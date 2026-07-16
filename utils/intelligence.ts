import { MainTweet } from "../data/Tweets";
import { Classification, Claim, QuotedClassification, Source, formatVerdict, sameLanguage } from "../data/Classification";

/** Clamp a value to (0, 1) exclusive — satisfies DB check constraint. */
function clampPropensity(val: number | undefined | null, fallback = 0.5): number {
  if (val == null || isNaN(val)) return fallback;
  return Math.min(Math.max(val, 0.01), 0.99);
}

/** Override for testing — set to a locale string (e.g. "fr") to simulate that browser language. */
export const TEST_LOCALE: string | null = null; // "fr" | "de" | "es" | "en-US" | null

/** Get the browser's UI language (e.g. "en-US", "fr"). */
function getUILanguage(): string {
  if (TEST_LOCALE) return TEST_LOCALE;
  try {
    return (browser?.i18n?.getUILanguage?.() ?? 'en');
  } catch { return 'en'; }
}

/** Extract reasoning text and locale from a DB result.
 *  DB returns reasoning as JSONB {"locale": "text"} but streamResearch gives a plain string. */
function extractReasoningObj(reasoning: any, defaultLocale = 'en'): { text: string; locale: string } {
  if (!reasoning) return { text: '', locale: defaultLocale };
  if (typeof reasoning === 'string') return { text: reasoning, locale: defaultLocale };
  const keys = Object.keys(reasoning);
  const locale = keys.find(k => typeof reasoning[k] === 'string') ?? defaultLocale;
  return { text: reasoning[locale] ?? '', locale };
}

/** Extract user-shared URLs from tweet text, excluding trailing media t.co links
 *  that X appends for images/videos. */
export function extractTweetUrls(text: string): string[] {
  const urlRegex = /https?:\/\/t\.co\/\w+/g;
  const allMatches = [...text.matchAll(urlRegex)];
  if (allMatches.length === 0) return [];

  // X appends media t.co URLs at the very end, one per media attachment.
  // Clip the trailing whitespace + t.co run to get user-shared URLs only.
  const cleaned = text.replace(/\s+(https?:\/\/t\.co\/\w+(?:\s+https?:\/\/t\.co\/\w+)*)\s*$/, '');
  return [...cleaned.matchAll(urlRegex)].map(m => m[0]);
}

export async function* preClassify(parsedTweets: MainTweet[], locale?: string): AsyncGenerator<Classification> {
    const effectiveLocale = locale ?? getUILanguage();
    const maxAttempts = 3;
    let lastError: any = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (attempt > 1) {
            console.log(`[preClassify] transient failure, retrying attempt ${attempt}/${maxAttempts}`);
            await new Promise(resolve => setTimeout(resolve, 1000 * (attempt - 1)));
        }

        try {
            const allClaims: any[] = [];
            let streamMode: string | null = null;
            let yieldedAny = false;

            const preStream = processWorkerStream({ input: parsedTweets, locale: effectiveLocale }, 'preclassify-tweets');
            for await (const item of processChunks(preStream)) {
                if (item && typeof item === 'object' && 'text' in item && 'rewritten' in item) {
                    allClaims.push(item);
                    // Detect mode from the chunk shape. processChunks returns complete snapshot
                    // objects in replace mode and incremental objects in append mode. We can't
                    // read the header here, so we infer: if the same claim text arrives again,
                    // we're in replace mode.
                    if (streamMode === null) {
                        // First claim: assume append until proven otherwise
                        streamMode = 'append';
                    } else if (streamMode === 'append') {
                        // If we see a claim text we already have, the worker is sending snapshots
                        const text = (item as any).text;
                        if (allClaims.slice(0, -1).some((c: any) => c.text === text)) {
                            streamMode = 'replace';
                            console.log('[preClassify] detected replace mode from duplicate claim text');
                        }
                    }

                    // In append mode, stream each new claim as it arrives.
                    if (streamMode === 'append') {
                        yieldedAny = true;
                        for (const tweet of parsedTweets) {
                            yield makePreclassification(tweet, allClaims);
                        }
                    }
                }
            }

            // Replace mode (or empty): yield the final classification once.
            for (const tweet of parsedTweets) {
                yield makePreclassification(tweet, allClaims);
            }
            return;
        } catch (err) {
            lastError = err;
            console.error(`[preClassify] attempt ${attempt}/${maxAttempts} failed:`, err);
        }
    }

    console.error(`[preClassify] all ${maxAttempts} attempts failed, yielding empty classification`, lastError);
    // Preserve the old contract (always yield at least once) so callers don't need to change.
    for (const tweet of parsedTweets) {
        yield makePreclassification(tweet, []);
    }
}

function makePreclassification(tweet: MainTweet, allClaims: any[]): Classification {
    const classification: Classification = {
        id: tweet.id,
        batchId: '',
        claims: allClaims.length > 0 ? allClaims : null,
        quoting: null,
    };
    // DEBUG: check if claim text arrives with spaces from the model
    for (const cl of classification.claims ?? []) {
        if (cl.text && !/\s/.test(cl.text)) {
            console.warn(`[classify] SPACE-LOST in preClassify: "${cl.text.slice(0, 60)}" has NO spaces`);
        } else if (cl.text) {
            console.log(`[classify] SPACE-OK in preClassify: "${cl.text.slice(0, 60)}" has spaces`);
        }
    }
    return normalizePreclassifyVerdicts(classification);
}

/** After preclassification, normalize verdicts and set confidence/veracity values so the UI
 *  displays the correct label and color. The model outputs verdict strings but no
 *  numeric scores.
 *  Map each verdict to appropriate confidence (probability) and veracity values:
 *    "true"   → confidence: 0.95, veracity: 0.95  (green)
 *    "false"  → confidence: 0.95, veracity: -0.95 (red)
 *    "unknown" → confidence: 0,   veracity: 0     (orange — low probability → "Unknown")
 *    "research required" → both undefined (purple, "Researching...")
 *  Also force verdict to match when the note indicates a source type. */
function normalizePreclassifyVerdicts(c: Classification): Classification {
    const normalize = (claims: Classification["claims"]): Classification["claims"] =>
        claims?.map(cl => {
            let verdict = cl.verdict;
            // If the note indicates a source, the claim is true regardless of what the model put in verdict
            if (cl.note === "primary source" || cl.note === "common knowledge") {
                verdict = "true";
            }
            // Set confidence and veracity based on verdict (model doesn't output numeric scores)
            let confidence = cl.confidence;
            let veracity = cl.veracity;
            if (confidence === undefined) {
                if (verdict === "true") { confidence = 0.95; veracity = 0.95; }
                else if (verdict === "false") { confidence = 0.95; veracity = -0.95; }
                else if (verdict === "unknown") { confidence = 0; veracity = 0; }
                // "research required" stays undefined → purple "Researching..." badge
            }
            return { ...cl, verdict, confidence, veracity };
        }) ?? null;

    return {
        ...c,
        claims: normalize(c.claims),
        quoting: c.quoting ? { ...c.quoting, claims: normalize(c.quoting.claims) } as QuotedClassification : null
    };
}

