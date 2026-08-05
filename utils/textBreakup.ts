import { Claim, TextSegment } from "../data/Classification";

type ClaimMatch = {
    claimIndex: number;
    start: number;
    end: number;
};

/** Normalize text for fuzzy comparison: lowercase, collapse whitespace, strip punctuation. */
function normalizeForMatch(s: string): string {
    return s.toLowerCase().replace(/\s+/g, ' ').replace(/[^\w\s]/g, '').trim();
}

/** Similarity ratio (0-1) of two strings, as the fraction of positions holding the same
 *  character. Strictly positional — there is no alignment, so a single inserted or
 *  deleted character shifts the rest and scores low. Adequate here only because callers
 *  compare equal-length windows of already-normalized text. */
function similarity(a: string, b: string): number {
    const len = Math.max(a.length, b.length);
    if (len === 0) return 1;
    let matches = 0;
    for (let i = 0; i < len; i++) {
        if (a[i] === b[i]) matches++;
    }
    return matches / len;
}

/** Find an exact verbatim or whitespace-normalized match of claimText within text.
 *  Falls back to fuzzy sliding-window search when precise matches fail.
 *  Exported so the background script can compute highlight ranges consistently
 *  with the content script's segment builder.
 *
 *  The optional `decode` parameter lets callers supply a decoder that works in
 *  their environment (the background service worker has no DOM, so it can't use
 *  the default HTML entity decoder). */
export function findExactMatch(
    text: string,
    claimText: string,
    decode?: (s: string) => string
): { start: number; end: number } | null {
    if (!text || !claimText) return null;

    const htmlDecode = decode ?? defaultHtmlDecode;

    // 1. Direct indexOf (after decoding entities in caller, but be defensive here too)
    const decodedText = htmlDecode(text);
    const decodedClaim = htmlDecode(claimText);
    let idx = decodedText.indexOf(decodedClaim);
    if (idx !== -1) return { start: idx, end: idx + decodedClaim.length };

    // 2. Whitespace-normalized (handles extra spaces, newlines, etc.)
    const normalized = decodedClaim.trim().replace(/\s+/g, ' ');
    const textNormalized = decodedText.replace(/\s+/g, ' ');
    const nIdx = textNormalized.indexOf(normalized);
    if (nIdx !== -1) {
        // Treat every whitespace char (incl. newlines/tabs) as a single space, to
        // match the collapse done above — otherwise newlines are mis-aligned and the
        // mapped range drifts.
        let origIdx = 0;
        let normIdx = 0;
        while (normIdx < nIdx && origIdx < decodedText.length) {
            const oc = /\s/.test(decodedText[origIdx]) ? ' ' : decodedText[origIdx].toLowerCase();
            const nc = textNormalized[normIdx];
            if (oc === ' ' && nc !== ' ') {
                origIdx++;
                continue;
            }
            if (oc === nc.toLowerCase()) {
                normIdx++;
            }
            origIdx++;
        }
        const start = origIdx;
        let end = start;
        let claimNormIdx = 0;
        while (claimNormIdx < normalized.length && end < decodedText.length) {
            const oc = /\s/.test(decodedText[end]) ? ' ' : decodedText[end].toLowerCase();
            const nc = normalized[claimNormIdx];
            if (oc === ' ' && nc !== ' ') {
                end++;
                continue;
            }
            if (oc === nc.toLowerCase()) {
                claimNormIdx++;
            }
            end++;
        }
        if (end > start) return { start, end };
    }

    // 3. Fuzzy sliding-window: find the best-matching substring when the model
    //    slightly rephrases, changes punctuation, or drops/alters small words.
    const normalizedClaim = normalizeForMatch(decodedClaim);
    const normalizedText = normalizeForMatch(decodedText);
    const claimLen = normalizedClaim.length;
    if (claimLen < 5) return null; // too short for reliable fuzzy matching

    let bestScore = 0;
    let bestPos = -1;
    // Slide a window of the same length over the normalized text
    for (let i = 0; i <= normalizedText.length - claimLen; i++) {
        const window = normalizedText.slice(i, i + claimLen);
        const score = similarity(window, normalizedClaim);
        if (score > bestScore) {
            bestScore = score;
            bestPos = i;
        }
    }

    // Accept if similarity is above 70%
    if (bestScore >= 0.7 && bestPos >= 0) {
        // Map normalized position back to original text character position.
        // normalizeForMatch collapses ALL whitespace (incl. newlines/tabs) to a
        // single space, so here we must treat every whitespace char in the original
        // as ' ' too — otherwise newlines are skipped as punctuation and the mapping
        // drifts, producing a wrong (often zero-length) range.
        let origIdx = 0;
        let normIdx = 0;
        while (normIdx < bestPos && origIdx < decodedText.length) {
            const rawTc = decodedText[origIdx];
            const tc = /\s/.test(rawTc) ? ' ' : rawTc.toLowerCase();
            const nc = normalizedText[normIdx];
            // Skip non-alphanumeric in original
            if (!/[\w]/.test(tc) && tc !== ' ') {
                origIdx++;
                continue;
            }
            // Skip non-alphanumeric in normalized (shouldn't happen since we stripped, but just in case)
            if (!/[\w]/.test(nc) && nc !== ' ') {
                normIdx++;
                continue;
            }
            if (tc === nc) normIdx++;
            origIdx++;
        }
        const start = origIdx;

        // Match forward from start
        let end = start;
        let claimNormIdx = 0;
        while (claimNormIdx < normalizedClaim.length && end < decodedText.length) {
            const rawTc = decodedText[end];
            const tc = /\s/.test(rawTc) ? ' ' : rawTc.toLowerCase();
            const nc = normalizedClaim[claimNormIdx];
            if (!/[\w]/.test(tc) && tc !== ' ') {
                end++;
                continue;
            }
            if (tc === nc) claimNormIdx++;
            end++;
        }

        // Reject a degenerate (zero-length) range — a mis-mapped position must not
        // become a bogus highlight that overrides a good client-side match.
        if (end <= start) {
            console.log(`[textBreakup] Fuzzy match produced a degenerate range for "${claimText.slice(0, 50)}...", rejecting`);
            return null;
        }

        console.log(`[textBreakup] Fuzzy match (${(bestScore * 100).toFixed(0)}%): "${claimText.slice(0, 50)}..." at [${start}, ${end})`);
        return { start, end };
    }

    console.log(`[textBreakup] No match for claim "${claimText.slice(0, 60)}..." in text "${text.slice(0, 80)}..."`);
    return null;
}

