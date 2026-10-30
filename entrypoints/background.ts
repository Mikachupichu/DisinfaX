/** Background service worker — the extension's pipeline coordinator.
 *
 *  Content scripts never talk to the network or the database. They send captured tweets
 *  here over a long-lived "classify" port, and this worker decides what each tweet needs:
 *  a hash lookup against the DB, a preclassification pass to find claims, research on
 *  individual claims, translation, or highlight re-localization. Results are broadcast
 *  back to every connected relay, which injects them into the page.
 *
 *  Two things shape almost all the complexity below:
 *
 *  1. Manifest V3 kills an idle service worker after ~30 seconds. Nothing here can be
 *     assumed to survive between messages, so anything that must outlive a restart is
 *     re-derived or read back from storage, and long operations hold a keep-alive.
 *
 *  2. Work is deduplicated aggressively. The same tweet arrives repeatedly as the user
 *     scrolls (every timeline XHR re-sends it), and each redundant classification would
 *     spend the user's balance. Hence the many caches, in-flight promise maps, and
 *     "already did this" sets declared at the top of the closure — they are the
 *     load-bearing guard against double-spending, not incidental memoization.
 */
import { preClassify, refreshClaim, computeTweetHash, backgroundTranslate, backgroundTranslateClaim, backgroundHighlightRange, backgroundAnnotate, extractTweetUrls, TEST_LOCALE, normalizeSources, setWorkerErrorHandler, normalizeText, type AnnotLocators, type HighlightAnnotContext } from "../utils/intelligence";
import { subscribeRow, fetchTweetAndTouchNetwork, getFullClaim, hashToBytea, subscribeFunds, getFunds, visibleTotal, type ClaimPayload, type SubscriptionHandle, type Funds, type FundsSubscription } from "../utils/realtime";
import { supabase, ensureFreshSession, asOAuthProvider, SUPABASE_AUTH_STORAGE_KEY } from "../utils/supabase";
import { adoptNativeSession, appEndedSessionAt, markSelectionFactCheck, NATIVE_SIGNOUT_KEY } from "../utils/nativeSession";
import { SELECTION_FACT_CHECK_KEY } from "../utils/guideOverlay";
import { findExactMatch, resolveHighlightRange, sha256HexSync, selectHighlightRevision, selectAnnotationRevision, splitHighlightKey, isLocatedRange, sameLocatedRange } from "../utils/textBreakup";
import { Classification, Claim, Source, sameLanguage } from "../data/Classification";
import { MainTweet, Tweet, MAX_CLASSIFY_CHARS, UNKNOWN_LANGUAGE } from "../data/Tweets";
import { COLOR_SCHEME_MESSAGE, applyToolbarIcon, restoreToolbarIcon, toolbarAction } from "../utils/toolbarIcon";
import { ERROR_CODES } from "../utils/errorCodes";
import { NATIVE_APP_ID, NATIVE_CALLBACK_SCHEME } from "../utils/nativeHost";
import {
  MASTODON_OPT_IN_MESSAGE, MASTODON_OPT_OUT_MESSAGE,
  MASTODON_COORDINATOR_FILE, MASTODON_INTERCEPTOR_FILE,
  normalizeInstanceHost, instanceOriginPatterns,
  readOptedInInstances, writeOptedInInstances,
  registerInstanceScripts, unregisterInstanceScripts, reconcileInstanceScripts,
} from "../utils/mastodonOptIn";
import type { ScriptPublicPath } from "wxt/utils/inject-script";

// [ttft-ext] Fires once per service worker load — if this appears more than once in a
// single test session, the service worker restarted mid-session (see the MV3 note at
// the top of this file), dropping any Realtime channel that was open at the time.
console.log(`[ttft-ext] background service worker (re)started at ${new Date().toISOString()}`);

// [ttft-ext] Stamped onto every mergeClaimPayload log line so two genuinely separate
// calls can't visually collapse into what looks like one in the console.
let mergeClaimPayloadCallCounter = 0;

let batchIdCounter = 0;
/** Unique id for a batch of work originating in the background (as opposed to the
 *  relay-supplied ids). The counter disambiguates batches created within the same
 *  millisecond, which a timestamp alone would collide on. */
function nextBatchId(): string {
  return `batch_${++batchIdCounter}_${Date.now()}`;
}

/** Debug-only display-locale override, mirrored from EXTENSION storage — the SAME
 *  `mfLocale` key relay.content.ts and utils/injecting.ts read (never page
 *  localStorage, which the host page could write). Cached in module scope because
 *  getUiLocale() is synchronous.
 *
 *  The background needs it too: the relay only attaches its locale to the messages
 *  the user's click originates, but claims reached from a DEFERRED path (a
 *  Fact-Check All that lands mid-preclassify and is replayed later out of
 *  broadcastClassification → localeFromClassification) fall back to getUiLocale().
 *  Without the override those two paths disagree — preclassify keys the claim under
 *  the override ("es") while classification keys it under the browser UI language
 *  ("en-US"), which inserts a duplicate claim row instead of updating the existing
 *  one (exactly the "e.g. 'en' vs 'en-US'" split localeFromClassification warns
 *  about). Kept verbatim, NOT normalized, so it stays byte-identical to what the
 *  relay sends for the non-deferred paths. */
let storedLocaleOverride: string | null = null;
try {
  browser.storage.local.get('mfLocale').then((r: any) => {
    storedLocaleOverride = (r?.mfLocale as string) ?? null;
  }).catch(() => {});
  browser.storage.onChanged.addListener((changes: Record<string, any>, area: string) => {
    if (area === 'local' && 'mfLocale' in changes) storedLocaleOverride = (changes.mfLocale.newValue as string) ?? null;
  });
} catch {}

function getUiLocale(): string {
  if (TEST_LOCALE) return TEST_LOCALE;
  if (storedLocaleOverride) return storedLocaleOverride;
  try { return browser?.i18n?.getUILanguage?.() ?? 'en'; } catch { return 'en'; }
}

export default defineBackground({
  // Scoped per browser, because the two MV2 targets want opposite things.
  //
  //   safari  — MUST be non-persistent. iOS/iPadOS refuse to load an extension whose
  //             background is persistent at all ("Invalid `persistent` manifest entry").
  //   firefox — MUST stay persistent (MV2's default). Setting it false here turned the
  //             background into an event page that unloads when idle, which contradicts
  //             what this file assumes: see the funds-hub note further down, which relies
  //             on MV2's background page surviving across account switches. A long
  //             classification run is exactly the kind of work an event page suspends
  //             out from under, leaving the caller waiting on a reply that never comes.
  //   chrome  — omitted entirely. MV3 emits a `service_worker` and ignores this key.
  //
  // Browsers absent from the map resolve to `undefined`, so the key is simply left out.
  persistent: { safari: false, firefox: true },
  main() {
  console.log("Background service worker started.");

  // ─────────────────────────────────────────────────────────────────────────
  //  Pipeline state. All of it is per-service-worker-lifetime and rebuilt from
  //  scratch after a restart; none of it is a source of truth (the DB is).
  // ─────────────────────────────────────────────────────────────────────────

  /** A cached classification plus every batch that asked for it, so clearBatch() can
   *  evict a tweet that several batches happen to share. */
  type CacheEntry = { classification: Classification; batchIds: Set<string> };
  const classificationCache = new Map<string, CacheEntry>();
  const researchCache = new Map<string, { confidence: number, veracity: number, reasoning: string, reasoningLocale?: string; sources?: Source[]; dbClaimText?: string; embedding?: number[]; lastClassification?: string; freshlyResearched?: boolean; veracity_change_duration?: string }>();
  const batchTweets = new Map<string, MainTweet[]>();
  const activePorts = new Set<any>();
  /** Cache of the latest MainTweet seen for each tweet id, used to detect
   *  translation toggles and to know which text/locale is currently displayed. */
  const tweetCache = new Map<string, MainTweet>();
  (globalThis as any).__classificationCache = classificationCache;
  (globalThis as any).__tweetCache = tweetCache;
  /** Track which highlight locales have been localized per tweet id so we don't
   *  re-run the highlight worker for the same locale repeatedly. */
  const localizedHighlightLocales = new Map<string, Set<string>>();
  /** Localizations actually running right now, keyed like `localizedHighlightLocales`. A
   *  press whose body is already in flight is not a second job: it is the reader seeing the
   *  Localize button before the wheel and clicking again, which used to start a second paid
   *  run for the same body (the run only joins `localizedHighlightLocales` when it finishes). */
  const localizationInFlight = new Set<string>();
  /** Track tweets that have already had re-research / background localization fired
   *  in this session, so repeated timeline XHRs don't keep writing to the DB. */
  const reResearchedTweetIds = new Set<string>();
  /** Store tweets that had no DB hash match, pending user click on "Disinfact". */
  const onHoldTweets = new Map<string, { tweet: MainTweet; hash: string }>();
  /** Disinfact taps that arrived before their tweet's on-hold entry existed. The
   *  usual cause is a worker restart after backgrounding/long idle: the relay
   *  reconnects and re-sends the batch, but the tap lands before hashing + DB
   *  lookup recreate the entry. Parked here and honored by
   *  flushPendingProcessOnHold when the entry appears; dropped on timeout. */
  const pendingProcessOnHold = new Map<string, { locale: string; displayedSide: 'TRANSLATED' | 'ORIGINAL' | null; displayedText: string | null; displayedLocale: string | null; namedSide: 'alt' | 'translation' | null; fromSelection: boolean; timer: ReturnType<typeof setTimeout> }>();
  /** How long a parked tap waits for its entry before being dropped. Matches the
   *  content-side spinner revert (30s), so a timed-out tap leaves the button
   *  restored and a later tap re-parks cleanly. */
  const PENDING_PROCESS_ON_HOLD_TIMEOUT_MS = 30000;
  /** Honor a parked Disinfact tap now that its tweet's on-hold entry exists.
   *  Consumes both the pending intent and the entry — exactly the live-tap
   *  contract (claim-on-receipt), so a parked tap can never double-run with a
   *  live one. No-op when nothing is parked or no entry exists yet. */
  function flushPendingProcessOnHold(tweetId: string): void {
    const pending = pendingProcessOnHold.get(tweetId);
    if (!pending) return;
    const entry = onHoldTweets.get(tweetId);
    if (!entry) return;
    pendingProcessOnHold.delete(tweetId);
    clearTimeout(pending.timer);
    onHoldTweets.delete(tweetId);
    console.log(`[background] PROCESS_ON_HOLD (deferred): ${tweetId}`);
    runPreclassification(entry, pending.locale, "PROCESS_ON_HOLD", false, pending.displayedSide, pending.displayedText, pending.displayedLocale, pending.namedSide, pending.fromSelection);
  }
  /** Track which claims currently have an ongoing forced reclassification,
   *  keyed by `${classificationId}:${claimText}`. Prevents concurrent re-runs. */
  const ongoingClaimRefreshes = new Set<string>();
  /** Waiters that resolve when a preclassify-origin claim's DB row is broadcast (it
   *  gains a `dbClaimId` via `mergeClaimPayload`), keyed by `${tweetId}:${claimText}`.
   *  A preclassify claim has no DB id until the worker finishes embedding + inserting
   *  it; classifying before then races that insert and creates an embedding-less row
   *  via the research save path. Research launches wait on these before classifying. */
  const claimDbRowWaiters = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  /** Promises that resolve when a claim's in-flight research finishes, keyed by
   *  `${classificationId}:${claimText}`. Lets the placeholder upsert wait for
   *  classifications that were triggered early (Fact-Check All / all Disinfact
   *  clicked before fetch-claim finished) so it writes real values, not placeholders. */
  const claimResearchPromises = new Map<string, Promise<void>>();
  /** Buffer re-research results for claims on hold until the user clicks.
   *  Keyed by `${classificationId}:${claimText}`. */
  const heldReclassifications = new Map<string, Classification>();
  /** Claims that had no DB match during classify() and are waiting for the user
   *  to click the Disinfact badge before starting fresh research.
   *  Keyed by `${classificationId}:${claimText}`. */
  const pendingFreshResearchClaims = new Set<string>();
  /** Claims the user asked to research while fetch-claim had not written their DB row yet,
   *  keyed by `${classificationId}:${claimText}`.
   *
   *  A streamed claim is on hold by construction: preclassify marks every "research required"
   *  claim that way before the worker's embed → match → link has run. So the on-hold flag
   *  alone cannot say whether the DB already answers the claim — only the row says that, and
   *  the row arrives after the stream. A click (or a Fact-Check All, which uses its own
   *  per-id flag) made in that window is therefore only recorded here; the row's own
   *  broadcast decides it: a linked classified claim leaves nothing to research, and a claim
   *  the row still holds on hold is enqueued then. */
  const researchRequestedBeforeRow = new Set<string>();
  /** Tweet IDs for which the user clicked "Fact-Check All" on the on-hold button.
   *  Claims in these tweets bypass the per-claim Disinfact badge pause and stream
   *  fresh research immediately after their DB fetch attempt returns no match. */
  const factCheckAllTweetIds = new Set<string>();
  /** The claims a revealed selection asked for, per tweet id. Absent = the whole post (the
   *  button's own meaning); present = only the claims under the selection, so the release
   *  loop below leaves every other on-hold claim of the post alone. */
  const factCheckAllScopedTexts = new Map<string, Set<string>>();
  /** Ids whose preclassification was handed straight to the automatic research run, so their
   *  claims are presented as the researching state they are about to become.
   *
   *  For a TWEET that is only its exactly-one-claim case: the drain is the first moment the
   *  claim count is known, and a lone claim is researched without any click. A tweet with any
   *  other claim count is never marked — those buttons are the user's to act on, and nothing
   *  about them is researched automatically.
   *
   *  A selected passage is never marked: its claims are handed over one by one as their own DB
   *  matches resolve, and they carry the Fact-Check All mask instead, which is the one that can
   *  outlive the hand-off a waitlist queue puts them in (see startSelectionPipeline).
   *
   *  Each claim's research starts by waiting on its DB row (fetch-claim, up to two seconds), so
   *  without this the claim wears the on-hold Fact-Check button the worker's mid-stream row
   *  gave it for a wait the user did not ask for. While an id is in this set its claims are
   *  presented as the researching state they are about to become; the cache keeps the real
   *  on-hold flag, so every click path still acts on the state the cache holds. The hand-off
   *  broadcasts that state itself and this mark is then dropped, which is what completes the
   *  switch to the loading state. */
  const preclassifyRunTweets = new Set<string>();
  /** Track DB results from fetchTweetByHash so TRANSLATE_FACT_CHECKS can
   *  re-fire the localization pipeline. Keyed by tweet id. */
  const dbHitCache = new Map<string, { tweet: MainTweet; dbClaims: any[] }>();
  /** Track tweets whose DB hash has already been fetched this session so
   *  repeated timeline XHRs don't refetch the same tweet. Keyed by tweet id. */
  const dbFetchPromises = new Map<string, Promise<{ hash: string; dbResult: any; quotedHash?: string; quotedDbResult?: any }>>();
  /** Track hashes that returned no DB match so we don't retry them. */
  const dbMissHashes = new Set<string>();
  /** The same lookup memo as `dbFetchPromises`, persisted — because that map is module state
   *  and dies with the service worker, while the page does not.
   *
   *  What makes this worth a store of its own: when the worker is reaped (MV3 idle, an
   *  extension reload, memory pressure) the relay's port disconnects and it re-announces every
   *  post the reader has reached, so the replacement worker can serve their taps. Measured
   *  2026-10-01, a replacement worker bought 11 fresh lookups in the 12 seconds after a Reddit
   *  page with 17 announced posts lost its worker — the same rows the dead worker had already
   *  paid for. This memo is what makes that reconnect free: the re-announced posts are answered
   *  from here instead of being fetched again.
   *
   *  `storage.session` for the same reason the checkout tab id uses it — it survives a worker
   *  restart and is cleared when the browser restarts — plus the TTL below, which bounds how
   *  long a served answer can be stale. */
  const LOOKUP_MEMO_KEY = 'mfLookupMemo';
  /** Oldest entries are dropped past this, so the store cannot grow without bound. */
  const LOOKUP_MEMO_MAX_ENTRIES = 400;
  /** And a byte budget under it, since one entry can hold a post's whole claim payload. */
  const LOOKUP_MEMO_MAX_BYTES = 3_000_000;
  /** An entry older than this is not served. Research completion rewrites claim rows AFTER
   *  the snapshot cached here was taken (`markTweetDbStale` handles the in-worker case), and a
   *  reaped worker can miss that broadcast — so a served answer is trusted only briefly. The
   *  reconnects this exists for happen seconds after a reap, so the TTL costs nothing. */
  const LOOKUP_MEMO_TTL_MS = 10 * 60 * 1000;
  const lookupMemo = new Map<string, { hash: string; dbResult: any; quotedHash?: string; quotedDbResult?: any; at: number }>();
  let lookupMemoReady: Promise<void> | null = null;
  let lookupMemoSaveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Tweet ids the content script has reported as present in the DOM.
   *  Used to defer DB fetches for timeline tweets beyond the first 5 of each
   *  XHR batch until they are actually rendered. */
  const seenInDom = new Set<string>();
  /** Deferred DB fetch resolvers for tweets waiting to appear in the DOM. */
  const domFetchResolvers = new Map<string, (() => void)[]>();

  // ── Realtime subscription state ──
  /** Teardown fallbacks if no DELETE arrives from the DB.
   *
   *  This bounds how long a tweet subscription waits for a preclassification to say
   *  anything at all — not how long the run may take. Every delivered claim resets it
   *  (see `ensureTweetSubscription`), so it only expires over a run that is silent from
   *  `insert_tweet` onward; 10s cut that stream off before a cold run's first claim, and
   *  the claims after it were simply never heard. */
  const PRECLASS_TIMEOUT_MS = 60000;
  const CLASSIFY_TIMEOUT_MS = 25000;
  /** How long a refresh-path tweet subscription stays open for Flow A's annotation
   *  persist. Research takes minutes and the annotation agent runs after it, so neither
   *  of the timeouts above can cover it. Capped at the DB's own close_after (5 min):
   *  anything still open past that is swept server-side, so a longer timeout would
   *  only pretend to listen. */
  const ANNOTATION_TIMEOUT_MS = 5 * 60 * 1000;
  /** When Flow A's annotation is looked for in the DB if no delivery has arrived, measured
   *  from the research stream's close (see reconcileSettledAnnotation).
   *
   *  The agent's own persist is normally ~3.3s behind the stream, so the first look is past
   *  it and a run that was delivered costs nothing. The second exists for the run that was
   *  slow rather than absent: the read is billed, so it is only spent when the annotation
   *  really has not landed. */
  const ANNOTATION_READBACK_MS = [5000, 15000];
  /** How long a research launch waits for a preclassify-origin claim's DB row to be broadcast
   *  before giving up and classifying anyway (see awaitClaimDbRow / pullClaimBeforeClassify).
   *
   *  Deliberately much shorter than PRECLASS_TIMEOUT_MS, which this used to borrow. The two
   *  measure different things: that one bounds how long a tweet subscription stays open, this
   *  one sits directly in front of the user's paid click. The row is normally broadcast within
   *  a few hundred ms of the claim being linked, so anything approaching a second means the
   *  broadcast is not coming at all — and waiting the full 10s for it added ten silent seconds
   *  to every affected fact-check (measured: two claims on one tweet cost 20s of pure waiting
   *  on top of ~3.4s of actual research). Expiring early only risks the embedding-less
   *  duplicate the wait exists to prevent; stalling costs the user the thing they paid for.
   *
   *  Widened 2000 → 3000 on 2026-10-15: the post path is measured expiring this budget in
   *  practice and classifying anyway (awaitClaimDbRow facebook:1224195383044868: TIMED OUT
   *  after +2001ms), so the margin was thin against a broadcast that does normally land. The
   *  extra second is only ever spent in the case this budget governs — the wait is
   *  signal-driven, so a row that arrives resolves it at once, whatever the budget is. */
  const CLAIM_DB_ROW_TIMEOUT_MS = 3000;
  /** The same wait as CLAIM_DB_ROW_TIMEOUT_MS, for the SELECTION path only.
   *
   *  The budget above is calibrated on X, where the claim links to a tweet row that
   *  already exists. A selection has no tweet row of its own, so the preclassify worker
   *  creates the routing row and links the claim before its broadcast lands — and that
   *  measures slower than the comment above assumes. Run 2026-09-21: the payload arrived
   *  at +2560ms against the 2000ms budget, expiring 560ms short.
   *
   *  Expiring there is not free. claimAfterRowLands then hands over the PRECLASSIFY claim
   *  (verdict "research required", reclassifyOnHold) instead of the DB row, whose settle
   *  guard refuses it, so a claim the DB already held with a full verdict gets re-researched
   *  and re-charged — the exact opposite of the "a cached selection stays free" this path
   *  documents.
   *
   *  Signal-driven, so the larger budget does not delay the normal case: the wait resolves
   *  the moment the row lands, whatever the budget is. This only bounds the case where no
   *  broadcast is coming at all, where the extra seconds are cheaper than the wasted spend. */
  const SELECTION_DB_ROW_TIMEOUT_MS = 6000;
  /** How long to coalesce balance writes to the App Group. Long enough that a burst of
   *  classifications is one write, short enough that returning to the app feels immediate. */
  const NATIVE_SYNC_DEBOUNCE_MS = 1500;
  /** Open tweet subscriptions keyed by tweet id. */
  const tweetSubs = new Map<string, SubscriptionHandle>();
  /** Callbacks to run when a tweet's subscription ends (row DELETE or its own deadline).
   *  The DB-driven `preclassifying` state (Step 3b) is cleared by a delivered claim, but a
   *  run that finishes without linking any delivers nothing at all — only the DELETE — so
   *  without this the wheel outlives the run with nothing left that could clear it. */
  const tweetSubscriptionEndHooks = new Map<string, Set<() => void>>();
  /** Tweet ids whose leftover preclass handle was already closed and replaced
   *  with an annotation-timeout subscription. Closing again (a second claim's
   *  research) LATE-drops the in-flight annotation UPDATE. Cleared when the
   *  handle actually ends (timeout / forget). */
  const annotationRoutingReady = new Set<string>();
  /** Handles that gave up their slot in `tweetSubs` to a fresh routing row but are still
   *  live. The trigger fans a claim row out to EVERY live internal.broadcasts row for the
   *  tweet, so a handle still holding one is the only delivery path for rows written
   *  before the replacement row exists. Closing it instead is how a selection's
   *  Fact-Check-All lost 6 of 8 claim rows: the worker's claim pipeline was still writing
   *  while admission rotated the row. These end on their own timer. */
  const lingeringTweetSubs = new Map<string, Set<SubscriptionHandle>>();
  /** Open per-claim (is_classifying) subscriptions keyed by `${tweetId}:${claimId}`. */
  const claimSubs = new Map<string, SubscriptionHandle>();

  const SELECTION_CACHE_KEY = 'mf_selection_pipeline';
  let persistSelectionTimer: ReturnType<typeof setTimeout> | null = null;

  function isSelectionId(id: string | undefined): boolean {
    return !!id && (id.startsWith('sel_') || id.startsWith('pw_'));
  }

  function persistSelectionPipeline() {
    if (persistSelectionTimer) clearTimeout(persistSelectionTimer);
    persistSelectionTimer = setTimeout(() => {
      persistSelectionTimer = null;
      const classifications: Record<string, { classification: Classification; batchIds: string[] }> = {};
      const tweets: Record<string, MainTweet> = {};
      for (const [id, entry] of classificationCache) {
        if (!isSelectionId(id) || !entry.classification.claims?.length) continue;
        classifications[id] = {
          classification: entry.classification,
          batchIds: Array.from(entry.batchIds),
        };
      }
      for (const [id, tweet] of tweetCache) {
        if (!isSelectionId(id)) continue;
        tweets[id] = tweet;
      }
      try {
        void browser.storage.local.set({ [SELECTION_CACHE_KEY]: { classifications, tweets } });
        if ((browser.storage as any).session) {
          void (browser.storage as any).session.set({ [SELECTION_CACHE_KEY]: { classifications, tweets } });
        }
      } catch { /* storage unavailable */ }
    }, 200);
  }

  async function restoreSelectionPipeline() {
    try {
      let stored = await browser.storage.local.get(SELECTION_CACHE_KEY);
      let payload = (stored as any)?.[SELECTION_CACHE_KEY];
      if ((!payload || typeof payload !== 'object') && (browser.storage as any).session) {
        stored = await (browser.storage as any).session.get(SELECTION_CACHE_KEY);
        payload = (stored as any)?.[SELECTION_CACHE_KEY];
      }
      if (!payload || typeof payload !== 'object') return;
      const classifications = payload.classifications ?? {};
      const tweets = payload.tweets ?? {};
      for (const [id, entry] of Object.entries(classifications as Record<string, { classification: Classification; batchIds: string[] }>)) {
        if (!isSelectionId(id) || !entry?.classification) continue;
        classificationCache.set(id, {
          classification: entry.classification,
          batchIds: new Set(entry.batchIds?.length ? entry.batchIds : [entry.classification.batchId ?? '']),
        });
      }
      for (const [id, tweet] of Object.entries(tweets as Record<string, MainTweet>)) {
        if (!isSelectionId(id) || !tweet) continue;
        tweetCache.set(id, tweet);
      }
    } catch { /* ignore */ }
  }
  const selectionPipelineReady = restoreSelectionPipeline();
  void selectionPipelineReady;

  /** A delivery carrying the localization wheel across it when its sender never stated the
   *  flag.
   *
   *  `localizingHighlights` lives on the one classification the Localize run works from, and
   *  every path that ENDS the run states it explicitly as false (`restoreAfterLocalizing`,
   *  `clearLocalizingHighlights`, `mergeHighlightsFor`). Nothing ever writes `undefined`. So a
   *  delivery that omits the field was built from a snapshot taken before the press — a claim
   *  merge, a refresh rewrite — and adopting it wholesale takes the wheel down mid-run and
   *  hands the reader the Localize button again, inviting a second paid press. Carrying the
   *  cached flag keeps the wheel up until the ranges land, and cannot outlive the run: the
   *  explicit false an exit broadcasts overrides it here. */
  function withRunningLocalization(classification: Classification): Classification {
    if (classification.localizingHighlights !== undefined) return classification;
    const running = classificationCache.get(classification.id)?.classification.localizingHighlights;
    return running ? { ...classification, localizingHighlights: true } : classification;
  }

  /** Store a classification under its tweet id, recording the batch that requested it.
   *  A quoted tweet gets its own top-level cache entry too, so a later batch that shows
   *  the quoted tweet on its own can reuse the claims already computed for it. */
  function cacheClassification(classification: Classification, batchId: string) {
    classification = withRunningLocalization(classification);
    // Recorded here, not in broadcastClassification: a DB hit is cached and then posted
    // straight to its port (`safePostToPort`), so it never passes through the broadcast
    // helper — and a DB hit is exactly the side a later flip has to come back to when the
    // reader has since localized the other one.
    rememberSideClaims(classification);
    const existing = classificationCache.get(classification.id);
    if (existing) {
      existing.classification = classification;
      existing.batchIds.add(batchId);
    } else {
      classificationCache.set(classification.id, { classification, batchIds: new Set([batchId]) });
    }
    // Also cache quoted tweet if not already present
    if (classification.quoting && !classificationCache.has(classification.quoting.id)) {
      classificationCache.set(classification.quoting.id, {
        classification: {
          id: classification.quoting.id,
          batchId,
          claims: classification.quoting.claims,
          quoting: null
        },
        batchIds: new Set([batchId])
      });
    }
    if (isSelectionId(classification.id)) persistSelectionPipeline();
  }

  /** Forget a tweet's DB snapshot so the next batch re-pulls it. Research completion
   *  (local, or a broadcast from elsewhere) rewrites the claim rows AFTER the snapshot
   *  cached in dbFetchPromises was taken; without this the next page load re-serves the
   *  pre-research rows — the old verdict (and its pre-localization highlights) come back
   *  until the worker restarts, which is the only other thing that clears those maps. */
  function markTweetDbStale(tweetId: string) {
    dbFetchPromises.delete(tweetId);
    dbHitCache.delete(tweetId);
    reResearchedTweetIds.delete(tweetId);
    forgetLookup(tweetId, true);
    // The same post reached by another id — a host that froze a `pfbid…` name on the feed
    // before the payload named it, and the story's own id in its detail view. Both are served
    // from the row keyed by the body's hash, so the rewrite this call is covering for is the
    // same row for both, and a snapshot kept under the other id would serve the verdicts from
    // before it. The body is what makes them the same post here, exactly as it does in the DB.
    const text = tweetCache.get(tweetId)?.text;
    if (!text) return;
    for (const [id, tweet] of tweetCache) {
      if (id === tweetId || tweet?.text !== text) continue;
      dbFetchPromises.delete(id);
      dbHitCache.delete(id);
      forgetLookup(id, true);
    }
  }

  /** Read the persisted lookup memo back into memory, once per worker.
   *
   *  Entries past `LOOKUP_MEMO_TTL_MS` are dropped on the way in rather than served and
   *  pruned later, so a worker that starts after a long gap re-buys what it cannot trust. */
  function loadLookupMemo(): Promise<void> {
    if (!lookupMemoReady) {
      lookupMemoReady = (async () => {
        try {
          const stored = await browser.storage.session.get(LOOKUP_MEMO_KEY);
          const raw = stored?.[LOOKUP_MEMO_KEY];
          if (!raw || typeof raw !== 'object') return;
          const cutoff = Date.now() - LOOKUP_MEMO_TTL_MS;
          for (const [id, entry] of Object.entries(raw as Record<string, any>)) {
            if (entry && typeof entry.at === 'number' && entry.at >= cutoff) lookupMemo.set(id, entry);
          }
        } catch (e) {
          // Not fatal: the only consequence is buying rows this worker already had.
          console.error('[background] lookup memo read failed:', e);
        }
      })();
    }
    return lookupMemoReady;
  }

  function scheduleLookupMemoSave(): void {
    if (lookupMemoSaveTimer) return;
    lookupMemoSaveTimer = setTimeout(() => {
      lookupMemoSaveTimer = null;
      void saveLookupMemo();
    }, 1500);
  }

  /** Write the memo back, newest first, stopping at the byte budget so the oldest entries are
   *  the ones the store drops. A failed write is logged and ignored: this is a cache. */
  async function saveLookupMemo(): Promise<void> {
    try {
      const blob: Record<string, any> = {};
      let bytes = 0;
      for (const [id, entry] of [...lookupMemo.entries()].reverse()) {
        const size = JSON.stringify(entry).length;
        if (bytes + size > LOOKUP_MEMO_MAX_BYTES) break;
        blob[id] = entry;
        bytes += size;
      }
      await browser.storage.session.set({ [LOOKUP_MEMO_KEY]: blob });
    } catch (e) {
      console.error('[background] lookup memo write failed:', e);
    }
  }

  /** Record a completed lookup, so a worker that replaces this one does not buy it again. */
  function rememberLookup(tweetId: string, entry: { hash: string; dbResult: any; quotedHash?: string; quotedDbResult?: any }): void {
    lookupMemo.delete(tweetId);
    lookupMemo.set(tweetId, { ...entry, at: Date.now() });
    while (lookupMemo.size > LOOKUP_MEMO_MAX_ENTRIES) {
      const oldest = lookupMemo.keys().next().value;
      if (oldest === undefined) break;
      lookupMemo.delete(oldest);
    }
    scheduleLookupMemoSave();
  }

  /** Drop one entry, for the same reasons `markTweetDbStale` drops the in-memory snapshot.
   *
   *  `now` writes through instead of waiting for the debounce. The debounce is fine for
   *  ADDING — an entry that never reaches the store only costs one lookup after a reap — but
   *  it is not fine for REMOVING: the store is the one place a superseded snapshot could
   *  outlive the worker that invalidated it, and if the worker is reaped inside the debounce
   *  the next one serves the pre-research rows this call exists to retire. `markTweetDbStale`
   *  is the caller that needs that, and it is rare. */
  function forgetLookup(tweetId: string, now = false): void {
    if (!lookupMemo.delete(tweetId)) return;
    if (now) flushLookupMemo();
    else scheduleLookupMemoSave();
  }

  /** Write the memo out immediately, cancelling any pending debounced save. */
  function flushLookupMemo(): void {
    if (lookupMemoSaveTimer) { clearTimeout(lookupMemoSaveTimer); lookupMemoSaveTimer = null; }
    void saveLookupMemo();
  }

  /** Drop the whole memo on a sign-out/freeze, where every other pipeline cache is cleared. */
  function clearLookupMemo(): void {
    if (lookupMemoSaveTimer) { clearTimeout(lookupMemoSaveTimer); lookupMemoSaveTimer = null; }
    lookupMemo.clear();
    void browser.storage.session.remove(LOOKUP_MEMO_KEY).catch((e: unknown) => {
      console.error('[background] lookup memo clear failed:', e);
    });
  }

  /** Remove ALL cache entries whose batchIds contain the given batchId,
   *  even if they also belong to other batches. This ensures a full
   *  re-preclassification + re-classification on batch refresh. */
  function clearBatch(batchId: string) {
    for (const [key, entry] of classificationCache) {
      if (entry.batchIds.has(batchId)) {
        classificationCache.delete(key);
      }
    }
    batchTweets.delete(batchId);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DB payload → UI model. The database stores claim text, reasoning and highlight
  // ranges as locale-keyed JSONB, and different RPCs spell the same field
  // differently; these helpers absorb that so the rest of the file sees plain
  // strings and a single Claim shape.
  // ─────────────────────────────────────────────────────────────────────────

  /** Extract the first available text value from a locale-keyed JSONB claim object.
   *  E.g. {"en": "Japan has..."} → "Japan has..." */
  function extractClaimText(claimObj: any): string {
    if (typeof claimObj === 'string') return claimObj;
    if (claimObj && typeof claimObj === 'object') {
      const keys = Object.keys(claimObj);
      if (keys.length > 0) return String(claimObj[keys[0]] ?? '');
    }
    return '';
  }

  /** Convert a Source[] array into the DB's preferred {url: title} dictionary format. */
  function sourcesToDictionary(sources: Source[]): Record<string, string> {
    const dict: Record<string, string> = {};
    for (const s of sources) {
      if (s.url) dict[s.url] = s.title ?? '';
    }
    return dict;
  }

  /** Extract text for a specific locale from a locale-keyed JSONB claim object.
   *  E.g. extractLocaleText({"en": "hello", "zh": "你好"}, "zh") → "你好"
   *  Falls back to base language match, then any available key.
   *  Handles both parsed objects and serialized JSON strings. */
  function extractLocaleText(claimObj: any, locale: string): string {
    if (!claimObj) return '';
    if (typeof claimObj === 'object' && !Array.isArray(claimObj)) {
      const exact = claimObj[locale];
      if (exact && typeof exact === 'string') return exact;
      const base = locale.split('-')[0];
      for (const [key, val] of Object.entries(claimObj)) {
        if (typeof val !== 'string') continue;
        if (key === base || key.startsWith(base + '-')) return val;
      }
      const first = Object.values(claimObj).find(v => typeof v === 'string');
      if (first) return first;
      return '';
    }
    if (typeof claimObj === 'string') {
      try {
        const parsed = JSON.parse(claimObj);
        return extractLocaleText(parsed, locale);
      } catch { return claimObj; }
    }
    return '';
  }

  /** Extract the locale key from a DB claim JSONB object. E.g. {"en": "text"} → "en" */
  /** The locale a JSONB claim/reasoning object is keyed under, taken as its first key.
   *  These objects normally hold exactly one locale; 'en' is the fallback when the value
   *  isn't a keyed object at all. */
  function getClaimLocale(claimObj: any): string {
    if (claimObj && typeof claimObj === 'object') {
      const keys = Object.keys(claimObj);
      if (keys.length > 0) return keys[0];
    }
    return 'en';
  }

  /** Read the last_classification timestamp from a DB claim result, tolerating
   *  either last_classification or last_classified field names. */
  function getLastClassification(dbClaim: any): string | undefined {
    return dbClaim?.last_classification ?? dbClaim?.last_classified;
  }

  /** Extract reasoning as a plain text string from the DB result.
   *  DB returns reasoning as JSONB {"en-US": "text", "fr": "text"}. We need
   *  to extract the best-matching locale's text as a plain string.
   *  Preference: exact locale match > base language > first available. */
  function extractReasoningText(reasoning: any, preferredLocale: string): string {
    if (!reasoning) return '';
    if (typeof reasoning === 'string') {
      // Could be a plain text string or a serialized JSON object
      try {
        const parsed = JSON.parse(reasoning);
        return extractLocaleText(parsed, preferredLocale);
      } catch { return reasoning; }
    }
    if (typeof reasoning === 'object') {
      return extractLocaleText(reasoning, preferredLocale);
    }
    return '';
  }

  /** True when a DB claim's reasoning is empty — i.e. the claim was stored as an
   *  unclassified placeholder (reasoning {}). Such claims show a Disinfact button
   *  and are classified on demand, updating the same DB row. */
  function isReasoningEmpty(reasoning: any): boolean {
    if (reasoning === null || reasoning === undefined) return true;
    if (typeof reasoning === 'string') {
      const trimmed = reasoning.trim();
      if (trimmed === '' || trimmed === '{}') return true;
      try { return isReasoningEmpty(JSON.parse(trimmed)); } catch { return false; }
    }
    if (typeof reasoning === 'object') {
      return Object.values(reasoning).filter(v => typeof v === 'string' && v.trim() !== '').length === 0;
    }
    return false;
  }

  /** Bodies a highlight revision may bind to in order to survive the strip in
   *  payloadToClaim. `displayed` is the sha256HexSync of the body the claim's tweet
   *  is currently showing (best guess — null when unknown); `known` holds the hashes
   *  of every body the client holds for the tweet. Matching is pure string equality,
   *  so no locale guessing is involved. Unknown (hash-less) origins pass a null
   *  displayed + empty known, which keeps legacy bare-locale keys and drops every
   *  hashed one. */
  type RevisionGate = {
    displayed: string | null;
    known: Set<string>;
    /** Rendering hashes of the side on screen, and hashes of the other side's bodies —
     *  see `RevisionGate` in textBreakup.ts. */
    displayedBodies?: Set<string>;
    otherBodies?: Set<string>;
    /** Locale prefix the displayed body is filed under — see `RevisionGate` in
     *  textBreakup.ts. Set from the recorded side (displayedSides), which is the only
     *  thing that knows it on a host that states no language. */
    displayedLocale?: string;
  };
  const NO_REVISION_GATE: RevisionGate = { displayed: null, known: new Set() };

  /** The exact tweet body a highlight range is measured against: the Grok translation
   *  when the tweet is displayed translated, else the captured original. Mirrors the
   *  display tweets built for the preclassify worker (tweetForDisplay) and the
   *  TRANSLATE_FACT_CHECKS path — the workers hash these same strings. */
  function displayedTweetText(tweet: { text?: string; translatedText?: string; destinationLanguage?: string } | null | undefined): string | null {
    if (!tweet) return null;
    const text = (tweet.translatedText && tweet.destinationLanguage) ? tweet.translatedText : tweet.text;
    return (typeof text === 'string' && text.length > 0) ? text : null;
  }

  /** The side the reader is actually looking at, as the content script last stated it
   *  (`SET_DISPLAYED_LOCALE`). A flip grows no captured text, so no re-capture ever states
   *  the side it put on screen, and every batch overwrites `tweetCache` with the pre-flip
   *  post. This record survives both, and the revision gate has to read it: fed the stale
   *  capture, the gate hashes the source as the displayed body and drops exactly the ranges
   *  a Localize press has just measured against the translation, so the side the reader is
   *  looking at comes back bare with its group offering Localize again. */
  /** Every body reported as on screen for this id, latest first, bounded. One side can be
   *  reported more than once with different renderings of the same words (Facebook's host
   *  block is a short clamp of the fetched translation the ranges were measured into), and
   *  the gate only ever ADDS these hashes, so keeping them all is what stops the shorter
   *  rendering from hiding the revision the longer one names. */
  const displayedSides = new Map<string, { text: string; locale: string; texts: string[] }>();

  /** Whether two bodies say the same words, differing only where the host joins or cuts
   *  them: all whitespace removed, then one must hold the other. `sameBodyRevision` cannot
   *  answer this — a missing join separator ("PERSON" + "AS") survives every whitespace fold. */
  function sameBodyWords(a: string, b: string): boolean {
    const sq = (s: string) => s.replace(/\s+/g, '');
    const x = sq(a);
    const y = sq(b);
    if (!x || !y) return false;
    return x === y || x.includes(y) || y.includes(x);
  }

  /** The post with the reader's displayed side laid over whatever the capture states. */
  function withDisplayedSide<T extends { translatedText?: string; destinationLanguage?: string } | null | undefined>(id: string, tweet: T): T {
    const recorded = displayedSides.get(id);
    if (!recorded || !tweet) return tweet;
    // A capture that already names these words is the side the reader is on — the host's
    // payload and its DOM are the same body with different separators (LinkedIn writes a line
    // break where the payload writes nothing, and appends its clamp's "… more"). Laying the
    // record over it would hand the revision gate a body no stored range was measured into:
    // every range dropped, `rangesBoundElsewhere` raised, and a side that HAS highlights came
    // back offering Localize (2026-10-24). The capture's own rendering is also the one the
    // offsets index, which is what the paint needs to place them.
    if (tweet.translatedText && tweet.destinationLanguage && sameBodyWords(tweet.translatedText, recorded.text)) return tweet;
    return { ...tweet, translatedText: recorded.text, destinationLanguage: recorded.locale };
  }

  /** Record the body now on screen. The renderings kept beside it are only those of the
   *  SAME revision of the post: a host clamp and its expansion name one side, and a range
   *  measured into either addresses the words on screen. A body that says different words
   *  is another side — a host that cannot name its sides files both under one key
   *  (`translationLocaleIsGuessed`), so carrying its hash here made a later DB read treat
   *  that side's ranges as this side's: the classification was built naming the English
   *  body while the claims carried the French offsets (they survived the revision gate as
   *  "another rendering"), and the reader got French marks over the English words with
   *  Hide + Fact-Check All instead of Localize (reported 2026-10-23, the monkeypox post).
   *  That side is not lost — a flip back to it reads its own revisions back through the
   *  strict hash gate. */
  function recordDisplayedSide(id: string, text: string, locale: string): void {
    const prev = displayedSides.get(id);
    const texts: string[] = [text];
    for (const t of prev ? [prev.text, ...prev.texts] : []) {
      if (!t || texts.length >= 4 || texts.includes(t)) continue;
      if (!sameBodyRevision(t, text)) continue;
      texts.push(t);
    }
    displayedSides.set(id, { text, locale, texts });
  }

  /** Claims as each side was last measured, keyed by the body they address. `displayedSides`
   *  remembers which bodies the reader has had on screen; this remembers what was measured
   *  against them. A host that states no language (Facebook) files both sides' ranges under
   *  the same locale key, so the live claim list can carry only ONE side's ranges at a time:
   *  flipping re-points the classification at another body, and flipping back would otherwise
   *  leave the side already classified — and already paid for — with nothing to paint. The
   *  persisted rows keep every revision, but they are only reachable while `dbHitCache` holds
   *  the tweet, which a post first classified this session never was. */
  const sideClaims = new Map<string, { text: string; locale: string; claims: Claim[] }[]>();
  const MAX_SIDE_CLAIMS = 4;
  function rememberSideClaims(cls: Classification): void {
    const text = typeof cls.translatedText === 'string' ? cls.translatedText.trim() : '';
    const locale = cls.textLocale ?? cls.translatedLocale;
    if (!text || !locale || !cls.claims?.length) return;
    const list = sideClaims.get(cls.id) ?? [];
    const at = list.findIndex(e => e.text === text);
    if (at >= 0) list.splice(at, 1);
    list.unshift({ text, locale, claims: cls.claims });
    if (list.length > MAX_SIDE_CLAIMS) list.length = MAX_SIDE_CLAIMS;
    sideClaims.set(cls.id, list);
  }

  /** Whether two renderings name the same revision of a post's body: equal once whitespace is
   *  normalized, or one holding the other (a host clamp or cut of the same words). A body that
   *  does neither is another side — a translation filed as the source, or its reverse. */
  function sameBodyRevision(a: string, b: string): boolean {
    // The page writes its own cut into the words it shows it is holding back — `…`, or three
    // ASCII dots on the mobile surface — so a body read AT a cut is the whole body plus one
    // mark that is not part of the post. Compared as it stands, that mark made a reader's
    // clamp look like ANOTHER revision of the post: a post captured whole and then collapsed
    // with the page's own "See less" handed the clamp over, and the run classified — and
    // billed — only the words before the cut (reported 2026-10-18). A cut mark at the very
    // end of either body says nothing about which words they are; a mark inside the text is
    // left alone.
    const norm = (s: string) => s.replace(/(?:…|\.{3})\s*$/, '').replace(/\s+/g, ' ').trim();
    const x = norm(a);
    const y = norm(b);
    if (x.length === 0 || y.length === 0) return true;
    return x === y || x.includes(y) || y.includes(x);
  }

  /** Whether two renderings are the SAME body — whitespace and a trailing cut mark aside —
   *  where `sameBodyRevision` also accepts a clamp of the other. A run's ranges are indexed
   *  into the words it was handed, so only an exact match says a classification already names
   *  those words (see the TRANSLATE_FACT_CHECKS stamp). */
  function sameBodyExactly(a: string, b: string): boolean {
    const norm = (s: string) => s.replace(/(?:…|\.{3})\s*$/, '').replace(/\s+/g, ' ').trim();
    const x = norm(a);
    return x.length > 0 && x === norm(b);
  }

  /** Revision gate for payloadToClaim covering a main tweet plus its quoted tweet (the
   *  two bodies any highlight here can address). The ORIGINAL bodies stay held even
   *  while a translation displays (and vice versa) — highlights bound to them are
   *  still genuine tier-2 revisions that apply instantly if the user toggles back.
   *  Null/empty bodies contribute nothing — legacy bare-locale keys never need a
   *  hash to survive. */
  function revisionGateFor(main: { id?: string; text?: string; translatedText?: string; destinationLanguage?: string } | null | undefined, quoted?: { text?: string; translatedText?: string; destinationLanguage?: string } | null | undefined): RevisionGate {
    const mainBody = displayedTweetText(main);
    const known = new Set<string>();
    for (const body of [mainBody, displayedTweetText(quoted)]) {
      if (body !== null) known.add(sha256HexSync(body));
    }
    // Without the originals, the strip drops e.g. en-US ranges while the es
    // translation shows, so toggling back to English spuriously raises the
    // Translate Fact-Checks hold (the subscription-merge path below already adds
    // them for the same reason).
    for (const body of [main?.text, quoted?.text, (main as any)?.fullText, (quoted as any)?.fullText]) {
      if (typeof body === 'string' && body.length > 0) known.add(sha256HexSync(body));
    }
    // The side the reader flipped to, as the page last stated it (see displayedSides).
    // The capture can hold only the clamped opening of that side — Facebook's appended
    // translation above all — so without this the revisions measured against the words
    // on screen (a Localize press, an annotation) hash to a body the gate has never
    // seen, and every later DB read drops them. Adding a body only ever KEEPS ranges.
    const recorded = typeof main?.id === 'string' ? displayedSides.get(main.id) : undefined;
    if (recorded) {
      for (const text of recorded.texts.length > 0 ? recorded.texts : [recorded.text]) known.add(sha256HexSync(text));
    }
    // Which hashes address the side on screen, and which address the other side. The same
    // body can be recorded in more than one rendering (a host clamp, then its expansion),
    // and a range measured into any of them addresses the visible side — which is why
    // this is a set of renderings and not just `displayed`. The capture's body and its
    // full-text splice are what the OTHER side's ranges were measured against.
    const displayedBodies = new Set<string>();
    const otherBodies = new Set<string>();
    if (mainBody !== null) displayedBodies.add(sha256HexSync(mainBody));
    if (recorded) {
      for (const text of [recorded.text, ...recorded.texts]) {
        if (text) displayedBodies.add(sha256HexSync(text));
      }
    }
    for (const body of [main?.text, (main as any)?.fullText]) {
      if (typeof body === 'string' && body.length > 0) otherBodies.add(sha256HexSync(body));
    }
    // The locale those displayed words are filed under. On a host that states no language
    // both sides share it, so this is what lets the annotation strip refuse the other
    // side's corrections there (see selectAnnotationRevision).
    return { displayed: mainBody !== null ? sha256HexSync(mainBody) : null, known, displayedBodies, otherBodies, ...(recorded?.locale ? { displayedLocale: recorded.locale } : {}) };
  }

  /** Convert one claim record (a ClaimPayload from fetch_tweet_and_touch_network /
   *  get_full_claim, or a Realtime build_claim_payload) into a UI Claim. Shared by the
   *  initial pull and by live subscription merges. Adds dbClaimId (uuid) and handles
   *  is_classifying (another user is classifying → spinner + auto-replace on arrival).
   *
   *  `gate` strips persisted "<locale>:<sha256-of-tweet-text>" highlight keys back to
   *  their bare locale prefix, keeping only the revision bound to a displayed/held
   *  text (see selectHighlightRevision). The client never needs the hashes; everything
   *  downstream (merges, missing-highlight checks, injection) works on bare keys. */
  /** Certainty for a DB claim payload.
   *
   *  Uses the stored `probability` column when the payload carries it, falling back to
   *  |veracity| when it doesn't. That fallback used to be UNCONDITIONAL, because
   *  build_claim_payload and fetch_tweet_and_touch_network never included `probability` —
   *  so a claim with (probability 0.4, veracity 0.1) was read as certainty 0.1 and rendered
   *  "Unknown" (verdictLabel treats < 0.2 as unknown) even though the model was moderately
   *  confident. Worse, it disagreed with itself: the research stream carries a real
   *  `confidence`, so the same claim showed a qualified verdict when freshly researched and
   *  flipped to "Unknown" after a reload.
   *
   *  The fallback is retained deliberately so this is safe to ship BEFORE the SQL change —
   *  payloads without `probability` behave exactly as they do today.
   *
   *  Numeric columns arrive as STRINGS over PostgREST ("0.4"), hence Number(). Note
   *  Number(null) === 0 and Number('') === 0, so null/empty are excluded explicitly rather
   *  than relying on a falsy/NaN check. */
  function dbClaimConfidence(dbClaim: any): number {
    const raw = dbClaim?.probability;
    if (raw !== null && raw !== undefined && raw !== '') {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) return parsed;
    }
    return Math.abs(Number(dbClaim?.veracity ?? 0));
  }

  function payloadToClaim(dbClaim: any, locale: string, gate: RevisionGate = NO_REVISION_GATE, fromDisplayed?: Set<string>): Claim {
    const veracityScore = Number(dbClaim.veracity ?? 0);
    const confidenceScore = dbClaimConfidence(dbClaim);
    const claimText = extractLocaleText(dbClaim.claim, locale) || extractClaimText(dbClaim.claim);
    const claimLocale = (() => {
      if (dbClaim.claim && typeof dbClaim.claim === 'object' && !Array.isArray(dbClaim.claim)) {
        const match = Object.entries(dbClaim.claim as Record<string, unknown>).find(([_, val]) => val === claimText);
        if (match) return match[0];
      }
      return getClaimLocale(dbClaim.claim);
    })();

    let highlight: Record<string, [number, number]> | undefined;
    if (dbClaim.highlight && typeof dbClaim.highlight === 'object') {
      const raw: Record<string, [number, number]> = {};
      for (const [key, val] of Object.entries(dbClaim.highlight)) {
        if (Array.isArray(val) && val.length === 2) raw[key] = val as [number, number];
      }
      // Persisted keys are "<locale>:<sha256-of-displayed-tweet-text>" (appended across
      // revisions server-side); live-stream keys are bare locales. Keep only the revision
      // bound to the displayed text (preferring it over other held bodies), re-emitted
      // under its bare locale prefix — the revision binding that stops a stale range
      // ever addressing an edited tweet.
      const keptHighlight = selectHighlightRevision(raw, gate, fromDisplayed);
      highlight = keptHighlight;
      if (Object.keys(highlight).length === 0) highlight = undefined;
    }

    // Range-keyed annotations for this tweet↔claim link: {"<locale>:<hash>": {"s,e": correction}}.
    // Same revision-keyed contract as highlight — keep only the revision bound to the
    // displayed text, re-emitted under its bare locale prefix. An empty dict under a kept
    // key ("annotated, nothing wrong") survives as an empty dict (NOT undefined): absence
    // of the key downstream is what renders the Annotate badge, so collapsing {} to
    // undefined here would make "annotated, clean" indistinguishable from "never annotated".
    let annotations: Record<string, Record<string, string>> | undefined;
    if (dbClaim.annotations && typeof dbClaim.annotations === 'object') {
      const rawA: Record<string, Record<string, string>> = {};
      for (const [key, val] of Object.entries(dbClaim.annotations)) {
        // Empty dict is a present key ("annotated, clean") — `val &&` would keep
        // it anyway ({} is truthy) but skip null/arrays explicitly.
        if (val !== null && typeof val === 'object' && !Array.isArray(val)) rawA[key] = val as Record<string, string>;
      }
      const stripped = selectAnnotationRevision(rawA, gate);
      // A kept locale key, even with an empty dict ("annotated, nothing wrong"),
      // must survive: collapsing it to undefined is how the Annotate badge came
      // back after Flow A persisted {}. Absence of every key is "never annotated".
      if (Object.keys(stripped).length > 0) annotations = stripped;
    }

    const reasoningEmpty = isReasoningEmpty(dbClaim.reasoning);
    const noteText = reasoningEmpty ? null : (extractReasoningText(dbClaim.reasoning, locale) || extractReasoningText(dbClaim.reasoning, claimLocale) || null);
    const reasoningLocale = (() => {
      if (!noteText || !dbClaim.reasoning) return dbClaim.locale_key ?? getClaimLocale(dbClaim.claim);
      let reasoningObj: any = dbClaim.reasoning;
      if (typeof reasoningObj === 'string') {
        try { reasoningObj = JSON.parse(reasoningObj); } catch { return dbClaim.locale_key ?? getClaimLocale(dbClaim.claim); }
      }
      if (reasoningObj && typeof reasoningObj === 'object' && !Array.isArray(reasoningObj)) {
        const match = Object.entries(reasoningObj as Record<string, unknown>).find(([_, val]) => val === noteText);
        if (match) return match[0];
      }
      return dbClaim.locale_key ?? getClaimLocale(dbClaim.claim);
    })();

    const base = {
      text: claimText,
      rewritten: claimText,
      dbClaimId: dbClaim.id ? String(dbClaim.id) : undefined,
      dbClaimText: extractClaimText(dbClaim.claim),
      dbClaimLocale: getClaimLocale(dbClaim.claim),
      highlight,
      annotations,
      // Link-scoped and stated by every link-bearing payload; absent from claim-scoped
      // ones, where "no opinion" must read as undefined rather than false.
      isHidden: dbClaim.is_hidden === true ? true : (dbClaim.is_hidden === false ? false : undefined),
      claimLocale,
      reasoningLocale,
    };
    // Mirrors formatVerdict() in data/Classification.ts, which is what the FRESH research
    // path uses: probability alone decides whether anything is claimed at all (< 0.2 =>
    // "unknown"), and the sign of veracity only picks the direction. Previously this gated
    // on |veracity| instead, so a DB-loaded claim could disagree with the very same claim
    // when freshly researched.
    const verdict = confidenceScore < 0.2 ? "unknown" : (veracityScore > 0 ? "true" : "false");

    // Being classified by someone else right now → show existing values (if any)
    // with a spinner; the fresh result auto-replaces them when the subscription
    // delivers it (no click needed).
    if (dbClaim.is_classifying === true) {
      if (!reasoningEmpty && noteText) {
        return { ...base, verdict, note: noteText, confidence: confidenceScore, veracity: veracityScore, sources: normalizeSources(dbClaim.sources), refreshing: true, isClassifying: true };
      }
      return { ...base, verdict: "research required", note: null, confidence: undefined, veracity: undefined, sources: [], refreshing: true, isClassifying: true };
    }

    // Unclassified placeholder (empty reasoning): Fact-Check (Disinfact) button.
    if (reasoningEmpty) {
      return { ...base, verdict: "research required", note: null, confidence: undefined, veracity: undefined, reclassifyOnHold: true, sources: [] };
    }

    // Change-prone (reclassify_after passed): present on hold with cached values so
    // clicking restores them while fresh research streams.
    if (dbClaim.reclassify === true) {
      return {
        ...base,
        verdict: "research required", note: null, confidence: undefined, veracity: undefined,
        reclassifyOnHold: true,
        cachedVerdict: verdict, cachedNote: noteText, cachedConfidence: confidenceScore, cachedVeracity: veracityScore,
        cachedSources: normalizeSources(dbClaim.sources), sources: normalizeSources(dbClaim.sources),
      };
    }

    // Classified.
    return { ...base, verdict, note: noteText, confidence: confidenceScore, veracity: veracityScore, sources: normalizeSources(dbClaim.sources) };
  }

  /** The locale a claim list's stored highlight ranges are keyed under, when they all
   *  agree on exactly one — else null.
   *
   *  This is what lets a DOM-fed platform be annotated at all. A tweet knows its own
   *  language and says so; a post read out of markup usually does not (HN is the one
   *  DOM platform where the answer is fixed and it states 'en' — see its capture), so
   *  `sourceLanguage`/`textLocale` both come out empty and the locator build gives up.
   *  The worker then skips its annotation pass outright ("no locators: tweetHash=false,
   *  tweetText=false, textLocale=false"), leaving a claim that has just been researched
   *  with a verdict, no corrections, and an empty annotations dict — which the badge
   *  renders as the idle "Annotate" button rather than the corrections it should show.
   *
   *  The ranges themselves still name the locale: the preclassify worker keys every
   *  range with the locale it classified the body in, and the annotate pass must be sent
   *  that same value as `text_locale` — get_annotation_context reads the claim's range
   *  out of `highlight -> text_locale`, and the worker files the annotations under it.
   *  So this states the key the claims are already filed under rather than guessing a
   *  language. One key only, the same rule the render path applies for the same reason:
   *  with several candidate languages a range would address an arbitrary span, and a
   *  verdict attached to the wrong words is worse than showing none. */
  function rangedLocale(claims: Claim[] | null | undefined): string | null {
    const keys = new Set<string>();
    for (const c of claims ?? []) {
      for (const key of Object.keys(c.highlight ?? {})) keys.add(key);
    }
    return keys.size === 1 ? [...keys][0] : null;
  }

  /** Locators Flow A needs so classify-tweets can silently annotate a freshly
   *  researched claim under the same hold (see AnnotLocators in intelligence.ts).
   *
   *  `tweetId` is the cached tweet whose claim this is. Quoted claims address the
   *  QUOTED row — same shape as classificationId (dbHitCache/tweetCache keying):
   *  the DB-hit path stores quoted tweets under their own id, and tweetCache holds
   *  the parent whose .quoting IS the quoted MainTweet. Returns null when the tweet
   *  side can't be resolved, in which case research simply runs un-annotated (old
   *  behaviour; the worker skips what it isn't sent).
   *
   *  tweet_hash is recomputed from the cached tweet (hash = full-context canonical
   *  serialization — never trust the DOM for it). tweet_text is the EXACT string the
   *  highlight ranges address: the Grok translation when the tweet displays translated,
   *  else the captured original — the same displayedTweetText() that gates the strip.
   *  text_locale is the persisted prefix for that text (destination/source language) —
   *  the same expression the preclassify worker uses for displayedLocale. claim_index
   *  counts within the claim's own list (main or quoted), mirroring how the worker
   *  echoes it on NDJSON lines. */
  async function annotLocatorsFor(
    tweetId: string,
    claims: Claim[] | null | undefined,
    claimText: string,
    classification: Classification,
    /** Which of a dual post's two bodies the tap came from, named by the tapped span —
     *  the only thing that knows which text the correction has to be measured against
     *  (see annotateSideForSpan). Omitted on every single-bodied surface, where the
     *  payload's displayed side is the only side there is. */
    namedSide?: 'alt' | 'translation' | null,
    sideText?: string | null,
    sideLocale?: string | null
  ): Promise<AnnotLocators | null> {
    try {
      const ownList = claims ?? [];
      let claimIndex = ownList.findIndex(c => c.text === claimText);
      // Which list owns this claim. The ranging locale below is read off it: a quoted
      // side's ranges are keyed by the QUOTED body's locale, never the main one's.
      let rangeList = ownList;
      // Structural subset: quoted tweets are plain Tweets (no References or translation
      // fields), so this can't be a MainTweet. computeTweetHash takes `any` regardless.
      type TweetSide = { text?: string; translatedText?: string; destinationLanguage?: string; sourceLanguage?: string; quoting?: { id: string } | null } | null | undefined;
      // The reader's displayed side, over the capture: Flow A hashes `tweetText` into the
      // annotation's "<locale>:<sha256>" key, and the capture can hold a different rendering
      // of that side than the one a Localize press measured (see displayedSides).
      let tweet: TweetSide = withDisplayedSide(tweetId, tweetCache.get(tweetId) ?? dbHitCache.get(tweetId)?.tweet ?? null);
      // Not the main tweet's claim — look in the quoted side (each side annotates
      // against its OWN tweet row, text, and hash).
      if (claimIndex < 0) {
        const quoted = classification.quoting?.claims;
        if (!quoted || quoted.findIndex(c => c.text === claimText) < 0) return null;
        claimIndex = quoted.findIndex(c => c.text === claimText);
        rangeList = quoted;
        tweet = tweetCache.get(tweetId)?.quoting ?? dbHitCache.get(tweetId)?.tweet?.quoting ?? null;
        if (!tweet) {
          for (const parent of tweetCache.values()) {
            if (parent.quoting?.id === tweetId || classification.quoting?.id === tweetId) { tweet = parent.quoting; break; }
          }
        }
      }
      if (!tweet) return null;
      const hasTranslation = !!(tweet.translatedText && tweet.destinationLanguage);
      // A named side wins over the payload's displayed side. Both sides of a dual post
      // paint ONE claim object, so the payload can only name the side it happens to call
      // displayed; measured off it, a tap on the translation wrote corrections for the
      // source under the translation's language (and with the clamped capture, not the
      // words on screen at all). The named translation hands over the live reading, the
      // same mine the Disinfact and Localize presses measure into.
      const translationSide = namedSide === 'translation';
      const altSide = namedSide === 'alt';
      const tweetText = translationSide
        ? (sideText?.trim() || tweet.translatedText || tweet.text)
        : altSide
          ? tweet.text
          : hasTranslation ? tweet.translatedText : tweet.text;
      const textLocale = translationSide
        ? (sideLocale ?? tweet.destinationLanguage ?? classification.textLocale ?? rangedLocale(rangeList))
        : altSide
          ? (tweet.sourceLanguage ?? classification.textLocale ?? rangedLocale(rangeList))
          : (hasTranslation ? tweet.destinationLanguage : tweet.sourceLanguage)
            ?? classification.textLocale
            ?? rangedLocale(rangeList);
      if (typeof tweetText !== 'string' || tweetText.length === 0 || !textLocale) return null;
      const tweetHash = await computeTweetHash(tweet);
      return { tweetHash, tweetText, textLocale, claimIndex: Math.max(0, claimIndex) };
    } catch {
      return null;
    }
  }

  /** Two claims' stored ranges name the same words when any shared locale key holds
   *  intersecting, located spans. The `[-1,-1]` could-not-locate sentinel is shared by
   *  every unlocated claim and names nothing, so it never overlaps. */
  function spansOverlap(
    a?: Record<string, [number, number]>,
    b?: Record<string, [number, number]>
  ): boolean {
    if (!a || !b) return false;
    for (const [key, spanA] of Object.entries(a)) {
      const spanB = b[key];
      if (!spanB || !isLocatedRange(spanA) || !isLocatedRange(spanB)) continue;
      if (spanA[0] < spanB[1] && spanB[0] < spanA[1]) return true;
    }
    return false;
  }

  /** Indices of the entries (in order) whose located spans are disjoint. Claims whose
   *  spans overlap are one claim wearing two rows, and nothing downstream can tell them
   *  apart: `mergeClaimPayload` matches a payload to a local claim by its range, the
   *  annotate flight is keyed by the claim's text, and both paint the same words. The
   *  preclassification contract is that raw spans never overlap (preclassify-tweets: "raw
   *  claims can NEVER overlap between claims") and the worker now drops an overlapping one
   *  before it is billed, but a row persisted before that still arrives, so every claim
   *  list entering from outside passes through here.
   *  The survivor is the claim carrying a verdict: the other has nothing a reader can act
   *  on, and left in place it parks a verdict-less row on hold — which is what renders
   *  Fact-Check All over a post whose only highlight is already green. */
  function overlappingClaimSurvivors<T extends Claim>(claims: T[]): number[] {
    if (claims.length < 2) return claims.map((_, i) => i);
    const keep: number[] = [];
    for (let i = 0; i < claims.length; i++) {
      const claim = claims[i];
      const at = keep.findIndex(k => spansOverlap(claims[k].highlight, claim.highlight));
      if (at < 0) { keep.push(i); continue; }
      const replaced = keep[at];
      const keptHasVerdict = claims[replaced].note != null && claims[replaced].confidence !== undefined;
      const incomingHasVerdict = claim.note != null && claim.confidence !== undefined;
      const survivor = incomingHasVerdict && !keptHasVerdict ? i : replaced;
      const dropped = survivor === i ? replaced : i;
      keep[at] = survivor;
      console.log(`[background] dropping claim "${(claims[dropped].rewritten ?? claims[dropped].text).slice(0, 40)}..." — its span already belongs to "${(claims[survivor].rewritten ?? claims[survivor].text).slice(0, 40)}..."`);
    }
    return keep.sort((a, b) => a - b);
  }

  function withoutOverlappingClaims<T extends Claim>(claims: T[]): T[] {
    const keep = overlappingClaimSurvivors(claims);
    return keep.length === claims.length ? claims : keep.map(i => claims[i]);
  }

  /** Convert a pulled/subscribed tweet's claims into a Classification for injection.
   *  If quotedDbClaims is provided, populates classification.quoting.claims as well.
   *  The surviving ROWS are returned alongside: `localizeHighlights` pairs ranges with
   *  `classification.claims` by index, so a dropped row has to leave the row list too. */
  function dbClaimsToClassification(
    tweet: MainTweet,
    dbClaims: any[],
    batchId: string,
    locale: string,
    quotedDbClaims?: any[]
  ): { classification: Classification; dbClaims: any[]; quotedDbClaims: any[] } {
    // X shows Grok-translated text by default when a translation exists.
    // Otherwise the displayed text is the original (source) text.
    const hasTranslation = !!tweet.translatedText && !!tweet.destinationLanguage;
    // `sourceLanguage` is NOT evidence that anyone named the source. Every DOM-fed capture is
    // stamped with the `und` placeholder (`nameCapturedLanguage`), and Facebook's own document
    // states no post language either — so the field is always present and always saying
    // nothing. The worker files ranges under whatever locale it was handed, which is exactly
    // this field, so it stays the right KEY to read them back with.
    const textLocale = hasTranslation ? tweet.destinationLanguage! : (tweet.sourceLanguage ?? UNKNOWN_LANGUAGE);
    // ...but it names no BODY. A classification with no body cannot be told apart from the
    // other side: the flip detector only runs when one is named, and the per-side claim record
    // only remembers a side whose body is known. Leaving it unnamed is why a DB hit's own
    // ranges vanished the moment the reader flipped away and back — the flip was never seen,
    // and the localization that followed then left the previously measured side with nothing.
    const statesSourceLanguage = !!tweet.sourceLanguage && tweet.sourceLanguage !== UNKNOWN_LANGUAGE;
    const namedBody = tweet.translatedText ?? (statesSourceLanguage ? undefined : tweet.text);

    // Strip persisted "<locale>:<hash>" highlight keys to the revision bound to the
    // displayed bodies (main + quoted — the two texts any highlight here can address).
    const gate = revisionGateFor(tweet, tweet.quoting);
    // Locale prefixes whose surviving range is bound to the DISPLAYED body (see
    // `selectHighlightRevision`). Facebook files both sides' ranges under whatever locale
    // the run was handed — a Localize press on the translation writes `und:<hash of the
    // translation>` just as a run on the source writes `und:<hash of the source>`. The
    // surviving `und` range is the translation's whenever the translation is what's on
    // screen, so it cannot stand in for the source (see `altBlockedKeys`).
    const fromDisplayed = new Set<string>();
    const mappedClaims = dbClaims.map(dbClaim => payloadToClaim(dbClaim, locale, gate, fromDisplayed));
    const keep = overlappingClaimSurvivors(mappedClaims);
    const claims = keep.map(i => mappedClaims[i]);
    const mappedQuoted = quotedDbClaims && quotedDbClaims.length > 0
      ? quotedDbClaims.map(dbClaim => payloadToClaim(dbClaim, locale, gate))
      : null;
    const quotedKeep = mappedQuoted ? overlappingClaimSurvivors(mappedQuoted) : [];
    const quoting = tweet.quoting
      ? {
          id: tweet.quoting.id,
          claims: mappedQuoted ? quotedKeep.map(i => mappedQuoted[i]) : null
        }
      : null;
    // A row whose every stored range is bound to a body this client is not holding has
    // nothing to paint and nothing to Reveal — the gate above drops all of them, and the
    // side then looked exactly like a post that had never been highlighted. That is the
    // state `translateFactChecksOnHold` names, and Localize is its affordance: the press
    // measures the stored ranges into the words on screen (filing them under `und` when
    // the platform states no language, which is Facebook's answer). Measured on a stored
    // row whose ten ranges were all filed against the English translation while the page
    // showed the Spanish source: no pill, and an on-hold bar with no way back to the paint.
    // A quoted post is left alone because the flag also tears down the quoted group's bar
    // (see `syncButtonBarAt`'s isQuoted branch), and these ranges are not that group's.
    const hadStoredRange = dbClaims.some((dbClaim) => {
      const h = dbClaim?.highlight;
      if (!h || typeof h !== 'object') return false;
      return Object.values(h).some((v) => Array.isArray(v) && v.length === 2);
    });
    const keptAnyRange = claims.some((c) => !!c.highlight && Object.keys(c.highlight).length > 0);
    const rangesBoundElsewhere = hadStoredRange && !keptAnyRange && !tweet.quoting;
    return {
      classification: {
        id: tweet.id, batchId, claims, quoting,
        translatedLocale: tweet.destinationLanguage, translatedText: namedBody, textLocale,
        ...(fromDisplayed.size > 0 ? { altBlockedKeys: [...fromDisplayed] } : {}),
        ...(rangesBoundElsewhere ? { translateFactChecksOnHold: true } : {}),
      },
      dbClaims: keep.map(i => dbClaims[i]),
      quotedDbClaims: mappedQuoted ? quotedKeep.map(i => quotedDbClaims![i]) : (quotedDbClaims ?? []),
    };
  }

  /** Localize highlights for a specific tweet text locale. Used both on initial
   *  load (for the default translated text) and on demand when the user toggles
   *  X's Show original/Show translation. Skips if this exact body was already
   *  localized under this locale for this tweet. */
  async function localizeHighlights(
    tweetId: string,
    tweet: Tweet,
    tweetText: string,
    highlightLocale: string,
    dbClaims: any[],
    classification: Classification,
    uiLocale: string,
    onHighlightUpdate?: (classification: Classification) => void
  ): Promise<void> {
    // Flow C annotation contexts, 1-based to match rewritten_claims indexing.
    // Only claims with a real verdict + reasoning are implicated: placeholders
    // (no note) and on-hold stale verdicts carry nothing the agent could
    // annotate, and the worker re-gates server-side anyway. classification.claims
    // runs in the same order as dbClaims (localizeHighlights guarantees it).
    const annotContexts: Record<string, HighlightAnnotContext> = {};
    (classification.claims ?? []).forEach((cl, idx) => {
      if (cl.note == null || cl.reclassifyOnHold) return;
      annotContexts[String(idx + 1)] = {
        veracity: cl.veracity,
        reasoning: cl.note,
        classified: true,
        stale: false,
      };
    });
    let seen = localizedHighlightLocales.get(tweetId);
    if (!seen) {
      seen = new Set<string>();
      localizedHighlightLocales.set(tweetId, seen);
    }
    // Keyed by the body, not the locale alone. A host that states no language (Facebook) files
    // BOTH sides' ranges under the same key, so the locale-only guard answered the second
    // side's Localize press with "already localized" and did nothing: the button stayed, the
    // side kept no ranges, and no run was ever sent for the words on screen.
    const seenKey = `${highlightLocale}:${sha256HexSync(tweetText)}`;
    // Every exit path has to restate `localizingHighlights`, which the press set before
    // calling here. This used to return bare, so a press that hit either early return
    // left the bar's wheel spinning with no Hide and no re-classify button, for good.
    const restoreAfterLocalizing = (holdButton: boolean) => {
      const cur = classificationCache.get(tweetId)?.classification;
      if (!cur) return;
      const restored = { ...cur, localizingHighlights: false };
      // A side that holds a range over THESE words is what the press was for: the hold that
      // offered Localize is spent. Re-stated, it outlived its result — Phase 2 returns while a
      // hold is set, so the run painted nothing, the button came back, and every later press
      // was this exit's "already localized over this body, skipping" (reported 2026-10-23 on a
      // side whose locale is a guess, where the hold is set before the run rather than after a
      // DB read). A side with nothing placed here keeps the hold.
      const painted = (cur.claims ?? []).some(cl => !!resolveHighlightRange(cl.highlight, highlightLocale));
      if (holdButton) restored.translateFactChecksOnHold = true;
      else if (painted) restored.translateFactChecksOnHold = undefined;
      cacheClassification(restored, classification.batchId);
      broadcastClassification(restored);
    };
    if (seen.has(seenKey)) {
      // The marker names a body, not a state this classification is guaranteed to hold: a
      // flip away drops the ranges the gate keeps only for the side on screen, and if the
      // flip back could not restore them (the DB snapshot can lag the run), the marker is
      // all that is left — a Localize button pressed forever over bare words, each press
      // exiting here and changing nothing (reported 2026-10-23). Identity is
      // `<locale>:<hash>`, so the marker is only spent while those words still hold a range.
      const cur = classificationCache.get(tweetId)?.classification;
      const placed = (cur?.claims ?? []).some(cl => !!resolveHighlightRange(cl.highlight, highlightLocale));
      if (placed) {
        console.log(`[localizeHighlights] ${tweetId}: already localized for ${highlightLocale} over this body, skipping`);
        // Ranges for this body are already filed, so the press has nothing to do — but the
        // highlight controls are the honest state, not a wheel.
        if (cur?.localizingHighlights) restoreAfterLocalizing(false);
        return;
      }
      seen.delete(seenKey);
      console.log(`[localizeHighlights] ${tweetId}: ${highlightLocale} was localized over this body but its ranges are no longer in hand — measuring again`);
    }

    // A press whose body is already being localized is the reader seeing Localize before the
    // wheel and clicking again — the run only joins `seen` once it finishes. Leave the wheel
    // alone: the run in flight owns `localizingHighlights`, and a second press must not start
    // a second paid job over the same words.
    if (localizationInFlight.has(seenKey)) {
      console.log(`[localizeHighlights] ${tweetId}: ${highlightLocale} localization is already in flight over this body — leaving it to finish`);
      return;
    }
    localizationInFlight.add(seenKey);
    try {
      const tweetHash = await computeTweetHash(tweet);
      // Claims are stored under the UI locale; use that text for cross-lingual highlight alignment.
      // Preserve the canonical DB claim text and its actual storage locale so the
      // highlight persistence worker can match the correct claim row (the RPC matches
      // c.claim @> jsonb_build_object(source_locale, claim_text)).
      const allDbClaims = dbClaims.map((d: any) => {
        const uiText = extractLocaleText(d.claim, uiLocale) || extractClaimText(d.claim);
        const canonical = d.dbClaimText ?? extractClaimText(d.claim);
        const storageLocale = d.sourceLocale ?? getClaimLocale(d.claim);
        return {
          claim: uiText,
          rewritten: uiText,
          dbClaimText: canonical,
          sourceLocale: storageLocale,
        };
      });
      if (allDbClaims.length === 0) {
        console.log(`[localizeHighlights] ${tweetId}: no claims to localize`);
        // Nothing can be measured, so the Localize affordance is the honest state.
        if (classificationCache.get(tweetId)?.classification.localizingHighlights) restoreAfterLocalizing(true);
        return;
      }
      // The persistence RPC matches claims by `c.claim @> {[source_locale]: claim_text}` — it
      // needs the locale the claim text is ACTUALLY stored under (allDbClaims[*].sourceLocale,
      // e.g. "es"), not uiLocale (e.g. "zh-TW"), which was passed here before and silently made
      // every match fail (0 rows updated, no error) since claims are never stored under the UI
      // locale. The RPC takes one locale per batch; claims in a batch share a storage locale.
      const claimStorageLocale = allDbClaims[0]?.sourceLocale ?? uiLocale;
      const injected = await backgroundHighlightRange(
        tweetHash,
        tweetText,
        allDbClaims,
        claimStorageLocale,
        highlightLocale,
        classification,
        onHighlightUpdate ?? mergeHighlightsFor(classification),
        annotContexts
      );
      if (injected > 0) {
        seen.add(seenKey);
        console.log(`[localizeHighlights] ${tweetId}: marked ${highlightLocale} as localized (${injected} range(s))`);
        // The merge can carry forward the hold the press started from; these words now hold a
        // range, so that hold is spent. Left set, Phase 2 returns for it on every pass and the
        // bar offers Localize again over a side that was just paid for.
        if (classificationCache.get(tweetId)?.classification.translateFactChecksOnHold) restoreAfterLocalizing(false);
        return;
      }
      // Worker failure or empty stream (transient 500s happen): NOT localized —
      // the next click retries instead of hitting "already localized, skipping".
      // The merge callback never fired, so localizingHighlights is still set and
      // would spin forever: clear it and restore the on-hold flag so the
      // Localize button comes back.
      console.warn(`[localizeHighlights] ${tweetId}: no ranges for ${highlightLocale} — restoring Translate Fact-Checks button`);
      restoreAfterLocalizing(true);
    } finally {
      localizationInFlight.delete(seenKey);
    }
  }

  /** Build a dbClaims-like array from a cached classification for on-demand highlight localization.
   *  Uses the UI-locale claim text so the highlight worker can align it to the tweet text. */
  function claimsToDbClaims(classification: Classification): { claim: string; rewritten: string; dbClaimText?: string; sourceLocale?: string }[] {
    return (classification.claims ?? []).map(cl => {
      const uiText = cl.rewritten ?? cl.text;
      const canonical = cl.dbClaimText;
      return {
        claim: uiText,
        rewritten: uiText,
        dbClaimText: canonical,
        sourceLocale: cl.claimLocale,
      };
    });
  }

  /** Fire re-research in background for an on-hold claim, buffering results
   *  until the user clicks the highlight/badge. */
  async function fireHeldReclassification(
    classification: Classification,
    claimText: string,
    locale: string
  ): Promise<void> {
    const holdKey = `${classification.id}:${claimText}`;
    try {
      // Held (unpaid) re-research sends NO locators: annotation costs real money and the
      // user hasn't agreed to spend anything yet — Flow A runs only on paid research.
      for await (const updated of refreshClaim(classification, claimText, researchCache, locale)) {
        // Buffer result instead of broadcasting
        heldReclassifications.set(holdKey, updated);
        console.log(`[fireHeldReclassification] buffered result for ${holdKey}`);
      }
    } catch (err) {
      console.error(`[fireHeldReclassification] error for "${claimText.slice(0, 40)}":`, err);
    }
  }

  /** Fire re-research for DB-hit claims needing reclassification.
   *  Reuses refreshClaim() which calls streamResearch(). After all done, upserts the tweet pipeline.
   *  Also localizes highlights for the displayed tweet text locale if needed.
   *  Does NOT translate claim text or reasoning — those are gated by user actions. */
  async function reResearchDbClaims(
    dbClaims: any[],
    classification: Classification,
    researchCache: Map<string, { confidence: number; veracity: number; reasoning: string; reasoningLocale?: string; sources?: Source[]; dbClaimText?: string; embedding?: number[]; lastClassification?: string; freshlyResearched?: boolean; veracity_change_duration?: string }>
  ): Promise<void> {
    // Reclassify check is already decided at build time in
    // dbClaimsToClassification (a reclassify=true claim is shown on hold from the
    // very first render, so it never flashes its old color then flips). Nothing to
    // do asynchronously here — an empty list keeps the loop below a no-op.
    const propense: any[] = [];

    // Pre-populate researchCache so formatVerdict works immediately (use plain string reasoning, not JSONB object)
    for (const dbClaim of dbClaims) {
      const cacheKey = extractClaimText(dbClaim.claim);
      if (!researchCache.has(cacheKey)) {
        const sourceLocale = dbClaim.locale_key ?? getClaimLocale(dbClaim.claim);
        const reasonStr = extractReasoningText(dbClaim.reasoning, sourceLocale);
        researchCache.set(cacheKey, {
          // Same certainty rule as payloadToClaim (see dbClaimConfidence): the stored
          // probability, falling back to |veracity| only when the payload lacks it. This
          // cache feeds applyFindings, which sets `confidence` on the claim — so leaving it
          // on the old |veracity| basis would silently undo the fix.
          confidence: dbClaimConfidence(dbClaim),
          veracity: Number(dbClaim.veracity ?? 0),
          reasoning: reasonStr,
          reasoningLocale: sourceLocale,
          sources: normalizeSources(dbClaim.sources),
          dbClaimText: extractClaimText(dbClaim.claim),
          lastClassification: getLastClassification(dbClaim),
        });
      }
    }

    // Propagate dbClaimLocale (canonical storage locale for matching) on the
    // classification's claims and quoted claims. Leave claimLocale and reasoningLocale
    // as set by dbClaimsToClassification (they reflect the displayed text's actual
    // locales and are used for Translate buttons).
    const propagateDbClaimLocale = (claims: Claim[] | null | undefined): Claim[] | null => {
      if (!claims) return claims ?? null;
      for (const dbClaim of dbClaims) {
        const cacheKey = extractClaimText(dbClaim.claim);
        const dbClaimLocaleVal = getClaimLocale(dbClaim.claim);
        claims = claims.map(cl => {
          if ((cl.dbClaimText ?? cl.text) === cacheKey) {
            return { ...cl, dbClaimLocale: dbClaimLocaleVal };
          }
          return cl;
        });
      }
      return claims;
    };
    classification.claims = propagateDbClaimLocale(classification.claims);
    if (classification.quoting?.claims) {
      classification.quoting = { ...classification.quoting, claims: propagateDbClaimLocale(classification.quoting.claims) };
    }

    // Highlight localization is NOT done here: this runs automatically on a DB hit,
    // before the user has clicked anything, and localizing charges the balance. It is
    // triggered ONLY when the user explicitly toggles X's translation (handled via the
    // SET_DISPLAYED_LOCALE path), never on load — even for a tweet X is already showing
    // translated. A DB hit is injected with whatever highlight locales it already has.

    for (const dbClaim of propense) {
      const claimText = extractClaimText(dbClaim.claim);
      try {
        // Put claim on hold: cache current values, set neutral state, broadcast
        const existing = classificationCache.get(classification.id);
        if (existing) {
          const cls = existing.classification;
          const updatedClaims = cls.claims?.map(cl => {
            if ((cl.dbClaimText ?? cl.text) === claimText) {
              return {
                ...cl,
                reclassifyOnHold: true,
                cachedVerdict: cl.verdict,
                cachedNote: cl.note,
                cachedConfidence: cl.confidence,
                cachedVeracity: cl.veracity,
                cachedSources: cl.sources,
                verdict: "research required" as const,
                note: null,
                confidence: undefined,
                veracity: undefined,
              };
            }
            return cl;
          }) ?? null;
          const onHoldCls: Classification = { ...cls, claims: updatedClaims, reclassifyOnHold: true };
          cacheClassification(onHoldCls, classification.batchId);
          broadcastClassification(onHoldCls);

          // Do NOT auto-fire re-research here. The claim stays on hold until the
          // user clicks the highlight, at which point PROCESS_ON_HOLD / REFRESH_CLAIM
          // runs refreshClaim with the correct canonical dbClaimLocale for matching.
        }
      } catch (err) {
        console.error(`[reResearchDbClaims] error for "${claimText.slice(0, 40)}":`, err);
      }
    }

    // No need to re-upsert tweet-claim links — they already exist from the initial insert.
    // Re-research updates claim veracity/reasoning, not tweet_claims links.
  }

  /** Decode common HTML entities without a DOM. The background service worker
   *  has no `document`, so we can't use `document.createElement('div')`. */
  function backgroundHtmlDecode(text: string): string {
    return text
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }

  /** Compute the character range of rawClaim within tweetText.
   *  Uses the same fuzzy matching as the content script's segment builder so
   *  that highlights computed in the background agree with what the user sees.
   *  Returns [start, end] or null if no acceptable match is found. */
  function computeHighlightRange(tweetText: string, rawClaim: string): [number, number] | null {
    if (!tweetText || !rawClaim) return null;

    // Use the same matcher the content script uses for inline highlighting.
    // Pass a DOM-free decoder because the service worker has no document.
    const match = findExactMatch(tweetText, rawClaim, backgroundHtmlDecode);
    if (match) return [match.start, match.end];

    return null;
  }


  /** Send a classification to every connected relay and reconcile the on-hold
   *  bookkeeping for its claims.
   *
   *  What goes over the wire is not always exactly what gets cached: under Fact-Check
   *  All, claims that are queued or in flight are presented as already fact-checking so
   *  the UI never flashes a button the user has effectively already pressed. */
  /** Stamp the Flow A marker onto the outgoing copy of a settled, classified,
   *  keyless claim whose research just ran WITH locators (opt.withLocators) —
   *  its silent post-research annotation run is in flight, so the content
   *  script shows "Annotating" instead of the idle Annotate affordance. A
   *  present key (even an empty dict) means annotated: stamps nothing. Claims
   *  list (main + quoting) mapped, never mutated: the cache keeps the clean
   *  claim, and the relay strips the marker before render — it never reaches
   *  the Claim type, the popover, or a worker. Returns null when nothing
   *  stamped, so the common path skips the copy entirely.
   *
   *  `claimTexts` is the second source of the same truth: a pull that read the
   *  server's is_annotating marker for some links (see watchInFlightAnnotation).
   *  Either way the run is real and under way; the gates below are the same. */
  function stampAnnotateInFlight(
    classification: Classification,
    opt?: { withLocators?: boolean; claimText?: string; claimTexts?: Set<string> }
  ): Classification | null {
    const picked = opt?.claimTexts;
    const single = opt?.claimText;
    if (opt?.withLocators !== true && !picked?.size) return null;
    const stampList = (claims: Classification["claims"]) => {
      if (!claims) return { list: claims, stamped: false };
      let stamped = false;
      const list = claims.map(cl => {
        if (single !== undefined && cl.text !== single) return cl;
        if (picked && !picked.has(cl.text)) return cl;
        // Same gate as the background's ANNOTATE_CLAIM handler and the content
        // script's spanNeedsAnnotateBadge: settled + classified + keyless.
        if (cl.reclassifyOnHold || cl.note == null) return cl;
        // A present locale key, even with an empty dict ("annotated, nothing
        // wrong"), means the run already landed — stamping would keep the
        // "Annotating" spinner up after Flow A persisted {}.
        if (cl.annotations && Object.keys(cl.annotations).length > 0) return cl;
        stamped = true;
        return { ...cl, annotateInFlight: true as any };
      });
      return { list, stamped };
    };
    const main = stampList(classification.claims);
    const q = classification.quoting
      ? stampList(classification.quoting.claims)
      : { list: null as Classification["claims"], stamped: false };
    if (!main.stamped && !q.stamped) return null;
    // The stamp is what paints "Annotating" on a settled, keyless claim, so it is also the
    // start of the wait that never ends when the worker's silent run produces nothing. Logged
    // with the claim text because "the badge is stuck" and "the badge was never raised" look
    // identical from the page, and only one of them is this path's doing.
    console.log(
      '[background] stampAnnotateInFlight:', classification.id,
      '| claim:', (single ?? `[${picked?.size ?? 0} pulled]`).slice(0, 40), '| mainStamped:', main.stamped, '| quotedStamped:', q.stamped
    );
    return {
      ...classification,
      claims: main.list,
      quoting: classification.quoting ? { ...classification.quoting, claims: q.list as any } : classification.quoting,
    };
  }

  /** The copy a classification is delivered to a port with, once the claims a run already
   *  owns are shown as researching rather than as the on-hold button they really are.
   *
   *  Outgoing copy only — the cache keeps the real (reclassifyOnHold) state, so click paths
   *  and the auto-release loop read what actually happened. Every claim-bearing delivery to
   *  a port must go through this, not just the broadcast: a DB rebuild posted straight to
   *  its port is where a parked claim used to come back as a button mid-run.
   */
  function maskPendingResearch(classification: Classification): Classification {
    // A claim the user asked to research — Fact-Check All for this tweet, or a single
    // Disinfact click recorded in `researchRequestedBeforeRow` — is presented as already
    // "Fact-Checking" (refreshing) in the message we send to the UI, so it never flashes a
    // Disinfact badge in the window before its DB row lets the auto-release below start the
    // run. That window is the point: the request is held until the row says whether the DB
    // already answers the claim. The cache and the auto-release loop still operate on the
    // real (reclassifyOnHold) state.
    const scopedTexts = factCheckAllScopedTexts.get(classification.id);
    const isRequestedClaim = (claim: Claim): boolean => {
      const key = `${classification.id}:${claim.text}`;
      const clicked = researchRequestedBeforeRow.has(key);
      return claim.reclassifyOnHold === true
        && !abandonedFactCheckKeys.has(key)
        && (factCheckAllTweetIds.has(classification.id) || clicked)
        && (!scopedTexts || scopedTexts.has(claim.text))
        // The post's Fact-Check All is a batch over the highlights it can see, and a flagged
        // claim is not one of them — it is researched only by a deliberate click on it, by a
        // passage's scoped request, or by a selection, whose every claim is its own. A
        // revealed area's scoped request is that same explicitness for the claims it names.
        && (clicked || scopedTexts !== null || isSelectionId(classification.id) || claim.isHidden !== true);
    };
    let outgoing = classification;
    if (classification.claims?.some(isRequestedClaim)) {
      // Present WAITLISTED/in-flight/row-pending claims as "Fact-Checking", but leave
      // ABANDONED ones (2 failed tries / 30s timeout / broke / row never came) showing
      // their real on-hold button so the user can retry — that's the visible signal the
      // call didn't go through.
      outgoing = {
        ...classification,
        claims: classification.claims.map(claim =>
          isRequestedClaim(claim)
            ? { ...claim, reclassifyOnHold: false, refreshing: true, note: null }
            : claim
        ),
      };
    }
    // A lone claim whose run drained and handed it to the automatic research: it is
    // about to be researched whether the user clicks or not, and the click that would
    // normally start it is the button this hides. Present it as the researching state
    // it is entering, so it never shows a Fact-Check button for the wait on its DB row.
    // Same shape as the Fact-Check All rewrite above — outgoing copy only, cache
    // untouched — so every click path stays on the state the cache actually holds. The
    // mark only has to cover the wait: the hand-off broadcasts the researching state
    // itself, and the mark is dropped once it has.
    //
    // A quoted post's claims are masked with the tweet's own: the hand-off counts both,
    // so a quote holding the run's only claim is researched automatically exactly like
    // the tweet's own would be.
    const maskedOnHold = (list: Claim[] | null | undefined): Claim[] | null | undefined =>
      list?.map(claim =>
        claim.reclassifyOnHold && !claim.refreshing
          ? { ...claim, reclassifyOnHold: false, refreshing: true }
          : claim
      );
    const anyStillOnHold = (list: Claim[] | null | undefined): boolean =>
      !!list?.some(claim => claim.reclassifyOnHold && !claim.refreshing);
    if (preclassifyRunTweets.has(classification.id)
        && (anyStillOnHold(outgoing.claims) || anyStillOnHold(outgoing.quoting?.claims))) {
      outgoing = {
        ...outgoing,
        claims: maskedOnHold(outgoing.claims) ?? outgoing.claims,
        quoting: outgoing.quoting
          ? { ...outgoing.quoting, claims: maskedOnHold(outgoing.quoting.claims) ?? outgoing.quoting.claims }
          : outgoing.quoting,
      };
    }
    return outgoing;
  }

  function broadcastClassification(classification: Classification, opt?: { withLocators?: boolean; claimText?: string }) {
    classification = withRunningLocalization(classification);
    const claimSummary = classification.claims?.map(claim => {
      const shortLabel = (claim.rewritten ?? claim.text).slice(0, 20);
      const notePreview = claim.note ? claim.note.slice(0, 15) : 'none';
      const highlightLocales = claim.highlight ? Object.keys(claim.highlight).join(',') : 'none';
      // `ann:` is here because an annotation-only update moves nothing else in this
      // summary, so without it a clean annotation ("annotated, nothing wrong" = an empty
      // dict under a kept locale key) arriving or NOT arriving looks identical in the log,
      // and whether it reached the client is exactly what has to be told apart.
      const annLocales = claim.annotations ? Object.keys(claim.annotations).join(',') : 'none';
      return `${shortLabel}...=${claim.confidence ?? '?'}(note:${notePreview}...,hl:${highlightLocales},ann:${annLocales})`;
    }).join(' | ') || 'none';
    console.log(`[background] broadcasting ${classification.id} with ${activePorts.size} active port(s), claims: ${claimSummary}`);


    let outgoing = maskPendingResearch(classification);
    // Stamp the Flow A marker onto the OUTGOING copy only (the cache keeps the
    // clean claim): a settled, classified claim with no annotation key whose
    // research ran with locators has a silent post-research annotation run in
    // flight — the content script shows "Annotating" instead of the idle
    // Annotate affordance. Refreshed verdicts re-stamp (a reclassification's
    // Flow A run also re-runs); the relay strips the marker before render.
    const stamped = stampAnnotateInFlight(outgoing, opt);
    if (stamped) outgoing = stamped;
    for (const port of activePorts) {
      try { port.postMessage({ type: "CLASSIFICATION", data: outgoing }); } catch { /* port closed mid-broadcast */ }
    }
    // Track claims still showing a Disinfact button (reclassifyOnHold) — awaiting
    // user action. If the user asked to research one (Fact-Check All for this tweet, or a
    // single click recorded in `researchRequestedBeforeRow`), auto-release it — including
    // change-prone DB claims that carry cached values; otherwise just mark it pending.
    //
    // The release NEVER acts on the streamed snapshot: preclassify marks a claim on hold
    // before the worker's embed → match → link has run, so an on-hold claim with no DB id
    // may still turn out to be one the DB already answers. The row's own broadcast
    // re-enters this loop and decides then — a claim it settles is not researched, and one
    // it still holds on hold is. The request stays recorded across that gap.
    const scopedTexts = factCheckAllScopedTexts.get(classification.id);
    for (const claim of classification.claims ?? []) {
      const key = `${classification.id}:${claim.text}`;
      const clicked = researchRequestedBeforeRow.has(key);
      const requested = (factCheckAllTweetIds.has(classification.id) || clicked)
        && (!scopedTexts || scopedTexts.has(claim.text))
        // Same rule as `isRequestedClaim` above: a batch request does not reach a flagged
        // claim; an explicit click, a revealed area's scope, a passage's scope or a
        // selection does.
        && (clicked || scopedTexts !== null || isSelectionId(classification.id) || claim.isHidden !== true);
      if (!requested) {
        if (claim.reclassifyOnHold) pendingFreshResearchClaims.add(key);
        continue;
      }
      if (!claim.dbClaimId) continue;
      pendingFreshResearchClaims.delete(key);
      researchRequestedBeforeRow.delete(key);
      // The row has decided: a claim it settled needs nothing.
      if (!claim.reclassifyOnHold) continue;
      // Add to the Fact-Check All waitlist (idempotent; skips already-queued/in-flight/
      // abandoned claims). It is admitted for research only when the balance covers its hold.
      enqueueFactCheckClaim(classification.id, claim.text, classification.batchId, localeFromClassification());
    }
  }

  /** Locale to key claim upserts under. Claims are stored/keyed in the DB under the
   *  UI locale (see upsertProcessedClaims' dbClaimLocale), NOT the displayed tweet's
   *  textLocale — so re-research must upsert under the UI locale too, otherwise it
   *  inserts a duplicate row under a different key (e.g. "en" vs "en-US") instead of
   *  updating the existing placeholder/claim row. */
  function localeFromClassification(): string {
    return getUiLocale();
  }

  /** Register a claim-research promise so the placeholder upsert can await it. */
  function trackClaimResearch(refreshKey: string, promise: Promise<void>) {
    claimResearchPromises.set(refreshKey, promise);
    promise.finally(() => {
      if (claimResearchPromises.get(refreshKey) === promise) {
        claimResearchPromises.delete(refreshKey);
      }
    });
  }

  /** Await any in-flight claim research for the given tweet. Used by the placeholder
   *  upsert: if the user triggered classification early (Fact-Check All / all Disinfact
   *  clicks before fetch-claim finished), we wait for those to complete so the tweet is
   *  persisted with real values instead of placeholders that would clobber them. */
  async function awaitTweetClaimResearch(tweetId: string): Promise<void> {
    const prefix = `${tweetId}:`;
    const pending: Promise<void>[] = [];
    for (const [key, p] of claimResearchPromises) {
      if (key.startsWith(prefix)) pending.push(p);
    }
    if (pending.length > 0) {
      console.log(`[background] awaitTweetClaimResearch ${tweetId}: waiting for ${pending.length} in-flight research(es)`);
      await Promise.allSettled(pending);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Cache merging. Results arrive from several sources at once — preclassification,
  // per-claim research, Realtime pushes, translation — each holding its own snapshot
  // of a classification. These helpers fold an update into the freshest cached copy
  // rather than overwriting it, which is what stops a slow path from resurrecting
  // stale claims over a newer result.
  // ─────────────────────────────────────────────────────────────────────────

  /** Merge a single claim's latest state (from a per-claim refreshClaim generator)
   *  into the freshest cached classification, then cache + broadcast the result.
   *
   *  When several claims are researched concurrently (e.g. Fact-Check All, or the
   *  user clicking multiple claim-level Disinfact badges), each refreshClaim
   *  generator holds its own stale classification snapshot. Caching/broadcasting
   *  the whole snapshot would overwrite OTHER claims that finished in the meantime,
   *  making already-classified highlights flicker back to grey ("Fact-Checking").
   *  Merging only the target claim into the authoritative cache avoids that. */
  /** Union two bare-locale annotation maps, the second winning per locale key. Never
   *  replaces: a payload stripped under a narrower gate (or an older fetch) must not
   *  clobber keys the cached copy already holds. A kept locale key with an empty dict
   *  ("annotated, clean") survives; only a map with no keys at all returns undefined
   *  so "never annotated" stays distinguishable. */
  function unionAnnotations(
    a?: Record<string, Record<string, string>>,
    b?: Record<string, Record<string, string>>
  ): Record<string, Record<string, string>> | undefined {
    if (!a && !b) return undefined;
    const merged = { ...(a ?? {}), ...(b ?? {}) };
    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  /** Keep only the annotation revision for the one locale being re-researched.
   *
   *  An annotation is bound to the classification that produced it. Re-researching a
   *  claim replaces that classification, but the DB never discards annotations — it
   *  appends them by text revision — so the cached claim's whole locale-keyed dict
   *  would go on painting the OTHER side's (the translation of a post, or its source)
   *  correction, a stale one that only returns again on the next DB read. Pruning it
   *  here lets that side fall back to the Annotate affordance. The researched side
   *  keeps its key until the fresh annotation lands and overwrites it over the
   *  annotation subscription. */
  function keepAnnotationsForLocale(
    ann: Record<string, Record<string, string>> | undefined,
    locale: string
  ): Record<string, Record<string, string>> | undefined {
    if (!ann) return undefined;
    // Same base-language matching the painter uses (`annotationKeysFor`), so a stored
    // "en-US" key and an annotator locale of "en" still name each other.
    const full = locale.toLowerCase();
    const base = full.split("-")[0];
    const kept: Record<string, Record<string, string>> = {};
    for (const [k, v] of Object.entries(ann)) {
      const kl = k.toLowerCase();
      if (kl === full || kl.split("-")[0] === base) kept[k] = v;
    }
    return Object.keys(kept).length > 0 ? kept : undefined;
  }

  /** The annotation dict minus every entry filed under one locale — the other half of
   *  keepAnnotationsForLocale. Used when a classification is re-pointed at another BODY
   *  under the same locale: what was measured into the old words cannot be told apart
   *  from the new side's once stripped to bare prefixes (see selectAnnotationRevision),
   *  so it is dropped rather than carried. Absence returns undefined — "never annotated"
   *  stays distinguishable from "annotated, nothing wrong" ({}) . */
  function dropAnnotationsForLocale(
    ann: Record<string, Record<string, string>> | undefined,
    locale: string
  ): Record<string, Record<string, string>> | undefined {
    if (!ann) return undefined;
    const full = locale.toLowerCase();
    const base = full.split("-")[0];
    const kept: Record<string, Record<string, string>> = {};
    for (const [k, v] of Object.entries(ann)) {
      const kl = k.toLowerCase();
      if (kl === full || kl.split("-")[0] === base) continue;
      kept[k] = v;
    }
    return Object.keys(kept).length > 0 ? kept : undefined;
  }

  /** Flow A has no NDJSON: after research the worker persists (even {}) in
   *  ctx.waitUntil. The client path is the same as X — the tweet subscription
   *  (`ensureAnnotationSubscription`) receives `trg_tweet_claim_annotations_updated`.
   *  Do not invent a locale key here: painting `{locale: {}}` made selection look
   *  like annotations were disabled, and a pull is not how X gets the ranges.
   *
   *  What this DOES do is re-open that subscription on a fresh routing row. The
   *  subscription opened before research is not necessarily the one Flow A's persist
   *  finds: `on_tweet_preclassification_complete` deletes every tweet-scoped routing row
   *  (internal.broadcasts) once the preclassify worker settles, and that runs while this
   *  claim's research is already in flight — after the pre-research subscribe registered.
   *  The handle still looks live locally (only the routing row died), so nothing would
   *  ever recreate it and the persist would broadcast to nobody: the badge sits on
   *  "Annotating" forever with the annotations already in the DB. Research outlasts that
   *  teardown, so a row created here is reliably still there when the worker persists. */
  async function settleFlowAAnnotations(
    classificationId: string,
    claimText: string,
    loc: AnnotLocators,
    _batchId: string
  ) {
    try {
      await ensureAnnotationSubscription(classificationId, claimText, loc.textLocale, true);
    } catch (err) {
      console.error('[background] settleFlowAAnnotations: annotation routing re-open failed:', err);
    }
    reconcileSettledAnnotation(classificationId, claimText, loc);
  }

  /** The annotation keys a claim holds for `locale`, bare or revision-keyed
   *  (`<locale>:<sha256>`). A present key counts even with an empty dict — `{}` is the
   *  refused run's "annotated, nothing wrong". */
  function sideAnnotationKeys(annotations: Claim['annotations'], locale: string): string[] {
    const want = locale.toLowerCase();
    const wantBase = want.split('-')[0];
    return Object.keys(annotations ?? {}).filter((key) => {
      const prefix = (splitHighlightKey(key)?.[0] ?? key).toLowerCase();
      return prefix === want || prefix.split('-')[0] === wantBase;
    });
  }

  /** Flow A's persist can land before the row it means to broadcast to exists.
   *
   *  The subscription re-opened in settleFlowAAnnotations carries everything written
   *  after it goes live, and the refused run is the fast case: the worker's gate persists
   *  its empty review about a tenth of a second behind the stream close, by which time
   *  the preclassify teardown has usually taken every earlier routing row — so the write
   *  lands with nobody listening and the badge spins out its whole window on an
   *  annotation that is already in the DB.
   *
   *  So look for it directly once the run has had time to finish, and again if the first
   *  look was too early. The read is billed, so it is only spent while no annotation key
   *  for this side has landed. Merging the row back is the path a reload takes. */
  function reconcileSettledAnnotation(
    classificationId: string,
    claimText: string,
    loc: AnnotLocators
  ): void {
    for (const delay of ANNOTATION_READBACK_MS) {
      setTimeout(() => { void readBackSettledAnnotation(classificationId, claimText, loc); }, delay);
    }
  }

  async function readBackSettledAnnotation(
    classificationId: string,
    claimText: string,
    loc: AnnotLocators
  ): Promise<void> {
    // Only the main list merges: mergeClaimPayload addresses cls.claims alone, so a
    // quoted-side payload would arrive as a duplicate. The re-open still covers that side.
    const claim = classificationCache.get(classificationId)?.classification
      ?.claims?.find(c => c.text === claimText);
    if (!claim) return;
    if (sideAnnotationKeys(claim.annotations, loc.textLocale).length > 0) return;
    try {
      const row = await fetchDbTweet(loc.tweetHash);
      if (!row.success || !row.claims) return;
      const payload = claim.dbClaimId
        ? row.claims.find(c => c.id === claim.dbClaimId)
        : (row.claims.length === 1 ? row.claims[0] : undefined);
      if (!payload) return;
      // A skipped run persists nothing but says so (`annotation_run_settled`), which is
      // also an answer: merging it hands the badge back to its idle Annotate affordance.
      const settled = payload.annotation_run_settled === true;
      if (!settled && sideAnnotationKeys(payload.annotations, loc.textLocale).length === 0) return;
      // The key can land while the read is in flight.
      const live = classificationCache.get(classificationId)?.classification
        ?.claims?.find(c => c.text === claimText);
      if (!live || sideAnnotationKeys(live.annotations, loc.textLocale).length > 0) return;
      console.log(`[background] annotation never landed for "${claimText.slice(0, 40)}..." — reading back the stored one`);
      mergeClaimPayload(classificationId, payload, loc.textLocale);
    } catch (err) {
      console.error('[background] readBackSettledAnnotation failed:', err);
    }
  }

  /** The workers' pre-agent verdict gate (classify-tweets `annotRefusalReason`, and the
   *  same constant in fetch-claim and highlight-claims): a near-certain TRUE claim has no
   *  wrong word to mark, and a verdict we barely trust must not strike anything. Both
   *  persist an empty dict instead of calling an agent. Thresholds are inclusive. */
  const ANNOT_REFUSE_VERACITY = 0.9, ANNOT_REFUSE_CONFIDENCE = 0.2;
  function verdictRefusesAnnotation(claim: Claim): boolean {
    if (typeof claim.veracity === 'number' && claim.veracity >= ANNOT_REFUSE_VERACITY) return true;
    return typeof claim.confidence === 'number' && claim.confidence <= ANNOT_REFUSE_CONFIDENCE;
  }

  /** The annotation a refused claim is going to be stored with, written now instead of
   *  waited for: the worker's gate persists `{}` under this locale and never calls the
   *  agent, so there is nothing to wait for — only a broadcast that can, and does, land
   *  before the client's re-opened routing row is listening.
   *
   *  The span has to have resolved for this side first. The gate sits BEHIND
   *  `resolveAnnotationSpan`, so a run with no located range for this locale skips before
   *  ever reading the verdict and persists nothing at all — pinning a key there would
   *  assert "annotated, nothing wrong" for a claim nobody annotated (see
   *  empty-annotation-key), and the Annotate affordance would stay gone. */
  function predictEmptyAnnotation(claim: Claim, locale: string | undefined): Claim {
    if (!locale) return claim;
    if (!verdictRefusesAnnotation(claim)) return claim;
    if (sideAnnotationKeys(claim.annotations, locale).length > 0) return claim;
    if (!Array.isArray(claim.highlight?.[locale])) {
      console.log(`[background] verdict refuses the annotation for "${claim.text.slice(0, 40)}..." but ${locale} has no located range — leaving the wait to the worker`);
      return claim;
    }
    console.log(`[background] verdict settles the annotation for "${claim.text.slice(0, 40)}..." (veracity ${claim.veracity}, confidence ${claim.confidence}) — ${locale} recorded empty`);
    return { ...claim, annotations: { ...(claim.annotations ?? {}), [locale]: {} } };
  }

  function mergeSingleClaimAndBroadcast(
    classificationId: string,
    claimText: string,
    updated: Classification,
    batchId: string,
    opts?: { withLocators?: boolean; annotatedLocale?: string }
  ) {
    const stampOpt = opts?.withLocators ? { withLocators: true, claimText } : undefined;
    const existing = classificationCache.get(classificationId)?.classification;
    const updatedClaim = updated.claims?.find(c => c.text === claimText);
    if (!existing || !existing.claims || !updatedClaim) {
      // The verdict may already settle this claim's annotation — see predictEmptyAnnotation.
      const painted: Classification = {
        ...updated,
        claims: updated.claims?.map(c => (c.text === claimText ? predictEmptyAnnotation(c, opts?.annotatedLocale) : c)) ?? updated.claims,
        batchId,
      };
      cacheClassification(painted, batchId);
      broadcastClassification(painted, stampOpt);
      // Research rewrote the rows — drop the pre-research fetch snapshot.
      markTweetDbStale(classificationId);
      return;
    }
    // Fresh research rebuilds carry no annotations — union so they never clobber the
    // cached copy's (the fresh result wins per locale key when it has any). Except for
    // the side NOT being researched: that annotation belonged to the classification
    // this run just replaced (and left the DB with it), so it must not survive to keep
    // painting there — that side falls back to the Annotate affordance.
    const mergedClaims = existing.claims.map(c => {
      if (c.text !== claimText) return c;
      const ann = unionAnnotations(c.annotations, updatedClaim.annotations);
      const kept = opts?.annotatedLocale ? keepAnnotationsForLocale(ann, opts.annotatedLocale) : ann;
      return predictEmptyAnnotation({ ...updatedClaim, annotations: kept }, opts?.annotatedLocale);
    });
    const anyOnHold = mergedClaims.some(c => c.reclassifyOnHold);
    const merged: Classification = {
      ...existing,
      claims: mergedClaims,
      reclassifyOnHold: anyOnHold || undefined,
    };
    merged.batchId = batchId;
    cacheClassification(merged, batchId);
    broadcastClassification(merged, stampOpt);
    // Research rewrote the rows — drop the pre-research fetch snapshot.
    markTweetDbStale(classificationId);
  }

  /** Did this claim arrive with no span in the passage the user selected?
   *
   *  A selection can only fact-check what was selected. The run ships the surrounding
   *  article prose for anchoring (up to 100 words before, 25 after — selection.ts), and the
   *  model sometimes mines a claim out of THAT instead of the passage. Such a claim comes
   *  back unlocated, so it has no span to draw and can only ever render as a list entry
   *  describing text the user never selected. Dropping it is the fix for that; and because
   *  the sentinel it carries is not an identity (see above), leaving it in is also what
   *  duplicated a claim.
   *
   *  `streamed` separates the two ways an unlocated claim arrives: the preclassify stream
   *  emits NO highlight at all for one (makePreclassification), while a DB payload carries
   *  the `[-1,-1]` the worker persisted. A payload with no highlight at all is NOT
   *  unlocated — the revision gate strips highlights it cannot bind, and those claims are
   *  real. Gated on the cached tweet being a selection, so tweets (X) are untouched. */
  const unlocatedSelectionClaim = (tweetId: string, claim: any, streamed: boolean): boolean => {
    const cached: any = tweetCache.get(tweetId);
    if (!cached || (cached.contextBefore === undefined && cached.contextAfter === undefined)) return false;
    const ranges = Object.values(claim?.highlight ?? {});
    if (ranges.length === 0) return streamed;
    return !ranges.some(isLocatedRange);
  };

  /** Merge a freshly-streamed preclassification snapshot into whatever is already
   *  cached for the tweet, WITHOUT downgrading a claim that has since become active.
   *  preClassify yields CUMULATIVE snapshots in which every claim is reset to the
   *  "research required" placeholder, so caching each one wholesale would reset an
   *  already-researched or in-flight claim back to a spinner (the reset-to-loading bug).
   *  Match incoming↔existing by a shared highlight range (any locale key) or by
   *  rewritten/text; when the existing copy is active (carries a verdict, is refreshing,
   *  is being classified, or already has a DB id) keep it and only union in new highlight
   *  ranges. */
  function mergePreclassIntoCache(incoming: Classification): Classification {
    const existing = classificationCache.get(incoming.id)?.classification;
    const claimsMatch = (a: any, b: any): boolean => {
      if (a.highlight && b.highlight) {
        for (const k of Object.keys(a.highlight)) {
          if (sameLocatedRange(a.highlight[k], b.highlight[k])) return true;
        }
      }
      return (!!a.rewritten && a.rewritten === b.rewritten)
        || a.text === b.text
        || (!!a.dbClaimText && a.dbClaimText === b.dbClaimText);
    };
    const isActive = (c: any): boolean =>
      (c.note != null && c.confidence !== undefined) || !!c.refreshing || !!c.isClassifying || !!c.dbClaimId;
    const mergeList = (incs: any[] | null | undefined, prevs: any[] | null | undefined) => {
      if (!incs) return incs ?? null;
      if (!prevs || prevs.length === 0) return incs;
      return incs.map((inc: any) => {
        const prev = prevs.find((p: any) => claimsMatch(p, inc));
        if (!prev) return inc;
        const mergedHl = { ...(inc.highlight ?? {}), ...(prev.highlight ?? {}) };
        const mergedAnn = unionAnnotations(prev.annotations, inc.annotations);
        if (isActive(prev)) return { ...prev, highlight: mergedHl, annotations: mergedAnn };
        return { ...inc, highlight: mergedHl, annotations: mergedAnn, dbClaimId: prev.dbClaimId ?? inc.dbClaimId };
      });
    };
    // The worker drops an overlapping claim before persisting it, but the streamed
    // snapshot is built from the model's own output and can still carry one.
    const claims = mergeList(incoming.claims as any, (existing?.claims as any) ?? null);
    const quoting = incoming.quoting
      ? { ...incoming.quoting, claims: mergeList(incoming.quoting.claims as any, (existing?.quoting?.claims as any) ?? null) }
      : incoming.quoting;
    const deduped = claims ? withoutOverlappingClaims(claims) : claims;
    const dedupedQuoting = quoting?.claims ? { ...quoting, claims: withoutOverlappingClaims(quoting.claims) } : quoting;
    const anyOnHold = (deduped ?? []).some((c: any) => c.reclassifyOnHold)
      || (dedupedQuoting?.claims ?? []).some((c: any) => c.reclassifyOnHold);
    return { ...incoming, claims: deduped, quoting: dedupedQuoting, reclassifyOnHold: anyOnHold || undefined };
  }

  /** Post to a port, ignoring the throw that follows if the content script has since
   *  navigated away or been torn down. A dead port is normal, not an error. */
  function safePostToPort(port: any, msg: any) {
    try {
      port.postMessage(msg?.type === "CLASSIFICATION" && msg.data
        ? { ...msg, data: withRunningLocalization(msg.data) }
        : msg);
    } catch { /* port already closed */ }
  }

  /** Set any preclassified claims (verdict but no reasoning note) to "Researching..."
   *  state so the UI doesn't show a misleading badge while the classify pipeline runs. */
  function markClaimsResearching(classification: Classification): Classification {
    const mark = (claims: Classification["claims"]) =>
      claims?.map(cl =>
        !cl.note ? { ...cl, verdict: "research required" as const, confidence: undefined, veracity: undefined } : cl
      ) ?? null;
    return {
      ...classification,
      claims: mark(classification.claims),
      quoting: classification.quoting
        ? { ...classification.quoting, claims: mark(classification.quoting.claims) }
        : null
    };
  }

  /** Merge highlights additively by locale key for both main and quoted claims. */
  function mergeHighlightsFor(classification: Classification) {
    return (upd: Classification) => {
      upd.batchId = classification.batchId;
      const existing = classificationCache.get(classification.id);
      if (!existing) {
        const merged = { ...upd, localizingHighlights: false };
        cacheClassification(merged, classification.batchId);
        broadcastClassification(merged);
        // Localization persisted new highlight locales — the fetch
        // snapshot predates them.
        markTweetDbStale(classification.id);
        return;
      }

      // Two bodies matter here, and they are not always the same one. `runBody` is what the
      // paid run measured its ranges into; the reader may have flipped while it was in
      // flight, and `displayedSides` is the background's record of what the page shows now.
      // A range's identity is its body (the DB files it `<locale>:<hash>`), so a result
      // measured into words that are no longer on screen must not be attached to this
      // classification, must not re-point it at those words, and must not spend the hold
      // that belongs to the side the reader is looking at. Left to the plain spread below,
      // it did all three: a French localization that finished after a flip to English
      // re-pointed the classification at the French body and cleared the hold, and the
      // client cut the English words at French offsets with no Localize offered (reported
      // 2026-10-23).
      const runBody = upd.translatedText ?? '';
      const bodyChanged = !!upd.textLocale
        && !sameBodyRevision(runBody, existing.classification.translatedText ?? '');
      const shownBody = displayedSides.get(classification.id)?.text;
      // No record of the page's side means nothing contradicts the run: it measured what the
      // classification names.
      const runIsDisplayed = shownBody ? sameBodyRevision(runBody, shownBody) : !bodyChanged;
      // Both flags are about the shared key a guessed-locale host files every side under
      // (Telegram, Threads: `und`). When the classification was re-pointed at the side on
      // screen, the dict it holds under that key is the body just left and the run's ranges
      // are the displayed body's. When the run measured a side the reader has left, the held
      // dict describes the screen and it is the run's ranges that are foreign.
      //
      // The union also handed back every claim this run did not match: the run's claim list
      // is the held one re-spread, so an unmatched claim still carried the range it had —
      // measured into the body the run's locale now names. Identical to the held copy's
      // range, it is that old measurement and not a new one (2026-10-23: a French
      // localization matched 5 of 10 claims; the other 5 painted mid-word over the French
      // text).
      const dropExistingLocale = bodyChanged && runIsDisplayed;
      const keepRunLocale = !bodyChanged || runIsDisplayed;
      const withoutLocale = (hl: Record<string, [number, number]> | undefined, drop: boolean) => {
        const out = { ...(hl ?? {}) };
        if (drop && upd.textLocale) delete out[upd.textLocale];
        return out;
      };
      const sameRange = (a?: [number, number], b?: [number, number]) =>
        !!a && !!b && a[0] === b[0] && a[1] === b[1];

      const mergeClaims = (existingClaims: Claim[] | null | undefined, updClaims: Claim[] | null | undefined): Claim[] | null => {
        if (!existingClaims || !updClaims) return existingClaims ?? null;
        return existingClaims.map((existingCl) => {
          const updCl = updClaims.find(
            ucl => (ucl.dbClaimText && ucl.dbClaimText === existingCl.dbClaimText) ||
                   ucl.text === existingCl.text ||
                   (ucl.rewritten && ucl.rewritten === existingCl.rewritten)
          );
          if (!updCl) {
            return dropExistingLocale && existingCl.highlight
              ? { ...existingCl, highlight: withoutLocale(existingCl.highlight, true) }
              : existingCl;
          }
          const updHl = !keepRunLocale
            ? withoutLocale(updCl.highlight, true)
            : dropExistingLocale && upd.textLocale
              && sameRange(updCl.highlight?.[upd.textLocale], existingCl.highlight?.[upd.textLocale])
              ? withoutLocale(updCl.highlight, true)
              : (updCl.highlight ?? {});
          const mergedHighlight = {
            ...withoutLocale(existingCl.highlight, dropExistingLocale),
            ...updHl
          };
          const updAnn = keepRunLocale ? updCl.annotations : dropAnnotationsForLocale(updCl.annotations, upd.textLocale!);
          const mergedAnnotations = unionAnnotations(existingCl.annotations, updAnn);
          const hlSize = Object.keys(mergedHighlight).length;
          const out = hlSize > 0 || (dropExistingLocale && existingCl.highlight)
            ? { ...existingCl, highlight: mergedHighlight }
            : existingCl;
          return mergedAnnotations ? { ...out, annotations: mergedAnnotations } : out;
        });
      };

      const merged = {
        ...existing.classification,
        ...upd,
        claims: mergeClaims(existing.classification.claims, upd.claims),
        quoting: existing.classification.quoting
          ? {
              ...existing.classification.quoting,
              ...upd.quoting,
              claims: mergeClaims(existing.classification.quoting.claims, upd.quoting?.claims)
            }
          : upd.quoting,
        localizingHighlights: false
      };
      // Annotations carry the same defect the highlights above now guard against:
      // corrections measured into the old words paint over the side this run measured, and
      // `cacheClassification` records them under the new body — which is what a later flip
      // restores. A side this run has none for is "not annotated here", and its own
      // revision comes back from the DB.
      if (dropExistingLocale) {
        const prune = (claims: Claim[] | null | undefined): Claim[] | null => claims?.map(cl =>
          cl.annotations ? { ...cl, annotations: dropAnnotationsForLocale(cl.annotations, upd.textLocale!) } : cl
        ) ?? null;
        merged.claims = prune(merged.claims);
        if (merged.quoting) merged.quoting = { ...merged.quoting, claims: prune(merged.quoting.claims) };
      }
      if (!runIsDisplayed && shownBody) {
        // The classification keeps describing the side the reader is on, and keeps that
        // side's hold: the run's result belongs to another body, and adopting it here was
        // what re-pointed the post and un-held its Localize.
        merged.textLocale = existing.classification.textLocale;
        merged.translatedLocale = existing.classification.translatedLocale;
        merged.translatedText = existing.classification.translatedText;
        merged.translateFactChecksOnHold = existing.classification.translateFactChecksOnHold;
        // Not lost, filed under its own identity: these ranges are `runBody`'s, and this is
        // the record a flip back to those words restores from without waiting for the DB
        // snapshot to catch up. Only what the run measured goes in — the caller adds the run's
        // ranges to the claim list it was handed and leaves every unmatched claim untouched,
        // so a range equal to the one the press started from is the held measurement
        // re-spread, not news about these words.
        const measuredOnly = (upd.claims ?? []).map((cl, i) => {
          const now = upd.textLocale ? cl.highlight?.[upd.textLocale] : undefined;
          const before = upd.textLocale ? classification.claims?.[i]?.highlight?.[upd.textLocale] : undefined;
          return now && !sameRange(now, before) ? cl : { ...cl, highlight: withoutLocale(cl.highlight, true) };
        });
        rememberSideClaims({
          ...merged,
          translatedText: runBody,
          textLocale: upd.textLocale,
          translatedLocale: upd.textLocale,
          claims: measuredOnly,
        });
      }
      cacheClassification(merged, classification.batchId);
      broadcastClassification(merged);
      // Localization persisted new highlight locales — the fetch
      // snapshot predates them.
      markTweetDbStale(classification.id);
    };
  }

  /** Create a merge callback for re-research updates that preserves rewritten
   *  text and accumulated highlights. */
  function mergeRefreshFor(classification: Classification) {
    return (upd: Classification) => {
      upd.batchId = classification.batchId;
      const existing = classificationCache.get(classification.id);
      if (existing && existing.classification.claims && upd.claims) {
        const mergedClaims = existing.classification.claims.map((existingCl) => {
          const updCl = upd.claims!.find(
            ucl => ucl.dbClaimText === existingCl.dbClaimText
          );
          if (!updCl || existingCl.text !== updCl.text) return existingCl;
          return {
            ...existingCl,
            note: updCl.note ?? existingCl.note,
            confidence: updCl.confidence ?? existingCl.confidence,
            veracity: updCl.veracity ?? existingCl.veracity,
            sources: updCl.sources ?? existingCl.sources,
            verdict: updCl.verdict ?? existingCl.verdict,
            annotations: unionAnnotations(existingCl.annotations, updCl.annotations),
          };
        });
        const merged = { ...upd, claims: mergedClaims };
        cacheClassification(merged, classification.batchId);
        broadcastClassification(merged);
        // Buffered research rewrote the rows — drop the pre-research fetch snapshot.
        markTweetDbStale(classification.id);
      } else {
        cacheClassification(upd, classification.batchId);
        broadcastClassification(upd);
        markTweetDbStale(classification.id);
      }
    };
  }

  /** Set translatedLocale, translatedText, and textLocale on a classification from
   *  the matching tweet if available. textLocale reflects the text currently shown
   *  (destination language for translated tweets, source language otherwise). */
  function attachTranslatedLocale(cls: Classification, tweet: MainTweet): Classification {
    const hasTranslation = !!tweet.translatedText && !!tweet.destinationLanguage;
    if (hasTranslation) {
      if (!cls.translatedLocale) cls.translatedLocale = tweet.destinationLanguage;
      if (!cls.translatedText) cls.translatedText = tweet.translatedText;
      if (!cls.textLocale) cls.textLocale = tweet.destinationLanguage;
    } else if (tweet.sourceLanguage) {
      if (!cls.translatedLocale) cls.translatedLocale = tweet.sourceLanguage;
      if (!cls.translatedText) cls.translatedText = tweet.text;
      if (!cls.textLocale) cls.textLocale = tweet.sourceLanguage;
    }
    return cls;
  }

  /** Pull a tweet + its linked claims directly from the DB, shaped like the old
   *  fetch-tweet worker result so the existing DB-hit/miss branching keeps working. */
  async function fetchDbTweet(hash: string): Promise<{ success: boolean; claims?: ClaimPayload[]; is_preclassifying?: boolean }> {
    const fetched = await fetchTweetAndTouchNetwork(hash);
    if (!fetched) return { success: false };
    return { success: true, claims: fetched.claims, is_preclassifying: fetched.isPreclassifying };
  }

  /** Merge one incoming claim payload (from the tweet subscription, a claim
   *  subscription, or a direct pull) into a cached tweet classification and broadcast.
   *  Matches an existing claim by dbClaimId, then by highlight range in the displayed
   *  locale, then by rewritten/text; replaces it in place (adopting the DB id and the
   *  possibly-different rewritten text) or appends it. This is inherently deduped:
   *  the same claim arriving twice (sub + pull) matches and replaces, never duplicates. */
  function mergeClaimPayload(tweetId: string, payload: ClaimPayload, locale: string) {
    // [ttft-ext] Every subscription payload for this tweet, whether or not it ends up
    // matching a local claim — distinguishes "no broadcast arrived" (nothing logged
    // before an awaitClaimDbRow timeout) from "arrived but didn't match" (logged here,
    // but no matching "UNMATCHED classified claim" error below means it DID match and
    // dbClaimId should have been signaled).
    const mergeCallNum = ++mergeClaimPayloadCallCounter;
    console.log(`[ttft-ext] mergeClaimPayload ${tweetId}: payload arrived #${mergeCallNum}, id=${payload.id ?? 'none'}, is_classifying=${payload.is_classifying}`);
    let entry = classificationCache.get(tweetId);
    if (!entry) {
      // A payload arrived before the initial classification was cached — seed one.
      const tweet = tweetCache.get(tweetId);
      const seed: Classification = { id: tweetId, batchId: '', claims: [], quoting: null };
      if (tweet) attachTranslatedLocale(seed, withDisplayedSide(tweetId, tweet));
      cacheClassification(seed, seed.batchId);
      entry = classificationCache.get(tweetId);
      if (!entry) return;
    }
    const cls = entry.classification;
    const batchId = cls.batchId || (entry.batchIds.values().next().value ?? '');
    // The payload names the tweet only by claim row — find its cached tweet to name the
    // displayed body/bodies whose hashes gate the strip. A quoted tweet id is never a
    // top-level tweetCache key, so also search parents' quoting objects. Falls back to
    // the classification's own translatedText when the tweet cache missed entirely (MV3
    // restart between batch and broadcast): the classification carries the same
    // displayed body dbClaimsToClassification stored, so the revision still binds.
    const gate = (() => {
      // The reader's side, over the capture — the same record annotLocatorsFor reads. A
      // broadcast can land after a flip, and the capture still names the side the reader
      // left; gated off it, "displayed" is that side's body, the strip prefers its
      // annotation over the words now on screen, and the merge paints the other side's
      // corrections here.
      const direct = withDisplayedSide(tweetId, tweetCache.get(tweetId) ?? null);
      let g: RevisionGate | null = null;
      if (direct) {
        g = revisionGateFor(direct, direct.quoting);
      } else {
        for (const parent of tweetCache.values()) {
          if (parent.quoting?.id === tweetId) {
            g = revisionGateFor(parent.quoting, null);
            break;
          }
        }
      }
      if (!g) {
        if (cls.translatedText) {
          const hash = sha256HexSync(cls.translatedText);
          g = { displayed: hash, known: new Set([hash]), ...(cls.textLocale ? { displayedLocale: cls.textLocale } : {}) };
        } else {
          g = { displayed: null, known: new Set() };
        }
      }
      if (cls.translatedText) g.known.add(sha256HexSync(cls.translatedText));
      if (direct?.text) g.known.add(sha256HexSync(direct.text));
      if (direct?.translatedText) g.known.add(sha256HexSync(direct.translatedText));
      return g;
    })();
    const incoming = payloadToClaim(payload, locale, gate);
    // A selection's DB row carrying the worker's "not located in the input" sentinel (or a
    // range outside the passage) describes text the user never selected: the claim pipeline
    // only ever reaches it by having mined the surrounding context. Ignore it here, before
    // it can be adopted by a local claim — adopting it is how a sentinel range used to
    // overwrite a real claim's text with an unrelated claim's.
    if (unlocatedSelectionClaim(tweetId, incoming, false)) {
      console.log(`[background] selection ${tweetId}: ignoring claim row ${payload.id ?? 'none'} — not located in the passage`);
      return;
    }
    const displayedLocale = cls.textLocale;
    const incomingRange = displayedLocale ? incoming.highlight?.[displayedLocale] : undefined;

    const claims = cls.claims ? [...cls.claims] : [];
    let idx = -1;
    if (payload.id) idx = claims.findIndex(c => c.dbClaimId === payload.id);
    if (idx < 0 && incomingRange && displayedLocale) {
      idx = claims.findIndex(claim => sameLocatedRange(claim.highlight?.[displayedLocale], incomingRange));
    }
    // Match by highlight range under ANY shared locale key — not just displayedLocale.
    // A [start,end] span in a given locale's text uniquely identifies one claim, so an
    // equal range under the same key is the same claim. This is what lets a DB-delivered
    // claim (from the subscription) recognize the agent-produced local claim even when
    // textLocale is unset and the rewritten text drifted (worker stores normalizeText'd
    // rewritten). Without it the DB copy is appended as a duplicate → fallback box.
    // "A span uniquely identifies one claim" holds only for a REAL span: `[-1,-1]` is the
    // worker's could-not-locate sentinel and every unlocated claim shares it, so it is
    // excluded here (sameLocatedRange) or the payloads of two unrelated unlocated claims
    // collapse onto one local claim.
    if (idx < 0 && incoming.highlight) {
      const incKeys = Object.keys(incoming.highlight);
      idx = claims.findIndex(c => {
        if (!c.highlight) return false;
        for (const k of incKeys) {
          if (sameLocatedRange(incoming.highlight![k], c.highlight![k])) return true;
        }
        return false;
      });
    }
    // Fallback: match by raw highlight ranges directly from payload.highlight
    // (in case revision gate filtering in selectHighlightRevision dropped incoming.highlight).
    if (idx < 0 && payload.highlight && typeof payload.highlight === 'object') {
      const rawPayloadRanges: [number, number][] = [];
      for (const val of Object.values(payload.highlight)) {
        if (isLocatedRange(val)) rawPayloadRanges.push(val as [number, number]);
      }
      if (rawPayloadRanges.length > 0) {
        idx = claims.findIndex(c => {
          if (!c.highlight) return false;
          for (const range of Object.values(c.highlight)) {
            if (rawPayloadRanges.some(r => sameLocatedRange(r, range))) return true;
          }
          return false;
        });
      }
    }
    if (idx < 0) {
      const normIncRewritten = incoming.rewritten ? normalizeText(incoming.rewritten) : '';
      const normIncText = incoming.text ? normalizeText(incoming.text) : '';
      const normIncDb = incoming.dbClaimText ? normalizeText(incoming.dbClaimText) : '';
      idx = claims.findIndex(c => {
        const normCRewritten = c.rewritten ? normalizeText(c.rewritten) : '';
        const normCText = c.text ? normalizeText(c.text) : '';
        const normCDb = c.dbClaimText ? normalizeText(c.dbClaimText) : '';
        return (!!normCRewritten && (normCRewritten === normIncRewritten || normCRewritten === normIncText || normCRewritten === normIncDb)) ||
          (!!normCText && (normCText === normIncText || normCText === normIncRewritten || normCText === normIncDb)) ||
          (!!normCDb && (normCDb === normIncDb || normCDb === normIncRewritten));
      });
    }
    // Single-claim heuristic: if there is only one claim lacking dbClaimId, correlate it directly.
    if (idx < 0 && claims.length === 1 && !claims[0].dbClaimId) {
      idx = 0;
    }

    // The worker's post-research annotation run ENDED without persisting: it skipped
    // (stale / unclassified / no context / over the input ceiling / infra), so no locale
    // key is coming for this claim and the "Annotating" badge would otherwise spin out
    // its whole seed window (see stampAnnotateInFlight — the same run, same writer).
    // Settle it here, at the point the run's outcome is actually known, by reusing the
    // failure channel: the badge returns to the idle Annotate affordance, which is the
    // truthful state (nothing was annotated). Never paint {} for this — that asserts
    // "annotated, clean" (see empty-annotation-key), which a skip does not.
    //
    // The key's claim text has to be the LOCAL claim's, which is the one the span carries
    // (`${dataset.mfCid}:${dataset.claimText}`). The payload's is the DB row's claim, a
    // different string whenever the worker normalized or rewrote it — and always a
    // different one for a preclassification, whose claim text is a verbatim slice of the
    // body. Keyed by the payload's, nothing matched and the wheel only went when some
    // later pass happened to reconcile that badge.
    if (payload.annotation_run_settled && incoming && !Object.keys(incoming.annotations ?? {}).length) {
      const settleText = claims[idx]?.text ?? incoming.text;
      console.log(`[background] annotation run settled with no key for "${settleText.slice(0, 40)}..." — clearing the flight`);
      for (const port of activePorts) {
        try { port.postMessage({ type: 'ANNOTATE_FAILED', data: { classificationId: tweetId, claimText: settleText } }); } catch {}
      }
    }

    if (idx >= 0) {
      const prev = claims[idx];
      const mergedHl = { ...(prev.highlight ?? {}), ...(incoming.highlight ?? {}) };
      // Annotations merge the same way: the incoming payload wins per locale key, but a
      // payload stripped under a narrower gate must never clobber keys it doesn't carry.
      // On the placeholder branch below this matters most — placeholders carry no verdict
      // but CAN carry annotations (a fresh link row has its annotation key already), and
      // ...prev alone would drop them.
      const mergedAnn = unionAnnotations(prev.annotations, incoming.annotations);
      const prevHasVerdict = prev.note != null && prev.confidence !== undefined && !prev.reclassifyOnHold && !prev.refreshing;
      const incomingPlaceholder = incoming.reclassifyOnHold === true && incoming.confidence === undefined && !incoming.isClassifying;

      if (incoming.isClassifying) {
        // Being (re)classified elsewhere → spinner. Keep prior values when the payload
        // has none yet; adopt the DB id + canonical/rewritten text either way.
        claims[idx] = {
          ...prev,
          dbClaimId: incoming.dbClaimId ?? prev.dbClaimId,
          dbClaimText: incoming.dbClaimText ?? prev.dbClaimText,
          dbClaimLocale: incoming.dbClaimLocale ?? prev.dbClaimLocale,
          rewritten: incoming.rewritten ?? prev.rewritten,
          claimLocale: incoming.claimLocale ?? prev.claimLocale,
          reasoningLocale: incoming.reasoningLocale ?? prev.reasoningLocale,
          highlight: mergedHl,
          annotations: mergedAnn,
          // Link-scoped: stated by link payloads, absent from claim-scoped ones — absent
          // means "no opinion", so it must never clear the link's existing flag.
          isHidden: incoming.isHidden ?? prev.isHidden,
          refreshing: true,
          isClassifying: true,
          reclassifyOnHold: false,
          note: incoming.note ?? prev.note,
          verdict: incoming.note != null ? incoming.verdict : prev.verdict,
          confidence: incoming.confidence ?? prev.confidence,
          veracity: incoming.veracity ?? prev.veracity,
          sources: (incoming.sources && incoming.sources.length) ? incoming.sources : prev.sources,
        };
      } else if (incomingPlaceholder && (prevHasVerdict || prev.refreshing || prev.isClassifying)) {
        // A freshly-inserted placeholder row arriving for a claim that is already ACTIVE
        // — it shows a (preclassify/DB) verdict, or is mid-refresh, or is being classified.
        // Never let the placeholder downgrade it back to the Fact-Check button (the CLOBBER
        // that left the button stuck after research). Keep prev's state (verdict/refreshing/
        // reclassifyOnHold untouched via ...prev); only adopt the DB id + canonical/rewritten
        // text so the row can be located later.
        claims[idx] = {
          ...prev,
          dbClaimId: incoming.dbClaimId ?? prev.dbClaimId,
          dbClaimText: incoming.dbClaimText ?? prev.dbClaimText,
          dbClaimLocale: incoming.dbClaimLocale ?? prev.dbClaimLocale,
          rewritten: incoming.rewritten ?? prev.rewritten,
          claimLocale: incoming.claimLocale ?? prev.claimLocale,
          reasoningLocale: incoming.reasoningLocale ?? prev.reasoningLocale,
          highlight: mergedHl,
          annotations: mergedAnn,
          isHidden: incoming.isHidden ?? prev.isHidden,
        };
      } else {
        // Diagnostic (error for visibility): a payload with NO verdict (unclassified
        // placeholder) is about to overwrite a claim that was mid-refresh or already
        // carried a verdict. This is the suspected clobber — e.g. pullClaimBeforeClassify
        // pulling the still-placeholder DB row (because the worker couldn't locate/save
        // it → "Claim not found") and resetting a claim whose research just returned.
        const incomingNoVerdict = incoming.note == null
          && (incoming.confidence === undefined || incoming.confidence === null)
          && !incoming.isClassifying;
        const prevWasActive = prev.refreshing === true
          || (prev.confidence !== undefined && prev.confidence !== null && prev.note != null);
        if (incomingNoVerdict && prevWasActive) {
          console.error(
            `[mergeClaimPayload] CLOBBER: unclassified placeholder overwriting an active claim on tweet ${tweetId} ` +
            `(button will persist despite research). claimText="${(prev.text ?? '').slice(0, 50)}" ` +
            `prev{refreshing=${!!prev.refreshing}, reclassifyOnHold=${!!prev.reclassifyOnHold}, confidence=${prev.confidence ?? 'none'}, ` +
            `note=${prev.note != null ? 'set' : 'null'}} incoming{id=${incoming.dbClaimId ?? 'none'}, ` +
            `reclassifyOnHold=${!!incoming.reclassifyOnHold}, confidence=${incoming.confidence ?? 'none'}, note=${incoming.note != null ? 'set' : 'null'}}`
          );
        }
        // Authoritative DB claim (classified — incl. a replaced rewritten text when the
        // claim was matched to an existing DB row), or a placeholder with no prior
        // verdict (→ Fact-Check button). Adopt it wholesale, keeping other-locale ranges.
        //
        // `text` is DELIBERATELY preserved. It is this claim's stable identity — the whole
        // codebase keys on it (dataset.claimText, the lookups in refreshClaim /
        // admitFactCheckClaim / enqueueFactCheckClaim / pullClaimBeforeClassify,
        // researchCache, the factCheckWaitlist and ongoingClaimRefreshes keys, and the
        // claimDbRowSignal/awaitClaimDbRow pair below) — and it doubles as the verbatim
        // anchor breakupTweetText's findExactMatch needs to locate the claim in the tweet.
        // `rewritten` is the mutable one by design: translateClaim streams partial strings
        // into it and explicitly re-pins `text: cl.text` to document that contract.
        //
        // Overwriting `text` here with the canonical DB wording broke BOTH roles at once,
        // and it only happens on this branch — the two branches above already keep prev's
        // text. Three concrete symptoms, all from that one line:
        //   1. refreshClaim's `find(c => c.text === claimText)` missed, so it fell through
        //      to researching the RAW SPAN with no claim id. classify-tweets then couldn't
        //      match any row and INSERTed a duplicate claim with NO EMBEDDING — invisible to
        //      semantic dedup forever after.
        //   2. admitFactCheckClaim's identical lookup missed and silently DROPPED the claim
        //      from the batch, so it was never classified at all.
        //   3. findExactMatch could no longer locate the claim (the canonical wording isn't
        //      in the tweet), so highlighting degraded to a ~73% fuzzy guess — a
        //      plausible-looking highlight in slightly the wrong place — or fell back to the
        //      fallback box.
        // Nothing is lost by keeping it: the canonical wording still arrives on `rewritten`
        // (what renderClaims displays) and on `dbClaimText` (what DB matching uses), and
        // `dbClaimId` from ...incoming means later merges match by id before text anyway.
        // A VERDICT-LESS payload (an annotation or link write on the row) must not un-park a
        // claim a live request is waiting on. `reclassifyOnHold` is what makes the researching
        // mask (`isRequestedClaim`) and the waitlist entry apply at all, so adopting the
        // payload's `false` strands the plain Fact-Check button on a claim that is about to be
        // researched — and no later pass can restore it, because the mask keys on that flag.
        // A payload that DELIVERS a verdict is untouched: that is the settle.
        const scopedNow = factCheckAllScopedTexts.get(tweetId);
        const stillWanted = prev.reclassifyOnHold === true
          && factCheckAllTweetIds.has(tweetId)
          && (!scopedNow || scopedNow.has(prev.text))
          && !abandonedFactCheckKeys.has(`${tweetId}:${prev.text}`)
          && incoming.note == null
          && (incoming.confidence === undefined || incoming.confidence === null)
          && !incoming.isClassifying;
        claims[idx] = { ...incoming, text: prev.text, highlight: mergedHl, annotations: mergedAnn, isHidden: incoming.isHidden ?? prev.isHidden,
          ...(stillWanted ? { reclassifyOnHold: true } : {}) };
      }
      // The claim now carries (or already carried) its DB id → the embedded row exists.
      // Release any research launch parked in awaitClaimDbRow for this claim.
      if (incoming.dbClaimId) claimDbRowSignal(tweetId, prev.text);
    } else {
      // Diagnostic (logged as error for visibility): an incoming claim that carries a
      // real verdict arrived over the subscription but matched NO local claim by id,
      // highlight-range, or rewritten/text — so its verdict can't replace the local
      // Fact-Check button and it's appended as a stray instead. This is the seam where
      // a DB-matched claim silently keeps requiring a click. If this NEVER fires while
      // the bug is observed, the claim isn't arriving at all (subscribe-side seam).
      const incomingClassified = incoming.confidence !== undefined && incoming.confidence !== null
        && incoming.note != null && !incoming.isClassifying && !incoming.reclassifyOnHold;
      if (incomingClassified) {
        const fmtRange = (r?: [number, number]) => (r ? `${r[0]}-${r[1]}` : 'none');
        const hlKeys = (c: { highlight?: Record<string, [number, number]> }) =>
          c.highlight ? Object.keys(c.highlight).join(',') : 'none';
        console.error(
          `[mergeClaimPayload] UNMATCHED classified claim for tweet ${tweetId} — arrived over subscription ` +
          `but matched no local claim, so its verdict cannot replace the Fact-Check button. ` +
          `displayedLocale=${displayedLocale ?? 'none'} | incoming{id=${incoming.dbClaimId ?? 'none'}, ` +
          `hlKeys=${hlKeys(incoming)}, rangeInDisplayedLocale=${fmtRange(incomingRange)}, ` +
          `rewritten="${(incoming.rewritten ?? '').slice(0, 50)}", dbClaimText="${(incoming.dbClaimText ?? '').slice(0, 50)}", ` +
          `text="${(incoming.text ?? '').slice(0, 50)}"} | local claims=[` +
          claims.map(c => `{hlKeys=${hlKeys(c)}, rangeInDisplayedLocale=${fmtRange(displayedLocale ? c.highlight?.[displayedLocale] : undefined)}, ` +
            `rewritten="${(c.rewritten ?? '').slice(0, 40)}", text="${(c.text ?? '').slice(0, 40)}", ` +
            `dbClaimText="${(c.dbClaimText ?? '').slice(0, 40)}", onHold=${!!c.reclassifyOnHold}}`).join(', ') + `]`
        );
      }
      if (claims.some(c => spansOverlap(c.highlight, incoming.highlight))) {
        console.log(`[background] claim row ${incoming.dbClaimId ?? 'none'} ("${(incoming.rewritten ?? incoming.text).slice(0, 40)}...") overlaps a claim already on this post — not appending it`);
      } else {
        claims.push(incoming);
      }
    }

    // A claim payload arrived, so this tweet is no longer merely "waiting for a
    // preclassification to produce claims" — clear the spinner flag. runPreclassification
    // already does exactly this (`merged.preclassifying = undefined`) for its own streamed
    // results; this covers the DB-broadcast path, which is the only way claims arrive for a
    // tweet we found mid-preclassification.
    const merged: Classification = { ...cls, claims, onHold: false, preclassifying: undefined };
    merged.batchId = batchId;
    cacheClassification(merged, batchId);
    broadcastClassification(merged);
    // A finished classification rewrote this tweet's claim rows AFTER the fetchForTweet
    // snapshot was taken. Forget it so the next page load re-pulls instead of re-serving
    // the pre-research rows (old verdict, pre-localization highlights). Placeholders and
    // in-flight spinners carry no verdict, so they never trip this.
    const deliveredVerdict = incoming.confidence !== undefined && incoming.confidence !== null
      && incoming.note != null && !incoming.isClassifying && !incoming.reclassifyOnHold;
    if (deliveredVerdict) markTweetDbStale(tweetId);

    if (payload.is_classifying && payload.id) {
      watchClassifyingClaim(tweetId, payload.id, locale);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Realtime subscriptions. Research happens server-side, so results stream back over
  // Supabase Realtime rather than being returned from a call. Every subscription here
  // is opened BEFORE the corresponding fetch, so a result that lands between the two
  // isn't lost; each is deduped by key and torn down on a DB DELETE or a timeout.
  // ─────────────────────────────────────────────────────────────────────────

  /** Open a per-claim subscription (deduped) and resolve only once it is live
   *  (channel SUBSCRIBED + `subscribe` RPC sent). Callers await this, then fetch — so
   *  no broadcast is missed in the gap between fetching and the subscription activating. */
  async function ensureClaimSubscription(tweetId: string, claimId: string, locale: string): Promise<void> {
    const key = `${tweetId}:${claimId}`;
    const existing = claimSubs.get(key);
    if (existing && !existing.isClosed()) { await existing.ready; return; }
    let handleRef: SubscriptionHandle | null = null;
    const handle = await subscribeRow({
      kind: 'claim', claimId, timeoutMs: CLASSIFY_TIMEOUT_MS,
      onClaim: (payload) => mergeClaimPayload(tweetId, payload, locale),
      onDone: () => { if (claimSubs.get(key) === handleRef) claimSubs.delete(key); },
    });
    handleRef = handle;
    if (handle) { claimSubs.set(key, handle); await handle.ready; }
  }

  /** When a delivered claim is being (re)classified by someone else, subscribe to it
   *  (channel → subscribe → then pull) so the fresh classification auto-replaces the
   *  spinner; the pull covers the race where it finishes before we subscribe. */
  function watchClassifyingClaim(tweetId: string, claimId: string, locale: string) {
    const key = `${tweetId}:${claimId}`;
    if (claimSubs.has(key)) return;
    (async () => {
      await ensureClaimSubscription(tweetId, claimId, locale);
      const pulled = await getFullClaim({ id: claimId, locale });
      if (pulled && !pulled.is_classifying) mergeClaimPayload(tweetId, pulled, locale);
    })().catch(e => console.error('[watchClassifyingClaim] error:', e));
  }

  /** Open (or refresh) a tweet subscription and resolve once it is live (channel →
   *  subscribe RPC). Callers await this, then fetch. Resets the timer if already open. */
  async function ensureTweetSubscription(tweetId: string, hash: string, locale: string, timeoutMs: number = PRECLASS_TIMEOUT_MS): Promise<void> {
    const existing = tweetSubs.get(tweetId);
    if (existing && !existing.isClosed()) { existing.resetTimeout(timeoutMs); await existing.ready; return; }
    let handleRef: SubscriptionHandle | null = null;
    const handle = await subscribeRow({
      kind: 'tweet', hash, timeoutMs,
      onClaim: (payload) => {
        // A delivered claim proves the run is still producing, so the deadline (which
        // only exists to bound one that never speaks) must not cut the stream off.
        handleRef?.resetTimeout(timeoutMs);
        mergeClaimPayload(tweetId, payload, locale);
      },
      onDone: () => {
        // Only the handle that currently owns the tweet may clear its routing readiness:
        // a superseded (lingering) handle ending says nothing about whether the
        // replacement's routing row is alive.
        if (tweetSubs.get(tweetId) === handleRef) {
          tweetSubs.delete(tweetId);
          annotationRoutingReady.delete(tweetId);
        }
        const hooks = tweetSubscriptionEndHooks.get(tweetId);
        tweetSubscriptionEndHooks.delete(tweetId);
        for (const hook of hooks ?? []) {
          try { hook(); } catch (e) { console.error('[tweetSubscription] end hook error:', e); }
        }
      },
    });
    handleRef = handle;
    if (handle) { tweetSubs.set(tweetId, handle); await handle.ready; }
  }

  /** Fire-and-forget tweet subscription (for callers that don't need to await readiness). */
  function startTweetSubscription(tweetId: string, hash: string, locale: string, timeoutMs: number = PRECLASS_TIMEOUT_MS) {
    ensureTweetSubscription(tweetId, hash, locale, timeoutMs).catch(e => console.error('[startTweetSubscription] error:', e));
  }

  /** Read a DB-driven preclassifying tweet and, when the run finished with claims linked,
   *  inject them as the authoritative result.
   *
   *  Two callers, same operation: the subscription's end hook below (the run linked no
   *  claims it could deliver, or its routing row went away) and the read taken the moment
   *  the subscription goes live. The second one closes a real gap: `subscribe` always
   *  inserts a fresh routing row, even for a tweet whose preclassification ALREADY
   *  completed — the completed run deleted its own row and nothing will ever delete the
   *  replacement, so the wheel would wait out the whole PRECLASS_TIMEOUT_MS while the
   *  claims sit in the database unbroadcast. Anything other than "settled with claims"
   *  leaves the exit to the callers. The row comes back so the end hook can describe it
   *  without buying a second read. */
  async function injectSettledPreclassification(tweetId: string, hash: string, batchId: string, locale: string): Promise<{ injected: boolean; row: Awaited<ReturnType<typeof fetchDbTweet>> }> {
    const row = await fetchDbTweet(hash);
    const after = classificationCache.get(tweetId)?.classification;
    // Only the batch this was armed for: a forced re-run owns the state now and restates
    // it itself, so a read of the old row must not answer for the new run.
    if (!after?.preclassifying || after.batchId !== batchId) return { injected: false, row };
    if (!row?.success || row.is_preclassifying || !row.claims?.length) return { injected: false, row };
    const tweet = tweetCache.get(tweetId) ?? dbHitCache.get(tweetId)?.tweet;
    if (!tweet) return { injected: false, row };
    const { classification: settled } = dbClaimsToClassification(withDisplayedSide(tweetId, tweet), row.claims, batchId, locale);
    cacheClassification(settled, batchId);
    broadcastClassification(settled);
    console.log(`[preclassifying] ${tweetId}: row complete — injected ${row.claims.length} claim(s)`);
    return { injected: true, row };
  }

  /** Settle a DB-driven `preclassifying` classification (Step 3b) when its subscription
   *  ends. A delivered claim clears that flag, but a run that links no claims delivers
   *  nothing — its routing row is DELETEd when the run completes — so the subscription's
   *  own end is the only remaining exit path, and it must restate the state rather than
   *  leave the wheel standing. */
  function watchPreclassifyingEnd(tweetId: string, hash: string, batchId: string, locale: string) {
    let hooks = tweetSubscriptionEndHooks.get(tweetId);
    if (!hooks) { hooks = new Set(); tweetSubscriptionEndHooks.set(tweetId, hooks); }
    hooks.add(() => {
      void (async () => {
        const cur = classificationCache.get(tweetId)?.classification;
        if (!cur?.preclassifying || cur.batchId !== batchId) return;
        const { injected, row } = await injectSettledPreclassification(tweetId, hash, batchId, locale);
        if (injected) return;
        const after = classificationCache.get(tweetId)?.classification;
        if (!after?.preclassifying || after.batchId !== batchId) return;
        // Everything else — no claims linked, row unreadable, or the row still flagged
        // after this listener gave up — has no write left that could ever clear the
        // wheel, and a wheel with nothing behind it is the state being fixed here. The
        // claims already held stay: the bar keeps Hide and re-classify, which is the
        // one control that can settle a row a dead run left flagged.
        const settled: Classification = { ...after, preclassifying: undefined, ...(row?.success ? { claims: null, quoting: null } : {}) };
        cacheClassification(settled, batchId);
        broadcastClassification(settled);
        console.log(`[preclassifying] ${tweetId}: subscription ended (row ${row?.success ? (row.is_preclassifying ? 'still flagged' : `${row.claims?.length ?? 0} claim(s)`) : 'unreadable'}) — cleared the wheel`);
      })();
    });
  }

  /** Take the tweet's current handle out of `tweetSubs` without closing it, so the caller
   *  can subscribe on a fresh routing row while rows still in flight keep landing on the
   *  old one. The detached handle ends on its own timer. */
  function detachTweetSubscription(tweetId: string) {
    const existing = tweetSubs.get(tweetId);
    tweetSubs.delete(tweetId);
    if (!existing || existing.isClosed()) return;
    const set = lingeringTweetSubs.get(tweetId) ?? new Set<SubscriptionHandle>();
    for (const s of Array.from(set)) { if (s.isClosed()) set.delete(s); }
    set.add(existing);
    lingeringTweetSubs.set(tweetId, set);
  }

  function closeLingeringTweetSubs(tweetId: string) {
    const set = lingeringTweetSubs.get(tweetId);
    if (!set) return;
    lingeringTweetSubs.delete(tweetId);
    for (const s of set) { try { s.close(); } catch { /* ignore */ } }
  }

  /** Open the tweet subscription Flow A's annotation persist broadcasts to, so a
   *  reclassification's fresh annotations repaint inline with no reload.
   *
   *  Flow A runs server-side in ctx.waitUntil AFTER the research stream closes, so
   *  unlike the streamed verdict it has no open connection — its only path to the
   *  client is the tweet-scoped routing row trg_tweet_claim_annotations_updated writes
   *  to. Settled tweets open no subscription anywhere (fetchForTweet and
   *  pullClaimBeforeClassify only subscribe while preclassifying/classifying), so
   *  without this the persist finds no routing row and the new ranges sit in the DB
   *  until the next reload pulls them (fetch_tweet_and_touch_network).
   *
   *  Mirrors annotLocatorsFor's side resolution: a quoted-side claim annotates against
   *  the QUOTED tweet's row/hash, so its broadcast needs the quoted subscription
   *  (same quoting.id + quotedHash pair the preclassification path subscribes).
   *  Silent no-op when the tweet isn't cached — research then runs un-annotated,
   *  exactly as before. Call inside `if (!handled)`, just before refreshClaim.
   *
   *  `force` re-opens on a brand-new routing row even when a handle is already
   *  registered, for the callers that need a row created AFTER the preclassification
   *  teardown has already run (see settleFlowAAnnotations). */
  async function ensureAnnotationSubscription(classificationId: string, claimText: string, locale: string, force = false): Promise<void> {
    try {
      const cls = classificationCache.get(classificationId)?.classification;
      if (!cls) return;
      // Which side is this claim on — main list first, then quoted, the same order
      // annotLocatorsFor uses to derive the hash the worker persists against.
      let sideTweetId = classificationId;
      let tweet: any = tweetCache.get(classificationId) ?? dbHitCache.get(classificationId)?.tweet ?? null;
      if (!(cls.claims ?? []).some(c => c.text === claimText)) {
        const quoting = cls.quoting;
        if (!quoting || !(quoting.claims ?? []).some(c => c.text === claimText)) return;
        sideTweetId = quoting.id;
        tweet = tweetCache.get(classificationId)?.quoting ?? dbHitCache.get(classificationId)?.tweet?.quoting ?? null;
        if (!tweet) {
          for (const parent of tweetCache.values()) {
            if (parent.quoting?.id === sideTweetId) { tweet = parent.quoting; break; }
          }
        }
      }
      if (!tweet) return;
      const hash = await computeTweetHash(tweet);
      // Preclass complete deletes internal.broadcasts (not public.subscriptions),
      // so a client handle can still look live while the routing row is gone.
      // resetTimeout would then never recreate it, and Flow A's persist would
      // have nowhere to broadcast — "Annotating" forever. X avoids this because
      // a settled tweet has no handle, so the first call here inserts a fresh
      // row. Rotate that leftover ONCE, then keep the annotation-timeout handle:
      // closing it again (a second claim's research, a reclassify) LATE-drops
      // the in-flight annotation UPDATE for the claim that just finished.
      //
      // The old handle is DETACHED, not closed. While preclassification's claim
      // rows are still landing, its routing row is where they are written, and
      // only one handle per tweet fits in tweetSubs — closing it dropped every
      // row that arrived before the replacement row went live.
      if (force || !annotationRoutingReady.has(sideTweetId)) {
        if (force && annotationRoutingReady.has(sideTweetId)) {
          console.log(`[background] ensureAnnotationSubscription ${sideTweetId}: re-opening on a fresh routing row for Flow A`);
        }
        detachTweetSubscription(sideTweetId);
        annotationRoutingReady.delete(sideTweetId);
      }
      await ensureTweetSubscription(sideTweetId, hash, locale, ANNOTATION_TIMEOUT_MS);
      annotationRoutingReady.add(sideTweetId);
    } catch (e) {
      console.error('[ensureAnnotationSubscription] error:', e);
    }
  }

  /** Kick off is_classifying watchers for any pulled claim already being classified. */
  function watchClassifyingClaims(tweetId: string, claims: ClaimPayload[] | undefined, locale: string) {
    for (const claim of claims ?? []) {
      if (claim.is_classifying && claim.id) watchClassifyingClaim(tweetId, claim.id, locale);
    }
  }

  /** A pull found a link whose is_annotating marker is live: a run is streaming for this
   *  claim right now, and the claim has no key for the displayed revision yet.
   *
   *  Subscribe to the tweet so the run's persist has a routing row to broadcast to (a
   *  settled tweet has no open subscription anywhere), then read once more — the same
   *  subscribe-then-read order, and the same reason, as watchClassifyingClaim: the write
   *  can land between the pull that reported the marker and the subscription going live,
   *  and a broadcast with no routing row reaches nobody.
   *
   *  Main list only: mergeClaimPayload addresses cls.claims, so a quoted-side payload
   *  would be seeded as a separate classification rather than merged into the parent. */
  function watchInFlightAnnotation(tweetId: string, claimText: string, dbClaimId: string, hash: string, locale: string) {
    void (async () => {
      await ensureAnnotationSubscription(tweetId, claimText, locale);
      const row = await fetchDbTweet(hash);
      if (!row.success || !row.claims) return;
      const payload = row.claims.find(c => c.id === dbClaimId);
      if (!payload) return;
      const live = classificationCache.get(tweetId)?.classification?.claims?.find(c => c.text === claimText);
      // The key can land while the read is in flight, and the merge below would then be
      // redundant at best.
      if (!live || sideAnnotationKeys(live.annotations, locale).length > 0) return;
      // Nothing landed and nothing said so: the run is still streaming, and the
      // subscription just opened is what will deliver it.
      if (!payload.annotation_run_settled && sideAnnotationKeys(payload.annotations, locale).length === 0) return;
      console.log(`[background] annotation was already in flight for "${claimText.slice(0, 40)}..." — read back the stored one`);
      mergeClaimPayload(tweetId, payload, locale);
    })().catch(e => console.error('[watchInFlightAnnotation] error:', e));
  }

  /** Fact-Check a single claim: subscribe FIRST (so an in-flight classification by
   *  another user auto-replaces), then pull; only run classify-tweets if it isn't
   *  already classified or being classified. Returns true when the caller should NOT
   *  run its own classification (already handled here). */
  /** Signal that a claim's DB row has arrived (it now carries a `dbClaimId`), releasing
   *  any research launch waiting on `awaitClaimDbRow`. Idempotent; a no-op if none waits. */
  function claimDbRowSignal(tweetId: string, claimText: string) {
    const key = `${tweetId}:${claimText}`;
    const waiter = claimDbRowWaiters.get(key);
    if (waiter) { claimDbRowWaiters.delete(key); waiter.resolve(); }
  }

  /** Resolve once the claim's DB row has been broadcast (it gained a `dbClaimId`), or after
   *  `timeoutMs` as a fallback so a missing broadcast never hangs research. Returns
   *  immediately when the row is already known. Registration is synchronous with respect to
   *  `mergeClaimPayload` (both run on the single JS thread), so no broadcast can slip the gap
   *  between the initial check and the waiter being registered. */
  function awaitClaimDbRow(tweetId: string, claimText: string, timeoutMs: number): Promise<void> {
    const cls = classificationCache.get(tweetId)?.classification;
    const claim = cls?.claims?.find(c => c.text === claimText) ?? cls?.quoting?.claims?.find(c => c.text === claimText);
    if (claim?.dbClaimId) return Promise.resolve(); // Row already known — no wait.
    // [ttft-ext] This is the biggest hidden-latency candidate in the research path: if the
    // preclassify worker's DB insert (embed → match → link/insert) hasn't landed and
    // broadcast yet, everything downstream blocks here for up to `timeoutMs`.
    console.log(`[ttft-ext] awaitClaimDbRow ${tweetId}: dbClaimId not yet known, waiting up to ${timeoutMs}ms`);
    const tWaitStart = performance.now();
    const key = `${tweetId}:${claimText}`;
    let waiter = claimDbRowWaiters.get(key);
    if (!waiter) {
      let resolve!: () => void;
      const promise = new Promise<void>(r => { resolve = r; });
      waiter = { promise, resolve };
      claimDbRowWaiters.set(key, waiter);
    }
    return Promise.race([
      waiter.promise.then(() => {
        console.log(`[ttft-ext] awaitClaimDbRow ${tweetId}: row broadcast arrived, waited +${(performance.now() - tWaitStart).toFixed(0)}ms`);
      }),
      new Promise<void>(r => setTimeout(() => {
        claimDbRowWaiters.delete(key);
        console.log(`[ttft-ext] awaitClaimDbRow ${tweetId}: TIMED OUT after +${(performance.now() - tWaitStart).toFixed(0)}ms, proceeding anyway`);
        r();
      }, timeoutMs)),
    ]);
  }

  /** Register (or reuse) the waiter `claimDbRowSignal` releases once a claim's DB row has been
   *  broadcast, with no timeout of its own — the CALLER bounds the wait.
   *
   *  Separating the two is what lets a selection start a claim's wait the moment the claim
   *  arrives while still giving up on the drain-anchored clock: a row the worker broadcasts
   *  mid-stream releases the wait at once, and a claim that arrived early is not thereby given
   *  less time to be matched (see claimAfterRowLands). Resolves immediately when the row is
   *  already known. Registration is synchronous with respect to `mergeClaimPayload` (both run
   *  on the single JS thread), so no broadcast can slip the gap between the check and the
   *  waiter being registered. */
  function claimDbRowArrival(tweetId: string, claimText: string): Promise<void> {
    const cls = classificationCache.get(tweetId)?.classification;
    const claim = cls?.claims?.find(c => c.text === claimText) ?? cls?.quoting?.claims?.find(c => c.text === claimText);
    if (claim?.dbClaimId) return Promise.resolve(); // Row already known — no wait.
    const key = `${tweetId}:${claimText}`;
    let waiter = claimDbRowWaiters.get(key);
    if (!waiter) {
      let resolve!: () => void;
      const promise = new Promise<void>(r => { resolve = r; });
      waiter = { promise, resolve };
      claimDbRowWaiters.set(key, waiter);
    }
    return waiter.promise;
  }

  /** The preclassify stream has drained: the only thing left outstanding for its claims is
   *  fetch-claim's embed → match → link, which writes each claim's DB row or nothing at all.
   *  A research request still waiting on a row when the give-up window closes is released back
   *  to its own Fact-Check button — nothing was spent, and the user can press it again. A
   *  request whose row does arrive was already decided and its entry dropped, so this only
   *  ever touches claims the worker never answered. */
  function armRowPendingGiveUp(classificationId: string, batchId: string): void {
    setTimeout(() => {
      const claims = classificationCache.get(classificationId)?.classification.claims;
      if (!claims) return;
      for (const claim of claims) {
        if (claim.dbClaimId) continue;
        const key = `${classificationId}:${claim.text}`;
        if (!factCheckAllTweetIds.has(classificationId) && !researchRequestedBeforeRow.has(key)) continue;
        // A run under way on this claim owns its state; only an unanswered wait is ours.
        if (ongoingClaimRefreshes.has(key)) continue;
        researchRequestedBeforeRow.delete(key);
        abandonedFactCheckKeys.add(key);
        console.log(`[background] row give-up ${classificationId}: "${claim.text.slice(0, 40)}..." never got a DB row — back to its button`);
        revertClaimToOnHold(classificationId, claim.text, batchId);
      }
    }, SELECTION_DB_ROW_TIMEOUT_MS);
  }

  /** Resolve the claim's DB row (waiting for it if a preclassify insert is still in flight),
   *  subscribe to it, and report whether the caller can SKIP classifying because the DB
   *  already holds a usable result.
   *
   *  `force` is for an explicit user-initiated re-research: it still resolves the row id and
   *  subscribes (so the fresh result targets the right row and streams back), but never
   *  reports "already handled" and never merges the stored payload. Skipping work that's
   *  already paid for is right for the Disinfact / Fact-Check buttons, but the entire point
   *  of the refresh button is to REPLACE the stored result — short-circuiting there made it a
   *  no-op that re-injected the old reasoning and, because `handled` also suppresses the
   *  caller's revert, left the spinner running forever. */
  async function pullClaimBeforeClassify(classificationId: string, claimText: string, locale: string, force = false): Promise<boolean> {
    let cls = classificationCache.get(classificationId)?.classification;
    let claim = cls?.claims?.find(c => c.text === claimText) ?? cls?.quoting?.claims?.find(c => c.text === claimText);
    // A miss here means the paid run about to start has no claim to land on: it is billed,
    // finishes, and its verdict is dropped. The click's claimText must be the cached claim's
    // `text` byte for byte, so name the drift rather than pay for it silently.
    if (!claim && cls?.claims?.length) {
      console.warn(`[background] pullClaimBeforeClassify ${classificationId}: claimText matched no cached claim — clicked=${JSON.stringify(claimText)} cached=${JSON.stringify(cls.claims.map(c => c.text))}`);
    }
    // A preclassify-origin claim has no DB id until the worker finishes embedding + inserting
    // it and the row is broadcast over the tweet subscription. Classifying before then races
    // that insert: start_claim_classification can't locate the row, so the claim is (re)created
    // by the research save path WITHOUT an embedding. Wait (bounded) for the broadcast so the
    // embedded row exists first, then re-read the claim to pick up its now-known id.
    if (!claim?.dbClaimId) {
      await awaitClaimDbRow(classificationId, claimText, CLAIM_DB_ROW_TIMEOUT_MS);
      cls = classificationCache.get(classificationId)?.classification;
      claim = cls?.claims?.find(c => c.text === claimText) ?? cls?.quoting?.claims?.find(c => c.text === claimText);
    }
    const claimId = claim?.dbClaimId;
    // We already know this claim's DB state from the tweet pull / broadcast that delivered
    // it. Only when it is being classified ELSEWHERE (isClassifying) do we need to watch the
    // DB for that result — otherwise we classify it ourselves and the answer streams straight
    // back from classify-tweets, making the subscribe + pull below pure cost (3 billed
    // fetches per claim) for information we already hold. Every claim the user can actually
    // click is `reclassifyOnHold` (empty reasoning, or reclassify_after elapsed), and the
    // pull below returned `false` for both of those anyway — so this skips no work, it only
    // skips paying to re-confirm it.
    if (!claim?.isClassifying) return false;
    // Subscribe first, then pull (the pull covers the race where it finished first).
    if (claimId) await ensureClaimSubscription(classificationId, claimId, locale);
    // Explicit refresh: reclassify unconditionally. Returning before the pull also avoids
    // merging the stored claim back in, which would flash the old reasoning straight back
    // over the spinner the user just triggered.
    if (force) return false;
    const pulled = claimId
      ? await getFullClaim({ id: claimId, locale })
      : await getFullClaim({ text: claim?.rewritten ?? claim?.dbClaimText ?? claimText, locale });
    if (!pulled) return false; // Not in DB (fresh claim) → caller classifies.
    mergeClaimPayload(classificationId, pulled, locale);
    // Already classified, or being classified elsewhere → nothing more for the caller.
    if (pulled.is_classifying) return true;
    // Change-prone (reclassify_after passed): the DB row still carries its OLD reasoning
    // until fresh research overwrites it, so `!isReasoningEmpty` alone can't tell "already
    // classified" apart from "stale, must reclassify despite having old text" — without this
    // check, every reclassify-on-hold claim silently short-circuits here and never actually
    // gets re-researched (the on-hold flip momentarily shows, then just settles back onto
    // the stale cached values, matching dbClaimsToClassification's own reclassify handling).
    if (pulled.reclassify) return false;
    if (!isReasoningEmpty(pulled.reasoning)) return true;
    return false; // Unclassified placeholder → caller runs classify-tweets.
  }

  // ─────────────────────────────────────────────────────────────────────────
  // The pipeline itself: preclassification (finding claims in a tweet) and the
  // per-batch flow that decides, for each captured tweet, whether it can be served
  // from the DB or needs paid work.
  // ─────────────────────────────────────────────────────────────────────────

  /** Run the preclassify worker for one tweet, streaming its claims into the UI and letting
   *  the worker persist the tweet + claims itself. Shared by the two paid entry points:
   *
   *  - PROCESS_ON_HOLD (the Disinfact button) passes `force = false`.
   *  - BATCH_REFRESH_FORCE (the "Re-reveal this post's claims" button) passes `force = true`.
   *
   *  Neither re-checks the DB first any more (that cost a billed fetch on every click to
   *  cover a rare race); `force` now only controls whether the top-of-tweet spinner is shown,
   *  since a forced run has no on-hold button to turn into one.
   *
   *  A no-claims outcome broadcasts the tweet with `onHold` cleared and its `batchId` set, so
   *  the bar settles into the refresh affordance rather than returning to a Disinfact pill —
   *  refresh re-enters this function, which is the retry. The entry is left in `onHoldTweets`
   *  either way, so a tap that arrives late is still honored. */
  function runPreclassification(
    entry: { tweet: MainTweet; hash: string },
    locale: string,
    logTag: string,
    force: boolean,
    /** Which side of a translation the user is looking at, read off X's toggle row by the
     *  content script. `null`/omitted means unknown — a caller that cannot observe the DOM
     *  passes nothing and keeps the original inference exactly. */
    displayedSide?: 'TRANSLATED' | 'ORIGINAL' | null,
    /** The text the page is actually rendering, sent only when `displayedSide` is
     *  'TRANSLATED'. Used as a last resort when the captured payload has no
     *  `translatedText`. */
    displayedText?: string | null,
    /** The language that text is in, read off the page by the content script. Used only
     *  when the payload names no destination language — see `destinationLocale` below. */
    displayedLocaleHint?: string | null,
    /** Which text a dual post's button group stands over, named by the group itself. A
     *  `'translation'` group is seated in the appended translation, so the words it hands
     *  over are that copy's live rendering. */
    namedSide?: 'alt' | 'translation' | null,
    /** The run answers a passage's gesture rather than a click on the post: the reader
     *  asked for the claims under their selection, so the one-claim hand-off below (which
     *  would research a claim anywhere on the post) does not apply. */
    fromSelection: boolean = false
  ): void {
    const { tweet, hash } = entry;
    const tweetId = tweet.id;
    const keepAlive = setInterval(() => {}, 20000);

    // Whether the user is demonstrably reading the ORIGINAL text. Only a positive
    // 'ORIGINAL' changes anything: the presence of a translation in the payload says a
    // translation is AVAILABLE, never that it is DISPLAYED, so inferring from it alone sent
    // the translated body to the worker and keyed the resulting highlight ranges under the
    // destination language while the user was reading the original — ranges that then
    // address the wrong text and cannot be rendered at all. When the side is unknown the
    // expressions below reduce to exactly what they computed before.
    // `sourceLanguage` is required, not incidental: it is the key the ranges get stored
    // under. X's lazily-fetched translations sometimes arrive with destination_language but
    // no source_language, and without it `displayedLocale` would fall through to the UI
    // locale — which for a French-UI user reading an English original would file English
    // ranges under "fr" and recreate the exact bug this fixes. When we cannot name the
    // original's language we decline to correct and leave the old inference untouched.
    // The words the page is showing, when they are not the ones the capture holds. A host
    // that translates without the adapter being able to name the side (Facebook) leaves a
    // post captured before its translation landed holding the source, and the click then
    // classifies the hidden side: the ranges address words the reader is not looking at, the
    // side on screen has nothing and offers a paid Localize, and the run that was paid for
    // paints under a body the page is not showing. The reading is compared with the capture,
    // never trusted on its own — a clamp or an expansion of the same words changes nothing.
    // A side the page cannot NAME (LinkedIn's labels unlearned, its state stale, its words too
    // short to judge) arrives as a body and nothing else. The body is still the answer: it is
    // compared with the capture and, when it says other words, it is the side on screen. Read
    // as the source instead, the press classified the text behind the translation while the
    // reader read the translation, filed every range against the wrong body, and left the side
    // on screen with nothing (reported 2026-10-25).
    const otherBody = displayedText && tweet.text && !sameBodyRevision(displayedText, tweet.text)
      ? displayedText.trim() || undefined
      : undefined;
    const shownBody = displayedSide === 'ORIGINAL' || displayedSide == null ? otherBody : undefined;
    // The side is named structurally by the adapter, not inferred from a language field: an
    // adapter answers ORIGINAL only while the post shows its own words (Telegram says as much
    // in its own comment on `displayedTranslationLocale`), so a missing `sourceLanguage` means
    // the payload never carried it — Facebook states no language anywhere — not that the side
    // is unknown. Requiring the field left every Facebook post reading its source with no
    // locale named: `attachTranslatedLocale` then stamped the payload's translation onto claims
    // measured against the source, the client preferred that body, found none of the ranges in
    // it and refused every segment, and the flip detector (which needs a named body) never ran.
    const readingOriginal = displayedSide === 'ORIGINAL' && !shownBody;
    if (displayedSide === 'ORIGINAL' && !tweet.sourceLanguage) {
      console.log(`[background] ${logTag} ${tweetId}: ORIGINAL side with no sourceLanguage in the payload — naming its ranges under the UI locale (${locale})`);
    }

    // The translated body to preclassify. Prefer the captured payload; fall back to what X
    // is rendering when the toggle says the translation is displayed but the payload never
    // carried it. X fetches translations lazily, so a tweet can be captured (and put on
    // hold) before its translation exists — the entry then looks untranslated forever, and
    // the click preclassifies the ORIGINAL text and files the ranges under the ORIGINAL's
    // locale while the reader is looking at another language. Those ranges are internally
    // consistent, so nothing detects them as wrong; they simply never match the displayed
    // text, the render guard refuses them, and the user is billed for nothing.
    // The payload is still preferred because the DOM copy is `textContent`, which drops
    // emoji rendered as <img> and would shift every offset after one.
    // An unnamed side's body is only ever the one the capture does not hold (see `shownBody`),
    // so it is this run's other side and nothing else.
    const fallbackTranslation = displayedSide === 'TRANSLATED'
      ? (displayedText?.trim() || undefined)
      : (displayedSide == null ? shownBody : undefined);
    // A group seated over the translation names its side, and the live reading wins over
    // the captured payload. The capture holds the translation as it stood when the post was
    // announced; on Facebook that is the host's clamp, and upgradeCapture refuses every post
    // whose translation locale is set, so it stays the clamped fragment for the post's whole
    // life while the page shows the expanded body. Preferring the payload there classified
    // that fragment — a few sentences the reader can see went to the worker as a couple of
    // hundred characters and came back with no claims.
    const liveTranslation = namedSide === 'translation' ? (displayedText?.trim() || undefined) : undefined;
    const displayedTranslation = liveTranslation ?? tweet.translatedText ?? fallbackTranslation;

    // The language the displayed side is in. The captured payload names it for a post that
    // was already translated when it was announced, and for those the hint is ignored. It
    // names nothing for a post the reader translated afterwards — the capture holds only
    // the source — and there the content script's reading of the live page is the only
    // source of it. Without that second source `displayedLocale` falls through to
    // `sourceLanguage`, which files every range under a language the reader is not looking
    // at, against text whose offsets belong to the source.
    // An unnamed side that names no language either (LinkedIn's wrapper states the target, but
    // a page that will not name its side has no hint to give here) falls through to the
    // capture's own locale — `und` for a source not yet read — which is exactly the key the
    // annotate run and the painter already address that side by.
    const destinationLocale = tweet.destinationLanguage
      ?? (displayedSide === 'TRANSLATED' || (displayedSide == null && shownBody)
        ? (displayedLocaleHint ?? undefined)
        : undefined);

    // Build the display tweet (translated text when translated) — the worker
    // computes highlight ranges against its `text`. Only the root tweet can use the DOM
    // fallback: `displayedText` is the main tweet's element, not a quoted or parent post.
    function tweetForDisplay(t: MainTweet, isRoot = false): MainTweet {
      const body = isRoot ? (shownBody ?? displayedTranslation) : t.translatedText;
      const dest = isRoot ? destinationLocale : t.destinationLanguage;
      const hasTranslationInner = !!body && !!dest && !readingOriginal;
      return {
        ...t,
        text: (hasTranslationInner || (isRoot && !!shownBody)) ? body! : t.text,
        quoting: t.quoting ? tweetForDisplay(t.quoting as MainTweet) : null,
        replyingTo: t.replyingTo ? tweetForDisplay(t.replyingTo as MainTweet) : null,
      } as MainTweet;
    }
    const hasTranslation = !!displayedTranslation && !!destinationLocale && !readingOriginal;
    const displayedLocale = (hasTranslation ? destinationLocale : tweet.sourceLanguage) ?? UNKNOWN_LANGUAGE;
    const bodySource = shownBody ? 'shown body (side not stated)'
      : !hasTranslation ? 'original'
      : (liveTranslation ? 'translated (named side)' : (tweet.translatedText ? 'translated (payload)' : 'translated (DOM fallback)'));
    console.log(`[background] ${logTag} ${tweetId}: displayedSide=${displayedSide ?? 'unknown'} -> preclassifying ${bodySource} text, highlights keyed ${displayedLocale}`);

    gatedSpend(async () => {
      try {
        const batchId = nextBatchId();

        // Step 0: Broadcast the spinning state immediately so the content script
        // keeps or renders the top-of-tweet spinner right away for both forced
        // and standard preclassifications. Cleared by the first streamed result
        // below, or in `finally`.
        const cur = classificationCache.get(tweetId)?.classification;
        const spinning: Classification = { ...(cur ?? { id: tweetId, claims: null, quoting: null }), batchId, preclassifying: true };
        cacheClassification(spinning, batchId);
        broadcastClassification(spinning);

        // Subscribe BEFORE streaming starts (fire-and-forget, in parallel with the
        // worker): link_tweet_claim broadcasts only land on an existing routing row,
        // and the claim pipeline runs mid-stream — subscribing after the stream
        // drains (oldStep 3 below) loses the race whenever linking beats stream drain.
        // ensureTweetSubscription refreshes the timer if one is already open.
        startTweetSubscription(tweetId, hash, locale);

        // Step 1 (removed): this used to re-pull the tweet from the DB on every Disinfact
        // click, in case it had landed there between the button rendering and the click.
        // That cost a fetch on every single click to cover a rare race, so we now assume
        // nothing changed in that window and go straight to preclassifying. The tweet
        // subscription opened below still delivers whatever the DB ends up holding.

        // Step 2: run the preclassify worker. It streams claims with
        // highlight ranges (shown immediately, research-required ones as Fact-Check
        // buttons) and persists the tweet + claims itself.
        let latest: Classification | null = null;
        // Pass the hash as the same bytea literal (\x…) used by the fetch/subscribe
        // RPCs so the row the worker inserts matches what we later query.
        for await (const cls of preClassify(tweetForDisplay(tweet, true), hashToBytea(hash), displayedLocale, locale)) {
          // A streamed claim is proof the worker's row for this hash exists. The session's miss
          // cache is hash-keyed and shared by every surface that renders this post, so without
          // this the lookup that missed before the click keeps answering "no row" to the post's
          // OTHER views for the rest of the worker's life: Facebook's search card and its detail
          // view name the same post by different host ids, so no id-keyed cache or memo joins
          // them — only the hash does — and the detail view shows Disinfact over a preclassified
          // post. A failed run streams nothing and leaves the miss in place.
          dbMissHashes.delete(hash);
          cls.batchId = batchId;
          attachTranslatedLocale(cls, tweet);
          // ...except when this run read the ORIGINAL side of a post that has a translation.
          // attachTranslatedLocale infers from the payload alone, and all a payload says is
          // that a translation EXISTS: it stamps the destination locale and the translated
          // body onto claims the worker measured against the SOURCE. The client then prefers
          // that translated body, finds none of the claims' ranges in it — they are keyed to
          // the source's locale — and upgradeToSegments refuses the segments it builds, so
          // the click lands its claims and paints nothing, on every broadcast, for as long
          // as the reader stays on the original. The run knows the side it classified, so it
          // stamps it, exactly as SET_DISPLAYED_LOCALE does for this same flip.
          if (shownBody) {
            // The worker measured against the words on screen, so the classification names
            // THOSE — the client resolves ranges through these two fields, and the capture
            // still holds the side the page is not showing.
            cls.textLocale = displayedLocale;
            cls.translatedLocale = displayedLocale;
            cls.translatedText = shownBody;
          } else if (readingOriginal && tweet.text) {
            // `displayedLocale` is the key the ranges are filed under by the call above, so the
            // stamp names exactly that whatever its source: the payload's source language when
            // one is stated, the UI locale when none is.
            cls.textLocale = displayedLocale;
            cls.translatedLocale = displayedLocale;
            cls.translatedText = tweet.text;
          } else if (hasTranslation && displayedTranslation) {
            // The same stamp for the other side, and for the same reason: attachTranslatedLocale
            // infers from the captured payload alone, and a post captured BEFORE the reader
            // translated it holds only the source — it then names the source body and the
            // source's language on claims the worker measured against the translation. The
            // client prefers that body and that locale, builds segments over the source with
            // offsets that belong to the translation, and files them as the source side
            // (alignDualSideSegments), so the click paints the wrong body. This run knows what
            // it measured, so it names that.
            cls.textLocale = displayedLocale;
            cls.translatedLocale = displayedLocale;
            cls.translatedText = displayedTranslation;
          }
          // Merge (don't overwrite): a later cumulative snapshot must not reset a claim
          // that already got a verdict or is mid-research back to a Fact-Check spinner.
          const merged = mergePreclassIntoCache(cls);
          merged.batchId = batchId;
          // First streamed claims have landed — the top-of-tweet spinner has done its job.
          merged.preclassifying = undefined;
          cacheClassification(merged, batchId);
          broadcastClassification(merged);
          latest = merged;
        }

        // The stream is over; only the worker's row writes remain outstanding. A click made
        // from here on is decided by its claim's row (see armRowPendingGiveUp).
        armRowPendingGiveUp(tweetId, batchId);

        if (!latest || !latest.claims || latest.claims.length === 0) {
          // Preclassification produced no claims (or failed after retries). Broadcast
          // empty (clears the Fact-Check All button) and leave it retryable.
          const empty: Classification = latest ?? { id: tweetId, batchId, claims: null, quoting: null };
          empty.onHold = false;
          cacheClassification(empty, batchId);
          broadcastClassification(empty);
          onHoldTweets.set(tweetId, entry);
          clearInterval(keepAlive);
          // An empty result used to say nothing at all: the button simply went back to
          // "Disinfact" and the user was left to guess whether the click had registered.
          // `preclassifyFailed` is the failed retry loop's empty result, whose own error
          // was already reported — naming "no claims" over it would blame the wrong thing.
          if (!latest?.preclassifyFailed) notifyError(browser.i18n.getMessage('errNoClaims'));
          return;
        }

        // Every claim this run found is flagged (`isHidden`) — a claim the strict filtering
        // categories pulled out of the post's affordances. The run did find claims, but the
        // reader sees none of them: no highlight, no Reveal/Hide, no Localize, no Fact-Check
        // All, so the press ends with the button it started from and nothing else. That is
        // the same outcome an empty run names, stated over the claim list the bar can see
        // rather than the one the worker returned, so it says so the same way.
        if (latest.claims.every(cl => cl.isHidden === true)) {
          notifyError(browser.i18n.getMessage('errNoClaims'));
        }

        reResearchedTweetIds.add(tweetId);

        // The stream has drained, so the claim count is known — the first moment it is.
        //
        // A lone claim is handed to the automatic run below, and until that run's own
        // broadcast the claim still wears the on-hold button the worker's mid-stream row
        // gave it — the wait on its DB row, which is the gap the user sees as a button
        // that vanishes on its own. Mark the tweet and re-broadcast so it enters the
        // loading state now (see preclassifyRunTweets). Nothing else here needs to
        // re-broadcast: any other claim count leaves the buttons the user acts on exactly
        // as the drain left them.
        // A flagged claim (`isHidden`) is not a highlight of the post: the reader never sees
        // it, so it does not make a one-claim text plural, and a post whose only visible
        // claim is unflagged gets that claim researched without a second click.
        const soleClaims = [...(latest.claims ?? []), ...(latest.quoting?.claims ?? [])]
          .filter((cl) => cl.isHidden !== true);
        // A selection's run classifies the claims under the passage and nothing else: the
        // scoped hand-off (`maybeRunSelectionCheck`) is the whole of its request, so no
        // claim is researched on the post's behalf.
        if (!fromSelection && soleClaims.length === 1) {
          preclassifyRunTweets.add(tweetId);
          const settled = classificationCache.get(tweetId)?.classification;
          if (settled) broadcastClassification(settled);
        }

        // Step 3: refresh the Step-0 subscription timer so the routing row stays
        // alive for the worker's link broadcasts (already a no-op reset when open).
        startTweetSubscription(tweetId, hash, locale);

        // Step 4: a tweet that yields exactly one claim is researched without waiting
        // for a second click. Awaited so the keepAlive interval above spans the
        // research — otherwise the service worker could be reaped mid-call.
        //
        // `annotateIfSettled` only for the Disinfact click (force = false, the run whose
        // hash was NOT in the DB): when the worker links this claim to one the DB already
        // answers, there is no research left to do, but the claim can still be keyless for
        // the displayed text — and then the annotation is run for it too, because the user
        // asked us to handle this post and should not have to press Annotate as well. A
        // forced re-reveal (force = true) is a post the DB does hold and keeps its old
        // behaviour exactly. */
        if (!fromSelection && soleClaims.length === 1) {
          await autoClassifyClaim(tweetId, soleClaims[0], batchId, locale, { annotateIfSettled: !force });
        }
      } catch (err: any) {
        console.error(`[background] ${logTag} error:`, err);
      } finally {
        // The mark is dropped here whatever else happened: a hand-off that threw must not
        // leave the claim presenting as still-researching with nothing researching it.
        // (For any other claim count nothing was ever marked, so this is a no-op.)
        preclassifyRunTweets.delete(tweetId);
        clearInterval(keepAlive);
        // Safety net: never strand the top-of-tweet spinner if the run threw or returned
        // early without ever streaming a claim.
        const cur = classificationCache.get(tweetId)?.classification;
        if (cur?.preclassifying) {
          const cleared: Classification = { ...cur, preclassifying: undefined };
          cacheClassification(cleared, cur.batchId ?? '');
          broadcastClassification(cleared);
        }
      }
    });
  }

  /** Research a claim without waiting for the user to click Fact-Check. Called for a tweet's
   *  only claim, and for every claim of a webpage selection — the rule is the same however
   *  many claims there are, and one claim's run is not affected by another's.
   *
   *  Runs the same DB-first-then-research sequence a claim click runs: pullClaimBeforeClassify
   *  short-circuits on a row that is already settled, and anything else goes through
   *  refreshClaim. The claim is flipped to `refreshing` up front so the Fact-Check
   *  affordance can't be clicked a second time (and billed twice) while the automatic run
   *  is in flight; any failure reverts it to its on-hold button for a manual retry.
   *
   *  Safe to call for several of a tweet's claims at once — `ongoingClaimRefreshes` is keyed
   *  per claim, and the flip below maps the cache keeping every other claim as it was.
   *
   *  `annotateIfSettled` is for a post whose lone claim the DB already answers (a linked
   *  variant of a claim it holds, or one answered while the stream was still running): there
   *  is no research to run and nothing to spend, but the claim can still be keyless for the
   *  text on screen — which is showing the user an Annotate button they should not have to
   *  press. Only the tweet flow asks for it (see the lone-claim hand-off in
   *  runPreclassification); selections and Fact-Check All are untouched. */
  async function autoClassifyClaim(
    tweetId: string, claim: Claim, batchId: string, locale: string,
    opts?: { annotateIfSettled?: boolean }
  ): Promise<void> {
    const refreshKey = `${tweetId}:${claim.text}`;
    if (ongoingClaimRefreshes.has(refreshKey)) return;

    const hit = classificationCache.get(tweetId);
    if (!hit) return;

    // The DB row is the decision: a streamed claim is on hold before the worker has matched
    // it, so researching on that reading charges for a verdict the DB may already hold. The
    // caller is already past the drain, so wait for the row (bounded, with a direct pull as
    // the fallback) and decide on what it says. A row that never lands hands the streamed
    // claim back, and research then proceeds exactly as it always has.
    if (!claim.dbClaimId) {
      claim = await claimAfterRowLands(tweetId, claim, '', locale);
      // The wait spans the cache being torn down (sign-out / freeze).
      if (!classificationCache.get(tweetId)) return;
    }
    // Re-read after the wait: the row's own broadcast rewrote the cache, and the flip below
    // must not start from the snapshot taken before it.
    const live = classificationCache.get(tweetId)?.classification ?? hit.classification;
    // Another launch may have taken the claim during the wait (the row's broadcast can
    // release the waitlist); it owns the claim then.
    if (ongoingClaimRefreshes.has(refreshKey)) return;

    // Already carrying a readable verdict → there is nothing to spend on. A change-prone
    // row (reclassifyOnHold) is deliberately NOT settled, so it falls through to research.
    const hasNote = claim.note !== undefined && claim.note !== null && String(claim.note).trim() !== "";
    // Logged because every one of these four can be the reason a claim the DB already holds
    // is re-researched — the user pays for that, and from the outside "it re-classified" has
    // no cause. The verdict the settle needs can also be sitting one field away in
    // `cachedVerdict` (a refresh-path stash), which reads identically to "no verdict" today.
    console.log(
      `[background] autoClassifyClaim ${tweetId}:`,
      claim.verdict && claim.verdict !== 'research required' && hasNote && !claim.reclassifyOnHold
        ? 'already settled — no spend'
        : `RESEARCHING (verdict=${claim.verdict ?? 'none'}, note=${hasNote}, onHold=${claim.reclassifyOnHold === true}, cachedVerdict=${claim.cachedVerdict ?? 'none'})`
    );
    if (claim.verdict && claim.verdict !== 'research required' && hasNote && !claim.reclassifyOnHold) {
      // The DB already answers this claim: nothing to research, nothing to spend. It may
      // still carry no annotation for the displayed text, though, and that is the whole
      // reason it is wearing the idle Annotate button — run that pass from here rather than
      // leaving the user to press it (see annotateSettledClaim).
      if (opts?.annotateIfSettled) return annotateSettledClaim(tweetId, claim.text, locale);
      return Promise.resolve();
    }

    // Flip to researching, restoring whatever cached values the claim carries so a
    // change-prone row keeps showing its previous verdict while the new one streams in.
    const updatedClaims = live.claims?.map(cl =>
      cl.text === claim.text
        ? {
            ...cl,
            reclassifyOnHold: false,
            refreshing: true,
            verdict: cl.cachedVerdict ?? cl.verdict,
            note: cl.cachedNote ?? cl.note,
            confidence: cl.cachedConfidence ?? cl.confidence,
            veracity: cl.cachedVeracity ?? cl.veracity,
            sources: cl.cachedSources ?? cl.sources,
          }
        : cl
    ) ?? null;
    const anyOnHold = updatedClaims?.some(cl => cl.reclassifyOnHold) ?? false;
    const restored: Classification = { ...live, claims: updatedClaims, reclassifyOnHold: anyOnHold || undefined };
    restored.batchId = batchId;
    cacheClassification(restored, batchId);
    broadcastClassification(restored);

    ongoingClaimRefreshes.add(refreshKey);
    const cachedTweet = tweetCache.get(tweetId);
    const tweetUrls = cachedTweet ? extractTweetUrls(cachedTweet.text) : undefined;

    const promise = gatedSpendAttributed(async (onBalanceError) => {
      let handled = false, gotUpdate = false;
      try {
        handled = await pullClaimBeforeClassify(tweetId, claim.text, locale);
        if (!handled) {
          // Re-read fresh: pullClaimBeforeClassify may have just merged a dbClaimId in
          // that the `restored` snapshot predates.
          const freshCls = classificationCache.get(tweetId)?.classification ?? restored;
          // Flow A's annotation persist broadcasts tweet-scoped, so it needs a live
          // tweet subscription to reach the client (see helper).
          await ensureAnnotationSubscription(tweetId, claim.text, locale);
          const annotLoc = await annotLocatorsFor(tweetId, freshCls.claims, claim.text, freshCls)
            ?? await annotLocatorsFor(tweetId, freshCls.quoting?.claims, claim.text, freshCls);
          for await (const updated of refreshClaim(freshCls, claim.text, researchCache, locale, tweetUrls, onBalanceError, annotLoc)) {
            gotUpdate = true;
            // Locators rode along, so the worker's silent post-research run is in
            // flight — tell the content script to show "Annotating", not idle Annotate.
            mergeSingleClaimAndBroadcast(tweetId, claim.text, updated, batchId, { withLocators: !!annotLoc, annotatedLocale: annotLoc?.textLocale });
          }
          if (annotLoc) await settleFlowAAnnotations(tweetId, claim.text, annotLoc, batchId);
        }
      } catch (err: any) {
        console.error(`[background] autoClassifyClaim error for "${claim.text.slice(0, 40)}":`, err);
      } finally {
        ongoingClaimRefreshes.delete(refreshKey);
        // Not `!(handled || gotUpdate)`: a run that streamed a snapshot and then died
        // without ever settling the claim would keep the wheel it just painted.
        if (!handled) settleClaimResearch(tweetId, claim.text, batchId, claim.reclassifyOnHold === true);
      }
    });
    trackClaimResearch(refreshKey, promise);
    return promise;
  }

  /** The annotations-only pass for a claim the DB already answers — Flow B (the Annotate
   *  button's run), started without a click.
   *
   *  A settled claim the DB holds no annotation for under the text being displayed is showing
   *  the idle Annotate button. On a post whose lone claim we just handled for free there is no
   *  reason to make the user press it: the run costs one annotations-only pass — no research,
   *  no searches — and it is exactly the pass the button would have started.
   *
   *  Same preconditions as the button enforces: settled, classified, and keyless for this
   *  revision. A present key, even an empty dict ("annotated, nothing wrong"), means this text
   *  is already annotated and nothing is started. Recent edits to a tweet are why a DB claim
   *  can be settled and still keyless here (see payloadToClaim's revision gate). */
  function annotateSettledClaim(tweetId: string, claimText: string, locale: string): Promise<void> {
    const hit = classificationCache.get(tweetId);
    if (!hit) return Promise.resolve();
    const claim = hit.classification.claims?.find(c => c.text === claimText)
      ?? hit.classification.quoting?.claims?.find(c => c.text === claimText);
    if (!claim || claim.reclassifyOnHold || claim.note == null) return Promise.resolve();
    if (claim.annotations && Object.keys(claim.annotations).length > 0) return Promise.resolve();
    const annotKey = `annot:${tweetId}:${claimText}`;
    // In flight already — the button's own run, or this one. Both keys: the bare key is a
    // research run's, and a research run annotates on its own.
    if (ongoingClaimRefreshes.has(annotKey) || ongoingClaimRefreshes.has(`${tweetId}:${claimText}`)) return Promise.resolve();

    // The same marker Flow A stamps, for the same reasons: without it the claim keeps showing
    // the idle Annotate button for the length of the run, and the button's own tap is refused
    // by the in-flight gate above — a button that does nothing when clicked. It is dropped
    // when the run's broadcast lands, or by the pending timeout.
    broadcastClassification(hit.classification, { withLocators: true, claimText });

    ongoingClaimRefreshes.add(annotKey);
    const anyBatchId = hit.batchIds.values().next().value ?? hit.classification.batchId ?? '';
    const refuse = () => {
      for (const port of activePorts) {
        try { port.postMessage({ type: "ANNOTATE_FAILED", data: { classificationId: tweetId, claimText } }); } catch { /* port closed */ }
      }
    };
    // Awaited by the caller so the tweet flow's keep-alive interval spans the run — the same
    // reason the research hand-off is awaited.
    return gatedSpendAttributed(async () => {
      try {
        const freshCls = classificationCache.get(tweetId)?.classification ?? hit.classification;
        const loc = await annotLocatorsFor(tweetId, freshCls.claims, claimText, freshCls)
          ?? await annotLocatorsFor(tweetId, freshCls.quoting?.claims, claimText, freshCls);
        if (!loc) {
          console.log(`[background] annotateSettledClaim: could not resolve locators for "${claimText.slice(0, 40)}...", skipping`);
          refuse();
          return;
        }
        // The routing row the worker's persist broadcasts land on.
        await ensureAnnotationSubscription(tweetId, claimText, locale);
        const freshClaim = freshCls.claims?.find(c => c.text === claimText)
          ?? freshCls.quoting?.claims?.find(c => c.text === claimText);
        const finalAcc = await backgroundAnnotate(
          loc.tweetHash, loc.tweetText, loc.textLocale,
          freshClaim?.dbClaimId, loc.claimIndex, locale,
          (acc) => paintAnnotationsLive(tweetId, claimText, anyBatchId, loc.textLocale, acc)
        );
        // null = transport failure or a server-side skip (stale/unclassified/forged revision).
        // Either way the badge stays rather than claiming a clean pass that never ran.
        if (finalAcc === null) { refuse(); return; }
        paintAnnotationsLive(tweetId, claimText, anyBatchId, loc.textLocale, finalAcc);
      } catch (err: any) {
        console.error('[background] annotateSettledClaim error:', err);
        refuse();
      } finally {
        ongoingClaimRefreshes.delete(annotKey);
      }
    });
  }

  /** Live-paint streamed annotation pairs onto a claim's cached copy and broadcast, so the
   *  page shows corrections as they arrive rather than only when the worker's persist
   *  broadcast lands. Shared: the Annotate button's run and the automatic one
   *  (annotateSettledClaim) paint identically through here.
   *
   *  Each pair is written under this revision's FULL-locale key (the same `${textLocale}:${hash}`
   *  shape the worker persists — the DB broadcast strips to bare prefixes at read time, and
   *  painting the full key lets that strip land on exactly this dict), plus every existing key,
   *  so a retag keeps older revisions visible. Union, never replace. */
  function paintAnnotationsLive(
    classificationId: string,
    claimText: string,
    anyBatchId: string,
    textLocale: string,
    acc: Record<string, string>
  ): void {
    const entry = classificationCache.get(classificationId);
    if (!entry) return;
    const liveKeys = new Set<string>();
    for (const list of [entry.classification.claims, entry.classification.quoting?.claims]) {
      for (const k of Object.keys(list?.find(c => c.text === claimText)?.annotations ?? {})) liveKeys.add(k);
    }
    liveKeys.add(textLocale);
    const paint = (list: Claim[] | null): Claim[] | null => {
      if (!list) return list;
      return list.map(c => {
        if (c.text !== claimText) return c;
        const merged = { ...(c.annotations ?? {}) };
        for (const k of liveKeys) merged[k] = { ...(merged[k] ?? {}), ...acc };
        return { ...c, annotations: merged };
      });
    };
    const painted: Classification = {
      ...entry.classification,
      claims: paint(entry.classification.claims),
      quoting: entry.classification.quoting
        ? { ...entry.classification.quoting, claims: paint(entry.classification.quoting.claims) }
        : entry.classification.quoting,
    };
    painted.batchId = anyBatchId;
    cacheClassification(painted, anyBatchId);
    broadcastClassification(painted);
  }

  /** True only when a Supabase session exists. The whole pipeline is gated on this so
   *  a logged-out user gets no processing, no RPC calls, and no injected buttons. */
  async function isSignedIn(): Promise<boolean> {
    try {
      const { data } = await supabase.auth.getSession();
      return !!data.session?.access_token;
    } catch {
      return false;
    }
  }

  /** Run the full pipeline for one batch of captured tweets: hash each tweet, look it up
   *  in the DB, and either inject the stored claims or start preclassification.
   *
   *  `keepAlive` is the caller's interval holding the service worker awake; this function
   *  owns clearing it on every exit path. `xhrBatchIndex` is the tweet's position in the
   *  originating timeline XHR, used to fetch the first few eagerly and defer the rest
   *  until the relay reports them visible in the DOM. */
  function processFullBatch(port: any, tweets: MainTweet[], batchId: string, keepAlive: NodeJS.Timeout, localeOverride?: string | null, xhrBatchIndex?: number) {
    // A post whose own body runs past MAX_CLASSIFY_CHARS gets no buttons on any platform and
    // is never classified — see that constant for why, and the filter below for what a
    // dropped post keeps. Measured on the post's own body: `text`, which for X's long tweets
    // is the note_tweet expansion the agents are sent, and on every DOM-captured platform is
    // the same string as `fullText`.
    // [ttft-ext] Covers the whole batch: DB hash+lookup, then either a DB-hit
    // injection or the preclassify/research pipeline for a miss.
    const tBatchStart = performance.now();
    (async () => {
      try {
        // Do nothing unless the extension is active (signed in AND positive balance)
        // — no DB pulls, no subscriptions, no on-hold buttons. Inert otherwise.
        if (!(await computeActive())) {
          clearInterval(keepAlive);
          safePostToPort(port, { type: "DONE" });
          return;
        }
        const locale = localeOverride ?? getUiLocale();
        // The filter sits at the top of this function because every path that can put
        // buttons on a post — the timeline announce, a refresh, a forced batch, a
        // reconnect — ends here, and because the client paints only what this function
        // sends it: a post dropped here is one with no pill and nothing billed. Nothing
        // else about it changes. It is still captured, still hashed, and still travels as
        // the quoted post or the ancestor of the posts that carry it, so it keeps its place
        // in another post's chain and context exactly as it always did. A web selection is
        // a different message and never this path — a passage the reader selects is
        // classified by the selection pipeline whatever the length of the post it was cut
        // from.
        const bodyOf = (t: MainTweet) => t.text || t.fullText || '';
        const overLong = tweets.filter((t) => bodyOf(t).length > MAX_CLASSIFY_CHARS);
        if (overLong.length > 0) {
          tweets = tweets.filter((t) => bodyOf(t).length <= MAX_CLASSIFY_CHARS);
          console.log(`[background] batch ${batchId}: no buttons on ${overLong.length} post(s) over ${MAX_CLASSIFY_CHARS} chars: [${overLong.map((t) => t.id).join(',')}]`);
          if (tweets.length === 0) {
            clearInterval(keepAlive);
            safePostToPort(port, { type: "DONE" });
            return;
          }
        }
        const firstTweetText = tweets[0]?.text?.slice(0, 80) ?? '(no text)';
        console.log(`[pipeline fires] batch=${batchId} tweets=${tweets.length} ids=[${tweets.map(t => t.id).join(',')}] firstTweet="${firstTweetText}"`);

        // Cache incoming tweets so SET_DISPLAYED_LOCALE can look up original/translated text.
        for (const t of tweets) tweetCache.set(t.id, t);

        // Step 1: Compute hashes and fetch tweets (and their quoted tweets) from DB in parallel.
        // Use a per-tweet promise cache so the same tweet is never fetched twice,
        // even if it disappears from the DOM and reappears in a later XHR batch.
        // For timeline efficiency, only the first 5 tweets of each XHR batch are
        // fetched immediately; the rest wait until the content script reports them
        // in the DOM.
        type HashResult = {
          tweet: MainTweet;
          hash: string;
          dbResult: any;
          quotedHash?: string;
          quotedDbResult?: any;
        };

        const shouldDeferDom = xhrBatchIndex !== undefined && xhrBatchIndex >= 5;

        async function waitForDom(tweetId: string): Promise<void> {
          if (seenInDom.has(tweetId)) {
            console.log(`[background] waitForDom ${tweetId}: already seen`);
            return;
          }
          console.log(`[background] waitForDom ${tweetId}: waiting`);
          return new Promise(resolve => {
            const list = domFetchResolvers.get(tweetId);
            if (list) {
              list.push(resolve);
            } else {
              domFetchResolvers.set(tweetId, [resolve]);
            }
          });
        }

        async function fetchForTweet(tweet: MainTweet): Promise<HashResult> {
          // Both caches below are keyed by id alone, but a lookup is only an answer about the
          // text it was made against: the same post read before and after its body renders is
          // two different texts, and their hashes name two different rows. Served by id, the
          // earlier reading's row — with the claim ranges and annotations bound to THAT text —
          // is handed to the later reading, so the post's own body is left with no claims and
          // its stored ranges cannot bind. Same id, same hash is still served as before.
          const currentHash = await computeTweetHash(tweet);

          const existing = dbFetchPromises.get(tweet.id);
          if (existing) {
            const cached = await existing;
            if (cached.hash === currentHash) return { tweet, ...cached };
            console.log(`[background] fetchForTweet ${tweet.id}: held lookup is for a different text, looking this one up`);
            dbFetchPromises.delete(tweet.id);
          }

          // A lookup an earlier worker already paid for. This is the reconnect path: the dead
          // worker's page still holds its posts, and the relay hands them all back, so without
          // this every post the reader had reached is bought a second time.
          await loadLookupMemo();
          const remembered = lookupMemo.get(tweet.id);
          if (remembered && remembered.hash === currentHash) {
            const { at: _at, ...cached } = remembered;
            console.log(`[background] fetchForTweet ${tweet.id}: served from the persisted memo`);
            dbFetchPromises.set(tweet.id, Promise.resolve(cached));
            return { tweet, ...cached };
          }
          if (remembered) {
            console.log(`[background] fetchForTweet ${tweet.id}: memo holds a different text of this post, looking this one up`);
          }

          const promise = (async (): Promise<Omit<HashResult, 'tweet'>> => {
            const tFetchStart = performance.now();
            if (shouldDeferDom) {
              await waitForDom(tweet.id);
            }
            const hash = await computeTweetHash(tweet);
            // The lookup is a hash of the author name and the text, so a miss is only ever one of
            // those two having drifted since the row was written. Both halves are printed beside
            // the hash — the tail matters most, because a text that stops mid-sentence is the one
            // drift that looks identical at the head. JSON.stringify so a newline shows as \n: the
            // paragraph join is one of the things two renders of one post disagree on.
            {
              const t = String(tweet.fullText ?? '');
              console.log(`[ttft-ext] hash-input ${tweet.id}: user=${JSON.stringify(String(tweet.username ?? ''))} len=${t.length} head=${JSON.stringify(t.slice(0, 40))} tail=${JSON.stringify(t.slice(-60))} hash=${hash}`);
              // What head and tail cannot show: a join that differs by characters invisible on
              // screen. The row key normalises and the raw text is not, so two renders of one
              // post can agree on the hash and still carry different raw text. Runs are printed
              // as code points — `a0` is a no-break space where `20` is a space.
              const runs = t.match(/\s+/g) ?? [];
              console.log(`[ttft-ext] hash-ws ${tweet.id}: nl=${(t.match(/\n/g) ?? []).length} runs=${runs.length} first=${JSON.stringify(runs.slice(0, 8).map(run => [...run].map(c => c.codePointAt(0)!.toString(16)).join(',')))} mid=${JSON.stringify(t.slice(600, 660))}`);
            }
            let dbResult: any;
            if (dbMissHashes.has(hash)) {
              dbResult = { success: false };
            } else {
              dbResult = await fetchDbTweet(hash);
              if (!dbResult?.success) {
                dbMissHashes.add(hash);
              } else if (dbResult.is_preclassifying) {
                // Subscribe ONLY while the tweet is mid-preclassification — the one case
                // where more claims are still to come. For a settled tweet, subscribe()
                // re-emits the claims this pull just returned (one BILLED broadcast per
                // claim, see subscribe()'s tweets branch) and then deletes itself, so it
                // costs 1 + N fetches for data we already hold.
                await ensureTweetSubscription(tweet.id, hash, locale);
              }
            }
            console.log(`[ttft-ext] fetchForTweet ${tweet.id}: main-tweet lookup +${(performance.now() - tFetchStart).toFixed(0)}ms`);
            let quotedHash: string | undefined;
            let quotedDbResult: any;
            if (tweet.quoting) {
              quotedHash = await computeTweetHash(tweet.quoting);
              if (dbMissHashes.has(quotedHash)) {
                quotedDbResult = { success: false };
              } else {
                quotedDbResult = await fetchDbTweet(quotedHash);
                if (!quotedDbResult?.success) {
                  dbMissHashes.add(quotedHash);
                } else if (quotedDbResult.is_preclassifying) {
                  // Same rule as the main tweet above.
                  await ensureTweetSubscription(tweet.quoting.id, quotedHash, locale);
                }
              }
              console.log(`[ttft-ext] fetchForTweet ${tweet.id}: +quoted-tweet lookup +${(performance.now() - tFetchStart).toFixed(0)}ms total`);
            }
            return { hash, dbResult, quotedHash, quotedDbResult };
          })();

          dbFetchPromises.set(tweet.id, promise);
          const result = await promise;
          rememberLookup(tweet.id, result);
          return { tweet, ...result };
        }

        const hashResults: HashResult[] = await Promise.all(tweets.map(fetchForTweet));
        console.log(`[ttft-ext] batch ${batchId}: DB hash+lookup done for ${tweets.length} tweet(s) +${(performance.now() - tBatchStart).toFixed(0)}ms`);
        // Quick lookup from classification id → tweet
        const tweetById = new Map<string, MainTweet>();
        for (const r of hashResults) {
          tweetById.set(r.tweet.id, r.tweet);
        }

        // Step 2: Split into DB hits (found with claims) and DB misses
        const dbHits = hashResults.filter(r => r.dbResult?.success && r.dbResult.claims?.length > 0);
        const dbMissResults = hashResults.filter(r => !r.dbResult?.success || !r.dbResult.claims?.length);

        // Step 3: Process DB hits — inject immediately, re-research in background
        for (const hit of dbHits) {
          const quotedClaims = hit.quotedDbResult?.success ? hit.quotedDbResult.claims : undefined;
          // The side the reader is looking at comes from the record, not from this batch's
          // copy (see `displayedSides`): a flip grows no captured text, so the sweep never
          // re-delivers the post and every batch here carries the pre-flip capture.
          const {
            classification,
            dbClaims: survivingDbClaims,
            quotedDbClaims: survivingQuotedDbClaims,
          } = dbClaimsToClassification(withDisplayedSide(hit.tweet.id, tweetCache.get(hit.tweet.id) ?? hit.tweet), hit.dbResult.claims, batchId, locale, quotedClaims);
          // Do NOT preserve textLocale from previous sessions/page loads. X's displayed
          // language may have changed (e.g. Chinese -> English), and the default displayed
          // text for this load is determined by dbClaimsToClassification. Only live toggle
          // clicks during this session should change textLocale.
          // Preserve any claims already seeded by the subscription (linked in the tiny
          // window after the fetch snapshot) so this authoritative build doesn't clobber them.
          const seeded = classificationCache.get(hit.tweet.id)?.classification;
          // ...but a LIVE flip does outrank it, and this rebuild is where one lands. `seeded` is
          // this session's cache — the selection pipeline is the only thing restored across
          // sessions and it is sel_/pw_-keyed, so a post id's entry cannot be a previous page
          // load's — hence a textLocale disagreeing with the build above is a toggle the reader
          // just made. It matters here because a host-page text swap destroys our wrap, the
          // re-announce re-sweeps, and this DB-hit rebuild is what answers it: re-stating the
          // captured side broadcasts it over the DOM the reader is looking at, and the segments
          // mismatch guard then refuses the paint, leaving the flipped side with no highlights.
          if (seeded?.textLocale && seeded.textLocale !== classification.textLocale) {
            classification.textLocale = seeded.textLocale;
            if (seeded.translatedLocale) classification.translatedLocale = seeded.translatedLocale;
            if (seeded.translatedText) classification.translatedText = seeded.translatedText;
          }
          if (seeded?.claims?.length && classification.claims) {
            const have = new Set(classification.claims.map(c => c.dbClaimId).filter(Boolean));
            const extra = seeded.claims.filter(c => c.dbClaimId && !have.has(c.dbClaimId));
            if (extra.length) classification.claims = [...classification.claims, ...extra];
            // A DB row is the snapshot taken before any run started, so this rebuild must
            // not restate a claim a live run owns: the row still says reclassify_after has
            // passed, and adopting that would drop `refreshing` mid-batch — the badge falls
            // back to the Fact-Check button until the run's first chunk recolours it.
            const live = new Map(
              seeded.claims
                .filter(c => c.dbClaimId && (c.refreshing === true || c.isClassifying === true))
                .map(c => [c.dbClaimId as string, c])
            );
            if (live.size) {
              classification.claims = classification.claims.map(c => {
                const l = c.dbClaimId ? live.get(c.dbClaimId) : undefined;
                if (!l || !c.reclassifyOnHold) return c;
                return {
                  ...c, reclassifyOnHold: false, refreshing: true, isClassifying: l.isClassifying,
                  verdict: l.verdict, confidence: l.confidence, veracity: l.veracity,
                  note: l.note, sources: l.sources,
                };
              });
            }
          }
          // Check if translate-fact-checks is needed: tweet has translation data AND
          // displayed text locale differs from claim storage locale by primary language.
          const hasTranslation = hit.tweet.translatedText && hit.tweet.sourceLanguage && hit.tweet.destinationLanguage;
          const displayedLocale = classification.textLocale ?? hit.tweet.sourceLanguage ?? '';
          const claimStorageLocale = (hit.dbResult.claims?.[0] && getClaimLocale(hit.dbResult.claims[0].claim)) ?? '';
          const allClaimsForHighlightCheck = [
            ...(classification.claims ?? []),
            ...(classification.quoting?.claims ?? [])
          ];
          // Tolerate same-language subtag differences (en vs en-US): a highlight that
          // resolves under the base language is NOT missing, so we never localize/
          // translate across regions of the same language.
          const highlightsMissing = displayedLocale && allClaimsForHighlightCheck.some(cl => !resolveHighlightRange(cl.highlight, displayedLocale));
          const differentLanguages = hasTranslation && claimStorageLocale && displayedLocale &&
            !sameLanguage(displayedLocale, claimStorageLocale);

          if (differentLanguages && highlightsMissing) {
            classification.translateFactChecksOnHold = true;
            console.log(`[background] DB hit ${classification.id}: translateFactChecksOnHold (displayed=${displayedLocale}, stored=${claimStorageLocale})`);
          }
          cacheClassification(classification, batchId);

          // Cache DB result for TRANSLATE_FACT_CHECKS handler. The surviving rows, not every
          // row read: the handler pairs the worker's ranges with `classification.claims` by
          // index, and a row dropped as an overlap would shift every range after it.
          dbHitCache.set(classification.id, { tweet: hit.tweet, dbClaims: survivingDbClaims });
          if (hit.tweet.quoting && hit.quotedDbResult?.success && survivingQuotedDbClaims.length > 0) {
            dbHitCache.set(hit.tweet.quoting.id, { tweet: hit.tweet.quoting as MainTweet, dbClaims: survivingQuotedDbClaims });
          }

          // A run writes nothing until it ENDS, so this pull is the only place a viewer can
          // learn that an annotation is already streaming for a claim — the server stamps
          // that on the link (is_annotating, see add_tweet_claim_is_annotating.sql). Without
          // it a second viewer paints the Annotate button over a run in flight and pays for
          // a duplicate. Stamped on an OUTGOING copy (the cache keeps the clean claim, the
          // relay strips the marker) with the same gates stampAnnotateInFlight applies to
          // Flow A: settled, classified, and no key for the displayed revision.
          const inFlightAnnotations = new Map<string, string>();
          const mainClaims = classification.claims ?? [];
          for (let i = 0; i < mainClaims.length; i++) {
            const cl = mainClaims[i];
            const link = survivingDbClaims[i];
            if (link?.is_annotating !== true || !link.id) continue;
            if (cl.reclassifyOnHold || cl.note == null || cl.refreshing || cl.isClassifying) continue;
            if (cl.annotations && Object.keys(cl.annotations).length > 0) continue;
            inFlightAnnotations.set(cl.text, String(link.id));
          }
          const posted = maskPendingResearch(classification);
          safePostToPort(port, {
            type: "CLASSIFICATION",
            data: inFlightAnnotations.size
              ? (stampAnnotateInFlight(posted, { claimTexts: new Set(inFlightAnnotations.keys()) }) ?? posted)
              : posted,
          });
          for (const [claimText, dbClaimId] of inFlightAnnotations) {
            watchInFlightAnnotation(classification.id, claimText, dbClaimId, hit.hash, locale);
          }

          // Subscribe only while the tweet is still preclassifying — claims are only ever
          // linked during that window, and fetchForTweet already opened this subscription
          // in that case (ensureTweetSubscription is deduped, so this just refreshes its
          // timer and costs nothing). A settled tweet gets none: its claims are already in
          // the pull above. watchClassifyingClaims is untouched — it only fires for a claim
          // someone else is mid-classifying, which is rare and must still resolve.
          if (hit.dbResult?.is_preclassifying) startTweetSubscription(classification.id, hit.hash, locale);
          watchClassifyingClaims(classification.id, hit.dbResult.claims, locale);
          if (classification.quoting && quotedClaims && hit.quotedHash) {
            if (hit.quotedDbResult?.is_preclassifying) startTweetSubscription(classification.quoting.id, hit.quotedHash, locale);
            watchClassifyingClaims(classification.quoting.id, quotedClaims, locale);
          }

          // Pre-populate researchCache from the DB hit so translation callbacks can find
          // last_classification/reasoningLocale even when re-research is skipped this session.
          const allDbClaimsForCache = [...hit.dbResult.claims, ...(quotedClaims ?? [])];
          for (const dbClaim of allDbClaimsForCache) {
            const cacheKey = extractClaimText(dbClaim.claim);
            const claimLocale = getClaimLocale(dbClaim.claim);
            const reasonStr = extractReasoningText(dbClaim.reasoning, claimLocale);
            const existing = researchCache.get(cacheKey);
            researchCache.set(cacheKey, {
              // Same certainty rule as payloadToClaim — see dbClaimConfidence.
              confidence: dbClaimConfidence(dbClaim),
              veracity: Number(dbClaim.veracity ?? 0),
              reasoning: reasonStr,
              reasoningLocale: claimLocale,
              sources: normalizeSources(dbClaim.sources),
              dbClaimText: cacheKey,
              lastClassification: getLastClassification(dbClaim) ?? existing?.lastClassification,
            });
          }

          (async () => {
            try {
              // When translation is on hold, skip localization + re-research entirely.
              if (classification.translateFactChecksOnHold) {
                console.log(`[background] DB hit ${classification.id}: translateFactChecksOnHold, skipping localization + re-research`);
                return;
              }

              // NOTE: highlight localization is NEVER done automatically on load — it
              // would silently charge the user. It is triggered ONLY by the tweet's
              // translate button (which remaps highlight ranges onto the translated
              // text). A DB hit is injected with whatever highlights it already has.

              // Only re-research once per tweet per session. Repeated timeline responses
              // should not keep translating/re-localizing and writing to the DB.
              if (!reResearchedTweetIds.has(classification.id)) {
                reResearchedTweetIds.add(classification.id);
                await reResearchDbClaims(hit.dbResult.claims, classification, researchCache);
              } else {
                console.log(`[background] DB hit ${classification.id}: re-research already done this session, skipping`);
              }
            } catch (err) {
              console.error("[background] reResearchDbClaims error:", err);
            }
          })();
        }

        // Step 3b: Tweet exists in DB but has no linked claims yet. It may still be
        // preclassifying (claims arrive over the subscription) or genuinely claim-free.
        const dbEmpty = dbMissResults.filter(r => r.dbResult?.success);
        for (const empty of dbEmpty) {
          const isPreclassifying = empty.dbResult?.is_preclassifying === true;
          const classification: Classification = { id: empty.tweet.id, batchId, claims: null, quoting: null };
          // Mid-preclassification (someone else is running it): present it exactly like a
          // forced re-preclassification — spinner + "Fact-Check All" where the Disinfact
          // button would sit, and no Disinfact button — then wait for the claims to arrive
          // over the subscription. `preclassifying` is the SAME flag
          // runPreclassification(force = true) already sets, so this reuses that existing,
          // tested injection path in injectClassification rather than adding a new state.
          if (isPreclassifying) classification.preclassifying = true;
          attachTranslatedLocale(classification, withDisplayedSide(empty.tweet.id, empty.tweet));
          cacheClassification(classification, batchId);
          safePostToPort(port, { type: "CLASSIFICATION", data: classification });
          // Subscribe only while it IS preclassifying: a settled claim-free tweet has
          // nothing more coming, and subscribe() would delete itself immediately anyway.
          if (isPreclassifying) {
            watchPreclassifyingEnd(classification.id, empty.hash, batchId, locale);
            // Subscribe-then-read, the same order watchClassifyingClaim uses: `subscribe`
            // inserts a routing row even when the run has ALREADY finished, and a finished
            // run left nothing that will ever delete that row — so without this read the
            // wheel waits out PRECLASS_TIMEOUT_MS on claims that are already in the DB.
            // Awaiting readiness first is what makes the read worth taking: a claim that
            // lands after the routing row exists is delivered by the subscription, so the
            // read only has to answer for everything before it. A still-running run
            // answers nothing and is carried by the subscription as before.
            void ensureTweetSubscription(classification.id, empty.hash, locale)
              .then(() => injectSettledPreclassification(classification.id, empty.hash, batchId, locale))
              .catch(e => console.error('[preclassifying] early read failed:', e));
          }
        }

        // Step 4: Existing cached/uncached split for remaining DB misses
        const dbNotFound = dbMissResults.filter(r => !r.dbResult?.success);
        const cached: Classification[] = [];
        const uncached: MainTweet[] = [];
        for (const r of dbNotFound) {
          const tweet = r.tweet;
          // The entry a Disinfact tap runs on must be the text the annotate path will
          // hash, and that path hashes `tweetCache` — which is overwritten by EVERY
          // batch (step 0 above). This map used to be written only when the id had no
          // cached classification, and that is wrong for a post whose text SETTLES
          // after it first appears: Reddit's body mounts asynchronously, so the same
          // post is announced twice with two texts and therefore two hashes (the hash
          // covers `fullText`). The second, complete capture took the `hit` branch
          // below, leaving the FIRST, body-less capture in this map — the tap then
          // preclassified text the page no longer showed (its claims all landed in the
          // title, none in the body), and every later annotation, hashing the current
          // capture, subscribed and settled against a tweet hash that holds none of
          // those claims. That is a pending routing row nothing can ever resolve, so
          // "Annotating" spins out its whole window. Refresh it on every batch.
          onHoldTweets.set(tweet.id, { tweet, hash: r.hash });
          const hit = classificationCache.get(tweet.id);
          if (hit) {
            hit.batchIds.add(batchId);
            const cachedCls = { ...hit.classification, batchId };
            // Reset to the default displayed locale for this page load. The user may have
            // changed X's UI language, so a stale textLocale from the previous session/page
            // load would inject the wrong text/highlight locale.
            attachTranslatedLocale(cachedCls, tweet);
            cached.push(cachedCls);
          } else {
            // No DB hash match — send on-hold classification (pipeline paused until user clicks "Disinfact")
            const onHoldClassification: Classification = {
              id: tweet.id, batchId, claims: null, quoting: null, onHold: true
            };
            attachTranslatedLocale(onHoldClassification, withDisplayedSide(tweet.id, tweet));
            cacheClassification(onHoldClassification, batchId);
            safePostToPort(port, { type: "CLASSIFICATION", data: onHoldClassification });
            // A tap parked while the worker was dead (backgrounded / long idle)
            // won the race and arrived before this entry existed — honor it now
            // instead of stranding the spinner until the 30s revert. No-op untapped.
            flushPendingProcessOnHold(tweet.id);
          }
        }

        for (const cachedClassification of cached)
          safePostToPort(port, { type: "CLASSIFICATION", data: maskPendingResearch(cachedClassification) });

        const allProcessed = dbHits.length + dbEmpty.length;
        if (allProcessed > 0 && uncached.length === 0) {
          clearInterval(keepAlive);
          safePostToPort(port, { type: "DONE" });
          return;
        }

        if (uncached.length === 0) {
          clearInterval(keepAlive);
          safePostToPort(port, { type: "DONE" });
          return;
        }


        safePostToPort(port, { type: "DONE" });
      } catch (err: any) {
        console.error("Error in Background:", err);
        safePostToPort(port, { type: "ERROR", error: err.message });
      } finally {
        clearInterval(keepAlive);
      }
    })();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Funds hub — one funds channel for the whole extension. Relays the balance to
  // the popup dashboard and balance-delta / error notifications to all X tabs.
  // ─────────────────────────────────────────────────────────────────────────
  let fundsSub: FundsSubscription | null = null;
  let fundsState: Funds | null = null;
  let lastVisibleTotal: number | null = null;
  let fundsInitPromise: Promise<void> | null = null;
  /** Which account the cached balance + Realtime subscription belong to. The hub is
   *  per-user, so this is what makes an account switch detectable. */
  let fundsHubUid: string | null = null;

  /** The signed-in user's id, or null when signed out. `isSignedIn()` cannot tell two
   *  different accounts apart — both answer true — so identity is tracked separately. */
  async function currentUserId(): Promise<string | null> {
    try {
      const { data } = await supabase.auth.getSession();
      return data.session?.user?.id ?? null;
    } catch {
      return null;
    }
  }

  /** Broadcast a notification to every connected X content script. 'broke' is the
   *  empty-balance notice — it carries no amount and renders this extension's own
   *  `balanceEmpty` copy on the page (see showNotification in utils/injecting.ts). */
  function broadcastNotification(data: { kind: 'increase' | 'decrease' | 'error' | 'broke'; amount?: number; text?: string; code?: number }) {
    for (const port of activePorts) {
      try { port.postMessage({ type: 'MF_NOTIFICATION', data }); } catch { /* ignore */ }
    }
  }

  /** Surface a failure to the user as a red in-page notification. A number is a
   *  recognized error code — the relay looks up this extension's own localized text
   *  for it (see utils/errorCodes.ts) and ignores whatever backend wording exists.
   *  A string is already-resolved text, shown as-is. */
  function notifyError(messageOrCode: string | number) {
    if (typeof messageOrCode === 'number') broadcastNotification({ kind: 'error', code: messageOrCode });
    else if (messageOrCode) broadcastNotification({ kind: 'error', text: messageOrCode });
  }

  /** Set by the popup immediately before a user-chosen sign-out, so the background can
   *  tell "the user signed out" from "the server threw us out". See the reader below. */
  const INTENTIONAL_SIGNOUT_KEY = 'mf_intentional_signout';
  /** How long a sign-out marker stays meaningful. The background normally sees the
   *  marker within a tick of the popup writing it; the window only exists so a marker
   *  stranded by a suspended worker can never suppress a LATER, real eviction. */
  const INTENTIONAL_SIGNOUT_TTL_MS = 15_000;

  /** Whether the sign-out we are looking at was chosen by the user. Consumes the marker. */
  async function consumeIntentionalSignOut(): Promise<boolean> {
    try {
      const data = await browser.storage.local.get(INTENTIONAL_SIGNOUT_KEY);
      const at = data[INTENTIONAL_SIGNOUT_KEY];
      if (typeof at !== 'number') return false;
      await browser.storage.local.remove(INTENTIONAL_SIGNOUT_KEY);
      return Date.now() - at < INTENTIONAL_SIGNOUT_TTL_MS;
    } catch {
      // Unreadable storage must not turn a chosen sign-out into an alarming one.
      return true;
    }
  }

  /** Last total written into the App Group, so an unchanged value costs nothing. */
  let lastNativeSyncedTotal: number | null = null;
  /** Last spend-notification setting sent along with it. Travels with the balance
   *  because the app's own Fact-Check tab raises its own charge notifications and
   *  cannot read extension storage; a change here alone is still worth a round trip,
   *  or a reader who just moved the slider would keep the old floor in the app. */
  let lastNativeSyncedSpend: string | null = null;
  /** Whether the app currently holds an identity from us, so sign-out is sent exactly once. */
  let nativeAccountShared = false;
  let nativeSyncTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Tell the containing app that nobody is signed in.
   *
   * Safari only. The app has no Supabase session, so it believes whatever identity we last wrote
   * — and until this existed we never unwrote it. Signing out of the popup therefore left the app
   * holding the previous user's id, still showing the top-up card, and still able to complete a
   * purchase against an account that was no longer signed in.
   *
   * Sent immediately rather than debounced: this one revokes a permission, and the debounce exists
   * to spare the app process a wake-up for a number, not to delay that.
   */
  function clearNativeAccount() {
    if (!import.meta.env.SAFARI) return;
    if (!nativeAccountShared) return; // nothing to revoke

    // Cancel any queued balance write. It carries the identity we are revoking, and arriving after
    // this would re-authorise the app.
    if (nativeSyncTimer !== undefined) { clearTimeout(nativeSyncTimer); nativeSyncTimer = undefined; }
    nativeAccountShared = false;
    lastNativeSyncedTotal = null;

    (async () => {
      try {
        await (browser.runtime as any).sendNativeMessage(NATIVE_APP_ID, { action: 'CLEAR_ACCOUNT' });
      } catch (e: any) {
        // The app also expires the identity on its own after a week, so a failure here degrades
        // to "stale for a while" rather than "sells forever".
        console.warn('[background] native account clear failed:', e?.message || e);
      }
    })();
  }

  /**
   * The expiry of the session this extension last handed the app — see `nativeSessionHandover`.
   *
   * Persisted rather than held in memory, because an idle service worker is torn down and rebuilt
   * constantly: a module-level copy would be gone by the next alarm tick, and every tick would hand
   * the same token over again — a wake-up a minute to say nothing.
   */
  const NATIVE_SESSION_EXPIRES_KEY = 'nativeSessionExpiresAt';

  /**
   * Ends the Safari session when the app has ended it.
   *
   * Safari only, and the reverse of `clearNativeAccount` above: that one tells the app, this one
   * finds out. The app's sign-out clears the shared record, but this profile holds its own copy
   * and keeps working on a still-valid access token until its refresh fails — up to an hour
   * later, during which the buttons stay injected and every run is charged to an account the
   * user has left. Nothing native runs app → extension, so the app stamps the shared container
   * instead and this asks for the stamp (see `appEndedSessionAt`).
   *
   * The two markers before the slot empties are the same pair the popup writes on a sign-out it
   * performs itself, and for the same two reasons: the first stops `refreshActiveState` from
   * announcing a sign-out nobody in this browser chose, the second stops the shared record from
   * being adopted straight back into the slot.
   *
   * One at a time: it is called from both a timer and every evaluation, and two sign-outs racing
   * would only clear the same slot twice — but the last one would also stamp the markers after
   * the first had emptied it, which is how a second account's session could be the one cleared.
   */
  let appSignOutChecking = false;
  async function endSessionSignedOutInApp(): Promise<boolean> {
    if (!import.meta.env.SAFARI || appSignOutChecking) return false;
    appSignOutChecking = true;
    try {
      const endedAt = await appEndedSessionAt(SUPABASE_AUTH_STORAGE_KEY);
      if (endedAt === null) return false;
      try {
        await browser.storage.local.set({
          [INTENTIONAL_SIGNOUT_KEY]: Date.now(),
          // The app's own sign-out instant, not this one. The stamp means "sessions minted at
          // or before this are dead", and `adoptNativeSession` runs immediately after this on
          // the same evaluation: stamped with the moment we noticed, it would refuse the
          // session the app minted a minute earlier signing back in, and the popup would keep
          // drawing its signed-out screen for a signed-in device until the next rotation.
          [NATIVE_SIGNOUT_KEY]: endedAt,
        });
      } catch { /* best-effort: the marker only suppresses a notice */ }
      // Local scope only, like the popup's own sign-out: the global default would revoke the
      // token family and sign the user out of their other devices, which they did not ask for.
      await supabase.auth.signOut({ scope: 'local' });
      return true;
    } catch (e: any) {
      console.warn('[background] app sign-out check failed:', e?.message || e);
      return false;
    } finally {
      appSignOutChecking = false;
    }
  }

  /**
   * A Supabase access token for the app to authenticate its own fact-checks with, or nil.
   *
   * The refresh token rides along, which is what lets the app renew the session itself rather
   * than waiting for this side to notice. Both processes publish to the same record, so a
   * handover is one more writer of a value that already exists — never the only source of it.
   * (See `AppSession` in SharedTopUpStore.swift for how two writers stay safe: one lock, one
   * rotation, last write wins on expiry.)
   *
   * Nil means there is nothing worth handing over, on any of three counts: nobody is signed in;
   * the token is at or near its end, which covers a refresh that just failed and which the app
   * would refuse anyway (`FactCheckClient.liveSession` wants 30 seconds of life left in it); or the
   * app already holds this same one.
   */
  async function nativeSessionHandover(): Promise<{ accessToken: string; refreshToken?: string; expiresAt: number } | null> {
    await ensureFreshSession();
    const { data } = await supabase.auth.getSession();
    const session = data.session;
    if (!session?.access_token || !session.expires_at) return null;
    // Wider than the app's own 30-second floor, so what arrives is never borderline.
    if (session.expires_at <= Date.now() / 1000 + 60) return null;

    const stored = (await browser.storage.local.get(NATIVE_SESSION_EXPIRES_KEY))[NATIVE_SESSION_EXPIRES_KEY];
    // Expiries only advance — a refresh extends this one, a sign-in issues a later one — so a value
    // no newer than the last handover means the app is already holding the best we have.
    if (typeof stored === 'number' && session.expires_at <= stored) return null;

    return {
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      expiresAt: session.expires_at,
    };
  }

  /**
   * Mirror the balance into the shared App Group container so the containing app can show it.
   *
   * Safari only, and it exists because the app has no Supabase session of its own — it cannot ask
   * the server what the balance is. Until now only the POPUP wrote that value across, so the app
   * showed whatever the balance was the last time the popup happened to be open. Now that the
   * webhook credits top-ups server-side within seconds, the popup was the only thing left forcing
   * the user to go and open it.
   *
   * The session rides along, on the same message and for the same reason: it too was the popup's
   * to hand over, and it is the one the app needs before it can do anything but display a number.
   *
   * Debounced, because a balance moves on every classification: without this each spend would wake
   * the app extension process just to write four bytes. The trailing edge is the one that matters —
   * intermediate values are of no interest to a screen nobody is looking at yet.
   */
  function syncFundsToNativeApp(total: number) {
    if (!import.meta.env.SAFARI) return;

    if (nativeSyncTimer !== undefined) clearTimeout(nativeSyncTimer);
    nativeSyncTimer = setTimeout(() => {
      nativeSyncTimer = undefined;
      (async () => {
        try {
          const userId = await currentUserId();
          if (!userId) return; // signed out; nothing to attribute a balance to
          // Read even when the balance has not moved: a session that has just been refreshed is a
          // reason to send on its own, and the balance coming along costs nothing.
          const session = await nativeSessionHandover();
          const spendSync = `${spendNotifySettings.enabled}:${spendNotifySettings.threshold}`;
          // The app already has every part of this message.
          if (total === lastNativeSyncedTotal && spendSync === lastNativeSyncedSpend && !session) return;

          await (browser.runtime as any).sendNativeMessage(NATIVE_APP_ID, {
            action: 'SYNC_ACCOUNT',
            userId,
            balance: total,
            notifySpendEnabled: spendNotifySettings.enabled,
            notifySpendThreshold: spendNotifySettings.threshold,
            ...(session
              ? {
                  accessToken: session.accessToken,
                  accessTokenExpiresAt: session.expiresAt,
                  refreshToken: session.refreshToken,
                }
              : {}),
          });
          // Only after the app has it. A send that failed leaves the mark where it was, so the
          // next tick tries again rather than counting a token as delivered when it was not.
          if (session) await browser.storage.local.set({ [NATIVE_SESSION_EXPIRES_KEY]: session.expiresAt });
          lastNativeSyncedTotal = total;
          lastNativeSyncedSpend = spendSync;
          nativeAccountShared = true;
        } catch (e: any) {
          // The app not being installed, or the host not answering, must never disturb the
          // extension. The popup still syncs on open, so this is an optimisation, not a
          // dependency.
          console.warn('[background] native balance sync failed:', e?.message || e);
        }
      })();
    }, NATIVE_SYNC_DEBOUNCE_MS);
  }

  /** Push the current visible total (balance + hold) to the popup dashboard, if open. */
  function relayFundsToPopup(total: number | null) {
    try {
      const maybe = (browser.runtime.sendMessage as any)({ type: 'MF_FUNDS_UPDATE', total });
      if (maybe && typeof maybe.catch === 'function') maybe.catch(() => { /* no popup listening */ });
    } catch { /* no popup listening */ }
  }

  // ── Spend-notification settings ───────────────────────────────────────────
  /** Written by the popup. `enabled` turns the balance-decrease toast off entirely;
   *  when it is on, only a decrease LARGER than `threshold` (USD) raises one. Defaults
   *  to on above US$0.001: the toast reports money, and a charge smaller than a
   *  tenth of a cent is noise. Read here rather than in the content scripts because
   *  this is the one place a decrease becomes a broadcast. */
  const SPEND_NOTIFY_ENABLED_KEY = 'mf_spend_notify_enabled';
  const SPEND_NOTIFY_THRESHOLD_KEY = 'mf_spend_notify_threshold';
  const SPEND_NOTIFY_DEFAULT_ENABLED = true;
  const SPEND_NOTIFY_DEFAULT_THRESHOLD = 0.001;
  const SPEND_NOTIFY_MIN_THRESHOLD = 0.0001;
  const SPEND_NOTIFY_MAX_THRESHOLD = 1;
  const spendNotifySettings = {
    enabled: SPEND_NOTIFY_DEFAULT_ENABLED,
    threshold: SPEND_NOTIFY_DEFAULT_THRESHOLD,
  };
  /** Narrow an arbitrary stored value into the slider's own range, so a stale or
   *  hand-edited storage entry can't put the floor somewhere the UI cannot. */
  function clampSpendNotifyThreshold(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value)
      ? Math.min(SPEND_NOTIFY_MAX_THRESHOLD, Math.max(SPEND_NOTIFY_MIN_THRESHOLD, value))
      : SPEND_NOTIFY_DEFAULT_THRESHOLD;
  }
  try {
    browser.storage.local
      .get([SPEND_NOTIFY_ENABLED_KEY, SPEND_NOTIFY_THRESHOLD_KEY])
      .then((r: any) => {
        if (typeof r?.[SPEND_NOTIFY_ENABLED_KEY] === 'boolean') {
          spendNotifySettings.enabled = r[SPEND_NOTIFY_ENABLED_KEY];
        }
        spendNotifySettings.threshold = clampSpendNotifyThreshold(r?.[SPEND_NOTIFY_THRESHOLD_KEY]);
      })
      .catch(() => {});
    browser.storage.onChanged.addListener((changes: Record<string, any>, area: string) => {
      if (area !== 'local') return;
      let touched = false;
      if (SPEND_NOTIFY_ENABLED_KEY in changes && typeof changes[SPEND_NOTIFY_ENABLED_KEY]?.newValue === 'boolean') {
        spendNotifySettings.enabled = changes[SPEND_NOTIFY_ENABLED_KEY].newValue;
        touched = true;
      }
      if (SPEND_NOTIFY_THRESHOLD_KEY in changes) {
        spendNotifySettings.threshold = clampSpendNotifyThreshold(changes[SPEND_NOTIFY_THRESHOLD_KEY]?.newValue);
        touched = true;
      }
      // Carry a fresh floor to the app now rather than at the next balance move: its
      // charge notices read the value from the App Group, and nothing else would send
      // it until money happened to change. Skipped before the first sync, where there
      // is no total to pair it with.
      if (touched && lastNativeSyncedTotal !== null) syncFundsToNativeApp(lastNativeSyncedTotal);
    });
  } catch { /* ignore */ }

  /** Single entry point for every balance change, wherever it came from (Realtime push,
   *  a one-off getFunds(), or post-checkout polling). Ordering matters here: the freeze
   *  state is re-evaluated before the waitlist is pumped, so newly-affordable work is
   *  only admitted once the extension is known to be active. */
  function handleFundsChange(funds: Funds) {
    fundsState = funds;
    // Balance crossing 0 (spend) or back above (top-up) toggles the freeze.
    refreshActiveState();
    // A settle (or top-up) frees room → admit any Fact-Check All claims now within budget.
    // availableToSpend() is absolute (lag-invariant), so this is safe on every funds change.
    pumpWaitlist();
    // Terminal case: balance ≤ 0 with no hold left → no settle can ever revive it, so any
    // still-WAITING Fact-Check All claim is unaffordable. Purge them (show the error once).
    purgeWaitlistIfBroke();
    // Round to the DB's 4-dp precision: balance + hold is exact NUMERIC server-side,
    // but re-adding the two in JS floats leaves ~1e-15 residue on net-zero hold↔balance
    // moves (acquire_hold then settle), which would otherwise fire phantom "$0" notifs.
    const total = Math.round(visibleTotal(funds) * 10000) / 10000;
    // The dashboard always shows the up-to-date total.
    relayFundsToPopup(total);
    // …and so does the containing app, which cannot look it up itself.
    syncFundsToNativeApp(total);
    if (lastVisibleTotal === null) {
      // First value this session = baseline. The opening-X.com-with-empty-funds case
      // announces itself here instead of staying silent: the freeze at zero balance
      // would otherwise greet the user with nothing but dead buttons.
      lastVisibleTotal = total;
      if (total <= 0) broadcastNotification({ kind: 'broke' });
      return;
    }
    // Crossing from positive to empty (balance + hold ≤ 0) announces itself with the
    // empty-balance notice alongside the usual decrease toast. lastVisibleTotal is the
    // session's memory of the crossing, so one crossing fires exactly once no matter
    // how many subsequent spends arrive while the balance stays empty.
    const wasPositive = lastVisibleTotal > 0;
    const delta = total - lastVisibleTotal;
    // Surface any change that rounds to 0.0001 (the DB's 4-dp precision) or more, so the
    // notification matches what the up-to-4-dp display can show. `total` is already
    // 4-dp-rounded above, so this only filters out pure float residue (< 0.00005). Leave
    // the baseline untouched when we skip, so tiny charges still accumulate until they
    // cross the threshold.
    const roundedDelta = Math.round(Math.abs(delta) * 10000) / 10000;
    if (roundedDelta >= 0.0001) {
      lastVisibleTotal = total;
      // A decrease is announced only above the reader's own floor (popup setting). The
      // baseline still advances, so the floor judges each change rather than letting
      // small charges accumulate unnoticed. The empty-balance notice is not a delta and
      // keeps firing: it is what explains the frozen buttons after a crossing.
      const hiddenSpend = delta < 0 && (
        !spendNotifySettings.enabled || roundedDelta <= spendNotifySettings.threshold
      );
      if (!hiddenSpend) broadcastNotification({ kind: delta > 0 ? 'increase' : 'decrease', amount: roundedDelta });
      if (wasPositive && total <= 0) broadcastNotification({ kind: 'broke' });
    }
  }

  /** Open the funds channel FIRST, then fetch once via get_funds, then keep listening.
   *  Idempotent — a single in-flight init is shared; retried after sign-in. */
  async function initFundsHub(): Promise<void> {
    // A hub built for a DIFFERENT account is worse than no hub: its cached balance and
    // its Realtime subscription both belong to the previous user, and the idempotence
    // guard below would keep handing that back forever. Rebuild on any identity change.
    const uid = await currentUserId();
    if (uid !== fundsHubUid) {
      teardownFundsHub();
      fundsHubUid = uid;
    }
    if (fundsInitPromise) return fundsInitPromise;
    fundsInitPromise = (async () => {
      const sub = await subscribeFunds(handleFundsChange, notifyError);
      if (!sub) { fundsInitPromise = null; return; } // not signed in
      fundsSub = sub;
      const funds = await getFunds();
      if (funds) handleFundsChange(funds);
    })().catch(e => { console.error('[background] initFundsHub error:', e); fundsInitPromise = null; });
    return fundsInitPromise;
  }

  /** Close the funds subscription and forget the cached balance, so the next
   *  initFundsHub() starts clean. Called on sign-out. */
  function teardownFundsHub() {
    if (fundsSub) { fundsSub.close(); fundsSub = null; }
    fundsState = null;
    lastVisibleTotal = null;
    // Cleared too, or the next user's identical total would be suppressed as "unchanged" and
    // the app would keep showing the previous account's balance.
    lastNativeSyncedTotal = null;
    lastNativeSyncedSpend = null;
    fundsInitPromise = null;
    // Cleared alongside the rest so "hub torn down" always implies "belongs to nobody";
    // callers that are rebuilding assign the new owner immediately after.
    fundsHubUid = null;
  }

  // Surface worker/DB failures (e.g. 402 balance-too-low) as red error notifications.
  // A recognized code takes priority — see notifyError's overload.
  setWorkerErrorHandler(result => notifyError(result.code ?? result.text ?? ''));

  /** Broadcast the current "active" state to every connected content script so it
   *  can tear down injections + freeze (inactive) or resume (active). Reuses the
   *  MF_AUTH message: `signedIn` here means "extension active". */
  function broadcastActive(active: boolean) {
    for (const port of activePorts) {
      try { port.postMessage({ type: 'MF_AUTH', signedIn: active }); } catch { /* ignore */ }
    }
  }

  /** Extension stays "active" (injections visible, subscriptions live) while the
   *  VISIBLE total (balance + hold) is positive — so results don't vanish just because
   *  spendable balance dipped to 0 with money still held. Unknown funds = OK. */
  function balanceOk(): boolean {
    if (!fundsState) return true;
    return visibleTotal(fundsState) > 0;
  }

  // ── Charging AI actions ─────────────────────────────────────────────────────
  // Single AI actions (one Fact-Check/reclassify click, Translate, Disinfact/preclassify) no
  // longer queue: they fire directly, and on ANY backend failure the error is surfaced and the
  // claim reverts to its on-hold button (retry affordance). Only Fact-Check All fans many
  // classifications out at once, so ONLY it uses a client WAITLIST that runs a claim in parallel
  // only while the balance covers its worst-case charge in full, and otherwise one at a time.

  /** Fire a single (non-fanning-out) charging AI action directly. No queue: a balance-too-low
   *  402 surfaces via reportWorkerError → workerErrorHandler (notifyError) since no interceptor
   *  is pushed. Kept as a wrapper so existing call sites are unchanged. */
  function gatedSpend(run: () => Promise<void>): Promise<void> {
    return run().catch(e => { console.error('[spend] action error:', e); });
  }

  /** Fire a single attributed charging AI action directly; route a balance-too-low 402 straight
   *  to the error notification (the worker calls this instead of reportWorkerError). */
  function gatedSpendAttributed(run: (onBalanceError: () => void) => Promise<void>): Promise<void> {
    return run(() => notifyError(ERROR_CODES.BALANCE_TOO_LOW)).catch(e => { console.error('[spend] action error:', e); });
  }

  // ── Fact-Check All waitlist ─────────────────────────────────────────────────
  // Each admitted claim reserves the WORST-CASE settled charge (see CLASSIFICATION_RESERVE), so the
  // balance is sized for what actually leaves it. Claims the balance funds in full run in parallel;
  // once it can't, they run ONE at a time, draining whatever is left. That still dispatches no
  // wasted 402s: the backend refuses a hold only while the balance is ≤ 0, so the partly-funded
  // claim runs and it is the SECOND one in parallel that would 402.
  const FACTCHECK_BATCH_TIMEOUT_MS = 30000;
  const MAX_CLASSIFY_ATTEMPTS = 2; // 1 initial + at most 1 retry after a backend balance-too-low
  type WaitlistItem = { classificationId: string; claimText: string; batchId: string; locale: string; reserve: number; attempts: number };
  const factCheckWaitlist: WaitlistItem[] = [];
  // Keys (`${id}:${text}`) currently WAITING — stops the broadcast auto-release from double-
  // enqueuing. In-flight claims are tracked by ongoingClaimRefreshes.
  const factCheckWaitlistKeys = new Set<string>();
  // Keys abandoned this batch (2 failed tries / 30s timeout / broke). The auto-release skips
  // these (and the on-hold masking shows their button) so a reverted claim isn't re-enqueued.
  // Cleared for a tweet on a fresh Fact-Check All (deliberate retry) and on reset.
  const abandonedFactCheckKeys = new Set<string>();
  // Σ of admitted-but-unsettled worst-case reserves. available = visibleTotal(funds) −
  // committedSpend is lag-invariant: acquiring a hold moves money balance→hold (visibleTotal
  // unchanged) while committedSpend tracks our commitments; a settle drops visibleTotal by the
  // real cost and we drop committedSpend by the (larger) reservation, so available rises by the
  // freed room. Because the reservation now bounds the charge rather than the hold, available is
  // a true spendable figure instead of an under-count of it.
  let committedSpend = 0;
  let factCheckInFlight = 0;
  // Absolute batch deadline (ms), set once when the waitlist first fills; NOT reset by a re-queue.
  let factCheckBatchDeadline = 0;
  let factCheckBatchTimer: ReturnType<typeof setTimeout> | null = null;

  /** Worst-case settled charge for one Fact-Check All classification — the reserve each admitted
   *  claim holds against the balance. classify-tweets settles at `cost * FEE_MULTIPLIER` with no
   *  margin, so this is the same fee-recovered worst case as its own hold. Both sides sum the SAME
   *  three terms — Gemini streams, paid searches, and the post-research annotation — and apply
   *  fee-recovery once to the total; the terms mirror classify-tweets' `const INPUT_LIMIT` block
   *  plus its `annotWorstAtLimit`. Change the backend formula and this together. */
  const CLASSIFICATION_RESERVE = (() => {
    const GEMINI_IN = 0.75, GEMINI_OUT = 3.75, OUTPUT_LIMIT = 2000;   // gemini-3.6-flash
    const INPUT_LIMIT = 6000, SEARCH_CONTEXT_TOKENS = 4000, GEMINI_STREAMS = 4;
    // The research prompt's own scaffolding — synthesizer header, return schema, verdict
    // instructions and the date note — rides in every stream. Sized on the shipped prompt
    // in classify-tweets (≈3,760 by its own estimateTokens for a typical locale).
    const RESEARCH_PROMPT_TOKENS = 3800;
    const TAVILY_SEARCH_COST = 0.016, EXA_DEEP_COST = 0.012;
    // The annotation agent tries Gemini 3.6 Flash first (no markup), then the
    // OpenRouter tiers — qwen3.8-27b's dearest route plus OpenRouter's 5.5%. A Gemini
    // call that fails to start can still bill its prefill, so both routes are added.
    const ANNOT_GEMINI_IN = 0.75, ANNOT_GEMINI_OUT = 3.75;   // gemini-3.6-flash
    const ANNOT_FALLBACK_IN = 0.99, ANNOT_FALLBACK_OUT = 2.20, ANNOT_FALLBACK_FEE = 1.055;
    const ANNOT_INPUT_LIMIT = 20000, ANNOT_OUTPUT_LIMIT = 2000;
    const FEE_MULTIPLIER = (4 / 3) * 1.03;   // Apple/Stripe take + FX
    const geminiWorst = (((INPUT_LIMIT + SEARCH_CONTEXT_TOKENS + RESEARCH_PROMPT_TOKENS) * GEMINI_IN + OUTPUT_LIMIT * GEMINI_OUT) / 1e6) * GEMINI_STREAMS;
    const searchWorst = TAVILY_SEARCH_COST * 2 + EXA_DEEP_COST;
    const annotWorst = (ANNOT_INPUT_LIMIT * ANNOT_GEMINI_IN + ANNOT_OUTPUT_LIMIT * ANNOT_GEMINI_OUT) / 1e6
      + ((ANNOT_INPUT_LIMIT * ANNOT_FALLBACK_IN + ANNOT_OUTPUT_LIMIT * ANNOT_FALLBACK_OUT) / 1e6) * ANNOT_FALLBACK_FEE;
    return (geminiWorst + searchWorst + annotWorst) * FEE_MULTIPLIER;
  })();

  /** Money free to commit now, in lag-invariant terms (unknown funds → optimistic). */
  function availableToSpend(): number {
    if (!fundsState) return Infinity;
    return visibleTotal(fundsState) - committedSpend;
  }

  /** Enqueue an on-hold claim for Fact-Check All (arrival order from preclassify = tweet order).
   *  Idempotent: a claim already waiting, in flight, or abandoned this batch is ignored. Does not
   *  flip the claim's UI — admitFactCheckClaim does that when the classification actually starts. */
  function enqueueFactCheckClaim(classificationId: string, claimText: string, batchId: string, locale: string): void {
    const key = `${classificationId}:${claimText}`;
    if (factCheckWaitlistKeys.has(key) || ongoingClaimRefreshes.has(key) || abandonedFactCheckKeys.has(key)) return;
    const hit = classificationCache.get(classificationId);
    const claim = hit?.classification.claims?.find(cl => cl.text === claimText);
    if (!claim || !claim.reclassifyOnHold) return;
    // Only a claim whose DB row is known can be decided here: the row is what says whether a
    // classified claim already answers this text. A claim still waiting on its row is
    // re-enqueued by the broadcast that delivers the row (see broadcastClassification).
    if (!claim.dbClaimId) return;
    const reserve = CLASSIFICATION_RESERVE;
    factCheckWaitlist.push({ classificationId, claimText, batchId, locale, reserve, attempts: 0 });
    factCheckWaitlistKeys.add(key);
    if (factCheckBatchDeadline === 0) { factCheckBatchDeadline = Date.now() + FACTCHECK_BATCH_TIMEOUT_MS; armBatchTimer(); }
    pumpWaitlist();
  }

  /** (Re)start the single timer guarding the Fact-Check All batch deadline. */
  function armBatchTimer(): void {
    if (factCheckBatchTimer) clearTimeout(factCheckBatchTimer);
    factCheckBatchTimer = setTimeout(onBatchTimeout, Math.max(0, factCheckBatchDeadline - Date.now()));
  }

  /** Batch 30s elapsed: abandon every claim STILL WAITING (in-flight ones keep going).
   *  A claim in flight means the queue is draining, not stuck — under a balance too small for
   *  parallel admission it drains ONE at a time, and each run legitimately outlasts the window.
   *  So roll the deadline forward instead of abandoning the tail, and let the next settle admit
   *  (pumpWaitlist runs there). Only a window that closes with nothing in flight is really stuck:
   *  nothing can be admitted, so no settle is coming to revive the queue. */
  function onBatchTimeout(): void {
    factCheckBatchTimer = null;
    if (factCheckInFlight > 0) {
      factCheckBatchDeadline = Date.now() + FACTCHECK_BATCH_TIMEOUT_MS;
      armBatchTimer();
      return;
    }
    if (factCheckWaitlist.length > 0) {
      for (const item of factCheckWaitlist.splice(0, factCheckWaitlist.length)) abandonWaitingClaim(item);
      notifyError(ERROR_CODES.BALANCE_TOO_LOW);
    }
    maybeEndBatch();
  }

  /** Admit every front claim the balance funds in full; once it can't, admit exactly one and stop
   *  until it settles. Parallel admission needs the FULL reserve for each claim, because all of
   *  them settle against the same balance at once. A partly-funded head does not need to be
   *  refused, though — one claim at a time is safe, since the backend's own gate is only that the
   *  balance is > 0 and a run that overshoots what's left merely dips it negative and blocks the
   *  next one. Refusing here instead would block a user whose balance is positive but small. */
  function pumpWaitlist(): void {
    while (factCheckWaitlist.length > 0) {
      const avail = availableToSpend();
      if (avail >= CLASSIFICATION_RESERVE) {
        admitFactCheckClaim(factCheckWaitlist.shift()!);
        continue; // still fully funded — another claim can safely run alongside it
      }
      // `avail > 0` is the lag-invariant reading of the backend's gate: acquire_hold refuses only
      // while the balance is ≤ 0, and takes LEAST(balance, requested) rather than rejecting a
      // request larger than the balance. With nothing in flight, committedSpend is 0, so avail is
      // the balance itself.
      if (avail > 0 && factCheckInFlight === 0) admitFactCheckClaim(factCheckWaitlist.shift()!);
      break;
    }
    maybeEndBatch();
  }

  /** Drop a waiting claim, mark it abandoned, and revert it to its on-hold button. */
  function abandonWaitingClaim(item: WaitlistItem): void {
    const key = `${item.classificationId}:${item.claimText}`;
    factCheckWaitlistKeys.delete(key);
    abandonedFactCheckKeys.add(key);
    revertClaimToOnHold(item.classificationId, item.claimText, item.batchId);
  }

  /** Broke (balance + hold ≤ 0) → no settle can revive it: purge every WAITING claim (in-flight
   *  ones settle on their own). Shows the error once. */
  function purgeWaitlistIfBroke(): void {
    if (!fundsState) return;
    if (fundsState.balance > 0 || (Number(fundsState.hold) || 0) > 0) return;
    if (factCheckWaitlist.length === 0) return;
    for (const item of factCheckWaitlist.splice(0, factCheckWaitlist.length)) abandonWaitingClaim(item);
    notifyError(ERROR_CODES.BALANCE_TOO_LOW);
    maybeEndBatch();
  }

  /** Tear down the batch timer/deadline once nothing is waiting or in flight. */
  function maybeEndBatch(): void {
    if (factCheckWaitlist.length > 0 || factCheckInFlight > 0) return;
    if (factCheckBatchTimer) { clearTimeout(factCheckBatchTimer); factCheckBatchTimer = null; }
    factCheckBatchDeadline = 0;
  }

  /** Flip a claim between on-hold and researching in the cache; returns the updated snapshot. */
  function flipClaimResearching(classification: Classification, claimText: string, batchId: string, toResearching: boolean): Classification {
    const updatedClaims = classification.claims?.map(cl => {
      if (cl.text !== claimText) return cl;
      if (toResearching) {
        if (!cl.reclassifyOnHold) return cl;
        return { ...cl, reclassifyOnHold: false, refreshing: true,
          verdict: cl.cachedVerdict ?? cl.verdict, note: cl.cachedNote ?? cl.note,
          confidence: cl.cachedConfidence ?? cl.confidence, veracity: cl.cachedVeracity ?? cl.veracity,
          sources: cl.cachedSources ?? cl.sources };
      }
      return { ...cl, reclassifyOnHold: true, refreshing: false };
    }) ?? null;
    const anyOnHold = updatedClaims?.some(cl => cl.reclassifyOnHold) ?? false;
    const restored: Classification = { ...classification, claims: updatedClaims, reclassifyOnHold: anyOnHold || undefined };
    restored.batchId = batchId;
    cacheClassification(restored, batchId);
    return restored;
  }

  /** Revert a claim to its on-hold button (any failed backend call) and broadcast it. */
  function revertClaimToOnHold(classificationId: string, claimText: string, batchId: string): void {
    const hit = classificationCache.get(classificationId);
    if (!hit) return;
    broadcastClassification(flipClaimResearching(hit.classification, claimText, batchId, false));
  }

  /** End a claim's research flags once a run WE own is over, restating what the claim
   *  actually holds.
   *
   *  `revertClaimToOnHold` fires only when a run delivered nothing at all
   *  (`!(handled || gotUpdate)`), and `gotUpdate` latches on the first streamed chunk
   *  — so a run that streamed a snapshot but never a settled one leaves `refreshing`
   *  set for the life of the cache. `refreshing` both suppresses the Annotate
   *  affordance and paints the spinner, so the claim wears a wheel with nothing behind
   *  it and never recovers: the page has to be reloaded, and a reload re-runs the same
   *  shape. Only a settled delivery clears the flag, and branch 3 of
   *  `mergeClaimPayload` is the only thing that produces one.
   *
   *  A claim that came to rest is left alone — the delivery that settled it owns the
   *  state. A claim still flagged when the run ends is restated: with its own research
   *  results when it has them (verdict badge, or the idle Annotate button when its
   *  annotation dict is still keyless), otherwise on its on-hold button so it can be
   *  retried. `wasOnHold` preserves the paid re-run: a change-prone claim's Fact-Check
   *  button is never displaced by Annotate. Callers must NOT run this when `handled` is
   *  set — the flag then belongs to another in-flight run, and clearing it would kill a
   *  wheel that is legitimately spinning. */
  function settleClaimResearch(classificationId: string, claimText: string, batchId: string, wasOnHold: boolean): void {
    const hit = classificationCache.get(classificationId);
    const cached = hit?.classification.claims;
    const target = cached?.find(cl => cl.text === claimText);
    if (!hit || !cached || !target) return;
    // Not flagged any more → the run settled it. Nothing to restate.
    if (target.refreshing !== true && target.isClassifying !== true) return;
    const hasVerdict = target.note !== undefined && target.note !== null && String(target.note).trim() !== "";
    const restated: Claim = {
      ...target,
      refreshing: false,
      isClassifying: false,
      reclassifyOnHold: wasOnHold || !hasVerdict,
    };
    const claims = cached.map(cl => (cl.text === claimText ? restated : cl));
    const anyOnHold = claims.some(cl => cl.reclassifyOnHold);
    const merged: Classification = { ...hit.classification, claims, reclassifyOnHold: anyOnHold || undefined };
    merged.batchId = batchId;
    cacheClassification(merged, batchId);
    broadcastClassification(merged);
  }

  /** Start one admitted Fact-Check-All classification: reserve its worst-case charge, flip it to
   *  researching, run pull-then-classify, and on completion release the reservation and either
   *  finish or (on a rare backend balance-too-low) re-queue once / abandon. Mirrors the old
   *  releaseFreshResearchClaim. */
  function admitFactCheckClaim(item: WaitlistItem): void {
    const { classificationId, claimText, batchId, locale, reserve } = item;
    const key = `${classificationId}:${claimText}`;
    factCheckWaitlistKeys.delete(key);

    const hit = classificationCache.get(classificationId);
    const targetClaim = hit?.classification.claims?.find(cl => cl.text === claimText);
    if (!hit || !targetClaim || !targetClaim.reclassifyOnHold) { maybeEndBatch(); return; }

    committedSpend += reserve;
    factCheckInFlight++;
    ongoingClaimRefreshes.add(key);
    const restored = flipClaimResearching(hit.classification, claimText, batchId, true);
    broadcastClassification(restored);

    const cachedTweet = tweetCache.get(classificationId);
    const tweetUrls = cachedTweet ? extractTweetUrls(cachedTweet.text) : undefined;
    let hitBalanceError = false;
    let gotUpdate = false;
    let handled = false;
    const researchPromise = (async () => {
      try {
        handled = await pullClaimBeforeClassify(classificationId, claimText, locale);
        if (!handled) {
          // Re-read fresh: pullClaimBeforeClassify may have just merged this claim's
          // dbClaimId into the cache (via the tweet/claim subscription broadcast), and
          // `restored` was snapshotted before that happened. Using the stale snapshot
          // here would send classify-tweets no id, forcing its fuzzy text-match fallback
          // — which, on a miss, inserts a duplicate claim row instead of updating this one.
          const freshCls = classificationCache.get(classificationId)?.classification ?? restored;
          // Flow A's annotation persist broadcasts tweet-scoped, so it needs a
          // live tweet subscription to reach the client (see helper).
          await ensureAnnotationSubscription(classificationId, claimText, locale);
          const annotLoc = await annotLocatorsFor(classificationId, freshCls.claims, claimText, freshCls)
            ?? await annotLocatorsFor(classificationId, freshCls.quoting?.claims, claimText, freshCls);
          for await (const updated of refreshClaim(freshCls, claimText, researchCache, locale, tweetUrls, () => { hitBalanceError = true; }, annotLoc)) {
            gotUpdate = true;
            // Locators rode along, so the worker's silent post-research run is in
            // flight — tell the content script to show "Annotating", not idle Annotate.
            mergeSingleClaimAndBroadcast(classificationId, claimText, updated, batchId, { withLocators: !!annotLoc, annotatedLocale: annotLoc?.textLocale });
          }
          if (annotLoc) await settleFlowAAnnotations(classificationId, claimText, annotLoc, batchId);
        }
      } catch (err: any) {
        console.error("[background] admitFactCheckClaim error:", err);
      } finally {
        committedSpend = Math.max(0, committedSpend - reserve);
        factCheckInFlight = Math.max(0, factCheckInFlight - 1);
        ongoingClaimRefreshes.delete(key);
        if (!(handled || gotUpdate)) {
          // Any backend failure: revert to the on-hold button (retry affordance).
          if (hitBalanceError && item.attempts + 1 < MAX_CLASSIFY_ATTEMPTS) {
            factCheckWaitlistKeys.add(key); // re-queue to END, one more try; deadline NOT reset
            factCheckWaitlist.push({ ...item, attempts: item.attempts + 1 });
          } else {
            abandonedFactCheckKeys.add(key);
            if (hitBalanceError) notifyError(ERROR_CODES.BALANCE_TOO_LOW); // non-balance failures already notified
          }
          revertClaimToOnHold(classificationId, claimText, batchId);
        } else if (!handled) {
          // Streamed a snapshot but never settled the claim: the flags would outlive
          // the run and strand the spinner. (Reverting here would also drop the
          // waitlist bookkeeping above that this branch must not touch.)
          settleClaimResearch(classificationId, claimText, batchId, true);
        }
        pumpWaitlist();
      }
    })();
    // Track so awaitTweetClaimResearch (placeholder-upsert gate) waits for this classification.
    trackClaimResearch(key, researchPromise);
  }

  /** The extension is "active" (does anything on X) only while signed in AND with a
   *  positive balance. A logged-out user OR a zero/negative balance freezes it. */
  async function computeActive(): Promise<boolean> {
    return (await isSignedIn()) && balanceOk();
  }

  /** Drop every cache, pending fetch, and open subscription so a later re-login
   *  starts from a clean slate with no stale tweets/claims. */
  function clearAllPipelineState() {
    for (const sub of tweetSubs.values()) { try { sub.close(); } catch { /* ignore */ } }
    tweetSubs.clear();
    for (const set of lingeringTweetSubs.values()) {
      for (const sub of set) { try { sub.close(); } catch { /* ignore */ } }
    }
    lingeringTweetSubs.clear();
    for (const sub of claimSubs.values()) { try { sub.close(); } catch { /* ignore */ } }
    claimSubs.clear();
    classificationCache.clear();
    researchCache.clear();
    batchTweets.clear();
    tweetCache.clear();
    localizedHighlightLocales.clear();
    reResearchedTweetIds.clear();
    onHoldTweets.clear();
    // Drop parked taps too: the pipeline they belong to is being torn down
    // (sign-out or freeze). A stale tap must never fire on a later session's
    // re-sent batch and spend on an intent long abandoned.
    for (const pending of pendingProcessOnHold.values()) clearTimeout(pending.timer);
    pendingProcessOnHold.clear();
    ongoingClaimRefreshes.clear();
    claimResearchPromises.clear();
    heldReclassifications.clear();
    pendingFreshResearchClaims.clear();
    researchRequestedBeforeRow.clear();
    factCheckAllTweetIds.clear();
    factCheckAllScopedTexts.clear();
    // Reset the Fact-Check All waitlist so a logout/freeze leaves no stale holds or timer.
    factCheckWaitlist.length = 0;
    factCheckWaitlistKeys.clear();
    abandonedFactCheckKeys.clear();
    committedSpend = 0;
    factCheckInFlight = 0;
    factCheckBatchDeadline = 0;
    if (factCheckBatchTimer) { clearTimeout(factCheckBatchTimer); factCheckBatchTimer = null; }
    dbHitCache.clear();
    dbFetchPromises.clear();
    dbMissHashes.clear();
    seenInDom.clear();
    domFetchResolvers.clear();
    clearLookupMemo();
    persistSelectionPipeline();
  }

  // Keep the whole extension in sync with sign-in AND balance. On a transition to
  // inactive (signed out, or balance ≤ 0) we clear pipeline state and freeze every
  // content script; on active we (re)open the funds hub and resume. Serialized +
  // guarded by `lastActive` so rapid events don't double-fire. When signed out we
  // also tear the funds hub down; on a mere zero-balance we keep it running so a
  // later top-up is detected and re-activates the extension.
  let lastActive: boolean | null = null;
  /** Whether the last evaluation saw a session. Distinct from `lastActive`, which is also
   *  false for a signed-in user with no balance. See the `clearNativeAccount` call below. */
  let lastSignedIn = false;
  let activeEvalChain: Promise<void> = Promise.resolve();
  /** Re-evaluate whether the extension should be active (signed in AND in credit) and,
   *  when that answer flips, either resume the content scripts or tear the pipeline down.
   *
   *  Serialized through activeEvalChain because sign-in and balance events can land
   *  together; running two evaluations concurrently could otherwise interleave and leave
   *  the relays with the wrong state. */
  function refreshActiveState() {
    activeEvalChain = activeEvalChain.then(async () => {
      // Safari: the app may have signed in, or renewed, while this context was asleep.
      // Taking the shared record before anything reads the session is what keeps a device
      // signed in through the app from being evaluated here as signed out — which would
      // freeze every relay and drop every injection. A profile that already holds a live
      // session is untouched: this only fills an empty or expired slot.
      if (import.meta.env.SAFARI) {
        // Before adoption, not after: a sign-out in the app is what makes this profile's copy
        // the last one standing, and adopting first would only hand it back the session the
        // user just ended.
        try { await endSessionSignedOutInApp(); }
        catch { /* best-effort: the poll below asks again */ }
        try { await adoptNativeSession(SUPABASE_AUTH_STORAGE_KEY); }
        catch { /* best-effort: the record is read again at the next refresh */ }
      }
      const signed = await isSignedIn();
      /** The state we are leaving. Read BEFORE the account-switch block below, which
       *  sets `lastActive = null` whenever the uid changes — and a uid change is exactly
       *  what a sign-out looks like (`currentUserId()` goes to null whether the user
       *  chose it or the server evicted the session). Reading it after that block would
       *  therefore see null on every sign-out and never recognise the transition. */
      const prevActive = lastActive;
      // Account switches must be caught BEFORE the `lastActive` guard below. Signing out
      // of a ZERO-balance account leaves active already false, so that guard returned
      // early and the teardown further down never ran — the next account then inherited
      // the previous one's cached $0 balance and its Realtime subscription, because
      // initFundsHub() saw a live fundsInitPromise and no-opped. Chrome's MV3 service
      // worker dying between sessions wiped this state and hid the bug; Safari/Firefox
      // MV2 use a persistent background page, so it survived every switch.
      const uid = await currentUserId();
      if (uid !== fundsHubUid) {
        teardownFundsHub();
        fundsHubUid = uid;
        lastActive = null; // re-broadcast for the new account rather than assume no change
      }
      if (signed) initFundsHub(); // ensure funds hub is up so balance is known
      // Revoke the app's copy of the identity the moment we know nobody is signed in. Placed here
      // because this runs on sign-out, on sign-in, and on every account switch — the three events
      // after which the app's stored identity could otherwise be someone else's.
      //
      // Only on a transition OUT of a session, and only now that the app can hold one the
      // extension does not: adoption above is a native round trip, and one that fails while
      // the app is signed in leaves `signed` false with a perfectly good session on the
      // other side. Unconditional, this call turned that hiccup into a sign-out the user
      // never asked for — the one thing sharing the session is meant to make impossible.
      // A chosen sign-out reaches the app directly from the popup as well, so nothing is
      // lost by waiting for a transition here.
      const signedBefore = lastSignedIn;
      lastSignedIn = signed;
      if (!signed && signedBefore) clearNativeAccount();
      const active = signed && balanceOk();
      if (lastActive === active) return;
      /** Whether the extension was live a moment ago, so the sign-out notification further
       *  down can tell a real ACTIVE → signed-out transition from every other way of
       *  landing here (a cold start with no session at all, or a signed-out tab the user
       *  simply opened) — `prevActive` is null on those, and null never notifies. */
      const wasActive = prevActive;
      // [ttft-ext] Every active/inactive flip, with the inputs that produced it — this is
      // the ONLY path that calls clearAllPipelineState(), which wipes every open tweet/
      // claim subscription. If this fires mid-test, that's what's killing them all at once.
      console.log(`[ttft-ext] refreshActiveState: ${lastActive} -> ${active} (signed=${signed}, fundsState=${fundsState ? JSON.stringify(fundsState) : 'null'})`);
      lastActive = active;
      if (active) {
        broadcastActive(true);
      } else {
        clearAllPipelineState();
        if (!signed) teardownFundsHub(); // keep the hub alive on a zero-balance
        broadcastActive(false);
        /** Say so, when a session disappears from under a signed-in user.
         *
         *  Without this the extension simply goes quiet: `broadcastActive(false)` freezes
         *  every relay and `setExtensionFrozen` removes every injection, so the buttons
         *  vanish and nothing explains why. The cause is usually the rate-limit ban —
         *  `increment_usage` sets `banned_until` and runs
         *  `DELETE FROM auth.sessions` whenever any metered window is exceeded, so the
         *  slot empties server-side and this storage-driven evaluation is the first the
         *  client hears of it, up to an hour after the ban (the client keeps working on
         *  its still-valid access token until that expires and its refresh 400s).
         *
         *  Deliberately AFTER broadcastActive(false), not before: freezing the relays
         *  calls removeAllInjections, which deletes `.mf-notif-container` along with
         *  everything else, so a notification sent first would be wiped before it could
         *  be read. Sent here it arrives at an already-frozen relay, which is the one
         *  state `showNotification`'s guard lets `NOT_SIGNED_IN` through in (see
         *  utils/injecting.ts) — the mechanism this case was built for, and its text is
         *  already localized in every locale, so no new string is owed.
         *
         *  Only when the user did NOT choose this. A deliberate sign-out reaches here
         *  looking identical from storage alone, so the popup leaves a short-lived marker
         *  (INTENTIONAL_SIGNOUT_KEY) and we stay quiet when we find one — announcing
         *  "you're not signed in, please sign in" to someone who just clicked Sign Out,
         *  or to someone switching accounts, would be worse than the silence this whole
         *  change exists to fix. */
        if (wasActive === true && !signed && !(await consumeIntentionalSignOut())) {
          notifyError(ERROR_CODES.NOT_SIGNED_IN);
        }
      }
    }).catch(e => console.error('[background] refreshActiveState error:', e));
  }

  // The supabase session lives in chrome.storage.local; sign-in/out from the popup
  // updates it there, so watching storage is the reliable cross-context trigger.
  try {
    browser.storage.onChanged.addListener((changes: Record<string, any>, area: string) => {
      if (area !== 'local') return;
      if (Object.keys(changes).some(k => k.includes('auth-token') || k.startsWith('sb-'))) {
        refreshActiveState();
      }
    });
  } catch (e) { console.error('[background] storage.onChanged setup error:', e); }
  // Also react to this client's own auth events (token refresh, etc.).
  supabase.auth.onAuthStateChange(() => refreshActiveState());

  // Establish the baseline on service-worker startup (inits funds if signed in).
  refreshActiveState();

  // ── Dashboard messages: fetched on startup + every 24h, cached in storage ──
  const MESSAGES_URL = 'https://messages.michael-pouget01.workers.dev/';
  const MESSAGES_ALARM = 'mf_messages_refresh';
  const MESSAGES_MAX_AGE_MS = 24 * 60 * 60 * 1000;

  /** Fetch the remote service-message list and cache it with a timestamp. Returns an
   *  empty list on any failure — these messages are advisory, so a fetch error must not
   *  surface to the user. */
  async function fetchAndStoreMessages(): Promise<any[]> {
    try {
      const response = await fetch(MESSAGES_URL);
      if (!response.ok) return [];
      const data = await response.json();
      const list = Array.isArray(data) ? data : [];
      await browser.storage.local.set({ mf_messages: list, mf_messages_at: Date.now() });
      return list;
    } catch (e) {
      console.error('[background] messages fetch error:', e);
      return [];
    }
  }

  /** Service messages for the popup, from cache when recent enough, otherwise refetched. */
  async function getMessagesFresh(): Promise<any[]> {
    const stored = await browser.storage.local.get(['mf_messages', 'mf_messages_at']);
    const fetchedAt = typeof stored.mf_messages_at === 'number' ? stored.mf_messages_at : 0;
    const cached = Array.isArray(stored.mf_messages) ? stored.mf_messages : null;
    if (cached && Date.now() - fetchedAt < MESSAGES_MAX_AGE_MS) return cached;
    return await fetchAndStoreMessages();
  }

  // ── Collecting an iOS sign-in hand-off ──
  //
  // On iOS the provider redirects into the containing app, because an app extension cannot
  // present the ASWebAuthenticationSession that would catch it (see utils/nativeHost.ts and
  // TopUpHandoff.swift). The app can only PARK what it caught; building the session needs this
  // side, which holds the PKCE verifier. So the flow ends with the extension asking, and there
  // are two askers by design: the popup on open — the fast path, since that is where the user
  // already is — and the funds alarm below, which is what makes sign-in complete without the
  // user having to open anything at all.

  /** Written by the popup before the provider's tab opens; see it for why. */
  const AUTH_PENDING_KEY = 'mf_auth_pending_at';

  /** How long a started hand-off is worth collecting.
   *
   *  The authorization code inside expires long before this, so the real job is to bound the
   *  polling: an abandoned sign-in must not leave a native round trip running on a one-minute
   *  alarm for the rest of the session. */
  const AUTH_PENDING_MAX_AGE_MS = 30 * 60 * 1000;

  /** Whether a hand-off may still be waiting. Read-and-cleared once stale, so an abandoned
   *  marker cannot outlive the flow it described and keep both askers asking forever. */
  async function isAuthPending(): Promise<boolean> {
    try {
      const stored = await browser.storage.local.get(AUTH_PENDING_KEY);
      const at = stored?.[AUTH_PENDING_KEY];
      if (typeof at !== 'number') return false;
      if (Date.now() - at <= AUTH_PENDING_MAX_AGE_MS) return true;
      await browser.storage.local.remove(AUTH_PENDING_KEY);
      return false;
    } catch { return false; }
  }

  /** The hand-off is over, whatever it did — nothing left for either asker to collect. */
  async function clearAuthPending(): Promise<void> {
    try { await browser.storage.local.remove(AUTH_PENDING_KEY); } catch { /* best-effort */ }
  }

  /** The provider tab the popup opened for an iOS sign-in; see it for why. */
  const AUTH_TAB_KEY = 'mf_auth_tab_id';

  /** Closes the tab a finished iOS sign-in leaves behind.
   *
   *  Safari takes the `disinfax://` redirect into the containing app and abandons the tab on the
   *  provider's last page, still spinning — so a sign-in that worked looks exactly like one that
   *  hung. Closing it is the only signal the flow gives, and it is the one the old callback page
   *  used to give by closing itself.
   *
   *  Called on success only. A failed exchange leaves the tab where it is on purpose: the popup
   *  reports the failure when the user next opens it, and pulling the tab out from under a
   *  rejection they are still reading would take away the only thing on screen.
   *
   *  Key removed before the attempt, so a tab that is already gone cannot leave the id sitting
   *  there to be closed twice on some later sign-in. */
  async function closeAuthTab(): Promise<void> {
    try {
      const stored = await browser.storage.local.get(AUTH_TAB_KEY);
      const tabId = stored?.[AUTH_TAB_KEY];
      await browser.storage.local.remove(AUTH_TAB_KEY);
      if (typeof tabId === 'number') await browser.tabs.remove(tabId);
    } catch { /* already closed, or never recorded — nothing to undo */ }
  }

  /** Turns a provider callback URL into a session. Both Safari transports end here — macOS is
   *  handed the URL by ASWebAuthenticationSession, iOS collects it from the app — so the two
   *  cannot drift apart about which half carries the credential.
   *
   *  PKCE puts `?code=` in the query and the implicit grant puts the tokens in the fragment;
   *  utils/supabase.ts sets no flowType, so the default applies and both are read.
   *
   *  Returns an error message, or null once the session is established. */
  async function completeOAuthCallbackUrl(callbackUrl: string): Promise<string | null> {
    let parsed: URL;
    try { parsed = new URL(callbackUrl); } catch { return 'The sign-in reply was not a usable URL.'; }
    const hashParams = new URLSearchParams(parsed.hash.replace(/^#/, ''));

    // A provider-side rejection rides in either half; its own message is more use than ours.
    const errorDescription = parsed.searchParams.get('error_description')
      ?? hashParams.get('error_description');
    if (errorDescription) return errorDescription;

    const code = parsed.searchParams.get('code');
    if (code) {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      return error?.message ?? null;
    }
    const accessToken = hashParams.get('access_token') ?? parsed.searchParams.get('access_token');
    const refreshToken = hashParams.get('refresh_token') ?? parsed.searchParams.get('refresh_token');
    if (accessToken && refreshToken) {
      const { error } = await supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      });
      return error?.message ?? null;
    }
    return 'The sign-in reply carried no code or tokens.';
  }

  /** Asks the app whether it is holding a callback, and completes the sign-in if it is. */
  async function pullPendingNativeAuth(): Promise<{ ok?: boolean; pending?: boolean; error?: string }> {
    // A real timeout, unlike the popup-initiated calls it otherwise mirrors: there is no UI
    // sheet to wait on here, and the alarm tick must not hang because an app that is not
    // running never answers. Long enough to cover the appex being woken from cold.
    const NATIVE_TIMEOUT_MS = 30 * 1000;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const res: any = await Promise.race([
        (browser.runtime as any).sendNativeMessage(NATIVE_APP_ID, { action: 'GET_PENDING_AUTH' }),
        new Promise((_resolve, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error('The DisinfaX app did not respond.')),
            NATIVE_TIMEOUT_MS,
          );
        }),
      ]).finally(() => { if (timeoutId !== undefined) clearTimeout(timeoutId); });

      const callbackUrl = res?.callbackUrl;
      // Nothing parked yet — the user may still be on the provider's page. The pending marker
      // stays, so the next read asks again.
      if (typeof callbackUrl !== 'string' || !callbackUrl) return { pending: false };

      const error = await completeOAuthCallbackUrl(callbackUrl);
      // Cleared either way. The app hands a parked callback over once and forgets it, and a
      // code that failed to exchange cannot be exchanged again — so a marker left set would
      // only have the alarm keep asking for something that is already gone.
      await clearAuthPending();
      if (error) return { error };
      // The user is signed in, so the tab they were left staring at has done its job. Closing
      // it is the completion signal the flow otherwise does not have.
      await closeAuthTab();
      // Bring the pipeline up for the newly signed-in account before the user gets back to
      // the popup, so the balance is already known when they reopen it.
      refreshActiveState();
      return { ok: true };
    } catch (e: any) {
      // Deliberately NOT cleared: an unreachable app is transient, and the marker is what
      // gives the next tick the right to try again — until it ages out.
      return { error: e?.message || 'Could not reach the DisinfaX app.' };
    }
  }

  // Refresh on startup and every 24 hours.
  fetchAndStoreMessages();
  try {
    browser.alarms.create(MESSAGES_ALARM, { periodInMinutes: 24 * 60 });

    browser.alarms.onAlarm.addListener((alarm: any) => {
      if (alarm.name === MESSAGES_ALARM) fetchAndStoreMessages();
    });

    // Safari's background page is non-persistent, so Safari suspends it while the user is in the
    // containing app — and a suspended page holds no Realtime connection, so a balance credited
    // server-side during that window reaches nobody. The observed symptom was exactly that: the
    // app's balance moved only on returning to Safari, because returning is what woke this page.
    //
    // An alarm is the sanctioned way to wake a suspended background page. One minute is the floor
    // the browsers enforce, so that is the worst-case staleness. The wake alone is usually enough
    // (a reloaded page re-runs refreshActiveState, which syncs) but funds are read explicitly too,
    // for when the page was alive all along and only its channel had gone quiet.
    //
    // Everything lives INSIDE the guard, constant included: declared outside it, the alarm name
    // string survived into the Chromium and Firefox bundles even with all its uses eliminated.
    if (import.meta.env.SAFARI) {
      const FUNDS_SYNC_ALARM = 'mf_funds_native_sync';
      browser.alarms.create(FUNDS_SYNC_ALARM, { periodInMinutes: 1 });
      browser.alarms.onAlarm.addListener((alarm: any) => {
        if (alarm.name !== FUNDS_SYNC_ALARM) return;
        (async () => {
          try {
            // A hand-off the user completed on the provider's page is sitting in the app, and
            // this tick is the only thing that can reach it without the user reopening the
            // popup. Checked BEFORE the signed-in gate below, because being signed out is
            // exactly the state it runs in — that gate would return first and never look.
            if (await isAuthPending()) {
              const pulled = await pullPendingNativeAuth();
              if (pulled.error) console.warn('[background] pending sign-in hand-off failed:', pulled.error);
            }
            if (!(await isSignedIn())) return;
            // Before the funds read, not after: `get_funds` authenticates with the same token, so
            // an expired one fails the read and the sync below never runs at all — which is how a
            // browser left open on an idle page stopped reporting in. Also what gives
            // `nativeSessionHandover` a token worth passing on.
            await ensureFreshSession();
            await initFundsHub();
            const funds = await getFunds();
            if (funds) handleFundsChange(funds);
          } catch (e: any) {
            console.warn('[background] funds sync alarm failed:', e?.message || e);
          }
        })();
      });

      // The app's sign-out, asked for rather than waited on. The alarm above is the floor on
      // staleness once this page is suspended — Safari's minimum period, and a page woken from
      // cold re-runs `refreshActiveState`, which asks too. This is what makes it immediate while
      // the page is awake, which on a Mac and in Split View is the whole time: without it the
      // app's sign-out would not reach Safari until the access token expired, an hour on.
      //
      // Cheap enough to run at this cadence: the check reads this profile's own storage first
      // and only then asks the app, so a signed-out profile costs nothing at all.
      const APP_SIGN_OUT_POLL_MS = 10_000;
      setInterval(() => { void endSessionSignedOutInApp(); }, APP_SIGN_OUT_POLL_MS);
    }
  } catch (e) { console.error('[background] alarms setup error:', e); }

  // After a Stripe checkout returns, the top-up is credited asynchronously by the
  // webhook — so poll get_funds for a short window and feed it through the normal
  // funds path. handleFundsChange → refreshActiveState broadcasts "resume" to the X
  // tabs the moment the balance turns positive, re-injecting the already-captured
  // tweets with no page reload. Belt-and-suspenders alongside the realtime push
  // (which can lag or be missed if the MV3 worker idled). balanceOk() still gates, so
  // this can only ever RESUME on a real positive balance — never bypass the freeze.
  /** After a checkout returns, poll for the credit instead of trusting Realtime alone:
   *  Stripe's webhook lands asynchronously, and the funds subscription may have been torn
   *  down while the balance sat at zero. Gives up after ~16s and lets Realtime take over. */
  async function pollFundsAfterCheckout() {
    for (let attempt = 0; attempt < 8; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      try {
        const funds = await getFunds();
        if (funds) {
          handleFundsChange(funds);
          if (funds.balance > 0) return; // credited → tabs resumed; stop polling
        }
      } catch (e) { console.error('[background] pollFundsAfterCheckout error:', e); }
    }
  }

  /** Fallback top-up destination when the popup cannot be opened programmatically
   *  (notably stable Firefox and Safari's intermittent false "already open"): the main
   *  site, where the user can sign in and find the top-up flow. Needs no user gesture. */
  function openTopUpFallback() {
    try {
      const maybe = browser.tabs.create({ url: 'https://disinfax.app' });
      if (maybe && typeof (maybe as any).catch === 'function') (maybe as any).catch(() => { /* ignore */ });
    } catch { /* ignore */ }
  }

  // ── Stripe checkout: poll for the credit once the checkout tab closes ──
  /** Where the id of the checkout tab we opened is parked.
   *
   *  It has to outlive the service worker: a Stripe session takes minutes and the MV3
   *  worker idles long before the user finishes paying. The listener below is registered
   *  at the top level for the same reason — one added *inside* openCheckoutTab is gone by
   *  then, which is exactly why the previous design needed a content script on the return
   *  page to send a backup message (and therefore needed the return page to be a host the
   *  extension already had access to). Reading the id back from storage on each wake lets
   *  a single top-level listener do the job, and `tabs.onRemoved` carries no URL, so
   *  nothing here needs host access to the return page.
   *
   *  `storage.session` deliberately: it is cleared when the browser restarts, so a stale
   *  id can never be matched by a new tab that happens to reuse the number. */
  const CHECKOUT_TAB_KEY = 'mfCheckoutTabId';

  browser.tabs.onRemoved.addListener((tabId) => {
    void (async () => {
      try {
        const stored = await browser.storage.session.get(CHECKOUT_TAB_KEY);
        if (stored?.[CHECKOUT_TAB_KEY] !== tabId) return;
        await browser.storage.session.remove(CHECKOUT_TAB_KEY);
        pollFundsAfterCheckout();
      } catch (e) {
        // Log rather than swallow: the only way this path breaks is by not running, and a
        // silent failure would look exactly like "the top-up worked but nothing resumed".
        console.error('[background] checkout tab close handling failed:', e);
      }
    })();
  });

  // Forget the frames a closed tab was known to have. They are only addressable while the
  // tab is open, and the store outlives this worker, so nothing else would ever clean them.
  browser.tabs.onRemoved.addListener((tabId) => {
    framesByTab.delete(tabId);
    selectionFrameByTab.delete(tabId);
    void (async () => {
      try {
        const stored = await browser.storage.session.get(FRAME_STORE);
        const all = stored?.[FRAME_STORE] as FrameLedger | undefined;
        if (!all?.[tabId]) return;
        delete all[tabId];
        await browser.storage.session.set({ [FRAME_STORE]: all });
      } catch { /* the entry is bounded by its TTL anyway */ }
    })();
  });

  /** Open Stripe checkout in a new tab. The user pays, lands on the DisinfaX success page
   *  and closes it — that close is the trigger to poll for the credit, and the poll only
   *  runs for a tab we opened. */
  function openCheckoutTab(url: string) {
    Promise.resolve(browser.tabs.create({ url })).then((tab: any) => {
      const tabId = tab?.id;
      if (tabId == null) return;
      return browser.storage.session.set({ [CHECKOUT_TAB_KEY]: tabId });
    }).catch((e: any) => console.error('[background] openCheckoutTab error:', e));
  }


  // ─────────────────────────────────────────────────────────────────────────
  // Fact-checking anywhere: webpage selections.
  //
  // The content script is injected on demand into ONE page (see
  // wxt.config.ts — `activeTab` + `scripting`, deliberately not an <all_urls>
  // content script), and it can only render: an MV3 content script's fetches are
  // subject to the host page's CORS, so every worker call and every claim research
  // must happen here. It is the same pipeline the X.com flow runs, keyed by a
  // synthetic id instead of a tweet id, so `REFRESH_CLAIM`, `pullClaimBeforeClassify`
  // and the balance gate all apply unchanged.
  // ─────────────────────────────────────────────────────────────────────────

  const SELECTION_MENU_ID = 'disinfax-selection';
  /** No leading slash, and it is not a style choice: `files` takes a path relative to the
   *  extension root, which is the form Safari's resource lookup is specified against.
   *  Chrome accepts either, so the slashless path is the one that works on both.
   *
   *  Two things about this file are easy to get wrong, and both fail the same way — as
   *  silence. A path Safari cannot resolve does not throw: Safari *resolves* the promise,
   *  so a refused injection returns here looking like a successful one. And the script is
   *  a root-level build output, so it is in the Safari app's bundle only because the Xcode
   *  project declares it; for a long time it did not, and the extension was shipping
   *  without the file while every other signal said the injection had worked. See the
   *  reply logged below, which is the only evidence that reaches the page.
   *
   *  The cast answers WXT's typing rather than any API: `ScriptPublicPath` is the union of
   *  this extension's built entrypoints, whose public paths all carry Chrome's leading
   *  slash. The value below is deliberately not one of those spellings. */
  const SELECTION_SCRIPT = 'selection.js' as ScriptPublicPath;

  /** What the isolated world reports back about itself. Read in `readIsolatedWorld` and
   *  logged next to the reply, because the reply alone cannot say whether a listener was
   *  there to answer it. */
  type IsolatedWorld = {
    href: string;
    readyState: string;
    flag: number | null;
    responder: string;
    browser: string;
    onMessage: string;
    selectionApi: string;
    /** The extension id the world's `browser` object answers to. Read because every reading
     *  above can look perfectly healthy in a world that is not ours — a listener installed on
     *  another extension's runtime answers none of our messages — and this is the one field
     *  that tells ours apart, by comparing it with `browser.runtime.id` here. */
    runtimeId: string | null;
  };

  /** Run `func` in the PAGE's own world and hand its return value back.
   *
   *  The selection has to be read here, in the page's world, and not from the page script:
   *  Safari gives an extension's isolated world a selection object of its own for each
   *  document, and that one stays empty while the page's holds the whole selection. Chrome
   *  shares a single selection across worlds, which is why reading it from the content
   *  script works there — and why the same code did nothing at all on Safari, where the
   *  read came back "collapsed, length 0" with the text still plainly selected on screen.
   *
   *  `func` rather than `files` so a value can come back: an injected file's return value is
   *  not reported to the injector, and a resolved injection is not a successful one. That
   *  distinction is the whole reason this feature could look like it was running while it
   *  was not doing anything.
   *
   *  `func` is serialized and run standalone, so it cannot close over anything here — every
   *  function passed to this is self-contained by necessity, not by style. */

  /** Run an injection in ONE frame of the tab, and in no other.
   *
   *  An unscoped injection also runs in every third-party iframe — whose domains Safari
   *  then gates one by one (the id5-sync.com ad-sync prompt on CBC). Naming a single
   *  frame keeps the single prompt for the site the user is actually on, and keeps the
   *  popup's tabs.sendMessage from being answered by a stale copy in a frame.
   *
   *  Which frame is named is the caller's business, and `frameId` is a parameter rather
   *  than the constant 0 because 0 is not always where the user acted: on a platform whose
   *  content lives in a same-origin frame (Naver Cafe's `#cafe_main`), a selection is made
   *  INSIDE that frame, and the frame's selection is not the top document's — measured:
   *  the frame held 40 characters while the document above it reported `rangeCount` 0 and
   *  an empty string. A script injected into frame 0 therefore cannot see the selection at
   *  all. The context menu is handed the frame the click came from (`info.frameId`) and
   *  targets that one; every other caller keeps frame 0, which is the whole of the page on
   *  every platform whose content is not framed.
   *
   *  Fails CLOSED when the scoped injection rejects (older Safari builds predate
   *  `frameIds` support): falling back to an unscoped injection there re-runs the
   *  file in every ad iframe and re-summons the per-domain prompts the scoping was
   *  built to prevent. The callers already treat a throw as "not injected" (the
   *  world probe logs `injected:false` and the flow declines with a named reason),
   *  so refusing beats prompting for a tracker. */
  async function execInFrame(tabId: number, frameId: number, spec: { files?: any; func?: () => any; world?: any }): Promise<any> {
    // `allFrames: false` is the documented default, but Safari has been observed
    // injecting into tracker iframes (id5-sync.com on CBC) when the target is
    // under-specified. Name both: the one frame asked for, never the ad frames.
    return await browser.scripting.executeScript({ target: { tabId, frameIds: [frameId], allFrames: false }, ...spec } as any);
  }

  async function runInPageWorld(tabId: number, frameId: number, func: () => any): Promise<any> {
    try {
      const results = await execInFrame(tabId, frameId, {
        world: 'MAIN',
        func,
      });
      return (results as any)?.[0]?.result ?? null;
    } catch (err: any) {
      // Safari has only supported `world` on executeScript recently, so an older build
      // refusing it is a fact about the browser rather than a failure of the read.
      console.log(`[background] page-world script refused in tab ${tabId}:`, err?.message ?? err);
      return null;
    }
  }

  /** The selection as the page's own world sees it, text only. Non-destructive: this is the
   *  popup's probe, and a popup opened to look at the balance must not eat the selection.
   *
   *  No editable-host check, deliberately. A selection inside a `<textarea>` yields no DOM
   *  text at all, so it cannot arrive here as text in the first place; and a selection in
   *  rich editable content is one the user can still legitimately want fact-checked, which
   *  the capture handles by declining to wrap rather than by refusing to read. */
  /** The frame a content script's message came from.
   *
   *  These two routes are the page script asking for a read in its OWN document, so the
   *  frame is not a detail the caller may assume away: on a platform whose content lives in
   *  a same-origin frame, `runInPageWorld` aimed at frame 0 would run the read in the
   *  document above the one holding the selection and come back empty — the same failure,
   *  one layer down, that the injection's frame id exists to prevent. The sender carries it,
   *  so it is taken from there rather than guessed; a sender without one is the top frame. */
  function senderFrameId(sender: any): number {
    return typeof sender?.frameId === 'number' ? sender.frameId : 0;
  }

  async function probeSelectionInPageWorld(tabId: number, frameId: number): Promise<string> {
    const result = await runInPageWorld(tabId, frameId, () => {
      const sel = window.getSelection();
      const text = sel ? String(sel) : '';
      return text.trim() ? text.slice(0, 200) : '';
    });
    return typeof result === 'string' ? result : '';
  }

  /** Take the selection out of the page's hands and into the `.mf-segment-wrap` the claims
   *  are anchored to, and report the wrap's id for the page script to find through the
   *  shared DOM.
   *
   *  Destructive by design — it re-parents the selected nodes and clears the page's own
   *  selection — so it is only ever run for a Disinfact the user has actually asked for.
   *
   *  Every refusal that still has readable text hands the text back with its reason rather
   *  than failing flat: extraction legitimately cannot re-parent some ranges, and a
   *  fact-check with its claims listed beats no fact-check at all. Only "the user has
   *  nothing selected" is a flat refusal.
   *
   *  The host is judged by where the SELECTION is, not by what has focus. `activeElement` is
   *  whatever the user last clicked into and on a page with any editor on it that is very
   *  often a field nowhere near the selection — checking it refused every selection on the
   *  one page this was first tried on. */
  async function captureSelectionInPageWorld(tabId: number, frameId: number): Promise<any> {
    return runInPageWorld(tabId, frameId, () => {
      const fail = (why: string, extra: Record<string, any> = {}) => ({ ok: false, why, ...extra });
      try {
        const BLOCK = 'p,li,dd,dt,td,th,caption,figcaption,blockquote,pre,article,section,aside,main,div,h1,h2,h3,h4,h5,h6';
        const isThin = (s: string) => {
          const t = s.trim();
          return t.length === 0 || t.length === 1 || !/\s/.test(t);
        };
        /** The block `r` sits in, as an element-bounded range: the pool a thin read's
         *  window is drawn from, and the reason the pool is the block alone and NOT its
         *  neighbours — a window that runs past the block's edge puts the wrap's boundary
         *  mid-paragraph in the next one, and re-inserting the read as a span then splits
         *  that paragraph in two. Mirrors selection.ts blockRange (this function is
         *  serialized into the page's world and cannot call it). */
        const blockPool = (r: Range): Range | null => {
          const startEl = r.startContainer.nodeType === 1
            ? (r.startContainer as Element)
            : r.startContainer.parentElement;
          const block = startEl?.closest(BLOCK);
          if (!block || block === document.body || block === document.documentElement) return null;
          const out = document.createRange();
          try {
            out.setStartBefore(block);
            out.setEndAfter(block);
            return out;
          } catch {
            return null;
          }
        };
        /** Characters either side of a right-click that carried no deliberate selection. A
         *  word is a POINTER at the passage it sits in: the read is its neighbourhood,
         *  never the article around it (this is the page-world half of the rule in
         *  entrypoints/selection.ts windowAround — this function is serialized into the
         *  page's world, so it cannot call that one and the two are kept in step by hand). */
        const THIN_WINDOW_CHARS = 60;
        const WHITESPACE = /\s/;
        /** ±`limit` characters around [a0, a1), each edge walked out to the nearer word
         *  boundary so neither cuts a word in half (mirrors selection.ts windowBounds). */
        const windowBounds = (text: string, a0: number, a1: number, limit: number): [number, number] => {
          let start = Math.max(0, a0 - limit);
          while (start > 0 && !WHITESPACE.test(text[start - 1])) start--;
          let end = Math.min(text.length, a1 + limit);
          while (end < text.length && !WHITESPACE.test(text[end])) end++;
          return [start, end];
        };
        const windowAround = (pool: Range, anchor: Range): Range => {
          if (pool.startContainer.nodeType !== 1 || pool.endContainer.nodeType !== 1) return pool;
          const common = pool.commonAncestorContainer;
          const host = common.nodeType === 1 ? (common as Element) : common.parentElement;
          if (!host) return pool;
          const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
          const nodes: Text[] = [];
          const starts: number[] = [];
          let all = '';
          for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
            if (!pool.intersectsNode(n)) continue;
            starts.push(all.length);
            nodes.push(n);
            all += n.data;
          }
          if (nodes.length === 0) return pool;
          const offsetOf = (container: Node, offset: number): number | null => {
            if (container.nodeType === 3) {
              const k = nodes.indexOf(container as Text);
              return k < 0 ? null : starts[k] + offset;
            }
            const child = (container as Element).childNodes[offset] ?? null;
            for (let k = 0; k < nodes.length; k++) {
              const n = nodes[k];
              if (child ? n === child || child.contains(n) : n === container || container.contains(n)) return starts[k];
            }
            return null;
          };
          const a0 = offsetOf(anchor.startContainer, anchor.startOffset);
          const a1 = offsetOf(anchor.endContainer, anchor.endOffset);
          if (a0 === null || a1 === null || a1 < a0) return pool;
          const [from, to] = windowBounds(all, a0, a1, THIN_WINDOW_CHARS);
          const locate = (g: number): [Text, number] | null => {
            for (let k = nodes.length - 1; k >= 0; k--) {
              if (g >= starts[k]) return [nodes[k], Math.min(g - starts[k], nodes[k].data.length)];
            }
            return null;
          };
          const head = locate(from);
          const tail = locate(to);
          if (!head || !tail) return pool;
          const narrowed = document.createRange();
          try {
            narrowed.setStart(head[0], head[1]);
            narrowed.setEnd(tail[0], tail[1]);
          } catch {
            return pool;
          }
          return narrowed.toString().trim() ? narrowed : pool;
        };
        const sel = window.getSelection();
        let range: Range | null = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
        let text = sel ? String(sel) : '';
        // Context-menu Disinfact only (the isolated script stamps this). A
        // popup probe must not swallow neighbouring lines.
        const expandThin = document.documentElement.dataset.mfSelExpandThin === '1';
        delete document.documentElement.dataset.mfSelExpandThin;
        if (expandThin && range && isThin(text)) {
          const pool = blockPool(range);
          const expanded = pool ? windowAround(pool, range) : range;
          const expandedText = expanded.toString();
          if (expandedText.trim()) {
            range = expanded;
            text = expandedText;
          }
        }
        if (!range) return fail('nothing selected');
        if (!text.trim()) return fail('blank');
        // `String(sel)` and not the range: in the page's world the selection reports
        // `isCollapsed` as true while still returning every selected character, so neither
        // `isCollapsed` nor the range is trustworthy as the source of the text. The string is.
        // Measured before any decision about wrapping, because the selection is live right
        // now and whatever happens next it is not going to be live much longer. Under the
        // selection's last line, which is where the eye is after selecting downwards.
        const rect = (() => {
          const rects = range.getClientRects();
          const last = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
          return last && (last.width || last.height) ? { x: last.left, y: last.bottom + 8 } : null;
        })();
        const host: any = range.startContainer.nodeType === 1
          ? range.startContainer
          : range.startContainer.parentElement;
        if (host && (host.tagName === 'INPUT' || host.tagName === 'TEXTAREA' || host.isContentEditable === true)) {
          // Wrapping here would re-parent the user's own input — and on an editor that owns
          // its DOM it would also be undone on the next render — so the text is passed on
          // unanchored instead: fact-checked, with the claims listed at the selection.
          return fail(`editable host: ${host.tagName}${host.isContentEditable === true ? '[contenteditable]' : ''}`, { text, rect });
        }
        if (!range.startContainer.isConnected || !range.endContainer.isConnected) {
          return fail('detached', { text, rect });
        }
        const intersects = (el: Element) => {
          try {
            const nr = document.createRange();
            nr.selectNodeContents(el);
            return range!.compareBoundaryPoints(Range.START_TO_END, nr) < 0
              && range!.compareBoundaryPoints(Range.END_TO_START, nr) > 0;
          } catch {
            return el.contains(range!.startContainer) || el.contains(range!.endContainer);
          }
        };
        const foldWrap = (wrapEl: HTMLElement) => {
          const claims = wrapEl.querySelectorAll('.mf-segment-claim');
          for (let i = 0; i < claims.length; i++) {
            const span = claims[i];
            const chrome = span.querySelectorAll('.mf-inline-badge, .mf-standalone-spinner');
            for (let j = 0; j < chrome.length; j++) chrome[j].remove();
            if (span.childNodes.length === 0) span.replaceWith(document.createTextNode(span.textContent ?? ''));
            else span.replaceWith(...Array.from(span.childNodes));
          }
          if (!wrapEl.parentNode) { wrapEl.remove(); return; }
          wrapEl.replaceWith(...Array.from(wrapEl.childNodes));
        };
        const overlappingWraps = Array.from(document.querySelectorAll('.mf-segment-wrap[data-mf-sel-wrap="true"]'))
          .filter((w) => (w as HTMLElement).isConnected && intersects(w as Element));
        // Folding a wrap removes the span the boundaries point into, and every live range
        // inside a removed node collapses to the removal point while its containers stay
        // connected — so a second click on a passage that is already wrapped would read the
        // first few characters of the block. The nodes the boundaries name survive the fold,
        // so the range is rebuilt from endpoints read before it. Mirrors `rangeEndpoints` and
        // `restoreRange` in entrypoints/selection.ts, which this function cannot call.
        const savedStart = range.startContainer;
        const savedStartOffset = range.startOffset;
        const savedEnd = range.endContainer;
        const savedEndOffset = range.endOffset;
        const overlapping = overlappingWraps.length > 0;
        for (const w of overlappingWraps) foldWrap(w as HTMLElement);
        if (overlapping && savedStart.isConnected && savedEnd.isConnected) {
          try {
            const rebuilt = document.createRange();
            rebuilt.setStart(savedStart, savedStartOffset);
            rebuilt.setEnd(savedEnd, savedEndOffset);
            if (rebuilt.toString().trim()) range = rebuilt;
          } catch { /* the collapsed range below is still the fallback */ }
        }
        if (overlapping && (!range.startContainer?.isConnected || !range.endContainer?.isConnected)) {
          const live = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
          if (live && live.startContainer && live.endContainer && live.startContainer.isConnected && live.endContainer.isConnected) {
            range = live;
          }
        }
        /** The block a range edge sits in. Mirrors `edgeBlock` in entrypoints/selection.ts
         *  (this function is serialized into the page's world and cannot call it). */
        const edgeBlock = (node: Node): Element | null => {
          const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
          return el ? el.closest(BLOCK) : null;
        };
        /** Whether a range's edges sit in different blocks. `extractContents` re-parents
         *  everything the range covers to the range's START, so such a range cannot be
         *  wrapped without moving the page's own text — the title bar's children land in a
         *  span inside the article body. Mirrors `rangeWithinOneBlock` in selection.ts. */
        const spansBlocks = (r: Range): boolean => {
          const a = edgeBlock(r.startContainer) ?? document.body;
          return a !== (edgeBlock(r.endContainer) ?? document.body);
        };
        const wrapOne = (r: Range): string | null => {
          if (spansBlocks(r)) return null;
          const wrapId = `pw_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
          const wrap = document.createElement('span');
          wrap.className = 'mf-segment-wrap';
          wrap.dataset.mfSelWrap = 'true';
          wrap.dataset.mfSelId = wrapId;
          try {
            wrap.appendChild(r.extractContents());
            r.insertNode(wrap);
          } catch {
            // The extraction above already moved the page's own nodes into the wrap:
            // removing it would delete the user's text from the page. Put them back first.
            if (wrap.childNodes.length > 0) {
              try {
                const back = document.createDocumentFragment();
                while (wrap.firstChild) back.appendChild(wrap.firstChild);
                r.insertNode(back);
              } catch { /* nothing safe left to do with these nodes */ }
            }
            wrap.remove();
            return null;
          }
          if (!(wrap.textContent ?? '').trim()) {
            wrap.remove();
            return null;
          }
          return wrapId;
        };
        // A selection is always the reader's own passage: it is wrapped and fact-checked,
        // never handed to a post whose buttons the drag happened to cross.
        if (spansBlocks(range)) {
          // Refused rather than wrapped: the page keeps its layout and the page script
          // fact-checks the text with its claims listed at the selection. `text` and `rect`
          // are what make that possible, so this is a fallback and not a failure.
          return fail('selection spans block boundaries', { text, rect });
        }
        const wrapId = wrapOne(range);
        if (!wrapId) {
          return fail(`range extracted nothing (collapsed=${range.collapsed}, rangeText=${range.toString().length})`, { text, rect });
        }
        if (overlapping) document.documentElement.dataset.mfSelForce = '1';
        else delete document.documentElement.dataset.mfSelForce;
        document.documentElement.dataset.mfSelId = wrapId;
        sel?.removeAllRanges();
        return { ok: true, id: wrapId, len: text.length };
      } catch (err) {
        return fail(String(err));
      }
    });
  }

  /** The in-page script file, as built by `entrypoints/selection.ts`. Injected rather
   *  than declared, so it exists only on pages the user acted on. Re-injection on every
   *  trigger is intentional — the script guards itself and the injection is what makes
   *  the *message* that follows deliverable. */
  async function peekIsolatedWorld(tabId: number, frameId: number): Promise<IsolatedWorld | null> {
    try {
      const probe = await execInFrame(tabId, frameId, {
        func: () => {
          const g = globalThis as any;
          return {
            href: location.href,
            readyState: document.readyState,
            flag: g.__mfSelectionInjected ?? null,
            responder: typeof g.__mfSelectionResponder,
            runtimeId: g.browser?.runtime?.id ?? null,
            browser: typeof g.browser,
            onMessage: typeof g.browser?.runtime?.onMessage?.addListener,
            selectionApi: typeof document.getSelection,
          };
        },
      });
      return (probe?.[0]?.result as IsolatedWorld | undefined) ?? null;
    } catch {
      return null;
    }
  }

  async function injectSelectionScript(tabId: number, frameId: number): Promise<{ injected: boolean; world: IsolatedWorld | null }> {
    try {
      // A live copy of this extension's script is enough: start/probe are handed
      // to `__mfSelectionResponder` in-world, so re-injecting does not make the
      // message more deliverable — it only stacks copies and gives Safari another
      // chance to prompt for every iframe on the page. A copy from a previous
      // extension id (reload of a different build) is not ours; inject then.
      // One peek, not the 5×100ms wait: a cold tab would otherwise stall every
      // probe on a world we already know is empty.
      const existing = await peekIsolatedWorld(tabId, frameId);
      if (existing?.responder === 'function' && existing.runtimeId === browser.runtime.id) {
        console.log(`[background] selection script already in tab ${tabId}:`, JSON.stringify(existing));
        return { injected: true, world: existing };
      }
      // Safari's executeScript file context often has `browser`/`chrome` as a
      // content-script local that is NOT on `globalThis`. WXT's polyfill is
      // `globalThis.browser?.runtime?.id ? browser : chrome`, so that local is
      // dropped, `Y` is undefined, and selection.js throws on `Y.runtime`
      // before it can publish `__mfSelectionResponder`. Copy the locals onto
      // globalThis first. The body is string-eval'd so the background's own
      // `browser` binding is not what the tab looks up.
      await execInFrame(tabId, frameId, {
        func: () => {
          const g = globalThis as any;
          // This frame is the one the user acted in, and the copy about to be injected is
          // told so. selection.js refuses to run in a subframe unless it finds this mark —
          // it was written when only the top frame could own a selection, which is false
          // anywhere content lives in a same-origin frame (Naver Cafe's `#cafe_main`), and
          // the mark is what separates "injected here on purpose" from a copy that landed in
          // a subframe by accident. Set before the file is injected, and in the frame the
          // file is injected into, so a copy that is NOT wanted still finds nothing.
          g.__mfSelectionWanted = true;
          try {
            const b = eval('typeof browser !== "undefined" ? browser : null');
            if (b?.runtime) g.browser = b;
          } catch { /* no local browser */ }
          try {
            const c = eval('typeof chrome !== "undefined" ? chrome : null');
            if (c?.runtime) g.chrome = c;
          } catch { /* no local chrome */ }
        },
      });
      // Logged with its result, because the result is the only evidence the script
      // actually landed: a resolve is not a success, and an empty one is what a refused
      // path resolves to. See SELECTION_SCRIPT. The whole array and not its length,
      // because `[{frameId:0}]` — a resolve with no `result` — is what a file injection
      // that ran nothing looks like, and it is indistinguishable from a real one by count.
      const injected = await execInFrame(tabId, frameId, { files: [SELECTION_SCRIPT] });
      console.log(`[background] selection script injected into tab ${tabId} frame ${frameId}:`, JSON.stringify(injected));
      // Then ask the tab what is actually in the world the file was injected into. This is
      // the only way to tell "the injection was refused" from "the file ran and its
      // listeners are not answering", and those two need opposite fixes: a refused
      // injection resolves exactly like a successful one, so the reply that follows a
      // message is otherwise the only evidence and it cannot say which happened.
      //
      // Reported alongside the injection rather than merged into it, and the caller must
      // keep treating them apart: `files` and `func` are separate injection paths, and a
      // page whose CSP admits the file can refuse the function. Reading a null world as a
      // failed injection would then skip the message on pages where it would have worked —
      // a diagnostic is not allowed to become a gate.
      return { injected: true, world: await readIsolatedWorld(tabId, frameId) };
    } catch (err: any) {
      // Chrome refuses injection into chrome:// pages, the Web Store, PDF viewers and
      // other extension pages. Nothing to do about it — the user cannot fact-check there.
      console.log(`[background] selection script not injectable into tab ${tabId} frame ${frameId}:`, err?.message ?? err);
      return { injected: false, world: null };
    }
  }

  /** What the tab's isolated world holds right after the selection script was injected.
   *
   *  `responder` is the signal that matters: it is the handler the file publishes
   *  immediately before it can answer anything, and it is the last thing the entry does
   *  that a reply depends on. `flag`, by contrast, is the entry's FIRST statement and sits
   *  some thousand lines earlier, so a number proves only that the file started — reading
   *  it as "reached its end" hid the one case worth seeing, a file that died in between.
   *  `flag` set with `responder` absent is therefore a script that never got as far as
   *  listening; both present with a message still unanswered is delivery, not the script.
   *  No result at all means even a bare function cannot run there, which is a permission
   *  problem rather than a script one.
   *
   *  Waits (bounded) for `responder` rather than reading once, because a resolve from
   *  `executeScript` is not a promise that the file's body has finished — the reply this
   *  feeds is sent by the very handler being waited for. Costs nothing when the file is
   *  already through: the first read returns and the loop exits. */
  async function readIsolatedWorld(tabId: number, frameId: number): Promise<IsolatedWorld | null> {
    let last: IsolatedWorld | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const probe = await execInFrame(tabId, frameId, {
          func: () => {
            const g = globalThis as any;
            return {
              href: location.href,
              readyState: document.readyState,
              flag: g.__mfSelectionInjected ?? null,
              responder: typeof g.__mfSelectionResponder,
              runtimeId: g.browser?.runtime?.id ?? null,
              browser: typeof g.browser,
              onMessage: typeof g.browser?.runtime?.onMessage?.addListener,
              selectionApi: typeof document.getSelection,
            };
          },
        });
        last = (probe?.[0]?.result as IsolatedWorld | undefined) ?? null;
      } catch (err: any) {
        console.log(`[background] isolated world unreadable in tab ${tabId} frame ${frameId}:`, err?.message ?? err);
        return null;
      }
      if (last?.responder === 'function') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    // Our own id is printed beside the world's so the two can be compared without a second
    // log line: they must match, and a world reporting a different one (or none) is a world
    // whose listener nothing this file sends can ever reach.
    console.log(
      `[background] isolated world in tab ${tabId} frame ${frameId}:`,
      JSON.stringify(last),
      '| our runtime id:',
      browser.runtime.id
    );
    return last;
  }

  /** Hand `kind` to the selection script in `tabId`, and return the answer it gives.
   *
   *  Not `browser.tabs.sendMessage`, and that is the point rather than a preference: a script
   *  injected with `scripting.executeScript` does not receive one. The injection resolves, the
   *  script runs to the end of its body, it installs its listener and publishes it as
   *  `__mfSelectionResponder` — every one of which the probe above reads back out of that same
   *  world on the same click — and the send still resolves `undefined`, because a message with
   *  no answer is indistinguishable there from a message with no receiver. The reverse
   *  direction is not affected: the page-world selection read is built on the script's own
   *  `runtime.sendMessage` calls, and the run in which the pipeline worked proves it.
   *
   *  So the message is delivered by calling the published responder, from a function injected
   *  into the same world — the mechanism this file already reads that world with. There are no
   *  arguments and no awaited promises in any of the three injections: whether an injected
   *  function's returned promise is awaited is not something to hang a handshake on, and an
   *  argument-less function is the one shape every implementation serializes the same way.
   *
   *  The reply is parked on a world global by the handler's own `sendResponse` and collected
   *  afterwards, because the handler is asynchronous — a start answers only after a round trip
   *  of its own back through this file. */
  async function askSelection(tabId: number, frameId: number, kind: 'start' | 'probe' | 'popupStart' | 'notifyNotSignedIn'): Promise<{ delivered: boolean; reply: any }> {
    // The request is staged in the world rather than passed in, for the reason above: the
    // literals below are the whole of what distinguishes a start from a probe. `func` is
    // serialized, so these cannot close over `kind` — each branch is a self-contained
    // function. Context-menu start is `keepProbe: false` (no earlier probe) and expands
    // a word/empty click to the neighbouring lines. Popup start omits that so a
    // selection the popup itself blurred can fall back to the probe.
    // Argument-less `func` only. Safari has treated `args` as a reason to
    // inject outside frame 0 (id5-sync.com on CBC). Firefox's click target
    // is recovered from the page's own contextmenu listener instead.
    const stage = kind === 'start'
      ? () => { (globalThis as any).__mfSelectionRequest = { type: 'MF_SELECTION_START', keepProbe: false, expandThin: true }; }
      : kind === 'popupStart'
      ? () => { (globalThis as any).__mfSelectionRequest = { type: 'MF_SELECTION_START' }; }
      : kind === 'notifyNotSignedIn'
      ? () => { (globalThis as any).__mfSelectionRequest = { type: 'MF_NOTIFICATION', data: { kind: 'error', code: 3 } }; }
      : () => { (globalThis as any).__mfSelectionRequest = { type: 'MF_SELECTION_PROBE' }; };
    try {
      await execInFrame(tabId, frameId, { func: stage });
      const invoked = await execInFrame(tabId, frameId, {
        func: () => {
          const g = globalThis as any;
          // The newest copy publishes itself here and retires the one before it, so this is
          // also the copy that would have answered a delivered message — and the only one.
          const handler = g.__mfSelectionResponder;
          if (typeof handler !== 'function') return 'no-responder';
          g.__mfSelectionOutcome = 'pending';
          try {
            handler(g.__mfSelectionRequest, { tab: { id: -1 }, id: g.browser?.runtime?.id ?? null }, (reply: any) => {
              g.__mfSelectionOutcome = reply === undefined ? 'undefined-reply' : reply;
            });
          } catch (err: any) {
            g.__mfSelectionOutcome = { ok: false, reason: `threw: ${String((err && err.message) || err)}` };
          }
          return 'invoked';
        },
      });
      const outcome = invoked?.[0]?.result ?? null;
      if (outcome !== 'invoked') {
        console.log(`[background] selection ${kind} not handed over:`, JSON.stringify(outcome));
        return { delivered: false, reply: null };
      }
      // Bounded, and only ever reached while the answer is outstanding: the handler settles
      // on its own schedule and there is nothing to await it with across the world boundary.
      for (let attempt = 0; attempt < 25; attempt++) {
        await new Promise((r) => setTimeout(r, 120));
        const read = await execInFrame(tabId, frameId, {
          func: () => (globalThis as any).__mfSelectionOutcome ?? null,
        });
        const collected = read?.[0]?.result ?? null;
        if (collected === 'pending' || collected === null) continue;
        return { delivered: true, reply: collected };
      }
      return { delivered: true, reply: null };
    } catch (err: any) {
      console.log(`[background] selection ${kind} could not be handed over:`, err?.message ?? err);
      return { delivered: false, reply: null };
    }
  }

  /** Which frames of a tab are known to run our own content script, and which of them last
   *  held a selection.
   *
   *  The popup names only a tab — no browser API reports which frame of a page holds the
   *  focus — so on a platform whose content lives in a frame it cannot know where to look.
   *  It does not have to ask the browser: a frame running our content script can open a port
   *  (see utils/relayCore.ts), and the port's sender carries the frame id. Recording it costs
   *  nothing and needs no permission — `webNavigation`, which would enumerate frames
   *  directly, is deliberately not one this extension carries, and injecting into every
   *  frame at once is the per-frame prompt the selection path already refuses.
   *
   *  Frame 0 is not in here. It is the default, it is always a candidate, and it is tried
   *  first, so the list holds only the frames that are an ADDITION to it. */
  const framesByTab = new Map<number, Set<number>>();

  /** Where the frames learned per tab are parked.
   *
   *  Session storage rather than this worker's memory, because what a stored frame id
   *  records is a fact about the PAGE and it has to outlive the worker that heard it. The
   *  reader loads a Naver Cafe article, reads it for a minute, selects a paragraph and only
   *  then opens the popup — by which time this worker has almost always been recycled, and
   *  an in-memory list would have gone with it, leaving the popup with nothing but the top
   *  document to ask. The id is the whole answer: reaching that frame needs only the toolbar
   *  grant the popup click produces, not the port that reported it. Session scope also means
   *  it is dropped when the browser restarts, so an id can never be matched by a tab that
   *  happens to reuse the number. */
  const FRAME_STORE = 'mfFramesByTab';

  /** How long a remembered frame is trusted, and how many are kept per tab. A frame id is
   *  only meaningful to the document that reported it, so a tab that has navigated many
   *  times would otherwise accumulate ids for documents that are gone. Asking a dead frame
   *  is harmless — the injection simply finds no selection — but it is not free, and it
   *  would grow without bound on a long-lived tab. */
  const FRAME_TTL_MS = 30 * 60 * 1000;
  const FRAME_MAX = 8;

  /** The shape the store above holds: a frame id and when it was reported, per tab id. */
  type FrameLedger = Record<string, { frameId: number; at: number }[]>;

  /** The frame the popup's last probe found a selection in, per tab. Start runs after the
   *  probe and must reach the same document; re-walking would be a guess, because the popup
   *  taking focus can clear the page's selection in between. */
  const selectionFrameByTab = new Map<number, number>();

  /** Remember that `frameId` of `tabId` runs our content script. */
  async function noteFrame(tabId: unknown, frameId: unknown): Promise<void> {
    if (typeof tabId !== 'number' || typeof frameId !== 'number' || frameId === 0) return;
    // In memory first: the next probe must see it even if the write below is slow, and a
    // worker that is busy enough to lose the write is one that will not be recycled either.
    const frames = framesByTab.get(tabId) ?? new Set<number>();
    frames.add(frameId);
    framesByTab.set(tabId, frames);
    try {
      const stored = await browser.storage.session.get(FRAME_STORE);
      const all: FrameLedger = (stored?.[FRAME_STORE] ?? {}) as FrameLedger;
      const now = Date.now();
      const kept = (all[tabId] ?? []).filter((e) => now - e.at < FRAME_TTL_MS);
      all[tabId] = [...kept, { frameId, at: now }].slice(-FRAME_MAX);
      await browser.storage.session.set({ [FRAME_STORE]: all });
    } catch { /* the in-memory copy above still answers this worker's probes */ }
  }

  /** The frames of `tabId` to ask about a selection, in the order to ask them: the top
   *  document first, then the frames our content script has announced itself from. */
  async function selectionFrames(tabId: number): Promise<number[]> {
    const known = new Set<number>(framesByTab.get(tabId) ?? []);
    try {
      const stored = await browser.storage.session.get(FRAME_STORE);
      const all: FrameLedger = (stored?.[FRAME_STORE] ?? {}) as FrameLedger;
      const now = Date.now();
      for (const e of all[tabId] ?? []) {
        if (now - e.at < FRAME_TTL_MS) known.add(e.frameId);
      }
    } catch { /* fall back to what this worker heard for itself */ }
    return [0, ...Array.from(known).sort((a, b) => a - b)];
  }

  /** The frame of `tabId` that holds a selection, with the probe's answer, or null.
   *
   *  A walk rather than a lookup because the frame is not knowable in advance: the selection
   *  is the only thing that says which frame the user was working in, and it can only be
   *  read from inside that frame. Each candidate is asked the same question the popup used
   *  to ask frame 0 alone, and the first one that answers yes wins — so on every platform
   *  whose content is in the top document this is exactly the single probe it always was. */
  async function frameHoldingSelection(tabId: number): Promise<{ frameId: number; reply: any; world: IsolatedWorld | null } | null> {
    for (const frameId of await selectionFrames(tabId)) {
      const { injected, world } = await injectSelectionScript(tabId, frameId);
      if (!injected) continue;
      const { reply } = await askSelection(tabId, frameId, 'probe');
      if (reply?.hasSelection) return { frameId, reply, world };
    }
    return null;
  }

  /** Display the signed-out error notification on the given tab immediately.
   *  Broadcasts to any live ports (e.g. X.com) and injects the selection script
   *  to deliver the notification on arbitrary web pages without running preclassification. */
  async function notifyTabSignedOut(tabId: number, frameId: number): Promise<void> {
    notifyError(ERROR_CODES.NOT_SIGNED_IN);
    try {
      const { injected } = await injectSelectionScript(tabId, frameId);
      if (injected) {
        await askSelection(tabId, frameId, 'notifyNotSignedIn');
      }
    } catch (err) {
      console.log('[background] notifyTabSignedOut failed to reach tab:', err);
    }
  }

  function registerSelectionMenu(): void {
    if (!browser.contextMenus?.create) return;
    // A previous run's item survives a service-worker restart, and create() with a
    // duplicate id throws, so clear first. removeAll is scoped to this extension.
    browser.contextMenus.removeAll(() => {
      try {
        browser.contextMenus.create({
          id: SELECTION_MENU_ID,
          title: browser.i18n.getMessage('disinfactButton') || 'Disinfact',
          // `page` is Firefox (right-click selects nothing) and the lazy
          // word-click path; `selection` is Safari/Chrome's word highlight.
          contexts: ['selection', 'page'],
        });
      } catch (err) {
        console.log('[background] context menu create failed:', err);
      }
    });
  }

  registerSelectionMenu();
  browser.runtime.onInstalled.addListener(() => registerSelectionMenu());

  // Mastodon instances are registered dynamically, one origin at a time, and this worker is
  // killed after ~30s idle (see the header) — so the registrations cannot be re-established
  // from a variable here. `persistAcrossSessions` restores them with the browser; this pass
  // is what repairs the record when the two disagree, and it runs on both events because a
  // worker restart is not an install. Fire-and-forget: housekeeping must not delay anything.
  void reconcileInstanceScripts();
  browser.runtime.onStartup.addListener(() => { void reconcileInstanceScripts(); });
  browser.runtime.onInstalled.addListener(() => { void reconcileInstanceScripts(); });

  /** The browser's own record of the selection, held from the moment the context menu
   *  opened until the read it belongs to arrives (one turn later, and only from that path).
   *  A different extent is a different hash and a different claim set, so this is the one
   *  piece of ground truth that can say whether a read matched what the user selected.
   *  Consumed on use, so a read can never be judged against an earlier selection. */
  let browserSelectionText: string | null = null;

  browser.contextMenus?.onClicked.addListener((info: any, tab: any) => {
    // Logged ahead of every guard, and it is the point of the line: a click that arrives
    // with an unexpected shape and a click that never arrived are the same silence from
    // the outside, and this path failing as silence is exactly what it used to do.
    //
    // `selectionText` is the browser's own record of what was selected when the menu was
    // opened, captured before any of this runs. It is the cross-check for the read the page
    // script reports below: the browser is holding a selection that the extension's own
    // world may not be able to see at all. Logged in full (up to a legible cap) because a
    // slice cannot tell a selection from a longer passage that starts the same way — and
    // telling those two apart is the whole job of this line.
    const browserText = String(info?.selectionText ?? '');
    browserSelectionText = browserText;
    // Which frame the click came from, and the reason the whole selection path takes a frame
    // id at all. A selection made inside a same-origin frame belongs to THAT frame's
    // selection object and is invisible above it — so a script injected into frame 0 reads
    // nothing and the click fails silently, which is what it did on Naver Cafe's article.
    // The click is the one trigger that knows where the user was; `?? 0` covers the browsers
    // that report no frame for the top document rather than omitting the field.
    const frameId = typeof info?.frameId === 'number' ? info.frameId : 0;
    console.log(
      '[background] context menu clicked:', info?.menuItemId,
      '| tab id:', tab?.id,
      '| frame id:', frameId,
      '| selectionText:', JSON.stringify(browserText.slice(0, 400)),
      '| len:', browserText.length
    );
    if (info?.menuItemId !== SELECTION_MENU_ID) return;
    void (async () => {
      const tabId = tab?.id;
      if (tabId == null) {
        console.log('[background] no tab to run the selection script in');
        return;
      }
      if (!(await isSignedIn())) {
        console.log('[background] context menu clicked while signed out; showing error');
        await notifyTabSignedOut(tabId, frameId);
        return;
      }
      const { injected, world } = await injectSelectionScript(tabId, frameId);
      if (!injected) return;
      // keepProbe: false — this path never ran a probe, so if the page no longer holds a
      // selection there is nothing to fall back on and the page script must say so rather
      // than reuse a capture left over from an earlier Disinfact.
      //
      // The page script reaches back here for the page-world read if its own comes up
      // empty, so this one hand-over is all both halves of the read need.
      const { delivered, reply } = await askSelection(tabId, frameId, 'start');
      // Stringified because the console renders every object as a bare "Object", so a
      // refusal and a success arrive looking the same. `null` here means the handler was
      // handed the message and had not answered when it stopped being waited for, which is
      // a different thing from `delivered: false` — nothing was handed over at all.
      console.log(
        '[background] selection start answered:', JSON.stringify(reply),
        '| delivered:', delivered,
        '| responder:', world?.responder ?? 'probe failed'
      );
    })();
  });

  type SelectionRequest = { id: string; before: string; selected: string; after: string; locale: string; force?: boolean };

  /** Hand a selected passage's claims to the automatic research, without waiting for a click.
   *
   *  EVERY claim is researched, not only a lone one: the drain no longer has to be counted,
   *  because the rule does not depend on the count any more. How they are handed over does:
   *
   *    One claim goes to `autoClassifyClaim` directly — the hand-off the lone-claim case has
   *    always used, unchanged.
   *
   *    Several go to the balance-aware waitlist, which is the client's mechanism for fanning
   *    many classifications out at once (Fact-Check All uses it for the same reason). N runs
   *    dispatched in parallel against one balance send N 402s as soon as it cannot cover them,
   *    each reverting its claim and notifying; the waitlist admits in parallel only while the
   *    balance covers every admitted claim in full and drains one at a time after that.
   *
   *  Either way the DB decides per claim first — the caller has already waited on each row, so
   *  a claim the DB answers carries no on-hold flag by now and `enqueueFactCheckClaim` skips it
   *  rather than paying to research a verdict that exists.
   *
   *  Returns the direct run's promise so the caller can hold the service worker across it; the
   *  waitlist holds the worker itself, on the batch timer it arms for the claims it queues. */
  function handOffSelectionClaims(
    selectionId: string, claims: Claim[], batchId: string, locale: string
  ): Promise<void> | void {
    if (claims.length === 1) return autoClassifyClaim(selectionId, claims[0], batchId, locale);
    for (const claim of claims) enqueueFactCheckClaim(selectionId, claim.text, batchId, locale);
  }

  /** Wait on one arriving claim's DB row and hand it to the Fact-Check All waitlist the moment
   *  that wait resolves — mid-stream, when the worker's own claim pipeline beats the drain,
   *  which is the common case. Nothing here waits for the stream to end, and no claim queues
   *  behind another claim's match.
   *
   *  The waitlist, not a direct run, is what the claim is handed to: how many may run at once
   *  has to follow the remaining balance, and the number of claims a passage will yield is not
   *  known while the stream is still running. `enqueueFactCheckClaim` re-reads the cached claim,
   *  so a row the DB answered leaves it off the waitlist rather than paying to research a
   *  verdict that already exists. */
  async function handOffSelectionClaim(
    selectionId: string, claim: Claim, hash: string, locale: string, batchId: string, drainedGate: Promise<void>
  ): Promise<void> {
    try {
      await claimAfterRowLands(selectionId, claim, hash, locale, drainedGate);
      enqueueFactCheckClaim(selectionId, claim.text, batchId, locale);
    } catch (err: any) {
      console.error('[background] handOffSelectionClaim error:', err);
    }
  }

  /** Rebuild the tweet-scoped routing row a selection's claim broadcasts land on.
   *
   *  Preclassification complete deletes `internal.broadcasts` in Postgres, so the handle
   *  opened before the stream is detached from routing by the time the worker links the
   *  claims it just preclassified — the row waits below would then never be released and
   *  every claim would settle on the timeout path. Detaching the old handle makes
   *  ensureTweetSubscription create a fresh routing row via public.subscribe, and leaves
   *  the old one open until its own timer: rows written before the replacement row is
   *  live still route to it.
   *
   *  Called once per selection, before any of its claims is waited on: the rebuild belongs to
   *  the routing row rather than to a claim, and claims racing to close each other's handle
   *  would leave the last one holding a row the others' broadcasts never reach. */
  async function refreshSelectionRouting(selectionId: string, hash: string, locale: string): Promise<void> {
    detachTweetSubscription(selectionId);
    annotationRoutingReady.delete(selectionId);
    await ensureTweetSubscription(selectionId, hash, locale, ANNOTATION_TIMEOUT_MS);
    annotationRoutingReady.add(selectionId);
  }

  /** The claim to decide on, once its DB row has landed: the DB's version of it when the row
   *  arrives, and the claim passed in when nothing can be learned.
   *
   *  A claim is researched without a second click, and the one question that has to be
   *  settled first is whether the DB already answers it. That cannot be answered by looking:
   *  the worker replies by LINKING, and the write that links runs detached from the stream just
   *  consumed — preclassify-tweets closes the stream (`data: [DONE]`, then `writer.close()`)
   *  and only afterwards, in the `finally`, embeds, matches and links the claim. So a claim read
   *  at the end of that stream is about a second and a half early, and a passage the DB has
   *  already researched arrives looking untouched. Researching on that reading is not a wasted
   *  round trip: it is a charge for a verdict that already exists.
   *
   *  The row that link produces is broadcast to the tweet subscription and merged into the
   *  cached claim by `mergeClaimPayload` — verdict and all — so waiting is what turns the
   *  question into an answer, and the wait costs no request. The subscription that carries it
   *  is opened by the caller before its stream starts (startSelectionPipeline), and rebuilt by
   *  `refreshSelectionRouting` once the stream has drained — the routing row preclassification
   *  complete deletes is what the rebuild replaces. It is rebuilt once for the passage, not
   *  once per claim, because it belongs to the row rather than to a claim; this call then only
   *  waits on it.
   *
   *  Bounded, but a timeout is NOT free: the claim handed back is the one passed in, and the
   *  one passed in comes off the preclassify stream, so it carries verdict "research required"
   *  with `reclassifyOnHold` — which is precisely the shape the hand-off's guard refuses a
   *  claim for being already answered (`autoClassifyClaim`'s settle guard, and the on-hold test
   *  `enqueueFactCheckClaim` makes). Timing out therefore re-researches a claim the DB may
   *  already hold a verdict for. That is why this wait gets the longer
   *  SELECTION_DB_ROW_TIMEOUT_MS. A row that does arrive settles the claim through those same
   *  guards, without spending. */
  async function claimAfterRowLands(
    selectionId: string, claim: Claim, hash: string, locale: string, drainedGate?: Promise<void>
  ): Promise<Claim> {
    const waiterKey = `${selectionId}:${claim.text}`;
    try {
      // The wait is REGISTERED the moment the claim arrives, so a row the worker's own
      // pipeline broadcasts mid-stream releases it at once — that is what lets a claim be
      // researched while the stream is still running. The give-up clock is anchored to the
      // drain rather than to the arrival, though: the row still lands only after the worker's
      // stream closes (the pipeline is awaited in its `finally`, after `writer.close()`), so
      // counting from the arrival would let an early claim time out where the drain-anchored
      // wait would not — handing back a streamed claim the DB may already answer, which is a
      // charge (see the note above).
      const arrived = claimDbRowArrival(selectionId, claim.text);
      let gotRow = false;
      arrived.then(() => { gotRow = true; });
      await Promise.race([
        arrived,
        (drainedGate ?? Promise.resolve()).then(
          () => new Promise<void>(r => setTimeout(r, SELECTION_DB_ROW_TIMEOUT_MS))
        ),
      ]);
      // Nothing will ever signal a waiter we gave up on; drop it rather than leave the entry
      // in the map for the next run to reuse.
      if (!gotRow) claimDbRowWaiters.delete(waiterKey);
      // Fallback: if broadcast didn't land dbClaimId, pull directly from DB
      const currentClaims = classificationCache.get(selectionId)?.classification.claims;
      const currentClaim = currentClaims?.find(c => c.text === claim.text);
      if (!currentClaim?.dbClaimId) {
        const candidateText = currentClaim?.rewritten ?? currentClaim?.dbClaimText ?? claim.rewritten ?? claim.dbClaimText ?? claim.text;
        const pulled = await getFullClaim({ text: candidateText, locale });
        if (pulled) mergeClaimPayload(selectionId, pulled, locale);
      }
    } catch (err: any) {
      console.error('[background] claimAfterRowLands error:', err);
    }
    const claims = classificationCache.get(selectionId)?.classification.claims;
    const rowClaim = claims?.find(c => c.text === claim.text) ?? claim;
    // Whether the bounded wait actually produced a DB-backed claim decides whether the
    // run settles on the stored verdict or re-researches (and re-spends). `handedBack:
    // streamed` with a row that exists is the race having been lost, not a missing row.
    console.log(
      '[background] claimAfterRowLands', selectionId,
      '| handed back:', rowClaim === claim ? 'the streamed claim (no row found by text)' : 'the cached claim',
      '| dbClaimId:', rowClaim.dbClaimId ?? 'none',
      '| verdict:', rowClaim.verdict ?? 'none',
      '| note:', rowClaim.note ? `${String(rowClaim.note).slice(0, 30)}…` : 'none',
      '| onHold:', rowClaim.reclassifyOnHold === true,
      '| cachedVerdict:', rowClaim.cachedVerdict ?? 'none'
    );
    return rowClaim;
  }

  /** Preclassify a webpage selection and, when it yields exactly one claim, research that
   *  claim immediately — the same "don't make the user click twice" rule the tweet flow and
   *  the popup's Fact-Check tab follow.
   *
   *  Hash-hit first, like processFullBatch: insert_tweet ON CONFLICT deletes tweet_claims
   *  (and the annotations on those links), so a reselect of an identical passage must not
   *  re-preclassify. A miss still streams, then the lone claim waits for its row
   *  (`claimAfterRowLands`) before auto-research.
   *
   *  On a miss the subscription is NOT gated on the claim count: it is how the links
   *  reach the page at all (see the note at the call). The auto-research below is. */
  function startSelectionPipeline(req: SelectionRequest): void {
    const selectionId = req.id;
    // The cross-check the click log above promises, and the only thing that can answer
    // "did we fact-check what the user selected?". The browser's record is ground truth —
    // it is what the context menu was opened on, and nothing in this extension can widen
    // it. Whitespace is stripped from both sides before comparing because the capture
    // concatenates block boundaries with no separator while the browser's record carries
    // one, so a separator-only difference must not read as a difference in extent.
    //
    // A read that is WIDER than the browser's record is the answer when a selection turns
    // out to have been fact-checked with text the user never selected: the hash covers a
    // different string, so a row that should have hit by hash cannot, and a claim mined
    // out of the extra text arrives as a second claim.
    if (browserSelectionText !== null) {
      const strip = (s: string) => s.replace(/\s+/g, '');
      const wanted = strip(browserSelectionText);
      const got = strip(req.selected);
      // A right-click on a word leaves the browser holding just that word (Chrome), and
      // the context-menu path deliberately grows it to the block it sits in — so the
      // word lands in the MIDDLE of the read, not at its start. Containment is the
      // success criterion there; for a real multi-word selection it is not, and a read
      // that merely contains it is still the mismatch this verdict exists to catch.
      const clickedWord = (() => {
        const t = browserSelectionText!.trim();
        return t.length === 0 || t.length === 1 || !/\s/.test(t);
      })();
      // The lengths reported are the raw ones — what a person reading the log will count in
      // the page — while the comparison itself is on the stripped forms.
      const verdict = wanted === got
        ? 'same content'
        : got.startsWith(wanted)
          ? `READ IS WIDER by ${req.selected.length - browserSelectionText.length} char(s) — the browser selected a prefix of what was fact-checked`
          : wanted.startsWith(got)
            ? `read is narrower by ${browserSelectionText.length - req.selected.length} char(s)`
            : clickedWord && got.includes(wanted)
              ? `contains the right-clicked word — the read is the block it sits in (${browserSelectionText.length} char(s) → ${req.selected.length})`
              : 'DIFFERENT CONTENT — the read is not the browser selection at all';
      console.log(
        '[background] selection cross-check | browser:', JSON.stringify(browserSelectionText.slice(0, 400)),
        `(${browserSelectionText.length} chars)`,
        '| read:', JSON.stringify(req.selected.slice(0, 400)), `(${req.selected.length} chars)`,
        '|', verdict
      );
      browserSelectionText = null;
    }
    // The worker's security gate re-derives its hash from these exact fields, and the
    // client's `canonicalContext` hashes `${before}${selected}${after}` for a selection —
    // see utils/intelligence.ts. `username`/`usertype` are empty: a webpage passage has
    // no author, and the prompt is told to ignore them for a selection.
    const tweet = {
      id: selectionId,
      text: req.selected,
      fullText: req.selected,
      username: '',
      usertype: 'None',
      time: new Date().toISOString(),
      contextBefore: req.before,
      contextAfter: req.after,
    } as unknown as MainTweet;
    console.log(
      '[background] selection context start | before:',
      JSON.stringify((req.before || '').slice(0, 500)),
      `(${(req.before || '').length} chars)`,
      '| after:',
      JSON.stringify((req.after || '').slice(0, 200)),
      `(${(req.after || '').length} chars)`,
    );

    // The annotate path resolves a claim's locators — its text, its language, its hash —
    // out of the tweet cache by id (annotLocatorsFor), and the tweet subscription that
    // carries annotation broadcasts is keyed the same way (ensureAnnotationSubscription).
    // The tweet flow gets both for free from processFullBatch; a selection is never in
    // that batch, so without this entry a selection can never be annotated and an
    // annotation broadcast can never find it.
    //
    // A selection has no text locale of its own, so it is `und` — never the UI locale the
    // run was sent under, which would file the same passage under a different key for every
    // reader. annotLocatorsFor needs the field, and this is a CLONE: what preClassify
    // was handed stays exactly as built, so the extraction input is untouched. Neither
    // field is part of a selection's canonical hash (see canonicalContext — the
    // contextBefore/contextAfter branch hashes only those three parts), so the row this
    // run inserts and looks up is unaffected.
    tweetCache.set(selectionId, { ...tweet, sourceLanguage: UNKNOWN_LANGUAGE } as unknown as MainTweet);
    persistSelectionPipeline();

    const keepAlive = setInterval(() => {}, 20000);
    // Outside the try so the `finally` below can always name the batch, even when the run
    // threw before it got as far as hashing.
    const batchId = nextBatchId();
    void (async () => {
      if (!(await isSignedIn())) {
        console.log('[background] startSelectionPipeline refused: not signed in');
        notifyError(ERROR_CODES.NOT_SIGNED_IN);
        clearInterval(keepAlive);
        return;
      }
      // Resolved once the stream has drained — or the run ended any other way. Every waiting
      // claim's give-up clock is anchored to it (see claimAfterRowLands), so the error paths
      // must release it too, or a wait nothing will ever resolve would hold the run open.
      let releaseDrain: (() => void) | null = null;
      const drainedGate = new Promise<void>(r => { releaseDrain = r; });
      void gatedSpend(async () => {
        try {
          const hash = await computeTweetHash(tweet);

        // Spinning state first, exactly like the tweet flow: the content script keeps its
        // "Disinfacting" indicator until the first claims land.
        const spinning: Classification = { id: selectionId, batchId, claims: null, quoting: null, preclassifying: true };
        cacheClassification(spinning, batchId);
        broadcastClassification(spinning);

        // No DB lookup on this path, deliberately. A selection's hash covers the passage
        // AND the prose around it (`${before}${selected}${after}` — see `canonicalContext`),
        // so a row is only ever found when somebody fact-checked the same words inside the
        // same surrounding context. Nothing else produced a hit, so the lookup was a round
        // trip charged to every reader before the run they are actually waiting on.
        //
        // It has no replacement: the passage is preclassified, always. The one thing the
        // route did that this does not is keep a settled row's annotation key, which the
        // worker's own `insert_tweet ON CONFLICT DELETE` clears on a re-run.

        // Subscribe BEFORE streaming starts, exactly like the tweet flow (see
        // its own note at the same point). link_tweet_claim broadcasts only land on
        // an existing routing row, and a routing row is written by a NEW subscription
        // on this hash; the claim pipeline runs mid-stream, so subscribing afterwards
        // loses the race whenever linking beats the stream drain.
        //
        // Fire-and-forget, in parallel with the request below: it must be open before
        // the worker's insert, and awaiting it would delay the run by however long the
        // subscription takes to go live.
        await ensureTweetSubscription(selectionId, hash, req.locale, ANNOTATION_TIMEOUT_MS);

        let latest: Classification | null = null;
        // Claim texts whose automatic hand-off has already been started. Every snapshot is
        // cumulative, so this is what makes the loop below act on each claim exactly once.
        const handedOff = new Set<string>();
        const handOffs: Promise<void>[] = [];

        for await (const cls of preClassify(tweet, hashToBytea(hash), UNKNOWN_LANGUAGE, req.locale)) {
          cls.batchId = batchId;
          // The selection is the only thing that may yield claims: the surrounding prose
          // this run ships for anchoring is not. The model sometimes extracts a claim from
          // that context anyway, and such a claim comes back with no span in the passage —
          // it could never be drawn, only listed. Dropping it here also keeps it out of the
          // DB's own claim rows (the worker's pipeline sees the same range and skips it).
          const streamed = cls.claims;
          if (streamed) {
            cls.claims = streamed.filter((c: any) => !unlocatedSelectionClaim(selectionId, c, true));
            if (cls.claims.length !== streamed.length) {
              console.log(`[background] selection ${selectionId}: dropped ${streamed.length - cls.claims.length} claim(s) not located in the passage`);
            }
          }
          const merged = mergePreclassIntoCache(cls);
          merged.batchId = batchId;
          merged.preclassifying = undefined;
          // The claims this snapshot brings that no earlier one did. Every one of them is bound
          // for the automatic research, so the mask goes up with the first of them — before the
          // broadcast below paints them — and none of them shows a Fact-Check button: not for the
          // wait on its own DB row, and not for a balance that holds it back in the waitlist.
          //
          // It is the Fact-Check All mask, not the lone-claim one, because the mask has to
          // outlive the hand-off: a claim the gate queues is still on hold in the cache, and only
          // this mask both keeps painting it as researching and lets it go the moment the
          // waitlist abandons it (see broadcastClassification). The waitlist is the only thing
          // that ends the passage's claims, so nothing here has to drop the mask.
          const fresh = (merged.claims ?? []).filter((c: any) => !handedOff.has(c.text));
          if (fresh.length) factCheckAllTweetIds.add(selectionId);
          for (const c of fresh) handedOff.add(c.text);
          cacheClassification(merged, batchId);
          broadcastClassification(merged);
          latest = merged;
          // Hand each one off as its own match resolves — mid-stream whenever the worker's own
          // claim pipeline beats the drain. Nothing here waits for the stream to end, and no
          // claim queues behind another claim's match.
          for (const c of fresh) {
            handOffs.push(handOffSelectionClaim(selectionId, c, hash, req.locale, batchId, drainedGate));
          }
        }

        // The stream is over; only the worker's row writes remain outstanding. A request
        // still waiting on one is released by the row, or by this give-up window
        // (see armRowPendingGiveUp).
        armRowPendingGiveUp(selectionId, batchId);

        if (!latest || !latest.claims || latest.claims.length === 0) {
          const empty: Classification = latest ?? { id: selectionId, batchId, claims: null, quoting: null };
          cacheClassification(empty, batchId);
          broadcastClassification(empty);
          // The selection surface drops its HUD on this broadcast; without this the pass
          // just unwrapped itself and left the user with nothing to read. A failed run
          // has already reported its own error — see the tweet flow's twin of this check.
          if (!latest?.preclassifyFailed) notifyError(browser.i18n.getMessage('errNoClaims'));
          return;
        }

        // The routing row a claim's broadcast lands on is deleted once the preclassify worker
        // settles, so the handle opened before the stream is detached by the time the worker
        // links the claims it just preclassified (see refreshSelectionRouting). Rebuilt once
        // for the passage, before the waits still pending can be released by it.
        await refreshSelectionRouting(selectionId, hash, req.locale);

        // The stream has drained AND routing is back: start the give-up clock every claim that
        // is still waiting on its row has been holding off (see claimAfterRowLands). Claims
        // whose rows the worker broadcast mid-stream resolved and were handed over long before
        // this point; this only bounds the ones still outstanding.
        releaseDrain?.();

        // Every claim has now been waited on and handed over. The claims still being researched
        // are the WAITLIST's to hold — it keeps the service worker alive on its own batch timer
        // — so nothing here waits on a run, only on each claim's match. The mask stays up with
        // them: a claim the balance queued keeps looking like the research it is waiting for,
        // and the waitlist drops it back to its own button if it gives up (see the stream loop).
        await Promise.all(handOffs);
      } catch (err: any) {
        console.error('[background] startSelectionPipeline error:', err);
      } finally {
        // A run that threw mid-stream must still free every pending claim's give-up clock,
        // or a wait nothing will ever resolve would hold the pipeline open past the point the
        // worker is meant to be reaped. Idempotent: the drain path releases it first.
        releaseDrain?.();
        // The passage's mask is deliberately NOT dropped here: a claim the waitlist is holding
        // is still on hold in the cache, and the mask is what keeps it looking like the research
        // it is queued for. The waitlist releases it — to the researching state or back to its
        // own button — when it admits or abandons the claim.
        clearInterval(keepAlive);
        const cur = classificationCache.get(selectionId)?.classification;
        // The page's "Disinfacting" indicator and the popup both wait for a terminal,
        // non-spinning classification before they stand down. A run that threw before it
        // ever cached the spinner has none to clear, so one is broadcast here — otherwise
        // the indicator spins on the page forever, which is worse than showing nothing.
        if (cur?.preclassifying || !cur) {
          const cleared: Classification = {
            ...(cur ?? { id: selectionId, batchId, claims: null, quoting: null }),
            preclassifying: undefined,
          };
          cacheClassification(cleared, cur?.batchId ?? batchId);
          broadcastClassification(cleared);
        }
      }
    });
    })();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Message entry points. One-off requests (popup) arrive on runtime.onMessage;
  // the content-script relay instead holds a long-lived "classify" port, because
  // classification results stream back over time rather than as a single reply.
  // ─────────────────────────────────────────────────────────────────────────

  // ── Mastodon runtime opt-in (utils/mastodonOptIn.ts) ───────────────────────
  //
  // Mastodon is federated, so an instance is enabled one origin at a time, from a click in
  // the popup on the instance itself. The GRANT is requested by the popup and not here:
  // `permissions.request` is only accepted while the caller still holds the user's gesture,
  // and a gesture does not survive `runtime.sendMessage`. By the time these two messages
  // arrive the grant is already held, so the background owns only the record and the
  // registrations.

  /** Put both halves of the integration into a tab that is already open.
   *
   *  Registering a content script only affects documents that START after it, and the page
   *  the reader just clicked on started long ago — without this the opt-in would appear to
   *  do nothing until they happened to reload. The interceptor goes first: it is the half
   *  that patches the page's XHR, and running it after the coordinator would leave the
   *  first sweep with nothing harvested. */
  async function injectMastodonInto(tabId: number): Promise<void> {
    const halves = [
      { world: 'MAIN' as const, allFrames: false, files: [MASTODON_INTERCEPTOR_FILE] },
      { world: 'ISOLATED' as const, allFrames: true, files: [MASTODON_COORDINATOR_FILE] },
    ];
    for (const half of halves) {
      try {
        await browser.scripting.executeScript({
          target: { tabId, allFrames: half.allFrames },
          files: half.files,
          world: half.world,
        } as any);
      } catch (error) {
        // A tab on an instance page we cannot inject into is not a failure worth failing
        // the opt-in over: the registration is in place, so the next load gets both halves.
        console.log(`[background] mastodon inject (${half.world}) skipped:`, String(error));
      }
    }
  }

  // Popup ↔ background messaging (balance, messages, checkout).
  browser.runtime.onMessage.addListener((message: any, _sender: any, sendResponse: (r: any) => void) => {
    if (message?.type === MASTODON_OPT_IN_MESSAGE && typeof message.host === 'string') {
      (async () => {
        const host = normalizeInstanceHost(message.host);
        try {
          // The popup asked for this grant a moment ago; a miss here means it was declined
          // or later revoked, and nothing should be recorded for an origin we cannot reach.
          if (!(await browser.permissions.contains({ origins: instanceOriginPatterns(host) }))) {
            sendResponse({ ok: false, reason: 'no-grant' });
            return;
          }
          const instances = await readOptedInInstances();
          if (!instances.includes(host)) await writeOptedInInstances([...instances, host]);
          await registerInstanceScripts(host);
          if (typeof message.tabId === 'number') await injectMastodonInto(message.tabId);
          sendResponse({ ok: true, host });
        } catch (error) {
          sendResponse({ ok: false, reason: String((error as Error)?.message ?? error) });
        }
      })();
      return true; // async sendResponse
    }
    if (message?.type === MASTODON_OPT_OUT_MESSAGE && typeof message.host === 'string') {
      (async () => {
        const host = normalizeInstanceHost(message.host);
        try {
          await unregisterInstanceScripts(host);
          const instances = await readOptedInInstances();
          if (instances.includes(host)) await writeOptedInInstances(instances.filter((h) => h !== host));
          // The origin grant is released, not merely forgotten: leaving it held would keep
          // the instance in the extension's own permission list after the reader turned it
          // off, which is exactly the quiet accumulation this design exists to avoid.
          try { await browser.permissions.remove({ origins: instanceOriginPatterns(host) }); } catch { /* best effort */ }
          sendResponse({ ok: true, host });
        } catch (error) {
          sendResponse({ ok: false, reason: String((error as Error)?.message ?? error) });
        }
      })();
      return true; // async sendResponse
    }

    // Opening the popup is the user's *second* way to start a selection fact-check, so the
    // popup needs to know whether the active tab currently has text selected. Injection
    // lives here, not in the popup, so both trigger paths share one code path — and so the
    // activeTab grant the toolbar click just produced is used from the context that owns
    // the injection. Reply shape: { hasSelection, preview }.
    if (message?.type === 'MF_SELECTION_PREPARE' && typeof message.tabId === 'number') {
      (async () => {
        // Which frame the user selected in is not something the popup can name, so the walk
        // asks every frame we know of and takes the one that answers yes. The answer is
        // remembered per tab: start has to hand the message to the same frame, and it runs
        // after the popup took focus, by which time the selection may no longer be readable.
        const found = await frameHoldingSelection(message.tabId);
        console.log(
          '[background] selection probe answered:', JSON.stringify(found?.reply ?? null),
          '| frame:', found?.frameId ?? 'none',
          '| of:', JSON.stringify(await selectionFrames(message.tabId)),
          '| responder:', found?.world?.responder ?? 'probe failed'
        );
        if (found) selectionFrameByTab.set(message.tabId, found.frameId);
        else selectionFrameByTab.delete(message.tabId);
        sendResponse({ hasSelection: !!found?.reply?.hasSelection, preview: found?.reply?.preview ?? '' });
      })();
      return true; // async sendResponse
    }
    // Popup Fact-Check after the disclosure. Must NOT go through tabs.sendMessage:
    // Safari delivers that to every iframe on the page and then prompts "would like
    // to access id5-sync.com" (and every other ad frame). The probe already uses
    // askSelection in the top frame; start is the same path. Do not re-inject: a
    // new copy would drop the probe's `pending`, and the popup often already stole
    // the live selection by taking focus.
    if (message?.type === 'MF_SELECTION_START_TAB' && typeof message.tabId === 'number') {
      (async () => {
        const tabId = message.tabId;
        if (!(await isSignedIn())) {
          console.log('[background] selection start refused: not signed in');
          await notifyTabSignedOut(tabId, 0);
          sendResponse({ ok: false, reason: 'not-signed-in' });
          return;
        }
        // The frame the probe found, not a fresh guess: the popup takes focus between the two
        // messages, and a page that has lost its selection answers the same question "no" no
        // matter which frame it is asked in. Falling back to frame 0 is for a start that
        // arrives without a probe — the flow allows it, and it is what this path always did.
        const frameId = selectionFrameByTab.get(tabId) ?? 0;
        let world = await readIsolatedWorld(tabId, frameId);
        if (world?.responder !== 'function') {
          const inj = await injectSelectionScript(tabId, frameId);
          if (!inj.injected) {
            sendResponse({ ok: false, reason: 'not-injected' });
            return;
          }
          world = inj.world;
        }
        const { delivered, reply } = await askSelection(tabId, frameId, 'popupStart');
        console.log(
          '[background] selection popup-start answered:', JSON.stringify(reply),
          '| delivered:', delivered,
          '| responder:', world?.responder ?? 'probe failed'
        );
        sendResponse(reply && typeof reply === 'object' ? reply : { ok: false, reason: delivered ? 'no-reply' : 'not-delivered' });
      })();
      return true; // async sendResponse
    }
    // The page script's two routes to the page's own world, asked for by name because it
    // has no way to run code there itself: `scripting` is not an API a content script gets.
    // The tab is the sender's — the script in question is running in it — so neither of
    // these can be pointed at a page the user was not acting on.
    if (message?.type === 'MF_SELECTION_PAGE_WORLD_PROBE') {
      (async () => {
        const tabId = _sender?.tab?.id;
        if (typeof tabId !== 'number') {
          sendResponse({ text: '' });
          return;
        }
        sendResponse({ text: await probeSelectionInPageWorld(tabId, senderFrameId(_sender)) });
      })();
      return true; // async sendResponse
    }
    if (message?.type === 'MF_SELECTION_PAGE_WORLD_CAPTURE') {
      (async () => {
        const tabId = _sender?.tab?.id;
        if (typeof tabId !== 'number') {
          sendResponse({ ok: false, why: 'no tab' });
          return;
        }
        const result = await captureSelectionInPageWorld(tabId, senderFrameId(_sender));
        // The only place the outcome of a page-world capture is legible: the page script
        // gets the same object, but it is the wrap that proves it, and the wrap is drawn
        // from here.
        console.log(`[background] page-world capture in tab ${tabId}:`, JSON.stringify(result));
        sendResponse(result ?? { ok: false, why: 'page world unavailable' });
      })();
      return true; // async sendResponse
    }
    if (message?.type === 'MF_FUNDS_GET') {
      (async () => {
        await initFundsHub();
        // `force` refetches instead of answering from the cached row. Used right after a
        // top-up is credited: the Realtime push is the normal way the total moves, but money
        // the user has just paid for should not depend on that push arriving — a dropped
        // channel would leave the dashboard showing the pre-purchase balance.
        //
        // Routed through handleFundsChange rather than assigning fundsState directly so the
        // freeze state, the waitlist and the in-page notification all see it. It also makes
        // this idempotent with the push that follows: lastVisibleTotal is already updated, so
        // the same total arriving again is a zero delta and notifies nobody twice.
        // `import.meta.env.SAFARI` is a build-time constant, so for Chromium and Firefox this
        // whole clause folds to `false &&` and disappears — those builds are left with exactly
        // the cache-or-fetch behaviour they had before the Apple top-up work existed.
        const forceRefetch = import.meta.env.SAFARI && message.force === true;
        if (forceRefetch || !fundsState) {
          const funds = await getFunds();
          if (funds) handleFundsChange(funds);
        }
        sendResponse({ total: fundsState ? visibleTotal(fundsState) : null });
      })();
      return true; // async sendResponse
    }
    if (message?.type === 'MF_MESSAGES_GET') {
      (async () => {
        const list = await getMessagesFresh();
        sendResponse({ messages: list });
      })();
      return true; // async sendResponse
    }
    if (message?.type === 'MF_OPEN_CHECKOUT' && typeof message.url === 'string') {
      openCheckoutTab(message.url);
      return undefined; // no response
    }
    // Safari drives OAuth (ASWebAuthenticationSession) and top-ups (StoreKit) through the
    // containing app. Safari only lets the BACKGROUND script call sendNativeMessage — a
    // popup calling it directly is not answered — so the popup asks here and this relays.
    // `import.meta.env.SAFARI` is a build-time constant, so this block is dropped entirely
    // from the Chromium and Firefox bundles.
    if (import.meta.env.SAFARI && (
      message?.type === 'MF_NATIVE_SIGN_IN' ||
      message?.type === 'MF_NATIVE_PREPARE_TOPUP' ||
      message?.type === 'MF_NATIVE_HANDOFF_TX' ||
      message?.type === 'MF_NATIVE_CLEAR_HANDOFF_TX' ||
      message?.type === 'MF_NATIVE_CLEAR_ACCOUNT' ||
      message?.type === 'MF_NATIVE_SYNC_ACCOUNT' ||
      message?.type === 'MF_NATIVE_FINISH_TX' ||
      message?.type === 'MF_NATIVE_PENDING_TX' ||
      message?.type === 'MF_NATIVE_GET_SESSION' ||
      message?.type === 'MF_NATIVE_REFRESH_SESSION' ||
      message?.type === 'MF_NATIVE_PUBLISH_SESSION' ||
      message?.type === 'MF_NATIVE_POPUP_OPENED' ||
      message?.type === 'MF_NATIVE_MARK_SELECTION_FACTCHECK' ||
      message?.type === 'MF_NATIVE_LAST_PROVIDER' ||
      message?.type === 'MF_NATIVE_GET_LAST_PROVIDER' ||
      message?.type === 'MF_NATIVE_OS_VERSION' ||
      message?.type === 'MF_NATIVE_OPEN_SIGN_IN'
    )) {
      (async () => {
        try {
          // MF_NATIVE_FINISH_TX / MF_NATIVE_PENDING_TX complete the two-phase top-up:
          // StoreKit hands us an *unfinished* transaction, the worker credits it, and only
          // then is it finished. Anything left unfinished is money already taken that we
          // still owe, so PENDING_TX lets the popup find and settle it later.
          //
          // MF_NATIVE_PREPARE_TOPUP replaced the old PURCHASE_TOPUP: the purchase itself now
          // happens in the containing app, because an app extension has no window to present
          // the StoreKit sheet into (and App Review 4.4 forbids IAP in an extension anyway).
          // So this only stages the amount and account in the shared container; the app then
          // charges, records the result there, and HANDOFF_TX brings it back on the next open.
          const payload =
            message.type === 'MF_NATIVE_SIGN_IN'
              ? { action: 'SIGN_IN', url: message.url, callbackUrlScheme: NATIVE_CALLBACK_SCHEME }
            : message.type === 'MF_NATIVE_FINISH_TX'
              ? { action: 'FINISH_TRANSACTION', transactionId: message.transactionId }
            : message.type === 'MF_NATIVE_PENDING_TX'
              ? { action: 'PENDING_TRANSACTIONS' }
            : message.type === 'MF_NATIVE_HANDOFF_TX'
              ? { action: 'HANDOFF_TRANSACTION' }
            : message.type === 'MF_NATIVE_CLEAR_HANDOFF_TX'
              ? { action: 'CLEAR_HANDOFF_TRANSACTION', transactionId: message.transactionId }
            : message.type === 'MF_NATIVE_CLEAR_ACCOUNT'
              ? { action: 'CLEAR_ACCOUNT' }
            : message.type === 'MF_NATIVE_SYNC_ACCOUNT'
              ? { action: 'SYNC_ACCOUNT', userId: message.userId, balance: message.balance,
                  accessToken: message.accessToken, accessTokenExpiresAt: message.accessTokenExpiresAt,
                  refreshToken: message.refreshToken,
                  notifySpendEnabled: message.notifySpendEnabled, notifySpendThreshold: message.notifySpendThreshold }
            // The shared session, relayed rather than sent direct: the popup reports that
            // Safari does not answer its own sendNativeMessage calls (see nativeHost.ts), and
            // a refresh is exactly the call that must not silently disappear.
            : message.type === 'MF_NATIVE_GET_SESSION'
              ? { action: 'GET_SESSION' }
            : message.type === 'MF_NATIVE_REFRESH_SESSION'
              ? { action: 'REFRESH_SESSION' }
            : message.type === 'MF_NATIVE_PUBLISH_SESSION'
              ? { action: 'PUBLISH_SESSION', accessToken: message.accessToken,
                  refreshToken: message.refreshToken, expiresAt: message.expiresAt, userId: message.userId }
            : message.type === 'MF_NATIVE_POPUP_OPENED'
              ? { action: 'POPUP_OPENED' }
            : message.type === 'MF_NATIVE_MARK_SELECTION_FACTCHECK'
              ? { action: 'MARK_SELECTION_FACTCHECK' }
            // The badge both surfaces draw for the provider a sign-in last used.
            : message.type === 'MF_NATIVE_LAST_PROVIDER'
              ? { action: 'LAST_PROVIDER', provider: message.provider, at: message.at }
            : message.type === 'MF_NATIVE_GET_LAST_PROVIDER'
              ? { action: 'GET_LAST_PROVIDER' }
            // Which drawing of Safari's extensions button the guide shows: see `readNativeOsMajor`.
            : message.type === 'MF_NATIVE_OS_VERSION'
              ? { action: 'OS_VERSION' }
            : message.type === 'MF_NATIVE_OPEN_SIGN_IN'
              ? { action: 'OPEN_SIGN_IN', provider: message.provider }
            : { action: 'PREPARE_TOPUP', amount: message.amount, userId: message.userId, balance: message.balance };
          // The host drives UI the user has to complete (ASWebAuthenticationSession, the
          // StoreKit sheet), so this ceiling is deliberately generous — it is not a
          // latency budget. It exists so that a host which never invokes its completion
          // handler surfaces an error instead of leaving the popup's spinner up forever.
          // An iOS handler missing ASWebAuthenticationPresentationContextProviding does
          // exactly that: the session cannot present, so nothing ever calls back.
          const NATIVE_TIMEOUT_MS = 5 * 60 * 1000;
          let timeoutId: ReturnType<typeof setTimeout> | undefined;
          const res = await Promise.race([
            (browser.runtime as any).sendNativeMessage(NATIVE_APP_ID, payload),
            new Promise((_resolve, reject) => {
              timeoutId = setTimeout(
                () => reject(new Error('The DisinfaX app did not respond. Please try again.')),
                NATIVE_TIMEOUT_MS,
              );
            }),
          ]).finally(() => { if (timeoutId !== undefined) clearTimeout(timeoutId); });
          // Passed through untouched: the popup already understands the host's shapes
          // ({access_token,refresh_token} / {code} / {callbackUrl} / {signedTransaction} /
          // {error}). Never resolve as undefined — the popup awaits this reply, and a
          // missing one would leave its spinner up forever.
          sendResponse(res ?? { error: 'The DisinfaX app did not respond.' });
        } catch (e: any) {
          console.error('[background] sendNativeMessage failed:', e);
          sendResponse({ error: e?.message || 'Could not reach the DisinfaX app.' });
        }
      })();
      return true; // async sendResponse
    }
    // iOS/iPadOS sign-in lands here: the popup opened the provider in a Safari tab (it
    // cannot use ASWebAuthenticationSession — see AuthManager.swift), and the content
    // script on the redirect page forwarded whatever came back. The exchange has to run
    // HERE rather than in the popup, because opening the tab dismisses the popup sheet on
    // iOS and its JS context is gone. This client shares the popup's storage adapter, so
    // the PKCE verifier stored during signInWithOAuth is readable from here.
    // Chromium and Firefox alike. In both, the identity window takes focus, and an action
    // popup dies on blur — so the JS context awaiting launchWebAuthFlow is gone before the
    // provider's page even paints, and the callback URL arrives with nobody left to receive
    // it. Google appeared to work only because an already-signed-in account redirects fast
    // enough to beat the teardown; Apple and X need real interaction and always lost the
    // race — Apple on Chrome was reported completing the sign-in and minting nothing.
    //
    // The background survives, so it runs the flow AND completes the session exchange.
    // The popup does not need to be alive at the end: the session lands in storage, and
    // whenever the popup is reopened it reads it back. Chrome ≥116 keeps the worker alive
    // for the whole flow (launchWebAuthFlow holds a strong keepalive), so the interactive
    // wait is not a termination risk.
    if (!import.meta.env.SAFARI && message?.type === 'MF_WEB_AUTH' && typeof message.url === 'string') {
      (async () => {
        try {
          const callbackUrl = await (browser.identity as any).launchWebAuthFlow({
            url: message.url,
            interactive: true,
          });
          if (!callbackUrl) throw new Error('Authentication flow was cancelled or failed.');

          const parsed = new URL(callbackUrl);
          const hashParams = new URLSearchParams(parsed.hash.replace(/^#/, ''));

          const errorDescription =
            parsed.searchParams.get('error_description') || hashParams.get('error_description');
          if (errorDescription) throw new Error(errorDescription);

          const code = parsed.searchParams.get('code');
          if (code) {
            const { error } = await supabase.auth.exchangeCodeForSession(code);
            if (error) throw error;
          } else {
            const accessToken = hashParams.get('access_token');
            const refreshToken = hashParams.get('refresh_token');
            if (!accessToken || !refreshToken) {
              const seen = [
                ...Array.from(parsed.searchParams.keys()).map(k => `?${k}`),
                ...Array.from(hashParams.keys()).map(k => `#${k}`),
              ].join(', ') || '(no query or fragment parameters)';
              throw new Error(`Authentication succeeded, but no usable tokens or codes were returned. Callback carried: ${seen}`);
            }
            const { error } = await supabase.auth.setSession({
              access_token: accessToken,
              refresh_token: refreshToken,
            });
            if (error) throw error;
          }

          // The popup requested this flow but is (usually) already dead — it cannot
          // record the provider itself, so do it here in the shared store the popup
          // reads on mount. Otherwise the "Last Used" badge keeps its stale value
          // (Apple/X sign-ins always lost the popup-teardown race; only a fast Google
          // redirect survived to write it). Best-effort, like the popup's own write.
          try {
            const usedProvider = asOAuthProvider(message.provider);
            if (usedProvider) {
              await browser.storage.local.set({ disinfax_last_oauth_provider: usedProvider });
            }
          } catch { /* badge is best-effort */ }

          // Warm the pipeline so the balance is already known when the popup reopens.
          refreshActiveState();
          sendResponse({ ok: true });
        } catch (e: any) {
          console.error('[background] web auth flow failed:', e);
          sendResponse({ error: e?.message || 'Sign-in could not be completed.' });
        }
      })();
      return true;
    }

    // The iOS sign-in hand-off, collected on demand — from the popup when it opens, which is
    // the fast path, or from the funds alarm when the user never does. Nothing is heard from
    // the app unprompted: a callback only reaches us when we ask for it.
    if (import.meta.env.SAFARI && message?.type === 'MF_AUTH_PULL') {
      (async () => {
        try {
          sendResponse(await pullPendingNativeAuth());
        } catch (e: any) {
          console.error('[background] pending auth pull failed:', e);
          sendResponse({ error: e?.message || 'Sign-in could not be completed.' });
        }
      })();
      return true; // async sendResponse
    }
    // A DOM context (popup or relay) reported the browser's dark/light preference;
    // the service worker cannot read it itself. See utils/toolbarIcon.ts.
    if (message?.type === COLOR_SCHEME_MESSAGE && typeof message.prefersDark === 'boolean') {
      void applyToolbarIcon(message.prefersDark);
      return undefined; // no response
    }
    return undefined;
  });

  // Restore the last known toolbar icon variant; until a DOM context reports in,
  // the neutral gray manifest icon stands in.
  void restoreToolbarIcon();

  browser.runtime.onConnect.addListener(port => {
    // A frame announcing itself so it can be addressed later, and nothing else — it carries
    // no messages in either direction. See `noteFrame` for why a frame of a framed platform
    // has to do this, and utils/native.content.ts for where it is opened.
    if (port.name === 'frame') {
      void noteFrame(port.sender?.tab?.id, port.sender?.frameId);
      return;
    }
    if (port.name !== "classify") return;
    // Which frame this is. Nothing else in the extension is told the frame id of a frame
    // running our content script, and it is the only way the popup's selection fact-check can
    // learn which frame to look in on a platform whose content is framed. See framesByTab.
    void noteFrame(port.sender?.tab?.id, port.sender?.frameId);
    activePorts.add(port);
    console.log(`[background] port connected, activePorts now ${activePorts.size}`);
    port.onDisconnect.addListener(() => {
      activePorts.delete(port);
      console.log(`[background] port disconnected, activePorts now ${activePorts.size}`);
    });

    // Tell the freshly-connected content script the current active state so a relay
    // that loaded (or reconnected after a service-worker restart) while inactive
    // (logged out or zero balance) freezes, and a previously-frozen one resumes.
    // A tab opened on x.com while funds are already known to be empty also gets the
    // empty-balance notice — otherwise it would freeze with no explanation, because
    // the funds-hub baseline was set long ago and no crossing will ever fire for it.
    computeActive().then(active => {
      try { port.postMessage({ type: 'MF_AUTH', signedIn: active }); } catch { /* ignore */ }
      try {
        if (fundsState && visibleTotal(fundsState) <= 0) {
          port.postMessage({ type: 'MF_NOTIFICATION', data: { kind: 'broke' } });
        }
      } catch { /* ignore */ }
    });

    port.onMessage.addListener(message => {
      // A webpage selection. Unlike CLASSIFY_TWEETS this is not a tweet: it carries the
      // selected passage plus the text around it, and the content script is the only
      // client interested — results reach it through the ordinary CLASSIFICATION
      // broadcasts, matched on this synthetic id.
      if (message.type === "MF_SELECTION_BEGIN") {
        const data = message.data;
        if (!data || typeof data.id !== "string" || typeof data.selected !== "string" || !data.selected) return;
        void (async () => {
          if (!(await isSignedIn())) {
            console.log('[background] MF_SELECTION_BEGIN refused: not signed in');
            notifyError(ERROR_CODES.NOT_SIGNED_IN);
            return;
          }
          // A selection fact-check that reached this point was confirmed and is signed in,
          // which is the whole of what the app's second guide overlay is asking about. Sent
          // before the run so it is recorded even if the run itself then fails — the user
          // did perform one.
          if (import.meta.env.SAFARI) void markSelectionFactCheck();
          // The same fact where there is no app to report it to. The popup gates its own copy
          // of the guide on it, so without this the guide would keep returning on a build that
          // has no shared container to ask.
          else void browser.storage.local.set({ [SELECTION_FACT_CHECK_KEY]: true }).catch(() => {});
          startSelectionPipeline({
            id: data.id,
            before: typeof data.before === "string" ? data.before : "",
            selected: data.selected,
            after: typeof data.after === "string" ? data.after : "",
            locale: typeof data.locale === "string" && data.locale ? data.locale : getUiLocale(),
            force: data.force === true,
          });
        })();
        return;
      }

      if (message.type === "CLASSIFY_TWEETS") {
        const keepAlive = setInterval(() => {
          // Ping service worker to prevent Chrome from terminating it
          // during long-running classification. Chrome's SW idle timeout is ~30s.
        }, 20000);

        const tweets: MainTweet[] = message.data.filter((t: any) => t != null);
        const batchId = message.batchId ?? nextBatchId();
        const msgLocale: string | null = message.locale ?? null;
        const xhrBatchIndex: number | undefined = message.xhrBatchIndex;
        batchTweets.set(batchId, tweets);
        processFullBatch(port, tweets, batchId, keepAlive, msgLocale, xhrBatchIndex);
        return;
      }

      if (message.type === "TWEET_IN_DOM") {
        const tweetId: string = message.tweetId;
        console.log(`[background] TWEET_IN_DOM ${tweetId}`);
        seenInDom.add(tweetId);
        const resolvers = domFetchResolvers.get(tweetId);
        if (resolvers) {
          console.log(`[background] TWEET_IN_DOM ${tweetId}: resolving ${resolvers.length} waiter(s)`);
          for (const resolve of resolvers) resolve();
          domFetchResolvers.delete(tweetId);
        }
        return;
      }

      // Click on an in-page notification: open the extension popup. This arrives over
      // the long-lived content-script port, which preserves the click's user gesture
      // (Chrome synthesizes one on the receiving end; Firefox and Safari accept a
      // gesture carried this way too) — so openPopup() may legally run here, provided
      // it is called promptly with no awaits in between. Where the browser refuses
      // (notably stable Firefox, and Safari's intermittent false "already open"), the
      // user still needs somewhere to go, so fall back to the top-up flow in a tab.
      if (message.type === "MF_OPEN_POPUP") {
        console.log(`[background] MF_OPEN_POPUP: notification clicked`, message.data);
        // Every kind, not just the money ones. An error notification is red because
        // something refused to pay — a low balance, an expired session, a failed worker —
        // so the balance is what its reader came to see. Landing them on the Fact-Check
        // tab would answer a question they did not ask.
        try { void browser.storage.local.set({ disinfax_popup_tab: 'balance' }); } catch { /* ignore */ }
        // The popup starts a fact-check on its own when the active page has a selection.
        // Someone who just clicked a balance notification is not asking for that, so the
        // origin is marked here and the popup skips the selection flow entirely. A
        // timestamp rather than a boolean: a mark left behind by a popup that never
        // opened would otherwise mislabel the next, ordinary toolbar click. Fire-and-
        // forget — openPopup() below must be reached without awaiting anything.
        try {
          void browser.storage.local.set({ mf_popup_origin: { kind: 'notification', at: Date.now() } });
        } catch { /* ignore */ }
        (async () => {
          try {
            const api = toolbarAction();
            if (typeof api?.openPopup === 'function') await api.openPopup();
            else openTopUpFallback();
          } catch {
            openTopUpFallback();
          }
        })();
        return;
      }

      if (message.type === "REFRESH_BATCH") {
        const { batchId, newBatchId, locale: msgLocale } = message.data;

        // Retrieve stored tweets FIRST, before clearing the batch cache,
        // otherwise batchTweets.get(batchId) returns nothing and we fall
        // back to the relay's capturedTweets (all timeline tweets).
        const tweets = batchTweets.get(batchId) ?? (message.data.tweets as MainTweet[] ?? []);

        // Clear classifications and research cache for this batch
        clearBatch(batchId);
        researchCache.clear();

        if (tweets.length === 0) {
          console.log(`[background] REFRESH_BATCH: no tweets found for ${batchId}`);
          return;
        }

        const useBatchId = newBatchId ?? nextBatchId();
        batchTweets.set(useBatchId, tweets);

        const keepAlive = setInterval(() => {}, 20000);
        processFullBatch(port, tweets, useBatchId, keepAlive, msgLocale);
        return;
      }

      if (message.type === "BATCH_REFRESH_FORCE") {
        const {
          batchId, tweetId: targetTweetId, newBatchId, locale: msgLocale,
          side: refreshSide, sideText: refreshSideText, sideLocale: refreshSideLocale,
        } = message.data;

        // Retrieve stored tweets FIRST, before clearing the batch cache.
        // If targetTweetId was supplied by the click, refresh ONLY that tweet.
        // Otherwise look in batchTweets, falling back to message.data.tweets filtered by targetTweetId.
        let tweets: MainTweet[] = [];
        if (targetTweetId) {
          const cached = tweetCache.get(targetTweetId);
          if (cached) {
            tweets = [cached];
          } else {
            const list = batchTweets.get(batchId) ?? (message.data.tweets as MainTweet[] ?? []);
            tweets = list.filter(t => t.id === targetTweetId);
          }
        } else {
          tweets = batchTweets.get(batchId) ?? (message.data.tweets as MainTweet[] ?? []);
        }

        // Clear classifications and research cache for this batch
        clearBatch(batchId);
        researchCache.clear();

        if (tweets.length === 0) {
          console.log(`[background] BATCH_REFRESH_FORCE: no tweets found for ${batchId} (targetTweetId=${targetTweetId ?? 'none'})`);
          return;
        }

        const useBatchId = newBatchId ?? nextBatchId();

        // Cache incoming tweets so SET_DISPLAYED_LOCALE can look up original/translated text.
        for (const t of tweets) tweetCache.set(t.id, t);

        // Force a fresh reload: drop the per-tweet fetch/session caches and any open
        // subscriptions so processFullBatch re-pulls + re-subscribes from scratch.
        dbMissHashes.clear();
        const forget = (id: string) => {
          dbFetchPromises.delete(id);
          forgetLookup(id);
          reResearchedTweetIds.delete(id);
          localizedHighlightLocales.delete(id);
          factCheckAllTweetIds.delete(id);
          factCheckAllScopedTexts.delete(id);
          // Purge any queued waitlist items or in-flight refreshes for this tweet
          // so refreshing never auto-triggers research or classifications on claims.
          for (let i = factCheckWaitlist.length - 1; i >= 0; i--) {
            if (factCheckWaitlist[i].classificationId === id) {
              const key = `${id}:${factCheckWaitlist[i].claimText}`;
              factCheckWaitlistKeys.delete(key);
              factCheckWaitlist.splice(i, 1);
            }
          }
          for (const k of Array.from(ongoingClaimRefreshes)) {
            if (k.startsWith(`${id}:`)) ongoingClaimRefreshes.delete(k);
          }
          for (const k of Array.from(abandonedFactCheckKeys)) {
            if (k.startsWith(`${id}:`)) abandonedFactCheckKeys.delete(k);
          }
          for (const k of Array.from(researchRequestedBeforeRow)) {
            if (k.startsWith(`${id}:`)) researchRequestedBeforeRow.delete(k);
          }
          const sub = tweetSubs.get(id);
          if (sub) { sub.close(); tweetSubs.delete(id); }
          closeLingeringTweetSubs(id);
          annotationRoutingReady.delete(id);
        };
        for (const t of tweets) {
          forget(t.id);
          if (t.quoting) forget(t.quoting.id);
        }
        // One write for the whole loop rather than one per id: the removals above are the
        // point, and a refresh must not leave a superseded snapshot in the store.
        flushLookupMemo();

        // This IS the click ("Re-classify this tweet's claims"), so run a real
        // preclassification rather than a reload. It used to call processFullBatch, which
        // re-fetches from the DB and re-injects the existing rows on a hit — making the
        // button do visibly nothing for any tweet already stored. `force` skips that
        // pre-check; everything else (hold/spend gating, streaming, persistence, the
        // no-claims retry path) is the same shared helper the Disinfact button uses.
        const refreshLocale = msgLocale ?? getUiLocale();
        // The pressed group names the side it stands over, exactly as the Disinfact button
        // does. The captured tweet reports whatever translation the host had on screen as
        // "displayed", so without this the group seated over the source re-classified the
        // translation beside it and the two sides swapped what they offered.
        const refreshDisplayedSide = refreshSide === 'alt' ? 'ORIGINAL'
          : refreshSide === 'translation' ? 'TRANSLATED' : null;
        // A press the seam cannot name a side for (`refreshSide` undefined) still hands the
        // words on screen, and they are what decides: the run compares them with the capture
        // and classifies the side actually being read (see `runPreclassification`). Left out,
        // the press reclassified the capture's source while the reader read the translation.
        const refreshSideArgs = [
          refreshDisplayedSide,
          refreshDisplayedSide === 'ORIGINAL' ? null : (refreshSideText ?? null),
          refreshDisplayedSide === 'TRANSLATED' ? (refreshSideLocale ?? null) : null,
          refreshSide === 'alt' || refreshSide === 'translation' ? refreshSide : null,
        ] as const;
        (async () => {
          for (const t of tweets) {
            try {
              const hash = await computeTweetHash(t);
              runPreclassification({ tweet: t, hash }, refreshLocale, "BATCH_REFRESH_FORCE", true, ...refreshSideArgs);
            } catch (err: any) {
              console.error(`[background] BATCH_REFRESH_FORCE: hash failed for ${t.id}:`, err);
            }
          }
        })();
        return;
      }

      // ── Flow B: annotations-only. The Annotate badge sends claim locators; the
      // annotation agent runs alone (no research, no searches, no verdict race) and
      // streams {range, correction} NDJSON back. Tracked in ongoingClaimRefreshes
      // under an "annot:" key so a double-tap can't double-spend; merges go through
      // mergeClaimPayload so matching/dedup stay in one place. Text NEVER leaves this
      // function except as hash input — only locators are sent, and the worker plus
      // get_annotation_context re-derive everything trust-sensitive server-side.
      if (message.type === "ANNOTATE_CLAIM") {
        void (async () => {
          const { classificationId, claimText, locale: msgLocale, selection: msgSelection, side: namedSide, sideText, sideLocale } = message.data;
          let hit = classificationCache.get(classificationId);
          if (!hit) {
            await restoreSelectionPipeline();
            hit = classificationCache.get(classificationId);
          }
          if (!hit) {
            console.log(`[background] ANNOTATE_CLAIM: no cached classification for ${classificationId}`);
            for (const port of activePorts) {
              try { port.postMessage({ type: "ANNOTATE_FAILED", data: { classificationId, claimText } }); } catch {}
            }
            return;
          }
        const classification = hit.classification;
        const anyBatchId = hit.batchIds.values().next().value ?? '';
        const locale = msgLocale ?? getUiLocale();

        if (isSelectionId(classificationId) && msgSelection && !tweetCache.has(classificationId)) {
          const tweet = {
            id: classificationId,
            text: msgSelection.selected,
            fullText: msgSelection.selected,
            username: '',
            usertype: 'None',
            time: new Date().toISOString(),
            contextBefore: msgSelection.before,
            contextAfter: msgSelection.after,
            sourceLanguage: UNKNOWN_LANGUAGE,
          } as unknown as MainTweet;
          tweetCache.set(classificationId, tweet);
          persistSelectionPipeline();
        }

        let claim = classification.claims?.find(c => c.text === claimText)
          ?? classification.quoting?.claims?.find(c => c.text === claimText);
        if (!claim) {
          console.log(`[background] ANNOTATE_CLAIM: claim not found for "${claimText.slice(0, 40)}..."`);
          for (const port of activePorts) {
            try { port.postMessage({ type: "ANNOTATE_FAILED", data: { classificationId, claimText } }); } catch {}
          }
          return;
        }

        // If dbClaimId is missing, resolve it from DB
        if (!claim.dbClaimId) {
          const candidateText = claim.rewritten ?? claim.dbClaimText ?? claim.text;
          const pulled = await getFullClaim({ text: candidateText, locale });
          if (pulled?.id) {
            claim.dbClaimId = pulled.id;
            mergeClaimPayload(classificationId, pulled, locale);
            const refetched = classificationCache.get(classificationId)?.classification;
            claim = refetched?.claims?.find(c => c.text === claimText)
              ?? refetched?.quoting?.claims?.find(c => c.text === claimText)
              ?? claim;
          }
        }

        // Never annotate a stale or unclassified claim: a stale verdict must be
        // re-researched first, and a placeholder has no reasoning to annotate yet.
        // (The worker re-checks this server-side; this is just the cheap client gate
        // so an obviously pointless tap doesn't spend the hold.)
        if (claim.reclassifyOnHold || claim.note == null) {
          console.log(`[background] ANNOTATE_CLAIM: claim not classified (onHold=${!!claim.reclassifyOnHold}, note=${claim.note != null}), skipping`);
          for (const port of activePorts) {
            try { port.postMessage({ type: "ANNOTATE_FAILED", data: { classificationId, claimText } }); } catch {}
          }
          return;
        }

        const annotKey = `annot:${classificationId}:${claimText}`;
        if (ongoingClaimRefreshes.has(annotKey)) {
          console.log(`[background] ANNOTATE_CLAIM: already annotating "${claimText.slice(0, 40)}...", skipping re-run`);
          return;
        }
        // A Flow A run is already annotating this claim (its research launched
        // with locators — see the withLocators stamp): a concurrent Flow B
        // would double the paid hold and race it on the same key. The content
        // script suppresses the tap the same way; this is the backstop for a
        // stale tab that never saw the marker.
        if (ongoingClaimRefreshes.has(`${classificationId}:${claimText}`)) {
          console.log(`[background] ANNOTATE_CLAIM: Flow A research in flight for "${claimText.slice(0, 40)}...", skipping re-run`);
          return;
        }
        ongoingClaimRefreshes.add(annotKey);

        gatedSpendAttributed(async (onBalanceError) => {
          try {
            const freshCls = classificationCache.get(classificationId)?.classification ?? classification;
            const loc = await annotLocatorsFor(classificationId, freshCls.claims, claimText, freshCls, namedSide ?? null, sideText ?? null, sideLocale ?? null)
              ?? await annotLocatorsFor(classificationId, freshCls.quoting?.claims, claimText, freshCls);
            if (!loc) {
              console.log(`[background] ANNOTATE_CLAIM: could not resolve locators for "${claimText.slice(0, 40)}...", skipping`);
              for (const port of activePorts) {
                try { port.postMessage({ type: "ANNOTATE_FAILED", data: { classificationId, claimText } }); } catch {}
              }
              return;
            }

            // Ensure tweet subscription is open so worker's DB persist broadcasts reach the client
            await ensureAnnotationSubscription(classificationId, claimText, locale);

            // See paintAnnotationsLive for the key shape and why the merge is a union.
            const paintLive = (acc: Record<string, string>) =>
              paintAnnotationsLive(classificationId, claimText, anyBatchId, loc.textLocale, acc);
            const finalAcc = await backgroundAnnotate(
              loc.tweetHash, loc.tweetText, loc.textLocale,
              claim.dbClaimId, loc.claimIndex, locale,
              paintLive
            );
            // null = transport failure or server-side skip (stale/unclassified/forged
            // revision — the worker returns 200-empty with X-Annotate-Skipped). Either
            // way the badge stays: a fake "clean" {} would be a lie either way, and a
            // real {} arrives through finalAcc (persisted + live-painted above).
            if (finalAcc === null) {
              for (const port of activePorts) {
                try { port.postMessage({ type: "ANNOTATE_FAILED", data: { classificationId, claimText } }); } catch {}
              }
              return;
            }
            // The authoritative broadcast (annotations trigger) folds the persisted
            // dict in; paint once more in case any line arrived after the last onPartial.
            paintLive(finalAcc);
          } catch (err: any) {
            console.error("[background] ANNOTATE_CLAIM error:", err);
            for (const port of activePorts) {
              try { port.postMessage({ type: "ANNOTATE_FAILED", data: { classificationId, claimText } }); } catch {}
            }
          } finally {
            ongoingClaimRefreshes.delete(annotKey);
          }
        });
        })();
        return;
      }

      if (message.type === "REFRESH_CLAIM") {
        const { classificationId, claimText, locale: msgLocale, side, sideText, sideLocale } = message.data;
        const hit = classificationCache.get(classificationId);
        if (!hit) {
          console.log(`[background] REFRESH_CLAIM: no cached classification for ${classificationId}`);
          return;
        }
        const classification = hit.classification;
        // Use the first batchId this classification belongs to
        const anyBatchId = hit.batchIds.values().next().value ?? '';

        // Broadcast the refreshing state immediately: keep the existing badge label
        // (verdict/confidence/veracity) AND the current reasoning so the user keeps reading
        // it while the re-research runs — only the `refreshing` flag changes, which shows a
        // spinner beside the text. (Nulling the note here used to blank the reasoning and
        // replace it with a spinner, leaving the popover empty for the whole call.)
        const fcClassification = {
          ...classification,
          claims: (classification.claims ?? []).map(cl =>
            cl.text === claimText
              ? { ...cl, refreshing: true }
              : cl
          ) ?? null,
          quoting: classification.quoting
            ? {
                ...classification.quoting,
                claims: (classification.quoting.claims ?? []).map(cl =>
                  cl.text === claimText
                    ? { ...cl, refreshing: true }
                    : cl
                ) ?? null,
              }
            : null,
        };
        fcClassification.batchId = anyBatchId;
        cacheClassification(fcClassification, anyBatchId);
        safePostToPort(port, { type: "CLASSIFICATION", data: fcClassification });
        broadcastClassification(fcClassification);

        // Guard: prevent concurrent reclassification of the same claim
        const refreshKey = `${classificationId}:${claimText}`;
        if (ongoingClaimRefreshes.has(refreshKey)) {
          console.log(`[background] REFRESH_CLAIM: already refreshing "${claimText.slice(0, 40)}...", skipping re-run`);
          return;
        }
        ongoingClaimRefreshes.add(refreshKey);

        console.log(`[background] REFRESH_CLAIM: refreshing "${claimText.slice(0, 40)}..." for ${classificationId}`);

        // Extract tweet URLs for the classify worker if the tweet is cached
        const cachedTweet = tweetCache.get(classificationId);
        const tweetUrls = cachedTweet ? extractTweetUrls(cachedTweet.text) : undefined;

        gatedSpendAttributed(async (onBalanceError) => {
          let handled = false, gotUpdate = false;
          try {
            // Explicit "Re-research this claim" click: force a real reclassification rather
            // than settling for whatever the DB already has. Resolve/subscribe to the row,
            // but never short-circuit on an existing result — replacing it IS the request.
            handled = await pullClaimBeforeClassify(classificationId, claimText, msgLocale ?? getUiLocale(), true);
            if (!handled) {
              // Re-read fresh: see the comment at the admitFactCheckClaim call site —
              // pullClaimBeforeClassify may have just merged a dbClaimId in that this
              // stale `classification` snapshot doesn't have yet.
              const freshCls = classificationCache.get(classificationId)?.classification ?? classification;
              // Flow A's annotation persist broadcasts tweet-scoped, so it needs a
              // live tweet subscription to reach the client (see helper).
              await ensureAnnotationSubscription(classificationId, claimText, msgLocale ?? getUiLocale());
              // The tapped span names the side it was painted on. Without it the locators read
              // the payload's DISPLAYED side, which on a dual post is whichever body the host
              // calls displayed — and a reclassify on the source then measures its correction
              // into the translation and files it under the translation's locale. That also
              // decides which side's old annotation survives the supersession below.
              const annotLoc = await annotLocatorsFor(classificationId, freshCls.claims, claimText, freshCls, side ?? null, sideText ?? null, sideLocale ?? null)
                ?? await annotLocatorsFor(classificationId, freshCls.quoting?.claims, claimText, freshCls);
              for await (const updated of refreshClaim(freshCls, claimText, researchCache, msgLocale ?? getUiLocale(), tweetUrls, onBalanceError, annotLoc)) {
                gotUpdate = true;
                // Locators rode along, so the worker's silent post-research run is
                // in flight — "Annotating", not idle Annotate (see call site above).
                mergeSingleClaimAndBroadcast(classificationId, claimText, updated, anyBatchId, { withLocators: !!annotLoc, annotatedLocale: annotLoc?.textLocale });
              }
              if (annotLoc) await settleFlowAAnnotations(classificationId, claimText, annotLoc, anyBatchId);
            }
          } catch (err: any) {
            console.error("[background] REFRESH_CLAIM error:", err);
          } finally {
            ongoingClaimRefreshes.delete(refreshKey);
            // Any backend failure → clear the spinner and show the claim's previous verdict
            // again (this is a re-classify of an already-classified claim, so its prior state
            // is the verdict, not the on-hold button).
            if (!(handled || gotUpdate)) {
              const cur = classificationCache.get(classificationId)?.classification;
              if (cur) {
                const reverted: Classification = { ...cur, claims: cur.claims?.map(cl => cl.text === claimText ? { ...cl, refreshing: false } : cl) ?? null };
                reverted.batchId = anyBatchId;
                cacheClassification(reverted, anyBatchId);
                broadcastClassification(reverted);
              }
            }
          }
        });
      }

      if (message.type === "PROCESS_ON_HOLD") {
        const { tweetId, locale: msgLocale, displayedSide, displayedText, displayedLocale, side: namedSide, fromSelection } = message.data;
        const locale = msgLocale ?? getUiLocale();
        const entry = onHoldTweets.get(tweetId);
        if (!entry) {
          // No entry YET — not a dead tap. The usual cause is a worker restart
          // after backgrounding/long idle: the relay reconnects and re-sends the
          // batch, but this tap won the race and arrived before hashing + DB
          // lookup recreated the entry. Park the intent; flushPendingProcessOnHold
          // honors it the moment the entry is created. (Dropping it here is what
          // made the button spin for 30s and silently revert.)
          const existing = pendingProcessOnHold.get(tweetId);
          if (existing) clearTimeout(existing.timer);
          console.log(`[background] PROCESS_ON_HOLD: no on-hold tweet for ${tweetId} yet, parking tap`);
          pendingProcessOnHold.set(tweetId, {
            locale,
            displayedSide: displayedSide ?? null,
            displayedText: displayedText ?? null,
            displayedLocale: displayedLocale ?? null,
            namedSide: namedSide ?? null,
            fromSelection: fromSelection === true,
            timer: setTimeout(() => {
              pendingProcessOnHold.delete(tweetId);
              console.log(`[background] PROCESS_ON_HOLD: parked tap for ${tweetId} timed out, dropped`);
            }, PENDING_PROCESS_ON_HOLD_TIMEOUT_MS),
          });
          return;
        }
        // A live tap supersedes any stale parked one (e.g. parked during a prior
        // run that since completed) — the entry is claimed below either way.
        const stalePending = pendingProcessOnHold.get(tweetId);
        if (stalePending) {
          pendingProcessOnHold.delete(tweetId);
          clearTimeout(stalePending.timer);
        }
        // Claim it immediately so a double-click can't start two pipelines.
        onHoldTweets.delete(tweetId);
        console.log(`[background] PROCESS_ON_HOLD: ${tweetId}`);
        // `displayedSide` comes from X's toggle row at click time. `entry` is the tweet as
        // first captured and has no idea the user switched sides since, so without it
        // runPreclassification would key highlights under the translation's locale for a
        // user reading the original.
        runPreclassification(entry, locale, "PROCESS_ON_HOLD", false, displayedSide ?? null, displayedText ?? null, displayedLocale ?? null, namedSide ?? null, fromSelection === true);
        return;
      }

      if (message.type === "FACT_CHECK_ALL") {
        const { tweetId, locale: msgLocale, claimTexts } = message.data;
        // A revealed area hands over only the claims under it; the button hands over every
        // claim still on hold. Either way the mask below is the Fact-Check All one: the
        // claims are painted as researching for the whole wait, not just their own row's.
        const scoped = Array.isArray(claimTexts) && claimTexts.length > 0
          ? new Set(claimTexts.filter((t: unknown): t is string => typeof t === 'string'))
          : null;
        factCheckAllTweetIds.add(tweetId);
        if (scoped) factCheckAllScopedTexts.set(tweetId, scoped);
        else factCheckAllScopedTexts.delete(tweetId);
        console.log(`[background] FACT_CHECK_ALL for ${tweetId}${scoped ? ` (${scoped.size} claim(s) scoped)` : ''}`);
        // A fresh Fact-Check All is a deliberate retry: clear any claims abandoned on a prior
        // batch for this tweet so they can be waitlisted again.
        for (const k of Array.from(abandonedFactCheckKeys)) if (k.startsWith(`${tweetId}:`)) abandonedFactCheckKeys.delete(k);

        // Waitlist every claim still showing a Disinfact button now — including change-prone
        // DB claims that carry cached values, not just fresh no-DB-match ones.
        const hit = classificationCache.get(tweetId);
        if (hit) {
          const classification = hit.classification;
          const batchId = hit.batchIds.values().next().value ?? '';
          const locale = msgLocale ?? getUiLocale();
          for (const cl of classification.claims ?? []) {
            // Flagged claims are not part of the post's highlights, so the button's batch
            // leaves them alone; a passage's scoped request names its own claims, flagged
            // ones included.
            if (cl.reclassifyOnHold && (!scoped || scoped.has(cl.text)) && (scoped || cl.isHidden !== true)) {
              enqueueFactCheckClaim(tweetId, cl.text, batchId, locale);
            }
          }
          // The researching paint is a broadcast-time mask (`isRequestedClaim`), and the loop
          // above may have admitted nothing — a claim still waiting on its DB row is only
          // waitlisted by the broadcast that delivers that row. Without a repaint here the
          // client keeps whatever it last painted, which for a parked claim is the Fact-Check
          // button: the "button while loading" a scoped request must never show. Read the
          // cache back, because an admission inside the loop has already replaced it.
          const latest = classificationCache.get(tweetId)?.classification;
          if (latest) broadcastClassification(latest);
        }
        return;
      }

      if (message.type === "RECLASSIFY_ON_HOLD_CLICK") {
        const { classificationId, claimText, locale: msgLocale } = message.data;
        void (async () => {
        if (isSelectionId(classificationId)) await selectionPipelineReady;
        const hit = classificationCache.get(classificationId);
        if (!hit) {
          console.log(`[background] RECLASSIFY_ON_HOLD_CLICK: no cached classification for ${classificationId}`);
          return;
        }
        const classification = hit.classification;
        const anyBatchId = hit.batchIds.values().next().value ?? '';
        const locale = msgLocale ?? getUiLocale();

        const holdKey = `${classificationId}:${claimText}`;
        pendingFreshResearchClaims.delete(holdKey);

        const claimObj = classification.claims?.find(cl => cl.text === claimText);
        // The claim's DB row decides this click: until fetch-claim has written it there is no
        // way to tell a claim that needs research from one a classified claim already
        // answers. Record the request, present the claim as researching, and let the row's
        // broadcast start — or rule out — the run (see broadcastClassification). Without
        // this the click researches the streamed claim, which is on hold by construction.
        if (claimObj && !claimObj.dbClaimId) {
          researchRequestedBeforeRow.add(holdKey);
          const pendingClaims = classification.claims?.map(cl =>
            cl.text === claimText ? { ...cl, reclassifyOnHold: false, refreshing: true } : cl
          ) ?? null;
          const pending: Classification = { ...classification, claims: pendingClaims };
          pending.batchId = anyBatchId;
          cacheClassification(pending, anyBatchId);
          broadcastClassification(pending);
          console.log(`[background] RECLASSIFY_ON_HOLD_CLICK ${classificationId}: "${claimText.slice(0, 40)}..." has no DB row yet — deferring research to it`);
          return;
        }

        // Pipeline claim: the user clicked the Disinfact badge while the
        // fetch-claim call was still in-flight or before the reclassifyOnHold
        // broadcast arrived. Set the claim to refreshing and start fresh research.
        if (claimObj && !claimObj.reclassifyOnHold && !claimObj.refreshing && (claimObj.verdict === "research required" || !claimObj.note)) {
          const pipelineUpdated = classification.claims?.map(cl =>
            cl.text === claimText
              ? { ...cl, refreshing: true, note: null }
              : cl
          ) ?? null;
          const pipelineRestored: Classification = {
            ...classification,
            claims: pipelineUpdated,
          };
          pipelineRestored.batchId = anyBatchId;
          cacheClassification(pipelineRestored, anyBatchId);
          broadcastClassification(pipelineRestored);

          const refreshKey = `${classificationId}:${claimText}`;
          if (ongoingClaimRefreshes.has(refreshKey)) {
            console.log(`[background] RECLASSIFY_ON_HOLD_CLICK: already refreshing pipeline claim "${claimText.slice(0, 40)}...", skipping`);
            return;
          }
          ongoingClaimRefreshes.add(refreshKey);
          const cachedTweet = tweetCache.get(classificationId);
          const tweetUrls = cachedTweet ? extractTweetUrls(cachedTweet.text) : undefined;
          console.log(`[background] RECLASSIFY_ON_HOLD_CLICK: starting fresh research for pipeline claim "${claimText.slice(0, 40)}..."`);
          const pipelineResearchPromise = gatedSpendAttributed(async (onBalanceError) => {
            let handled = false, gotUpdate = false;
            try {
              handled = await pullClaimBeforeClassify(classificationId, claimText, locale);
              if (!handled) {
                // Re-read fresh: see the comment at the admitFactCheckClaim call site —
                // pullClaimBeforeClassify may have just merged a dbClaimId in that this
                // stale `pipelineRestored` snapshot doesn't have yet.
                const freshCls = classificationCache.get(classificationId)?.classification ?? pipelineRestored;
                // Flow A's annotation persist broadcasts tweet-scoped, so it needs a
                // live tweet subscription to reach the client (see helper).
                await ensureAnnotationSubscription(classificationId, claimText, locale);
                const annotLoc = await annotLocatorsFor(classificationId, freshCls.claims, claimText, freshCls)
                  ?? await annotLocatorsFor(classificationId, freshCls.quoting?.claims, claimText, freshCls);
                for await (const updated of refreshClaim(freshCls, claimText, researchCache, locale, tweetUrls, onBalanceError, annotLoc)) {
                  gotUpdate = true;
                  // Locators rode along, so the worker's silent post-research run is
                  // in flight — "Annotating", not idle Annotate (see admit site).
                  mergeSingleClaimAndBroadcast(classificationId, claimText, updated, anyBatchId, { withLocators: !!annotLoc, annotatedLocale: annotLoc?.textLocale });
                }
                if (annotLoc) await settleFlowAAnnotations(classificationId, claimText, annotLoc, anyBatchId);
              }
            } catch (err: any) {
              console.error("[background] RECLASSIFY_ON_HOLD_CLICK pipeline refresh error:", err);
            } finally {
              ongoingClaimRefreshes.delete(refreshKey);
              // Any backend failure → revert to the on-hold button so the user can retry.
              if (!(handled || gotUpdate)) revertClaimToOnHold(classificationId, claimText, anyBatchId);
              else if (!handled) settleClaimResearch(classificationId, claimText, anyBatchId, true);
            }
          });
          trackClaimResearch(refreshKey, pipelineResearchPromise);
          return;
        }

        // Standard path: claim already has reclassifyOnHold = true.
        // Restore cached values and clear on-hold flag. Keep the cached reasoning
        // (cachedNote) visible while re-researching — it is replaced once the new
        // reasoning streams in; a claim with no prior reasoning falls back to null.
        const updatedClaims = classification.claims?.map(cl => {
          if (cl.text === claimText && cl.reclassifyOnHold) {
            return {
              ...cl,
              reclassifyOnHold: false,
              refreshing: true,
              verdict: cl.cachedVerdict ?? cl.verdict,
              note: cl.cachedNote ?? cl.note,
              confidence: cl.cachedConfidence ?? cl.confidence,
              veracity: cl.cachedVeracity ?? cl.veracity,
              sources: cl.cachedSources ?? cl.sources,
            };
          }
          return cl;
        }) ?? null;

        // Clear reclassifyOnHold on classification if no claims remain on hold
        const anyOnHold = updatedClaims?.some(cl => cl.reclassifyOnHold) ?? false;
        const restored: Classification = {
          ...classification,
          claims: updatedClaims,
          reclassifyOnHold: anyOnHold || undefined,
        };
        restored.batchId = anyBatchId;
        cacheClassification(restored, anyBatchId);
        broadcastClassification(restored);

        // If buffered re-research result already arrived, merge it in.
        const buffered = heldReclassifications.get(holdKey);
        if (buffered) {
          console.log(`[background] RECLASSIFY_ON_HOLD_CLICK: applying buffered re-research for ${holdKey}`);
          heldReclassifications.delete(holdKey);
          mergeRefreshFor(restored)(buffered);
          return;
        }

        // No buffered result: fire re-research on user click.
        // Guard against concurrent refreshes for the same claim.
        const refreshKey = `${classificationId}:${claimText}`;
        if (ongoingClaimRefreshes.has(refreshKey)) {
          console.log(`[background] RECLASSIFY_ON_HOLD_CLICK: already refreshing "${claimText.slice(0, 40)}...", skipping re-run`);
          return;
        }
        ongoingClaimRefreshes.add(refreshKey);

        const cachedTweet = tweetCache.get(classificationId);
        const tweetUrls = cachedTweet ? extractTweetUrls(cachedTweet.text) : undefined;
        console.log(`[background] RECLASSIFY_ON_HOLD_CLICK: starting refresh for "${claimText.slice(0, 40)}..."`);
        const reclassifyResearchPromise = gatedSpendAttributed(async (onBalanceError) => {
          let handled = false, gotUpdate = false;
          try {
            handled = await pullClaimBeforeClassify(classificationId, claimText, locale);
            if (!handled) {
              // Re-read fresh: see the comment at the admitFactCheckClaim call site —
              // pullClaimBeforeClassify may have just merged a dbClaimId in that this
              // stale `restored` snapshot doesn't have yet.
              const freshCls = classificationCache.get(classificationId)?.classification ?? restored;
              // Flow A's annotation persist broadcasts tweet-scoped, so it needs a
              // live tweet subscription to reach the client (see helper).
              await ensureAnnotationSubscription(classificationId, claimText, locale);
              const annotLoc = await annotLocatorsFor(classificationId, freshCls.claims, claimText, freshCls)
                ?? await annotLocatorsFor(classificationId, freshCls.quoting?.claims, claimText, freshCls);
              for await (const updated of refreshClaim(freshCls, claimText, researchCache, locale, tweetUrls, onBalanceError, annotLoc)) {
                gotUpdate = true;
                // Locators rode along, so the worker's silent post-research run is
                // in flight — "Annotating", not idle Annotate (see admit site).
                mergeSingleClaimAndBroadcast(classificationId, claimText, updated, anyBatchId, { withLocators: !!annotLoc, annotatedLocale: annotLoc?.textLocale });
              }
              if (annotLoc) await settleFlowAAnnotations(classificationId, claimText, annotLoc, anyBatchId);
            }
          } catch (err: any) {
            console.error("[background] RECLASSIFY_ON_HOLD_CLICK refresh error:", err);
          } finally {
            ongoingClaimRefreshes.delete(refreshKey);
            // Any backend failure → revert to the on-hold button so the user can retry.
            if (!(handled || gotUpdate)) revertClaimToOnHold(classificationId, claimText, anyBatchId);
            else if (!handled) settleClaimResearch(classificationId, claimText, anyBatchId, true);
          }
        });
        trackClaimResearch(refreshKey, reclassifyResearchPromise);
        })();
        return;
      }

      if (message.type === "TRANSLATE_FACT_CHECKS") {
        const { tweetId, locale: msgLocale, side, sideText, sideLocale } = message.data;
        const hit = classificationCache.get(tweetId);
        if (!hit) {
          // A press that reaches here has a bar on screen, so this means the cache no longer
          // names the id that bar carries. Say so: the press is otherwise indistinguishable
          // from a button that did nothing (the bar re-syncs to its idle Localize at once).
          console.warn(`[background] TRANSLATE_FACT_CHECKS: no cached classification for ${tweetId} (side=${side ?? 'none'})`);
          return;
        }
        const classification = hit.classification;
        const locale = msgLocale ?? getUiLocale();
        const anyBatchId = hit.batchIds.values().next().value ?? '';

        // Clear the on-hold flag and mark highlight localization as in-progress
        // so the content script suppresses the fallback area until it completes.
        const unheld: Classification = { ...classification, translateFactChecksOnHold: undefined, localizingHighlights: true };
        unheld.batchId = anyBatchId;
        cacheClassification(unheld, anyBatchId);
        broadcastClassification(unheld);

        console.log(`[background] TRANSLATE_FACT_CHECKS: starting localization + translation for ${tweetId}`);

        // Get tweet data: from dbHitCache if available, otherwise from tweetCache
        const dbEntry = dbHitCache.get(tweetId);
        const cachedTweet = tweetCache.get(tweetId);
        const tweet = withDisplayedSide(tweetId, dbEntry?.tweet ?? cachedTweet);
        const dbClaims = dbEntry?.dbClaims;
        // Which body this press is for. A platform showing both sides at once paints each from
        // the same claims, but the ranges are filed under one language, so the side they were
        // not filed under has nothing to paint — and its group offers this action rather than
        // the highlight controls (see `syncButtonBarAt`). Pressed there, the words to localize
        // INTO are the post's own (`text`, which is what names it) and the key to file under is
        // its own language, which most platforms state and Facebook does not: it answers `und`
        // there, and `und` is still the right key — the worker aligns the claims to whatever
        // text it is handed, and every later read of that side looks the ranges up by the same
        // name.
        const altSide = side === 'alt';
        // The translation-row group names its own side, and with it the copy it is painted
        // over. Both are load-bearing here: this classification was built for the OTHER
        // side, so its `textLocale` and `translatedText` name that side's words — a source
        // run stamps both with the source — and reading them for the translation's Localize
        // localizes the source while filing its ranges under the translation's language.
        const translationSide = side === 'translation';
        // The body the localizing press handed over, which only says something when it is a
        // DIFFERENT revision than the capture holds (see displayedText): a host auto-translation
        // the extension never fetched gets filed as the post's own words, so switching back to
        // the source leaves the capture naming the wrong side. Localizing against it measured
        // ranges into words the page no longer showed — charged, painted nothing.
        const cachedBody = unheld.translatedText ?? tweet?.translatedText ?? tweet?.text ?? '';
        const handedBody = !altSide && !translationSide && typeof sideText === 'string' ? sideText.trim() : '';
        const swappedBody = handedBody && !sameBodyRevision(handedBody, cachedBody) ? handedBody : undefined;
        const displayedLocale = altSide
          ? tweet?.sourceLanguage
          : translationSide
            ? (sideLocale ?? tweet?.destinationLanguage ?? UNKNOWN_LANGUAGE)
            : unheld.textLocale ?? tweet?.destinationLanguage ?? tweet?.sourceLanguage;

        const clearLocalizingHighlights = () => {
          const cur = classificationCache.get(tweetId)?.classification;
          if (cur?.localizingHighlights) {
            const cleared = { ...cur, localizingHighlights: false };
            cacheClassification(cleared, anyBatchId);
            broadcastClassification(cleared);
          }
        };

        // Flow C persists its annotations AFTER the highlight stream closes, so —
        // like Flow A — they reach the client only via the tweet-scoped annotation
        // broadcast (trg_tweet_claim_annotations_updated → routing row → Realtime).
        // Warm the subscription(s) BEFORE the worker runs so the persist finds a
        // routing row; without this the new-locale ranges sit in the DB until reload
        // while the client keeps painting the stale locale's pair.
        //
        // Backfill: on a retry the annotations are ALREADY persisted (Flow C's
        // annotations_present gate skips re-persisting — no UPDATE, no broadcast),
        // so merge them from the stored dbClaims directly. The gate strips to the
        // displayed revision (revisionGateFor holds the originals since the
        // spurious-Localize fix), and the union keeps the freshly-streamed `es`
        // highlights — both land in one broadcast.
        const backfillAnnotations = (body: string, runLocale: string) => {
          const gate = revisionGateFor(tweet, tweet?.quoting);
          const cur = classificationCache.get(tweetId)?.classification;
          if (!cur?.claims) return;
          // Under the locale this run filed, only THIS run's body may come back. The gate is
          // deliberately wider — "another held body" is still a genuine revision — but a host
          // that states no language (Facebook) files both sides of a post under one locale
          // prefix, so there the wider tier hands this side the OTHER side's corrections and
          // they paint over words they never addressed, which is the annotation that lands
          // when the agent found nothing here. Other locales are left exactly as the gate
          // reads them: on a host that names each side's language they can only paint there.
          const bodyHash = sha256HexSync(body);
          const runFull = runLocale.toLowerCase();
          const runBase = runFull.split('-')[0];
          const dbByText = new Map<string, any>();
          for (const d of dbClaims ?? []) {
            const key = extractClaimText((d as any).claim);
            if (key && !dbByText.has(key)) dbByText.set(key, d);
          }
          let touched = false;
          const claims = cur.claims.map(cl => {
            const d = dbByText.get(cl.dbClaimText ?? cl.text) ?? dbByText.get(cl.text);
            const rawA = d?.annotations;
            if (!d || !rawA || typeof rawA !== 'object') return cl;
            const ownA: Record<string, Record<string, string>> = {};
            for (const [k, v] of Object.entries(rawA as Record<string, unknown>)) {
              if (v === null || typeof v !== 'object' || Array.isArray(v)) continue;
              const split = splitHighlightKey(k);
              if (split) {
                const prefix = split[0].toLowerCase();
                if ((prefix === runFull || prefix.split('-')[0] === runBase) && split[1] !== bodyHash) continue;
              }
              ownA[k] = v as Record<string, string>;
            }
            const stripped = selectAnnotationRevision(ownA, gate);
            const merged = unionAnnotations(cl.annotations, Object.keys(stripped).length > 0 ? stripped : undefined);
            if (JSON.stringify(merged ?? {}) === JSON.stringify(cl.annotations ?? {})) return cl;
            touched = true;
            return { ...cl, annotations: merged };
          });
          if (touched) {
            const merged = { ...cur, claims };
            cacheClassification(merged, anyBatchId);
            broadcastClassification(merged);
            console.log(`[background] TRANSLATE_FACT_CHECKS: backfilled persisted annotations for ${tweetId}`);
          }
        };
        const warmAnnotationSubs = async () => {
          const texts = [
            ...(unheld.claims ?? []).map(c => c.text),
            ...(unheld.quoting?.claims ?? []).map(c => c.text),
          ];
          for (const ct of texts) await ensureAnnotationSubscription(tweetId, ct, locale);
        };

        if (displayedLocale && tweet) {
          const tweetText = altSide
            ? tweet.text
            : translationSide
              ? (sideText ?? tweet?.translatedText ?? tweet.text)
              : swappedBody ?? unheld.translatedText ?? tweet.translatedText ?? tweet.text;
          // The classification that carries these ranges must name the side they were
          // measured against. `unheld` names the OTHER side — this run was built for it, so
          // its `textLocale` and `translatedText` point at that side's words — and the client
          // resolves ranges through exactly those two fields, not through the map they are
          // filed in. Merged unstamped, a named side's fresh ranges were resolved against the
          // other body, matched nothing, and were never painted: the Localize press landed its
          // ranges silently and the page stayed bare. Only a successful run merges this
          // (mergeHighlightsFor spreads it over the cached classification), so a failed one
          // leaves the classification exactly as it was.
          //
          // ...except the source group of a post showing BOTH sides. There `textElement` still
          // names the translation, and these two fields are what the client cuts `segments`
          // from — the ranges it paints into that translation. Stamped with the source, the
          // client's `alignDualSideSegments` moved them onto the post's own words (correctly),
          // left `segments` plain, and the translation's group read no ranges of its own and
          // offered Localize again over a side it had just reclassified (reported 2026-10-19).
          // The source's fresh ranges do not need the stamp: they are filed under
          // `displayedLocale` (`und` on Facebook), the key `altSegments` resolves them by, and
          // they reach that side without moving the classification's named body.
          //
          // ...unless that named body IS the one the run measured. A classification can name
          // the source's own words under another key — a side reported by a host state that
          // lagged the markup, or a flip restored from a body-matched record — and then the
          // key it carries holds no range for those words at all: `segments` cut the source,
          // resolved the old locale, found nothing, and the press painted nothing until a flip
          // away and back re-pointed the classification at the same words under the new key
          // (reported 2026-10-25 on a LinkedIn comment localized from its source side). The
          // stamp moves nothing: it names the body already named, under the key this run filed
          // its ranges with, which is the one honest name for them.
          const namesRunBody = altSide && !!displayedLocale
            && typeof tweetText === 'string' && typeof unheld.translatedText === 'string'
            && sameBodyExactly(tweetText, unheld.translatedText);
          const stamped: Classification = (translationSide || swappedBody || namesRunBody)
            ? { ...unheld, textLocale: displayedLocale, translatedLocale: displayedLocale, translatedText: tweetText }
            : unheld;
          // The swapped body survives later DB reads only through displayedSides: the revision
          // gate hashes every body recorded there, and the capture still holds the other side.
          if (swappedBody && displayedLocale) {
            recordDisplayedSide(tweetId, swappedBody, displayedLocale);
          }
          if (dbClaims) {
            // DB hit path: use cached claims for highlight localization
            gatedSpend(async () => {
              try {
                await warmAnnotationSubs();
                await localizeHighlights(tweetId, tweet, tweetText, displayedLocale, dbClaims, stamped, locale, mergeHighlightsFor(stamped));
                // Retry with annotations already persisted: Flow C's
                // annotations_present gate skips re-writing (no UPDATE → no
                // broadcast), so pull the stored dicts in directly.
                backfillAnnotations(tweetText, displayedLocale);
              } catch (e) {
                console.error('[TRANSLATE_FACT_CHECKS] highlight error:', e);
                clearLocalizingHighlights();
              }
            });
          } else {
            // Freshly classified: derive claims from classification for localization
            const clsDbClaims = claimsToDbClaims(unheld);
            gatedSpend(async () => {
              try {
                await warmAnnotationSubs();
                await localizeHighlights(tweetId, tweet, tweetText, displayedLocale, clsDbClaims, stamped, locale, mergeHighlightsFor(stamped));
                backfillAnnotations(tweetText, displayedLocale);
              } catch (e) {
                console.error('[TRANSLATE_FACT_CHECKS] highlight error:', e);
                clearLocalizingHighlights();
              }
            });
          }
        } else {
          clearLocalizingHighlights();
        }

        // Also fire re-research if we have DB claims. Claim/reasoning translation is
        // NEVER automatic — only each claim's own popover translate button (TRANSLATE_CLAIM)
        // does that, on an explicit per-claim click. This button only relocalizes
        // highlights + re-researches for the newly-displayed locale.
        reResearchedTweetIds.add(tweetId);
        if (dbEntry && dbClaims) {
          reResearchDbClaims(dbClaims, unheld, researchCache)
            .catch(e => console.error('[TRANSLATE_FACT_CHECKS] reResearch error:', e));
        }
        return;
      }

      if (message.type === "TRANSLATE_CLAIM") {
        const { classificationId, claimText, translateWhat, locale: msgLocale } = message.data;
        const hit = classificationCache.get(classificationId);
        if (!hit) {
          console.log(`[background] TRANSLATE_CLAIM: no cached classification for ${classificationId}`);
          return;
        }
        const classification = hit.classification;
        const claim = classification.claims?.find(cl => cl.text === claimText || (cl.dbClaimText === claimText));
        if (!claim) {
          console.log(`[background] TRANSLATE_CLAIM: claim not found for ${claimText}`);
          return;
        }
        const locale = msgLocale ?? getUiLocale();

        if (translateWhat === "reasoning" && claim.reasoningLocale && claim.note) {
          // Ignore the request if the reasoning is already in the same language as the UI
          if (sameLanguage(claim.reasoningLocale, locale)) {
            console.log(`[background] TRANSLATE_CLAIM: skipping reasoning translation, ${claim.reasoningLocale} and ${locale} share a language`);
            return;
          }
          console.log(`[background] TRANSLATE_CLAIM: translating reasoning for "${claimText.slice(0, 40)}..." from ${claim.reasoningLocale} to ${locale}, dbClaimText=${claim.dbClaimText}`);
          const cacheKey = claim.dbClaimText ?? claimText;
          // Pull last_classification from the cached DB hit so the worker can guard
          // against stale translations overwriting freshly-reclassified claims.
          const dbEntry = dbHitCache.get(classificationId);
          const dbClaim = dbEntry?.dbClaims.find(candidate => extractClaimText(candidate.claim) === cacheKey);
          const lastClassification = getLastClassification(dbClaim);
          if (!researchCache.has(cacheKey)) {
            researchCache.set(cacheKey, {
              confidence: claim.confidence ?? Math.abs(claim.veracity ?? 0),
              veracity: claim.veracity ?? 0,
              reasoning: claim.note,
              reasoningLocale: claim.reasoningLocale,
              dbClaimText: cacheKey,
              lastClassification,
            });
          }
          gatedSpend(() => backgroundTranslate(
            cacheKey, cacheKey, claim.note!,
            claim.reasoningLocale!, locale, researchCache, classification,
            (upd: Classification) => {
              upd.batchId = classification.batchId;
              const existing = classificationCache.get(classification.id);
              if (existing?.classification.claims && upd.claims) {
                const merged = existing.classification.claims.map(existingCl => {
                  const updCl = upd.claims!.find(ucl => ucl.dbClaimText === existingCl.dbClaimText);
                  if (!updCl || existingCl.dbClaimText !== (claim.dbClaimText ?? claimText)) return existingCl;
                  return { ...existingCl, note: updCl.note ?? existingCl.note, reasoningLocale: locale, sources: updCl.sources ?? existingCl.sources };
                });
                const mergedCls = { ...existing.classification, claims: merged };
                cacheClassification(mergedCls, classification.batchId);
                broadcastClassification(mergedCls);
              }
            }
          )).catch(e => console.error('[TRANSLATE_CLAIM] reasoning translation error:', e));
        } else if (translateWhat === "claim" && claim.claimLocale && claim.rewritten) {
          // Ignore the request if the claim is already in the same language as the UI
          if (sameLanguage(claim.claimLocale, locale)) {
            console.log(`[background] TRANSLATE_CLAIM: skipping claim translation, ${claim.claimLocale} and ${locale} share a language`);
            return;
          }
          const canonicalClaimText = claim.dbClaimText ?? claimText;
          console.log(`[background] TRANSLATE_CLAIM: translating claim for "${claimText.slice(0, 40)}..." from ${claim.claimLocale} to ${locale}, dbClaimText=${claim.dbClaimText}, canonical=${canonicalClaimText.slice(0, 40)}`);
          const dbEntry = dbHitCache.get(classificationId);
          const dbClaim = dbEntry?.dbClaims.find(candidate => extractClaimText(candidate.claim) === canonicalClaimText);
          const lastClassification = getLastClassification(dbClaim);
          if (!researchCache.has(canonicalClaimText)) {
            researchCache.set(canonicalClaimText, {
              confidence: claim.confidence ?? Math.abs(claim.veracity ?? 0),
              veracity: claim.veracity ?? 0,
              reasoning: claim.note ?? '',
              reasoningLocale: claim.reasoningLocale ?? claim.claimLocale,
              dbClaimText: canonicalClaimText,
              lastClassification,
            });
          }
          gatedSpend(() => backgroundTranslateClaim(
            canonicalClaimText,
            claim.claimLocale!, locale, classification, researchCache,
            (upd: Classification) => {
              upd.batchId = classification.batchId;
              const existing = classificationCache.get(classification.id);
              if (existing?.classification.claims && upd.claims) {
                const merged = existing.classification.claims.map(existingCl => {
                  const updCl = upd.claims!.find(ucl => ucl.dbClaimText === existingCl.dbClaimText);
                  if (!updCl || existingCl.dbClaimText !== canonicalClaimText) return existingCl;
                  const newRewritten = updCl.rewritten && updCl.rewritten !== updCl.text ? updCl.rewritten : existingCl.rewritten;
                  return { ...existingCl, rewritten: newRewritten, claimLocale: locale, sources: updCl.sources ?? existingCl.sources };
                });
                const mergedCls = { ...existing.classification, claims: merged };
                cacheClassification(mergedCls, classification.batchId);
                broadcastClassification(mergedCls);
              }
            }
          )).catch(e => console.error('[TRANSLATE_CLAIM] claim translation error:', e));
        }
        return;
      }

      if (message.type === "SET_DISPLAYED_LOCALE") {
        const { tweetId, textLocale: requestedLocale, displayedText, bodyOnly } = message.data;
        const hit = classificationCache.get(tweetId);
        if (!hit) {
          console.log(`[background] SET_DISPLAYED_LOCALE: no cached classification for ${tweetId}`);
          return;
        }
        const classification = hit.classification;
        const tweet = tweetCache.get(tweetId);
        if (!tweet) {
          console.log(`[background] SET_DISPLAYED_LOCALE: no cached tweet for ${tweetId}`);
          return;
        }
        // Content script may send symbolic 'original'/'translated' or an actual locale code.
        const textLocale = requestedLocale === 'original'
          ? (tweet.sourceLanguage ?? requestedLocale)
          : requestedLocale === 'translated'
            ? (tweet.destinationLanguage ?? requestedLocale)
            : requestedLocale;

        console.log(`[background] SET_DISPLAYED_LOCALE: ${tweetId} displayed locale -> ${textLocale}`);

        // A host that states no language (Facebook) can report only the body that is on
        // screen. No locale decides anything here: the side now showing is found by measuring
        // the persisted revisions against this exact body, and only when the classification
        // names a different one — which is the reader having flipped sides. Without this the
        // classification keeps naming the side that was flipped AWAY from, the paint guard
        // refuses its segments on the words now shown, and the side that does have ranges
        // (already paid for, or the preclassification's) comes back offering Localize.
        // A platform that cannot name the side it shows files BOTH sides under `und` (see
        // `translationLocaleIsGuessed`), so the locale on the way back to the source names
        // nothing: `hl.und` is whatever the last paid run measured, into the side just left.
        // The named path below reads its mere presence as "this side is already placed" and
        // broadcasts it over the source — the ranges cut into the words that were on screen
        // before (reported 2026-10-23: Telegram's French marks landed on the Russian body).
        // The source's own words are in hand — the capture files them whatever the markup
        // shows — so this flip is answered exactly like a body-first report: the side is
        // found, held or restored by the body it addresses, never by the locale.
        const sourceBody = typeof tweet.text === 'string' ? tweet.text.trim() : '';
        const sharedKeySourceFlip = !bodyOnly
          && requestedLocale === 'original'
          && textLocale.toLowerCase().split('-')[0] === UNKNOWN_LANGUAGE
          // The side just left was filed under that same `und` key — which is what makes its
          // ranges unreadable as this side's. A host whose source is unknown but whose
          // translation is named (Facebook files it under its UI locale) keeps its own path:
          // its two sides never share a key, so a range under one cannot be the other's.
          && (classification.textLocale ?? '').toLowerCase().split('-')[0] === UNKNOWN_LANGUAGE
          && !!sourceBody
          && !!classification.translatedText
          && !sameBodyRevision(classification.translatedText, sourceBody);

        if (bodyOnly || sharedKeySourceFlip) {
          const shownBody = sharedKeySourceFlip
            ? sourceBody
            : (typeof displayedText === 'string' ? displayedText.trim() : '');
          if (!shownBody) {
            // Nothing to re-read, but the reader's flip still has to be answered: the client
            // drops its own copy of this classification the moment the flip is asked for
            // (`mf-prepare-locale-switch`), and only a delivery replaces it. Left silent, the
            // bar spins over a bare post with nothing running — and since nothing is in
            // flight, no later delivery is owed either (reported 2026-10-23).
            console.log(`[background] SET_DISPLAYED_LOCALE: ${tweetId} side reported with no body — nothing to re-read, answering so the client's swap state ends`);
            broadcastClassification(classification);
            return;
          }
          // A capture holding no translation at all still has to answer for a side the seam
          // reports as one: a post announced before the reader translated it holds only its
          // own words, and this report IS the other side. It falls through to the gate below,
          // which files it by its body — recovering any revision measured against these words
          // and holding the rest for Localize. The one case that is not news is words the
          // classification was built from (they still carry their ranges, and a flip report
          // over them would re-point the classification for nothing).
          const unheldTranslation = !classification.translatedText
            && (!tweet.text || !sameBodyRevision(shownBody, tweet.text));
          if (unheldTranslation) {
            console.log(`[background] SET_DISPLAYED_LOCALE: ${tweetId} side reported by its body, capture holds no translation — reading it against the persisted claims`);
          } else if (!classification.translatedText || sameBodyRevision(shownBody, classification.translatedText)) {
            // Back on the side the classification names. A hold recorded when the reader
            // flipped AWAY from it is about a body that is no longer on screen: left set, the
            // Localize button sits over a side whose ranges are right there, and pressing it is
            // a second paid run. Cleared only when this side actually holds a range, so a side
            // that is genuinely waiting on a localization keeps its hold.
            const classifiedLocale = classification.textLocale;
            if (classification.translateFactChecksOnHold && classifiedLocale
              && (classification.claims ?? []).some(cl => !!resolveHighlightRange(cl.highlight, classifiedLocale))) {
              const back: Classification = { ...classification, translateFactChecksOnHold: undefined };
              cacheClassification(back, hit.batchIds.values().next().value ?? '');
              broadcastClassification(back);
              console.log(`[background] SET_DISPLAYED_LOCALE: ${tweetId} back on the classified side — clearing the flip's hold`);
            } else {
              // Answer the flip even though there is nothing to re-read: see the no-body exit
              // above. This one is the common case on a post this session classified.
              console.log(`[background] SET_DISPLAYED_LOCALE: ${tweetId} body unchanged, nothing to re-read, answering so the client's swap state ends`);
              broadcastClassification(classification);
            }
            return;
          }
          // The side now on screen may be one this session already measured, and then its
          // claims are still in hand. The persisted rows below only answer while
          // `dbHitCache` holds the tweet — a post first classified this session never was a
          // DB hit — and even then a host that states no language files both sides' ranges
          // under one key, so that read can only ever recover one of them.
          // A memo speaks for a side only while it names the claims the post still holds: a
          // reclassification REPLACES the whole claim list, so a run that came back empty
          // (or with a different set) leaves every other side's entry describing a
          // classification the reader has since retired. Restored ungated, the flip painted
          // highlights the reclassification had discarded — a side whose bar should have
          // offered only the re-run button came back showing the old claims.
          const heldTexts = new Set((classification.claims ?? []).map(cl => cl.text));
          const namesHeldClaims = (e: { claims: any[] }) =>
            heldTexts.size > 0 && e.claims.length === heldTexts.size
            && e.claims.every(cl => heldTexts.has(cl.text));
          const remembered = !classification.preclassifying
            ? sideClaims.get(tweetId)?.find(e =>
                namesHeldClaims(e)
                && sameBodyRevision(e.text, shownBody)
                && e.claims.some(cl => !!resolveHighlightRange(cl.highlight, e.locale)))
            : undefined;
          if (remembered) {
            const restored: Classification = {
              ...classification,
              textLocale: remembered.locale,
              translatedLocale: remembered.locale,
              translatedText: remembered.text,
              claims: remembered.claims.map(cl => ({ ...cl })),
              translateFactChecksOnHold: undefined,
              // NOT `localizingHighlights: false`: a localization can be running while this
              // side is re-read (the paint itself triggers this pass), and this broadcast used
              // to drop the wheel mid-run — the Localize button came back over a job still in
              // flight, and the reader's second press was a second paid run. The run's own
              // exits clear the flag; inheriting it here leaves it alone.
            };
            // The restored body is on screen now, so a later DB read must keep its revision
            // (and the renderings recorded before it) rather than the capture's.
            recordDisplayedSide(tweetId, remembered.text, remembered.locale);
            cacheClassification(restored, hit.batchIds.values().next().value ?? '');
            broadcastClassification(restored);
            console.log(`[background] SET_DISPLAYED_LOCALE: ${tweetId} flipped side — restored the ${remembered.locale} claims this session measured against the body on screen (${restored.claims?.length ?? 0})`);
            return;
          }
          const dbEntry = dbHitCache.get(tweetId);
          if (!dbEntry?.dbClaims?.length) {
            // Nothing to read this side's ranges back from, and the classification must not be
            // re-pointed at the new body without them — that would aim the old side's offsets at
            // words they never addressed (see above). But saying nothing was its own wrong
            // answer: the reader IS on a side with nothing localized, which is exactly
            // `translateFactChecksOnHold`, and Localize is its affordance. Left silent, the bar
            // offered no Localize at all and the stale paint stayed over the new words.
            //
            // Only when there IS something to localize. A post that has never been classified
            // arrives here holding no claims at all — the flip is still news (it decides which
            // side the next tap classifies), but its affordance is the ordinary Disinfact
            // button, not Localize: that press would have no claims to measure and would
            // answer with the same button, doing nothing, forever (reported 2026-10-23 on a
            // fresh post flipped to its translation before any classification).
            const hasClaims = (classification.claims?.length ?? 0) > 0;
            // Recorded even though there is nothing to re-read: what is ON SCREEN is what
            // tells a localization that finishes later (or a press made now) whether the
            // body it measured is still the one being shown. Unrecorded, this report left
            // the previous side standing as the page's side, and a run the reader started
            // here looked foreign to it. `bodyOnly` arrives from hosts that cannot name
            // their sides, so the key this side is filed under is the unknown language.
            recordDisplayedSide(tweetId, shownBody, classification.textLocale ?? textLocale);
            console.log(`[background] SET_DISPLAYED_LOCALE: ${tweetId} flipped side with no persisted claims to re-read — ${hasClaims ? 'holding for Localize' : 'no claims to localize, leaving the Disinfact button'}`);
            if (hasClaims !== !!classification.translateFactChecksOnHold) {
              const held: Classification = { ...classification, translateFactChecksOnHold: hasClaims || undefined };
              cacheClassification(held, hit.batchIds.values().next().value ?? '');
              broadcastClassification(held);
            } else {
              // Answer the flip even though the hold state did not change: see the no-body exit
              // above. A post first classified this session has no row to read this side back
              // from, so this is the branch a flip on a new post lands in.
              broadcastClassification(classification);
            }
            return;
          }
          // Strict gate: only a revision measured against the body now on screen survives.
          const bodyHash = sha256HexSync(shownBody);
          const known = new Set([bodyHash]);
          const gate: RevisionGate = { displayed: bodyHash, known };
          const byId = new Map<string, any>();
          const byText = new Map<string, any>();
          for (const d of dbEntry.dbClaims) {
            if (d?.id != null) byId.set(String(d.id), d);
            const key = extractClaimText(d?.claim);
            if (key && !byText.has(key)) byText.set(key, d);
          }
          let recovered = 0;
          let dropped = 0;
          // Which side this is comes from the revisions that SURVIVED the gate, never from the
          // locale the message names: the content script sends the locale of the side being
          // flipped AWAY from (`classification.textLocale`). A host that keys each side by its
          // own language files the side now showing under a different key — Telegram files the
          // source under `und` and the translation under the host's UI locale — so reading the
          // named locale's key discarded the range the gate had just kept, while the departing
          // side's range was deleted from the live claims: a side holding ranges painted none,
          // its bar offered Localize over a result already paid for, and the flip wrote that
          // wrong locale back into `sideClaims`, which poisoned the in-session rescue for every
          // later flip. When both sides share one key (Facebook) the vote lands on the named
          // locale and nothing below changes.
          const gateResults = (classification.claims ?? []).map(cl => {
            const d = (cl.dbClaimId ? byId.get(cl.dbClaimId) : undefined) ?? byText.get(cl.dbClaimText ?? cl.text);
            const kept = d?.highlight && typeof d.highlight === 'object'
              ? selectHighlightRevision(d.highlight as Record<string, unknown>, gate)
              : {};
            return { d, kept };
          });
          const votes = new Map<string, number>();
          for (const { kept } of gateResults) {
            for (const [key, val] of Object.entries(kept)) {
              if (isLocatedRange(val)) votes.set(key, (votes.get(key) ?? 0) + 1);
            }
          }
          const sideLocale = [...votes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? textLocale;
          const flipped: Classification = {
            ...classification,
            textLocale: sideLocale,
            translatedText: shownBody,
            translatedLocale: sideLocale,
            claims: (classification.claims ?? []).map((cl, i) => {
              const { d, kept } = gateResults[i];
              // Annotations persist under the same "<locale>:<hash>" binding as highlights,
              // and this host files both sides under ONE locale key — so the dict carried on
              // the claim survives a flip unchanged and its corrections paint over the words
              // now on screen. The gate keeps only the shown body's revision; a side it has
              // none for is "not annotated here", which is what brings that side's Annotate
              // affordance back.
              const keptAnn = d?.annotations && typeof d.annotations === 'object' && !Array.isArray(d.annotations)
                ? selectAnnotationRevision(d.annotations as Record<string, Record<string, string>>, gate)
                : {};
              const annotations = Object.keys(keptAnn).length > 0 ? keptAnn : undefined;
              const range = kept[sideLocale] as [number, number] | undefined;
              const hl = { ...(cl.highlight ?? {}) };
              if (range && isLocatedRange(range)) {
                hl[sideLocale] = range;
                recovered++;
                return { ...cl, highlight: hl, annotations };
              }
              if (hl[sideLocale]) {
                delete hl[sideLocale];
                dropped++;
                return { ...cl, highlight: Object.keys(hl).length > 0 ? hl : undefined, annotations };
              }
              return { ...cl, annotations };
            }),
          };
          const flippedClaims = flipped.claims ?? [];
          const localizedAny = flippedClaims.some(cl => !!resolveHighlightRange(cl.highlight, sideLocale));
          if (!localizedAny && flippedClaims.length > 0) flipped.translateFactChecksOnHold = true;
          else if (flipped.translateFactChecksOnHold) flipped.translateFactChecksOnHold = undefined;
          // The side now on screen is what later taps are measured against: `withDisplayedSide`
          // lays this record over the capture, and the annotate path reads the body to correct
          // and the hash to file it under from there (see annotLocatorsFor). Unrecorded, a tap
          // on the side the reader flipped TO measured the capture's side instead — a comment
          // captured while its source showed had every correction on its translation filed
          // into the source's words, and the annotation the reader got back was the other
          // side's. Same record the other two flip outcomes keep (below, and the `remembered`
          // branch above); the gate also holds these words as the displayed revision from here
          // on, which is what lets a DB read keep what this side is measured with.
          recordDisplayedSide(tweetId, shownBody, sideLocale);
          cacheClassification(flipped, hit.batchIds.values().next().value ?? '');
          broadcastClassification(flipped);
          console.log(`[background] SET_DISPLAYED_LOCALE: ${tweetId} flipped side — recovered ${recovered} persisted ${sideLocale} highlight(s), dropped ${dropped} measured against the other side`);
          return;
        }

        // WHICH side supplied the text decides what the next paid localization measures
        // its ranges against, and the three are indistinguishable from the outside, so it
        // is named on the log line below.
        let textSource: 'capture-source' | 'capture-translation' | 'dom' | 'none' = 'none';

        // Update the classification's displayed text locale and, if we know the text,
        // update translatedText/translatedLocale so the content script uses the right source.
        const updatedCls: Classification = { ...classification, textLocale };
        if (textLocale === tweet.sourceLanguage && tweet.text) {
          updatedCls.translatedText = tweet.text;
          updatedCls.translatedLocale = tweet.sourceLanguage;
          textSource = 'capture-source';
        } else if (textLocale === tweet.destinationLanguage && tweet.translatedText) {
          updatedCls.translatedText = tweet.translatedText;
          updatedCls.translatedLocale = tweet.destinationLanguage;
          textSource = 'capture-translation';
        } else if (displayedText) {
          // Locale resolved from the DOM (watchDisplayedLocaleFromDom): X translated the tweet
          // lazily, so the captured payload has no destinationLanguage and the cached tweet has
          // only the ORIGINAL text — neither branch above can match. Trusting the DOM copy is
          // essential, not cosmetic: without it `translatedText` stayed the ORIGINAL while
          // textLocale said e.g. "th", so backgroundHighlightRange computed ranges against
          // English and persisted them under the Thai key (identical en/th ranges in the DB),
          // and kickOffTextBreakup built English segments the mismatch guard had to reject.
          //
          // Caveat: the DOM copy is truncated for long tweets, where the XHR payload is
          // preferred precisely for that reason — so ranges past the cut-off may be missed.
          // That only applies to this lazily-translated path, which has no other source.
          updatedCls.translatedText = displayedText;
          updatedCls.translatedLocale = textLocale;
          textSource = 'dom';
        }

        // A paid localization survives a reload only if the client still recognises the
        // body it was measured against: ranges are persisted as "<locale>:<sha256-of-body>"
        // and selectHighlightRevision drops every key whose body the client does not hold.
        // A post captured with one side on screen holds ONLY that side (all Telegram posts,
        // and X's lazily-translated ones), so the moment the reader flips it, the ranges
        // persisted for the other side are invisible: the Localize button comes back over a
        // result already paid for, and clicking it is worse than useless — `localizedHighlightLocales`
        // still holds the locale, so localizeHighlights returns without running and the
        // button does nothing at all.
        //
        // The reader has just said what is on screen, so record that side on the cached
        // tweet and read the persisted ranges back through a gate that knows it. This only
        // ever FILLS a translation side that was missing and only ever ADDS a highlight, so
        // a tweet whose payload carried both sides is untouched.
        if (displayedText && textLocale) {
          // The durable record of the side on screen. Only a side that is NOT the captured
          // source is recorded: the source's own body is already what the capture holds, and
          // its DOM copy can be truncated, which would hash differently from the payload and
          // drop the ranges that address the source legitimately.
          if (textLocale !== tweet.sourceLanguage) {
            recordDisplayedSide(tweetId, displayedText, textLocale);
          }
          const cached = tweetCache.get(tweetId);
          if (cached && !(cached.translatedText && cached.destinationLanguage)) {
            tweetCache.set(tweetId, { ...cached, translatedText: displayedText, destinationLanguage: textLocale });
            // The DB-hit entry holds its own copy of the same post, and the localization paths
            // read THAT one (TRANSLATE_FACT_CHECKS, backfillAnnotations). Left stale, it gates
            // the freshly localized ranges against the source and drops them, so the record of
            // the side on screen has to reach both copies.
            const dbHit = dbHitCache.get(tweetId);
            if (dbHit) dbHitCache.set(tweetId, { ...dbHit, tweet: { ...dbHit.tweet, translatedText: displayedText, destinationLanguage: textLocale } });
          }
          const shownTweet = tweetCache.get(tweetId);
          const dbEntry = dbHitCache.get(tweetId);
          if (shownTweet && dbEntry?.dbClaims?.length) {
            const gate = revisionGateFor(shownTweet, shownTweet.quoting);
            const byId = new Map<string, any>();
            const byText = new Map<string, any>();
            for (const d of dbEntry.dbClaims) {
              if (d?.id != null) byId.set(String(d.id), d);
              const key = extractClaimText(d?.claim);
              if (key && !byText.has(key)) byText.set(key, d);
            }
            let recovered = 0;
            let reannotated = 0;
            updatedCls.claims = (updatedCls.claims ?? []).map(cl => {
              const d = (cl.dbClaimId ? byId.get(cl.dbClaimId) : undefined) ?? byText.get(cl.dbClaimText ?? cl.text);
              // The DB-hit rebuild that precedes a flip reads its gate off the side that WAS
              // on screen, so the side now showing comes back carrying neither its ranges nor
              // its annotations. Both are restored here, under one rule: only ADD, and only
              // what this side has none of already — a present dict is the fresher one, and
              // the per-side record only survives the flip for one of the two sides.
              let next = cl;
              const annKnown = !!cl.annotations && Object.keys(cl.annotations).some(k => sameLanguage(k, textLocale));
              if (!annKnown && d?.annotations && typeof d.annotations === 'object' && !Array.isArray(d.annotations)) {
                const keptAnn = selectAnnotationRevision(d.annotations as Record<string, Record<string, string>>, gate);
                const annKey = Object.keys(keptAnn).find(k => sameLanguage(k, textLocale));
                if (annKey !== undefined) {
                  next = { ...cl, annotations: { ...(cl.annotations ?? {}), [annKey]: keptAnn[annKey] } };
                  reannotated++;
                }
              }
              if (resolveHighlightRange(next.highlight, textLocale)) return next;
              if (!d?.highlight || typeof d.highlight !== 'object') return next;
              const kept = selectHighlightRevision(d.highlight as Record<string, unknown>, gate);
              const range = kept[textLocale] as [number, number] | undefined;
              if (!isLocatedRange(range)) return next;
              recovered++;
              return { ...next, highlight: { ...(next.highlight ?? {}), [textLocale]: range } };
            });
            if (recovered > 0) {
              console.log(`[background] SET_DISPLAYED_LOCALE: ${tweetId} recovered ${recovered} persisted ${textLocale} highlight(s) for the body now on screen`);
            }
            if (reannotated > 0) {
              console.log(`[background] SET_DISPLAYED_LOCALE: ${tweetId} recovered ${reannotated} persisted ${textLocale} annotation(s) for the body now on screen`);
            }
          }
        }
        // If the newly-displayed locale's highlights aren't already cached, NEVER
        // localize automatically (localizing charges the balance). Instead surface our
        // Translate Fact-Checks button; localization runs ONLY when the user clicks it
        // (the TRANSLATE_FACT_CHECKS path). If they ARE cached, the broadcast below
        // injects them instantly.
        // Same-language subtag differences (en vs en-US) resolve via the base language,
        // so they DON'T count as missing → no spurious paid localization for the same language.
        //
        // Decided BEFORE broadcasting, and broadcast EXACTLY ONCE. This used to broadcast the
        // locale change first and only then, in a second broadcast, set
        // translateFactChecksOnHold — leaving one delivery in between that carried neither the
        // on-hold flag nor the content script's streaming suppression, which is long enough for
        // the fallback area to flash before the Disinfact button appears. The final state is
        // identical either way.
        //
        // The button is offered only when the side has NOTHING localized: a paid run that
        // placed most of its claims is still the result the reader bought, and re-offering
        // over it charges again for the same run while the side already shows those ranges.
        const localizedAny = (updatedCls.claims ?? []).some(cl => !!resolveHighlightRange(cl.highlight, textLocale));
        const needsLocalization = !localizedAny && (updatedCls.claims ?? []).length > 0;
        console.log(`[background] SET_DISPLAYED_LOCALE: ${tweetId} text=${textSource} needsLocalization=${needsLocalization} (localizedAny=${localizedAny})`);
        if (needsLocalization) {
          console.log(`[background] SET_DISPLAYED_LOCALE: ${tweetId} no cached highlights for ${textLocale} → holding for Translate Fact-Checks button`);
          updatedCls.translateFactChecksOnHold = true;
        } else if (updatedCls.translateFactChecksOnHold) {
          updatedCls.translateFactChecksOnHold = undefined;
          console.log(`[background] SET_DISPLAYED_LOCALE: ${tweetId} clearing translateFactChecksOnHold (highlights exist for ${textLocale})`);
        }
        cacheClassification(updatedCls, hit.batchIds.values().next().value ?? '');
        broadcastClassification(updatedCls);
      }
    });
  });
  },
});