export async function* classify(
    classification: Classification,
    researchCache: Map<string, { confidence: number, veracity: number, reasoning: string, reasoningLocale?: string, sources?: Source[], dbClaimText?: string, embedding?: number[], lastClassification?: string, freshlyResearched?: boolean, veracity_change_duration?: string }> = new Map(),
    locale?: string,
    onBackgroundUpdate?: BackgroundUpdateCallback,
    tweetUrls?: string[],
    onNoDbMatch?: (claimText: string) => void
): AsyncGenerator<Classification> {
    const needsResearch = (claims: Classification["claims"]) =>
        claims?.some(c => c.verdict === "research required" || c.verdict === "unknown" || !c.note) ?? false;

    if (!needsResearch(classification.claims) && !needsResearch(classification.quoting?.claims ?? null))
        return;

    const uniqueClaimTexts = new Set<string>();
    classification.claims?.filter(cl => cl.verdict === "research required" || cl.verdict === "unknown" || !cl.note).forEach(cl => uniqueClaimTexts.add(cl.text));
    classification.quoting?.claims?.filter(cl => cl.verdict === "research required" || cl.verdict === "unknown" || !cl.note).forEach(cl => uniqueClaimTexts.add(cl.text));

    const uncachedClaims = [...uniqueClaimTexts].filter(t => !researchCache.has(t));

    if (uncachedClaims.length === 0) {
        yield applyFindings(classification, researchCache);
        return;
    }

    // Build a map from raw claim text → rewritten text for better embedding/matching
    const textToRewritten = new Map<string, string>();
    const addToMap = (claims: Classification["claims"]) =>
        claims?.forEach(cl => { if (cl.rewritten) textToRewritten.set(cl.text, cl.rewritten); });
    addToMap(classification.claims);
    addToMap(classification.quoting?.claims ?? null);

    // --- Concurrent claim processing ---
    // Coordination: yield as each claim progresses or completes
    let completedCount = 0;
    const total = uncachedClaims.length;
    let waker: (() => void) | null = null;
    let yieldCount = 0;

    const signalProgress = () => {
        yieldCount++;
        if (waker) { waker(); waker = null; }
    };

    const processClaim = async (claimText: string) => {
        // Guard: concurrent classify() calls (from two tweets that share a claim text)
        // race on researchCache. If we already have an entry (even a placeholder from
        // another processClaim), skip to avoid duplicate streamResearch calls.
        if (researchCache.has(claimText)) {
            completedCount++;
            signalProgress();
            return;
        }
        const searchText = textToRewritten.get(claimText) ?? claimText;
        // Reserve a spot immediately so concurrent calls for the same claimText
        // find the placeholder and bail above, not after a full research pipeline.
        researchCache.set(claimText, { confidence: 0, veracity: 0, reasoning: "" });
        try {
            console.log(`[classify] Starting pipeline for: "${claimText}" (search: "${searchText.slice(0, 60)}")`);
            const embedding = await createEmbedding(searchText);
            if (!embedding) console.warn(`[classify] No embedding for: "${claimText}"`);
            else {
                console.log(`[classify] Embedding OK for: "${claimText}", fetching claim...`);
                const result = await fetchClaim(searchText, embedding, locale);
                console.log(`[classify] Fetch claim result: equivalentIndex=${result.equivalentIndex}, matchedClaim=${result.matchedClaim ? 'FOUND' : 'null'}`);

                if (result.matchedClaim) {
                    const equivalent = result.matchedClaim;
                    const confidence = Number(
                        equivalent.confidence ??
                        (equivalent.probability != null ? Math.abs(Number(equivalent.probability)) :
                         equivalent.veracity != null ? Math.abs(Number(equivalent.veracity)) :
                         0)
                    );
                    const veracity = Number(equivalent.veracity ?? equivalent.probability);
                    const reclassify = equivalent.reclassify === true;
                    console.log(`[classify] Equivalent found in DB: confidence=${confidence}, veracity=${veracity}, reclassify=${reclassify}`);
                    const dbClaimText = extractCanonicalClaimText(equivalent.claim);
                    const claimLocale = (equivalent.claim && typeof equivalent.claim === 'object' && !Array.isArray(equivalent.claim))
                        ? (Object.keys(equivalent.claim)[0] ?? 'en')
                        : 'en';
                    // Use the actual claim JSONB key for DB matching, not equivalent.locale_key,
                    // because locale_key may use a different format (e.g. en_US vs en-US).
                    const sourceLocale = claimLocale;
                    const { text: dbReasonText, locale: dbReasonLocale } = extractReasoningObj(equivalent.reasoning, locale ?? getUILanguage());

                    // If the matched DB claim is an unclassified placeholder (empty
                    // reasoning), do NOT treat it as classified. Put it on hold so the
                    // user sees a Disinfact button. Keep dbClaimText/locale so a later
                    // classification UPDATES this existing row (linked via existing_claims)
                    // rather than inserting a duplicate.
                    const isPlaceholderMatch = !dbReasonText || dbReasonText.trim() === '';
                    if (isPlaceholderMatch && onNoDbMatch) {
                        researchCache.set(claimText, { confidence: 0, veracity: 0, reasoning: "", dbClaimText, embedding: embedding ?? undefined, lastClassification: equivalent.last_classification ?? equivalent.last_classified });
                        classification.claims = classification.claims?.map(cl =>
                            cl.text === claimText
                                ? { ...cl, reclassifyOnHold: true, verdict: "research required" as const, note: null, confidence: undefined, veracity: undefined, dbClaimText, dbClaimLocale: sourceLocale, claimLocale: sourceLocale }
                                : cl
                        ) ?? null;
                        console.log(`[classify] DB match is an unclassified placeholder for "${claimText.slice(0, 40)}..." — holding for user`);
                        onNoDbMatch(claimText);
                        signalProgress();
                        return;
                    }

                    researchCache.set(claimText, { confidence, veracity, reasoning: dbReasonText, reasoningLocale: dbReasonLocale, sources: normalizeSources(equivalent.sources), dbClaimText, embedding: embedding ?? undefined, lastClassification: equivalent.last_classification ?? equivalent.last_classified });
                    // Associate the preclassified claim with its canonical DB text and
                    // storage locale so background translation callbacks and the upsert
                    // pipeline can match the right claim row / JSONB locale key.
                    classification.claims = classification.claims?.map(cl =>
                        cl.text === claimText ? { ...cl, dbClaimText, dbClaimLocale: sourceLocale, claimLocale: sourceLocale } : cl
                    ) ?? null;
                    // If the DB claim/reasoning is not available in the UI language, translate in the background.
                    // This fires during active classification, e.g. when the user clicked Disinfact and we
                    // happened to find an equivalent claim already in the DB.
                    const uiLocale = locale ?? getUILanguage();
                    const listLocales = (obj: any): string[] => {
                        if (!obj) return [];
                        if (typeof obj === 'string') { try { return Object.keys(JSON.parse(obj)); } catch { return []; } }
                        if (typeof obj === 'object') return Object.keys(obj);
                        return [];
                    };
                    const claimLocales = listLocales(equivalent.claim);
                    const reasoningLocales = listLocales(equivalent.reasoning);

                    if (!claimLocales.some(l => sameLanguage(l, uiLocale))) {
                        const claimToTranslate = extractPlainClaimText(equivalent.claim, sourceLocale) || dbClaimText;
                        backgroundTranslateClaim(dbClaimText, claimToTranslate, sourceLocale, uiLocale, classification, researchCache, onBackgroundUpdate).catch(e =>
                            console.error('[classify] backgroundTranslateClaim error:', e)
                        );
                    }

                    if (dbReasonText && !reasoningLocales.some(l => sameLanguage(l, uiLocale))) {
                        backgroundTranslate(claimText, dbClaimText, dbReasonText, dbReasonLocale, uiLocale, researchCache, classification, onBackgroundUpdate).catch(e =>
                            console.error('[classify] backgroundTranslate error:', e)
                        );
                    }

                    // Signal DB result progress
                    signalProgress();

                    // Possibly re-research based on reclassify boolean
                    let didReResearch = false;
                    if (reclassify) {
                        console.log(`[classify] Re-researching change-prone claim: "${claimText}"`);
                        // NOTE: affected claims context removed — fetch-claim no longer returns affected claims.
                        for await (const update of streamResearch(searchText, [], locale, tweetUrls)) {
                            if (update.kind === 'complete') {
                                const mainResult = update.data.mainResult;
                                // Generate timestamp right before the upsert so it matches DB's last_classification.
                                const reclassificationTimestamp = new Date().toISOString();
                                researchCache.set(claimText, {
                                    confidence: mainResult.confidence,
                                    veracity: mainResult.veracity,
                                    reasoning: mainResult.reasoning,
                                    sources: mainResult.sources,
                                    veracity_change_duration: mainResult.veracity_change_duration,
                                    dbClaimText: dbClaimText,
                                    embedding: embedding ?? undefined,
                                    lastClassification: reclassificationTimestamp
                                });
                                signalProgress();

                                // Upsert re-research results under the claim's actual storage locale.
                                // equivalent.claim is already a locale-keyed JSONB object (e.g. {"en-US":"text"}).
                                // Pass it as-is so upsertClaims doesn't wrap the canonical text under the UI locale.
                                const storageLocale = Object.keys(equivalent.claim as Record<string, unknown>)[0] ?? 'en';
                                const uiLocale = locale ?? getUILanguage();
                                const reUpsertItems: any[] = [
                                    { claim: dbClaimText, embedding, confidence: Number(mainResult.confidence), probability: Number(mainResult.confidence), veracity: Number(mainResult.veracity), veracity_change_duration: mainResult.veracity_change_duration, sources: mainResult.sources }
                                ];
                                upsertClaims(reUpsertItems, storageLocale).catch(e => console.error('[classify] re-research upsert error:', e));

                                // Persist the freshly-researched reasoning under the UI locale (the language
                                // the research was actually produced in), not the claim's storage locale.
                                // upsertClaims keys reasoning by its matching locale parameter, so we use the
                                // dedicated reasoning-locale worker to store under uiLocale while matching
                                // the claim row by its canonical storage locale.
                                if (mainResult.reasoning) {
                                    insertReasoningLocale(dbClaimText, { [uiLocale]: mainResult.reasoning }, reclassificationTimestamp, sourceLocale).catch(e =>
                                        console.error('[classify] re-research reasoning locale insert error:', e)
                                    );
                                }
                                didReResearch = true;
                            }
                        }
                    }

                    // Skip the redundant cache-backed upsert when re-research already ran
                    if (didReResearch) { /* already upserted fresh results above */ }
                } else {
                    // No equivalent claim found in DB.
                    if (onNoDbMatch) {
                        // Pause fresh research behind the Disinfact badge. Notify the
                        // caller and put the claim into the same reclassifyOnHold state
                        // used by DB-hit change-propensity reclassifications. The caller
                        // starts streamResearch when the user clicks the badge.
                        // Keep the embedding in the cache so the placeholder upsert can
                        // persist it (the claim will be inserted as an unclassified
                        // placeholder and updated in place once classified).
                        researchCache.set(claimText, { confidence: 0, veracity: 0, reasoning: "", embedding: embedding ?? undefined });
                        onNoDbMatch(claimText);
                        classification.claims = classification.claims?.map(cl =>
                            cl.text === claimText
                                ? {
                                      ...cl,
                                      reclassifyOnHold: true,
                                      verdict: "research required" as const,
                                      note: null,
                                      confidence: undefined,
                                      veracity: undefined
                                  }
                                : cl
                        ) ?? null;
                        signalProgress();
                    } else {
                        // No callback: stream fresh research immediately (legacy behavior).
                        let researchDone = false;
                        for await (const update of streamResearch(searchText, [], locale, tweetUrls)) {
                            if (update.kind === 'partial') {
                                // Stream partial text directly into the claim note for progressive UI updates.
                                // Only adopt confidence/veracity when BOTH are present in the same partial
                                // update so the highlight color updates the moment the model has settled on
                                // a verdict, but never flickers back to grey because of a later text-only chunk.
                                const hasBoth = update.confidence !== undefined && update.veracity !== undefined;
                                classification.claims = classification.claims?.map(cl =>
                                    cl.text === claimText
                                        ? {
                                              ...cl,
                                              note: update.partialText,
                                              confidence: hasBoth ? update.confidence : cl.confidence,
                                              veracity: hasBoth ? update.veracity : cl.veracity
                                          }
                                        : cl
                                ) ?? null;
                                signalProgress();
                            } else {
                                researchDone = true;
                                const mainResult = update.data.mainResult;
                                const srcCount = mainResult.sources?.length ?? 0;
                                console.debug(`[classify] streamResearch complete: sources=${srcCount}`, mainResult.sources);
                                const reason = mainResult.reasoning ?? '';
                                const reasonSpaced = /\s/.test(reason);
                                console.log(`[classify] streamResearch complete: reasoning ${reasonSpaced ? 'HAS SPACES' : 'NO SPACES'} for "${claimText.slice(0, 40)}...": "${reason.slice(0, 100)}"`);
                                researchCache.set(claimText, { confidence: mainResult.confidence, veracity: mainResult.veracity, reasoning: reason, sources: mainResult.sources, veracity_change_duration: mainResult.veracity_change_duration, embedding: embedding ?? undefined, freshlyResearched: true });
                                signalProgress();

                                // Do NOT upsert the claim here. upsertProcessedClaims
                                // (called by processFullBatch after classify() finishes)
                                // persists the claim via upsertTweetPipeline. Calling
                                // upsertClaims here races with that and creates a
                                // duplicate-key error. The research result is already
                                // in researchCache for applyFindings.
                            }
                        }
                        if (!researchDone) {
                            console.warn(`[classify] streamResearch yielded no result for: "${claimText}"`);
                            researchCache.set(claimText, { confidence: 0, veracity: 0, reasoning: "Error" });
                        }
                    }
                }
            }
        } catch (error) {
            console.error(`[classify] Error on claim "${claimText}":`, error);
        } finally {
            completedCount++;
            signalProgress();
        }
    };

    // Start all claim pipelines concurrently (each catches its own errors)
    uncachedClaims.forEach(ct => { processClaim(ct); });

    // Yield as each claim makes progress
    while (completedCount < total) {
        if (yieldCount > 0) {
            yieldCount--;
            yield applyFindings(classification, researchCache);
        } else {
            await new Promise<void>(resolve => { waker = resolve; });
        }
    }

    // Final yield with all results applied
    yield applyFindings(classification, researchCache);
}

