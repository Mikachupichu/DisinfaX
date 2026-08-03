import { MainTweet } from "../data/Tweets";
import { Classification, Claim, QuotedClassification, Source, formatVerdict, sameLanguage } from "../data/Classification";
import { supabase, ensureFreshSession } from "./supabase";

/** Build the Authorization header carrying the user's Supabase JWT. Every worker
 *  except stripe-webhook / messages now requires it (they charge the balance via an
 *  authenticated RPC). Returns an empty object when there is no session so the caller
 *  still sends a well-formed request (the worker then rejects with 401).
 *
 *  ensureFreshSession() refreshes an expired/near-expiry token first — needed because
 *  autoRefreshToken's timer doesn't survive an MV3 service-worker restart, and several
 *  of these calls often fire in parallel off one click (see its doc comment). */
export async function getAuthHeader(): Promise<Record<string, string>> {
  try {
    await ensureFreshSession();
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

/** Optional sink for surfacing worker/DB failures (e.g. 402 balance-too-low) to the
 *  UI as error notifications. The background sets this; when unset, errors are only
 *  logged (unchanged behaviour). */
let workerErrorHandler: ((message: string) => void) | null = null;
export function setWorkerErrorHandler(fn: ((message: string) => void) | null): void {
  workerErrorHandler = fn;
}
/** True when a worker/DB error message is specifically the "balance too low" (P0003 /
 *  402) rejection — as opposed to "Account suspended." (P0004) or any other failure.
 *  Only these are eligible for the queue-and-retry-once flow. */
export function isBalanceTooLowMessage(message: string): boolean {
  return typeof message === 'string' && /balance\s+is\s+too\s+low/i.test(message);
}

/** Stack of per-action balance-error interceptors. The background pushes one around a
 *  gated charging action; if a "balance too low" error surfaces while ≥1 is active, it
 *  is routed to the most-recent one (which decides retry-once vs. abandon) and NOT
 *  broadcast globally — so it's shown only when the action is actually abandoned. */
let balanceErrorInterceptors: Array<(message: string) => void> = [];
export function pushBalanceErrorInterceptor(fn: (message: string) => void): void {
  balanceErrorInterceptors.push(fn);
}
export function popBalanceErrorInterceptor(fn: (message: string) => void): void {
  const i = balanceErrorInterceptors.lastIndexOf(fn);
  if (i !== -1) balanceErrorInterceptors.splice(i, 1);
}

/** Extract a human-readable message from a worker error body ({"error": "..."}, or
 *  a "prefix: {json}" string, or plain text) and forward it to the error sink. */
function reportWorkerError(body: string): void {
  let message = body;
  const start = body.indexOf('{');
  const jsonSlice = start !== -1 ? body.slice(start) : body;
  try { const j = JSON.parse(jsonSlice); if (j && typeof j.error === 'string') message = j.error; } catch { /* plain text */ }
  // A balance-too-low error during a gated action is handled by that action (retry or
  // abandon) — suppress the global notification here so it only shows on abandonment.
  if (isBalanceTooLowMessage(message) && balanceErrorInterceptors.length > 0) {
    try { balanceErrorInterceptors[balanceErrorInterceptors.length - 1](message); } catch { /* ignore */ }
    return;
  }
  if (!workerErrorHandler) return;
  try { workerErrorHandler(message); } catch { /* ignore */ }
}

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

/** Stream a tweet's preclassification from the preclassify-tweets worker.
 *
 *  The worker now (a) returns each claim's highlight as a [start, end] character
 *  range computed server-side against the displayed tweet text, and (b) persists the
 *  tweet + claims itself (insert_tweet → embed → match/link/insert → complete
 *  preclassification). The extension only streams claims for immediate injection;
 *  the authoritative rows (with ids) arrive over the tweet's Realtime subscription.
 *
 *  @param displayTweet  the tweet as displayed (translated text when translated) —
 *                       its `text` is what the worker computes ranges against.
 *  @param hash          the tweet hash (hex) so the worker can key its DB writes.
 *  @param displayedLocale  locale of displayTweet.text (the highlight range's key).
 *  @param locale        UI locale the rewritten claims are written in. */
export async function* preClassify(
    displayTweet: MainTweet,
    hash: string,
    displayedLocale: string,
    locale?: string
): AsyncGenerator<Classification> {
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

            // `locale` (effectiveLocale) = extension locale for rewritten claims;
            // `displayedLocale` = tweet-text locale the worker must key highlight ranges by.
            const preStream = processWorkerStream({ input: displayTweet, locale: effectiveLocale, hash, displayedLocale }, 'preclassify-tweets');
            for await (const item of processChunks(preStream)) {
                if (item && typeof item === 'object' && 'text' in item && 'rewritten' in item) {
                    allClaims.push(item);
                    // Detect mode: append streams incremental claims; replace streams full
                    // snapshots (so a rewritten we already have arriving again ⇒ replace).
                    if (streamMode === null) {
                        streamMode = 'append';
                    } else if (streamMode === 'append') {
                        const rw = (item as any).rewritten;
                        if (allClaims.slice(0, -1).some((c: any) => c.rewritten === rw)) {
                            streamMode = 'replace';
                            console.log('[preClassify] detected replace mode from duplicate claim');
                        }
                    }
                    if (streamMode === 'append') {
                        yield makePreclassification(displayTweet, allClaims, displayedLocale, effectiveLocale);
                    }
                }
            }

            // Replace mode (or empty): yield the final classification once.
            yield makePreclassification(displayTweet, allClaims, displayedLocale, effectiveLocale);
            return;
        } catch (err) {
            lastError = err;
            console.error(`[preClassify] attempt ${attempt}/${maxAttempts} failed:`, err);
        }
    }

    console.error(`[preClassify] all ${maxAttempts} attempts failed, yielding empty classification`, lastError);
    if (lastError?.message) reportWorkerError(String(lastError.message));
    yield makePreclassification(displayTweet, [], displayedLocale, effectiveLocale);
}

