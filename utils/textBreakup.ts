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

/** Compute the similarity ratio (0-1) between two strings by counting matching characters
 *  at the same positions after same-length alignment. */
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
        let origIdx = 0;
        let normIdx = 0;
        while (normIdx < nIdx && origIdx < decodedText.length) {
            if (decodedText[origIdx] === ' ' && textNormalized[normIdx] !== ' ') {
                origIdx++;
                continue;
            }
            if (decodedText[origIdx].toLowerCase() === textNormalized[normIdx].toLowerCase()) {
                normIdx++;
            }
            origIdx++;
        }
        const start = origIdx;
        let end = start;
        let claimNormIdx = 0;
        while (claimNormIdx < normalized.length && end < decodedText.length) {
            if (decodedText[end] === ' ' && normalized[claimNormIdx] !== ' ') {
                end++;
                continue;
            }
            if (decodedText[end].toLowerCase() === normalized[claimNormIdx].toLowerCase()) {
                claimNormIdx++;
            }
            end++;
        }
        return { start, end };
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
        // Map normalized position back to original text character position
        let origIdx = 0;
        let normIdx = 0;
        while (normIdx < bestPos && origIdx < decodedText.length) {
            const tc = decodedText[origIdx].toLowerCase();
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
            const tc = decodedText[end].toLowerCase();
            const nc = normalizedClaim[claimNormIdx];
            if (!/[\w]/.test(tc) && tc !== ' ') {
                end++;
                continue;
            }
            if (tc === nc) claimNormIdx++;
            end++;
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

  const matches: { claimIndex: number; start: number; end: number }[] = [];

  for (let i = 0; i < claims.length; i++) {
    const highlight = claims[i].highlight;
    if (!highlight) continue;

    // Try exact locale, then base language, then any entry
    let range = highlight[locale];
    if (!range) {
      const baseLang = locale.split('-')[0];
      for (const [key, val] of Object.entries(highlight)) {
        if (key === baseLang || key.startsWith(baseLang + '-')) {
          range = val;
          break;
        }
      }
    }
    if (!range) continue;

    const [start, end] = range;
    // Validate bounds
    if (start < 0 || end > tweetText.length || start >= end) continue;
    matches.push({ claimIndex: i, start, end });
  }

  if (matches.length === 0) return null;

  // Sort by start position
  matches.sort((a, b) => a.start - b.start);

  // Build segments
  const segments: TextSegment[] = [];
  let cursor = 0;

  for (const m of matches) {
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

export function breakupTweetText(tweetText: string, claims: Claim[]): TextSegment[] | null {
    if (!tweetText || !claims || claims.length === 0) return null;

    const matches: ClaimMatch[] = [];
    const unmatched: string[] = [];

    for (let i = 0; i < claims.length; i++) {
        const pos = findExactMatch(tweetText, claims[i].text);
        if (pos) {
            matches.push({ claimIndex: i, start: pos.start, end: pos.end });
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
