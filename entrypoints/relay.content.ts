/** Tweet capture, isolated-world half — the extension's coordinator on x.com.
 *
 *  Receives tweets from the MAIN-world interceptor (capture.main.content.ts) over
 *  window.postMessage, forwards them to the background for classification over a long-
 *  lived port, and injects the results into the page (utils/injecting.ts). It also
 *  relays user intents from the injected UI back to the background over the mfBus, and
 *  watches for X's own translation toggle so highlights follow the displayed text.
 *
 *  Running in the isolated world is what makes it safe to hold this role: the host page
 *  cannot reach this scope, so it can neither forge the intents that spend the user's
 *  balance nor read extension state. Everything crossing in from the page — only the
 *  X_DATA_CAPTURED message — is origin-checked before it is trusted.
 */
import { injectClassifications, showNotification, setExtensionFrozen, hasNonExtensionChange } from '../utils/injecting';
import { mfBus } from '../utils/mfBus';
import { MainTweet } from "../data/Tweets";
import { reportColorScheme } from '../utils/toolbarIcon';

const tweetTextCache = new Map<string, string>();
const translatedTextCache = new Map<string, string>();
let capturedTweets: MainTweet[] = [];
let currentBatchId: string | null = null;
let pendingBatchRefresh: string | null = null;
let localeOverride: string | null = null;
let currentPort: any = null;
/** True while the user is logged out: the extension is frozen (injections torn
 *  down, nothing re-injected) until the background reports a sign-in. */
let frozen = false;
/** Tweet ids already reported to the background as present in the DOM. */
const reportedToBackground = new Set<string>();
/** DOM reports queued before the background port was ready. */
let pendingDomReports: string[] = [];

/** Serialized fingerprint of the last batch we sent, so identical captured tweet
 *  batches (e.g. from repeated timeline XHRs) don't reconnect and re-classify. */
let lastBatchFingerprint = '';

function sendToPort(message: any) {
  if (currentPort) {
    try { currentPort.postMessage(message); } catch (e) {
      console.log(`[misinfo] relay: failed to send to port, reconnecting...`, e);
      connectAndClassify();
    }
  }
}

/** In-flight DOM locale watches, keyed by tweet id, so a rapid double-toggle replaces its
 *  own watch instead of leaving two intervals racing to report different locales. */
const localeWatchTimers = new Map<string, ReturnType<typeof setInterval>>();

/** Resolve a tweet's displayed locale by watching the `lang` attribute X puts on its text
 *  element (verified: it reads "da" once the post is translated to Danish).
 *
 *  Needed because X fetches translations lazily via
 *  `POST https://api.x.com/2/grok/translation.json` — a `fetch` through X's own service
 *  worker, which capture.main.content.ts's XMLHttpRequest patch cannot see. So on the FIRST
 *  toggle click after a page load there is no captured destinationLanguage, and without one
 *  we cannot name the locale the text is switching to. Reading the DOM avoids having to
 *  patch window.fetch in the MAIN world, which would intercept every host-page request.
 *
 *  Polls instead of using a MutationObserver because X REPLACES the tweetText element when
 *  it swaps the text — an observer bound to the original node would simply stop firing.
 *
 *  Reports whatever locale the DOM settles on, INCLUDING an unchanged one. That is
 *  deliberate: the toggle click has already torn our segments down, so reporting the
 *  unchanged locale is what makes kickOffTextBreakup re-derive them against the text still
 *  on screen. Without it, a translation that never lands (X's Grok request can fail — seen
 *  as "Fetch failed loading" on that endpoint) would strand the tweet on its fallback box
 *  with no way back to inline highlights short of a reload. */
