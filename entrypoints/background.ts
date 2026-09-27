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
import { supabase, ensureFreshSession } from "../utils/supabase";
import { findExactMatch, resolveHighlightRange, sha256HexSync, selectHighlightRevision, selectAnnotationRevision, isLocatedRange, sameLocatedRange } from "../utils/textBreakup";
import { Classification, Claim, Source, sameLanguage } from "../data/Classification";
import { MainTweet, Tweet } from "../data/Tweets";
import { COLOR_SCHEME_MESSAGE, applyToolbarIcon, restoreToolbarIcon, toolbarAction } from "../utils/toolbarIcon";
import { ERROR_CODES } from "../utils/errorCodes";
import { NATIVE_APP_ID, NATIVE_CALLBACK_SCHEME } from "../utils/nativeHost";
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
  const pendingProcessOnHold = new Map<string, { locale: string; displayedSide: 'TRANSLATED' | 'ORIGINAL' | null; displayedText: string | null; timer: ReturnType<typeof setTimeout> }>();
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
    runPreclassification(entry, pending.locale, "PROCESS_ON_HOLD", false, pending.displayedSide, pending.displayedText);
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
  /** Tweet IDs for which the user clicked "Fact-Check All" on the on-hold button.
   *  Claims in these tweets bypass the per-claim Disinfact badge pause and stream
   *  fresh research immediately after their DB fetch attempt returns no match. */
  const factCheckAllTweetIds = new Set<string>();
  /** Track DB results from fetchTweetByHash so TRANSLATE_FACT_CHECKS can
   *  re-fire the localization pipeline. Keyed by tweet id. */
  const dbHitCache = new Map<string, { tweet: MainTweet; dbClaims: any[] }>();
  /** Track tweets whose DB hash has already been fetched this session so
   *  repeated timeline XHRs don't refetch the same tweet. Keyed by tweet id. */
  const dbFetchPromises = new Map<string, Promise<{ hash: string; dbResult: any; quotedHash?: string; quotedDbResult?: any }>>();
  /** Track hashes that returned no DB match so we don't retry them. */
  const dbMissHashes = new Set<string>();
  /** Tweet ids the content script has reported as present in the DOM.
   *  Used to defer DB fetches for timeline tweets beyond the first 5 of each
   *  XHR batch until they are actually rendered. */
  const seenInDom = new Set<string>();
  /** Deferred DB fetch resolvers for tweets waiting to appear in the DOM. */
  const domFetchResolvers = new Map<string, (() => void)[]>();

  // ── Realtime subscription state ──
  /** Teardown fallbacks if no DELETE arrives from the DB. */
  const PRECLASS_TIMEOUT_MS = 10000;
  const CLASSIFY_TIMEOUT_MS = 25000;
  /** How long a refresh-path tweet subscription stays open for Flow A's annotation
   *  persist. Research takes minutes and the annotation agent runs after it, so neither
   *  of the timeouts above can cover it. Capped at the DB's own close_after (5 min):
   *  anything still open past that is swept server-side, so a longer timeout would
   *  only pretend to listen. */
  const ANNOTATION_TIMEOUT_MS = 5 * 60 * 1000;
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
   *  duplicate the wait exists to prevent; stalling costs the user the thing they paid for. */
  const CLAIM_DB_ROW_TIMEOUT_MS = 2000;
  /** The same wait as CLAIM_DB_ROW_TIMEOUT_MS, for the SELECTION path only.
   *
   *  The 2s budget above is calibrated on X, where the claim links to a tweet row that
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
  /** Tweet ids whose leftover preclass handle was already closed and replaced
   *  with an annotation-timeout subscription. Closing again (a second claim's
   *  research) LATE-drops the in-flight annotation UPDATE. Cleared when the
   *  handle actually ends (timeout / forget). */
  const annotationRoutingReady = new Set<string>();
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

  /** Store a classification under its tweet id, recording the batch that requested it.
   *  A quoted tweet gets its own top-level cache entry too, so a later batch that shows
   *  the quoted tweet on its own can reuse the claims already computed for it. */
  function cacheClassification(classification: Classification, batchId: string) {
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
  type RevisionGate = { displayed: string | null; known: Set<string> };
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

  /** Revision gate for payloadToClaim covering a main tweet plus its quoted tweet (the
   *  two bodies any highlight here can address). The ORIGINAL bodies stay held even
   *  while a translation displays (and vice versa) — highlights bound to them are
   *  still genuine tier-2 revisions that apply instantly if the user toggles back.
   *  Null/empty bodies contribute nothing — legacy bare-locale keys never need a
   *  hash to survive. */
  function revisionGateFor(main: { text?: string; translatedText?: string; destinationLanguage?: string } | null | undefined, quoted?: { text?: string; translatedText?: string; destinationLanguage?: string } | null | undefined): RevisionGate {
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
    return { displayed: mainBody !== null ? sha256HexSync(mainBody) : null, known };
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

  function payloadToClaim(dbClaim: any, locale: string, gate: RevisionGate = NO_REVISION_GATE): Claim {
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
      highlight = selectHighlightRevision(raw, gate);
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
    classification: Classification
  ): Promise<AnnotLocators | null> {
    try {
      const ownList = claims ?? [];
      let claimIndex = ownList.findIndex(c => c.text === claimText);
      // Structural subset: quoted tweets are plain Tweets (no References or translation
      // fields), so this can't be a MainTweet. computeTweetHash takes `any` regardless.
      type TweetSide = { text?: string; translatedText?: string; destinationLanguage?: string; sourceLanguage?: string; quoting?: { id: string } | null } | null | undefined;
      let tweet: TweetSide = tweetCache.get(tweetId) ?? dbHitCache.get(tweetId)?.tweet ?? null;
      // Not the main tweet's claim — look in the quoted side (each side annotates
      // against its OWN tweet row, text, and hash).
      if (claimIndex < 0) {
        const quoted = classification.quoting?.claims;
        if (!quoted || quoted.findIndex(c => c.text === claimText) < 0) return null;
        claimIndex = quoted.findIndex(c => c.text === claimText);
        tweet = tweetCache.get(tweetId)?.quoting ?? dbHitCache.get(tweetId)?.tweet?.quoting ?? null;
        if (!tweet) {
          for (const parent of tweetCache.values()) {
            if (parent.quoting?.id === tweetId || classification.quoting?.id === tweetId) { tweet = parent.quoting; break; }
          }
        }
      }
      if (!tweet) return null;
      const tweetText = (tweet.translatedText && tweet.destinationLanguage) ? tweet.translatedText : tweet.text;
      const textLocale = ((tweet.translatedText && tweet.destinationLanguage) ? tweet.destinationLanguage : tweet.sourceLanguage) ?? classification.textLocale ?? null;
      if (typeof tweetText !== 'string' || tweetText.length === 0 || !textLocale) return null;
      const tweetHash = await computeTweetHash(tweet);
      return { tweetHash, tweetText, textLocale, claimIndex: Math.max(0, claimIndex) };
    } catch {
      return null;
    }
  }

  /** Convert a pulled/subscribed tweet's claims into a Classification for injection.
   *  If quotedDbClaims is provided, populates classification.quoting.claims as well. */
  function dbClaimsToClassification(
    tweet: MainTweet,
    dbClaims: any[],
    batchId: string,
    locale: string,
    quotedDbClaims?: any[]
  ): Classification {
    // X shows Grok-translated text by default when a translation exists.
    // Otherwise the displayed text is the original (source) text.
    const hasTranslation = !!tweet.translatedText && !!tweet.destinationLanguage;
    const textLocale = hasTranslation ? tweet.destinationLanguage! : tweet.sourceLanguage!;

    // Strip persisted "<locale>:<hash>" highlight keys to the revision bound to the
    // displayed bodies (main + quoted — the two texts any highlight here can address).
    const gate = revisionGateFor(tweet, tweet.quoting);
    const claims = dbClaims.map(dbClaim => payloadToClaim(dbClaim, locale, gate));
    const quoting = tweet.quoting
      ? {
          id: tweet.quoting.id,
          claims: quotedDbClaims && quotedDbClaims.length > 0 ? quotedDbClaims.map(dbClaim => payloadToClaim(dbClaim, locale, gate)) : null
        }
      : null;
    return { id: tweet.id, batchId, claims, quoting, translatedLocale: tweet.destinationLanguage, translatedText: tweet.translatedText, textLocale };
  }

  /** Localize highlights for a specific tweet text locale. Used both on initial
   *  load (for the default translated text) and on demand when the user toggles
   *  X's Show original/Show translation. Skips if this locale was already localized
   *  for this tweet. */
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
    if (seen.has(highlightLocale)) {
      console.log(`[localizeHighlights] ${tweetId}: already localized for ${highlightLocale}, skipping`);
      return;
    }

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
      seen.add(highlightLocale);
      console.log(`[localizeHighlights] ${tweetId}: marked ${highlightLocale} as localized (${injected} range(s))`);
      return;
    }
    // Worker failure or empty stream (transient 500s happen): NOT localized —
    // the next click retries instead of hitting "already localized, skipping".
    // The merge callback never fired, so localizingHighlights is still set and
    // would spin forever: clear it and restore the on-hold flag so the
    // Localize button comes back.
    console.warn(`[localizeHighlights] ${tweetId}: no ranges for ${highlightLocale} — restoring Translate Fact-Checks button`);
    const cur = classificationCache.get(tweetId)?.classification;
    if (cur) {
      const restored = { ...cur, localizingHighlights: false, translateFactChecksOnHold: true };
      cacheClassification(restored, classification.batchId);
      broadcastClassification(restored);
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
   *  stamped, so the common path skips the copy entirely. */
  function stampAnnotateInFlight(
    classification: Classification,
    opt?: { withLocators?: boolean; claimText?: string }
  ): Classification | null {
    if (!opt?.withLocators) return null;
    const stampList = (claims: Classification["claims"]) => {
      if (!claims) return { list: claims, stamped: false };
      let stamped = false;
      const list = claims.map(cl => {
        if (opt.claimText !== undefined && cl.text !== opt.claimText) return cl;
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
      '| claim:', (opt.claimText ?? '').slice(0, 40), '| mainStamped:', main.stamped, '| quotedStamped:', q.stamped
    );
    return {
      ...classification,
      claims: main.list,
      quoting: classification.quoting ? { ...classification.quoting, claims: q.list as any } : classification.quoting,
    };
  }

  function broadcastClassification(classification: Classification, opt?: { withLocators?: boolean; claimText?: string }) {
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

    // If Fact-Check All was clicked for this tweet, present any claim still showing
    // a Disinfact button as already "Fact-Checking" (refreshing) in the message we
    // send to the UI, so it never flashes a Disinfact badge in the brief window
    // before the auto-release below actually flips it. The cache and the
    // auto-release loop still operate on the real (reclassifyOnHold) state.
    let outgoing = classification;
    if (factCheckAllTweetIds.has(classification.id)
        && classification.claims?.some(claim => claim.reclassifyOnHold && !abandonedFactCheckKeys.has(`${classification.id}:${claim.text}`))) {
      // Present WAITLISTED/in-flight on-hold claims as "Fact-Checking", but leave ABANDONED
      // ones (2 failed tries / 30s timeout / broke) showing their real on-hold button so the
      // user can retry — that's the visible signal the call didn't go through.
      outgoing = {
        ...classification,
        claims: classification.claims.map(claim =>
          claim.reclassifyOnHold && !abandonedFactCheckKeys.has(`${classification.id}:${claim.text}`)
            ? { ...claim, reclassifyOnHold: false, refreshing: true, note: null }
            : claim
        ),
      };
    }
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
    // user action. If the user clicked "Fact-Check All" for this tweet, auto-release
    // EVERY such claim (including change-prone DB claims that carry cached values),
    // not just fresh no-DB-match ones; otherwise just mark them pending.
    for (const claim of classification.claims ?? []) {
      if (claim.reclassifyOnHold) {
        const key = `${classification.id}:${claim.text}`;
        if (factCheckAllTweetIds.has(classification.id)) {
          pendingFreshResearchClaims.delete(key);
          // Add to the Fact-Check All waitlist (idempotent; skips already-queued/in-flight/
          // abandoned claims). It is admitted for research only when the balance covers its hold.
          enqueueFactCheckClaim(classification.id, claim.text, classification.batchId, localeFromClassification());
        } else {
          pendingFreshResearchClaims.add(key);
        }
      }
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
  }

  function mergeSingleClaimAndBroadcast(
    classificationId: string,
    claimText: string,
    updated: Classification,
    batchId: string,
    opts?: { withLocators?: boolean }
  ) {
    const stampOpt = opts?.withLocators ? { withLocators: true, claimText } : undefined;
    const existing = classificationCache.get(classificationId)?.classification;
    const updatedClaim = updated.claims?.find(c => c.text === claimText);
    if (!existing || !existing.claims || !updatedClaim) {
      updated.batchId = batchId;
      cacheClassification(updated, batchId);
      broadcastClassification(updated, stampOpt);
      // Research rewrote the rows — drop the pre-research fetch snapshot.
      markTweetDbStale(classificationId);
      return;
    }
    // Fresh research rebuilds carry no annotations — union so they never clobber the
    // cached copy's (the fresh result wins per locale key when it has any).
    const mergedClaims = existing.claims.map(c => (c.text === claimText
      ? { ...updatedClaim, annotations: unionAnnotations(c.annotations, updatedClaim.annotations) }
      : c));
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
    const claims = mergeList(incoming.claims as any, (existing?.claims as any) ?? null);
    const quoting = incoming.quoting
      ? { ...incoming.quoting, claims: mergeList(incoming.quoting.claims as any, (existing?.quoting?.claims as any) ?? null) }
      : incoming.quoting;
    const anyOnHold = (claims ?? []).some((c: any) => c.reclassifyOnHold)
      || (quoting?.claims ?? []).some((c: any) => c.reclassifyOnHold);
    return { ...incoming, claims, quoting, reclassifyOnHold: anyOnHold || undefined };
  }

  /** Post to a port, ignoring the throw that follows if the content script has since
   *  navigated away or been torn down. A dead port is normal, not an error. */
  function safePostToPort(port: any, msg: any) {
    try { port.postMessage(msg); } catch { /* port already closed */ }
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

      const mergeClaims = (existingClaims: Claim[] | null | undefined, updClaims: Claim[] | null | undefined): Claim[] | null => {
        if (!existingClaims || !updClaims) return existingClaims ?? null;
        return existingClaims.map((existingCl) => {
          const updCl = updClaims.find(
            ucl => (ucl.dbClaimText && ucl.dbClaimText === existingCl.dbClaimText) ||
                   ucl.text === existingCl.text ||
                   (ucl.rewritten && ucl.rewritten === existingCl.rewritten)
          );
          if (!updCl) return existingCl;
          const mergedHighlight = {
            ...(existingCl.highlight ?? {}),
            ...(updCl.highlight ?? {})
          };
          const mergedAnnotations = unionAnnotations(existingCl.annotations, updCl.annotations);
          const hlSize = Object.keys(mergedHighlight).length;
          const out = hlSize > 0
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
      if (tweet) attachTranslatedLocale(seed, tweet);
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
      const direct = tweetCache.get(tweetId);
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
          g = { displayed: hash, known: new Set([hash]) };
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
        claims[idx] = { ...incoming, text: prev.text, highlight: mergedHl, annotations: mergedAnn };
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
      claims.push(incoming);
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
      onClaim: (payload) => mergeClaimPayload(tweetId, payload, locale),
      onDone: () => {
        if (tweetSubs.get(tweetId) === handleRef) tweetSubs.delete(tweetId);
        annotationRoutingReady.delete(tweetId);
      },
    });
    handleRef = handle;
    if (handle) { tweetSubs.set(tweetId, handle); await handle.ready; }
  }

  /** Fire-and-forget tweet subscription (for callers that don't need to await readiness). */
  function startTweetSubscription(tweetId: string, hash: string, locale: string, timeoutMs: number = PRECLASS_TIMEOUT_MS) {
    ensureTweetSubscription(tweetId, hash, locale, timeoutMs).catch(e => console.error('[startTweetSubscription] error:', e));
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
      // row. Close that leftover ONCE, then keep the annotation-timeout handle:
      // closing it again (a second claim's research, a reclassify) LATE-drops
      // the in-flight annotation UPDATE for the claim that just finished.
      if (force || !annotationRoutingReady.has(sideTweetId)) {
        if (force && annotationRoutingReady.has(sideTweetId)) {
          console.log(`[background] ensureAnnotationSubscription ${sideTweetId}: re-opening on a fresh routing row for Flow A`);
        }
        const existing = tweetSubs.get(sideTweetId);
        if (existing && !existing.isClosed()) existing.close();
        tweetSubs.delete(sideTweetId);
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
   *  - BATCH_REFRESH_FORCE (the "Re-reveal this tweet's claims" button) passes `force = true`.
   *
   *  Neither re-checks the DB first any more (that cost a billed fetch on every click to
   *  cover a rare race); `force` now only controls whether the top-of-tweet spinner is shown,
   *  since a forced run has no on-hold button to turn into one.
   *
   *  On a no-claims outcome the tweet is returned to `onHoldTweets` so the Disinfact button
   *  comes back and the user can retry. */
  function runPreclassification(
    entry: { tweet: MainTweet; hash: string },
    locale: string,
    logTag: string,
    force: boolean,
    /** Which side of a translation the user is looking at, read off X's toggle row by the
     *  content script. `null`/omitted means unknown — callers that cannot observe the DOM
     *  (e.g. BATCH_REFRESH_FORCE) pass nothing and keep the original inference exactly. */
    displayedSide?: 'TRANSLATED' | 'ORIGINAL' | null,
    /** The text X is actually rendering, sent only when `displayedSide` is 'TRANSLATED'.
     *  Used as a last resort when the captured payload has no `translatedText`. */
    displayedText?: string | null
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
    const readingOriginal = displayedSide === 'ORIGINAL' && !!tweet.sourceLanguage;
    if (displayedSide === 'ORIGINAL' && !tweet.sourceLanguage) {
      console.log(`[background] ${logTag} ${tweetId}: user is on the ORIGINAL side but the payload has no sourceLanguage — cannot name the locale, leaving the inference unchanged`);
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
    const fallbackTranslation = displayedSide === 'TRANSLATED' ? (displayedText?.trim() || undefined) : undefined;
    const displayedTranslation = tweet.translatedText || fallbackTranslation;

    // Build the display tweet (translated text when translated) — the worker
    // computes highlight ranges against its `text`. Only the root tweet can use the DOM
    // fallback: `displayedText` is the main tweet's element, not a quoted or parent post.
    function tweetForDisplay(t: MainTweet, isRoot = false): MainTweet {
      const body = isRoot ? displayedTranslation : t.translatedText;
      const hasTranslationInner = !!body && !!t.destinationLanguage && !readingOriginal;
      return {
        ...t,
        text: hasTranslationInner ? body! : t.text,
        quoting: t.quoting ? tweetForDisplay(t.quoting as MainTweet) : null,
        replyingTo: t.replyingTo ? tweetForDisplay(t.replyingTo as MainTweet) : null,
      } as MainTweet;
    }
    const hasTranslation = !!displayedTranslation && !!tweet.destinationLanguage && !readingOriginal;
    const displayedLocale = (hasTranslation ? tweet.destinationLanguage : tweet.sourceLanguage) ?? locale;
    const bodySource = !hasTranslation ? 'original' : (tweet.translatedText ? 'translated (payload)' : 'translated (DOM fallback)');
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
          cls.batchId = batchId;
          attachTranslatedLocale(cls, tweet);
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

        if (!latest || !latest.claims || latest.claims.length === 0) {
          // Preclassification produced no claims (or failed after retries). Broadcast
          // empty (clears the Fact-Check All button) and leave it retryable.
          const empty: Classification = latest ?? { id: tweetId, batchId, claims: null, quoting: null };
          empty.onHold = false;
          cacheClassification(empty, batchId);
          broadcastClassification(empty);
          onHoldTweets.set(tweetId, entry);
          clearInterval(keepAlive);
          return;
        }

        reResearchedTweetIds.add(tweetId);

        // Step 3: refresh the Step-0 subscription timer so the routing row stays
        // alive for the worker's link broadcasts (already a no-op reset when open).
        startTweetSubscription(tweetId, hash, locale);

        // Step 4: a tweet that yields exactly one claim is researched without waiting
        // for a second click. Awaited so the keepAlive interval above spans the
        // research — otherwise the service worker could be reaped mid-call.
        const soleClaims = [...(latest.claims ?? []), ...(latest.quoting?.claims ?? [])];
        if (soleClaims.length === 1) {
          await autoClassifySoleClaim(tweetId, soleClaims[0], batchId, locale);
        }
      } catch (err: any) {
        console.error(`[background] ${logTag} error:`, err);
      } finally {
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

  /** Research a tweet's only claim without waiting for the user to click Fact-Check.
   *
   *  Runs the same DB-first-then-research sequence a claim click runs: pullClaimBeforeClassify
   *  short-circuits on a row that is already settled, and anything else goes through
   *  refreshClaim. The claim is flipped to `refreshing` up front so the Fact-Check
   *  affordance can't be clicked a second time (and billed twice) while the automatic run
   *  is in flight; any failure reverts it to its on-hold button for a manual retry. */
  function autoClassifySoleClaim(tweetId: string, claim: Claim, batchId: string, locale: string): Promise<void> {
    const refreshKey = `${tweetId}:${claim.text}`;
    if (ongoingClaimRefreshes.has(refreshKey)) return Promise.resolve();

    const hit = classificationCache.get(tweetId);
    if (!hit) return Promise.resolve();

    // Already carrying a readable verdict → there is nothing to spend on. A change-prone
    // row (reclassifyOnHold) is deliberately NOT settled, so it falls through to research.
    const hasNote = claim.note !== undefined && claim.note !== null && String(claim.note).trim() !== "";
    // Logged because every one of these four can be the reason a claim the DB already holds
    // is re-researched — the user pays for that, and from the outside "it re-classified" has
    // no cause. The verdict the settle needs can also be sitting one field away in
    // `cachedVerdict` (a refresh-path stash), which reads identically to "no verdict" today.
    console.log(
      `[background] autoClassifySoleClaim ${tweetId}:`,
      claim.verdict && claim.verdict !== 'research required' && hasNote && !claim.reclassifyOnHold
        ? 'already settled — no spend'
        : `RESEARCHING (verdict=${claim.verdict ?? 'none'}, note=${hasNote}, onHold=${claim.reclassifyOnHold === true}, cachedVerdict=${claim.cachedVerdict ?? 'none'})`
    );
    if (claim.verdict && claim.verdict !== 'research required' && hasNote && !claim.reclassifyOnHold) {
      return Promise.resolve();
    }

    // Flip to researching, restoring whatever cached values the claim carries so a
    // change-prone row keeps showing its previous verdict while the new one streams in.
    const updatedClaims = hit.classification.claims?.map(cl =>
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
    const restored: Classification = { ...hit.classification, claims: updatedClaims, reclassifyOnHold: anyOnHold || undefined };
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
            mergeSingleClaimAndBroadcast(tweetId, claim.text, updated, batchId, { withLocators: !!annotLoc });
          }
          if (annotLoc) await settleFlowAAnnotations(tweetId, claim.text, annotLoc, batchId);
        }
      } catch (err: any) {
        console.error(`[background] autoClassifySoleClaim error for "${claim.text.slice(0, 40)}":`, err);
      } finally {
        ongoingClaimRefreshes.delete(refreshKey);
        if (!(handled || gotUpdate)) revertClaimToOnHold(tweetId, claim.text, batchId);
      }
    });
    trackClaimResearch(refreshKey, promise);
    return promise;
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
          const existing = dbFetchPromises.get(tweet.id);
          if (existing) {
            const cached = await existing;
            return { tweet, ...cached };
          }

          const promise = (async (): Promise<Omit<HashResult, 'tweet'>> => {
            const tFetchStart = performance.now();
            if (shouldDeferDom) {
              await waitForDom(tweet.id);
            }
            const hash = await computeTweetHash(tweet);
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
          const classification = dbClaimsToClassification(hit.tweet, hit.dbResult.claims, batchId, locale, quotedClaims);
          // Do NOT preserve textLocale from previous sessions/page loads. X's displayed
          // language may have changed (e.g. Chinese -> English), and the default displayed
          // text for this load is determined by dbClaimsToClassification. Only live toggle
          // clicks during this session should change textLocale.
          // Preserve any claims already seeded by the subscription (linked in the tiny
          // window after the fetch snapshot) so this authoritative build doesn't clobber them.
          const seeded = classificationCache.get(hit.tweet.id)?.classification;
          if (seeded?.claims?.length && classification.claims) {
            const have = new Set(classification.claims.map(c => c.dbClaimId).filter(Boolean));
            const extra = seeded.claims.filter(c => c.dbClaimId && !have.has(c.dbClaimId));
            if (extra.length) classification.claims = [...classification.claims, ...extra];
          }
          cacheClassification(classification, batchId);

          // Cache DB result for TRANSLATE_FACT_CHECKS handler
          dbHitCache.set(classification.id, { tweet: hit.tweet, dbClaims: hit.dbResult.claims });
          if (hit.tweet.quoting && hit.quotedDbResult?.success && hit.quotedDbResult.claims?.length > 0) {
            dbHitCache.set(hit.tweet.quoting.id, { tweet: hit.tweet.quoting as MainTweet, dbClaims: hit.quotedDbResult.claims });
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

          safePostToPort(port, { type: "CLASSIFICATION", data: classification });

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
          attachTranslatedLocale(classification, empty.tweet);
          cacheClassification(classification, batchId);
          safePostToPort(port, { type: "CLASSIFICATION", data: classification });
          // Subscribe only while it IS preclassifying: a settled claim-free tweet has
          // nothing more coming, and subscribe() would delete itself immediately anyway.
          if (isPreclassifying) startTweetSubscription(classification.id, empty.hash, locale);
        }

        // Step 4: Existing cached/uncached split for remaining DB misses
        const dbNotFound = dbMissResults.filter(r => !r.dbResult?.success);
        const cached: Classification[] = [];
        const uncached: MainTweet[] = [];
        for (const r of dbNotFound) {
          const tweet = r.tweet;
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
            attachTranslatedLocale(onHoldClassification, tweet);
            cacheClassification(onHoldClassification, batchId);
            safePostToPort(port, { type: "CLASSIFICATION", data: onHoldClassification });
            onHoldTweets.set(tweet.id, { tweet, hash: r.hash });
            // A tap parked while the worker was dead (backgrounded / long idle)
            // won the race and arrived before this entry existed — honor it now
            // instead of stranding the spinner until the 30s revert. No-op untapped.
            flushPendingProcessOnHold(tweet.id);
          }
        }

        for (const cachedClassification of cached)
          safePostToPort(port, { type: "CLASSIFICATION", data: cachedClassification });

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

  /** Last total written into the App Group, so an unchanged value costs nothing. */
  let lastNativeSyncedTotal: number | null = null;
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
   * A Supabase access token for the app to authenticate its own fact-checks with, or nil.
   *
   * The app cannot mint one: it is given an access token and no refresh token (see
   * `SharedTopUpStore.setSession`), so once its copy lapses the Fact-Check tab is dead until the
   * popup is opened — which was the only thing that ever handed one over. The background can
   * refresh, so it does, and hands the result on: the app's copy is then never far behind a live
   * one, and that state goes back to meaning what it says — the browser is not running.
   *
   * Nil means there is nothing worth handing over, on any of three counts: nobody is signed in;
   * the token is at or near its end, which covers a refresh that just failed and which the app
   * would refuse anyway (`FactCheckClient.liveSession` wants 30 seconds of life left in it); or the
   * app already holds this same one.
   */
  async function nativeSessionHandover(): Promise<{ accessToken: string; expiresAt: number } | null> {
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

    return { accessToken: session.access_token, expiresAt: session.expires_at };
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
          // The app already has both halves of this message.
          if (total === lastNativeSyncedTotal && !session) return;

          await (browser.runtime as any).sendNativeMessage(NATIVE_APP_ID, {
            action: 'SYNC_ACCOUNT',
            userId,
            balance: total,
            ...(session
              ? { accessToken: session.accessToken, accessTokenExpiresAt: session.expiresAt }
              : {}),
          });
          // Only after the app has it. A send that failed leaves the mark where it was, so the
          // next tick tries again rather than counting a token as delivered when it was not.
          if (session) await browser.storage.local.set({ [NATIVE_SESSION_EXPIRES_KEY]: session.expiresAt });
          lastNativeSyncedTotal = total;
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
      broadcastNotification({ kind: delta > 0 ? 'increase' : 'decrease', amount: roundedDelta });
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
  // Each admitted claim reserves the WORST-CASE settled charge (not the backend hold — see
  // CLASSIFICATION_RESERVE), so the balance is sized for what actually leaves it rather than for
  // what the backend merely held. Claims the balance funds in full run in parallel; once it can't,
  // they run ONE at a time, draining whatever is left. That still dispatches no wasted 402s: the
  // backend refuses a hold only while the balance is ≤ 0, so the partly-funded claim runs and it
  // is the SECOND one in parallel that would 402.
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
   *  claim holds against the balance. Deliberately NOT the backend hold: classify-tweets settles at
   *  `cost * FEE_MULTIPLIER * PROFIT_MULTIPLIER`, and the ×2 margin is excluded from the hold (an
   *  overrun eats the margin rather than the operator's money). Both sides sum the SAME three
   *  terms — Gemini streams, paid searches, and the post-research annotation — and apply
   *  fee-recovery once to the total; the terms mirror classify-tweets' `const INPUT_LIMIT` block
   *  plus its `annotWorstAtLimit`. Change the backend formula and this together. */
  const CLASSIFICATION_RESERVE = (() => {
    const GEMINI_IN = 0.75, GEMINI_OUT = 3.75, OUTPUT_LIMIT = 2000;   // gemini-3.6-flash
    const INPUT_LIMIT = 6000, SEARCH_CONTEXT_TOKENS = 3500, GEMINI_STREAMS = 4;
    const TAVILY_SEARCH_COST = 0.016, EXA_DEEP_COST = 0.015;
    const ANNOT_IN = 0.99, ANNOT_OUT = 2.20, ANNOT_FEE = 1.055;   // Qwen 3.8 27B via OpenRouter
    const ANNOT_INPUT_LIMIT = 20000, ANNOT_OUTPUT_LIMIT = 2000;
    const FEE_MULTIPLIER = (4 / 3) * 1.03;   // Apple/Stripe take + FX
    const PROFIT_MULTIPLIER = 2;             // classify-tweets' margin, on the whole charge
    const geminiWorst = (((INPUT_LIMIT + SEARCH_CONTEXT_TOKENS) * GEMINI_IN + OUTPUT_LIMIT * GEMINI_OUT) / 1e6) * GEMINI_STREAMS;
    const searchWorst = TAVILY_SEARCH_COST * 2 + EXA_DEEP_COST;
    const annotWorst = ((ANNOT_INPUT_LIMIT * ANNOT_IN + ANNOT_OUTPUT_LIMIT * ANNOT_OUT) / 1e6) * ANNOT_FEE;
    return (geminiWorst + searchWorst + annotWorst) * FEE_MULTIPLIER * PROFIT_MULTIPLIER;
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
            mergeSingleClaimAndBroadcast(classificationId, claimText, updated, batchId, { withLocators: !!annotLoc });
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
    factCheckAllTweetIds.clear();
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
    persistSelectionPipeline();
  }

  // Keep the whole extension in sync with sign-in AND balance. On a transition to
  // inactive (signed out, or balance ≤ 0) we clear pipeline state and freeze every
  // content script; on active we (re)open the funds hub and resume. Serialized +
  // guarded by `lastActive` so rapid events don't double-fire. When signed out we
  // also tear the funds hub down; on a mere zero-balance we keep it running so a
  // later top-up is detected and re-activates the extension.
  let lastActive: boolean | null = null;
  let activeEvalChain: Promise<void> = Promise.resolve();
  /** Re-evaluate whether the extension should be active (signed in AND in credit) and,
   *  when that answer flips, either resume the content scripts or tear the pipeline down.
   *
   *  Serialized through activeEvalChain because sign-in and balance events can land
   *  together; running two evaluations concurrently could otherwise interleave and leave
   *  the relays with the wrong state. */
  function refreshActiveState() {
    activeEvalChain = activeEvalChain.then(async () => {
      const signed = await isSignedIn();
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
      if (!signed) clearNativeAccount();
      const active = signed && balanceOk();
      if (lastActive === active) return;
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

  // ── Stripe checkout: open the checkout tab and close it on the x.com return ──
  /** Open Stripe checkout in a new tab and close it again once it redirects back to
   *  x.com carrying the disinfax_checkout marker (see the checkout worker's return
   *  URLs), then poll for the credit. Watching for the redirect is what lets the user
   *  land back where they started instead of on a stranded success page. x.com needs no
   *  extra host permission: its content-script match already makes tabs.onUpdated carry
   *  changeInfo.url for it. */
  function openCheckoutTab(url: string) {
    Promise.resolve(browser.tabs.create({ url })).then((tab: any) => {
      const tabId = tab?.id;
      if (tabId == null) return;
      const onUpdated = (updatedTabId: number, changeInfo: any) => {
        if (updatedTabId !== tabId) return;
        const updatedUrl: string | undefined = changeInfo?.url;
        if (updatedUrl && /:\/\/x\.com[/?#].*disinfax_checkout=/i.test(updatedUrl)) {
          cleanup();
          try { browser.tabs.remove(tabId); } catch { /* already gone */ }
          pollFundsAfterCheckout();
        }
      };
      const onRemoved = (closedId: number) => { if (closedId === tabId) cleanup(); };
      const cleanup = () => {
        try { browser.tabs.onUpdated.removeListener(onUpdated); } catch { /* ignore */ }
        try { browser.tabs.onRemoved.removeListener(onRemoved); } catch { /* ignore */ }
      };
      browser.tabs.onUpdated.addListener(onUpdated);
      browser.tabs.onRemoved.addListener(onRemoved);
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

  /** Run an injection in the tab's TOP frame only.
   *
   *  The selection and the wrap both live in the top document, and an unscoped
   *  injection also runs in every third-party iframe — whose domains Safari then
   *  gates one by one (the id5-sync.com ad-sync prompt on CBC). Scoping to frame 0
   *  keeps the single prompt for the site the user is actually on, and keeps the
   *  popup's tabs.sendMessage from being answered by a stale copy in a frame.
   *
   *  Fails CLOSED when the scoped injection rejects (older Safari builds predate
   *  `frameIds` support): falling back to an unscoped injection there re-runs the
   *  file in every ad iframe and re-summons the per-domain prompts the scoping was
   *  built to prevent. The callers already treat a throw as "not injected" (the
   *  world probe logs `injected:false` and the flow declines with a named reason),
   *  so refusing beats prompting for a tracker. */
  async function execTopFrame(tabId: number, spec: { files?: any; func?: () => any; world?: any }): Promise<any> {
    // `allFrames: false` is the documented default, but Safari has been observed
    // injecting into tracker iframes (id5-sync.com on CBC) when the target is
    // under-specified. Name both: top frame only, never the ad frames.
    return await browser.scripting.executeScript({ target: { tabId, frameIds: [0], allFrames: false }, ...spec } as any);
  }

  async function runInPageWorld(tabId: number, func: () => any): Promise<any> {
    try {
      const results = await execTopFrame(tabId, {
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
  async function probeSelectionInPageWorld(tabId: number): Promise<string> {
    const result = await runInPageWorld(tabId, () => {
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
  async function captureSelectionInPageWorld(tabId: number): Promise<any> {
    return runInPageWorld(tabId, () => {
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
        /** Words either side of a right-click that carried no deliberate selection. A
         *  word is a POINTER at the passage it sits in: the read is its neighbourhood,
         *  never the article around it (this is the page-world half of the rule in
         *  entrypoints/selection.ts windowAround — this function is serialized into the
         *  page's world, so it cannot call that one and the two are kept in step by hand). */
        const THIN_WINDOW_WORDS = 25;
        const WHITESPACE = /\s/;
        const windowBounds = (text: string, a0: number, a1: number, limit: number): [number, number] => {
          let start = a0, back = 0, i = a0;
          while (i > 0 && back < limit) {
            while (i > 0 && WHITESPACE.test(text[i - 1])) i--;
            if (i === 0) break;
            while (i > 0 && !WHITESPACE.test(text[i - 1])) i--;
            back++;
            start = i;
          }
          let end = a1, forward = 0, j = a1;
          while (j < text.length && forward < limit) {
            while (j < text.length && WHITESPACE.test(text[j])) j++;
            if (j >= text.length) break;
            while (j < text.length && !WHITESPACE.test(text[j])) j++;
            forward++;
            end = j;
          }
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
          const [from, to] = windowBounds(all, a0, a1, THIN_WINDOW_WORDS);
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
        const hostName = location.hostname.replace(/^www\./, '');
        const onX = hostName === 'x.com' || hostName === 'twitter.com'
          || hostName.endsWith('.x.com') || hostName.endsWith('.twitter.com');
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
        const tweetIdOf = (article: Element): string | null => {
          const links = article.querySelectorAll('a[href*="/status/"]');
          for (let i = 0; i < links.length; i++) {
            const link = links[i] as HTMLAnchorElement;
            if (link.closest('article') !== article) continue;
            const m = (link.getAttribute('href') || '').match(/\/status\/(\d+)/);
            if (m) return m[1];
          }
          return null;
        };
        const ownEl = (article: Element, selector: string): HTMLElement | null => {
          const found = article.querySelectorAll(selector);
          for (let i = 0; i < found.length; i++) {
            const el = found[i] as HTMLElement;
            if (el.closest('article') === article) return el;
          }
          return null;
        };
        const hasButtons = (article: Element) => !!ownEl(
          article,
          '[data-mf-charge="disinfact"], [data-mf-charge="refresh-top"], [data-mf-charge="factcheckall"], [data-mf-charge="translate-tweet"], [mf-on-hold-id], [mf-top-bar-id], [translate-fc-id], [mf-refresh-id], [mf-visual-id]',
        );
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
        const overlapping = overlappingWraps.length > 0;
        for (const w of overlappingWraps) foldWrap(w as HTMLElement);
        if (overlapping && (!range.startContainer?.isConnected || !range.endContainer?.isConnected)) {
          const live = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
          if (live && live.startContainer && live.endContainer && live.startContainer.isConnected && live.endContainer.isConnected) {
            range = live;
          }
        }
        const injected: Element[] = [];
        if (onX) {
          const ancestor = range.commonAncestorContainer;
          const root = ancestor.nodeType === 1 ? (ancestor as Element) : ancestor.parentElement;
          const scope = root?.closest('article')?.parentElement ?? root;
          if (scope) {
            const articles = scope.querySelectorAll('article');
            for (let i = 0; i < articles.length; i++) {
              const a = articles[i];
              if (hasButtons(a) && tweetIdOf(a) && intersects(a)) injected.push(a);
            }
          }
          const startA = (range.startContainer.nodeType === 1
            ? (range.startContainer as Element)
            : range.startContainer.parentElement)?.closest('article');
          const endA = (range.endContainer.nodeType === 1
            ? (range.endContainer as Element)
            : range.endContainer.parentElement)?.closest('article');
          for (const a of [startA, endA]) {
            if (a && hasButtons(a) && tweetIdOf(a) && intersects(a) && !injected.includes(a)) injected.push(a);
          }
          injected.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);
        }
        const fireTweet = (article: Element): string | null => {
          const disinfact = ownEl(article, 'button[data-mf-charge="disinfact"]');
          if (disinfact) { disinfact.click(); return null; }
          const refresh = ownEl(article, 'button[data-mf-charge="refresh-top"]');
          if (refresh) { refresh.click(); return null; }
          return tweetIdOf(article);
        };
        const leftoverFrom = (src: Range, holes: Element[]): Range[] => {
          if (holes.length === 0) return [src.cloneRange()];
          const pieces: Range[] = [];
          let fromContainer: Node = src.startContainer;
          let fromOffset = src.startOffset;
          for (const hole of holes) {
            try {
              const piece = document.createRange();
              piece.setStart(fromContainer, fromOffset);
              piece.setEndBefore(hole);
              if (piece.compareBoundaryPoints(Range.START_TO_START, src) < 0) {
                piece.setStart(src.startContainer, src.startOffset);
              }
              if (piece.compareBoundaryPoints(Range.END_TO_END, src) > 0) {
                piece.setEnd(src.endContainer, src.endOffset);
              }
              if (!piece.collapsed && piece.toString().trim()) pieces.push(piece);
            } catch { /* inverted */ }
            try {
              const after = document.createRange();
              after.setStartAfter(hole);
              fromContainer = after.startContainer;
              fromOffset = after.startOffset;
            } catch {
              return pieces;
            }
          }
          try {
            const tail = document.createRange();
            tail.setStart(fromContainer, fromOffset);
            tail.setEnd(src.endContainer, src.endOffset);
            if (!tail.collapsed && tail.toString().trim()) pieces.push(tail);
          } catch { /* inverted */ }
          return pieces.filter((p) => !holes.some((h) => {
            try {
              const nr = document.createRange();
              nr.selectNodeContents(h);
              return p.compareBoundaryPoints(Range.START_TO_END, nr) < 0
                && p.compareBoundaryPoints(Range.END_TO_START, nr) > 0;
            } catch {
              return false;
            }
          }));
        };
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
        const pendingTweetIds: string[] = [];
        let wrapIds: string[] = [];
        if (injected.length > 0) {
          for (const article of injected) {
            const missed = fireTweet(article);
            if (missed) pendingTweetIds.push(missed);
          }
          const leftovers = leftoverFrom(range, injected);
          for (let i = leftovers.length - 1; i >= 0; i--) {
            const wrapId = wrapOne(leftovers[i]);
            if (wrapId) wrapIds.unshift(wrapId);
          }
        } else if (spansBlocks(range)) {
          // Refused rather than wrapped: the page keeps its layout and the page script
          // fact-checks the text with its claims listed at the selection. `text` and `rect`
          // are what make that possible, so this is a fallback and not a failure.
          return fail('selection spans block boundaries', { text, rect });
        } else {
          const wrapId = wrapOne(range);
          if (wrapId) wrapIds.push(wrapId);
        }
        if (wrapIds.length === 0 && injected.length === 0) {
          return fail(`range extracted nothing (collapsed=${range.collapsed}, rangeText=${range.toString().length})`, { text, rect });
        }
        if (pendingTweetIds.length) document.documentElement.dataset.mfSelTweetIds = pendingTweetIds.join(',');
        else delete document.documentElement.dataset.mfSelTweetIds;
        if (overlapping) document.documentElement.dataset.mfSelForce = '1';
        else delete document.documentElement.dataset.mfSelForce;
        if (wrapIds.length === 0) {
          document.documentElement.dataset.mfSelTweetOnly = '1';
          delete document.documentElement.dataset.mfSelId;
          delete document.documentElement.dataset.mfSelIds;
        } else {
          delete document.documentElement.dataset.mfSelTweetOnly;
          document.documentElement.dataset.mfSelId = wrapIds[0];
          document.documentElement.dataset.mfSelIds = wrapIds.join(',');
        }
        sel?.removeAllRanges();
        return { ok: true, id: wrapIds[0] ?? 'tweet-only', len: text.length, tweetOnly: wrapIds.length === 0, leftoverCount: wrapIds.length };
      } catch (err) {
        return fail(String(err));
      }
    });
  }

  /** The in-page script file, as built by `entrypoints/selection.ts`. Injected rather
   *  than declared, so it exists only on pages the user acted on. Re-injection on every
   *  trigger is intentional — the script guards itself and the injection is what makes
   *  the *message* that follows deliverable. */
  async function peekIsolatedWorld(tabId: number): Promise<IsolatedWorld | null> {
    try {
      const probe = await execTopFrame(tabId, {
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

  async function injectSelectionScript(tabId: number): Promise<{ injected: boolean; world: IsolatedWorld | null }> {
    try {
      // A live copy of this extension's script is enough: start/probe are handed
      // to `__mfSelectionResponder` in-world, so re-injecting does not make the
      // message more deliverable — it only stacks copies and gives Safari another
      // chance to prompt for every iframe on the page. A copy from a previous
      // extension id (reload of a different build) is not ours; inject then.
      // One peek, not the 5×100ms wait: a cold tab would otherwise stall every
      // probe on a world we already know is empty.
      const existing = await peekIsolatedWorld(tabId);
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
      await execTopFrame(tabId, {
        func: () => {
          const g = globalThis as any;
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
      const injected = await execTopFrame(tabId, { files: [SELECTION_SCRIPT] });
      console.log(`[background] selection script injected into tab ${tabId}:`, JSON.stringify(injected));
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
      return { injected: true, world: await readIsolatedWorld(tabId) };
    } catch (err: any) {
      // Chrome refuses injection into chrome:// pages, the Web Store, PDF viewers and
      // other extension pages. Nothing to do about it — the user cannot fact-check there.
      console.log(`[background] selection script not injectable into tab ${tabId}:`, err?.message ?? err);
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
  async function readIsolatedWorld(tabId: number): Promise<IsolatedWorld | null> {
    let last: IsolatedWorld | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const probe = await execTopFrame(tabId, {
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
        console.log(`[background] isolated world unreadable in tab ${tabId}:`, err?.message ?? err);
        return null;
      }
      if (last?.responder === 'function') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    // Our own id is printed beside the world's so the two can be compared without a second
    // log line: they must match, and a world reporting a different one (or none) is a world
    // whose listener nothing this file sends can ever reach.
    console.log(
      `[background] isolated world in tab ${tabId}:`,
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
  async function askSelection(tabId: number, kind: 'start' | 'probe' | 'popupStart' | 'notifyNotSignedIn'): Promise<{ delivered: boolean; reply: any }> {
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
      await execTopFrame(tabId, { func: stage });
      const invoked = await execTopFrame(tabId, {
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
        const read = await execTopFrame(tabId, {
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

  /** Display the signed-out error notification on the given tab immediately.
   *  Broadcasts to any live ports (e.g. X.com) and injects the selection script
   *  to deliver the notification on arbitrary web pages without running preclassification. */
  async function notifyTabSignedOut(tabId: number): Promise<void> {
    notifyError(ERROR_CODES.NOT_SIGNED_IN);
    try {
      const { injected } = await injectSelectionScript(tabId);
      if (injected) {
        await askSelection(tabId, 'notifyNotSignedIn');
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
    console.log(
      '[background] context menu clicked:', info?.menuItemId,
      '| tab id:', tab?.id,
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
        await notifyTabSignedOut(tabId);
        return;
      }
      const { injected, world } = await injectSelectionScript(tabId);
      if (!injected) return;
      // keepProbe: false — this path never ran a probe, so if the page no longer holds a
      // selection there is nothing to fall back on and the page script must say so rather
      // than reuse a capture left over from an earlier Disinfact.
      //
      // The page script reaches back here for the page-world read if its own comes up
      // empty, so this one hand-over is all both halves of the read need.
      const { delivered, reply } = await askSelection(tabId, 'start');
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

  /** The claim to decide on, once its DB row has landed: the DB's version of it when the row
   *  arrives, and the claim passed in when nothing can be learned.
   *
   *  A lone claim is researched without a second click, and the one question that has to be
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
   *  is opened by the caller before its stream starts (startSelectionPipeline); the call below
   *  only refreshes that timer, which is the longer window this wait needs, and re-opens it if
   *  the run reached here without one.
   *
   *  Bounded, but a timeout is NOT free: the claim handed back is the one passed in, and the
   *  one passed in comes off the preclassify stream, so it carries verdict "research required"
   *  with `reclassifyOnHold` — which is precisely the shape `autoClassifySoleClaim`'s settle
   *  guard refuses. Timing out therefore re-researches a claim the DB may already hold a
   *  verdict for. That is why this wait gets the longer SELECTION_DB_ROW_TIMEOUT_MS. A row
   *  that does arrive settles the claim through that same guard, without spending. */
  async function claimAfterRowLands(
    selectionId: string, claim: Claim, hash: string, locale: string
  ): Promise<Claim> {
    try {
      // Preclassification complete deletes internal.broadcasts in Postgres, so any
      // pre-existing client handle is now detached from routing. Close it so
      // ensureTweetSubscription creates a fresh routing row via public.subscribe.
      const existing = tweetSubs.get(selectionId);
      if (existing && !existing.isClosed()) existing.close();
      tweetSubs.delete(selectionId);
      annotationRoutingReady.delete(selectionId);
      await ensureTweetSubscription(selectionId, hash, locale, ANNOTATION_TIMEOUT_MS);
      annotationRoutingReady.add(selectionId);
      await awaitClaimDbRow(selectionId, claim.text, SELECTION_DB_ROW_TIMEOUT_MS);
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
    // The language is the one the run was sent under (a selection has no sourceLanguage
    // of its own, and annotLocatorsFor needs one), and this is a CLONE: what preClassify
    // was handed stays exactly as built, so the extraction input is untouched. Neither
    // field is part of a selection's canonical hash (see canonicalContext — the
    // contextBefore/contextAfter branch hashes only those three parts), so the row this
    // run inserts and looks up is unaffected.
    tweetCache.set(selectionId, { ...tweet, sourceLanguage: req.locale } as unknown as MainTweet);
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
      void gatedSpend(async () => {
        try {
          const hash = await computeTweetHash(tweet);

        // Spinning state first, exactly like the tweet flow: the content script keeps its
        // "Disinfacting" indicator until the first claims land.
        const spinning: Classification = { id: selectionId, batchId, claims: null, quoting: null, preclassifying: true };
        cacheClassification(spinning, batchId);
        broadcastClassification(spinning);

        // Hash-hit first (same rule as processFullBatch). insert_tweet ON CONFLICT
        // DELETE's tweet_claims — re-preclassifying a passage the DB already holds
        // is what wiped the annotation key and brought the Annotate badge back.
        // A reselect (`force`) is the user's way to re-preclassify without a
        // button: skip the hit so the worker runs again and the new wrap is
        // the only highlight left on that passage.
        const dbResult = req.force ? { success: false as const } : await fetchDbTweet(hash);
        if (dbResult.success && dbResult.claims && dbResult.claims.length > 0) {
          const classification = dbClaimsToClassification(
            tweetCache.get(selectionId) as MainTweet,
            dbResult.claims,
            batchId,
            req.locale
          );
          classification.id = selectionId;
          classification.preclassifying = undefined;
          if (classification.claims) {
            classification.claims = classification.claims.filter(
              (c: any) => !unlocatedSelectionClaim(selectionId, c, false)
            );
          }
          cacheClassification(classification, batchId);
          dbHitCache.set(selectionId, { tweet: tweetCache.get(selectionId) as MainTweet, dbClaims: dbResult.claims });
          broadcastClassification(classification);
          // Same as X's research path: Flow A persists after the stream, and
          // the only client delivery is trg_tweet_claim_annotations_updated on
          // this routing row. A settled hash-hit used to skip the sub entirely
          // (`is_preclassifying` only), so the annotation never arrived.
          await ensureTweetSubscription(selectionId, hash, req.locale, ANNOTATION_TIMEOUT_MS);
          watchClassifyingClaims(selectionId, dbResult.claims, req.locale);
          const sole = classification.claims;
          if (sole && sole.length === 1) {
            await autoClassifySoleClaim(selectionId, sole[0], batchId, req.locale);
          }
          return;
        }

        // Miss: subscribe BEFORE streaming starts, exactly like the tweet flow (see
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
        for await (const cls of preClassify(tweet, hashToBytea(hash), req.locale, req.locale)) {
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
          cacheClassification(merged, batchId);
          broadcastClassification(merged);
          latest = merged;
        }

        if (!latest || !latest.claims || latest.claims.length === 0) {
          const empty: Classification = latest ?? { id: selectionId, batchId, claims: null, quoting: null };
          cacheClassification(empty, batchId);
          broadcastClassification(empty);
          return;
        }

        const sole = latest.claims;
        if (sole.length === 1) {
          // Decide on the claim the DB has, not on the one the stream stopped at — the
          // difference is a verdict that already exists (see the helper).
          const claim = await claimAfterRowLands(selectionId, sole[0], hash, req.locale);
          // Awaited so keepAlive spans the research, or the worker could be reaped mid-call.
          await autoClassifySoleClaim(selectionId, claim, batchId, req.locale);
        }
      } catch (err: any) {
        console.error('[background] startSelectionPipeline error:', err);
      } finally {
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

  // Popup ↔ background messaging (balance, messages, checkout).
  browser.runtime.onMessage.addListener((message: any, _sender: any, sendResponse: (r: any) => void) => {
    // Opening the popup is the user's *second* way to start a selection fact-check, so the
    // popup needs to know whether the active tab currently has text selected. Injection
    // lives here, not in the popup, so both trigger paths share one code path — and so the
    // activeTab grant the toolbar click just produced is used from the context that owns
    // the injection. Reply shape: { hasSelection, preview }.
    if (message?.type === 'MF_SELECTION_PREPARE' && typeof message.tabId === 'number') {
      (async () => {
        const { injected, world } = await injectSelectionScript(message.tabId);
        if (!injected) {
          sendResponse({ hasSelection: false });
          return;
        }
        const { delivered, reply } = await askSelection(message.tabId, 'probe');
        console.log(
          '[background] selection probe answered:', JSON.stringify(reply),
          '| delivered:', delivered,
          '| responder:', world?.responder ?? 'probe failed'
        );
        sendResponse({ hasSelection: !!reply?.hasSelection, preview: reply?.preview ?? '' });
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
          await notifyTabSignedOut(tabId);
          sendResponse({ ok: false, reason: 'not-signed-in' });
          return;
        }
        let world = await readIsolatedWorld(tabId);
        if (world?.responder !== 'function') {
          const inj = await injectSelectionScript(tabId);
          if (!inj.injected) {
            sendResponse({ ok: false, reason: 'not-injected' });
            return;
          }
          world = inj.world;
        }
        const { delivered, reply } = await askSelection(tabId, 'popupStart');
        console.log(
          '[background] selection popup-start answered:', JSON.stringify(reply),
          '| delivered:', delivered,
          '| responder:', world?.responder ?? 'probe failed'
        );
        sendResponse(reply && typeof reply === 'object' ? reply : { ok: false, reason: delivered ? 'no-reply' : 'not-delivered' });
      })();
      return true; // async sendResponse
    }
    if (message?.type === 'MF_NOTIFY_SIGNED_OUT' && typeof message.tabId === 'number') {
      (async () => {
        await notifyTabSignedOut(message.tabId);
        sendResponse({ ok: true });
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
        sendResponse({ text: await probeSelectionInPageWorld(tabId) });
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
        const result = await captureSelectionInPageWorld(tabId);
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
    // Stripe return tab: the content script on x.com/?disinfax_checkout= fires this at
    // document_start because the tabs.onUpdated watcher in openCheckoutTab is often gone
    // by then (MV3 idle during the Checkout session). Close the tab immediately — its
    // page must not classify, and leaving it open is how a freshly-funded X tab ended
    // up with no DisinfaX UI (relay bails on the marker and never injects).
    if (message?.type === 'MF_CHECKOUT_RETURN') {
      const tabId = _sender?.tab?.id;
      if (tabId != null) { try { browser.tabs.remove(tabId); } catch { /* already gone */ } }
      if (message.outcome === 'success') pollFundsAfterCheckout();
      return undefined;
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
      message?.type === 'MF_NATIVE_PENDING_TX'
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
                  accessToken: message.accessToken, accessTokenExpiresAt: message.accessTokenExpiresAt }
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
    // Firefox only. On Firefox, launchWebAuthFlow opens its auth window in a way that
    // closes the popup, and closing the popup destroys the JS context that was awaiting
    // the result — so the callback URL arrives with nobody left to receive it. Google
    // appeared to work only because an already-signed-in account redirects fast enough
    // to beat the teardown; Apple and X need real interaction and always lost the race.
    //
    // The background survives, so it runs the flow AND completes the session exchange.
    // The popup does not need to be alive at the end: the session lands in storage, and
    // whenever the popup is reopened it reads it back. Chrome is deliberately excluded —
    // its popup path works today and must not be disturbed.
    if (import.meta.env.FIREFOX && message?.type === 'MF_WEB_AUTH' && typeof message.url === 'string') {
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
            const usedProvider = message.provider;
            if (usedProvider === 'x' || usedProvider === 'google' || usedProvider === 'apple') {
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

    if (import.meta.env.SAFARI && message?.type === 'MF_AUTH_CALLBACK') {
      (async () => {
        const closeCallbackTab = () => {
          const tabId = _sender?.tab?.id;
          if (tabId != null) { try { browser.tabs.remove(tabId); } catch { /* already gone */ } }
        };
        try {
          if (message.errorDescription) {
            console.error('[background] OAuth provider rejected sign-in:', message.errorDescription);
            closeCallbackTab();
            sendResponse({ error: message.errorDescription });
            return;
          }
          if (message.code) {
            const { error } = await supabase.auth.exchangeCodeForSession(message.code);
            if (error) throw error;
          } else if (message.accessToken && message.refreshToken) {
            const { error } = await supabase.auth.setSession({
              access_token: message.accessToken,
              refresh_token: message.refreshToken,
            });
            if (error) throw error;
          } else {
            throw new Error('Callback carried no code or tokens.');
          }
          // Bring the pipeline up for the newly signed-in account before the user gets
          // back to the popup, so the balance is already known when they reopen it.
          refreshActiveState();
          closeCallbackTab();
          sendResponse({ ok: true });
        } catch (e: any) {
          console.error('[background] OAuth callback exchange failed:', e);
          closeCallbackTab();
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
    if (port.name !== "classify") return;
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
        const { batchId, tweetId: targetTweetId, newBatchId, locale: msgLocale } = message.data;

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
          reResearchedTweetIds.delete(id);
          localizedHighlightLocales.delete(id);
          factCheckAllTweetIds.delete(id);
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
          const sub = tweetSubs.get(id);
          if (sub) { sub.close(); tweetSubs.delete(id); }
          annotationRoutingReady.delete(id);
        };
        for (const t of tweets) {
          forget(t.id);
          if (t.quoting) forget(t.quoting.id);
        }

        // This IS the click ("Re-classify this tweet's claims"), so run a real
        // preclassification rather than a reload. It used to call processFullBatch, which
        // re-fetches from the DB and re-injects the existing rows on a hit — making the
        // button do visibly nothing for any tweet already stored. `force` skips that
        // pre-check; everything else (hold/spend gating, streaming, persistence, the
        // no-claims retry path) is the same shared helper the Disinfact button uses.
        const refreshLocale = msgLocale ?? getUiLocale();
        (async () => {
          for (const t of tweets) {
            try {
              const hash = await computeTweetHash(t);
              runPreclassification({ tweet: t, hash }, refreshLocale, "BATCH_REFRESH_FORCE", true);
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
          const { classificationId, claimText, locale: msgLocale, selection: msgSelection } = message.data;
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
            sourceLanguage: locale,
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
            const loc = await annotLocatorsFor(classificationId, freshCls.claims, claimText, freshCls)
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

            // Live-paint each streamed pair under this revision's FULL-locale key
            // (same `${textLocale}:${hash}` shape the worker persists — the DB
            // broadcast strips to bare prefixes at read time, and painting the
            // full key lets that strip land on exactly this dict), plus every
            // existing key (a retag keeps older revisions visible). The badge
            // flips to corrections without waiting for the broadcast, which
            // still arrives later via the annotations trigger and merges the
            // same values — union, never replace.
            const liveKeys = new Set<string>();
            for (const k of Object.keys(claim.annotations ?? {})) liveKeys.add(k);
            liveKeys.add(loc.textLocale);
            const paintLive = (acc: Record<string, string>) => {
              const entry = classificationCache.get(classificationId);
              if (!entry) return;
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
            };
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
        const { classificationId, claimText, locale: msgLocale } = message.data;
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
        port.postMessage({ type: "CLASSIFICATION", data: fcClassification });
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
              const annotLoc = await annotLocatorsFor(classificationId, freshCls.claims, claimText, freshCls)
                ?? await annotLocatorsFor(classificationId, freshCls.quoting?.claims, claimText, freshCls);
              for await (const updated of refreshClaim(freshCls, claimText, researchCache, msgLocale ?? getUiLocale(), tweetUrls, onBalanceError, annotLoc)) {
                gotUpdate = true;
                // Locators rode along, so the worker's silent post-research run is
                // in flight — "Annotating", not idle Annotate (see call site above).
                mergeSingleClaimAndBroadcast(classificationId, claimText, updated, anyBatchId, { withLocators: !!annotLoc });
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
        const { tweetId, locale: msgLocale, displayedSide, displayedText } = message.data;
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
        runPreclassification(entry, locale, "PROCESS_ON_HOLD", false, displayedSide ?? null, displayedText ?? null);
        return;
      }

      if (message.type === "FACT_CHECK_ALL") {
        const { tweetId, locale: msgLocale } = message.data;
        factCheckAllTweetIds.add(tweetId);
        console.log(`[background] FACT_CHECK_ALL for ${tweetId}`);
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
            if (cl.reclassifyOnHold) {
              enqueueFactCheckClaim(tweetId, cl.text, batchId, locale);
            }
          }
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

        // Pipeline claim: the user clicked the Disinfact badge while the
        // fetch-claim call was still in-flight or before the reclassifyOnHold
        // broadcast arrived. Set the claim to refreshing and start fresh research.
        const claimObj = classification.claims?.find(cl => cl.text === claimText);
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
                  mergeSingleClaimAndBroadcast(classificationId, claimText, updated, anyBatchId, { withLocators: !!annotLoc });
                }
                if (annotLoc) await settleFlowAAnnotations(classificationId, claimText, annotLoc, anyBatchId);
              }
            } catch (err: any) {
              console.error("[background] RECLASSIFY_ON_HOLD_CLICK pipeline refresh error:", err);
            } finally {
              ongoingClaimRefreshes.delete(refreshKey);
              // Any backend failure → revert to the on-hold button so the user can retry.
              if (!(handled || gotUpdate)) revertClaimToOnHold(classificationId, claimText, anyBatchId);
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
                mergeSingleClaimAndBroadcast(classificationId, claimText, updated, anyBatchId, { withLocators: !!annotLoc });
              }
              if (annotLoc) await settleFlowAAnnotations(classificationId, claimText, annotLoc, anyBatchId);
            }
          } catch (err: any) {
            console.error("[background] RECLASSIFY_ON_HOLD_CLICK refresh error:", err);
          } finally {
            ongoingClaimRefreshes.delete(refreshKey);
            // Any backend failure → revert to the on-hold button so the user can retry.
            if (!(handled || gotUpdate)) revertClaimToOnHold(classificationId, claimText, anyBatchId);
          }
        });
        trackClaimResearch(refreshKey, reclassifyResearchPromise);
        })();
        return;
      }

      if (message.type === "TRANSLATE_FACT_CHECKS") {
        const { tweetId, locale: msgLocale } = message.data;
        const hit = classificationCache.get(tweetId);
        if (!hit) return;
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
        const tweet = dbEntry?.tweet ?? cachedTweet;
        const dbClaims = dbEntry?.dbClaims;
        const displayedLocale = unheld.textLocale ?? tweet?.destinationLanguage ?? tweet?.sourceLanguage;

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
        const backfillAnnotations = () => {
          const gate = revisionGateFor(tweet, tweet?.quoting);
          const cur = classificationCache.get(tweetId)?.classification;
          if (!cur?.claims) return;
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
            const stripped = selectAnnotationRevision(rawA, gate);
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
          const tweetText = unheld.translatedText ?? tweet.translatedText ?? tweet.text;
          if (dbClaims) {
            // DB hit path: use cached claims for highlight localization
            gatedSpend(async () => {
              try {
                await warmAnnotationSubs();
                await localizeHighlights(tweetId, tweet, tweetText, displayedLocale, dbClaims, unheld, locale, mergeHighlightsFor(unheld));
                // Retry with annotations already persisted: Flow C's
                // annotations_present gate skips re-writing (no UPDATE → no
                // broadcast), so pull the stored dicts in directly.
                backfillAnnotations();
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
                await localizeHighlights(tweetId, tweet, tweetText, displayedLocale, clsDbClaims, unheld, locale, mergeHighlightsFor(unheld));
                backfillAnnotations();
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
        const { tweetId, textLocale: requestedLocale, displayedText } = message.data;
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

        // Update the classification's displayed text locale and, if we know the text,
        // update translatedText/translatedLocale so the content script uses the right source.
        const updatedCls: Classification = { ...classification, textLocale };
        if (textLocale === tweet.sourceLanguage && tweet.text) {
          updatedCls.translatedText = tweet.text;
          updatedCls.translatedLocale = tweet.sourceLanguage;
        } else if (textLocale === tweet.destinationLanguage && tweet.translatedText) {
          updatedCls.translatedText = tweet.translatedText;
          updatedCls.translatedLocale = tweet.destinationLanguage;
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
        // identical either way; the two conditions are complements (some claim missing a
        // highlight for this locale vs. some claim having one).
        const needsLocalization = (classification.claims ?? []).some(cl => !resolveHighlightRange(cl.highlight, textLocale));
        console.log(`[background] SET_DISPLAYED_LOCALE: ${tweetId} needsLocalization=${needsLocalization}`);
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