/** Decode HTML entities using a DOM element. Safe only in content-script / browser contexts. */
function defaultHtmlDecode(text: string): string {
    if (typeof document === 'undefined') return text;
    const el = document.createElement('div');
    el.innerHTML = text;
    return el.textContent ?? text;
}

/**
 * Resolve overlaps between claim matches.
 * When one claim is a substring of another (e.g. "300 sub-agents" inside
 * "K2.6 supports 300 sub-agents"), keep the longer one.
 * For partial overlaps that aren't containment, first claim wins.
 */
function resolveOverlaps(matches: ClaimMatch[]): ClaimMatch[] {
    const sorted = [...matches].sort((a, b) => a.start - b.start);
    const result: ClaimMatch[] = [];
    let lastEnd = 0;

    for (const m of sorted) {
        if (m.start >= lastEnd) {
            result.push(m);
            lastEnd = m.end;
        } else if (m.end > lastEnd) {
            // Partial overlap — keep only the non-overlapping tail
            result.push({ claimIndex: m.claimIndex, start: lastEnd, end: m.end });
            lastEnd = m.end;
        }
        // else completely contained — skip (the containing claim already covers this text)
    }

    return result;
}

/**
 * Resolve a claim's highlight [start,end] range for a requested locale, tolerating a
 * region-SUBTAG mismatch on the key (same primary language, different region — or none).
 * This matters because the same range is labelled with different locale strings on the
 * two paths: the preclassify worker keys it by the UI locale (`effectiveLocale`, e.g.
 * "en-US" from browser.i18n.getUILanguage()), while injection looks it up by the
 * displayed-text locale (source/dest language, e.g. "en" from X). Same language, same
 * text — only a "-US" subtag difference — so the exact-key lookup misses.
 *
 * Resolution is intentionally limited to exact key → base language. It NEVER bridges
 * different primary languages (that would risk applying one language's offsets to
 * another's text); those cases stay handled by the translate-fact-checks flow.
 */
export function resolveHighlightRange(
    highlight: Record<string, [number, number]> | undefined,
    locale: string
): [number, number] | undefined {
    if (!highlight) return undefined;
    if (locale && highlight[locale]) return highlight[locale];
    if (locale) {
        const baseLang = locale.split('-')[0];
        for (const [key, val] of Object.entries(highlight)) {
            if (key === baseLang || key.startsWith(baseLang + '-')) return val;
        }
    }
    return undefined;
}

