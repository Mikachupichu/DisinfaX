import { Classification, QuotedClassification, Claim, TextSegment, Source, sameLanguage } from "../data/Classification";
import { normalizeSources } from "./intelligence";
import { breakupTweetText, breakupWithHighlights, resolveHighlightRange } from "./textBreakup";
import { mfBus } from "./mfBus";

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
// Safety net for the (rare) case where a Disinfact/Translate-Fact-Checks backend call fails:
// its button becomes a spinner and, with no result to re-render it away, would stay stuck. If
// after this long the button is STILL connected AND still marked processing (i.e. no success
// re-render removed it), revert it to its clickable state so the user can retry. Generous so a
// slow-but-successful call never trips it; a success detaches the node first, making it a no-op.
const CHARGE_REVERT_TIMEOUT_MS = 30000;
const requestedQuotedDbFetchIds = new Set<string>();
let observerSetup = false;
/** When true (user logged out), the extension is frozen: no injection, no
 *  notifications, no onboarding. Existing injections are torn down on freeze. */
let extensionFrozen = false;

// Tracks tweet IDs for which the user clicked "Fact-Check All".
// These approvals persist for the session so late-arriving no-DB-match claims
// bypass the per-claim Disinfact badge pause.
const factCheckAllClickedIds = new Set<string>();

// Tracks individual Disinfact badge clicks for no-DB-match claims.
// Keyed by `${tweetId}:${claimText}`.
const individuallyClickedOnHoldClaims = new Set<string>();

// Tracks on-hold Disinfact clicks for the floating scroll navigation buttons:
// tweetId -> { originalScrollY, pendingClaimTexts }.
const onHoldScrollStates = new Map<string, { originalScrollY: number; pendingClaimTexts: Set<string> }>();

interface FloatingButtonState {
    path: string;
    btn: HTMLElement;
    createdAt: number;
    timerStartedAt: number;
    remainingTimeMs: number;
    lastHoverLeaveAt: number;
    hovered: boolean;
    dismissTimer: ReturnType<typeof setTimeout> | null;
    hoverLeaveTimer: ReturnType<typeof setTimeout> | null;
    visibilityCheck: ReturnType<typeof setInterval> | null;
    tweetId: string;
}

const floatingButtonRegistry = new Map<string, FloatingButtonState>();
let currentPathname = (typeof window !== 'undefined' && window.location) ? window.location.
pathname : '';
let navigationListenerSetup = false;

/**
 * Testing: from the background service worker console (chrome://extensions →
 * click "service worker" under DisinfaX), run:
 *   browser.storage.local.set({ mfLocale: 'fr' })
 *   browser.storage.local.remove('mfLocale')
 *
 * Read from EXTENSION storage (chrome.storage.local), NOT page localStorage — the
 * host page (X) can write page localStorage and could otherwise spoof the
 * extension's displayed locale (or RTL layout / number formatting) into a bogus
 * value. Extension storage is unreachable from the page. This mirrors the same
 * `mfLocale` key relay.content.ts already reads for the translate/reclassify
 * locale, so one setting controls both.
 *   any locale code present under `public/_locales/`  →  fetch that locale's messages.json
 *   'auto'                                            →  detect from navigator.language
 *   undefined / 'en'                                  →  use chrome.i18n (browser's built-in locale)
 *
 * Accepts either separator ('zh_TW' or 'zh-TW') — normalized to a hyphen so it's
 * also valid to hand straight to Intl.NumberFormat/Intl RTL checks, which reject
 * underscores.
 */
let localeOverride: string | null = null;

function normalizeLocaleOverride(raw: string | null | undefined): string | null {
    if (!raw) return null;
    if (raw === 'auto') return (navigator.language || 'en').split('-')[0];
    return raw.replace(/_/g, '-');
}

try {
    browser.storage.local.get('mfLocale').then((r: any) => {
        localeOverride = normalizeLocaleOverride(r?.mfLocale ?? null);
    }).catch(() => {});
    browser.storage.onChanged.addListener((changes: Record<string, any>, area: string) => {
        if (area === 'local' && 'mfLocale' in changes) {
            localeOverride = normalizeLocaleOverride(changes.mfLocale?.newValue ?? null);
        }
    });
} catch {}

/** Effective UI locale: respect the extension-storage test override first, then
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

// ── `_locales/<locale>/messages.json` loading (single source of truth for all copy) ──

type RawMessageEntry = { message: string; placeholders?: Record<string, { content: string }> };

const localeMessageCache = new Map<string, Record<string, RawMessageEntry>>();
const localeMessageLoadPromises = new Map<string, Promise<void>>();

/** Kick off (once) an async fetch of `_locales/<locale>/messages.json` and cache it.
 *  Used for the mfLocale test override and as the ultimate fallback when the
 *  chrome/browser i18n API is unavailable — both are edge paths, so the fetch
 *  being async (results only available on the *next* call to `t`) is an acceptable
 *  trade-off for not duplicating any translated copy inside this file.
 *
 *  `locale` may be a hyphenated BCP-47 tag (e.g. "zh-TW"); the `_locales/` folders
 *  are named with underscores, so candidates try the underscore form first, then
 *  the bare base language, caching the result under the original hyphenated key. */
function ensureLocaleMessagesLoading(locale: string): void {
    if (localeMessageCache.has(locale) || localeMessageLoadPromises.has(locale)) return;
    const promise = (async () => {
        try {
            const runtime = (typeof chrome !== 'undefined' && (chrome as any).runtime)
                ? (chrome as any).runtime
                : (typeof browser !== 'undefined' && (browser as any).runtime)
                    ? (browser as any).runtime
                    : null;
            const candidates = [locale.replace(/-/g, '_'), locale.split('-')[0]];
            for (const c of candidates) {
                const url = runtime?.getURL?.(`_locales/${c}/messages.json`);
                if (!url) continue;
                const res = await fetch(url);
                if (!res.ok) continue;
                const json = await res.json();
                localeMessageCache.set(locale, json);
                return;
            }
        } catch {
        } finally {
            localeMessageLoadPromises.delete(locale);
        }
    })();
    localeMessageLoadPromises.set(locale, promise);
}

/** Formats a raw `_locales` message entry the same way chrome.i18n.getMessage does:
 *  named `$PLACEHOLDER$` tokens are resolved via the entry's `placeholders` map to a
 *  positional `$1`/`$2`/... substitution, bare `$1`.. tokens substitute directly, and
 *  `$$` is a literal dollar sign. */
function formatRawMessage(entry: RawMessageEntry, subs?: string[]): string {
    let msg = entry.message;
    if (entry.placeholders) {
        msg = msg.replace(/\$([A-Za-z0-9_]+)\$/g, (whole, name: string) => {
            const ph = entry.placeholders?.[name.toLowerCase()];
            if (!ph) return whole;
            const m = /^\$(\d+)$/.exec(ph.content);
            if (!m) return ph.content;
            const idx = parseInt(m[1], 10) - 1;
            return subs?.[idx] !== undefined ? subs[idx] : whole;
        });
    }
    if (subs) {
        msg = msg.replace(/\$(\d+)/g, (whole, num: string) => {
            const idx = parseInt(num, 10) - 1;
            return subs[idx] !== undefined ? subs[idx] : whole;
        });
    }
    return msg.replace(/\$\$/g, '$');
}

/** Safe i18n lookup — falls back to English via `_locales/en/messages.json`. All copy
 *  lives exclusively in `public/_locales/<locale>/messages.json`; nothing is duplicated here. */
function t(key: string, subs?: string[]): string {
    try {
        if (localeOverride && localeOverride !== 'en') {
            ensureLocaleMessagesLoading(localeOverride);
            const map = localeMessageCache.get(localeOverride);
            const entry = map?.[key];
            if (entry) return formatRawMessage(entry, subs);
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
    ensureLocaleMessagesLoading('en');
    const enEntry = localeMessageCache.get('en')?.[key];
    return enEntry ? formatRawMessage(enEntry, subs) : key;
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

/** Check if reclassifyOnHold flag changed without text/content changes. */
function reclassifyFlagChanged(a: Claim[] | null | undefined, b: Claim[] | null | undefined): boolean {
    if (!a && !b) return false;
    if (!a || !b) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i].reclassifyOnHold !== b[i].reclassifyOnHold) return true;
    }
    return false;
}

/**
 * Track which claim highlights have already been animated so we only animate
 * new highlights, not color-only updates of an existing highlight.
 */
const animatedHighlights = new WeakSet<HTMLElement>();
// Stable per-claim animation memory (keyed "tweetId:claimIndex"), so the wipe only
// plays the FIRST time a claim's highlight appears — not every time the segment spans
// are rebuilt (which happens whenever a new claim arrives and the text re-splits).
const animatedHighlightKeys = new Set<string>();

/** True when the host page is in a dark theme, so highlight tints use white rather
 *  than black. Read from the body's background luminance (works across X's themes). */
function isDarkMode(): boolean {
    try {
        const m = getComputedStyle(document.body).backgroundColor.match(/\d+/g);
        if (m && m.length >= 3) {
            const [r, g, b] = m.map(Number);
            return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 128;
        }
    } catch { /* ignore */ }
    return true;
}

/** Highlight tint for a claim. On-hold ("Fact-Check", actionable) = a prominent
 *  black/white tint; researching ("Fact-Checking", in progress) or no verdict = gray;
 *  otherwise the verdict color. `hover` returns the stronger hover variant. */
function highlightBgColor(claim: Claim, hover: boolean): string {
    const hasVerdictColor = claim.confidence !== undefined && claim.confidence !== null
        && claim.veracity !== undefined && claim.veracity !== null && claim.confidence >= 0.2;
    if (claim.reclassifyOnHold) {
        return isDarkMode()
            ? (hover ? 'rgba(255,255,255,0.40)' : 'rgba(255,255,255,0.28)')
            : (hover ? 'rgba(0,0,0,0.34)' : 'rgba(0,0,0,0.22)');
    }
    if (!hasVerdictColor) return hover ? 'rgba(128,128,128,0.35)' : 'rgba(128,128,128,0.25)';
    return confidenceRgba(claim.confidence, hover ? 0.5 : 0.25, claim.veracity);
}

// Last known mouse-pointer position (viewport coords). Tracked so a highlight whose
// state changes UNDER a stationary cursor — e.g. clicking "Fact-Check" flips it to
// "Fact-Checking" and then to a verdict, all without the mouse ever moving — can
// re-evaluate its own hover state instead of only reacting once the user physically
// moves the pointer out and back in. Touch pointers never fire mousemove, so this
// stays inert on touch (the values remain -1).
let mfPointerX = -1, mfPointerY = -1;

/** The span most recently handed a SYNTHETIC mouseenter by resyncHoverAtPointer.
 *
 *  A synthetic enter has no browser-guaranteed matching mouseleave — the pointer never
 *  really entered, so the browser will never announce it leaving. When the cached
 *  coordinates are stale (the pointer flicked across the highlight and kept going, or
 *  left the window entirely so no fresher mousemove was recorded), the resync lands on a
 *  span the cursor is no longer over and its hover state — tinted background, inline
 *  badge, and the article-level preview-popover timer — sticks until the node is
 *  re-rendered (which is why scrolling away and back clears it).
 *
 *  So: remember that span, and on the next REAL mouse move, if the pointer isn't inside
 *  it, hand it the mouseleave the browser owes it. Dispatching the real event (rather
 *  than resetting styles here) keeps every existing guard intact — the span's own
 *  handler still honours _mfPopoverOpen / _mfBadgePermanent, and the article's
 *  capture-phase listener still cancels the preview — exactly mirroring how the
 *  synthetic enter reaches both layers. */
let mfSyntheticHoverSpan: HTMLElement | null = null;

if (typeof window !== "undefined") {
    window.addEventListener("mousemove", (e) => {
        mfPointerX = e.clientX; mfPointerY = e.clientY;
        const stuck = mfSyntheticHoverSpan;
        if (!stuck) return;
        // Node re-rendered away: its stuck state went with it, just drop the reference.
        if (!stuck.isConnected) { mfSyntheticHoverSpan = null; return; }
        const atPoint = document.elementFromPoint(e.clientX, e.clientY);
        if (atPoint === stuck || stuck.contains(atPoint)) return; // genuinely still hovered
        mfSyntheticHoverSpan = null;
        stuck.dispatchEvent(new MouseEvent("mouseleave", { bubbles: false, clientX: e.clientX, clientY: e.clientY }));
    }, true);
}

/** If the pointer is currently sitting inside `span`, re-fire a synthetic mouseenter
 *  so both hover layers (the span's own inline-badge listener AND the article-level
 *  preview-popover trigger) react as if the user had just entered it. This replicates
 *  the manual "move the mouse out and back in" the user otherwise has to do after an
 *  in-place transition the browser doesn't treat as a hover change (the cursor never
 *  moved). Because it just replays a real mouseenter, every existing guard (on-hold,
 *  permanent badge, already-open popover) is honoured unchanged. No-op if the pointer
 *  isn't over the span (or on touch, where the coords stay -1). */
function resyncHoverAtPointer(span: HTMLElement) {
    if (mfPointerX < 0 || mfPointerY < 0) return;
    const atPoint = document.elementFromPoint(mfPointerX, mfPointerY);
    if (!atPoint) return;
    if (atPoint === span || span.contains(atPoint)) {
        span.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false, clientX: mfPointerX, clientY: mfPointerY }));
        // Track it so the next real mouse move can undo this if the coords were stale.
        mfSyntheticHoverSpan = span;
    }
}

/** Animate a claim highlight background wiping in. LTR wipes left-to-right;
 *  RTL wipes right-to-left. After the animation finishes the span reverts to a
 *  solid background color so hover effects work normally.
 *
 *  If the span already had a highlight and only the color changes, no animation
 *  is played — the background color is updated directly. */
function animateHighlightReveal(span: HTMLElement, bgColor: string) {
    // Record the highlight's intended (resting) color so callers can tell whether the
    // classification color actually changed, without being fooled by the transient
    // 'transparent' background used mid-wipe.
    (span as any)._mfTargetBg = bgColor;

    // Cancel any in-flight cleanup scheduled by a previous call so its stale (old)
    // bgColor can't overwrite this one when its transitionend/timeout fires later.
    const prevOnEnd = (span as any)._mfRevealOnEnd as (() => void) | undefined;
    if (prevOnEnd) { span.removeEventListener('transitionend', prevOnEnd); (span as any)._mfRevealOnEnd = null; }
    const prevTimeout = (span as any)._mfRevealTimeout as ReturnType<typeof setTimeout> | undefined;
    if (prevTimeout) { clearTimeout(prevTimeout); (span as any)._mfRevealTimeout = null; }

    // Prefer the stable per-claim key so a rebuilt span for a claim that already
    // animated doesn't replay the wipe (fixes the blink + "all re-animate on each new
    // highlight"). Fall back to the span object if no key was assigned.
    const animKey = span.dataset.mfAnimKey;
    const alreadyHighlighted = animKey ? animatedHighlightKeys.has(animKey) : animatedHighlights.has(span);
    if (animKey) animatedHighlightKeys.add(animKey); else animatedHighlights.add(span);

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
        // Swap the finished gradient for the solid resting color INSTANTLY. Without
        // killing the transition here, background-color fades transparent→bgColor over
        // 0.15s while the gradient is already gone — a ~150ms near-invisible flash (the
        // "blink"). Force it with transition:none, then restore next frame for hover.
        span.style.transition = 'none';
        span.style.backgroundImage = '';
        span.style.backgroundSize = '';
        span.style.backgroundPosition = '';
        span.style.backgroundRepeat = '';
        span.style.backgroundColor = bgColor;
        // eslint-disable-next-line no-unused-expressions
        span.offsetHeight; // force reflow so the instant swap commits before transition is restored
        span.style.transition = '';
        span.removeEventListener('transitionend', onEnd);
        if ((span as any)._mfRevealOnEnd === onEnd) (span as any)._mfRevealOnEnd = null;
        if ((span as any)._mfRevealTimeout) { clearTimeout((span as any)._mfRevealTimeout); (span as any)._mfRevealTimeout = null; }
    };
    (span as any)._mfRevealOnEnd = onEnd;
    span.addEventListener('transitionend', onEnd);
    // Safety net in case transitionend doesn't fire
    (span as any)._mfRevealTimeout = setTimeout(onEnd, 600);
}

/** Remove all .mf-segment-wrap DOM elements for the given tweet ID.
 *  This forces the next upgradeToSegments call to re-render from scratch
 *  instead of updating in place (needed when claims change after batch refresh). */
function removeSegmentWraps(tweetId: string) {
    const links = document.querySelectorAll(`a[href*="/status/${tweetId}"]`);
    for (const link of links) {
        const article = link.closest('article');
        if (!article) continue;
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
        const onHold = article.querySelector(`[mf-on-hold-id="${tweetId}"]`);
        if (onHold) onHold.remove();
    }
    processingOnHoldIds.delete(tweetId);
    processingTranslateFactChecksIds.delete(tweetId);
}

/** Neutralize a segment wrap so the tweet text stays visible but carries no
 *  highlights, badges, or interactivity. The rendered text (and its links) is
 *  kept exactly as-is; only the extension styling is stripped, and all event
 *  listeners are dropped by replacing the node with a clone. The wrap is also
 *  un-classed so a later re-login re-renders segments from scratch. */
function freezeSegmentWrap(wrap: HTMLElement) {
    for (const badge of Array.from(wrap.querySelectorAll('.mf-inline-badge'))) badge.remove();
    for (const span of Array.from(wrap.querySelectorAll<HTMLElement>('.mf-segment-claim'))) {
        span.classList.remove('mf-segment-claim', 'mf-highlight-reveal');
        span.style.backgroundColor = '';
        span.style.backgroundImage = '';
        span.style.backgroundSize = '';
        span.style.cursor = '';
        span.removeAttribute('classification-id');
    }
    wrap.classList.remove('mf-segment-wrap');
    // Drop every attached listener (hover/click popover triggers) by cloning.
    wrap.replaceWith(wrap.cloneNode(true));
}

/** Tear down every injection on the page. Tweet text is preserved (highlights
 *  stripped in place); all standalone UI (buttons, popovers, notifications,
 *  onboarding) is removed, and internal state is reset so a subsequent
 *  re-login re-injects from scratch. */
export function removeAllInjections() {
    for (const wrap of Array.from(document.querySelectorAll<HTMLElement>('.mf-segment-wrap'))) {
        freezeSegmentWrap(wrap);
    }
    const standalone = document.querySelectorAll(
        '[classification-id],[mf-unmatched],[translate-fc-id],[mf-on-hold-id],.mf-popover,.mf-onboard,.mf-onboard-attached,.mf-notif-container,.mf-floating-scroll-btn'
    );
    for (const el of Array.from(standalone)) el.remove();

    for (const path of Array.from(floatingButtonRegistry.keys())) clearFloatingButtonForPath(path, true);
    previewPopoverState = null;
    allClassifications.length = 0;
    processingOnHoldIds.clear();
    processingTranslateFactChecksIds.clear();
    requestedQuotedDbFetchIds.clear();
    factCheckAllClickedIds.clear();
    individuallyClickedOnHoldClaims.clear();
    onHoldScrollStates.clear();
    textBreakupInProgress.clear();
}