/** Re-research a single claim on demand (triggered by the user clicking the refresh button).
 *  Skips all matching/identification — uses the existing claim text (or dbClaimText) directly.
 *  Always streams fresh research regardless of reclassify. */
export async function* refreshClaim(
    classification: Classification,
    claimText: string,
    researchCache: Map<string, { confidence: number, veracity: number, reasoning: string, reasoningLocale?: string, sources?: Source[], dbClaimText?: string, embedding?: number[], lastClassification?: string, freshlyResearched?: boolean, veracity_change_duration?: string }>,
    locale?: string,
    tweetUrls?: string[],
    /** When true, do NOT write the researched claim via upsertClaims. Used by the
     *  Fact-Check All fresh-research path, where the on-hold pipeline's
     *  upsertProcessedClaims persists tweet + claims in a single upsert_tweet_pipeline
     *  call. Writing here too would double-write the claim and trip the
     *  duration_between_accesses trigger. */
    skipClaimUpsert?: boolean
): AsyncGenerator<Classification> {
    const claimObj = classification.claims?.find(c => c.text === claimText);
    const searchText = claimObj?.rewritten ?? claimText;

    const embedding = await createEmbedding(searchText);
    const mainDbText = researchCache.get(claimText)?.dbClaimText;

    for await (const update of streamResearch(searchText, [], locale, tweetUrls)) {
        if (update.kind === 'partial') {
            // Show partial reasoning progress
            const existing = researchCache.get(claimText);
            researchCache.set(claimText, {
                confidence: update.confidence ?? existing?.confidence ?? 0,
                veracity: update.veracity ?? existing?.veracity ?? 0,
                reasoning: update.partialText,
                sources: existing?.sources,
                dbClaimText: mainDbText ?? existing?.dbClaimText,
                veracity_change_duration: existing?.veracity_change_duration,
            });
            yield applyFindings(classification, researchCache);
        } else {
            const mainResult = update.data.mainResult;
            // Always use the stored DB claim text for upserting — never the model's output,
            // which may be in a different language or rephrased. This prevents creating
            // duplicate claim entries for the same semantic claim. For a fresh claim with
            // no DB match, fall back to the rewritten text (the canonical key the
            // placeholder row was inserted under) so this UPDATES that row instead of
            // creating a duplicate under the raw text.
            const actualDbText = mainDbText ?? claimObj?.rewritten ?? claimText;

            // Generate timestamp right before the upsert so it matches DB's last_classification.
            const reclassificationTimestamp = new Date().toISOString();
            researchCache.set(claimText, {
                confidence: mainResult.confidence,
                veracity: mainResult.veracity,
                reasoning: mainResult.reasoning,
                sources: mainResult.sources,
                // Only carry a dbClaimText when there was a REAL DB match (mainDbText).
                // For a fresh no-match claim this must stay undefined so applyFindings
                // doesn't tag the claim with a dbClaimText — which would route it to
                // upsertProcessedClaims' existingClaims path (an UPDATE that matches
                // nothing, since the claim was never inserted) instead of newClaims.
                dbClaimText: mainDbText,
                // Preserve the embedding so upsertProcessedClaims can persist it when it
                // inserts this fresh claim (the per-claim upsertClaims write is skipped
                // in the Fact-Check All flow).
                embedding: embedding ?? undefined,
                lastClassification: reclassificationTimestamp,
                veracity_change_duration: mainResult.veracity_change_duration,
            });

            // Re-research is performed in the UI/research locale. The model returns
            // reasoning in that locale, so we upsert under the research locale. The worker
            // no longer returns claim text, so use the known actualDbText for upserting.
            const uiLocale = locale ?? getUILanguage();
            const refreshedClaimText = actualDbText;

            const upsertItems: any[] = [{
                claim: refreshedClaimText,
                embedding,
                confidence: Number(mainResult.confidence),
                probability: Number(mainResult.confidence),
                veracity: Number(mainResult.veracity),
                veracity_change_duration: mainResult.veracity_change_duration,
                reasoning: mainResult.reasoning ? { [uiLocale]: mainResult.reasoning } : {},
                sources: mainResult.sources
            }];
            if (!skipClaimUpsert) {
                upsertClaims(upsertItems, uiLocale).catch(e => console.error('[refreshClaim] upsert error:', e));
            }

            yield applyFindings(classification, researchCache);
        }
    }
}

function applyFindings(
    classification: Classification,
    cache: Map<string, { confidence: number, veracity: number, reasoning: string, reasoningLocale?: string, sources?: Source[], dbClaimText?: string, freshlyResearched?: boolean, veracity_change_duration?: string }>
): Classification {
    const apply = (claims: Classification["claims"]): Claim[] | null =>
        claims?.map(cl => {
            const r = cache.get(cl.text);
            // If research is complete (has full results), remove the on-hold flag and apply findings.
            // Otherwise, preserve on-hold state across partial updates.
            const hasCompleteResearch = r && r.confidence !== undefined && r.veracity !== undefined && r.reasoning;
            if (cl.reclassifyOnHold && !hasCompleteResearch) return cl;

            if (!r || (r.confidence === 0 && r.veracity === 0 && !r.reasoning)) {
                // During a background refresh, keep the existing badge label and
                // let the reasoning spinner show because note is null.
                if (cl.refreshing) return cl;
                // Claim hasn't finished research yet (either not in cache at all,
                // or it's the placeholder from processClaim's guard). If it only
                // has a preclassification verdict (no reasoning note), show
                // "Researching..." so the user doesn't see a misleading badge.
                if (!cl.note) {
                    return { ...cl, verdict: "research required", note: null, confidence: undefined, veracity: undefined };
                }
                return cl;
            }
            if (r.sources?.length) {
                console.debug(`[applyFindings] "${cl.text.slice(0, 40)}..." has ${r.sources.length} sources from cache`);
            }
            if (cl.refreshing) {
                const newConfidence = r.confidence;
                const newVeracity = r.veracity;
                const hasNewNumbers = newConfidence !== undefined && newVeracity !== undefined;
                if (hasNewNumbers) {
                    const { verdict, note } = formatVerdict(newConfidence, newVeracity, r.reasoning);
                    return { ...cl, verdict, note, confidence: newConfidence, veracity: newVeracity, sources: r.sources, dbClaimText: r.dbClaimText ?? cl.dbClaimText, refreshing: false, freshlyResearched: r.freshlyResearched, reclassifyOnHold: false };
                }
                // Stream reasoning while waiting for new confidence/veracity.
                return { ...cl, note: r.reasoning || cl.note, sources: r.sources ?? cl.sources, dbClaimText: r.dbClaimText ?? cl.dbClaimText, freshlyResearched: r.freshlyResearched };
            }
            const { verdict, note } = formatVerdict(r.confidence, r.veracity, r.reasoning);
            return { ...cl, verdict, note, confidence: r.confidence, veracity: r.veracity, sources: r.sources, dbClaimText: r.dbClaimText ?? cl.dbClaimText, freshlyResearched: r.freshlyResearched, reclassifyOnHold: false };
        }) ?? null;

    return {
        ...classification,
        claims: apply(classification.claims),
        quoting: classification.quoting
            ? { ...classification.quoting, claims: apply(classification.quoting.claims) } as QuotedClassification
            : null
    };
}

/** Safely extract claim text from a string or locale-keyed JSONB object (e.g. {"en": "text"}).
 *  NOTE: kept for reference — no longer used directly since fetch-claim handles matching internally. */
// function extractClaimText(raw: any): string {
//     if (typeof raw === 'string') return raw;
//     if (raw && typeof raw === 'object') {
//         const vals = Object.values(raw).filter(v => typeof v === 'string');
//         if (vals.length > 0) return vals[0] as string;
//     }
//     return '';
// }

