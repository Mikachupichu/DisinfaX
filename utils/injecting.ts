import { Classification, QuotedClassification, Claim, TextSegment, Source, sameLanguage } from "../data/Classification";
import { normalizeSources } from "./intelligence";
import { breakupTweetText, breakupWithHighlights } from "./textBreakup";

/**
 * Detects whether the user is interacting via touch (finger) or a pointing device
 * (mouse/trackpad). Toggles `is-touch-active` on <html> so CSS can adapt button sizes
 * instantly — large touch targets while the user's fingers are active, small defaults
 * for pointer precision.
 *
 * The class stays active as long as touch interactions keep arriving. Any pointer
 * move or wheel event from a non-touch device removes it immediately.
 */
class InputModeManager {
    constructor() {
        this.initListeners();
    }

    private setTouchMode(active: boolean): void {
        if (active) {
            document.documentElement.classList.add("is-touch-active");
        } else {
            document.documentElement.classList.remove("is-touch-active");
        }
    }

    private initListeners(): void {
        // Any touch start (scroll or tap) → touch mode
        window.addEventListener("touchstart", () => {
            this.setTouchMode(true);
        }, { capture: true, passive: true });

        // pointerdown with touch pointerType → touch mode
        window.addEventListener("pointerdown", (e) => {
            if (e.pointerType === "touch") {
                this.setTouchMode(true);
            } else {
                this.setTouchMode(false);
            }
        }, { capture: true, passive: true });

        // pointermove from non-touch device → mouse mode
        window.addEventListener("pointermove", (e) => {
            if (e.pointerType !== "touch") {
                this.setTouchMode(false);
            }
        }, { capture: true, passive: true });

        // Wheel (mouse wheel / trackpad pinch-scroll) → mouse mode
        window.addEventListener("wheel", () => {
            this.setTouchMode(false);
        }, { capture: true, passive: true });
    }
}

const allClassifications: Classification[] = [];
const processingOnHoldIds = new Set<string>();
let observerSetup = false;

// Tracks on-hold Disinfact clicks for the floating scroll navigation buttons:
// tweetId -> { originalScrollY, pendingClaimTexts }.
const onHoldScrollStates = new Map<string, { originalScrollY: number; pendingClaimTexts: Set<string> }>();
let activeFloatingButton: HTMLElement | null = null;
let floatingButtonDismissTimer: ReturnType<typeof setTimeout> | null = null;
let floatingButtonVisibilityCheck: ReturnType<typeof setInterval> | null = null;

/**
 * Testing: set `window.__mfLocale` or `localStorage.mfLocale` in the console, then refresh.
 *   'fr' / 'de' / 'ja' / 'es'  →  use embedded test map for that locale
 *   'auto'                       →  detect from navigator.language
 *   undefined / 'en'             →  use chrome.i18n (browser's built-in locale)
 *
 * localStorage persists across page refreshes; window.__mfLocale needs to be set
 * each time before the page loads (harder to use). Prefer localStorage:
 *   localStorage.mfLocale = 'fr'; location.reload()
 *   delete localStorage.mfLocale; location.reload()
 */
let localeOverride: string | null = null;
try {
    const raw = (window as any).__mfLocale ?? localStorage?.getItem?.('mfLocale') ?? null;
    localeOverride = raw === 'auto'
        ? (navigator.language || 'en').split('-')[0]
        : (raw ?? null);
} catch {}

/** Effective UI locale: respect the localStorage test override first, then
 *  chrome.i18n.getUILanguage(), then navigator.language. */
function getEffectiveUILocale(): string {
    try {
        return localeOverride ??
            (typeof chrome !== 'undefined' && (chrome as any).i18n?.getUILanguage?.()) ??
            (navigator.language || 'en');
    } catch {
        return navigator.language || 'en';
    }
}

/** True when the given locale writes right-to-left. */
function isRTLLocale(locale?: string): boolean {
    if (!locale) return false;
    const rtlLangs = new Set([
        'ar', 'he', 'fa', 'ur', 'sd', 'ps', 'yi', 'ug', 'ku',
        'dv', 'ckb', 'syr', 'aeb', 'arq', 'ars'
    ]);
    return rtlLangs.has(locale.split('-')[0].toLowerCase());
}

/** Safe i18n lookup — falls back to English via `_locales/<locale>/messages.json`. */
function t(key: string, subs?: string[]): string {
    try {
        if (localeOverride && localeOverride !== 'en') {
            const map = TEST_LOCALE_MAPS[localeOverride];
            if (map) return applyMap(map, key, subs);
        }
        const api = (typeof chrome !== 'undefined' && (chrome as any).i18n)
            ? (chrome as any).i18n
            : (typeof browser !== 'undefined' && (browser as any).i18n)
                ? (browser as any).i18n
                : null;
        if (api?.getMessage) {
            const result = api.getMessage(key, subs);
            if (result) return result;
        }
    } catch {}
    return applyMap(EN_MAP, key, subs);
}

// ── Inline locale maps (for testing & fallback) ──────────────────

// ── Inline locale maps (for testing & fallback) ──────────────────

const EN_MAP: Record<string, string> = {
    verdictTrue: "True", verdictFalse: "False", verdictUnknown: "Unknown",
    verdictResearching: "Fact-Checking",
    adjVeryLikely: "Very Likely", adjLikely: "Likely", adjPossibly: "Possibly",
    adjMostly: "Mostly", adjArguably: "Arguably", adjPartially: "Partially", adjEquivocally: "Equivocally",
    copyTooltip: "Copy", refreshBatchTooltip: "Re-classify all tweets in this batch",
    refreshClaimTooltip: "Re-research this claim", researchingText: "Fact-Checking",
    translateFactChecks: "Translate Fact-Checks", translateClaimButton: "Translate",
    factCheckedFloatingButton: "Fact-Checked", goBackFloatingButton: "Go Back",
    badgeVerdictOnly: "{0}", badgeAdjVerdict: "{0} {1}", badgeVerdictAdj: "{1} {0}",
    badgeAdjVerdictAdj2: "{2} {0} {1}", badgeAdjVerdictAdj2Verbose: "{2} to be {0} {1}",
};

const TEST_LOCALE_MAPS: Record<string, Record<string, string>> = {
    fr: {
        verdictTrue: "Vrai", verdictFalse: "Faux", verdictUnknown: "Inconnu", verdictResearching: "Vérification",
        adjVeryLikely: "Très probablement", adjLikely: "Probablement", adjPossibly: "Possiblement",
        adjMostly: "Plutôt", adjArguably: "Discutablement", adjPartially: "Partiellement", adjEquivocally: "Équivoquement",
        copyTooltip: "Copier", refreshBatchTooltip: "Reclassifier tous les tweets de ce lot",
        refreshClaimTooltip: "Re-rechercher cette affirmation", researchingText: "Vérification",
        translateFactChecks: "Traduire la vérification", translateClaimButton: "Traduire",
        factCheckedFloatingButton: "Vérifié", goBackFloatingButton: "Retour",
        badgeVerdictOnly: "{0}", badgeAdjVerdict: "{0} {1}", badgeVerdictAdj: "{1} {0}",
        badgeAdjVerdictAdj2: "{2} {0} {1}", badgeAdjVerdictAdj2Verbose: "{2} {0} {1}",
    },
    de: {
        verdictTrue: "Wahr", verdictFalse: "Falsch", verdictUnknown: "Unbekannt", verdictResearching: "Prüfung",
        adjVeryLikely: "Sehr wahrscheinlich", adjLikely: "Wahrscheinlich", adjPossibly: "Möglicherweise",
        adjMostly: "Überwiegend", adjArguably: "Diskutabel", adjPartially: "Teilweise", adjEquivocally: "Unklar",
        copyTooltip: "Kopieren", refreshBatchTooltip: "Alle Tweets in diesem Durchlauf neu klassifizieren",
        refreshClaimTooltip: "Diese Behauptung erneut recherchieren", researchingText: "Prüfung",
        translateFactChecks: "Prüfung übersetzen", translateClaimButton: "Übersetzen",
        factCheckedFloatingButton: "Geprüft", goBackFloatingButton: "Zurück",
        badgeVerdictOnly: "{0}", badgeAdjVerdict: "{0} {1}", badgeVerdictAdj: "{1} {0}",
        badgeAdjVerdictAdj2: "{2} {0} {1}", badgeAdjVerdictAdj2Verbose: "{2} {0} {1}",
    },
    ja: {
        verdictTrue: "真実", verdictFalse: "虚偽", verdictUnknown: "不明", verdictResearching: "ファクトチェック",
        adjVeryLikely: "非常に可能性が高い", adjLikely: "可能性が高い", adjPossibly: "可能性がある",
        adjMostly: "概ね", adjArguably: "議論の余地がある", adjPartially: "部分的に", adjEquivocally: "あいまい",
        copyTooltip: "コピー", refreshBatchTooltip: "このバッチのすべてのツイートを再分類",
        refreshClaimTooltip: "この主張を再調査", researchingText: "ファクトチェック",
        translateFactChecks: "ファクトチェックを翻訳", translateClaimButton: "翻訳",
        factCheckedFloatingButton: "チェック済み", goBackFloatingButton: "戻る",
        badgeVerdictOnly: "{0}", badgeAdjVerdict: "{0}{1}", badgeVerdictAdj: "{1}{0}",
        badgeAdjVerdictAdj2: "{2}{0}{1}", badgeAdjVerdictAdj2Verbose: "{2}という{0}{1}",
    },
    es: {
        verdictTrue: "Verdadero", verdictFalse: "Falso", verdictUnknown: "Desconocido", verdictResearching: "Verificando",
        adjVeryLikely: "Muy probablemente", adjLikely: "Probablemente", adjPossibly: "Posiblemente",
        adjMostly: "Mayormente", adjArguably: "Discutiblemente", adjPartially: "Parcialmente", adjEquivocally: "Ambiguamente",
        copyTooltip: "Copiar", refreshBatchTooltip: "Reclasificar todos los tweets de este lote",
        refreshClaimTooltip: "Volver a investigar esta afirmación", researchingText: "Verificando",
        translateFactChecks: "Traducir verificación", translateClaimButton: "Traducir",
        factCheckedFloatingButton: "Verificado", goBackFloatingButton: "Volver",
        badgeVerdictOnly: "{0}", badgeAdjVerdict: "{0} {1}", badgeVerdictAdj: "{1} {0}",
        badgeAdjVerdictAdj2: "{2} {0} {1}", badgeAdjVerdictAdj2Verbose: "{2} {0} {1}",
    },
    it: {
        verdictTrue: "Vero", verdictFalse: "Falso", verdictUnknown: "Sconosciuto", verdictResearching: "Verifica",
        adjVeryLikely: "Molto probabilmente", adjLikely: "Probabilmente", adjPossibly: "Possibilmente",
        adjMostly: "Per lo più", adjArguably: "Discutibilmente", adjPartially: "Parzialmente", adjEquivocally: "Equivocamente",
        copyTooltip: "Copia", refreshBatchTooltip: "Riclassifica tutti i tweet in questo lotto",
        refreshClaimTooltip: "Riricerca questa affermazione", researchingText: "Verifica",
        translateFactChecks: "Traduci verifica", translateClaimButton: "Traduci",
        factCheckedFloatingButton: "Verificato", goBackFloatingButton: "Indietro",
        badgeVerdictOnly: "{0}", badgeAdjVerdict: "{0} {1}", badgeVerdictAdj: "{1} {0}",
        badgeAdjVerdictAdj2: "{2} {0} {1}", badgeAdjVerdictAdj2Verbose: "{2} {0} {1}",
    },
};

function applyMap(map: Record<string, string>, key: string, subs?: string[]): string {
    const template = map[key];
    if (template === undefined) return key;
    if (!subs || subs.length === 0) return template;
    return subs.reduce((s, sub, i) => s.replace(new RegExp(`\\{${i}\\}`), sub), template);
}

/** Check if two claim arrays differ in text, rewritten, claimLocale, reasoningLocale, or count enough to need fresh segment derivation. */
function claimsEqual(a: Claim[] | null | undefined, b: Claim[] | null | undefined): boolean {
    if (!a && !b) return true;
    if (!a || !b) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i].text !== b[i].text) return false;
        if ((a[i].rewritten ?? a[i].text) !== (b[i].rewritten ?? b[i].text)) return false;
        if (a[i].claimLocale !== b[i].claimLocale) return false;
        if (a[i].reasoningLocale !== b[i].reasoningLocale) return false;
    }
    return true;
}
/**
 * Track which claim highlights have already been animated so we only animate
 * new highlights, not color-only updates of an existing highlight.
 */
const animatedHighlights = new WeakSet<HTMLElement>();

/** Animate a claim highlight background wiping in. LTR wipes left-to-right;
 *  RTL wipes right-to-left. After the animation finishes the span reverts to a
 *  solid background color so hover effects work normally.
 *
 *  If the span already had a highlight and only the color changes, no animation
 *  is played — the background color is updated directly. */
function animateHighlightReveal(span: HTMLElement, bgColor: string) {
    const alreadyHighlighted = animatedHighlights.has(span);
    animatedHighlights.add(span);

    if (alreadyHighlighted) {
        // Color-only change: skip the wipe animation entirely.
        span.classList.remove('mf-highlight-reveal');
        span.style.backgroundImage = '';
        span.style.backgroundSize = '';
        span.style.backgroundPosition = '';
        span.style.backgroundRepeat = '';
        span.style.backgroundColor = bgColor;
        return;
    }

    const isRTL = isRTLLocale(getEffectiveUILocale());
    span.classList.add('mf-highlight-reveal');
    span.style.backgroundColor = 'transparent';
    span.style.backgroundImage = `linear-gradient(to ${isRTL ? 'left' : 'right'}, ${bgColor}, ${bgColor})`;
    span.style.backgroundSize = '0% 100%';
    span.style.backgroundPosition = isRTL ? 'right' : 'left';
    span.style.backgroundRepeat = 'no-repeat';

    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            span.style.backgroundSize = '100% 100%';
        });
    });

    const onEnd = () => {
        span.classList.remove('mf-highlight-reveal');
        span.style.backgroundImage = '';
        span.style.backgroundSize = '';
        span.style.backgroundPosition = '';
        span.style.backgroundRepeat = '';
        span.style.backgroundColor = bgColor;
        span.removeEventListener('transitionend', onEnd);
    };
    span.addEventListener('transitionend', onEnd);
    // Safety net in case transitionend doesn't fire
    setTimeout(onEnd, 600);
}

/** Remove all .mf-segment-wrap DOM elements for the given tweet ID.
 *  This forces the next upgradeToSegments call to re-render from scratch
 *  instead of updating in place (needed when claims change after batch refresh). */
function removeSegmentWraps(tweetId: string) {
    const links = document.querySelectorAll(`a[href*="/status/${tweetId}"]`);
    for (const link of links) {
        const article = link.closest('article');
        if (!article) continue;
        // Search broadly: the wrap may be inside a [data-testid="tweetText"] element
        // (main tweet) or in a fallback text container (quoted tweet).
        const wraps = article.querySelectorAll('.mf-segment-wrap');
        for (const wrap of wraps) wrap.remove();
    }
}

/** Remove all injected extension elements for a tweet so X's native
 *  Show original / Show translation toggle can swap the text unimpeded. */
function removeInjectedElements(tweetId: string) {
    const links = document.querySelectorAll(`a[href*="/status/${tweetId}"]`);
    for (const link of links) {
        const article = link.closest('article');
        if (!article) continue;
        for (const wrap of article.querySelectorAll('.mf-segment-wrap')) wrap.remove();
        const fallback = article.querySelector(`[classification-id="${tweetId}"]`);
        if (fallback) fallback.remove();
        const unmatched = article.querySelector(`[mf-unmatched="${tweetId}"]`);
        if (unmatched) unmatched.remove();
        const tfc = article.querySelector(`[translate-fc-id="${tweetId}"]`);
        if (tfc) tfc.remove();
    }
    processingTranslateFactChecksIds.delete(tweetId);
}

/** Returns true if any part of the tweet article is within the viewport. */
function isTweetVisible(tweetId: string): boolean {
    const article = document.querySelector(`a[href*="/status/${tweetId}"]`)?.closest('article');
    if (!article) return false;
    const rect = article.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < window.innerHeight;
}

/** Smoothly scroll the window so the top of the tweet is visible.
 *  Animation duration is fixed at 1000ms regardless of distance. */
function scrollToTweet(tweetId: string, durationMs: number = 1000): Promise<void> {
    return new Promise(resolve => {
        const article = document.querySelector(`a[href*="/status/${tweetId}"]`)?.closest('article');
        if (!article) { resolve(); return; }
        const startY = window.scrollY;
        const targetY = article.getBoundingClientRect().top + window.scrollY - 80; // leave room for header
        const startTime = performance.now();
        const easeInOutCubic = (t: number) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

        function step(now: number) {
            const elapsed = now - startTime;
            const progress = Math.min(elapsed / durationMs, 1);
            const eased = easeInOutCubic(progress);
            window.scrollTo(0, startY + (targetY - startY) * eased);
            if (progress < 1) {
                requestAnimationFrame(step);
            } else {
                resolve();
            }
        }
        requestAnimationFrame(step);
    });
}

/** Smoothly scroll back to an absolute scrollY position.
 *  Animation duration is fixed at 1000ms regardless of distance. */
function scrollToPosition(targetY: number, durationMs: number = 1000): Promise<void> {
    return new Promise(resolve => {
        const startY = window.scrollY;
        const startTime = performance.now();
        const easeInOutCubic = (t: number) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

        function step(now: number) {
            const elapsed = now - startTime;
            const progress = Math.min(elapsed / durationMs, 1);
            const eased = easeInOutCubic(progress);
            window.scrollTo(0, startY + (targetY - startY) * eased);
            if (progress < 1) {
                requestAnimationFrame(step);
            } else {
                resolve();
            }
        }
        requestAnimationFrame(step);
    });
}


const upArrowSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"></polyline></svg>`;
const downArrowSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`;

/** Compute the average highlight color across all finished claims in a classification.
 *  Ignores claims that are still researching or on-hold. Returns null if no color can be derived. */
function averageClaimColor(classification: Classification): { r: number; g: number; b: number } | null {
    const allClaims: Claim[] = [
        ...(classification.claims ?? []),
        ...(classification.quoting?.claims ?? [])
    ];
    const finished = allClaims.filter(cl =>
        cl.verdict !== "research required" &&
        cl.note !== null && cl.note !== undefined &&
        cl.confidence !== undefined && cl.veracity !== undefined
    );
    if (finished.length === 0) return null;

    let rSum = 0, gSum = 0, bSum = 0;
    for (const cl of finished) {
        const rgba = confidenceRgba(cl.confidence, 1, cl.veracity);
        const match = rgba.match(/rgba\((\d+),\s*(\d+),\s*(\d+)/);
        if (!match) continue;
        rSum += parseInt(match[1], 10);
        gSum += parseInt(match[2], 10);
        bSum += parseInt(match[3], 10);
    }
    return {
        r: Math.round(rSum / finished.length),
        g: Math.round(gSum / finished.length),
        b: Math.round(bSum / finished.length)
    };
}

/** Darken an RGB color by a given ratio (0 = unchanged, 1 = black). */
function darkenColor(rgb: { r: number; g: number; b: number }, ratio: number): { r: number; g: number; b: number } {
    const factor = 1 - Math.max(0, Math.min(1, ratio));
    return {
        r: Math.round(rgb.r * factor),
        g: Math.round(rgb.g * factor),
        b: Math.round(rgb.b * factor)
    };
}

/** Brighten an RGB color by a given ratio (0 = unchanged, 1 = white). */
function brightenColor(rgb: { r: number; g: number; b: number }, ratio: number): { r: number; g: number; b: number } {
    const factor = Math.max(0, Math.min(1, ratio));
    return {
        r: Math.round(rgb.r + (255 - rgb.r) * factor),
        g: Math.round(rgb.g + (255 - rgb.g) * factor),
        b: Math.round(rgb.b + (255 - rgb.b) * factor)
    };
}

/** Locale-appropriate quotation marks for raw claim text when no rewritten text exists. */
function quoteMarksForLocale(locale?: string): { open: string; close: string } {
    const lang = (locale ?? getEffectiveUILocale()).split('-')[0].toLowerCase();
    switch (lang) {
        case 'fr': case 'ru': case 'be': case 'uk': return { open: '«', close: '»' };
        case 'de': case 'pl': case 'cs': case 'sk': case 'hr': case 'sl': return { open: '„', close: '“' };
        case 'es': case 'it': case 'pt': return { open: '«', close: '»' };
        case 'ja': case 'zh': return { open: '「', close: '」' };
        case 'ar': case 'he': case 'fa': case 'ur': return { open: '"', close: '"' };
        default: return { open: '"', close: '"' };
    }
}

/** Remove the active floating button and clean up its timers. */
let hoveredFloatingButton = false;

function clearFloatingButton() {
    if (hoveredFloatingButton) return;
    if (floatingButtonDismissTimer) {
        clearTimeout(floatingButtonDismissTimer);
        floatingButtonDismissTimer = null;
    }
    if (floatingButtonVisibilityCheck) {
        clearInterval(floatingButtonVisibilityCheck);
        floatingButtonVisibilityCheck = null;
    }
    const existing = document.querySelector(".mf-floating-scroll-btn");
    if (existing) existing.remove();
    if (activeFloatingButton && activeFloatingButton.isConnected) activeFloatingButton.remove();
    activeFloatingButton = null;
}

/** Compute the center X coordinate of the timeline column on screen. */
function getTimelineColumnCenter(): number | null {
    const primaryCol = document.querySelector<HTMLElement>('[data-testid="primaryColumn"]');
    if (primaryCol) {
        const rect = primaryCol.getBoundingClientRect();
        return rect.left + rect.width / 2;
    }
    // Fallback: try to find the scrollable timeline container's center
    let current: Element | null = document.body;
    while (current) {
        const style = getComputedStyle(current as HTMLElement);
        if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
            const rect = (current as HTMLElement).getBoundingClientRect();
            return rect.left + rect.width / 2;
        }
        current = current.parentElement;
    }
    return null;
}

/** Create a floating fixed button at the top or bottom of the viewport, themed
 *  to match the average highlight color of the tweet's claims. */
function createFloatingButton(
    label: string,
    iconSvg: string,
    position: 'top' | 'bottom',
    onClick: () => void,
    classification?: Classification
): HTMLElement {
    clearFloatingButton();

    const isRTL = isRTLLocale(getEffectiveUILocale());
    const avgColor = classification ? averageClaimColor(classification) : null;
    const darkened = avgColor ? darkenColor(avgColor, 0.25) : null;
    const baseRgb = darkened ? `${darkened.r}, ${darkened.g}, ${darkened.b}` : "29, 155, 240";

    const timelineCenter = getTimelineColumnCenter();
    const left = timelineCenter !== null ? `${timelineCenter}px` : '50%';
    const transform = timelineCenter !== null ? 'translateX(-50%)' : 'translateX(-50%)';

    const btn = document.createElement("button");
    btn.className = "mf-floating-scroll-btn";
    btn.style.cssText = `
        position: fixed;
        ${position}: 80px;
        left: ${left};
        transform: ${transform};
        z-index: 9999;
        display: inline-flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 4px;
        padding: 10px 20px;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,0.25);
        background: rgba(${baseRgb}, 0.92);
        color: #fff;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        cursor: pointer;
        box-shadow: 0 6px 20px rgba(0,0,0,0.35);
        backdrop-filter: blur(6px);
        direction: ${isRTL ? 'rtl' : 'ltr'};
        transition: transform 0.15s ease, box-shadow 0.15s ease, background-color 0.15s ease;
        max-width: min(90vw, 520px);
        min-width: 140px;
    `;

    btn.addEventListener("mouseenter", () => { hoveredFloatingButton = true; });
    btn.addEventListener("mouseleave", () => { hoveredFloatingButton = false; });

    // Capture the handler once so stale closures can't fire after replacement.
    const handler = () => {
        clearFloatingButton();
        onClick();
    };
    btn.addEventListener("click", handler);

    document.body.appendChild(btn);
    activeFloatingButton = btn;
    return btn;
}

/** Build the inner HTML for the Fact-Checked button: icon + default label. */
function factCheckedButtonDefaultHtml(label: string, iconSvg: string, isRTL: boolean): string {
    const dirStyle = isRTL ? 'flex-direction:row-reverse;' : 'flex-direction:row;';
    return `<div class="mf-fc-btn-main" style="display:flex;${dirStyle}align-items:center;gap:8px;font-size:15px;font-weight:700;letter-spacing:-0.01em;">${isRTL ? `<span>${label}</span>${iconSvg}` : `${iconSvg}<span>${label}</span>`}</div>`;
}

/** Build the preview text (first 140 chars of tweet, italic, with ellipsis if cut). */
function factCheckedButtonPreviewHtml(tweetText: string, isRTL: boolean): string {
    const preview = tweetText.length > 140 ? tweetText.slice(0, 140) + '...' : tweetText;
    const escaped = preview.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<div class="mf-fc-btn-preview" style="font-size:12px;line-height:1.35;font-weight:400;font-style:italic;opacity:0.92;text-align:${isRTL ? 'right' : 'left'};max-width:340px;white-space:normal;word-wrap:break-word;">${escaped}</div>`;
}

/** Build the claims list HTML for the Fact-Checked button hover state. */
function factCheckedButtonClaimsHtml(classification: Classification, isRTL: boolean): string {
    const claims = classification.claims ?? [];
    if (claims.length === 0) return '';
    const locale = getEffectiveUILocale();
    const q = quoteMarksForLocale(locale);
    const rows = claims.map(cl => {
        const display = (cl.rewritten && cl.rewritten !== cl.text) ? cl.rewritten : `${q.open}${cl.text}${q.close}`;
        const escaped = display.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const badgeColor = cl.confidence !== undefined && cl.veracity !== undefined
            ? confidenceRgba(cl.confidence, 1, cl.veracity)
            : 'rgb(180,180,180)';
        const badgeLabel = cl.confidence !== undefined && cl.veracity !== undefined
            ? verdictLabel(cl.confidence, cl.veracity)
            : t("verdictResearching");
        return `<div class="mf-fc-btn-claim" style="display:flex;align-items:center;${isRTL ? 'flex-direction:row-reverse;' : 'flex-direction:row;'}gap:6px;margin:2px 0;white-space:nowrap;width:100%;"><span style="display:inline-flex;align-items:center;padding:2px 7px;border-radius:999px;font-size:10px;font-weight:600;background:rgba(0,0,0,0.5);color:${badgeColor};white-space:nowrap;flex-shrink:0;">${badgeLabel}</span><span style="font-size:11px;${isRTL ? 'text-align:right;' : 'text-align:left;'}overflow:hidden;text-overflow:ellipsis;max-width:280px;opacity:0.95;">${escaped}</span></div>`;
    });
    return `<div class="mf-fc-btn-claims" style="display:flex;flex-direction:column;align-items:${isRTL ? 'flex-end' : 'flex-start'};gap:2px;max-width:360px;">${rows.join('')}</div>`;
}

/** Build the full Fact-Checked button contents with main label + extra area above. */
function factCheckedButtonContent(extraHtml: string, label: string, iconSvg: string, isRTL: boolean): string {
    const main = factCheckedButtonDefaultHtml(label, iconSvg, isRTL);
    return `${extraHtml}${main}`;
}

/** Show the "Fact-Checked" floating button if the tweet is off-screen. */
function showFactCheckedFloatingButton(tweetId: string, originalScrollY: number, classification: Classification) {
    if (isTweetVisible(tweetId)) return;

    const tweetText = findTweetTextInDom(tweetId) ?? '';
    const isRTL = isRTLLocale(getEffectiveUILocale());
    const avgColor = averageClaimColor(classification);
    const darkened = avgColor ? darkenColor(avgColor, 0.25) : null;
    const brightened = avgColor ? brightenColor(avgColor, 0.5) : null;
    const normalRgb = darkened ? `${darkened.r}, ${darkened.g}, ${darkened.b}` : "29, 155, 240";
    const hoverRgb = brightened ? `${brightened.r}, ${brightened.g}, ${brightened.b}` : "29, 155, 240";

    const btn = createFloatingButton(t("factCheckedFloatingButton"), upArrowSvg, 'top', async () => {
        // Capture the scroll position *right before* we animate to the tweet so
        // the Go Back button returns the user to exactly where they were when they
        // clicked, not to a stale value captured earlier.
        const capturedOriginalScrollY = window.scrollY;
        await scrollToTweet(tweetId, 1000);
        showGoBackFloatingButton(tweetId, capturedOriginalScrollY, classification);
    }, classification);

    // Default content: label only.
    btn.innerHTML = factCheckedButtonDefaultHtml(t("factCheckedFloatingButton"), upArrowSvg, isRTL);

    // Stop the preview popover from being placed on top of this button.
    (btn as any)._mfIsFactCheckedButton = true;

    let previewTimer: ReturnType<typeof setTimeout> | null = null;
    let popoverTimer: ReturnType<typeof setTimeout> | null = null;
    let showingClaims = false;

    function setHoverStyle() {
        btn.style.backgroundColor = `rgba(${hoverRgb}, 0.92)`;
        btn.style.transform = "translateX(-50%) scale(1.03)";
        btn.style.boxShadow = "0 8px 26px rgba(0,0,0,0.45)";
    }

    function setNormalStyle() {
        btn.style.backgroundColor = `rgba(${normalRgb}, 0.92)`;
        btn.style.transform = "translateX(-50%) scale(1)";
        btn.style.boxShadow = "0 6px 20px rgba(0,0,0,0.35)";
    }

    function showPreview() {
        showingClaims = false;
        setHoverStyle();
        btn.innerHTML = factCheckedButtonContent(
            factCheckedButtonPreviewHtml(tweetText, isRTL),
            t("factCheckedFloatingButton"), upArrowSvg, isRTL
        );
    }

    function showClaims() {
        showingClaims = true;
        setHoverStyle();
        btn.innerHTML = factCheckedButtonContent(
            factCheckedButtonClaimsHtml(classification, isRTL),
            t("factCheckedFloatingButton"), upArrowSvg, isRTL
        );
    }

    function resetButton() {
        showingClaims = false;
        setNormalStyle();
        btn.innerHTML = factCheckedButtonDefaultHtml(t("factCheckedFloatingButton"), upArrowSvg, isRTL);
        if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; }
        if (popoverTimer) { clearTimeout(popoverTimer); popoverTimer = null; }
    }

    btn.addEventListener("mouseenter", () => {
        showPreview();
        if (previewTimer) clearTimeout(previewTimer);
        previewTimer = setTimeout(() => {
            if (hoveredFloatingButton) showClaims();
        }, 1000);
    });

    btn.addEventListener("mouseleave", () => {
        resetButton();
    });

    btn.addEventListener("mouseover", (e) => {
        const target = e.target as HTMLElement;
        if (target.closest(".mf-fc-btn-claim")) {
            if (popoverTimer) clearTimeout(popoverTimer);
            popoverTimer = setTimeout(() => {
                if (!hoveredFloatingButton) return;
                const claimEl = target.closest(".mf-fc-btn-claim") as HTMLElement | null;
                if (!claimEl) return;
                const index = Array.from(btn.querySelectorAll(".mf-fc-btn-claim")).indexOf(claimEl);
                const claim = classification.claims?.[index];
                if (claim) {
                    showPreviewPopoverFromButton(btn, claim, classification);
                }
            }, 1000);
        }
    });

    // Auto-dismiss after 10 seconds or when the user scrolls the tweet into view.
    floatingButtonDismissTimer = setTimeout(() => clearFloatingButton(), 10000);
    floatingButtonVisibilityCheck = setInterval(() => {
        if (isTweetVisible(tweetId)) {
            clearFloatingButton();
        }
    }, 500);
}

/** Show the "Go Back" floating button after scrolling to the tweet. */
function showGoBackFloatingButton(tweetId: string, originalScrollY: number, classification: Classification) {
    const label = t("goBackFloatingButton");
    const isRTL = isRTLLocale(getEffectiveUILocale());

    const btn = createFloatingButton(label, downArrowSvg, 'bottom', async () => {
        await scrollToPosition(originalScrollY, 1000);
    }, classification);

    // Force the label text to be present and protect against empty labels.
    const safeLabel = label || "Go Back";
    btn.innerHTML = `<div style="display:flex;${isRTL ? 'flex-direction:row-reverse;' : 'flex-direction:row;'}align-items:center;gap:8px;font-size:15px;font-weight:700;">${isRTL ? `<span>${safeLabel}</span>${downArrowSvg}` : `${downArrowSvg}<span>${safeLabel}</span>`}</div>`;

    btn.addEventListener("mouseenter", () => {
        btn.style.transform = "translateX(-50%) scale(1.03)";
        btn.style.boxShadow = "0 8px 26px rgba(0,0,0,0.45)";
    });
    btn.addEventListener("mouseleave", () => {
        btn.style.transform = "translateX(-50%) scale(1)";
        btn.style.boxShadow = "0 6px 20px rgba(0,0,0,0.35)";
    });

    // Auto-dismiss 10 seconds after the fact-checked tweet leaves the viewport,
    // or immediately if the user has already returned to the original position.
    let becameInvisibleAt: number | null = null;
    floatingButtonVisibilityCheck = setInterval(() => {
        const visible = isTweetVisible(tweetId);
        if (!visible) {
            if (becameInvisibleAt === null) becameInvisibleAt = performance.now();
            else if (performance.now() - becameInvisibleAt >= 10000) {
                clearFloatingButton();
            }
        } else {
            becameInvisibleAt = null;
        }
        if (Math.abs(window.scrollY - originalScrollY) < 5) {
            clearFloatingButton();
        }
    }, 500);
}

/** Track pending claims for on-hold Disinfact clicks and trigger the floating
 *  scroll button when all claims are done and the tweet is off-screen. */
function updateOnHoldScrollTracking(classification: Classification) {
    const state = onHoldScrollStates.get(classification.id);
    if (!state) return;

    // Collect all claims that belong to this tweet (main + quoted).
    const allClaims: Claim[] = [
        ...(classification.claims ?? []),
        ...(classification.quoting?.claims ?? [])
    ];

    // If we have no claims yet, keep waiting; a later broadcast will supply them.
    if (allClaims.length === 0) return;

    // Rebuild the pending set each time from the current claim texts so that
    // rewritten claims or claim reordering don't leave stale pending entries.
    const currentClaimTexts = new Set(allClaims.map(cl => cl.text));
    for (const text of Array.from(state.pendingClaimTexts)) {
        if (!currentClaimTexts.has(text)) state.pendingClaimTexts.delete(text);
    }
    for (const cl of allClaims) {
        const isResearched = cl.verdict !== "research required" && cl.note !== null && cl.note !== undefined;
        if (!isResearched && !state.pendingClaimTexts.has(cl.text)) {
            state.pendingClaimTexts.add(cl.text);
        }
    }

    // Remove claims that have finished research.
    for (const cl of allClaims) {
        const isResearched = cl.verdict !== "research required" && cl.note !== null && cl.note !== undefined;
        if (isResearched) {
            state.pendingClaimTexts.delete(cl.text);
        }
    }

    // Only show the floating button once every claim is done.
    if (state.pendingClaimTexts.size === 0) {
        const anyFresh = allClaims.some(cl => cl.freshlyResearched);
        if (anyFresh) {
            showFactCheckedFloatingButton(classification.id, state.originalScrollY, classification);
        }
        onHoldScrollStates.delete(classification.id);
    }
}

/** Decode HTML entities (e.g. &amp; → &) in text from X's API. */
function htmlDecode(text: string): string {
  const el = document.createElement('div');
  el.innerHTML = text;
  return el.textContent ?? text;
}

let debounceTimeout: NodeJS.Timeout | null = null;
let stylesInjected = false;

export function injectClassifications(classifications: Classification[], tweetTextCache?: Map<string, string>, translatedTextCache?: Map<string, string>) {
    console.log(`[misinfo] injectClassifications: received ${classifications.length} classifications`, classifications.map(c => ({ id: c.id, claims: c.claims?.length, hasSegments: !!c.segments, cacheHas: tweetTextCache?.has(c.id), translatedHas: translatedTextCache?.has(c.id) })));

    for (const c of classifications) {
        const idx = allClassifications.findIndex(x => x.id === c.id);
        if (idx >= 0) {
            const old = allClassifications[idx];
            // Determine if segments need re-derivation:
            // 1. Claims text changed (batch refresh)
            // 2. Highlights changed (localization thread completed)
            // 3. translatedLocale changed (sets the text source)
            const claimsChanged = !claimsEqual(c.claims, old.claims);
            const highlightsChanged = c.claims?.some((cl, i) => {
                const oldCl = old.claims?.[i];
                return oldCl && JSON.stringify(cl.highlight) !== JSON.stringify(oldCl.highlight);
            }) ?? false;
            const localeChanged = c.translatedLocale !== old.translatedLocale || c.textLocale !== old.textLocale;
            const needsRedo = claimsChanged || highlightsChanged || localeChanged;
            if (needsRedo) {
                console.log(`[misinfo] injectClassifications: change detected for ${c.id} (claims=${claimsChanged}, highlights=${highlightsChanged}, locale=${localeChanged})`);
            }

            if (needsRedo) {
                // Re-derive segments when claims, highlights, rewritten, or locale changed.
                // Clear the in-progress guard so kickOffTextBreakup can re-run.
                // This is critical for locale-switching scenarios: the first text breakup
                // attempt with English claims on Chinese text fails, but after Thread 1
                // broadcasts French rewritten claims, the guard must NOT block re-derivation.
                textBreakupInProgress.delete(c.id);
                if (old.segments) {
                    console.log(`[misinfo] injectClassifications: re-deriving segments for ${c.id} (claims=${claimsChanged}, highlights=${highlightsChanged}, locale=${localeChanged})`);
                    c.segments = undefined;
                    removeSegmentWraps(c.id);
                }
            } else if (!c.segments && old.segments) {
                // Preserve old segments if nothing changed
                c.segments = old.segments;
            }
            // Same preservation for quoting tweet segments
            if (c.quoting && old.quoting) {
                if (!c.quoting.segments && old.quoting.segments) {
                    const qClaimsChanged = !claimsEqual(c.quoting.claims, old.quoting.claims);
                    if (qClaimsChanged) {
                        console.log(`[misinfo] injectClassifications: quoting claims changed for ${c.id}, discarding quoting segments`);
                        removeSegmentWraps(c.quoting.id);
                    } else {
                        c.quoting.segments = old.quoting.segments;
                    }
                }
            }
            allClassifications[idx] = c;
        } else {
            allClassifications.push(c);
        }
    }

    // Kick off text breakup for any classifications that don't have segments yet
    for (const c of classifications) {
        if (!c.segments && c.claims && c.claims.length > 0) {
            kickOffTextBreakup(c, tweetTextCache, translatedTextCache);
        }
    }

    // Also re-derive quoting segments when the main tweet already has segments
    // but the quoting text breakup was missed (e.g. initial cache miss).
    for (const c of allClassifications) {
        if (c.segments && c.quoting && c.quoting.claims?.length && !c.quoting.segments) {
            const quotedText = tweetTextCache?.get(c.quoting.id) ?? findTweetTextInDom(c.quoting.id);
            if (quotedText) {
                const qTextLocale = c.textLocale ?? c.translatedLocale;
                let qSegments: TextSegment[] | null = null;
                if (qTextLocale && c.quoting.claims.some(cl => cl.highlight?.[qTextLocale])) {
                    qSegments = breakupWithHighlights(quotedText, c.quoting.claims, qTextLocale);
                }
                if (!qSegments) {
                    qSegments = breakupTweetText(quotedText, c.quoting.claims);
                }
                if (qSegments) {
                    c.quoting.segments = qSegments;
                    classificationInjections([c]);
                }
            }
        }
    }

    classificationInjections(classifications);

    // Update floating-scroll-button tracking for tweets that started from on-hold.
    for (const c of classifications) {
        updateOnHoldScrollTracking(c);
    }

    if (!observerSetup) {
        observerSetup = true;
        const observer = new MutationObserver(() => {
            if (debounceTimeout) clearTimeout(debounceTimeout);
            debounceTimeout = setTimeout(() => {
                classificationInjections(allClassifications);
            }, 300);
        });
        observer.observe(document.body, {
            childList: true,
            subtree: true,
        });
    }
}


