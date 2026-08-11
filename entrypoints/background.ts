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
import { preClassify, refreshClaim, computeTweetHash, backgroundTranslate, backgroundTranslateClaim, backgroundHighlightRange, extractTweetUrls, TEST_LOCALE, normalizeSources, setWorkerErrorHandler } from "../utils/intelligence";
import { subscribeRow, fetchTweetAndTouchNetwork, getFullClaim, hashToBytea, subscribeFunds, getFunds, visibleTotal, type ClaimPayload, type SubscriptionHandle, type Funds, type FundsSubscription } from "../utils/realtime";
import { supabase } from "../utils/supabase";
import { findExactMatch, resolveHighlightRange } from "../utils/textBreakup";
import { Classification, Claim, Source, sameLanguage } from "../data/Classification";
import { MainTweet, Tweet } from "../data/Tweets";
import { COLOR_SCHEME_MESSAGE, applyToolbarIcon, restoreToolbarIcon } from "../utils/toolbarIcon";
import { ERROR_CODES } from "../utils/errorCodes";
import { NATIVE_APP_ID, NATIVE_CALLBACK_SCHEME } from "../utils/nativeHost";

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
  /** Track which highlight locales have been localized per tweet id so we don't
   *  re-run the highlight worker for the same locale repeatedly. */
  const localizedHighlightLocales = new Map<string, Set<string>>();
  /** Track tweets that have already had re-research / background localization fired
   *  in this session, so repeated timeline XHRs don't keep writing to the DB. */
  const reResearchedTweetIds = new Set<string>();
  /** Store tweets that had no DB hash match, pending user click on "Disinfact". */
  const onHoldTweets = new Map<string, { tweet: MainTweet; hash: string }>();
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
  /** How long to coalesce balance writes to the App Group. Long enough that a burst of
   *  classifications is one write, short enough that returning to the app feels immediate. */
  const NATIVE_SYNC_DEBOUNCE_MS = 1500;
  /** Open tweet subscriptions keyed by tweet id. */
  const tweetSubs = new Map<string, SubscriptionHandle>();
  /** Open per-claim (is_classifying) subscriptions keyed by `${tweetId}:${claimId}`. */
  const claimSubs = new Map<string, SubscriptionHandle>();

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

  /** Convert one claim record (a ClaimPayload from fetch_tweet_and_touch_network /
   *  get_full_claim, or a Realtime build_claim_payload) into a UI Claim. Shared by the
   *  initial pull and by live subscription merges. Adds dbClaimId (uuid) and handles
   *  is_classifying (another user is classifying → spinner + auto-replace on arrival). */
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

  function payloadToClaim(dbClaim: any, locale: string): Claim {
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
      highlight = {};
      for (const [key, val] of Object.entries(dbClaim.highlight)) {
        if (Array.isArray(val) && val.length === 2) highlight[key] = val as [number, number];
      }
      if (Object.keys(highlight).length === 0) highlight = undefined;
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

    const claims = dbClaims.map(dbClaim => payloadToClaim(dbClaim, locale));
    const quoting = tweet.quoting
      ? {
          id: tweet.quoting.id,
          claims: quotedDbClaims && quotedDbClaims.length > 0 ? quotedDbClaims.map(dbClaim => payloadToClaim(dbClaim, locale)) : null
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
    await backgroundHighlightRange(
      tweetHash,
      tweetText,
      allDbClaims,
      claimStorageLocale,
      highlightLocale,
      classification,
      onHighlightUpdate ?? mergeHighlightsFor(classification)
    );
    seen.add(highlightLocale);
    console.log(`[localizeHighlights] ${tweetId}: marked ${highlightLocale} as localized`);
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
  function broadcastClassification(classification: Classification) {
    const claimSummary = classification.claims?.map(claim => {
      const shortLabel = (claim.rewritten ?? claim.text).slice(0, 20);
      const notePreview = claim.note ? claim.note.slice(0, 15) : 'none';
      const highlightLocales = claim.highlight ? Object.keys(claim.highlight).join(',') : 'none';
      return `${shortLabel}...=${claim.confidence ?? '?'}(note:${notePreview}...,hl:${highlightLocales})`;
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
  function mergeSingleClaimAndBroadcast(
    classificationId: string,
    claimText: string,
    updated: Classification,
    batchId: string
  ) {
    const existing = classificationCache.get(classificationId)?.classification;
    const updatedClaim = updated.claims?.find(c => c.text === claimText);
    if (!existing || !existing.claims || !updatedClaim) {
      updated.batchId = batchId;
      cacheClassification(updated, batchId);
      broadcastClassification(updated);
      return;
    }
    const mergedClaims = existing.claims.map(c => (c.text === claimText ? updatedClaim : c));
    const anyOnHold = mergedClaims.some(c => c.reclassifyOnHold);
    const merged: Classification = {
      ...existing,
      claims: mergedClaims,
      reclassifyOnHold: anyOnHold || undefined,
    };
    merged.batchId = batchId;
    cacheClassification(merged, batchId);
    broadcastClassification(merged);
  }

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
          const ar = a.highlight[k], br = b.highlight[k];
          if (ar && br && ar[0] === br[0] && ar[1] === br[1]) return true;
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
        if (isActive(prev)) return { ...prev, highlight: mergedHl };
        return { ...inc, highlight: mergedHl, dbClaimId: prev.dbClaimId ?? inc.dbClaimId };
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
          const hlSize = Object.keys(mergedHighlight).length;
          return hlSize > 0
            ? { ...existingCl, highlight: mergedHighlight }
            : existingCl;
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
          };
        });
        const merged = { ...upd, claims: mergedClaims };
        cacheClassification(merged, classification.batchId);
        broadcastClassification(merged);
      } else {
        cacheClassification(upd, classification.batchId);
        broadcastClassification(upd);
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
    const incoming = payloadToClaim(payload, locale);
    const displayedLocale = cls.textLocale;
    const incomingRange = displayedLocale ? incoming.highlight?.[displayedLocale] : undefined;

    const claims = cls.claims ? [...cls.claims] : [];
    let idx = -1;
    if (payload.id) idx = claims.findIndex(c => c.dbClaimId === payload.id);
    if (idx < 0 && incomingRange && displayedLocale) {
      idx = claims.findIndex(claim => {
        const range = claim.highlight?.[displayedLocale];
        return !!range && range[0] === incomingRange[0] && range[1] === incomingRange[1];
      });
    }
    // Match by highlight range under ANY shared locale key — not just displayedLocale.
    // A [start,end] span in a given locale's text uniquely identifies one claim, so an
    // equal range under the same key is the same claim. This is what lets a DB-delivered
    // claim (from the subscription) recognize the agent-produced local claim even when
    // textLocale is unset and the rewritten text drifted (worker stores normalizeText'd
    // rewritten). Without it the DB copy is appended as a duplicate → fallback box.
    if (idx < 0 && incoming.highlight) {
      const incKeys = Object.keys(incoming.highlight);
      idx = claims.findIndex(c => {
        if (!c.highlight) return false;
        for (const k of incKeys) {
          const ir = incoming.highlight![k];
          const cr = c.highlight![k];
          if (ir && cr && ir[0] === cr[0] && ir[1] === cr[1]) return true;
        }
        return false;
      });
    }
    if (idx < 0) {
      idx = claims.findIndex(c =>
        (!!c.rewritten && c.rewritten === incoming.rewritten) ||
        c.text === incoming.text ||
        (!!c.dbClaimText && c.dbClaimText === incoming.dbClaimText));
    }

    if (idx >= 0) {
      const prev = claims[idx];
      const mergedHl = { ...(prev.highlight ?? {}), ...(incoming.highlight ?? {}) };
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
        claims[idx] = { ...incoming, text: prev.text, highlight: mergedHl };
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
      onDone: () => { if (tweetSubs.get(tweetId) === handleRef) tweetSubs.delete(tweetId); },
    });
    handleRef = handle;
    if (handle) { tweetSubs.set(tweetId, handle); await handle.ready; }
  }

  /** Fire-and-forget tweet subscription (for callers that don't need to await readiness). */
  function startTweetSubscription(tweetId: string, hash: string, locale: string, timeoutMs: number = PRECLASS_TIMEOUT_MS) {
    ensureTweetSubscription(tweetId, hash, locale, timeoutMs).catch(e => console.error('[startTweetSubscription] error:', e));
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

        // A forced re-preclassification has no on-hold button to turn into a spinner (the
        // tweet is already injected), so flag it and let the content script show one in the
        // Disinfact slot. Cleared by the first streamed result below, or in `finally`.
        if (force) {
          const cur = classificationCache.get(tweetId)?.classification;
          const spinning: Classification = { ...(cur ?? { id: tweetId, claims: null, quoting: null }), batchId, preclassifying: true };
          cacheClassification(spinning, batchId);
          broadcastClassification(spinning);
        }

        // If a tweet subscription is somehow still open, just extend its timer.
        const existingSub = tweetSubs.get(tweetId);
        if (existingSub && !existingSub.isClosed()) existingSub.resetTimeout(PRECLASS_TIMEOUT_MS);

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

        // Step 3: the worker inserts the tweet + claims and completes
        // preclassification. Subscribe to receive the authoritative claims (ids +
        // any matched-claim rewritten-text replacements) and merge them in.
        startTweetSubscription(tweetId, hash, locale);
      } catch (err: any) {
        console.error(`[background] ${logTag} error:`, err);
      } finally {
        clearInterval(keepAlive);
        // Safety net: never strand the top-of-tweet spinner if the run threw or returned
        // early without ever streaming a claim.
        if (force) {
          const cur = classificationCache.get(tweetId)?.classification;
          if (cur?.preclassifying) {
            const cleared: Classification = { ...cur, preclassifying: undefined };
            cacheClassification(cleared, cur.batchId ?? '');
            broadcastClassification(cleared);
          }
        }
      }
    });
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

  /** Broadcast a notification to every connected X content script. */
  function broadcastNotification(data: { kind: 'increase' | 'decrease' | 'error'; amount?: number; text?: string; code?: number }) {
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
   * Mirror the balance into the shared App Group container so the containing app can show it.
   *
   * Safari only, and it exists because the app has no Supabase session of its own — it cannot ask
   * the server what the balance is. Until now only the POPUP wrote that value across, so the app
   * showed whatever the balance was the last time the popup happened to be open. Now that the
   * webhook credits top-ups server-side within seconds, the popup was the only thing left forcing
   * the user to go and open it.
   *
   * Debounced, because a balance moves on every classification: without this each spend would wake
   * the app extension process just to write four bytes. The trailing edge is the one that matters —
   * intermediate values are of no interest to a screen nobody is looking at yet.
   */
  function syncFundsToNativeApp(total: number) {
    if (!import.meta.env.SAFARI) return;
    if (total === lastNativeSyncedTotal) return;

    if (nativeSyncTimer !== undefined) clearTimeout(nativeSyncTimer);
    nativeSyncTimer = setTimeout(() => {
      nativeSyncTimer = undefined;
      (async () => {
        try {
          const userId = await currentUserId();
          if (!userId) return; // signed out; nothing to attribute a balance to
          await (browser.runtime as any).sendNativeMessage(NATIVE_APP_ID, {
            action: 'SYNC_ACCOUNT',
            userId,
            balance: total,
          });
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
      // First value this session = baseline; no notification.
      lastVisibleTotal = total;
      return;
    }
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
  // classifications out at once, so ONLY it uses a client WAITLIST that admits claims within the
  // balance and the per-claim HOLD the backend reserves — never dispatching one that would 402.

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
  // Replicates the backend hold formula (classify-tweets:128-139) so the client admits only as
  // many parallel classifications as the balance covers; the rest wait (tweet order) and are
  // admitted one at a time as settling holds free the balance. Nothing that would 402 is ever
  // dispatched, so there are no wasted 402s or get_full_claim pulls.
  const FACTCHECK_BATCH_TIMEOUT_MS = 30000;
  const MAX_CLASSIFY_ATTEMPTS = 2; // 1 initial + at most 1 retry after a backend balance-too-low
  type WaitlistItem = { classificationId: string; claimText: string; batchId: string; locale: string; hold: number; attempts: number };
  const factCheckWaitlist: WaitlistItem[] = [];
  // Keys (`${id}:${text}`) currently WAITING — stops the broadcast auto-release from double-
  // enqueuing. In-flight claims are tracked by ongoingClaimRefreshes.
  const factCheckWaitlistKeys = new Set<string>();
  // Keys abandoned this batch (2 failed tries / 30s timeout / broke). The auto-release skips
  // these (and the on-hold masking shows their button) so a reverted claim isn't re-enqueued.
  // Cleared for a tweet on a fresh Fact-Check All (deliberate retry) and on reset.
  const abandonedFactCheckKeys = new Set<string>();
  // Σ of admitted-but-unsettled holds. available = visibleTotal(funds) − committedHold is
  // lag-invariant: acquiring a hold moves money balance→hold (visibleTotal unchanged) while
  // committedHold tracks our commitments; a settle drops visibleTotal by the tiny real cost and
  // we drop committedHold by the (larger) reserved hold, so available rises by the freed room.
  let committedHold = 0;
  let factCheckInFlight = 0;
  // Absolute batch deadline (ms), set once when the waitlist first fills; NOT reset by a re-queue.
  let factCheckBatchDeadline = 0;
  let factCheckBatchTimer: ReturnType<typeof setTimeout> | null = null;

  /** Token estimate — byte-identical to classify-tweets:606-609 (deliberately over-counts). */
  function estimateTokens(text: string): number {
    if (!text) return 0;
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    return Math.ceil(text.length / 3) + words;
  }
  /** The max hold classify-tweets reserves per research (classify-tweets:128-139) — dominated by
   *  the 32000-token output ceiling (≈ $0.49), so ~independent of claim length. If the backend
   *  formula changes first, the backend simply rejects any over-admit (caught as a rare 402). */
  function computeClassificationHold(mainClaim: string, sources: string[] | undefined): number {
    const GEMINI_IN = 1.50, GEMINI_OUT = 7.50, SEARCH_FEE = 0.005, MAX_SEARCHES = 1, OUTPUT_LIMIT = 32000, MARGIN = 2;
    const srcText = sources && sources.length ? sources.join("\n") : "";
    const estIn = estimateTokens(mainClaim) + estimateTokens(srcText);
    return (((estIn * GEMINI_IN + OUTPUT_LIMIT * GEMINI_OUT) / 1e6) + (SEARCH_FEE * MAX_SEARCHES)) * MARGIN;
  }

  /** Money free to commit now, in lag-invariant terms (unknown funds → optimistic). */
  function availableToSpend(): number {
    if (!fundsState) return Infinity;
    return visibleTotal(fundsState) - committedHold;
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
    const cachedTweet = tweetCache.get(classificationId);
    const sources = cachedTweet ? extractTweetUrls(cachedTweet.text) : undefined;
    const hold = computeClassificationHold(claim.rewritten ?? claimText, sources);
    factCheckWaitlist.push({ classificationId, claimText, batchId, locale, hold, attempts: 0 });
    factCheckWaitlistKeys.add(key);
    if (factCheckBatchDeadline === 0) { factCheckBatchDeadline = Date.now() + FACTCHECK_BATCH_TIMEOUT_MS; armBatchTimer(); }
    pumpWaitlist();
  }

  /** (Re)start the single timer guarding the Fact-Check All batch deadline. */
  function armBatchTimer(): void {
    if (factCheckBatchTimer) clearTimeout(factCheckBatchTimer);
    factCheckBatchTimer = setTimeout(onBatchTimeout, Math.max(0, factCheckBatchDeadline - Date.now()));
  }

  /** Batch 30s elapsed: abandon every claim STILL WAITING (in-flight ones keep going). */
  function onBatchTimeout(): void {
    factCheckBatchTimer = null;
    if (factCheckWaitlist.length > 0) {
      for (const item of factCheckWaitlist.splice(0, factCheckWaitlist.length)) abandonWaitingClaim(item);
      notifyError(ERROR_CODES.BALANCE_TOO_LOW);
    }
    maybeEndBatch();
  }

  /** Admit as many front claims as the available balance covers their holds; then reconcile batch. */
  function pumpWaitlist(): void {
    while (factCheckWaitlist.length > 0 && availableToSpend() >= factCheckWaitlist[0].hold) {
      admitFactCheckClaim(factCheckWaitlist.shift()!);
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

  /** Start one admitted Fact-Check-All classification: reserve its hold, flip it to researching,
   *  run pull-then-classify, and on completion release the hold and either finish or (on a rare
   *  backend balance-too-low) re-queue once / abandon. Mirrors the old releaseFreshResearchClaim. */
  function admitFactCheckClaim(item: WaitlistItem): void {
    const { classificationId, claimText, batchId, locale, hold } = item;
    const key = `${classificationId}:${claimText}`;
    factCheckWaitlistKeys.delete(key);

    const hit = classificationCache.get(classificationId);
    const targetClaim = hit?.classification.claims?.find(cl => cl.text === claimText);
    if (!hit || !targetClaim || !targetClaim.reclassifyOnHold) { maybeEndBatch(); return; }

    committedHold += hold;
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
          for await (const updated of refreshClaim(freshCls, claimText, researchCache, locale, tweetUrls, () => { hitBalanceError = true; })) {
            gotUpdate = true;
            mergeSingleClaimAndBroadcast(classificationId, claimText, updated, batchId);
          }
        }
      } catch (err: any) {
        console.error("[background] admitFactCheckClaim error:", err);
      } finally {
        committedHold = Math.max(0, committedHold - hold);
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
    ongoingClaimRefreshes.clear();
    claimResearchPromises.clear();
    heldReclassifications.clear();
    pendingFreshResearchClaims.clear();
    factCheckAllTweetIds.clear();
    // Reset the Fact-Check All waitlist so a logout/freeze leaves no stale holds or timer.
    factCheckWaitlist.length = 0;
    factCheckWaitlistKeys.clear();
    abandonedFactCheckKeys.clear();
    committedHold = 0;
    factCheckInFlight = 0;
    factCheckBatchDeadline = 0;
    if (factCheckBatchTimer) { clearTimeout(factCheckBatchTimer); factCheckBatchTimer = null; }
    dbHitCache.clear();
    dbFetchPromises.clear();
    dbMissHashes.clear();
    seenInDom.clear();
    domFetchResolvers.clear();
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

  // ── Stripe checkout: open the checkout tab and close it on redirect to disinfax.app ──
  /** Open Stripe checkout in a new tab and close it again once it redirects back to
   *  disinfax.app, then poll for the credit. Watching for the redirect is what lets the
   *  user land back where they started instead of on a stranded success page. */
  function openCheckoutTab(url: string) {
    Promise.resolve(browser.tabs.create({ url })).then((tab: any) => {
      const tabId = tab?.id;
      if (tabId == null) return;
      const onUpdated = (updatedTabId: number, changeInfo: any) => {
        if (updatedTabId !== tabId) return;
        const updatedUrl: string | undefined = changeInfo?.url;
        if (updatedUrl && /:\/\/(www\.)?disinfax\.app\b/i.test(updatedUrl)) {
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
  // Message entry points. One-off requests (popup) arrive on runtime.onMessage;
  // the content-script relay instead holds a long-lived "classify" port, because
  // classification results stream back over time rather than as a single reply.
  // ─────────────────────────────────────────────────────────────────────────

  // Popup ↔ background messaging (balance, messages, checkout).
  browser.runtime.onMessage.addListener((message: any, _sender: any, sendResponse: (r: any) => void) => {
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
            : message.type === 'MF_NATIVE_SYNC_ACCOUNT'
              ? { action: 'SYNC_ACCOUNT', userId: message.userId, balance: message.balance }
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
    computeActive().then(active => {
      try { port.postMessage({ type: 'MF_AUTH', signedIn: active }); } catch { /* ignore */ }
    });

    port.onMessage.addListener(message => {
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
        const { batchId, newBatchId, locale: msgLocale } = message.data;

        // Retrieve stored tweets FIRST, before clearing the batch cache,
        // otherwise batchTweets.get(batchId) returns nothing and we fall
        // back to the relay's capturedTweets (all timeline tweets).
        const tweets = batchTweets.get(batchId) ?? (message.data.tweets as MainTweet[] ?? []);

        // Clear classifications and research cache for this batch
        clearBatch(batchId);
        researchCache.clear();

        if (tweets.length === 0) {
          console.log(`[background] BATCH_REFRESH_FORCE: no tweets found for ${batchId}`);
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
          const sub = tweetSubs.get(id);
          if (sub) { sub.close(); tweetSubs.delete(id); }
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
              for await (const updated of refreshClaim(freshCls, claimText, researchCache, msgLocale ?? getUiLocale(), tweetUrls, onBalanceError)) {
                gotUpdate = true;
                mergeSingleClaimAndBroadcast(classificationId, claimText, updated, anyBatchId);
              }
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
        const entry = onHoldTweets.get(tweetId);
        if (!entry) {
          console.log(`[background] PROCESS_ON_HOLD: no on-hold tweet for ${tweetId}`);
          return;
        }
        const locale = msgLocale ?? getUiLocale();
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
                for await (const updated of refreshClaim(freshCls, claimText, researchCache, locale, tweetUrls, onBalanceError)) {
                  gotUpdate = true;
                  mergeSingleClaimAndBroadcast(classificationId, claimText, updated, anyBatchId);
                }
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
              for await (const updated of refreshClaim(freshCls, claimText, researchCache, locale, tweetUrls, onBalanceError)) {
                gotUpdate = true;
                mergeSingleClaimAndBroadcast(classificationId, claimText, updated, anyBatchId);
              }
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

        if (displayedLocale && tweet) {
          const tweetText = unheld.translatedText ?? tweet.translatedText ?? tweet.text;
          if (dbClaims) {
            // DB hit path: use cached claims for highlight localization
            gatedSpend(() => localizeHighlights(tweetId, tweet, tweetText, displayedLocale, dbClaims, unheld, locale, mergeHighlightsFor(unheld))
              .catch(e => console.error('[TRANSLATE_FACT_CHECKS] highlight error:', e)));
          } else {
            // Freshly classified: derive claims from classification for localization
            const clsDbClaims = claimsToDbClaims(unheld);
            gatedSpend(() => localizeHighlights(tweetId, tweet, tweetText, displayedLocale, clsDbClaims, unheld, locale, mergeHighlightsFor(unheld))
              .catch(e => console.error('[TRANSLATE_FACT_CHECKS] highlight error:', e)));
          }
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
