import { classify, preClassify, refreshClaim, computeTweetHash, fetchTweetByHash, upsertTweetPipeline, backgroundTranslate, backgroundTranslateClaim, backgroundHighlightRange, extractTweetUrls, TEST_LOCALE, normalizeSources } from "../utils/intelligence";
import { findExactMatch } from "../utils/textBreakup";
import { Classification, Claim, Source, sameLanguage } from "../data/Classification";
import { MainTweet } from "../data/Tweets";

let batchIdCounter = 0;
function nextBatchId(): string {
  return `batch_${++batchIdCounter}_${Date.now()}`;
}

function getUiLocale(): string {
  if (TEST_LOCALE) return TEST_LOCALE;
  try { return browser?.i18n?.getUILanguage?.() ?? 'en'; } catch { return 'en'; }
}

export default defineBackground(() => {
  console.log("Background service worker started.");

  type CacheEntry = { classification: Classification; batchIds: Set<string> };
  const classificationCache = new Map<string, CacheEntry>();
  const researchCache = new Map<string, { confidence: number, veracity: number, reasoning: string, reasoningLocale?: string; change_propensity?: number; sources?: Source[]; dbClaimText?: string; embedding?: number[]; lastClassification?: string; freshlyResearched?: boolean }>();
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

  /** Apply a per-claim transformation to the cached classification and broadcast.
   *  Used by translation merges so each caller only mutates the fields it owns. */
  function mergeAndBroadcast(
    classification: Classification,
    upd: Classification,
    mergeClaim: (existingCl: Claim, updCl: Claim) => Claim
  ) {
    upd.batchId = classification.batchId;
    const existing = classificationCache.get(classification.id);
    if (existing && existing.classification.claims && upd.claims) {
      const mergedClaims = existing.classification.claims.map((existingCl) => {
        const updCl = upd.claims!.find(
          ucl => ucl.dbClaimText === existingCl.dbClaimText
        );
        if (!updCl) return existingCl;
        return mergeClaim(existingCl, updCl);
      });
      const merged = { ...upd, claims: mergedClaims };
      cacheClassification(merged, classification.batchId);
      broadcastClassification(merged);
    } else {
      cacheClassification(upd, classification.batchId);
      broadcastClassification(upd);
    }
  }

  function mergeClaimTranslation(classification: Classification, targetDbClaimText: string) {
    return (upd: Classification) => {
      mergeAndBroadcast(classification, upd, (existingCl, updCl) => {
        if (existingCl.dbClaimText !== targetDbClaimText) return existingCl;
        const newRewritten =
          updCl.rewritten && updCl.rewritten !== updCl.text && updCl.rewritten !== existingCl.rewritten
            ? updCl.rewritten
            : existingCl.rewritten;
        return { ...existingCl, rewritten: newRewritten, sources: updCl.sources ?? existingCl.sources, claimLocale: updCl.claimLocale ?? existingCl.claimLocale };
      });
    };
  }

  function mergeReasoningTranslation(classification: Classification, targetDbClaimText: string) {
    return (upd: Classification) => {
      mergeAndBroadcast(classification, upd, (existingCl, updCl) => {
        if (existingCl.dbClaimText !== targetDbClaimText) return existingCl;
        const newNote = updCl.note && updCl.note !== existingCl.note ? updCl.note : existingCl.note;
        return { ...existingCl, note: newNote, reasoningLocale: updCl.reasoningLocale ?? existingCl.reasoningLocale, sources: updCl.sources ?? existingCl.sources };
      });
    };
  }

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
  function getClaimLocale(claimObj: any): string {
    if (claimObj && typeof claimObj === 'object') {
      const keys = Object.keys(claimObj);
      if (keys.length > 0) return keys[0];
    }
    return 'en';
  }

  /** Read the last_classification timestamp from a DB claim result, tolerating
   *  either last_classification or last_classified field names. */
  function getLastClassification(dc: any): string | undefined {
    return dc?.last_classification ?? dc?.last_classified;
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
      const s = reasoning.trim();
      if (s === '' || s === '{}') return true;
      try { return isReasoningEmpty(JSON.parse(s)); } catch { return false; }
    }
    if (typeof reasoning === 'object') {
      return Object.values(reasoning).filter(v => typeof v === 'string' && v.trim() !== '').length === 0;
    }
    return false;
  }

  /** Convert DB claims from fetchTweetByHash into a Classification for injection.
   *  Uses the UI locale for claim text and reasoning when available.
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

    function claimFromDb(dc: any): Claim {
      const v = Number(dc.veracity ?? 0);
      const claimText = extractLocaleText(dc.claim, locale) || extractClaimText(dc.claim);
      const claimLocale = (() => {
        if (dc.claim && typeof dc.claim === 'object' && !Array.isArray(dc.claim)) {
          const match = Object.entries(dc.claim as Record<string, unknown>).find(([_, val]) => val === claimText);
          if (match) return match[0];
        }
        return getClaimLocale(dc.claim);
      })();

      // Unclassified placeholder claim (stored with empty reasoning): show a
      // Disinfact button. Keep dbClaimText/locale so classifying it later UPDATES
      // this existing DB row (linked via existing_claims), never inserts a duplicate.
      if (isReasoningEmpty(dc.reasoning)) {
        let phHighlight: Record<string, [number, number]> | undefined;
        if (dc.highlight && typeof dc.highlight === 'object') {
          phHighlight = {};
          for (const [key, val] of Object.entries(dc.highlight)) {
            if (Array.isArray(val) && val.length === 2) phHighlight[key] = val as [number, number];
          }
          if (Object.keys(phHighlight).length === 0) phHighlight = undefined;
        }
        return {
          text: claimText,
          rewritten: claimText,
          verdict: "research required",
          note: null,
          confidence: undefined,
          veracity: undefined,
          reclassifyOnHold: true,
          sources: [],
          dbClaimText: extractClaimText(dc.claim),
          dbClaimLocale: getClaimLocale(dc.claim),
          highlight: phHighlight,
          claimLocale,
          reasoningLocale: dc.locale_key ?? getClaimLocale(dc.claim),
        };
      }
      const noteText = extractReasoningText(dc.reasoning, locale) || extractReasoningText(dc.reasoning, claimLocale) || null;
      const reasoningLocale = (() => {
        if (!noteText || !dc.reasoning) return dc.locale_key ?? getClaimLocale(dc.claim);
        let reasoningObj: any = dc.reasoning;
        if (typeof reasoningObj === 'string') {
          try { reasoningObj = JSON.parse(reasoningObj); } catch { return dc.locale_key ?? getClaimLocale(dc.reasoning); }
        }
        if (reasoningObj && typeof reasoningObj === 'object' && !Array.isArray(reasoningObj)) {
          const match = Object.entries(reasoningObj as Record<string, unknown>).find(([_, val]) => val === noteText);
          if (match) return match[0];
        }
        return dc.locale_key ?? getClaimLocale(dc.reasoning) ?? getClaimLocale(dc.claim);
      })();
      console.log(`[dbClaimsToClassification] locale=${locale} claimLocale=${claimLocale} reasoningLocale=${reasoningLocale} textLocale=${textLocale} raw=${JSON.stringify(dc.claim).slice(0, 80)} rewritten=${claimText.slice(0, 50)} note=${noteText ? noteText.slice(0, 50) : 'null'}`);
      // Extract highlight from locale-filtered DB result (e.g. {"en": [24, 56]})
      let highlight: Record<string, [number, number]> | undefined;
      if (dc.highlight && typeof dc.highlight === 'object') {
        highlight = {};
        for (const [key, val] of Object.entries(dc.highlight)) {
          if (Array.isArray(val) && val.length === 2) {
            highlight[key] = val as [number, number];
          }
        }
        if (Object.keys(highlight).length === 0) highlight = undefined;
      }

      const verdict = Math.abs(v) < 0.2 ? "unknown" : (v > 0 ? "true" : "false");

      // Change-propensity re-check, decided AT BUILD TIME (not asynchronously after
      // the claim is already shown). A classified claim that is "change-prone"
      // (random draw below its change_propensity) is presented on hold — a Disinfact
      // button — from the very first render, so it never flashes its old color and
      // then flips. The DB classification is cached so clicking restores it while the
      // fresh re-research streams, and dbClaimText links the update to this same row.
      const changeProp = Number(dc.change_propensity ?? 0);
      if (changeProp > 0 && Math.random() < changeProp) {
        return {
          text: claimText,
          rewritten: claimText,
          verdict: "research required",
          note: null,
          confidence: undefined,
          veracity: undefined,
          reclassifyOnHold: true,
          cachedVerdict: verdict,
          cachedNote: noteText,
          cachedConfidence: Math.abs(v),
          cachedVeracity: v,
          cachedSources: normalizeSources(dc.sources),
          sources: normalizeSources(dc.sources),
          dbClaimText: extractClaimText(dc.claim),
          dbClaimLocale: getClaimLocale(dc.claim),
          highlight,
          claimLocale,
          reasoningLocale,
        };
      }

      return {
        text: claimText,
        rewritten: claimText,
        verdict,
        note: noteText,
        confidence: Math.abs(v),
        veracity: v,
        sources: normalizeSources(dc.sources),
        dbClaimText: extractClaimText(dc.claim),
        dbClaimLocale: getClaimLocale(dc.claim),
        highlight,
        claimLocale,
        reasoningLocale,
      };
    }
    const claims = dbClaims.map(claimFromDb);
    const quoting = tweet.quoting
      ? {
          id: tweet.quoting.id,
          claims: quotedDbClaims && quotedDbClaims.length > 0 ? quotedDbClaims.map(claimFromDb) : null
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

    const tweetHash = await computeTweetHash(tweetId);
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
    await backgroundHighlightRange(
      tweetHash,
      tweetText,
      allDbClaims,
      uiLocale,
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

  /** Fire re-research for DB-hit claims whose change_propensity exceeds the random threshold.
   *  Reuses refreshClaim() which calls streamResearch(). After all done, upserts the tweet pipeline.
   *  Also localizes highlights for the displayed tweet text locale if needed.
   *  Does NOT translate claim text or reasoning — those are gated by user actions. */
  async function reResearchDbClaims(
    tweet: MainTweet,
    dbClaims: any[],
    classification: Classification,
    researchCache: Map<string, { confidence: number; veracity: number; reasoning: string; reasoningLocale?: string; change_propensity?: number; sources?: Source[]; dbClaimText?: string; embedding?: number[]; lastClassification?: string; freshlyResearched?: boolean }>,
    locale: string
  ): Promise<void> {
    // Helper: list existing locales in a locale-keyed JSONB object.
    const existingLocales = (obj: any): string[] => {
      if (!obj) return [];
      if (typeof obj === 'string') {
        try { return Object.keys(JSON.parse(obj)); } catch { return []; }
      }
      if (typeof obj === 'object') return Object.keys(obj);
      return [];
    };
    // Change-propensity re-check is now decided at build time in
    // dbClaimsToClassification (a change-prone claim is shown on hold from the very
    // first render, so it never flashes its old color then flips). Nothing to do
    // asynchronously here — an empty list keeps the loop below a no-op.
    const propense: any[] = [];

    // Pre-populate researchCache so formatVerdict works immediately (use plain string reasoning, not JSONB object)
    for (const dc of dbClaims) {
      const cacheKey = extractClaimText(dc.claim);
      if (!researchCache.has(cacheKey)) {
        const sourceLocale = dc.locale_key ?? getClaimLocale(dc.claim);
        const reasonStr = extractReasoningText(dc.reasoning, sourceLocale);
        researchCache.set(cacheKey, {
          confidence: Math.abs(Number(dc.veracity ?? 0)),
          veracity: Number(dc.veracity ?? 0),
          reasoning: reasonStr,
          reasoningLocale: sourceLocale,
          change_propensity: Number(dc.change_propensity ?? 0),
          sources: normalizeSources(dc.sources),
          dbClaimText: extractClaimText(dc.claim),
          lastClassification: getLastClassification(dc),
        });
      }
    }

    // Propagate dbClaimLocale (canonical storage locale for matching) on the
    // classification's claims and quoted claims. Leave claimLocale and reasoningLocale
    // as set by dbClaimsToClassification (they reflect the displayed text's actual
    // locales and are used for Translate buttons).
    const propagateDbClaimLocale = (claims: Claim[] | null | undefined): Claim[] | null => {
      if (!claims) return claims ?? null;
      for (const dc of dbClaims) {
        const cacheKey = extractClaimText(dc.claim);
        const dbClaimLocaleVal = getClaimLocale(dc.claim);
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

    // Check if tweet has Grok translation data
    const hasTranslation = tweet.translatedText && tweet.sourceLanguage && tweet.destinationLanguage;
    const destLang = tweet.destinationLanguage!;
    const sourceLang = tweet.sourceLanguage!;

    // Helper: compare locales by primary language subtag (en-US == en-GB).
    const sameLang = (a: string, b: string) => sameLanguage(a, b);

    // Thread 3: highlight localization for the default displayed locale (destination).
    // Additional locales are triggered by SET_DISPLAYED_LOCALE messages when the user
    // toggles X's Show original/Show translation.
    if (hasTranslation && !sameLang(destLang, sourceLang)) {
      (async () => {
        const existingHighlightLocales = new Set<string>(dbClaims.flatMap(dc => existingLocales(dc.highlight)));
        if (existingHighlightLocales.has(destLang) || Array.from(existingHighlightLocales).some(l => sameLang(l, destLang))) return;
        await localizeHighlights(tweet.id, tweet.translatedText!, destLang, dbClaims, classification, locale, mergeHighlightsFor(classification));
      })().catch(e => console.error('[reResearchDbClaims] highlight error:', e));
    }

    for (const dc of propense) {
      const claimText = extractClaimText(dc.claim);
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

  /** After a new tweet's classify() pipeline completes, link claims to the tweet.
   *  Computes character ranges from preclassification raw claims on the original
   *  tweet text and stores them in tweet_claims.highlight for subsequent loads.
   *  Falls back to translated text when available (claim may be in English). */
  async function upsertProcessedClaims(
    tweet: MainTweet,
    tweetHash: string,
    classification: Classification,
    researchCache: Map<string, { confidence: number; veracity: number; reasoning: string; reasoningLocale?: string; change_propensity?: number; sources?: Source[]; dbClaimText?: string; embedding?: number[]; lastClassification?: string; freshlyResearched?: boolean }>,
    locale: string
  ): Promise<void> {
    // If the user triggered classification early (Fact-Check All, or clicked every
    // claim's Disinfact button before fetch-claim finished), wait for those
    // researches to complete so we persist real values instead of placeholders that
    // would clobber them. When nothing is in flight this resolves immediately.
    await awaitTweetClaimResearch(tweet.id);
    // Re-read the freshest cached classification so any values updated while we
    // waited (or during classification) are reflected in what we upsert.
    classification = classificationCache.get(tweet.id)?.classification ?? classification;

    const tweetText = tweet.text;
    const translatedText = tweet.translatedText;
    const newClaims: any[] = [];
    const existingClaims: { claim: string; highlight_range?: number[]; highlight_locale?: string; source_locale?: string }[] = [];
    const seen = new Set<string>();
    // Locale used to key claim/reasoning in the DB. This is the UI locale because
    // the claim text we store is the rewritten/UI-locale version.
    const dbClaimLocale = locale;

    const process = (claims: Claim[] | null | undefined) => {
      if (!claims) return;
      for (const c of claims) {
        const key = c.dbClaimText ?? c.text;
        if (seen.has(key)) continue;
        seen.add(key);

        // Always use newClaims — the RPC handles dedup by claim text+locale.
        // existingClaims doesn't work because the DB stores claims as locale-keyed
        // JSONB and the RPC can't match raw text against it.
        // Compute highlight range: try claim.text on the currently-displayed text first,
        // then fall back to the other available text. The highlight locale must match the
        // locale of the text the range was found in — never the UI locale.
        const hasTranslation = !!translatedText && !!tweet.destinationLanguage;
        const displayedText = classification.textLocale === tweet.destinationLanguage && translatedText
          ? translatedText
          : tweetText;
        const displayedLocale = classification.textLocale ?? (hasTranslation ? tweet.destinationLanguage : tweet.sourceLanguage) ?? locale;
        let range = computeHighlightRange(displayedText, c.text);
        let highlightLocale = displayedLocale;
        if (!range && translatedText) {
          // Try the other text (translation if original was searched, or vice versa)
          const otherText = displayedText === translatedText ? tweetText : translatedText;
          const otherLocale = displayedText === translatedText ? tweet.sourceLanguage : tweet.destinationLanguage;
          range = computeHighlightRange(otherText, c.text);
          highlightLocale = otherLocale ?? displayedLocale;
        }
        if (!range && translatedText && c.rewritten && c.rewritten !== c.text) {
          const otherText = displayedText === translatedText ? tweetText : translatedText;
          const otherLocale = displayedText === translatedText ? tweet.sourceLanguage : tweet.destinationLanguage;
          range = computeHighlightRange(otherText, c.rewritten);
          highlightLocale = otherLocale ?? displayedLocale;
        }
        if (!range) {
          console.warn(`[upsertProcessedClaims] Could not compute highlight range for "${c.text.slice(0, 40)}..."`);
        }
        const cached = researchCache.get(c.text);
        if (c.dbClaimText) {
          // DB-matched claim: just link to the existing canonical claim. Sending the
          // preclassified/rewritten text in newClaims would create a duplicate row
          // because the worker can't match English text against a French canonical claim.
          // We also pass the claim's storage locale so the worker can match the right
          // locale-keyed JSONB key (e.g. fr vs en-US).
          existingClaims.push({
            claim: c.dbClaimText,
            highlight_range: range ?? undefined,
            highlight_locale: highlightLocale,
            source_locale: c.dbClaimLocale ?? c.claimLocale,
          });
        } else {
          // Fresh claim (not in DB). Store under the rewritten claim text + UI locale —
          // the canonical key so a later classification UPDATES this row rather than
          // duplicating it.
          const isClassified = !c.reclassifyOnHold && !!c.note && c.confidence !== undefined && c.veracity !== undefined;
          if (isClassified) {
            // Already classified — persist the real values.
            newClaims.push({
              claim: c.rewritten ?? c.text,
              highlight_range: range,
              highlight_locale: highlightLocale,
              embedding: cached?.embedding,
              probability: cached?.confidence ?? c.confidence ?? 0,
              veracity: cached?.veracity ?? c.veracity ?? 0,
              change_propensity: cached?.change_propensity ?? 0.5,
              reasoning: cached?.reasoning ? { [locale]: cached.reasoning } : {},
              sources: sourcesToDictionary(cached?.sources ?? []),
            });
          } else {
            // Unclassified placeholder: no reasoning, veracity 0, confidence 0.5,
            // change_propensity 0. Keep the embedding so it is matchable by fetch-claim.
            // Classification (Disinfact click / Fact-Check All) updates this row later.
            newClaims.push({
              claim: c.rewritten ?? c.text,
              highlight_range: range,
              highlight_locale: highlightLocale,
              embedding: cached?.embedding,
              probability: 0.5,
              veracity: 0,
              change_propensity: 0,
              reasoning: {},
              sources: {},
            });
          }
        }
      }
    };

    process(classification.claims);
    // Quoted-tweet claims are handled by the quoted tweet's own pipeline/DB entry.
    // Matching them against the main tweet text here produces bogus highlight ranges
    // and stores them under the wrong tweet hash, so skip them.

    // Update the cached classification with the initial highlight ranges so
    // SET_DISPLAYED_LOCALE can tell which locales are already localized.
    // Include existing claims as well as fresh ones — both can carry highlight ranges.
    const claimHighlightMap = new Map<string, { locale: string; range: [number, number] }>();
    for (const n of newClaims) {
      if (n.highlight_range && n.highlight_locale) {
        claimHighlightMap.set(n.claim, { locale: n.highlight_locale, range: n.highlight_range });
      }
    }
    for (const e of existingClaims) {
      if (e.highlight_range && e.highlight_locale) {
        claimHighlightMap.set(e.claim, { locale: e.highlight_locale, range: e.highlight_range as [number, number] });
      }
    }
    if (claimHighlightMap.size > 0 && classification.claims) {
      const updatedClaims = classification.claims.map(cl => {
        const key = cl.dbClaimText ?? cl.rewritten ?? cl.text;
        const item = claimHighlightMap.get(key);
        if (!item) return cl;
        return { ...cl, highlight: { ...cl.highlight, [item.locale]: item.range } };
      });
      const updatedClassification = { ...classification, claims: updatedClaims };
      cacheClassification(updatedClassification, classification.batchId);
      broadcastClassification(updatedClassification);
    }

    // Record the classification timestamp right before the upsert so later reasoning
    // translations use a timestamp that matches (or immediately precedes) DB's last_classification.
    const classificationTimestamp = new Date().toISOString();
    for (const c of classification.claims ?? []) {
      const cached = researchCache.get(c.text);
      if (cached) {
        researchCache.set(c.text, { ...cached, lastClassification: classificationTimestamp });
      }
    }

    // Only register the tweet + claim links when there is at least one researched
    // claim to link. If every claim was skipped (all still on hold / unresearched),
    // registering an empty tweet would make it a "DB hit with empty claims" next
    // session, hiding its fact-checks. Leave it unregistered so it re-classifies.
    if (newClaims.length > 0 || existingClaims.length > 0) {
      await upsertTweetPipeline(tweetHash, newClaims, existingClaims, dbClaimLocale);
    } else {
      console.log(`[upsertProcessedClaims] ${tweet.id}: no researched claims to link, skipping tweet upsert`);
    }
  }

  function broadcastClassification(classification: Classification) {
    const claimSummary = classification.claims?.map(c => {
      const rw = (c.rewritten ?? c.text).slice(0, 20);
      const noteLang = c.note ? c.note.slice(0, 15) : 'none';
      const hlKeys = c.highlight ? Object.keys(c.highlight).join(',') : 'none';
      return `${rw}...=${c.confidence ?? '?'}(note:${noteLang}...,hl:${hlKeys})`;
    }).join(' | ') || 'none';
    console.log(`[background] broadcasting ${classification.id} with ${activePorts.size} active port(s), claims: ${claimSummary}`);

    // If Fact-Check All was clicked for this tweet, present any claim still showing
    // a Disinfact button as already "Fact-Checking" (refreshing) in the message we
    // send to the UI, so it never flashes a Disinfact badge in the brief window
    // before the auto-release below actually flips it. The cache and the
    // auto-release loop still operate on the real (reclassifyOnHold) state.
    let outgoing = classification;
    if (factCheckAllTweetIds.has(classification.id)
        && classification.claims?.some(cl => cl.reclassifyOnHold)) {
      outgoing = {
        ...classification,
        claims: classification.claims.map(cl =>
          cl.reclassifyOnHold
            ? { ...cl, reclassifyOnHold: false, refreshing: true, note: null }
            : cl
        ),
      };
    }
    for (const p of activePorts) {
      try { p.postMessage({ type: "CLASSIFICATION", data: outgoing }); } catch {}
    }
    // Track claims still showing a Disinfact button (reclassifyOnHold) — awaiting
    // user action. If the user clicked "Fact-Check All" for this tweet, auto-release
    // EVERY such claim (including change-prone DB claims that carry cached values),
    // not just fresh no-DB-match ones; otherwise just mark them pending.
    for (const cl of classification.claims ?? []) {
      if (cl.reclassifyOnHold) {
        const key = `${classification.id}:${cl.text}`;
        if (factCheckAllTweetIds.has(classification.id)) {
          console.log(`[background] auto-releasing fresh research for ${key} (Fact-Check All)`);
          pendingFreshResearchClaims.delete(key);
          // Trigger the same reclassify flow in the background without requiring a click.
          releaseFreshResearchClaim(classification.id, cl.text, classification.batchId, localeFromClassification(classification));
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
  function localeFromClassification(_classification: Classification): string {
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

  /** Start fresh research for a single claim that was on hold due to no DB match.
   *  Mirrors the RECLASSIFY_ON_HOLD_CLICK flow but is driven by Fact-Check All. */
  function releaseFreshResearchClaim(
    classificationId: string,
    claimText: string,
    batchId: string,
    locale: string
  ) {
    const refreshKey = `${classificationId}:${claimText}`;
    // Idempotency: never re-run (or re-broadcast) for a claim that is already
    // being researched. Repeated broadcasts from concurrent generators would
    // otherwise call this again and again, causing a release cascade.
    if (ongoingClaimRefreshes.has(refreshKey)) return;

    const hit = classificationCache.get(classificationId);
    if (!hit) return;
    const classification = hit.classification;

    // Only release a claim that is genuinely still on hold in the authoritative
    // cache. A stale snapshot may still show it on hold after it was released.
    const targetClaim = classification.claims?.find(cl => cl.text === claimText);
    if (!targetClaim || !targetClaim.reclassifyOnHold) return;

    ongoingClaimRefreshes.add(refreshKey);

    const updatedClaims = classification.claims?.map(cl => {
      if (cl.text === claimText && cl.reclassifyOnHold) {
        return {
          ...cl,
          reclassifyOnHold: false,
          refreshing: true,
          verdict: cl.cachedVerdict ?? cl.verdict,
          // Keep the cached reasoning visible while re-researching (replaced once the
          // new reasoning streams); null when there was no prior reasoning.
          note: cl.cachedNote ?? cl.note,
          confidence: cl.cachedConfidence ?? cl.confidence,
          veracity: cl.cachedVeracity ?? cl.veracity,
          sources: cl.cachedSources ?? cl.sources,
        };
      }
      return cl;
    }) ?? null;

    const anyOnHold = updatedClaims?.some(cl => cl.reclassifyOnHold) ?? false;
    const restored: Classification = {
      ...classification,
      claims: updatedClaims,
      reclassifyOnHold: anyOnHold || undefined,
    };
    restored.batchId = batchId;
    cacheClassification(restored, batchId);
    broadcastClassification(restored);

    const cachedTweet = tweetCache.get(classificationId);
    const tweetUrls = cachedTweet ? extractTweetUrls(cachedTweet.text) : undefined;
    console.log(`[background] releaseFreshResearchClaim: starting fresh research for "${claimText.slice(0, 40)}..."`);
    const researchPromise = (async () => {
      try {
        for await (const updated of refreshClaim(restored, claimText, researchCache, locale, tweetUrls)) {
          mergeSingleClaimAndBroadcast(classificationId, claimText, updated, batchId);
        }
      } catch (err: any) {
        console.error("[background] releaseFreshResearchClaim error:", err);
      } finally {
        ongoingClaimRefreshes.delete(refreshKey);
      }
    })();
    trackClaimResearch(refreshKey, researchPromise);
  }

  function safePostToPort(port: any, msg: any) {
    try { port.postMessage(msg); } catch {}
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

  function processFullBatch(port: any, tweets: MainTweet[], batchId: string, keepAlive: NodeJS.Timeout, localeOverride?: string | null, xhrBatchIndex?: number) {
    (async () => {
      try {
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
            if (shouldDeferDom) {
              await waitForDom(tweet.id);
            }
            const hash = await computeTweetHash(tweet.id);
            let dbResult: any;
            if (dbMissHashes.has(hash)) {
              dbResult = { success: false };
            } else {
              dbResult = await fetchTweetByHash(hash, locale);
              if (!dbResult?.success) dbMissHashes.add(hash);
            }
            let quotedHash: string | undefined;
            let quotedDbResult: any;
            if (tweet.quoting) {
              quotedHash = await computeTweetHash(tweet.quoting.id);
              if (dbMissHashes.has(quotedHash)) {
                quotedDbResult = { success: false };
              } else {
                quotedDbResult = await fetchTweetByHash(quotedHash, locale);
                if (!quotedDbResult?.success) dbMissHashes.add(quotedHash);
              }
            }
            return { hash, dbResult, quotedHash, quotedDbResult };
          })();

          dbFetchPromises.set(tweet.id, promise);
          const result = await promise;
          return { tweet, ...result };
        }

        const hashResults: HashResult[] = await Promise.all(tweets.map(fetchForTweet));
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
          const highlightsMissing = displayedLocale && allClaimsForHighlightCheck.some(cl => !cl.highlight?.[displayedLocale]);
          const differentLanguages = hasTranslation && claimStorageLocale && displayedLocale &&
            !sameLanguage(displayedLocale, claimStorageLocale);

          if (differentLanguages && highlightsMissing) {
            classification.translateFactChecksOnHold = true;
            console.log(`[background] DB hit ${classification.id}: translateFactChecksOnHold (displayed=${displayedLocale}, stored=${claimStorageLocale})`);
          }

          safePostToPort(port, { type: "CLASSIFICATION", data: classification });

          // Pre-populate researchCache from the DB hit so translation callbacks can find
          // last_classification/reasoningLocale even when re-research is skipped this session.
          const allDbClaimsForCache = [...hit.dbResult.claims, ...(quotedClaims ?? [])];
          for (const dc of allDbClaimsForCache) {
            const cacheKey = extractClaimText(dc.claim);
            const claimLocale = getClaimLocale(dc.claim);
            const reasonStr = extractReasoningText(dc.reasoning, claimLocale);
            const existing = researchCache.get(cacheKey);
            researchCache.set(cacheKey, {
              confidence: Math.abs(Number(dc.veracity ?? 0)),
              veracity: Number(dc.veracity ?? 0),
              reasoning: reasonStr,
              reasoningLocale: claimLocale,
              change_propensity: Number(dc.change_propensity ?? 0),
              sources: normalizeSources(dc.sources),
              dbClaimText: cacheKey,
              lastClassification: getLastClassification(dc) ?? existing?.lastClassification,
            });
          }

          (async () => {
            try {
              // When translation is on hold, skip localization + re-research entirely.
              if (classification.translateFactChecksOnHold) {
                console.log(`[background] DB hit ${classification.id}: translateFactChecksOnHold, skipping localization + re-research`);
                return;
              }

              // If the currently-displayed text locale's highlights are missing (e.g. the user
              // changed X's UI language to Chinese, so the tweet is now shown in Chinese but the
              // DB only has English/Spanish highlights), localize them on demand.
              const displayedLocale = classification.textLocale ?? hit.tweet.sourceLanguage;
              const needsMainLocalization = displayedLocale && (classification.claims ?? []).some(cl => !cl.highlight?.[displayedLocale]);
              if (needsMainLocalization) {
                const tweetText = classification.translatedText ?? hit.tweet.text;
                console.log(`[background] DB hit ${classification.id}: missing ${displayedLocale} highlights, localizing on load`);
                await localizeHighlights(classification.id, tweetText, displayedLocale, hit.dbResult.claims, classification, locale, mergeHighlightsFor(classification));
              }

              // Same for the quoted tweet, if it has DB claims and is missing highlights.
              const quotedText = hit.tweet.quoting?.text;
              const quotedClaims = classification.quoting?.claims;
              if (quotedText && quotedClaims && quotedClaims.length > 0 && displayedLocale) {
                const needsQuotedLocalization = quotedClaims.some(cl => !cl.highlight?.[displayedLocale]);
                if (needsQuotedLocalization) {
                  console.log(`[background] DB hit ${classification.id}: missing ${displayedLocale} highlights for quoted tweet, localizing on load`);
                  await localizeHighlights(classification.quoting!.id, quotedText, displayedLocale, hit.quotedDbResult.claims, classification, locale, mergeHighlightsFor(classification));
                }
              }

              // Only re-research once per tweet per session. Repeated timeline responses
              // should not keep translating/re-localizing and writing to the DB.
              if (!reResearchedTweetIds.has(classification.id)) {
                reResearchedTweetIds.add(classification.id);
                await reResearchDbClaims(hit.tweet, hit.dbResult.claims, classification, researchCache, locale);
              } else {
                console.log(`[background] DB hit ${classification.id}: re-research already done this session, skipping`);
              }
            } catch (err) {
              console.error("[background] reResearchDbClaims error:", err);
            }
          })();
        }

        // Step 3b: Process DB hits with empty claims — inject empty classification, upsert tweet hash
        const dbEmpty = dbMissResults.filter(r => r.dbResult?.success);
        for (const empty of dbEmpty) {
          const classification = { id: empty.tweet.id, batchId, claims: null, quoting: null };
          attachTranslatedLocale(classification, empty.tweet);
          cacheClassification(classification, batchId);
          safePostToPort(port, { type: "CLASSIFICATION", data: classification });

          (async () => {
            await upsertTweetPipeline(empty.hash, [], [] as { claim: string; highlight_range?: number[] }[]);
          })();
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

        for (const c of cached)
          safePostToPort(port, { type: "CLASSIFICATION", data: c });

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

        // Step 5: Preclassify + classify for DB misses
        // Each tweet is self-contained (linked tweets are nested as context),
        // so preclassify each tweet individually.
        function tweetForDisplay(t: MainTweet): MainTweet {
          const hasTranslation = !!t.translatedText && !!t.destinationLanguage;
          const base = {
            ...t,
            text: hasTranslation ? t.translatedText! : t.text,
            quoting: t.quoting ? tweetForDisplay(t.quoting as MainTweet) : null,
          };
          return base as MainTweet;
        }

        for (const uncachedTweet of uncached) {
          let latestClassification: Classification | null = null;
          for await (const classification of preClassify([tweetForDisplay(uncachedTweet)], locale)) {
            classification.batchId = batchId;
            // Attach translatedLocale/textLocale from the ORIGINAL tweet (not display text)
            const origTweet = tweetById.get(classification.id);
            if (origTweet) attachTranslatedLocale(classification, origTweet);
            cacheClassification(classification, batchId);
            safePostToPort(port, { type: "CLASSIFICATION", data: classification });
            latestClassification = classification;
          }

          if (!latestClassification) continue;
          const classification = latestClassification;
          const hashResult = hashResults.find(r => r.tweet.id === classification.id);

          // Immediately broadcast "Researching..." so the UI doesn't show
          // a misleading preclassification verdict while the pipeline runs.
          const researchingCls = markClaimsResearching(classification);
          researchingCls.batchId = batchId;
          cacheClassification(researchingCls, batchId);
          broadcastClassification(researchingCls);

          // Extract user-shared URLs from the tweet (and its quoted tweet) for the classify worker
          let tweetUrls: string[] | undefined;
          if (hashResult) {
            tweetUrls = extractTweetUrls(hashResult.tweet.text);
            if (hashResult.tweet.quoting?.text) {
              tweetUrls.push(...extractTweetUrls(hashResult.tweet.quoting.text));
            }
            if (tweetUrls.length === 0) tweetUrls = undefined;
          }

          console.log(`[background] starting classification for ${classification.id} after preclassification (${classification.claims?.length ?? 0} claim(s))`);

          (async () => {
            try {
              let latestClassification = classification;
              for await (const updated of classify(classification, researchCache, locale, (upd) => {
                upd.batchId = batchId;
                cacheClassification(upd, batchId);
                broadcastClassification(upd);
              }, tweetUrls, (claimText) => {
                pendingFreshResearchClaims.add(`${classification.id}:${claimText}`);
              })) {
                updated.batchId = batchId;
                cacheClassification(updated, batchId);
                broadcastClassification(updated);
                latestClassification = updated;
              }

              // Mark as re-researched so future DB hits don't re-run reResearchDbClaims.
              // This tweet was just fully classified — double-processing wastes a worker call.
              reResearchedTweetIds.add(classification.id);

              // Step 6: Upsert tweet + claims in parallel — use latest classify output
              if (hashResult) {
                upsertProcessedClaims(hashResult.tweet, hashResult.hash, latestClassification, researchCache, locale);
              }

              // Set claimLocale/reasoningLocale on cached classification so
              // SET_DISPLAYED_LOCALE can detect language mismatches without
              // waiting for a DB re-fetch to populate these fields.
              const clsAfterUpsert = classificationCache.get(classification.id)?.classification;
              if (clsAfterUpsert?.claims) {
                const updatedClaims = clsAfterUpsert.claims.map(cl => ({
                  ...cl,
                  claimLocale: cl.claimLocale ?? locale,
                  reasoningLocale: cl.reasoningLocale ?? locale,
                }));
                const clsWithLocales = { ...clsAfterUpsert, claims: updatedClaims };
                cacheClassification(clsWithLocales, batchId);
              }
            } catch (err) {
              console.error("[background] classify pipeline error:", err);
            }
          })();
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

  browser.runtime.onConnect.addListener(port => {
    if (port.name !== "classify") return;
    activePorts.add(port);
    port.onDisconnect.addListener(() => activePorts.delete(port));

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
        batchTweets.set(useBatchId, tweets);

        const keepAlive = setInterval(() => {}, 20000);
        const locale = msgLocale ?? getUiLocale();

        // Cache incoming tweets so SET_DISPLAYED_LOCALE can look up original/translated text.
        for (const t of tweets) tweetCache.set(t.id, t);

        // Quick lookup from tweet id to tweet
        const tweetById = new Map<string, MainTweet>();
        for (const t of tweets) tweetById.set(t.id, t);

        (async () => {
          try {
            // Helper: use translated text for preclassification when available
            function tweetForDisplay(t: MainTweet): MainTweet {
              const hasTranslation = !!t.translatedText && !!t.destinationLanguage;
              return {
                ...t,
                text: hasTranslation ? t.translatedText! : t.text,
                quoting: t.quoting ? tweetForDisplay(t.quoting as MainTweet) : null,
              } as MainTweet;
            }

            // Step 1: Preclassify each tweet individually and start classification
            // as soon as each tweet's preclassification completes.
            for (const bTweet of tweets) {
              let latestClassification: Classification | null = null;
              for await (const classification of preClassify([tweetForDisplay(bTweet)], locale)) {
                classification.batchId = useBatchId;
                const origTweet = tweetById.get(classification.id);
                if (origTweet) attachTranslatedLocale(classification, origTweet);
                cacheClassification(classification, useBatchId);
                safePostToPort(port, { type: "CLASSIFICATION", data: classification });
                latestClassification = classification;
              }

              if (!latestClassification) continue;
              const classification = latestClassification;

              const researchingCls = markClaimsResearching(classification);
              researchingCls.batchId = useBatchId;
              cacheClassification(researchingCls, useBatchId);
              broadcastClassification(researchingCls);

              // Extract user-shared URLs from the tweet
              const tweet = tweetById.get(classification.id);
              let tweetUrls: string[] | undefined;
              if (tweet) {
                tweetUrls = extractTweetUrls(tweet.text);
                if (tweet.quoting?.text) {
                  tweetUrls.push(...extractTweetUrls(tweet.quoting.text));
                }
                if (tweetUrls.length === 0) tweetUrls = undefined;
              }

              console.log(`[background] BATCH_REFRESH_FORCE starting classification for ${classification.id} after preclassification (${classification.claims?.length ?? 0} claim(s))`);

              (async () => {
                try {
                  let latestClassification = classification;
                  for await (const updated of classify(classification, researchCache, locale, (upd) => {
                    upd.batchId = useBatchId;
                    cacheClassification(upd, useBatchId);
                    broadcastClassification(upd);
                  }, tweetUrls, (claimText) => {
                    pendingFreshResearchClaims.add(`${classification.id}:${claimText}`);
                  })) {
                    updated.batchId = useBatchId;
                    cacheClassification(updated, useBatchId);
                    broadcastClassification(updated);
                    latestClassification = updated;
                  }

                  reResearchedTweetIds.add(classification.id);

                  // Upsert tweet + claims
                  if (tweet) {
                    const hash = await computeTweetHash(tweet.id);
                    upsertProcessedClaims(tweet, hash, latestClassification, researchCache, locale);
                  }
                } catch (err) {
                  console.error("[background] BATCH_REFRESH_FORCE classify error:", err);
                }
              })();
            }

            safePostToPort(port, { type: "DONE" });
          } catch (err: any) {
            console.error("[background] BATCH_REFRESH_FORCE error:", err);
            safePostToPort(port, { type: "ERROR", error: err.message });
          } finally {
            clearInterval(keepAlive);
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
        // (verdict/confidence/veracity) so the user still sees "True"/"False", but
        // clear the reasoning and set the refreshing flag so spinners appear.
        const fcClassification = {
          ...classification,
          claims: (classification.claims ?? []).map(cl =>
            cl.text === claimText
              ? { ...cl, note: null, refreshing: true }
              : cl
          ) ?? null,
          quoting: classification.quoting
            ? {
                ...classification.quoting,
                claims: (classification.quoting.claims ?? []).map(cl =>
                  cl.text === claimText
                    ? { ...cl, note: null, refreshing: true }
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

        (async () => {
          try {
            for await (const updated of refreshClaim(classification, claimText, researchCache, msgLocale ?? getUiLocale(), tweetUrls)) {
              mergeSingleClaimAndBroadcast(classificationId, claimText, updated, anyBatchId);
            }
          } catch (err: any) {
            console.error("[background] REFRESH_CLAIM error:", err);
          } finally {
            ongoingClaimRefreshes.delete(refreshKey);
          }
        })();
      }

      if (message.type === "PROCESS_ON_HOLD") {
        const { tweetId, locale: msgLocale } = message.data;
        const entry = onHoldTweets.get(tweetId);
        if (!entry) {
          console.log(`[background] PROCESS_ON_HOLD: no on-hold tweet for ${tweetId}`);
          return;
        }
        const locale = msgLocale ?? getUiLocale();

        // Process the single on-hold tweet individually.
        console.log(`[background] PROCESS_ON_HOLD: starting pipeline for tweet ${entry.tweet.id}`);

        // Keep service worker alive during long-running pipeline (like processFullBatch)
        const keepAlive = setInterval(() => {}, 20000);

        // Mirror of tweetForDisplay from processFullBatch
        function tweetForDisplay(t: MainTweet): MainTweet {
          const hasTranslation = !!t.translatedText && !!t.destinationLanguage;
          return {
            ...t,
            text: hasTranslation ? t.translatedText! : t.text,
            quoting: t.quoting ? tweetForDisplay(t.quoting as MainTweet) : null,
          } as MainTweet;
        }

        (async () => {
          try {
            // Step 1: Preclassify the single tweet
            const batchId = nextBatchId();
            let latestClassification: Classification | null = null;

            for await (const classification of preClassify([tweetForDisplay(entry.tweet)], locale)) {
              classification.batchId = batchId;
              attachTranslatedLocale(classification, entry.tweet);
              cacheClassification(classification, batchId);
              latestClassification = classification;
              broadcastClassification(classification);
            }

            if (!latestClassification) {
              onHoldTweets.delete(entry.tweet.id);
              clearInterval(keepAlive);
              return;
            }

            // If preclassification ultimately failed (e.g. worker 504 after retries),
            // the final yield may have zero claims. Broadcast the empty classification
            // so the UI can remove the Fact-Check All button (condition 1), but leave
            // the tweet in onHoldTweets so the user can retry by clicking Disinfact again.
            if (!latestClassification.claims || latestClassification.claims.length === 0) {
              console.error(`[background] PROCESS_ON_HOLD: preclassification produced no claims for ${entry.tweet.id} after retries; broadcasting empty and leaving on hold`);
              latestClassification.onHold = false;
              broadcastClassification(latestClassification);
              clearInterval(keepAlive);
              return;
            }

            const classification = latestClassification;

            // Step 2: Mark as "Researching..." then classify
            const researchingCls = markClaimsResearching(classification);
            researchingCls.batchId = batchId;
            cacheClassification(researchingCls, batchId);
            broadcastClassification(researchingCls);

            const tweet = entry.tweet;
            const hash = entry.hash;

            // Extract user-shared URLs from the tweet (and its quoted tweet)
            let tweetUrls: string[] | undefined;
            if (tweet) {
              tweetUrls = extractTweetUrls(tweet.text);
              if (tweet.quoting?.text) {
                tweetUrls.push(...extractTweetUrls(tweet.quoting.text));
              }
              if (tweetUrls.length === 0) tweetUrls = undefined;
            }

            console.log(`[background] PROCESS_ON_HOLD starting classification for ${classification.id} after preclassification (${classification.claims?.length ?? 0} claim(s))`);

            (async () => {
              try {
                let latestClassification = classification;
                for await (const updated of classify(classification, researchCache, locale, (upd) => {
                  upd.batchId = batchId;
                  cacheClassification(upd, batchId);
                  broadcastClassification(upd);
                }, tweetUrls, (claimText) => {
                  pendingFreshResearchClaims.add(`${classification.id}:${claimText}`);
                })) {
                  updated.batchId = batchId;
                  cacheClassification(updated, batchId);
                  broadcastClassification(updated);
                  latestClassification = updated;
                }

                if (tweet && hash) {
                  upsertProcessedClaims(tweet, hash, latestClassification, researchCache, locale)
                    .catch(e => console.error("[background] PROCESS_ON_HOLD upsert error:", e));
                }
                // Also guard against reResearchDbClaims when this tweet shows up as a DB hit
                reResearchedTweetIds.add(classification.id);

                // Set claimLocale/reasoningLocale so SET_DISPLAYED_LOCALE
                // can detect language mismatches without a DB re-fetch.
                const clsAfter = classificationCache.get(classification.id)?.classification;
                if (clsAfter?.claims) {
                  const updatedClaims = clsAfter.claims.map(cl => ({
                    ...cl,
                    claimLocale: cl.claimLocale ?? locale,
                    reasoningLocale: cl.reasoningLocale ?? locale,
                  }));
                  cacheClassification({ ...clsAfter, claims: updatedClaims }, batchId);
                }
              } catch (err) {
                console.error("[background] PROCESS_ON_HOLD classify error:", err);
              }
            })();

            // Remove processed tweet from onHoldTweets
            onHoldTweets.delete(entry.tweet.id);
          } catch (err: any) {
            console.error("[background] PROCESS_ON_HOLD pipeline error:", err);
          } finally {
            clearInterval(keepAlive);
          }
        })();
        return;
      }

      if (message.type === "FACT_CHECK_ALL") {
        const { tweetId, locale: msgLocale } = message.data;
        factCheckAllTweetIds.add(tweetId);
        console.log(`[background] FACT_CHECK_ALL for ${tweetId}`);

        // Release every claim still showing a Disinfact button now — including
        // change-prone DB claims that carry cached values, not just fresh
        // no-DB-match ones.
        const hit = classificationCache.get(tweetId);
        if (hit) {
          const classification = hit.classification;
          const batchId = hit.batchIds.values().next().value ?? '';
          const locale = msgLocale ?? getUiLocale();
          for (const cl of classification.claims ?? []) {
            if (cl.reclassifyOnHold) {
              releaseFreshResearchClaim(tweetId, cl.text, batchId, locale);
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
          const pipelineResearchPromise = (async () => {
            try {
              for await (const updated of refreshClaim(pipelineRestored, claimText, researchCache, locale, tweetUrls)) {
                mergeSingleClaimAndBroadcast(classificationId, claimText, updated, anyBatchId);
              }
            } catch (err: any) {
              console.error("[background] RECLASSIFY_ON_HOLD_CLICK pipeline refresh error:", err);
            } finally {
              ongoingClaimRefreshes.delete(refreshKey);
            }
          })();
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
        const reclassifyResearchPromise = (async () => {
          try {
            for await (const updated of refreshClaim(restored, claimText, researchCache, locale, tweetUrls)) {
              mergeSingleClaimAndBroadcast(classificationId, claimText, updated, anyBatchId);
            }
          } catch (err: any) {
            console.error("[background] RECLASSIFY_ON_HOLD_CLICK refresh error:", err);
          } finally {
            ongoingClaimRefreshes.delete(refreshKey);
          }
        })();
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
            localizeHighlights(tweetId, tweetText, displayedLocale, dbClaims, unheld, locale, mergeHighlightsFor(unheld))
              .catch(e => console.error('[TRANSLATE_FACT_CHECKS] highlight error:', e));
          } else {
            // Freshly classified: derive claims from classification for localization
            const clsDbClaims = claimsToDbClaims(unheld);
            localizeHighlights(tweetId, tweetText, displayedLocale, clsDbClaims, unheld, locale, mergeHighlightsFor(unheld))
              .catch(e => console.error('[TRANSLATE_FACT_CHECKS] highlight error:', e));
          }
        }

        // Also fire re-research + translation threads if we have DB claims
        reResearchedTweetIds.add(tweetId);
        if (dbEntry && dbClaims) {
          // Re-research + highlight localization only; translation is handled explicitly below.
          reResearchDbClaims(dbEntry.tweet, dbClaims, unheld, researchCache, locale)
            .catch(e => console.error('[TRANSLATE_FACT_CHECKS] reResearch error:', e));

          // The top-of-tweet "Translate Fact-Checks" button is the one allowed
          // auto-translation path: translate claim and/or reasoning if they are not
          // already in the extension's language.
          const listLocales = (obj: any): string[] => {
            if (!obj) return [];
            if (typeof obj === 'string') {
              try { return Object.keys(JSON.parse(obj)); } catch { return []; }
            }
            if (typeof obj === 'object') return Object.keys(obj);
            return [];
          };
          for (const dc of dbClaims) {
            const claimText = extractClaimText(dc.claim);
            const claimLocale = getClaimLocale(dc.claim);
            const sourceLocale = claimLocale;
            const claimLocales = listLocales(dc.claim);
            const reasoningLocales = listLocales(dc.reasoning);
            const reasonStr = extractReasoningText(dc.reasoning, sourceLocale);

            if (!claimLocales.some((l: string) => sameLanguage(l, locale))) {
              backgroundTranslateClaim(claimText, claimText, claimLocale, locale, unheld, researchCache, mergeClaimTranslation(unheld, claimText))
                .catch(e => console.error('[TRANSLATE_FACT_CHECKS] claim translation error:', e));
            }

            if (reasonStr && !reasoningLocales.some((l: string) => sameLanguage(l, locale)) && !sameLanguage(sourceLocale, locale)) {
              backgroundTranslate(claimText, claimText, reasonStr, sourceLocale, locale, researchCache, unheld, mergeReasoningTranslation(unheld, claimText))
                .catch(e => console.error('[TRANSLATE_FACT_CHECKS] reasoning translation error:', e));
            }
          }
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
          const dbClaim = dbEntry?.dbClaims.find(dc => extractClaimText(dc.claim) === cacheKey);
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
          backgroundTranslate(
            cacheKey, cacheKey, claim.note,
            claim.reasoningLocale, locale, researchCache, classification,
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
          ).catch(e => console.error('[TRANSLATE_CLAIM] reasoning translation error:', e));
        } else if (translateWhat === "claim" && claim.claimLocale && claim.rewritten) {
          // Ignore the request if the claim is already in the same language as the UI
          if (sameLanguage(claim.claimLocale, locale)) {
            console.log(`[background] TRANSLATE_CLAIM: skipping claim translation, ${claim.claimLocale} and ${locale} share a language`);
            return;
          }
          const canonicalClaimText = claim.dbClaimText ?? claimText;
          console.log(`[background] TRANSLATE_CLAIM: translating claim for "${claimText.slice(0, 40)}..." from ${claim.claimLocale} to ${locale}, dbClaimText=${claim.dbClaimText}, canonical=${canonicalClaimText.slice(0, 40)}`);
          const dbEntry = dbHitCache.get(classificationId);
          const dbClaim = dbEntry?.dbClaims.find(dc => extractClaimText(dc.claim) === canonicalClaimText);
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
          backgroundTranslateClaim(
            canonicalClaimText, claim.rewritten,
            claim.claimLocale, locale, classification, researchCache,
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
          ).catch(e => console.error('[TRANSLATE_CLAIM] claim translation error:', e));
        }
        return;
      }

      if (message.type === "SET_DISPLAYED_LOCALE") {
        const { tweetId, textLocale: requestedLocale, locale: msgLocale } = message.data;
        const effectiveUiLocale = msgLocale ?? getUiLocale();
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
        }
        // Clear translateFactChecksOnHold if the new locale already has highlights
        if (updatedCls.translateFactChecksOnHold && textLocale && updatedCls.claims?.some(cl => cl.highlight?.[textLocale])) {
          updatedCls.translateFactChecksOnHold = undefined;
          console.log(`[background] SET_DISPLAYED_LOCALE: ${tweetId} clearing translateFactChecksOnHold (highlights exist for ${textLocale})`);
        }
        cacheClassification(updatedCls, hit.batchIds.values().next().value ?? '');
        broadcastClassification(updatedCls);

        // If highlights for this locale are not yet present, decide whether to
        // auto-localize or show the Translate Fact-Checks button.
        const needsLocalization = (classification.claims ?? []).some(cl => !cl.highlight?.[textLocale]);
        console.log(`[background] SET_DISPLAYED_LOCALE: ${tweetId} needsLocalization=${needsLocalization}, existing highlights=${JSON.stringify(classification.claims?.map(cl => cl.highlight))}`);
        if (needsLocalization) {
          const existingHighlightLocales = new Set(
            (classification.claims ?? []).flatMap(cl => Object.keys(cl.highlight ?? {}))
          );
          const hasMatchingHighlightLocale = textLocale && Array.from(existingHighlightLocales).some(hl => sameLanguage(hl, textLocale));
          const claimLocaleHint = updatedCls.claims?.[0]?.claimLocale ?? classification.claims?.[0]?.claimLocale;

          // Hold for Translate Fact-Checks when:
          // 1. We have existing highlights but none in the new text's language, OR
          // 2. We don't know the claim locale yet, OR
          // 3. The claim locale is in a different language from the displayed text.
          const defaultDisplayedLocale = tweet.destinationLanguage ?? tweet.sourceLanguage;
          const switchingFromDefault = textLocale && defaultDisplayedLocale && !sameLanguage(textLocale, defaultDisplayedLocale);
          const shouldHoldForTranslation =
            (existingHighlightLocales.size > 0 && !hasMatchingHighlightLocale) ||
            switchingFromDefault ||
            !claimLocaleHint ||
            (textLocale && !sameLanguage(textLocale, claimLocaleHint));

          if (shouldHoldForTranslation) {
            console.log(`[background] SET_DISPLAYED_LOCALE: ${tweetId} holding for Translate Fact-Checks (text=${textLocale}, claim=${claimLocaleHint ?? 'unknown'}, existing=[${Array.from(existingHighlightLocales).join(',')}])`);
            updatedCls.translateFactChecksOnHold = true;
            cacheClassification(updatedCls, hit.batchIds.values().next().value ?? '');
            broadcastClassification(updatedCls);
          } else {
            const dbClaims = claimsToDbClaims(classification);
            const tweetText = updatedCls.translatedText ?? tweet.text;
            console.log(`[background] SET_DISPLAYED_LOCALE: ${tweetId} starting localization for ${textLocale} with ${dbClaims.length} claims, uiLocale=${effectiveUiLocale}`);
            localizeHighlights(tweetId, tweetText, textLocale, dbClaims, updatedCls, effectiveUiLocale, mergeHighlightsFor(updatedCls))
              .catch(e => console.error('[background] SET_DISPLAYED_LOCALE highlight error:', e));
          }
        }
      }
    });
  });
});