function kickOffTextBreakup(classification: Classification, tweetTextCache?: Map<string, string>, translatedTextCache?: Map<string, string>) {
    // Guard against duplicate text breakup for the same tweet
    if (textBreakupInProgress.has(classification.id)) {
        console.log(`[misinfo] Text breakup: already in progress for ${classification.id}, skipping`);
        return;
    }
    textBreakupInProgress.add(classification.id);

    const claims = classification.claims ?? [];

    // Pick the best text: the text currently displayed (as told by background) > caches > DOM
    let tweetText = classification.translatedText
        || translatedTextCache?.get(classification.id)
        || tweetTextCache?.get(classification.id)
        || findTweetTextInDom(classification.id);

    if (!tweetText) {
        console.log(`[misinfo] Text breakup: could not find tweet text for ${classification.id}`);
        textBreakupInProgress.delete(classification.id);
        return;
    }

    // X's API returns HTML-encoded entities (&amp; → &, &lt; → <, etc.);
    // decode them so they render correctly with createTextNode and match
    // against claim substrings that were extracted from the encoded text.
    tweetText = htmlDecode(tweetText);

    // Also decode claim text fields since they were extracted as verbatim
    // substrings of the API response and need to match the decoded tweet text.
    for (const cl of claims) {
      cl.text = htmlDecode(cl.text);
      if (cl.rewritten) cl.rewritten = htmlDecode(cl.rewritten);
    }

    // Strip trailing media URLs: Twitter's API full_text appends t.co URLs for
    // attached images/videos at the end. These don't appear in X's displayed text
    // and would show as unwanted raw URLs after injection.
    // When domText is unavailable (tweet not yet in DOM), strip trailing t.co URLs
    // unconditionally — they are always media attachments, never user-shared links.
    const domText = findTweetTextInDom(classification.id);
    const trailingMatch = tweetText.match(/\s+(https:\/\/t\.co\/\w+)\s*$/);
    if (trailingMatch && (!domText || !domText.includes(trailingMatch[1]))) {
        tweetText = tweetText.slice(0, trailingMatch.index).trim();
    }

    // textLocale is the locale of the text currently shown (original or translation).
    // translatedText now holds whichever text is displayed, not strictly the Grok translation.
    const textLocale = classification.textLocale ?? classification.translatedLocale;
    const hasTextLocale = !!textLocale;

    console.log(`[misinfo] Text breakup for ${classification.id}: textLocale=${textLocale ?? 'none'}, ${claims.length} claims`);

    // Try stored highlights first using the current text locale.
    let mainSegments: TextSegment[] | null = null;

    if (hasTextLocale) {
        const hlKey = textLocale!;
        const hasHl = claims.some(c => c.highlight && c.highlight[hlKey]);
        console.log(`[misinfo] Text breakup for ${classification.id}: trying highlight key ${hlKey}, has=${hasHl}`);
        if (hasHl) {
            mainSegments = breakupWithHighlights(tweetText, claims, hlKey);
            console.log(`[misinfo] Text breakup for ${classification.id}: breakupWithHighlights result=${mainSegments ? mainSegments.length + ' segments' : 'null'}`);
        }
    }
    if (!mainSegments) {
        // Try matching claims against the text using fuzzy matching.
        // For non-original locales, also try rewritten claim text as a fallback.
        mainSegments = breakupTweetText(tweetText, claims);
        if (!mainSegments) {
            const fallbackClaims = hasTextLocale
                ? claims.map(c => ({ ...c, text: c.rewritten && c.rewritten !== c.text ? c.rewritten : c.text }))
                : claims;
            mainSegments = breakupTweetText(tweetText, fallbackClaims);
            if (mainSegments) {
                console.log(`[misinfo] Text breakup: matched via rewritten claims for ${classification.id}`);
            }
        }
    }

    if (mainSegments) {
        classification.segments = mainSegments;
        console.log(`[misinfo] Text breakup: created ${mainSegments.length} segments for ${classification.id}`);
    } else {
        // Show plain text as last resort
        console.log(`[misinfo] Text breakup: no segments created for ${classification.id}, showing plain text`);
        classification.segments = [{ text: tweetText, claimIndex: null }];
    }

    // Handle quoted tweet segments: prefer stored highlights, then fuzzy matching.
    if (classification.quoting && classification.quoting.claims && classification.quoting.claims.length > 0) {
        const quotedText = tweetTextCache?.get(classification.quoting.id) ?? findTweetTextInDom(classification.quoting.id);
        if (quotedText) {
            let quotedSegments: TextSegment[] | null = null;
            if (hasTextLocale) {
                const hasQuotedHl = classification.quoting.claims.some(c => c.highlight && c.highlight[textLocale!]);
                if (hasQuotedHl) {
                    quotedSegments = breakupWithHighlights(quotedText, classification.quoting.claims, textLocale!);
                    console.log(`[misinfo] Text breakup for ${classification.id}: quoted breakupWithHighlights result=${quotedSegments ? quotedSegments.length + ' segments' : 'null'}`);
                }
            }
            if (!quotedSegments) {
                quotedSegments = breakupTweetText(quotedText, classification.quoting.claims);
                if (!quotedSegments && hasTextLocale) {
                    const fallbackQuotedClaims = classification.quoting.claims.map(c => ({
                        ...c,
                        text: c.rewritten && c.rewritten !== c.text ? c.rewritten : c.text
                    }));
                    quotedSegments = breakupTweetText(quotedText, fallbackQuotedClaims);
                }
            }
            if (quotedSegments) {
                classification.quoting.segments = quotedSegments;
            }
        }
    }

    // Re-inject to upgrade to inline segments
    classificationInjections([classification]);

    textBreakupInProgress.delete(classification.id);
}

function findTweetTextInDom(tweetId: string): string | null {
    const tryGetText = (article: Element, bestEffort = false): string | null => {
        const tweetTextEl = article.querySelector('[data-testid="tweetText"]');
        if (tweetTextEl?.textContent) return tweetTextEl.textContent;
        if (!bestEffort) return null;
        // best-effort: the quoted tweet's text may not have data-testid="tweetText",
        // so look for any non-empty text-bearing element in the article
        for (const el of article.querySelectorAll('[lang], div[dir="auto"]')) {
            const text = el.textContent?.trim();
            if (text && text.length > 10 && !el.closest('time')) {
                return el.textContent;
            }
        }
        return null;
    };

    // Primary: find article via status link
    const timeLink = document.querySelector(`a[href*="/status/${tweetId}"]`);
    if (timeLink) {
        const article = timeLink.closest('article');
        if (article) {
            const text = tryGetText(article, true);
            if (text) return text;
        }
    }

    // Fallback: search all tweetText elements for one that's in an article with this tweet id
    const allArticles = document.querySelectorAll('article');
    for (const article of allArticles) {
        const link = article.querySelector(`a[href*="/status/${tweetId}"]`);
        if (link) {
            const text = tryGetText(article, true);
            if (text) return text;
        }
    }

    return null;
}

const textBreakupInProgress = new Set<string>();

function classificationInjections(classifications: Classification[]) {
    for (const classification of classifications) {
        const times = document.querySelectorAll(`a[href*="/status/${classification.id}"]`);
        if (times.length === 0) {
            console.log(`[misinfo] classificationInjections: no DOM elements found for ${classification.id}`);
        }
        for (const time of times) {
            const article = time.closest("article");
            if (!article) {
                console.log(`[misinfo] classificationInjections: no article for ${classification.id} time element`);
                continue;
            }
            injectClassification(time, classification, article);
        }
    }
}

function verdictLabel(probability: number | undefined, veracity?: number): string {
    if (probability === undefined) return t("verdictResearching");
    if (probability < 0.2) return t("verdictUnknown");

    const trueLabel = t("verdictTrue");
    const falseLabel = t("verdictFalse");

    // Fallback: if veracity not provided, use the old combined confidence behavior
    if (veracity === undefined) {
        const abs = Math.abs(probability);
        let likelihoodKey: string | null;
        if (abs >= 0.9) likelihoodKey = null;
        else if (abs >= 0.8) likelihoodKey = "VeryLikely";
        else if (abs >= 0.5) likelihoodKey = "Likely";
        else likelihoodKey = "Possibly";
        const v = probability >= 0 ? trueLabel : falseLabel;
        if (!likelihoodKey) return v;
        const adj = t("adj" + likelihoodKey);
        return t("badgeAdjVerdict", [adj, v]);
    }

    // Probability adjective (how confident)
    let probKey: string | null = null;
    if (probability >= 0.9) probKey = null;
    else if (probability >= 0.8) probKey = "VeryLikely";
    else if (probability >= 0.5) probKey = "Likely";
    else probKey = "Possibly";

    // Veracity adjective (degree of truth)
    const absVer = Math.abs(veracity);
    let verKey: string | null = null;
    if (absVer >= 0.9) verKey = null;
    else if (absVer >= 0.8) verKey = "Mostly";
    else if (absVer >= 0.5) verKey = "Arguably";
    else if (absVer >= 0.2) verKey = "Partially";
    else verKey = "Equivocally";

    const verdict = veracity >= 0 ? trueLabel : falseLabel;

    if (!probKey && !verKey) return verdict;
    if (probKey && !verKey) return t("badgeVerdictAdj", [verdict, t("adj" + probKey)]);
    if (!probKey && verKey) return t("badgeAdjVerdict", [t("adj" + verKey), verdict]);
    // Both adjectives present — Verbose template for multi-word confidence adj
    // ("Very Likely"), compact template for single-word (Likely, Possibly).
    // Each locale defines both templates independently to handle its own grammar.
    return probKey === "VeryLikely"
        ? t("badgeAdjVerdictAdj2Verbose", [t("adj" + verKey), verdict, t("adj" + probKey)])
        : t("badgeAdjVerdictAdj2", [t("adj" + verKey), verdict, t("adj" + probKey)]);
}

/** Color based on veracity (hue: red → yellow → green) with confidence as saturation.
 *  veracity=-1 → red, 0 → yellow, +1 → green.
 *  confidence=0 → fully desaturated (grey), 1 → fully saturated.
 *  Undefined probability/veracity → grey (Fact-Checking state). */
function factCheckColor(probability: number | undefined, veracity?: number, bgOpacity = 0.15): string {
    // Fact-Checking state — neutral grey
    if (probability === undefined || veracity === undefined)
        return `background: rgba(128, 128, 128, ${bgOpacity}); color: rgb(128, 128, 128)`;

    const v = Math.max(-1, Math.min(1, veracity));
    const t = (v + 1) / 2;   // 0 = red, 0.5 = yellow, 1 = green
    const s = Math.max(0, Math.min(1, probability));  // saturation

    // Hue: red → yellow → green
    let r: number, g: number, b: number;
    if (t <= 0.5) {
        const p = t / 0.5;
        r = 255;
        g = Math.round(255 * p);
        b = 0;
    } else {
        const p = (t - 0.5) / 0.5;
        r = Math.round(255 * (1 - p));
        g = 255;
        b = 0;
    }

    // Desaturate toward luminance grey based on confidence
    const lum = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    const fr = Math.round(lum + (r - lum) * s);
    const fg = Math.round(lum + (g - lum) * s);
    const fb = Math.round(lum + (b - lum) * s);

    return `background: rgba(${fr}, ${fg}, ${fb}, ${bgOpacity}); color: rgb(${fr}, ${fg}, ${fb})`;
}

/** Fact-checking color as an rgba string, for segment background use.
 *  The caller passes the background opacity (e.g. 0.25 for claim bg). */
function confidenceRgba(probability: number | undefined, opacity: number, veracity?: number): string {
    // Fact-Checking state — neutral grey
    if (probability === undefined || veracity === undefined)
        return `rgba(128, 128, 128, ${opacity})`;

    const v = Math.max(-1, Math.min(1, veracity));
    const t = (v + 1) / 2;
    const s = Math.max(0, Math.min(1, probability));

    let r: number, g: number, b: number;
    if (t <= 0.5) {
        const p = t / 0.5;
        r = 255;
        g = Math.round(255 * p);
        b = 0;
    } else {
        const p = (t - 0.5) / 0.5;
        r = Math.round(255 * (1 - p));
        g = 255;
        b = 0;
    }

    const lum = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    const fr = Math.round(lum + (r - lum) * s);
    const fg = Math.round(lum + (g - lum) * s);
    const fb = Math.round(lum + (b - lum) * s);

    return `rgba(${fr}, ${fg}, ${fb}, ${opacity})`;
}

function extractReasoning(note: string | null | undefined, probability: number | undefined, veracity?: number): string {
    if (!note) return "";
    if (probability === undefined) return note;
    const prefix = verdictLabel(probability, veracity) + ": ";
    // Only strip the verdict prefix if the note actually starts with it.
    // DB-loaded notes are stored without a prefix, so falling back to the
    // first ": " would truncate reasoning text that contains colons.
    if (note.startsWith(prefix)) return note.slice(prefix.length);
    return note;
}

// ---- Fallback rendering (Phase 1) ----

function renderClaims(c: Classification | QuotedClassification, claimsOverride?: Claim[]): string {
    const claims = claimsOverride ?? c.claims;
    if (!claims)
        return '';
    return claims
        .map((claim) => {
            const isOnHold = claim.reclassifyOnHold;
            const label = isOnHold ? "Disinfact" : verdictLabel(claim.confidence, claim.veracity);
            const reasoning = isOnHold
                ? (claim.cachedNote ?? "Click to re-check this claim")
                : extractReasoning(claim.note, claim.confidence, claim.veracity);
            // Show only the highlight locale that was actually used for injection attempts.
            // For translated tweets that's the destination locale; otherwise show the first available.
            const cls = c as Classification;
            const hlKey = cls.translatedLocale ?? cls.textLocale ?? Object.keys(claim.highlight ?? {})[0];
            const hlValue = hlKey ? claim.highlight?.[hlKey] : undefined;
            const hlDebug = hlKey && hlValue ? JSON.stringify({ [hlKey]: hlValue }) : 'null';
            return `
            <div style="margin-bottom: 8px; line-height: 1.4;">
                ${claim.text !== (claim.rewritten ?? claim.text) ? `<div style="font-size: 10px; color: inherit; opacity: 0.35; margin-bottom: 1px;">${claim.text}</div>` : ''}
                <div style="font-size: 12px; color: inherit; opacity: 0.55; margin-bottom: 3px;">${claim.rewritten ?? claim.text}</div>
                <div style="font-size: 9px; color: inherit; opacity: 0.25; font-family: monospace; margin-bottom: 2px;">${hlDebug}</div>
                <div>
                    <span style="display: inline-flex; align-items: center; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; white-space: nowrap; ${isOnHold ? 'color: rgb(180, 180, 180); background: rgba(128, 128, 128, 0.25);' : factCheckColor(claim.confidence, claim.veracity)}">${isOnHold ? '' : ((claim.confidence === undefined || claim.refreshing) ? '<span class="mf-fc-spinner"></span>' : '')}${label}</span>
                    <span style="font-size: 13px; color: inherit;"> ${reasoning}</span>
                </div>
            </div>
        `;
        })
        .join("");
}

// ---- Inline segment rendering (Phase 2) ----