function watchDisplayedLocaleFromDom(tweetId: string, article: Element) {
  const readTextEl = () => article.querySelector('[data-testid="tweetText"]');
  const readLang = () => readTextEl()?.getAttribute('lang') ?? null;
  const initial = readLang();

  const existing = localeWatchTimers.get(tweetId);
  if (existing !== undefined) clearInterval(existing);

  const readText = () => readTextEl()?.textContent ?? null;

  const STEP_MS = 150;
  /** How long to wait for the `lang` attribute to flip at all. */
  const LANG_TIMEOUT_MS = 6000;
  /** Consecutive unchanged polls required before the text counts as settled. X STREAMS a
   *  translation in progressively and flips `lang` when streaming BEGINS, so the attribute
   *  changing tells us nothing about the text being complete. Snapshotting immediately caught
   *  25 characters of a 200-character Romanian translation; that snapshot became
   *  `translatedText`, and upgradeToSegments then wrote those 25 characters over X's
   *  still-streaming text — visibly truncating the post to its first few words. */
  const STABLE_POLLS_REQUIRED = 4; // 600ms of no growth
  /** Overall cap, so a translation that never stops changing still reports something. */
  const TOTAL_TIMEOUT_MS = 15000;

  let elapsed = 0;
  let langSettled = false;
  let resolvedLang: string | null = null;
  let lastText: string | null = null;
  let stablePolls = 0;

  const timer = setInterval(() => {
    elapsed += STEP_MS;

    // Give up if the tweet unmounted (scrolled out / navigation) — nothing to report.
    if (!article.isConnected) {
      clearInterval(timer);
      localeWatchTimers.delete(tweetId);
      console.log(`[misinfo] relay: locale watch for ${tweetId} aborted — tweet left the DOM`);
      return;
    }

    const current = readLang();

    // PHASE 1 — wait for the locale to flip (or give up and keep the current one, which is
    // what restores highlights when a translation never lands).
    if (!langSettled) {
      const changed = current !== null && current !== initial;
      if (!changed && elapsed < LANG_TIMEOUT_MS) return;
      langSettled = true;
      resolvedLang = current ?? initial;
      lastText = readText();
      stablePolls = 0;
      return;
    }

    // PHASE 2 — wait for the text to stop growing before snapshotting it.
    if (current !== null && current !== resolvedLang) resolvedLang = current;
    const text = readText();
    if (text === lastText) {
      stablePolls++;
    } else {
      stablePolls = 0;
      lastText = text;
    }
    if (stablePolls < STABLE_POLLS_REQUIRED && elapsed < TOTAL_TIMEOUT_MS) return;

    clearInterval(timer);
    localeWatchTimers.delete(tweetId);

    if (!resolvedLang) {
      console.log(`[misinfo] relay: locale watch for ${tweetId} found no lang attribute, leaving locale unchanged`);
      return;
    }
    // Send the text X is now showing, not just its locale. Nothing else in the extension has
    // a copy of it: the translation never passed through our XHR capture, so the background's
    // cached tweet only has the ORIGINAL text. Without this, SET_DISPLAYED_LOCALE leaves
    // `translatedText` as the original while `textLocale` says (say) "th", and every consumer
    // then works on the wrong text — highlight ranges get computed against English and stored
    // under the Thai key (giving identical en/th ranges in the DB), and kickOffTextBreakup
    // builds English segments that upgradeToSegments then has to reject.
    const displayedText = lastText ?? undefined;
    console.log(`[misinfo] relay: locale watch for ${tweetId} resolved lang=${resolvedLang} (was ${initial ?? 'none'}, settled after ${elapsed}ms, text=${displayedText ? displayedText.length + ' chars' : 'none'})`);
    sendToPort({ type: 'SET_DISPLAYED_LOCALE', data: { tweetId, textLocale: resolvedLang, locale: localeOverride, displayedText } });
  }, STEP_MS);

  localeWatchTimers.set(tweetId, timer);
}

/** Notify the background that a tweet is present in the DOM so it can proceed
 *  with deferred DB fetches for timeline tweets. */
function reportTweetInDom(tweetId: string) {
  if (reportedToBackground.has(tweetId)) return;
  if (!currentPort) {
    pendingDomReports.push(tweetId);
    return;
  }
  reportedToBackground.add(tweetId);
  sendToPort({ type: "TWEET_IN_DOM", tweetId });
}

/** Re-send DOM reports that may have been dropped because the port wasn't ready. */
function flushPendingDomReports() {
  const pending = pendingDomReports;
  pendingDomReports = [];
  for (const tweetId of pending) {
    if (!reportedToBackground.has(tweetId)) {
      reportedToBackground.add(tweetId);
      sendToPort({ type: "TWEET_IN_DOM", tweetId });
    }
  }
}