/** Freeze or resume the extension. Freezing (user logged out) tears down all
 *  injections and blocks any further injection/notification/onboarding until
 *  resumed. Resuming (logged back in) simply lifts the block; re-injection is
 *  driven by the relay re-sending captured tweets. */
export function setExtensionFrozen(frozen: boolean) {
    if (frozen === extensionFrozen) return;
    extensionFrozen = frozen;
    if (frozen) removeAllInjections();
}

/** Returns true if any representation of the tweet (main article or quoted tweet card) is within the viewport. */
function isTweetVisible(tweetId: string): boolean {
    const links = document.querySelectorAll(`a[href*="/status/${tweetId}"]`);
    if (links.length === 0) return false;

    for (const link of links) {
        const target = link.closest('article, div[role="link"], div[data-testid="card.wrapper"]') ?? link;
        const rect = target.getBoundingClientRect();
        if (rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight) {
            return true;
        }
    }
    return false;
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
        !cl.refreshing &&
        cl.note !== null && cl.note !== undefined &&
        cl.confidence !== undefined && cl.confidence !== null && cl.confidence >= 0.2 &&
        cl.veracity !== undefined && cl.veracity !== null
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

function clearFloatingButtonForPath(path: string, force = false) {
    const state = floatingButtonRegistry.get(path);
    if (!state) return;

    if (!force) {
        tryDismissFloatingButtonForPath(path);
        return;
    }

    if (state.dismissTimer) { clearTimeout(state.dismissTimer); state.dismissTimer = null; }
    if (state.hoverLeaveTimer) { clearTimeout(state.hoverLeaveTimer); state.hoverLeaveTimer = null; }
    if (state.visibilityCheck) { clearInterval(state.visibilityCheck); state.visibilityCheck = null; }

    if (state.btn && state.btn.isConnected) {
        state.btn.remove();
    }
    floatingButtonRegistry.delete(path);
}

function clearFloatingButton(force = false) {
    clearFloatingButtonForPath(window.location.pathname, force);
}

function tryDismissFloatingButtonForPath(path: string, force = false) {
    if (force) {
        clearFloatingButtonForPath(path, true);
        return;
    }

    const state = floatingButtonRegistry.get(path);
    if (!state) return;

    const currentElapsed = (path === window.location.pathname) ? (performance.now() - state.timerStartedAt) : 0;
    const totalRemaining = state.remainingTimeMs - currentElapsed;

    if (totalRemaining > 0) return;
    if (state.hovered) return;

    const timeSinceLeave = state.lastHoverLeaveAt > 0 ? (performance.now() - state.lastHoverLeaveAt) : Infinity;
    if (state.lastHoverLeaveAt > 0 && timeSinceLeave < 1000) {
        if (state.hoverLeaveTimer) clearTimeout(state.hoverLeaveTimer);
        state.hoverLeaveTimer = setTimeout(() => tryDismissFloatingButtonForPath(path), 1000 - timeSinceLeave + 50);
        return;
    }

    clearFloatingButtonForPath(path, true);
}

function tryDismissFloatingButton(force = false) {
    tryDismissFloatingButtonForPath(window.location.pathname, force);
}

function handlePathChange(oldPath: string, newPath: string) {
    const oldState = floatingButtonRegistry.get(oldPath);
    if (oldState) {
        const elapsed = performance.now() - oldState.timerStartedAt;
        oldState.remainingTimeMs = Math.max(0, oldState.remainingTimeMs - elapsed);

        if (oldState.dismissTimer) { clearTimeout(oldState.dismissTimer); oldState.dismissTimer = null; }
        if (oldState.hoverLeaveTimer) { clearTimeout(oldState.hoverLeaveTimer); oldState.hoverLeaveTimer = null; }
        if (oldState.visibilityCheck) { clearInterval(oldState.visibilityCheck); oldState.visibilityCheck = null; }

        if (oldState.btn) {
            oldState.btn.style.display = "none";
        }
    }

    const newState = floatingButtonRegistry.get(newPath);
    if (newState) {
        if (newState.remainingTimeMs > 0) {
            newState.btn.style.display = "inline-flex";
            newState.timerStartedAt = performance.now();

            newState.dismissTimer = setTimeout(() => {
                tryDismissFloatingButtonForPath(newPath);
            }, newState.remainingTimeMs);

            newState.visibilityCheck = setInterval(() => {
                if (isTweetVisible(newState.tweetId)) {
                    clearFloatingButtonForPath(newPath, true);
                }
            }, 500);
        } else {
            clearFloatingButtonForPath(newPath, true);
        }
    }
}

function checkPathChange() {
    const newPath = window.location.pathname;
    if (newPath !== currentPathname) {
        const oldPath = currentPathname;
        currentPathname = newPath;
        handlePathChange(oldPath, newPath);
    }
}

function setupNavigationListener() {
    if (navigationListenerSetup) return;
    navigationListenerSetup = true;

    window.addEventListener("popstate", checkPathChange);

    const origPush = history.pushState;
    history.pushState = function (...args) {
        origPush.apply(this, args);
        checkPathChange();
    };

    const origReplace = history.replaceState;
    history.replaceState = function (...args) {
        origReplace.apply(this, args);
        checkPathChange();
    };

    setInterval(checkPathChange, 200);
}

/** Compute the center X coordinate of the timeline column on screen. */
function getTimelineColumnCenter(): number | null {
    const primaryCol = document.querySelector<HTMLElement>('[data-testid="primaryColumn"]');
    if (primaryCol) {
        const rect = primaryCol.getBoundingClientRect();
        return rect.left + rect.width / 2;
    }
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
    classification?: Classification,
    tweetId: string = ''
): HTMLElement {
    const path = window.location.pathname;
    clearFloatingButtonForPath(path, true);
    setupNavigationListener();

    const isRTL = isRTLLocale(getEffectiveUILocale());
    const avgColor = classification ? averageClaimColor(classification) : null;
    const darkened = avgColor ? darkenColor(avgColor, 0.25) : null;
    const baseRgb = darkened ? `${darkened.r}, ${darkened.g}, ${darkened.b}` : "29, 155, 240";

    const timelineCenter = getTimelineColumnCenter();
    const left = timelineCenter !== null ? `${timelineCenter}px` : '50%';
    const transform = 'translateX(-50%)';

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

    const now = performance.now();
    const state: FloatingButtonState = {
        path,
        btn,
        createdAt: now,
        timerStartedAt: now,
        remainingTimeMs: 10000,
        lastHoverLeaveAt: 0,
        hovered: false,
        dismissTimer: null,
        hoverLeaveTimer: null,
        visibilityCheck: null,
        tweetId
    };

    btn.addEventListener("mouseenter", () => {
        state.hovered = true;
        if (state.hoverLeaveTimer) {
            clearTimeout(state.hoverLeaveTimer);
            state.hoverLeaveTimer = null;
        }
    });

    btn.addEventListener("mouseleave", () => {
        state.hovered = false;
        state.lastHoverLeaveAt = performance.now();
        const currentElapsed = performance.now() - state.timerStartedAt;
        if (state.remainingTimeMs - currentElapsed <= 0) {
            if (state.hoverLeaveTimer) clearTimeout(state.hoverLeaveTimer);
            state.hoverLeaveTimer = setTimeout(() => tryDismissFloatingButtonForPath(path), 1000);
        }
    });

    const handler = () => {
        clearFloatingButtonForPath(path, true);
        onClick();
    };
    btn.addEventListener("click", handler);

    document.body.appendChild(btn);
    floatingButtonRegistry.set(path, state);

    state.dismissTimer = setTimeout(() => tryDismissFloatingButtonForPath(path), 10000);

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
    return `<div class="mf-fc-btn-preview" style="font-size:12px;line-height:1.35;font-weight:400;font-style:italic;opacity:0.92;text-align:${isRTL ? 'right' : 'left'};max-width:340px;white-space:normal;word-wrap:break-word;padding:4px 0;cursor:pointer;">${escaped}</div>`;
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
            : pickResearchingWord(`${classification.id}:${cl.text}`);
        return `<div class="mf-fc-btn-claim" style="display:flex;align-items:center;${isRTL ? 'flex-direction:row-reverse;' : 'flex-direction:row;'}gap:6px;margin:2px 0;white-space:nowrap;width:100%;cursor:pointer;"><span style="display:inline-flex;align-items:center;padding:2px 7px;border-radius:999px;font-size:10px;font-weight:600;background:rgba(0,0,0,0.5);color:${badgeColor};white-space:nowrap;flex-shrink:0;">${badgeLabel}</span><span style="font-size:11px;${isRTL ? 'text-align:right;' : 'text-align:left;'}overflow:hidden;text-overflow:ellipsis;max-width:280px;opacity:0.95;">${escaped}</span></div>`;
    });
    return `<div class="mf-fc-btn-claims" style="display:flex;flex-direction:column;align-items:${isRTL ? 'flex-end' : 'flex-start'};gap:2px;max-width:360px;">${rows.join('')}</div>`;
}

/** Build the full Fact-Checked button contents with main label + extra area.
 *  When position === 'top', extraHtml is placed BELOW main so main stays fixed under cursor.
 *  When position === 'bottom', extraHtml is placed ABOVE main so main stays fixed under cursor. */
function factCheckedButtonContent(extraHtml: string, label: string, iconSvg: string, isRTL: boolean, position: 'top' | 'bottom'): string {
    const main = factCheckedButtonDefaultHtml(label, iconSvg, isRTL);
    return position === 'top' ? `${main}${extraHtml}` : `${extraHtml}${main}`;
}

/** Show the "Fact-Checked" floating button if the tweet is off-screen. */
function showFactCheckedFloatingButton(tweetId: string, originalScrollY: number, classification: Classification) {
    if (isTweetVisible(tweetId)) {
        console.log(`[misinfo] showFactCheckedFloatingButton ${tweetId}: tweet is visible, skipping`);
        return;
    }

    const tweetText = findTweetTextInDom(tweetId) ?? '';
    const isRTL = isRTLLocale(getEffectiveUILocale());
    const avgColor = averageClaimColor(classification);
    const darkened = avgColor ? darkenColor(avgColor, 0.25) : null;
    const brightened = avgColor ? brightenColor(avgColor, 0.5) : null;
    const normalRgb = darkened ? `${darkened.r}, ${darkened.g}, ${darkened.b}` : "29, 155, 240";
    const hoverRgb = brightened ? `${brightened.r}, ${brightened.g}, ${brightened.b}` : "29, 155, 240";

    const article = document.querySelector(`a[href*="/status/${tweetId}"]`)?.closest('article');
    const tweetRect = article?.getBoundingClientRect();

    // If fact-checked tweet is above viewport, position = 'top', arrow points UP.
    // If fact-checked tweet is below viewport, position = 'bottom', arrow points DOWN.
    const isTweetAbove = tweetRect ? tweetRect.bottom <= window.innerHeight / 2 : true;
    const position: 'top' | 'bottom' = isTweetAbove ? 'top' : 'bottom';
    const factCheckedIcon = position === 'top' ? upArrowSvg : downArrowSvg;

    const path = window.location.pathname;
    const btn = createFloatingButton(t("factCheckedFloatingButton"), factCheckedIcon, position, async () => {
        const capturedOriginalScrollY = window.scrollY;
        await scrollToTweet(tweetId, 1000);
        // Go Back button appears at opposite edge
        const goBackPosition: 'top' | 'bottom' = position === 'top' ? 'bottom' : 'top';
        showGoBackFloatingButton(tweetId, capturedOriginalScrollY, classification, goBackPosition);
    }, classification, tweetId);

    btn.innerHTML = factCheckedButtonDefaultHtml(t("factCheckedFloatingButton"), factCheckedIcon, isRTL);
    (btn as any)._mfIsFactCheckedButton = true;

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

    function setupClaimBadgeHoverHandlers() {
        const claimEls = btn.querySelectorAll<HTMLElement>(".mf-fc-btn-claim");
        claimEls.forEach((claimEl, index) => {
            let badgeHoverTimer: ReturnType<typeof setTimeout> | null = null;

            claimEl.addEventListener("mouseenter", () => {
                if (badgeHoverTimer) clearTimeout(badgeHoverTimer);
                badgeHoverTimer = setTimeout(() => {
                    const state = floatingButtonRegistry.get(path);
                    if (!state?.hovered) return;
                    const claim = classification.claims?.[index];
                    if (claim) {
                        showPreviewPopoverFromButton(btn, claim, classification, claimEl);
                    }
                }, 1000);
            });

            claimEl.addEventListener("mouseleave", () => {
                if (badgeHoverTimer) {
                    clearTimeout(badgeHoverTimer);
                    badgeHoverTimer = null;
                }
                if (previewPopoverState && (previewPopoverState.trigger as any)?._mfAnchorEl === claimEl) {
                    schedulePreviewPopoverDismiss(previewPopoverState.trigger);
                }
            });
        });
    }

    function showPreview() {
        showingClaims = false;
        setHoverStyle();
        btn.style.borderRadius = "999px";
        btn.innerHTML = factCheckedButtonContent(
            factCheckedButtonPreviewHtml(tweetText, isRTL),
            t("factCheckedFloatingButton"), factCheckedIcon, isRTL, position
        );
    }

    function showClaims() {
        showingClaims = true;
        setHoverStyle();
        btn.innerHTML = factCheckedButtonContent(
            factCheckedButtonClaimsHtml(classification, isRTL),
            t("factCheckedFloatingButton"), factCheckedIcon, isRTL, position
        );
        setupClaimBadgeHoverHandlers();
        // When the claim-badge list makes the button grow past 3 rows, switch from a
        // pill to a rounded rectangle whose corner radius equals half the button's
        // height at exactly 3 rows (i.e. the pill corner diameter at 3 rows).
        const claimEls = btn.querySelectorAll<HTMLElement>(".mf-fc-btn-claim");
        if (claimEls.length > 3) {
            const perRow = claimEls.length >= 2
                ? claimEls[1].offsetTop - claimEls[0].offsetTop
                : claimEls[0].offsetHeight;
            const heightAt3 = btn.offsetHeight - (claimEls.length - 3) * perRow;
            btn.style.borderRadius = `${Math.max(0, heightAt3 / 2)}px`;
        } else {
            btn.style.borderRadius = "999px";
        }
    }

    function resetButton() {
        showingClaims = false;
        setNormalStyle();
        btn.style.borderRadius = "999px";
        btn.innerHTML = factCheckedButtonDefaultHtml(t("factCheckedFloatingButton"), factCheckedIcon, isRTL);
    }

    btn.addEventListener("mouseenter", () => {
        if (!showingClaims) {
            showPreview();
        }
    });

    btn.addEventListener("mouseleave", () => {
        resetButton();
        if (previewPopoverState && (previewPopoverState.trigger as any)?._mfButtonPreview) {
            schedulePreviewPopoverDismiss(previewPopoverState.trigger);
        }
    });

    // Hovering over .mf-fc-btn-preview transitions to claim-badges; hovering back over .mf-fc-btn-main transitions back to the 140-char preview
    btn.addEventListener("mouseover", (e) => {
        const target = e.target as HTMLElement;
        if (target.closest(".mf-fc-btn-preview")) {
            if (!showingClaims) {
                showClaims();
            }
        } else if (target.closest(".mf-fc-btn-main")) {
            if (showingClaims) {
                showPreview();
                if (previewPopoverState && (previewPopoverState.trigger as any)?._mfButtonPreview) {
                    dismissPreviewPopover();
                }
            }
        }
    });

    const state = floatingButtonRegistry.get(path);
    if (state) {
        state.visibilityCheck = setInterval(() => {
            if (isTweetVisible(tweetId)) {
                clearFloatingButtonForPath(path, true);
            }
        }, 500);
    }
}

/** Show the "Go Back" floating button after scrolling to the tweet. */
function showGoBackFloatingButton(tweetId: string, originalScrollY: number, classification: Classification, position: 'top' | 'bottom' = 'bottom') {
    const label = t("goBackFloatingButton");
    const isRTL = isRTLLocale(getEffectiveUILocale());
    const path = window.location.pathname;

    // Point arrow towards direction of scroll when clicked:
    // If original position is above current position (originalScrollY < window.scrollY), arrow points UP.
    // If original position is below current position (originalScrollY > window.scrollY), arrow points DOWN.
    const goBackIcon = originalScrollY < window.scrollY ? upArrowSvg : downArrowSvg;

    const btn = createFloatingButton(label, goBackIcon, position, async () => {
        await scrollToPosition(originalScrollY, 1000);
    }, classification, tweetId);

    const safeLabel = label || "Go Back";
    btn.innerHTML = `<div style="display:flex;${isRTL ? 'flex-direction:row-reverse;' : 'flex-direction:row;'}align-items:center;gap:8px;font-size:15px;font-weight:700;">${isRTL ? `<span>${safeLabel}</span>${goBackIcon}` : `${goBackIcon}<span>${safeLabel}</span>`}</div>`;

    btn.addEventListener("mouseenter", () => {
        btn.style.transform = "translateX(-50%) scale(1.03)";
        btn.style.boxShadow = "0 8px 26px rgba(0,0,0,0.45)";
    });
    btn.addEventListener("mouseleave", () => {
        btn.style.transform = "translateX(-50%) scale(1)";
        btn.style.boxShadow = "0 6px 20px rgba(0,0,0,0.35)";
    });

    const state = floatingButtonRegistry.get(path);
    if (state) {
        let becameInvisibleAt: number | null = null;
        state.visibilityCheck = setInterval(() => {
            const visible = isTweetVisible(tweetId);
            if (!visible) {
                if (becameInvisibleAt === null) becameInvisibleAt = performance.now();
                else if (performance.now() - becameInvisibleAt >= 10000) {
                    tryDismissFloatingButtonForPath(path);
                }
            } else {
                becameInvisibleAt = null;
            }
            if (Math.abs(window.scrollY - originalScrollY) < 5) {
                clearFloatingButtonForPath(path, true);
            }
        }, 500);
    }
}

/** Track pending claims for on-hold Disinfact clicks and trigger the floating
 *  scroll button when all claims are done and the tweet is off-screen. */
