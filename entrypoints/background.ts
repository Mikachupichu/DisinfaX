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
  const researchCache = new Map<string, { confidence: number, veracity: number, reasoning: string, reasoningLocale?: string; change_propensity?: number; sources?: Source[]; dbClaimText?: string; embedding?: number[]; lastClassification?: string }>();
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
  /** Buffer re-research results for claims on hold until the user clicks.
   *  Keyed by `${classificationId}:${claimText}`. */
  const heldReclassifications = new Map<string, Classification>();
  /** Track DB results from fetchTweetByHash so TRANSLATE_FACT_CHECKS can
   *  re-fire the localization pipeline. Keyed by tweet id. */
  const dbHitCache = new Map<string, { tweet: MainTweet; dbClaims: any[] }>();
  /** Track tweets whose DB hash has already been fetched this session so
   *  repeated timeline XHRs don't refetch the same tweet. Keyed by tweet id. */
  const dbFetchPromises = new Map<string, Promise<{ hash: string; dbResult: any; quotedHash?: string; quotedDbResult?: any }>>();
  /** Track hashes that returned no DB match so we don't retry them. */
  const dbMissHashes = new Set<string>();
  /** Tweet ids the content script has reported as present in the DOM.
   *  Used to defer DB fetches for timeline tweets until they are actually
   *  rendered. The first 5 tweets of each XHR batch are fetched immediately. */
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
      return {
        text: claimText,
        rewritten: claimText,
        verdict: Math.abs(v) < 0.2 ? "unknown" : (v > 0 ? "true" : "false"),
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
    researchCache: Map<string, { confidence: number; veracity: number; reasoning: string; reasoningLocale?: string; change_propensity?: number; sources?: Source[]; dbClaimText?: string; embedding?: number[]; lastClassification?: string }>,
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
    const propense = dbClaims.filter(dc => {
      const p = Number(dc.change_propensity ?? 0);
      return p > 0 && Math.random() < p;
    });

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
    researchCache: Map<string, { confidence: number; veracity: number; reasoning: string; reasoningLocale?: string; change_propensity?: number; sources?: Source[]; dbClaimText?: string; embedding?: number[]; lastClassification?: string }>,
    locale: string
  ): Promise<void> {
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
          // Fresh claim: store the rewritten claim text under the UI locale. This is the
          // canonical claim text for this locale and matches what the user sees in the popover.
          newClaims.push({
            claim: c.rewritten ?? c.text,
            highlight_range: range,
            highlight_locale: highlightLocale,
            embedding: cached?.embedding,
            probability: cached?.confidence ?? 0,
            veracity: cached?.veracity ?? c.veracity ?? 0,
            change_propensity: cached?.change_propensity ?? 0.5,
            reasoning: cached?.reasoning ? { [locale]: cached.reasoning } : {},
            sources: sourcesToDictionary(cached?.sources ?? []),
          });
        }
      }
    };

    process(classification.claims);
    if (classification.quoting) process(classification.quoting.claims);

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
    for (const claims of [classification.claims, classification.quoting?.claims]) {
      for (const c of claims ?? []) {
        const cached = researchCache.get(c.text);
        if (cached) {
          researchCache.set(c.text, { ...cached, lastClassification: classificationTimestamp });
        }
      }
    }

    await upsertTweetPipeline(tweetHash, newClaims, existingClaims, dbClaimLocale);
  }

  function broadcastClassification(classification: Classification) {
    const claimSummary = classification.claims?.map(c => {
      const rw = (c.rewritten ?? c.text).slice(0, 20);
      const noteLang = c.note ? c.note.slice(0, 15) : 'none';
      const hlKeys = c.highlight ? Object.keys(c.highlight).join(',') : 'none';
      return `${rw}...=${c.confidence ?? '?'}(note:${noteLang}...,hl:${hlKeys})`;
    }).join(' | ') || 'none';
    console.log(`[background] broadcasting ${classification.id} with ${activePorts.size} active port(s), claims: ${claimSummary}`);
    for (const p of activePorts) {
      try { p.postMessage({ type: "CLASSIFICATION", data: classification }); } catch {}
    }
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

  function processFullBatch(port: any, tweets: MainTweet[], batchId: string, keepAlive: NodeJS.Timeout, localeOverride?: string | null) {
    (async () => {
      try {
        const locale = localeOverride ?? getUiLocale();
        const firstTweetText = tweets[0]?.text?.slice(0, 80) ?? '(no text)';
        console.log(`[pipeline fires] batch=${batchId} tweets=${tweets.length} ids=[${tweets.map(t => t.id).join(',')}] firstTweet="${firstTweetText}"`);

        // Cache incoming tweets so SET_DISPLAYED_LOCALE can look up original/translated text.
        for (const t of tweets) tweetCache.set(t.id, t);

        type HashResult = {
          tweet: MainTweet;
          hash: string;
          dbResult: any;
          quotedHash?: string;
          quotedDbResult?: any;
        };

        const IMMEDIATE_FETCH_COUNT = 5;
        const immediateTweets = tweets.slice(0, IMMEDIATE_FETCH_COUNT);
        const deferredTweets = tweets.slice(IMMEDIATE_FETCH_COUNT);

        async function waitForDom(tweetId: string): Promise<void> {
          if (seenInDom.has(tweetId)) return;
          return new Promise(resolve => {
            const list = domFetchResolvers.get(tweetId) ?? [];
            list.push(resolve);
            domFetchResolvers.set(tweetId, list);
          });
        }

        async function fetchForTweet(tweet: MainTweet, deferDom: boolean): Promise<HashResult> {
          const existing = dbFetchPromises.get(tweet.id);
          if (existing) {
            const cached = await existing;
            return { tweet, ...cached };
          }

          const promise = (async (): Promise<Omit<HashResult, 'tweet'>> => {
            if (deferDom) {
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

        // Build helper to process a HashResult through the rest of the pipeline.
        function tweetForDisplay(t: MainTweet): MainTweet {
          const hasTranslation = !!t.translatedText && !!t.destinationLanguage;
          const base = {
            ...t,
            text: hasTranslation ? t.translatedText! : t.text,
            quoting: t.quoting ? tweetForDisplay(t.quoting as MainTweet) : null,
          };
          return base as MainTweet;
        }

        async function processHashResult(r: HashResult) {
          // DB hit with claims
          if (r.dbResult?.success && r.dbResult.claims?.length > 0) {
            const quotedClaims = r.quotedDbResult?.success ? r.quotedDbResult.claims : undefined;
            const classification = dbClaimsToClassification(r.tweet, r.dbResult.claims, batchId, locale, quotedClaims);
            cacheClassification(classification, batchId);

            dbHitCache.set(classification.id, { tweet: r.tweet, dbClaims: r.dbResult.claims });
            if (r.tweet.quoting && r.quotedDbResult?.success && r.quotedDbResult.claims?.length > 0) {
              dbHitCache.set(r.tweet.quoting.id, { tweet: r.tweet.quoting as MainTweet, dbClaims: r.quotedDbResult.claims });
            }

            const hasTranslation = r.tweet.translatedText && r.tweet.sourceLanguage && r.tweet.destinationLanguage;
            const displayedLocale = classification.textLocale ?? r.tweet.sourceLanguage ?? '';
            const claimStorageLocale = (r.dbResult.claims?.[0] && getClaimLocale(r.dbResult.claims[0].claim)) ?? '';
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

            const allDbClaimsForCache = [...r.dbResult.claims, ...(quotedClaims ?? [])];
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
                if (classification.translateFactChecksOnHold) {
                  console.log(`[background] DB hit ${classification.id}: translateFactChecksOnHold, skipping localization + re-research`);
                  return;
                }

                const displayedLocale = classification.textLocale ?? r.tweet.sourceLanguage;
                const needsMainLocalization = displayedLocale && (classification.claims ?? []).some(cl => !cl.highlight?.[displayedLocale]);
                if (needsMainLocalization) {
                  const tweetText = classification.translatedText ?? r.tweet.text;
                  console.log(`[background] DB hit ${classification.id}: missing ${displayedLocale} highlights, localizing on load`);
                  await localizeHighlights(classification.id, tweetText, displayedLocale, r.dbResult.claims, classification, locale, mergeHighlightsFor(classification));
                }

                const quotedText = r.tweet.quoting?.text;
                const quotedClaims = classification.quoting?.claims;
                if (quotedText && quotedClaims && quotedClaims.length > 0 && displayedLocale) {
                  const needsQuotedLocalization = quotedClaims.some(cl => !cl.highlight?.[displayedLocale]);
                  if (needsQuotedLocalization) {
                    console.log(`[background] DB hit ${classification.id}: missing ${displayedLocale} highlights for quoted tweet, localizing on load`);
                    await localizeHighlights(classification.quoting!.id, quotedText, displayedLocale, r.quotedDbResult.claims, classification, locale, mergeHighlightsFor(classification));
                  }
                }

                if (!reResearchedTweetIds.has(classification.id)) {
                  reResearchedTweetIds.add(classification.id);
                  await reResearchDbClaims(r.tweet, r.dbResult.claims, classification, researchCache, locale);
                } else {
                  console.log(`[background] DB hit ${classification.id}: re-research already done this session, skipping`);
                }
              } catch (err) {
                console.error("[background] reResearchDbClaims error:", err);
              }
            })();
            return;
          }

          // DB hit with empty claims
          if (r.dbResult?.success) {
            const classification = { id: r.tweet.id, batchId, claims: null, quoting: null };
            attachTranslatedLocale(classification, r.tweet);
            cacheClassification(classification, batchId);
            safePostToPort(port, { type: "CLASSIFICATION", data: classification });

            (async () => {
              await upsertTweetPipeline(r.hash, [], [] as { claim: string; highlight_range?: number[] }[]);
            })();
            return;
          }

          // DB miss
          const hit = classificationCache.get(r.tweet.id);
          if (hit) {
            hit.batchIds.add(batchId);
            const cachedCls = { ...hit.classification, batchId };
            attachTranslatedLocale(cachedCls, r.tweet);
            safePostToPort(port, { type: "CLASSIFICATION", data: cachedCls });
            return;
          }

          // New on-hold tweet: preclassify + classify
          const onHoldClassification: Classification = {
            id: r.tweet.id, batchId, claims: null, quoting: null, onHold: true
          };
          attachTranslatedLocale(onHoldClassification, r.tweet);
          cacheClassification(onHoldClassification, batchId);
          safePostToPort(port, { type: "CLASSIFICATION", data: onHoldClassification });
          onHoldTweets.set(r.tweet.id, { tweet: r.tweet, hash: r.hash });

          let latestClassification: Classification | null = null;
          for await (const classification of preClassify([tweetForDisplay(r.tweet)], locale)) {
            classification.batchId = batchId;
            attachTranslatedLocale(classification, r.tweet);
            cacheClassification(classification, batchId);
            safePostToPort(port, { type: "CLASSIFICATION", data: classification });
            latestClassification = classification;
          }

          if (!latestClassification) return;
          const classification = latestClassification;

          const researchingCls = markClaimsResearching(classification);
          researchingCls.batchId = batchId;
          cacheClassification(researchingCls, batchId);
          broadcastClassification(researchingCls);

          let tweetUrls: string[] | undefined;
          tweetUrls = extractTweetUrls(r.tweet.text);
          if (r.tweet.quoting?.text) {
            tweetUrls.push(...extractTweetUrls(r.tweet.quoting.text));
          }
          if (tweetUrls.length === 0) tweetUrls = undefined;

          console.log(`[background] starting classification for ${classification.id} after preclassification (${classification.claims?.length ?? 0} claim(s))`);

          (async () => {
            try {
              let latestClassification = classification;
              for await (const updated of classify(classification, researchCache, locale, (upd) => {
                upd.batchId = batchId;
                cacheClassification(upd, batchId);
                broadcastClassification(upd);
              }, tweetUrls)) {
                updated.batchId = batchId;
                cacheClassification(updated, batchId);
                broadcastClassification(updated);
                latestClassification = updated;
              }

              reResearchedTweetIds.add(classification.id);

              upsertProcessedClaims(r.tweet, r.hash, latestClassification, researchCache, locale);

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

        // Process first 5 immediately.
        const immediateResults = await Promise.all(immediateTweets.map(t => fetchForTweet(t, false)));
        for (const r of immediateResults) {
          processHashResult(r);
        }

        // Process remaining tweets as they appear in the DOM.
        for (const deferred of deferredTweets) {
          fetchForTweet(deferred, true).then(r => {
            processHashResult(r);
          }).catch(err => {
            console.error(`[background] deferred fetch error for ${deferred.id}:`, err);
          });
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
        batchTweets.set(batchId, tweets);
        processFullBatch(port, tweets, batchId, keepAlive, msgLocale);
        return;
      }

      if (message.type === "TWEET_IN_DOM") {
        const tweetId: string = message.tweetId;
        if (seenInDom.has(tweetId)) return;
        seenInDom.add(tweetId);
        const resolvers = domFetchResolvers.get(tweetId);
        if (resolvers) {
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
                  }, tweetUrls)) {
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
              updated.batchId = anyBatchId;
              cacheClassification(updated, anyBatchId);
              port.postMessage({ type: "CLASSIFICATION", data: updated });
              broadcastClassification(updated);
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
                }, tweetUrls)) {
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

        // Restore cached values on the claim and clear on-hold flag. Keep the old
        // badge label visible but clear reasoning so the popover shows a spinner
        // while the re-research streams.
        const updatedClaims = classification.claims?.map(cl => {
          if (cl.text === claimText && cl.reclassifyOnHold) {
            return {
              ...cl,
              reclassifyOnHold: false,
              refreshing: true,
              verdict: cl.cachedVerdict ?? cl.verdict,
              note: null,
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
        // Otherwise start fresh re-research now that the user clicked.
        const holdKey = `${classificationId}:${claimText}`;
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
        (async () => {
          try {
            for await (const updated of refreshClaim(restored, claimText, researchCache, locale, tweetUrls)) {
              updated.batchId = anyBatchId;
              cacheClassification(updated, anyBatchId);
              port.postMessage({ type: "CLASSIFICATION", data: updated });
              broadcastClassification(updated);
            }
          } catch (err: any) {
            console.error("[background] RECLASSIFY_ON_HOLD_CLICK refresh error:", err);
          } finally {
            ongoingClaimRefreshes.delete(refreshKey);
          }
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