/** Normalize claim text for comparison: trim, collapse whitespace, lowercase, strip trailing punctuation.
 *  NOTE: kept for reference — no longer used directly since fetch-claim handles matching internally. */
// function normalizeText(t: string): string {
//     return t.trim().replace(/\s+/g, ' ').toLowerCase().replace(/[.,!?;:]+$/, '');
// }

/** Find a matched claim by normalized text comparison, with substring fallback */
// NOTE: kept for reference — no longer used since fetch-claim returns matchedClaim directly
// function findClaimIn(matchedClaims: any[], text: string): any | undefined {
//     const n = normalizeText(text);
//     return matchedClaims.find((m: any) => {
//         const ct = extractClaimText(m.claim);
//         return ct && normalizeText(ct) === n;
//     }) ?? matchedClaims.find((m: any) => {
//         const ct = extractClaimText(m.claim);
//         return ct && (normalizeText(ct).includes(n) || n.includes(normalizeText(ct)));
//     });
// }

/** Match a potentially-different claim text from the model back to the original text.
 *  NOTE: kept for reference — no longer used since affected claims have been removed. */
// function resolveClaimFromContext(modelClaim: string, context: { claim: string, reasoning: string }[]): string {
//     const n = normalizeText(modelClaim);
//     // Try exact normalized match first
//     const exact = context.find(ctx => normalizeText(ctx.claim) === n);
//     if (exact) return exact.claim;
//     // Fall back to space-insensitive match (model sometimes strips all spaces)
//     const nCompact = n.replace(/\s+/g, '');
//     const fuzzy = context.find(ctx => normalizeText(ctx.claim).replace(/\s+/g, '') === nCompact);
//     if (fuzzy) return fuzzy.claim;
//     // No match found — log and return the model's version
//     if (modelClaim && !/\s/.test(modelClaim)) {
//         console.warn(`[resolveClaimFromContext] Model returned spaceless claim "${modelClaim.slice(0, 60)}" — no context match, using raw text`);
//     }
//     return modelClaim;
// }

// ---- Worker API helpers ----

async function createEmbedding(text: string): Promise<number[] | null> {
    const res = await fetch('https://create-claim-embeddings.michael-pouget01.workers.dev/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text }] }] })
    });
    if (!res.ok) { console.error('Embedding error:', await res.text()); return null; }
    const data = await res.json();
    // Embedding endpoint returns raw array: [0.1, 0.2, ...]
    if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'number') return data;
    // OpenAI format: { data: [{ embedding: number[] }] }
    // Also support: { embedding: { values: number[] } } or flat embedding key
    return data.data?.[0]?.embedding ?? data.embedding?.values ?? data.embedding ?? data.embeddings?.[0]?.values ?? null;
}

async function fetchClaim(claimText: string, embedding: number[], locale?: string): Promise<{ equivalentIndex: number; matchedClaim: any | null; candidates: any[] }> {
    const res = await fetch('https://fetch-claim.michael-pouget01.workers.dev/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claimText, embedding, locale: locale ?? getUILanguage() })
    });
    if (!res.ok) { console.error('Fetch claim error:', await res.text()); return { equivalentIndex: 0, matchedClaim: null, candidates: [] }; }
    return await res.json();
}

/** SHA-256 hex digest of a tweet ID for DB lookup. */
export async function computeTweetHash(id: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(id);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Look up a tweet by hash in the DB. Returns null if not found. */
export async function fetchTweetByHash(hash: string, locale?: string): Promise<any | null> {
    try {
        const res = await fetch('https://fetch-tweet-classification.michael-pouget01.workers.dev/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hash, locale: locale ?? getUILanguage() })
        });
        if (!res.ok) { console.error('[fetchTweetByHash] error:', await res.text()); return null; }
        return await res.json();
    } catch (err) {
        console.error('[fetchTweetByHash] fetch error:', err);
        return null;
    }
}

/** Upsert a tweet (by hash) and link its claims via the upsert-tweet-pipeline worker.
 *  newClaims = full claim objects (include highlight_range: number[] for character ranges).
 *  existingClaims = { claim, highlight_range? } pairs to link. */
export async function upsertTweetPipeline(tweetHash: string, newClaims: any[], existingClaims: { claim: string; highlight_range?: number[] }[], locale?: string): Promise<void> {
    try {
        const targetLocale = locale ?? getUILanguage();
        const url = new URL('https://upsert-tweet-and-claims.michael-pouget01.workers.dev/');
        url.searchParams.set('locale', targetLocale);
        const res = await fetch(url.toString(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tweet_hash: tweetHash, new_claims: newClaims, existing_claims: existingClaims })
        });
        const body = await res.text();
        if (!res.ok) console.error('[upsertTweetPipeline] error:', body);
        else console.log(`[upsertTweetPipeline] success: ${body.slice(0, 200)}`);
    } catch (err) {
        console.error('[upsertTweetPipeline] fetch error:', err);
    }
}

// NOTE: identifyRelatedClaims has been replaced by fetchClaim above.
// The new fetch-claim worker handles matching + identification in a single call.

/** Translate any text to the target locale via the translate worker (handles both reasoning and claim text).
 *  The worker streams SSE. If onPartial is provided, partial accumulated text is emitted
 *  after each chunk for live UI updates. The final translated text is always returned. */
export async function translateText(text: string, target: string, onPartial?: (partial: string) => void): Promise<string | null> {
    try {
        const res = await fetch('https://translate.michael-pouget01.workers.dev/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ q: text, target })
        });
        if (!res.ok) { console.error('[translateText] error:', await res.text()); return null; }
        if (!res.body) { console.error('[translateText] no response body'); return null; }

        const streamMode = res.headers.get('X-Stream-Mode') || 'append';
        console.log(`[translateText] streamMode=${streamMode} target=${target}`);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let translated = '';

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data: ')) continue;
                const data = trimmed.slice(6);
                if (data === '[DONE]') continue;
                // SSE: choices[0].delta.content or candidates[0].content.parts[0].text
                try {
                    const json = JSON.parse(data);
                    const content = json.choices?.[0]?.delta?.content
                        ?? json.candidates?.[0]?.content?.parts?.[0]?.text;
                    if (content) {
                        if (streamMode === 'replace') translated = content;
                        else translated += content;
                        if (onPartial) onPartial(translated);
                    }
                } catch {
                    // If it's not JSON, the model may be outputting raw text directly
                    if (data) {
                        if (streamMode === 'replace') translated = data;
                        else translated += data;
                        if (onPartial) onPartial(translated);
                    }
                }
            }
        }

        // Process remaining buffer
        const remaining = buffer.trim();
        if (remaining.startsWith('data: ')) {
            const data = remaining.slice(6);
            if (data !== '[DONE]') {
                try {
                    const json = JSON.parse(data);
                    const content = json.choices?.[0]?.delta?.content
                        ?? json.candidates?.[0]?.content?.parts?.[0]?.text;
                    if (content) {
                        if (streamMode === 'replace') translated = content;
                        else translated += content;
                        if (onPartial) onPartial(translated);
                    }
                } catch {
                    if (data) {
                        if (streamMode === 'replace') translated = data;
                        else translated += data;
                        if (onPartial) onPartial(translated);
                    }
                }
            }
        }

        return translated.trim() || null;
    } catch (err) {
        console.error('[translateText] fetch error:', err);
        return null;
    }
}

/** Insert a locale-keyed reasoning entry into the DB via the insert-reasoning-locale worker.
 *  inputTimestamp is the claim's last_classification at fetch time — the DB uses it to
 *  guard against stale translations overwriting freshly-reclassified claims.
 *  The claim can be passed as a plain string; when sourceLocale is provided it is wrapped
 *  as {sourceLocale: claim} so the worker can match against the locale-keyed JSONB column. */
async function insertReasoningLocale(claim: string, reasoning: Record<string, string>, inputTimestamp?: string, sourceLocale?: string): Promise<void> {
    try {
        // The updated worker reads source_locale from each item and accepts either a
        // plain-string claim or a locale-keyed JSONB object.
        const body = JSON.stringify({ items: [{ claim, reasoning, source_locale: sourceLocale }], timestamp: inputTimestamp });
        console.log(`[insertReasoningLocale] Sending claim="${claim.slice(0, 40)}..." reasoningKeys=${Object.keys(reasoning).join(',')} sourceLocale=${sourceLocale ?? 'none'} ts=${inputTimestamp ?? 'none'}`);
        const res = await fetch('https://insert-reasoning-locale.michael-pouget01.workers.dev/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body
        });
        const resBody = await res.text();
        if (!res.ok) console.error('[insertReasoningLocale] error:', res.status, resBody);
        else console.log('[insertReasoningLocale] success:', resBody.slice(0, 200));
    } catch (err) {
        console.error('[insertReasoningLocale] fetch error:', err);
    }
}

/** Insert a locale-keyed claim localization into the DB via the insert-claim-locale worker.
 *  source_locale is the locale of the existing claim text in the DB (used for matching);
 *  the items carry new_locale / new_claim for the translation being inserted. */