function getInlineStyles(): string {
    return `
.mf-segment-wrap {
    display: inline;
}
.mf-segment-plain {
    display: inline;
    white-space: pre-wrap;
}
.mf-segment-plain a:hover {
    text-decoration: underline;
}
.mf-segment-claim {
    display: inline;
    white-space: pre-wrap;
    cursor: pointer;
    position: relative;
    border-radius: 3px;
    padding: 1px 0;
    transition: background-color 0.15s ease;
}
.mf-segment-claim.mf-highlight-reveal {
    background-repeat: no-repeat;
    transition: background-size 0.45s ease-out, background-color 0.15s ease;
}
.mf-inline-badge {
    display: inline-block;
    vertical-align: middle;
    padding: 0 6px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
    margin-left: 3px;
    vertical-align: middle;
}
.mf-popover {
    position: absolute;
    z-index: 1;
    background: #1a1a2e;
    border: 1px solid rgba(255,255,255,0.15);
    border-radius: 12px;
    padding: 12px 16px;
    font-size: 14px;
    line-height: 1.4;
    max-width: 360px;
    min-width: 320px;
    box-sizing: border-box;
    box-shadow: 0 8px 24px rgba(0,0,0,0.4);
    color: #e1e1e1;
}
.mf-popover.mf-popover-preview {
    opacity: 0;
    transform: translateY(6px) scale(0.98);
    transform-origin: top center;
    transition: opacity 180ms cubic-bezier(0.4, 0, 0.2, 1),
                transform 180ms cubic-bezier(0.4, 0, 0.2, 1);
    pointer-events: none;
}
.mf-popover.mf-popover-preview.mf-popover-visible {
    opacity: 0.75;
    transform: translateY(0) scale(1);
    pointer-events: auto;
}
.mf-popover.mf-popover-preview.mf-popover-fading {
    opacity: 0;
    transform: translateY(4px) scale(0.98);
    pointer-events: none;
}
.mf-popover-reasoning {
    font-size: 13px;
    color: rgba(225,225,225,0.85);
    word-wrap: break-word;
    user-select: text;
    -webkit-user-select: text;
}
.mf-popover-text-row {
    margin-bottom: 4px;
}
.mf-popover-text-row .mf-popover-text {
    display: inline;
}
.mf-popover-text-row.mf-popover-claim-text .mf-popover-text {
    font-size: 12px;
    color: rgba(225,225,225,0.55);
    font-style: italic;
}
.mf-popover-text-row.mf-popover-reasoning-text .mf-popover-text {
    font-size: 13px;
    color: rgba(225,225,225,0.85);
}
.mf-popover-section-header {
    display: flex;
    align-items: center;
    margin-bottom: 3px;
}
.mf-popover-section-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: rgba(225,225,225,0.4);
}
.mf-popover-copy-icon,
.mf-translate-btn {
    display: inline-flex;
    vertical-align: middle;
    background: transparent;
    border: none;
    border-radius: 3px;
    padding: 1px 3px;
    cursor: pointer;
    color: rgba(225,225,225,0.35);
    line-height: 1;
    align-items: center;
    transition: color 0.15s, background 0.15s;
}
.mf-popover-copy-icon:hover {
    color: rgba(225,225,225,0.85);
    background: rgba(225,225,225,0.1);
}
.mf-popover-copy-icon svg,
.mf-translate-btn svg {
    display: block;
}
.mf-popover-close {
    position: absolute;
    top: 6px;
    right: 10px;
    cursor: pointer;
    font-size: 16px;
    color: rgba(225,225,225,0.5);
    line-height: 1;
}
.mf-popover-close:hover {
    color: rgba(225,225,225,0.9);
}
.mf-spinner {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 2px solid rgba(225,225,225,0.2);
    border-top-color: rgba(225,225,225,0.8);
    border-radius: 50%;
    animation: mf-spin 0.6s linear infinite;
    vertical-align: middle;
    margin-right: 4px;
}
.mf-refresh-spinner {
    display: inline-flex;
    width: 11px;
    height: 11px;
    border: 2px solid rgba(225,225,225,0.2);
    border-top-color: rgba(225,225,225,0.7);
    border-radius: 50%;
    animation: mf-spin 0.6s linear infinite;
    vertical-align: middle;
}
@keyframes mf-spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
}
.mf-fc-spinner {
    display: inline-block;
    width: 10px;
    height: 10px;
    border: 1.5px solid rgba(128,128,128,0.25);
    border-top-color: rgba(128,128,128,0.8);
    border-radius: 50%;
    animation: mf-spin 0.6s linear infinite;
    margin-right: 3px;
    flex-shrink: 0;
}
.mf-popover .mf-popover-copy-icon:hover,
.mf-popover .mf-popover-close:hover {
    background-color: var(--mf-popover-hover) !important;
    color: rgba(255,255,255,0.9) !important;
}
.mf-popover .mf-popover-close:hover {
    border-radius: 3px !important;
}

/* ── Touch-mode button sizing ── */
.is-touch-active .mf-popover-copy-icon,
.is-touch-active .mf-translate-btn {
    padding: 6px 8px !important;
}
.is-touch-active .mf-popover-copy-icon svg,
.is-touch-active .mf-translate-btn svg {
    width: 16px;
    height: 16px;
}
.is-touch-active .mf-popover-close {
    font-size: 22px;
    padding: 4px 8px;
    top: 8px;
    right: 12px;
}
`;
}

function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    const style = document.createElement("style");
    style.textContent = getInlineStyles();
    document.head.appendChild(style);
    // Start watching for touch vs. pointer input so popover buttons
    // get larger touch targets when the user is using their fingers.
    new InputModeManager();
}

function findTweetTextElement(article: Element, isQuoted: boolean = false): Element | null {
    if (isQuoted) {
        // For quoted tweets, find the nested tweet text within the quoted article
        const quotedArticle = article.querySelector('article');
        if (quotedArticle) {
            const el = quotedArticle.querySelector('[data-testid="tweetText"]');
            if (el) return el;
        }
        // Fallback: scan all tweetText elements in the article — the quoted tweet's
        // text is the one that does NOT belong to the main tweet (i.e. the last one).
        const allTexts = article.querySelectorAll('[data-testid="tweetText"]');
        if (allTexts.length >= 2) {
            return allTexts[allTexts.length - 1];
        }
        return null;
    }
    const el = article.querySelector('[data-testid="tweetText"]');
    if (el) return el;
    // Auto-detect: when this article is a quoted tweet (nested inside another
    // article), data-testid="tweetText" may be absent. Try dir="auto" containers.
    if (article.parentElement?.closest('article')) {
        const candidate = article.querySelector('div[dir="auto"], span[dir="auto"]');
        if (candidate && (candidate.textContent?.trim()?.length ?? 0) > 10) {
            return candidate;
        }
    }
    return null;
}

function renderSegmentedTweet(tweetTextEl: Element, segments: TextSegment[], claims: Claim[], batchId: string) {
    // Extract URL href → display-text mapping from existing <a> elements before clearing
    const urlDisplayMap = new Map<string, string>();
    const existingLinks = tweetTextEl.querySelectorAll('a');
    for (const link of existingLinks) {
        const href = link.getAttribute('href');
        const text = link.textContent?.trim();
        if (href && text && href !== text) {
            urlDisplayMap.set(href, text);
        }
    }

    const wrap = buildSegmentWrap(segments, claims, batchId, urlDisplayMap);
    // Clear and replace the tweet text content
    tweetTextEl.innerHTML = "";
    tweetTextEl.appendChild(wrap);
}

/** Create a styled <a> element that visually matches X.com's native links
 *  without depending on X's generated CSS class names. */
function createLinkElement(href: string, displayText: string): HTMLAnchorElement {
    const a = document.createElement("a");
    a.dir = "ltr";
    a.href = href;
    a.rel = "noopener noreferrer nofollow";
    a.target = "_blank";
    a.role = "link";
    a.style.color = "rgb(29, 155, 240)";
    a.style.textDecoration = "none";
    a.style.cursor = "pointer";

    if (displayText.startsWith("https://")) {
        const httpsSpan = document.createElement("span");
        httpsSpan.ariaHidden = "true";
        httpsSpan.style.position = "absolute";
        httpsSpan.style.width = "1px";
        httpsSpan.style.height = "1px";
        httpsSpan.style.padding = "0";
        httpsSpan.style.margin = "-1px";
        httpsSpan.style.overflow = "hidden";
        httpsSpan.style.clip = "rect(0, 0, 0, 0)";
        httpsSpan.style.whiteSpace = "nowrap";
        httpsSpan.style.border = "0";
        httpsSpan.textContent = "https://";
        a.appendChild(httpsSpan);
        a.appendChild(document.createTextNode(displayText.slice("https://".length)));
    } else {
        a.textContent = displayText;
    }

    return a;
}

/** Build a DocumentFragment for a plain text segment, converting URLs to <a> elements. */
function buildPlainSegmentContent(text: string, urlDisplayMap: Map<string, string>): DocumentFragment {
    const fragment = document.createDocumentFragment();
    const urlRegex = /https?:\/\/[^\s<>"'`]+/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = urlRegex.exec(text)) !== null) {
        if (match.index > lastIndex) {
            fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
        }
        const url = match[0];
        const displayText = urlDisplayMap.get(url) ?? url;
        fragment.appendChild(createLinkElement(url, displayText));
        lastIndex = urlRegex.lastIndex;
    }

    if (lastIndex < text.length) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }

    if (fragment.childNodes.length === 0) {
        fragment.appendChild(document.createTextNode(text));
    }

    return fragment;
}

/** Build the segment <span> elements used by renderSegmentedTweet. */
function buildSegmentWrap(segments: TextSegment[], claims: Claim[], batchId: string, urlDisplayMap: Map<string, string> = new Map()): HTMLSpanElement {
    const wrap = document.createElement("span");
    wrap.className = "mf-segment-wrap";

    for (const seg of segments) {
        if (seg.claimIndex === null) {
            const span = document.createElement("span");
            span.className = "mf-segment-plain";
            span.appendChild(buildPlainSegmentContent(seg.text, urlDisplayMap));
            wrap.appendChild(span);
        } else {
            const claim = claims[seg.claimIndex];
            if (!claim) {
                const span = document.createElement("span");
                span.className = "mf-segment-plain";
                span.textContent = seg.text;
                wrap.appendChild(span);
                continue;
            }

            const label = verdictLabel(claim.confidence, claim.veracity);
            const reasoning = extractReasoning(claim.note, claim.confidence, claim.veracity);
            const isOnHold = claim.reclassifyOnHold;
            const bgColor = isOnHold
              ? 'rgba(128, 128, 128, 0.25)'
              : confidenceRgba(claim.confidence, 0.25, claim.veracity);
            const hoverBgColor = isOnHold
              ? 'rgba(128, 128, 128, 0.35)'
              : confidenceRgba(claim.confidence, 0.5, claim.veracity);

            const span = document.createElement("span");
            span.className = "mf-segment-claim";
            span.dataset.claimIndex = String(seg.claimIndex);
            span.dataset.claimText = claim.text;
            span.dataset.claimRewritten = claim.rewritten ?? claim.text;
            span.dataset.batchId = batchId;
            span.dataset.verdict = label;
            span.dataset.reasoning = reasoning;
            span.dataset.probability = String(claim.confidence ?? "");
            span.dataset.veracity = String(claim.veracity ?? "");
            span.dataset.hoverBg = hoverBgColor;
            span.dataset.sources = JSON.stringify(claim.sources ?? []);
            span.dataset.dbClaimText = claim.dbClaimText ?? '';
            if (claim.claimLocale) span.dataset.claimLocale = claim.claimLocale;
            if (claim.reasoningLocale) span.dataset.reasoningLocale = claim.reasoningLocale;
            span.dataset.refreshing = claim.refreshing ? "true" : "";
            if (isOnHold) {
              span.dataset.reclassifyOnHold = "true";
              span.dataset.cachedVerdict = claim.cachedVerdict ?? "";
              span.dataset.cachedNote = claim.cachedNote ?? "";
              span.dataset.cachedConfidence = String(claim.cachedConfidence ?? "");
              span.dataset.cachedVeracity = String(claim.cachedVeracity ?? "");
              span.dataset.cachedSources = JSON.stringify(claim.cachedSources ?? []);
            }
            span.style.backgroundColor = bgColor;
            span.textContent = seg.text;

            // RTL: place the badge on the left of the claim text.
            const isRTL = isRTLLocale(getEffectiveUILocale());
            if (isRTL) span.dir = "rtl";

            // Animate the highlight background wiping in.
            animateHighlightReveal(span, bgColor);

            // Helper to create an inline badge for this span.
            const createInlineBadge = (permanent: boolean): HTMLElement => {
                const pVal = parseFloat(span.dataset.probability ?? "");
                const prob = isNaN(pVal) ? undefined : pVal;
                const vVal = parseFloat(span.dataset.veracity ?? "");
                const ver = isNaN(vVal) ? undefined : vVal;
                const isRefreshing = span.dataset.refreshing === "true";
                const lbl = isOnHold ? "Disinfact" : verdictLabel(prob, ver);
                const txtColor = isOnHold
                  ? 'rgb(180, 180, 180)'
                  : confidenceRgba(prob, 1, ver);
                const badge = document.createElement("span");
                badge.className = "mf-inline-badge";
                badge.style.cssText = `display: inline-flex; align-items: center; border-radius: 999px; font-size: 11px; font-weight: 600; white-space: nowrap; margin-left: ${isRTL ? '0' : '3px'}; margin-right: ${isRTL ? '3px' : '0'}; color: ${txtColor}; background: rgba(0,0,0,0.7); cursor: pointer;`;
                if (isRefreshing || (prob === undefined && !isOnHold)) {
                    const fcSpinner = document.createElement("span");
                    fcSpinner.className = "mf-fc-spinner";
                    if (isRTL) {
                        // Text first, then spinner on the right side.
                        fcSpinner.style.marginRight = "0";
                        fcSpinner.style.marginLeft = "3px";
                        badge.appendChild(document.createTextNode(lbl));
                        badge.appendChild(fcSpinner);
                    } else {
                        badge.appendChild(fcSpinner);
                        badge.appendChild(document.createTextNode(lbl));
                    }
                } else {
                    badge.textContent = lbl;
                    if (isRTL) badge.dir = "rtl";
                }
                if (permanent) {
                    (span as any)._mfBadgePermanent = badge;
                }
                return badge;
            };

            // For on-hold claims, show the Disinfact badge immediately and keep it.
            if (isOnHold) {
                span.appendChild(createInlineBadge(true));
            }

            // Hover: show inline badge + full opacity (mouseenter/mouseleave don't fire for child elements)
            span.addEventListener("mouseenter", () => {
                if (span.querySelector(".mf-inline-badge")) return;
                if (span.dataset.hoverBg) {
                    span.style.backgroundColor = span.dataset.hoverBg;
                }
                span.appendChild(createInlineBadge(!!isOnHold));
            });

            span.addEventListener("mouseleave", () => {
                // Don't remove badge or reset background while popover is open or claim on hold
                if ((span as any)._mfPopoverOpen) return;
                if ((span as any)._mfBadgePermanent) return;
                const pVal = parseFloat(span.dataset.probability ?? "");
                const prob = isNaN(pVal) ? undefined : pVal;
                const vVal = parseFloat(span.dataset.veracity ?? "");
                const ver = isNaN(vVal) ? undefined : vVal;
                const baseBg = confidenceRgba(prob, 0.25, ver);
                span.style.backgroundColor = baseBg;
                const badge = span.querySelector(".mf-inline-badge");
                if (badge) badge.remove();
            });

            wrap.appendChild(span);
        }
    }

    return wrap;
}

function upgradeToSegments(article: Element, classification: Classification | QuotedClassification, batchId: string, isQuoted: boolean = false) {
    const segments = classification.segments;
    const claims = classification.claims;
    if (!segments || segments.length === 0 || !claims || claims.length === 0) return;

    const tweetTextEl = findTweetTextElement(article, isQuoted);
    if (!tweetTextEl) {
        console.log(`[misinfo] upgradeToSegments: no tweetTextEl found for ${classification.id} (isQuoted=${isQuoted})`);
        return;
    }

    const existingWrap = tweetTextEl.querySelector(".mf-segment-wrap");
    if (existingWrap) {
        // Update existing claim span data attributes (verdict, colors, etc.)
        const existingClaimSpans = existingWrap.querySelectorAll(".mf-segment-claim");
        const newHasClaims = segments.some(s => s.claimIndex !== null);

        // If the existing wrap is plain-text only (no highlighted claims) but the
        // new segments contain claims, the DOM structure is wrong and must be
        // rebuilt. This happens after Translate Fact-Checks: the first broadcast
        // renders a plain-text fallback while highlights are still being computed,
        // and the second broadcast arrives with the real highlighted segments.
        if (existingClaimSpans.length === 0 && newHasClaims) {
            console.log(`[misinfo] upgradeToSegments: existing wrap is plain text but new segments have claims for ${classification.id}, re-rendering`);
            existingWrap.remove();
            // fall through to renderSegmentedTweet below
        } else {
            let updated = 0;
            for (const span of existingClaimSpans) {
                const idx = parseInt((span as HTMLElement).dataset.claimIndex ?? "", 10);
                if (isNaN(idx) || !claims[idx]) continue;
                const claim = claims[idx];
                const label = verdictLabel(claim.confidence, claim.veracity);
                const reasoning = extractReasoning(claim.note, claim.confidence, claim.veracity);
                const bgColor = confidenceRgba(claim.confidence, 0.25, claim.veracity);
                const hoverBgColor = confidenceRgba(claim.confidence, 0.5, claim.veracity);
                const el = span as HTMLElement;
                const oldRewritten = el.dataset.claimRewritten;
                const oldVerdict = el.dataset.verdict;
                const oldReasoning = el.dataset.reasoning;
                const oldRefreshing = el.dataset.refreshing;
                const isRefreshing = claim.refreshing;
                const changed =
                    oldVerdict !== label ||
                    oldReasoning !== reasoning ||
                    oldRefreshing !== (isRefreshing ? "true" : "") ||
                    oldRewritten !== (claim.rewritten ?? claim.text);
                el.dataset.verdict = label;
                el.dataset.claimText = claim.text;
                el.dataset.claimRewritten = claim.rewritten ?? claim.text;
                el.dataset.batchId = batchId;
                el.dataset.reasoning = reasoning;
                el.dataset.probability = String(claim.confidence ?? "");
                el.dataset.veracity = String(claim.veracity ?? "");
                el.dataset.hoverBg = hoverBgColor;
                el.dataset.sources = JSON.stringify(claim.sources ?? []);
                el.dataset.dbClaimText = claim.dbClaimText ?? '';
                if (claim.claimLocale) el.dataset.claimLocale = claim.claimLocale;
                if (claim.reasoningLocale) el.dataset.reasoningLocale = claim.reasoningLocale;
                el.dataset.refreshing = isRefreshing ? "true" : "";
                // Preserve on-hold reclassification state so the inline badge keeps
                // showing "Disinfact" and the popover can restore cached values.
                if (claim.reclassifyOnHold) {
                    el.dataset.reclassifyOnHold = "true";
                    el.dataset.cachedVerdict = claim.cachedVerdict ?? "";
                    el.dataset.cachedNote = claim.cachedNote ?? "";
                    el.dataset.cachedConfidence = String(claim.cachedConfidence ?? "");
                    el.dataset.cachedVeracity = String(claim.cachedVeracity ?? "");
                    el.dataset.cachedSources = JSON.stringify(claim.cachedSources ?? []);
                } else {
                    delete el.dataset.reclassifyOnHold;
                    delete el.dataset.cachedVerdict;
                    delete el.dataset.cachedNote;
                    delete el.dataset.cachedConfidence;
                    delete el.dataset.cachedVeracity;
                    delete el.dataset.cachedSources;
                }
                el.style.opacity = "";

                // Animate highlight background changes (e.g. when a neutral/grey
                // highlight turns into a verdict-colored one).
                const currentBg = el.style.backgroundColor;
                const targetBg = bgColor;
                if (currentBg && currentBg !== targetBg) {
                    animateHighlightReveal(el, targetBg);
                } else {
                    el.style.backgroundColor = targetBg;
                }

                // RTL: keep badge on the left of the claim text.
                const isRTLEl = isRTLLocale(getEffectiveUILocale());
                if (isRTLEl) el.dir = "rtl";

                // If this span just became on-hold, render the Disinfact badge immediately.
                if (claim.reclassifyOnHold && !el.querySelector(".mf-inline-badge")) {
                    const badge = document.createElement("span");
                    badge.className = "mf-inline-badge";
                    badge.style.cssText = `display: inline-flex; align-items: center; border-radius: 999px; font-size: 11px; font-weight: 600; white-space: nowrap; margin-left: ${isRTLEl ? '0' : '3px'}; margin-right: ${isRTLEl ? '3px' : '0'}; color: rgb(180, 180, 180); background: rgba(0,0,0,0.7); cursor: pointer;`;
                    badge.textContent = "Disinfact";
                    el.appendChild(badge);
                    (el as any)._mfBadgePermanent = badge;
                }

                if (changed) {
                    updated++;
                    const badge = el.querySelector(".mf-inline-badge");
                    if (badge) {
                        const isOnHold = el.dataset.reclassifyOnHold === "true";
                        const isRefreshingNow = el.dataset.refreshing === "true";
                        const newLabel = isOnHold ? "Disinfact" : verdictLabel(claim.confidence, claim.veracity);
                        const newColor = isOnHold
                            ? 'rgb(180, 180, 180)'
                            : confidenceRgba(claim.confidence, 1, claim.veracity);
                        (badge as HTMLElement).style.color = newColor;
                        (badge as HTMLElement).style.marginLeft = isRTLEl ? '0' : '3px';
                        (badge as HTMLElement).style.marginRight = isRTLEl ? '3px' : '0';
                        badge.innerHTML = '';
                        if (isRefreshingNow || (claim.confidence === undefined && !isOnHold)) {
                            const fcSpinner = document.createElement("span");
                            fcSpinner.className = "mf-fc-spinner";
                            if (isRTLEl) {
                                fcSpinner.style.marginRight = "0";
                                fcSpinner.style.marginLeft = "3px";
                                badge.appendChild(document.createTextNode(newLabel));
                                badge.appendChild(fcSpinner);
                            } else {
                                badge.appendChild(fcSpinner);
                                badge.appendChild(document.createTextNode(newLabel));
                            }
                        } else {
                            badge.textContent = newLabel;
                            if (isRTLEl) (badge as HTMLElement).dir = "rtl";
                        }
                    }
                }
            }
            console.log(`[misinfo] upgradeToSegments: updated ${updated}/${existingClaimSpans.length} claim spans for ${classification.id}`);
            updateOpenPopover();
            return;
        }
    }

    console.log(`[misinfo] upgradeToSegments: upgrading ${classification.id} with ${segments.length} segments`);
    injectStyles();
    renderSegmentedTweet(tweetTextEl, segments, claims, batchId);

    // Remove the fallback injection div if it exists
    const fallbackDiv = article.querySelector(`[classification-id="${classification.id}"]`);
    if (fallbackDiv) fallbackDiv.remove();

    // Remove fallback for quoted tweet too
    if (!isQuoted && (classification as Classification).quoting) {
        const quoting = (classification as Classification).quoting!;
        const quotedArticle = article.querySelector('article');
        if (quotedArticle) {
            const qFallback = quotedArticle.querySelector(`[classification-id="${quoting.id}"]`);
            if (qFallback) qFallback.remove();
        }
    }

    // Set up event delegation on the article for hover and click
    setupArticleHandlers(article);
}

