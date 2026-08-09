/** The injected UI — everything the user actually sees on x.com.
 *
 *  Given a Classification from the background, this module rewrites the tweet's text into
 *  highlighted claim spans and attaches the surrounding interface: verdict badges, detail
 *  popovers, the Disinfact / Fact-Check All buttons, floating scroll affordances,
 *  balance notifications, and the onboarding walkthrough.
 *
 *  Three constraints explain most of the design here:
 *
 *  - **The host page is hostile territory.** X owns the DOM and re-renders it constantly
 *    as the user scrolls, so injected nodes are marked with `mf-*` classes and data
 *    attributes, re-applied idempotently, and reconciled against what is already there
 *    rather than blindly rebuilt. Tweets are located by structural fingerprints (status
 *    links, stable SVG paths) because X ships no stable hooks.
 *  - **Nothing may be trusted from the page.** User intents travel out over the private
 *    mfBus (see utils/mfBus.ts), never `document` events, so page scripts cannot forge
 *    the actions that spend the user's balance.
 *  - **Results stream in.** A claim can be on hold, queued, researching, or complete, and
 *    it moves between those states while on screen — so rendering is driven by claim
 *    state rather than by one-shot construction.
 */
import { Classification, QuotedClassification, Claim, TextSegment, Source, sameLanguage } from "../data/Classification";
import { normalizeSources } from "./intelligence";
import { breakupTweetText, breakupWithHighlights, resolveHighlightRange } from "./textBreakup";
import { mfBus } from "./mfBus";
import { codeToMessageKey } from "./errorCodes";
import disinfaxMarkRaw from "../public/black.svg?raw";

// ── Input mode (touch vs. pointer) ───────────────────────────────────────────

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

/** True right after a tap, with no real pointer movement since — mobile browsers
 *  synthesize mouseenter/mouseover for compatibility with hover-only UIs, which would
 *  otherwise pop open every hover popover (and leave it stuck, since a synthetic enter
 *  has no finger sitting there to later trigger a matching mouseleave). Every hover
 *  handler that shows/changes something must bail out when this is true. */