/** Build a Classification from the worker's streamed preclassification claims.
 *  Each raw claim is `{ text: [start, end], rewritten }` (the worker no longer returns a
 *  verdict/note); we slice the verbatim substring out of the displayed text and store the
 *  range under the displayed-text locale so injection highlights it directly. Every claim
 *  is treated as "research required" (Fact-Check button) with no reasoning. */
function makePreclassification(tweet: MainTweet, allClaims: any[], displayedLocale: string, uiLocale: string): Classification {
    const tweetText = tweet.text ?? '';
    const claims: Claim[] = allClaims.map((raw: any) => {
        const range = Array.isArray(raw.text) && raw.text.length === 2 ? [Number(raw.text[0]), Number(raw.text[1])] as [number, number] : null;
        let text: string;
        let highlight: Record<string, [number, number]> | undefined;
        if (range && range[0] >= 0 && range[1] > range[0] && range[1] <= tweetText.length) {
            text = tweetText.slice(range[0], range[1]);
            highlight = { [displayedLocale]: range };
        } else {
            // Worker couldn't locate the substring ([-1,-1]); fall back to the rewritten
            // text so the claim still renders, just without an inline highlight.
            text = typeof raw.rewritten === 'string' ? raw.rewritten : '';
        }
        return {
            text,
            rewritten: typeof raw.rewritten === 'string' ? raw.rewritten : text,
            // The preclassify worker no longer classifies: every claim is "research
            // required" (shown with a Fact-Check button) and has no reasoning note.
            verdict: "research required",
            note: null,
            highlight,
            claimLocale: uiLocale,
        } as Claim;
    });
    const classification: Classification = {
        id: tweet.id,
        batchId: '',
        claims: claims.length > 0 ? claims : null,
        quoting: null,
    };
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
                // "research required" stays undefined
            }
            // Claims that still need research are presented on hold with a Fact-Check
            // button — there is no automatic classification after preclassification.
            // true/false claims (common knowledge / primary source) show directly.
            const needsResearch = verdict === "research required" || verdict === "unknown";
            return { ...cl, verdict, confidence, veracity, reclassifyOnHold: needsResearch ? true : cl.reclassifyOnHold };
        }) ?? null;

    return {
        ...c,
        claims: normalize(c.claims),
        quoting: c.quoting ? { ...c.quoting, claims: normalize(c.quoting.claims) } as QuotedClassification : null
    };
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
    // Per-call balance-error sink: when the research worker returns "balance too low",
    // it's reported HERE (bound by the caller to THIS claim's gated action) instead of
    // the global interceptor — so a 402 during a concurrent burst (Fact-Check All) is
    // attributed to the exact claim that triggered it.
    onBalanceError?: () => void
): AsyncGenerator<Classification> {
    const claimObj = classification.claims?.find(c => c.text === claimText)
        ?? classification.quoting?.claims?.find(c => c.text === claimText);
    const searchText = claimObj?.rewritten ?? claimText;
    const mainDbText = researchCache.get(claimText)?.dbClaimText ?? claimObj?.dbClaimText;
    // Pass the claim id when known so the worker updates the exact DB row; otherwise
    // it matches by text via start_claim_classification.
    const claimId = claimObj?.dbClaimId;

    // The classify-tweets worker now researches, marks the claim is_classifying, and
    // upserts the result to the DB itself. The extension no longer embeds or upserts.
    for await (const update of streamResearch(searchText, locale, tweetUrls, claimId, onBalanceError)) {
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
            researchCache.set(claimText, {
                confidence: mainResult.confidence,
                veracity: mainResult.veracity,
                reasoning: mainResult.reasoning,
                sources: mainResult.sources,
                dbClaimText: mainDbText,
                lastClassification: new Date().toISOString(),
                veracity_change_duration: mainResult.veracity_change_duration,
            });
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

/** Canonicalize text identically to the backend workers before hashing/embedding:
 *  NFKC-normalize, strip zero-width/bidi/BOM/control chars (keeping normal
 *  whitespace/newlines), collapse runs of spaces/tabs, and trim. Idempotent.
 *  MUST stay byte-identical to the workers' normalizeText so hashes match. */
export function normalizeText(text: string): string {
    if (typeof text !== 'string') return '';
    return text
        .normalize('NFKC')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u00AD\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\uFEFF]/g, '')
        .replace(/[ \t]+/g, ' ')
        .trim();
}