let globalHandlersSetup = false;

function setupGlobalHandlers() {
    if (globalHandlersSetup) return;
    globalHandlersSetup = true;

    // Close popover on click outside
    document.addEventListener("click", (e) => {
        const popovers = document.querySelectorAll(".mf-popover");
        if (popovers.length === 0) return;
        const target = e.target as HTMLElement;
        // Check if click is outside ALL popovers and not on a claim segment
        let outsideAll = true;
        for (const p of popovers) {
            if (p.contains(target)) { outsideAll = false; break; }
        }
        if (outsideAll && !target.closest?.(".mf-segment-claim")) {
            const sel = window.getSelection();
            if (sel && !sel.isCollapsed) return;
            closePopover();
        }
    });

    // Close all popovers on Escape
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closePopover();
    });
}

function setupArticleHandlers(articleEl: Element) {
    const article = articleEl as HTMLElement;
    if (article.dataset.mfHandlers === "true") return;
    article.dataset.mfHandlers = "true";
    setupGlobalHandlers();

    function closestEl(el: Element, selector: string): HTMLElement | null {
        return el.closest(selector) as HTMLElement | null;
    }

    let hoverTimer: ReturnType<typeof setTimeout> | null = null;
    let hoveredSegment: HTMLElement | null = null;

    function openPinnedPopover(target: HTMLElement) {
        if ((target as any)._mfPopoverOpen) {
            closePopover(target);
            return;
        }
        const claimText = target.dataset.claimRewritten ?? target.dataset.claimText ?? "";
        const reasoning = target.dataset.reasoning ?? "";
        const sources: Source[] = (() => {
            try { return JSON.parse(target.dataset.sources ?? "[]"); } catch { return []; }
        })();
        target.style.opacity = "1";
        showPopover(target, reasoning, sources, claimText);
    }

    function startHoverPreview(target: HTMLElement) {
        if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
        hoveredSegment = target;
        hoverTimer = setTimeout(() => {
            if (hoveredSegment !== target) return;
            if ((target as any)._mfPopoverOpen) return;
            showPreviewPopover(target);
        }, 1000);
    }

    function cancelHoverPreview() {
        if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
        hoveredSegment = null;
    }

    article.addEventListener("mouseenter", (e) => {
        const target = closestEl(e.target as Element, ".mf-segment-claim");
        if (!target) return;
        startHoverPreview(target);
    }, true);

    article.addEventListener("mouseleave", (e) => {
        const target = closestEl(e.target as Element, ".mf-segment-claim");
        if (!target) return;
        cancelHoverPreview();
        schedulePreviewPopoverDismiss(target);
    }, true);

    // Click: show popover (capture phase intercepts before X.com's handlers)
    article.addEventListener("click", (e) => {
        const target = closestEl(e.target as Element, ".mf-segment-claim");
        if (!target) return;

        // Don't show popover if the user is selecting text
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) return;

        e.stopPropagation();
        cancelHoverPreview();

        // On-hold claim: immediately restore cached values and show popover
        if (target.dataset.reclassifyOnHold === "true") {
          // Immediately restore cached values on the span
          target.dataset.reclassifyOnHold = "";
          target.dataset.verdict = target.dataset.cachedVerdict ?? "";
          target.dataset.reasoning = target.dataset.cachedNote ?? "";
          target.dataset.probability = target.dataset.cachedConfidence ?? "";
          target.dataset.veracity = target.dataset.cachedVeracity ?? "";
          target.dataset.sources = target.dataset.cachedSources ?? "[]";
          // Remove permanent badge
          delete (target as any)._mfBadgePermanent;
          const badge = target.querySelector(".mf-inline-badge");
          if (badge) badge.remove();
          // Update background to cached color
          const prob = parseFloat(target.dataset.probability);
          const ver = parseFloat(target.dataset.veracity);
          target.style.backgroundColor = confidenceRgba(isNaN(prob) ? undefined : prob, 0.25, isNaN(ver) ? undefined : ver);
          target.dataset.hoverBg = confidenceRgba(isNaN(prob) ? undefined : prob, 0.5, isNaN(ver) ? undefined : ver);
          // Show popover with cached content
          const cachedClaimText = target.dataset.claimRewritten ?? target.dataset.claimText ?? "";
          const cachedReasoning = target.dataset.reasoning ?? "";
          const cachedSources: Source[] = (() => {
            try { return JSON.parse(target.dataset.sources ?? "[]"); } catch { return []; }
          })();
          showPopover(target, cachedReasoning, cachedSources, cachedClaimText);
          // Fire background reclassification
          const classificationId = (() => {
            const article = target.closest('article');
            if (!article) return null;
            const link = article.querySelector<HTMLAnchorElement>('a[href*="/status/"]');
            if (!link) return null;
            const match = link.href.match(/\/status\/(\d+)/);
            return match ? match[1] : null;
          })();
          if (classificationId) {
            document.dispatchEvent(new CustomEvent('mf-reclassify-on-hold-click', {
              detail: { classificationId, claimText: target.dataset.claimText }
            }));
          }
          return;
        }

        openPinnedPopover(target);
    }, true); // capture phase
}

/** Find the bottom of the sticky "Post" header bar on X.com so popovers
 *  don't render underneath it. Falls back to searching for any sticky element
 *  in the primary column if the direct-child check fails. Returns 0 if no
 *  header is found. */
function getHeaderBottom(): number {
    const primaryCol = document.querySelector<HTMLElement>('[data-testid="primaryColumn"]');
    if (!primaryCol) return 0;

    // First try direct sticky/fixed children (most common)
    for (const child of primaryCol.children) {
        const childEl = child as HTMLElement;
        const pos = getComputedStyle(childEl).position;
        if (pos === 'sticky' || pos === 'fixed') {
            return childEl.getBoundingClientRect().bottom;
        }
    }

    // Fallback: search deeper for any sticky/fixed element
    const stickyEl = primaryCol.querySelector<HTMLElement>('[style*="sticky"], [style*="fixed"], [style*="top: 0"]');
    if (stickyEl) return stickyEl.getBoundingClientRect().bottom;

    return 53; // fallback: common X.com header height
}

/** Build a popover DOM for a claim. Returns the popover element and a render function
 *  that fills its content. Used by both pinned and preview popovers. */
function buildPopoverShell(trigger: HTMLElement, isPreview: boolean): { popover: HTMLElement; render: (reasoning: string, sources: Source[], claimText?: string) => void } {
    const popover = document.createElement("div");
    popover.className = "mf-popover" + (isPreview ? " mf-popover-preview" : "");
    (popover as any)._mfTrigger = trigger;
    if (isPreview) {
        popover.dataset.preview = "true";
        popover.style.opacity = String(PREVIEW_BASE_OPACITY);
    }

    // RTL: flip popover text direction so buttons and icons lay out correctly.
    const isRTLP = isRTLLocale(getEffectiveUILocale());
    if (isRTLP) popover.dir = "rtl";

    const closeBtn = document.createElement("span");
    closeBtn.className = "mf-popover-close";
    closeBtn.textContent = "×";
    if (isRTLP) {
        closeBtn.style.right = "auto";
        closeBtn.style.left = "10px";
    }
    const onClose = (e?: Event) => {
        if (e) e.stopPropagation();
        const liveTrigger = (popover as any)._mfTrigger as HTMLElement | undefined;
        const targetTrigger = liveTrigger ?? trigger;
        targetTrigger.style.opacity = "";
        delete (targetTrigger as any)._mfPopoverOpen;
        const badge = targetTrigger.querySelector(".mf-inline-badge");
        if (badge) badge.remove();
        const pVal = parseFloat(targetTrigger.dataset.probability ?? "");
        const prob = isNaN(pVal) ? undefined : pVal;
        const vVal = parseFloat(targetTrigger.dataset.veracity ?? "");
        const ver = isNaN(vVal) ? undefined : vVal;
        targetTrigger.style.backgroundColor = confidenceRgba(prob, 0.25, ver);
        popover.remove();
        if (previewPopoverState?.popover === popover) previewPopoverState = null;
    };
    closeBtn.addEventListener("mousedown", onClose);
    // For preview popovers, also close on click anywhere in the popover body
    // so the X button reliably removes the popover rather than toggling opacity.
    if (isPreview) {
        popover.addEventListener("click", (e) => {
            const target = e.target as HTMLElement;
            if (target.closest(".mf-popover-close")) {
                onClose(e);
            }
        });
    }
    popover.appendChild(closeBtn);

    const render = (reasoning: string, sources: Source[], claimText?: string) => {
        // Clear dynamic content but keep close button
        while (popover.childNodes.length > 1) popover.removeChild(popover.lastChild!);
        populatePopoverContent(popover, trigger, reasoning, sources, claimText);
        positionPopover(popover, trigger);
    };

    return { popover, render };
}

function showPopover(
    trigger: HTMLElement,
    reasoning: string,
    sources: Source[],
    claimText?: string,
) {
    // Close only the popover for this trigger (toggle behavior — different claims stay open)
    closePopover(trigger);

    // Clear any lingering selection from the tweet text
    window.getSelection()?.removeAllRanges();

    let popover: HTMLElement | null = null;
    try {
        const shell = buildPopoverShell(trigger, false);
        popover = shell.popover;
        shell.render(reasoning, sources, claimText);

        const timelineContainer = getTimelineContainer(trigger);
        if (getComputedStyle(timelineContainer).position === "static") {
            timelineContainer.style.position = "relative";
        }
        timelineContainer.appendChild(popover);
        bringPopoverToFront(popover);

        popover.addEventListener("mousedown", () => {
            const p = popover;
            if (p && p.parentElement) bringPopoverToFront(p);
        });

        // Mark trigger so the click handler can detect it already has a popover open.
        // Only set this after the popover is successfully in the DOM so a crash
        // doesn't leave the badge permanently visible.
        (trigger as any)._mfPopoverOpen = true;
    } catch (e) {
        console.error("[misinfo] showPopover failed:", e);
        if (popover && popover.parentElement) popover.remove();
        delete (trigger as any)._mfPopoverOpen;
        const badge = trigger.querySelector(".mf-inline-badge");
        if (badge) badge.remove();
        const pVal = parseFloat(trigger.dataset.probability ?? "");
        const prob = isNaN(pVal) ? undefined : pVal;
        const vVal = parseFloat(trigger.dataset.veracity ?? "");
        const ver = isNaN(vVal) ? undefined : vVal;
        trigger.style.backgroundColor = confidenceRgba(prob, 0.25, ver);
    }
}