function updateOnHoldScrollTracking(classification: Classification) {
    const state = onHoldScrollStates.get(classification.id);
    if (!state) return;

    const allClaims: Claim[] = [
        ...(classification.claims ?? []),
        ...(classification.quoting?.claims ?? [])
    ];

    if (allClaims.length === 0) return;

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

    for (const cl of allClaims) {
        const isResearched = cl.verdict !== "research required" && cl.note !== null && cl.note !== undefined;
        if (isResearched) {
            state.pendingClaimTexts.delete(cl.text);
        }
    }

    console.log(`[misinfo] updateOnHoldScrollTracking ${classification.id}: pending=${state.pendingClaimTexts.size}, anyFresh=${allClaims.some(cl => cl.freshlyResearched)}, visible=${isTweetVisible(classification.id)}`);

    if (state.pendingClaimTexts.size === 0) {
        const anyCompleted = allClaims.some(cl =>
            cl.verdict !== "research required" && cl.note !== null && cl.note !== undefined
        );
        if (anyCompleted) {
            console.log(`[misinfo] updateOnHoldScrollTracking ${classification.id}: showing Fact-Checked button`);
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

/** Dispatch a custom event to fetch a quoted tweet classification from DB concurrently. */
function requestQuotedDbFetch(quotedTweetId: string, parentTweetId: string) {
    if (!quotedTweetId || requestedQuotedDbFetchIds.has(quotedTweetId)) return;

    const existing = allClassifications.find(x => x.id === quotedTweetId);
    if (existing && existing.claims && existing.claims.length > 0) {
        return;
    }

    requestedQuotedDbFetchIds.add(quotedTweetId);
    console.log(`[misinfo] Requesting DB fetch for quoted tweet ${quotedTweetId} (parent ${parentTweetId})`);
    mfBus.dispatchEvent(new CustomEvent('mf-fetch-quoted-db', {
        detail: { tweetId: quotedTweetId, parentTweetId }
    }));
}

/** Find a quoted status ID inside an article DOM element. */
function findQuotedTweetIdInArticle(article: Element, mainTweetId: string): string | null {
    const links = article.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]');
    for (const link of links) {
        const match = link.href.match(/\/status\/(\d+)/);
        if (match && match[1] !== mainTweetId) {
            return match[1];
        }
    }
    return null;
}

/** Sync cached quoted tweet classifications into parent classifications. */
function syncQuotingClassifications() {
    const classMap = new Map<string, Classification>();
    for (const c of allClassifications) {
        classMap.set(c.id, c);
    }
    for (const c of allClassifications) {
        if (c.quoting?.id) {
            const cachedQuoted = classMap.get(c.quoting.id);
            if (cachedQuoted) {
                if (cachedQuoted.claims && cachedQuoted.claims.length > 0) {
                    if (!c.quoting.claims || c.quoting.claims.length === 0 || !claimsEqual(c.quoting.claims, cachedQuoted.claims)) {
                        c.quoting.claims = cachedQuoted.claims;
                    }
                }
                if (cachedQuoted.segments && cachedQuoted.segments.length > 0) {
                    c.quoting.segments = cachedQuoted.segments;
                }
                if (cachedQuoted.onHold !== undefined) {
                    (c.quoting as any).onHold = cachedQuoted.onHold;
                }
                if (cachedQuoted.translateFactChecksOnHold !== undefined) {
                    (c.quoting as any).translateFactChecksOnHold = cachedQuoted.translateFactChecksOnHold;
                }
            }
        }
    }
}

let debounceTimeout: NodeJS.Timeout | null = null;
let stylesInjected = false;

export function injectClassifications(classifications: Classification[], tweetTextCache?: Map<string, string>, translatedTextCache?: Map<string, string>) {
    if (extensionFrozen) return;
    setupNavigationListener();
    console.log(`[misinfo] injectClassifications: received ${classifications.length} classifications`, classifications.map(c => ({ id: c.id, claims: c.claims?.length, hasSegments: !!c.segments, cacheHas: tweetTextCache?.has(c.id), translatedHas: translatedTextCache?.has(c.id) })));

    for (const c of classifications) {
        if (c.quoting?.id) {
            requestQuotedDbFetch(c.quoting.id, c.id);
        }

        const idx = allClassifications.findIndex(x => x.id === c.id);
        if (idx >= 0) {
            const old = allClassifications[idx];
            const claimsChanged = !claimsEqual(c.claims, old.claims);
            const highlightsChanged = c.claims?.some((cl, i) => {
                const oldCl = old.claims?.[i];
                return oldCl && JSON.stringify(cl.highlight) !== JSON.stringify(oldCl.highlight);
            }) ?? false;
            const localeChanged = c.translatedLocale !== old.translatedLocale || c.textLocale !== old.textLocale;
            const flagChanged = reclassifyFlagChanged(c.claims, old.claims);
            const needsRedo = claimsChanged || highlightsChanged || localeChanged || flagChanged;
            if (needsRedo) {
                console.log(`[misinfo] injectClassifications: change detected for ${c.id} (claims=${claimsChanged}, highlights=${highlightsChanged}, locale=${localeChanged})`);
            }

            if (needsRedo) {
                textBreakupInProgress.delete(c.id);
                // Only re-derive segments if claims/highlights/locale changed, not if just reclassifyOnHold flag changed
                const shouldRederiveSegments = claimsChanged || highlightsChanged || localeChanged;
                if (old.segments && shouldRederiveSegments) {
                    console.log(`[misinfo] injectClassifications: re-deriving segments for ${c.id} (claims=${claimsChanged}, highlights=${highlightsChanged}, locale=${localeChanged})`);
                    c.segments = undefined;
                    removeSegmentWraps(c.id);
                } else if (!c.segments && old.segments) {
                    // Preserve segments even if flag changed
                    c.segments = old.segments;
                }
            } else if (!c.segments && old.segments) {
                c.segments = old.segments;
            }
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

    syncQuotingClassifications();

    for (const c of classifications) {
        if (!c.segments && c.claims && c.claims.length > 0) {
            kickOffTextBreakup(c, tweetTextCache, translatedTextCache);
        }
    }

    for (const c of allClassifications) {
        if (c.segments && c.quoting && c.quoting.claims?.length && !c.quoting.segments) {
            const quotedText = tweetTextCache?.get(c.quoting.id) ?? findTweetTextInDom(c.quoting.id);
            if (quotedText) {
                const qTextLocale = c.textLocale ?? c.translatedLocale;
                let qSegments: TextSegment[] | null = null;
                if (qTextLocale && c.quoting.claims.some(cl => !!resolveHighlightRange(cl.highlight, qTextLocale))) {
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

    for (const c of classifications) {
        updateOnHoldScrollTracking(c);
    }

    refreshOnboarding();

    if (!observerSetup) {
        observerSetup = true;
        const observer = new MutationObserver((mutations) => {
            checkPathChange();
            // Only re-inject when the HOST page actually changed (a tweet mounted /
            // re-rendered). Ignore mutations that are purely our OWN injected elements —
            // otherwise our injections (segments, popover text updates, onboarding
            // popovers on document.body) re-trigger this observer, which re-injects, which
            // mutates again: an infinite inject→observe→inject loop that thrashes the main
            // thread and detaches open popovers (the "click a highlight, badge sticks,
            // popover never opens, highlight frozen" bug).
            if (!mutations.some(hasNonExtensionChange)) return;
            if (debounceTimeout) clearTimeout(debounceTimeout);
            debounceTimeout = setTimeout(() => {
                classificationInjections(allClassifications);
                refreshOnboarding();
            }, 300);
        });
        observer.observe(document.body, {
            childList: true,
            subtree: true,
        });
    }
}

/** Selector matching every element the extension injects, so the timeline
 *  MutationObserver can distinguish host-page (real tweet) changes from our own. */
const MF_OWN_SELECTOR = '.mf-segment-wrap, .mf-popover, .mf-onboard, .mf-notif-container, .mf-floating-scroll-btn, [mf-on-hold-id], [classification-id], [mf-unmatched], [translate-fc-id]';

/** True if a mutated node is (or lives inside) one of our injected elements. */
function isOwnMutationNode(n: Node): boolean {
    const el: Element | null = n.nodeType === 1 ? (n as Element) : n.parentElement;
    if (!el) return false;
    if (typeof el.className === 'string' && el.className.startsWith('mf-')) return true;
    return el.matches?.(MF_OWN_SELECTOR) || el.closest?.(MF_OWN_SELECTOR) != null;
}

/** True only when a mutation adds/removes at least one node that ISN'T ours — i.e. a
 *  genuine host-page change worth re-injecting for. Extension-only mutations return false. */
function hasNonExtensionChange(m: MutationRecord): boolean {
    const nodes = [...Array.from(m.addedNodes), ...Array.from(m.removedNodes)];
    if (nodes.length === 0) return false;
    return nodes.some(n => !isOwnMutationNode(n));
}

function kickOffTextBreakup(classification: Classification, tweetTextCache?: Map<string, string>, translatedTextCache?: Map<string, string>) {
    if (textBreakupInProgress.has(classification.id)) {
        console.log(`[misinfo] Text breakup: already in progress for ${classification.id}, skipping`);
        return;
    }
    textBreakupInProgress.add(classification.id);

    const claims = classification.claims ?? [];

    let tweetText = classification.translatedText
        || translatedTextCache?.get(classification.id)
        || tweetTextCache?.get(classification.id)
        || findTweetTextInDom(classification.id);

    if (!tweetText) {
        console.log(`[misinfo] Text breakup: could not find tweet text for ${classification.id}`);
        textBreakupInProgress.delete(classification.id);
        return;
    }

    tweetText = htmlDecode(tweetText);

    for (const cl of claims) {
      cl.text = htmlDecode(cl.text);
      if (cl.rewritten) cl.rewritten = htmlDecode(cl.rewritten);
    }

    const domText = findTweetTextInDom(classification.id);
    const trailingMatch = tweetText.match(/\s+(https:\/\/t\.co\/\w+)\s*$/);
    if (trailingMatch && (!domText || !domText.includes(trailingMatch[1]))) {
        tweetText = tweetText.slice(0, trailingMatch.index).trim();
    }

    const textLocale = classification.textLocale ?? classification.translatedLocale;
    const hasTextLocale = !!textLocale;

    console.log(`[misinfo] Text breakup for ${classification.id}: textLocale=${textLocale ?? 'none'}, ${claims.length} claims`);

    let mainSegments: TextSegment[] | null = null;

    if (hasTextLocale) {
        const hlKey = textLocale!;
        // Resolve tolerantly: the range's stored key (worker keys by UI locale) can
        // differ from hlKey (displayed-text locale), so an exact-key check would wrongly
        // skip breakupWithHighlights and drop every claim to the unmatched fallback.
        const hasHl = claims.some(c => !!resolveHighlightRange(c.highlight, hlKey));
        console.log(`[misinfo] Text breakup for ${classification.id}: trying highlight key ${hlKey}, has=${hasHl}`);
        if (hasHl) {
            mainSegments = breakupWithHighlights(tweetText, claims, hlKey);
            console.log(`[misinfo] Text breakup for ${classification.id}: breakupWithHighlights result=${mainSegments ? mainSegments.length + ' segments' : 'null'}`);
        }
    }
    if (!mainSegments) {
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
        console.log(`[misinfo] Text breakup: no segments created for ${classification.id}, showing plain text`);
        classification.segments = [{ text: tweetText, claimIndex: null }];
    }

    if (classification.quoting && classification.quoting.claims && classification.quoting.claims.length > 0) {
        const quotedText = tweetTextCache?.get(classification.quoting.id) ?? findTweetTextInDom(classification.quoting.id);
        if (quotedText) {
            let quotedSegments: TextSegment[] | null = null;
            if (hasTextLocale) {
                const hasQuotedHl = classification.quoting.claims.some(c => !!resolveHighlightRange(c.highlight, textLocale!));
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

    classificationInjections([classification]);

    textBreakupInProgress.delete(classification.id);
}

function findTweetTextInDom(tweetId: string): string | null {
    const tryGetText = (article: Element, bestEffort = false): string | null => {
        const tweetTextEl = article.querySelector('[data-testid="tweetText"]');
        if (tweetTextEl?.textContent) return tweetTextEl.textContent;
        if (!bestEffort) return null;
        for (const el of article.querySelectorAll('[lang], div[dir="auto"]')) {
            const text = el.textContent?.trim();
            if (text && text.length > 10 && !el.closest('time')) {
                return el.textContent;
            }
        }
        return null;
    };

    const timeLink = document.querySelector(`a[href*="/status/${tweetId}"]`);
    if (timeLink) {
        const article = timeLink.closest('article');
        if (article) {
            const text = tryGetText(article, true);
            if (text) return text;
        }
    }

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

/** Find the main status ID of an article element. */
function getArticleMainStatusId(article: Element): string | null {
    const link = article.querySelector<HTMLAnchorElement>('a[href*="/status/"]');
    if (!link) return null;
    const match = link.href.match(/\/status\/(\d+)/);
    return match ? match[1] : null;
}

function classificationInjections(classifications: Classification[]) {
    if (extensionFrozen) return;
    syncQuotingClassifications();
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
            const mainStatusId = getArticleMainStatusId(article);
            const isQuoted = mainStatusId !== null && mainStatusId !== classification.id;
            injectClassification(time, classification, article, isQuoted);
        }
    }
}

// Assigns each claim a single, stable random word (from `researchingWords`) for as
// long as it stays in the "being fact-checked" state, keyed by a caller-supplied seed
// (typically `${classificationId}:${claimText}`) so the word doesn't flicker on re-render.
const researchingWordCache = new Map<string, string>();

function researchingWordsList(): string[] {
    return t("researchingWords").split("|").map(w => w.trim()).filter(Boolean);
}

function pickResearchingWord(seed?: string): string {
    const words = researchingWordsList();
    if (words.length === 0) return t("verdictResearching");
    const pick = () => words[Math.floor(Math.random() * words.length)];
    if (!seed) return pick();
    const cached = researchingWordCache.get(seed);
    if (cached !== undefined && words.includes(cached)) return cached;
    const word = pick();
    researchingWordCache.set(seed, word);
    return word;
}

function verdictLabel(probability: number | undefined, veracity?: number, seed?: string): string {
    if (probability === undefined) return pickResearchingWord(seed);
    if (probability < 0.2) return t("verdictUnknown");

    const trueLabel = t("verdictTrue");
    const falseLabel = t("verdictFalse");

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

    let probKey: string | null = null;
    if (probability >= 0.9) probKey = null;
    else if (probability >= 0.8) probKey = "VeryLikely";
    else if (probability >= 0.5) probKey = "Likely";
    else probKey = "Possibly";

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
    return probKey === "VeryLikely"
        ? t("badgeAdjVerdictAdj2Verbose", [t("adj" + verKey), verdict, t("adj" + probKey)])
        : t("badgeAdjVerdictAdj2", [t("adj" + verKey), verdict, t("adj" + probKey)]);
}

function factCheckColor(probability: number | undefined, veracity?: number, bgOpacity = 0.15): string {
    if (probability === undefined || veracity === undefined || probability === null || veracity === null || probability < 0.2)
        return `background: rgba(128, 128, 128, ${bgOpacity}); color: rgb(128, 128, 128)`;

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

    return `background: rgba(${fr}, ${fg}, ${fb}, ${bgOpacity}); color: rgb(${fr}, ${fg}, ${fb})`;
}

function confidenceRgba(probability: number | undefined, opacity: number, veracity?: number): string {
    if (probability === undefined || veracity === undefined || probability === null || veracity === null || probability < 0.2)
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
            const label = isOnHold ? "Fact-Check" : verdictLabel(claim.confidence, claim.veracity, `${c.id}:${claim.text}`);
            const reasoning = isOnHold
                ? (claim.cachedNote ?? tapify("Click to re-check this claim"))
                : extractReasoning(claim.note, claim.confidence, claim.veracity);
            return `
            <div style="margin-bottom: 8px; line-height: 1.4;">
                <div style="font-size: 13px; color: inherit; margin-bottom: 3px;">${claim.rewritten ?? claim.text}</div>
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
    min-width: 280px;
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
.mf-popover.mf-popover-preview.mf-popover-visible.mf-popover-opaque {
    opacity: 1 !important;
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

/* ── Balance notifications ──
   Top-right on wide screens, top-centered on narrow (mobile) ones. z-index sits
   above popovers (z:1) but below the Fact-Checked / Go-Back buttons (z:9999). */
.mf-notif-container {
    position: fixed;
    top: 12px;
    right: 12px;
    left: auto;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 8px;
    z-index: 9998;
    pointer-events: none;
    max-width: min(360px, 90vw);
}
@media (max-width: 600px) {
    .mf-notif-container {
        left: 12px;
        right: 12px;
        align-items: center;
        max-width: none;
    }
}
.mf-notif {
    pointer-events: auto;
    padding: 10px 14px;
    border-radius: 12px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 13px;
    font-weight: 700;
    line-height: 1.35;
    max-width: 100%;
    white-space: pre-wrap;
    word-break: break-word;
    box-shadow: 0 6px 20px rgba(0,0,0,0.35);
    transition: opacity 0.25s ease, transform 0.25s ease;
    opacity: 0;
    transform: translateY(-6px);
}
.mf-notif.mf-notif-visible { opacity: 1; transform: translateY(0); }

/* ── Onboarding "charge-balance" popovers ──
   Reuse the popover look but sit above claim popovers (z:1) and below notifications
   (z:9998). Always fully opaque and persistent (unless mirroring a preview popover). */
.mf-onboard {
    z-index: 9997;
    opacity: 1;
    min-width: 0;
    max-width: 210px;
    /* Compact: tight padding, just enough room on the right for the × close. */
    padding: 5px 22px 5px 8px;
    font-size: 11.5px;
    line-height: 1.3;
    border-radius: 8px;
}
.mf-onboard .mf-popover-reasoning { font-size: 11.5px; padding-right: 0; }
/* Inline button icon embedded in the onboarding text (refresh / translate). */
.mf-onboard-btn-icon { display: inline-flex; vertical-align: -2px; margin: 0 1px; }
.mf-onboard-btn-icon svg { width: 13px; height: 13px; }
.mf-onboard-btn-label { font-weight: 700; white-space: nowrap; }
.mf-onboard .mf-popover-close { top: 3px; right: 6px; }
/* Attached onboarding popovers (translate / refresh) sit just below a claim popover
   and share its opacity (mirrored in JS), with a smooth fade. */
.mf-onboard-attached { transition: opacity 180ms ease; }
`;
}

function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    const style = document.createElement("style");
    style.textContent = getInlineStyles();
    document.head.appendChild(style);
    new InputModeManager();
}

// ── Balance / error notifications ────────────────────────────────────────────

/** Notification colors, matching the highlight extremes and center: green (most
 *  true), yellow/orange (center), red (most false) — derived from confidenceRgba. */
function notifColor(kind: 'increase' | 'decrease' | 'error'): { bg: string; fg: string } {
    if (kind === 'increase') return { bg: confidenceRgba(1, 0.96, 1), fg: '#000' };
    if (kind === 'decrease') return { bg: confidenceRgba(1, 0.96, 0), fg: '#000' };
    return { bg: confidenceRgba(1, 0.96, -1), fg: '#fff' };
}

function getNotifContainer(): HTMLElement {
    let c = document.querySelector<HTMLElement>('.mf-notif-container');
    if (!c) {
        injectStyles();
        c = document.createElement('div');
        c.className = 'mf-notif-container';
        document.body.appendChild(c);
    }
    return c;
}

/** Format a signed USD delta, e.g. "+US$5" / "-US$0.0013", with the locale separator. */
/** Returns HTML for a signed USD amount with a small, vertically-centered "US" (mirrors
 *  the dashboard's Usd component). Values are numeric/controlled — safe for innerHTML. */
function formatSignedUsd(amount: number, sign: '+' | '-'): string {
    // Mirror the balance's formatUsdNumber rule exactly (popup/i18n.ts): round to 4dp,
    // trim trailing zeros, then 0 decimals → integer; exactly 1 → pad to 2; 2+ → as-is.
    const rounded = Math.round((Math.abs(amount) + Number.EPSILON) * 10000) / 10000;
    const trimmed = rounded.toFixed(4).replace(/0+$/, '');
    const dot = trimmed.indexOf('.');
    const decimals = dot === -1 ? 0 : trimmed.length - dot - 1;
    const frac = decimals === 0 ? 0 : decimals === 1 ? 2 : decimals;
    const n = new Intl.NumberFormat(getEffectiveUILocale(), { minimumFractionDigits: frac, maximumFractionDigits: frac }).format(rounded);
    return `<span style="display:inline-flex;align-items:center;line-height:1;">`
        + `${sign}`
        + `<span style="font-size:0.6em;font-weight:600;line-height:1;margin:0 0.5px 0 1px;">US</span>`
        + `<span style="font-weight:600;line-height:1;">$</span>`
        + `${n}`
        + `</span>`;
}

/** Show a balance-change (green ↑ / orange ↓) or error (red) notification. Auto-dismisses after 5s. */
export function showNotification(kind: 'increase' | 'decrease' | 'error', opts: { amount?: number; text?: string }) {
    if (extensionFrozen) return;
    if (!document.body) return;
    const container = getNotifContainer();
    const el = document.createElement('div');
    el.className = 'mf-notif';
    const { bg, fg } = notifColor(kind);
    el.style.backgroundColor = bg;
    el.style.color = fg;
    if (kind === 'error') {
        if (!opts.text) return;
        el.textContent = opts.text;
    } else {
        el.innerHTML = formatSignedUsd(opts.amount ?? 0, kind === 'increase' ? '+' : '-');
    }
    container.appendChild(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('mf-notif-visible')));
    setTimeout(() => {
        el.classList.remove('mf-notif-visible');
        setTimeout(() => { el.remove(); if (container.childElementCount === 0) container.remove(); }, 300);
    }, 5000);
}

// ── Onboarding "charge-balance" popovers ─────────────────────────────────────
// Persistent popovers next to every charge button whose type the user has never
// clicked, warning that using it spends balance. An "×" dismisses them all
// permanently; clicking a charge button marks its type done. z-index sits above
// claim popovers (z:1) but below notifications (z:9998).

const ONBOARD_DISMISS_KEY = 'mf_onboarding_dismissed';
const ONBOARD_CLICKED_KEY = 'mf_onboarding_clicked_types';
/** Types anchored directly next to a single per-tweet button. */
const STANDALONE_CHARGE_TYPES = new Set(['disinfact', 'factcheckall', 'translate-tweet']);
let onboardingDismissed = false;
const onboardingClickedTypes = new Set<string>();
/** Maps a charge-button anchor to its onboarding popover. */
const onboardingByAnchor = new WeakMap<HTMLElement, HTMLElement>();

function persistOnboardingClicked() {
    try { chrome.storage.local.set({ [ONBOARD_CLICKED_KEY]: Array.from(onboardingClickedTypes) }); } catch { /* ignore */ }
}
function markOnboardingClicked(type: string) {
    if (!type || onboardingClickedTypes.has(type)) return;
    onboardingClickedTypes.add(type);
    persistOnboardingClicked();
    refreshOnboarding();
}
function dismissAllOnboarding() {
    onboardingDismissed = true;
    try { chrome.storage.local.set({ [ONBOARD_DISMISS_KEY]: true }); } catch { /* ignore */ }
    for (const el of Array.from(document.querySelectorAll('.mf-onboard'))) el.remove();
}
function onboardingActive(type: string): boolean {
    return !onboardingDismissed && !onboardingClickedTypes.has(type);
}
/** On touch devices, present click-oriented copy as tap-oriented. Reuses the same
 *  `is-touch-active` signal that sizes the buttons. English-only best-effort: localized
 *  strings that don't contain the word "click" pass through unchanged. */
function tapify(msg: string): string {
    if (!document.documentElement.classList.contains('is-touch-active')) return msg;
    return msg
        .replace(/Clicking/g, 'Tapping').replace(/clicking/g, 'tapping')
        .replace(/Click/g, 'Tap').replace(/click/g, 'tap');
}

function onboardingMessage(type: string): string {
    let msg: string;
    if (type === 'disinfact') {
        // Keep the properly-localized Tap variant for this one; tapify() is the fallback
        // that also covers the other messages, which have no dedicated Tap key.
        const tap = document.documentElement.classList.contains('is-touch-active');
        msg = tap ? t('onboardDisinfactTap') : t('onboardDisinfactClick');
    } else if (type === 'factcheck') msg = t('onboardFactcheck');
    else if (type === 'translate-inner') msg = t('onboardTranslations');
    else if (type === 'refresh-inner') msg = t('onboardRefreshes');
    else msg = t('onboardWillCharge'); // factcheckall, translate-tweet
    return tapify(msg);
}
// Inline icons embedded in the onboarding text for the icon-only buttons.
const onboardRefreshIconSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>`;
const onboardTranslateIconSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10z"></path></svg>`;

/** The button an onboarding popover refers to: a text label (rendered quoted + bold)
 *  or an inline icon (for the icon-only refresh/translate buttons). Keeps the popover
 *  text explicit about exactly which control charges the balance. */
function onboardingButtonRef(type: string): { label?: string; icon?: string } {
    switch (type) {
        case 'disinfact': return { label: t('disinfactButton') };
        case 'factcheckall': return { label: t('factCheckAllButton') };
        case 'translate-tweet': return { label: t('disinfactButton') };
        case 'factcheck': return { label: 'Fact-Check' };
        case 'translate-inner': return { icon: onboardTranslateIconSvg };
        case 'refresh-inner': return { icon: onboardRefreshIconSvg };
        default: return { label: 'Fact-Check' };
    }
}

function buildOnboardingPopover(type: string): HTMLElement {
    // Guarantee the .mf-popover / .mf-onboard styles exist: onboarding popovers can show
    // on an on-hold tweet before any claim renders (upgradeToSegments, the other caller
    // of injectStyles, hasn't run yet), which would otherwise leave the popover as bare
    // unstyled text. Idempotent.
    injectStyles();
    const el = document.createElement('div');
    el.className = 'mf-popover mf-onboard';
    el.dataset.mfOnboard = type;
    const isRTLP = isRTLLocale(getEffectiveUILocale());
    if (isRTLP) el.dir = 'rtl';
    ['click', 'mousedown', 'pointerdown', 'touchstart'].forEach(ev =>
        el.addEventListener(ev, (e) => e.stopPropagation()));
    const text = document.createElement('div');
    text.className = 'mf-popover-reasoning';
    // Insert the referenced button — a quoted label or an inline icon — where the
    // message has its %BTN% placeholder, so the popover names exactly what it charges
    // for. Locales not yet re-translated (no %BTN%) simply show their plain text.
    const template = onboardingMessage(type);
    const ref = onboardingButtonRef(type);
    const parts = template.split('%BTN%');
    text.appendChild(document.createTextNode(parts[0] ?? ''));
    if (parts.length > 1) {
        if (ref.icon) {
            const ic = document.createElement('span');
            ic.className = 'mf-onboard-btn-icon';
            ic.innerHTML = ref.icon;
            text.appendChild(ic);
        } else if (ref.label) {
            const lb = document.createElement('span');
            lb.className = 'mf-onboard-btn-label';
            lb.textContent = `“${ref.label}”`;
            text.appendChild(lb);
        }
        text.appendChild(document.createTextNode(parts.slice(1).join('%BTN%')));
    }
    el.appendChild(text);
    const close = document.createElement('span');
    close.className = 'mf-popover-close';
    close.textContent = '×';
    if (isRTLP) { close.style.right = 'auto'; close.style.left = '10px'; }
    close.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); dismissAllOnboarding(); });
    el.appendChild(close);
    return el;
}
/** Ensure a standalone onboarding popover is attached next to `anchor` and positioned. */
function ensureStandaloneOnboarding(anchor: HTMLElement, type: string) {
    let pop = onboardingByAnchor.get(anchor);
    if (!pop || !pop.isConnected) {
        pop = buildOnboardingPopover(type);
        // Appended to body so position:fixed resolves against the viewport (X's timeline
        // containers use transforms, which would otherwise capture a fixed element).
        document.body.appendChild(pop);
        onboardingByAnchor.set(anchor, pop);
    }
    positionOnboardingPopover(pop, anchor);
}
/** Re-evaluate all standalone onboarding popovers (called on injection + scroll). */
function refreshStandaloneOnboarding() {
    const wanted = new Set<HTMLElement>();
    for (const anchor of Array.from(document.querySelectorAll<HTMLElement>('[data-mf-charge]'))) {
        const type = anchor.dataset.mfCharge ?? '';
        if (!STANDALONE_CHARGE_TYPES.has(type)) continue; // factcheck + in-popover handled separately
        if (!onboardingActive(type)) continue;
        if (!anchor.isConnected || anchor.offsetParent === null) continue; // hidden
        ensureStandaloneOnboarding(anchor, type);
        const p = onboardingByAnchor.get(anchor);
        if (p) wanted.add(p);
    }
    // Drop standalone popovers whose anchor is gone / type now clicked.
    for (const pop of Array.from(document.querySelectorAll<HTMLElement>('.mf-onboard'))) {
        const type = pop.dataset.mfOnboard ?? '';
        if (!STANDALONE_CHARGE_TYPES.has(type)) continue;
        if (!wanted.has(pop)) pop.remove();
    }
}

/** One "Fact-checking a claim will charge your balance" popover per tweet, attached
 *  to the first claim (DOM order) currently showing a Fact-Check button. Re-anchors
 *  dynamically as claims stream in and their buttons appear/disappear. */
const factcheckByArticle = new WeakMap<Element, HTMLElement>();
function refreshFactcheckOnboarding() {
    // A claim highlight shows a Fact-Check button when it's on hold (reclassifyOnHold)
    // or is a pipeline claim with a permanent badge, and hasn't been clicked yet.
    const firstByArticle = new Map<Element, HTMLElement>();
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('.mf-segment-claim'))) {
        const isFactcheck = el.dataset.reclassifyOnHold === 'true' || !!(el as any)._mfBadgePermanent;
        if (isFactcheck && el.isConnected) {
            el.dataset.mfCharge = 'factcheck'; // so clicking it marks the type done
            const article = el.closest('article');
            if (article && !firstByArticle.has(article)) firstByArticle.set(article, el);
        } else if (el.dataset.mfCharge === 'factcheck') {
            delete el.dataset.mfCharge;
        }
    }

    if (!onboardingActive('factcheck')) {
        for (const pop of Array.from(document.querySelectorAll('.mf-onboard[data-mf-onboard="factcheck"]'))) pop.remove();
        return;
    }

    const wanted = new Set<HTMLElement>();
    for (const [article, anchor] of firstByArticle) {
        let pop = factcheckByArticle.get(article);
        if (!pop || !pop.isConnected) {
            pop = buildOnboardingPopover('factcheck');
            document.body.appendChild(pop);
            factcheckByArticle.set(article, pop);
        }
        positionOnboardingPopover(pop, anchor);
        wanted.add(pop);
    }
    // Remove the fact-check popover from any tweet that no longer has a Fact-Check button.
    for (const pop of Array.from(document.querySelectorAll<HTMLElement>('.mf-onboard[data-mf-onboard="factcheck"]'))) {
        if (!wanted.has(pop)) pop.remove();
    }
}

/** External onboarding popovers attached NEXT TO a claim-reasoning popover (translate /
 *  refresh). They are separate elements positioned just below the popover, but behave as
 *  an extension of it: hovering one keeps the preview alive (see the handlers here and
 *  isHoveringPreviewRelated), their opacity mirrors it (setPreviewPopoverOpacity), and
 *  they are dismissed together (dismissPreviewPopover / closePopover). */
function buildAttachedOnboardingPopover(type: string, claimPop: HTMLElement): HTMLElement {
    const op = buildOnboardingPopover(type);
    op.classList.add('mf-onboard-attached');
    (op as any)._mfClaimPop = claimPop;
    op.addEventListener('mouseenter', () => {
        if (previewPopoverState && previewPopoverState.popover === claimPop) {
            setPreviewPopoverOpacity(1);
            if (previewPopoverState.leaveTimer) { clearTimeout(previewPopoverState.leaveTimer); previewPopoverState.leaveTimer = null; }
        }
    });
    op.addEventListener('mouseleave', () => {
        if (previewPopoverState && previewPopoverState.popover === claimPop) {
            setPreviewPopoverOpacity(PREVIEW_BASE_OPACITY);
            schedulePreviewPopoverDismiss(previewPopoverState.trigger);
        }
    });
    return op;
}

function refreshInPopoverOnboarding() {
    // Drop attached popovers whose claim popover is gone.
    for (const op of Array.from(document.querySelectorAll<HTMLElement>('.mf-onboard-attached'))) {
        const cp = (op as any)._mfClaimPop as HTMLElement | undefined;
        if (!cp || !cp.isConnected) op.remove();
    }

    for (const claimPop of Array.from(document.querySelectorAll<HTMLElement>('.mf-popover'))) {
        if (claimPop.classList.contains('mf-onboard')) continue;
        // Tag translate buttons so clicking one marks the type done (via the delegated listener).
        for (const b of Array.from(claimPop.querySelectorAll<HTMLElement>('.mf-translate-btn'))) {
            if (!b.dataset.mfCharge) b.dataset.mfCharge = 'translate-inner';
        }
        const wants: string[] = [];
        if (claimPop.querySelector('.mf-translate-btn') && onboardingActive('translate-inner')) wants.push('translate-inner');
        if (claimPop.querySelector('[data-mf-charge="refresh-inner"]') && onboardingActive('refresh-inner')) wants.push('refresh-inner');

        const isPreview = previewPopoverState?.popover === claimPop;
        const container = claimPop.offsetParent instanceof HTMLElement ? claimPop.offsetParent : getTimelineContainer(claimPop);

        const existing = new Map<string, HTMLElement>();
        for (const op of Array.from(document.querySelectorAll<HTMLElement>('.mf-onboard-attached'))) {
            if ((op as any)._mfClaimPop === claimPop) existing.set(op.dataset.mfOnboard ?? '', op);
        }
        for (const [type, op] of Array.from(existing)) {
            if (!wants.includes(type)) { op.remove(); existing.delete(type); }
        }
        const ordered: HTMLElement[] = [];
        for (const type of ['translate-inner', 'refresh-inner']) { // translations above refreshes
            if (!wants.includes(type)) continue;
            let op = existing.get(type);
            if (!op) { op = buildAttachedOnboardingPopover(type, claimPop); container.appendChild(op); }
            ordered.push(op);
        }
        // Position stacked directly below the claim popover, matching its width.
        let top = claimPop.offsetTop + claimPop.offsetHeight + 8;
        const left = claimPop.offsetLeft;
        const width = claimPop.offsetWidth;
        for (const op of ordered) {
            op.style.left = `${left}px`;
            op.style.top = `${top}px`;
            op.style.width = `${width}px`;
            op.style.maxWidth = `${width}px`;
            op.style.opacity = isPreview && previewPopoverState?.semiTransparent ? String(PREVIEW_BASE_OPACITY) : '1';
            top += op.offsetHeight + 8;
        }
        if (isPreview && previewPopoverState) previewPopoverState.onboardPopovers = ordered;
    }
}

function refreshOnboarding() {
    if (extensionFrozen) return;
    if (onboardingDismissed) {
        for (const pop of Array.from(document.querySelectorAll('.mf-onboard'))) pop.remove();
        return;
    }
    refreshStandaloneOnboarding();
    refreshFactcheckOnboarding();
    refreshInPopoverOnboarding();
}

// Load persisted onboarding state, then evaluate.
try {
    chrome.storage.local.get([ONBOARD_DISMISS_KEY, ONBOARD_CLICKED_KEY], (res: any) => {
        if (!chrome.runtime.lastError && res) {
            onboardingDismissed = res[ONBOARD_DISMISS_KEY] === true;
            if (Array.isArray(res[ONBOARD_CLICKED_KEY])) for (const x of res[ONBOARD_CLICKED_KEY]) onboardingClickedTypes.add(String(x));
        }
        refreshOnboarding();
    });
} catch { /* ignore */ }

// Debug/testing: react live when the onboarding state is reset from the EXTENSION
// side, so every popover reappears without a page reload — as if no button had ever
// been clicked or dismissed. Reset from the extension's service-worker console with:
//   chrome.storage.local.remove(['mf_onboarding_dismissed', 'mf_onboarding_clicked_types'])
// (Extension storage, so the host page can't touch it — same as the mfLocale hook.)
try {
    chrome.storage.onChanged.addListener((changes: any, area: string) => {
        if (area !== 'local') return;
        if (!(ONBOARD_DISMISS_KEY in changes) && !(ONBOARD_CLICKED_KEY in changes)) return;
        if (ONBOARD_DISMISS_KEY in changes) onboardingDismissed = changes[ONBOARD_DISMISS_KEY].newValue === true;
        if (ONBOARD_CLICKED_KEY in changes) {
            onboardingClickedTypes.clear();
            const v = changes[ONBOARD_CLICKED_KEY].newValue;
            if (Array.isArray(v)) for (const x of v) onboardingClickedTypes.add(String(x));
        }
        refreshOnboarding();
    });
} catch { /* ignore */ }

// Mark a type done when its button is clicked (capture so it runs before X's handlers).
document.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement)?.closest?.('[data-mf-charge]') as HTMLElement | null;
    if (el?.dataset.mfCharge) markOnboardingClicked(el.dataset.mfCharge);
}, true);