/**
 * Build segments directly from stored character ranges in the highlight field.
 * This is used when highlights are available from the DB (tweet_claims.highlight).
 * Skips fuzzy matching entirely — uses exact character positions.
 */
export function breakupWithHighlights(
    tweetText: string,
    claims: Claim[],
    locale: string
): TextSegment[] | null {
    if (!tweetText || !claims || claims.length === 0) return null;

    const matches: ClaimMatch[] = [];

    for (let i = 0; i < claims.length; i++) {
        const highlight = claims[i].highlight;
        if (!highlight) continue;

        const range = resolveHighlightRange(highlight, locale);
        if (!range) continue;

        const [start, end] = range;
        // Drop ranges that don't address real text: stored offsets come from a worker
        // and may refer to a different revision of the tweet body.
        if (start < 0 || end > tweetText.length || start >= end) continue;
        matches.push({ claimIndex: i, start, end });
    }

    if (matches.length === 0) return null;

    matches.sort((a, b) => a.start - b.start);

    // Walk the matches in order, emitting the plain text before each one and then the
    // match itself, then whatever trails the last match.
    const segments: TextSegment[] = [];
    let cursor = 0;

    for (const m of matches) {
        // Overlap guard: never re-emit text the cursor has already passed. Two claims
        // sharing (or overlapping) a range would otherwise slice the same text out twice,
        // duplicating the tweet text on screen. Clamp the start to the cursor; if the whole
        // match is already consumed by a prior claim, skip it (it's a duplicate).
        const start = Math.max(m.start, cursor);
        if (start >= m.end) continue;
        if (start > cursor) {
            segments.push({ text: tweetText.slice(cursor, start), claimIndex: null });
        }
        segments.push({ text: tweetText.slice(start, m.end), claimIndex: m.claimIndex });
        cursor = m.end;
    }

    if (cursor < tweetText.length) {
        segments.push({ text: tweetText.slice(cursor), claimIndex: null });
    }

    return segments;
}

/**
 * Build segments by locating each claim's text inside the tweet body, for the case where
 * stored character ranges can't be used directly (see breakupWithHighlights for that
 * faster path). Falls back through exact, whitespace-normalized, then fuzzy matching via
 * findExactMatch, and returns null when nothing matched at all.
 */
export function breakupTweetText(tweetText: string, claims: Claim[]): TextSegment[] | null {
    if (!tweetText || !claims || claims.length === 0) return null;

    const matches: ClaimMatch[] = [];
    /** Human-readable descriptions of claims that produced no segment, for logging. */
    const unmatched: string[] = [];

    for (let i = 0; i < claims.length; i++) {
        // Skip claims with no highlight range: the worker returned [-1,-1] (couldn't
        // locate the text in the tweet). Text-matching them here would drop a stray
        // inline highlight onto a fragment; unlocatable claims belong ONLY in the
        // fallback box. (Located claims — incl. locale-mismatched ones re-matched here —
        // still carry a highlight under some locale key, so they're unaffected.)
        const highlightRanges = claims[i].highlight;
        if (!highlightRanges || Object.keys(highlightRanges).length === 0) {
            unmatched.push(`#${i + 1}: "${claims[i].text}" (no highlight range)`);
            continue;
        }
        const matchRange = findExactMatch(tweetText, claims[i].text);
        if (matchRange) {
            matches.push({ claimIndex: i, start: matchRange.start, end: matchRange.end });
        } else {
            unmatched.push(`#${i + 1}: "${claims[i].text}"`);
        }
    }

    if (matches.length === 0) {
        console.log(`[misinfo] breakupTweetText: no claims matched. Unmatched:`, unmatched);
        return null;
    }

    if (unmatched.length > 0) {
        console.log(`[misinfo] breakupTweetText: ${unmatched.length} unmatched:`, unmatched);
    }

    const filtered = resolveOverlaps(matches);

    // Split text into alternating segments
    const segments: TextSegment[] = [];
    let cursor = 0;

    for (const m of filtered) {
        if (m.start > cursor) {
            segments.push({ text: tweetText.slice(cursor, m.start), claimIndex: null });
        }
        segments.push({ text: tweetText.slice(m.start, m.end), claimIndex: m.claimIndex });
        cursor = m.end;
    }

    if (cursor < tweetText.length) {
        segments.push({ text: tweetText.slice(cursor), claimIndex: null });
    }

    return segments;
}