function populatePopoverContent(
    popover: HTMLElement,
    trigger: HTMLElement,
    reasoning: string,
    sources: Source[],
    claimText?: string,
) {
    // Helper: extract the tweet/classification ID from the trigger span's DOM context
    const getRefreshClassificationId = (): string | null => {
        const article = trigger.closest('article');
        if (!article) return null;
        const link = article.querySelector<HTMLAnchorElement>('a[href*="/status/"]');
        if (!link) return null;
        const match = link.href.match(/\/status\/(\d+)/);
        return match ? match[1] : null;
    };

    // Highlight color for hover effects on copy and close buttons
    const hlProb = parseFloat(trigger.dataset.probability ?? "");
    const hlVer = parseFloat(trigger.dataset.veracity ?? "");
    const highlightHover = (!isNaN(hlProb) && !isNaN(hlVer)) ? confidenceRgba(hlProb, 0.3, hlVer) : undefined;

    const closeBtn = popover.querySelector(".mf-popover-close") as HTMLElement;

    // Same hover effect for the close button as the copy button
    if (closeBtn && highlightHover) {
        closeBtn.addEventListener("mouseenter", () => {
            closeBtn.style.backgroundColor = highlightHover;
            closeBtn.style.color = "rgba(255,255,255,0.9)";
            closeBtn.style.borderRadius = "3px";
        });
        closeBtn.addEventListener("mouseleave", () => {
            closeBtn.style.backgroundColor = "";
            closeBtn.style.color = "";
            closeBtn.style.borderRadius = "";
        });
    }

    // Copy icon SVG (clipboard outline)
    const copyIconSvg = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
    // Checkmark icon (shown briefly after copy)
    const checkIconSvg = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
    // Refresh icon (circling arrow)
    const refreshIconSvg = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>`;
    const batchRefreshIconSvg = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>`;
    // Translate icon (globe/language)
    const translateIconSvg = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>`;

    function appendTextRow(text: string, container: HTMLElement, styleClass: string, extraButtons?: { icon: string, title: string, onClick: () => void }[], preButton?: { icon: string, title: string, label?: string, onClick: () => void }) {
        const row = document.createElement("div");
        row.className = `mf-popover-text-row ${styleClass}`;

        const textSpan = document.createElement("span");
        textSpan.className = "mf-popover-text";
        textSpan.textContent = text;
        row.appendChild(textSpan);

        // Pre-copy button (e.g. Translate) — placed before copy
        if (preButton) {
            const preBtn = document.createElement("button");
            preBtn.className = "mf-translate-btn";
            preBtn.title = preButton.title;
            if (preButton.label) {
                preBtn.style.display = "inline-flex";
                preBtn.style.alignItems = "center";
                preBtn.style.width = "auto";
                preBtn.style.padding = "2px 6px";
                preBtn.style.height = "20px";
                preBtn.style.gap = "3px";
                preBtn.style.marginLeft = "6px";
                preBtn.innerHTML = `${preButton.icon}<span style="font-size:11px;white-space:nowrap;">${preButton.label}</span>`;
            } else {
                preBtn.innerHTML = preButton.icon;
            }
            preBtn.addEventListener("mousedown", (e) => e.stopPropagation());
            preBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                preButton.onClick();
            });
            if (highlightHover) {
                // Solid highlight background at rest so the translate button stands out.
                // Use !important so these beat the generic .mf-popover-copy-icon:hover rule.
                preBtn.style.setProperty("background-color", highlightHover, "important");
                preBtn.style.setProperty("color", "rgba(255,255,255,0.9)", "important");
                preBtn.style.border = "1px solid transparent";
                preBtn.style.borderRadius = "3px";
                preBtn.style.transition = "filter 0.15s ease, color 0.15s ease";
                preBtn.addEventListener("mouseenter", () => {
                    preBtn.style.setProperty("filter", "brightness(1.25)", "important");
                });
                preBtn.addEventListener("mouseleave", () => {
                    preBtn.style.setProperty("filter", "brightness(1)", "important");
                });
            }
            row.appendChild(preBtn);
        }

        const copyBtn = document.createElement("button");
        copyBtn.className = "mf-popover-copy-icon";
        copyBtn.innerHTML = copyIconSvg;
        copyBtn.title = t("copyTooltip");
        copyBtn.addEventListener("mousedown", (e) => e.stopPropagation());
        copyBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            const latest = row.querySelector(".mf-popover-text")?.textContent ?? text;
            try {
                await navigator.clipboard.writeText(latest);
                copyBtn.innerHTML = checkIconSvg;
                setTimeout(() => { copyBtn.innerHTML = copyIconSvg; }, 1500);
            } catch {
                const ta = document.createElement("textarea");
                ta.value = latest;
                ta.style.position = "fixed";
                ta.style.opacity = "0";
                document.body.appendChild(ta);
                ta.select();
                document.execCommand("copy");
                document.body.removeChild(ta);
                copyBtn.innerHTML = checkIconSvg;
                setTimeout(() => { copyBtn.innerHTML = copyIconSvg; }, 1500);
            }
        });

        // Use claim highlight color for hover
        if (highlightHover) {
            copyBtn.addEventListener("mouseenter", () => {
                copyBtn.style.backgroundColor = highlightHover;
                copyBtn.style.color = "rgba(255,255,255,0.9)";
            });
            copyBtn.addEventListener("mouseleave", () => {
                copyBtn.style.backgroundColor = "";
                copyBtn.style.color = "";
            });
        }

        row.appendChild(copyBtn);

        // Add extra buttons (e.g. refresh)
        if (extraButtons) {
            for (const btn of extraButtons) {
                const button = document.createElement("button");
                button.className = "mf-popover-copy-icon";
                button.innerHTML = btn.icon;
                button.title = btn.title;
                button.addEventListener("mousedown", (e) => e.stopPropagation());
                button.addEventListener("click", (e) => {
                    e.stopPropagation();
                    btn.onClick();
                });
                if (highlightHover) {
                    button.addEventListener("mouseenter", () => {
                        button.style.backgroundColor = highlightHover;
                        button.style.color = "rgba(255,255,255,0.9)";
                    });
                    button.addEventListener("mouseleave", () => {
                        button.style.backgroundColor = "";
                        button.style.color = "";
                    });
                }
                row.appendChild(button);
            }
        }

        container.appendChild(row);
    }

    // Rewritten claim text from preclassification — with batch-level refresh button
    if (claimText) {
        const batchId = trigger.dataset.batchId;
        const extraBtns = batchId ? [{
            icon: batchRefreshIconSvg,
            title: t("refreshBatchTooltip"),
            onClick: () => {
                closePopover();
                document.dispatchEvent(new CustomEvent('mf-refresh-batch', {
                    detail: { batchId }
                }));
            }
        }] : undefined;

        // Translate button: shown when claim locale differs from browser locale by primary language
        const claimLocale = trigger.dataset.claimLocale;
        const uiLocale = getEffectiveUILocale();
        let translatePreBtn: { icon: string, title: string, label?: string, onClick: () => void } | undefined;
        if (claimLocale && uiLocale && !sameLanguage(claimLocale, uiLocale)) {
            translatePreBtn = {
                icon: translateIconSvg,
                title: t("translateClaimButton"),
                label: t("translateClaimButton"),
                onClick: () => {
                    // Replace the translate button with a spinner (not inside the button)
                    const row = popover.querySelector('.mf-popover-text-row.mf-popover-claim-text');
                    if (row) {
                        const btn = row.querySelector('.mf-translate-btn');
                        if (btn) {
                            const spinner = document.createElement("span");
                            spinner.className = "mf-spinner";
                            spinner.style.marginRight = "4px";
                            btn.replaceWith(spinner);
                        }
                    }
                    // Get classification ID from the live trigger (popover may have been repointed after a re-render)
                    const liveTrigger = (popover as any)._mfTrigger as HTMLElement | undefined;
                    const article = (liveTrigger ?? trigger).closest('article');
                    let classificationId = '';
                    if (article) {
                        const link = article.querySelector<HTMLAnchorElement>('a[href*="/status/"]');
                        if (link) {
                            const match = link.href.match(/\/status\/(\d+)/);
                            classificationId = match ? match[1] : '';
                        }
                    }
                    const targetTrigger = liveTrigger ?? trigger;
                    document.dispatchEvent(new CustomEvent('mf-translate-claim', {
                        detail: { classificationId, claimText: targetTrigger.dataset.claimText ?? targetTrigger.dataset.dbClaimText, translateWhat: "claim" }
                    }));
                }
            };
        }
        appendTextRow(claimText, popover, "mf-popover-claim-text", extraBtns, translatePreBtn);
    }

    // Reasoning
    const isRefreshing = trigger.dataset.refreshing === "true";
    const hasReasoning = !!reasoning;
    if (hasReasoning || isRefreshing) {
        // Translate button for reasoning row
        const reasoningLocale = trigger.dataset.reasoningLocale;
        const uiLocale2 = getEffectiveUILocale();
        let reasoningTranslateBtn: { icon: string, title: string, label?: string, onClick: () => void } | undefined;
        if (hasReasoning && reasoningLocale && uiLocale2 && !sameLanguage(reasoningLocale, uiLocale2)) {
            reasoningTranslateBtn = {
                icon: translateIconSvg,
                title: t("translateClaimButton"),
                label: t("translateClaimButton"),
                onClick: () => {
                    const rRow = popover.querySelector('.mf-popover-text-row.mf-popover-reasoning-text');
                    if (rRow) {
                        const btn = rRow.querySelector('.mf-translate-btn');
                        if (btn) {
                            const spinner = document.createElement("span");
                            spinner.className = "mf-spinner";
                            spinner.style.marginRight = "4px";
                            btn.replaceWith(spinner);
                        }
                    }
                    const liveTrigger2 = (popover as any)._mfTrigger as HTMLElement | undefined;
                    const article = (liveTrigger2 ?? trigger).closest('article');
                    let cId = '';
                    if (article) {
                        const link = article.querySelector<HTMLAnchorElement>('a[href*="/status/"]');
                        if (link) {
                            const match = link.href.match(/\/status\/(\d+)/);
                            cId = match ? match[1] : '';
                        }
                    }
                    const targetTrigger2 = liveTrigger2 ?? trigger;
                    document.dispatchEvent(new CustomEvent('mf-translate-claim', {
                        detail: { classificationId: cId, claimText: targetTrigger2.dataset.claimText ?? targetTrigger2.dataset.dbClaimText, translateWhat: "reasoning" }
                    }));
                }
            };
        }
        appendTextRow(reasoning || "", popover, "mf-popover-reasoning-text", undefined, reasoningTranslateBtn);
        // If we're refreshing and reasoning hasn't streamed yet, show a spinner in the row.
        if (!hasReasoning && isRefreshing) {
            const reasoningRow = popover.querySelector('.mf-popover-text-row.mf-popover-reasoning-text');
            if (reasoningRow) {
                const spinner = document.createElement("span");
                spinner.className = "mf-spinner";
                spinner.style.marginRight = "4px";
                reasoningRow.insertBefore(spinner, reasoningRow.firstChild);
                const textSpan = reasoningRow.querySelector(".mf-popover-text") as HTMLElement | null;
                if (textSpan) textSpan.style.display = "none";
            }
        }
        // Add refresh button alongside the copy button in the reasoning row
        const reasoningRow = popover.querySelector('.mf-popover-text-row.mf-popover-reasoning-text');
        if (reasoningRow) {
            const refreshContainer = document.createElement("span");
            refreshContainer.className = "mf-refresh-container";
            refreshContainer.style.cssText = "display: inline-flex; align-items: center; margin-left: 2px; vertical-align: middle;";

            const refreshBtn = document.createElement("button");
            refreshBtn.className = "mf-popover-copy-icon";
            refreshBtn.innerHTML = refreshIconSvg;
            refreshBtn.title = t("refreshClaimTooltip");
            refreshBtn.addEventListener("mousedown", (e) => e.stopPropagation());
            refreshBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                const cId = getRefreshClassificationId();
                if (!cId) return;
                const claimText = trigger.dataset.claimText;
                const dbClaimText = trigger.dataset.dbClaimText;
                // Set refreshing state on the trigger; keep the existing badge label
                // so the spinner appears next to it while new values stream in.
                trigger.dataset.refreshing = "true";
                trigger.dataset.reasoning = "";
                document.dispatchEvent(new CustomEvent('mf-refresh-claim', {
                    detail: { classificationId: cId, claimText, dbClaimText }
                }));
                updateOpenPopover();
            });
            if (highlightHover) {
                refreshBtn.addEventListener("mouseenter", () => {
                    refreshBtn.style.backgroundColor = highlightHover;
                    refreshBtn.style.color = "rgba(255,255,255,0.9)";
                });
                refreshBtn.addEventListener("mouseleave", () => {
                    refreshBtn.style.backgroundColor = "";
                    refreshBtn.style.color = "";
                });
            }

            const spinnerEl = document.createElement("span");
            spinnerEl.className = "mf-refresh-spinner";
            spinnerEl.style.display = "none";

            refreshContainer.appendChild(refreshBtn);
            refreshContainer.appendChild(spinnerEl);
            reasoningRow.appendChild(refreshContainer);
        }
    } else {
        const reasoningEl = document.createElement("div");
        reasoningEl.className = "mf-popover-reasoning";
        const spinner = document.createElement("span");
        spinner.className = "mf-spinner";
        reasoningEl.appendChild(spinner);
        reasoningEl.appendChild(document.createTextNode(t("researchingText")));
        popover.appendChild(reasoningEl);
    }

    console.debug(`[misinfo] showPopover: sources.length=${sources.length}`, JSON.stringify(sources));

    // Sources at the bottom — favicon circles that reveal the title on hover
    if (sources.length > 0) {
        const prob = parseFloat(trigger.dataset.probability ?? "");
        const ver = parseFloat(trigger.dataset.veracity ?? "");
        const srcHoverColor = (!isNaN(prob) && !isNaN(ver)) ? confidenceRgba(prob, 0.4, ver) : undefined;

        const sourcesRow = document.createElement("div");
        sourcesRow.className = "mf-popover-sources-row";
        sourcesRow.style.cssText = "display: flex; gap: 6px; margin-top: 6px; align-items: center; flex-wrap: wrap;";

        for (const src of sources) {
            if (!src.url) continue;
            const link = createSourceLink(src, srcHoverColor);
            sourcesRow.appendChild(link);
        }

        if (sourcesRow.children.length > 0) {
            popover.appendChild(sourcesRow);
        }
    }

}

/** Find the scrollable ancestor that serves as the timeline container (shared parent of all tweets). */
/** Get the bounding rectangle of the Fact-Checked floating button if it exists. */
function getFactCheckedButtonRect(): DOMRect | null {
    const btn = document.querySelector<HTMLElement>(".mf-floating-scroll-btn");
    return btn?.getBoundingClientRect() ?? null;
}

/** Keep a small counter to alternate preview popover placement when multiple
 *  positions are valid, giving a different spot each time it appears. */
let previewPlacementCounter = 0;

/** Position a popover relative to the timeline container.
 *
 *  Strategy:
 *   1. Prefer the right side of the trigger when there is enough room between the
 *      trigger and the timeline's right edge (e.g. on desktop where the timeline
 *      is centered). The popover expands to fill that space, with a sane minimum.
 *   2. Otherwise fall back to above/below the trigger, centered horizontally,
 *      while never overlapping the Fact-Checked floating button.
 *   3. Alternate between above/below when both are viable so the position varies.
 *
 *  In tweet detail view we position relative to the viewport instead, because the
 *  timeline container can be much wider and the trigger is typically near the left
 *  edge with plenty of space to the right. */
function positionPopover(popover: HTMLElement, trigger: HTMLElement) {
    const timelineContainer = getTimelineContainer(trigger);
    const containerRect = timelineContainer.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const headerBottom = getHeaderBottom() || 53;
    const trigRect = trigger.getBoundingClientRect();
    const factCheckedRect = getFactCheckedButtonRect();
    const padding = 8;
    const minPopoverWidth = 320;
    const maxPopoverWidth = 520;

    // Candidate positions in preference order.
    type Pos = { left: number; top: number; side: 'right' | 'above' | 'below'; width?: number };
    const candidates: Pos[] = [];

    // 1) Right side of trigger, vertically centered, filling available width.
    const availableRightWidth = Math.min(
        containerRect.right - trigRect.right,
        viewportWidth - trigRect.right
    ) - padding * 2;
    const rightWidth = Math.max(minPopoverWidth, Math.min(maxPopoverWidth, availableRightWidth));
    const rightLeft = trigRect.right - containerRect.left + padding;
    const rightTop = trigRect.top - containerRect.top + trigRect.height / 2 - popoverRect.height / 2;
    const rightFits = availableRightWidth >= minPopoverWidth;
    const rightOverlapsFact = factCheckedRect
        ? rightLeft + containerRect.left < factCheckedRect.right + padding &&
          rightLeft + containerRect.left + rightWidth > factCheckedRect.left - padding &&
          rightTop + containerRect.top < factCheckedRect.bottom + padding &&
          rightTop + containerRect.top + popoverRect.height > factCheckedRect.top - padding
        : false;
    if (rightFits && !rightOverlapsFact) {
        candidates.push({ left: rightLeft, top: rightTop, side: 'right', width: rightWidth });
    }

    // 2) Above the trigger, centered horizontally.
    const aboveTop = trigRect.top - containerRect.top - popoverRect.height - padding;
    const aboveLeft = trigRect.left - containerRect.left + trigRect.width / 2 - popoverRect.width / 2;
    const aboveFits = trigRect.top - popoverRect.height - padding >= headerBottom;
    const aboveOverlapsFact = factCheckedRect
        ? aboveLeft + containerRect.left < factCheckedRect.right + padding &&
          aboveLeft + containerRect.left + popoverRect.width > factCheckedRect.left - padding &&
          aboveTop + containerRect.top < factCheckedRect.bottom + padding &&
          aboveTop + containerRect.top + popoverRect.height > factCheckedRect.top - padding
        : false;
    if (aboveFits && !aboveOverlapsFact) {
        candidates.push({ left: aboveLeft, top: aboveTop, side: 'above' });
    }

    // 3) Below the trigger, centered horizontally.
    const belowTop = trigRect.bottom - containerRect.top + padding;
    const belowLeft = trigRect.left - containerRect.left + trigRect.width / 2 - popoverRect.width / 2;
    const belowFits = trigRect.bottom + padding + popoverRect.height <= viewportHeight;
    const belowOverlapsFact = factCheckedRect
        ? belowLeft + containerRect.left < factCheckedRect.right + padding &&
          belowLeft + containerRect.left + popoverRect.width > factCheckedRect.left - padding &&
          belowTop + containerRect.top < factCheckedRect.bottom + padding &&
          belowTop + containerRect.top + popoverRect.height > factCheckedRect.top - padding
        : false;
    if (belowFits && !belowOverlapsFact) {
        candidates.push({ left: belowLeft, top: belowTop, side: 'below' });
    }

    let chosen: Pos;
    if (candidates.length === 0) {
        // Last resort: place below the trigger and clamp horizontally.
        chosen = { left: belowLeft, top: belowTop, side: 'below' };
    } else {
        // Prefer right side when available, otherwise alternate above/below.
        const rightIndex = candidates.findIndex(c => c.side === 'right');
        if (rightIndex >= 0) {
            chosen = candidates[rightIndex];
        } else {
            const vertical = candidates.filter(c => c.side === 'above' || c.side === 'below');
            chosen = vertical[previewPlacementCounter % vertical.length] ?? candidates[0];
            previewPlacementCounter++;
        }
    }

    // Clamp to viewport and timeline container bounds.
    let left = chosen.left;
    let top = chosen.top;
    const minLeft = padding - containerRect.left;
    const maxLeft = Math.min(
        containerRect.width - (chosen.width ?? popoverRect.width) - padding,
        viewportWidth - containerRect.left - (chosen.width ?? popoverRect.width) - padding
    );
    left = Math.max(minLeft, Math.min(left, maxLeft));
    const minTop = headerBottom - containerRect.top;
    const maxTop = viewportHeight - containerRect.top - popoverRect.height - padding;
    top = Math.max(minTop, Math.min(top, maxTop));

    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
    if (chosen.width) {
        popover.style.width = `${chosen.width}px`;
        popover.style.maxWidth = `${chosen.width}px`;
    } else {
        popover.style.width = '';
        popover.style.maxWidth = '';
    }
}

function getTimelineContainer(el: Element): HTMLElement {
    // Skip quoted tweet containers: they clip with overflow:hidden but are not
    // real scroll containers. Start from the outermost article ancestor instead
    // of the trigger so traversal doesn't stop inside a quoted tweet card.
    let current = el.parentElement;
    while (current && current !== document.body) {
        if (current.scrollHeight > current.clientHeight + 2) {
            const style = getComputedStyle(current);
            if (style.overflowY === "auto" || style.overflowY === "scroll") {
                // On tweet detail view the full-page scroll container is very tall
                // and its bounding rect has a large negative top, which pushes the
                // popover far below the tweet. Prefer the primary column there.
                const rect = current.getBoundingClientRect();
                const isFullPageScroll = rect.height > window.innerHeight * 1.5 && rect.top < -100;
                if (!isFullPageScroll) return current;
            }
        }
        current = current.parentElement;
    }
    // Fallback: the primary column on X.com
    const primaryCol = document.querySelector<HTMLElement>('[data-testid="primaryColumn"]');
    if (primaryCol) return primaryCol;
    return document.body;
}

/** Active preview popover state for hover-to-preview behavior. */
let previewPopoverState: {
    popover: HTMLElement;
    trigger: HTMLElement;
    leaveTimer: ReturnType<typeof setTimeout> | null;
    pinned: boolean;
    semiTransparent: boolean;
} | null = null;

/** Base opacity for preview popovers — visible enough to read but clearly
 *  distinct from pinned popovers. */
const PREVIEW_BASE_OPACITY = 0.75;

function dismissPreviewPopover() {
    if (!previewPopoverState) return;
    const t = previewPopoverState.trigger;
    if (t && !(t as any)._mfPopoverOpen) {
        t.style.opacity = "";
        const badge = t.querySelector(".mf-inline-badge");
        if (badge) badge.remove();
        const pVal = parseFloat(t.dataset.probability ?? "");
        const prob = isNaN(pVal) ? undefined : pVal;
        const vVal = parseFloat(t.dataset.veracity ?? "");
        const ver = isNaN(vVal) ? undefined : vVal;
        t.style.backgroundColor = confidenceRgba(prob, 0.25, ver);
    }
    const popover = previewPopoverState.popover;
    previewPopoverState = null;
    popover.classList.add("mf-popover-fading");
    popover.classList.remove("mf-popover-visible");
    const onTransitionEnd = (e: TransitionEvent) => {
        if (e.propertyName !== "opacity") return;
        popover.removeEventListener("transitionend", onTransitionEnd);
        popover.remove();
    };
    popover.addEventListener("transitionend", onTransitionEnd);
    // Safety net in case transitionend doesn't fire.
    setTimeout(() => {
        popover.removeEventListener("transitionend", onTransitionEnd);
        popover.remove();
    }, 250);
}

function setPreviewPopoverOpacity(opacity: number) {
    if (!previewPopoverState) return;
    previewPopoverState.semiTransparent = opacity < 1;
    const popover = previewPopoverState.popover;
    if (opacity >= 1) {
        popover.classList.remove("mf-popover-fading");
        popover.classList.add("mf-popover-visible");
    } else {
        popover.classList.remove("mf-popover-fading");
        popover.classList.add("mf-popover-visible");
    }
}

function closePopover(trigger?: HTMLElement) {
    // First close any pinned popover, then any preview popover if it matches.
    const pinnedPopovers = document.querySelectorAll(".mf-popover:not([data-preview='true'])");
    for (const p of pinnedPopovers) {
        if (trigger && (p as any)._mfTrigger !== trigger) continue;
        const t = (p as any)._mfTrigger as HTMLElement | undefined;
        if (t) {
            t.style.opacity = "";
            delete (t as any)._mfPopoverOpen;
            const badge = t.querySelector(".mf-inline-badge");
            if (badge) badge.remove();
            const pVal = parseFloat(t.dataset.probability ?? "");
            const prob = isNaN(pVal) ? undefined : pVal;
            const vVal = parseFloat(t.dataset.veracity ?? "");
            const ver = isNaN(vVal) ? undefined : vVal;
            t.style.backgroundColor = confidenceRgba(prob, 0.25, ver);
        }
        p.remove();
    }
    if (previewPopoverState && (!trigger || previewPopoverState.trigger === trigger)) {
        dismissPreviewPopover();
    }
}

function bringPopoverToFront(popover: HTMLElement) {
    // Move to end of its parent (the article) so it stacks on top of sibling elements
    popover.parentElement?.appendChild(popover);
}

/** Show a semitransparent preview popover after hovering a claim highlight
 *  or the Fact-Checked button's claim list for 1 second. */
function showPreviewPopover(trigger: HTMLElement) {
    if ((trigger as any)._mfPopoverOpen) return;
    if (previewPopoverState) {
        if (previewPopoverState.trigger === trigger) return;
        dismissPreviewPopover();
    }

    const claimText = trigger.dataset.claimRewritten ?? trigger.dataset.claimText ?? "";
    const reasoning = trigger.dataset.reasoning ?? "";
    const sources: Source[] = (() => {
        try { return JSON.parse(trigger.dataset.sources ?? "[]"); } catch { return []; }
    })();

    const { popover, render } = buildPopoverShell(trigger, true);
    render(reasoning, sources, claimText);

    const timelineContainer = getTimelineContainer(trigger);
    if (getComputedStyle(timelineContainer).position === "static") {
        timelineContainer.style.position = "relative";
    }
    timelineContainer.appendChild(popover);
    bringPopoverToFront(popover);

    // Force a reflow so the browser registers the initial hidden state before
    // we add the visible class; otherwise the appear transition won't run.
    void popover.offsetHeight;
    popover.classList.add("mf-popover-visible");

    previewPopoverState = {
        popover,
        trigger,
        leaveTimer: null,
        pinned: false,
        semiTransparent: true
    };

    // Hovering the popover itself makes it opaque; leaving makes it semitransparent
    // and starts the 1-second dismissal timer.
    popover.addEventListener("mouseenter", () => {
        setPreviewPopoverOpacity(1);
        if (previewPopoverState?.leaveTimer) {
            clearTimeout(previewPopoverState.leaveTimer);
            previewPopoverState.leaveTimer = null;
        }
    });
    popover.addEventListener("mouseleave", () => {
        setPreviewPopoverOpacity(PREVIEW_BASE_OPACITY);
        schedulePreviewPopoverDismiss(trigger);
    });
}

/** True when the pointer is currently over either the trigger element or the
 *  active preview popover. */
function isHoveringPreviewRelated(trigger: HTMLElement): boolean {
    if (!previewPopoverState) return false;
    if (previewPopoverState.trigger !== trigger) return false;
    const hoveredEl = (document as any).querySelector?.(':hover');
    if (!hoveredEl) return false;
    if (trigger.contains(hoveredEl) || hoveredEl === trigger) return true;
    const popover = previewPopoverState.popover;
    if (popover.contains(hoveredEl) || hoveredEl === popover) return true;
    return false;
}

/** Schedule preview popover dismissal 1 second after pointer leaves both
 *  the trigger and the popover. If the pointer re-enters, the timer is cleared
 *  by the element's own mouseenter handlers. */
function schedulePreviewPopoverDismiss(trigger: HTMLElement) {
    if (!previewPopoverState || previewPopoverState.trigger !== trigger) return;
    if (previewPopoverState.leaveTimer) clearTimeout(previewPopoverState.leaveTimer);
    previewPopoverState.leaveTimer = setTimeout(() => {
        // Final guard: if the user moved the pointer back onto the trigger or
        // popover while the timer was running, don't dismiss.
        if (isHoveringPreviewRelated(trigger)) return;
        dismissPreviewPopover();
    }, 1000);
}

/** Show a preview popover anchored to the Fact-Checked button for a given claim. */
function showPreviewPopoverFromButton(anchorBtn: HTMLElement, claim: Claim, classification: Classification) {
    // Use a transient trigger element positioned near the button.
    const trigger = document.createElement("span");
    trigger.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;";
    trigger.dataset.claimRewritten = (claim.rewritten && claim.rewritten !== claim.text) ? claim.rewritten : claim.text;
    trigger.dataset.claimText = claim.text;
    trigger.dataset.reasoning = claim.note ?? "";
    trigger.dataset.probability = String(claim.confidence ?? "");
    trigger.dataset.veracity = String(claim.veracity ?? "");
    trigger.dataset.sources = JSON.stringify(claim.sources ?? []);
    trigger.dataset.batchId = classification.batchId;
    trigger.dataset.claimLocale = claim.claimLocale ?? '';
    trigger.dataset.reasoningLocale = claim.reasoningLocale ?? '';
    document.body.appendChild(trigger);

    const rect = anchorBtn.getBoundingClientRect();
    // Position the virtual trigger just below the button so the popover appears near it.
    trigger.style.left = `${rect.left + rect.width / 2}px`;
    trigger.style.top = `${rect.bottom + 8}px`;

    showPreviewPopover(trigger);

    // Keep the virtual trigger alive as long as the preview popover exists.
    const cleanup = () => {
        if (!previewPopoverState || previewPopoverState.trigger !== trigger) {
            trigger.remove();
        }
    };
    setTimeout(cleanup, 1500);
}

const reasoningCopyIconSvg = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
const reasoningCheckIconSvg = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
const refreshIconSvg = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>`;

/** Extract the domain from a URL */
function domainFromUrl(url: string): string {
    try { return new URL(url).hostname; } catch { return url; }
}

/** Create a source link — favicon circle that expands to show domain on hover */
function createSourceLink(src: Source, hoverBg?: string): HTMLAnchorElement {
    const url = src.url ?? "#";
    // Favicon domain is always derived from the URL hostname. The new DB format
    // stores {url: title}, so the URL is the only source of truth for the domain.
    const faviconDomain = domainFromUrl(url).replace(/^www\./, '');
    const firstLetter = (faviconDomain.charAt(0) || "?").toUpperCase();
    console.log(`[createSourceLink] url=${url} faviconDomain=${faviconDomain}`);

    const defaultBg = hoverBg
        ? hoverBg.replace(/,\s*[\d.]+\)$/, ', 0.15)')
        : "rgba(255, 255, 255, 0.06)";
    const activeBg = hoverBg ?? "rgba(255, 255, 255, 0.12)";
    const borderColor = hoverBg
        ? hoverBg.replace(/,\s*[\d.]+\)$/, ', 0.3)')
        : "rgba(255, 255, 255, 0.06)";

    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.title = src.title ?? url;
    link.style.cursor = "pointer";

    // Use mousedown (fires before React's click interception) to open the URL
    link.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        window.open(url, '_blank', 'noopener,noreferrer');
    });
    // Click handler as fallback
    link.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.open(url, '_blank', 'noopener,noreferrer');
    });

    // Resting circle state
    link.style.cssText = `
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 2px;
        width: 20px;
        height: 20px;
        border-radius: 50%;
        background: ${defaultBg};
        border: 1px solid ${borderColor};
        cursor: pointer;
        transition: all 0.15s ease;
        flex-shrink: 0;
        text-decoration: none;
        overflow: hidden;
        position: relative;
        font-size: 0;
        color: transparent;
    `;

    // Favicon fallback chain: own favicon -> Google -> DuckDuckGo.
    const faviconSources = [
        `https://${faviconDomain}/favicon.ico`,
        `https://www.google.com/s2/favicons?domain=${encodeURIComponent(faviconDomain)}&sz=32`,
        `https://icons.duckduckgo.com/ip3/${encodeURIComponent(faviconDomain)}.ico`
    ];
    let currentSourceIndex = 0;
    let faviconLoaded = false;

    const img = document.createElement("img");
    img.alt = "";
    img.style.cssText = "width: 16px; height: 16px; display: none; border-radius: 2px;";
    img.referrerPolicy = "no-referrer";
    // No crossOrigin: favicon endpoints usually don't send CORS headers, and we don't
    // need canvas access. Setting anonymous makes the browser reject the image.
    link.appendChild(img);

    // Fallback letter (shown if favicon fails)
    const letter = document.createElement("span");
    letter.textContent = firstLetter;
    letter.style.cssText = "font-size: 11px; font-weight: 600; color: rgba(255,255,255,0.7); line-height: 1;";
    link.appendChild(letter);

    // Hover text (hidden by default, shown on mouseenter)
    const textSpan = document.createElement("span");
    textSpan.textContent = domainFromUrl(url) || src.title || url;
    textSpan.style.cssText = "font-size: 11px; color: rgba(255,255,255,0.9); white-space: nowrap; display: none;";
    link.appendChild(textSpan);

    // Bind handlers BEFORE assigning src so cached images don't fire synchronously
    // before the listeners are registered.
    img.onload = () => {
        // Google sometimes returns a generic 1x1 transparent pixel on failure.
        if (img.naturalWidth > 1) {
            img.style.display = "block";
            letter.style.display = "none";
            faviconLoaded = true;
        } else {
            img.onerror?.(new Event('error'));
        }
    };

    img.onerror = () => {
        currentSourceIndex++;
        if (currentSourceIndex < faviconSources.length) {
            console.log(`[createSourceLink] favicon error, trying fallback ${currentSourceIndex}: ${faviconSources[currentSourceIndex]}`);
            img.src = faviconSources[currentSourceIndex];
        } else {
            console.log(`[createSourceLink] all favicon sources failed for ${faviconDomain}`);
            img.style.display = "none";
            letter.style.display = "inline";
        }
    };

    img.src = faviconSources[currentSourceIndex];

    // Hover: expand to show title, draw above neighbors (toggle visibility, no DOM recreation)
    link.addEventListener("mouseenter", () => {
        link.style.zIndex = "1";
        link.style.background = activeBg;
        link.style.borderRadius = "10px";
        link.style.padding = "2px 6px";
        link.style.width = "auto";
        link.style.height = "20px";
        link.style.border = "1px solid transparent";
        link.style.overflow = "visible";
        link.style.fontSize = "11px";
        link.style.color = "rgba(255, 255, 255, 0.9)";
        img.style.display = "none";
        letter.style.display = "none";
        textSpan.style.display = "inline";
    });

    // Hover leave: reset to circle with favicon or letter (no DOM recreation)
    link.addEventListener("mouseleave", () => {
        link.style.zIndex = "";
        link.style.background = defaultBg;
        link.style.borderRadius = "50%";
        link.style.padding = "";
        link.style.width = "20px";
        link.style.height = "20px";
        link.style.border = `1px solid ${borderColor}`;
        link.style.overflow = "hidden";
        link.style.fontSize = "0";
        link.style.color = "transparent";
        textSpan.style.display = "none";
        if (faviconLoaded) {
            img.style.display = "block";
            letter.style.display = "none";
        } else {
            img.style.display = "none";
            letter.style.display = "inline";
        }
    });

    return link;
}