async function sha256Hex(s: string): Promise<string> {
    const data = new TextEncoder().encode(s);
    const buf = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Deterministic canonical serialization of a tweet AND its full context (reply
 *  thread + quotes), using ONLY original-language usernames + `fullText` (so it's
 *  language-independent). Control-char delimiters can't appear in normalized text,
 *  so there's no collision. MUST match the preclassify worker's canonicalContext. */
function canonicalContext(t: any, depth: number = 0): string {
    // Depth cap (MUST match the preclassify worker's canonicalContext): bounds
    // recursion so a hostile/deep/cyclic structure can't hang the hash. Real threads
    // are far shallower, so this never changes a legitimate hash.
    if (!t || typeof t !== 'object' || depth > 20) return '';
    let s = normalizeText(String(t.username ?? '')) + '\x1f' + normalizeText(String(t.fullText ?? ''));
    if (t.quoting && typeof t.quoting === 'object') s += '\x1e' + canonicalContext(t.quoting, depth + 1);
    if (t.replyingTo != null) {
        s += '\x1d' + (typeof t.replyingTo === 'object' ? canonicalContext(t.replyingTo, depth + 1) : normalizeText(String(t.replyingTo)));
    }
    return s;
}

/** Tweet hash = SHA-256 of the full-context canonical serialization (main tweet +
 *  thread + quotes; usernames + original text). Any change to ANY part → a
 *  different hash → a separate tweet row, so fabricated context can't pollute the
 *  real tweet. The worker re-derives this identically to verify hash matches input. */
export async function computeTweetHash(tweet: any): Promise<string> {
    return sha256Hex(canonicalContext(tweet));
}

/** Translate any text to the target locale via the translate worker (handles both reasoning and claim text).
 *  The worker streams SSE. If onPartial is provided, partial accumulated text is emitted
 *  after each chunk for live UI updates. The final translated text is always returned. */
export async function translateText(
    text: string,
    target: string,
    onPartial?: (partial: string) => void,
    endpoint: string = 'https://translate.michael-pouget01.workers.dev/',
    extraBody: Record<string, any> = {}
): Promise<string | null> {
    try {
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(await getAuthHeader()) },
            body: JSON.stringify({ q: text, target, ...extraBody })
        });
        if (!res.ok) { const body = await res.text(); console.error('[translateText] error:', body); reportWorkerError(body); return null; }
        if (!res.body) { console.error('[translateText] no response body'); return null; }

        const streamMode = res.headers.get('X-Stream-Mode') || 'append';
        console.log(`[translateText] streamMode=${streamMode} target=${target}`);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let translated = '';
        // Diagnostics: a translation that silently yields nothing is indistinguishable from
        // one that hangs, unless we can see whether chunks/lines ever arrived.
        let dbgChunks = 0, dbgBytes = 0, dbgDataLines = 0, dbgContentPieces = 0;
        let dbgFirstLine = '';

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            dbgChunks++; dbgBytes += value?.byteLength ?? 0;
            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!dbgFirstLine && trimmed) dbgFirstLine = trimmed.slice(0, 160);
                if (!trimmed.startsWith('data: ')) continue;
                dbgDataLines++;
                const data = trimmed.slice(6);
                if (data === '[DONE]') continue;
                // SSE: choices[0].delta.content or candidates[0].content.parts[0].text
                try {
                    const json = JSON.parse(data);
                    const content = json.choices?.[0]?.delta?.content
                        ?? json.candidates?.[0]?.content?.parts?.[0]?.text;
                    if (content) {
                        dbgContentPieces++;
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

        const out = translated.trim() || null;
        console.log(`[translateText] stream ended: chunks=${dbgChunks} bytes=${dbgBytes} dataLines=${dbgDataLines} contentPieces=${dbgContentPieces} resultLen=${out?.length ?? 0}${out ? '' : ' (NULL — caller will abort silently)'} firstLine=${JSON.stringify(dbgFirstLine)}`);
        return out;
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

    // The translate-reasoning bridge worker performs both the translation (streamed
    // back for live injection) and the reasoning-locale DB insertion itself. We pass
    // the canonical DB claim text (to locate the claim row), its source locale, and
    // the guard timestamp so the worker can insert without a separate client call.
    const translated = await translateText(
        reasoningText,
        targetLocale,
        onPartial,
        'https://translate-reasoning.michael-pouget01.workers.dev/',
        { claim: dbClaimText, source_locale: sourceLocale, timestamp: lastClassification }
    );
    if (!translated || translated === reasoningText) return;
    finalTranslated = translated;
    console.log(`[backgroundTranslate] Translated OK: "${finalTranslated.slice(0, 80)}"`);

    // Update cache with final translation
    const cached = researchCache.get(claimText);
    if (cached) {
        researchCache.set(claimText, { ...cached, reasoning: finalTranslated, reasoningLocale: targetLocale });
    }

    // Send one final UI update (in case the last partial didn't match the trimmed
    // final text). Persistence is handled by the worker.
    console.log(`[backgroundTranslate] Injecting final reasoning locale ${targetLocale} for claim "${dbClaimText.slice(0, 40)}..." sourceLocale=${sourceLocale} timestamp=${lastClassification ?? 'none'}`);
    onPartial(finalTranslated);
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

    // The translate-claim bridge worker performs both the translation (streamed back
    // for live injection) and the claim-locale DB insertion itself. Its `q` doubles
    // as the DB match key, so we send the canonical DB claim text — the same value
    // previously passed to the claim-locale inserter for matching.
    const translated = await translateText(
        dbClaimText,
        targetLocale,
        onPartial,
        'https://translate-claim.michael-pouget01.workers.dev/',
        { claim: dbClaimText, source_locale: sourceLocale }
    );
    if (!translated || translated === dbClaimText) return;
    finalTranslated = translated;
    console.log(`[backgroundTranslateClaim] Translated OK: "${finalTranslated.slice(0, 80)}"`);

    // Send one final UI update. Persistence is handled by the worker.
    console.log(`[backgroundTranslateClaim] Injecting final claim locale ${targetLocale} for "${dbClaimText.slice(0, 40)}..." sourceLocale=${sourceLocale}`);
    onPartial(finalTranslated);
}

/**
 * Fire-and-forget: ask the highlight-claims worker for the highlight ranges of the
 * translated tweet text, then inject them (via callback). The worker computes the
 * ranges and persists them to the DB itself; the extension only injects.
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

    // Build a 1-based index -> rewritten claim dictionary. The highlight-claims
    // worker now computes the character ranges itself, tags each returned range with
    // the claim_index it corresponds to, and persists the highlights to the DB. We
    // keep the same 1-based indexing the worker previously returned so the ranges map
    // back to the right claim (and thus classification.claims, which is in the same
    // order as dbClaims — localizeHighlights guarantees this).
    const rewrittenClaims: Record<string, string> = {};
    dbClaims.forEach((dc, idx) => {
        rewrittenClaims[String(idx + 1)] = dc.rewritten ?? dc.claim;
    });

    // claimIndex (0-based) -> [start, end]
    const claimHighlightsByIndex = new Map<number, [number, number]>();

    try {
        const res = await fetch('https://highlight-claims.michael-pouget01.workers.dev/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(await getAuthHeader()) },
            body: JSON.stringify({
                tweet_text: tweetText,
                rewritten_claims: rewrittenClaims,
                locale: highlightLocale,
                source_locale: sourceLocale,
                tweet_hash: tweetHash
            })
        });
        if (!res.ok || !res.body) {
            const body = res.ok ? '(no body)' : await res.text();
            console.error('[backgroundHighlightRange] highlight-claims error:', res.status, body);
            if (!res.ok) reportWorkerError(body);
            return;
        }

        // The worker streams back newline-delimited JSON objects of the form
        // {"range":[start,end],"claim_index":N}. Parse each line as it arrives.
        const handleLine = (line: string) => {
            const trimmed = line.trim();
            if (!trimmed) return;
            try {
                const obj = JSON.parse(trimmed);
                const range = obj.range;
                const claimIndex = obj.claim_index;
                if (!Array.isArray(range) || range.length !== 2 || typeof claimIndex !== 'number') return;
                // Convert the 1-based claim_index to the 0-based array index used everywhere else.
                const idx = claimIndex - 1;
                if (idx < 0 || idx >= dbClaims.length) {
                    console.warn(`[backgroundHighlightRange] Skipping out-of-bounds claim_index=${claimIndex}, dbClaims.length=${dbClaims.length}`);
                    return;
                }
                claimHighlightsByIndex.set(idx, [range[0], range[1]]);
                console.log(`[backgroundHighlightRange] range for claim_index=${claimIndex}: [${range[0]}, ${range[1]}]`);
            } catch {
                // Ignore blank / keep-alive / non-JSON lines.
            }
        };

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) handleLine(line);
        }
        if (buffer.trim()) handleLine(buffer);
    } catch (err) {
        console.error('[backgroundHighlightRange] fetch error:', err);
        return;
    }

    console.log(`[backgroundHighlightRange] Received ${claimHighlightsByIndex.size} highlight range(s) from worker`);
    if (claimHighlightsByIndex.size === 0) {
        console.warn('[backgroundHighlightRange] No highlight ranges returned');
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

    // Inject the updated classification (translated text highlights). Persistence is
    // handled by the highlight-claims worker itself.
    if (onUpdate) {
        onUpdate({ ...classification, claims: updatedClaims });
    }
    console.log(`[backgroundHighlightRange] Injected ${claimHighlightsByIndex.size} highlight(s) for locale ${highlightLocale}`);
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

async function* streamResearch(mainClaim: string, locale?: string, tweetUrls?: string[], claimId?: string, onBalanceError?: () => void): AsyncGenerator<ResearchUpdate> {
    const effectiveLocale = locale ?? getUILanguage();
    // Match how the claim was STORED: the preclassify worker normalized the rewritten
    // text (normalizeText) before writing it, so we must normalize here too — otherwise
    // start_claim_classification's exact JSONB match (and the upsert) miss on any claim
    // containing NFKC-foldable chars, non-breaking hyphens, collapsed spaces, etc.,
    // yielding "Claim not found" and repeated charges. normalizeText is byte-identical
    // to the worker's, so normalized text keys the exact same row.
    mainClaim = normalizeText(mainClaim);
    // The classify-tweets worker starts the claim classification, researches, and
    // upserts the result to the DB itself. Pass the claim id when known so it updates
    // the exact row rather than matching by text.
    const payload: any = { mainClaim, locale: effectiveLocale };
    if (claimId) payload.id = claimId;
    if (tweetUrls && tweetUrls.length > 0) payload.sources = tweetUrls;
    const res = await fetch('https://classify-tweets.michael-pouget01.workers.dev/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await getAuthHeader()) },
        body: JSON.stringify(payload)
    });
    if (!res.ok || !res.body) {
        const body = res.body || !res.ok ? await res.text() : '';
        console.error('Research error:', res.status, body);
        if (!res.ok) {
            // Attribute a "balance too low" 402 to THIS claim's gated action (if the
            // caller provided a sink); everything else goes to the global handler.
            if (onBalanceError && isBalanceTooLowMessage(body)) onBalanceError();
            else reportWorkerError(body);
        }
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

// ---- Streaming helpers (preclassify) ----

async function* processWorkerStream(input: any, worker: string): AsyncGenerator<{ text: string; streamMode: string }> {
    console.log(`Sending request to worker: ${worker}`);
    const response = await fetch(`https://${worker}.michael-pouget01.workers.dev/`, {
        method: 'POST',
        body: JSON.stringify(input),
        headers: { 'Content-Type': 'application/json', ...(await getAuthHeader()) }
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