/** Report all tweet ids currently rendered in the DOM. */
function reportVisibleTweets() {
  const links = document.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]');
  let reported = 0;
  for (const link of links) {
    const match = link.href.match(/\/status\/(\d+)/);
    if (!match) continue;
    const tweetId = match[1];
    if (reportedToBackground.has(tweetId)) continue;
    if (!link.closest('article')) continue;
    reportTweetInDom(tweetId);
    reported++;
  }
  if (reported > 0) {
    console.log(`[misinfo] relay: reported ${reported} tweet(s) in DOM`);
  }
}

function batchFingerprint(tweets: MainTweet[]): string {
  return tweets.map(t => `${t.id}:${t.text.length}:${t.translatedText?.length ?? 0}:${t.sourceLanguage ?? ''}:${t.destinationLanguage ?? ''}`).join('|');
}

/** Ensure a background port exists and hand it a batch to classify.
 *
 *  Called both for the whole captured set (no `tweetsToSend`) and for individual tweets
 *  during per-tweet sends. `xhrBatchId`/`xhrBatchIndex` carry the originating XHR's
 *  identity so the background can fetch the first few tweets eagerly and defer the rest
 *  until they actually appear in the DOM. */
function connectAndClassify(tweetsToSend?: MainTweet[], xhrBatchId?: string, xhrBatchIndex?: number) {
  const tweetsForSend = tweetsToSend ?? capturedTweets;
  console.log(`[misinfo] relay: connectAndClassify called, tweets=${tweetsForSend.length}` + (tweetsToSend ? ' (per-group)' : ''));
  if (tweetsForSend.length === 0) return;

  // Only fingerprint-check on the full batch path (skip for per-group sends)
  if (!tweetsToSend) {
    const fingerprint = batchFingerprint(tweetsForSend);
    if (!pendingBatchRefresh && fingerprint === lastBatchFingerprint) {
      console.log(`[misinfo] relay: batch unchanged, skipping reconnect`);
      return;
    }
    lastBatchFingerprint = fingerprint;
  }

  // Only create a new port for batch refreshes or when there is no port yet.
  // Do NOT disconnect on every new XHR batch — doing so loses in-flight
  // classification messages (e.g. on-hold "Disinfact" buttons) from the
  // previous scroll's processFullBatch calls. The background handles multiple
  // CLASSIFY_TWEETS on the same port concurrently just fine.
  if (pendingBatchRefresh || !currentPort) {
    // Disconnect old port if any
    if (currentPort) {
      try { currentPort.disconnect(); } catch {}
      currentPort = null;
    }

    const port = browser.runtime.connect({ name: "classify" });
    currentPort = port;
    console.log(`[misinfo] relay: connected port (name=${port.name})`);

    port.onMessage.addListener((message) => {
      if (message.type === "CLASSIFICATION") {
        console.log(`[misinfo] relay: received CLASSIFICATION for ${message.data.id}, onHold=${message.data.onHold}, translateFC=${message.data.translateFactChecksOnHold}, claims=${message.data.claims?.length ?? 0}`);
        injectClassifications([message.data], tweetTextCache, translatedTextCache);
      } else if (message.type === "MF_NOTIFICATION" && message.data) {
        showNotification(message.data.kind, { amount: message.data.amount, text: message.data.text, code: message.data.code });
      } else if (message.type === "MF_AUTH") {
        if (message.signedIn) {
          // Only act on a real freeze→resume transition, so a redundant
          // "signed in" (e.g. on reconnect) doesn't re-classify needlessly.
          if (frozen) {
            frozen = false;
            setExtensionFrozen(false);
            // Re-classify captured tweets so highlights torn down while frozen come back.
            if (capturedTweets.length > 0) {
              lastBatchFingerprint = '';
              // The background fetches the first few tweets immediately and DEFERS the
              // rest until TWEET_IN_DOM. Those DOM reports already fired (and got deduped)
              // while signed out, so clear the dedup and re-announce every visible tweet —
              // otherwise the deferred tweets never inject until a scroll/reload.
              reportedToBackground.clear();
              classifyCapturedTweetsIndividually();
              reportVisibleTweets();
            }
          }
        } else if (!frozen) {
          // Logged out: strip every injection and freeze until re-login.
          frozen = true;
          setExtensionFrozen(true);
        }
      }
    });

    // Report any tweets already in the DOM on this fresh connection,
    // and flush reports that arrived before the port was ready.
    reportVisibleTweets();
    flushPendingDomReports();

    port.onDisconnect.addListener(() => {
      if (currentPort === port) currentPort = null;
      const error = browser.runtime.lastError;
      if (capturedTweets.length > 0 && !pendingBatchRefresh) {
        console.log(`[misinfo] relay: port disconnected${error ? ` (${error.message})` : ''}, reconnecting in 1s...`);
        setTimeout(() => connectAndClassify(), 1000);
      } else {
        console.log(`[misinfo] relay: port disconnected${error ? ` (${error.message})` : ''}, NOT reconnecting (capturedTweets=${capturedTweets.length}, pendingBatchRefresh=${pendingBatchRefresh})`);
      }
    });
  }

  // Send the actual data (on existing port or newly created one)
  if (pendingBatchRefresh) {
    const refreshBatchId = pendingBatchRefresh;
    pendingBatchRefresh = null;
    currentBatchId = `batch_${Date.now()}`;
    console.log(`[misinfo] relay: sending BATCH_REFRESH_FORCE for ${refreshBatchId}, new batchId=${currentBatchId}`);
    currentPort.postMessage({
      type: "BATCH_REFRESH_FORCE",
      data: { batchId: refreshBatchId, tweets: capturedTweets, newBatchId: currentBatchId, locale: localeOverride }
    });
  } else {
    currentBatchId = `batch_${Date.now()}`;
    currentPort.postMessage({
      type: "CLASSIFY_TWEETS",
      data: tweetsForSend,
      batchId: currentBatchId,
      locale: localeOverride,
      xhrBatchId,
      xhrBatchIndex
    });
  }
}