function addSourcesToPopover(popover: HTMLElement, trigger: HTMLElement) {
    const rawSources = trigger.dataset.sources;
    // Skip if sources haven't changed (compare serialized JSON on the popover)
    const previousRaw = (popover as any)._mfSourcesRaw;
    if (previousRaw === rawSources) return;
    (popover as any)._mfSourcesRaw = rawSources;

    // Remove existing sources row before re-adding
    const existing = popover.querySelector(".mf-popover-sources-row");
    if (existing) existing.remove();

    let srcList: Source[] = [];
    try {
        const parsed = JSON.parse(rawSources ?? "[]");
        srcList = normalizeSources(parsed);
    } catch {}
    if (srcList.length === 0) return;

    // Compute highlight color from the trigger claim's verdict for hover effects
    const p = parseFloat(trigger.dataset.probability ?? "");
    const v = parseFloat(trigger.dataset.veracity ?? "");
    const hoverColor = (!isNaN(p) && !isNaN(v)) ? confidenceRgba(p, 0.4, v) : undefined;

    const sourcesRow = document.createElement("div");
    sourcesRow.className = "mf-popover-sources-row";
    sourcesRow.style.cssText = "display: flex; gap: 6px; margin-top: 6px; align-items: center; flex-wrap: wrap;";
    for (const src of srcList) {
        if (!src.url) continue;
        sourcesRow.appendChild(createSourceLink(src, hoverColor));
    }
    if (sourcesRow.children.length > 0) {
        popover.appendChild(sourcesRow);
    }
}

function updateOpenPopover() {
    console.log(`[updateOpenPopover] running`);
    document.querySelectorAll(".mf-popover").forEach(p => {
        const popover = p as HTMLElement;
        let trigger = (popover as any)._mfTrigger as HTMLElement | undefined;
        if (!trigger) return;

        // If the stored trigger was removed during a segment re-render (e.g. after
        // a per-claim translation changed claimLocale/reasoningLocale), find the
        // current live span for the same claim and repoint the popover at it.
        if (!trigger.isConnected) {
            const dbClaimText = trigger.dataset.dbClaimText;
            const claimText = trigger.dataset.claimText;
            const currentTrigger = Array.from(document.querySelectorAll<HTMLElement>(".mf-segment-claim")).find(el => {
                if (dbClaimText && el.dataset.dbClaimText === dbClaimText) return true;
                if (claimText && el.dataset.claimText === claimText) return true;
                return false;
            });
            if (currentTrigger) {
                console.log(`[updateOpenPopover] trigger was detached, re-attached to live span dbClaimText=${dbClaimText?.slice(0, 30)}`);
                (popover as any)._mfTrigger = currentTrigger;
                currentTrigger.style.opacity = "1";
                (currentTrigger as any)._mfPopoverOpen = true;
                trigger = currentTrigger;
            }
        }

        const uiLocale = getEffectiveUILocale();

        // Update claim text if it changed (e.g. after per-claim translation)
        const claimTextSpan = popover.querySelector<HTMLElement>(".mf-popover-text-row.mf-popover-claim-text .mf-popover-text");
        if (claimTextSpan) {
            const newClaimText = trigger.dataset.claimRewritten ?? trigger.dataset.claimText ?? "";
            console.log(`[updateOpenPopover] claim text stream oldLen=${claimTextSpan.textContent?.length ?? 0} newLen=${newClaimText.length} old="${claimTextSpan.textContent?.slice(0, 30)}" new="${newClaimText.slice(0, 30)}" claimLocale=${trigger.dataset.claimLocale} uiLocale=${uiLocale}`);
            // Always remove spinner if present — translation arrived
            const claimRow = popover.querySelector(".mf-popover-text-row.mf-popover-claim-text");
            const spinner = claimRow?.querySelector(".mf-spinner");
            if (spinner) spinner.remove();
            if (newClaimText && newClaimText !== claimTextSpan.textContent) {
                claimTextSpan.textContent = newClaimText;
            }
            // Remove claim translate button if locale now matches UI
            if (trigger.dataset.claimLocale && sameLanguage(trigger.dataset.claimLocale, uiLocale)) {
                const btn = popover.querySelector(".mf-popover-claim-text .mf-translate-btn");
                if (btn) btn.remove();
            }
        }

        const reasoning = trigger.dataset.reasoning ?? "";

        // Case 1: reasoning already upgraded to a text row — just update the text
        const existingTextSpan = popover.querySelector<HTMLElement>(".mf-popover-text-row.mf-popover-reasoning-text .mf-popover-text");
        if (existingTextSpan) {
            console.log(`[updateOpenPopover] reasoning text stream oldLen=${existingTextSpan.textContent?.length ?? 0} newLen=${reasoning.length} old="${existingTextSpan.textContent?.slice(0, 30)}" new="${reasoning.slice(0, 30)}" reasoningLocale=${trigger.dataset.reasoningLocale} uiLocale=${uiLocale} refreshing=${trigger.dataset.refreshing}`);
            const reasoningRow = popover.querySelector(".mf-popover-text-row.mf-popover-reasoning-text");
            const isRefreshingNow = trigger.dataset.refreshing === "true";
            if (reasoning) {
                // Reasoning arrived: remove spinner and show text
                const rSpinner = reasoningRow?.querySelector(".mf-spinner");
                if (rSpinner) rSpinner.remove();
                existingTextSpan.style.display = "";
                if (reasoning !== existingTextSpan.textContent) {
                    existingTextSpan.textContent = reasoning;
                    // Reset refresh button if it was in spinning state
                    const refreshContainer = existingTextSpan.closest('.mf-popover-text-row')?.querySelector('.mf-refresh-container');
                    if (refreshContainer) {
                        const btn = refreshContainer.querySelector('button');
                        const spinner = refreshContainer.querySelector('.mf-refresh-spinner') as HTMLElement;
                        if (btn && spinner) {
                            btn.style.display = "";
                            spinner.style.display = "none";
                        }
                    }
                }
            } else if (isRefreshingNow) {
                // Refreshing but no reasoning yet: show spinner, hide text
                existingTextSpan.style.display = "none";
                if (!reasoningRow?.querySelector(".mf-spinner")) {
                    const spinner = document.createElement("span");
                    spinner.className = "mf-spinner";
                    spinner.style.marginRight = "4px";
                    reasoningRow?.insertBefore(spinner, reasoningRow.firstChild);
                }
            }
            // Remove reasoning translate button if locale now matches UI
            if (trigger.dataset.reasoningLocale && sameLanguage(trigger.dataset.reasoningLocale, uiLocale)) {
                const btn = popover.querySelector(".mf-popover-reasoning-text .mf-translate-btn");
                if (btn) btn.remove();
            }
            // Update button hover colors from the refreshed claim's probability/veracity
            const prob = parseFloat(trigger.dataset.probability ?? "");
            const ver = parseFloat(trigger.dataset.veracity ?? "");
            const hoverBg = (!isNaN(prob) && !isNaN(ver)) ? confidenceRgba(prob, 0.3, ver) : undefined;
            if (hoverBg) {
                popover.style.setProperty('--mf-popover-hover', hoverBg);
            }
            addSourcesToPopover(popover, trigger);
            return;
        }

        // Case 2: still showing spinner/researching — first upgrade to text row
        const reasoningEl = popover.querySelector(".mf-popover-reasoning");
        if (!reasoningEl) return;

        const currentText = reasoningEl.textContent ?? "";
        if (reasoning === currentText) return;
        if (!reasoning && (currentText === t("researchingText") || currentText === "")) return;

        reasoningEl.innerHTML = "";
        if (reasoning) {
            const row = document.createElement("div");
            row.className = "mf-popover-text-row mf-popover-reasoning-text";

            const textSpan = document.createElement("span");
            textSpan.className = "mf-popover-text";
            textSpan.textContent = reasoning;
            row.appendChild(textSpan);

            const copyBtn = document.createElement("button");
            copyBtn.className = "mf-popover-copy-icon";
            copyBtn.innerHTML = reasoningCopyIconSvg;
            copyBtn.title = t("copyTooltip");
            copyBtn.addEventListener("mousedown", (e) => e.stopPropagation());
            copyBtn.addEventListener("click", async (e) => {
                e.stopPropagation();
                // Read text from DOM at click time so progressive updates are included
                const latest = copyBtn.parentElement?.querySelector(".mf-popover-text")?.textContent ?? "";
                try {
                    await navigator.clipboard.writeText(latest);
                    copyBtn.innerHTML = reasoningCheckIconSvg;
                    setTimeout(() => { copyBtn.innerHTML = reasoningCopyIconSvg; }, 1500);
                } catch {
                    const ta = document.createElement("textarea");
                    ta.value = latest;
                    ta.style.position = "fixed";
                    ta.style.opacity = "0";
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand("copy");
                    document.body.removeChild(ta);
                    copyBtn.innerHTML = reasoningCheckIconSvg;
                    setTimeout(() => { copyBtn.innerHTML = reasoningCopyIconSvg; }, 1500);
                }
            });

            // Use claim highlight color for hover
            const hlProb = parseFloat(trigger.dataset.probability ?? "");
            const hlVer = parseFloat(trigger.dataset.veracity ?? "");
            const hlHover = (!isNaN(hlProb) && !isNaN(hlVer)) ? confidenceRgba(hlProb, 0.3, hlVer) : undefined;
            if (hlHover) {
                copyBtn.addEventListener("mouseenter", () => {
                    copyBtn.style.backgroundColor = hlHover;
                    copyBtn.style.color = "rgba(255,255,255,0.9)";
                });
                copyBtn.addEventListener("mouseleave", () => {
                    copyBtn.style.backgroundColor = "";
                    copyBtn.style.color = "";
                });
            }

            row.appendChild(copyBtn);

            // Add refresh button (same as in showPopover)
            const refreshContainer = document.createElement("span");
            refreshContainer.className = "mf-refresh-container";
            refreshContainer.style.cssText = "display: inline-flex; align-items: center; margin-left: 2px; vertical-align: middle;";

            const refreshBtn = document.createElement("button");
            refreshBtn.className = "mf-popover-copy-icon";
            refreshBtn.innerHTML = refreshIconSvg;
            refreshBtn.title = t("refreshClaimTooltip");
            refreshBtn.addEventListener("mousedown", (e) => e.stopPropagation());
            refreshBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                const article = trigger.closest('article');
                if (!article) return;
                const link = article.querySelector<HTMLAnchorElement>('a[href*="/status/"]');
                if (!link) return;
                const match = link.href.match(/\/status\/(\d+)/);
                const cId = match ? match[1] : null;
                if (!cId) return;
                const ct = trigger.dataset.claimText;
                const dbCt = trigger.dataset.dbClaimText;
                // Set refreshing state on the trigger; keep the existing badge label
                // so the spinner appears next to it while new values stream in.
                trigger.dataset.refreshing = "true";
                trigger.dataset.reasoning = "";
                document.dispatchEvent(new CustomEvent('mf-refresh-claim', {
                    detail: { classificationId: cId, claimText: ct, dbClaimText: dbCt }
                }));
                updateOpenPopover();
            });
            if (hlHover) {
                refreshBtn.addEventListener("mouseenter", () => {
                    refreshBtn.style.backgroundColor = hlHover;
                    refreshBtn.style.color = "rgba(255,255,255,0.9)";
                });
                refreshBtn.addEventListener("mouseleave", () => {
                    refreshBtn.style.backgroundColor = "";
                    refreshBtn.style.color = "";
                });
            }

            const rSpinnerEl = document.createElement("span");
            rSpinnerEl.className = "mf-refresh-spinner";
            rSpinnerEl.style.display = "none";

            refreshContainer.appendChild(refreshBtn);
            refreshContainer.appendChild(rSpinnerEl);
            row.appendChild(refreshContainer);

            reasoningEl.parentElement?.replaceChild(row, reasoningEl);
            addSourcesToPopover(popover, trigger);
        } else {
            const spinner = document.createElement("span");
            spinner.className = "mf-spinner";
            reasoningEl.appendChild(spinner);
            reasoningEl.appendChild(document.createTextNode(t("researchingText")));
        }
    });
}