function isTouchInput(): boolean {
    return document.documentElement.classList.contains("is-touch-active");
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

/** Finish any positional substitution the browser's i18n left undone.
 *
 *  A named placeholder resolves to a positional token (`$VERDICT$` → `"$2"`), and the
 *  engine is then supposed to swap that token for the caller's substitution. Safari only
 *  applies the FIRST one, so a two-placeholder badge rendered as "Partially $2" — the raw
 *  token leaking into the UI. Chrome substitutes them all, so this finds nothing there and
 *  is a no-op.
 *
 *  Mirrors the `$n` handling in formatRawMessage: an index with no matching substitution
 *  is left exactly as-is rather than blanked, so a genuine mistake stays visible instead of
 *  silently producing truncated copy. */
function applyLeftoverSubs(message: string, subs?: string[]): string {
    if (!subs?.length || !message.includes('$')) return message;
    return message.replace(/\$(\d+)/g, (whole, num: string) => {
        const idx = parseInt(num, 10) - 1;
        return subs[idx] !== undefined ? subs[idx] : whole;
    });
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
            if (result) return applyLeftoverSubs(result, subs);
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
 *  Show original / Show translation toggle can swap the text unimpeded.
 *
 *  The segment wrap is never simply removed. It is the element renderSegmentedTweet built to
 *  hold the tweet body, so removing it deletes the text itself, leaving the post visibly empty.
 *
 *  Preferred path: put X's original child nodes back. renderSegmentedTweet detached rather than
 *  destroyed them, so these are the same objects X's renderer still points at — reattaching them
 *  gives its Show original / Show translation toggle something it can actually patch, and the
 *  text swaps language as it did before we ever rendered.
 *
 *  Fallback, when no originals were captured: freeze the wrap. That strips our highlights, badges
 *  and listeners while leaving the text and its links in place, so the reader sees the previous
 *  text rather than a blank tweet — correct content, possibly the pre-switch language.
 *
 *  Both paths leave no `.mf-segment-wrap` class behind (restoring drops the node, freezing
 *  declasses it), which is what upgradeToSegments keys off to choose a full rebuild over an
 *  in-place update — so the next render after the switch still rebuilds from scratch. */
function removeInjectedElements(tweetId: string) {
    const links = document.querySelectorAll(`a[href*="/status/${tweetId}"]`);
    for (const link of links) {
        const article = link.closest('article');
        if (!article) continue;
        for (const wrap of article.querySelectorAll<HTMLElement>('.mf-segment-wrap')) {
            const host = wrap.parentElement as (HTMLElement & { _mfOriginalNodes?: ChildNode[] }) | null;
            const originals = host?._mfOriginalNodes;
            if (host && originals?.length) {
                host.replaceChildren(...originals);
                // Cleared so the next render captures the nodes X owns after the switch,
                // not this now-stale set.
                delete host._mfOriginalNodes;
            } else {
                freezeSegmentWrap(wrap);
            }
        }
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
    for (const spinner of Array.from(wrap.querySelectorAll('.mf-standalone-spinner'))) spinner.remove();
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

// ── Teardown and freeze ──────────────────────────────────────────────────────

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

/** Returns true when EVERY highlighted claim of this tweet is fully inside the viewport.
 *
 *  This is the question the Fact-Checked button actually cares about: "can the user see the
 *  verdicts they just paid for?" — not isTweetVisible()'s "is any pixel of the article on
 *  screen?". A tweet taller than a screen counted as visible the moment its first line
 *  scrolled into view, which suppressed the button (and, once shown, cleared it 500ms later)
 *  while every highlight was still below the fold.
 *
 *  Falls back to isTweetVisible() when no highlight span is laid out — the claims may not be
 *  rendered yet, or may have matched no text — so behaviour is unchanged where this cannot
 *  answer. Quoted-tweet claims are covered too: their spans live inside the same article. */
function areTweetHighlightsVisible(tweetId: string): boolean {
    const links = document.querySelectorAll(`a[href*="/status/${tweetId}"]`);
    if (links.length === 0) return false;

    let sawLaidOutHighlight = false;

    for (const link of links) {
        const target = link.closest('article, div[role="link"], div[data-testid="card.wrapper"]') ?? link;
        const spans = target.querySelectorAll('span.mf-segment-claim');
        if (spans.length === 0) continue;

        let allVisible = true;
        let anyLaidOut = false;
        for (const span of spans) {
            const rect = span.getBoundingClientRect();
            // A zero-size rect means the span isn't laid out (collapsed/hidden subtree); it
            // carries no position to judge, so it neither confirms nor denies visibility.
            if (rect.height === 0 && rect.width === 0) continue;
            anyLaidOut = true;
            if (rect.top < 0 || rect.bottom > window.innerHeight) { allVisible = false; break; }
        }
        if (!anyLaidOut) continue;
        sawLaidOutHighlight = true;
        // Any single on-screen representation showing all its highlights is enough.
        if (allVisible) return true;
    }

    return sawLaidOutHighlight ? false : isTweetVisible(tweetId);
}

/** Which way the user has to scroll to reach this tweet's nearest off-screen highlight, or
 *  null when no highlight is laid out (caller then falls back to the article's own rect).
 *
 *  The floating button used to take its side and arrow from the article rect alone — "is the
 *  tweet's bottom above mid-screen?". Once the button started appearing for a single highlight
 *  slipping off an otherwise on-screen tweet, that inference broke: scrolling down a little
 *  pushes the first highlight off the TOP while the article's bottom is still well below the
 *  middle, so the button pinned itself to the bottom with a down arrow, pointing away from the
 *  content it was offering to return to.
 *
 *  Distance-ranked rather than order-ranked: on a tweet spilling past both edges, the nearest
 *  off-screen highlight is the one the user just lost and expects to get back. */
function offScreenHighlightDirection(tweetId: string): 'above' | 'below' | null {
    const links = document.querySelectorAll(`a[href*="/status/${tweetId}"]`);
    if (links.length === 0) return null;

    let nearestAbove = Infinity;
    let nearestBelow = Infinity;
    let sawLaidOutHighlight = false;

    for (const link of links) {
        const target = link.closest('article, div[role="link"], div[data-testid="card.wrapper"]') ?? link;
        for (const span of target.querySelectorAll('span.mf-segment-claim')) {
            const rect = span.getBoundingClientRect();
            if (rect.height === 0 && rect.width === 0) continue;
            sawLaidOutHighlight = true;
            if (rect.top < 0) nearestAbove = Math.min(nearestAbove, -rect.top);
            if (rect.bottom > window.innerHeight) nearestBelow = Math.min(nearestBelow, rect.bottom - window.innerHeight);
        }
    }

    if (!sawLaidOutHighlight) return null;
    if (nearestAbove === Infinity && nearestBelow === Infinity) return null;
    // Ties go up: the earliest claim in the tweet is the one that scrolls off the top first.
    return nearestAbove <= nearestBelow ? 'above' : 'below';
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

// ── Floating buttons and SPA navigation ──────────────────────────────────────
// x.com is a single-page app: it swaps routes without a page load, so injected UI
// has to be keyed by path and cleaned up on navigation rather than relying on
// unload. The registry below tracks each path's floating button for that reason.

/** Remove the floating button registered for `path`, unless it is still wanted and
 *  `force` is not set. */
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
                if (areTweetHighlightsVisible(newState.tweetId)) {
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
        if (isTouchInput()) return;
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
    if (areTweetHighlightsVisible(tweetId)) {
        console.log(`[misinfo] showFactCheckedFloatingButton ${tweetId}: all highlights visible, skipping`);
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

    // Point at whatever the user actually has to scroll towards. The off-screen highlight is
    // the reason this button exists, so it — not the article's midpoint — decides the side and
    // the arrow. Only when no highlight is laid out do we fall back to the old article-rect
    // inference: content above viewport => position 'top', arrow UP; below => 'bottom', DOWN.
    const highlightDirection = offScreenHighlightDirection(tweetId);
    const isTweetAbove = highlightDirection !== null
        ? highlightDirection === 'above'
        : (tweetRect ? tweetRect.bottom <= window.innerHeight / 2 : true);
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
                if (isTouchInput()) return;
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
        if (isTouchInput()) return;
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
        if (isTouchInput()) return;
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
            if (areTweetHighlightsVisible(tweetId)) {
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
        if (isTouchInput()) return;
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

    /** Done for the purposes of the Fact-Checked button: the claim has a VERDICT.
     *
     *  Deliberately does not wait on `note` (the reasoning). Reasoning and sources stream
     *  in afterwards and the popover renders them live, so gating on the note kept the
     *  button hidden long after the highlight had already settled on its final colour —
     *  the user could not be sent back to a tweet whose verdicts were, visibly, ready.
     *  The `verdict !== "research required"` guard stays: a claim can carry a DB-matched
     *  confidence/veracity while still awaiting its own research, and that must not count. */
    const hasVerdict = (cl: Claim) =>
        cl.verdict !== "research required"
        && cl.confidence !== undefined && cl.confidence !== null
        && cl.veracity !== undefined && cl.veracity !== null;

    /** Only a claim that is actually IN FLIGHT can hold the button back.
     *
     *  A claim sitting on hold is idle — it is waiting on the user's own Fact-Check click,
     *  not on a result — so it must not count as outstanding. Otherwise fact-checking one
     *  claim on a multi-claim tweet left the others permanently un-verdicted, the pending
     *  set never emptied, and the button never appeared at all for a partial check. */
    const isAwaitingVerdict = (cl: Claim) => !hasVerdict(cl) && cl.reclassifyOnHold !== true;

    for (const cl of allClaims) {
        if (isAwaitingVerdict(cl) && !state.pendingClaimTexts.has(cl.text)) {
            state.pendingClaimTexts.add(cl.text);
        }
    }

    // Clear anything that is no longer outstanding — either it produced a verdict, or it
    // went back on hold (a reverted/cancelled research), which makes it idle rather than
    // pending and must not strand the set at a non-zero size forever.
    for (const cl of allClaims) {
        if (!isAwaitingVerdict(cl)) {
            state.pendingClaimTexts.delete(cl.text);
        }
    }

    console.log(`[misinfo] updateOnHoldScrollTracking ${classification.id}: pending=${state.pendingClaimTexts.size}, anyFresh=${allClaims.some(cl => cl.freshlyResearched)}, tweetVisible=${isTweetVisible(classification.id)}, highlightsVisible=${areTweetHighlightsVisible(classification.id)}`);

    if (state.pendingClaimTexts.size === 0) {
        const anyCompleted = allClaims.some(hasVerdict);
        if (anyCompleted) {
            console.log(`[misinfo] updateOnHoldScrollTracking ${classification.id}: showing Fact-Checked button`);
            showFactCheckedFloatingButton(classification.id, state.originalScrollY, classification);
            // Tear the tracker down only once it has done its job.
            onHoldScrollStates.delete(classification.id);
        }
        // Otherwise: keep tracking. Nothing has a verdict yet, so there is nowhere to send
        // the user back to — but the click is still being worked on.
        //
        // Deleting here was the regression. In the moment after the Disinfact click every
        // claim is still flagged reclassifyOnHold, so isAwaitingVerdict() exempts all of
        // them, the pending set is empty, and no claim has a verdict yet. This branch then
        // destroyed the tracker before research had even begun, and every later update bailed
        // at the `!state` guard above — so the button could never appear at all. The set is
        // empty here for two opposite reasons ("not started" vs "all done"), and only the
        // second one means we are finished.
        //
        // Retaining it cannot leak: clearAllInjectedUi() clears onHoldScrollStates on
        // navigation, and the visibility interval dismisses a stale button on its own.
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

/** Main entry point: apply classifications to the page.
 *
 *  Called by the relay every time the background broadcasts a result, which means it runs
 *  many times for the same tweet as research streams in. It therefore merges each incoming
 *  classification against the copy already held, works out whether anything the user can
 *  see actually changed, and only then schedules a (debounced) re-render.
 *
 *  The two caches carry the full tweet text captured from the XHR payload — the DOM copy
 *  is truncated for long tweets, so claim offsets would not line up against it.
 *
 *  A no-op while the extension is frozen (signed out or out of credit). */
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
export function hasNonExtensionChange(m: MutationRecord): boolean {
    const nodes = [...Array.from(m.addedNodes), ...Array.from(m.removedNodes)];
    if (nodes.length === 0) return false;
    return nodes.some(n => !isOwnMutationNode(n));
}

/** Normalize a tweet body for comparison against another rendering of the same body.
 *
 *  Emoji are dropped. X does not render them as characters — it swaps each one for an
 *  element — and textContent concatenates text nodes only, so a DOM-derived string
 *  structurally cannot contain an emoji while the XHR payload always does. Left in, every
 *  tweet opening with one (👉 ⚡ 🇺🇸 ☀️ …) compares as different from itself. Stripping
 *  rather than trying to read them back out of the markup keeps this independent of how X
 *  chooses to render them, and costs only a little comparison signal: different languages
 *  still differ on their letters. */
function normalizeTweetTextForCompare(s: string): string {
    return htmlDecode(s)
        .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\u200D]/gu, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

/** Whether two renderings of the same tweet body can be the same text.
 *
 *  Deliberately permissive, because a mismatch is normal in two benign cases:
 *    - the DOM copy is TRUNCATED for long tweets (the XHR payload carries the full body)
 *      → the prefix check covers it
 *    - X renders a reply's leading @mention outside [data-testid="tweetText"], so the DOM
 *      text is a substring of the payload → the containment check covers it
 *  Either passing is enough. Genuinely different languages fail both. Under ~12 comparable
 *  characters there isn't enough signal to judge, so those are treated as compatible rather
 *  than risk suppressing a legitimate render. */
function tweetTextsCompatible(a: string, b: string): boolean {
    const x = normalizeTweetTextForCompare(a);
    const y = normalizeTweetTextForCompare(b);
    const compareLen = Math.min(24, x.length, y.length);
    if (compareLen < 12) return true;
    if (x.slice(0, compareLen) === y.slice(0, compareLen)) return true;
    return x.includes(y) || y.includes(x);
}

/** Split a tweet's text into claim / non-claim segments and store them on the
 *  classification, which is what promotes it from the fallback box (Phase 1) to inline
 *  highlights (Phase 2).
 *
 *  The text is taken from the captured XHR payload in preference to the DOM, because the
 *  DOM copy is truncated for long tweets and claim offsets are measured against the full
 *  body. Translated text wins when the tweet is being shown translated, since highlight
 *  ranges are stored per locale. Guarded against re-entry: this runs on every broadcast
 *  for a tweet, and overlapping runs would race to rewrite the same nodes. */
function kickOffTextBreakup(classification: Classification, tweetTextCache?: Map<string, string>, translatedTextCache?: Map<string, string>) {
    if (textBreakupInProgress.has(classification.id)) {
        console.log(`[misinfo] Text breakup: already in progress for ${classification.id}, skipping`);
        return;
    }
    textBreakupInProgress.add(classification.id);

    const claims = classification.claims ?? [];

    const domText = findTweetTextInDom(classification.id);

    // A cached translation can outlive the translated DOM. Reloading the page makes X render
    // the original text again, but the background keeps serving the classification object it
    // mutated when the translation was toggled on, so `translatedText`/`textLocale` still
    // describe the translated body. Those win the || chain below and select that locale's
    // highlight ranges, so the segments come out in a language the tweet is no longer showing
    // and upgradeToSegments correctly refuses to render them — the tweet loses its highlights
    // even though the displayed locale's ranges are cached and ready to use.
    //
    // Correct it only when the replacement key is UNAMBIGUOUS: exactly one highlight locale
    // other than the stale one, compared by base language so en/en-US aren't treated as
    // rivals. breakupWithHighlights checks only that a range is in BOUNDS, never that it
    // addresses the right words, and two languages' bodies are usually of similar length —
    // so picking wrongly between several candidates would highlight an arbitrary span and
    // attach a verdict to it, which is worse than showing none. Anything ambiguous is left
    // exactly as it was.
    const staleLocale = classification.textLocale ?? classification.translatedLocale;
    const baseLang = (l: string) => l.split('-')[0];
    let untranslated: { text: string; hlKey: string } | null = null;
    // Compared against X's own text, never `domText`: after the first render domText IS our
    // output, so a mismatch would be self-fulfilling — having once picked the untranslated
    // body we would keep re-picking it even after X switched the tweet back to the
    // translation, injecting the wrong language over the right one.
    const xOwnedText = findXOwnedTweetText(classification.id);
    if (classification.translatedText && xOwnedText
        && !tweetTextsCompatible(classification.translatedText, xOwnedText)) {
        // Skip translatedTextCache too: if the cached translation is stale, a translation
        // sourced from the same toggle is no more trustworthy. The payload text is preferred
        // over the DOM for the usual reason — the DOM copy is truncated for long tweets.
        const body = tweetTextCache?.get(classification.id) ?? xOwnedText;
        const candidates = new Set<string>();
        for (const cl of claims) {
            for (const key of Object.keys(cl.highlight ?? {})) {
                if (!staleLocale || baseLang(key) !== baseLang(staleLocale)) candidates.add(key);
            }
        }
        if (candidates.size === 1) {
            untranslated = { text: body, hlKey: [...candidates][0] };
            console.log(`[misinfo] Text breakup for ${classification.id}: cached ${staleLocale ?? 'unknown'} translation no longer matches the DOM — using the untranslated body with highlight key ${untranslated.hlKey}`);
        } else {
            console.log(`[misinfo] Text breakup for ${classification.id}: cached ${staleLocale ?? 'unknown'} translation no longer matches the DOM, but ${candidates.size} candidate highlight key(s) — leaving unchanged`);
        }
    }

    let tweetText = untranslated?.text
        || classification.translatedText
        || translatedTextCache?.get(classification.id)
        || tweetTextCache?.get(classification.id)
        || domText;

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

    const trailingMatch = tweetText.match(/\s+(https:\/\/t\.co\/\w+)\s*$/);
    if (trailingMatch && (!domText || !domText.includes(trailingMatch[1]))) {
        tweetText = tweetText.slice(0, trailingMatch.index).trim();
    }

    // When the stale translation was replaced above, the body is the untranslated one, so
    // the stale locale must go with it — keeping it would apply that locale's offsets to a
    // body they were never measured against.
    const textLocale = untranslated ? untranslated.hlKey : staleLocale;
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

/** Last-resort read of a tweet's text straight from the page, for when the captured XHR
 *  payload has no entry for it. Prefers X's `tweetText` testid and only then falls back to
 *  guessing at language/direction wrappers, since that heuristic can pick up neighbouring
 *  copy. Note the text may be truncated for long tweets. */
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

/** The tweet text X itself is showing, ignoring anything we rendered over it.
 *
 *  findTweetTextInDom reads the element's textContent, but once renderSegmentedTweet has run
 *  that element holds OUR segments — so comparing it against a cached translation compares our
 *  last decision with itself, and any wrong choice re-confirms itself on every later re-derive.
 *  renderSegmentedTweet parks X's displaced children in `_mfOriginalNodes`, and X keeps patching
 *  those nodes while they sit detached, so they remain an accurate record of what it is showing.
 *  Falls back to the live element whenever we have not rendered, which is the state every caller
 *  saw before this existed. */
function findXOwnedTweetText(tweetId: string): string | null {
    const article = document.querySelector(`a[href*="/status/${tweetId}"]`)?.closest('article');
    const el = article?.querySelector('[data-testid="tweetText"]') as
        (Element & { _mfOriginalNodes?: ChildNode[] }) | null | undefined;
    const originals = el?._mfOriginalNodes;
    if (originals?.length) {
        const text = originals.map(n => n.textContent ?? '').join('');
        if (text) return text;
    }
    return findTweetTextInDom(tweetId);
}

const textBreakupInProgress = new Set<string>();

/** Find the main status ID of an article element.
 *
 *  Links inside a quoted-tweet card are skipped. On a timeline card the first /status/
 *  link in DOM order is the timestamp permalink, so taking it outright was fine — but on
 *  a detail page X renders no permalink to the post you are already viewing, and the first
 *  link then belongs to the QUOTED card. That made the main tweet compare unequal to its
 *  own id in classificationInjections, marking it `isQuoted`, which suppressed its
 *  Disinfact button entirely (injectClassification returns early for quoted + onHold).
 *
 *  `div[role="link"]` is the quoted-card wrapper — the same landmark findTweetTextElement
 *  already keys off — and the containment check keeps the search inside this article. When
 *  every link sits in a card we return null, which callers already read as "not quoted".
 */
function getArticleMainStatusId(article: Element): string | null {
    for (const link of article.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]')) {
        const quotedCard = link.closest('div[role="link"]');
        if (quotedCard && article.contains(quotedCard)) continue;
        const match = link.href.match(/\/status\/(\d+)/);
        if (match) return match[1];
    }
    return null;
}

/** Locate every on-screen occurrence of each classification's tweet and inject into it.
 *
 *  A tweet can appear more than once on a page (timeline plus a quoted card, say), so this
 *  walks all status links rather than assuming one match, and derives whether each match is
 *  the main tweet or a quoted one from its position in the article. */
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

/** The localized pool of "being fact-checked" words, supplied as a single
 *  pipe-delimited message so translators can vary the count per language. */
function researchingWordsList(): string[] {
    return t("researchingWords").split("|").map(word => word.trim()).filter(Boolean);
}

/** One word from the researching pool, held stable for a given `seed` so a claim
 *  keeps the same word across re-renders instead of flickering between them. */
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

/** The badge text for a claim, built from its two scores.
 *
 *  Layers up to two adjectives onto "True"/"False": one for how confident the model is
 *  (Very Likely / Likely / Possibly) and one for the degree of truth (Mostly / Arguably /
 *  Partially / Equivocally). Either is dropped when the score is emphatic enough (≥0.9)
 *  that a qualifier would only add noise, so a strong result reads simply as "True".
 *
 *  An undefined `probability` means research hasn't produced a verdict yet, which shows a
 *  researching word instead; `seed` keeps that word stable (see pickResearchingWord).
 *  Composition order is locale-dependent, hence the badgeAdjVerdict / badgeVerdictAdj
 *  message keys rather than string concatenation. */
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

    // A veracity of exactly 0 reads as "false", matching formatVerdict/payloadToClaim.
    const verdict = veracity > 0 ? trueLabel : falseLabel;

    if (!probKey && !verKey) return verdict;
    if (probKey && !verKey) return t("badgeVerdictAdj", [verdict, t("adj" + probKey)]);
    if (!probKey && verKey) return t("badgeAdjVerdict", [t("adj" + verKey), verdict]);
    return probKey === "VeryLikely"
        ? t("badgeAdjVerdictAdj2Verbose", [t("adj" + verKey), verdict, t("adj" + probKey)])
        : t("badgeAdjVerdictAdj2", [t("adj" + verKey), verdict, t("adj" + probKey)]);
}

/** Colour shown when a claim has no usable scores (not yet researched, or too uncertain). */
const NEUTRAL_VERDICT_CHANNELS: readonly [number, number, number] = [128, 128, 128];

/** Map a claim's two scores onto an RGB triple.
 *
 *  Veracity picks the hue along red (false) → yellow → green (true). Confidence then acts
 *  as saturation: the colour is blended toward its own luminance, so a low-confidence
 *  verdict fades toward grey rather than asserting itself in strong red or green.
 *
 *  Falls back to neutral grey when either score is absent or confidence sits below the
 *  0.2 "unknown" floor. Shared by factCheckColor and confidenceRgba, which differ only
 *  in the CSS they wrap around these channels. */
function verdictColorChannels(probability: number | undefined, veracity?: number): readonly [number, number, number] {
    if (probability === undefined || veracity === undefined || probability === null || veracity === null || probability < 0.2)
        return NEUTRAL_VERDICT_CHANNELS;

    const clampedVeracity = Math.max(-1, Math.min(1, veracity));
    /** 0 = fully false, 0.5 = neutral, 1 = fully true. */
    const truthFraction = (clampedVeracity + 1) / 2;
    const saturation = Math.max(0, Math.min(1, probability));

    let r: number, g: number, b: number;
    if (truthFraction <= 0.5) {
        // Red → yellow across the false half.
        const ramp = truthFraction / 0.5;
        r = 255;
        g = Math.round(255 * ramp);
        b = 0;
    } else {
        // Yellow → green across the true half.
        const ramp = (truthFraction - 0.5) / 0.5;
        r = Math.round(255 * (1 - ramp));
        g = 255;
        b = 0;
    }

    // Rec. 601 luminance, the grey this hue desaturates toward.
    const luminance = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    return [
        Math.round(luminance + (r - luminance) * saturation),
        Math.round(luminance + (g - luminance) * saturation),
        Math.round(luminance + (b - luminance) * saturation),
    ];
}

/** Inline `background` + `color` declarations for a verdict badge. */
function factCheckColor(probability: number | undefined, veracity?: number, bgOpacity = 0.15): string {
    const [r, g, b] = verdictColorChannels(probability, veracity);
    return `background: rgba(${r}, ${g}, ${b}, ${bgOpacity}); color: rgb(${r}, ${g}, ${b})`;
}

/** A verdict's colour as a bare `rgba(...)` value, for callers composing their own CSS. */
function confidenceRgba(probability: number | undefined, opacity: number, veracity?: number): string {
    const [r, g, b] = verdictColorChannels(probability, veracity);
    return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

function extractReasoning(note: string | null | undefined, probability: number | undefined, veracity?: number): string {
    if (!note) return "";
    if (probability === undefined) return note;
    const prefix = verdictLabel(probability, veracity) + ": ";
    if (note.startsWith(prefix)) return note.slice(prefix.length);
    return note;
}

// ── Fallback rendering (Phase 1): claims shown in a box below the tweet ──────

/** Build the fallback claim box shown beneath a tweet: one row per claim with its verdict
 *  badge. Used before segments exist, and permanently for claims whose text could not be
 *  located in the tweet body (so they still get a verdict the user can read). */
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

// ── Inline segment rendering (Phase 2): claims highlighted in the tweet text ─

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
/* Narrow viewports (phones) run out of room on the action row that X already packs with
   its own controls, so the Disinfact / Fact-Check All buttons get squeezed or pushed to
   wrap. Reclaim the horizontal padding X's button classes apply — the tap target stays
   full-height, only the dead space either side of the label shrinks.

   The container's own margin (MF_BTN_GAP, applied inline at placement time) is the larger
   share of the visible gap, and an inline style can only be beaten with !important — which
   is why targeting just the buttons left the spacing looking unchanged. Scoped to our own
   elements via .mf-btn-container / data-mf-charge so nothing of X's is touched. */
@media (max-width: 500px) {
    /* NOTE: the container's MARGIN is deliberately not set here. It is written inline at
       placement time (see MF_BTN_GAP_NARROW in placeButtonContainer), because overriding an
       inline margin from this stylesheet proved unreliable in practice — inspecting a live
       button showed the original inline 10px still winning over an !important rule. Padding
       below is class-derived, so it overrides normally. */
    /* The button AND its inner div[dir="ltr"] both carry X's own button classes, and both
       contribute padding — zeroing only the outer left most of the gap in place. */
    [data-mf-charge="disinfact"],
    [data-mf-charge="factcheckall"],
    [data-mf-charge="disinfact"] > div,
    [data-mf-charge="factcheckall"] > div {
        padding-left: 0 !important;
        padding-right: 0 !important;
        margin-left: 0 !important;
        margin-right: 0 !important;
        min-width: 0 !important;
        column-gap: 0 !important;
    }
    /* Degrade to an ellipsis rather than overflowing once it does have to give way. */
    [data-mf-charge="disinfact"] > div > span,
    [data-mf-charge="factcheckall"] > div > span {
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
        min-width: 0 !important;
    }
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
        + `<span style="font-size:0.6em;font-weight:600;line-height:1;margin:0 0.5px 0 1px;position:relative;top:1px;">US</span>`
        + `<span style="font-weight:600;line-height:1;">$</span>`
        + `${n}`
        + `</span>`;
}

/** Show a balance-change (green ↑ / orange ↓) or error (red) notification. Auto-dismisses after 5s. */
export function showNotification(kind: 'increase' | 'decrease' | 'error', opts: { amount?: number; text?: string; code?: number }) {
    if (extensionFrozen) return;
    if (!document.body) return;
    const container = getNotifContainer();
    const el = document.createElement('div');
    el.className = 'mf-notif';
    const { bg, fg } = notifColor(kind);
    el.style.backgroundColor = bg;
    el.style.color = fg;
    if (kind === 'error') {
        // A recognized error code (see utils/errorCodes.ts) takes this extension's own
        // localized text over whatever the backend sent; opts.text is pre-resolved
        // plain text for everything else (client-detected conditions, or a worker
        // error the parser couldn't map to a code).
        const messageKey = opts.code != null ? codeToMessageKey(opts.code) : null;
        const resolvedText = messageKey ? t(messageKey) : opts.text;
        if (!resolvedText) return;
        el.textContent = resolvedText;
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
// clicked, warning that using it spends balance. An "×" permanently dismisses just
// that popover's type (same effect as clicking its charge button); other types are
// unaffected, since e.g. Fact-Check and Fact-Check All are separate buttons that
// happen to share a purpose. z-index sits above
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
    try { browser.storage.local.set({ [ONBOARD_CLICKED_KEY]: Array.from(onboardingClickedTypes) }).catch(() => { /* ignore */ }); } catch { /* ignore */ }
}
function markOnboardingClicked(type: string) {
    if (!type || onboardingClickedTypes.has(type)) return;
    onboardingClickedTypes.add(type);
    persistOnboardingClicked();
    refreshOnboarding();
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
    close.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); markOnboardingClicked(type); });
    el.appendChild(close);
    makeDraggable(el);
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
    // Disinfact / Fact-Check All specifically prefer opening ABOVE their button when
    // there's no room to the right, before falling back below — translate-tweet (which
    // reuses the Disinfact label/slot) keeps the original right-then-below behavior,
    // matching what was explicitly asked for rather than guessing it in too.
    const preferAbove = type === 'disinfact' || type === 'factcheckall';
    positionOnboardingPopover(pop, anchor, preferAbove);
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
        if (isTouchInput()) return;
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
    browser.storage.local.get([ONBOARD_DISMISS_KEY, ONBOARD_CLICKED_KEY]).then((res: any) => {
        if (res) {
            onboardingDismissed = res[ONBOARD_DISMISS_KEY] === true;
            if (Array.isArray(res[ONBOARD_CLICKED_KEY])) for (const x of res[ONBOARD_CLICKED_KEY]) onboardingClickedTypes.add(String(x));
        }
        refreshOnboarding();
    }).catch(() => { refreshOnboarding(); });
} catch { /* ignore */ }

// Debug/testing: react live when the onboarding state is reset from the EXTENSION
// side, so every popover reappears without a page reload — as if no button had ever
// been clicked or dismissed. Reset from the extension's service-worker console with:
//   chrome.storage.local.remove(['mf_onboarding_dismissed', 'mf_onboarding_clicked_types'])
// (Extension storage, so the host page can't touch it — same as the mfLocale hook.)
try {
    browser.storage.onChanged.addListener((changes: any, area: string) => {
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

// ── Locating tweets in X's DOM ───────────────────────────────────────────────
// X exposes no stable identifiers for the text of a tweet, so these helpers work
// from structural landmarks — the status link for a given id, role/testid
// containers, text direction wrappers. They are the most breakage-prone code in
// the extension and are written to fail closed (return null) rather than guess.

/** Find the element holding a tweet's body text within `article`, or null when the
 *  structure doesn't match. `isQuoted` looks inside the nested quoted-tweet card
 *  instead of the outer tweet. */
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

/** Rebuild a tweet's text element from `segments`, wrapping claim segments in interactive
 *  highlight spans and leaving the rest as plain text.
 *
 *  X renders links with display text that differs from the href (shortened URLs, @mentions),
 *  so existing anchors are captured first and restored as the text is rewritten — otherwise
 *  rebuilding the element would turn every link into a raw URL. */
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

    console.log(`[misinfo] renderSegmentedTweet ${classificationId ?? '?'}: captured ${urlDisplayMap.size} link(s) from X: ${[...urlDisplayMap].map(([h, t]) => `${t} -> ${h}`).join(' | ') || 'none'}`);

    const wrap = buildSegmentWrap(segments, claims, batchId, urlDisplayMap, classificationId);
    // Keep X's own child nodes alive. `innerHTML = ""` detaches them, it does not destroy them,
    // and X's renderer still holds references to those exact node objects. Handing the same
    // objects back on teardown is what lets its Show original / Show translation toggle repaint;
    // clones or re-parsed HTML would be new nodes it has never seen. Captured once — on a
    // re-render the children are already ours, and overwriting would lose the originals.
    const host = tweetTextEl as Element & { _mfOriginalNodes?: ChildNode[] };
    if (!host._mfOriginalNodes) host._mfOriginalNodes = Array.from(tweetTextEl.childNodes);
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
    // Only external links open a new tab. Mentions and hashtags carry a relative href
    // ("/TheAthletic") and X navigates those in place; forcing _blank on them would
    // spawn a tab for something that used to be an in-app route.
    if (/^https?:\/\//i.test(href)) a.target = "_blank";
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

/** Build a DocumentFragment for a plain text segment, converting URLs, @mentions and
 *  #hashtags back into <a> elements.
 *
 *  Mentions and hashtags are not URLs — they appear in the tweet body as bare text, and X
 *  links them to a relative route ("/TheAthletic"). renderSegmentedTweet already records
 *  them in urlDisplayMap, but keyed by href with the display text as the value, so a
 *  by-URL lookup never finds them and the rebuild dropped the link. They are matched by
 *  display text against a reverse index instead, and a token with no entry there is left
 *  as plain text: every link written here is one X had, never one we inferred. */
function buildPlainSegmentContent(text: string, urlDisplayMap: Map<string, string>): DocumentFragment {
    const fragment = document.createDocumentFragment();
    const hrefByDisplayText = new Map<string, string>();
    for (const [href, display] of urlDisplayMap) hrefByDisplayText.set(display, href);
    // The URL branch is first so it wins on shared characters; the second branch stops at
    // punctuation so trailing ":" or "," in "From @TheAthletic:" stays outside the link.
    const tokenRegex = /https?:\/\/[^\s<>"'`]+|[@#$][^\s<>"'`.,;:!?()[\]{}]+/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = tokenRegex.exec(text)) !== null) {
        const token = match[0];
        const isUrl = /^https?:\/\//i.test(token);
        // Prefer the href X used. When it has none, derive it from X's own URL scheme rather
        // than dropping the link: a translated tweet body is re-rendered by X from plain
        // translated text, so the mention that was an <a> in the original may be bare text
        // in the translation — there is nothing to copy, but "@handle" unambiguously means
        // x.com/handle. Only these two forms are derived; anything else stays plain text.
        //
        // Deriving additionally requires a word boundary before the token, which a copied
        // href does not: X only treats "@name" as a mention at the start of a word, and
        // without the check the "@example" inside "contact@example.com" becomes a profile
        // link. A map hit means X really did render a link at that spot, so it is trusted
        // as-is.
        const prevChar = match.index > 0 ? text[match.index - 1] : '';
        const atWordBoundary = !/[\p{L}\p{N}_]/u.test(prevChar);
        const href = isUrl
            ? token
            : (hrefByDisplayText.get(token)
                ?? (atWordBoundary && /^@[A-Za-z0-9_]{1,15}$/.test(token) ? `/${token.slice(1)}` : undefined)
                ?? (atWordBoundary && token.startsWith('#') && token.length > 1 ? `/hashtag/${encodeURIComponent(token.slice(1))}` : undefined));
        if (!href) continue;
        if (match.index > lastIndex) {
            fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
        }
        const displayText = isUrl ? (urlDisplayMap.get(token) ?? token) : token;
        fragment.appendChild(createLinkElement(href, displayText));
        lastIndex = tokenRegex.lastIndex;
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
            // `confidence < 0.2` alone used to mean "still researching", which conflated two
            // very different states: a claim that has never been researched, and one that
            // HAS been researched and honestly came back uncertain (the model's web search
            // failing yields a real result of confidence 0 with a reasoning note). Treating
            // the second as unresearched reverted its badge to "Fact-Check", so the user
            // clicked again, was charged again, got the same zero-confidence answer, and
            // could loop indefinitely — paying every time for a claim that can never resolve.
            //
            // A note is the completion signal: unresearched claims carry none. Low
            // confidence with a note now renders as an Unknown verdict (verdictLabel already
            // handles < 0.2) instead of pretending the work never happened.
            const hasResearchNote = claim.note !== undefined && claim.note !== null && String(claim.note).trim() !== "";
            const isResearching = claim.verdict === "research required" || claim.refreshing || claim.confidence === undefined || claim.veracity === undefined || claim.confidence === null || claim.veracity === null || (claim.confidence < 0.2 && !hasResearchNote);
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
                // Same conflation as `isResearching` above, but this is the one that actually
                // decides the badge TEXT: without the note check, a researched-but-uncertain
                // claim satisfies isPipelineClaim and gets relabelled "Fact-Check", even though
                // verdictLabel() would correctly render it as Unknown, and even though its
                // popover is already showing the reasoning that proves it was researched.
                const isResearchingNow = isRefreshing || prob === undefined || ver === undefined
                    || (prob < 0.2 && !hasResearchNote);
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
            } else if (claim.refreshing || isResearching) {
                // The badge carries the spinner, but the badge itself is only permanent for
                // on-hold / in-pipeline claims — a RECLASSIFY (claim.refreshing) shows no
                // badge at all, so on touch, where there is no hover to summon one, the
                // highlight gave no sign it was working. Stand in a bare spinner so every
                // loading state is visible. Removed again by the badge-toggle handlers below
                // (so the two never show at once) and by the next re-render once the result
                // lands, since this whole block re-runs with refreshing/isResearching false.
                span.appendChild(createStandaloneSpinner(isRTL));
            }

            // Exposed so showPopover can create the same badge on a tap — mouseenter
            // never fires there (isTouchInput() bails it out), so without this a
            // touch tap opens the popover with no badge, since it only ever existed
            // as a hover effect.
            (span as any)._mfCreateBadge = createInlineBadge;

            span.addEventListener("mouseenter", () => {
                if (isTouchInput()) return;
                if (span.querySelector(".mf-inline-badge")) return;
                if (span.dataset.hoverBg) {
                    span.style.backgroundColor = span.dataset.hoverBg;
                }
                // The hover badge carries its own spinner, so drop the stand-in first —
                // otherwise a loading claim would briefly show two.
                span.querySelector(".mf-standalone-spinner")?.remove();
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
                // Restore the stand-in if this claim is still loading — the badge that was
                // showing the spinner has just been taken away with the hover.
                const stillLoading = span.dataset.refreshing === "true" || noVerdict;
                if (stillLoading && !span.querySelector(".mf-standalone-spinner")) {
                    span.appendChild(createStandaloneSpinner(isRTLLocale(getEffectiveUILocale())));
                }
            });

            wrap.appendChild(span);
        }
    }

    return wrap;
}

/** Promote one already-injected tweet from the Phase 1 fallback box to Phase 2 inline
 *  highlights, once segments are available. Bails out quietly when there is nothing to
 *  upgrade or the tweet's text element can no longer be found in X's DOM. */
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
                // `confidence < 0.2` alone used to mean "still researching", which conflated two
            // very different states: a claim that has never been researched, and one that
            // HAS been researched and honestly came back uncertain (the model's web search
            // failing yields a real result of confidence 0 with a reasoning note). Treating
            // the second as unresearched reverted its badge to "Fact-Check", so the user
            // clicked again, was charged again, got the same zero-confidence answer, and
            // could loop indefinitely — paying every time for a claim that can never resolve.
            //
            // A note is the completion signal: unresearched claims carry none. Low
            // confidence with a note now renders as an Unknown verdict (verdictLabel already
            // handles < 0.2) instead of pretending the work never happened.
            const hasResearchNote = claim.note !== undefined && claim.note !== null && String(claim.note).trim() !== "";
            const isResearching = claim.verdict === "research required" || claim.refreshing || claim.confidence === undefined || claim.veracity === undefined || claim.confidence === null || claim.veracity === null || (claim.confidence < 0.2 && !hasResearchNote);
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
                // Whether this span carries the "always show the badge regardless of
                // hover" flag, checked before any of the mutations below might flip it.
                // A flip here means mouseenter/mouseleave will start (or stop) treating
                // this span specially — if the pointer is genuinely resting on it right
                // now, that's exactly the "state changed under a stationary cursor" case
                // resyncHoverAtPointer exists for, so it must fire even when `changed`
                // (below) stays false, or the hover tint/badge can stick until the span
                // is rebuilt from scratch (e.g. by scrolling away and back).
                const hadPermanentBadge = !!(el as any)._mfBadgePermanent;
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

                // Keep the stand-in spinner in sync on the IN-PLACE update path (this runs
                // without a full re-render, so it is what makes the spinner appear when a
                // reclassify starts and vanish the moment the result lands). It is only ever
                // shown when no badge is present, since the badge carries its own spinner.
                {
                    const loadingNow = el.dataset.refreshing === "true" || isResearching;
                    const hasBadge = !!el.querySelector(".mf-inline-badge");
                    const standalone = el.querySelector(".mf-standalone-spinner");
                    if (loadingNow && !hasBadge && !standalone) {
                        el.appendChild(createStandaloneSpinner(isRTLEl));
                    } else if ((!loadingNow || hasBadge) && standalone) {
                        standalone.remove();
                    }
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
                // instead of waiting for a manual mouse-out/in. `changed` alone misses a
                // pure on-hold/pipeline-researching transition (see hadPermanentBadge
                // above), so a permanent-badge flip forces the same replay.
                const hasPermanentBadgeNow = !!(el as any)._mfBadgePermanent;
                if (changed || hadPermanentBadge !== hasPermanentBadgeNow) resyncHoverAtPointer(el);
            }
            console.log(`[misinfo] upgradeToSegments: updated ${updated}/${existingClaimSpans.length} claim spans for ${classification.id}`);
            updateOpenPopover();
            return;
        }
    }

    // Diagnostic for the hover-freeze bug: a full rebuild (as opposed to the in-place
    // update path above, which explicitly calls resyncHoverAtPointer for exactly this
    // reason) never re-syncs hover state for the freshly created spans. If the pointer
    // is sitting over this tweet's text right when a rebuild fires — most likely because
    // the host page's own re-render replaced our injected markup out from under us —
    // that's a real candidate for the freeze, since the old span's real mouseenter state
    // dies with the removed node and the new span never gets an equivalent one.
    // SAFETY: a full rebuild does `tweetTextEl.innerHTML = ""` and writes OUR segment text,
    // destroying whatever the host page currently has there. That is only ever correct when
    // our segments were derived from the same text the page is showing. If they weren't, we
    // would overwrite the tweet with different words — e.g. the user asks X to translate a
    // post to Dutch, X swaps the text (removing our wrap), our MutationObserver sees a
    // host-page change and re-injects, and the stale ENGLISH segments get written on top of
    // the Dutch. For a fact-checking extension, putting words in someone's tweet that they
    // did not post is the worst failure mode available, so bail out instead.
    //
    // See tweetTextsCompatible for the permissiveness rationale and for why emoji are
    // dropped from both sides. kickOffTextBreakup uses that same predicate to decide whether
    // a cached translation still describes the displayed body, so the two cannot disagree
    // about what "the same text" means.
    const segmentsText = segments.map(s => s.text).join('');
    const domTextNow = tweetTextEl.textContent ?? '';
    if (!tweetTextsCompatible(segmentsText, domTextNow)) {
        console.warn(`[misinfo] upgradeToSegments: SKIPPING full rebuild for ${classification.id} — segments do not match the text currently in the DOM (probably a host-page translation swap). segments="${normalizeTweetTextForCompare(segmentsText).slice(0, 40)}..." dom="${normalizeTweetTextForCompare(domTextNow).slice(0, 40)}..."`);
        return;
    }

    // NOTE: there was briefly a second guard here that also skipped the rebuild when the
    // segments covered materially LESS text than the DOM, meant to stop a partial
    // mid-translation snapshot from truncating a post. It was WRONG and is deliberately gone:
    // the DOM element legitimately holds more text than the authoritative XHR payload in
    // normal layouts (observed 429 chars in the DOM vs 255 in the payload on an ordinary
    // detail-view tweet), so it suppressed correct, fully-classified highlights — the user
    // paid for a classification and saw nothing, with the on-hold button stuck on.
    //
    // The case it was defending against is already handled at the source: the locale watcher
    // in relay.content.ts now waits for X's streamed translation to STOP CHANGING before
    // snapshotting, so a partial snapshot never becomes `translatedText` in the first place.
    // The prefix/containment check above remains, and is what actually catches a genuine
    // wrong-language mismatch.

    const rectAtRebuild = tweetTextEl.getBoundingClientRect();
    const pointerInsideAtRebuild = mfPointerX >= rectAtRebuild.left && mfPointerX <= rectAtRebuild.right
        && mfPointerY >= rectAtRebuild.top && mfPointerY <= rectAtRebuild.bottom;
    console.log(`[misinfo] upgradeToSegments: upgrading ${classification.id} with ${segments.length} segments (full rebuild, pointerInsideTweetText=${pointerInsideAtRebuild})`);
    injectStyles();
    renderSegmentedTweet(tweetTextEl, segments, claims, batchId, classification.id);

    // If the pointer was already resting over this tweet (see the diagnostic above),
    // the just-destroyed old span's hover state died with it and the freshly built
    // replacement never got an equivalent mouseenter — resync it now, same as the
    // in-place update path does for its own state-changed-under-cursor case.
    if (pointerInsideAtRebuild) {
        for (const freshSpan of tweetTextEl.querySelectorAll<HTMLElement>(".mf-segment-claim")) {
            resyncHoverAtPointer(freshSpan);
        }
    }

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

    window.addEventListener("beforeprint", enterPrintMode);
    window.addEventListener("afterprint", exitPrintMode);

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
        if (isTouchInput()) return;
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

    // Draggable for the real (pinned) popover only — not the transient hover preview,
    // whose position is tied to hover/pin bookkeeping (leave timers, opacity mirroring)
    // that dragging would fight with.
    if (!isPreview) makeDraggable(popover);

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
        console.log(`[misinfo] onClose: targetTrigger connected=${targetTrigger.isConnected}, hadBadge=${!!targetTrigger.querySelector(".mf-inline-badge")}, bgBefore=${targetTrigger.style.backgroundColor}`);
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
        console.log(`[misinfo] onClose: bgAfter=${targetTrigger.style.backgroundColor}, stillHasBadge=${!!targetTrigger.querySelector(".mf-inline-badge")}`);
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

// ── Popovers (verdict detail and previews) ───────────────────────────────────

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
        // Normally the badge is a hover effect (span mouseenter); a tap never hovers, so
        // without this the popover would open with no badge on a touch device. closePopover
        // already removes a non-permanent one, so it's safe to (re)create it here.
        if (!trigger.querySelector(".mf-inline-badge") && (trigger as any)._mfCreateBadge) {
            trigger.appendChild((trigger as any)._mfCreateBadge(trigger.dataset.reclassifyOnHold === "true"));
        }
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
            if (isTouchInput()) return;
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
                    if (isTouchInput()) return;
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
                if (isTouchInput()) return;
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
                        if (isTouchInput()) return;
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
                    if (isTouchInput()) return;
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

    ensurePopoverDisclaimer(popover);
}

/** Append the AI-accuracy disclaimer, or move it back to the end if it already exists.
 *
 *  appendChild() on a node that is already a child MOVES it, which is what keeps this last:
 *  addSourcesToPopover removes and re-appends the sources row as sources stream in, so a
 *  disclaimer added once at build time would end up above them. No `text-align` is set so it
 *  inherits the popover's `dir`, which is set to rtl for RTL locales. */
function ensurePopoverDisclaimer(popover: HTMLElement) {
    let el = popover.querySelector<HTMLElement>(".mf-popover-disclaimer");
    if (!el) {
        el = document.createElement("div");
        el.className = "mf-popover-disclaimer";
        el.style.cssText = "margin-top: 6px; font-size: 9px; line-height: 1.35; opacity: 0.6;";
        el.textContent = t("aiDisclaimer");
    }
    popover.appendChild(el);
}

/** A bare spinner shown inline where the badge would be, for loading states that do not
 *  get a permanent badge (notably a reclassify). Mirrors the badge's own margins so the
 *  highlight's layout is identical whichever of the two is present. */
function createStandaloneSpinner(isRTL: boolean): HTMLElement {
    const spinner = document.createElement("span");
    spinner.className = "mf-fc-spinner mf-standalone-spinner";
    spinner.style.marginLeft = isRTL ? "0" : "3px";
    spinner.style.marginRight = isRTL ? "3px" : "0";
    spinner.style.verticalAlign = "middle";
    return spinner;
}

/** Get the bounding rectangle of the Fact-Checked floating button if it exists. */
function getFactCheckedButtonRect(): DOMRect | null {
    const btn = document.querySelector<HTMLElement>(".mf-floating-scroll-btn");
    return btn?.getBoundingClientRect() ?? null;
}

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
/** Makes a fixed/absolutely-positioned popover draggable by its background — not by
 *  its text, links, buttons, or the close icon, which keep working exactly as before
 *  (clicking and text selection are never hijacked). A small movement threshold tells
 *  an actual drag apart from a click; if a real text selection grows during that
 *  threshold check, the gesture is treated as a selection instead and the drag is
 *  abandoned.
 *
 *  A drag is recorded two ways, because the two popover families are positioned in different
 *  coordinate spaces. `_mfManuallyPositioned` makes positionPopover stop repositioning the
 *  claim popover — safe there, since it is position:absolute inside the timeline container,
 *  so fixed coordinates still scroll with the content. `_mfDragDx/_mfDragDy` record the same
 *  drag as an offset, which positionOnboardingPopover re-applies on top of its recomputed
 *  position — necessary there, since those are position:fixed in viewport coordinates and
 *  must keep tracking their button on scroll. */
/** Re-stack a claim popover's attached onboarding popovers (translate / refresh) directly
 *  below it. Position-only — opacity and create/destroy stay with
 *  refreshInPopoverOnboarding, which owns them. Used during a drag, where that heavier
 *  function must not run on every pointermove. */
function repositionAttachedOnboardingFor(claimPop: HTMLElement) {
    const attached = Array.from(document.querySelectorAll<HTMLElement>('.mf-onboard-attached'))
        .filter(op => (op as any)._mfClaimPop === claimPop);
    if (attached.length === 0) return;
    // Same stacking order refreshInPopoverOnboarding uses: translations above refreshes.
    const order = ['translate-inner', 'refresh-inner'];
    attached.sort((a, b) => order.indexOf(a.dataset.mfOnboard ?? '') - order.indexOf(b.dataset.mfOnboard ?? ''));
    let top = claimPop.offsetTop + claimPop.offsetHeight + 8;
    const left = claimPop.offsetLeft;
    for (const op of attached) {
        op.style.left = `${left}px`;
        op.style.top = `${top}px`;
        top += op.offsetHeight + 8;
    }
}

function makeDraggable(el: HTMLElement) {
    let startX = 0, startY = 0, startLeft = 0, startTop = 0, active = false, moved = false;
    let pointerId = -1;
    /** The element whose position the drag actually mutates — see pointerdown. */
    let anchor: HTMLElement = el;
    /** Drag offset the anchor already carried when this drag began, so repeated drags
     *  accumulate rather than reset. See `_mfDragDx/_mfDragDy` below. */
    let baseDx = 0, baseDy = 0;

    const onMove = (e: PointerEvent) => {
        if (!active || e.pointerId !== pointerId) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (!moved) {
            if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
            if (window.getSelection()?.toString()) { endDrag(); return; }
            moved = true;
        }
        e.preventDefault();
        anchor.style.left = `${startLeft + dx}px`;
        anchor.style.top = `${startTop + dy}px`;
        (anchor as any)._mfManuallyPositioned = true;
        // Also record the drag as a cumulative OFFSET FROM THE ANCHOR'S COMPUTED POSITION.
        // positionPopover freezes on _mfManuallyPositioned, which is fine for the claim
        // popover: it is position:absolute inside the timeline container, so frozen
        // coordinates still scroll with the content. Standalone onboarding popovers are
        // position:FIXED in viewport coordinates and recomputed from their button's rect on
        // every scroll — freezing those left them welded to the viewport while the tweet
        // scrolled away. positionOnboardingPopover therefore keeps recomputing and re-applies
        // this offset instead, so a dragged popover both keeps the user's placement AND
        // continues to track its button.
        (anchor as any)._mfDragDx = baseDx + dx;
        (anchor as any)._mfDragDy = baseDy + dy;
        // Attached onboarding popovers are extensions of the claim popover, so the whole
        // group travels together. They are positioned FROM the anchor, so this covers both
        // directions: dragging the claim popover carries them along, and dragging one of
        // them moves the anchor (see pointerdown) which then re-stacks the rest.
        repositionAttachedOnboardingFor(anchor);
    };

    /** Idempotent: reached via pointerup, pointercancel, or lostpointercapture. */
    const endDrag = () => {
        if (!active) return;
        active = false;
        if (pointerId !== -1) {
            try { if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId); } catch { /* already gone */ }
            pointerId = -1;
        }
    };

    // Listeners live on `el`, not on document, and the drag uses POINTER CAPTURE.
    //
    // Both matter. buildPopoverShell attaches its own listener that calls
    // e.stopPropagation() for "pointerup" (among others) on the popover, to keep the host
    // page from reacting to interactions inside it. A document-level pointerup listener
    // therefore never fires, because the release happens over the popover and is stopped
    // there — which left the popover glued to the cursor after release. Listening on `el`
    // itself is immune to that: stopPropagation only blocks ANCESTORS, never other
    // listeners on the same node (that would need stopImmediatePropagation).
    //
    // Pointer capture then guarantees we still get the move/up events when the cursor
    // outruns the popover mid-drag or leaves the window entirely — without it, those
    // events would target whatever is under the cursor instead and the drag would hang.
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", endDrag);
    el.addEventListener("pointercancel", endDrag);
    el.addEventListener("lostpointercapture", endDrag);

    el.addEventListener("pointerdown", (e) => {
        // Touch stays a scroll gesture, never a drag — only mouse/pen moves the popover.
        if (e.pointerType === "touch") return;
        if (e.button !== 0) return;
        const target = e.target as HTMLElement;
        if (target.closest('button, a, input, textarea, [contenteditable], .mf-popover-text, .mf-popover-sources-row, .mf-popover-close')) return;
        // An attached onboarding popover is an extension of its claim popover, not an
        // independent window: dragging it moves the CLAIM popover, and the attached ones
        // re-stack from there. Anything else (the claim popover itself, a standalone
        // onboarding popover) is its own anchor, so behaviour there is unchanged.
        const ownerClaimPop = (el as any)._mfClaimPop as HTMLElement | undefined;
        anchor = (ownerClaimPop && ownerClaimPop.isConnected) ? ownerClaimPop : el;
        active = true;
        moved = false;
        pointerId = e.pointerId;
        startX = e.clientX;
        startY = e.clientY;
        startLeft = parseFloat(getComputedStyle(anchor).left) || 0;
        startTop = parseFloat(getComputedStyle(anchor).top) || 0;
        baseDx = Number((anchor as any)._mfDragDx) || 0;
        baseDy = Number((anchor as any)._mfDragDy) || 0;
        try { el.setPointerCapture(e.pointerId); } catch { /* capture unsupported — el listeners still cover the common case */ }
    });
}

function positionPopover(popover: HTMLElement, trigger: HTMLElement) {
    if ((popover as any)._mfManuallyPositioned) return;
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
    observeTriggerGeometry(popover, trigger);
}

/** Keep a popover clear of its trigger as the trigger's own box CHANGES under it.
 *
 *  The placement above reads the trigger once, but a highlight is not static at that
 *  moment: its badge is inserted immediately AFTER the popover opens (and on touch there is
 *  no hover, so the badge only ever appears post-tap). If the badge does not fit on the line
 *  the highlight ends on, it wraps to the next one — which grows the highlight's bounding
 *  box downward, leaving the popover, placed against the pre-badge geometry, sitting on top
 *  of the very badge it was meant to avoid.
 *
 *  A ResizeObserver re-runs placement whenever that box actually changes, which also covers
 *  reflow from font loading, rotation and text rewrapping. Repositioning the popover never
 *  resizes the trigger, so this cannot feed back into itself. Self-disconnects once the
 *  popover leaves the DOM, so call sites need no cleanup.
 */
function observeTriggerGeometry(popover: HTMLElement, trigger: HTMLElement) {
    if (typeof ResizeObserver !== 'function') return;
    const holder = popover as HTMLElement & { _mfTriggerObserver?: ResizeObserver };
    if (holder._mfTriggerObserver) return;
    try {
        const observer = new ResizeObserver(() => {
            if (!popover.isConnected || !trigger.isConnected) {
                observer.disconnect();
                delete holder._mfTriggerObserver;
                return;
            }
            // Respect a user-dragged popover exactly as positionPopover() does.
            if ((popover as any)._mfManuallyPositioned) return;
            positionPopover(popover, trigger);
        });
        observer.observe(trigger);
        holder._mfTriggerObserver = observer;
    } catch { /* unobservable trigger — initial placement still applies */ }
}

/** Position an onboarding popover with `position: fixed`, pinned directly to the button's
 *  live VIEWPORT rect — no container/scrollTop math (which mis-placed them ~scroll-offset
 *  px offscreen, previously masked only by positionPopover's viewport clamp). It sits to
 *  the button's right with a 280–360px width when there's room, else below it; it follows
 *  the button on scroll (refreshOnboarding re-runs on scroll) and goes offscreen with it,
 *  with no edge pile-up. Popovers are appended to document.body (no transformed ancestor)
 *  so `fixed` resolves against the viewport. */
function positionOnboardingPopover(popover: HTMLElement, trigger: HTMLElement, preferAboveOnCramped: boolean = false) {
    // Deliberately does NOT bail out on `_mfManuallyPositioned` (unlike positionPopover).
    // These are position:fixed in viewport coordinates, so they only stay with their button
    // because this recomputes them on every scroll. Freezing a dragged one left it welded to
    // the viewport while the tweet scrolled away. Instead we keep recomputing and re-apply the
    // user's drag as an offset at the end of this function.
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
        const w = popover.getBoundingClientRect().width || minPopoverWidth;
        left = Math.max(padding, Math.min(trigRect.left, viewportWidth - w - padding));
        // Disinfact / Fact-Check All only: try ABOVE the button before falling back
        // below, when there isn't room to the right. Everything else (Fact-Check's own
        // onboarding, in-popover translate/refresh ones) keeps the original right-then-
        // below order untouched.
        const h = popover.getBoundingClientRect().height;
        const spaceAbove = trigRect.top - padding;
        const aboveFits = preferAboveOnCramped && h > 0 && spaceAbove >= h;
        top = aboveFits ? trigRect.top - h - padding : trigRect.bottom + padding;
    }
    // Re-apply any drag the user performed, as an offset from the freshly-computed anchor
    // position (see makeDraggable). Keeps their placement while still tracking the button on
    // scroll, so the popover leaves the screen with its tweet instead of hovering in place.
    left += Number((popover as any)._mfDragDx) || 0;
    top += Number((popover as any)._mfDragDy) || 0;
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
        if (isTouchInput()) return;
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
        if (isTouchInput()) return;
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
    if (srcList.length === 0) { ensurePopoverDisclaimer(popover); return; }

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
    // Re-anchor the disclaimer below the sources row we just (re)appended.
    ensurePopoverDisclaimer(popover);
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
                // The old trigger's badge doesn't carry over to its replacement, and
                // the replacement never hovers on its own — same as showPopover, ensure
                // one exists so the badge doesn't vanish out from under an open popover.
                if (!currentTrigger.querySelector(".mf-inline-badge") && (currentTrigger as any)._mfCreateBadge) {
                    currentTrigger.appendChild((currentTrigger as any)._mfCreateBadge(currentTrigger.dataset.reclassifyOnHold === "true"));
                }
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
                    if (isTouchInput()) return;
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
                    if (isTouchInput()) return;
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

// ── On-hold button injection (pipeline paused, awaiting a user click) ────────

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

/** The mark's `<path>` elements, pulled straight from the same public/black.svg the
 *  toolbar/manifest/popup icons are generated from (imported as raw text at build time —
 *  no runtime fetch), recolored to `currentColor` so it can be tinted per use site. This
 *  is the ONLY copy of the path data in the codebase; editing black.svg updates every
 *  place the mark appears, instead of a hand-maintained duplicate going stale. */
const DISINFAX_MARK_PATHS = disinfaxMarkRaw
    .replace(/^[\s\S]*?<svg[^>]*>/, "")
    .replace(/<\/svg>[\s\S]*$/, "")
    .replace(/black/g, "currentColor");

/** Builds the DisinfaX logo mark used inline in the Disinfact / Fact-Check All button
 *  text, so every button carrying the brand mark stays pixel-identical. Deliberately
 *  sets no color of its own — every call site already colors its wrapping text-wrap div
 *  to match the label next to it, and `color` inherits down to this SVG, so it always
 *  matches automatically instead of hardcoding the same value a second time. */
function createDisinfactLogoSvg(): SVGSVGElement {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("viewBox", "0 0 128 128");
    svg.setAttribute("fill", "none");
    svg.style.flexShrink = "0";
    svg.style.marginTop = "-5px";
    // Narrow screens: close the gap between the mark and its label. The wrapper's flex gap
    // is already 0, so the remaining slack is the mark not filling its own 128x128 viewBox —
    // only a negative margin can take it back. Set inline, like the container's gap, because
    // that reliably wins where a stylesheet rule did not.
    if (window.innerWidth <= MF_NARROW_MAX_WIDTH) {
        svg.style.marginRight = "-3px";
    }
    svg.innerHTML = DISINFAX_MARK_PATHS;
    return svg;
}

/** Render a "Disinfact" button for tweets awaiting user action. */
/** Insert a button container into the action row (before Grok), else the Grok row,
 *  else right after the timestamp. Applies a single symmetric gap: margin-RIGHT when the
 *  button sits to the LEFT of the Grok/action content, margin-LEFT when it sits to the
 *  RIGHT of the timestamp — so the same visual gap separates it from its neighbor either
 *  way (previously the fixed margin-right left it cramped against the timestamp). */
const MF_BTN_GAP = '10px';
/** Narrow screens: X's own row already separates its children with `column-gap: 8px`, so
 *  our extra 10px on top of that was pure surplus — measured at ~26px of dead space around
 *  the button, which is what squeezed the display name down to "The W…". Pull back past the
 *  row's gap instead, leaving a small deliberate separation.
 *
 *  Applied INLINE rather than from the injected stylesheet on purpose: the margin is set
 *  inline at placement, and stylesheet rules (even !important ones inside a media query)
 *  proved unreliable at overriding it here. Setting it at the source is unambiguous. */
const MF_BTN_GAP_NARROW = '-4px';
const MF_NARROW_MAX_WIDTH = 500;
function currentBtnGap(): string {
    return window.innerWidth <= MF_NARROW_MAX_WIDTH ? MF_BTN_GAP_NARROW : MF_BTN_GAP;
}
function placeButtonContainer(container: HTMLElement, article: Element, time: Element, grokData: { row: HTMLElement } | null) {
    const MF_BTN_GAP = currentBtnGap();
    // On narrow screens tighten BOTH sides: only one of them carries the gap below, and the
    // other side still inherits the row's 8px, so leaving it untouched would look lopsided.
    if (window.innerWidth <= MF_NARROW_MAX_WIDTH) {
        container.style.marginLeft = MF_BTN_GAP_NARROW;
        container.style.marginRight = MF_BTN_GAP_NARROW;
    }
    const actionRow = findActionRow(article);
    if (actionRow) {
        container.style.marginRight = MF_BTN_GAP;
        actionRow.insertBefore(container, actionRow.firstChild);
    } else if (grokData) {
        container.style.marginRight = MF_BTN_GAP;
        grokData.row.insertBefore(container, grokData.row.firstChild);
    } else {
        // After the timestamp: neighbor is on the LEFT, so the gap goes on the left. On
        // narrow screens keep the pull-back on the right too, rather than resetting it to 0
        // and re-introducing the row's full 8px on that side.
        container.style.marginLeft = MF_BTN_GAP;
        container.style.marginRight =
            window.innerWidth <= MF_NARROW_MAX_WIDTH ? MF_BTN_GAP_NARROW : '0';
        time.insertAdjacentElement("afterend", container);
    }
}

// ── Screenshot mode (print) ───────────────────────────────────────────────────
// Browsers have no way to detect an OS screenshot tool, but printing (Ctrl/Cmd+P,
// "Save as PDF", and any page-capture tool that goes through the print pipeline) fires
// real, reliable beforeprint/afterprint events. While printing, every highlight's badge
// is forced visible (normally a hover-only effect), and any tweet with at least one
// classified claim shows "DisinfaX" + the logo where its Disinfact/Fact-Check All button
// normally sits — replacing the button if one is present, or adding a small label if the
// tweet is already fully resolved and has no button left. Reverted exactly on afterprint.
const printBadgesAdded = new Set<HTMLElement>();
const printContainerOriginalHTML = new Map<HTMLElement, string>();
const printContainersAdded = new Set<HTMLElement>();

/** The "DisinfaX" mark shown in place of the Disinfact/Fact-Check All button while
 *  printing — styled to match whatever text element it's replacing (`innerClass` is
 *  that element's own className) so it looks native rather than pasted-in. */
function buildPrintLabel(innerClass: string): HTMLElement {
    const wrap = document.createElement("div");
    wrap.setAttribute("dir", "ltr");
    wrap.className = innerClass;
    wrap.style.color = "rgb(83, 100, 113)";
    wrap.style.fontSize = "13px";
    wrap.style.fontWeight = "700";
    wrap.style.minWidth = "0";
    wrap.style.display = "flex";
    wrap.style.alignItems = "center";
    wrap.style.gap = "0";
    wrap.appendChild(createDisinfactLogoSvg());
    const text = document.createElement("span");
    text.textContent = "DisinfaX";
    wrap.appendChild(text);
    return wrap;
}

function enterPrintMode() {
    // 1. Force every highlight's badge visible, exactly as hovering it would show it.
    for (const span of Array.from(document.querySelectorAll<HTMLElement>(".mf-segment-claim"))) {
        if (span.querySelector(".mf-inline-badge")) continue;
        const create = (span as any)._mfCreateBadge as ((permanent: boolean) => HTMLElement) | undefined;
        if (!create) continue;
        const badge = create(span.dataset.reclassifyOnHold === "true");
        span.appendChild(badge);
        printBadgesAdded.add(badge);
    }

    // 2. Swap the button area for a "DisinfaX" label on every tweet with at least one
    // classified (not on-hold, not mid-refresh, verdict-bearing) claim.
    for (const classification of allClassifications) {
        const hasClassified = classification.claims?.some(
            cl => !cl.reclassifyOnHold && !cl.refreshing && cl.note != null && cl.confidence !== undefined
        );
        if (!hasClassified) continue;

        let time: HTMLElement | null = null;
        let article: Element | null = null;
        for (const t of Array.from(document.querySelectorAll<HTMLElement>(`a[href*="/status/${classification.id}"]`))) {
            const a = t.closest("article");
            if (a && getArticleMainStatusId(a) === classification.id) { time = t; article = a; break; }
        }
        if (!time || !article) continue;

        const existing = article.querySelector<HTMLElement>(`[mf-on-hold-id="${classification.id}"]`);
        if (existing) {
            printContainerOriginalHTML.set(existing, existing.innerHTML);
            const innerClass = existing.querySelector('div[dir="ltr"]')?.className ?? "";
            existing.innerHTML = "";
            existing.appendChild(buildPrintLabel(innerClass));
            continue;
        }

        const container = document.createElement("div");
        container.classList.add("mf-btn-container");
        container.setAttribute("mf-on-hold-id", classification.id);
        container.style.cssText = `
            display: inline-flex;
            align-items: center;
            min-width: 0;
            flex-shrink: 0;
        `;
        const grokData = findGrokRow(article);
        const refBtn = grokData?.btn ?? time;
        const innerDiv = grokData?.btn.querySelector<HTMLElement>('div[dir="ltr"]');
        const innerClass = innerDiv?.className ?? refBtn.className;
        container.appendChild(buildPrintLabel(innerClass));
        placeButtonContainer(container, article, time, grokData);
        printContainersAdded.add(container);
    }
}

function exitPrintMode() {
    for (const badge of printBadgesAdded) badge.remove();
    printBadgesAdded.clear();

    for (const [container, html] of printContainerOriginalHTML) container.innerHTML = html;
    printContainerOriginalHTML.clear();

    for (const container of printContainersAdded) container.remove();
    printContainersAdded.clear();
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
    container.classList.add("mf-btn-container");
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
        factCheckAllText.style.display = "flex";
        factCheckAllText.style.alignItems = "center";
        factCheckAllText.style.gap = "0";
        factCheckAllText.appendChild(createDisinfactLogoSvg());
        const factCheckAllLabel = document.createElement("span");
        factCheckAllLabel.textContent = t('factCheckAllButton');
        factCheckAllText.appendChild(factCheckAllLabel);
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
    textWrap.style.display = "flex";
    textWrap.style.alignItems = "center";
    textWrap.style.gap = "0";

    textWrap.appendChild(createDisinfactLogoSvg());
    const text = document.createElement("span");
    text.textContent = t("disinfactButton");
    textWrap.appendChild(text);

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
        factCheckAllText.style.display = "flex";
        factCheckAllText.style.alignItems = "center";
        factCheckAllText.style.gap = "0";
        factCheckAllText.appendChild(createDisinfactLogoSvg());
        const factCheckAllLabel = document.createElement("span");
        factCheckAllLabel.textContent = t('factCheckAllButton');
        factCheckAllText.appendChild(factCheckAllLabel);
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
    container.classList.add("mf-btn-container");
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
    textWrap.style.display = "flex";
    textWrap.style.alignItems = "center";
    textWrap.style.gap = "0";
    // Displayed as the "Disinfact" button (per design: a DB hit whose highlights
    // don't yet exist for the currently-displayed locale should look exactly like
    // no hit at all). dataset.mfCharge stays "translate-tweet" — a separate charge
    // type from "disinfact" — since the click below only relocalizes highlights +
    // re-researches (TRANSLATE_FACT_CHECKS), not a full preclassification.

    textWrap.appendChild(createDisinfactLogoSvg());
    const text2 = document.createElement("span");
    text2.textContent = t("disinfactButton");
    textWrap.appendChild(text2);

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

// ── Main injection (drives both phases above) ───────────────────────────────

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
        // Show NOTHING until the switch resolves, rather than dropping to the fallback area.
        // X streams a translation in over several seconds, and with segments cleared every
        // observer tick in that window would otherwise render the fallback box — turning a
        // last-resort UI into a normal, expected step on the way to the Disinfact button.
        // Reuses the flag TRANSLATE_FACT_CHECKS already sets for the same reason; both
        // fallback call sites above honour it. It clears itself when the next broadcast
        // arrives, because injectClassifications replaces this object with the background's
        // (which never sets it) — so there is no state to unwind if the switch is abandoned.
        c.localizingHighlights = true;
        textBreakupInProgress.delete(tweetId);
    }
}) as EventListener);