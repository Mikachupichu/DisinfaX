/** The platform-independent half of a platform relay.
 *
 *  A relay has two jobs: get a platform's posts classified, and render the answers back
 *  into that platform's page. Only the second is platform-shaped (it goes through the
 *  adapter), and only the *capture* of posts is platform-shaped (X reads them from an
 *  XHR interceptor, Reddit from the DOM). Everything in between — the background port
 *  and its reconnect rules, batching and its fingerprint dedupe, the in-DOM deferral
 *  reports, the signed-out freeze, and the ten mfBus intents the injected UI emits — is
 *  identical on every platform. That is what lives here.
 *
 *  A platform supplies hooks for the parts that genuinely differ. X's `displayedSideFor`
 *  reads its Grok translate-toggle state; a platform with no translate control returns
 *  nulls and nothing else changes.
 *
 *  This module holds the module-level mutable state X's relay used to own (the port, the
 *  batch fingerprint, the reported-ids set). It is per-call state because a page has
 *  exactly one relay; `createRelayCore` is a factory rather than a singleton only so a
 *  test — or a future second world — can have its own.
 */
import {
  hasNonExtensionChange,
  injectClassifications,
  setAnnotateSeeded,
  setExtensionFrozen,
  showNotification,
} from './injecting';
import { mfBus } from './mfBus';
import { reportColorScheme } from './toolbarIcon';
import type { MainTweet } from '../data/Tweets';

/** The text caches the highlight layer resolves a classification against. Owned by the
 *  caller because only the platform knows where a post's text came from. */
export interface RelayTextCaches {
  text: Map<string, string>;
  translated: Map<string, string>;
}

/** The platform-varying parts of a relay. */
export interface RelayCoreHooks {
  /** This platform's bare tag, e.g. `reddit`. The `[misinfo] ` wrapper and the colon are
   *  composed at the console calls themselves and never held here: a release build drops
   *  every `console.*` call (see wxt.config.ts), and an argument to a dropped call goes with
   *  it, whereas a prefix stored on this object outlives the drop and reaches the store. */
  logTag: string;

  /** Every post captured so far, in the order the platform wants them classified. */
  currentPosts(): MainTweet[];

  /** Ids of the posts currently rendered on screen. The background classifies the first
   *  few eagerly and defers the rest until they are announced here, so a long thread
   *  does not pay for posts nobody has scrolled to. */
  visibleIds(): string[];

  textCaches(): RelayTextCaches;

  /** Which side of the platform's translate toggle is on screen for this post, the text it
   *  is showing, and the language that text is in. Platforms without a translate control
   *  return nulls, which the background already reads as "no opinion" rather than as a
   *  claim about the text. */
  displayedSideFor(postId: string): { side: string | null; text: string | null; locale: string | null };
}

export interface RelayCore {
  /** Deliver a message, reconnecting first if the worker's port is gone. */
  send(message: unknown): void;
  /** Ensure a port exists and hand it a batch. Omit `posts` to send everything captured. */
  classify(posts?: MainTweet[], xhrBatchId?: string, xhrBatchIndex?: number): void;
  /** Send every captured post as its own batch. */
  classifyIndividually(): void;
  /** Announce the posts currently rendered. Idempotent per id until a reconnect. */
  reportVisible(): void;
  /** Report the current platform's text locale and dark/light preference, and keep the
   *  former current. Safe to call once, after the redirect-landing bails. */
  start(): void;
  /** The debug display-locale override in force, or null. */
  locale(): string | null;
}

