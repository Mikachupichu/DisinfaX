/** The coordinator for every platform added after X.
 *
 *  X is not here: its posts arrive as JSON from a MAIN-world XHR interceptor
 *  (capture.main.content.ts) because X's GraphQL payload carries fields the rendered
 *  markup never shows, so X keeps its own relay. Every other platform is driven from
 *  this file, and each is fed one of two ways — from the DOM (sweep the page, lift each
 *  post out of it) or from its own API, through an interceptor of its own that forwards
 *  records for the adapter to read (`captureNetwork`). Either way the batch goes to the
 *  shared half of the relay (utils/relayCore.ts), which is identical on all three paths.
 *
 *  Running in the isolated world is what makes it safe to hold this role: the host page
 *  cannot reach this scope, so it can neither forge the intents that spend the user's
 *  balance nor read extension state. The page can post messages at this scope, and does
 *  — that is how a network capture crosses in — which is why every field of one is
 *  validated by the adapter before it is trusted.
 */
import { injectClassifications, setPlatformAdapter, hasNonExtensionChange } from '../utils/injecting';
import { platformForHost, normalizeHost } from '../utils/platforms/registry';
import { isInstanceOptedIn } from '../utils/mastodonOptIn';
import { mastodonAdapter } from '../utils/platforms/mastodon';
import { hydrateCapturedChains, nameCapturedLanguage } from '../utils/platforms/capture';
import { createRelayCore, type RelayTextCaches } from '../utils/relayCore';
import type { CapturedPost, PlatformAdapter } from '../utils/platforms/types';
import type { MainTweet } from '../data/Tweets';

/** The port a framed child keeps open only so the background can learn its frame id. Held
 *  for the life of the content script; nothing is ever sent over it. */
let announcePort: ReturnType<typeof browser.runtime.connect> | null = null;

/** Tell the background this frame exists, so it can be addressed later.
 *
 *  A frame of a platform whose posts live in one is the only thing on the page the
 *  background cannot reach by itself: it can name a tab, and `webNavigation` — which would
 *  name the frames — is deliberately not a permission this extension carries. A port's
 *  sender is the one thing that does name a frame id, so the frame announces itself once
 *  and the background files the id against the tab (see `noteFrame` there). Without it the
 *  popup's selection fact-check can only ask the top document — which on this platform
 *  holds no post and no selection, so a passage selected in the article body could not be
 *  fact-checked from the popup at all.
 *
 *  Opened here rather than left to the relay's own port, because that one is opened lazily
 *  on the frame's first announcement and announcing is what bills a lookup: a frame the
 *  reader has not scrolled to must not be announced, but it must still be addressable,
 *  since the passage selected can sit in a part of the page that holds no post. */
function announceFrame(): void {
  try {
    announcePort = browser.runtime.connect({ name: 'frame' });
  } catch { /* no extension context to announce to */ }
}

/** Everything this extension writes into a platform's DOM matches one of these.
 *
 *  Text under such a mark is no longer the post's own words: a strike keeps the host's word
 *  inside our span but an annotation appends our correction beside it, and a badge or a
 *  button is wholly ours. Anything that means to read a post's text off the page — the
 *  capture, and the upgrade in `upgradeCapture` — has to check first, or it hashes words
 *  this extension wrote. Both class shapes are matched because a host's own class attribute
 *  can sit before ours; our elements always start the attribute when they carry nothing else. */
const OURS = '[class^="mf-"], [class*=" mf-"]';