export async function addClaimLocalization(items: { claim: string; new_locale: string; new_claim: string }[], source_locale: string): Promise<void> {
    try {
        console.log(`[addClaimLocalization] Sending ${items.length} item(s) source_locale=${source_locale}:`, items.map(i => ({ claim: i.claim.slice(0, 40), new_locale: i.new_locale })));
        const res = await fetch(`https://insert-claim-locale.michael-pouget01.workers.dev/?locale=${encodeURIComponent(source_locale)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(items)
        });
        const body = await res.text();
        if (!res.ok) console.error('[addClaimLocalization] error:', res.status, body);
        else console.log('[addClaimLocalization] success:', body.slice(0, 200));
    } catch (err) {
        console.error('[addClaimLocalization] fetch error:', err);
    }
}

/** Insert locale-keyed highlight ranges into tweet_claims via the insert-highlight-locale worker. */
async function addTweetClaimHighlight(
    items: { tweet_hash: string; claim: string; highlight_locale: string; highlight_range: number[] }[],
    source_locale: string
): Promise<void> {
    try {
        console.log(`[addTweetClaimHighlight] Persisting ${items.length} highlight(s) source_locale=${source_locale}:`, items.map(i => `${i.claim.slice(0, 30)}... [${i.highlight_range.join(',')}]`));
        const res = await fetch(`https://insert-highlight-locale.michael-pouget01.workers.dev/?source_locale=${encodeURIComponent(source_locale)}&_=${Date.now()}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(items)
        });
        if (!res.ok) {
            console.error('[addTweetClaimHighlight] error:', await res.text());
            return;
        }
        const body = await res.json();
        console.log(`[addTweetClaimHighlight] Persisted ${items.length} highlight(s) OK`, body);
        if (body.matched_and_updated_rows === 0) {
            console.warn('[addTweetClaimHighlight] Worker reported 0 updated rows — highlights may not have been persisted. Check that claim text matches the stored claim exactly.');
        }
    } catch (err) {
        console.error('[addTweetClaimHighlight] fetch error:', err);
    }
}

/**
 * Call the highlight-claims worker to determine character ranges of rewritten claims
 * within the translated tweet text. Returns [substring, claim_index][] pairs.
 * The caller must map these to [start, end] character ranges via indexOf.
 */
async function* highlightClaims(
    tweetText: string,
    rewrittenClaims: string[]
): AsyncGenerator<string> {
    const res = await fetch('https://highlight-claims.michael-pouget01.workers.dev/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tweet_text: tweetText, rewritten_claims: rewrittenClaims })
    });
    if (!res.ok || !res.body) {
        console.error('[highlightClaims] error:', res.status, await res.text());
        return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let accumulatedText = '';

    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data: ')) continue;
            const data = trimmed.slice(6);
            if (data === '[DONE]') continue;
            try {
                const json = JSON.parse(data);
                const content = json.choices?.[0]?.delta?.content
                    ?? json.candidates?.[0]?.content?.parts?.[0]?.text;
                if (content) accumulatedText += content;
            } catch {
                accumulatedText += data;
            }
        }
    }

    // Remaining buffer
    const remaining = buffer.trim();
    if (remaining.startsWith('data: ')) {
        const data = remaining.slice(6);
        if (data !== '[DONE]') {
            try {
                const json = JSON.parse(data);
                const content = json.choices?.[0]?.delta?.content
                    ?? json.candidates?.[0]?.content?.parts?.[0]?.text;
                if (content) accumulatedText += content;
            } catch {
                accumulatedText += data;
            }
        }
    }

    if (accumulatedText) {
        yield accumulatedText;
    }
}

/**
 * Parse the highlight-claims worker SSE output into [substring, claimIndex] pairs.
 */
