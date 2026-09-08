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
 *
 * NOTE on DB keys: persisted highlight keys are "<locale>:<sha256-of-tweet-text>"
 * (see the preclassify-tweets / highlight-claims workers), but the background strips
 * them back to bare-locale keys when the payload arrives (payloadToClaim), keeping
 * only the revision matching the displayed text — so by the time ranges reach this
 * function the hashes are already gone and this lookup stays exactly as it was.
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

/** Synchronous SHA-256 of a string's raw UTF-8 bytes, as lowercase hex. Byte-identical
 *  to crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)) and to the sha256Hex
 *  helpers in the preclassify-tweets / highlight-claims workers, so a client-side hash of
 *  a displayed tweet text matches the "<locale>:<hash>" key the worker persisted.
 *  Sync (not WebCrypto) because highlight stripping runs inside the synchronous merge
 *  paths, which must stay atomic — an await there would let two rapid payloads
 *  interleave and clobber each other's merge. Hashing a tweet body takes microseconds. */
export function sha256HexSync(input: string): string {
    const bytes = new TextEncoder().encode(input);
    const bitLen = bytes.length * 8;
    // Padded length: multiple of 64 with room for the 0x80 byte + 8-byte length.
    const paddedLen = (((bytes.length + 8) >> 6) + 1) << 6;
    const padded = new Uint8Array(paddedLen);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const view = new DataView(padded.buffer);
    // 64-bit big-endian length; tweet bodies never reach 2^32 bits, so the high word is 0.
    view.setUint32(paddedLen - 4, bitLen >>> 0);

    const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
    const K = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    const w = new Uint32Array(64);
    for (let off = 0; off < paddedLen; off += 64) {
        for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
        for (let i = 16; i < 64; i++) {
            const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
        }
        let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
        for (let i = 0; i < 64; i++) {
            const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const ch = (e & f) ^ (~e & g);
            const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
            const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (S0 + maj) | 0;
            h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
        }
        h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
        h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
    }
    return [h0, h1, h2, h3, h4, h5, h6, h7]
        .map(x => (x >>> 0).toString(16).padStart(8, '0'))
        .join('');
}

/** Split a persisted highlight key "<locale>:<sha256-of-tweet-text>" into its locale
 *  prefix and hash. Returns null for legacy bare-locale keys (rows written before
 *  hashing) and live-stream keys, which carry no hash. The colon is safe to split on:
 *  it never appears in a BCP-47 tag. */
export function splitHighlightKey(key: string): [string, string] | null {
    const idx = key.lastIndexOf(':');
    if (idx <= 0) return null;
    const hash = key.slice(idx + 1);
    if (!/^[0-9a-f]{64}$/.test(hash)) return null;
    return [key.slice(0, idx), hash];
}

/** Which text revision a stripped highlight key must bind to. `displayed` is the
 *  sha256HexSync of the body the claim's tweet is currently showing (best guess —
 *  may be null when unknown); `known` holds the hashes of every body the client
 *  holds for the tweet (original + translation + quoted + classification body). */
export type RevisionGate = {
    displayed: string | null;
    known: Set<string>;
};

/** Strip revision hashes from a DB highlight object, re-emitting survivors under
 *  their bare locale prefix. Per locale prefix, three tiers — first match wins:
 *    1. a "<locale>:<hash>" key whose hash is the DISPLAYED body;
 *    2. a "<locale>:<hash>" key whose hash is another HELD body (e.g. the original
 *       while the translation shows — still genuine, and instant if the user
 *       toggles back);
 *    3. a legacy bare "<locale>" key (rows written before hashing).
 *  Unknown-hash revisions (stale translations/edits, appended forever server-side)
 *  are dropped — the missing-highlight checks downstream then route through the
 *  Translate Fact-Checks flow. Hash equality IS string equality here, so no locale
 *  guessing is involved. */
export function selectHighlightRevision(
    highlight: Record<string, [number, number]>,
    gate: RevisionGate
): Record<string, [number, number]> {
    const best = new Map<string, { tier: number; val: [number, number] }>();
    for (const [key, val] of Object.entries(highlight)) {
        const split = splitHighlightKey(key);
        const prefix = split ? split[0] : key;
        const tier = !split ? 0 : split[1] === gate.displayed ? 2 : gate.known.has(split[1]) ? 1 : -1;
        if (tier < 0) continue;
        if ((best.get(prefix)?.tier ?? -1) <= tier) best.set(prefix, { tier, val });
    }
    const out: Record<string, [number, number]> = {};
    for (const [prefix, { val }] of best) out[prefix] = val;
    return out;
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

        let [start, end] = range;
        // Stored offsets come from a worker revision of the tweet body that can
        // drift by a char or two (trailing t.co strip, entity decode, whitespace).
        // Clamp a small overshoot so the final claim doesn't fall into the
        // fallback box; drop only what can't be salvaged (wrong revision).
        if (start < 0) {
            if (start < -30) continue;
            start = 0;
        }
        if (end > tweetText.length) {
            const overshoot = end - tweetText.length;
            if (overshoot <= 30) {
                console.log(`[misinfo] breakupWithHighlights: clamped end ${end} to ${tweetText.length} (overshoot ${overshoot}) for claim "${claims[i].text.slice(0, 80)}..."`);
                end = tweetText.length;
            } else {
                continue;
            }
        }
        if (start >= tweetText.length || start >= end) continue;
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