export default defineContentScript({
  // Every platform host is enumerated rather than wildcarded, and this list must stay in
  // step with PLATFORM_HOSTS (utils/platforms/hosts.ts). A host matched here but missing
  // there would let a content script race the popup for the session slot and log the
  // user out silently — see ownsAuthSession in utils/supabase.ts.
  matches: [
    '*://reddit.com/*',
    '*://www.reddit.com/*',
    // Reddit's newer web app, on its own name — the shreddit DOM as on the two above, and a
    // second name for PLATFORM_HOSTS.reddit rather than a platform of its own.
    '*://sh.reddit.com/*',
    // Reddit's legacy front end is a separate application (see PLATFORM_HOSTS.oldreddit),
    // so it needs its own match rather than being covered by the two above.
    '*://old.reddit.com/*',
    '*://news.ycombinator.com/*',
    '*://bsky.app/*',
    // Substack is the one platform here whose hosts cannot be enumerated: every
    // publication is its own subdomain, and the reader at the apex is a third surface.
    // Both are listed because `*.substack.com` is not relied on to cover the bare apex.
    // Custom-domain publications are deliberately not matched — see PLATFORM_HOSTS.
    '*://substack.com/*',
    '*://*.substack.com/*',
    // Both of Threads' names, in their bare and `www.` forms: the apex redirects to `www.`,
    // and the app is served at either.
    '*://threads.com/*',
    '*://www.threads.com/*',
    '*://threads.net/*',
    '*://www.threads.net/*',
    // Truth Social serves the app from the bare apex and redirects there from `www.`, but a
    // redirect is not a guarantee the `www.` name was never used.
    '*://truthsocial.com/*',
    '*://www.truthsocial.com/*',
    // Mastodon's default instance. Mastodon is federated — every other instance is its own
    // third-party domain — so this single host is the whole static match; the rest are
    // reached by the registration the runtime opt-in makes per instance (see
    // utils/mastodonOptIn.ts and the adapter seam in `main`), and the host list is the
    // matching `PLATFORM_HOSTS.mastodon`.
    '*://mastodon.social/*',
    '*://www.mastodon.social/*',
    // Quora serves each reader from a locale subdomain (`fr.quora.com` and the rest) and
    // redirects the apex to `www.`, so this is the one entry after Substack that cannot be
    // enumerated — but unlike a publication subdomain the set is Quora's own, which is why
    // the host rule for it is the `.`-prefixed suffix rather than a list of locales.
    '*://quora.com/*',
    '*://*.quora.com/*',
    // Dcard serves the app from `www.dcard.tw` and redirects the apex to it; both are listed
    // because the redirect is not a guarantee the bare name was never used.
    '*://dcard.tw/*',
    '*://www.dcard.tw/*',
    // PTT's web front end is `www.ptt.cc` and the apex redirects to it; both are listed
    // because the redirect is not a guarantee the bare name was never used.
    '*://ptt.cc/*',
    '*://www.ptt.cc/*',
    // Naver Cafe serves every cafe from `cafe.naver.com` — the board lists, the article
    // viewer and the mobile reader alike — so one host covers all of its surfaces. The
    // `*.` form is the one entry here that is not a redirect alias: Naver renders an
    // article's view inside a same-origin `cafe.naver.com/ca-fe/…` iframe, and a match
    // without it would leave the frame (and so the article) with no coordinator.
    '*://cafe.naver.com/*',
    '*://*.cafe.naver.com/*',
    // Facebook's desktop app, from the apex and the `web.` alias that redirects to `www.`.
    // The mobile readers (`m.` and `mbasic.`) are deliberately not matched — they are
    // different UIs whose anchors this adapter finds nothing in; see PLATFORM_HOSTS.
    '*://facebook.com/*',
    '*://www.facebook.com/*',
    '*://web.facebook.com/*',
    // The mobile site: a different application served in place, with its own anchor set in the
    // adapter (see PLATFORM_HOSTS.facebook). Listed here because this list must stay in step
    // with that one — a host matched here but missing there would let a content script race the
    // popup for the session slot.
    '*://m.facebook.com/*',
    // LinkedIn's desktop app, from the apex and from the locale subdomain each reader is
    // served (`de.linkedin.com` and the rest). The `*.` form covers those subdomains and
    // cannot cover the bare apex, so both are listed — as with Quora, the set is LinkedIn's
    // own rather than third parties', which is why it is a wildcard here at all.
    '*://linkedin.com/*',
    '*://*.linkedin.com/*',
    // Telegram's web app. The host serves two clients — the one this adapter reads is `/a/`, and
    // `/k/` is a different app that shares its session — so the path is gated inside the adapter
    // rather than here, where a match can only name a host.
    '*://web.telegram.org/*',
    // Mastodon is deliberately NOT listed here. It is federated, so there is no host to
    // enumerate; the coordinator reaches its adapter through the runtime opt-in instead
    // (see the opt-in seam in `main` and utils/mastodonOptIn.ts), and this file is
    // registered on an instance's origin only once the reader has enabled that instance.
  ],
  runAt: 'document_start',
  // Every frame of every platform page, because a platform's own UI can put a post in
  // one — Naver Cafe renders each article inside a `#cafe_main` iframe. A frame is only
  // driven for a platform whose adapter says its posts live there (`frameScoped`); every
  // other platform's frames are chrome this coordinator has no business reading, and the
  // bail below is what keeps them from being read. The button UI is styled by this
  // content script's own CSS, which WXT injects into the frames the script runs in — the
  // reason an adapter cannot simply reach into a frame from the top document instead.
  allFrames: true,
  async main() {
    // Static platforms first, then the runtime opt-in: Mastodon is federated, so its
    // adapter claims no host of its own and is reachable only by the reader having
    // enabled the instance they are on (see utils/mastodonOptIn.ts). `platformForHost`
    // stays synchronous and unchanged for every other platform — this awaits a storage
    // read only on a host no static adapter claims, which is the one case where the
    // answer is not already known.
    //
    // The adapter is named here rather than in `mastodonOptIn` on purpose. That module is
    // imported by the background, and a platform adapter reaches `utils/injecting`, whose
    // module body is written for a document. Pulling it into the service worker is what a
    // shared `optedInPlatform` would do, so the join lives in the one context that has a
    // DOM and the storage question stays a plain boolean.
    const resolved = platformForHost(location.hostname)
      ?? ((await isInstanceOptedIn(location.hostname)) ? mastodonAdapter : null);
    // `captureRoots`/`capture` are what make a platform DOM-fed. An adapter without them
    // reads its posts somewhere else and must not be driven from here.
    if (!resolved?.captureRoots || !resolved.capture) return;
    /** The DOM-capture half is optional on the interface (X has none), so narrow it once
     *  here rather than asserting non-null at every call site below. */
    const adapter = resolved as PlatformAdapter & {
      captureRoots(): Element[];
      capture(root: Element): CapturedPost | null;
    };

    // A child frame is driven only when the platform's posts live in one (see
    // `frameScoped`). Bailing here, before the adapter seam is installed and before
    // anything is logged, is what makes `allFrames` cost nothing on the platforms whose
    // frames are their own UI — a Substack embed, an ad slot — rather than posts.
    if (window !== window.top && !adapter.frameScoped) return;
    // Safari has been observed running this coordinator TWICE in one document: a single
    // `content_scripts` entry, one top frame, and two live copies of everything behind it —
    // the classifications, the Reveal/Hide latches, every registry Set — both driving the
    // same DOM. Each copy then rebuilds the top bar the other one owns, so the Reveal pill
    // is torn down and comes straight back. Nothing asks for a second copy and a second copy
    // can only ever disagree with the first, so the first one marks the document's own
    // isolated world and a copy arriving after it stands down. The mark is per world, not
    // per extension, so every other frame still gets its own coordinator and a navigation
    // starts fresh.
    if ((globalThis as any).__mfCoordinatorLive) {
      console.log(`[misinfo] ${location.hostname}: duplicate coordinator copy stood down`);
      return;
    }
    (globalThis as any).__mfCoordinatorLive = true;
    if (window !== window.top) announceFrame();

    const logPrefix = `[misinfo] ${adapter.id}:`;
    console.log(`${logPrefix} content script loaded on ${normalizeHost(location.hostname)}`);

    // Redirect-landing bail, same as X's relay: an OAuth return carries a disinfax_
    // marker and its tab is closed by the background within milliseconds. Classify
    // nothing from it — a logged-out landing page renders sample posts, and capturing
    // those would spend the user's balance on someone else's content on a torn-down tab.
    if (location.search.includes('disinfax_oauth=callback')) return;

    // The adapter seam must be installed before anything can inject, because the shared
    // UI asks it where a post lives and where its buttons go. It is installed on this
    // platform's world only, so X is untouched by construction.
    setPlatformAdapter(adapter);

    const textCaches: RelayTextCaches = { text: new Map(), translated: new Map() };
    /** Every post captured on this page, keyed by the adapter's id for it. Grows as the
     *  user scrolls; never shrinks, because a post that scrolls out can scroll back and
     *  must not be re-classified (and re-billed) when it does. */
    const captured = new Map<string, CapturedPost>();
    /** The subset the background has been told about: posts the reader has actually
     *  reached. Every entry costs one billed `fetch_tweet_and_touch_network` lookup, so
     *  this set — not `captured`, and not "every post in the DOM" — is what a page load
     *  is charged for. These platforms render far more than they show (a Bluesky home
     *  feed lays out ~50 items at once), and unlike X's virtualized timeline the whole
     *  page stays in the DOM, so "rendered" is not a usable stand-in for "reached". */
    const announced = new Set<string>();
    /** Which side of its own text each announced post is showing — `true` while a
     *  translation covers it. The background is told only when this changes, because the
     *  rest of a post's reading is fixed at capture time. */
    const reportedTranslation = new Map<string, boolean>();
    /** Ids whose data came from the platform's own API (see `captureNetwork`). The DOM
     *  must never overwrite one: the payload is the richer reading — a post's language,
     *  its ancestors, its untruncated body — and the markup is the fallback for posts no
     *  response covered, not a second opinion on the ones it did. */
    const networkIds = new Set<string>();

    /** How much text each captured post's DOM was showing when it was captured, as
     *  `domTextSignature` measures it. A later sweep compares against this to notice a post
     *  being shown with MORE text than the one it was classified as — the same id on
     *  another surface, reached without a page load. See `upgradeCapture`. */
    const capturedSignature = new Map<string, number>();

    /** The words each region of a captured post's text held at capture time, in region order.
     *
     *  A post already carrying our marks cannot be read off its own DOM, so the last clean
     *  reading of each of its blocks is kept here to be put back when the post is re-read —
     *  see `upgradeCapture`. Stored only for a post whose regions tile its text exactly, so a
     *  piece taken from here is the string the adapter sliced there in the first place. */
    const capturedPieces = new Map<string, string[]>();

    /** The window whose viewport decides what "on screen" means here.
     *
     *  Usually this one. Inside a same-origin child frame it is the TOP window instead: a
     *  frame holding Naver Cafe's article viewer is sized to its own content — measured
     *  at 10,998px tall while the reader's viewport is 819px — so its `innerHeight` is
     *  the whole article and every post in it would be "on screen" at once, announcing
     *  (and billing) a page of comments nobody has scrolled to. The reader scrolls the
     *  top document, so that is the viewport the question is actually about.
     *
     *  `frameElement` is same-origin only, and null in a frame sandboxed without
     *  `allow-same-origin`, so a cross-origin parent falls back to this window — the only
     *  viewport a coordinator there can honestly measure. */
    function viewportWindow(): Window {
      try {
        if (window !== window.top && window.frameElement) return window.top as Window;
      } catch { /* cross-origin or sandboxed: measure our own viewport */ }
      return window;
    }

    const viewport = viewportWindow();

    /** Where this frame's own origin sits in `viewport`, so a rect measured in this
     *  frame's coordinates can be compared against `viewport`'s height. Read per call
     *  rather than once: the frame moves with the document above it. */
    function frameOffset(): number {
      if (viewport === window) return 0;
      try {
        return window.frameElement?.getBoundingClientRect().top ?? 0;
      } catch { return 0; }
    }

    /** Is this post at, or within one screen of, the viewport?
     *
     *  This is the gate for every billed DB lookup on these platforms, so it is the whole
     *  reason a feed load stays cheap. One screen of look-ahead so a normal scroll never
     *  outruns the fetch, and one screen BEHIND so a flick that skips past a post still
     *  leaves it within reach of the next pass at rest. */
    function nearViewport(root: Element): boolean {
      const margin = viewport.innerHeight;
      const offset = frameOffset();
      const rect = root.getBoundingClientRect();
      return rect.bottom + offset >= -margin && rect.top + offset <= viewport.innerHeight + margin;
    }

    const core = createRelayCore({
      logTag: adapter.id,
      // Only the posts the reader has actually reached. The relay core re-announces this
      // set whenever the background loses its memory of the page (an MV3 worker restart
      // drops the port, and with it every tweet it was holding), so it has to mean "what
      // the reader has seen" rather than "everything captured so far" — otherwise each
      // restart re-bills a lookup for every post ever scrolled past.
      currentPosts: () => Array.from(announced, (id) => captured.get(id))
        .filter((c): c is CapturedPost => !!c)
        .map((c) => c.post),
      visibleIds: () => {
        const ids: string[] = [];
        for (const root of adapter.captureRoots()) {
          if (!nearViewport(root)) continue;
          const id = adapter.postIdOf(root);
          if (id) ids.push(id);
        }
        return ids;
      },
      textCaches: () => textCaches,
      // Which side of a post's translation is on screen, for the platforms that have one.
      // Only Telegram so far, and it is asked on a click rather than on every sweep, so
      // reading the message's mark here is cheap. Platforms with no translate control
      // report no opinion rather than a guess — see `platform-translate-affordances`.
      //
      // The text and its language are read only for the TRANSLATED side, and they are
      // load-bearing rather than a convenience: the captured payload carries both sides
      // only for a post that was ALREADY translated when it was announced. A reader who
      // translates a post afterwards leaves the capture holding the source alone, and the
      // press hands the background `onHoldTweets` — the tweet as first captured — so
      // without these two the click preclassifies the source and files every range under
      // the source's language while the reader is looking at another one.
      displayedSideFor: (postId) => {
        if (!adapter.displayedTranslationLocale) return { side: null, text: null, locale: null };
        const root = adapter.postRoots(postId)[0];
        if (!root) return { side: null, text: null, locale: null };
        const locale = adapter.displayedTranslationLocale(root);
        if (!locale) return { side: 'ORIGINAL', text: null, locale: null };
        return { side: 'TRANSLATED', text: adapter.displayedText?.(root) ?? null, locale };
      },
    });

    core.start();

    /** Hand the background every post the reader can currently reach that it has not been
     *  told about yet, in DOM order.
     *
     *  This is the only place a post is ever announced, which is what makes the whole
     *  page's billed work proportional to what is looked at: a feed that renders fifty
     *  items announces the five in view, and the other forty-five wait in `captured`
     *  until the reader scrolls to them. Cheap to re-run — it is one rect read per root
     *  and a set lookup per id. */
    function announceVisible(roots: Element[] = adapter.captureRoots()): void {
      const fresh: MainTweet[] = [];
      for (const root of roots) {
        const id = adapter.postIdOf(root);
        if (!id) continue;
        // A long-form post is announced like any other: the buttons the reader gets on it
        // are the ones every other post has, and clicking one behaves identically. What it
        // keeps — and what `isLongForm` still decides — is the selection: a passage taken
        // out of a long post stays a passage, with the post's own bounds, author and chain
        // as its context, instead of firing the post whole the way a selection inside a
        // short post does. See `buttonlessPostFor` in entrypoints/selection.ts.
        //
        // This costs nothing at announce time. The background answers an announce from the
        // DB — a cached verdict where one exists, and where none does an on-hold
        // classification that parks the post and runs nothing — so the paid work still
        // happens on the click, exactly as it does for a short post.
        //
        // The verdict is stamped on the post because the bundle that resolves a selection
        // cannot reach it: `entrypoints/selection.ts` carries its own copy of the adapter
        // module, and the state some adapters answer from (Mastodon's captured reply edges)
        // is only in this one. Stamped for every root on every sweep, before the guards
        // below, because the reader can select inside a post this sweep will not announce.
        // `toggleAttribute` writes only when the answer has changed.
        root.toggleAttribute('mf-longform', !!adapter.isLongForm?.(root));
        if (announced.has(id)) continue;
        const post = captured.get(id);
        if (!post || !nearViewport(root)) continue;
        // A post with no words gets no buttons, whatever any adapter's `capture` decided: an
        // image-only story is not something to fact-check, and a pill on one is a pill with
        // nothing behind it. Every adapter's own capture refuses an empty body today, but this
        // is the one place a post is announced, so the guarantee belongs here rather than in
        // seven places that each have to remember it. Not counted either — a post with no text
        // carries nothing to classify — and still its comments' ancestor, because the guard is
        // on the ANNOUNCE rather than on the capture.
        if (!post.post.text.trim()) continue;
        announced.add(id);
        reportedTranslation.set(id, !!adapter.displayedTranslationLocale?.(root));
        fresh.push(post.post);
      }
      // The chain count is what an ancestor's being filed looks like from this side: an
      // ancestor has no element and is never announced, so the only evidence that a post was
      // filed with the context it is classified in is its own `replyingTo`.
      const chained = fresh.filter((post) => post.replyingTo).length;
      console.log(`${logPrefix} announcing ${fresh.length} post(s)${chained > 0 ? `, ${chained} with a chain` : ''}`);
      for (const [i, post] of fresh.entries()) {
        core.send({
          type: 'CLASSIFY_TWEETS',
          data: [post],
          batchId: `batch_${Date.now()}_${i}`,
          locale: core.locale(),
        });
      }
    }

    /** Recover the source text of every post in reach that its platform is showing a
     *  translation of, so that `capture` can read the post's own words.
     *
     *  This is what a platform that hides one of a post's two sides behind its own control
     *  costs, and it is paid here — before the post is captured — for two reasons. The hash
     *  that identifies a post is computed from its source text, so a post captured while
     *  translated would be filed as a second, unrelated post in that language, and it would
     *  be the reader's own language that decided which of the two they got. And doing it
     *  before the post is announced means the reader sees the right buttons on it from the
     *  start, rather than buttons that change a moment later.
     *
     *  Every rendered root is asked for, not just the ones in reach, because that is the set
     *  `capture` runs over: a post captured while translated is mis-filed permanently, and
     *  the moment a post is rendered is the only moment its source can be read for free.
     *
     *  Off-screen posts first. Recovering a source is a visible change to the post for a few
     *  hundred milliseconds (see the adapter), and a post the reader has not scrolled to yet
     *  is one nobody sees it happen to. */
    async function revealSources(roots: Element[]): Promise<void> {
      if (!adapter.revealSource || !adapter.displayedTranslationLocale) return;
      const pending: Element[] = [];
      for (const root of roots) {
        const id = adapter.postIdOf(root);
        if (!id || captured.has(id) || networkIds.has(id)) continue;
        if (!adapter.displayedTranslationLocale(root)) continue;
        // A post under the pointer is left for the next pass: a host menu opening under the
        // reader's cursor is the one they are most likely to see, and it can eat their next
        // click. This is a delay rather than a refusal — the next sweep tries again.
        if (root.matches(':hover')) continue;
        pending.push(root);
      }
      if (pending.length === 0) return;
      const offset = frameOffset();
      const onScreen = (el: Element) => {
        const rect = el.getBoundingClientRect();
        return rect.bottom + offset > 0 && rect.top + offset < viewport.innerHeight;
      };
      pending.sort((a, b) => Number(onScreen(a)) - Number(onScreen(b)));
      console.log(`${logPrefix} reading the source of ${pending.length} translated post(s)`);
      for (const root of pending) await adapter.revealSource(root);
    }

    /** Give the posts the host is showing a clipped render of their whole text.
     *
     *  A post is hashed from its text, so a body the host cut short is one nothing can be
     *  said about: filed as it stands it would name a prefix, and a prefix names no post.
     *  So the adapter is asked to drive the host's own expander first, and only then is the
     *  post captured.
     *
     *  Same order and same cautions as `revealSources`: off-screen posts first, because
     *  this is a visible change to the page, and a post under the pointer is left for the
     *  next pass so the reader's own click cannot land on an affordance we just took away. */
    async function revealClippedBodies(roots: Element[]): Promise<void> {
      if (!adapter.revealClipped || !adapter.bodyClipped) return;
      const pending: Element[] = [];
      for (const root of roots) {
        const id = adapter.postIdOf(root);
        if (!id || captured.has(id) || networkIds.has(id)) continue;
        if (!adapter.bodyClipped(root)) continue;
        if (root.matches(':hover')) continue;
        pending.push(root);
      }
      if (pending.length === 0) return;
      const offset = frameOffset();
      const onScreen = (el: Element) => {
        const rect = el.getBoundingClientRect();
        return rect.bottom + offset > 0 && rect.top + offset < viewport.innerHeight;
      };
      pending.sort((a, b) => Number(onScreen(a)) - Number(onScreen(b)));
      console.log(`${logPrefix} expanding ${pending.length} clipped post(s)`);
      for (const root of pending) await adapter.revealClipped(root);
    }

    /** How much text a post's DOM is offering right now, cheaply.
     *
     *  This is the tripwire for `upgradeCapture`, run for every already-captured root on every
     *  sweep, so it must not be `capture`: an adapter's `capture` composes the post, and on
     *  platforms that carry a payload it can parse one. Reading the elements `capture` would
     *  read is one lookup each, which is what `announceVisible` already does on the same pass
     *  to decide whether a post is long-form.
     *
     *  Only lengths are compared, never the strings, so a host re-wrapping a line does not read
     *  as new text. Our own marks inflate the number, and that is wanted in one direction: a
     *  post that grows marks but no text cannot pass the comparison that follows (`upgradeCapture`
     *  composes its candidate from the clean readings and refuses anything not strictly longer),
     *  so a false trip costs one capture and yields nothing. */
    function domTextSignature(root: Element): number {
      const id = adapter.postIdOf(root) ?? '';
      const ref = { id, isQuoted: false };
      const regions = adapter.textRegions?.(root, ref) ?? null;
      if (regions && regions.length > 0) {
        let n = 0;
        for (const r of regions) n += (r.el.textContent ?? '').length;
        return n;
      }
      const el = adapter.textElement(root, ref);
      return (el?.textContent ?? '').length;
    }

    /** Give a post the fuller text its DOM has started offering.
     *
     *  An id is not a text, and these platforms render one id on more than one surface — which
     *  the reader moves between without a page load. Measured on Reddit 2026-10-05, in a single
     *  page instance: a subreddit card renders a link post as its TITLE alone and contains no
     *  `shreddit-post-text-body` at all, while the permalink that card links to renders the same
     *  id with its body — 96 characters against 620. Reddit navigates between the two
     *  client-side, so `captured` survives the hop, and the skip for an id already in it then
     *  pins the post to the CARD's reading: the page that shows the body never reads it, the
     *  hash is computed over a prefix of the post, and the database — which is keyed by the
     *  hash of the text — has no row under it. The post has been classified, in full, and the
     *  reader gets no reveal: only a fresh classification of the headline, painted over the
     *  headline, while the body underneath is never fact-checked at all.
     *
     *  So read again, and let the fuller text replace the capture. What makes this delicate is
     *  that by the time the body appears the post may already be carrying our own markup — the
     *  reader can have clicked Disinfact on the card's reading while still on that surface — and
     *  a marked block is not the post's words: the annotation appends our correction into it.
     *  So the reading is assembled block by block: a block with no mark of ours on it is taken
     *  from the adapter's reading of the page as it stands, and a marked block is put back the
     *  way it was captured (`capturedPieces`), which is the last reading of it that was clean.
     *  The separators between blocks come from the adapter's own composition, so the string
     *  handed on is the one the adapter would have produced for this DOM had nothing of ours
     *  been in it — which is what the hash has to be.
     *
     *  Guards, in order, and every one of them fails closed to the post as captured:
     *
     *  - Never a post showing a translation: `capture` would read the translated side, and the
     *    hash would then name the post in the reader's language instead of its own.
     *  - Never a post on a surface its platform fed from the API (`networkIds`): a payload's
     *    reading is authoritative for the posts it covered, exactly as it is when the two
     *    arrive the other way round (see `absorbNetworkRecords`).
     *  - Never anything but STRICTLY more text, so going back to a poorer surface cannot shrink
     *    a post back to the prefix it has already been classified without.
     *  - Never a marked block whose clean reading was never stored — including any post the
     *    platform renders as one unregioned element, where there is no block to put back. */
    async function upgradeCapture(root: Element, id: string, prior: CapturedPost): Promise<CapturedPost | null> {
      if (adapter.displayedTranslationLocale?.(root)) return null;
      const ref = { id, isQuoted: false, text: prior.post.text };
      const regions = adapter.textRegions?.(root, ref) ?? null;
      const blocks = regions && regions.length > 0 ? regions.map((r) => r.el) : null;
      const sole = blocks ? null : adapter.textElement(root, ref);
      const marked = (blocks ?? (sole ? [sole] : [])).some((el) => el.querySelector(OURS));
      if (!marked) {
        // Nothing of ours is inside the post's text, so the adapter's own reading is the post's
        // own words — exactly the string it would have captured had it read this surface first.
        const lifted = adapter.capture(root);
        return lifted && lifted.post.text.length > prior.post.text.length ? lifted : null;
      }
      if (!regions || !blocks) return null;
      const held = capturedPieces.get(id);
      if (!held) return null;
      const lifted = adapter.capture(root);
      if (!lifted) return null;
      let text = '';
      for (let i = 0; i < regions.length; i++) {
        if (i > 0) text += lifted.post.text.slice(regions[i - 1].end, regions[i].start);
        if (!blocks[i].querySelector(OURS)) {
          text += lifted.post.text.slice(regions[i].start, regions[i].end);
          continue;
        }
        const clean = held[i];
        if (clean === undefined) return null;
        text += clean;
      }
      if (text.length <= prior.post.text.length) return null;
      return { post: { ...lifted.post, text }, replyParentId: lifted.replyParentId };
    }

    /** Take a post's fuller reading in place of the one it was captured with.
     *
     *  The background still has to hear about it: a click is answered from the text the post was
     *  ANNOUNCED with, so the id is dropped from `announced`, and the caller's `announceVisible`
     *  re-announces it — with the fuller text, whose hash the database holds a row for.
     *
     *  The clean pieces are dropped along with the capture they came from: a substituted block
     *  has a different length from the one the adapter read, so the blocks of the new text no
     *  longer sit at the offsets this DOM reports, and a second substitution could not be made
     *  from them. A post that has just been given its whole text has no further reading to
     *  reach anyway — only a surface larger than the post, which is nothing this needs. */
    function adoptUpgrade(root: Element, id: string, lifted: CapturedPost): void {
      nameCapturedLanguage(lifted.post);
      captured.set(id, lifted);
      capturedSignature.set(id, domTextSignature(root));
      capturedPieces.delete(id);
      textCaches.text.set(id, lifted.post.text);
      if (lifted.post.translatedText) textCaches.translated.set(id, lifted.post.translatedText);
      announced.delete(id);
      console.log(`${logPrefix} re-read ${id}: now ${lifted.post.text.length} chars`);
    }

    /** Lift every newly-rendered post out of the page, then announce what is in reach.
     *
     *  Sweeping the whole page each time rather than diffing is deliberate: the adapters'
     *  `captureRoots` is a single querySelectorAll over a tag vocabulary, which is far
     *  cheaper than tracking which nodes the platform added and removed — and on these
     *  platforms the post set changes wholesale on every navigation anyway.
     *
     *  Asynchronous, and coalesced rather than overlapped, because a post can have to be
     *  made readable before it can be captured — a translated one read back into its source
     *  (`revealSources`), a clipped one given its whole text (`revealClippedBodies`) — and
     *  both are real interactions with the host, which mutate the page, which is exactly
     *  what this sweep is watching for. A sweep asked for while one is running is folded
     *  into a single further pass rather than queued one per mutation. */
    let sweeping = false;
    let sweepQueued = false;
    async function sweep(): Promise<void> {
      if (sweeping) {
        sweepQueued = true;
        return;
      }
      sweeping = true;
      try {
        do {
          sweepQueued = false;
          await sweepOnce();
        } while (sweepQueued);
      } finally {
        sweeping = false;
      }
    }

    async function sweepOnce(): Promise<void> {
      const roots = adapter.captureRoots();
      await revealSources(roots);
      await revealClippedBodies(roots);
      let added = 0;
      for (const root of roots) {
        const id = adapter.postIdOf(root);
        if (!id || networkIds.has(id)) continue;
        const prior = captured.get(id);
        if (prior) {
          // A post already captured is normally left alone — but an id can be rendered on more
          // than one surface, and this one may now be the surface that shows more of it. The
          // signature is a length comparison, so a post that has not grown is skipped without
          // touching the DOM; see `upgradeCapture` for what happens when it has.
          if (domTextSignature(root) <= (capturedSignature.get(id) ?? 0)) continue;
          const fuller = await upgradeCapture(root, id, prior);
          if (!fuller) continue;
          adoptUpgrade(root, id, fuller);
          added++;
          continue;
        }
        const lifted = adapter.capture(root);
        if (!lifted) continue;
        nameCapturedLanguage(lifted.post);
        captured.set(id, lifted);
        capturedSignature.set(id, domTextSignature(root));
        // The blocks this text was read from, kept in case the post has to be re-read after our
        // own markup has gone into one of them. Stored only when the regions tile the text
        // exactly, so a piece taken back out of here is the string the adapter sliced there.
        const regions = adapter.textRegions?.(root, { id, isQuoted: false });
        if (regions && regions.length > 0
          && regions[0].start === 0 && regions[regions.length - 1].end === lifted.post.text.length) {
          capturedPieces.set(id, regions.map((r) => lifted.post.text.slice(r.start, r.end)));
        }
        textCaches.text.set(lifted.post.id, lifted.post.text);
        if (lifted.post.translatedText) textCaches.translated.set(lifted.post.id, lifted.post.translatedText);
        added++;
      }
      if (added > 0) relink();
      // Announced even with nothing new: a mutation that only re-lays-out the page (an
      // expanded thread pushing posts around) changes which posts are in reach without
      // adding any.
      announceVisible(roots);
      reportTranslations(roots);
    }

    /** Tell the background when the side a post is showing changes.
     *
     *  Everything else about a post is read once, when it is captured; the one thing that can
     *  move afterwards is the reader's own language toggle — Telegram's message menu, X's
     *  Grok row — and it changes which language the post's highlights have to address. The
     *  background either swaps in the other side's cached ranges or offers the Localize
     *  button; without this it would keep painting the ranges of the side that was captured,
     *  over words that are no longer on screen.
     *
     *  Sent only on an actual change, and only for a post captured with both sides: a post the
     *  platform states no translation for has nothing to flip between, and a locale the
     *  background cannot resolve would be filed under a name nothing reads. */
    function reportTranslations(roots: Element[]): void {
      if (!adapter.displayedTranslationLocale) return;
      for (const root of roots) {
        const id = adapter.postIdOf(root);
        if (!id || !announced.has(id)) continue;
        const locale = adapter.displayedTranslationLocale(root);
        const translated = locale !== null;
        if (reportedTranslation.get(id) === translated) continue;
        reportedTranslation.set(id, translated);
        console.log(`${logPrefix} ${id} flipped to its ${translated ? `translation (${locale})` : 'source'}`);
        core.send({
          type: 'SET_DISPLAYED_LOCALE',
          // Symbolic on the way back: the background resolves it against the tweet it holds,
          // which is the only place the source's own language is recorded.
          //
          // The text is sent only for the translated side. A post captured with its source on
          // screen holds no destination language, so the background has nothing to resolve
          // that side from and would otherwise localize against the source while filing the
          // ranges under the locale being read. Going the other way needs no help: the source
          // IS the text the background holds.
          data: {
            tweetId: id,
            textLocale: locale ?? 'original',
            displayedText: translated ? adapter.displayedText?.(root) ?? null : null,
          },
        });
      }
    }

    /** Re-link the WHOLE captured set, not just the new posts: a comment captured on an
     *  earlier sweep can be the parent of one captured now, and the chain builder only
     *  links ids that are present in what it is given. */
    function relink() {
      hydrateCapturedChains(Array.from(captured.values()));
    }

    /** Take in the posts a platform's own API described, which arrive before the markup
     *  that renders them does.
     *
     *  These land in the same map the sweep fills, so everything downstream — the billed
     *  announce gate, the chain linker, the text cache the highlighter matches against —
     *  sees one set of posts and does not care which half produced a given one. The
     *  `networkIds` marker is what keeps the sweep from replacing a payload's reading
     *  with the markup's on a later mutation.
     *
     *  Announcement stays behind `announceVisible`, so a response covering fifty posts
     *  still bills for the handful the reader has actually reached: a feed is fetched
     *  whole and rendered lazily, and the payload is no reason to classify the tail. */
    function absorbNetworkRecords(records: unknown[]): void {
      if (!adapter.captureNetwork) return;
      const lifted = adapter.captureNetwork(records);
      let added = 0;
      let withParents = 0;
      let withQuotes = 0;
      for (const entry of lifted) {
        const id = entry.post.id;
        if (!id) continue;
        networkIds.add(id);
        // A post the reader has already reached was classified on the text the DOM gave it,
        // and that text is what its claims' offsets are into. Overwriting it now would leave
        // one id holding two texts — the collision `post-id-names-one-text` exists to
        // prevent — and would hand the second one to the classifier on the next re-announce
        // (a worker restart replays `currentPosts`), billing a second classification for a
        // post already paid for. The payload's reading is what posts the reader has NOT
        // reached yet are classified from, which is the race this half exists to win.
        if (announced.has(id)) continue;
        nameCapturedLanguage(entry.post);
        captured.set(id, entry);
        textCaches.text.set(id, entry.post.text);
        added++;
        if (entry.replyParentId) withParents++;
        if (entry.post.quoting) withQuotes++;
      }
      // A payload is not always a capture, and this runs either way. An adapter may take one
      // as a statement about a post the page also renders and file nothing of its own, or file
      // only part of what it describes — Substack files the notes above the one on screen and
      // leaves the rest to the markup, because a post there is filed with the side it is
      // showing and only `capture` knows which that is. What any of those unblocks is a post
      // whose capture was deferred waiting for this response: a note shown translated cannot
      // be filed at all until its source is known. That post is still uncaptured, and the
      // sweep is what files it — the next host mutation would do it too, but a reader
      // scrolling a list the host never re-renders fires none, and the post would sit there
      // with no buttons.
      void sweep();
      if (added === 0) return;
      // Logged because the two feed paths differ in what reaches the classifier — a payload
      // carries the post's language and its ancestors, the markup carries neither — so which
      // one a given post came from is the first thing to know when a post behaves oddly.
      // The parent and quote counts are that context's only outward sign: nothing else about
      // a captured post is visible from the page.
      console.log(`${logPrefix} absorbed ${added} post(s) from the network${withParents > 0 ? `, ${withParents} with a parent` : ''}${withQuotes > 0 ? `, ${withQuotes} with a quote` : ''}`);
      relink();
      announceVisible();
    }

    if (
      adapter.captureNetwork ||
      adapter.absorbTranslations ||
      adapter.absorbThreadEdges ||
      adapter.absorbPostIds ||
      adapter.absorbCommentTexts
    ) {
      window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        const data = (event as MessageEvent).data;
        if (!data || !Array.isArray(data.records)) return;
        if (data.type === 'MF_NETWORK_POSTS') {
          absorbNetworkRecords(data.records);
          return;
        }
        if (data.type === 'MF_NETWORK_POST_IDS') {
          // Which post each of the payload's own names stands for — the one fact that makes a
          // post and its comments share an id (see `absorbPostIds`). Remembered rather than
          // captured, so there is nothing to announce: the sweep below is what files a post
          // whose id this has just resolved, and it is swept rather than left to the next
          // mutation because the payload and the render it describes are two promise chains
          // off one request, and a post captured between them would otherwise be filed under
          // the name the markup states — permanently, since nothing re-keys a captured post.
          adapter.absorbPostIds?.(data.records);
          console.log(`${logPrefix} absorbed ${data.records.length} post id(s) from the network`);
          void sweep();
          return;
        }
        if (data.type === 'MF_NETWORK_COMMENT_TEXTS') {
          // What each comment says, as the platform's own payload states it — the whole text a
          // comment the page truncated is completed from (see `absorbCommentTexts`). The sweep
          // is what files one: a clipped comment is refused while the text is unknown, so a
          // comment this describes that was already swept is swept again and filed whole now.
          adapter.absorbCommentTexts?.(data.records);
          console.log(`${logPrefix} absorbed ${data.records.length} comment text(s) from the network`);
          void sweep();
          return;
        }
        if (data.type === 'MF_NETWORK_THREAD_EDGES') {
          // A platform's own statement of which comment each comment answers — the one
          // fact its markup gets wrong beyond one level (see `absorbThreadEdges`). The
          // adapter has already remembered them, so a comment captured from here on reads
          // the right parent; this pass is for the ones captured before the payload
          // arrived, which on these platforms is a real race rather than a theoretical
          // one: a response and the render it describes are two promise chains off one
          // request, and which side hears about it first is not guaranteed.
          const edges = adapter.absorbThreadEdges?.(data.records);
          console.log(`${logPrefix} absorbed ${data.records.length} thread edge(s) from the network`);
          let corrected = 0;
          for (const [id, parentId] of edges ?? []) {
            // Never for a post the background has been told about: it was filed with the
            // chain we had, and the chain is part of the text hash the reader's row was
            // billed on. Re-sending would bill a second classification for one post — the
            // same reason `absorbNetworkRecords` leaves an announced post alone.
            if (announced.has(id)) continue;
            const entry = captured.get(id);
            if (!entry || entry.replyParentId === parentId) continue;
            entry.replyParentId = parentId;
            corrected++;
          }
          if (corrected > 0) {
            console.log(`${logPrefix} corrected ${corrected} thread edge(s) from the network`);
            relink();
          }
          // Then swept, because the edges may describe comments the page has rendered but
          // no mutation has swept yet — and a comment captured by that sweep reads the
          // corrected parent on its first pass rather than being amended after the fact.
          void sweep();
          return;
        }
        if (data.type !== 'MF_NETWORK_TRANSLATIONS') return;
        // Remembered, not captured: a translation is one fact about a post the adapter
        // already holds (see `absorbTranslations` in types.ts), so there is nothing to
        // announce, link or cache here.
        adapter.absorbTranslations?.(data.records);
        // Then swept, because a translation is the one thing an adapter can learn about a
        // post without the page changing — and the change it describes is exactly what
        // `reportTranslations` looks for. The DOM swap that puts the translation on screen is
        // its own mutation and will usually have swept already, but the response and the
        // re-render are two promise chains off one fetch, so which of them this side hears
        // about first is not guaranteed. Sweeping is cheap and coalesced, and it is the only
        // way a flip this side was told about can be certain of being reported.
        void sweep();
      });
      // The MAIN-world interceptor has been running since document_start and buffered
      // everything it saw before this listener existed — the order the two worlds start
      // in is not guaranteed. Ask for that backlog now rather than wait for the next page
      // of the feed.
      window.postMessage({ type: 'MF_NETWORK_HELLO' }, '*');
    }

    /** Sweep on every host-page change, behind the same guard X's relay uses.
     *
     *  Our own injections mutate the DOM continuously while a fact-check streams in
     *  (popover text, segment and badge updates), so an unguarded observer would re-run
     *  the sweep on every one of those ticks — competing with the main thread for the
     *  click that opens a popover. */
    function setupObserver() {
      if (!document.body) {
        setTimeout(setupObserver, 50);
        return;
      }
      const observer = new MutationObserver((mutations) => {
        if (!mutations.some(hasNonExtensionChange)) return;
        void sweep();
      });
      observer.observe(document.body, { childList: true, subtree: true });
      void sweep();
    }

    // A comment thread expands without any mutation of the post list itself, and some
    // platforms swap their whole post set on an in-page navigation that fires no
    // mutation we can see. Both are covered by re-sweeping when the page settles.
    window.addEventListener('popstate', () => void sweep());

    /** Announce posts as they scroll into reach.
     *
     *  The observer below cannot cover this: these platforms render their post list once
     *  and leave it alone, so scrolling changes no DOM and fires no mutation — and since
     *  only posts in reach are ever announced, the rest would never be announced at all.
     *  `capture` picks up scrolls on an inner feed container, which do not bubble to the
     *  window. Coalesced because `scroll` fires continuously and each pass measures every
     *  root.
     *
     *  Inside a frame the scrolling document is the one ABOVE it (see `viewportWindow`),
     *  and its scroll events do not arrive here, so that window is listened to as well. */
    let scrollReportTimer = 0;
    const onScroll = () => {
      if (scrollReportTimer) return;
      scrollReportTimer = window.setTimeout(() => {
        scrollReportTimer = 0;
        announceVisible();
      }, 150);
    };
    for (const target of new Set([window, viewport])) {
      target.addEventListener('scroll', onScroll, { passive: true, capture: true });
    }

    setupObserver();
  },
});