function parseHighlightClaimsOutput(rawJson: string): [string, number][] {
    // Strip markdown code fences if present
    let cleaned = rawJson.replace(/```(?:json)?\s*\n?/gi, '').trim();
    try {
        const parsed = JSON.parse(cleaned);
        if (Array.isArray(parsed)) {
            return parsed;
        }
        return [];
    } catch {
        return [];
    }
}


export type BackgroundUpdateCallback = (classification: Classification) => void;

/**
 * Fire-and-forget: translate reasoning text from sourceLocale to targetLocale,
 * then simultaneously inject (via callback) and persist (via DB).
 */
export async function backgroundTranslate(
    claimText: string,
    dbClaimText: string,
    reasoningText: string,
    sourceLocale: string,
    targetLocale: string,
    researchCache: Map<string, { confidence: number; veracity: number; reasoning: string; reasoningLocale?: string; sources?: Source[]; dbClaimText?: string; embedding?: number[]; lastClassification?: string; freshlyResearched?: boolean; veracity_change_duration?: string }>,
    classification: Classification,
    onUpdate?: BackgroundUpdateCallback
): Promise<void> {
    if (!reasoningText || sourceLocale === targetLocale) return;
    console.log(`[backgroundTranslate] Translating "${claimText.slice(0, 40)}..." from ${sourceLocale} to ${targetLocale}`);

    // Capture the last_classification timestamp at scheduling time so a concurrent
    // re-research doesn't make us overwrite fresher reasoning with a stale translation.
    const lastClassification = researchCache.get(claimText)?.lastClassification;

    let finalTranslated = '';
    const targetClaimKey = dbClaimText || claimText;

    const onPartial = (partial: string) => {
        // Stream partial translation into the UI. Don't persist to DB yet.
        const cached = researchCache.get(claimText);
        const updatedClaims = classification.claims?.map(cl => {
            if ((cl.dbClaimText ?? cl.text) === targetClaimKey) {
                const r = cached ?? { confidence: cl.confidence, veracity: cl.veracity, sources: cl.sources };
                return { ...cl, note: partial, confidence: r.confidence, veracity: r.veracity, reasoningLocale: targetLocale, sources: r.sources ?? cl.sources };
            }
            return cl;
        }) ?? null;
        if (onUpdate) {
            onUpdate({ ...classification, claims: updatedClaims });
        }
    };

    const translated = await translateText(reasoningText, targetLocale, onPartial);
    if (!translated || translated === reasoningText) return;
    finalTranslated = translated;
    console.log(`[backgroundTranslate] Translated OK: "${finalTranslated.slice(0, 80)}"`);

    // Update cache with final translation
    const cached = researchCache.get(claimText);
    if (cached) {
        researchCache.set(claimText, { ...cached, reasoning: finalTranslated, reasoningLocale: targetLocale });
    }

    // Persist final translation to DB and send one final UI update (in case the
    // last partial didn't match the trimmed final text).
    console.log(`[backgroundTranslate] Persisting reasoning locale ${targetLocale} for claim "${dbClaimText.slice(0, 40)}..." sourceLocale=${sourceLocale} timestamp=${lastClassification ?? 'none'}`);
    await Promise.all([
        insertReasoningLocale(dbClaimText, { [targetLocale]: finalTranslated }, lastClassification, sourceLocale),
        new Promise<void>(resolve => {
            onPartial(finalTranslated);
            resolve();
        })
    ]);
}

/**
 * Fire-and-forget: translate a rewritten claim text from sourceLocale to targetLocale,
 * then simultaneously inject (via callback) and persist (via DB).
 */
export async function backgroundTranslateClaim(
    dbClaimText: string,
    claimRewritten: string,
    sourceLocale: string,
    targetLocale: string,
    classification: Classification,
    researchCache: Map<string, { confidence: number; veracity: number; reasoning: string; reasoningLocale?: string; sources?: Source[]; dbClaimText?: string; embedding?: number[]; lastClassification?: string; freshlyResearched?: boolean; veracity_change_duration?: string }>,
    onUpdate?: BackgroundUpdateCallback
): Promise<void> {
    if (sourceLocale === targetLocale || !dbClaimText) return;
    console.log(`[backgroundTranslateClaim] Translating claim "${dbClaimText.slice(0, 40)}..." from ${sourceLocale} to ${targetLocale}`);

    let finalTranslated = '';

    const onPartial = (partial: string) => {
        // Stream partial claim translation into the UI. Don't persist to DB yet.
        const matchingClaim = classification.claims?.find(cl => cl.dbClaimText === dbClaimText);
        const cacheKey = matchingClaim?.text ?? dbClaimText;
        const cached = researchCache.get(cacheKey);
        const updatedClaims = classification.claims?.map(cl => {
            if (cl.dbClaimText === dbClaimText) {
                const r = cached ?? { confidence: cl.confidence, veracity: cl.veracity, reasoning: cl.note, sources: cl.sources };
                const { verdict } = formatVerdict(r.confidence ?? 0, r.veracity ?? 0, r.reasoning ?? '');
                return { ...cl, rewritten: partial, text: cl.text, verdict: verdict ?? cl.verdict, confidence: r.confidence, veracity: r.veracity, sources: r.sources ?? cl.sources, claimLocale: targetLocale };
            }
            return cl;
        }) ?? null;
        if (onUpdate) {
            onUpdate({ ...classification, claims: updatedClaims });
        }
    };

    const translated = await translateText(claimRewritten, targetLocale, onPartial);
    if (!translated || translated === claimRewritten) return;
    finalTranslated = translated;
    console.log(`[backgroundTranslateClaim] Translated OK: "${finalTranslated.slice(0, 80)}"`);

    // Persist final translation to DB and send one final UI update.
    console.log(`[backgroundTranslateClaim] Persisting claim locale ${targetLocale} for "${dbClaimText.slice(0, 40)}..." sourceLocale=${sourceLocale}`);
    await Promise.all([
        addClaimLocalization([
            { claim: dbClaimText, new_locale: targetLocale, new_claim: finalTranslated }
        ], sourceLocale),
        new Promise<void>(resolve => {
            onPartial(finalTranslated);
            resolve();
        })
    ]);
}

/**
 * Fire-and-forget: determine highlight ranges for the translated tweet text,
 * then inject (via callback) and persist (via DB).
 */
export async function backgroundHighlightRange(
    tweetHash: string,
    tweetText: string,              // tweet text to find highlights in
    dbClaims: { claim: string; rewritten: string; dbClaimText?: string; sourceLocale?: string }[],
    sourceLocale: string,            // fallback locale the canonical claims are stored under
    highlightLocale: string,         // locale of the tweet text (and thus the highlight key)
    classification: Classification,
    onUpdate?: BackgroundUpdateCallback
): Promise<void> {
    if (dbClaims.length === 0) return;
    console.log(`[backgroundHighlightRange] Finding highlights on translated text for locale ${highlightLocale}, tweetText length=${tweetText.length}`);
    console.log(`[backgroundHighlightRange] Input claims:`, dbClaims.map(dc => ({ claim: dc.claim.slice(0, 50), rewritten: dc.rewritten?.slice(0, 50) })));

    // Collect rewritten claims from DB results
    const rewrittenClaims = dbClaims.map(dc => dc.rewritten ?? dc.claim);
    if (rewrittenClaims.length === 0) return;

    // Try the worker up to 2 times and keep the result with the most valid ranges.
    // LLM alignment can be non-deterministic; a retry often finds ranges the first
    // attempt missed.
    let bestPairs: [string, number][] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
        let fullResult = '';
        for await (const chunk of highlightClaims(tweetText, rewrittenClaims)) {
            fullResult += chunk;
        }
        console.log(`[backgroundHighlightRange] attempt ${attempt + 1}: raw worker output (${fullResult.length} chars): ${fullResult.slice(0, 400)}`);
        const pairs: [string, number][] = parseHighlightClaimsOutput(fullResult);
        console.log(`[backgroundHighlightRange] attempt ${attempt + 1}: worker returned ${pairs.length} pairs`);
        if (pairs.length > bestPairs.length) {
            bestPairs = pairs;
        }
        if (bestPairs.length >= dbClaims.length) break;
    }

    // The highlight-claims worker returns 1-based claim indices, but we use
    // 0-based arrays everywhere else. Convert them here.
    const pairs: [string, number][] = bestPairs.map(([substring, claimIndex]) => [substring, claimIndex - 1]);
    console.log(`[backgroundHighlightRange] Using ${pairs.length} pairs after retries`);
    for (const [substring, claimIndex] of pairs) {
        console.log(`[backgroundHighlightRange] pair (0-based): claimIndex=${claimIndex}, substring="${substring.slice(0, 60)}..."`);
    }

    const highlightItems: { tweet_hash: string; claim: string; highlight_locale: string; highlight_range: number[]; sourceLocale: string }[] = [];
    // Map by claim INDEX rather than by text. dbClaims and classification.claims
    // are in the same order (localizeHighlights guarantees this), but the text
    // keys can differ: for freshly classified tweets dbClaimText is the
    // preclassification text while allDbClaims uses rewritten/text. Index mapping
    // avoids missing highlights because of a text-key mismatch.
    const claimHighlightsByIndex = new Map<number, [number, number]>();

    for (const [substring, claimIndex] of pairs) {
        if (claimIndex < 0 || claimIndex >= dbClaims.length) {
            console.warn(`[backgroundHighlightRange] Skipping out-of-bounds claimIndex=${claimIndex}, dbClaims.length=${dbClaims.length}`);
            continue;
        }
        const dbClaim = dbClaims[claimIndex];

        // Find the substring in the translated text with CJK-friendly matching
        let start = tweetText.indexOf(substring);
        let matched = substring;
        if (start === -1) {
            // Try stripping spaces only
            const textNS = tweetText.replace(/\s+/g, '');
            const subNS = substring.replace(/\s+/g, '');
            const sidx = textNS.indexOf(subNS);
            if (sidx !== -1) {
                let ti = 0, si = 0;
                while (si < sidx) { if (tweetText[ti] !== ' ') si++; ti++; }
                start = ti;
                let end = ti, ci = 0;
                while (ci < subNS.length && end < tweetText.length) {
                    if (tweetText[end] !== ' ') ci++;
                    end++;
                }
                highlightItems.push({ tweet_hash: tweetHash, claim: dbClaim.dbClaimText ?? dbClaim.claim, highlight_locale: highlightLocale, highlight_range: [start, end], sourceLocale: dbClaim.sourceLocale ?? sourceLocale });
                claimHighlightsByIndex.set(claimIndex, [start, end]);
                continue;
            }
            // Try stripping punctuation too
            const punct = /[\s,.\-–—!?;:'"()【】「」『』\[\]（）《》〈〉、，。！？；：""''．]/g;
            const textP = tweetText.replace(punct, '');
            const subP = substring.replace(punct, '');
            const pidx = textP.indexOf(subP);
            if (pidx !== -1) {
                let ti = 0, pi = 0;
                while (pi < pidx && ti < tweetText.length) {
                    if (!punct.test(tweetText[ti])) pi++;
                    ti++;
                }
                start = ti;
                let end = ti, ci = 0;
                while (ci < subP.length && end < tweetText.length) {
                    if (!punct.test(tweetText[end])) ci++;
                    end++;
                }
                highlightItems.push({ tweet_hash: tweetHash, claim: dbClaim.dbClaimText ?? dbClaim.claim, highlight_locale: highlightLocale, highlight_range: [start, end], sourceLocale: dbClaim.sourceLocale ?? sourceLocale });
                claimHighlightsByIndex.set(claimIndex, [start, end]);
                continue;
            }
            console.warn(`[backgroundHighlightRange] Could not find substring in text: "${substring.slice(0, 40)}..."`);
            continue;
        }
        highlightItems.push({ tweet_hash: tweetHash, claim: dbClaim.dbClaimText ?? dbClaim.claim, highlight_locale: highlightLocale, highlight_range: [start, start + matched.length], sourceLocale: dbClaim.sourceLocale ?? sourceLocale });
        claimHighlightsByIndex.set(claimIndex, [start, start + matched.length]);
    }

    console.log(`[backgroundHighlightRange] ${highlightItems.length} highlight item(s) to persist:`, highlightItems.map(i => ({ claim: i.claim.slice(0, 40), locale: i.highlight_locale, range: i.highlight_range })));

    if (highlightItems.length === 0) {
        console.warn('[backgroundHighlightRange] No valid highlight ranges found');
        return;
    }

    // Update classification claims with the new highlight ranges.
    // classification.claims is in the same order as dbClaims, so we map by index.
    const updatedClaims = classification.claims?.map((cl, idx) => {
        const range = claimHighlightsByIndex.get(idx);
        if (!range) return cl;
        const existingHl = cl.highlight ?? {};
        return { ...cl, highlight: { ...existingHl, [highlightLocale]: range } };
    }) ?? null;

    // Inject updated classification (translated text highlights) and persist in parallel.
    // Group items by their actual claim storage locale because the highlight worker's
    // RPC matches c.claim @> jsonb_build_object(source_locale, claim_text).
    const itemsBySourceLocale = new Map<string, typeof highlightItems>();
    for (const item of highlightItems) {
      const sl = item.sourceLocale;
      if (!itemsBySourceLocale.has(sl)) itemsBySourceLocale.set(sl, []);
      itemsBySourceLocale.get(sl)!.push(item);
    }

    try {
        await Promise.all([
            ...Array.from(itemsBySourceLocale.entries()).map(([sl, items]) =>
                addTweetClaimHighlight(items, sl)
            ),
            new Promise<void>(resolve => {
                if (onUpdate) {
                    onUpdate({ ...classification, claims: updatedClaims });
                }
                resolve();
            })
        ]);
        console.log(`[backgroundHighlightRange] Completed persistence for ${highlightItems.length} highlight(s)`);
    } catch (e) {
        console.error('[backgroundHighlightRange] Error during persistence:', e);
    }
}

type ResearchUpdate =
    | { kind: 'partial', partialText: string, confidence?: number, veracity?: number }
    | { kind: 'complete', data: { mainResult: { confidence: number, veracity: number, reasoning: string, veracity_change_duration?: string, sources?: Source[] } } };

/**
 * Try to extract a JSON object from arbitrary text that may have markdown wrapping,
 * leading/trailing text, or code fences around it.
 * Returns the parsed object or null.
 */
function extractJsonFromText(text: string): any | null {
    // Strip markdown code fences: ```json ... ``` or ``` ... ```
    let cleaned = text.replace(/```(?:json)?\s*\n?/gi, '').trim();

    // Find the first '{' and last '}' to isolate the outermost JSON object
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;

    cleaned = cleaned.substring(firstBrace, lastBrace + 1);

    try {
        return JSON.parse(cleaned);
    } catch {
        // If the reasoning field contains unescaped characters, try to be more lenient
        // by finding the structure via regex
        return null;
    }
}
/** Apply a regex replacement only within contiguous word-character runs longer than `minLength`.
 *  This prevents false positives from dictionary-based patterns matching inside valid words
 *  (e.g., "(at)(a)" matching inside "data" → "dat a").
 */


/**
 * Extract fields from a malformed JSON-like string using regex.
 * Returns { mainResult, affectedResults } or null.
 */
