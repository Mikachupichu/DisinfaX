export type Source = {
    title?: string;
    url?: string;
};

export type Claim = {
    text: string;
    rewritten?: string;
    verdict: "false" | "true" | "research required" | "unknown";
    note: null | string;
    confidence?: number;
    veracity?: number;
    sources?: Source[];
    /** Canonical claim text from the DB table entry this claim is linked to.
     *  Set when a DB match is found. Used by the refresh button to re-research
     *  without re-matching. */
    dbClaimText?: string;
    /** claims.id (uuid) of the DB row this claim is linked to, once known (from a
     *  fetch_tweet_and_touch_network / get_full_claim pull or a Realtime payload).
     *  Preferred dedup key and the handle for get_full_claim / subscribe. */
    dbClaimId?: string;
    /** True when another user's classification for this claim is currently in flight
     *  (DB is_classifying). The UI shows the existing values with a spinner and
     *  auto-replaces them when the fresh classification arrives — no click needed. */
    isClassifying?: boolean;
    /** Locale-keyed character ranges for highlighting in the tweet text.
     *  E.g. {"en": [24, 56], "es": [45, 78]} — keyed by locale, value is [start, end]. */
    highlight?: Record<string, [number, number]>;
    /** This claim is flagged for reclassification-on-hold (reclassify trigger).
     *  Highlight should be neutral grey and badge always visible with "Disinfact". */
    reclassifyOnHold?: boolean;
    /** When true, the claim is being re-researched in the background. The UI shows
     *  a spinner next to the existing badge label and reasoning until new values stream in. */
    refreshing?: boolean;
    /** Cached classification shown immediately when user clicks before re-research completes. */
    cachedVerdict?: "false" | "true" | "research required" | "unknown";
    cachedNote?: string | null;
    cachedConfidence?: number;
    cachedVeracity?: number;
    cachedSources?: Source[];
    /** Locale of the reasoning text (for Translate button in popover). */
    reasoningLocale?: string;
    /** Locale of the rewritten claim text (for Translate button in popover). */
    claimLocale?: string;
    /** Locale of the canonical dbClaimText in the DB (used for matching during re-research). */
    dbClaimLocale?: string;
    /** True when this claim was researched from scratch (no DB match) during the
     *  on-hold pipeline. Used to decide whether to show the floating scroll button. */
    freshlyResearched?: boolean;
};

export type TextSegment = {
    text: string;
    claimIndex: number | null;
};

export type QuotedClassification = {
    id: string;
    claims: null | Claim[];
    segments?: TextSegment[] | null;
};

export type Classification = {
    id: string;
    batchId: string;
    claims: null | Claim[];
    segments?: TextSegment[] | null;
    quoting: QuotedClassification | null;
    /** When true, the tweet had no DB hash match and the pipeline is on hold
     *  until the user clicks the "Disinfact" button. */
    onHold?: boolean;
    /** When true, some claims need re-research but old content is held.
     *  Neutral highlights + always-visible "Disinfact" badge until user clicks. */
    reclassifyOnHold?: boolean;
    /** When true, highlights for the displayed locale are missing and the
     *  language differs. Show "Translate Fact-Checks" button at tweet top. */
    translateFactChecksOnHold?: boolean;
    /** When true, the user clicked "Translate Fact-Checks" and highlight
     *  localization is still running. Hide fallback boxes until it completes. */
    localizingHighlights?: boolean;
    /** When true, a forced re-preclassification ("Re-classify this tweet's claims") is
     *  running. Shows a spinner in the Disinfact button's slot at the top of the tweet,
     *  since that flow has no on-hold button of its own to spin. */
    preclassifying?: boolean;
    /** When set, the tweet text should be replaced with Grok's auto-translated
     *  text in this locale. Highlights on claims use this locale key. */
    translatedLocale?: string;
    /** The Grok-translated tweet text itself. When present, this is what should
     *  be shown to the user and used for highlight-based text breakup. */
    translatedText?: string;
    /** Locale of the text currently being displayed (either sourceLanguage for
     *  original text or destinationLanguage for Grok translation). Used to pick
     *  the correct highlight locale from claim.highlight. */
    textLocale?: string;
};

export interface ResearchResult {
    text: string;
    verdict: "true" | "false" | "unknown";
    note: string;
}

/**
 * Format a verdict label from separate probability (confidence) and veracity (degree of truth) scores.
 *
 * probability: 0.0 (uncertain) – 1.0 (certain)
 * veracity:    -1.0 (completely false) – 1.0 (completely true)
 *
 * When probability < 0.2, everything is "unknown".
 * Otherwise:
 *   1. Probability adjective  (Very Likely / Likely / Possibly / none) — how confident the AI is
 *   2. Veracity adjective     (Mostly / Arguably / Partially / Equivocally / none) — degree of truth
 *   3. Truth verdict          (True / False) — based on sign of veracity
 */
export function formatVerdict(probability: number, veracity: number, reasoning: string): Pick<Claim, "verdict" | "note"> {
    // Low probability → unknown (veracity near 0 with high probability is "Equivocally True/False")
    if (probability < 0.2) {
        return { verdict: "unknown", note: reasoning };
    }

    // true/false based on veracity sign
    const verdict: Claim["verdict"] = veracity > 0.0 ? "true" : "false";

    // Store the reasoning without a verdict prefix. The badge and popover header
    // already display the verdict via verdictLabel(), and prepending it here made
    // prefix stripping fragile across locales (e.g. "Mostly True: " vs "Mostly,True:").
    return { verdict, note: reasoning };
}

/** True when two locale strings share the same primary language subtag.
 *  sameLanguage("en-US", "en-GB") → true; sameLanguage("en", "fr") → false. */
export function sameLanguage(a: string, b: string): boolean {
    if (!a || !b) return false;
    return a.split('-')[0].toLowerCase() === b.split('-')[0].toLowerCase();
}