// Reposition on scroll (the popover shares the timeline container so it scrolls with
// its button, but re-render/layout shifts still need a nudge).
let onboardScrollRaf = 0;
window.addEventListener('scroll', () => {
    if (onboardScrollRaf) return;
    onboardScrollRaf = requestAnimationFrame(() => { onboardScrollRaf = 0; refreshOnboarding(); });
}, { capture: true, passive: true });

function findTweetTextElement(article: Element, isQuoted: boolean = false, tweetId?: string): Element | null {
    if (tweetId) {
        const link = article.querySelector(`a[href*="/status/${tweetId}"]`);
        if (link) {
            const container = link.closest('div[role="link"], div[data-testid="card.wrapper"], article, div[dir="auto"]');
            if (container) {
                const textEl = container.querySelector('[data-testid="tweetText"]');
                if (textEl) return textEl;
            }
        }
    }
    if (isQuoted) {
        const quotedArticle = article.querySelector('article');
        if (quotedArticle) {
            const el = quotedArticle.querySelector('[data-testid="tweetText"]');
            if (el) return el;
        }
        const allTexts = article.querySelectorAll('[data-testid="tweetText"]');
        if (allTexts.length >= 2) {
            return allTexts[allTexts.length - 1];
        }
        return null;
    }
    const el = article.querySelector('[data-testid="tweetText"]');
    if (el) return el;
    if (article.parentElement?.closest('article')) {
        const candidate = article.querySelector('div[dir="auto"], span[dir="auto"]');
        if (candidate && (candidate.textContent?.trim()?.length ?? 0) > 10) {
            return candidate;
        }
    }
    return null;
}