function extractResearchFromRegex(text: string): { mainResult: any, affectedResults: any[] } | null {
    // Remove code fences
    const cleaned = text.replace(/```(?:json)?\s*\n?/gi, '').trim();

    // Try to extract mainResult fields. The worker no longer returns a claim field,
    // so we only extract numeric/reasoning/source fields.
    const confMatch = cleaned.match(/"confidence"\s*:\s*(-?\d+\.?\d*)/);
    const verMatch = cleaned.match(/"veracity"\s*:\s*(-?\d+\.?\d*)/);
    const reasonMatch = cleaned.match(/"reasoning"\s*:\s*"((?:[^"\\]|\\.)*)/);
    const veracityChangeDurationMatch = cleaned.match(/"veracity_change_duration"\s*:\s*"((?:[^"\\]|\\.)*)"/);

    if (!confMatch || !verMatch) return null;

    const mainResult: any = {};
    if (confMatch) mainResult.confidence = parseFloat(confMatch[1]);
    if (verMatch) mainResult.veracity = parseFloat(verMatch[1]);
    if (reasonMatch) mainResult.reasoning = reasonMatch[1];
    if (veracityChangeDurationMatch) mainResult.veracity_change_duration = veracityChangeDurationMatch[1];

    // Extract sources: can be "sources": ["url1"], [{"url":"..."}], or {"title":"url"}
    const arraySourcesMatch = cleaned.match(/"sources"\s*:\s*\[([^\]]*)\]/);
    const dictSourcesMatch = cleaned.match(/"sources"\s*:\s*\{([^}]*)\}/);
    if (arraySourcesMatch) {
        const rawContent = arraySourcesMatch[1].trim();
        // Try object form first: {"url": "..." , "domain": "..."}
        const objectMatches = rawContent.match(/\{"url"\s*:\s*"((?:[^"\\]|\\.)*)"(?:\s*,\s*"domain"\s*:\s*"((?:[^"\\]|\\.)*)")?\s*\}/g);
        if (objectMatches) {
            mainResult.sources = objectMatches.map(o => {
                const url = o.match(/"url"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1] ?? '';
                const domain = o.match(/"domain"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1] ?? '';
                return { url, domain };
            });
        } else {
            // Fallback to plain string URLs
            const rawUrls = rawContent.match(/"((?:[^"\\]|\\.)*)"/g);
            if (rawUrls) {
                mainResult.sources = rawUrls.map(u => u.replace(/^"|"$/g, ''));
            }
        }
    } else if (dictSourcesMatch) {
        // Dictionary form from classify worker: {"url": "title", ...}
        const rawContent = dictSourcesMatch[1].trim();
        const pairMatches = rawContent.match(/"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g);
        if (pairMatches) {
            mainResult.sources = pairMatches.map(pair => {
                const m = pair.match(/"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"/)!;
                const key = m[1].replace(/\\"/g, '"');
                const val = m[2].replace(/\\"/g, '"');
                // New format: URL keys, title values
                if (key.match(/^https?:\/\//)) {
                    return { url: key, title: val };
                }
                // Legacy: title keys, URL values
                return { title: key, url: val };
            });
        }
    }

    if (mainResult.confidence === undefined) mainResult.confidence = 0;
    if (mainResult.veracity === undefined) mainResult.veracity = 0;

    return { mainResult, affectedResults: [] };
}

/** Normalize raw sources from the model into Source[].
 *  Supports:
 *    - Dictionary {url: title} (classify worker output)
 *    - Dictionary {title: url} (legacy)
 *    - Array of strings or {url, title, domain} objects
 *  Heuristic: if a dictionary key looks like an HTTP URL, treat it as {url: title}. */
export function normalizeSources(sources: unknown): Source[] {
  if (!sources) return [];
  if (typeof sources === 'object' && !Array.isArray(sources)) {
    const result: Source[] = [];
    for (const [key, val] of Object.entries(sources as Record<string, unknown>)) {
      if (typeof val === 'string') {
        if (key.match(/^https?:\/\//)) {
          result.push({ url: key, title: val });
        } else {
          result.push({ title: key, url: val });
        }
      }
    }
    return result;
  }
  if (!Array.isArray(sources)) return [];
  const result: Source[] = [];
  for (const s of sources) {
    if (typeof s === 'string') {
      result.push({ url: s, title: extractDomainFromUrl(s) });
    } else if (typeof s === 'object' && s !== null) {
      const obj = s as Record<string, unknown>;
      if (obj.url || obj.title || obj.domain) {
        result.push({
          url: obj.url as string | undefined,
          title: (obj.title as string | undefined) ?? (obj.domain as string | undefined)
        });
      }
    }
  }
  return result;
}

/** Extract a human-readable domain from a URL string (e.g. "https://www.xinhua.com/..." → "xinhua.com"). */
function extractDomainFromUrl(urlStr: string): string {
  try {
    return new URL(urlStr).hostname.replace(/^www\./, '');
  } catch {
    return urlStr;
  }
}

/** Deduplicate sources by URL, keeping the first occurrence. */
function deduplicateSources(sources: Source[] | undefined): Source[] {
  if (!sources) return [];
  const seen = new Set<string>();
  return sources.filter(s => {
    const key = s.url ?? s.title ?? '';
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

type AffectedClaimContext = {
    claim: string;
    reasoning: any;
    confidence?: number;
    veracity?: number;
    sources?: Source[];
    veracity_change_duration?: string;
};

async function* streamResearch(mainClaim: string, affectedClaims: AffectedClaimContext[], locale?: string, tweetUrls?: string[]): AsyncGenerator<ResearchUpdate> {
    const effectiveLocale = locale ?? getUILanguage();
    const payload: any = { mainClaim, affectedClaims, locale: effectiveLocale };
    if (tweetUrls && tweetUrls.length > 0) payload.sources = tweetUrls;
    const res = await fetch('https://classify-tweets.michael-pouget01.workers.dev/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    if (!res.ok || !res.body) {
        console.error('Research error:', res.status, await res.text());
        return;
    }

    // Stream mode from worker: "append" (left-to-right tokens) or "replace" (diffusion snapshots).
    const streamMode = res.headers.get('X-Stream-Mode') || 'append';
    console.log(`[streamResearch] streamMode=${streamMode} for "${mainClaim.slice(0, 40)}..."`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    let accumulatedText = '';
    let lastYieldedText = '';
    let lastGroundingMetadata: { groundingChunks?: { web: { uri: string; title: string } }[]; webSearchQueries?: string[]; groundingSupports?: any[] } | null = null;
    const reasoningRegex = /"reasoning"\s*:\s*"((?:[^"\\]|\\.)*)/;

    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            sseBuffer += decoder.decode(value, { stream: true });

            // Process complete SSE events from the buffer
            const lines = sseBuffer.split('\n');
            sseBuffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data: ')) continue;
                const jsonData = trimmed.slice(6);
                if (jsonData === '[DONE]') continue;
                try {
                    const json = JSON.parse(jsonData);
                    // candidates format (various model providers)
                    const delta = json.candidates?.[0]?.content?.parts?.[0]?.text;
                    // OpenAI-compatible format
                    const openaiDelta = json.choices?.[0]?.delta?.content;
                    const chunk = delta ?? openaiDelta;
                    if (chunk) {
                        if (streamMode === 'replace') {
                            // Diffusion/refinement snapshots: each chunk is the full text so far.
                            accumulatedText = chunk;
                        } else {
                            // Default append mode: left-to-right token streaming.
                            accumulatedText += chunk;
                        }
                    }
                    // Capture grounding metadata — typically present in the final candidate event
                    const meta = json.candidates?.[0]?.groundingMetadata;
                    if (meta) {
                        lastGroundingMetadata = meta;
                        console.debug(`[streamResearch] CAPTURED grounding metadata:`, JSON.stringify(meta).slice(0, 300));
                    }
                } catch {
                    console.debug(`[streamResearch] Skipping unparseable SSE line: "${trimmed.slice(0, 200)}"`);
                }
            }

            // Extract reasoning text from the accumulated JSON so far and yield if it grew.
    // The worker's field order can vary, so extract confidence/veracity independently.
            const confMatch = accumulatedText.match(/"confidence"\s*:\s*(-?\d+\.?\d*)/);
            const verMatch = accumulatedText.match(/"veracity"\s*:\s*(-?\d+\.?\d*)/);
            const reasoningMatch = accumulatedText.match(reasoningRegex);
            const currentText = reasoningMatch ? reasoningMatch[1] : '';
            const currentConfidence = confMatch ? parseFloat(confMatch[1]) : undefined;
            const currentVeracity = verMatch ? parseFloat(verMatch[1]) : undefined;
            if ((currentText && currentText !== lastYieldedText) || (currentConfidence !== undefined && currentVeracity !== undefined)) {
                lastYieldedText = currentText;
                yield {
                    kind: 'partial',
                    partialText: currentText,
                    confidence: currentConfidence,
                    veracity: currentVeracity
                };
            }
        }
    } finally {
        reader.releaseLock();
    }

    // Process any remaining line in the SSE buffer
    const remaining = sseBuffer.trim();
    if (remaining.startsWith('data: ')) {
        const jsonData = remaining.slice(6);
        if (jsonData === '[DONE]') { /* skip */ }
        else try {
            const json = JSON.parse(jsonData);
            const delta = json.candidates?.[0]?.content?.parts?.[0]?.text;
            const openaiDelta = json.choices?.[0]?.delta?.content;
            const chunk = delta ?? openaiDelta;
            if (chunk) {
                if (streamMode === 'replace') accumulatedText = chunk;
                else accumulatedText += chunk;
            }
            const meta = json.candidates?.[0]?.groundingMetadata;
            if (meta) lastGroundingMetadata = meta;
        } catch {}
    }

    // If the reasoning text grew from the last partial, yield it one more time
    const finalMatch = accumulatedText.match(reasoningRegex);
    const finalText = finalMatch ? finalMatch[1] : '';
    if (finalText && finalText !== lastYieldedText) {
        yield { kind: 'partial', partialText: finalText };
    }

    console.log(`[streamResearch] Accumulated ${accumulatedText.length} chars for "${mainClaim.slice(0, 40)}..."`);
    if (accumulatedText && !/\s/.test(accumulatedText)) {
        console.warn(`[streamResearch] SPACE-LOST in RAW accumulated text! First 120: "${accumulatedText.slice(0, 120)}"`);
    } else if (/\s/.test(accumulatedText)) {
        const spaceCount = (accumulatedText.match(/\s/g) || []).length;
        console.log(`[streamResearch] SPACE-OK in accumulated text: ${spaceCount} spaces found. First 120: "${accumulatedText.slice(0, 120)}"`);
    }

    // Derive sources from grounding metadata
    console.debug(`[streamResearch] grounding metadata:`, JSON.stringify(lastGroundingMetadata));
    const rawChunks = lastGroundingMetadata?.groundingChunks ?? [];
    console.debug(`[streamResearch] groundingChunks count: ${rawChunks.length}`);
    const sourcesFromGrounding: Source[] = rawChunks
        .map(c => {
            const s = { title: c.web?.title, url: c.web?.uri };
            console.debug(`[streamResearch] grounding chunk: title="${s.title}" url="${s.url}"`);
            return s;
        })
        .filter(s => s.title || s.url) ?? [];
    // Strategy 1: Try direct JSON extraction (handles markdown fences, extra text)
    const parsed = extractJsonFromText(accumulatedText);
    console.debug(`[streamResearch] derived ${sourcesFromGrounding.length} sources from grounding metadata, parsed=${JSON.stringify(parsed?.mainResult?.sources)}`);
    if (parsed && parsed.mainResult) {
        console.log(`[streamResearch] JSON extraction OK: mainResult.confidence=${parsed.mainResult.confidence} sources=${sourcesFromGrounding.length}`);
        const reasonText = parsed.mainResult.reasoning ?? '';
        if (reasonText && !/\s/.test(reasonText)) {
            console.warn(`[streamResearch] SPACE-LOST in reasoning (JSON): "${reasonText.slice(0, 80)}"`);
        } else if (reasonText) {
            console.log(`[streamResearch] SPACE-OK in reasoning (JSON): "${reasonText.slice(0, 80)}"`);
        }
        const modelSources = normalizeSources(parsed.mainResult.sources);
        const mainSources = deduplicateSources(modelSources.length > 0 ? modelSources : sourcesFromGrounding);
        yield {
            kind: 'complete',
            data: {
                mainResult: { ...parsed.mainResult, sources: mainSources }
            }
        };
        return;
    }

    // Strategy 2: Regex extraction for malformed JSON
    const regexResult = extractResearchFromRegex(accumulatedText);
    if (regexResult) {
        console.log(`[streamResearch] Regex extraction OK: mainResult.confidence=${regexResult.mainResult.confidence}`);
        const reasonText = regexResult.mainResult.reasoning ?? '';
        if (reasonText && !/\s/.test(reasonText)) {
            console.warn(`[streamResearch] SPACE-LOST in reasoning (regex): "${reasonText.slice(0, 80)}"`);
        } else if (reasonText) {
            console.log(`[streamResearch] SPACE-OK in reasoning (regex): "${reasonText.slice(0, 80)}"`);
        }
        const regexModelSources = normalizeSources(regexResult.mainResult.sources);
        const regexSources = deduplicateSources(regexModelSources.length > 0 ? regexModelSources : sourcesFromGrounding);
        yield {
            kind: 'complete',
            data: {
                mainResult: { ...regexResult.mainResult, sources: regexSources }
            }
        };
        return;
    }

    console.warn(`[streamResearch] All extraction methods failed. Text (first 200): "${accumulatedText.slice(0, 200)}"`);
}

/** Extract a plain claim text string from a locale-keyed JSONB claim object
 *  (e.g. {"en": "text"}) or a plain string. Prefers the requested locale,
 *  then the base language, then any available text. */
function extractPlainClaimText(claim: unknown, locale: string): string {
    if (typeof claim === 'string') return claim;
    if (claim && typeof claim === 'object' && !Array.isArray(claim)) {
        const obj = claim as Record<string, unknown>;
        const exact = obj[locale];
        if (typeof exact === 'string') return exact;
        const base = locale.split('-')[0];
        for (const [key, val] of Object.entries(obj)) {
            if (typeof val === 'string' && (key === base || key.startsWith(base + '-'))) {
                return val;
            }
        }
        const first = Object.values(obj).find(v => typeof v === 'string');
        if (first) return first as string;
    }
    return '';
}

/** Extract the canonical (storage-locale) claim text from a locale-keyed JSONB
 *  claim object, or return a plain string as-is. */
function extractCanonicalClaimText(claim: unknown): string {
    if (typeof claim === 'string') return claim;
    if (claim && typeof claim === 'object' && !Array.isArray(claim)) {
        const first = Object.values(claim as Record<string, unknown>).find(v => typeof v === 'string');
        if (first) return first as string;
    }
    return '';
}

async function upsertClaims(items: any[], locale?: string): Promise<void> {
    const effectiveLocale = locale ?? getUILanguage();
    // The upsert-claims worker keys plain-string claims by the locale query param.
    // Without it, the worker defaults to "en", causing duplicate rows when
    // upsertTweetPipeline stores the same text under the UI locale (e.g. "fr").
    const url = new URL('https://upsert-claims.michael-pouget01.workers.dev/');
    url.searchParams.set('locale', effectiveLocale);

    // Send each item individually to avoid Supabase "All object keys must match" error
    // when items have different value shapes (e.g. embedding array vs null)
    for (const item of items) {
        const claimText = extractPlainClaimText(item.claim, effectiveLocale) || String(item.claim ?? '');

        // The upsert-claims worker expects a plain-string claim and uses the
        // ?locale query param to know which JSONB key to store it under.

        // Wrap plain-string reasoning in locale JSONB {"fr": "text"} for the DB
        const reasoningPayload = typeof item.reasoning === 'string'
            ? { [effectiveLocale]: item.reasoning }
            : (item.reasoning ?? { [effectiveLocale]: '' });

        const wrappedItem = { ...item, claim: claimText, reasoning: reasoningPayload };
        const reasonCheck = item.reasoning ? (/\s/.test(String(item.reasoning)) ? 'HAS_SPACES' : 'NO_SPACES') : 'NO_REASONING';
        console.log(`[upsertClaims] Sending: "${claimText}" reasoning=${reasonCheck} locale=${effectiveLocale} emb=${item.embedding ? 'yes' : 'no'}`);
        const res = await fetch(url.toString(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify([wrappedItem])
        });
        const body = await res.text();
        if (!res.ok) {
            // 23505 = unique violation. upsertTweetPipeline already inserted this
            // claim under the same locale key, so this race is expected and harmless.
            const isDuplicate = body.includes('"23505"') || body.includes('duplicate key value violates unique constraint');
            if (isDuplicate) {
                console.log(`[upsertClaims] Claim already exists (upsertTweetPipeline won the race) for "${claimText}"`);
            } else {
                console.error(`[upsertClaims] Error for "${claimText}":`, body);
            }
        } else {
            console.log(`[upsertClaims] Success for "${claimText}": status=${res.status}`);
        }
    }
}

// ---- Streaming helpers (preclassify) ----

async function* processWorkerStream(input: any, worker: string): AsyncGenerator<{ text: string; streamMode: string }> {
    console.log(`Sending request to worker: ${worker}`);
    const response = await fetch(`https://${worker}.michael-pouget01.workers.dev/`, {
        method: 'POST',
        body: JSON.stringify(input),
        headers: { 'Content-Type': 'application/json' }
    });
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Worker ${worker} returned ${response.status}: ${text.slice(0, 200)}`);
    }
    if (!response.body) { console.log("No response body."); return; }

    const streamMode = response.headers.get('X-Stream-Mode') || 'append';
    console.log(`[processWorkerStream] worker=${worker} streamMode=${streamMode}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    console.log(`Processing response from worker: ${worker}`);
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        let lines = buffer.split("\n");

        buffer = lines.pop() || "";

        for (const line of lines)
            yield* handleLine(line);
    }

    if (buffer.trim())
        yield* handleLine(buffer);

    function* handleLine(line: string) {
        const trimmed = line.trim();

        if (!trimmed) {
            console.warn(`Unexpected empty line: ${trimmed}`);
            return;
        }

        if (!trimmed.startsWith("data: ")) {
            console.warn(`Unexpected non-data line: ${trimmed}`);
            return;
        }

        const jsonString = trimmed.replace("data: ", "");

        // OpenAI-compatible streaming ends with "[DONE]"
        if (jsonString === "[DONE]") return;

        try {
            const json = JSON.parse(jsonString);
            // candidates format (various model providers)
            const delta = json.candidates?.[0]?.content?.parts?.[0]?.text;
            // OpenAI-compatible format
            const openaiDelta = json.choices?.[0]?.delta?.content;
            const chunk = delta ?? openaiDelta;

            if (chunk) {
                console.log("Yielding chunk:", chunk);
                yield { text: chunk, streamMode };
            }
        } catch (e) {
            console.error("Error parsing chunk:", e);
        }
    }
}