export function createRelayCore(hooks: RelayCoreHooks): RelayCore {
  type RuntimePort = ReturnType<typeof browser.runtime.connect>;
  let currentPort: RuntimePort | null = null;
  let currentBatchId: string | null = null;
  let pendingBatchRefresh: { batchId: string; postId?: string } | null = null;
  /** True while the user is signed out: injections are torn down and nothing is
   *  re-injected until the background reports a sign-in. */
  let frozen = false;
  /** Ids already announced to the background as rendered. */
  const reportedInDom = new Set<string>();
  let pendingDomReports: string[] = [];
  /** Fingerprint of the last batch sent, so an identical re-capture (a repeat timeline
   *  XHR, a re-swept DOM) does not reconnect and re-classify — and re-bill. */
  let lastBatchFingerprint = '';
  let localeOverride: string | null = null;

  const log = (...args: unknown[]) => console.log(`[misinfo] ${hooks.logTag}:`, ...args);
  const caches = () => hooks.textCaches();
  /** The port as it stands *now*, read through a call so control-flow narrowing cannot
   *  pin it to a stale value — `classify()` replaces the port, and the send path has to
   *  see the replacement. */
  const livePort = (): RuntimePort | null => currentPort;

  function reportInDom(postId: string) {
    if (!currentPort) {
      // Queue it: the port is the only thing that can carry a report, and dropping it
      // would strand a deferred post until some unrelated capture healed the connection.
      if (!pendingDomReports.includes(postId)) pendingDomReports.push(postId);
      return;
    }
    if (reportedInDom.has(postId)) return;
    reportedInDom.add(postId);
    // `tweetId` sits at the TOP level, not under `data`: the background reads
    // `message.tweetId` and this is the shape X's own relay has always sent. Nesting it
    // under `data` — as everything else on this port does — made every report a no-op,
    // so `seenInDom` filled with `undefined` and the deferred half of a batch waited
    // forever. Server-rendered platforms feel it worst: their whole post set arrives in
    // one sweep, so everything past the fifth post is deferred and then never released.
    currentPort.postMessage({ type: 'TWEET_IN_DOM', tweetId: postId });
  }

  function flushPendingDomReports() {
    const pending = pendingDomReports;
    pendingDomReports = [];
    for (const postId of pending) reportInDom(postId);
  }

  function reportVisible() {
    let reported = 0;
    for (const postId of hooks.visibleIds()) {
      if (reportedInDom.has(postId)) continue;
      reportInDom(postId);
      reported++;
    }
    if (reported > 0) log(`reported ${reported} post(s) in DOM`);
  }

  function batchFingerprint(posts: MainTweet[]): string {
    return posts
      .map((t) => `${t.id}:${t.text.length}:${t.translatedText?.length ?? 0}:${t.sourceLanguage ?? ''}:${t.destinationLanguage ?? ''}`)
      .join('|');
  }

  /** Open the port if it is not already up, wiring its message and disconnect handlers.
   *
   *  Only ever create a port when there is none. A batch refresh MUST reuse the live port,
   *  never disconnect and reconnect: tasks from earlier scroll batches still hold the old
   *  port object, and anything they finish after the disconnect posts into the void, so
   *  those posts never get their buttons until an unrelated capture re-sends them. The
   *  background keeps no per-port state (replies address the receiving port, broadcasts
   *  fan out over activePorts), so sharing one port across refreshes is exactly as safe as
   *  sharing it across captures. */
  function ensurePort(): RuntimePort {
    if (currentPort) return currentPort;
    const port: RuntimePort = browser.runtime.connect({ name: 'classify' });
    currentPort = port;
    log(`connected port (name=${port.name})`);

    port.onMessage.addListener((message: any) => {
      if (message.type === 'CLASSIFICATION') {
        const incoming = message.data;
        log(`received CLASSIFICATION for ${incoming.id}, onHold=${incoming.onHold}, claims=${incoming.claims?.length ?? 0}`);
        // Strip the Flow A marker before render: it is a background→content control
        // signal, not claim data. Quoted claims annotate against the QUOTED side, so
        // their seeds key on the quoted id.
        const annotating = new Set<string>();
        const stripList = (claims: any[] | null | undefined, sideId: string) => {
          for (const cl of claims ?? []) {
            if (cl.annotateInFlight) { annotating.add(`${sideId}:${cl.text}`); delete cl.annotateInFlight; }
          }
        };
        stripList(incoming.claims, incoming.id);
        stripList(incoming.quoting?.claims, incoming.quoting?.id ?? incoming.id);
        // Seed BEFORE render: the badge factory and the in-place reconcile consume
        // seeds synchronously inside injectClassifications.
        if (annotating.size > 0) setAnnotateSeeded(annotating);
        const { text, translated } = caches();
        injectClassifications([incoming], text, translated);
      } else if (message.type === 'MF_NOTIFICATION' && message.data) {
        // 'broke' bypasses showNotification's freeze guard: a frozen tab must still
        // hear why it is frozen.
        if (message.data.kind === 'broke') showNotification('broke', {});
        else showNotification(message.data.kind, { amount: message.data.amount, text: message.data.text, code: message.data.code });
      } else if (message.type === 'ANNOTATE_FAILED' && message.data) {
        mfBus.dispatchEvent(new CustomEvent('mf-annotate-failed', { detail: message.data }));
      } else if (message.type === 'MF_AUTH') {
        if (message.signedIn) {
          // Only act on a real freeze→resume transition, so a redundant "signed in"
          // (e.g. on reconnect) does not re-classify and re-bill.
          if (frozen) {
            frozen = false;
            setExtensionFrozen(false);
            if (hooks.currentPosts().length > 0) {
              lastBatchFingerprint = '';
              // The DOM reports already fired (and were deduped) while signed out, so
              // clear the dedupe and re-announce everything visible — otherwise the
              // deferred posts never inject until a scroll or reload.
              reportedInDom.clear();
              classifyIndividually();
              reportVisible();
            }
          }
        } else if (!frozen) {
          frozen = true;
          setExtensionFrozen(true);
        }
      }
    });

    reportedInDom.clear();
    reportVisible();
    flushPendingDomReports();

    port.onDisconnect.addListener(() => {
      if (currentPort === port) currentPort = null;
      const error = browser.runtime.lastError;
      if (hooks.currentPosts().length > 0) {
        log(`port disconnected${error ? ` (${error.message})` : ''}, reconnecting in 1s...`);
        // Re-announce INDIVIDUALLY, never as one batch: the worker that just died held
        // this page's tweets in memory, so the reconnect has to hand them back — but a
        // single unindexed batch means every one of them is looked up in the DB at once
        // (one billed fetch each, all in the same tick). Indexed, the background fetches
        // the first few and defers the rest until the reader's viewport reaches them,
        // which is the same rule the initial page load follows.
        setTimeout(() => classifyIndividually(), 1000);
      } else {
        log(`port disconnected${error ? ` (${error.message})` : ''}, NOT reconnecting (0 posts)`);
      }
    });
    return port;
  }

  function classify(posts?: MainTweet[], xhrBatchId?: string, xhrBatchIndex?: number) {
    const batch = posts ?? hooks.currentPosts();
    log(`classify called, posts=${batch.length}` + (posts ? ' (per-group)' : ''));
    if (batch.length === 0) return;

    // Only fingerprint-check the full-batch path (skip for per-post sends). But never
    // skip when there is no live port: after a worker restart the port is dead, and
    // returning here would strand every later tap — the buttons are still in the DOM but
    // their messages go nowhere, until some unrelated new post happens to heal the
    // connection.
    if (!posts) {
      const fingerprint = batchFingerprint(batch);
      if (!pendingBatchRefresh && fingerprint === lastBatchFingerprint && currentPort) {
        log('batch unchanged, skipping reconnect');
        return;
      }
      lastBatchFingerprint = fingerprint;
    }

    const port = ensurePort();

    if (pendingBatchRefresh) {
      const { batchId: refreshBatchId, postId: refreshPostId } = pendingBatchRefresh;
      pendingBatchRefresh = null;
      currentBatchId = `batch_${Date.now()}`;
      const toSend = refreshPostId
        ? hooks.currentPosts().filter((t) => t.id === refreshPostId)
        : hooks.currentPosts();
      log(`sending BATCH_REFRESH_FORCE for batchId=${refreshBatchId} postId=${refreshPostId ?? 'all'}, ${toSend.length} post(s)`);
      port.postMessage({
        type: 'BATCH_REFRESH_FORCE',
        data: { batchId: refreshBatchId, tweetId: refreshPostId, tweets: toSend, newBatchId: currentBatchId, locale: localeOverride },
      });
    } else {
      currentBatchId = `batch_${Date.now()}`;
      port.postMessage({
        type: 'CLASSIFY_TWEETS',
        data: batch,
        batchId: currentBatchId,
        locale: localeOverride,
        xhrBatchId,
        xhrBatchIndex,
      });
    }
  }

  function send(message: unknown) {
    if (!currentPort) {
      // No live port — the worker was killed (MV3 idle, aggressive on phones). Reconnect
      // first so the intent is not silently dropped: the reconnect re-announces the
      // platform's posts, which repopulates the background's in-memory stores.
      log('no port, reconnecting to deliver message...');
      ensurePort();
      classifyIndividually();
    }
    if (currentPort) {
      try {
        currentPort.postMessage(message);
      } catch (e) {
        log('failed to send to port, reconnecting...', e);
        // The port object itself is broken — drop it so ensurePort builds a fresh one.
        try { currentPort.disconnect(); } catch { /* ignore */ }
        currentPort = null;
        ensurePort();
        classifyIndividually();
        // Retry once on the fresh port: without this, the tap that healed the connection
        // would itself be lost and the user would have to tap twice.
        try { livePort()?.postMessage(message); } catch (e2) {
          console.error(`[misinfo] ${hooks.logTag}: retry send failed, message dropped`, e2);
        }
      }
    }
  }

  function classifyIndividually() {
    const posts = hooks.currentPosts();
    if (posts.length === 0) return;
    const xhrBatchId = `xhr_${Date.now()}`;
    log(`sending ${posts.length} post(s) individually`);
    classify([posts[0]], xhrBatchId, 0);
    for (let i = 1; i < posts.length; i++) {
      const batchId = `batch_${Date.now()}_${i}`;
      send({ type: 'CLASSIFY_TWEETS', data: [posts[i]], batchId, locale: localeOverride, xhrBatchId, xhrBatchIndex: i });
    }
  }

  function wireIntents() {
    mfBus.addEventListener('mf-refresh-claim', ((e: CustomEvent) => {
      const { classificationId, claimText, dbClaimText } = e.detail;
      log(`refresh-claim for ${classificationId}`);
      send({ type: 'REFRESH_CLAIM', data: { classificationId, claimText, dbClaimText, locale: localeOverride } });
    }) as EventListener);

    mfBus.addEventListener('mf-set-displayed-locale', ((e: CustomEvent) => {
      const { tweetId, textLocale, displayedText } = e.detail;
      log(`set-displayed-locale for ${tweetId} -> ${textLocale}`);
      send({ type: 'SET_DISPLAYED_LOCALE', data: { tweetId, textLocale, displayedText } });
    }) as EventListener);

    mfBus.addEventListener('mf-refresh-batch', ((e: CustomEvent) => {
      const { batchId, tweetId } = e.detail;
      log(`refresh-batch for ${batchId} (postId=${tweetId ?? 'unknown'}), forcing reconnection`);
      pendingBatchRefresh = { batchId, postId: tweetId };
      classify();
    }) as EventListener);

    mfBus.addEventListener('mf-process-on-hold', ((e: CustomEvent) => {
      const { tweetId } = e.detail;
      let displayedSide: string | null = null;
      let displayedText: string | null = null;
      let displayedLocale: string | null = null;
      try {
        const read = hooks.displayedSideFor(tweetId);
        displayedSide = read.side;
        displayedText = read.text;
        displayedLocale = read.locale;
      } catch (err) {
        console.error(`[misinfo] ${hooks.logTag}: displayedSideFor THREW for ${tweetId}`, err);
      }
      log(`process-on-hold for ${tweetId} (displayedSide=${displayedSide ?? 'unknown'}, displayedText=${displayedText ? `${displayedText.length} chars` : 'none'}, displayedLocale=${displayedLocale ?? 'unknown'})`);
      // Sent even when the reads above failed: they are refinements, and losing the
      // intent costs the user a click that appears to do nothing.
      send({ type: 'PROCESS_ON_HOLD', data: { tweetId, locale: localeOverride, displayedSide, displayedText, displayedLocale } });
    }) as EventListener);

    mfBus.addEventListener('mf-fact-check-all', ((e: CustomEvent) => {
      const { tweetId } = e.detail;
      log(`fact-check-all for ${tweetId}`);
      send({ type: 'FACT_CHECK_ALL', data: { tweetId, locale: localeOverride } });
    }) as EventListener);

    mfBus.addEventListener('mf-annotate-claim', ((e: CustomEvent) => {
      const { classificationId, claimText } = e.detail;
      log(`annotate-claim for ${classificationId}`);
      send({ type: 'ANNOTATE_CLAIM', data: { classificationId, claimText, locale: localeOverride } });
    }) as EventListener);

    mfBus.addEventListener('mf-reclassify-on-hold-click', ((e: CustomEvent) => {
      const { classificationId, claimText } = e.detail;
      log(`reclassify-on-hold-click for ${classificationId}`);
      send({ type: 'RECLASSIFY_ON_HOLD_CLICK', data: { classificationId, claimText, locale: localeOverride } });
    }) as EventListener);

    mfBus.addEventListener('mf-translate-fact-checks', ((e: CustomEvent) => {
      const { tweetId } = e.detail;
      log(`translate-fact-checks for ${tweetId}`);
      send({ type: 'TRANSLATE_FACT_CHECKS', data: { tweetId, locale: localeOverride } });
    }) as EventListener);

    mfBus.addEventListener('mf-translate-claim', ((e: CustomEvent) => {
      const { classificationId, claimText, translateWhat } = e.detail;
      log(`translate-claim for ${classificationId} (${translateWhat})`);
      send({ type: 'TRANSLATE_CLAIM', data: { classificationId, claimText, translateWhat, locale: localeOverride } });
    }) as EventListener);

    // Click on an in-page notification: ask the background to open the extension popup.
    // Sent over the long-lived port (not runtime.sendMessage) so the click's user gesture
    // reaches the background intact — openPopup() is only legal with one.
    mfBus.addEventListener('mf-open-popup', ((e: CustomEvent) => {
      log('notification clicked, requesting popup open', e.detail);
      // Set here as well as at the background's end, and for every kind: the background
      // is the half that may fail to run, and the tab is worth having right even then.
      try { browser.storage.local.set({ disinfax_popup_tab: 'balance' }).catch(() => {}); } catch { /* ignore */ }
      send({ type: 'MF_OPEN_POPUP', data: e.detail });
    }) as EventListener);
  }

  function start() {
    // The background service worker has no DOM and so cannot read the browser's
    // dark/light preference itself. Report it from here — this keeps the toolbar icon
    // correct for users who never open the popup.
    reportColorScheme();
    // Debug-only display-locale override. Read from EXTENSION storage
    // (chrome.storage.local), NOT page localStorage — the host page can write page
    // localStorage and could otherwise force the extension's output into a bogus locale.
    try {
      browser.storage.local.get('mfLocale').then((r) => { localeOverride = (r?.mfLocale as string) ?? null; }).catch(() => {});
      browser.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && 'mfLocale' in changes) localeOverride = (changes.mfLocale.newValue as string) ?? null;
      });
    } catch { /* ignore */ }
    wireIntents();
  }

  return {
    send,
    classify,
    classifyIndividually,
    reportVisible,
    start,
    locale: () => localeOverride,
  };
}

/** The mutation guard every relay's DOM observer needs.
 *
 *  Our injected elements mutate the DOM constantly while a fact-check streams in
 *  (popover text, segment and badge updates), and a naive observer would re-run a
 *  full-document query on every one of those ticks — competing with the main thread for
 *  the click that opens a popover and reproducing the "highlight frozen, popover won't
 *  open" bug from a second, unguarded observer. */
export { hasNonExtensionChange };