function renderSegmentedTweet(tweetTextEl: Element, segments: TextSegment[], claims: Claim[], batchId: string, classificationId?: string) {
    const urlDisplayMap = new Map<string, string>();
    const existingLinks = tweetTextEl.querySelectorAll('a');
    for (const link of existingLinks) {
        const href = link.getAttribute('href');
        const text = link.textContent?.trim();
        if (href && text && href !== text) {
            urlDisplayMap.set(href, text);
        }
    }

    const wrap = buildSegmentWrap(segments, claims, batchId, urlDisplayMap, classificationId);
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
function buildSegmentWrap(segments: TextSegment[], claims: Claim[], batchId: string, urlDisplayMap: Map<string, string> = new Map(), classificationId?: string): HTMLSpanElement {
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

            const label = verdictLabel(claim.confidence, claim.veracity, `${classificationId ?? ''}:${claim.text}`);
            const reasoning = extractReasoning(claim.note, claim.confidence, claim.veracity);
            const isOnHold = claim.reclassifyOnHold;
            const isResearching = claim.verdict === "research required" || claim.refreshing || claim.confidence === undefined || claim.veracity === undefined || claim.confidence === null || claim.veracity === null || claim.confidence < 0.2;
            // On-hold ("Fact-Check") = black/white tint; researching/no-verdict = gray;
            // else the verdict color (kept during refresh so it doesn't flash grey).
            const bgColor = highlightBgColor(claim, false);
            const hoverBgColor = highlightBgColor(claim, true);

            const span = document.createElement("span");
            span.className = "mf-segment-claim";
            span.dataset.claimIndex = String(seg.claimIndex);
            span.dataset.mfAnimKey = `${classificationId ?? ''}:${seg.claimIndex}`;
            // Carry the claim's OWN tweet/classification id so claim-level actions
            // (reclassify, translate) target the right classification instead of
            // scraping the first /status/ link in the article — which is wrong for
            // quoted tweets (returns the outer tweet) and detail view (returns an
            // embedded/thread link), the two cases where the money-path click failed.
            if (classificationId) span.dataset.mfCid = classificationId;
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

            const isRTL = isRTLLocale(getEffectiveUILocale());
            if (isRTL) span.dir = "rtl";

            animateHighlightReveal(span, bgColor);

            const createInlineBadge = (permanent: boolean): HTMLElement => {
                // Derive ALL state from the live dataset, never the render-time closure.
                // The span is updated in place (upgradeToSegments update path) as the
                // claim progresses, so closure values (isResearching/isOnHold/claim)
                // go stale — using them would revive a "Fact-Check" badge on a claim
                // that has since been classified.
                const pVal = parseFloat(span.dataset.probability ?? "");
                const prob = isNaN(pVal) ? undefined : pVal;
                const vVal = parseFloat(span.dataset.veracity ?? "");
                const ver = isNaN(vVal) ? undefined : vVal;
                const isRefreshing = span.dataset.refreshing === "true";
                const isOnHoldNow = span.dataset.reclassifyOnHold === "true";
                const inPipeline = classificationId ? processingOnHoldIds.has(classificationId) : false;
                const isResearchingNow = isRefreshing || prob === undefined || ver === undefined || prob < 0.2;
                const isPipelineClaim = inPipeline && isResearchingNow && !isOnHoldNow && !isRefreshing;
                const lbl = (isOnHoldNow || isPipelineClaim) ? "Fact-Check" : verdictLabel(prob, ver, `${classificationId ?? ''}:${claim.text}`);
                const txtColor = (isOnHoldNow || isPipelineClaim)
                  ? 'rgb(180, 180, 180)'
                  : confidenceRgba(prob, 1, ver);
                const badge = document.createElement("span");
                badge.className = "mf-inline-badge";
                badge.style.cssText = `display: inline-flex; align-items: center; border-radius: 999px; font-size: 11px; font-weight: 600; white-space: nowrap; margin-left: ${isRTL ? '0' : '3px'}; margin-right: ${isRTL ? '3px' : '0'}; color: ${txtColor}; background: rgba(0,0,0,0.7); cursor: pointer;`;
                if (isRefreshing || (prob === undefined && !isOnHoldNow && !isPipelineClaim)) {
                    const fcSpinner = document.createElement("span");
                    fcSpinner.className = "mf-fc-spinner";
                    if (isRTL) {
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

            const isInPipeline = classificationId ? processingOnHoldIds.has(classificationId) : false;
            const showPermanentBadge = isOnHold || (isInPipeline && isResearching && !claim.refreshing);

            if (showPermanentBadge) {
                span.appendChild(createInlineBadge(true));
            }

            span.addEventListener("mouseenter", () => {
                if (span.querySelector(".mf-inline-badge")) return;
                if (span.dataset.hoverBg) {
                    span.style.backgroundColor = span.dataset.hoverBg;
                }
                // A permanent badge only for a claim that is still on hold in the live
                // dataset; a classified claim gets a transient hover-only badge.
                span.appendChild(createInlineBadge(span.dataset.reclassifyOnHold === "true"));
            });

            span.addEventListener("mouseleave", () => {
                if ((span as any)._mfPopoverOpen) return;
                if ((span as any)._mfBadgePermanent) return;
                const pVal = parseFloat(span.dataset.probability ?? "");
                const prob = isNaN(pVal) ? undefined : pVal;
                const vVal = parseFloat(span.dataset.veracity ?? "");
                const ver = isNaN(vVal) ? undefined : vVal;
                // Keep a valid verdict's color even while reclassifying (refreshing);
                // grey only when there's no valid verdict.
                const noVerdict = prob === undefined || ver === undefined || prob < 0.2;
                const baseBg = noVerdict ? 'rgba(128, 128, 128, 0.25)' : confidenceRgba(prob, 0.25, ver);
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

    const tweetTextEl = findTweetTextElement(article, isQuoted, classification.id);
    if (!tweetTextEl) {
        console.log(`[misinfo] upgradeToSegments: no tweetTextEl found for ${classification.id} (isQuoted=${isQuoted})`);
        return;
    }

    const existingWrap = tweetTextEl.querySelector(".mf-segment-wrap");
    if (existingWrap) {
        const existingClaimSpans = existingWrap.querySelectorAll(".mf-segment-claim");
        const newHasClaims = segments.some(s => s.claimIndex !== null);

        if (existingClaimSpans.length === 0 && newHasClaims) {
            console.log(`[misinfo] upgradeToSegments: existing wrap is plain text but new segments have claims for ${classification.id}, re-rendering`);
            existingWrap.remove();
        } else {
            let updated = 0;
            for (const span of existingClaimSpans) {
                const idx = parseInt((span as HTMLElement).dataset.claimIndex ?? "", 10);
                if (isNaN(idx) || !claims[idx]) continue;
                const claim = claims[idx];
                const label = verdictLabel(claim.confidence, claim.veracity, `${classification.id}:${claim.text}`);
                const reasoning = extractReasoning(claim.note, claim.confidence, claim.veracity);
                const isResearching = claim.verdict === "research required" || claim.refreshing || claim.confidence === undefined || claim.veracity === undefined || claim.confidence === null || claim.veracity === null || claim.confidence < 0.2;
                // Highlight color: keep a claim's classification color even while it is
                // being reclassified (refreshing) as long as it still carries a valid
                // verdict — so a reclassifying claim shows its soon-to-be-replaced color
                // instead of going grey. Grey only when on hold or with no valid verdict.
                const bgColor = highlightBgColor(claim, false);
                const hoverBgColor = highlightBgColor(claim, true);
                const el = span as HTMLElement;
                el.dataset.mfCid = classification.id;
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
                    if ((el as any)._mfBadgePermanent) {
                        delete (el as any)._mfBadgePermanent;
                        el.querySelector(".mf-inline-badge")?.remove();
                    }
                }
                // When a pipeline claim transitions from researching to classified,
                // clear the permanent badge marker and remove the stale badge element.
                if (!isResearching && !claim.reclassifyOnHold && (el as any)._mfBadgePermanent) {
                    delete (el as any)._mfBadgePermanent;
                    el.querySelector(".mf-inline-badge")?.remove();
                }
                el.style.opacity = "";

                const targetBg = bgColor;
                const prevTargetBg = (el as any)._mfTargetBg;
                if (prevTargetBg === undefined) {
                    // Not yet initialized (defensive) — set directly and record it.
                    el.style.backgroundColor = targetBg;
                    (el as any)._mfTargetBg = targetBg;
                } else if (prevTargetBg !== targetBg) {
                    // The classification color genuinely changed → smooth color
                    // transition (or a wipe for a brand-new span, via the WeakSet).
                    animateHighlightReveal(el, targetBg);
                }
                // else: same intended color — leave the element untouched so an
                // in-progress reveal wipe isn't aborted/restarted by rapid re-injections.

                const isRTLEl = isRTLLocale(getEffectiveUILocale());
                if (isRTLEl) el.dir = "rtl";

                const inPipeline = processingOnHoldIds.has(classification.id);
                const isPipelineResearching = inPipeline && isResearching && !claim.reclassifyOnHold && !claim.refreshing;
                if ((claim.reclassifyOnHold || isPipelineResearching) && !el.querySelector(".mf-inline-badge")) {
                    const badge = document.createElement("span");
                    badge.className = "mf-inline-badge";
                    badge.style.cssText = `display: inline-flex; align-items: center; border-radius: 999px; font-size: 11px; font-weight: 600; white-space: nowrap; margin-left: ${isRTLEl ? '0' : '3px'}; margin-right: ${isRTLEl ? '3px' : '0'}; color: rgb(180, 180, 180); background: rgba(0,0,0,0.7); cursor: pointer;`;
                    badge.textContent = "Fact-Check";
                    el.appendChild(badge);
                    (el as any)._mfBadgePermanent = badge;
                }

                if (changed) {
                    updated++;
                    const badge = el.querySelector(".mf-inline-badge");
                    if (badge) {
                        const isOnHold = el.dataset.reclassifyOnHold === "true";
                        const isRefreshingNow = el.dataset.refreshing === "true";
                        const pipelineResearching = inPipeline && isResearching && !isOnHold && !claim.refreshing;
                        const newLabel = (isOnHold || pipelineResearching) ? "Fact-Check" : verdictLabel(claim.confidence, claim.veracity, `${classification.id}:${claim.text}`);
                        const newColor = (isOnHold || pipelineResearching)
                            ? 'rgb(180, 180, 180)'
                            : confidenceRgba(claim.confidence, 1, claim.veracity);
                        (badge as HTMLElement).style.color = newColor;
                        (badge as HTMLElement).style.marginLeft = isRTLEl ? '0' : '3px';
                        (badge as HTMLElement).style.marginRight = isRTLEl ? '3px' : '0';
                        badge.innerHTML = '';
                        if (isRefreshingNow || (claim.confidence === undefined && !isOnHold && !pipelineResearching)) {
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

                // If this span's state changed while the pointer is resting on it (e.g. a
                // verdict landing right after the user clicked Fact-Check, with the mouse
                // never moving), replay the hover so the badge/preview appear immediately
                // instead of waiting for a manual mouse-out/in.
                if (changed) resyncHoverAtPointer(el);
            }
            console.log(`[misinfo] upgradeToSegments: updated ${updated}/${existingClaimSpans.length} claim spans for ${classification.id}`);
            updateOpenPopover();
            return;
        }
    }

    console.log(`[misinfo] upgradeToSegments: upgrading ${classification.id} with ${segments.length} segments`);
    injectStyles();
    renderSegmentedTweet(tweetTextEl, segments, claims, batchId, classification.id);

    const fallbackDiv = article.querySelector(`[classification-id="${classification.id}"]`);
    if (fallbackDiv) fallbackDiv.remove();

    if (!isQuoted && (classification as Classification).quoting) {
        const quoting = (classification as Classification).quoting!;
        const quotedArticle = article.querySelector('article');
        if (quotedArticle) {
            const qFallback = quotedArticle.querySelector(`[classification-id="${quoting.id}"]`);
            if (qFallback) qFallback.remove();
        }
    }

    setupArticleHandlers(article);
}

let globalHandlersSetup = false;

function setupGlobalHandlers() {
    if (globalHandlersSetup) return;
    globalHandlersSetup = true;

    document.addEventListener("click", (e) => {
        const popovers = document.querySelectorAll(".mf-popover");
        if (popovers.length === 0) return;
        const target = e.target as HTMLElement;
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

    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closePopover();
    });

    window.addEventListener("resize", () => {
        updateOpenPopover();
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
            if (target.dataset.reclassifyOnHold === "true") return;
            if ((target as any)._mfBadgePermanent) return;
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

    article.addEventListener("click", (e) => {
        const target = closestEl(e.target as Element, ".mf-segment-claim");
        if (!target) return;

        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) return;

        e.stopPropagation();
        cancelHoverPreview();
        dismissPreviewPopover();

        if (target.dataset.reclassifyOnHold === "true") {
          target.dataset.reclassifyOnHold = "";
          target.dataset.verdict = target.dataset.cachedVerdict ?? "";
          // Keep the cached (soon-to-be-replaced) reasoning visible while re-researching;
          // it's replaced once the reclassification's reasoning starts streaming.
          target.dataset.reasoning = target.dataset.cachedNote ?? "";
          target.dataset.probability = target.dataset.cachedConfidence ?? "";
          target.dataset.veracity = target.dataset.cachedVeracity ?? "";
          target.dataset.sources = target.dataset.cachedSources ?? "[]";
          target.dataset.refreshing = "true";
          // If the claim had a prior classification (cached confidence/veracity),
          // instantly show that soon-to-be-replaced color while re-researching,
          // instead of going grey. Fall back to grey only when there's no valid
          // prior verdict.
          const cachedProb = parseFloat(target.dataset.cachedConfidence ?? "");
          const cachedVer = parseFloat(target.dataset.cachedVeracity ?? "");
          const hasCachedVerdict = !isNaN(cachedProb) && !isNaN(cachedVer) && cachedProb >= 0.2;
          target.style.backgroundColor = hasCachedVerdict ? confidenceRgba(cachedProb, 0.25, cachedVer) : 'rgba(128, 128, 128, 0.25)';
          target.dataset.hoverBg = hasCachedVerdict ? confidenceRgba(cachedProb, 0.5, cachedVer) : 'rgba(128, 128, 128, 0.35)';
          const claimIdForSeed = target.dataset.mfCid || (() => {
            // Legacy fallback for spans built before mfCid existed. Unreliable for
            // quoted tweets (outer article link) and detail view; mfCid is preferred.
            const article = target.closest('article');
            if (!article) return null;
            const link = article.querySelector<HTMLAnchorElement>('a[href*="/status/"]');
            if (!link) return null;
            const match = link.href.match(/\/status\/(\d+)/);
            return match ? match[1] : null;
          })();
          const researchingSeed = `${claimIdForSeed ?? ''}:${target.dataset.claimText ?? ''}`;
          const badge = target.querySelector(".mf-inline-badge");
          if (badge) {
            const isRTL = isRTLLocale(getEffectiveUILocale());
            (badge as HTMLElement).style.color = 'rgb(180, 180, 180)';
            (badge as HTMLElement).style.marginLeft = isRTL ? '0' : '3px';
            (badge as HTMLElement).style.marginRight = isRTL ? '3px' : '0';
            badge.innerHTML = '';
            const fcSpinner = document.createElement("span");
            fcSpinner.className = "mf-fc-spinner";
            if (isRTL) {
              fcSpinner.style.marginRight = "0";
              fcSpinner.style.marginLeft = "3px";
              badge.appendChild(document.createTextNode(pickResearchingWord(researchingSeed)));
              badge.appendChild(fcSpinner);
            } else {
              badge.appendChild(fcSpinner);
              badge.appendChild(document.createTextNode(pickResearchingWord(researchingSeed)));
            }
          }
          const classificationId = claimIdForSeed;
          if (classificationId) {
            const ct = target.dataset.claimText;
            individuallyClickedOnHoldClaims.add(`${classificationId}:${ct}`);
            mfBus.dispatchEvent(new CustomEvent('mf-reclassify-on-hold-click', {
              detail: { classificationId, claimText: ct }
            }));
          }
          // The pointer is still on the claim (they just clicked it) but the browser
          // won't re-fire hover for the in-place transition — replay it so the new
          // state reacts immediately, exactly as a manual mouse-out/in would.
          resyncHoverAtPointer(target);
          return;
        }

        // Pipeline claim: permanent badge is visible but reclassifyOnHold is not set
        // (the fetch-claim call hasn't completed yet). Clicking transitions to
        // grey Fact-Checking state and dispatches the background event.
        if ((target as any)._mfBadgePermanent) {
          delete (target as any)._mfBadgePermanent;
          target.dataset.refreshing = "true";
          target.dataset.reasoning = "";
          const claimIdForSeed = target.dataset.mfCid || (() => {
            // Legacy fallback for spans built before mfCid existed. Unreliable for
            // quoted tweets (outer article link) and detail view; mfCid is preferred.
            const article = target.closest('article');
            if (!article) return null;
            const link = article.querySelector<HTMLAnchorElement>('a[href*="/status/"]');
            if (!link) return null;
            const match = link.href.match(/\/status\/(\d+)/);
            return match ? match[1] : null;
          })();
          const researchingSeed = `${claimIdForSeed ?? ''}:${target.dataset.claimText ?? ''}`;
          target.dataset.verdict = pickResearchingWord(researchingSeed);
          target.style.backgroundColor = 'rgba(128, 128, 128, 0.25)';
          target.dataset.hoverBg = 'rgba(128, 128, 128, 0.35)';
          const badge = target.querySelector(".mf-inline-badge") as HTMLElement | null;
          if (badge) {
            const isRTL = isRTLLocale(getEffectiveUILocale());
            badge.style.color = 'rgb(180, 180, 180)';
            badge.style.marginLeft = isRTL ? '0' : '3px';
            badge.style.marginRight = isRTL ? '3px' : '0';
            badge.innerHTML = '';
            const fcSpinner = document.createElement("span");
            fcSpinner.className = "mf-fc-spinner";
            if (isRTL) {
              fcSpinner.style.marginRight = "0";
              fcSpinner.style.marginLeft = "3px";
              badge.appendChild(document.createTextNode(pickResearchingWord(researchingSeed)));
              badge.appendChild(fcSpinner);
            } else {
              badge.appendChild(fcSpinner);
              badge.appendChild(document.createTextNode(pickResearchingWord(researchingSeed)));
            }
          }
          const classificationId = claimIdForSeed;
          if (classificationId) {
            const ct = target.dataset.claimText!;
            individuallyClickedOnHoldClaims.add(`${classificationId}:${ct}`);
            mfBus.dispatchEvent(new CustomEvent('mf-reclassify-on-hold-click', {
              detail: { classificationId, claimText: ct }
            }));
          }
          // Replay the hover under the (still-stationary) pointer so the new
          // Fact-Checking state reacts at once, as a manual mouse-out/in would.
          resyncHoverAtPointer(target);
          return;
        }

        openPinnedPopover(target);
    }, true);
}

/** Find the bottom of the sticky "Post" header bar on X.com so popovers
 *  don't render underneath it. Falls back to searching for any sticky element
 *  in the primary column if the direct-child check fails. Returns 0 if no
 *  header is found. */
function getHeaderBottom(): number {
    const primaryCol = document.querySelector<HTMLElement>('[data-testid="primaryColumn"]');
    if (!primaryCol) return 0;

    // Only trust a candidate that actually looks like the sticky top bar: hugging
    // the top of the viewport and short. The attribute fallbacks below can match
    // unrelated elements — e.g. media overlays inside the first tweet's cell carry
    // inline "top: 0" styles, and at the top of the page their bottom is hundreds
    // of px down, which pinned first-tweet popovers far below their highlight.
    const isHeaderLike = (rect: DOMRect): boolean =>
        rect.top < 5 && rect.bottom > 0 && rect.bottom <= 250;

    for (const child of primaryCol.children) {
        const childEl = child as HTMLElement;
        const pos = getComputedStyle(childEl).position;
        if (pos === 'sticky' || pos === 'fixed') {
            const rect = childEl.getBoundingClientRect();
            if (isHeaderLike(rect)) return rect.bottom;
        }
    }

    const stickyEl = primaryCol.querySelector<HTMLElement>('[style*="sticky"], [style*="fixed"], [style*="top: 0"]');
    if (stickyEl) {
        const rect = stickyEl.getBoundingClientRect();
        if (isHeaderLike(rect)) return rect.bottom;
    }

    return 53;
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

    // Stop click & pointer events inside popovers from propagating to background elements
    ["click", "mousedown", "mouseup", "pointerdown", "pointerup", "touchstart", "touchend"].forEach(eventType => {
        popover.addEventListener(eventType, (e) => {
            e.stopPropagation();
        });
    });

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
        if (e) {
            e.stopPropagation();
            e.preventDefault();
        }
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
        const isResearching = targetTrigger.dataset.refreshing === "true" || prob === undefined || ver === undefined || prob < 0.2;
        targetTrigger.style.backgroundColor = isResearching ? 'rgba(128, 128, 128, 0.25)' : confidenceRgba(prob, 0.25, ver);
        removeAttachedOnboardingFor(popover);
        popover.remove();
        if (previewPopoverState?.popover === popover) previewPopoverState = null;
    };

    closeBtn.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        e.preventDefault();
    });
    closeBtn.addEventListener("click", onClose);

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
        while (popover.childNodes.length > 1) popover.removeChild(popover.lastChild!);
        populatePopoverContent(popover, trigger, reasoning, sources, claimText);
        if (popover.isConnected) {
            positionPopover(popover, trigger);
        }
    };

    return { popover, render };
}

function showPopover(
    trigger: HTMLElement,
    reasoning: string,
    sources: Source[],
    claimText?: string,
) {
    closePopover(trigger);
    window.getSelection()?.removeAllRanges();

    let popover: HTMLElement | null = null;
    try {
        const shell = buildPopoverShell(trigger, false);
        popover = shell.popover;

        const timelineContainer = getTimelineContainer(trigger);
        if (getComputedStyle(timelineContainer).position === "static") {
            timelineContainer.style.position = "relative";
        }
        timelineContainer.appendChild(popover);
        shell.render(reasoning, sources, claimText);
        bringPopoverToFront(popover);

        popover.addEventListener("mousedown", (e) => {
            e.stopPropagation();
            const p = popover;
            if (p && p.parentElement) bringPopoverToFront(p);
        });

        (trigger as any)._mfPopoverOpen = true;
        refreshInPopoverOnboarding();
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
        const isResearching = trigger.dataset.refreshing === "true" || prob === undefined || ver === undefined || prob < 0.2;
        trigger.style.backgroundColor = isResearching ? 'rgba(128, 128, 128, 0.25)' : confidenceRgba(prob, 0.25, ver);
    }
}

function populatePopoverContent(
    popover: HTMLElement,
    trigger: HTMLElement,
    reasoning: string,
    sources: Source[],
    claimText?: string,
) {
    const getRefreshClassificationId = (): string | null => {
        // Prefer the claim span's own tweet id. Scraping the first /status/ link is
        // wrong for quoted tweets (outer id) and detail view (embedded/thread link).
        const live = (popover as any)._mfTrigger as HTMLElement | undefined;
        const cid = (live ?? trigger).dataset.mfCid;
        if (cid) return cid;
        const article = trigger.closest('article');
        if (!article) return null;
        const link = article.querySelector<HTMLAnchorElement>('a[href*="/status/"]');
        if (!link) return null;
        const match = link.href.match(/\/status\/(\d+)/);
        return match ? match[1] : null;
    };

    const hlProb = parseFloat(trigger.dataset.probability ?? "");
    const hlVer = parseFloat(trigger.dataset.veracity ?? "");
    const highlightHover = (!isNaN(hlProb) && !isNaN(hlVer) && hlProb >= 0.2) ? confidenceRgba(hlProb, 0.3, hlVer) : undefined;

    const closeBtn = popover.querySelector(".mf-popover-close") as HTMLElement;

    if (closeBtn && highlightHover) {
        closeBtn.addEventListener("mouseenter", () => {
            closeBtn.style.backgroundColor = highlightHover;
            closeBtn.style.color = "rgba(255,255,255,0.9)";
            closeBtn.style.borderRadius = "3px";
        });
        closeBtn.addEventListener("mouseleave", () => {
            closeBtn.style.backgroundColor = "";
            closeBtn.style.color = "";
        });
    }

    const copyIconSvg = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
    const checkIconSvg = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
    const refreshIconSvg = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>`;
    const batchRefreshIconSvg = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>`;
    const translateIconSvg = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10z"></path></svg>`;

    function appendTextRow(text: string, container: HTMLElement, styleClass: string, extraButtons?: { icon: string, title: string, onClick: () => void }[], preButton?: { icon: string, title: string, label?: string, onClick: () => void }) {
        const row = document.createElement("div");
        row.className = `mf-popover-text-row ${styleClass}`;

        const textSpan = document.createElement("span");
        textSpan.className = "mf-popover-text";
        textSpan.textContent = text;
        row.appendChild(textSpan);

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
            preBtn.addEventListener("mousedown", (e) => {
                e.stopPropagation();
                e.preventDefault();
            });
            preBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                e.preventDefault();
                preButton.onClick();
            });
            if (highlightHover) {
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
        copyBtn.addEventListener("mousedown", (e) => {
            e.stopPropagation();
            e.preventDefault();
        });
        copyBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            e.preventDefault();
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

        if (extraButtons) {
            for (const btn of extraButtons) {
                const button = document.createElement("button");
                button.className = "mf-popover-copy-icon";
                button.innerHTML = btn.icon;
                button.title = btn.title;
                button.addEventListener("mousedown", (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                });
                button.addEventListener("click", (e) => {
                    e.stopPropagation();
                    e.preventDefault();
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

    if (claimText) {
        const batchId = trigger.dataset.batchId;
        const extraBtns = batchId ? [{
            icon: batchRefreshIconSvg,
            title: t("refreshBatchTooltip"),
            onClick: () => {
                closePopover();
                mfBus.dispatchEvent(new CustomEvent('mf-refresh-batch', {
                    detail: { batchId }
                }));
            }
        }] : undefined;

        const claimLocale = trigger.dataset.claimLocale;
        const uiLocale = getEffectiveUILocale();
        let translatePreBtn: { icon: string, title: string, label?: string, onClick: () => void } | undefined;
        if (claimLocale && uiLocale && !sameLanguage(claimLocale, uiLocale)) {
            translatePreBtn = {
                icon: translateIconSvg,
                title: t("translateClaimButton"),
                label: t("translateClaimButton"),
                onClick: () => {
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
                    const liveTrigger = (popover as any)._mfTrigger as HTMLElement | undefined;
                    const targetTrigger = liveTrigger ?? trigger;
                    let classificationId = targetTrigger.dataset.mfCid ?? '';
                    if (!classificationId) {
                        const article = targetTrigger.closest('article');
                        const link = article?.querySelector<HTMLAnchorElement>('a[href*="/status/"]');
                        const match = link?.href.match(/\/status\/(\d+)/);
                        classificationId = match ? match[1] : '';
                    }
                    mfBus.dispatchEvent(new CustomEvent('mf-translate-claim', {
                        detail: { classificationId, claimText: targetTrigger.dataset.claimText ?? targetTrigger.dataset.dbClaimText, translateWhat: "claim" }
                    }));
                }
            };
        }
        appendTextRow(claimText, popover, "mf-popover-claim-text", extraBtns, translatePreBtn);
    }

    const isRefreshing = trigger.dataset.refreshing === "true";
    const hasReasoning = !!reasoning;
    if (hasReasoning || isRefreshing) {
        const reasoningLocale = trigger.dataset.reasoningLocale;
        const uiLocale2 = getEffectiveUILocale();
        let reasoningTranslateBtn: { icon: string, title: string, label?: string, onClick: () => void } | undefined;
        // Not while re-researching: a fresh reasoning written directly in the UI locale is
        // already on its way, so translating the stale one is pointless and would bill the
        // user for text that's about to be replaced.
        if (hasReasoning && !isRefreshing && reasoningLocale && uiLocale2 && !sameLanguage(reasoningLocale, uiLocale2)) {
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
                    const targetTrigger2 = liveTrigger2 ?? trigger;
                    let cId = targetTrigger2.dataset.mfCid ?? '';
                    if (!cId) {
                        const article = targetTrigger2.closest('article');
                        const link = article?.querySelector<HTMLAnchorElement>('a[href*="/status/"]');
                        const match = link?.href.match(/\/status\/(\d+)/);
                        cId = match ? match[1] : '';
                    }
                    mfBus.dispatchEvent(new CustomEvent('mf-translate-claim', {
                        detail: { classificationId: cId, claimText: targetTrigger2.dataset.claimText ?? targetTrigger2.dataset.dbClaimText, translateWhat: "reasoning" }
                    }));
                }
            };
        }
        appendTextRow(reasoning || "", popover, "mf-popover-reasoning-text", undefined, reasoningTranslateBtn);
        if (isRefreshing) {
            const reasoningRow = popover.querySelector('.mf-popover-text-row.mf-popover-reasoning-text');
            if (reasoningRow) {
                const textSpan = reasoningRow.querySelector(".mf-popover-text") as HTMLElement | null;
                const spinner = document.createElement("span");
                spinner.className = "mf-spinner";
                if (hasReasoning && textSpan) {
                    // Show the cached (soon-to-be-replaced) reasoning with the spinner
                    // inline to its right, before the copy/refresh buttons.
                    spinner.style.marginLeft = "4px";
                    textSpan.insertAdjacentElement("afterend", spinner);
                } else {
                    // No prior reasoning — spinner at the start, hide the empty text.
                    spinner.style.marginRight = "4px";
                    reasoningRow.insertBefore(spinner, reasoningRow.firstChild);
                    if (textSpan) textSpan.style.display = "none";
                }
            }
        }
        const reasoningRow = popover.querySelector('.mf-popover-text-row.mf-popover-reasoning-text');
        if (reasoningRow) {
            const refreshContainer = document.createElement("span");
            refreshContainer.className = "mf-refresh-container";
            refreshContainer.style.cssText = "display: inline-flex; align-items: center; margin-left: 2px; vertical-align: middle;";

            const refreshBtn = document.createElement("button");
            refreshBtn.className = "mf-popover-copy-icon";
            refreshBtn.dataset.mfCharge = "refresh-inner";
            refreshBtn.innerHTML = refreshIconSvg;
            refreshBtn.title = t("refreshClaimTooltip");
            refreshBtn.addEventListener("mousedown", (e) => {
                e.stopPropagation();
                e.preventDefault();
            });
            refreshBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                e.preventDefault();
                const cId = getRefreshClassificationId();
                if (!cId) return;
                const ct = trigger.dataset.claimText;
                const dbCt = trigger.dataset.dbClaimText;
                trigger.dataset.refreshing = "true";
                // Keep the current reasoning on screen while the re-research runs — blanking
                // it here is what made the text vanish behind a leading spinner. Instead swap
                // this button for the spinner that already sits to the RIGHT of the text
                // (refreshContainer); the update path restores the button when the new
                // reasoning arrives.
                const rc = refreshBtn.closest('.mf-refresh-container');
                const rcSpinner = rc?.querySelector<HTMLElement>('.mf-refresh-spinner');
                if (rcSpinner) {
                    refreshBtn.style.display = "none";
                    rcSpinner.style.display = "";
                }
                mfBus.dispatchEvent(new CustomEvent('mf-refresh-claim', {
                    detail: { classificationId: cId, claimText: ct, dbClaimText: dbCt }
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

            const rSpinnerEl = document.createElement("span");
            rSpinnerEl.className = "mf-refresh-spinner";
            rSpinnerEl.style.display = "none";

            refreshContainer.appendChild(refreshBtn);
            refreshContainer.appendChild(rSpinnerEl);
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

    if (sources.length > 0) {
        const prob = parseFloat(trigger.dataset.probability ?? "");
        const ver = parseFloat(trigger.dataset.veracity ?? "");
        const srcHoverColor = (!isNaN(prob) && !isNaN(ver) && prob >= 0.2) ? confidenceRgba(prob, 0.4, ver) : undefined;

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

/** Get the bounding rectangle of the Fact-Checked floating button if it exists. */
function getFactCheckedButtonRect(): DOMRect | null {
    const btn = document.querySelector<HTMLElement>(".mf-floating-scroll-btn");
    return btn?.getBoundingClientRect() ?? null;
}

let previewPlacementCounter = 0;

/** Return the bounding rectangle of a popover's trigger, in viewport coordinates,
 *  tolerating virtual triggers created for the Fact-Checked button preview or explicit anchor elements. */
function getTriggerViewportRect(trigger: HTMLElement): DOMRect {
    const anchor = (trigger as any)._mfAnchorEl as HTMLElement | undefined;
    if (anchor && anchor.isConnected) {
        return anchor.getBoundingClientRect();
    }
    if (trigger.parentElement === document.body && trigger.style.position === 'fixed' && trigger.style.left.startsWith('-9999')) {
        const left = parseFloat(trigger.dataset.mfVirtualLeft ?? '0');
        const top = parseFloat(trigger.dataset.mfVirtualTop ?? '0');
        const width = parseFloat(trigger.dataset.mfVirtualWidth ?? '1');
        const height = parseFloat(trigger.dataset.mfVirtualHeight ?? '1');
        return new DOMRect(left, top, width, height);
    }
    return trigger.getBoundingClientRect();
}

/** Position a popover relative to the timeline container.
 *
 *  Strategy:
 *   1. Prioritize placing the popover directly to the RIGHT of the trigger (highlight or claim badge)
 *      whenever space is available in the viewport.
 *   2. When space to the right is insufficient (e.g. mobile/narrow viewports), fall back to placing
 *      strictly ABOVE or BELOW the trigger with zero overlap. */
function positionPopover(popover: HTMLElement, trigger: HTMLElement) {
    popover.style.maxHeight = '';
    popover.style.overflowY = '';
    popover.style.width = '';
    popover.style.maxWidth = '';

    // Position relative to the popover's ACTUAL offsetParent — the element its
    // absolute top/left genuinely resolve against — not a freshly re-resolved
    // getTimelineContainer(), which can return a different element than the one the
    // popover was appended to (this divergence is what threw the first tweet's
    // popovers far below where they belong). scrollTop/scrollLeft make the transform
    // correct even when that parent is an internal scroll container (0 otherwise).
    const offsetParent = (popover.offsetParent as HTMLElement | null) ?? getTimelineContainer(trigger);
    const containerRect = offsetParent.getBoundingClientRect();
    const containerScrollTop = offsetParent.scrollTop || 0;
    const containerScrollLeft = offsetParent.scrollLeft || 0;
    const popoverRect = popover.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const headerBottom = getHeaderBottom() || 53;
    const trigRect = getTriggerViewportRect(trigger);
    const padding = 8;
    const minPopoverWidth = 280;
    const maxPopoverWidth = 360;

    const spaceToRight = viewportWidth - trigRect.right - padding;
    const rightFits = spaceToRight >= minPopoverWidth;

    let left: number;
    let top: number;
    let width: number | undefined;

    if (rightFits) {
        width = Math.min(maxPopoverWidth, Math.max(minPopoverWidth, spaceToRight));
        left = trigRect.right - containerRect.left + containerScrollLeft + padding;

        let targetViewportTop = trigRect.top;
        if (targetViewportTop + popoverRect.height > viewportHeight - padding) {
            targetViewportTop = viewportHeight - padding - popoverRect.height;
        }
        if (targetViewportTop < headerBottom + padding) {
            targetViewportTop = headerBottom + padding;
        }
        top = targetViewportTop - containerRect.top + containerScrollTop;
    } else {
        const spaceAbove = trigRect.top - headerBottom - padding;
        const spaceBelow = viewportHeight - trigRect.bottom - padding;

        const aboveFits = spaceAbove >= popoverRect.height;
        const belowFits = spaceBelow >= popoverRect.height;

        let placeAbove = false;
        if (aboveFits && !belowFits) {
            placeAbove = true;
        } else if (!aboveFits && belowFits) {
            placeAbove = false;
        } else {
            placeAbove = spaceAbove >= spaceBelow;
        }

        if (placeAbove) {
            let vTop = trigRect.top - popoverRect.height - padding;
            if (vTop < headerBottom + padding) {
                vTop = headerBottom + padding;
                const maxH = trigRect.top - padding - vTop;
                if (maxH > 60) {
                    popover.style.maxHeight = `${maxH}px`;
                    popover.style.overflowY = 'auto';
                }
            }
            top = vTop - containerRect.top + containerScrollTop;
        } else {
            let vTop = trigRect.bottom + padding;
            const maxVTop = viewportHeight - padding;
            if (vTop + popoverRect.height > maxVTop) {
                const maxH = maxVTop - vTop;
                if (maxH > 60) {
                    popover.style.maxHeight = `${maxH}px`;
                    popover.style.overflowY = 'auto';
                }
            }
            top = vTop - containerRect.top + containerScrollTop;
        }

        const targetViewportLeft = trigRect.left;
        const minVLeft = padding;
        const currentPopWidth = (width ?? popoverRect.width) || minPopoverWidth;
        const maxVLeft = viewportWidth - currentPopWidth - padding;
        const clampedVLeft = Math.max(minVLeft, Math.min(targetViewportLeft, maxVLeft));
        left = clampedVLeft - containerRect.left + containerScrollLeft;
    }

    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
    if (width !== undefined) {
        popover.style.width = `${width}px`;
        popover.style.maxWidth = `${width}px`;
    } else {
        popover.style.width = '';
        popover.style.maxWidth = '';
    }
}

/** Position an onboarding popover with `position: fixed`, pinned directly to the button's
 *  live VIEWPORT rect — no container/scrollTop math (which mis-placed them ~scroll-offset
 *  px offscreen, previously masked only by positionPopover's viewport clamp). It sits to
 *  the button's right with a 280–360px width when there's room, else below it; it follows
 *  the button on scroll (refreshOnboarding re-runs on scroll) and goes offscreen with it,
 *  with no edge pile-up. Popovers are appended to document.body (no transformed ancestor)
 *  so `fixed` resolves against the viewport. */
function positionOnboardingPopover(popover: HTMLElement, trigger: HTMLElement) {
    popover.style.maxHeight = '';
    popover.style.overflowY = '';
    popover.style.width = '';
    popover.style.maxWidth = '';
    popover.style.position = 'fixed';
    const viewportWidth = window.innerWidth;
    const trigRect = getTriggerViewportRect(trigger);
    const padding = 8;
    const minPopoverWidth = 280;
    const maxPopoverWidth = 360;
    const spaceToRight = viewportWidth - trigRect.right - padding;
    const rightFits = spaceToRight >= minPopoverWidth;

    let left: number;
    let top: number;
    let width: number | undefined;
    if (rightFits) {
        width = Math.min(maxPopoverWidth, Math.max(minPopoverWidth, spaceToRight));
        left = trigRect.right + padding;
        top = trigRect.top;
    } else {
        top = trigRect.bottom + padding;
        const w = popover.getBoundingClientRect().width || minPopoverWidth;
        left = Math.max(padding, Math.min(trigRect.left, viewportWidth - w - padding));
    }
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
    if (width !== undefined) {
        popover.style.width = `${width}px`;
        popover.style.maxWidth = `${width}px`;
    } else {
        popover.style.width = '';
        popover.style.maxWidth = '';
    }
}

function getTimelineContainer(el: Element): HTMLElement {
    let current = el.parentElement;
    while (current && current !== document.body) {
        if (current.scrollHeight > current.clientHeight + 2) {
            const style = getComputedStyle(current);
            if (style.overflowY === "auto" || style.overflowY === "scroll") {
                const rect = current.getBoundingClientRect();
                // A pseudo-scroll wrapper taller than the viewport is never a valid popover
                // container, at ANY scroll position: gating this on rect.top < -100 made the
                // container choice scroll-dependent, so at the top of the page (the first
                // tweet) the tall wrapper was picked and popovers landed far below their
                // highlight. Real, user-scrollable regions are at most viewport-sized.
                const isFullPageScroll = rect.height > window.innerHeight * 1.5;
                if (!isFullPageScroll) return current;
            }
        }
        current = current.parentElement;
    }
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
    /** External onboarding "charge-balance" popovers attached to this preview; they
     *  behave as an extension of it (shared hover, mirrored opacity, dismissed together). */
    onboardPopovers?: HTMLElement[];
} | null = null;

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
        const isResearching = t.dataset.refreshing === "true" || prob === undefined || ver === undefined || prob < 0.2;
        t.style.backgroundColor = isResearching ? 'rgba(128, 128, 128, 0.25)' : confidenceRgba(prob, 0.25, ver);
    }
    const popover = previewPopoverState.popover;
    // Remove the attached onboarding popovers along with their preview.
    for (const op of previewPopoverState.onboardPopovers ?? []) op.remove();
    previewPopoverState = null;
    popover.classList.add("mf-popover-fading");
    popover.classList.remove("mf-popover-visible");
    const onTransitionEnd = (e: TransitionEvent) => {
        if (e.propertyName !== "opacity") return;
        popover.removeEventListener("transitionend", onTransitionEnd);
        popover.remove();
    };
    popover.addEventListener("transitionend", onTransitionEnd);
    setTimeout(() => {
        popover.removeEventListener("transitionend", onTransitionEnd);
        popover.remove();
    }, 250);
}

function setPreviewPopoverOpacity(opacity: number) {
    if (!previewPopoverState) return;
    previewPopoverState.semiTransparent = opacity < 1;
    const popover = previewPopoverState.popover;
    popover.classList.remove("mf-popover-fading");
    popover.classList.add("mf-popover-visible");
    const value = opacity >= 1 ? "1" : String(PREVIEW_BASE_OPACITY);
    if (opacity >= 1) popover.classList.add("mf-popover-opaque");
    else popover.classList.remove("mf-popover-opaque");
    popover.style.opacity = value;
    // Mirror onto the attached onboarding popovers so they share the state.
    for (const op of previewPopoverState.onboardPopovers ?? []) op.style.opacity = value;
}

function closePopover(trigger?: HTMLElement) {
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
            const isResearching = t.dataset.refreshing === "true" || prob === undefined || ver === undefined || prob < 0.2;
            t.style.backgroundColor = isResearching ? 'rgba(128, 128, 128, 0.25)' : confidenceRgba(prob, 0.25, ver);
        }
        removeAttachedOnboardingFor(p as HTMLElement);
        p.remove();
    }
    if (previewPopoverState && (!trigger || previewPopoverState.trigger === trigger)) {
        dismissPreviewPopover();
    }
}

/** Remove the external onboarding popovers attached to a given claim popover. */
function removeAttachedOnboardingFor(claimPop: HTMLElement) {
    for (const op of Array.from(document.querySelectorAll<HTMLElement>('.mf-onboard-attached'))) {
        if ((op as any)._mfClaimPop === claimPop) op.remove();
    }
}

function bringPopoverToFront(popover: HTMLElement) {
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

    const timelineContainer = getTimelineContainer(trigger);
    if (getComputedStyle(timelineContainer).position === "static") {
        timelineContainer.style.position = "relative";
    }
    timelineContainer.appendChild(popover);
    render(reasoning, sources, claimText);
    bringPopoverToFront(popover);

    void popover.offsetHeight;
    popover.classList.add("mf-popover-visible");

    previewPopoverState = {
        popover,
        trigger,
        leaveTimer: null,
        pinned: false,
        semiTransparent: true
    };

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

    refreshInPopoverOnboarding();
}

/** True when the pointer is currently over either the trigger element, its anchor element, or the
 *  active preview popover. */
function isHoveringPreviewRelated(trigger: HTMLElement): boolean {
    if (!previewPopoverState) return false;
    if (previewPopoverState.trigger !== trigger) return false;
    const hoveredEl = (document as any).querySelector?.(':hover');
    if (!hoveredEl) return false;
    if (trigger.contains(hoveredEl) || hoveredEl === trigger) return true;
    const anchorEl = (trigger as any)._mfAnchorEl as HTMLElement | undefined;
    if (anchorEl && (anchorEl.contains(hoveredEl) || hoveredEl === anchorEl)) return true;
    const popover = previewPopoverState.popover;
    if (popover.contains(hoveredEl) || hoveredEl === popover) return true;
    // Attached onboarding popovers count as part of the preview for hover purposes.
    for (const op of previewPopoverState.onboardPopovers ?? []) {
        if (op.contains(hoveredEl) || hoveredEl === op) return true;
    }
    return false;
}

/** Schedule preview popover dismissal 1 second after pointer leaves both
 *  the trigger and the popover. */
function schedulePreviewPopoverDismiss(trigger: HTMLElement) {
    if (!previewPopoverState || previewPopoverState.trigger !== trigger) return;
    if (previewPopoverState.leaveTimer) clearTimeout(previewPopoverState.leaveTimer);
    previewPopoverState.leaveTimer = setTimeout(() => {
        if (isHoveringPreviewRelated(trigger)) return;
        dismissPreviewPopover();
    }, 1000);
}

/** Show a preview popover anchored to the Fact-Checked button for a given claim.
 *  The preview follows the same hover rules as highlight previews: opaque while
 *  hovered, dismissed 1 second after the pointer leaves both the badge and the
 *  popover. */
function showPreviewPopoverFromButton(anchorBtn: HTMLElement, claim: Claim, classification: Classification, claimEl: HTMLElement) {
    if (previewPopoverState) {
        if ((previewPopoverState.trigger as any)?._mfAnchorEl === claimEl) {
            return;
        }
        dismissPreviewPopover();
    }

    const trigger = document.createElement("span");
    (trigger as any)._mfButtonPreview = true;
    (trigger as any)._mfAnchorEl = claimEl;
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

    const rect = claimEl.getBoundingClientRect();
    trigger.style.left = `${rect.left}px`;
    trigger.style.top = `${rect.top}px`;
    trigger.dataset.mfVirtualLeft = String(rect.left);
    trigger.dataset.mfVirtualTop = String(rect.top);
    trigger.dataset.mfVirtualWidth = String(rect.width);
    trigger.dataset.mfVirtualHeight = String(rect.height);

    showPreviewPopover(trigger);

    const cleanup = () => {
        if (!previewPopoverState || previewPopoverState.trigger !== trigger) {
            trigger.remove();
        } else {
            setTimeout(cleanup, 1000);
        }
    };
    setTimeout(cleanup, 1000);
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

    link.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        window.open(url, '_blank', 'noopener,noreferrer');
    });
    link.addEventListener("mouseup", (e) => {
        e.preventDefault();
        e.stopPropagation();
    });
    link.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
    });
    link.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.open(url, '_blank', 'noopener,noreferrer');
    });

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
    link.appendChild(img);

    const letter = document.createElement("span");
    letter.textContent = firstLetter;
    letter.style.cssText = "font-size: 11px; font-weight: 600; color: rgba(255,255,255,0.7); line-height: 1;";
    link.appendChild(letter);

    const textSpan = document.createElement("span");
    textSpan.textContent = domainFromUrl(url) || src.title || url;
    textSpan.style.cssText = "font-size: 11px; color: rgba(255,255,255,0.9); white-space: nowrap; display: none;";
    link.appendChild(textSpan);

    img.onload = () => {
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
    const previousRaw = (popover as any)._mfSourcesRaw;
    if (previousRaw === rawSources) return;
    (popover as any)._mfSourcesRaw = rawSources;

    const existing = popover.querySelector(".mf-popover-sources-row");
    if (existing) existing.remove();

    let srcList: Source[] = [];
    try {
        const parsed = JSON.parse(rawSources ?? "[]");
        srcList = normalizeSources(parsed);
    } catch {}
    if (srcList.length === 0) return;

    const p = parseFloat(trigger.dataset.probability ?? "");
    const v = parseFloat(trigger.dataset.veracity ?? "");
    const hoverColor = (!isNaN(p) && !isNaN(v) && p >= 0.2) ? confidenceRgba(p, 0.4, v) : undefined;

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

        const claimTextSpan = popover.querySelector<HTMLElement>(".mf-popover-text-row.mf-popover-claim-text .mf-popover-text");
        if (claimTextSpan) {
            const newClaimText = trigger.dataset.claimRewritten ?? trigger.dataset.claimText ?? "";
            console.log(`[updateOpenPopover] claim text stream oldLen=${claimTextSpan.textContent?.length ?? 0} newLen=${newClaimText.length} old="${claimTextSpan.textContent?.slice(0, 30)}" new="${newClaimText.slice(0, 30)}" claimLocale=${trigger.dataset.claimLocale} uiLocale=${uiLocale}`);
            const claimRow = popover.querySelector(".mf-popover-text-row.mf-popover-claim-text");
            const spinner = claimRow?.querySelector(".mf-spinner");
            if (spinner) spinner.remove();
            if (newClaimText && newClaimText !== claimTextSpan.textContent) {
                claimTextSpan.textContent = newClaimText;
            }
            if (trigger.dataset.claimLocale && sameLanguage(trigger.dataset.claimLocale, uiLocale)) {
                const btn = popover.querySelector(".mf-popover-claim-text .mf-translate-btn");
                if (btn) btn.remove();
            }
        }

        const reasoning = trigger.dataset.reasoning ?? "";

        const existingTextSpan = popover.querySelector<HTMLElement>(".mf-popover-text-row.mf-popover-reasoning-text .mf-popover-text");
        if (existingTextSpan) {
            console.log(`[updateOpenPopover] reasoning text stream oldLen=${existingTextSpan.textContent?.length ?? 0} newLen=${reasoning.length} old="${existingTextSpan.textContent?.slice(0, 30)}" new="${reasoning.slice(0, 30)}" reasoningLocale=${trigger.dataset.reasoningLocale} uiLocale=${uiLocale} refreshing=${trigger.dataset.refreshing}`);
            const reasoningRow = popover.querySelector(".mf-popover-text-row.mf-popover-reasoning-text");
            const isRefreshingNow = trigger.dataset.refreshing === "true";
            if (reasoning) {
                existingTextSpan.style.display = "";
                if (reasoning !== existingTextSpan.textContent) {
                    // The reasoning text changed — either the cached (soon-to-be-replaced)
                    // reasoning is now being replaced by the streaming reclassification, or
                    // a fresh reasoning arrived. Update the text and drop the inline spinner.
                    existingTextSpan.textContent = reasoning;
                    const rSpinner = reasoningRow?.querySelector(".mf-spinner");
                    if (rSpinner) rSpinner.remove();
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
                // else: reasoning unchanged (still the cached text) — keep the inline
                // spinner visible while the reclassification is still in flight.
            } else if (isRefreshingNow) {
                existingTextSpan.style.display = "none";
                if (!reasoningRow?.querySelector(".mf-spinner")) {
                    const spinner = document.createElement("span");
                    spinner.className = "mf-spinner";
                    spinner.style.marginRight = "4px";
                    reasoningRow?.insertBefore(spinner, reasoningRow.firstChild);
                }
            }
            // Drop the reasoning translate button as soon as translating becomes pointless:
            // either the reasoning is already in the UI language, or a re-research is in
            // flight that will replace it with a fresh one written directly in that language.
            // (The button is built before the refresh starts, so this streaming-update path —
            // which keeps the existing row rather than rebuilding it — has to remove it.)
            if (isRefreshingNow || (trigger.dataset.reasoningLocale && sameLanguage(trigger.dataset.reasoningLocale, uiLocale))) {
                const btn = popover.querySelector(".mf-popover-reasoning-text .mf-translate-btn");
                if (btn) btn.remove();
            }
            const prob = parseFloat(trigger.dataset.probability ?? "");
            const ver = parseFloat(trigger.dataset.veracity ?? "");
            const hoverBg = (!isNaN(prob) && !isNaN(ver) && prob >= 0.2) ? confidenceRgba(prob, 0.3, ver) : undefined;
            if (hoverBg) {
                popover.style.setProperty('--mf-popover-hover', hoverBg);
            }
            addSourcesToPopover(popover, trigger);
            positionPopover(popover, trigger);
            return;
        }

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
            copyBtn.addEventListener("mousedown", (e) => {
                e.stopPropagation();
                e.preventDefault();
            });
            copyBtn.addEventListener("click", async (e) => {
                e.stopPropagation();
                e.preventDefault();
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

            const hlProb = parseFloat(trigger.dataset.probability ?? "");
            const hlVer = parseFloat(trigger.dataset.veracity ?? "");
            const hlHover = (!isNaN(hlProb) && !isNaN(hlVer) && hlProb >= 0.2) ? confidenceRgba(hlProb, 0.3, hlVer) : undefined;
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

            const refreshContainer = document.createElement("span");
            refreshContainer.className = "mf-refresh-container";
            refreshContainer.style.cssText = "display: inline-flex; align-items: center; margin-left: 2px; vertical-align: middle;";

            const refreshBtn = document.createElement("button");
            refreshBtn.className = "mf-popover-copy-icon";
            refreshBtn.dataset.mfCharge = "refresh-inner";
            refreshBtn.innerHTML = refreshIconSvg;
            refreshBtn.title = t("refreshClaimTooltip");
            refreshBtn.addEventListener("mousedown", (e) => {
                e.stopPropagation();
                e.preventDefault();
            });
            refreshBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                e.preventDefault();
                let cId: string | null = trigger.dataset.mfCid ?? null;
                if (!cId) {
                    const article = trigger.closest('article');
                    const link = article?.querySelector<HTMLAnchorElement>('a[href*="/status/"]');
                    const match = link?.href.match(/\/status\/(\d+)/);
                    cId = match ? match[1] : null;
                }
                if (!cId) return;
                const ct = trigger.dataset.claimText;
                const dbCt = trigger.dataset.dbClaimText;
                trigger.dataset.refreshing = "true";
                // Keep the current reasoning on screen while the re-research runs — blanking
                // it here is what made the text vanish behind a leading spinner. Instead swap
                // this button for the spinner that already sits to the RIGHT of the text
                // (refreshContainer); the update path restores the button when the new
                // reasoning arrives.
                const rc = refreshBtn.closest('.mf-refresh-container');
                const rcSpinner = rc?.querySelector<HTMLElement>('.mf-refresh-spinner');
                if (rcSpinner) {
                    refreshBtn.style.display = "none";
                    rcSpinner.style.display = "";
                }
                mfBus.dispatchEvent(new CustomEvent('mf-refresh-claim', {
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
            positionPopover(popover, trigger);
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
    return subscribeBtn?.parentElement?.parentElement as HTMLElement | null;
}

// ---- On-hold button injection (paused pipeline) ----

/** Decide whether the top-of-tweet on-hold container (spinner + Fact-Check All)
 *  should be removed for a tweet that is no longer `onHold`.
 *
 *  The button stays unless one of the user's three conditions is met:
 *  1. Preclassification finished and the tweet has zero claims.
 *  2. Preclassification finished, every claim's DB fetch was attempted, and either
 *     all claims were found in DB or the user clicked Disinfact on every no-match claim.
 *  3. The user clicked "Fact-Check All".
 */
function shouldRemoveOnHoldButton(classification: Classification): boolean {
    // Condition 3: Fact-Check All was clicked.
    if (factCheckAllClickedIds.has(classification.id)) {
        console.log(`[misinfo] shouldRemoveOnHoldButton ${classification.id}: removing because Fact-Check All was clicked`);
        return true;
    }

    const claims = classification.claims ?? [];

    // We cannot make a removal decision until preclassification has produced a
    // definitive claim list. A `null` claims array while onHold is still true
    // means the pipeline hasn't yielded claims yet. Once onHold is false/absent,
    // null means the preclassification stream finished with no claims.
    if (classification.claims === null) {
        if (classification.onHold) {
            console.log(`[misinfo] shouldRemoveOnHoldButton ${classification.id}: keeping, claims still null and onHold`);
            return false;
        }
        console.log(`[misinfo] shouldRemoveOnHoldButton ${classification.id}: removing, claims null and pipeline done`);
        return true;
    }

    // Condition 1: preclassification done and no claims at all.
    if (claims.length === 0) {
        console.log(`[misinfo] shouldRemoveOnHoldButton ${classification.id}: removing, zero claims`);
        return true;
    }

    // Condition 2: every claim must have completed its DB fetch attempt. We know
    // a DB fetch has been attempted when the claim is either:
    //   - matched DB (dbClaimText set), or
    //   - explicitly paused for no-DB-match (reclassifyOnHold === true).
    // A plain "research required" claim without reclassifyOnHold only means
    // markClaimsResearching ran; the fetch has NOT happened yet, so keep the button.
    const allDbFetchesDone = claims.every(cl =>
        cl.dbClaimText !== undefined || cl.reclassifyOnHold === true
    );
    if (!allDbFetchesDone) {
        console.log(`[misinfo] shouldRemoveOnHoldButton ${classification.id}: keeping, not all DB fetches done`, claims.map(cl => ({ text: cl.text.slice(0, 30), db: !!cl.dbClaimText, onHold: cl.reclassifyOnHold })));
        return false;
    }

    const allResolved = claims.every(cl => {
        // A claim still showing a Disinfact button (reclassifyOnHold) is NOT
        // resolved — even a DB-matched placeholder claim carries a dbClaimText.
        // It becomes resolved only once the user has individually clicked it.
        if (cl.reclassifyOnHold) {
            return individuallyClickedOnHoldClaims.has(`${classification.id}:${cl.text}`);
        }
        // Not on hold: classified (from DB or freshly) → resolved.
        return true;
    });

    console.log(`[misinfo] shouldRemoveOnHoldButton ${classification.id}: ${allResolved ? 'removing' : 'keeping'}, allResolved=${allResolved}`, claims.map(cl => ({ text: cl.text.slice(0, 30), db: !!cl.dbClaimText, onHold: cl.reclassifyOnHold })));
    return allResolved;
}

/** Render a "Disinfact" button for tweets awaiting user action. */
/** Insert a button container into the action row (before Grok), else the Grok row,
 *  else right after the timestamp. Applies a single symmetric gap: margin-RIGHT when the
 *  button sits to the LEFT of the Grok/action content, margin-LEFT when it sits to the
 *  RIGHT of the timestamp — so the same visual gap separates it from its neighbor either
 *  way (previously the fixed margin-right left it cramped against the timestamp). */
const MF_BTN_GAP = '10px';
function placeButtonContainer(container: HTMLElement, article: Element, time: Element, grokData: { row: HTMLElement } | null) {
    const actionRow = findActionRow(article);
    if (actionRow) {
        container.style.marginRight = MF_BTN_GAP;
        actionRow.insertBefore(container, actionRow.firstChild);
    } else if (grokData) {
        container.style.marginRight = MF_BTN_GAP;
        grokData.row.insertBefore(container, grokData.row.firstChild);
    } else {
        // After the timestamp: neighbor is on the LEFT, so the gap goes on the left.
        container.style.marginLeft = MF_BTN_GAP;
        container.style.marginRight = '0';
        time.insertAdjacentElement("afterend", container);
    }
}

function injectOnHoldButton(
    time: Element,
    classification: Classification,
    article: Element,
    isQuoted: boolean = false
) {
    if (isQuoted) {
        article.querySelector(`[mf-on-hold-id="${classification.id}"]`)?.remove();
        return;
    }

    if (article.querySelector(`[mf-on-hold-id="${classification.id}"]`)) return;

    const container = document.createElement("div");
    container.setAttribute("mf-on-hold-id", classification.id);
    container.style.cssText = `
        display: inline-flex;
        align-items: center;
        min-width: 0;
        flex-shrink: 0;
    `;

    const grokData = findGrokRow(article);
    const refBtn = grokData?.btn ?? (time as HTMLElement);
    const refClass = refBtn.className;
    const innerDiv = grokData?.btn.querySelector<HTMLElement>('div[dir="ltr"]');
    const innerClass = innerDiv?.className ?? refClass;

    if (processingOnHoldIds.has(classification.id)) {
        const spinnerWrap = document.createElement("div");
        spinnerWrap.setAttribute("dir", "ltr");
        spinnerWrap.className = innerClass;
        spinnerWrap.style.color = "rgb(83, 100, 113)";
        spinnerWrap.style.display = "inline-flex";
        spinnerWrap.style.alignItems = "center";
        spinnerWrap.style.gap = "6px";

        const spinner = document.createElement("span");
        spinner.className = "mf-spinner";
        spinner.style.marginRight = "0";
        spinner.style.borderColor = "rgba(83, 100, 113, 0.2)";
        spinner.style.borderTopColor = "rgba(83, 100, 113, 0.8)";
        spinnerWrap.appendChild(spinner);

        const factCheckAllBtn = document.createElement("button");
        factCheckAllBtn.textContent = t('factCheckAllButton');
        factCheckAllBtn.setAttribute("role", "button");
        factCheckAllBtn.setAttribute("type", "button");
        factCheckAllBtn.className = refClass;
        factCheckAllBtn.style.cursor = "pointer";
        factCheckAllBtn.style.color = "rgb(83, 100, 113)";
        // The placeholder wrapper below is pointer-events:none (the spinner area is
        // inert); re-enable pointer events on the button itself so it stays clickable.
        factCheckAllBtn.style.pointerEvents = "auto";
        const factCheckAllText = document.createElement("div");
        factCheckAllText.setAttribute("dir", "ltr");
        factCheckAllText.className = innerClass;
        factCheckAllText.style.color = "rgb(83, 100, 113)";
        factCheckAllText.style.fontSize = "13px";
        factCheckAllText.style.fontWeight = "700";
        factCheckAllText.style.minWidth = "0";
        factCheckAllText.textContent = t('factCheckAllButton');
        factCheckAllBtn.innerHTML = "";
        factCheckAllBtn.appendChild(factCheckAllText);
        factCheckAllBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            factCheckAllBtn.disabled = true;
            factCheckAllBtn.style.opacity = "0.6";
            factCheckAllBtn.style.cursor = "default";
            factCheckAllClickedIds.add(classification.id);
            mfBus.dispatchEvent(new CustomEvent('mf-fact-check-all', {
                detail: { tweetId: classification.id }
            }));
        });
        factCheckAllBtn.dataset.mfCharge = "factcheckall";
        spinnerWrap.appendChild(factCheckAllBtn);

        const placeholder = document.createElement("button");
        placeholder.setAttribute("role", "button");
        placeholder.setAttribute("type", "button");
        placeholder.className = refClass;
        placeholder.style.cursor = "default";
        placeholder.style.pointerEvents = "none";
        placeholder.appendChild(spinnerWrap);

        container.appendChild(placeholder);
        placeButtonContainer(container, article, time, grokData);
        return;
    }

    const button = document.createElement("button");
    button.dataset.mfCharge = "disinfact";
    button.textContent = t("disinfactButton");
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
    textWrap.textContent = t("disinfactButton");

    button.innerHTML = "";
    button.style.cursor = "pointer";
    button.appendChild(textWrap);

    button.addEventListener("click", () => {
        processingOnHoldIds.add(classification.id);

        onHoldScrollStates.set(classification.id, {
            originalScrollY: window.scrollY,
            pendingClaimTexts: new Set()
        });

        const loadingWrap = document.createElement("div");
        loadingWrap.setAttribute("dir", "ltr");
        loadingWrap.className = innerClass;
        loadingWrap.style.color = "rgb(83, 100, 113)";
        loadingWrap.style.display = "inline-flex";
        loadingWrap.style.alignItems = "center";
        loadingWrap.style.gap = "6px";

        const spinner = document.createElement("span");
        spinner.className = "mf-spinner";
        spinner.style.marginRight = "0";
        spinner.style.borderColor = "rgba(83, 100, 113, 0.2)";
        spinner.style.borderTopColor = "rgba(83, 100, 113, 0.8)";
        loadingWrap.appendChild(spinner);

        const factCheckAllBtn = document.createElement("button");
        factCheckAllBtn.textContent = t('factCheckAllButton');
        factCheckAllBtn.setAttribute("role", "button");
        factCheckAllBtn.setAttribute("type", "button");
        factCheckAllBtn.className = refClass;
        factCheckAllBtn.style.cursor = "pointer";
        factCheckAllBtn.style.color = "rgb(83, 100, 113)";
        const factCheckAllText = document.createElement("div");
        factCheckAllText.setAttribute("dir", "ltr");
        factCheckAllText.className = innerClass;
        factCheckAllText.style.color = "rgb(83, 100, 113)";
        factCheckAllText.style.fontSize = "13px";
        factCheckAllText.style.fontWeight = "700";
        factCheckAllText.style.minWidth = "0";
        factCheckAllText.textContent = t('factCheckAllButton');
        factCheckAllBtn.innerHTML = "";
        factCheckAllBtn.appendChild(factCheckAllText);
        factCheckAllBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            factCheckAllBtn.disabled = true;
            factCheckAllBtn.style.opacity = "0.6";
            factCheckAllBtn.style.cursor = "default";
            factCheckAllClickedIds.add(classification.id);
            mfBus.dispatchEvent(new CustomEvent('mf-fact-check-all', {
                detail: { tweetId: classification.id }
            }));
        });
        factCheckAllBtn.dataset.mfCharge = "factcheckall";
        loadingWrap.appendChild(factCheckAllBtn);

        button.innerHTML = "";
        button.style.cursor = "default";
        // The outer button is no longer a Disinfact button — it now hosts the processing
        // spinner + Fact-Check All. Drop its disinfact charge marker so the onboarding
        // system doesn't re-create a (now pointless) Disinfact popover on it after a
        // reset, which would overlap and hide the Fact-Check All popover.
        delete button.dataset.mfCharge;
        button.appendChild(loadingWrap);

        mfBus.dispatchEvent(new CustomEvent('mf-process-on-hold', {
            detail: { tweetId: classification.id }
        }));

        // Safety net: if the backend call fails, no classification comes back to remove the
        // spinner, so revert to the clickable "Disinfact" button. On success the spinner is
        // removed (or the node re-rendered), so `spinner.isConnected` is false → this no-ops.
        setTimeout(() => {
            if (!spinner.isConnected || !processingOnHoldIds.has(classification.id)) return;
            processingOnHoldIds.delete(classification.id);
            onHoldScrollStates.delete(classification.id);
            button.innerHTML = "";
            button.style.cursor = "pointer";
            button.dataset.mfCharge = "disinfact";
            button.appendChild(textWrap);
        }, CHARGE_REVERT_TIMEOUT_MS);
    });

    container.appendChild(button);
    placeButtonContainer(container, article, time, grokData);
}

const processingTranslateFactChecksIds = new Set<string>();

/** Render a "Disinfact"-labeled button for a DB-hit tweet whose highlights aren't
 *  localized for the currently-displayed locale yet — visually and behaviorally as
 *  if there were no DB hit at all. Clicking it relocalizes highlights + re-researches
 *  (TRANSLATE_FACT_CHECKS) rather than a full preclassification. Same style as
 *  injectOnHoldButton, but a separate charge type ("translate-tweet"). */
function injectTranslateFactChecksButton(
    time: Element,
    classification: Classification,
    article: Element,
    isQuoted: boolean = false
) {
    if (isQuoted) {
        article.querySelector(`[translate-fc-id="${classification.id}"]`)?.remove();
        return;
    }

    if (article.querySelector(`[translate-fc-id="${classification.id}"]`)) return;

    const container = document.createElement("div");
    container.setAttribute("translate-fc-id", classification.id);
    container.style.cssText = `
        display: inline-flex;
        align-items: center;
        min-width: 0;
        flex-shrink: 0;
    `;

    const grokData = findGrokRow(article);
    const subscribeWrapper = findSubscribeWrapper(article);
    const refBtn = (subscribeWrapper?.querySelector('button') as HTMLElement | null) ?? grokData?.btn ?? (time as HTMLElement);
    const refClass = refBtn.className;
    const innerDiv2 = grokData?.btn.querySelector<HTMLElement>('div[dir="ltr"]');
    const innerClass = innerDiv2?.className ?? refClass;

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
        placeButtonContainer(container, article, time, grokData);
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
    // Displayed as the "Disinfact" button (per design: a DB hit whose highlights
    // don't yet exist for the currently-displayed locale should look exactly like
    // no hit at all). dataset.mfCharge stays "translate-tweet" — a separate charge
    // type from "disinfact" — since the click below only relocalizes highlights +
    // re-researches (TRANSLATE_FACT_CHECKS), not a full preclassification.
    textWrap.textContent = t("disinfactButton");

    button.innerHTML = "";
    button.style.cursor = "pointer";
    button.dataset.mfCharge = "translate-tweet";
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
        mfBus.dispatchEvent(new CustomEvent('mf-translate-fact-checks', {
            detail: { tweetId: classification.id }
        }));

        // Safety net: if the backend call fails, no localized result comes back to remove this
        // button, so revert to the clickable "Disinfact" state. On success the
        // [translate-fc-id] container is removed, so `button.isConnected` is false → this no-ops.
        setTimeout(() => {
            if (!button.isConnected || !processingTranslateFactChecksIds.has(classification.id)) return;
            processingTranslateFactChecksIds.delete(classification.id);
            button.innerHTML = "";
            button.style.cursor = "pointer";
            button.appendChild(textWrap);
        }, CHARGE_REVERT_TIMEOUT_MS);
    });

    container.appendChild(button);
    placeButtonContainer(container, article, time, grokData);
}

// ---- Main injection (two-phase) ----

function injectClassification(
    time: Element,
    classification: Classification | QuotedClassification,
    article: Element,
    isQuoted: boolean = false
) {
    const segments = classification.segments;
    const claims = classification.claims;

    // Feature-detection + graceful-degradation guard (launch resilience against the
    // host platform changing its markup). Each injection KEEPS its existing fallback
    // chain — we only fully no-op a tweet when even the fallbacks are exhausted. The
    // one hard requirement is the tweet text element: findTweetTextElement already
    // tries several fallback selectors, so a null result means there's genuinely no
    // readable tweet text to highlight or fact-check → inject nothing (no highlights,
    // no button, no fallback box) rather than decorate a tweet we can't read. The
    // button keeps its own actionRow → Grok-row → after-timestamp fallback chain
    // below, so a missing Grok bar still places the button (just lower), not a no-op.
    if (!findTweetTextElement(article, isQuoted, classification.id)) {
        console.log(`[misinfo] injectClassification: tweet text anchor missing for ${classification.id} (isQuoted=${isQuoted}) — skipping all injection`);
        return;
    }

    if (!isQuoted) {
        const domQuotedId = (classification as Classification).quoting?.id ?? findQuotedTweetIdInArticle(article, classification.id);
        if (domQuotedId) {
            requestQuotedDbFetch(domQuotedId, classification.id);
        }
    }

    const staleOnHold = document.querySelector(`[mf-on-hold-id="${classification.id}"]`);
    if (staleOnHold && !(classification as Classification).onHold && shouldRemoveOnHoldButton(classification as Classification)) {
        staleOnHold.remove();
        processingOnHoldIds.delete(classification.id);
    }
    const staleTFC = document.querySelector(`[translate-fc-id="${classification.id}"]`);
    if (staleTFC && !(classification as Classification).translateFactChecksOnHold) {
        staleTFC.remove();
        processingTranslateFactChecksIds.delete(classification.id);
    }

    if (isQuoted) {
        if ((classification as Classification).translateFactChecksOnHold || (classification as Classification).onHold) {
            article.querySelector(`[mf-on-hold-id="${classification.id}"]`)?.remove();
            article.querySelector(`[translate-fc-id="${classification.id}"]`)?.remove();
            article.querySelector(`[mf-unmatched="${classification.id}"]`)?.remove();
            return;
        }
    } else {
        if ((classification as Classification).translateFactChecksOnHold) {
            article.querySelector(`[mf-on-hold-id="${classification.id}"]`)?.remove();
            article.querySelector(`[mf-unmatched="${classification.id}"]`)?.remove();
            injectTranslateFactChecksButton(time, classification as Classification, article, isQuoted);
            return;
        }

        // A forced re-preclassification is running. Reuse the on-hold container so the
        // spinner appears exactly where the Disinfact button sits: processingOnHoldIds is
        // what makes injectOnHoldButton render the spinner state rather than the button.
        if ((classification as Classification).preclassifying) {
            processingOnHoldIds.add(classification.id);
            injectOnHoldButton(time, classification as Classification, article, isQuoted);
            return;
        }

        if ((classification as Classification).onHold) {
            injectOnHoldButton(time, classification as Classification, article, isQuoted);
            return;
        }
    }

    if (!claims || claims.length === 0) return;

    // Keep the "Fact-Check All" container present whenever the tweet still has one
    // or more claims showing a Disinfact button — even after navigating to a new
    // page (e.g. the detail view), where the on-hold container was never re-created
    // because the tweet is no longer `onHold`. It goes away once the user clicks
    // Fact-Check All or every pending claim has been classified.
    if (!isQuoted && !(classification as Classification).onHold) {
        const hasPendingDisinfact = claims.some(cl => cl.reclassifyOnHold);
        const containerExists = !!article.querySelector(`[mf-on-hold-id="${classification.id}"]`);
        if (hasPendingDisinfact && !containerExists
            && !factCheckAllClickedIds.has(classification.id)
            && !shouldRemoveOnHoldButton(classification as Classification)) {
            // processingOnHoldIds must contain the id so injectOnHoldButton renders
            // the spinner + Fact-Check All state (not the initial "Disinfact" button).
            processingOnHoldIds.add(classification.id);
            injectOnHoldButton(time, classification as Classification, article, isQuoted);
        }
    }

    if (segments && segments.length > 0) {
        console.log(`[misinfo] injectClassification: Phase 2 for ${classification.id} (isQuoted=${isQuoted})`);
        const mainCls = classification as Classification;
        const clBatchId = mainCls.batchId ?? '';
        upgradeToSegments(article, classification, clBatchId, isQuoted);
        if (!isQuoted && mainCls.quoting && mainCls.quoting.segments && mainCls.quoting.segments.length > 0) {
            upgradeToSegments(article, mainCls.quoting, clBatchId, true);
        }

        // Once all claim highlights are injected, stop the spinner next to the
        // Fact-Check All button, but keep the button itself.
        if (!isQuoted && processingOnHoldIds.has(classification.id)) {
            const onHoldContainer = document.querySelector(`[mf-on-hold-id="${classification.id}"]`);
            if (onHoldContainer) {
                const spinner = onHoldContainer.querySelector(".mf-spinner");
                if (spinner) spinner.remove();
            }
        }

        if (!mainCls.localizingHighlights) {
            const segmentClaimTexts = new Set<string>();
            for (const seg of segments) {
                if (seg.claimIndex !== null && claims[seg.claimIndex]) {
                    segmentClaimTexts.add(claims[seg.claimIndex].text);
                }
            }
            for (const seg of segments) {
                if (seg.claimIndex !== null && claims[seg.claimIndex]?.rewritten) {
                    segmentClaimTexts.add(claims[seg.claimIndex].rewritten!);
                }
            }
            const unmatched = claims.filter(c => !segmentClaimTexts.has(c.text) && !segmentClaimTexts.has(c.rewritten ?? ''));
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
                    const mainTweet = !isQuoted && parseInt(article.getAttribute("tabindex") ?? "0") < 0;
                    if (mainTweet) article.querySelector(`[data-testid="User-Name"]`)?.appendChild(div);
                    else time.insertAdjacentElement("afterend", div);
                }
            } else {
                const unmatchedDiv = article.querySelector(`[mf-unmatched="${classification.id}"]`);
                if (unmatchedDiv) unmatchedDiv.remove();
            }
        }

        return;
    }

    if ((classification as Classification).localizingHighlights) {
        console.log(`[misinfo] injectClassification: suppressing Phase 1 fallback for ${classification.id} while localizing highlights`);
        return;
    }
    console.log(`[misinfo] injectClassification: Phase 1 (fallback) for ${classification.id}`);
    const mainTweet = !isQuoted && parseInt(article.getAttribute("tabindex") ?? "0") < 0;
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

    if (!isQuoted && (classification as Classification).quoting && quotedTimes.length > 1) {
        const quoting = (classification as Classification).quoting!;
        if (mainTweet)
            injectClassification(
                quotedTimes[0],
                quoting,
                article.querySelector(`[tabindex="0"]`) ?? article,
                true
            );
        else injectClassification(quotedTimes[1], quoting, article, true);
    }
}

mfBus.addEventListener('mf-prepare-locale-switch', ((e: CustomEvent) => {
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