async function* processChunks<T = Classification>(response: AsyncGenerator<{ text: string; streamMode: string }>): AsyncGenerator<T> {
    let buffer = '';
    let depth = 0;
    let inString = false;
    let escape = false;
    let objectStart = -1;
    let currentMode = 'append';

    for await (const chunk of response) {
        const text = chunk.text;
        const mode = chunk.streamMode;
        if (mode !== currentMode) {
            currentMode = mode;
            console.log(`[processChunks] streamMode switched to ${mode}`);
        }

        // Diffusion / refinement snapshots: each chunk is a complete JSON document.
        // Reset the parser buffer and parse the snapshot directly.
        if (currentMode === 'replace') {
            buffer = text;
            depth = 0;
            inString = false;
            escape = false;
            objectStart = -1;
            // Parse the snapshot as JSON. It may be a single object or an array.
            try {
                const parsed = JSON.parse(buffer.trim());
                const items = Array.isArray(parsed) ? parsed : [parsed];
                for (const item of items) {
                    if (item && typeof item === 'object') yield item as T;
                }
            } catch {
                // If the snapshot isn't valid JSON yet, fall through and let the
                // append-style parser try to extract complete objects.
            }
            continue;
        }

        // Default append mode: stream JSON tokens left-to-right.
        for (const char of text) {
            buffer += char;

            if (escape) { escape = false; continue; }
            if (char === '\\' && inString) { escape = true; continue; }
            if (char === '"') { inString = !inString; continue; }
            if (inString) continue;

            if (char === '[' || char === '{') {
                if (char === '{' && depth === 1) objectStart = buffer.length - 1;
                depth++;
            } else if (char === ']' || char === '}') {
                depth--;
                if (char === '}' && depth === 1 && objectStart !== -1) {
                    const objStr = buffer.substring(objectStart, buffer.length);
                    try { yield JSON.parse(objStr) as T; } catch {}
                    objectStart = -1;
                    buffer = '';
                }
            }
        }
    }
}