/** Send every currently-captured tweet to the background as its own batch.
 *  Used on initial capture and again when the user logs back in (to restore
 *  highlights that were torn down while frozen). */
function classifyCapturedTweetsIndividually() {
  const tweets = capturedTweets;
  if (tweets.length === 0) return;
  const xhrBatchId = `xhr_${Date.now()}`;
  console.log(`[misinfo] relay: sending ${tweets.length} tweet(s) individually`);
  connectAndClassify([tweets[0]], xhrBatchId, 0);
  for (let i = 1; i < tweets.length; i++) {
    const batchId = `batch_${Date.now()}_${i}`;
    console.log(`[misinfo] relay: sending tweet ${tweets[i].id} as batch ${batchId}`);
    sendToPort({ type: "CLASSIFY_TWEETS", data: [tweets[i]], batchId, locale: localeOverride, xhrBatchId, xhrBatchIndex: i });
  }
}

// ---- Event listeners (set up once, always use currentPort) ----

mfBus.addEventListener('mf-refresh-claim', ((e: CustomEvent) => {
  const { classificationId, claimText, dbClaimText } = e.detail;
  console.log(`[misinfo] relay: refresh-claim for ${classificationId} "${claimText.slice(0, 40)}..."`);
  sendToPort({ type: "REFRESH_CLAIM", data: { classificationId, claimText, dbClaimText, locale: localeOverride } });
}) as EventListener);

mfBus.addEventListener('mf-set-displayed-locale', ((e: CustomEvent) => {
  const { tweetId, textLocale } = e.detail;
  console.log(`[misinfo] relay: set-displayed-locale for ${tweetId} -> ${textLocale}`);
  sendToPort({ type: "SET_DISPLAYED_LOCALE", data: { tweetId, textLocale } });
}) as EventListener);

mfBus.addEventListener('mf-refresh-batch', ((e: CustomEvent) => {
  const { batchId } = e.detail;
  console.log(`[misinfo] relay: refresh-batch for ${batchId}, forcing reconnection`);
  pendingBatchRefresh = batchId;
  connectAndClassify();
}) as EventListener);