/** Find the Grok button's parent div for inserting custom buttons.
 *  Uses `aria-label*="Grok"` — "Grok" is a brand name, never translated. */
function findGrokRow(article: Element): { row: HTMLElement; btn: HTMLElement } | null {
    const grokBtn = article.querySelector<HTMLElement>('button[aria-label*="Grok"]');
    if (!grokBtn?.parentElement) return null;
    return { row: grokBtn.parentElement as HTMLElement, btn: grokBtn };
}

/** Find the action row that contains Subscribe/Grok/More buttons.
 *  Returns the shared flex parent so we can insert our button as the
 *  leftmost sibling at the same level. */
function findActionRow(article: Element): HTMLElement | null {
    const grokBtn = article.querySelector<HTMLElement>('button[aria-label*="Grok"]');
    const grokWrapper = grokBtn?.parentElement;
    const row = grokWrapper?.parentElement;
    return row as HTMLElement | null;
}

/** Find the Subscribe button if present. The data-testid is dynamic and follows
 *  the pattern `<userId>-subscribe`, so we match any button whose data-testid
 *  ends with `-subscribe`. Returns the outer wrapper div (sibling of Grok/More)
 *  so we can insert our button at the same flex level. */
function findSubscribeWrapper(article: Element): HTMLElement | null {
    const subscribeBtn = article.querySelector<HTMLElement>('button[data-testid$="-subscribe"]');
    // The wrapper is the div that is a direct sibling of the Grok/More wrappers.
    return subscribeBtn?.parentElement?.parentElement as HTMLElement | null;
}

// ---- On-hold button injection (paused pipeline) ----

/** Render a "Disinfact" button for tweets awaiting user action.
 *  Track processing state so the spinner survives X.com's React re-renders:
 *  the MutationObserver re-injects from allClassifications, and we check
 *  processingOnHoldIds to show the spinner instead of a fresh button. */
function injectOnHoldButton(
    time: Element,
    classification: Classification,
    article: Element
) {
    // Only main tweets get the Disinfact button
    const grokData = findGrokRow(article);
    if (!grokData) return;
    const grokRow = grokData.row;
    const grokBtn = grokData.btn;
    // Guard: already injected for this tweet
    if (article.querySelector(`[classification-id="${classification.id}"]`)) return;

    const container = document.createElement("div");
    container.setAttribute("classification-id", classification.id);
    container.style.cssText = `
        display: inline-flex;
        align-items: center;
        margin-right: 12px;
        min-width: 0;
        flex-shrink: 0;
    `;

    // Clone the Grok button's CSS for pixel-perfect X.com match. We read the
    // actual runtime class names instead of hard-coding X's generated CSS
    // classes, which can change at any time. If the reference button has no
    // classes, skip injection rather than rely on stale fallback classes.
    const refClass = grokBtn.className;
    const innerDiv = grokBtn.querySelector<HTMLElement>('div[dir="ltr"]');
    const innerClass = innerDiv?.className;
    if (!refClass || !innerClass) return;

    // If this tweet is already being processed, show spinner immediately
    // (survives X.com's React re-renders because the MutationObserver
    //  re-injects from allClassifications and hits this path).
    if (processingOnHoldIds.has(classification.id)) {
        const spinnerWrap = document.createElement("div");
        spinnerWrap.setAttribute("dir", "ltr");
        spinnerWrap.className = innerClass;
        spinnerWrap.style.color = "rgb(83, 100, 113)";

        const spinner = document.createElement("span");
        spinner.className = "mf-spinner";
        spinner.style.marginRight = "0";
        spinner.style.borderColor = "rgba(83, 100, 113, 0.2)";
        spinner.style.borderTopColor = "rgba(83, 100, 113, 0.8)";
        spinnerWrap.appendChild(spinner);

        const placeholder = document.createElement("button");
        placeholder.setAttribute("role", "button");
        placeholder.setAttribute("type", "button");
        placeholder.className = refClass;
        placeholder.style.cursor = "default";
        placeholder.style.pointerEvents = "none";
        placeholder.appendChild(spinnerWrap);

        container.appendChild(placeholder);
        const actionRow = findActionRow(article);
        if (actionRow) actionRow.insertBefore(container, actionRow.firstChild);
        else grokRow.insertBefore(container, grokRow.firstChild);
        return;
    }

    const button = document.createElement("button");
    button.textContent = "Disinfact";
    button.setAttribute("role", "button");
    button.setAttribute("type", "button");
    button.className = refClass;

    const textWrap = document.createElement("div");
    textWrap.setAttribute("dir", "ltr");
    textWrap.className = innerClass;
    textWrap.style.color = "rgb(83, 100, 113)";
    textWrap.style.fontSize = "13px";
    textWrap.style.fontWeight = "700";
    textWrap.style.minWidth = "0";
    textWrap.textContent = "Disinfact";

    button.innerHTML = "";
    button.style.cursor = "pointer";
    button.appendChild(textWrap);

    button.addEventListener("click", () => {
        processingOnHoldIds.add(classification.id);

        // Remember scroll position so we can offer a "Go Back" button later.
        onHoldScrollStates.set(classification.id, {
            originalScrollY: window.scrollY,
            pendingClaimTexts: new Set()
        });

        // Replace text with spinner inside the same styled frame
        const loadingWrap = document.createElement("div");
        loadingWrap.setAttribute("dir", "ltr");
        loadingWrap.className = innerClass;
        loadingWrap.style.color = "rgb(83, 100, 113)";

        const spinner = document.createElement("span");
        spinner.className = "mf-spinner";
        spinner.style.marginRight = "0";
        spinner.style.borderColor = "rgba(83, 100, 113, 0.2)";
        spinner.style.borderTopColor = "rgba(83, 100, 113, 0.8)";
        loadingWrap.appendChild(spinner);

        button.innerHTML = "";
        button.style.cursor = "default";
        button.appendChild(loadingWrap);

        document.dispatchEvent(new CustomEvent('mf-process-on-hold', {
            detail: { tweetId: classification.id }
        }));
    });

    container.appendChild(button);
    const actionRow = findActionRow(article);
    if (actionRow) actionRow.insertBefore(container, actionRow.firstChild);
    else grokRow.insertBefore(container, grokRow.firstChild);
}

const processingTranslateFactChecksIds = new Set<string>();

/** Render a "Translate Fact-Checks" button for tweets whose highlights need
 *  localization but are paused behind user consent. Same style as injectOnHoldButton. */
function injectTranslateFactChecksButton(
    time: Element,
    classification: Classification,
    article: Element
) {
    const grokData = findGrokRow(article);
    if (!grokData) return;
    const grokRow = grokData.row;
    const grokBtn = grokData.btn;
    if (article.querySelector(`[translate-fc-id="${classification.id}"]`)) return;

    const container = document.createElement("div");
    container.setAttribute("translate-fc-id", classification.id);
    container.style.cssText = `
        display: inline-flex;
        align-items: center;
        margin-right: 12px;
        min-width: 0;
        flex-shrink: 0;
    `;

    const subscribeWrapper = findSubscribeWrapper(article);
    // Clone the actual runtime classes of a reference button (Subscribe if
    // available, otherwise Grok). No hard-coded X CSS fallbacks.
    const refBtn = (subscribeWrapper?.querySelector('button') as HTMLElement | null) ?? grokBtn;
    const refClass = refBtn.className;
    const innerDiv2 = grokBtn.querySelector<HTMLElement>('div[dir="ltr"]');
    const innerClass = innerDiv2?.className;
    if (!refClass || !innerClass) return;

    if (processingTranslateFactChecksIds.has(classification.id)) {
        const spinnerWrap = document.createElement("div");
        spinnerWrap.setAttribute("dir", "ltr");
        spinnerWrap.className = innerClass;
        spinnerWrap.style.color = "rgb(83, 100, 113)";
        const spinner = document.createElement("span");
        spinner.className = "mf-spinner";
        spinner.style.marginRight = "0";
        spinner.style.borderColor = "rgba(83, 100, 113, 0.2)";
        spinner.style.borderTopColor = "rgba(83, 100, 113, 0.8)";
        spinnerWrap.appendChild(spinner);
        const placeholder = document.createElement("button");
        placeholder.setAttribute("role", "button");
        placeholder.setAttribute("type", "button");
        placeholder.className = refClass;
        placeholder.style.cursor = "default";
        placeholder.style.pointerEvents = "none";
        placeholder.appendChild(spinnerWrap);
        container.appendChild(placeholder);
        const actionRow2 = findActionRow(article);
        if (actionRow2) actionRow2.insertBefore(container, actionRow2.firstChild);
        else grokRow.insertBefore(container, grokRow.firstChild);
        return;
    }

    const button = document.createElement("button");
    button.setAttribute("role", "button");
    button.setAttribute("type", "button");
    button.className = refClass;

    const textWrap = document.createElement("div");
    textWrap.setAttribute("dir", "ltr");
    textWrap.className = innerClass;
    textWrap.style.color = "rgb(83, 100, 113)";
    textWrap.style.fontSize = "13px";
    textWrap.style.fontWeight = "700";
    textWrap.style.minWidth = "0";
    textWrap.textContent = t("translateFactChecks");

    button.innerHTML = "";
    button.style.cursor = "pointer";
    button.appendChild(textWrap);

    button.addEventListener("click", () => {
        processingTranslateFactChecksIds.add(classification.id);
        const loadingWrap = document.createElement("div");
        loadingWrap.setAttribute("dir", "ltr");
        loadingWrap.className = innerClass;
        loadingWrap.style.color = "rgb(83, 100, 113)";
        const spinner = document.createElement("span");
        spinner.className = "mf-spinner";
        spinner.style.marginRight = "0";
        spinner.style.borderColor = "rgba(83, 100, 113, 0.2)";
        spinner.style.borderTopColor = "rgba(83, 100, 113, 0.8)";
        loadingWrap.appendChild(spinner);
        button.innerHTML = "";
        button.style.cursor = "default";
        button.appendChild(loadingWrap);
        document.dispatchEvent(new CustomEvent('mf-translate-fact-checks', {
            detail: { tweetId: classification.id }
        }));
    });

    container.appendChild(button);
    const actionRow2 = findActionRow(article);
    if (actionRow2) actionRow2.insertBefore(container, actionRow2.firstChild);
    else grokRow.insertBefore(container, grokRow.firstChild);
}

// ---- Main injection (two-phase) ----

function injectClassification(
    time: Element,
    classification: Classification | QuotedClassification,
    article: Element,
    isQuoted: boolean = !!(classification as Classification).quoting
) {
    const segments = classification.segments;
    const claims = classification.claims;

    // Remove any stale on-hold injection button when the real classification arrives.
    // Use document-wide query: after X.com recycles articles, the container may be
    // in a different DOM location than what article.querySelector would find.
    const staleOnHold = document.querySelector(`[classification-id="${classification.id}"]`);
    if (staleOnHold && !(classification as Classification).onHold) {
        staleOnHold.remove();
        processingOnHoldIds.delete(classification.id);
    }
    // Also clean up stale translate-fact-checks button
    const staleTFC = document.querySelector(`[translate-fc-id="${classification.id}"]`);
    if (staleTFC && !(classification as Classification).translateFactChecksOnHold) {
        staleTFC.remove();
        processingTranslateFactChecksIds.delete(classification.id);
    }

    // Translate-fact-checks on hold: show "Translate Fact-Checks" button
    if ((classification as Classification).translateFactChecksOnHold) {
        // Hide any Phase 1 fallback while the Translate Fact-Checks button is shown.
        article.querySelector(`[classification-id="${classification.id}"]`)?.remove();
        article.querySelector(`[mf-unmatched="${classification.id}"]`)?.remove();
        injectTranslateFactChecksButton(time, classification as Classification, article);
        return;
    }

    // On-hold tweet: show "Disinfact" button instead of classification
    if ((classification as Classification).onHold) {
        injectOnHoldButton(time, classification as Classification, article);
        return;
    }

    // No claims → leave tweet untouched
    if (!claims || claims.length === 0) return;

    // Phase 2: Upgrade to inline segments if segments are ready
    if (segments && segments.length > 0) {
        console.log(`[misinfo] injectClassification: Phase 2 for ${classification.id}`);
        const mainCls = classification as Classification;
        const clBatchId = mainCls.batchId ?? '';
        // Always upgrade main tweet text (isQuoted=false — targets [data-testid="tweetText"])
        upgradeToSegments(article, classification, clBatchId, false);
        // Also upgrade quoted tweet if it has its own segments
        if (mainCls.quoting && mainCls.quoting.segments && mainCls.quoting.segments.length > 0) {
            // Pass isQuoted=true so findTweetTextElement searches within the outer
            // article for the quoted tweet's text element (nested <article> or
            // last [data-testid="tweetText"] fallback).
            upgradeToSegments(article, mainCls.quoting, clBatchId, true);
        }

        // While highlight localization is running after "Translate Fact-Checks",
        // suppress the fallback box so it doesn't flash before new highlights arrive.
        if (!mainCls.localizingHighlights) {
            // Render Phase 1-style fallback at the top for claims NOT already highlighted inline.
            // Use claim TEXT comparison instead of index — research updates can rearrange the
            // claims array, making index-based matching unreliable.
            const segmentClaimTexts = new Set<string>();
            for (const seg of segments) {
                if (seg.claimIndex !== null && claims[seg.claimIndex]) {
                    segmentClaimTexts.add(claims[seg.claimIndex].text);
                }
            }
            // Also include rewritten text for claims that matched via different text
            for (const seg of segments) {
                if (seg.claimIndex !== null && claims[seg.claimIndex]?.rewritten) {
                    segmentClaimTexts.add(claims[seg.claimIndex].rewritten!);
                }
            }
            const unmatched = claims.filter(c => !segmentClaimTexts.has(c.text) && !segmentClaimTexts.has(c.rewritten ?? ''));
            // Remove any old Phase 1 fallback div so it doesn't linger alongside inline highlighting
            const oldFallback = article.querySelector(`[classification-id="${classification.id}"]`);
            if (oldFallback) oldFallback.remove();
            if (unmatched.length > 0) {
                console.log(`[misinfo] injectClassification: ${unmatched.length} unmatched claims for ${classification.id}, rendering Phase 1 fallback`);
                const existing = article.querySelector(`[mf-unmatched="${classification.id}"]`);
                if (existing) {
                    existing.innerHTML = renderClaims(classification, unmatched);
                } else {
                    const div = document.createElement("div");
                    div.setAttribute("mf-unmatched", classification.id);
                    div.innerHTML = renderClaims(classification, unmatched);
                    div.style.cssText = `
                        display: block;
                        width: 100%;
                        margin-top: 8px;
                        padding: 12px;
                        background: rgba(128, 128, 128, 0.08);
                        border: 1px solid rgba(128, 128, 128, 0.2);
                        border-radius: 12px;
                        font-size: 14px;
                        box-sizing: border-box;
                    `;
                    const mainTweet = parseInt(article.getAttribute("tabindex") ?? "0") < 0;
                    if (mainTweet) article.querySelector(`[data-testid="User-Name"]`)?.appendChild(div);
                    else time.insertAdjacentElement("afterend", div);
                }
            } else {
                // No unmatched claims — remove any leftover unmatched fallback
                const unmatchedDiv = article.querySelector(`[mf-unmatched="${classification.id}"]`);
                if (unmatchedDiv) unmatchedDiv.remove();
            }
        }

        return;
    }

    // Phase 1: Fallback — render at top (existing behavior)
    if ((classification as Classification).localizingHighlights) {
        console.log(`[misinfo] injectClassification: suppressing Phase 1 fallback for ${classification.id} while localizing highlights`);
        return;
    }
    console.log(`[misinfo] injectClassification: Phase 1 (fallback) for ${classification.id}`);
    const mainTweet = parseInt(article.getAttribute("tabindex") ?? "0") < 0;
    const existing = article.querySelector(`[classification-id="${classification.id}"]`);
    if (existing) {
        existing.innerHTML = renderClaims(classification);
    } else {
        const div = document.createElement("div");
        div.setAttribute("classification-id", classification.id);
        div.innerHTML = renderClaims(classification);
        div.style.cssText = `
            display: block;
            width: 100%;
            margin-top: 8px;
            padding: 12px;
            background: rgba(128, 128, 128, 0.08);
            border: 1px solid rgba(128, 128, 128, 0.2);
            border-radius: 12px;
            font-size: 14px;
            box-sizing: border-box;
        `;
        if (mainTweet) article.querySelector(`[data-testid="User-Name"]`)?.appendChild(div);
        else time.insertAdjacentElement("afterend", div);
    }

    const quotedTimes = article.querySelectorAll("time");

    if (isQuoted && quotedTimes.length > 1) {
        const quoting = (classification as Classification).quoting!;
        if (mainTweet)
            injectClassification(
                quotedTimes[0],
                quoting,
                article.querySelector(`[tabindex="0"]`) ?? article,
                false
            );
        else injectClassification(quotedTimes[1], quoting, article, false);
    }
}

document.addEventListener('mf-prepare-locale-switch', ((e: CustomEvent) => {
    const { tweetId } = e.detail;
    console.log(`[misinfo] preparing locale switch for ${tweetId}: removing injected elements`);
    removeInjectedElements(tweetId);
    const c = allClassifications.find(x => x.id === tweetId);
    if (c) {
        c.segments = undefined;
        c.translatedText = undefined;
        textBreakupInProgress.delete(tweetId);
    }
}) as EventListener);