/** Read X's translate-toggle state for a tweet. Pure: depends only on `tweetElement`
 *  and the DOM, which is why it can live at module scope and be called from both the
 *  click handler inside main() and the mf-process-on-hold listener below. */
function getTweetTranslationState(tweetElement: Element) {
  const allSVGs = tweetElement.querySelectorAll('svg');
  for (const svg of allSVGs) {
    const path = svg.querySelector('path');
    if (!path) continue;
    const pathData = path.getAttribute('d') || '';
    // Stable fingerprint for X's translation icon.
    if (pathData.startsWith('M12.745 20.54l10.97-8.19')) {
      const rowWrapper = svg.closest('[dir]');
      if (!rowWrapper) continue;
      const toggleButton = rowWrapper.querySelector('button');
      if (!toggleButton) continue;
      const prevSibling = toggleButton.previousElementSibling;
      // A <span> between icon and button means X inserted "Translated from..."
      // attribution, so the tweet is currently showing the translation.
      const currentState = prevSibling && prevSibling.tagName.toLowerCase() === 'span'
        ? 'TRANSLATED'
        : 'ORIGINAL';
      return { buttonElement: toggleButton as HTMLButtonElement, currentState };
    }
  }
  return null;
}

mfBus.addEventListener('mf-process-on-hold', ((e: CustomEvent) => {
  const { tweetId } = e.detail;
  // Report which side of a translation the user is actually looking at. The background
  // otherwise infers it as "a translation exists in the payload, therefore the translation
  // is on screen" (runPreclassification), which keys the highlight ranges under the
  // destination language even when the user is reading the original — the ranges are then
  // unusable against the text they can see. The toggle row is the only reliable signal; a
  // null here (no translate row, or the fingerprint moved) leaves the old inference intact.
  const idLink = document.querySelector(`a[href*="/status/${tweetId}"]`);
  const article = idLink?.closest('article') ?? null;
  const displayedSide = article ? (getTweetTranslationState(article)?.currentState ?? null) : null;
  // Also ship the text X is rendering, but only when the toggle says a translation is on
  // screen. X fetches translations lazily, so the payload the background captured can be
  // missing `translatedText` even though the tweet is visibly translated; the background
  // then preclassifies the ORIGINAL and keys the ranges under the original's locale, and
  // the user pays for highlights that can never be drawn over the text in front of them.
  // The DOM is the one source that always agrees with what is displayed.
  //
  // Skipped entirely for a quoted post: an article holds the quoted tweet's text as well as
  // its own, and this id resolves to the OUTER article either way, so there is no reliable
  // way to tell which body belongs to `tweetId`. Sending nothing leaves the old inference
  // untouched — far better than preclassifying a different tweet's words.
  const inQuotedCard = !!idLink?.closest('div[role="link"]');
  const displayedText = (displayedSide === 'TRANSLATED' && article && !inQuotedCard)
    ? (Array.from(article.querySelectorAll('[data-testid="tweetText"]'))
        .find(el => !el.closest('div[role="link"]'))?.textContent ?? null)
    : null;
  console.log(`[misinfo] relay: process-on-hold for ${tweetId} (displayedSide=${displayedSide ?? 'unknown'}, displayedText=${displayedText ? `${displayedText.length} chars` : 'none'})`);
  sendToPort({ type: "PROCESS_ON_HOLD", data: { tweetId, locale: localeOverride, displayedSide, displayedText } });
}) as EventListener);

mfBus.addEventListener('mf-fact-check-all', ((e: CustomEvent) => {
  const { tweetId } = e.detail;
  console.log(`[misinfo] relay: fact-check-all for ${tweetId}`);
  sendToPort({ type: "FACT_CHECK_ALL", data: { tweetId, locale: localeOverride } });
}) as EventListener);

mfBus.addEventListener('mf-reclassify-on-hold-click', ((e: CustomEvent) => {
  const { classificationId, claimText } = e.detail;
  console.log(`[misinfo] relay: reclassify-on-hold-click for ${classificationId} "${claimText?.slice(0, 40)}..."`);
  sendToPort({ type: "RECLASSIFY_ON_HOLD_CLICK", data: { classificationId, claimText, locale: localeOverride } });
}) as EventListener);

mfBus.addEventListener('mf-translate-fact-checks', ((e: CustomEvent) => {
  const { tweetId } = e.detail;
  console.log(`[misinfo] relay: translate-fact-checks for ${tweetId}`);
  sendToPort({ type: "TRANSLATE_FACT_CHECKS", data: { tweetId, locale: localeOverride } });
}) as EventListener);

mfBus.addEventListener('mf-translate-claim', ((e: CustomEvent) => {
  const { classificationId, claimText, translateWhat } = e.detail;
  console.log(`[misinfo] relay: translate-claim for ${classificationId} "${claimText?.slice(0, 40)}..." (${translateWhat})`);
  sendToPort({ type: "TRANSLATE_CLAIM", data: { classificationId, claimText, translateWhat, locale: localeOverride } });
}) as EventListener);

// ---- (Deferred batch processing removed — each tweet is self-contained) ----

export default defineContentScript({
  matches: ['*://x.com/*'],
  runAt: 'document_start',
  main() {
    console.log('[misinfo] relay content script loaded, localeOverride=', localeOverride);

    // The background service worker has no DOM and so cannot read the browser's
    // dark/light preference itself. Report it from here — this keeps the toolbar
    // icon correct for users who never open the popup. See utils/toolbarIcon.ts.
    reportColorScheme();
    // Debug-only display-locale override for testing. Read from EXTENSION storage
    // (chrome.storage.local), NOT page localStorage — the host page (X) can write
    // page localStorage and could otherwise force the extension's output into a
    // bogus locale (and cause cache-miss churn). Extension storage is unreachable
    // from the page. Set it while testing from the extension side, e.g. the
    // background console: chrome.storage.local.set({ mfLocale: 'fr' }).
    try {
      browser.storage.local.get('mfLocale').then((r) => { localeOverride = (r?.mfLocale as string) ?? null; }).catch(() => {});
      browser.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && 'mfLocale' in changes) localeOverride = (changes.mfLocale.newValue as string) ?? null;
      });
    } catch {}

    window.addEventListener('message', (event) => {
      // Trust ONLY our own main-world interceptor (capture.main.content.ts), which
      // posts from this same window on the page's own origin. Reject anything from
      // an iframe/ad or a cross-origin frame — the host platform (or any script it
      // loads) must not be able to spoof captured tweets into the pipeline and spend
      // the signed-in user's balance on attacker-chosen content.
      if (event.source !== window || event.origin !== location.origin) return;
      if (event.data?.type !== 'X_DATA_CAPTURED') return;

      // Cache full tweet texts from captured data (not truncated like DOM text)
      const tweets: MainTweet[] = event.data.tweets;
      let cachedCount = 0;
      let translatedCount = 0;
      for (const t of tweets) {
        if (t && t.id && t.text) {
          tweetTextCache.set(t.id, t.text);
          cachedCount++;
          // Cache translated text if available (from Grok auto-translation)
          if (t.translatedText) {
            translatedTextCache.set(t.id, t.translatedText);
            translatedCount++;
          }
          // Also cache quoted tweet text
          if (t.quoting && t.quoting.id && t.quoting.text) {
            tweetTextCache.set(t.quoting.id, t.quoting.text);
          }
        }
      }
      console.log(`[misinfo] relay: cached ${cachedCount} tweet texts + ${translatedCount} translations, cache size now ${tweetTextCache.size}`);

      capturedTweets = tweets;

      // Each tweet is self-contained (linked tweets are nested as context).
      // Send each tweet individually as its own batch, but include the original
      // XHR batch id and index so the background can fetch the first 5 immediately
      // and defer the rest until they appear in the DOM.
      classifyCapturedTweetsIndividually();
    });

    // Report tweets as they enter the DOM so the background can defer DB fetches
    // for timeline tweets until they are actually rendered. Wait for document.body
    // because this content script runs at document_start.
    function setupDomObserver() {
      if (!document.body) {
        setTimeout(setupDomObserver, 50);
        return;
      }
      const domObserver = new MutationObserver((mutations) => {
        // Same guard as utils/injecting.ts's own observer: our injected elements
        // (popover text streaming in, segment/badge updates) mutate the DOM constantly
        // while a fact-check streams in, and a naive observer here would re-run a
        // full-document querySelectorAll on every one of those ticks — competing with
        // the main thread for the click that opens a popover and reproducing the
        // "highlight frozen, popover won't open" bug from a second, unguarded observer.
        if (!mutations.some(hasNonExtensionChange)) return;
        reportVisibleTweets();
      });
      domObserver.observe(document.body, { childList: true, subtree: true });
      // Run once immediately in case the DOM is already populated.
      reportVisibleTweets();
    }
    setupDomObserver();

    // Detect clicks on X's translation/original toggle and notify the background
    // so it can switch highlight locale before X re-renders the text.
    // We identify the button via the stable translation icon SVG path, and we
    // determine the toggle direction from the DOM structure: if a <span> sits
    // between the icon and the button, the tweet is currently translated and the
    // click will show the original; otherwise it will show the translation.
    document.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement)?.closest<HTMLElement>('button[role="button"]') ?? (e.target as HTMLElement);
      if (!target || target.tagName !== 'BUTTON') return;

      // Find the containing article and the translation row via the SVG icon fingerprint.
      const article = target.closest('article');
      if (!article) return;

      const translationToggle = getTweetTranslationState(article);
      if (!translationToggle || translationToggle.buttonElement !== target) return;

      const statusLink = article.querySelector<HTMLAnchorElement>('a[href*="/status/"]');
      if (!statusLink) return;
      const match = statusLink.href.match(/\/status\/(\d+)/);
      const tweetId = match ? match[1] : null;
      if (!tweetId) return;

      const tweet = capturedTweets.find(t => t.id === tweetId);
      if (!tweet) {
        console.log(`[misinfo] relay: toggle click for ${tweetId} but tweet not in captured cache`);
        return;
      }
      // Tear down injected elements immediately so X can swap the text unimpeded.
      //
      // This MUST happen before the sourceLanguage/destinationLanguage check below, not
      // after it. X only includes translation metadata in its GraphQL payload once a
      // translation has actually been fetched, so on the FIRST toggle click after a fresh
      // page load destinationLanguage is undefined and that check returns. When the teardown
      // sat below it, that early return left our injected segments in place: X then replaced
      // the tweet text, our MutationObserver saw a host-page change and re-injected, and the
      // stale segments (in the OLD language) were written over the newly translated text.
      // Tearing down unconditionally is right regardless — the user has asked X to swap this
      // tweet's text, so our text-derived markup is invalid either way. The handler clears
      // `segments` and `translatedText` as well as removing the DOM nodes.
      mfBus.dispatchEvent(new CustomEvent('mf-prepare-locale-switch', {
        detail: { tweetId }
      }));

      // Without both languages the captured payload cannot name the locale the text is
      // switching TO — X fetches translations lazily and our XHR capture never sees that
      // request (see watchDisplayedLocaleFromDom). Rather than guess, read the locale off the
      // DOM once X has finished swapping the text. Guessing would be actively harmful here: a
      // highlight keyed under the wrong locale is worse than none, since it would satisfy
      // resolveHighlightRange for a language whose ranges we never computed.
      //
      // The known-metadata path below is deliberately left exactly as it was.
      if (!tweet.sourceLanguage || !tweet.destinationLanguage) {
        console.log(`[misinfo] relay: toggle click for ${tweetId} — tore down injections; translation metadata not captured (source=${tweet.sourceLanguage ?? 'none'}, destination=${tweet.destinationLanguage ?? 'none'}), resolving locale from the DOM instead`);
        watchDisplayedLocaleFromDom(tweetId, article);
        return;
      }

      // currentState === 'TRANSLATED' means the screen is showing the translation,
      // so the click will switch to the original (source) text.
      const textLocale = translationToggle.currentState === 'TRANSLATED'
        ? tweet.sourceLanguage!
        : tweet.destinationLanguage!;
      console.log(`[misinfo] relay: toggle click for ${tweetId} -> ${textLocale} (currentState=${translationToggle.currentState})`);

      sendToPort({ type: 'SET_DISPLAYED_LOCALE', data: { tweetId, textLocale, locale: localeOverride } });
    }, true);

  }
});
