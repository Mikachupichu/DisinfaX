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
import { normalizeSources } from "./sources";
import { breakupTweetText, breakupWithHighlights, resolveHighlightRange } from "./textBreakup";
import { mfBus } from "./mfBus";
import { codeToMessageKey, ERROR_CODES } from "./errorCodes";
import { KALAM_BOLD_LATIN_B64, KALAM_BOLD_LATIN_EXT_B64 } from "./correctionFont";
import disinfaxMarkRaw from "../public/black.svg?raw";
import type { PlatformAdapter, PostRef, TextRegion } from "./platforms/types";

// ── Active platform adapter ──────────────────────────────────────────────────

/**
 * The adapter for the platform this document is on, or null on an ordinary webpage.
 *
 * X is deliberately excluded from every seam below, and that exclusion is what makes
 * this refactor unable to regress X: the X adapter's methods delegate straight back
 * into this file (see `utils/platforms/x.ts`), so consulting it from here would
 * recurse. X therefore keeps executing its native code path, token for token, while
 * the other platforms route through the adapter.
 *
 * Set once by the platform content script before any injection runs. Until a
 * non-X entrypoint calls it, every seam is inert and this file behaves exactly as it
 * did before the adapter existed.
 */
let activeAdapter: PlatformAdapter | null = null;

export function setPlatformAdapter(adapter: PlatformAdapter | null): void {
    activeAdapter = adapter;
}

/** The adapter to consult from a seam: the active one, unless it is X's (which would
 *  recurse) or there is none (a plain webpage). */
function platformSeam(): PlatformAdapter | null {
    return activeAdapter && activeAdapter.id !== 'x' ? activeAdapter : null;
}

/** Whether an id belongs to a native post on this page.
 *
 *  The platform-agnostic form of `isTweetTargetOnX`. Use this wherever the answer
 *  decides feed-centering or whether a selection counts as a web selection — places
 *  that were only ever X-shaped because X was the only platform. */
export function isNativePostTarget(id: string): boolean {
    const seam = platformSeam();
    if (seam) return seam.isPostTarget(id);
    return isTweetTargetOnX(id);
}

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
/** Tweet IDs with a user-triggered re-preclassification in flight (the top-of-tweet
 *  refresh button). Distinct from `processingOnHoldIds` (owned by the
 *  Disinfact/pipeline flow): both sets drive the same top-of-tweet wheel, and the
 *  wheel is shown while EITHER is non-empty. Cleared when the first streamed
 *  claims land (broadcast path) or when the run fails to produce them (the
 *  button's 30s revert), never optimistically at click time. */
const refreshRunPendingIds = new Set<string>();
/** Tweet IDs with a user-triggered initial preclassification in flight (Disinfact click).
 *  Cleared when streamed claims land or when the run fails / times out. */
const disinfactRunPendingIds = new Set<string>();
/** Tweet IDs whose cached preclassification visuals are currently hidden — either
 *  the user clicked Hide, or cached visuals arrived with no engagement this
 *  session (DB hit, or their own earlier click before a reload) and defaulted to
 *  hidden. Rendering is gated ONLY; derivation, spend, and pipeline state are
 *  untouched. Main tweets only. */
const hiddenVisualIds = new Set<string>();
/** Tweet IDs the user has revealed (Reveal button) or engaged with (clicked any
 *  top-of-tweet action button: Disinfact, Fact-Check All, translate, refresh).
 *  Takes precedence over the hidden set. Main tweets only. */
const revealedVisualIds = new Set<string>();
/** Popup "show false claims while hidden" setting (per-extension storage.local):
 *  while a tweet's cached visuals stay hidden behind the Reveal button, claims
 *  that are classified, need no reclassification, and clear BOTH thresholds —
 *  confidence at or above the minimum, veracity at or below the maximum — keep
 *  their highlight, annotations, badge and popover fully interactable. Everything
 *  else stays stripped until Reveal. Defaults: disabled, confidence 0.2, veracity 0. */
const BYPASS_STORE_ENABLED = 'mf_bypass_enabled';
const BYPASS_STORE_CONFIDENCE = 'mf_bypass_min_confidence';
const BYPASS_STORE_VERACITY = 'mf_bypass_min_veracity';
const BYPASS_DEFAULT_ENABLED = false;
const BYPASS_DEFAULT_CONFIDENCE = 0.2;
const BYPASS_DEFAULT_VERACITY = 0;
const bypassSettings = {
    enabled: BYPASS_DEFAULT_ENABLED,
    minConfidence: BYPASS_DEFAULT_CONFIDENCE,
    minVeracity: BYPASS_DEFAULT_VERACITY,
};
/** Narrow an arbitrary stored value into a threshold range, so a stale or
 *  hand-edited storage entry can't push a slider somewhere the UI doesn't go. */
function clampBypassNumber(value: unknown, lo: number, hi: number, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.min(hi, Math.max(lo, value))
        : fallback;
}
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
// tweetId -> { mark, pendingClaimTexts, keptClaimTexts }.
//
// `pendingClaimTexts` is the work still outstanding — it empties as verdicts land, and the
// button appears once it does. `keptClaimTexts` is every claim this run ever had in flight,
// which is what the button OFFERS: the results the reader just paid for. They differ by
// design. A post can already hold verdicts from an earlier classification, and those claims
// are never pending here (they are not being researched), so they must not be listed on a
// button that announces THIS run's results — nor decide where that button points.
const onHoldScrollStates = new Map<string, {
    mark: ScrollMark;
    pendingClaimTexts: Set<string>;
    keptClaimTexts: Set<string>;
}>();

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
    /** The claims this button is offering (see buttonClaimSpans). Carried on the state so
     *  the restore-on-navigation interval can ask the same question the button was built on
     *  — it runs with nothing but this registry entry in hand. */
    claimTexts?: ReadonlySet<string>;
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
        if (localeOverride && localeOverride !== 'en') {
            ensureLocaleMessagesLoading(localeOverride).then(repairUnresolvedLabels).catch(() => {});
        }
    }).catch(() => {});
    browser.storage.onChanged.addListener((changes: Record<string, any>, area: string) => {
        if (area === 'local' && 'mfLocale' in changes) {
            localeOverride = normalizeLocaleOverride(changes.mfLocale?.newValue ?? null);
        }
    });
    // Load the bypass thresholds, then keep them live: a popup slider move flips
    // already-rendered tweets on the next inject pass with no reload.
    browser.storage.local.get([BYPASS_STORE_ENABLED, BYPASS_STORE_CONFIDENCE, BYPASS_STORE_VERACITY]).then((r: any) => {
        if (typeof r?.[BYPASS_STORE_ENABLED] === 'boolean') bypassSettings.enabled = r[BYPASS_STORE_ENABLED];
        bypassSettings.minConfidence = clampBypassNumber(r?.[BYPASS_STORE_CONFIDENCE], 0, 1, BYPASS_DEFAULT_CONFIDENCE);
        bypassSettings.minVeracity = clampBypassNumber(r?.[BYPASS_STORE_VERACITY], -1, 1, BYPASS_DEFAULT_VERACITY);
    }).catch(() => {});
    browser.storage.onChanged.addListener((changes: Record<string, any>, area: string) => {
        if (area !== 'local') return;
        let touched = false;
        if (BYPASS_STORE_ENABLED in changes && typeof changes[BYPASS_STORE_ENABLED]?.newValue === 'boolean') {
            bypassSettings.enabled = changes[BYPASS_STORE_ENABLED].newValue;
            touched = true;
        }
        if (BYPASS_STORE_CONFIDENCE in changes) {
            bypassSettings.minConfidence = clampBypassNumber(changes[BYPASS_STORE_CONFIDENCE]?.newValue, 0, 1, BYPASS_DEFAULT_CONFIDENCE);
            touched = true;
        }
        if (BYPASS_STORE_VERACITY in changes) {
            bypassSettings.minVeracity = clampBypassNumber(changes[BYPASS_STORE_VERACITY]?.newValue, -1, 1, BYPASS_DEFAULT_VERACITY);
            touched = true;
        }
        // Re-inject synchronously while still inside the storage event: the user is
        // staring at the open popup AND the tab behind it, so the highlights must
        // flip the instant they drag — the next MutationObserver tick is too late.
        if (touched) classificationInjections(allClassifications);
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

/** Kick off (once) an async fetch of `_locales/<locale>/messages.json` and cache it,
 *  returning the load so a caller can also act on arrival.
 *  Used for the mfLocale test override and as the ultimate fallback when the
 *  chrome/browser i18n API is unavailable — both are edge paths, and the fetch is
 *  started by the lookup that needs it, so a `t` call in the meantime can only answer
 *  with the raw key. `repairUnresolvedLabels` is what undoes that: it runs off this
 *  promise and rewrites the labels that were built before the catalog landed. The
 *  copy itself stays in `_locales` and is never duplicated inside this file.
 *
 *  `locale` may be a hyphenated BCP-47 tag (e.g. "zh-TW"); the `_locales/` folders
 *  are named with underscores, so candidates try the underscore form first, then
 *  the bare base language, caching the result under the original hyphenated key. */
function ensureLocaleMessagesLoading(locale: string): Promise<void> {
    const inFlight = localeMessageLoadPromises.get(locale);
    if (inFlight) return inFlight;
    if (localeMessageCache.has(locale)) return Promise.resolve();
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
    return promise;
}

// Warm the English catalog at module load rather than leaving it to the first `t` call:
// that call would be the one that built a bar, and the fetch it starts lands a tick too
// late for the label it is already writing. See `repairUnresolvedLabels`.
//
// This has to sit BELOW `localeMessageCache`/`localeMessageLoadPromises`, not in the
// module-init block above `t`: `ensureLocaleMessagesLoading` reaches those bindings, so a
// call made before their `const` initializers run throws a ReferenceError from the
// temporal dead zone — inside the async function it becomes a rejected promise, which the
// `.catch` swallows, leaving the warm-up and the repair silently inert. Measured: with the
// call above the declarations, no catalog was ever fetched and a bar built before the
// first successful lookup kept its raw key.
//
// The repair runs on BOTH settle paths. On a host that blocks the fetch the promise only
// ever rejects, and `then` alone would leave the repair inert on precisely the hosts where
// the catalog is missing and `t` has nothing to fall back on.
ensureLocaleMessagesLoading('en').then(repairUnresolvedLabels, repairUnresolvedLabels);

/** Our own chrome, wherever a label can live: every injected bar, notification and
 *  popover. The repair below is scoped to these so it can never rewrite host text. */
const OUR_CHROME_SELECTOR = '[mf-top-bar-id], [mf-visual-id], [mf-on-hold-id], '
    + '[translate-fc-id], [mf-refresh-id], [classification-id], [mf-unmatched], '
    + '.mf-notif-container, .mf-popover, .mf-onboard, .mf-onboard-attached';

/** Keys are camelCase identifiers — `disinfactButton`, `factCheckAllButton` — and no
 *  platform renders one as prose. This is what identifies our own label when the catalog
 *  itself is unavailable; see `repairUnresolvedLabels`. A leading uppercase is required,
 *  so an ordinary word like "Disinfact" can never match. */
const CATALOG_KEY_SHAPE = /^[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*$/;

/** Rewrite the labels that were built before their catalog arrived.
 *
 *  `t` answers with the raw key when neither the chrome i18n API nor the English
 *  overlay can resolve a string, and the overlay is only *started* by the lookup that
 *  needs it — so the FIRST label built in a content-script world rendered its key and
 *  stayed that way, because a label is written once. Measured on a Reddit thread: the
 *  first bar read "revealButton" while every bar built a moment later read "Disinfact".
 *  Warming the catalog at module load closes the window; this closes it for good.
 *
 *  Only leaf elements are considered, so skipping parents keeps us from flattening a
 *  subtree, and only a leaf whose whole text is one of our keys is rewritten.
 *
 *  Where the catalog cannot be loaded the key's SHAPE stands in for membership in it.
 *  That is not a hypothetical: a content script's `fetch` is subject to the PAGE's CSP,
 *  and Facebook's blocks `chrome-extension:` — measured, `fetch(chrome.runtime.getURL(
 *  '_locales/en/messages.json'))` throws "Failed to fetch" there. Requiring the catalog
 *  would leave this repair inert on exactly the host it is needed on, and would leave
 *  `t`'s English fallback dead there too. */
function repairUnresolvedLabels(): void {
    const en = localeMessageCache.get('en');
    let repaired = 0;
    for (const host of Array.from(document.querySelectorAll<HTMLElement>(OUR_CHROME_SELECTOR))) {
        for (const el of Array.from(host.querySelectorAll<HTMLElement>('*'))) {
            if (el.children.length > 0) continue;
            const text = (el.textContent ?? '').trim();
            if (!text) continue;
            if (en ? !(text in en) : !CATALOG_KEY_SHAPE.test(text)) continue;
            const resolved = t(text);
            if (resolved !== text) { el.textContent = resolved; repaired++; }
        }
    }
    // Only ever printed when there was something to undo, so a healthy page stays quiet —
    // but a page that prints it is a page where a label outlived its catalog, which is the
    // signal to look at why the lookup could not answer.
    if (repaired) console.log(`[misinfo] i18n: repaired ${repaired} label(s) that could not resolve`);
}

/** Repair labels for as long as the page lives, not merely once.
 *
 *  A content-script world outlives an extension reload: its JavaScript and its DOM event
 *  listeners keep running, but `chrome.i18n` and `chrome.runtime` are gone from it.
 *  Measured on facebook.com — one frame held NINE of our isolated worlds and only one
 *  still had the extension APIs. A bar whose button was wired up by a dead world is still
 *  clickable, and the rebuild that click triggers runs `t` there, where neither the i18n
 *  API nor the (CSP-blocked) catalog can answer, so the label is written as its raw key and
 *  — because a label is written once — stays that way. That is the whole observable: bars
 *  correct on a fresh load, "disinfactButton" the moment one is rebuilt.
 *
 *  A one-shot repair cannot catch that: the write happens long after module load, and it
 *  happens in another world. What the two worlds DO share is the DOM, so this watches it,
 *  and the repair runs from whichever world is still alive.
 *
 *  The filter is deliberately narrow — a mutation only schedules a pass when its target or
 *  an added node is inside our own chrome — because on a busy host the observer itself fires
 *  constantly and the pass, cheap as it is, must not run on every one of those. Passes are
 *  coalesced to one per frame, so a burst of writes costs a single sweep of our bars. */
function watchForUnresolvedLabels(): void {
    let scheduled = false;
    const schedule = () => {
        if (scheduled) return;
        scheduled = true;
        const run = () => { scheduled = false; repairUnresolvedLabels(); };
        // `requestAnimationFrame` is the cheapest coalescer while the tab is visible, but a
        // HIDDEN tab is served no frames at all, so arming the repair with it alone means it
        // simply never runs — measured: a planted raw key sat unhealed for as long as the
        // Facebook tab stayed in the background. Timers are still serviced there (throttled,
        // which for a repair that only has to happen eventually is fine), so they carry it.
        if (document.visibilityState === 'visible' && typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(run);
        } else {
            setTimeout(run, 0);
        }
    };
    const inOurChrome = (node: Node | null): boolean => {
        if (!node || node.nodeType !== 1) return false;
        const el = node as Element;
        if (el.matches?.(OUR_CHROME_SELECTOR)) return true;
        return !!el.closest?.(OUR_CHROME_SELECTOR);
    };
    try {
        new MutationObserver((records) => {
            for (const rec of records) {
                if (inOurChrome(rec.target.nodeType === 1 ? rec.target : rec.target.parentElement)) return schedule();
                for (const node of Array.from(rec.addedNodes)) {
                    if (inOurChrome(node)) return schedule();
                }
            }
        }).observe(document, { childList: true, subtree: true, characterData: true });
    } catch {
    }
}

// Sits below `OUR_CHROME_SELECTOR` and the two functions it reaches. The observer itself
// reads none of them at call time — its callback is deferred to the first mutation — but a
// call placed above the `const` would still be the kind of forward reference that silently
// works one day and throws the next.
watchForUnresolvedLabels();

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

/** Check if two claim arrays differ in text, rewritten, claimLocale, reasoningLocale, or count enough to need fresh segment derivation. Annotations are deliberately EXCLUDED: an annotation-only broadcast (Flow A/B key landing, no verdict movement) must keep the cheap in-place repaint path — the dispatcher triages it with its own comparison, and folding annotations in here would promote every such broadcast to a full segment re-derivation. */
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

/** The colour an element actually paints behind its contents, or null when it paints
 *  nothing. `alpha === 0` paints nothing — and that is the case this exists for:
 *  `rgba(0, 0, 0, 0)` says "no background", not "black". Reading its three zeroes as
 *  black is how a page that sets no background at all (CBC's body is transparent,
 *  which is the norm — the white comes from the canvas) was read as a dark theme, so
 *  the mid-grey preclassification tint was composited over white and vanished. */
function paintedBg(el: Element | null): [number, number, number] | null {
    if (!el) return null;
    try {
        const m = getComputedStyle(el).backgroundColor.match(/[\d.]+/g);
        if (!m || m.length < 3) return null;
        const [r, g, b, a] = m.map(Number);
        if (a !== undefined && a === 0) return null;
        return [r, g, b];
    } catch { return null; }
}

function rgbLuma(rgb: [number, number, number]): number {
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

/** True when the surface behind `el` (or the page, if omitted) is dark, so tints
 *  use white rather than black. Walk painted backgrounds first — X's body is
 *  opaque, so that still answers on the first step. A transparent body used to
 *  fall through to `prefers-color-scheme`, which on a light Substack article in
 *  a dark OS painted a white Fact-Check wash onto white and the highlight
 *  vanished; ink colour of the text itself is the next signal (dark ink = light
 *  page). `color-scheme` / OS preference are last-resort only. */
function isDarkSurface(el?: Element | null): boolean {
    // Ink first: dark letters only exist on a light page, even when the OS or
    // a chrome ancestor is dark (Substack article on a dark macOS). Light
    // letters only exist on a dark page (X night mode). Mid greys fall through
    // to painted backgrounds.
    try {
        const sample = (el && el.isConnected ? el : document.body) ?? document.documentElement;
        const m = getComputedStyle(sample).color.match(/[\d.]+/g);
        if (m && m.length >= 3) {
            const inkLuma = rgbLuma([Number(m[0]), Number(m[1]), Number(m[2])]);
            if (inkLuma < 140) return false;
            if (inkLuma > 180) return true;
        }
    } catch { /* ignore */ }
    let node: Element | null = el ?? null;
    while (node) {
        const bg = paintedBg(node);
        if (bg) return rgbLuma(bg) < 128;
        node = node.parentElement;
    }
    const pageBg = paintedBg(document.body) ?? paintedBg(document.documentElement);
    if (pageBg) return rgbLuma(pageBg) < 128;
    try {
        const scheme = getComputedStyle(document.documentElement).colorScheme ?? "";
        const light = /\blight\b/.test(scheme), darkScheme = /\bdark\b/.test(scheme);
        if (light && !darkScheme) return false;
        if (darkScheme && !light) return true;
        if (typeof matchMedia === "function") return matchMedia("(prefers-color-scheme: dark)").matches;
    } catch { /* ignore */ }
    return false;
}

function isDarkMode(): boolean {
    return isDarkSurface();
}

/** Highlight tint for a claim. On-hold ("Fact-Check", actionable) = a prominent
 *  black/white tint; no verdict yet = gray; otherwise the verdict color — and a
 *  reclassification keeps the verdict it is replacing for as long as that verdict is
 *  still the one on screen, so only the badge gains the spinner and the highlight never
 *  goes grey under a colour the reader is still reading. `hover` returns the stronger
 *  hover variant. */
export function highlightBgColor(claim: Claim, hover: boolean, surface?: Element | null): string {
    const hasVerdictColor = claim.confidence !== undefined && claim.confidence !== null
        && claim.veracity !== undefined && claim.veracity !== null && claim.confidence >= 0.2;
    const dark = isDarkSurface(surface);
    if (claim.reclassifyOnHold) {
        return dark
            ? (hover ? 'rgba(255,255,255,0.40)' : 'rgba(255,255,255,0.28)')
            : (hover ? 'rgba(0,0,0,0.34)' : 'rgba(0,0,0,0.22)');
    }
    if (!hasVerdictColor) {
        // The neutral tint follows the canvas, the same way the on-hold one above does.
        // A mid-grey at 25% is #202020 over X's black but #DFDFDF over the white page a
        // web selection sits on — close enough to white to read as "not highlighted at
        // all", which is how a passage mid-preclassification looked while its verdict
        // colour (saturated, so it survives the same alpha) became obvious the instant
        // research landed. Kept under the on-hold alphas so "working" never reads as
        // "needs your click".
        return dark
            ? (hover ? 'rgba(180,180,180,0.42)' : 'rgba(180,180,180,0.32)')
            : (hover ? 'rgba(0,0,0,0.28)' : 'rgba(0,0,0,0.18)');
    }
    return confidenceRgba(claim.confidence, hover ? 0.5 : 0.25, claim.veracity);
}

/** Set while a rebuild replays the hover it took away (see `resyncHoverAtPointer`). The
 *  replay repaints spans the pointer never left, and a span the rebuild has just made has no
 *  committed background-color for the browser to animate *from* — so the repaint reads as a
 *  change and the `.mf-segment-claim` transition ramps the tint up from the resting colour
 *  over 150ms. A streaming run rebuilds at ~10Hz, so it never reaches the hover colour and
 *  visibly sawtooths for as long as the run lasts — the flicker. A replay is not a colour
 *  change the user ever saw; commit it outright, the same dance `animateHighlightReveal`
 *  already uses for the reveal's own blink. */
let mfTintCommitsInstantly = false;

/** Pin the claim tint as both a CSS variable and an inline `!important` background.
 *  Host pages (Substack) set `p span { background: transparent !important }` at
 *  (0,2,1) — a stylesheet rule cannot beat that, but an inline `!important` can.
 *  A 1×1 repeating gradient is a second paint path hosts that only zero
 *  `background-color` cannot wipe. */
function paintClaimBg(el: HTMLElement, color: string) {
    // Replayed hover: commit with transitions off, then force a reflow so the new colour lands
    // as the before-change style before the transition — the caller's own, if it set one —
    // comes back.
    const prevTransition = mfTintCommitsInstantly ? el.style.transition : null;
    if (prevTransition !== null) el.style.transition = "none";
    el.style.setProperty("--mf-hl", color);
    el.style.setProperty("background-color", color, "important");
    if (prevTransition !== null) {
        // eslint-disable-next-line no-unused-expressions
        void el.offsetHeight;
        el.style.transition = prevTransition;
    }
}

/** Wraps an inline badge in a curved pill cap that smoothly terminates the claim highlight
 *  without rounding previous multiline wrap edges. */
function wrapBadgeInCap(badge: HTMLElement, _bg?: string): HTMLElement {
    pinBadgeLayout(badge);
    const cap = document.createElement("span");
    cap.className = "mf-badge-cap";
    const origRemove = badge.remove.bind(badge);
    badge.remove = () => {
        if (cap.isConnected) cap.remove();
        else origRemove();
    };
    cap.appendChild(badge);
    return cap;
}

/** Resting highlight tint from a span's live dataset. A reclassify keeps the
 *  current verdict's colour (same as `highlightBgColor` for a claim that still
 *  carries numbers); grey only when there is no valid verdict. */
function restHighlightColor(span: HTMLElement): string {
    const pVal = parseFloat(span.dataset.probability ?? "");
    const vVal = parseFloat(span.dataset.veracity ?? "");
    if (!isNaN(pVal) && !isNaN(vVal) && pVal >= 0.2) {
        return confidenceRgba(pVal, 0.25, vVal);
    }
    // Hover already uses the stronger verdict colour in hoverBg. If numbers
    // were cleared mid-rebuild but hoverBg still holds that colour, rest must
    // stay the same family — never grey while hover is red.
    const hover = span.dataset.hoverBg ?? "";
    if (hover.startsWith("rgba(") && !/128,\s*128,\s*128/.test(hover) && !/255,\s*255,\s*255/.test(hover) && !/0,\s*0,\s*0/.test(hover)) {
        return hover.replace(/,\s*[\d.]+\)$/, ", 0.25)");
    }
    const dark = isDarkSurface(span);
    if (span.dataset.reclassifyOnHold === "true") {
        return dark ? "rgba(255,255,255,0.28)" : "rgba(0,0,0,0.22)";
    }
    // Grey-on-white vanishes; use the same on-hold-strength black/white as
    // highlightBgColor so a Fact-Check / researching claim stays visible.
    return dark ? "rgba(180,180,180,0.32)" : "rgba(0,0,0,0.18)";
}

/** Host sheets (Substack `p span { display:block; white-space:normal }`) restyle
 *  every inner span. Inline `!important` is the only origin that beats them. */
function pinInline(el: HTMLElement, props: Record<string, string>) {
    for (const [k, v] of Object.entries(props)) el.style.setProperty(k, v, "important");
}

function syncClaimBadgeLayout(claim: HTMLElement | null) {
    if (!claim) return;
    claim.style.removeProperty("border-top-left-radius");
    claim.style.removeProperty("border-bottom-left-radius");
    claim.style.removeProperty("border-top-right-radius");
    claim.style.removeProperty("border-bottom-right-radius");
    claim.style.removeProperty("padding-top");
    claim.style.removeProperty("padding-bottom");
    claim.style.removeProperty("padding-left");
    claim.style.removeProperty("padding-right");
    claim.style.setProperty("-webkit-box-decoration-break", "slice", "important");
    claim.style.setProperty("box-decoration-break", "slice", "important");

    const hasBadge = !!claim.querySelector(".mf-inline-badge, .mf-standalone-spinner");
    const isRTL = isRTLLocale(getEffectiveUILocale()) || document.dir === "rtl" || !!claim.closest?.('[dir="rtl"]');
    if (hasBadge) {
        if (isRTL) {
            claim.style.setProperty("border-top-right-radius", "3px", "important");
            claim.style.setProperty("border-bottom-right-radius", "3px", "important");
            claim.style.setProperty("border-top-left-radius", "999px", "important");
            claim.style.setProperty("border-bottom-left-radius", "999px", "important");
            claim.style.setProperty("padding-top", "1px", "important");
            claim.style.setProperty("padding-bottom", "1px", "important");
            claim.style.setProperty("padding-right", "3px", "important");
            claim.style.setProperty("padding-left", "1px", "important");
        } else {
            claim.style.setProperty("border-top-left-radius", "3px", "important");
            claim.style.setProperty("border-bottom-left-radius", "3px", "important");
            claim.style.setProperty("border-top-right-radius", "999px", "important");
            claim.style.setProperty("border-bottom-right-radius", "999px", "important");
            claim.style.setProperty("padding-top", "1px", "important");
            claim.style.setProperty("padding-bottom", "1px", "important");
            claim.style.setProperty("padding-left", "3px", "important");
            claim.style.setProperty("padding-right", "1px", "important");
        }
    } else {
        claim.style.setProperty("border-radius", "3px", "important");
        claim.style.setProperty("padding", "1px 3px", "important");
    }
}

function pinClaimLayout(el: HTMLElement) {
    // `white-space: inherit` for the same reason as the sheet's rule: a claim holds the
    // host's own text, so the host's collapsing is the layout it was rendered at.
    pinInline(el, {
        display: "inline",
        "white-space": "inherit",
        position: "relative",
    });
    syncClaimBadgeLayout(el);
}


function onXFeedHost(): boolean {
    try {
        const h = (location.hostname || "").replace(/^www\./, "");
        return h === "x.com" || h === "twitter.com" || h.endsWith(".x.com") || h.endsWith(".twitter.com");
    } catch { return false; }
}

function pinBadgeLayout(badge: HTMLElement) {
    const onX = onXFeedHost();
    badge.classList.toggle("mf-web-badge", !onX);
    const isRTL = isRTLLocale(getEffectiveUILocale());
    // Safari shrink-to-fits inline-flex to leftover line width and then wraps
    // inner items (95% 100% / True). inline-block's shrink-to-fit is the
    // nowrap content width, so the whole pill jumps to the next line instead.
    // X's leftover width is the tweet column, so inline-flex is fine there.
    const props: Record<string, string> = {
        display: onX ? "inline-flex" : "inline-block",
        "flex-direction": "row",
        "flex-wrap": "nowrap",
        "align-items": "center",
        "justify-content": "center",
        "vertical-align": "middle",
        position: "relative",
        top: "-0.142em",
        "line-height": "1.15",
        "white-space": "nowrap",
        width: "max-content",
        "min-width": "max-content",
        "max-width": "none",
        "flex-shrink": "0",
        "word-break": "keep-all",
        "overflow-wrap": "normal",
        padding: "0.12em 0.52em",
        "border-radius": "999px",
        "font-weight": "600",
        "box-sizing": "border-box",
        "font-style": "normal",
        "font-size": "0.75em",
        color: "#ffffff",
        "margin-left": isRTL ? "0" : "0.22em",
        "margin-right": isRTL ? "0.22em" : "0",
        // The pill is one line tall and nothing in it wants space above or
        // below. A host that margins inline <b> (Substack Notes: 8px) sizes
        // the line the pill sits in from the child's margin box, so the pill
        // grows by a margin that is invisible to every other probe.
        "margin-top": "0",
        "margin-bottom": "0",
    };
    const uiSans = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
    if (!onX) props["font-family"] = uiSans;
    pinInline(badge, props);
    for (const child of Array.from(badge.querySelectorAll("span, b"))) {
        const c = child as HTMLElement;
        // Margin, unlike the rest of the pin, is never ours to inherit: the
        // badge parts are laid out relative to each other, so a host's
        // vertical margin on a part sizes the line the pill sits in and the
        // pill grows (Substack Notes put 8px on b). Pinned here rather than in
        // the per-part branches so no part is left out.
        pinInline(c, { "margin-top": "0", "margin-bottom": "0" });
        if (!c.classList.contains("mf-fc-spinner")) {
            pinInline(c, {
                color: "#ffffff",
                ...(onX ? {} : {
                    "font-family": uiSans,
                    "font-weight": "600",
                    "font-style": "normal",
                    "white-space": "nowrap",
                    "line-height": "1",
                }),
            });
        }
        if (c.classList.contains("mf-badge-stack")) {
            // Sizer for the adjective. The percentage is painted on top of it,
            // not as a second line — grid overlay was dropping 80% in WebKit.
            pinInline(c, {
                display: "inline-block",
                position: "relative",
                "white-space": "nowrap",
                "line-height": "1",
                "vertical-align": "middle",
            });
        } else if (c.classList.contains("mf-badge-adj")) {
            pinInline(c, {
                display: "inline",
                position: "static",
                "white-space": "nowrap",
                "line-height": "1",
                "pointer-events": "none",
                margin: "0",
            });
        } else if (c.classList.contains("mf-badge-pct")) {
            const empty = !!c.closest(".mf-badge-empty");
            pinInline(c, empty ? {
                display: "inline",
                position: "static",
                "white-space": "nowrap",
                "line-height": "1",
                "pointer-events": "none",
                margin: "0",
            } : {
                display: "block",
                position: "absolute",
                left: "0",
                right: "0",
                top: "0",
                bottom: "0",
                "white-space": "nowrap",
                "line-height": "1",
                "pointer-events": "none",
                margin: "0",
                "text-align": "center",
            });
        } else if (c.classList.contains("mf-fc-spinner")) {
            pinInline(c, { display: "inline-block", "flex-shrink": "0" });
        } else if (c.classList.contains("mf-badge-empty")) {
            // Do NOT pin display: hover CSS must be able to bring the slot in
            // (inline none !important would win over :hover). Resting hide is
            // the stylesheet's `.mf-badge-empty { display:none }`, which
            // still beats host `p span { display:block }`.
            pinInline(c, {
                "flex-direction": "row",
                "flex-wrap": "nowrap",
                "align-items": "center",
                "flex-shrink": "0",
                "white-space": "nowrap",
                "line-height": "1",
            });
        } else if (c.classList.contains("mf-badge-glue")) {
            // Glue lives INSIDE .mf-badge-slot, which is inline-flex, so the
            // glue span is a flex item. WebKit sizes a space-only flex item
            // at 0 (95%100%True). NBSP + a 1ch floor keeps the separator.
            pinInline(c, {
                display: "inline",
                "white-space": "pre",
                "flex-shrink": "0",
                "line-height": "1",
            });
        } else {
            // Slots and the verdict word stay inline-flex even off-X: inline
            // dropped a hovered percentage (80%) onto the baseline. The OUTER
            // pill is still inline-block off-X so Safari cannot wrap the row.
            pinInline(c, {
                display: "inline-flex",
                "flex-direction": "row",
                "flex-wrap": "nowrap",
                "align-items": "center",
                "flex-shrink": "0",
                "white-space": "nowrap",
                "line-height": "1",
            });
        }
    }
    afterLayout(badge, () => applyBadgeToLine(badge));
}

/** Size the badge from the highlight's line box, not from `em`.
 *  `em` tracks font-size; article leading makes the green strip much taller
 *  than the letters, so a 0.72em chip looks tiny next to it. Same on X. */
function claimLineBoxPx(claim: HTMLElement): number {
    // Prefer computed leading, not getClientRects: the badge lives inside the
    // claim, so a rect would include the chip and feed back into its own size.
    const cs = getComputedStyle(claim);
    const fs = parseFloat(cs.fontSize);
    if (!isFinite(fs) || fs <= 0) return 0;
    const raw = (cs.lineHeight || "").trim();
    if (!raw || raw === "normal") return fs * 1.4;
    if (raw.endsWith("px")) return parseFloat(raw);
    if (raw.endsWith("em")) return parseFloat(raw) * fs;
    const n = parseFloat(raw);
    // Unitless multipliers compute as "1.6", not "25.6px". Treating that as
    // 1.6px used to bail (lh < 8) so the chip never left 0.72em.
    if (n > 0 && n < 5) return n * fs;
    if (n >= 8) return n;
    return fs * 1.4;
}

function applyBadgeToLine(badge: HTMLElement) {
    if (!badge.isConnected) return;
    const claim = badge.closest(".mf-segment-claim") as HTMLElement | null;
    if (!claim) return;
    const cs = getComputedStyle(claim);
    const fs = parseFloat(cs.fontSize) || 16;
    const badgeFs = Math.max(9, Math.round(fs * 0.75 * 10) / 10);
    const lh = claimLineBoxPx(claim);
    if (isFinite(lh) && lh >= 8) {
        claim.style.setProperty("--mf-line", `${lh}px`);
        badge.style.setProperty("--mf-line", `${lh}px`);
    }
    const isRTL = isRTLLocale(getEffectiveUILocale());
    pinInline(badge, {
        color: "#ffffff",
        "font-size": `${badgeFs}px`,
        height: "auto",
        "min-height": "auto",
        padding: "0.12em 0.52em",
        "vertical-align": "middle",
        position: "relative",
        top: "-0.142em",
        "box-sizing": "border-box",
        "line-height": "1.15",
        "margin-left": isRTL ? "0" : "0.25em",
        "margin-right": isRTL ? "0.25em" : "0",
    });
    syncClaimBadgeLayout(claim);
}

function visibleBadgeSample(badge: HTMLElement): string {
    let s = "";
    const w = document.createTreeWalker(badge, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    while ((n = w.nextNode())) {
        const parent = (n as Text).parentElement;
        if (parent) {
            try {
                const vis = getComputedStyle(parent);
                if (vis.display === "none" || vis.visibility === "hidden") continue;
            } catch { continue; }
        }
        const t = n.nodeValue ?? "";
        if (t.trim()) s += t;
    }
    return s.trim();
}

/** X's UI font is a sans with optically-centred caps. Article serifs
 *  (Substack) park "True" in the top of the em-box. Only then do we pin a
 *  system UI sans — X already is one, so this is a no-op there. */
function isSerifFont(cs: CSSStyleDeclaration): boolean {
    const fam = (cs.fontFamily || "").toLowerCase();
    if (/,\s*serif\s*$/.test(fam)) return true;
    if (/\bserif\b/.test(fam) && !/\bsans-serif\b/.test(fam)) return true;
    return /times|georgia|garamond|palatino|baskerville|charter|iowan|source serif|pt serif|merriweather|noto serif|libre baskerville|playfair|fraunces|spectral|literata|newsreader|ibarra/.test(fam);
}

function applyBadgeHostFont(badge: HTMLElement) {
    if (!badge.isConnected) return;
    if (!isSerifFont(getComputedStyle(badge))) return;
    pinInline(badge, {
        "font-family": '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    });
}

function afterLayout(el: HTMLElement, fn: () => void) {
    let frames = 0;
    const run = () => {
        if (el.isConnected) {
            fn();
            try { document.fonts?.ready.then(() => { if (el.isConnected) fn(); }); } catch { /* ignore */ }
            return;
        }
        if (++frames < 45) requestAnimationFrame(run);
    };
    requestAnimationFrame(run);
}

function renderMultiStrikeSvg(wrap: HTMLElement) {
    if (!wrap.isConnected) return;
    const rects = wrap.getClientRects();
    if (rects.length === 0) return;
    const origin = rects[0];
    let svg = wrap.querySelector(":scope > svg.mf-strike-svg") as SVGSVGElement | null;
    if (!svg) {
        svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("class", "mf-strike-svg");
        // margin/padding/border are pinned because this box is placed by `top: 0`, and an
        // absolutely positioned box sits at `top + margin-top`: a host rule on `svg`
        // (Substack: 8px) moves the whole rule down by that much, and padding or a border
        // moves the viewport the <line> coordinates are drawn in. Every offset in this
        // function is relative, so none of it shows up in the geometry below.
        svg.style.cssText = "position: absolute !important; left: 0px !important; top: 0px !important; margin: 0px !important; padding: 0px !important; border: 0px !important; width: 1px !important; height: 1px !important; overflow: visible !important; pointer-events: none !important; z-index: 2 !important;";
        wrap.appendChild(svg);
    }
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    // Not `wrap.style.textDecorationColor`: pinStrikeLayout pins the SHORTHAND
    // `text-decoration: none` after the colour was set as a longhand, which resets it —
    // reading it back yields the string "initial", truthy enough to defeat a fallback and
    // invalid as a stroke, so the line painted nothing at all.
    const red = strikethroughRed();
    for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        if (r.width <= 0) continue;
        const x1 = r.left - origin.left;
        const x2 = r.right - origin.left;
        // 0.59 of the fragment's font box (ascent + descent) is its x-band middle
        // (baseline - xHeight/2) — the same target as the diagonal overlay's
        // `calc(50% + 0.1em)`, expressed as a ratio because a wrapped strike has no
        // single box to size a percentage against. At 0.52 the rule sat a line-width
        // of ink too high on every wrapped strike.
        const y = (r.top - origin.top) + (r.height * 0.59);
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", String(x1));
        line.setAttribute("y1", String(y));
        line.setAttribute("x2", String(x2));
        line.setAttribute("y2", String(y));
        line.setAttribute("stroke", red);
        line.setAttribute("stroke-width", "2.2");
        line.setAttribute("stroke-linecap", "round");
        svg.appendChild(line);
    }
}

function pinStrikeLayout(wrap: HTMLElement, inner?: HTMLElement | null, line?: HTMLElement | null) {
    if (wrap.classList.contains("mf-strike-h")) {
        // Multi-word strikethroughs wrap natively across lines.
        // MUST be display: inline to avoid breaking the claim's highlight background.
        // Rounded line ends are rendered via per-rect SVG lines with stroke-linecap: round on each wrapped line.
        pinInline(wrap, {
            display: "inline",
            position: "relative",
            "text-decoration": "none",
            "white-space": "normal",
            "line-height": "inherit",
            "vertical-align": "baseline",
        });
        if (inner) {
            pinInline(inner, {
                display: "inline",
                "line-height": "inherit",
            });
        }
        if (line) {
            line.remove();
        }
        afterLayout(wrap, () => renderMultiStrikeSvg(wrap));
        if (typeof ResizeObserver !== "undefined") {
            const ro = new ResizeObserver(() => {
                if (wrap.isConnected) renderMultiStrikeSvg(wrap);
            });
            ro.observe(wrap);
        }
        return;
    }
    // Single-word strikethrough (diagonal slash overlay):
    // Display inline with position relative keeps the claim background continuous
    // while providing the containing block for the diagonal slash overlay.
    pinInline(wrap, {
        display: "inline",
        position: "relative",
        "line-height": "inherit",
        "vertical-align": "baseline",
        "white-space": "nowrap",
    });
    if (inner) {
        pinInline(inner, {
            display: "inline",
            "line-height": "inherit",
            position: "relative",
        });
    }
    if (line) {
        pinInline(line, {
            display: "block",
            position: "absolute",
            left: "0px",
            right: "0px",
            // The x-band middle of the wrap's own box — see the .mf-strike-line rule.
            // Pinned inline as well as styled, because a page's own `style` attribute
            // outranks any !important rule we can inject, and this is the one value the
            // strike cannot lose: at 50% it sits 1.4px high at 16px and 3px at display sizes.
            top: "calc(50% + 0.1em)",
            height: "2px",
            "border-radius": "999px",
            "margin-top": "-1px",
            // The other three sides only ever shrink or shift the bar if the host margins
            // `span`; `left`/`right` alone do not carry it, since a used margin is subtracted
            // from the auto width between them.
            "margin-left": "0px",
            "margin-right": "0px",
            "margin-bottom": "0px",
            "pointer-events": "none",
        });
    }
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

/** Hit-test that never throws on synthetic coordinates. Any script on the page can
 *  dispatch an event NAMED mousemove carrying no (or non-finite) coordinates — a real
 *  pointer move always names finite viewport pixels — and elementFromPoint throws on
 *  those. Null means "nothing was hit", which is what a coordinate-less move is. */
function mfElementFromPoint(x: number, y: number): Element | null {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    try {
        return document.elementFromPoint(x, y);
    } catch {
        return null;
    }
}

if (typeof window !== "undefined") {
    window.addEventListener("mousemove", (e) => {
        mfPointerX = e.clientX; mfPointerY = e.clientY;
        const stuck = mfSyntheticHoverSpan;
        if (!stuck) return;
        // Node re-rendered away: its stuck state went with it, just drop the reference.
        if (!stuck.isConnected) { mfSyntheticHoverSpan = null; return; }
        const atPoint = mfElementFromPoint(e.clientX, e.clientY);
        if (atPoint && claimHoverSiblings(stuck).some(s => atPoint === s || s.contains(atPoint))) return;
        mfSyntheticHoverSpan = null;
        stuck.dispatchEvent(new MouseEvent("mouseleave", { bubbles: false, clientX: e.clientX, clientY: e.clientY }));
    }, true);
}

/** Whether the last-known pointer position is inside `span` (mouse only — touch
 *  keeps the coords at -1). Used to decide hover-only badge creation under a
 *  stationary cursor, where no fresh mouseenter will fire to summon one. */
function isPointerOverSpan(span: HTMLElement): boolean {
    if (mfPointerX < 0 || mfPointerY < 0) return false;
    const atPoint = mfElementFromPoint(mfPointerX, mfPointerY);
    if (!atPoint) return false;
    return claimHoverSiblings(span).some(s => atPoint === s || s.contains(atPoint));
}

/** Whether the pointer is still on `span` by the measure every leave guard uses — the claim's
 *  padded silhouette, the leading between its line boxes included — rather than by the strict
 *  hit-test, which a wrapped claim's line gaps fail even though the pointer never left the claim.
 *  Anything the guards call hovering has to be able to come back after a rebuild for the same
 *  reason the guards keep it: otherwise the highlight the guards refused to drop is dropped by the
 *  rebuild that follows, and the pointer sitting in a gap gets a resting tint it cannot shake. */
function isPointerInClaimHoverArea(span: HTMLElement): boolean {
    if (mfPointerX < 0 || mfPointerY < 0) return false;
    return inClaimHoverArea(span, mfPointerX, mfPointerY);
}

/** If the pointer is currently on `span` — by the hit-test or, failing that, by the
 *  silhouette the leave guards use — re-fire a synthetic mouseenter
 *  so both hover layers (the span's own inline-badge listener AND the article-level
 *  preview-popover trigger) react as if the user had just entered it. This replicates
 *  the manual "move the mouse out and back in" the user otherwise has to do after an
 *  in-place transition the browser doesn't treat as a hover change (the cursor never
 *  moved). Because it just replays a real mouseenter, every existing guard (on-hold,
 *  permanent badge, already-open popover) is honoured unchanged. No-op if the pointer
 *  isn't on the span (or on touch, where the coords stay -1). */
function resyncHoverAtPointer(span: HTMLElement) {
    if (mfPointerX < 0 || mfPointerY < 0) return;
    const atPoint = mfElementFromPoint(mfPointerX, mfPointerY);
    if (!atPoint) return;
    // Strict hit first, then the measure every leave guard uses. The two disagree in a wrapped
    // claim's line gaps and past a short line's end — positions the guards count as still
    // hovering, because the pointer has not left the claim's silhouette — and a pointer resting
    // there is exactly the case this replay exists for: a claim whose state changed, or whose span
    // was rebuilt, under a hand that is not going to move. Declining to replay there leaves the
    // fresh span with no hover and no way to earn one back, which is the flicker.
    const over = claimHoverSiblings(span).find(s => atPoint === s || s.contains(atPoint))
        ?? (isPointerInClaimHoverArea(span) ? span : undefined);
    if (over) {
        // The user never moved, so the hover this replays was never lost as far as they are
        // concerned: the tint it paints is not a colour change to animate. The dispatch is what
        // is bracketed, not the paint — the span's own mouseenter handler walks the claim's
        // siblings and repaints every one of them.
        mfTintCommitsInstantly = true;
        try {
            over.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false, clientX: mfPointerX, clientY: mfPointerY }));
        } finally {
            mfTintCommitsInstantly = false;
        }
        // Track it so the next real mouse move can undo this if the coords were stale.
        mfSyntheticHoverSpan = over;
    }
}

/** Give back the hover a claim rebuild took away.
 *
 *  A rebuild replaces the span the pointer is resting on, and a fresh element is never
 *  *entered*: the hover tint, the hover badge and the pending preview wait all belonged to
 *  the node that just went away. With the pointer held still — a claim being read while its
 *  reasoning streams — the highlight under it drops back to the resting colour on every
 *  update the run broadcasts, which is the flicker. Replay the real mouseenter on whichever
 *  new span the pointer is over, exactly as the tweet path does after its own full rebuild,
 *  so every existing guard (on-hold, permanent badge, already-open popover) is honoured
 *  unchanged.
 *
 *  Deferred by one microtask on purpose. The span factory paints from a microtask of its
 *  own: `makeClaimSegmentNodes` stamps `dataset.hoverBg` and repaints the resting colour
 *  inside `reveal`, which it queues whenever the span is not yet connected — and a wrapping
 *  rebuild hands it a detached span. A tint painted before that reveal is painted over by
 *  it. Microtasks run in the order they were queued, so this lands after every reveal the
 *  rebuild scheduled, and still before the frame is painted: the passage never shows the
 *  resting colour at all. */
export function restoreHoverAfterClaimRebuild(container: Element) {
    if (mfPointerX < 0 || mfPointerY < 0) return;
    queueMicrotask(() => {
        if (!container.isConnected) return;
        const atPoint = mfElementFromPoint(mfPointerX, mfPointerY);
        if (!atPoint) return;
        // The container is the rebuilt passage (not the popover), so a hit outside every
        // claim here means the pointer is over something else — an open popover it may have
        // summoned — and nothing is owed back.
        const spans = Array.from(container.querySelectorAll<HTMLElement>(".mf-segment-claim"));
        // Falling back to the guards' own measure, because a pointer can be on a claim without
        // being on any part of it: the leading between two of its lines, or the space past a short
        // line's end, is inside the claim's silhouette and nowhere near a line box. Those are the
        // positions where the tint would otherwise drop to resting and stay there — no fresh
        // mouseenter fires while the pointer is between lines — which is the flicker.
        const under = spans.find(s => atPoint === s || s.contains(atPoint))
            // But never over a popover: a window flipped above a claim near the bottom of the
            // viewport sits inside that claim's silhouette, and a hit on it is the "something
            // else" above, not a hover.
            ?? (atPoint.closest && atPoint.closest(".mf-popover") ? undefined : spans.find(isPointerInClaimHoverArea));
        if (!under) return;
        // A semi-transparent preview open over this claim has just lost the span it hangs from.
        // Hand it to the replacement BEFORE the replay: the replay's own guard keeps an open
        // preview alive by recognising its trigger among the claim's pieces, and a trigger left
        // detached would instead start a fresh one-second dwell — the window would go away and
        // come back, which is the blink the user sees. (Not every surface calls
        // updateOpenPopover after its rebuild, so this is not redundant with the hand-off
        // there.)
        adoptDetachedPreviewTrigger();
        resyncHoverAtPointer(under);
    });
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
        // Color-only change: skip the wipe animation entirely — EXCEPT when a wipe is
        // actually in flight. Killing one here leaves background-color at the
        // 'transparent' the wipe set, and the base .mf-segment-claim transition then
        // fades the new colour up from nothing over 150ms: the highlight blinks nearly
        // away and fills back in, once per reconcile for as long as the run keeps
        // moving. Commit instantly instead, exactly as onEnd does. With no wipe in
        // flight this stays the plain, fading colour-only change it always was.
        const wasWiping = span.classList.contains('mf-highlight-reveal');
        span.classList.remove('mf-highlight-reveal');
        if (wasWiping) span.style.transition = 'none';
        span.style.removeProperty('background-image');
        span.style.removeProperty('background-size');
        span.style.removeProperty('background-position');
        span.style.removeProperty('background-repeat');
        paintClaimBg(span, bgColor);
        if (wasWiping) {
            // eslint-disable-next-line no-unused-expressions
            span.offsetHeight; // force reflow so the instant swap commits before transition is restored
            span.style.transition = '';
        }
        return;
    }

    const isRTL = isRTLLocale(getEffectiveUILocale());
    span.classList.add('mf-highlight-reveal');
    paintClaimBg(span, 'transparent');
    span.style.setProperty('background-image', `linear-gradient(to ${isRTL ? 'left' : 'right'}, ${bgColor}, ${bgColor})`, 'important');
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
        span.style.removeProperty('background-image');
        span.style.removeProperty('background-size');
        span.style.removeProperty('background-position');
        span.style.removeProperty('background-repeat');
        paintClaimBg(span, bgColor);
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
/** Every element a classification's post is currently rendered into — the seam's own
 *  roots, or X's article for a status link. Teardown is scoped per post, so it needs the
 *  same notion of "where this post lives" that injection has; an X-shaped lookup finds
 *  nothing on a platform that has no `/status/` URLs, and the post would never be torn
 *  down. */
function postContainersFor(id: string): Element[] {
    const seam = platformSeam();
    if (seam) return seam.postRoots(id);
    const out: Element[] = [];
    for (const link of document.querySelectorAll(`a[href*="/status/${id}"]`)) {
        const article = link.closest('article');
        if (article && !out.includes(article)) out.push(article);
    }
    return out;
}

function removeSegmentWraps(tweetId: string) {
    for (const root of postContainersFor(tweetId)) {
        const wraps = root.querySelectorAll<HTMLElement>('.mf-segment-wrap');
        for (const wrap of Array.from(wraps)) discardSegmentWrap(wrap);
    }
}

/** Drop one post's highlight paint from one root, when the classification being rendered
 *  gives it no claims to show.
 *
 *  Teardown otherwise happens only when a delivery REPLACES a held classification
 *  (`removeSegmentWraps` inside the merge), and both ends of that are scoped to the post's
 *  roots AT THAT MOMENT. A root that was painted and then left the adapter's set — Facebook
 *  renders one story twice, the modal and the card behind it, and the adapter keeps one of
 *  them (`postRootsFromDom`) — is never swept: the swap's teardown runs against the roots of
 *  the swap, not against the root that holds the paint. Re-entering the set does not help
 *  either, because a claims-less render tears nothing down; it builds no Hide/Reveal pill
 *  (`wantsVisual` needs claims), so the stale spans and their wrapper sit there revealed,
 *  showing highlights for claims that are no longer held. Measured on a permalink whose modal
 *  held nine claim spans for an id the bar showed as Disinfact.
 *
 *  Scoped by the claim spans' own `mfCid`, so a quoted post rendered inside the same root
 *  keeps its paint: a wrap whose spans all name another post is not this post's. */
function clearStaleSegmentPaint(article: Element, id: string) {
    for (const wrap of Array.from(article.querySelectorAll<HTMLElement>('.mf-segment-wrap'))) {
        const cids = Array.from(wrap.querySelectorAll<HTMLElement>('.mf-segment-claim'))
            .map((span) => span.dataset.mfCid);
        if (cids.length === 0) continue;
        if (!cids.every((cid) => cid === id)) continue;
        console.log(`[misinfo] clearStaleSegmentPaint: dropping ${cids.length} stale highlight span(s) for ${id}`);
        discardSegmentWrap(wrap);
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
    for (const article of postContainersFor(tweetId)) {
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
        const topBar = article.querySelector(`[mf-top-bar-id="${tweetId}"]`);
        if (topBar) topBar.remove();
        const tfc = article.querySelector(`[translate-fc-id="${tweetId}"]`);
        if (tfc) tfc.remove();
        const onHold = article.querySelector(`[mf-on-hold-id="${tweetId}"]`);
        if (onHold) onHold.remove();
        const refresh = article.querySelector(`[mf-refresh-id="${tweetId}"]`);
        if (refresh) refresh.remove();
        const visual = article.querySelector(`[mf-visual-id="${tweetId}"]`);
        if (visual) visual.remove();
    }
    processingOnHoldIds.delete(tweetId);
    processingTranslateFactChecksIds.delete(tweetId);
    refreshRunPendingIds.delete(tweetId);
    disinfactRunPendingIds.delete(tweetId);
}

/** Neutralize a segment wrap so the tweet text stays visible but carries no
 *  highlights, badges, or interactivity. The rendered text (and its links) is
 *  kept exactly as-is; only the extension styling is stripped, and all event
 *  listeners are dropped by replacing the node with a clone. The wrap is also
 *  un-classed so a later re-login re-renders segments from scratch. */
function freezeSegmentWrap(wrap: HTMLElement) {
    // An in-place wrap holds the PAGE's own nodes rather than ours, so stripping classes and
    // keeping the element would leave our bare <span> wrapped around the post's block content
    // for the rest of the page's life — and at `display: contents` no longer applying, the
    // block layout under it is the page's to keep, not ours to perturb. Unwrapping gives the
    // same result freezing is for — no highlights, no badges, no listeners, text intact —
    // with the host's own structure handed back exactly as it was.
    //
    // Our own nodes are INSIDE that wrap, though: the claim spans carrying the tint and the
    // badge pills beside them. Unwrapping the wrap alone hands those back with the page's
    // nodes, which is how Hide came to be a visual no-op on every in-place platform — the
    // button flipped to Reveal while every highlight and "Fact-Check" pill stayed on screen,
    // and a sign-out left the same debris behind. Strip them first, unwrapping each claim
    // span rather than removing it so the page's own nodes inside it (links included) are
    // handed back untouched. Same cleanup `wrapClaimSegmentsInPlace` does before a rebuild.
    //
    // Un-painting means more than unwrapping our spans on an in-place wrap: the paint may have
    // cut the page's own text nodes and left stand-in runs holding the post's text. Hide that
    // only unwraps leaves those stand-ins behind, so the page's next write into its own (now
    // empty) node lands beside the words it replaced — the host's toggle visibly flipping while
    // the old language stays on screen, with no wrap left for the stale-paint guard to catch it.
    if (wrap.dataset.mfInPlace === "1") {
        undoInPlacePaint(wrap);
        for (const badge of Array.from(wrap.querySelectorAll('.mf-inline-badge'))) badge.remove();
        for (const spinner of Array.from(wrap.querySelectorAll('.mf-standalone-spinner'))) spinner.remove();
        for (const span of Array.from(wrap.querySelectorAll<HTMLElement>('.mf-segment-claim'))) {
            span.replaceWith(...Array.from(span.childNodes));
        }
        wrap.replaceWith(...Array.from(wrap.childNodes));
        return;
    }
    for (const badge of Array.from(wrap.querySelectorAll('.mf-inline-badge'))) badge.remove();
    for (const spinner of Array.from(wrap.querySelectorAll('.mf-standalone-spinner'))) spinner.remove();
    for (const span of Array.from(wrap.querySelectorAll<HTMLElement>('.mf-segment-claim'))) {
        span.classList.remove('mf-segment-claim', 'mf-highlight-reveal');
        span.style.backgroundColor = '';
        span.style.removeProperty('--mf-hl');
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
        '[classification-id],[mf-unmatched],[translate-fc-id],[mf-on-hold-id],[mf-refresh-id],[mf-visual-id],[mf-top-bar-id],.mf-popover,.mf-onboard,.mf-onboard-attached,.mf-notif-container,.mf-floating-scroll-btn'
    );
    for (const el of Array.from(standalone)) el.remove();

    for (const path of Array.from(floatingButtonRegistry.keys())) clearFloatingButtonForPath(path, true);
    previewPopoverState = null;
    allClassifications.length = 0;
    processingOnHoldIds.clear();
    processingTranslateFactChecksIds.clear();
    refreshRunPendingIds.clear();
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

/** Escape a value for a double-quoted CSS attribute selector. `CSS.escape` is the wrong
 *  tool for this: it escapes for an IDENTIFIER (`"123"` becomes `\31 23`), not for a quoted
 *  string. Ids are machine-generated today, but a selector that silently matches nothing is
 *  worth two lines to rule out. */
function cssAttrValue(value: string): string {
    return value.replace(/[\\"]/g, '\\$&');
}

/** Every DOM subtree carrying a given classification's highlights.
 *
 *  Two shapes, because two features produce highlights. On X.com the id is a status id and
 *  the highlights live inside that tweet's `<article>` (or a quoted-tweet card). Anywhere
 *  else the id is a selection's classification id and the highlights are the segments the
 *  injected selection script wrapped around the user's own text. Resolving both in one place
 *  is what lets the visibility, direction and scroll helpers below stay page-agnostic: they
 *  were written against the tweet anchor and now serve a selection on an arbitrary page
 *  without knowing the difference.
 *
 *  An empty result means "nothing to point at" — the caller's cue to do nothing, exactly as
 *  it was when a tweet was simply absent from the DOM. */
export function classificationRoots(id: string): Element[] {
    const seam = platformSeam();
    if (seam) return seam.postRoots(id);

    const links = document.querySelectorAll(`a[href*="/status/${id}"]`);
    if (links.length > 0) {
        const roots: Element[] = [];
        for (const link of links) {
            roots.push(link.closest('article, div[role="link"], div[data-testid="card.wrapper"]') ?? link);
        }
        return roots;
    }

    const roots: Element[] = [];
    const wrap = selectionWrap(id);
    if (wrap) roots.push(wrap);
    return roots;
}

/** The wrap the selection script put around the user's own text, or null when this id is not
 *  a selection's — or when its highlights are gone.
 *
 *  The wrap, not the matched span: the visibility helpers search a root's DESCENDANTS for
 *  claim spans, and a span is not its own descendant. */
function selectionWrap(id: string): Element | null {
    const span = document.querySelector(`[data-mf-sel-id="${cssAttrValue(id)}"]`);
    if (!span) return null;
    return span.closest('.mf-segment-wrap') ?? span.parentElement ?? span;
}

/** The passage a selection's highlights cover, for the Fact-Checked button's hover preview.
 *  Deliberately NOT classificationRoots(): for a tweet that returns the article, whose text
 *  carries X's whole UI chrome, and findTweetTextInDom() has already answered for tweets.
 *  Empty when there is nothing to show, and the button then shows no preview at all. */
function selectionPassageText(id: string): string {
    return selectionWrap(id)?.textContent?.trim() ?? '';
}

/** Returns true if any representation of the classification (tweet article, quoted tweet
 *  card, or a webpage selection's highlight wrap) is within the viewport. */
function isTweetVisible(tweetId: string): boolean {
    for (const root of classificationRoots(tweetId)) {
        const rect = root.getBoundingClientRect();
        if (rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight) {
            return true;
        }
    }
    return false;
}

/** The claim spans the Fact-Checked button is about: the highlights it offers to take the
 *  reader back to.
 *
 *  The button is an offer to go back and read the results of a run the reader just paid for,
 *  and it is raised once no more of that run's claims are outstanding. Everything it does —
 *  whether it should be on screen at all, which way its arrow points, whose verdicts it lists
 *  on hover, what colour it takes — is a question about THAT run's claims and no others.
 *
 *  Two kinds of claim sit in the same root and had to be told apart. A claim left ON HOLD
 *  waits on the user's own Fact-Check click: idle, never part of the run, and its span stays
 *  un-verdicted. A claim verdicted by an EARLIER classification is finished but equally not
 *  this run's — its verdict was read long ago. Counting either made the button answer about
 *  highlights nobody had just bought: on a post taller than a screen, "every highlight
 *  visible" can never hold (all its spans cannot fit in one viewport at once), so the button
 *  stayed up for the rest of the session with its arrow on whichever un-bought claim sat
 *  nearest the fold. On X one screenful holds the whole tweet, so the readings coincided and
 *  hid this.
 *
 *  So the run's own claims come first, by text — the caller (the on-hold tracker) is the only
 *  thing that knows them, and an empty result is an answer ("those claims painted nothing
 *  here"), never an invitation to borrow another run's highlights. Without them, fall back to
 *  the spans that carry a verdict, which is what the badges paint from: probability and
 *  veracity are stamped `String(claim.confidence ?? "")`, so an un-verdicted claim's span holds
 *  empty strings. Selection wraps, and spans repainted by an older build, have neither and
 *  keep their old behaviour. */
function buttonClaimSpans(root: Element, claimTexts?: ReadonlySet<string>): Element[] {
    const spans = Array.from(root.querySelectorAll<HTMLElement>('span.mf-segment-claim'));
    if (claimTexts && claimTexts.size > 0) {
        return spans.filter(span => claimTexts.has(span.dataset.claimText ?? ''));
    }
    const verdicted = spans.filter(span =>
        (span.dataset.probability ?? '') !== '' && (span.dataset.veracity ?? '') !== ''
    );
    return verdicted.length > 0 ? verdicted : spans;
}

/** Returns true when EVERY highlighted claim the button is offering is fully inside the
 *  viewport.
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
function areTweetHighlightsVisible(tweetId: string, claimTexts?: ReadonlySet<string>): boolean {
    let sawLaidOutHighlight = false;

    for (const root of classificationRoots(tweetId)) {
        const spans = buttonClaimSpans(root, claimTexts);
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

/** Which way the user has to scroll to reach the nearest off-screen highlight the button is
 *  offering (see buttonClaimSpans), or null when none is laid out — the caller then falls
 *  back to the article's own rect.
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
function offScreenHighlightDirection(tweetId: string, claimTexts?: ReadonlySet<string>): 'above' | 'below' | null {
    let nearestAbove = Infinity;
    let nearestBelow = Infinity;
    let sawLaidOutHighlight = false;

    for (const root of classificationRoots(tweetId)) {
        for (const span of buttonClaimSpans(root, claimTexts)) {
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

/** Where the reader is, in the scroller that actually holds the content.
 *
 *  `window.scrollY` is that position only on a page that scrolls its own document. Several of
 *  the platforms here scroll an inner element instead — Telegram Web A scrolls its message
 *  list, so its document is exactly one viewport tall and `window.scrollY` is 0 at every
 *  moment — and a position that records the window alone then reports "the reader is at the
 *  top" wherever they really are. That is not a cosmetic difference, because the floating
 *  navigation buttons are built out of this number: the Go Back button was dismissed the
 *  instant it appeared (its "has the reader got back?" test held on every tick, since neither
 *  side ever moved) and clicking either button scrolled nothing at all. */
type ScrollMark = { container: Element | null; top: number };

/** The element that scrolls `el`, or null when the document is what scrolls it.
 *
 *  Read as the nearest ancestor that both declares itself a scroller and is currently
 *  overflowing — an ancestor that cannot scroll sends nothing anywhere, so it is skipped in
 *  favour of the document path the rest of the code has always used. */
function scrollContainerOf(el: Element | null): Element | null {
    for (let node = el?.parentElement ?? null; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
        const overflowY = getComputedStyle(node).overflowY;
        if (overflowY !== 'auto' && overflowY !== 'scroll' && overflowY !== 'overlay') continue;
        if (node.scrollHeight <= node.clientHeight + 1) continue;
        return node;
    }
    return null;
}

/** The reader's position around `el`, for a "come back to this" button. */
function markAt(el: Element | null): ScrollMark {
    const container = scrollContainerOf(el);
    return { container, top: container ? container.scrollTop : window.scrollY };
}

/** How far the reader has moved from a mark. Both sides read the mark's own scroller, so a
 *  document that cannot scroll does not read as "no distance" on a page whose list can. */
function markDistance(mark: ScrollMark): number {
    const now = mark.container ? mark.container.scrollTop : window.scrollY;
    return Math.abs(now - mark.top);
}

/** Animate a scroll position. A null container is the document scroller — the window path,
 *  unchanged. Duration is fixed at 1000ms regardless of distance. */
function animateScroll(container: Element | null, targetY: number, durationMs: number = 1000): Promise<void> {
    return new Promise(resolve => {
        const startY = container ? container.scrollTop : window.scrollY;
        const startTime = performance.now();
        const easeInOutCubic = (t: number) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

        function step(now: number) {
            const elapsed = now - startTime;
            const progress = Math.min(elapsed / durationMs, 1);
            const eased = easeInOutCubic(progress);
            const y = startY + (targetY - startY) * eased;
            if (container) container.scrollTop = y; else window.scrollTo(0, y);
            if (progress < 1) {
                requestAnimationFrame(step);
            } else {
                resolve();
            }
        }
        requestAnimationFrame(step);
    });
}

/** Smoothly scroll back to a mark. */
function scrollToMark(mark: ScrollMark, durationMs: number = 1000): Promise<void> {
    return animateScroll(mark.container, mark.top, durationMs);
}

/** Smoothly scroll so the top of the tweet — or of a selection's highlights — is visible.
 *
 *  The tweet path keeps its own narrow `article` lookup rather than going through
 *  classificationRoots(): that helper's selector list would also accept an inner
 *  `div[role="link"]`, which on X.com can sit inside the article and would move the scroll
 *  destination. A selection has no article at all, so only it takes the fallback. */
function scrollToTweet(tweetId: string, durationMs: number = 1000): Promise<void> {
    const article = document.querySelector(`a[href*="/status/${tweetId}"]`)?.closest('article');
    const target = article ?? classificationRoots(tweetId)[0];
    if (!target) return Promise.resolve();

    const container = scrollContainerOf(target);
    if (container) {
        // The content is in a scroller of its own, so the window has nothing to give: move the
        // container instead, leaving the same 80px of room above the target that the window
        // path leaves for a sticky header.
        const offset = target.getBoundingClientRect().top - container.getBoundingClientRect().top;
        return animateScroll(container, Math.max(0, container.scrollTop + offset - 80), durationMs);
    }

    // leave room for header
    return animateScroll(null, Math.max(0, target.getBoundingClientRect().top + window.scrollY - 80), durationMs);
}

const upArrowSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"></polyline></svg>`;
const downArrowSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`;

/** Compute the average highlight color across all finished claims in a classification.
 *  Ignores claims that are still researching or on-hold. Returns null if no color can be derived.
 *
 *  `claimTexts` restricts the average to one run's claims, for the same reason the hover list
 *  is restricted: the Fact-Checked button takes its colour from the highlights it is offering
 *  to return the reader to, so a verdict left over from an earlier classification must not
 *  tint it. */
function averageClaimColor(classification: Classification, claimTexts?: ReadonlySet<string>): { r: number; g: number; b: number } | null {
    const scoped = claimTexts && claimTexts.size > 0 ? claimTexts : null;
    const allClaims: Claim[] = [
        ...(classification.claims ?? []),
        ...(classification.quoting?.claims ?? [])
    ].filter(cl => !scoped || scoped.has(cl.text));
    const finished = allClaims.filter(cl =>
        cl.verdict !== "research required" &&
        !cl.refreshing &&
        cl.confidence !== undefined && cl.confidence !== null &&
        cl.veracity !== undefined && cl.veracity !== null
    );
    if (finished.length === 0) {
        // Fallback for any claims with veracity and confidence
        const withVeracity = allClaims.filter(cl =>
            cl.confidence !== undefined && cl.confidence !== null &&
            cl.veracity !== undefined && cl.veracity !== null
        );
        if (withVeracity.length === 0) return null;
        let rSum = 0, gSum = 0, bSum = 0;
        for (const cl of withVeracity) {
            const [r, g, b] = verdictColorChannels(cl.confidence, cl.veracity);
            rSum += r;
            gSum += g;
            bSum += b;
        }
        return {
            r: Math.round(rSum / withVeracity.length),
            g: Math.round(gSum / withVeracity.length),
            b: Math.round(bSum / withVeracity.length)
        };
    }

    let rSum = 0, gSum = 0, bSum = 0;
    for (const cl of finished) {
        const [r, g, b] = verdictColorChannels(cl.confidence, cl.veracity);
        rSum += r;
        gSum += g;
        bSum += b;
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

    if (state.btn) {
        if ((state.btn as any)._mfResizeListener) {
            window.removeEventListener('resize', (state.btn as any)._mfResizeListener);
            delete (state.btn as any)._mfResizeListener;
        }
        if (state.btn.isConnected) {
            state.btn.remove();
        }
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
                if (areTweetHighlightsVisible(newState.tweetId, newState.claimTexts)) {
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

/** Whether the classification target is solely within a tweet on X.com (first-class tweet
 *  integration or a selection made exclusively inside tweet articles). If the selection
 *  was on an X article, UI chrome, or non-tweet container, or on a general webpage, this
 *  returns false. */
export function isTweetTargetOnX(tweetId: string): boolean {
    const isX = /^(www\.)?(twitter|x)\.com$/i.test(window.location.hostname);
    if (!isX) return false;

    // Check status links on the page (first-class tweet or status anchor)
    const statusLinks = document.querySelectorAll(`a[href*="/status/${tweetId}"]`);
    if (statusLinks.length > 0) {
        for (const link of statusLinks) {
            if (link.closest('article[data-testid="tweet"]')) return true;
        }
    }

    const roots = classificationRoots(tweetId);
    if (roots.length > 0) {
        // Every root must be inside an article[data-testid="tweet"]
        return roots.every(root => !!root.closest('article[data-testid="tweet"]'));
    }

    // If roots are not in DOM right now but tweetId is a numeric status ID (first-class tweet)
    return /^\d+$/.test(tweetId);
}

/** Compute the center X coordinate of the timeline column on X. */
export function getTimelineColumnCenter(): number | null {
    const seam = platformSeam();
    if (seam) return seam.feedCenter();

    const primaryCol = document.querySelector<HTMLElement>('[data-testid="primaryColumn"]');
    if (primaryCol) {
        const rect = primaryCol.getBoundingClientRect();
        if (rect.width > 0) {
            return rect.left + rect.width / 2;
        }
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
    tweetId: string = '',
    claimTexts?: ReadonlySet<string>
): HTMLElement {
    const path = window.location.pathname;
    clearFloatingButtonForPath(path, true);
    setupNavigationListener();

    const isRTL = isRTLLocale(getEffectiveUILocale());
    const avgColor = classification ? averageClaimColor(classification, claimTexts) : null;
    const baseRgb = avgColor ? `${avgColor.r}, ${avgColor.g}, ${avgColor.b}` : "29, 155, 240";

    const shouldCenterOnTimeline = isNativePostTarget(tweetId);
    const timelineCenter = shouldCenterOnTimeline ? getTimelineColumnCenter() : null;
    const left = timelineCenter !== null ? `${timelineCenter}px` : '50%';
    const transform = 'translateX(-50%)';

    const btn = document.createElement("button");
    btn.className = "mf-floating-scroll-btn";
    if (shouldCenterOnTimeline) {
        const onResize = () => {
            const center = getTimelineColumnCenter();
            if (center !== null) {
                btn.style.left = `${center}px`;
            }
        };
        window.addEventListener('resize', onResize);
        (btn as any)._mfResizeListener = onResize;
    }
    btn.style.cssText = `
        position: fixed;
        ${position}: 80px;
        left: ${left};
        transform: ${transform};
        z-index: 2147483647;
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
        tweetId,
        claimTexts
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

    mountOverlayChrome(btn);
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
    // Nothing to quote back — a selection whose passage could not be read. Returning '' lets
    // showPreview() fall through to the claim list instead of growing the button by an empty,
    // padding-only div.
    if (!tweetText) return '';
    const preview = tweetText.length > 140 ? tweetText.slice(0, 140) + '...' : tweetText;
    // Shares escapeHtml() with renderClaims rather than keeping its own inline version — the
    // two had already drifted (this one escaped, renderClaims did not), which is exactly how
    // the injection above went unnoticed. Output is unchanged: the extra " and ' escapes
    // render as the same characters in a text node.
    const escaped = escapeHtml(preview);
    return `<div class="mf-fc-btn-preview" style="font-size:12px;line-height:1.35;font-weight:400;font-style:italic;opacity:0.92;text-align:${isRTL ? 'right' : 'left'};max-width:340px;white-space:normal;word-wrap:break-word;padding:4px 0;cursor:pointer;">${escaped}</div>`;
}

/** Done for the purposes of the Fact-Checked button: the claim has a VERDICT.
 *
 *  Deliberately does not wait on `note` (the reasoning). Reasoning and sources stream
 *  in afterwards and the popover renders them live, so gating on the note kept the
 *  button hidden long after the highlight had already settled on its final colour —
 *  the user could not be sent back to a tweet whose verdicts were, visibly, ready.
 *  The `verdict !== "research required"` guard stays: a claim can carry a DB-matched
 *  confidence/veracity while still awaiting its own research, and that must not count. */
function claimHasVerdict(cl: Claim) {
    return cl.verdict !== "research required"
        && cl.confidence !== undefined && cl.confidence !== null
        && cl.veracity !== undefined && cl.veracity !== null;
}

/** Build the claims list HTML for the Fact-Checked button hover state.
 *
 *  Verdicts only. A claim with no verdict is IDLE — it waits on the user's own Fact-Check
 *  click — so it is not work in progress, and the undefined-probability fallback (a
 *  researching word) under a "Fact-Checked" heading advertised research that was not
 *  happening. The post's own badges still offer every claim, checked or not.
 *
 *  When the caller knows which claims this run took on (`claimTexts`), those are the only
 *  rows. The post may already carry verdicts from an earlier classification — the reader
 *  watched those land, and listing them again under a button that announces the results of
 *  the run they just paid for claims credit the run did not earn. */
function factCheckedButtonClaimsHtml(classification: Classification, isRTL: boolean, claimTexts?: ReadonlySet<string>): string {
    const scoped = claimTexts && claimTexts.size > 0 ? claimTexts : null;
    const claims = (classification.claims ?? [])
        .map((claim, claimIndex) => ({ claim, claimIndex }))
        .filter(({ claim }) => claimHasVerdict(claim) && (!scoped || scoped.has(claim.text)));
    if (claims.length === 0) return '';
    const locale = getEffectiveUILocale();
    const q = quoteMarksForLocale(locale);
    // Each row carries its claim's index in the classification: the hover handler looks its
    // claim up positionally, and a filtered list no longer lines up with classification.claims.
    const rows = claims.map(({ claim: cl, claimIndex }) => {
        const display = (cl.rewritten && cl.rewritten !== cl.text) ? cl.rewritten : `${q.open}${cl.text}${q.close}`;
        const escaped = escapeHtml(display);
        const badgeHtml = verdictBadgeHtml(cl.confidence, cl.veracity);
        return `<div class="mf-fc-btn-claim" data-claim-index="${claimIndex}" style="display:flex;align-items:center;${isRTL ? 'flex-direction:row-reverse;' : 'flex-direction:row;'}gap:6px;margin:2px 0;white-space:nowrap;width:100%;cursor:pointer;"><span class="${VERDICT_BADGE_CLASS}" style="display:inline-flex;align-items:center;padding:2px 7px;border-radius:999px;font-size:10px;font-weight:600;background:rgba(0,0,0,0.5);color:#ffffff;white-space:nowrap;flex-shrink:0;">${badgeHtml}</span><span style="font-size:11px;${isRTL ? 'text-align:right;' : 'text-align:left;'}overflow:hidden;text-overflow:ellipsis;max-width:280px;opacity:0.95;">${escaped}</span></div>`;
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

/** Show the "Fact-Checked" floating button when the classified content is off-screen.
 *
 *  Serves both anchors: an X.com tweet (the id is a status id, and the caller is the on-hold
 *  scroll tracker) and a selection on an arbitrary webpage (the id is a selection's
 *  classification id, and the caller is trackSelectionFloatingButtons). Everything below is
 *  the same either way — the anchor resolution lives in classificationRoots(). */
function showFactCheckedFloatingButton(tweetId: string, classification: Classification, claimTexts?: ReadonlySet<string>) {
    if (areTweetHighlightsVisible(tweetId, claimTexts)) {
        console.log(`[misinfo] showFactCheckedFloatingButton ${tweetId}: all highlights visible, skipping`);
        return;
    }

    // What the hover preview quotes back to the user. A selection has no tweet text, so its
    // own wrapped passage stands in — that IS what the button offers to scroll them back to.
    const tweetText = findTweetTextInDom(tweetId) ?? selectionPassageText(tweetId);
    const isRTL = isRTLLocale(getEffectiveUILocale());
    const avgColor = averageClaimColor(classification, claimTexts);
    // 0.15 (not higher): the claim text stays white, so a strong brighten washes it
    // out and makes the hover list unreadable. A subtle lift keeps contrast intact.
    const brightened = avgColor ? brightenColor(avgColor, 0.15) : null;
    const normalRgb = avgColor ? `${avgColor.r}, ${avgColor.g}, ${avgColor.b}` : "29, 155, 240";
    const hoverRgb = brightened ? `${brightened.r}, ${brightened.g}, ${brightened.b}` : "29, 155, 240";

    const targetEl = document.querySelector(`a[href*="/status/${tweetId}"]`)?.closest('article')
        ?? classificationRoots(tweetId)[0];
    const targetRect = targetEl?.getBoundingClientRect();

    // Point at whatever the user actually has to scroll towards. The off-screen highlight is
    // the reason this button exists, so it — not the article's midpoint — decides the side and
    // the arrow. Only when no highlight is laid out do we fall back to the target-rect
    // inference: content above viewport => position 'top', arrow UP; below => 'bottom', DOWN.
    const highlightDirection = offScreenHighlightDirection(tweetId, claimTexts);
    const isTargetAbove = highlightDirection !== null
        ? highlightDirection === 'above'
        : (targetRect ? targetRect.bottom <= window.innerHeight / 2 : true);
    const position: 'top' | 'bottom' = isTargetAbove ? 'top' : 'bottom';
    const factCheckedIcon = position === 'top' ? upArrowSvg : downArrowSvg;

    const path = window.location.pathname;
    const btn = createFloatingButton(t("factCheckedFloatingButton"), factCheckedIcon, position, async () => {
        // Where the reader was when they asked to be taken there, in the scroller that holds
        // the content — what the Go Back button has to return them to.
        const capturedMark = markAt(targetEl);
        await scrollToTweet(tweetId, 1000);
        // Go Back button appears at opposite edge
        const goBackPosition: 'top' | 'bottom' = position === 'top' ? 'bottom' : 'top';
        showGoBackFloatingButton(tweetId, capturedMark, classification, goBackPosition, claimTexts);
    }, classification, tweetId, claimTexts);

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
        claimEls.forEach((claimEl) => {
            let badgeHoverTimer: ReturnType<typeof setTimeout> | null = null;

            claimEl.addEventListener("mouseenter", () => {
                if (isTouchInput()) return;
                if (badgeHoverTimer) clearTimeout(badgeHoverTimer);
                badgeHoverTimer = setTimeout(() => {
                    const state = floatingButtonRegistry.get(path);
                    if (!state?.hovered) return;
                    const claim = classification.claims?.[Number(claimEl.dataset.claimIndex)];
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
        // No passage to preview: the claim list is the only thing hovering can usefully
        // reveal, so go straight there rather than rendering an empty preview box.
        const previewHtml = factCheckedButtonPreviewHtml(tweetText, isRTL);
        if (!previewHtml) { showClaims(); return; }

        showingClaims = false;
        setHoverStyle();
        btn.style.borderRadius = "999px";
        btn.innerHTML = factCheckedButtonContent(
            previewHtml,
            t("factCheckedFloatingButton"), factCheckedIcon, isRTL, position
        );
    }

    function showClaims() {
        // Idempotent. On a platform whose passage cannot be read back there is no preview state
        // to return to: showPreview() falls through to here, so the mouseover over the label —
        // the one region that has a handler calling showPreview() — rebuilds the button's
        // innerHTML while the cursor is on it, where the claim rows below are left alone. That
        // asymmetry is the reported "the Fact-Checked part was not clicking; the rest was":
        // the swap replaces the element the cursor is pressing. Entering the state twice has
        // nothing to add, so the second call is dropped.
        if (showingClaims) return;
        showingClaims = true;
        setHoverStyle();
        btn.innerHTML = factCheckedButtonContent(
            factCheckedButtonClaimsHtml(classification, isRTL, claimTexts),
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
            if (areTweetHighlightsVisible(tweetId, claimTexts)) {
                clearFloatingButtonForPath(path, true);
            }
        }, 500);
    }
}

/** Show the "Go Back" floating button after scrolling to the tweet. */
function showGoBackFloatingButton(tweetId: string, mark: ScrollMark, classification: Classification, position: 'top' | 'bottom' = 'bottom', claimTexts?: ReadonlySet<string>) {
    const label = t("goBackFloatingButton");
    const isRTL = isRTLLocale(getEffectiveUILocale());
    const path = window.location.pathname;

    // Point arrow towards direction of scroll when clicked:
    // If the mark is above where the reader is now, arrow points UP; below, DOWN.
    const goBackIcon = mark.top < (mark.container ? mark.container.scrollTop : window.scrollY) ? upArrowSvg : downArrowSvg;

    const btn = createFloatingButton(label, goBackIcon, position, async () => {
        await scrollToMark(mark, 1000);
    }, classification, tweetId, claimTexts);

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
            if (markDistance(mark) < 5) {
                clearFloatingButtonForPath(path, true);
            }
        }, 500);
    }
}

/** Ids whose Fact-Checked button has already been offered on this page. A second Disinfact on
 *  the same page is a different selection with a different id, so it gets its own offer; the
 *  same id is offered once, which is what stops every later classification update from
 *  re-creating a button the user has already dismissed. Bounded by the number of selections
 *  fact-checked in one page session — the script runs once per page load. */
const selectionButtonShown = new Set<string>();

/** Offer the "Fact-Checked" floating button for a selection whose highlights became
 *  classified while off-screen — exactly the tweet flow's rule ("only if the highlight
 *  BECOMES classified while offscreen; if it's already classified there's no point").
 *
 *  Called by the injected selection script on every classification update and on scroll —
 *  the two moments the answer can change. It is a no-op until the run has settled, so it is
 *  safe to call as often as the caller likes.
 *
 *  Transition semantics, not state: a run that settles while its highlights are ON screen
 *  never earns the button (the user watched the verdicts land), and no later scroll can
 *  conjure it. Only a run that is STILL settling when its highlights leave the screen —
 *  the verdicts landing onto a passage the user has already read past — arms it, and the
 *  button then shows on the next check. Once fired (or once settled on-screen), the id is
 *  retired. */
export function trackSelectionFloatingButtons(classification: Classification): void {
    const id = classification.id;
    if (selectionButtonShown.has(id)) return;

    const claims = classification.claims ?? [];
    if (claims.length === 0) return;

    /** The same bar the tweet flow uses (claimHasVerdict). A claim sitting on hold is idle —
     *  waiting on the user's own Disinfact click, not on a result — so it does not hold the
     *  button back; and at least one verdict must exist, because the button is an invitation
     *  to go back and read a result and there is nothing to read until then. */

    // The claim checks run before any DOM work: the caller drives this from a scroll handler,
    // and until the run settles every scroll event lands here and should cost nothing.
    if (!claims.some(claimHasVerdict)) return;
    const settled = claims.every(cl => claimHasVerdict(cl) || cl.reclassifyOnHold === true);

    // Nothing to point at: the claims found no text to anchor to and rendered as a list
    // instead of highlights, or the wrap has since gone. A button that scrolls nowhere is
    // worse than no button.
    if (!selectionWrap(id)) return;

    const visible = areTweetHighlightsVisible(id);
    if (settled) {
        // The run has finished. If its highlights are on screen, the user watched the
        // verdicts land — there is nothing to offer.
        // If they are off screen (the user scrolled away while the text was being classified),
        // offer the button to return to the fact-checked claims.
        if (visible) {
            selectionButtonShown.add(id);
            selectionButtonArmed.delete(id);
            return;
        }
        selectionButtonShown.add(id);
        selectionButtonArmed.delete(id);
        showFactCheckedFloatingButton(id, classification);
        return;
    }

    // Still settling: remember whether its highlights are currently off screen. Only a
    // run that is off screen now can settle "while offscreen" — the one case the button
    // exists for. A run that is on screen keeps no arm (and drops one it had — the user
    // scrolled back before the verdicts landed, so they will watch them land).
    if (visible) selectionButtonArmed.delete(id);
    else selectionButtonArmed.add(id);
}

/** Runs armed for the floating button: settling while their highlights are off screen.
 *  Kept apart from `selectionButtonShown` (retired ids) so the arm can be DROPPED when
 *  the user scrolls back mid-run — watching the verdicts land on screen means the
 *  transition the button exists for never happened. */
const selectionButtonArmed = new Set<string>();

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

    /** Only a claim that is actually IN FLIGHT can hold the button back.
     *
     *  A claim sitting on hold is idle — it is waiting on the user's own Fact-Check click,
     *  not on a result — so it must not count as outstanding. Otherwise fact-checking one
     *  claim on a multi-claim tweet left the others permanently un-verdicted, the pending
     *  set never emptied, and the button never appeared at all for a partial check. */
    const isAwaitingVerdict = (cl: Claim) => !claimHasVerdict(cl) && cl.reclassifyOnHold !== true;

    for (const cl of allClaims) {
        if (isAwaitingVerdict(cl) && !state.pendingClaimTexts.has(cl.text)) {
            state.pendingClaimTexts.add(cl.text);
        }
        // Every claim this run takes on stays on the books, even once its verdict lands —
        // that set is what the button offers. A claim that already carried a verdict when
        // the run started is never awaiting one, so an earlier run's results never enter it.
        if (isAwaitingVerdict(cl)) state.keptClaimTexts.add(cl.text);
    }

    // Clear anything that is no longer outstanding — either it produced a verdict, or it
    // went back on hold (a reverted/cancelled research), which makes it idle rather than
    // pending and must not strand the set at a non-zero size forever.
    for (const cl of allClaims) {
        if (!isAwaitingVerdict(cl)) {
            state.pendingClaimTexts.delete(cl.text);
        }
    }

    console.log(`[misinfo] updateOnHoldScrollTracking ${classification.id}: pending=${state.pendingClaimTexts.size}, kept=${state.keptClaimTexts.size}, anyFresh=${allClaims.some(cl => cl.freshlyResearched)}, tweetVisible=${isTweetVisible(classification.id)}, highlightsVisible=${areTweetHighlightsVisible(classification.id, state.keptClaimTexts)}`);

    if (state.pendingClaimTexts.size === 0) {
        const anyCompleted = allClaims.some(claimHasVerdict);
        if (anyCompleted) {
            console.log(`[misinfo] updateOnHoldScrollTracking ${classification.id}: showing Fact-Checked button`);
            showFactCheckedFloatingButton(classification.id, classification, state.keptClaimTexts);
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

/** Escape text before interpolating it into an HTML template string.
 *
 *  Mandatory for anything derived from a tweet. Claim text is a verbatim span of the post and
 *  reasoning is model output about it, so both are attacker-influenced — and htmlDecode()
 *  above runs on them first (see the cl.text/cl.rewritten calls), which turns X's own escaped
 *  `&lt;img&gt;` back into a live `<img>`. Interpolating that into innerHTML would parse it as
 *  markup and let an inline handler run in x.com's page context: an injection point the
 *  platform itself does not have, since X escapes its rendering of the same text.
 *
 *  Every value passed through here is rendered as a text node, so these five characters are
 *  sufficient; nothing lands in an unquoted attribute. Escaping cannot double-encode, because
 *  the inputs are decoded before they get here. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
        if (!c.onHold && !c.preclassifying) {
            disinfactRunPendingIds.delete(c.id);
            processingOnHoldIds.delete(c.id);
        }
        // A (re)preclassification re-derives the tweet's claim links from
        // scratch (insert_tweet DELETEs them), so any annotation run left
        // over from the previous round — Flow A seed or Flow B pending — can
        // never land: its link row is gone, its persist matches 0 rows and
        // broadcasts nothing. Drop this tweet's keys so the fresh keyless
        // claims offer the idle Annotate button instead of a ghost
        // "Annotating" that only dies at the 1–3 min timeout.
        if (c.preclassifying) {
            clearAnnotateStateForTweet(c.id);
            if (c.quoting?.id && c.quoting.id !== c.id) clearAnnotateStateForTweet(c.quoting.id);
        }
        if (!c.localizingHighlights) {
            // No localization in flight → any click marker is stale. This covers
            // the failure-restore broadcast (hold back on, localizing off): the
            // spinner must die with the run, not linger out the 30s click timeout
            // next to the restored idle button. While a run IS in flight the
            // marker is redundant anyway (wantsSpinner covers localizingHighlights).
            processingTranslateFactChecksIds.delete(c.id);
        }

        if (c.quoting?.id) {
            requestQuotedDbFetch(c.quoting.id, c.id);
        }

        const idx = allClassifications.findIndex(x => x.id === c.id);
        if (idx >= 0) {
            const old = allClassifications[idx];
            // One post is read from more than one trace, and only the trace holding the
            // text a claim's ranges were measured against can bind them; a sibling trace of
            // the same post arrives with the revision gate stripped, so its claims carry no
            // highlight and no annotations. Adopting that emptier copy is what un-marks the
            // body, plants the claim-less placeholder below (which reports every claim
            // unmatched and renders the fallback box), and offers Annotate again on a claim
            // that is already annotated. `claimsEqual` deliberately ignores highlight and
            // annotations, so when it calls these the same claims they ARE the same claims:
            // keep what the held copy has and this delivery does not carry. A genuinely new
            // revision — or a fresh annotation — arrives WITH the field and wins as always.
            if (claimsEqual(c.claims, old.claims)) {
                const n = c.claims?.length ?? 0;
                for (let i = 0; i < n; i++) {
                    const cl = c.claims![i], prev = old.claims![i];
                    if (!cl.highlight || Object.keys(cl.highlight).length === 0) {
                        if (prev.highlight && Object.keys(prev.highlight).length > 0) cl.highlight = prev.highlight;
                    }
                    if (!cl.annotations || Object.keys(cl.annotations).length === 0) {
                        if (prev.annotations && Object.keys(prev.annotations).length > 0) cl.annotations = prev.annotations;
                    }
                }
            }
            const claimsChanged = !claimsEqual(c.claims, old.claims);
            const highlightsChanged = c.claims?.some((cl, i) => {
                const oldCl = old.claims?.[i];
                return oldCl && JSON.stringify(cl.highlight) !== JSON.stringify(oldCl.highlight);
            }) ?? false;
            const localeChanged = c.translatedLocale !== old.translatedLocale || c.textLocale !== old.textLocale;
            const flagChanged = reclassifyFlagChanged(c.claims, old.claims);
            const needsRedo = claimsChanged || highlightsChanged || localeChanged || flagChanged;
            const annotationsChanged = c.claims?.some((cl, i) => {
                const oldCl = old.claims?.[i];
                return oldCl && JSON.stringify(cl.annotations ?? {}) !== JSON.stringify(oldCl.annotations ?? {});
            }) ?? false;
            if (needsRedo || annotationsChanged) {
                console.log(`[misinfo] injectClassifications: change detected for ${c.id} (claims=${claimsChanged}, highlights=${highlightsChanged}, locale=${localeChanged}, annotations=${annotationsChanged})`);
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
            // Annotation-only change (a Flow-A/B broadcast with no verdict movement):
            // segments stay valid (correction ranges don't move claim spans), so skip
            // the re-derivation above and let upgradeToSegments sync the dataset
            // in place, then repaint the popover section below.
            if (!needsRedo && annotationsChanged && c.segments && old.segments) {
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
        let maxTimeout: NodeJS.Timeout | null = null;

        const runInjections = () => {
            if (debounceTimeout) { clearTimeout(debounceTimeout); debounceTimeout = null; }
            if (maxTimeout) { clearTimeout(maxTimeout); maxTimeout = null; }
            classificationInjections(allClassifications);
            refreshOnboarding();
            // Re-squeeze after host-driven DOM churn (theme toggles, timeline
            // re-renders): a pass that ran mid-transition can leave a stale cap
            // with no later trigger to clear it. Caps-clear-first makes this a
            // pure healing pass once layout has settled.
            for (const slot of Array.from(document.querySelectorAll<HTMLElement>('[mf-top-bar-id], [mf-on-hold-id], [translate-fc-id], [mf-refresh-id], [mf-visual-id]'))) {
                const article = slot.closest('article');
                if (article) updateTopButtonSqueeze(article);
            }
        };

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

            // Schedule a guaranteed max-wait run so rapid continuous scrolling
            // doesn't indefinitely starve injection of newly mounted tweets.
            if (!maxTimeout) {
                maxTimeout = setTimeout(runInjections, 200);
            }

            if (debounceTimeout) clearTimeout(debounceTimeout);
            debounceTimeout = setTimeout(runInjections, 100);
        });
        observer.observe(document.body, {
            childList: true,
            subtree: true,
        });

        // The page rewriting a post's text in place — its own translate toggle handing the new
        // language to the node it made — leaves nothing but a `characterData` record: no node is
        // added, no element is re-rendered, and the injection observer above therefore never
        // hears it. Kept separate for exactly that reason (it must not run injections on every
        // keystroke), and scoped to the wrap the mutated node sits in, so the cost is one
        // `closest` per mutation.
        const paintObserver = new MutationObserver((mutations) => {
            let dropped: Set<string> | null = null;
            for (const mutation of mutations) {
                const node = mutation.target;
                const el = (node.nodeType === Node.ELEMENT_NODE ? node : (node as ChildNode).parentElement) as Element | null;
                if (!el?.closest) continue;
                const wrap = el.closest<HTMLElement>('.mf-segment-wrap.mf-in-place');
                if (!wrap || !inPlacePaintIsStale(wrap)) continue;
                const id = wrap.querySelector<HTMLElement>('.mf-segment-claim')?.dataset.mfCid ?? '?';
                console.log(`[misinfo] in-place paint dropped for ${id}: the page rewrote the text under it`);
                undoInPlacePaint(wrap);
                if (id !== '?') {
                    if (!dropped) dropped = new Set();
                    dropped.add(id);
                }
            }
            // Put those posts back in THIS task. Un-painting here is instant, but the pass that
            // repaints them is only debounced behind a host *childList* change — and the write
            // that got us here is a characterData one, which that observer never sees. So
            // waiting leaves the reader looking at the post's own words with no highlights for
            // 100–200ms, and returning them only if the page happens to mutate again; that is
            // the highlights flipping away and back that a reader sees on a host which
            // re-renders the posts it handed us to paint. The work and every guard are the
            // pass's own (a body no longer matching its segments is refused by
            // wrapClaimSegmentsInPlace either way) — only the moment it lands changes, and
            // nothing is painted in between.
            const ids = dropped;
            if (ids) classificationInjections(allClassifications.filter((c) => ids.has(c.id)));
        });
        paintObserver.observe(document.body, { characterData: true, subtree: true });
    }
}

/** Selector matching every element the extension injects, so the timeline
 *  MutationObserver can distinguish host-page (real tweet) changes from our own. */
const MF_OWN_SELECTOR = '.mf-segment-wrap, .mf-popover, .mf-onboard, .mf-notif-container, .mf-floating-scroll-btn, .mf-btn-container, .mf-spinner-slot, [mf-on-hold-id], [classification-id], [mf-unmatched], [translate-fc-id], [mf-refresh-id], [mf-visual-id], [mf-top-bar-id]';

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
    const targetEl = (m.target?.nodeType === 1 ? m.target : m.target?.parentElement) as Element | null;
    if (targetEl && (targetEl.matches?.(MF_OWN_SELECTOR) || targetEl.closest?.(MF_OWN_SELECTOR) != null)) {
        return false;
    }
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

    // Do NOT decode cl.text. It is the claim's identity, not just its label: it travels to
    // the background on every claim action and is matched with === against the cached claim
    // (refreshClaim, awaitClaimDbRow, researchCache, mergeSingleClaimAndBroadcast). X is the
    // one platform whose payload is HTML-escaped, so decoding only the DOM's copy made the
    // background's claim ("…watermarks to ChatGPT &amp; Codex…") and the clicked text
    // ("…watermarks to ChatGPT & Codex…") differ — every lookup missed, and the fact-check
    // ran, billed the user, and landed its verdict nowhere. `rewritten` is display text and
    // a research query, never a key, so decoding it is fine.
    for (const cl of claims) {
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

    // Last resort before the fallback box: the worker's stored ranges, when they name the
    // body under exactly one key. Text matching above can only succeed if a claim's own words
    // appear in the post, and the workers do NOT promise that — they return the claim as
    // normalized prose (live example: claim "nearly 70% of patients in the mRNA-4157 vaccine
    // group" against a post reading "NEARLY 70% of people in the vaccine group"), while the
    // range they stored with it is exact. Without this, such a post shows no highlights at all
    // — every claim lands in the fallback box — even though its ranges tile the body.
    //
    // A translated tweet names its range key outright (above); an untranslated one has no
    // locale field, because for an untranslated body the key is just the language the worker
    // classified in and nothing needs translating. Hence keying off the claims themselves, and
    // only when they agree on ONE key: a range addresses words, and several candidate
    // languages of similar length would let a verdict land on an arbitrary span — worse than
    // showing none. Ranges are trusted here exactly as the translated path trusts them.
    if (!mainSegments) {
        const rangeKeys = new Set<string>();
        for (const cl of claims) {
            for (const key of Object.keys(cl.highlight ?? {})) rangeKeys.add(key);
        }
        const onlyKey = rangeKeys.size === 1 ? [...rangeKeys][0] : null;
        if (onlyKey) {
            mainSegments = breakupWithHighlights(tweetText, claims, onlyKey);
            if (mainSegments) {
                console.log(`[misinfo] Text breakup: matched via stored ranges under ${onlyKey} for ${classification.id}`);
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
 *  copy. Note the text may be truncated for long tweets.
 *
 *  Inline annotation paint (correction text nodes inside our own segments) would corrupt
 *  this read, which feeds breakup offsets — so our overlay/correction nodes are skipped
 *  via mfPlainText(). Callers comparing against cached translations already go through
 *  findXOwnedTweetText (parked originals), which needs no such filter. */
function mfPlainText(el: Element): string {
    let out = '';
    const walk = (node: Node): void => {
        if (node instanceof HTMLElement) {
            // Our inline annotation overlays: the strike wrap (its data holds the
            // original substring) and the correction node (not tweet text at all).
            if (node.classList.contains("mf-corr")) return;
            if (node.classList.contains("mf-strike")) {
                out += node.dataset.mfStrike ?? node.textContent ?? '';
                return;
            }
            if (node.classList.contains("mf-inline-badge") || node.classList.contains("mf-standalone-spinner")) return;
            for (const child of Array.from(node.childNodes)) walk(child);
        } else if (node.nodeType === Node.TEXT_NODE) {
            // Text nodes only. A comment node's textContent is its data, which is not
            // rendered content: Naver Cafe's smart editor brackets every text module with
            // comments carrying its own template markup (" SE-TEXT { " / " } SE-TEXT "), and
            // counting them made this string disagree with the post's classified text (which
            // comes from textContent, and textContent excludes comments) by exactly the
            // comments' length — so every highlight on such a post was refused here as a
            // suspected translation swap.
            out += node.textContent ?? '';
        }
    };
    walk(el);
    return out;
}
function findTweetTextInDom(tweetId: string): string | null {
    const tryGetText = (article: Element, bestEffort = false): string | null => {
        const tweetTextEl = article.querySelector('[data-testid="tweetText"]');
        if (tweetTextEl?.textContent) return mfPlainText(tweetTextEl);
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
export function getArticleMainStatusId(article: Element): string | null {
    const seam = platformSeam();
    if (seam) return seam.postIdOf(article);

    for (const link of article.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]')) {
        const quotedCard = link.closest('div[role="link"]');
        if (quotedCard && article.contains(quotedCard)) continue;
        const match = link.href.match(/\/status\/(\d+)/);
        if (match) return match[1];
    }
    return null;
}

/** Every on-screen occurrence of a post, as the (timestamp anchor, container, isQuoted)
 *  triple the injector consumes.
 *
 *  On X both come from the status permalink: the post is found by its `/status/<id>`
 *  link and the article enclosing that link. A DOM-fed platform has no such link — the
 *  root element IS the post, and on Reddit a comment carries no permalink node at all —
 *  so there the adapter's roots serve as both.
 *
 *  A post can appear more than once on a page (a timeline entry plus the card it
 *  quotes, say), so this returns every occurrence rather than assuming one; `isQuoted`
 *  is derived from which post each container actually holds. */
function postOccurrences(id: string): { time: Element; article: Element; isQuoted: boolean }[] {
    const seam = platformSeam();
    const out: { time: Element; article: Element; isQuoted: boolean }[] = [];
    if (seam) {
        for (const root of seam.postRoots(id)) {
            const mainStatusId = seam.postIdOf(root);
            out.push({ time: root, article: root, isQuoted: mainStatusId !== null && mainStatusId !== id });
        }
        return out;
    }
    for (const time of document.querySelectorAll(`a[href*="/status/${id}"]`)) {
        const article = time.closest("article");
        if (!article) continue;
        const mainStatusId = getArticleMainStatusId(article);
        out.push({ time, article, isQuoted: mainStatusId !== null && mainStatusId !== id });
    }
    return out;
}

/** Locate every on-screen occurrence of each classification's tweet and inject into it. */
function classificationInjections(classifications: Classification[]) {
    if (extensionFrozen) return;
    syncQuotingClassifications();
    for (const classification of classifications) {
        const occurrences = postOccurrences(classification.id);
        if (occurrences.length === 0) {
            console.log(`[misinfo] classificationInjections: no DOM elements found for ${classification.id}`);
        }
        for (const { time, article, isQuoted } of occurrences) {
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
export function verdictLabel(probability: number | undefined, veracity?: number, seed?: string): string {
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

/** Which of a badge template's positional arguments holds which piece of the label. */
type BadgeSlotRole = "conf" | "ver" | "verdict";

/** Stand-ins for a template's arguments while its literal text is read back. These are
 *  control characters, so no locale string can contain one and the split stays exact. */
const BADGE_SENTINELS = ["\u0001", "\u0002", "\u0003"] as const;

/** The score as a whole percentage, for the hover swap. Veracity's sign is dropped:
 *  the verdict word already says true or false. */
function scorePercent(score: number): string {
    return `${Math.min(100, Math.max(0, Math.round(Math.abs(score) * 100)))}%`;
}

/** Verdict badges whose adjectives swap to percentages on hover are marked with this
 *  class. Separate from mf-inline-badge, which carries the badge's own chrome and is
 *  not applied to the Fact-Checked button's badges. */
const VERDICT_BADGE_CLASS = "mf-verdict-badge";

/** Read a rendered badge template back as its literal runs and its argument slots.
 *
 *  Each argument is substituted as a sentinel rather than as its own text, so what comes
 *  back are exactly the literals this locale puts between the pieces (" to be " in en).
 *  Nothing about spacing or word order is assumed here. */
function parseBadgeTemplate(key: string, roles: BadgeSlotRole[]): { role: BadgeSlotRole | null; text: string }[] {
    const rendered = t(key, roles.map((_, i) => BADGE_SENTINELS[i]));
    const pieces: { role: BadgeSlotRole | null; text: string }[] = [];
    let literal = "";
    for (const ch of rendered) {
        const idx = BADGE_SENTINELS.indexOf(ch as (typeof BADGE_SENTINELS)[number]);
        if (idx >= 0 && idx < roles.length) {
            pieces.push({ role: null, text: literal }, { role: roles[idx], text: "" });
            literal = "";
        } else {
            literal += ch;
        }
    }
    pieces.push({ role: null, text: literal });
    return pieces;
}

/** The adjectives, verdict word and locale template a badge should show for a pair of
 *  scores. Mirrors verdictLabel() branch for branch so the two never disagree. */
type BadgeParts = {
    /** Template to lay the badge out with, plus the role each of its positional
     *  arguments plays. Null when no adjective applies and the badge is a bare word. */
    template: { key: string; roles: BadgeSlotRole[] } | null;
    verdict: string;
    confAdj: string | null;
    verAdj: string | null;
};

function verdictBadgeParts(probability: number, veracity?: number): BadgeParts {
    const trueLabel = t("verdictTrue");
    const falseLabel = t("verdictFalse");

    // Below 0.2 the model won't commit to a direction, whatever the veracity says.
    if (probability < 0.2) {
        return { template: null, verdict: t("verdictUnknown"), confAdj: null, verAdj: null };
    }

    if (veracity === undefined) {
        // Research has only landed one score: its magnitude reads as likelihood, and it
        // takes the template's single adjective slot, ahead of the verdict word.
        const abs = Math.abs(probability);
        let likelihoodKey: string | null;
        if (abs >= 0.9) likelihoodKey = null;
        else if (abs >= 0.8) likelihoodKey = "VeryLikely";
        else if (abs >= 0.5) likelihoodKey = "Likely";
        else likelihoodKey = "Possibly";
        return {
            template: likelihoodKey ? { key: "badgeAdjVerdict", roles: ["conf", "verdict"] } : null,
            verdict: probability >= 0 ? trueLabel : falseLabel,
            confAdj: likelihoodKey ? t("adj" + likelihoodKey) : null,
            verAdj: null,
        };
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
    const parts: BadgeParts = {
        template: null,
        verdict: veracity > 0 ? trueLabel : falseLabel,
        confAdj: probKey ? t("adj" + probKey) : null,
        verAdj: verKey ? t("adj" + verKey) : null,
    };
    if (probKey && verKey) {
        parts.template = {
            key: probKey === "VeryLikely" ? "badgeAdjVerdictAdj2Verbose" : "badgeAdjVerdictAdj2",
            roles: ["ver", "verdict", "conf"],
        };
    } else if (probKey) {
        parts.template = { key: "badgeVerdictAdj", roles: ["verdict", "conf"] };
    } else if (verKey) {
        parts.template = { key: "badgeAdjVerdict", roles: ["ver", "verdict"] };
    }
    return parts;
}

/** Build a claim badge's inner HTML, with the confidence and veracity adjectives in slots
 *  that swap to their percentage on hover.
 *
 *  Every locale puts the confidence adjective, then the veracity adjective, then the
 *  verdict word, so the template's literals can be handed to the slot they follow as that
 *  slot's trailing glue. A slot therefore carries its own separator: while it is hidden
 *  the separator goes with it, and the badge reads exactly like the plain verdictLabel()
 *  string. A slot holding no adjective (a score of 0.9 or better gets no qualifier) stays
 *  out of the layout until the verdict word is hovered, when it takes only the width its
 *  percentage needs. */
export function verdictBadgeHtml(probability: number | undefined, veracity?: number, seed?: string): string {
    if (probability === undefined) return escapeHtml(pickResearchingWord(seed));

    const parts = verdictBadgeParts(probability, veracity);
    const pieces = parts.template ? parseBadgeTemplate(parts.template.key, parts.template.roles) : [];

    // Walk the template in order, handing each literal run to the piece it follows.
    type BadgeSlot = { role: "conf" | "ver"; adj: string | null; glue: string; pct: string };
    type BadgePiece = BadgeSlot | { role: "verdict"; glue: string };
    const order: BadgePiece[] = [];
    let current: BadgePiece | null = null;
    for (const piece of pieces) {
        if (!piece.role) {
            if (current) current.glue += piece.text;
            continue;
        }
        current = piece.role === "verdict"
            ? { role: "verdict", glue: "" }
            : {
                role: piece.role,
                adj: piece.role === "conf" ? parts.confAdj : parts.verAdj,
                glue: "",
                pct: piece.role === "conf" ? scorePercent(probability) : scorePercent(veracity ?? 0),
            };
        order.push(current);
    }

    // A badge with no adjective at all ("True", "Unknown") has no template to walk, so
    // the verdict word goes in on its own and the slots are inserted ahead of it.
    if (!order.some(p => p.role === "verdict")) order.push({ role: "verdict", glue: "" });

    // A score with no adjective still has a percentage worth showing, so its slot goes
    // where the template would have put it, borrowing the neighbouring slot's separator
    // (or, with no slot to copy, the plain adjective→verdict join).
    const wanted: BadgeSlot[] = [{ role: "conf", adj: parts.confAdj, glue: "", pct: scorePercent(probability) }];
    if (veracity !== undefined) {
        wanted.push({ role: "ver", adj: parts.verAdj, glue: "", pct: scorePercent(veracity) });
    }
    for (const slot of wanted) {
        if (order.some(p => p.role === slot.role)) continue;
        const verAt = order.findIndex(p => p.role === "ver");
        const at = verAt >= 0 ? verAt : order.findIndex(p => p.role === "verdict");
        const neighbour = order[at];
        slot.glue = at >= 0 && neighbour && neighbour.role !== "verdict" ? neighbour.glue : verdictGlueFallback();
        order.splice(at < 0 ? order.length : at, 0, slot);
    }

    return order.map(piece => {
        const glue = piece.glue ? `<b class="mf-badge-glue">${escapeHtml(piece.glue).replace(/ /g, "\u00a0")}</b>` : "";
        if (piece.role === "verdict") {
            return `<b class="mf-badge-verdict">${escapeHtml(parts.verdict)}</b>${glue}`;
        }
        const adj = piece.adj === null ? "" : `<b class="mf-badge-adj">${escapeHtml(piece.adj)}</b>`;
        const empty = piece.adj === null ? " mf-badge-empty" : "";
        return `<b class="mf-badge-slot mf-badge-${piece.role}${empty}">`
            + `<b class="mf-badge-stack">${adj}<b class="mf-badge-pct">${escapeHtml(piece.pct)}</b></b>`
            + glue
            + `</b>`;
    }).join("");
}

/** The locale's own separator between an adjective and the verdict word, reused for a
 *  slot the template has no position for. */
function verdictGlueFallback(): string {
    const pieces = parseBadgeTemplate("badgeAdjVerdict", ["conf", "verdict"]);
    const at = pieces.findIndex(p => p.role === "conf");
    const after = pieces[at + 1];
    // With no slot to read from, the template key itself comes back as one literal; a
    // plain space is the safe separator then.
    return at >= 0 && after && after.role === null ? after.text : " ";
}

/** Set on a verdict badge whose percentages are being held open because its own hover widened
 *  it, moving it out from under the pointer that widened it. */
const BADGE_HOLD_CLASS = "mf-badge-held";

/** Slack around a claim's boxes, in px: enough to close the leading the browser keeps
 *  between two of its lines, not enough to reach past the claim's paragraph. */
const CLAIM_HOVER_PAD = 4;

/** How far a finger may travel and still be the tap it started as, in px — the browser's own
 *  slop before it reads the gesture as a scroll and drops the hover under the finger. */
const TOUCH_TAP_SLOP = 8;

/** How long after a tap's touchstart its compatibility click may arrive and still count as
 *  that tap's echo, in ms. The browser fires it ~300ms after touchend on mobile; a second
 *  later it is a dismissal the finger aimed, not the echo of the first tap. */
const TOUCH_COMPAT_CLICK_WINDOW = 1000;

interface Box { left: number; top: number; right: number; bottom: number; }

/** A badge held open against the move its own hover caused. */
interface BadgeHold {
    claim: HTMLElement;
    badge: HTMLElement;
    /** The line of the claim the hover pushed the badge off, out to the column's content
     *  edges — where the pointer is left standing. Null when the badge only grew in place,
     *  and the pointer is still on the badge. */
    vacated: Box | null;
}

let badgeHold: BadgeHold | null = null;

/** Last pointer position seen over the page. Boundary events name the element the pointer is
 *  on, but a wrapped highlight has gaps between its lines where that is no element at all —
 *  the position itself is what tells a crossing apart from a departure. */
let lastPointer: { x: number; y: number } | null = null;

/** Claim span with a preview wait currently counting down, if any. One wait at a time for
 *  the whole page: only one preview can be open anyway, and a wait belongs to the claim the
 *  pointer entered last — entering another claim cancels the earlier one outright rather
 *  than letting it fire onto an abandoned claim. */
let hoverTimer: ReturnType<typeof setTimeout> | null = null;
let hoveredSegment: HTMLElement | null = null;

/** Bounding box over every box the elements occupy, or null when none has one to measure. */
function silhouetteOf(els: Element[]): Box | null {
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const el of els) {
        for (const rect of Array.from(el.getClientRects())) {
            if (!rect.width && !rect.height) continue;
            left = Math.min(left, rect.left);
            top = Math.min(top, rect.top);
            right = Math.max(right, rect.right);
            bottom = Math.max(bottom, rect.bottom);
        }
    }
    return left === Infinity ? null : { left, top, right, bottom };
}

function withinBox(box: Box, x: number, y: number): boolean {
    return x >= box.left - CLAIM_HOVER_PAD && x <= box.right + CLAIM_HOVER_PAD
        && y >= box.top - CLAIM_HOVER_PAD && y <= box.bottom + CLAIM_HOVER_PAD;
}

/** Content edges of the text column an element sits in — the padding box of its nearest block
 *  ancestor. The space past the end of a claim's line belongs to no box of the claim, yet it
 *  is exactly where the pointer is left when a badge outgrows that line and wraps. */
function columnEdges(el: HTMLElement): { left: number; right: number } {
    let node: HTMLElement | null = el.parentElement;
    while (node && getComputedStyle(node).display.indexOf("inline") === 0) node = node.parentElement;
    const target = node ?? el;
    const rect = target.getBoundingClientRect();
    const style = getComputedStyle(target);
    return {
        left: rect.left + (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.borderLeftWidth) || 0),
        right: rect.right - (parseFloat(style.paddingRight) || 0) - (parseFloat(style.borderRightWidth) || 0),
    };
}

/** The line of the claim a pointer at y is standing in, as a band across the column's content
 *  width: the space a badge left behind when its hover pushed it onto the next line. */
function vacatedLine(claim: HTMLElement, y: number, edges: { left: number; right: number }): Box {
    for (const rect of Array.from(claim.getClientRects())) {
        if (y >= rect.top && y <= rect.bottom) {
            return { left: edges.left, top: rect.top, right: edges.right, bottom: rect.bottom };
        }
    }
    return { left: edges.left, top: y, right: edges.right, bottom: y };
}

/** Every highlight piece of the same claim inside one wrap.
 *
 *  A claim that crosses a block boundary (or leftover formatting splits) is more
 *  than one `.mf-segment-claim`. Hover, badge and leave must treat that set as one
 *  highlight — otherwise leaving the first piece for the next looks like a
 *  departure, and a badge left on the vacated piece stays stuck. On X a claim is
 *  almost always one span, so this is a no-op. */
function claimHoverSiblings(claim: HTMLElement): HTMLElement[] {
    const wrap = claim.closest(".mf-segment-wrap") ?? claim.parentElement;
    if (!wrap) return [claim];
    const idx = claim.dataset.claimIndex;
    if (idx == null) return [claim];
    const cid = claim.dataset.mfCid;
    const all = Array.from(wrap.querySelectorAll<HTMLElement>(".mf-segment-claim"));
    const siblings = all.filter(s => s.dataset.claimIndex === idx && (cid == null || s.dataset.mfCid === cid || !s.dataset.mfCid));
    return siblings.length ? siblings : [claim];
}

/** True when a point still counts as hovering the claim even though no part of the claim is
 *  under the pointer.
 *
 *  A highlight that runs over more than one line is a stack of line boxes with the browser's
 *  leading between them. Crossing that gap leaves the element without leaving the claim, and
 *  reading it as a departure cancelled the pending preview and dismissed the open one — so a
 *  pointer travelling from a highlight's upper line down to its badge lost the badge unless
 *  the crossing was made in one quick move. The gap lies inside the claim's silhouette, so
 *  the silhouette is the test. A held badge widens that area by the space it moved out of. */
function inClaimHoverArea(claim: HTMLElement, x: number, y: number): boolean {
    const box = silhouetteOf(claimHoverSiblings(claim));
    if (box && withinBox(box, x, y)) return true;
    const siblings = claimHoverSiblings(claim);
    return badgeHold !== null && siblings.includes(badgeHold.claim) && inBadgeHoldArea(badgeHold, x, y);
}

/** Whether a point is inside the area a held badge keeps open: the badge as it stands now, and
 *  — only when the hover pushed the badge onto another line — the band of the line it left, so
 *  the pointer can travel along that line and follow the badge down. Nothing else. The hold is
 *  the pointer staying with the badge, not the pointer staying anywhere on the claim: reaching
 *  across the whole highlight kept every percentage up long after the pointer had left the
 *  verdict word for the text. */
function inBadgeHoldArea(hold: BadgeHold, x: number, y: number): boolean {
    // A badge rebuilt under the hold is gone, box and all, and holds no space open.
    if (!hold.badge.isConnected) return false;
    const box = silhouetteOf([hold.badge]);
    if (box && withinBox(box, x, y)) return true;
    return hold.vacated !== null && withinBox(hold.vacated, x, y);
}

/** Which part of a badge a point falls in: the slot or the verdict word it belongs to, rather
 *  than the node itself, since a swap or a shift moves no slot's contents out from under a
 *  point that stays within it. */
function badgePartOf(el: Element | null): Element | null {
    return el?.closest(".mf-badge-verdict, .mf-badge-slot") ?? null;
}

/** How far into the slot beside the verdict word a tap may land and still count as the
 *  word's tap, in px. A finger lands where it lands, and a tap that only clipped the
 *  neighbouring slot is a near-miss, not a request for one score. */
const TOUCH_WORD_EDGE = 10;

/** The adjective slot a tap deliberately asks one score of — null when the tap asks for
 *  the whole badge. A tap on the verdict word or an empty slot is the whole badge; so is
 *  a tap inside a slot but within TOUCH_WORD_EDGE of the word. Anything deeper in a slot
 *  is aimed, not clipped. */
function singleScoreSlot(badge: HTMLElement, on: Element, x: number): Element | null {
    const slot = on.closest(".mf-badge-slot:not(.mf-badge-empty)");
    if (!slot) return null;
    const word = badge.querySelector(".mf-badge-verdict");
    if (!word) return slot;
    const edge = word.getBoundingClientRect();
    const dx = x < edge.left ? edge.left - x : x > edge.right ? x - edge.right : 0;
    return dx < TOUCH_WORD_EDGE ? null : slot;
}

/** Watch a badge the pointer has just landed on for the move that hover costs it.
 *
 *  Hovering an adjective-less slot widens the badge; at the end of a line that pushes the
 *  badge onto the next one, out from under the pointer that widened it. Chrome re-tests hover
 *  when layout moves, so the badge loses :hover, shrinks, lands under the pointer again and
 *  widens once more — a flicker at frame rate. The same thing happens without any re-wrap when
 *  the widening slides a slot that was already there under the pointer: hovering the verdict
 *  word of a badge with one hidden slot widens the badge to the left of the word, and the
 *  pointer, now over the adjective-only slot beside it, no longer holds the word's hover. A
 *  badge that only grows and shrinks in place flickers just as hard as one that wraps.
 *
 *  Either way the badge is held open until the pointer follows it or leaves the space.
 *
 *  From a touch tap (`fromTouch`) the caller has already settled word-vs-slot, so the hold
 *  is unconditional once asked: no empty slot needed to justify it, and no geometry left to
 *  re-measure. A deliberate single-score tap never reaches here — the stuck hover the browser
 *  holds on the tapped slot swaps that score on its own. */
function armBadgeHold(badge: HTMLElement, x: number, y: number, enteredOn: Element, fromTouch = false): void {
    // Only an adjective-less slot changes the badge's width, so only its reveal moves anything.
    // A finger is exempt: it lands where it lands, and a tap that clipped the neighbouring
    // slot must read as the word's tap rather than as asking for a single score.
    if (!fromTouch && !badge.querySelector(".mf-badge-empty")) return;
    // The class goes on now, ahead of the recalc the reveal is waiting on, and not in the frame
    // after it. A mouse lands on the word and the browser reveals the slots in the same recalc;
    // a finger lands on the word and the browser reveals them a recalc later, with the tap's own
    // compatibility mouse events arriving after that to move the hover off the word onto
    // whatever the widening slid under it. Held from here, the slots survive all of it, and the
    // measurement below sees the badge where the reveal left it rather than where it started.
    badge.classList.add(BADGE_HOLD_CLASS);
    // The reveal carries the badge onto the next line out from under the pointer, and the
    // teardown the span's own mouseleave runs fires in between, before the frame below has
    // measured anything: with no hold yet the pointer left standing in the vacated
    // end-of-line space reads as a departure and the badge is torn down mid-reveal — this
    // bug, where hovering a badge that only wraps once its percentages show loses it. So
    // the span is told to stand the teardown down until the settle below. What tells the
    // reveal's own teardown from a genuine departure is that the pointer has not moved:
    // the layout shifted under a stationary pointer, so the teardown names the very point
    // the hover armed at. The guard records that point for the comparison. It is switched
    // off again at the settle or by a real move off the badge (releaseBadgeHold disarms
    // it), never by the teardown itself.
    const earlyClaim = badge.closest<HTMLElement>(".mf-segment-claim") ?? badge.parentElement;
    let earlyGuard: (() => void) | null = null;
    if (earlyClaim) {
        if (badgeHold && badgeHold.badge !== badge) releaseBadgeHold();
        earlyGuard = holdTeardownGuard(earlyClaim, badge, x, y);
    }
    requestAnimationFrame(() => {
        if (!badge.isConnected) { if (badgeHold?.badge === badge) badgeHold = null; earlyGuard?.(); return; }
        // The teardown below is no longer mid-reveal: whatever it did by now, it did with the
        // guard above watching. Switch the guard off before settling, so the decision reads
        // the reveal that actually happened and nothing earlier.
        earlyGuard?.();
        // Whether the reveal cost the pointer anything is the whole question, and it is answered
        // by where the pointer is now against where its hover landed. The layout read here is the
        // one the class above just produced, which is the point of reading it: the reveal is
        // exactly what has to be measured, and a slot that came into the layout only because of
        // that class is not a slot the pointer's own hover is holding open — the pointer would
        // have been left on the word. Reading the two as the same part means nothing moved, the
        // hover is what is holding the reveal, and the class comes back off; unless this badge is
        // already held, in which case it is not this call's to drop.
        // A finger skips the question: it cannot place itself on one part rather than another,
        // so whatever it landed on counts as the word's tap.
        if (!fromTouch && badgePartOf(mfElementFromPoint(x, y)) === badgePartOf(enteredOn)) {
            if (badgeHold?.badge !== badge) badge.classList.remove(BADGE_HOLD_CLASS);
            return;
        }
        const claim = badge.closest<HTMLElement>(".mf-segment-claim") ?? badge.parentElement;
        if (!claim) { if (badgeHold?.badge === badge) badgeHold = null; return; }
        // Two ways the reveal moves the badge. Growing in place leaves the pointer on the badge,
        // and the badge is then the whole of the hold. Outgrowing the line carries the badge to
        // the next one, and the space it left behind — the line the pointer is standing on — is
        // part of the hold too, so the pointer can travel that line and follow the badge down.
        const rect = badge.getBoundingClientRect();
        const stillOnBadge = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
        if (badgeHold && badgeHold.badge !== badge) releaseBadgeHold();
        badgeHold = {
            claim, badge,
            vacated: stillOnBadge ? null : vacatedLine(claim, y, columnEdges(claim)),
        };
        // The reveal just re-wrapped above: its percentages grew the trigger's box downward,
        // under any popover placed against the pre-reveal geometry. Geometry is live here —
        // the class above already landed — and this settle is the one frame both the mouse
        // and the tap go through. Does nothing unless the window actually covers the badge.
        shiftPopoverBelowBadge(claim);
    });
}

/** A teardown the span's own mouseleave runs while a badge it holds is mid-reveal.
 *
 *  The verdict word's hover widens the badge, and at the end of a line that carries the
 *  badge onto the next one — out from under the pointer, which is left standing in the
 *  vacated end-of-line space over no part of the span. The span's mouseleave fires before
 *  the hold's settling frame has measured anything, and with no hold yet its guard reads
 *  that as a departure and tears the badge down mid-reveal. So between arming the hold and
 *  settling it, the span stands down only while the pointer is where the reveal left it:
 *  a teardown naming the very point the hover armed at is the layout shifting under a
 *  stationary pointer, not the pointer going anywhere. Anything else is a genuine
 *  departure — the pointer leaving for the highlight's text or off the claim — and the
 *  teardown runs as before. The one exception is the deliberate single-score mouse: its
 *  hover lives on the aimed adjective slot, and the percentages must drop exactly as
 *  before.
 *
 *  Returns a disarmer the settle frame calls once the reveal has happened, so the guard
 *  never outlives the reveal it is guarding. Also disarmed by releaseBadgeHold and by
 *  updateBadgeHold's release path — a real move off the badge. */
let badgeTeardownGuard: { claim: HTMLElement; badge: HTMLElement; x: number; y: number } | null = null;

function holdTeardownGuard(claim: HTMLElement, badge: HTMLElement, x: number, y: number): () => void {
    badgeTeardownGuard = { claim, badge, x, y };
    return () => {
        if (badgeTeardownGuard?.claim === claim && badgeTeardownGuard?.badge === badge) {
            badgeTeardownGuard = null;
        }
    };
}

/** True when the span's own mouseleave teardown must stand down for a badge mid-reveal.
 *  Kept out of inClaimHoverArea on purpose: until the settle frame has measured the reveal,
 *  the position of the pointer on the page decides nothing — the badge the widening carried
 *  away is nowhere near it by design, and the vacated space it stands in counts as no part
 *  of the claim. What tells the reveal's own teardown from a departure is that the pointer
 *  has not moved since the hover armed, so the teardown names the arming point itself. */
function spanTeardownStandsDown(claim: HTMLElement, x: number, y: number): boolean {
    const guard = badgeTeardownGuard;
    if (!guard) return false;
    if (guard.claim !== claim && !claimHoverSiblings(claim).includes(guard.claim)) return false;
    const badge = guard.badge;
    if (!badge.isConnected) return false;
    const on = mfElementFromPoint(x, y);
    // The deliberate single-score mouse aims at its adjective slot; that hover is the
    // pointer's own, not the reveal's, and the teardown must run for it.
    if (on && singleScoreSlot(badge, on, x) && badge.contains(on)) return false;
    // The widening still in flight: the layout shifted under a stationary pointer, so the
    // teardown names the arming point. TOUCH_TAP_SLOP is the leeway for what counts as
    // unmoved; anything further is the pointer's own travel, a genuine departure.
    return Math.abs(x - guard.x) <= TOUCH_TAP_SLOP && Math.abs(y - guard.y) <= TOUCH_TAP_SLOP;
}

function releaseBadgeHold(): void {
    if (badgeHold?.badge.isConnected) badgeHold.badge.classList.remove(BADGE_HOLD_CLASS);
    badgeHold = null;
    badgeTeardownGuard = null;
}

function updateBadgeHold(x: number, y: number): void {
    if (!badgeHold) return;
    if (!badgeHold.badge.isConnected) { badgeHold = null; badgeTeardownGuard = null; return; }
    if (inBadgeHoldArea(badgeHold, x, y)) return;
    releaseBadgeHold();
}

/** Put the resting tint back on every piece of a claim, and touch nothing else.
 *
 *  The tint is hover-only; the rest of a claim's hover state is not. A permanent badge (the
 *  idle Annotate button, an on-hold Fact-Check pill) and an open popover both outlive the
 *  pointer by design — and the one teardown that keeps them is also the only thing that
 *  repainted the background. Skipping it for them therefore left every claim carrying one
 *  wearing its held colour for the rest of the session: a highlight that never comes back
 *  from a hover. Where something has to outlive the pointer, this restores the background
 *  alone. */
function restoreClaimTint(span: HTMLElement): void {
    const base = restHighlightColor(span);
    for (const piece of claimHoverSiblings(span)) paintClaimBg(piece, base);
}

/** Undo a claim span's hover visuals: base background back, hover badge gone, loading
 *  spinner restored if the claim is still waiting on its verdict. Shared by the span's own
 *  mouseleave and the mousemove backstop below — one teardown, two triggers. */
function teardownClaimHover(span: HTMLElement): void {
    const pVal = parseFloat(span.dataset.probability ?? "");
    const prob = isNaN(pVal) ? undefined : pVal;
    const vVal = parseFloat(span.dataset.veracity ?? "");
    const ver = isNaN(vVal) ? undefined : vVal;
    // Keep a valid verdict's color even while reclassifying (refreshing);
    // grey only when there's no valid verdict.
    const noVerdict = prob === undefined || ver === undefined || prob < 0.2;
    // Rest tint stays the current verdict even while reclassifying — hover
    // already uses hoverBg (the stronger verdict colour). Grey only when
    // there is no valid verdict to keep.
    const baseBg = restHighlightColor(span);
    const siblings = claimHoverSiblings(span);
    const last = siblings[siblings.length - 1] ?? span;
    for (const piece of siblings) paintClaimBg(piece, baseBg);
    // Only the idle Annotate button is permanent (spec) — hover teardown must
    // not take it. A pending "Annotating" flight is hover-only, like the
    // classification loading words, so teardown takes it here. Call sites
    // already skip permanent badges, but teardown is shared, so defend here
    // too: a stale _mfBadgePermanent marker must never cost the badge when
    // the live dataset still wants the idle button.
    const keepBadge = spanWantsIdleAnnotate(span) || siblings.some(s => (s as any)._mfBadgePermanent);
    if (!keepBadge) {
        for (const piece of siblings) {
            piece.querySelector(".mf-inline-badge")?.remove();
            syncClaimBadgeLayout(piece);
        }
    }
    // Restore the stand-in if this claim is still loading — the badge that was
    // showing the spinner has just been taken away with the hover. A live
    // annotate flight counts: its hover-only badge is gone the same way. Only
    // the pending set marks a genuine flight (a leftover seed promotes —
    // never spins — the next reconcile pass, and must not stand in meanwhile).
    // Never stand in next to a visible badge: that badge already carries the
    // spinner (Annotating / Fact-Checking) or is the idle button.
    const stillLoading = span.dataset.refreshing === "true" || noVerdict || isAnnotatePending(span);
    const hasBadge = siblings.some(s => s.querySelector(".mf-inline-badge"));
    if (stillLoading && !hasBadge && !last.querySelector(".mf-standalone-spinner")) {
        last.appendChild(createStandaloneSpinner(isRTLLocale(getEffectiveUILocale())));
    }
}

/** Every claim span currently showing hover state — armed by the previews' wait and the
 *  span's own badge reveal, cleared when the teardown runs. Boundary events fire when the
 *  pointer leaves ELEMENTS, but a highlight's hover area reaches past its elements: the
 *  claim-attributed leaves fire at the element edge, still inside the pad, and stand down —
 *  then crossing the pad boundary itself fires nothing, and later leaves name no part of
 *  the claim. Without this set, a pointer that drifts off a highlight sideways leaves the
 *  badge and its preview open forever: no departure is ever scheduled. So each mousemove
 *  checks the armed claims against the pointer itself, and what the pointer observably
 *  abandoned gets the same teardown and dismiss the boundary path would have run. */
const hoverArmedClaims = new Set<HTMLElement>();

function armHoverClaim(span: HTMLElement): void {
    for (const piece of claimHoverSiblings(span)) hoverArmedClaims.add(piece);
}

function disarmHoverClaim(span: HTMLElement): void {
    for (const piece of claimHoverSiblings(span)) hoverArmedClaims.delete(piece);
}

/** True when (x, y) is still on the open preview: the claim, the popover, an
 *  attached onboarding popover, or the Fact-Checked-button badge that opened it.
 *  Geometry / elementFromPoint, not `:hover` — a still pointer often has an empty
 *  `:hover` list (Safari especially), which used to dismiss the preview while the
 *  pointer was sitting on it. */
function inPreviewRelatedArea(trigger: HTMLElement, x: number, y: number): boolean {
    if (inClaimHoverArea(trigger, x, y)) return true;
    const hit = mfElementFromPoint(x, y);
    const covers = (el: HTMLElement | null | undefined): boolean => {
        if (!el || !el.isConnected) return false;
        if (hit && (el === hit || el.contains(hit))) return true;
        const box = el.getBoundingClientRect();
        return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
    };
    if (covers(previewPopoverState?.popover)) return true;
    for (const op of previewPopoverState?.onboardPopovers ?? []) {
        if (covers(op)) return true;
    }
    const anchorEl = (trigger as any)._mfAnchorEl as HTMLElement | undefined;
    if (covers(anchorEl)) return true;
    // A preview opened from the Fact-Checked button belongs to the whole button: between claim
    // rows, or over its label, the pointer is still on what the preview came from, and the
    // button's own leave is what dismisses it.
    if (covers((trigger as any)._mfButtonEl as HTMLElement | undefined)) return true;
    return false;
}

/** The departure boundary events cannot deliver: the pointer is observably outside an
 *  armed claim's hover area, so run the same teardown and dismiss the leave would have. */
function settleHoverClaims(x: number, y: number): void {
    if (hoverArmedClaims.size === 0 && !previewPopoverState) return;
    const previewTrigger = previewPopoverState?.trigger;
    const overPreview = !!(previewTrigger && inPreviewRelatedArea(previewTrigger, x, y));
    if (overPreview && previewPopoverState?.leaveTimer) {
        clearTimeout(previewPopoverState.leaveTimer);
        previewPopoverState.leaveTimer = null;
    }
    if (hoverArmedClaims.size === 0) return;
    for (const span of Array.from(hoverArmedClaims)) {
        if (!span.isConnected) { hoverArmedClaims.delete(span); continue; }
        if (overPreview && previewTrigger && (span === previewTrigger || claimHoverSiblings(previewTrigger).includes(span))) continue;
        if (inClaimHoverArea(span, x, y)) continue;
        if (spanTeardownStandsDown(span, x, y)) continue;
        const siblings = claimHoverSiblings(span);
        for (const piece of siblings) hoverArmedClaims.delete(piece);
        if (siblings.some(s => (s as any)._mfPopoverOpen || (s as any)._mfBadgePermanent)) restoreClaimTint(span);
        else teardownClaimHover(span);
        cancelHoverPreview();
        schedulePreviewPopoverDismiss(span);
    }
}

/** The preview's dismissal for the departures its own events never name: the pointer is
 *  observably clear of the popover, its trigger and everything attached to it, so the countdown
 *  starts from here.
 *
 *  A preview is taken down by a countdown armed from `mouseleave` of the claim and of the
 *  popover, and that countdown stands down — leaving nothing armed behind it — if the pointer is
 *  back on the preview when it fires. Either event can therefore be spent while the pointer is
 *  still inside: the pointer quits the window over the popover and the single countdown stands
 *  down, or the claim is rebuilt under an open preview so the trigger the event would have come
 *  from is detached and fires nothing at all. From there the popover outlives every later
 *  mousemove: there is no armed claim left for settleHoverClaims to settle, and only hovering
 *  another claim or a click would ever take it down. The pointer's own position is the authority
 *  those boundary events lost. */
function settlePreviewPopover(x: number, y: number): void {
    if (!previewPopoverState) return;
    const trigger = previewPopoverState.trigger;
    if (!trigger.isConnected) {
        // The span went away, which is not the same as the pointer leaving it: if a rebuild
        // replaced it under the pointer, the window belongs to the replacement now and only a
        // pointer that is genuinely off the claim takes it down.
        if (!adoptDetachedPreviewTrigger()) dismissPreviewPopover();
        return;
    }
    if (inPreviewRelatedArea(trigger, x, y)) return;
    // A countdown already running will re-read the pointer when it fires; starting a fresh one
    // on every mousemove would push the dismissal out for as long as the pointer keeps moving.
    if (previewPopoverState.leaveTimer) return;
    schedulePreviewPopoverDismiss(trigger);
}

/** Clear badges no live state wants, from the same pointer backstop the tint uses.
 *
 *  A badge leaves by its own claim's hover teardown, so one that an in-place path left standing —
 *  an annotate run landing and swapping the element where it stood, a popover closed after
 *  keeping it — outlives the pointer with nothing left to look at it: the claim is never hovered
 *  again, so the teardown that would have taken it never runs. What the spec keeps is marked
 *  (_mfBadgePermanent), held by a popover, or held by the pointer's own hover; everything else
 *  here is a leftover, and it goes. */
let lastStraySweep = 0;
function sweepStrayBadges(x: number, y: number): void {
    // Print mode badges every highlight on purpose and afterprint takes them back.
    if (printBadgesAdded.size > 0) return;
    if (previewPopoverState) return;
    const now = Date.now();
    if (now - lastStraySweep < 200) return;
    lastStraySweep = now;
    for (const badge of Array.from(document.querySelectorAll<HTMLElement>(".mf-inline-badge"))) {
        const span = badge.closest<HTMLElement>(".mf-segment-claim");
        if (!span) continue;
        const siblings = claimHoverSiblings(span);
        if (siblings.some(s => (s as any)._mfPopoverOpen || (s as any)._mfBadgePermanent)) continue;
        if (hoverArmedClaims.has(span)) continue;
        if (inClaimHoverArea(span, x, y)) continue;
        if (spanTeardownStandsDown(span, x, y)) continue;
        if (badgeHold?.badge === badge && inBadgeHoldArea(badgeHold, x, y)) continue;
        // A claim that wants the idle Annotate button keeps the affordance — as the button, never
        // as the verdict badge a swap left standing in its place.
        if (spanWantsIdleAnnotate(span) && !badge.classList.contains("mf-annotate-badge")) {
            const create = (span as any)._mfCreateBadge as ((permanent: boolean) => HTMLElement) | undefined;
            if (create) {
                badge.remove();
                span.appendChild(create(true));
                syncClaimBadgeLayout(span);
            }
            continue;
        }
        badge.remove();
        syncClaimBadgeLayout(span);
        // A run still in flight keeps its progress visible: its badge was hover-only, so the
        // stand-in spinner takes over, exactly as the in-place reconcile does.
        if (isAnnotateFlight(span) || span.dataset.refreshing === "true") ensureAnnotateStandin(span);
    }
}

/** Clear tints no live hover wants, from the same pointer backstop the badges use.
 *
 *  The tint leaves by the claim's own hover teardown, so a departure that the boundary events
 *  name on one layer but not the other leaves it hot with nothing armed to settle it:
 *  `startHoverPreview` disarms the claim the pointer left, and the leave that would have
 *  repainted the tint stands down as a crossing of the claim's own line gap — so the highlight
 *  keeps its hover colour until that claim is hovered and left again. The pointer's own position
 *  is the authority those boundary events lost. What counts as still hovered is the whole
 *  claim: every piece of a multi-piece highlight wears the tint, so the pointer on any one of
 *  them is a live hover for all of them. */
let lastTintSweep = 0;
function sweepStrayTints(x: number, y: number): void {
    // A visible preview owns the hover that produced its tint: the pointer is often resting
    // inside the popover window, off the claim, which reads as a departure from the pointer's
    // position alone. The preview's own countdown settles that hover; this backstop stays out
    // until it has — same stand-down sweepStrayBadges takes for the badge it would take down.
    if (previewPopoverState) return;
    const now = Date.now();
    if (now - lastTintSweep < 200) return;
    lastTintSweep = now;
    for (const span of Array.from(document.querySelectorAll<HTMLElement>(".mf-segment-claim"))) {
        const hoverBg = span.dataset.hoverBg;
        if (!hoverBg) continue;
        // A reveal wipe paints its own gradient — never a hover tint to take back.
        if (span.classList.contains("mf-highlight-reveal")) continue;
        const inlineBg = span.style.getPropertyValue("background-color");
        if (!inlineBg || inlineBg.replace(/\s+/g, "") !== hoverBg.replace(/\s+/g, "")) continue;
        const siblings = claimHoverSiblings(span);
        if (siblings.some(s => inClaimHoverArea(s, x, y))) continue;
        if (spanTeardownStandsDown(span, x, y)) continue;
        for (const piece of siblings) hoverArmedClaims.delete(piece);
        if (siblings.some(s => (s as any)._mfPopoverOpen || (s as any)._mfBadgePermanent)) restoreClaimTint(span);
        else teardownClaimHover(span);
    }
}

function startHoverPreview(target: HTMLElement) {
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
    if (hoveredSegment && hoveredSegment !== target) disarmHoverClaim(hoveredSegment);
    hoveredSegment = target;
    armHoverClaim(target);
    hoverTimer = setTimeout(() => {
        if (hoveredSegment !== target) return;
        if ((target as any)._mfPopoverOpen) return;
        if (target.dataset.reclassifyOnHold === "true") return;
        if ((target as any)._mfBadgePermanent) return;
        // The leave that should have cancelled this wait may have stood down instead:
        // it fires from the pointer's position, and from a gap or the hold's vacated
        // band that position still counts as the claim. Re-check the pointer itself —
        // lastPointer is the freshest mousemove — and let an outran wait die quietly.
        // The hover settles at once rather than waiting on the backstop: the pointer is
        // observably gone, and another mousemove may never come.
        if (lastPointer && !inClaimHoverArea(target, lastPointer.x, lastPointer.y)) {
            hoverTimer = null;
            hoveredSegment = null;
            disarmHoverClaim(target);
            const sibs = claimHoverSiblings(target);
            // A permanent badge (the idle Annotate button, an on-hold Fact-Check pill) and
            // an open popover outlive the pointer, so the teardown stands down for them —
            // but the TINT does not outlive it, and this was the one exit that left it hot.
            // The span's own mouseleave and the mousemove backstop both restore the tint on
            // this branch; here the claim was disarmed and the pointer's absence confirmed,
            // so returning without a repaint left the highlight wearing its held colour
            // until some later hover-and-leave happened to put it back.
            if (sibs.some(s => (s as any)._mfPopoverOpen || (s as any)._mfBadgePermanent)) restoreClaimTint(target);
            else teardownClaimHover(target);
            return;
        }
        showPreviewPopover(target);
    }, 1000);
}

function cancelHoverPreview() {
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
    hoveredSegment = null;
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
export function factCheckColor(probability: number | undefined, veracity?: number, bgOpacity = 0.15): string {
    const [r, g, b] = verdictColorChannels(probability, veracity);
    return `background: rgba(${r}, ${g}, ${b}, ${bgOpacity}); color: #ffffff`;
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
            const showSpinner = !isOnHold && (claim.confidence === undefined || claim.refreshing);
            // A badge whose verdict is settled gets hoverable adjective slots; anything
            // still in flight (on-hold, spinner, refreshing) stays a plain label.
            const slotBadge = !showSpinner && !isOnHold;
            const label = isOnHold ? t("factCheckButton") : verdictLabel(claim.confidence, claim.veracity, `${c.id}:${claim.text}`);
            const reasoning = isOnHold
                ? (claim.cachedNote ?? tapify("Click to re-check this claim"))
                : extractReasoning(claim.note, claim.confidence, claim.veracity);
            return `
            <div style="margin-bottom: 8px; line-height: 1.4;">
                <div style="font-size: 13px; color: inherit; margin-bottom: 3px;">${escapeHtml(String(claim.rewritten ?? claim.text))}</div>
                <div>
                    <span${slotBadge ? ` class="${VERDICT_BADGE_CLASS}"` : ''} style="display: inline-flex; align-items: center; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; white-space: nowrap; ${isOnHold ? 'color: #ffffff; background: rgba(128, 128, 128, 0.25);' : factCheckColor(claim.confidence, claim.veracity)}">${showSpinner ? '<span class="mf-fc-spinner"></span>' : ''}${slotBadge ? verdictBadgeHtml(claim.confidence, claim.veracity, `${c.id}:${claim.text}`) : escapeHtml(label)}</span>
                    <span style="font-size: 13px; color: inherit;"> ${escapeHtml(reasoning)}</span>
                </div>
            </div>
        `;
        })
        .join("");
}

/** Render the fallback claim boxes — the list of rewritten claims shown under a post whose
 *  claims could not be anchored to their own text.
 *
 *  Off in production, deliberately. A box is a diagnostic, not a fact-check: it names claims
 *  the injector failed to place, and its presence under a post whose highlights are perfectly
 *  fine reads as output when it is really an error report. Logged either way (see the
 *  `unmatched claims` line), so a build that hides them still says how many it could not
 *  anchor. Flip to true to inspect the boxes themselves. */
const RENDER_FALLBACK_CLAIM_BOXES = false;

/** Put a claim box inside the post it belongs to.
 *
 *  X hangs it under the main article's byline, and after the timestamp when that article
 *  has no byline to hang it from. Everywhere else — the DOM-fed platforms, where the
 *  injector's container IS the post element itself, so `time === article` — it goes at the
 *  END of that element, never beside it.
 *
 *  Beside it is what made the boxes pile up. `insertAdjacentElement("afterend", …)` on the
 *  root puts the box OUTSIDE the subtree every later pass searches
 *  (`article.querySelector('[mf-unmatched="…"]')`), so the box is write-only: the pass that
 *  has claims it cannot place appends a copy, and the pass that later places them cannot
 *  find that copy to remove it. A post re-injected a dozen times collects a dozen identical
 *  boxes beneath text whose highlights are perfectly fine — the leftover of one early pass
 *  that ran before its segments existed. */
function placeClaimBox(time: Element, article: Element, div: HTMLElement, mainTweet: boolean) {
    if (mainTweet) {
        const byline = article.querySelector('[data-testid="User-Name"]');
        if (byline) { byline.appendChild(div); return; }
    }
    if (time === article) article.appendChild(div);
    else time.insertAdjacentElement("afterend", div);
}

/** Remove this post's claim boxes that live outside every container of the post.
 *
 *  Nothing else can reach them. Each pass looks for a box with
 *  `article.querySelector(...)`, and the clear path with `postContainersFor(id)` — both
 *  confined to the post's own subtree — so a box that a pass of an older build left
 *  BESIDE the post is invisible to the update that should rewrite it, to the branch that
 *  removes it once its claims are placed, and to the teardown that clears the post. It
 *  sits there for the life of the page, and a post re-injected a dozen times leaves a
 *  dozen of them: the same two unplaceable claims printed over and over under a post
 *  whose highlights are perfectly fine. */
function sweepOrphanClaimBoxes(id: string) {
    const containers = postContainersFor(id);
    for (const box of document.querySelectorAll(`[mf-unmatched="${id}"], [classification-id="${id}"]`)) {
        if (!containers.some(root => root.contains(box))) box.remove();
    }
}

// ── Inline segment rendering (Phase 2): claims highlighted in the tweet text ─

export function getInlineStyles(): string {
    return `
/* Host pages (Substack especially) restyle bare spans — display:block, background
   transparent, huge line-height. Every injected chrome below pins its own layout
   so a highlight, badge or strike cannot be flattened or washed out. */
/* Correction handwriting: bundled Kalam Bold (OFL 1.1, upright print — not
   cursive) as data: URIs, because x.com's CSP (font-src 'self'
   https://*.twimg.com data:) blocks chrome-extension:// font files. font-display
   swap keeps corrections readable while the font decodes. */
@font-face {
    font-family: "MFKalam";
    font-style: normal;
    font-weight: 700;
    font-display: swap;
    src: url(data:font/woff2;base64,${KALAM_BOLD_LATIN_EXT_B64}) format('woff2');
    unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF;
}
@font-face {
    font-family: "MFKalam";
    font-style: normal;
    font-weight: 700;
    font-display: swap;
    src: url(data:font/woff2;base64,${KALAM_BOLD_LATIN_B64}) format('woff2');
    unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
.mf-segment-wrap {
    display: inline !important;
}
/* An in-place wrap holds the post's own DOM — headings, list items, links — instead of a
   rendered run of text, so it must not generate a box of its own: display:contents lays
   its children out as if the wrap were not there, which is what keeps the post
   pixel-identical to how the page built it. */
.mf-segment-wrap[data-mf-in-place="1"] {
    display: contents !important;
}
.mf-segment-wrap[data-mf-sel-loading="true"] {
    background-color: rgba(29, 155, 240, 0.14) !important;
    padding: 1px 5px 1px 3px !important;
    -webkit-box-decoration-break: slice !important;
    box-decoration-break: slice !important;
    transition: background-color 0.2s ease !important;
}
.mf-sel-spinner {
    display: inline-block !important;
    width: 12px !important;
    height: 12px !important;
    border: 2px solid rgba(29, 155, 240, 0.28) !important;
    border-top-color: #1d9bf0 !important;
    border-radius: 50% !important;
    animation: mf-spin 0.6s linear infinite !important;
    vertical-align: middle !important;
    position: relative !important;
    top: -0.08em !important;
    margin-left: 6px !important;
    margin-right: 2px !important;
    flex-shrink: 0 !important;
    box-sizing: border-box !important;
}
[dir="rtl"] .mf-sel-spinner {
    margin-left: 2px !important;
    margin-right: 6px !important;
}
/* Inherit, not pre-wrap: these spans hold the PAGE's own text, and the page's own
   white-space is what its layout was laid out at. Forcing pre-wrap made every newline and
   tab carried inside a wrap render literally — a tab is a tab-stop advance at the host's
   font size, so a selection whose span opened on the page's layout whitespace showed a
   blank gap where the page itself collapses one. Inheriting keeps a paragraph on
   Wikipedia collapsed and a tweet's line breaks on X intact. */
.mf-segment-plain {
    display: inline !important;
    white-space: inherit;
}
.mf-segment-plain a:hover {
    text-decoration: underline;
}
.mf-segment-claim {
    display: inline !important;
    white-space: inherit;
    cursor: pointer;
    position: relative;
    border-radius: 3px;
    padding: 1px 3px;
    transition: background-color 0.15s ease;
    -webkit-box-decoration-break: slice;
    box-decoration-break: slice;
    --mf-line: 1lh;
}
.mf-badge-cap {
    display: inline-flex !important;
    align-items: center !important;
    vertical-align: middle !important;
    background-color: transparent !important;
    background: transparent !important;
    padding: 0 1.2px 0 0 !important;
    margin: 0 !important;
    position: relative !important;
    top: 0 !important;
}
[dir="rtl"] .mf-badge-cap,
.mf-badge-cap[dir="rtl"] {
    padding: 0 0 0 1.2px !important;
    margin: 0 !important;
}
.mf-badge-cap .mf-inline-badge,
.mf-badge-cap .mf-inline-badge.mf-web-badge {
    top: -0.142em !important;
    margin-left: 0.22em !important;
    margin-right: 0 !important;
}
[dir="rtl"] .mf-badge-cap .mf-inline-badge,
[dir="rtl"] .mf-badge-cap .mf-inline-badge.mf-web-badge,
.mf-badge-cap[dir="rtl"] .mf-inline-badge,
.mf-badge-cap[dir="rtl"] .mf-inline-badge.mf-web-badge {
    margin-left: 0 !important;
    margin-right: 0.22em !important;
}
/* Host pages (Substack) set p span { background: transparent !important }
   at (0, 2, 1). Wrap + claim beats that so the tint always paints. */
span.mf-segment-claim,
p span.mf-segment-claim,
li span.mf-segment-claim,
h1 span.mf-segment-claim,
h2 span.mf-segment-claim,
h3 span.mf-segment-claim,
.mf-segment-wrap .mf-segment-claim {
    background-color: var(--mf-hl, rgba(128, 128, 128, 0.25)) !important;
}
.mf-segment-claim.mf-highlight-reveal {
    background-repeat: no-repeat;
    transition: background-size 0.45s ease-out, background-color 0.15s ease;
}
/* Inline annotation overlays: an inner span wraps each erroneous substring so the
   line draws ON TOP of the claim's highlight background. Longer-than-a-word matches
   use a per-line horizontal rule (wraps natively); at-most-a-word matches use a
   diagonal overlay whose slant is stable-random per substring. The correction sits
   just after the struck substring in fully-opaque false-red, handwritten
   pencil-style font (bundled Kalam Bold via @font-face below, system
   handwriting stack as fallback; NOT generic cursive — Kalam is upright
   print handwriting, unjoined). */
.mf-strike {
    position: relative !important;
    display: inline !important;
    line-height: inherit !important;
    vertical-align: baseline !important;
}
.mf-strike:not(.mf-strike-h) {
    white-space: nowrap !important;
}
.mf-strike > span {
    display: inline !important;
    line-height: inherit !important;
}
.mf-strike-h {
    display: inline !important;
    text-decoration: none !important;
    white-space: normal !important;
}
.mf-strike-line {
    position: absolute !important;
    display: block !important;
    left: 0 !important;
    right: 0 !important;
    /* The containing block is the wrap's own box — the font box, whose height is
       ascent + descent, NOT the host paragraph's line box (measured: top: 0 lands
       on the wrap's rect top at every host leading). Its centre is
       baseline - (ascent - descent)/2, which is above the middle of the text the
       eye reads: prose is centred on its x-band, baseline - xHeight/2. That
       difference is what made every strike sit high, worst at display sizes.
       + 0.1em closes it: the residual against a measured x-band middle is under
       0.2px for Arial/Helvetica (0.088em), Georgia (0.107), Times New Roman
       (0.12) and Linux Libertine (0.107) — the spans this has to work across.
       Kept as a ratio rather than a measured value because the same rule has to
       hold in the popup's React paint, which has no measurement pass, and because
       the box's own height is the only geometry both surfaces share. */
    top: calc(50% + 0.1em) !important;
    height: 2px !important;
    margin-top: -1px !important;
    border-radius: 999px !important;
    pointer-events: none !important;
}
.mf-strike-line.mf-diag-a {
    transform: rotate(14deg);
}
.mf-strike-line.mf-diag-b {
    transform: rotate(-14deg);
}
.mf-corr {
    display: inline !important;
    font: inherit;
    font-family: "MFKalam", "Segoe Print", "Bradley Hand", "Chalkboard SE", "Marker Felt", "Comic Sans MS", cursive;
    font-weight: 700;
    font-size: 1.12em;
    line-height: 1 !important;
    vertical-align: baseline !important;
}
b.mf-inline-badge,
b.mf-badge-verdict,
b.mf-badge-slot,
b.mf-badge-stack,
b.mf-badge-adj,
b.mf-badge-pct,
b.mf-badge-glue {
    font-weight: 600 !important;
    font-style: normal !important;
    color: #ffffff !important;
}
.mf-inline-badge,
.mf-inline-badge *,
.mf-web-badge,
.mf-web-badge *,
.mf-verdict-badge,
.mf-verdict-badge *,
.mf-annotate-badge,
.mf-annotate-badge *,
.mf-badge-cap .mf-inline-badge,
.mf-badge-cap .mf-inline-badge * {
    color: #ffffff !important;
}
.mf-inline-badge {
    display: inline-flex !important;
    flex-direction: row !important;
    flex-wrap: nowrap !important;
    align-items: center !important;
    justify-content: center !important;
    vertical-align: middle !important;
    position: relative !important;
    top: -0.142em !important;
    padding: 0.12em 0.52em !important;
    line-height: 1.15 !important;
    border-radius: 999px !important;
    height: auto !important;
    min-height: auto !important;
    box-sizing: border-box !important;
    font-size: 0.75em !important;
    font-weight: 600 !important;
    white-space: nowrap !important;
    min-width: max-content !important;
    max-width: none !important;
    flex-wrap: nowrap !important;
    word-break: keep-all !important;
    margin-left: 0.25em !important;
    margin-right: 0 !important;
}
[dir="rtl"] .mf-inline-badge {
    margin-left: 0 !important;
    margin-right: 0.25em !important;
}
.mf-inline-badge.mf-badge-loading {
    vertical-align: middle !important;
    position: relative !important;
    top: -0.142em !important;
}
.mf-inline-badge.mf-web-badge {
    display: inline-block !important;
    vertical-align: middle !important;
    position: relative !important;
    top: -0.142em !important;
    height: auto !important;
    box-sizing: border-box !important;
    font-size: 0.75em !important;
    padding: 0.12em 0.52em !important;
    line-height: 1.15 !important;
    margin-left: 0.25em !important;
    margin-right: 0 !important;
}
[dir="rtl"] .mf-inline-badge.mf-web-badge {
    margin-left: 0 !important;
    margin-right: 0.25em !important;
}
.mf-inline-badge.mf-web-badge.mf-badge-loading {
    vertical-align: middle !important;
    position: relative !important;
    top: -0.142em !important;
}
/* Verdict badge: an adjective and its percentage share one grid cell, so the slot is as
   wide as the wider of the two and swapping them on hover moves nothing. The locale's
   separator rides inside the slot, so a slot that is out of the layout takes it along. */
.mf-badge-verdict,
.mf-badge-slot {
    display: inline-flex !important;
    flex-direction: row !important;
    flex-wrap: nowrap !important;
    align-items: center !important;
    white-space: nowrap !important;
    min-width: max-content !important;
    flex-shrink: 0 !important;
}
.mf-badge-slot {
    display: inline-flex !important;
    align-items: center;
}
.mf-badge-stack {
    display: inline-block !important;
    position: relative !important;
    white-space: nowrap !important;
    line-height: 1 !important;
    vertical-align: middle;
}
.mf-badge-adj {
    display: inline !important;
    white-space: nowrap;
    line-height: 1;
    pointer-events: none !important;
}
.mf-badge-pct {
    display: block !important;
    position: absolute !important;
    left: 0;
    right: 0;
    top: 0;
    bottom: 0;
    text-align: center;
    white-space: nowrap;
    line-height: 1;
    pointer-events: none !important;
    margin: 0;
}
.mf-badge-empty .mf-badge-pct {
    display: inline !important;
    position: static !important;
    left: auto;
    right: auto;
    top: auto;
    bottom: auto;
}
.mf-badge-glue {
    display: inline !important;
    white-space: pre !important;
}
.mf-badge-slot:not(.mf-badge-empty) .mf-badge-pct {
    visibility: hidden;
}
/* A score of 0.9 or better gets no adjective, so its slot stays out of the layout until
   the verdict word is hovered, then takes only the width its percentage needs. Bringing
   the slot in widens the badge, which slides the word out from under the pointer and onto
   the new slot — so the slot's own hover holds it open, or the rule would drop it, snap
   the word back, and flicker. */
.mf-badge-empty,
b.mf-badge-empty,
.mf-badge-slot.mf-badge-empty,
.mf-inline-badge .mf-badge-slot.mf-badge-empty {
    display: none !important;
}
.mf-verdict-badge:has(.mf-badge-verdict:hover) .mf-badge-slot.mf-badge-empty,
.mf-verdict-badge:has(.mf-badge-empty:hover) .mf-badge-slot.mf-badge-empty {
    display: inline-flex !important;
}
/* While the pointer is with a badge whose hover widened it, the empty slots stay in the
   layout. They are the whole of the badge's width change, so holding them holds the layout
   still: the widening either carries the badge off the pointer's line or slides a slot under
   the pointer in place of the word, and in both cases the hover that widened the badge would
   otherwise be lost the moment it happened, flickering between the two widths. */
.mf-verdict-badge.mf-badge-held .mf-badge-slot.mf-badge-empty {
    display: inline-flex !important;
}
/* What is held is the reveal, not just the width it cost: the percentages stand in whatever
   shape the widening left the badge. Held from the line the badge vacated — the pointer
   standing where the badge was, having followed it to the next line — the slots the pointer
   has left behind would otherwise hand their percentages back to their adjectives, showing
   half a badge turned over. */
.mf-verdict-badge.mf-badge-held .mf-badge-adj {
    visibility: hidden;
}
.mf-verdict-badge.mf-badge-held .mf-badge-pct {
    visibility: visible;
}
/* Hovering an adjective swaps that one score. The verdict word stands for the whole badge
   and swaps both; so does an adjective-less slot, which the pointer can only be on after
   the widening moved it there — that is the verdict word's hover arriving. */
.mf-verdict-badge .mf-badge-conf:hover .mf-badge-adj,
.mf-verdict-badge .mf-badge-ver:hover .mf-badge-adj,
.mf-verdict-badge:has(.mf-badge-verdict:hover) .mf-badge-adj,
.mf-verdict-badge:has(.mf-badge-empty:hover) .mf-badge-adj {
    visibility: hidden;
}
.mf-verdict-badge .mf-badge-conf:hover .mf-badge-pct,
.mf-verdict-badge .mf-badge-ver:hover .mf-badge-pct,
.mf-verdict-badge:has(.mf-badge-verdict:hover) .mf-badge-pct,
.mf-verdict-badge:has(.mf-badge-empty:hover) .mf-badge-pct {
    visibility: visible;
}
.mf-popover {
    position: absolute;
    /* The reader opened this window on purpose, so it has to cover the page it is talking
       about — a host panel, a sticky header, another site's own overlay. Only our own
       floating chrome outranks it, and the whole ladder sits at the top of the range rather
       than at 9999 because a HOST's cookie bar or sticky header is routinely at 9999 too. */
    z-index: 2147483643;
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
    width: 0.91em;
    height: 0.91em;
    border: 0.14em solid rgba(128,128,128,0.25);
    border-top-color: rgba(128,128,128,0.8);
    border-radius: 50%;
    animation: mf-spin 0.6s linear infinite;
    margin-right: 0.27em;
    flex-shrink: 0;
    vertical-align: middle;
}
/* The stand-in is the same wheel without a badge around it. The badge's
   0.15em optical nudge lifts a lone wheel off the line; middle puts it
   back on the glyph centre (X and web). */
.mf-standalone-spinner {
    vertical-align: middle;
}
/* Our chrome is tappable wherever it lands, descendants included.
   pointer-events INHERITS, so a host that disables it on a subtree disables our own
   controls inside that subtree — and a value computed by inheritance is not the same
   thing as a value written on the element: an inline auto on the container does nothing
   for the buttons under it. Facebook's mobile site is exactly this shape — .ssr
   #screen-root > .m, and every element under it, are pointer-events: none — and it cost
   us every tap on that surface. Measured there: the bar container hit-tested and its
   button did not, so a press was delivered to a container with no handler on it (the pill
   painted, sat under the finger, and did nothing at all); and every claim span and badge
   of a painted post hit-tested to the host's own DIV.m, which is why tapping a highlight
   neither opened its popover nor reached the Annotate affordance.
   Only the chrome that lives INSIDE the host's tree is listed. Popovers and notices are
   appended to document.body, where the host rule cannot reach them, and the preview
   popover's own none/auto pair (see .mf-popover-preview) is behaviour, not accident.
   The badge's inner slots keep their explicit none: on the desktop host they compute none
   too, so the badge stays the target on both, and the claim span stays the target
   everywhere else. !important because the host rule is an id-and-two-classes descendant
   selector that outranks ours on the button regardless of order. */
.mf-btn-container,
.mf-btn-container *,
.mf-segment-wrap,
.mf-segment-claim,
.mf-inline-badge {
    pointer-events: auto !important;
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
    [data-mf-charge="disinfact"] > div,
    [data-mf-charge="factcheckall"] > div,
    [data-mf-charge="translate-tweet"] > div,
    [data-mf-visual] > div {
        padding-left: 0 !important;
        padding-right: 0 !important;
        margin-left: 0 !important;
        margin-right: 0 !important;
        min-width: 0 !important;
        column-gap: 0 !important;
    }
    /* Degrade to an ellipsis rather than overflowing once it does have to give way. */
    [data-mf-charge="disinfact"] > div > span,
    [data-mf-charge="factcheckall"] > div > span,
    [data-mf-charge="translate-tweet"] > div > span,
    [data-mf-visual] > div > span {
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
   above popovers (z:2147483643) but below the Fact-Checked / Go-Back buttons
   (z:2147483647). */
.mf-notif-container {
    position: fixed;
    top: 12px;
    right: 12px;
    left: auto;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 8px;
    z-index: 2147483645;
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
    cursor: pointer;
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
   Reuse the popover look but sit above claim popovers (z:2147483643) and below
   notifications (z:2147483645). Always fully opaque and persistent (unless mirroring a
   preview popover). */
.mf-onboard {
    z-index: 2147483644;
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

/* ── Source-link favicons ──
   A host stylesheet reaches in here: Reddit ships a reset whose selector list includes
   an img rule with margin-bottom: 1rem, and inside the 20px centred flex link that margin
   makes the icon's margin box 32px tall, so the icon centres 8px above the middle of the
   circle and the link's overflow clips its top — the favicon renders short and stuck to
   the top of the ring. Same defence as the badges: our own class and !important, so no
   host sheet can size or space our icon. The link keeps its geometry inline (the hover
   writes width/padding/border-radius there and must keep winning), so only what the
   hover never touches is pinned here. */
.mf-source-link { margin: 0 !important; }
.mf-source-link > * {
    margin: 0 !important;
    padding: 0 !important;
}
.mf-source-link > img {
    width: 16px !important;
    height: 16px !important;
    max-width: none !important;
    max-height: none !important;
    border-radius: 2px !important;
}

/* ── Floating buttons (Fact-Checked / Go Back) ──
   The favicon defect above, on a whole element. A host reset for :where(button) supplies
   height: var(--button-height), overflow: hidden and a line-height equal to its button height
   (Reddit ships exactly that). Our inline styles declare none of the three, so the zero
   specificity of :where() does not save us: the button is pinned to a single line and the
   expanded state — the preview text, then the claim list — is clipped to a ~30px strip, with
   every row inflated to that same ~30px on the way through. Pin the box here, the way the
   badges and the source links already do. Everything the JS and the hover write stays inline
   and unqualified: width, padding, radius, colours, transform. */
.mf-floating-scroll-btn {
    height: auto !important;
    min-height: 0 !important;
    max-height: none !important;
    overflow: visible !important;
    line-height: normal !important;
    white-space: normal !important;
}
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
function notifColor(kind: 'increase' | 'decrease' | 'error' | 'broke'): { bg: string; fg: string } {
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
    }
    // A toast belongs over whatever the reader is looking at, and the page's comments view is a
    // top-layer surface no z-index of ours can reach. Re-homing an existing container also
    // covers the toast raised while that surface is open, and the container a closed surface
    // took with it is rebuilt here on the next notification.
    mountOverlayChrome(c);
    return c;
}

/** True when the locale writes a currency symbol AFTER the number (e.g. French
 *  "3,24 $US"). Probed from the platform's own USD formatting so every locale
 *  follows its own convention; only the position is taken from the probe, the
 *  symbol text stays this extension's "US$" branding. Mirrors the popup's
 *  usdSymbolAfterAmount (popup/i18n.ts) — kept local because the content script
 *  cannot import the popup bundle. */
function usdSymbolAfterAmount(locale?: string): boolean {
    try {
        // Underscore form ("pt_BR") is valid for `_locales/` lookup but not for Intl.
        const tag = (locale ?? getEffectiveUILocale()).replace(/_/g, '-');
        const parts = new Intl.NumberFormat(tag, { style: 'currency', currency: 'USD' }).formatToParts(1);
        const currencyIdx = parts.findIndex(part => part.type === 'currency');
        const integerIdx = parts.findIndex(part => part.type === 'integer');
        return currencyIdx !== -1 && integerIdx !== -1 && currencyIdx > integerIdx;
    } catch {
        return false;
    }
}

/** Format a signed USD delta ("+US$5" / "-US$0.0013" in prefix locales, "+5 US$" /
 *  "-0,0013 US$" with the locale separator in suffix locales).
 *  Returns HTML for a signed USD amount with a small, vertically-centered "US" (mirrors
 *  the dashboard's Usd component). Values are numeric/controlled — safe for innerHTML. */
function formatSignedUsd(amount: number, sign: '+' | '-'): string {
    // Mirror the balance's formatUsdNumber rule exactly (popup/i18n.ts): round to 4dp,
    // trim trailing zeros, then 0 decimals → integer; exactly 1 → pad to 2; 2+ → as-is.
    const rounded = Math.round((Math.abs(amount) + Number.EPSILON) * 10000) / 10000;
    const trimmed = rounded.toFixed(4).replace(/0+$/, '');
    const dot = trimmed.indexOf('.');
    const decimals = dot === -1 ? 0 : trimmed.length - dot - 1;
    const frac = decimals === 0 ? 0 : decimals === 1 ? 2 : decimals;
    const locale = getEffectiveUILocale();
    const n = new Intl.NumberFormat(locale, { minimumFractionDigits: frac, maximumFractionDigits: frac }).format(rounded);
    const us = `<span style="font-size:0.6em;font-weight:600;line-height:1;margin:0 0.5px 0 1px;position:relative;top:1px;">US</span>`;
    const dollar = `<span style="font-weight:600;line-height:1;">$</span>`;
    // Suffix form uses a non-breaking space (like the platform convention) so the
    // number and currency can never wrap onto separate lines.
    const nbsp = ' ';
    const currency = usdSymbolAfterAmount(locale) ? `${dollar}${us}` : `${us}${dollar}`;
    const body = usdSymbolAfterAmount(locale) ? `${n}${nbsp}${currency}` : `${currency}${n}`;
    return `<span style="display:inline-flex;align-items:center;line-height:1;">`
        + `${sign}`
        + body
        + `</span>`;
}

/** Auto-dismiss delay for a notification, restarted from scratch every time the
 *  pointer leaves it (see armNotifDismiss). */
const NOTIF_DISMISS_MS = 5000;
/** Fade-out length, mirroring the .mf-notif opacity transition above. */
const NOTIF_FADE_MS = 300;

/** Arm (or re-arm) a notification's auto-dismiss: after NOTIF_DISMISS_MS it fades
 *  and removes itself.
 *
 *  Hover pauses the countdown instead of letting it die mid-read: entering clears
 *  the pending timeout, and leaving starts a FRESH full-length one — not the
 *  remainder — so "resets precisely when we exit the hover" holds no matter how
 *  many times the pointer dips in and out. Each notification tracks its own timers,
 *  so stacked toasts dismiss independently. */
function armNotifDismiss(container: HTMLElement, el: HTMLElement) {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let fadeTimeout: ReturnType<typeof setTimeout> | null = null;
    const dismiss = () => {
        timeout = null;
        el.classList.remove('mf-notif-visible');
        fadeTimeout = setTimeout(() => { el.remove(); if (container.childElementCount === 0) container.remove(); }, NOTIF_FADE_MS);
    };
    const schedule = () => {
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(dismiss, NOTIF_DISMISS_MS);
    };
    // Hovering pauses the countdown; it also cancels a fade already in progress
    // (re-hovering mid-fade restores the toast instead of watching it vanish).
    el.addEventListener('mouseenter', () => {
        if (timeout) { clearTimeout(timeout); timeout = null; }
        if (fadeTimeout) { clearTimeout(fadeTimeout); fadeTimeout = null; el.classList.add('mf-notif-visible'); }
    });
    el.addEventListener('mouseleave', schedule);
    schedule();
}

/** Shared toast construction: colored box, fade-in, click-through to the popup,
 *  hover-paused auto-dismiss. The click dispatches onto mfBus so the relay (which
 *  owns the background port) can forward it — injecting.ts never touches the port
 *  itself, keeping the "host page cannot forge money intents" boundary intact for
 *  everything except this one benign open-the-popup request. content is set by the
 *  caller (textContent for localized copy, innerHTML only for the integer-controlled
 *  formatSignedUsd output). */
function buildNotification(kind: 'increase' | 'decrease' | 'error' | 'broke'): { container: HTMLElement; el: HTMLElement } {
    const container = getNotifContainer();
    const el = document.createElement('div');
    el.className = 'mf-notif';
    const { bg, fg } = notifColor(kind);
    el.style.backgroundColor = bg;
    el.style.color = fg;
    el.addEventListener('click', () => {
        // Every notification, whatever its colour. A red one is the case that needs the
        // balance most: an error is usually the balance, or the lack of it, refusing to
        // pay for something — and landing the user on the Fact-Check tab instead answers
        // a question they did not ask.
        try { browser.storage.local.set({ disinfax_popup_tab: 'balance' }).catch(() => {}); } catch { /* ignore */ }
        mfBus.dispatchEvent(new CustomEvent('mf-open-popup', { detail: { kind } }));
    });
    container.appendChild(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('mf-notif-visible')));
    armNotifDismiss(container, el);
    return { container, el };
}

/** Show a balance-change (green ↑ / orange ↓), error (red), or empty-balance (red)
 *  notification. Auto-dismisses after 5s.
 *
 *  The empty-balance notice deliberately bypasses the freeze guard: the freeze at zero
 *  balance is exactly what it exists to explain, and a frozen tab would otherwise
 *  swallow it (e.g. re-login with an empty balance re-sends no MF_AUTH, so nothing
 *  else would ever announce the state). */
export function showNotification(kind: 'increase' | 'decrease' | 'error' | 'broke', opts: { amount?: number; text?: string; code?: number }) {
    if (kind === 'broke') {
        showBrokeNotification();
        return;
    }
    // A signed-out error must be visible even when the extension is frozen.
    if (extensionFrozen && !(kind === 'error' && opts.code === ERROR_CODES.NOT_SIGNED_IN)) return;
    if (!document.body) return;
    // One charge must never paint twice on the same page. The background fans
    // MF_NOTIFICATION to every live `classify` port, and this file is bundled into
    // both the X.com relay and the selection script — two ports on one tab, or two
    // leftover selection copies, would otherwise stack identical spend banners.
    // Distinct amounts in a short window (preclass then research) still both show.
    if (isDuplicatePageNotification(kind, opts)) return;
    const { container, el } = buildNotification(kind);
    if (kind === 'error') {
        // A recognized error code (see utils/errorCodes.ts) takes this extension's own
        // localized text over whatever the backend sent; opts.text is pre-resolved
        // plain text for everything else (client-detected conditions, or a worker
        // error the parser couldn't map to a code).
        const messageKey = opts.code != null ? codeToMessageKey(opts.code) : null;
        const resolvedText = messageKey ? t(messageKey) : opts.text;
        if (!resolvedText) { el.remove(); if (container.childElementCount === 0) container.remove(); return; }
        el.textContent = resolvedText;
    } else {
        el.innerHTML = formatSignedUsd(opts.amount ?? 0, kind === 'increase' ? '+' : '-');
    }
}

/** "Your balance is empty" notice (red, no amount). Shown once per page-load, so a
 *  tab left open on x.com doesn't re-announce a state the user already saw — the
 *  session flag is per content-script lifetime. */
let brokeNotificationShown = false;
function showBrokeNotification() {
    if (brokeNotificationShown) return;
    // Check the body BEFORE setting the flag: an MF_NOTIFICATION can arrive at
    // document_start before <body> exists, and that delivery must not consume the
    // one announcement — a later broadcast (funds baseline, tab connect) retries it.
    if (!document.body) return;
    if (isDuplicatePageNotification('broke', {})) return;
    brokeNotificationShown = true;
    buildNotification('broke').el.textContent = t('balanceEmpty');
}

/** Collapse identical toasts that arrive through more than one content-script
 *  bundle on the same page. Module state is per-bundle, so this lives on
 *  `window` — the isolated world is shared by the relay and every injected
 *  copy of the selection script. */
const PAGE_NOTIF_DEDUPE_KEY = '__mfNotifDedupe';
const PAGE_NOTIF_DEDUPE_MS = 2000;
function isDuplicatePageNotification(
    kind: 'increase' | 'decrease' | 'error' | 'broke',
    opts: { amount?: number; text?: string; code?: number },
): boolean {
    const key = kind === 'error'
        ? `error:${opts.code ?? ''}:${opts.text ?? ''}`
        : kind === 'broke'
            ? 'broke'
            : `${kind}:${Math.round((opts.amount ?? 0) * 10000)}`;
    const now = Date.now();
    const w = window as unknown as Record<string, { key: string; at: number } | undefined>;
    const last = w[PAGE_NOTIF_DEDUPE_KEY];
    if (last && last.key === key && now - last.at < PAGE_NOTIF_DEDUPE_MS) return true;
    w[PAGE_NOTIF_DEDUPE_KEY] = { key, at: now };
    return false;
}

// ── Onboarding "charge-balance" popovers ─────────────────────────────────────
// Persistent popovers next to every charge button whose type the user has never
// clicked, warning that using it spends balance. An "×" permanently dismisses just
// that popover's type (same effect as clicking its charge button); other types are
// unaffected, since e.g. Fact-Check and Fact-Check All are separate buttons that
// happen to share a purpose. z-index sits above
// claim popovers (z:2147483643) but below notifications (z:2147483645).

const ONBOARD_DISMISS_KEY = 'mf_onboarding_dismissed';
const ONBOARD_CLICKED_KEY = 'mf_onboarding_clicked_types';
/// Types anchored directly next to a single per-tweet button. 'refresh-top' is the
// top-of-tweet batch-refresh icon: same charge warning as the in-popover refresh it
// replaces, now anchored to the button at the tweet instead.
const STANDALONE_CHARGE_TYPES = new Set(['disinfact', 'factcheckall', 'translate-tweet', 'refresh-top']);
let onboardingDismissed = false;
const onboardingClickedTypes = new Set<string>();
/** Maps a charge-button anchor to its onboarding popover. */
const onboardingByAnchor = new WeakMap<HTMLElement, HTMLElement>();

function persistOnboardingClicked() {
    try { browser.storage.local.set({ [ONBOARD_CLICKED_KEY]: Array.from(onboardingClickedTypes) }).catch(() => { /* ignore */ }); } catch { /* ignore */ }
}
/** Each charge type dismisses its own onboarding independently: Disinfact reveals
 *  claims, Localize repositions highlights, Annotate checks a claim for errors —
 *  tapping one says nothing about the others. (Localize was historically
 *  clustered with Disinfact when it shared that label; it has its own label
 *  and its own popover now.) */
function onboardingCluster(type: string): string[] {
    return [type];
}
function markOnboardingClicked(type: string) {
    if (!type) return;
    let added = false;
    for (const t of onboardingCluster(type)) {
        if (onboardingClickedTypes.has(t)) continue;
        onboardingClickedTypes.add(t);
        added = true;
    }
    if (!added) return;
    persistOnboardingClicked();
    refreshOnboarding();
}
function onboardingActive(type: string): boolean {
    if (onboardingDismissed) return false;
    return !onboardingCluster(type).some(t => onboardingClickedTypes.has(t));
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
    } else if (type === 'translate-tweet') {
        // Localize has its own label now (not Disinfact): its popover names the
        // highlight-repositioning action, not claim revelation.
        msg = t('onboardLocalize');
    } else if (type === 'annotate') {
        // The Annotate highlight button: checks this claim for errors.
        msg = t('onboardAnnotate');
    } else if (type === 'factcheck') msg = t('onboardFactcheck');
    else if (type === 'translate-inner') msg = t('onboardTranslations');
    else if (type === 'refresh-inner') msg = t('onboardRefreshes');
    else if (type === 'refresh-top') msg = t('onboardRefreshes');
    else msg = t('onboardWillCharge'); // factcheckall
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
        case 'translate-tweet': return { label: t('localizeButton') };
        case 'annotate': return { label: t('annotateButton') };
        case 'factcheck': return { label: t('factCheckButton') };
        case 'translate-inner': return { icon: onboardTranslateIconSvg };
        case 'refresh-inner': return { icon: onboardRefreshIconSvg };
        case 'refresh-top': return { icon: onboardRefreshIconSvg };
        default: return { label: t('factCheckButton') };
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
    // Disinfact (including the highlight-localization variant) / Fact-Check All
    // specifically prefer opening ABOVE their button when there's no room to the
    // right, before falling back below.
    const preferAbove = type === 'disinfact' || type === 'translate-tweet' || type === 'factcheckall';
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
    // Drop standalone popovers whose anchor is gone / type now clicked. A removed
    // popover un-exempts its anchor button, so its article must be re-squeezed below —
    // otherwise an injection-time cap sticks forever: a compressed button with space.
    const unexempted = new Set<Element>();
    for (const pop of Array.from(document.querySelectorAll<HTMLElement>('.mf-onboard'))) {
        const type = pop.dataset.mfOnboard ?? '';
        if (!STANDALONE_CHARGE_TYPES.has(type)) continue;
        if (!wanted.has(pop)) {
            const article = anchorForOnboardingPop(pop)?.closest('article');
            if (article) unexempted.add(article);
            pop.remove();
        }
    }
    // When a tweet-top Fact-Check All popover and a tweet-top refresh popover are both
    // showing for the SAME tweet, stack them: refresh above, Fact-Check All below.
    // Same-tweet = anchors in the same article (beside-variant) or the same on-hold
    // container subtree; different tweets never coordinate.
    stackTopOnboardingPairs();
    // A popover opening/closing flips the squeeze exemption for its anchor button,
    // so re-run the squeezer on every affected article: the ones still showing a
    // popover (newly exempt) AND the ones that just lost one (newly un-exempt).
    const squeezed = new Set<Element>();
    for (const pop of Array.from(document.querySelectorAll<HTMLElement>('.mf-onboard'))) {
        const anchor = anchorForOnboardingPop(pop);
        const article = anchor?.closest('article');
        if (article && !squeezed.has(article)) { squeezed.add(article); updateTopButtonSqueeze(article); }
    }
    for (const article of unexempted) {
        if (!squeezed.has(article)) { squeezed.add(article); updateTopButtonSqueeze(article); }
    }
}

/** Stack same-tweet tweet-top onboarding pairs: the refresh popover above, the
 *  Fact-Check All popover below. Only overrides placement when BOTH are showing
 *  for the same tweet; every other popover keeps its computed position. Runs on
 *  every standalone refresh (injection + scroll), so stacking tracks movement and
 *  a dismissed/expired popover simply stops participating. */
function stackTopOnboardingPairs() {
    const pops = Array.from(document.querySelectorAll<HTMLElement>('.mf-onboard[data-mf-onboard="refresh-top"], .mf-onboard[data-mf-onboard="factcheckall"]'));
    if (pops.length < 2) return;
    // Group by tweet: the article holding both anchors.
    const byTweet = new Map<Element, { refresh?: HTMLElement; factcheckall?: HTMLElement }>();
    for (const pop of pops) {
        if (!pop.isConnected) continue;
        const anchor = anchorForOnboardingPop(pop);
        const article = anchor?.closest('article');
        if (!article) continue;
        let g = byTweet.get(article);
        if (!g) { g = {}; byTweet.set(article, g); }
        if (pop.dataset.mfOnboard === 'refresh-top') g.refresh = pop;
        else g.factcheckall = pop;
    }
    for (const { refresh, factcheckall } of byTweet.values()) {
        if (!refresh || !factcheckall) continue;
        const refreshAnchor = anchorForOnboardingPop(refresh);
        const fcaAnchor = anchorForOnboardingPop(factcheckall);
        if (!refreshAnchor || !fcaAnchor) continue;
        // Anchor both popovers to the refresh button's row: refresh directly above it,
        // Fact-Check All directly below it. Both share the same left edge so they read
        // as one stacked callout.
        const rRect = getTriggerViewportRect(refreshAnchor);
        const fRect = getTriggerViewportRect(fcaAnchor);
        const trigRect = {
            top: Math.min(rRect.top, fRect.top),
            bottom: Math.max(rRect.bottom, fRect.bottom),
            left: Math.min(rRect.left, fRect.left),
            right: Math.max(rRect.right, fRect.right),
        };
        const padding = 8;
        const refreshH = refresh.getBoundingClientRect().height || 0;
        const fcaH = factcheckall.getBoundingClientRect().height || 0;
        const viewportWidth = window.innerWidth;
        // Horizontal: align to the buttons' left, clamped into the viewport. The
        // normal right-side placement is skipped here by construction — stacking
        // only matters on cramped widths where both fell back to vertical.
        const w = Math.max(refresh.getBoundingClientRect().width || 0, factcheckall.getBoundingClientRect().width || 0, 280);
        const left = Math.max(padding, Math.min(trigRect.left, viewportWidth - w - padding));
        refresh.style.position = 'fixed';
        factcheckall.style.position = 'fixed';
        refresh.style.left = `${left}px`;
        factcheckall.style.left = `${left}px`;
        refresh.style.width = `${w}px`;
        refresh.style.maxWidth = `${w}px`;
        factcheckall.style.width = `${w}px`;
        factcheckall.style.maxWidth = `${w}px`;
        // Refresh above the row when it fits, else below the Fact-Check All popover
        // is impossible (that's the row itself) — so fall back to directly below the
        // row, pushing Fact-Check All further down.
        const spaceAbove = trigRect.top - padding;
        if (refreshH > 0 && spaceAbove >= refreshH) {
            refresh.style.top = `${trigRect.top - refreshH - padding}px`;
            factcheckall.style.top = `${trigRect.bottom + padding}px`;
        } else {
            factcheckall.style.top = `${trigRect.bottom + padding}px`;
            refresh.style.top = `${trigRect.bottom + padding + fcaH + padding}px`;
        }
        // User drags re-apply on the next positionOnboardingPopover pass (they are
        // stored as offsets and added there); stacking only sets the base positions.
    }
}

/** Reverse-lookup the anchor element a standalone onboarding popover was built for. */
function anchorForOnboardingPop(pop: HTMLElement): HTMLElement | null {
    for (const anchor of Array.from(document.querySelectorAll<HTMLElement>('[data-mf-charge]'))) {
        if (onboardingByAnchor.get(anchor) === pop) return anchor;
    }
    return null;
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
        // An Annotate badge is permanent but is NOT a Fact-Check button: the
        // "fact-checking will charge" onboarding must neither anchor to it nor
        // be dismissed by it. spanNeedsAnnotateBadge reads the live dataset, so
        // a stale _mfBadgePermanent marker can't mistag the claim either.
        const isFactcheck = el.dataset.reclassifyOnHold === 'true' || (!!(el as any)._mfBadgePermanent && !spanNeedsAnnotateBadge(el));
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

/** One "Annotating a claim will charge your balance" popover per tweet, attached
 *  to the first claim (DOM order) currently showing the idle Annotate button.
 *  Re-anchors dynamically as claims stream in and their badges appear/disappear.
 *  Unlike the top buttons the idle Annotate badge carries no data-mf-charge
 *  marker of its own — stamping one on every highlight would invite the generic
 *  click-marker and standalone reaper into a lifecycle owned entirely by the
 *  annotate reconcile, so this mirrors the Fact-Check pattern (its own popover
 *  map, dismissed by the same delegated click handler below) instead. Only the
 *  IDLE button anchors one: a pending "Annotating" flight is hover-only and has
 *  nothing to click, so it never earns a callout. */
const annotateByArticle = new WeakMap<Element, HTMLElement>();
function refreshAnnotateOnboarding() {
    // The anchor is always the idle button's own span: a per-tweet map, so one
    // popover per tweet, not one per claim.
    const firstByArticle = new Map<Element, HTMLElement>();
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('.mf-segment-claim'))) {
        if (spanWantsIdleAnnotate(el) && el.isConnected) {
            const article = el.closest('article');
            if (article && !firstByArticle.has(article)) firstByArticle.set(article, el);
        }
    }

    if (!onboardingActive('annotate')) {
        for (const pop of Array.from(document.querySelectorAll('.mf-onboard[data-mf-onboard="annotate"]'))) pop.remove();
        return;
    }

    const wanted = new Set<HTMLElement>();
    for (const [article, anchor] of firstByArticle) {
        let pop = annotateByArticle.get(article);
        if (!pop || !pop.isConnected) {
            pop = buildOnboardingPopover('annotate');
            document.body.appendChild(pop);
            annotateByArticle.set(article, pop);
        }
        positionOnboardingPopover(pop, anchor);
        wanted.add(pop);
    }
    // Remove the annotate popover from any tweet that no longer has an idle button.
    for (const pop of Array.from(document.querySelectorAll<HTMLElement>('.mf-onboard[data-mf-onboard="annotate"]'))) {
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

/** Attached onboarding callouts live below the popover they annotate, positioned from the
 *  popover's CURRENT offsetTop/offsetHeight (see the assignment below). Anything that
 *  resizes the popover therefore has to re-run this, or a callout keeps the geometry it was
 *  given when the window was smaller and floats up over the reasoning.
 *
 *  Exported for the selection surface, which — unlike the X feed, where
 *  injectClassifications re-runs refreshOnboarding() after every update — repaints its
 *  popover through updateOpenPopover() alone and so would otherwise never reposition them.
 *  X itself never calls this directly; it goes through refreshOnboarding(). */
export function refreshInPopoverOnboarding() {
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
        // Below, these callouts are placed from the claim popover's offsetTop/offsetLeft — the
        // coordinates it was positioned in. A popover mounted on document.body (see mountPopover)
        // has no offsetParent and reports VIEWPORT coordinates, so its callouts are mounted there
        // too and anchored the same way; without this they would resolve against the document
        // instead and slide by the page's scroll offset.
        const viewportAnchored = !!(claimPop as any)._mfViewportFixed;
        const container = viewportAnchored
            ? document.body
            : (claimPop.offsetParent instanceof HTMLElement ? claimPop.offsetParent : getTimelineContainer(claimPop));

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
            if (viewportAnchored) op.style.position = 'fixed';
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
    refreshAnnotateOnboarding();
    refreshInPopoverOnboarding();
}

// Load persisted onboarding state, then evaluate.
try {
    browser.storage.local.get([ONBOARD_DISMISS_KEY, ONBOARD_CLICKED_KEY]).then((res: any) => {
        if (res) {
            onboardingDismissed = res[ONBOARD_DISMISS_KEY] === true;
            if (Array.isArray(res[ONBOARD_CLICKED_KEY])) for (const x of res[ONBOARD_CLICKED_KEY]) onboardingClickedTypes.add(String(x));
        }
        // Note: users who clicked Disinfact or Localize under the old shared
        // cluster carry both types as done, so the newly-independent Localize
        // popover won't re-show for them. Deliberately no migration: the stored
        // state can't distinguish "clicked Disinfact only" from "clicked
        // Localize", and re-stripping would nag genuine Localize users every
        // session. New users and anyone who clicked neither get the full tour.
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
    // The idle Annotate button carries no data-mf-charge marker of its own (see
    // refreshAnnotateOnboarding), so its tap is marked done here by the same gate
    // the tap handler requires — never during a pending flight, whose badge is
    // hover-only and earns no callout.
    const annTarget = (e.target as HTMLElement)?.closest?.('.mf-segment-claim') as HTMLElement | null;
    if (annTarget && spanWantsIdleAnnotate(annTarget)
        && ((e.target as Element)?.closest?.('.mf-annotate-badge')
            || (!(annTarget as any)._mfPopoverOpen && !(e.target as Element)?.closest?.('.mf-inline-badge')))) {
        markOnboardingClicked('annotate');
    }
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
export function findTweetTextElement(article: Element, isQuoted: boolean = false, tweetId?: string): Element | null {
    const seam = platformSeam();
    if (seam) return seam.textElement(article, { id: tweetId ?? '', isQuoted });

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

/** Show the whole of an X post we have just painted marks into.
 *
 *  X clamps a long post's own text element, and it does it with an INLINE style rather than
 *  a rule: `[data-testid="tweetText"]` carries `style="-webkit-line-clamp: 5; …"`, which no
 *  stylesheet scan will ever find. `overflow: hidden` arrives from a class. Measured on a
 *  signed-in home timeline: a 275-character post rendered 100px against a 140px
 *  scrollHeight, two of its lines unreachable.
 *
 *  Two separate readings decided that this is worth clearing. First, it is not a state X
 *  keeps only off-screen posts in: scrolling that post to the middle of the viewport and
 *  touching nothing left `clamp: 5, overflow: hidden, hidden: 40` exactly as it was, from
 *  +300ms out to +9s. Second, a QUOTED post gets no "Show more" to escape through — the
 *  outer post in the same article renders one and the quote inside it does not — so there a
 *  post past five lines is cut with nothing on screen offering the rest.
 *
 *  `renderSegmentedTweet` rebuilds that element's CHILDREN, which leaves the inline clamp
 *  exactly where it was: a reader who followed a claim past line five would be reading four
 *  lines, an ellipsis, and no sign of what they came for.
 *
 *  Two declarations are the whole of it — clearing the clamp and the overflow it hides
 *  behind takes the same element from `100/140, hidden 40` to `140/140, hidden 0`, verified
 *  on the element itself. X's own "Show more" lifts the same clamp. X's control is left in
 *  the DOM rather than removed — it is React's node, and a node deleted from outside React
 *  is the classic way to break reconciliation on the host's next render of the very subtree
 *  our `mf-segment-wrap` lives in. Nothing here changes the text, so the hash and the id are
 *  untouched.
 *
 *  X is the one platform reached without the adapter seam (consulting the X adapter from
 *  this file would recurse — see the note at the top of `utils/platforms/x.ts`), which is
 *  why this lives here rather than on `xAdapter`. */
function unclipXPostText(textElement: Element): void {
    const el = textElement as HTMLElement;
    el.style.webkitLineClamp = 'unset';
    el.style.overflow = 'visible';
}

/** Give a body we are about to paint into, or have just been asked about, the whole of
 *  itself — through the platform's own hook where it has one, and through X's own clamp
 *  where it does not. */
function unclipPostBody(textElement: Element): void {
    const seam = platformSeam();
    if (seam) {
        seam.unclip?.(textElement);
        return;
    }
    unclipXPostText(textElement);
}

/** Rebuild a tweet's text element from `segments`, wrapping claim segments in interactive
 *  highlight spans and leaving the rest as plain text.
 *
 *  X renders links with display text that differs from the href (shortened URLs, @mentions),
 *  so existing anchors are captured first and restored as the text is rewritten — otherwise
 *  rebuilding the element would turn every link into a raw URL. */
function renderSegmentedTweet(tweetTextEl: Element, segments: TextSegment[], claims: Claim[], batchId: string, classificationId?: string, hiddenPlain?: Set<number> | null, textLocale?: string) {
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

    const wrap = buildSegmentWrap(segments, claims, batchId, urlDisplayMap, classificationId, hiddenPlain, textLocale);
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

/** The fewest characters of a classified run worth painting on their own.
 *
 *  Only used on the partial-fit path below, where the element holds a prefix of the run and
 *  not the whole of it. Below this length a match is as likely to be a coincidence as the
 *  run, and painting a coincidental range would underline words nobody classified. */
const MIN_ALIGNED_PREFIX = 12;

/** Paint `segments` over the element's own text, leaving the rest of its DOM alone.
 *
 *  `renderSegmentedTweet` cannot be used for a body that is markup. It writes the
 *  classified text into the element, which is correct for a tweet (one inline run, and X
 *  re-links @/#/URLs itself) and destructive for a rendered markdown body: Reddit's links,
 *  headings and list items are not text nodes to be rewritten, so the rebuild flattens the
 *  whole post into a single paragraph and every link loses the words it was wrapped around.
 *
 *  Instead the element's children are moved into a `.mf-segment-wrap` and
 *  `wrapClaimSegmentsInPlace` wraps only the claimed runs inside it. In this mode the wrap
 *  is `display: contents` (see the stylesheet), so it generates no box: the block structure
 *  underneath lays out exactly as the page built it.
 *
 *  The wrapper deliberately does NOT park the moved children in `_mfOriginalNodes` the way
 *  `renderSegmentedTweet` parks X's. That handoff is only sound when the parked nodes are
 *  held intact, and the rebuild path does hold them: it renders from its own spans and
 *  never touches X's nodes. This path wraps the parked nodes THEMSELVES — `isolateTextRun`
 *  rewrites a text node's data and empties it, and `extractContents` detaches what it
 *  takes — so a snapshot taken here is a husk by the time any teardown reads it, and
 *  `restoreOriginals` would put an empty node back and leave the post blank. Measured: a
 *  comment whose claim started at offset 0 lost its entire body. Without the parking,
 *  every teardown takes its in-place-safe branch instead — `discardSegmentWrap` and
 *  `freezeSegmentWrap` both un-paint a wrap of this kind (restoring the text a paint cut out
 *  of the page's own nodes) and unwrap it — and all of them keep the text.
 *
 *  Nothing is lost when nothing can be highlighted: with no claim in `segments` no run is
 *  wrapped and the element is left as the page rendered it. */
function renderSegmentsInPlace(tweetTextEl: Element, segments: TextSegment[], claims: Claim[], batchId: string, classificationId: string | undefined, hiddenPlain: Set<number> | null, textLocale?: string) {
    let wrap = tweetTextEl.querySelector<HTMLElement>(":scope > .mf-segment-wrap");
    if (!wrap) {
        const live = Array.from(tweetTextEl.childNodes);
        if (live.length === 0) return;
        wrap = document.createElement("span");
        wrap.className = "mf-segment-wrap mf-in-place";
        wrap.dataset.mfInPlace = "1";
        wrap.dataset.mfHiddenPlain = hiddenPlainSig(hiddenPlain);
        tweetTextEl.appendChild(wrap);
        wrap.append(...live);
    }
    // `wrapClaimSegmentsInPlace` walks the container's text by the segments' own lengths,
    // so the segments must start at the container's first character. They do not: the
    // classified text is trimmed (the worker hashes it, and a leading indent is not part of
    // the post) while the element's text is whatever whitespace the page's markup indents
    // with. Pad the segments out to the element's own text — the classified run is located
    // in it, and the whitespace on either side becomes plain segments, which wrap nothing.
    // A passage has two possible shapes and the classified text names which one is in force: with
    // every `<br>` counted as the newline it renders, or with breaks counted as nothing at all.
    // The first is what `passageTextContent` produces and what every adapter that reads its body
    // through it classifies; the second is what a body read by plain `textContent` classifies, and
    // a break inside such a body is invisible to the capture but not to this walk — so the
    // classified run would not be found and the post would lose every highlight, silently. Asking
    // which shape contains the text costs one failed `indexOf` in the common case and makes the
    // adapter's own read the deciding vote rather than a migration this file has to keep in step.
    const joined = segments.map(s => s.text).join('');
    const bounds = [0];
    for (const seg of segments) bounds.push(bounds[bounds.length - 1] + seg.text.length);
    // The element and the classified run can also differ INSIDE the run, in which case
    // containment of the whole thing fails while most of it sits in the element verbatim.
    // A host that ellipsised a link it renders is the case in hand: Threads paints
    // `cnn.it/4y52w…` where the payload — and so the classification — holds the whole URL,
    // so a body the adapter read from the network names text the page never wrote. Dropping
    // every highlight on such a post is the one outcome that helps nobody: the claims before
    // the divergence are exactly the claims the element does hold. So take the longest run of
    // LEADING segments the element contains — cut at a segment boundary, so no claim is ever
    // painted in part — and leave the rest of what is on screen as plain text.
    const fitOf = (p: string): { at: number; kept: number } | null => {
        const whole = p.indexOf(joined);
        if (whole >= 0) return { at: whole, kept: segments.length };
        for (let i = segments.length - 1; i >= 1; i--) {
            if (bounds[i] < MIN_ALIGNED_PREFIX) break;
            const at = p.indexOf(joined.slice(0, bounds[i]));
            if (at >= 0) return { at, kept: i };
        }
        return null;
    };
    let breaks = true;
    let passage = passageTextContent(wrap, true);
    let fit = fitOf(passage);
    // A partial fit is worth a second look at the other shape: the shape that does not hold
    // the whole run may well hold more of it. Contained-whole costs no second walk.
    if (!fit || fit.kept < segments.length) {
        const altPassage = passageTextContent(wrap, false);
        const altFit = fitOf(altPassage);
        if (altFit && (!fit || altFit.kept > fit.kept)) {
            breaks = false;
            passage = altPassage;
            fit = altFit;
        }
    }
    let at = fit ? fit.at : 0;
    let kept = fit ? fit.kept : 0;
    // The classified text and the page can also disagree on WHITESPACE ALONE, and then the exact
    // fit above stops at the first place they do: the claims before it are exactly the claims the
    // element still holds, so the post keeps the highlights of its opening and silently loses
    // every one after — two badges in the first paragraph and a plain rest, which reads as the
    // painter giving up halfway.
    //
    // What makes the two copies part company is a body completed from the page's own payload
    // (facebook's `wholeBodyText`). That splice keeps the page's characters up to the cut and
    // takes the remainder from the payload, and the payload separates paragraphs with a newline
    // where the renderer runs each into its own block and puts nothing between them (see
    // `squeeze`). One character then sits in the classified text that the page never wrote, and
    // every claim placed after the first paragraph join addresses the page one character off.
    //
    // Whitespace is the ONLY thing tolerated here. Every non-space character of the classified run
    // must appear, in order and unchanged, in the passage — so no claim can be painted over words
    // it does not name, and a divergence of any other kind leaves the exact fit's answer standing.
    // A segment is taken only when the alignment reaches its end, so no claim is ever painted in
    // part, the same rule the exact fit follows.
    let spaceCuts: number[] | null = null;
    if (kept < segments.length) {
        const spaceFitOf = (p: string): { at: number; kept: number; cuts: number[] } | null => {
            const ws = (ch: string): boolean => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
            const map: number[] = new Array(joined.length + 1).fill(-1);
            let j = 0;
            let i = 0;
            while (j < joined.length && i < p.length) {
                const c = joined[j];
                const d = p[i];
                if (c === d || (ws(c) && ws(d))) { map[j] = i; j++; i++; continue; }
                if (ws(c)) { map[j] = i; j++; continue; }
                if (ws(d)) { i++; continue; }
                break;
            }
            if (map[0] < 0) return null;
            // The passage index just past the last classified character the alignment reached.
            // `map` holds a position per consumed character, so a boundary AT the end of the run
            // has none — and without this the final cut reads as "never reached", which slices the
            // last segment empty and hands its characters to the plain tail instead. Set only when
            // the whole run was consumed: anywhere else that index belongs to a character the
            // alignment refused, and a segment ending there must not be taken.
            if (j === joined.length) map[joined.length] = i;
            let n = 0;
            while (n < segments.length && map[bounds[n + 1]] >= 0) n++;
            if (n === 0) return null;
            const cuts: number[] = [];
            for (let k = 0; k <= n; k++) cuts.push(map[bounds[k]]);
            return { at: cuts[0], kept: n, cuts };
        };
        let best = spaceFitOf(passage);
        if (!best || best.kept < segments.length) {
            const altPassage = passageTextContent(wrap, !breaks);
            const altBest = spaceFitOf(altPassage);
            if (altBest && (!best || altBest.kept > best.kept)) {
                best = altBest;
                passage = altPassage;
                breaks = !breaks;
            }
        }
        if (best && best.kept > kept) {
            at = best.at;
            kept = best.kept;
            spaceCuts = best.cuts;
            console.log(`[misinfo] renderSegmentsInPlace: ${classificationId ?? '?'} — the classified text and the element agree on every character but their whitespace, so ${kept} of ${segments.length} segments are painted instead of the exact fit's ${fit ? fit.kept : 0}.`);
        }
    }
    // The passage offset of each segment's start: the exact fit's own arithmetic, or the offsets
    // the whitespace alignment landed on. Everything emitted below is a slice of the PASSAGE,
    // which is what keeps the walk's segments accounting for every character of the container.
    const cutAt = (k: number): number => (spaceCuts ? spaceCuts[k] : at + bounds[k]);
    if (!fit && !spaceCuts) {
        // Both sides are printed because they are the whole diagnosis: a mismatch here means
        // the element no longer holds the text that was classified, and which side moved (a
        // host translation, a rebuild by the page, an our-own teardown that dropped the
        // originals) is only visible by comparing them.
        console.log(`[misinfo] renderSegmentsInPlace: ${classificationId ?? '?'} — the element's text does not contain the classified text, leaving it unwrapped. dom(${passage.length})="${passage.slice(0, 60)}" classified(${joined.length})="${joined.slice(0, 60)}"`);
        return;
    }
    if (kept < segments.length) {
        const cut = cutAt(kept);
        console.log(`[misinfo] renderSegmentsInPlace: ${classificationId ?? '?'} — the element holds only the first ${kept} of ${segments.length} classified segments (${bounds[kept]}/${joined.length} chars); highlighting those and leaving the rest plain. dom="…${passage.slice(Math.max(0, cut - 20), cut + 20)}" classified="…${joined.slice(Math.max(0, bounds[kept] - 20), bounds[kept] + 20)}"`);
    }
    const aligned: TextSegment[] = [];
    if (at > 0) aligned.push({ text: passage.slice(0, at), claimIndex: null });
    // While hidden, a non-bypassing claim renders as ordinary text, which in this mode
    // just means it is not wrapped at all — there is no plain span to build, because the
    // page's own text node is already what plain rendering produces.
    for (let i = 0; i < kept; i++) {
        const seg = segments[i];
        // The page's own characters rather than the classified slice: the two are the same string
        // wherever the fit was exact, and where it was not, these are the characters on screen.
        const text = passage.slice(cutAt(i), cutAt(i + 1));
        const out = text === seg.text ? seg : { ...seg, text };
        aligned.push(hiddenPlain && out.claimIndex !== null && hiddenPlain.has(out.claimIndex)
            ? { ...out, claimIndex: null }
            : out);
    }
    // Everything past the fit is one plain segment covering it. It has to be here — the walk
    // below requires the segments to account for every character of the container — and being
    // plain is what keeps the unpaintable tail from being painted as something it is not.
    const tail = passage.slice(cutAt(kept));
    if (tail) aligned.push({ text: tail, claimIndex: null });

    if (!wrapClaimSegmentsInPlace(wrap, aligned, claims, batchId, classificationId, textLocale, breaks)) {
        console.log(`[misinfo] renderSegmentsInPlace: element text does not match the classified segments for ${classificationId ?? '?'} — left unwrapped`);
    }
}

/** Discard a segment wrap without discarding the text it holds.
 *
 *  An in-place wrap owns the post's own child nodes — the page's, not ours — so `remove()`
 *  would delete the post along with them. It is unwrapped instead, which returns those
 *  nodes to the host exactly where they were. A rebuild wrap holds the rendered text
 *  itself and is removed as before. Every removal site goes through here for that reason. */
function discardSegmentWrap(wrap: HTMLElement) {
    if (wrap.dataset.mfInPlace === "1") {
        // Un-paint before handing the page's nodes back, for the same reason Hide does: a
        // stand-in left holding the post's text is a post the page's own next write cannot
        // visibly replace.
        undoInPlacePaint(wrap);
        wrap.replaceWith(...Array.from(wrap.childNodes));
        return;
    }
    wrap.remove();
}

/** What an in-place paint has to undo, recorded on the wrap it painted. */
type InPlacePaint = {
    /** The passage as this paint left it, node by node. A page writing a post's next text into a
     *  node it made shows up here and nowhere else — no element added, no element re-rendered, so
     *  the injection observer never hears it. Detached nodes are deliberately NOT a signal: our
     *  own churn detaches plenty, and a page that renders fresh nodes instead of rewriting these
     *  is caught by that observer as the removal it is. */
    watch: { node: Text; left: string }[];
    /** Text this paint cut out of a node that is the page's own, with the whole text that node
     *  held before the cut. Putting it back cannot double anything: the run cut out of it lives
     *  in a node the paint minted, and undo drops those. */
    cut: { node: Text; before: string; left: string }[];
    /** Claim spans this paint minted, holding only text of its own. Removed. */
    own: HTMLElement[];
    /** Claim spans holding the page's own nodes — a claim that runs across an `<a>`/`<u>` keeps
     *  that element inside its highlight. Unwrapped, never removed. */
    moved: HTMLElement[];
};

type PaintHost = HTMLElement & { _mfPaint?: InPlacePaint };
type MintedText = Text & { _mfMinted?: true };

function inPlacePaintOf(wrap: HTMLElement): InPlacePaint | null {
    return (wrap as PaintHost)._mfPaint ?? null;
}

/** Mark text this extension minted — a stand-in run cut out of the page's own node.
 *
 *  The mark has to outlive the paint that made it: a later paint cuts those same stand-in nodes
 *  rather than the node they were cut from, so by the time undo runs the record no longer names
 *  them. Without it, dropping the paint would leave text the page has since replaced sitting in
 *  the passage, and restoring that paint's cuts would double text it no longer holds alone. */
function markMinted(node: Text) {
    (node as MintedText)._mfMinted = true;
}

function markMintedSubtree(el: Element) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) markMinted(node as Text);
}

/** Undo an in-place paint: strip ours, hand the page's text back.
 *
 *  Called when the page has rewritten the words under a paint, and on every teardown of the
 *  wrap (Hide, discard) — a paint left standing while its stand-in runs hold the post's text is
 *  exactly what makes the page's next write invisible, so teardown un-paints rather than merely
 *  unwrapping.
 *
 *  What comes off is ours: the claim spans, the stand-in runs, and the spans holding the page's
 *  own nodes (those are unwrapped, never removed). A cut node goes back to the text it held,
 *  unless the page has already written something else into it — that text is the page's to show
 *  — or unless the cut was into a stand-in of an earlier paint, which is ours to drop. */
function undoInPlacePaint(wrap: HTMLElement) {
    const paint = inPlacePaintOf(wrap);
    if (!paint) return;
    delete (wrap as PaintHost)._mfPaint;
    // Our chrome first, before anything is unwrapped into the passage: a badge is not text.
    for (const chrome of Array.from(wrap.querySelectorAll('.mf-inline-badge, .mf-standalone-spinner'))) {
        chrome.remove();
    }
    for (const span of paint.moved) {
        if (!span.isConnected) continue;
        for (const inner of Array.from(span.querySelectorAll('.mf-strike, .mf-corr'))) {
            inner.replaceWith(...Array.from(inner.childNodes));
        }
        span.replaceWith(...Array.from(span.childNodes));
    }
    for (const span of paint.own) {
        if (span.isConnected) span.remove();
    }
    // Stand-ins outlive the paint that minted them, so they are found by their mark rather than
    // by the record, and a cut that landed in one is never restored (its `before` is also this
    // paint's, and the text it holds is the language the page has just replaced).
    const walker = document.createTreeWalker(wrap, NodeFilter.SHOW_TEXT);
    const minted: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if ((node as MintedText)._mfMinted) minted.push(node as Text);
    }
    for (const cut of paint.cut) {
        if ((cut.node as MintedText)._mfMinted || !cut.node.isConnected || cut.node.data !== cut.left) continue;
        cut.node.data = cut.before;
    }
    for (const node of minted) node.remove();
}

/** Has the page rewritten the words under an in-place paint?
 *
 *  Compared node by node against the passage as the paint left it. A node the paint wrote and
 *  the page has since written something else into is the whole signal: that is what a language
 *  toggle does — the same node, new text, no element re-rendered. */
function inPlacePaintIsStale(wrap: HTMLElement): boolean {
    const paint = inPlacePaintOf(wrap);
    if (!paint) return false;
    for (const entry of paint.watch) {
        if (entry.node.data !== entry.left) return true;
    }
    return false;
}

/** Does the active platform want highlights painted over its own text nodes rather than
 *  rebuilt from the classified text? See `PlatformAdapter.highlightInPlace`. */
function platformHighlightsInPlace(): boolean {
    return !!platformSeam()?.highlightInPlace;
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

/** Build the nodes for ONE claim segment: the span carrying every dataset field the
 *  popover, the badges and the refresh/annotate paths read, followed by its badge when
 *  `withBadge`.
 *
 *  Split out of `buildSegmentWrap` (whose behaviour is unchanged) so a surface that must
 *  NOT rebuild its text can inject into a wrap it already has — see
 *  `wrapClaimSegmentsInPlace`. `withBadge` false returns the span alone: when one claim
 *  runs across two block elements it is wrapped piece by piece, and the single badge rides
 *  the last piece. */
function annotationsHaveRanges(ann: Claim['annotations']): boolean {
    if (!ann || typeof ann !== 'object') return false;
    for (const dict of Object.values(ann)) {
        if (dict && typeof dict === 'object' && !Array.isArray(dict) && Object.keys(dict).length > 0) return true;
    }
    return false;
}

function makeClaimSegmentNodes(batchId: string, classificationId?: string, textLocale?: string) {
    return (seg: TextSegment, claim: Claim, withBadge: boolean, contents?: Node[]): Node[] => {

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
        pinClaimLayout(span);
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
        // Range-keyed annotations, bare-locale keys ({en: {"s,e": correction}}).
        // Synced in place on updates (see upgradeToSegments) so annotation-only
        // broadcasts repaint without rebuilding the wrap.
        span.dataset.annotations = JSON.stringify(claim.annotations ?? {});
        // Text locale of the displayed tweet — tells the popover which key's
        // ranges index this span's text (same key rule as highlight breakup).
        if (textLocale) span.dataset.textLocale = textLocale;
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
        paintClaimBg(span, bgColor);
        // Selection wrapping hands in the original DOM (so an `<u>`/`<em>`/`<a>`
        // stays inside one highlight instead of splitting it). The tweet path
        // still builds from `seg.text`. Annotation paint flattens children, so
        // it only runs when there are ranges to draw — otherwise a formatting
        // change would become three highlights again on the next paint.
        if (contents?.length) {
            for (const n of contents) span.appendChild(n);
        } else {
            span.textContent = seg.text;
        }
        span.dataset.mfSegStart = String(seg.start ?? 0);
        const paintNow = !contents?.length || annotationsHaveRanges(claim.annotations);
        span.dataset.mfStrike = paintNow
            ? repaintInlineAnnotations(span, seg.text, seg.start ?? 0, claim.annotations, [], resolveTriggerAnnotations(span)?.key)
            : '';

        const isRTL = isRTLLocale(getEffectiveUILocale());
        if (isRTL) span.dir = "rtl";

        const reveal = () => {
            const liveBg = highlightBgColor(claim, false, span);
            span.dataset.hoverBg = highlightBgColor(claim, true, span);
            animateHighlightReveal(span, liveBg);
        };
        if (span.isConnected) reveal();
        else queueMicrotask(() => { if (span.isConnected) reveal(); else requestAnimationFrame(reveal); });

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
            // Flow B: a settled, classified claim with no annotation key carries
            // the "Annotate" affordance instead of its verdict — the badge
            // IS the annotation affordance (spec). Only the idle button is
            // permanent; a pending flight is hover-only, like the
            // classification loading words (the annotateWorking branch at
            // the build site never mints one here). Plain grey chrome like
            // the Fact-Check button; never the verdict badge.
            const needsAnnotate = spanNeedsAnnotateBadge(span);
            const plainLabel = isOnHoldNow || isPipelineClaim;
            const lbl = plainLabel ? t("factCheckButton") : needsAnnotate ? t("annotateButton") : verdictLabel(prob, ver, `${classificationId ?? ''}:${claim.text}`);
            const txtColor = '#ffffff';
            const badge = document.createElement("b");
            badge.className = plainLabel ? "mf-inline-badge" : needsAnnotate ? "mf-inline-badge mf-annotate-badge" : `mf-inline-badge ${VERDICT_BADGE_CLASS}`;
            badge.style.cssText = `display: inline-flex; align-items: center; justify-content: center; vertical-align: middle; position: relative; top: -0.142em; line-height: 1.15; padding: 0.12em 0.52em; border-radius: 999px; font-size: 0.75em; font-weight: 600; white-space: nowrap; margin-left: ${isRTL ? '0' : '0.25em'}; margin-right: ${isRTL ? '0.25em' : '0'}; color: ${txtColor}; background: rgba(0,0,0,0.7); cursor: pointer;`;
            // On hold is a settled state and beats a `refreshing` left over from whatever
            // parked the claim (see the stand-in spinner's note in the update path): a run
            // always states `reclassifyOnHold: false`, so a parked claim never hides one.
            if (!isOnHoldNow && (isRefreshing || (prob === undefined && !isPipelineClaim))) {
                const fcSpinner = document.createElement("span");
                fcSpinner.className = "mf-fc-spinner";
                if (isRTL) {
                    fcSpinner.style.marginRight = "0";
                    fcSpinner.style.marginLeft = "0.27em";
                    badge.appendChild(document.createTextNode(lbl));
                    badge.appendChild(fcSpinner);
                } else {
                    badge.appendChild(fcSpinner);
                    badge.appendChild(document.createTextNode(lbl));
                }
            } else if (needsAnnotate) {
                // A tap repaints synchronously, but a REBUILT span would lose
                // that — the pending set survives rebuilds, so re-derive the
                // spinner here instead of trusting the paint. A Flow A seed
                // outstanding promotes the same way (consumed either way).
                if (annotateSeededKeys.has(`${classificationId ?? ''}:${claim.text}`)) {
                    promoteAnnotateSeed(span);
                }
                paintAnnotateBadgeContent(badge, isAnnotatePending(span), span);
            } else {
                badge.innerHTML = plainLabel
                    ? escapeHtml(lbl)
                    : verdictBadgeHtml(prob, ver, `${classificationId ?? ''}:${claim.text}`);
                if (isRTL) badge.dir = "rtl";
            }
            // A pending "Annotating" badge is hover-only, never permanent
            // (like the classification loading words): marking it would pin
            // a working state with nothing to click. The seed promotes to
            // pending inside the needsAnnotate branch above, so read the
            // final state here, not the caller's `permanent` alone.
            if (permanent && !isAnnotatePending(span)) {
                (span as any)._mfBadgePermanent = badge;
            }
            syncBadgeLoadingClass(badge);
            const currentBg = span.style.getPropertyValue("--mf-hl") || span.style.backgroundColor || (span.dataset.hoverBg ?? undefined);
            return wrapBadgeInCap(badge, currentBg);
        };

        const isInPipeline = withBadge && classificationId ? processingOnHoldIds.has(classificationId) : false;
        // The idle Annotate badge is permanent by spec (visible without
        // hovering); its "Annotating" working state is hover-only like the
        // classification loading words — while it has nothing to click it
        // must not sit there. A live seed/flight (not yet promoted — the
        // factory consumes it in the needsAnnotate branch) counts as
        // working, so read the flight state BEFORE building the badge; the
        // factory additionally refuses to mark a promoted-pending badge.
        const annotateWorking = withBadge && isAnnotateFlight(span);
        const showPermanentBadge = withBadge && (isOnHold || (isInPipeline && isResearching && !claim.refreshing) || (spanNeedsAnnotateBadge(span) && !annotateWorking));

        if (showPermanentBadge) {
            span.appendChild(createInlineBadge(true));
            syncClaimBadgeLayout(span);
        } else if (annotateWorking) {
            // Working state, armed exactly once here. promoteAnnotateSeed
            // only arms state — the paint below is this branch's, so a
            // genuine flight mints hover-only chrome (badge under the
            // resting pointer, which no promotion can replay-hover for;
            // stand-in spinner otherwise, like every other loading state).
            // `!armed` is NOT always a misfire: promote also returns false
            // when the key is already pending (seed/pending overlap, or a
            // rebuild mid-refresh) — still a live flight, so it takes the
            // same hover-or-stand-in paint, never a badge minted straight
            // into the DOM. Only a stale seed with no pending key means no
            // run is coming, and only then does idle chrome return: the
            // permanent button when the affordance gate holds, a
            // refresh/research's stand-in, and nothing for a settled
            // verdict (hover summons its badge; never pinned here).
            // Rebuilds are idempotent: the same live key either lands or
            // times out, whatever the paint.
            const seedKey = `${classificationId ?? ''}:${claim.text}`;
            const armed = annotateSeededKeys.has(seedKey) ? promoteAnnotateSeed(span) : isAnnotatePending(span);
            const flightNow = armed || isAnnotatePending(span);
            if (!flightNow) {
                if (spanNeedsAnnotateBadge(span)) {
                    span.appendChild(createInlineBadge(true));
                    syncClaimBadgeLayout(span);
                } else if (claim.refreshing || isResearching) {
                    span.appendChild(createStandaloneSpinner(isRTL));
                }
            } else if (isPointerOverSpan(span)) {
                span.appendChild(createInlineBadge(false));
                syncClaimBadgeLayout(span);
            } else {
                span.appendChild(createStandaloneSpinner(isRTL));
            }
        } else if (withBadge && (claim.refreshing || isResearching)) {
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

        // A wrap rebuild can mint the stand-in and then an open popover re-attaches
        // a badge that already has a spinner. Never keep both.
        if (span.querySelector(".mf-inline-badge")) {
            span.querySelector(".mf-standalone-spinner")?.remove();
        }

        span.addEventListener("mouseenter", () => {
            if (isTouchInput()) return;
            const siblings = claimHoverSiblings(span);
            const last = siblings[siblings.length - 1] ?? span;
            for (const piece of siblings) {
                if (piece.dataset.hoverBg) paintClaimBg(piece, piece.dataset.hoverBg);
                if (piece !== last && !(piece as any)._mfBadgePermanent) {
                    piece.querySelector(".mf-inline-badge")?.remove();
                    syncClaimBadgeLayout(piece);
                }
            }
            if (last.querySelector(".mf-inline-badge")) {
                // A visible badge already carries the spinner (or is the idle
                // button). A leftover stand-in from a wrap rebuild must not sit
                // next to it.
                last.querySelector(".mf-standalone-spinner")?.remove();
                return;
            }
            // The hover badge carries its own spinner, so drop the stand-in first —
            // otherwise a loading claim would briefly show two.
            last.querySelector(".mf-standalone-spinner")?.remove();
            // A permanent badge for a claim that is still on hold in the live
            // dataset — or still awaiting annotation. The factory decides
            // marking post-promotion (a live seed promotes synchronously
            // inside it): a genuine flight mints the hover-only pending
            // badge unmarked, like the classification loading words (see
            // teardownClaimHover), while a misfired seed (no run coming)
            // is consumed to idle and KEEPS its permanence. A classified
            // claim gets a transient hover-only badge. Re-marking here
            // also heals the marker when a popover close took the element
            // without clearing it.
            // The badge rides the last piece of a multi-span claim (one claim
            // across a block boundary, or leftover formatting splits) so the
            // same highlight never shows three identical verdicts.
            last.appendChild(createInlineBadge(span.dataset.reclassifyOnHold === "true" || spanNeedsAnnotateBadge(span)));
            syncClaimBadgeLayout(last);
        });

        span.addEventListener("mouseleave", (e) => {
            const siblings = claimHoverSiblings(span);
            // Crossing one of the claim's own line gaps is no departure either —
            // measured from the pointer, since that is the one thing that says where
            // between the lines it is. Without this, moving down a highlight to its
            // badge dropped the badge in the gap: the teardown below ran on the way
            // through, and only a crossing quick enough to re-enter and rebuild it
            // before anyone noticed ever worked. The same guard keeps a held badge
            // that re-wrapped off the pointer's line, which would otherwise be torn
            // down on the move its own hover caused. Both guards run before anything
            // is undone — the tint included.
            if (inClaimHoverArea(span, e.clientX, e.clientY)) return;
            // And the verdict word's own hover widening the badge onto the next line
            // is no departure either: the pointer it carried the badge out from under
            // is on the word or the empty slot that arrived, and the teardown must
            // stand down for exactly that — the frame the hold armed in has not yet
            // measured the reveal, so the positional guard above cannot see it.
            if (spanTeardownStandsDown(span, e.clientX, e.clientY)) return;
            if (siblings.some(s => (s as any)._mfPopoverOpen || (s as any)._mfBadgePermanent)) {
                // A permanent badge and an open popover are meant to outlive the pointer.
                // The tint is not: it is the hover state itself, and returning here without
                // repainting left these highlights hot for good.
                restoreClaimTint(span);
                return;
            }
            disarmHoverClaim(span);
            teardownClaimHover(span);
        });
        return [span];
    };
}

/** Build the segment <span> elements used by renderSegmentedTweet. */
export function buildSegmentWrap(segments: TextSegment[], claims: Claim[], batchId: string, urlDisplayMap: Map<string, string> = new Map(), classificationId?: string, hiddenPlain?: Set<number> | null, textLocale?: string): HTMLSpanElement {
    const wrap = document.createElement("span");
    wrap.className = "mf-segment-wrap";
    // While hidden, non-bypassing claims render as ordinary text — plain-text path
    // below, no highlight, no listeners. The strip gate already removed anything
    // that would make bypassed interactivity wrong (buttons, fallbacks).
    if (hiddenPlain && hiddenPlain.size > 0) wrap.dataset.mfHiddenPlain = hiddenPlainSig(hiddenPlain);

    const claimSegmentNodes = makeClaimSegmentNodes(batchId, classificationId, textLocale);
    for (const seg of segments) {
        if (seg.claimIndex === null || hiddenPlain?.has(seg.claimIndex)) {
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
            wrap.append(...claimSegmentNodes(seg, claim, true));
        }
    }

    return wrap;
}

/** The passage text a piece of our own chrome replaced: its text, with the badge and
 *  spinner subtrees taken back off. A badge's verdict word is not part of the passage, and
 *  reading it as if it were would shift every offset after it. */
function passageTextOf(el: Element): string {
    // Flatten an already-rendered span back to passage text for the rebuild. Badges and
    // spinners are chrome, but so is the annotation paint: the strike wrap holds the
    // struck substring in its dataset (and the plain-path single-word variant wraps it
    // in an inner span beside its strike line) while the correction node is not passage
    // text at all — keeping either corrupts the length the rebuild matches segments
    // against, so on an annotation-only rebroadcast the guard below bails and the stale
    // spans stand. mfPlainText knows both shapes already.
    return mfPlainText(el);
}

/** Same block list the selection context walk uses: an inline highlight cannot
 *  straddle one of these, but it CAN (and must) straddle `<u>`/`<em>`/`<a>`. */
const CLAIM_WRAP_BLOCK_SELECTOR =
    'p,li,dd,dt,td,th,caption,figcaption,blockquote,pre,article,section,aside,main,div,h1,h2,h3,h4,h5,h6';

function nearestClaimBlock(node: Node, container: HTMLElement): Element {
    const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    if (!el) return container;
    const block = el.closest(CLAIM_WRAP_BLOCK_SELECTOR);
    // Stay inside the wrap. `closest` on leftover text that extractContents
    // pulled out of its `<h1>`/`<p>` would otherwise walk OUT to the article
    // and treat the headline and the standfirst as one run.
    if (block && container.contains(block) && block !== container) return block;
    return container;
}

/** Not shown to the user — `textContent` still concatenates it, so a CBC
 *  visually-hidden dek (or `aria-hidden` duplicate) used to be sent to the
 *  worker and highlighted as if it were on the page. */
export function isPassageInvisible(el: Element): boolean {
    if (el.classList.contains("mf-inline-badge") || el.classList.contains("mf-standalone-spinner") || el.classList.contains("mf-corr")) return true;
    const tag = el.tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEMPLATE" || tag === "HEAD" || tag === "TITLE") return true;
    if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") return true;
    const cls = el.getAttribute("class") ?? "";
    if (/\b(sr-only|visually-hidden|visuallyhidden|screen-reader-only|screen-reader-text|u-hiddenVisually|offscreen)\b/i.test(cls)) return true;
    try {
        const s = getComputedStyle(el);
        if (s.display === "none" || s.visibility === "hidden" || s.visibility === "collapse") return true;
        if (s.opacity === "0") return true;
        const clipPath = s.clipPath;
        if (clipPath === "inset(50%)" || clipPath === "inset(100%)") return true;
        const clip = (s.clip || "").replace(/\s+/g, "");
        if (clip && clip !== "auto" && /^rect\((0|0px|0%),/.test(clip)) return true;
    } catch { /* not rendered yet */ }
    return false;
}

/** One position-holding unit of a passage: a text node, or a `<br>` occupying the single
 *  character its rendered line break takes up in the passage string.
 *
 *  A break is a unit of the string and not decoration. The capture half reads the same
 *  string this half indexes, so a `<br>` dropped from the model is a newline dropped from
 *  what a post is taken to say: measured on Naver, a two-line comment arrived at the worker
 *  welded into one run of words (`0.5리터 / 가스` read back as `0.5리터가스`), and on bsky
 *  the markup fallback disagreed with the platform's own record whenever a body had a line
 *  break in it — one post, two strings, the collision `post-id-names-one-text` refuses. */
type PassagePiece = { text: Text } | { br: Element };

/** How many characters a piece contributes to the passage string. */
function pieceLength(piece: PassagePiece): number {
    return "br" in piece ? 1 : piece.text.data.length;
}

/** The element a piece is anchored in — the text node's parent, or the break itself. */
function pieceAnchor(piece: PassagePiece): Element | null {
    return "br" in piece ? piece.br : piece.text.parentElement;
}

/** The passage string's units, in order: visible text nodes, with every `<br>` standing for
 *  the newline it renders when `breaks` is set. Badge and other hidden subtrees are skipped,
 *  because their words are not in the worker's string and must not shift later offsets.
 *
 *  `breaks` false yields the shape a plain `textContent` read produces — a break counted as
 *  nothing — which is what an adapter that has not yet been moved onto `passageTextContent`
 *  still classifies. Both shapes exist because the classified text is the thing being located
 *  and it appears verbatim in only one of them; see `renderSegmentsInPlace`. */
function passagePieces(container: HTMLElement, breaks: boolean): PassagePiece[] {
    const pieces: PassagePiece[] = [];
    const walk = (node: Node) => {
        if (node.nodeType === 1) {
            const el = node as Element;
            if (isPassageInvisible(el)) return;
            if (el.tagName === "BR") {
                if (breaks) pieces.push({ br: el });
                return;
            }
            for (const child of Array.from(el.childNodes)) walk(child);
            return;
        }
        if (node.nodeType === 3) pieces.push({ text: node as Text });
    };
    walk(container);
    return pieces;
}

/** The passage text a subtree holds, for reading back a run a paint has just cut out: text
 *  nodes joined, with each `<br>` read as the newline it renders. Unlike the passage model
 *  itself this hides nothing — it answers what the fragment in hand says, not what the
 *  worker was told. */
function passageTextOfFragment(node: Node): string {
    if (node.nodeType === 3) return (node as Text).data;
    if (node.nodeType !== 1) return "";
    const el = node as Element;
    if (el.tagName === "BR") return "\n";
    return Array.from(el.childNodes).map(passageTextOfFragment).join("");
}

/** Passage text nodes inside a selection wrap, chrome and hidden subtrees
 *  excluded. Badge/spinner words are not in the worker's string, so they
 *  must not shift later offsets. */
function passageTextNodes(container: HTMLElement): Text[] {
    const nodes: Text[] = [];
    for (const piece of passagePieces(container, true)) {
        if ("text" in piece) nodes.push(piece.text);
    }
    return nodes;
}

/** The string `wrapClaimSegmentsInPlace` indexes — visible passage only, with every `<br>`
 *  read as the newline it renders. The adapters read a body through this same function, which
 *  is what makes the classified text and the offsets into it one string rather than two.
 *
 *  `breaks` false drops the breaks and yields what a plain `textContent` read produces. That
 *  shape exists only for a container already classified by an adapter that still reads its body
 *  that way; `renderSegmentsInPlace` picks whichever shape actually holds the classified text. */
export function passageTextContent(container: HTMLElement, breaks = true): string {
    return passagePieces(container, breaks).map((piece) => ("br" in piece ? "\n" : piece.text.data)).join("");
}

function locatePassage(container: HTMLElement, offset: number, breaks: boolean): { index: number; piece: PassagePiece; offset: number } | null {
    const pieces = passagePieces(container, breaks);
    let remaining = offset;
    for (let i = 0; i < pieces.length; i++) {
        const len = pieceLength(pieces[i]);
        if (remaining < len) return { index: i, piece: pieces[i], offset: remaining };
        remaining -= len;
    }
    if (remaining === 0 && pieces.length > 0) {
        const last = pieces.length - 1;
        return { index: last, piece: pieces[last], offset: pieceLength(pieces[last]) };
    }
    return null;
}

/** Wrap the claimed stretches of an ALREADY-SEGMENTED passage in place, leaving the
 *  passage's own DOM — its elements, its fonts — exactly as it was.
 *
 *  `buildSegmentWrap` cannot be used for this: it builds a fresh flat `<span>` from the
 *  segment texts, which is right for a tweet body (one inline run) and wrong for a
 *  selection that spans block elements — the `<h1>` and `<p>` inside the selection wrap
 *  are replaced by flat text, so the headline re-renders in the paragraph's font, on the
 *  paragraph's line, and its highlight is anchored in the paragraph.
 *
 *  So the same claim span is built here (`makeClaimSegmentNodes`, byte-for-byte the
 *  tweet path's) but it is put back exactly where the text it covers already is. A
 *  claim that stays inside one block is ONE span, even when an `<u>`/`<em>`/`<a>`
 *  splits it into several text nodes — wrapping each text node used to mint a
 *  badge per fragment. A claim that crosses a block boundary still becomes one
 *  span per block, and the single badge rides the last one: an inline element
 *  cannot straddle an `<h1>`/`<p>` boundary, which is the whole reason this exists.
 *
 *  `container.textContent` is what `segments` index (the caller splits the same string),
 *  so each claimed range is re-resolved against the live passage after the previous
 *  wrap, chrome excluded. A snapshot of Text nodes cannot be used: wrapping claim 1
 *  with extractContents detaches later snapshot entries, and claim 2 would never wrap
 *  while this still returned true. Content already wrapped by a previous call is
 *  folded back to plain text first, which makes this idempotent: a second
 *  classification re-wraps the passage rather than wrapping it twice.
 *
 *  Returns false when the container's text no longer matches the segments (the page
 *  re-rendered under the run — extra text the segments never indexed, or text gone).
 *  The fold-back above already ran by then, so a false return leaves the passage as
 *  BARE TEXT with no highlights at all; the caller must fall back (the selection flow
 *  lists the claims) rather than leave it that way. True when the wrap holds spans. */
export function wrapClaimSegmentsInPlace(container: HTMLElement, segments: TextSegment[], claims: Claim[], batchId: string, classificationId?: string, textLocale?: string, breaks = true): boolean {
    const claimSegmentNodes = makeClaimSegmentNodes(batchId, classificationId, textLocale);
    // Recorded as the cuts happen, so the page's own text can be put back: a paint over the
    // page's text cuts its nodes, and the page hands a post's next text to the node it made.
    // Only an in-place wrap holds the page's own nodes — a selection wrap holds a copy of
    // them, and the page's text is not inside it to be blocked.
    const painted = container.dataset.mfInPlace === "1";
    const previous = painted ? inPlacePaintOf(container) : null;
    const paint: InPlacePaint = { watch: [], cut: [], own: [], moved: [] };
    if (painted) delete (container as PaintHost)._mfPaint;

    for (const span of Array.from(container.querySelectorAll(".mf-segment-claim"))) {
        // Keep page formatting (`<u>`/`<em>`/`<a>`) across a streaming rebuild.
        // Flattening to a text node would split the next wrap on those nodes
        // again. Annotation paint already replaced those children, so only
        // then fall back to the passage string. The flattened node is still OURS —
        // text recovered from a span, not the page's — so it carries the mark that
        // lets a later teardown drop it rather than keep the language it replaced.
        if (span.querySelector(".mf-strike, .mf-corr")) {
            const flat = document.createTextNode(passageTextOf(span));
            markMinted(flat);
            span.replaceWith(flat);
            continue;
        }
        for (const chrome of Array.from(span.querySelectorAll(".mf-inline-badge, .mf-standalone-spinner"))) {
            chrome.remove();
        }
        if (span.childNodes.length === 0) {
            const flat = document.createTextNode(passageTextOf(span));
            markMinted(flat);
            span.replaceWith(flat);
        } else {
            span.replaceWith(...Array.from(span.childNodes));
        }
    }

    // Offsets are into the passage string (same string `segments` index).
    // Do NOT walk a snapshot of Text nodes: wrapping claim 1 with extractContents
    // across an `<h1>`/`<p>` detaches later snapshot entries, so claim 2 never
    // wraps while this still returns true. Re-resolve each offset from the live
    // DOM instead, and skip badge/spinner text so those words cannot shift the
    // remaining ranges.
    const passageLen = passageTextContent(container, breaks).length;
    if (passageLen !== segments.reduce((n, s) => n + s.text.length, 0)) {
        // The fold-back above is lossless, so the previous record still describes the page's
        // own nodes — it is what can put their text back. Keep it.
        if (previous) (container as PaintHost)._mfPaint = previous;
        return false;
    }

    let flat = 0;
    for (const seg of segments) {
        const segStart = flat;
        flat += seg.text.length;
        // `flat` counts the container's own characters, `seg.start` the classified text's.
        // They part company exactly where the passage carries something the classification
        // does not — the indentation `renderSegmentsInPlace` pads a trimmed body with — and
        // the offset stamped on the span (mfSegStart) has to be the classified one, because
        // that is the string the claim's annotation ranges address. Stamping the passage
        // offset instead shifted every painted range by the padding's width: a strike landed
        // that many characters to the left of the words it named, and the correction with it.
        const clsDelta = seg.start === undefined ? 0 : seg.start - segStart;
        const claimIdx = seg.claimIndex;
        const claim = claimIdx === null ? undefined : claims[claimIdx];
        if (!claim) continue;

        let left = seg.text.length;
        let pieceStart = segStart;
        while (left > 0) {
            const start = locatePassage(container, pieceStart, breaks);
            if (!start) break;
            const block = nearestClaimBlock(pieceAnchor(start.piece) ?? container, container);
            const pieces = passagePieces(container, breaks);
            // The index comes back from the locate, never from `indexOf`: a piece is a
            // wrapper minted per call, so the entry `locatePassage` matched is a different
            // object from the equal-looking one in this array and `indexOf` would answer -1
            // for every claim — the wrap built, the gate passed, and not one span painted.
            const startIndex = start.index;

            let endIndex = startIndex;
            let endOffset = start.offset;
            let pieceTake = 0;
            let i = startIndex;
            let o = start.offset;
            while (pieceTake < left && i < pieces.length) {
                const piece = pieces[i];
                const anchor = pieceAnchor(piece);
                if (!anchor || !anchor.isConnected) {
                    i++;
                    o = 0;
                    continue;
                }
                if ("text" in piece && piece.text.data.length === 0) {
                    i++;
                    o = 0;
                    continue;
                }
                if (anchor.closest(".mf-segment-claim")) {
                    i++;
                    o = 0;
                    continue;
                }
                if (nearestClaimBlock(anchor, container) !== block && pieceTake > 0) break;
                const a = pieceLength(piece) - o;
                if (a <= 0) { i++; o = 0; continue; }
                const t = Math.min(a, left - pieceTake);
                pieceTake += t;
                endIndex = i;
                endOffset = o + t;
                if (t >= a) { i++; o = 0; }
                else o += t;
            }
            if (pieceTake <= 0) break;

            const withBadge = left - pieceTake === 0;
            const startPiece = pieces[startIndex];
            const endPiece = pieces[endIndex];
            if (startIndex === endIndex && "text" in startPiece) {
                const host = startPiece.text;
                const before = host.data;
                const { run, after } = isolateTextRun(host, start.offset, pieceTake);
                const pieceSeg: TextSegment = { text: run.data, claimIndex: claimIdx, start: pieceStart + clsDelta };
                const [span] = claimSegmentNodes(pieceSeg, claim, withBadge);
                run.replaceWith(span);
                if (painted) {
                    // The span holds text this paint minted while `host` — the page's own node —
                    // keeps the run's prefix, so undo drops the span and puts the whole text back
                    // into the page's node. The tail is minted too, and goes by its mark.
                    paint.cut.push({ node: host, before, left: host.data });
                    paint.own.push(span as HTMLElement);
                    markMintedSubtree(span as Element);
                    if (after) markMinted(after);
                }
            } else {
                // A run that reaches a `<br>` — or starts on one — is cut out by RANGE rather
                // than by `isolateTextRun`, because a break is an element and cannot be a text
                // node's slice. `extractContents` moves the break itself into the claim, so the
                // wrapped run still renders the line break it claims; `setStartBefore` and
                // `setEndAfter` are what take it in, a boundary AT the break excluding it.
                const range = document.createRange();
                if ("text" in startPiece) {
                    const first = start.offset > 0 ? startPiece.text.splitText(start.offset) : startPiece.text;
                    range.setStart(first, 0);
                } else {
                    range.setStartBefore(startPiece.br);
                }
                if ("text" in endPiece) {
                    if (endOffset < endPiece.text.data.length) endPiece.text.splitText(endOffset);
                    range.setEnd(endPiece.text, endPiece.text.data.length);
                } else {
                    range.setEndAfter(endPiece.br);
                }
                const fragment = range.extractContents();
                const contents = Array.from(fragment.childNodes);
                const pieceText = contents.map(passageTextOfFragment).join("");
                const pieceSeg: TextSegment = {
                    text: pieceText || seg.text.slice(pieceStart - segStart, pieceStart - segStart + pieceTake),
                    claimIndex: claimIdx,
                    start: pieceStart + clsDelta,
                };
                const [span] = claimSegmentNodes(pieceSeg, claim, withBadge, contents);
                range.insertNode(span);
                if (painted) paint.moved.push(span as HTMLElement);
            }
            left -= pieceTake;
            pieceStart += pieceTake;
        }
    }
    for (const span of Array.from(container.querySelectorAll(".mf-segment-claim"))) {
        const el = span as HTMLElement;
        pinClaimLayout(el);
        const badge = el.querySelector(".mf-inline-badge") as HTMLElement | null;
        if (badge) pinBadgeLayout(badge);
        for (const strike of Array.from(el.querySelectorAll(".mf-strike"))) {
            const w = strike as HTMLElement;
            const inner = w.querySelector(":scope > span:not(.mf-strike-line)") as HTMLElement | null;
            const line = w.querySelector(".mf-strike-line") as HTMLElement | null;
            pinStrikeLayout(w, inner, line);
        }
    }
    if (painted) {
        // The passage as it now stands. Taken after the layout pass, which is the last thing to
        // touch these nodes: the record compares against exactly what ends up on the page.
        paint.watch = passageTextNodes(container).map((node) => ({ node, left: node.data }));
        (container as PaintHost)._mfPaint = paint;
    }
    return true;
}

/** Cut the characters `[offset, offset + length)` out of `node` as a text node of their
 *  own, returning it along with the node holding whatever followed it (null when the run
 *  reached the end of the node). What precedes the run stays in `node`. `Text.splitText`
 *  does much of this in one call, but not all of it — the cursor needs the node after the
 *  run — and one shape is easier to be sure of than two. */
function isolateTextRun(node: Text, offset: number, length: number): { run: Text; after: Text | null } {
    const data = node.data;
    const parent = node.parentNode!;
    const anchor = node.nextSibling;
    const run = document.createTextNode(data.slice(offset, offset + length));
    const rest = data.slice(offset + length);
    node.data = data.slice(0, offset);
    parent.insertBefore(run, anchor);
    markMinted(run);
    let after: Text | null = null;
    if (rest) {
        after = document.createTextNode(rest);
        parent.insertBefore(after, run.nextSibling);
        markMinted(after);
    }
    // `node` is NEVER removed, emptied or not. It is the page's own text node object, and a
    // renderer hands a post's next text to THE node it made: Substack's translate toggle writes
    // the new language into the very node the previous language came out of (measured — same
    // node, new `data`, still connected, its `lang` flipped with it). A node we detached takes
    // that write out of the document, so the toggle's own control changes state while the words
    // on screen do not. Empty, the node is inert: offsets skip it, and `undoInPlacePaint` puts
    // its text back.
    return { run, after };
}

/** Promote one already-injected tweet from the Phase 1 fallback box to Phase 2 inline
 *  highlights, once segments are available. Bails out quietly when there is nothing to
 *  upgrade or the tweet's text element can no longer be found in X's DOM. */
/** The parts of `segments` that fall inside one region of a post's text, re-based onto
 *  that region.
 *
 *  Segments tile the whole classified text, so the ones covering a block boundary spill
 *  into the block on either side; each piece is cut to the region and keeps its claim
 *  index, which is how a claim that runs across the boundary still highlights on both
 *  sides. A segment's `start` — the offset annotations index against — moves with the
 *  cut rather than with the region, so it stays an offset into the text the claim was
 *  matched in. */
function sliceSegmentsToRegion(segments: TextSegment[], start: number, end: number): TextSegment[] {
    const out: TextSegment[] = [];
    let at = 0;
    for (const seg of segments) {
        const segStart = at;
        const segEnd = at + seg.text.length;
        at = segEnd;
        const from = Math.max(start, segStart);
        const to = Math.min(end, segEnd);
        if (to <= from) continue;
        const text = seg.text.slice(from - segStart, to - segStart);
        if (!text) continue;
        out.push({
            text,
            claimIndex: seg.claimIndex,
            ...(seg.start === undefined ? {} : { start: seg.start + (from - segStart) }),
        });
    }
    return out;
}

function upgradeToSegments(article: Element, classification: Classification | QuotedClassification, batchId: string, isQuoted: boolean = false, hiddenPlain?: Set<number> | null, textLocaleOverride?: string, targetEl?: Element | null, segmentsOverride?: TextSegment[]) {
    const segments = segmentsOverride ?? classification.segments;
    const claims = classification.claims;
    if (!segments || segments.length === 0 || !claims || claims.length === 0) return;
    // Locale stamped onto spans so the annotation popover knows which key's
    // ranges index the span text (same rule as highlight breakup). Main reads
    // its own field; quoted borrows the caller's override.
    const stampedLocale = textLocaleOverride
        ?? ('textLocale' in classification ? classification.textLocale : undefined);

    // The hidden-bypass verdict can flip mid-session (settings drag, late verdicts).
    // The in-place path below can neither build a promoted claim's spans nor strip
    // a demoted highlight's — `hiddenPlain` only counts non-bypassing claims, so a
    // changed signature throws the wrap away and rebuilds from scratch. Quoted
    // passes compute their own set at their call site, never the parent's.
    const wrapPlain = hiddenPlain === undefined ? null : hiddenPlain;
    // `targetEl` is how a multi-region post paints its second block: the caller has
    // already cut `segmentsOverride` down to that block, so the element is handed in
    // rather than looked up. Everything below is per-element, which is what makes one
    // post with two wraps work — each region reconciles against its own.
    const tweetTextEl = targetEl ?? findTweetTextElement(article, isQuoted, classification.id);
    if (!tweetTextEl) {
        console.log(`[misinfo] upgradeToSegments: no tweetTextEl found for ${classification.id} (isQuoted=${isQuoted})`);
        return;
    }

    const existingWrap = tweetTextEl.querySelector<HTMLElement>(".mf-segment-wrap");
    // `?? ''`: a wrap built with no bypass set carries no marker, and
    // hiddenPlainSig(null) is '' — without the fallback every ordinary tweet
    // would look stale and rebuild its wrap on every pass.
    const stalePlain = !!existingWrap
        && ((existingWrap as HTMLElement).dataset.mfHiddenPlain ?? '') !== hiddenPlainSig(wrapPlain);
    if (stalePlain) {
        // `existingClaimSpans.length === 0 && newHasClaims` below also re-renders,
        // but only when the wrap is FULLY plain; a bypass flip usually leaves some
        // claim spans behind, which would take the in-place path and render wrong.
        console.log(`[misinfo] upgradeToSegments: hidden-bypass set changed for ${classification.id}, re-rendering`);
        discardSegmentWrap(existingWrap);
    }
    if (existingWrap && !stalePlain) {
        const existingClaimSpans = existingWrap.querySelectorAll(".mf-segment-claim");
        const newHasClaims = segments.some(s => s.claimIndex !== null && !wrapPlain?.has(s.claimIndex));

        if (existingClaimSpans.length === 0 && newHasClaims) {
            console.log(`[misinfo] upgradeToSegments: existing wrap is plain text but new segments have claims for ${classification.id}, re-rendering`);
            discardSegmentWrap(existingWrap);
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
                const el = span as HTMLElement;
                const bgColor = highlightBgColor(claim, false, el);
                const hoverBgColor = highlightBgColor(claim, true, el);
                el.dataset.mfCid = classification.id;
                const oldRewritten = el.dataset.claimRewritten;
                const oldVerdict = el.dataset.verdict;
                const oldProbability = el.dataset.probability;
                const oldVeracity = el.dataset.veracity;
                const oldRefreshing = el.dataset.refreshing;
                // Read before the stamps below: whether the claim was parked decides the
                // badge's face (Fact-Check, no wheel) as much as its verdict does, so a
                // park/unpark has to count as a change or a wheel painted before the park
                // would stay on a claim that has nothing running.
                const oldOnHold = el.dataset.reclassifyOnHold === "true" ? "true" : "";
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
                // The badge's own inputs — deliberately NOT the reasoning text. A streamed
                // reasoning chunk changes nothing this block or the hover replay below
                // paints, and counting it as a change rebuilt the badge and replayed the
                // hover once per chunk: with the pointer resting on a streaming claim that
                // re-fires the claim's own mouseenter, repainting the hover tint and
                // re-summoning its badge over and over for as long as the stream ran. That
                // is the flicker, and the tint it kept re-painting is what stayed hot on the
                // way out. The reasoning still lands: it is stamped into the dataset below,
                // and an open popover re-reads it on every update.
                const changed =
                    oldVerdict !== label ||
                    oldProbability !== String(claim.confidence ?? "") ||
                    oldVeracity !== String(claim.veracity ?? "") ||
                    oldRefreshing !== (isRefreshing ? "true" : "") ||
                    oldOnHold !== (claim.reclassifyOnHold ? "true" : "") ||
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
                // Annotation-only broadcasts land here (no segment re-derivation — ranges
                // don't move text). Deliberately outside `changed`: annotations repaint
                // inline below, never the badge.
                el.dataset.annotations = JSON.stringify(claim.annotations ?? {});
                // Stamps the same value the rebuild path stamps below, so an
                // annotation-only update never desyncs the locale from the ranges.
                if (stampedLocale) el.dataset.textLocale = stampedLocale;
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
                    // Never strip a wanted idle Annotate button here — the dataset
                    // was re-stamped above, so read the same live predicate the
                    // badge factory uses. (The reconcile block below heals
                    // anything else.) A pending flight is hover-only, so a stale
                    // permanent marker for one IS stripped here.
                    if ((el as any)._mfBadgePermanent && !spanWantsIdleAnnotate(el)) {
                        delete (el as any)._mfBadgePermanent;
                        el.querySelector(".mf-inline-badge")?.remove();
                    }
                }
                // When a pipeline claim transitions from researching to classified,
                // clear the permanent badge marker and remove the stale badge element —
                // UNLESS the claim now wants the idle Annotate button (a classified
                // claim with no annotation key and no flight), which replaces the
                // Fact-Check badge in place. A Flow A seed outstanding here means
                // the silent post-research run is in flight — promote it to the
                // hover-only "Annotating" state rather than the idle affordance
                // (consumed either way; a misfire falls back to idle).
                if (!isResearching && !claim.reclassifyOnHold && (el as any)._mfBadgePermanent) {
                    if (spanWantsIdleAnnotate(el)) {
                        // Untouched: the idle button keeps its marker and element.
                    } else if (spanNeedsAnnotateBadge(el)) {
                        // A flight is outstanding — the stale permanent marker
                        // belongs to the idle button this span no longer shows.
                        // promote only arms state (marker drop included); the
                        // paint below owns the chrome. A misfire consumes to
                        // idle — nothing to strip, keep the button's element
                        // and marker exactly as they are.
                        if (promoteAnnotateSeed(el)) {
                            el.querySelector(".mf-inline-badge")?.remove();
                            syncClaimBadgeLayout(el);
                            removeAnnotateStandin(el);
                            ensureAnnotateStandin(el);
                            // No explicit resync here: promote drops the idle
                            // button's marker, so the generic marker-flip replay
                            // at the end of this reconcile summons the pending
                            // badge when the pointer is resting here.
                        }
                    } else {
                        delete (el as any)._mfBadgePermanent;
                        el.querySelector(".mf-inline-badge")?.remove();
                        syncClaimBadgeLayout(el);
                    }
                }
                el.style.opacity = "";

                const targetBg = bgColor;
                const prevTargetBg = (el as any)._mfTargetBg;
                if (prevTargetBg === undefined) {
                    // Not yet initialized (defensive) — set directly and record it.
                    paintClaimBg(el, targetBg);
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
                    const badge = document.createElement("b");
                    badge.className = "mf-inline-badge";
                    badge.style.cssText = `display: inline-flex; align-items: center; justify-content: center; vertical-align: middle; position: relative; top: -0.142em; line-height: 1.15; padding: 0.12em 0.52em; border-radius: 999px; font-size: 0.75em; font-weight: 600; white-space: nowrap; margin-left: ${isRTLEl ? '0' : '0.25em'}; margin-right: ${isRTLEl ? '0.25em' : '0'}; color: #ffffff; background: rgba(0,0,0,0.7); cursor: pointer;`;
                    badge.textContent = t("factCheckButton");
                    const currentBg = el.style.getPropertyValue("--mf-hl") || el.style.backgroundColor;
                    el.appendChild(wrapBadgeInCap(badge, currentBg));
                    pinBadgeLayout(badge);
                    syncClaimBadgeLayout(el);
                    (el as any)._mfBadgePermanent = badge;
                }

                // Flow B reconcile: an annotation-only broadcast (no verdict movement)
                // re-stamps the dataset above. When the tapped run's key lands, clear
                // pending and swap the Annotate badge for the verdict badge; when a
                // claim first becomes eligible (e.g. classified by refresh), arm it.
                // A Flow A seed outstanding promotes to "Annotating" the same way.
                // The idle button is permanent (spec); a pending flight is
                // hover-only like the classification loading words — hover shows
                // the badge, a stand-in spinner holds it when idle. Never touch
                // a hover badge's spinner state — the tap's timer owns that.
                {
                    const needsAnnotateNow = spanNeedsAnnotateBadge(el);
                    if (!needsAnnotateNow) {
                        annotatePendingClaims.delete(`${classification.id}:${claim.text}`);
                        clearAnnotateSeedForClaim(classification.id, claim.text);
                        clearAnnotateTimeout(el);
                        // The key landed: swap the annotate badge (idle button
                        // or hover-only pending) for the verdict badge in place,
                        // like any verdict movement — don't just remove it,
                        // which would strand a hovering pointer with no badge.
                        // (`changed` below won't repaint it: an annotation-only
                        // broadcast moves no verdict/reasoning/refreshing.)
                        const landed = el.querySelector(".mf-inline-badge.mf-annotate-badge") as HTMLElement | null;
                        if (landed) {
                            if ((el as any)._mfBadgePermanent) delete (el as any)._mfBadgePermanent;
                            const landedPlain = claim.reclassifyOnHold || isPipelineResearching;
                            const landedLabel = landedPlain ? t("factCheckButton") : verdictLabel(claim.confidence, claim.veracity, `${classification.id}:${claim.text}`);
                            landed.classList.remove("mf-annotate-badge");
                            landed.classList.toggle(VERDICT_BADGE_CLASS, !landedPlain);
                            landed.style.color = '#ffffff';
                            landed.style.marginLeft = isRTLEl ? '0' : '0.27em';
                            landed.style.marginRight = isRTLEl ? '0.27em' : '0';
                            landed.innerHTML = '';
                            // On hold wins over a stale `refreshing` here too — see the stand-in
                            // spinner's note in the in-place update path above.
                            if (!claim.reclassifyOnHold && (claim.refreshing || (claim.confidence === undefined && !isPipelineResearching))) {
                                const landedSpinner = document.createElement("span");
                                landedSpinner.className = "mf-fc-spinner";
                                if (isRTLEl) {
                                    landedSpinner.style.marginRight = "0";
                                    landedSpinner.style.marginLeft = "0.27em";
                                    landed.appendChild(document.createTextNode(landedLabel));
                                    landed.appendChild(landedSpinner);
                                } else {
                                    landed.appendChild(landedSpinner);
                                    landed.appendChild(document.createTextNode(landedLabel));
                                }
                            } else {
                                landed.innerHTML = landedPlain
                                    ? escapeHtml(landedLabel)
                                    : verdictBadgeHtml(claim.confidence, claim.veracity, `${classification.id}:${claim.text}`);
                                if (isRTLEl) landed.dir = "rtl";
                            }
                            syncBadgeLoadingClass(landed);
                        }
                    } else {
                        promoteAnnotateSeed(el);
                    }
                    const pendingNow = isAnnotatePending(el);
                    const wantsBadge = claim.reclassifyOnHold || isPipelineResearching || (needsAnnotateNow && !pendingNow);
                    const current = el.querySelector(".mf-inline-badge");
                    if (wantsBadge && !current) {
                        const nb = document.createElement("b");
                        nb.className = "mf-inline-badge";
                        nb.style.cssText = `display: inline-flex; align-items: center; line-height: 1.15; padding: 0.12em 0.55em; border-radius: 999px; font-size: 0.75em; font-weight: 600; white-space: nowrap; margin-left: ${isRTLEl ? '0' : '0.27em'}; margin-right: ${isRTLEl ? '0.27em' : '0'}; color: #ffffff; background: rgba(0,0,0,0.7); cursor: pointer;`;
                        if (needsAnnotateNow && !claim.reclassifyOnHold && !isPipelineResearching) {
                            paintAnnotateBadgeContent(nb, false);
                        } else {
                            nb.textContent = t("factCheckButton");
                            pinBadgeLayout(nb);
                        }
                        const currentBg = el.style.getPropertyValue("--mf-hl") || el.style.backgroundColor;
                        el.appendChild(wrapBadgeInCap(nb, currentBg));
                        syncClaimBadgeLayout(el);
                        // Only the idle button owns the permanent marker; the
                        // pending branch can't reach here (excluded from
                        // wantsBadge), so this is always the idle state.
                        (el as any)._mfBadgePermanent = nb;
                    } else if (current && !wantsBadge && pendingNow) {
                        // A flight is live (the key has NOT landed — that
                        // branch above already swapped the badge to the
                        // verdict in place, and pending is clear there): the
                        // idle button or a stale verdict badge in hand has no
                        // place. Drop the marker and the element, and stand in
                        // a spinner when the pointer isn't here to summon the
                        // hover badge. A pending badge element in hand is the
                        // HOVER's — the reconcile runs without a hover change,
                        // so the pointer may be resting here with no fresh
                        // mouseenter coming: keep that element and repaint it
                        // as the working state. (`pendingNow` re-checks make
                        // the key-landed case unreachable — belt and braces
                        // against a swap the block above just performed.)
                        if ((el as any)._mfBadgePermanent) delete (el as any)._mfBadgePermanent;
                        if (current.classList.contains("mf-annotate-badge") && isPointerOverSpan(el)) {
                            paintAnnotateBadgeContent(current as HTMLElement, true, el);
                        } else {
                            current.remove();
                            syncClaimBadgeLayout(el);
                            ensureAnnotateStandin(el);
                            // Nudge an open popover clear of the shrunk trigger —
                            // the idle button's box is gone, same geometry the
                            // badge reveal's settle already handles.
                            shiftPopoverBelowBadge(el);
                        }
                    }
                }

                // Keep the stand-in spinner in sync on the IN-PLACE update path (this runs
                // without a full re-render, so it is what makes the spinner appear when a
                // reclassify starts and vanish the moment the result lands). It is only ever
                // shown when no badge is present, since the badge carries its own spinner.
                // A live annotate flight counts as loading: its hover-only badge is
                // gone with the hover, and the stand-in holds the state instead.
                {
                    // On hold is a SETTLED state: the claim is parked for the reader to start,
                    // and the dataset can still be carrying a `refreshing` from whatever
                    // parked it. A sole claim is parked the moment its automatic run starts
                    // (`autoClassifySoleClaim`), and if that run's result never lands the flag
                    // never clears — a wheel with nothing behind it, for the life of the page.
                    // Every genuine run states `reclassifyOnHold: false` (that is exactly what
                    // separates a running claim from a parked one), so on hold wins here and no
                    // live run can be hidden by it.
                    const onHoldNow = el.dataset.reclassifyOnHold === "true";
                    const loadingNow = (!onHoldNow && (el.dataset.refreshing === "true" || isResearching))
                        || isAnnotatePending(el);
                    const hasBadge = !!el.querySelector(".mf-inline-badge");
                    const standalone = el.querySelector(".mf-standalone-spinner");
                    if (loadingNow && !hasBadge && !standalone) {
                        el.appendChild(createStandaloneSpinner(isRTLEl));
                        syncClaimBadgeLayout(el);
                    } else if ((!loadingNow || hasBadge) && standalone) {
                        standalone.remove();
                        syncClaimBadgeLayout(el);
                    }
                }

                // Inline annotation repaint (range keys, spec §strikethroughs): an
                // annotation-only broadcast re-stamped the dataset above; repaint
                // (idempotent strip-first) and, when the painted signature moved,
                // nudge an open popover clear of the grown trigger (same move-down
                // logic as the badge reveal's settle). Deliberately outside
                // `changed`: annotations never move text, so they repaint without
                // rebuilding the wrap. `mfPlainText` recovers the plain segment
                // text from the CURRENT span (paint-aware: overlay datasets count
                // as their original substring, corrections/badges/spinners don't
                // count). The badge and stand-in spinner are kept back across the
                // text rebuild, so the paint never eats the affordance; on an
                // annotated-clean claim this restores the pristine highlight.
                {
                    const kept: HTMLElement[] = [];
                    const badgeNow = el.querySelector(".mf-inline-badge");
                    if (badgeNow instanceof HTMLElement) { badgeNow.remove(); kept.push(badgeNow); }
                    const spinNow = el.querySelector(".mf-standalone-spinner");
                    if (spinNow instanceof HTMLElement) { spinNow.remove(); kept.push(spinNow); }
                    const segStart = parseInt(el.dataset.mfSegStart ?? "", 10);
                    const plain = mfPlainText(el);
                    // Same dict choice as the build path: the dataset was
                    // re-stamped above, so resolve off it live.
                    const sig = repaintInlineAnnotations(el, plain, isNaN(segStart) ? 0 : segStart, claim.annotations, kept, resolveTriggerAnnotations(el)?.key);
                    const prev = el.dataset.mfStrike ?? '';
                    el.dataset.mfStrike = sig;
                    if (sig !== prev) shiftPopoverBelowBadge(el);
                }


                if (changed) {
                    updated++;
                    const badge = el.querySelector(".mf-inline-badge");
                    if (badge) {
                        const isOnHold = el.dataset.reclassifyOnHold === "true";
                        const isRefreshingNow = el.dataset.refreshing === "true";
                        const pipelineResearching = inPipeline && isResearching && !isOnHold && !claim.refreshing;
                        // Flow B: a settled classified claim with no annotation key keeps
                        // its Annotate affordance — never a verdict badge. The idle
                        // button is permanent (spec); a pending flight is
                        // hover-only like the classification loading words (the
                        // reconcile block above already healed missing/stale
                        // ones); this block only repaints what `changed`
                        // actually moved.
                        const needsAnnotateHere = !isOnHold && !pipelineResearching && !isRefreshingNow && spanNeedsAnnotateBadge(el);
                        // A Flow A seed outstanding promotes the same way
                        // (consumed either way) — promote only arms state
                        // (marker drop included); this block owns the badge
                        // element's repaint. A badge in hand here is the
                        // HOVER's, not the button's: the flight start dropped
                        // the button's marker and element (or the span was
                        // just rebuilt, equally unmarked), so repainting it
                        // as the working state strands no permanence.
                        if (annotateSeededKeys.has(`${classification.id}:${claim.text}`)) {
                            promoteAnnotateSeed(el);
                        }
                        if (needsAnnotateHere && !isAnnotatePending(el)) {
                            paintAnnotateBadgeContent(badge as HTMLElement, false);
                        } else if (needsAnnotateHere) {
                            paintAnnotateBadgeContent(badge as HTMLElement, true, el);
                        } else {
                            const plainLabel = isOnHold || pipelineResearching;
                            const newLabel = plainLabel ? t("factCheckButton") : verdictLabel(claim.confidence, claim.veracity, `${classification.id}:${claim.text}`);
                            const newColor = '#ffffff';
                            (badge as HTMLElement).style.color = newColor;
                            (badge as HTMLElement).style.marginLeft = isRTLEl ? '0' : '0.27em';
                            (badge as HTMLElement).style.marginRight = isRTLEl ? '0.27em' : '0';
                            badge.innerHTML = '';
                            badge.classList.remove("mf-annotate-badge");
                            badge.classList.toggle(VERDICT_BADGE_CLASS, !plainLabel);
                            if (!isOnHold && (isRefreshingNow || (claim.confidence === undefined && !pipelineResearching))) {
                                const fcSpinner = document.createElement("span");
                                fcSpinner.className = "mf-fc-spinner";
                                if (isRTLEl) {
                                    fcSpinner.style.marginRight = "0";
                                    fcSpinner.style.marginLeft = "0.27em";
                                    badge.appendChild(document.createTextNode(newLabel));
                                    badge.appendChild(fcSpinner);
                                } else {
                                    badge.appendChild(fcSpinner);
                                    badge.appendChild(document.createTextNode(newLabel));
                                }
                            } else {
                                badge.innerHTML = plainLabel
                                    ? escapeHtml(newLabel)
                                    : verdictBadgeHtml(claim.confidence, claim.veracity, `${classification.id}:${claim.text}`);
                                if (isRTLEl) (badge as HTMLElement).dir = "rtl";
                            }
                            syncBadgeLoadingClass(badge as HTMLElement);
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

    // Hover state does not survive a full rebuild: unlike the in-place update path above,
    // these spans are new, so the old span's real mouseenter state dies with the removed
    // node. The pointer resting over this tweet's text right when a rebuild fires — most
    // likely because the host page's own re-render replaced our injected markup out from
    // under us — is what the resync below exists for, and it has to land after the fresh
    // spans' own deferred reveal to stick (see restoreHoverAfterClaimRebuild).
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
    // mfPlainText, not textContent: after the first paint our own correction nodes
    // live inside the wrap, and comparing segment text against paint would
    // self-confirm on every later re-derive (same class of bug findXOwnedTweetText
    // guards against — its parked originals are X's nodes and need no filter).
    const domTextNow = mfPlainText(tweetTextEl);
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
    // Falls back to stamping nothing — the popover then prefers the UI-locale
    // key, same as before.
    // A claim is about to be shown inside this body, so the reader is owed the whole of it:
    // a host that clamps the body with CSS would otherwise leave the marks — and the claim
    // itself — somewhere inside a few lines and an ellipsis. Fires only when there is
    // something to paint, which is the same condition X's rebuild amounts to.
    if (segments.some(s => s.claimIndex !== null)) unclipPostBody(tweetTextEl);
    if (platformHighlightsInPlace()) {
        renderSegmentsInPlace(tweetTextEl, segments, claims, batchId, classification.id, wrapPlain, stampedLocale);
    } else {
        renderSegmentedTweet(tweetTextEl, segments, claims, batchId, classification.id, wrapPlain, stampedLocale);
    }

    // If the pointer was already resting over this tweet (see the note above), the
    // just-destroyed old span's hover state died with it and the freshly built replacement
    // never got an equivalent mouseenter — resync it, same as the in-place update path does
    // for its own state-changed-under-cursor case.
    if (pointerInsideAtRebuild) restoreHoverAfterClaimRebuild(tweetTextEl);

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

/** A wheel node — every spinner class in this file, and not the containers that merely hold one
 *  (`.mf-spinner-slot` runs no animation). The two forms are the same set: the regex tests a
 *  className we already hold, the list is what a subtree has to be searched with. */
const MF_SPIN_SELECTOR = /(^|\s)mf-(fc-|sel-|refresh-)?spinner(\s|$)/;
const MF_SPIN_QUERY = ".mf-fc-spinner, .mf-spinner, .mf-refresh-spinner, .mf-sel-spinner";
/** The `mf-spin` keyframes' period, in ms. Kept beside the rule so the two move together. */
const MF_SPIN_PERIOD_MS = 600;

/** Point a wheel at the document-wide rotation phase for right now, so a wheel that replaced
 *  another carries on from where that one was instead of restarting at the top. See the
 *  observer in setupGlobalHandlers for why every wheel gets this. */
function stampWheelPhase(el: HTMLElement): void {
    // !important because the stylesheet's own `animation` shorthand is important for some wheels
    // (`.mf-sel-spinner`) and would otherwise reset the longhand this sets.
    el.style.setProperty("animation-delay", `-${((performance.now() % MF_SPIN_PERIOD_MS) / 1000).toFixed(3)}s`, "important");
}

function setupGlobalHandlers() {
    if (globalHandlersSetup) return;
    globalHandlersSetup = true;

    // A wheel is a CSS animation, and one restarts from 0deg whenever its node is replaced —
    // which this codebase does constantly: a hover mints a fresh badge with a fresh wheel in
    // it, the hover teardown stands in another, a reconcile or an innerHTML repaint mints the
    // popover's. Every one of those restarts snapped the wheel back to the top mid-turn, so a
    // wheel rebuilt under a moving pointer visibly reset and span up again.
    //
    // Anchor them all to one document-wide clock instead: a negative delay puts a wheel at the
    // phase that clock says it should be at, so a replacement picks up where the node it replaced
    // left off and the rotation never restarts (and every wheel on screen turns in step). Stamped
    // the moment a wheel enters the document, so no frame is ever painted at the wrong phase —
    // the delay is in place before the animation is created, and a node re-inserted later is
    // re-stamped to the phase it should be at now rather than the one it was born with.
    //
    // One observer for every creation site rather than a call at each: the wheels are minted in
    // fifteen-odd places (badge factories, reconciles, popover rows, an innerHTML template), and
    // anything that rebuilds one would otherwise silently reintroduce the reset. Both filters
    // below are per-element and O(1), so the host pages' own churn is rejected without a tree
    // walk — a wheel is only ever added to one of our own containers, or arrives inside one.
    const couldHoldWheel = (el: Element): boolean => {
        const cls = el.className;
        return (typeof cls === "string" && cls.indexOf("mf-") !== -1)
            || el.hasAttribute("mf-unmatched") || el.hasAttribute("classification-id");
    };
    const wheelObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
            if (m.type !== "childList" || m.addedNodes.length === 0) continue;
            for (const node of Array.from(m.addedNodes)) {
                if (node.nodeType !== 1) continue;
                const el = node as Element;
                if (MF_SPIN_SELECTOR.test(typeof el.className === "string" ? el.className : "")) stampWheelPhase(el as HTMLElement);
                else if (couldHoldWheel(el)) for (const wheel of Array.from(el.querySelectorAll<HTMLElement>(MF_SPIN_QUERY))) stampWheelPhase(wheel);
            }
        }
    });
    wheelObserver.observe(document.body, { childList: true, subtree: true });

    // A badge that grows on hover can wrap away from the pointer that grew it; these two keep
    // it open across that move. mouseover arms the watch, mousemove finds out whether the
    // pointer followed the badge or left the space it moved out of.
    document.addEventListener("mouseover", (e) => {
        if (isTouchInput()) return;
        const on = e.target as Element;
        // Only a hover that reveals the empty slots can move the badge's layout, so only those
        // hovers are worth watching. Hovering an adjective the badge already shows swaps it for
        // its percentage, which the slot's own width absorbs — arming on that would reveal a
        // hidden slot the pointer never asked for.
        const enteredOn = on.closest?.(".mf-badge-verdict, .mf-badge-empty") ?? null;
        if (!enteredOn) return;
        const badge = on.closest?.(`.${VERDICT_BADGE_CLASS}`) as HTMLElement | null;
        if (badge) armBadgeHold(badge, e.clientX, e.clientY, enteredOn);
    });

    document.addEventListener("mousemove", (e) => {
        lastPointer = { x: e.clientX, y: e.clientY };
        updateBadgeHold(e.clientX, e.clientY);
        if (!isTouchInput()) {
            settleHoverClaims(e.clientX, e.clientY);
            settlePreviewPopover(e.clientX, e.clientY);
            sweepStrayTints(e.clientX, e.clientY);
            sweepStrayBadges(e.clientX, e.clientY);
        }
    });

    // The pointer leaving the document is the one departure no element-level boundary can name:
    // the element it was over may sit flush against the edge, and a preview's countdown reading
    // the last inside position would stand down as if the pointer had never left. It has left the
    // document, so the reading is dropped — nothing here is under the pointer any more.
    document.documentElement.addEventListener("mouseleave", () => {
        lastPointer = null;
        if (previewPopoverState) schedulePreviewPopoverDismiss(previewPopoverState.trigger);
    });

    // A tap is a hover the browser holds on what it landed on, but the two are read at
    // different moments. The hover is settled at touchstart, while the tap's own compatibility
    // mouse events arrive afterwards and are hit-tested against the layout the hover has since
    // produced — so they name the slot the widening slid under the finger rather than the word
    // that widened it, and following them drops the hover that revealed the percentages and
    // leaves one of the two showing. Read at touchstart, where the tap landed is still the word —
    // or squarely inside one adjective slot, which asks for that score alone, while a tap that
    // only clips the neighbouring slot is a near-miss and counts as the word's tap.
    let touchStart: { id: number; x: number; y: number; t: number } | null = null;
    document.addEventListener("touchstart", (e) => {
        // `changedTouches[0]`, not `e.changedTouches[0]`: any script on the page can
        // dispatch an event NAMED touchstart that carries no touch lists at all (CBC's
        // Sentry session-replay does, many times per page), and reading through it threw
        // on every one of them. A synthetic touchstart names no finger, so there is
        // nothing here to act on.
        const touch = e.changedTouches?.[0];
        if (!touch) return;
        // t stamps the tap's own window: the compatibility click below must arrive inside
        // it to count as that tap's echo rather than a later dismissal.
        touchStart = { id: touch.identifier, x: touch.clientX, y: touch.clientY, t: Date.now() };
        const { clientX: x, clientY: y } = touch;
        const on = mfElementFromPoint(x, y);
        const badge = on?.closest<HTMLElement>(`.${VERDICT_BADGE_CLASS}`) ?? null;
        if (!badge || !on) { releaseBadgeHold(); return; }
        // A finger on a held badge is on that badge still: a tap has nowhere to travel to, and
        // the spot under it may have moved since it landed. Tapping it again keeps it — unless
        // the tap is aimed squarely at one adjective slot, which is the one thing a tap can say
        // no other way: it asks for that score alone, so the hold goes and the stuck hover the
        // browser keeps on the tapped slot swaps it on its own. (On a mouse the same move needs
        // no release — the word's :hover was the whole reveal, so leaving it hands the other
        // percentage back by itself.)
        if (badgeHold && inBadgeHoldArea(badgeHold, x, y)) {
            if (singleScoreSlot(badgeHold.badge, on, x) && badgeHold.badge.contains(on)) releaseBadgeHold();
            return;
        }
        // A deliberate single-score tap never arms the hold: the stuck hover the browser keeps
        // on the tapped slot swaps that score on its own, and holding would force both.
        if (singleScoreSlot(badge, on, x)) { releaseBadgeHold(); return; }
        armBadgeHold(badge, x, y, on.closest(".mf-badge-verdict, .mf-badge-empty") ?? on, true);
    }, { capture: true, passive: true });

    // A finger that travels rather than taps is scrolling, and the browser drops its hover for
    // it. The hold goes too, rather than leaving the percentages up over a badge that has
    // scrolled out from under them.
    document.addEventListener("touchmove", (e) => {
        const touch = e.changedTouches?.[0];
        if (!touch || !touchStart || touch.identifier !== touchStart.id) return;
        if (Math.abs(touch.clientX - touchStart.x) < TOUCH_TAP_SLOP
            && Math.abs(touch.clientY - touchStart.y) < TOUCH_TAP_SLOP) return;
        touchStart = null;
        releaseBadgeHold();
    }, { capture: true, passive: true });

    document.addEventListener("click", (e) => {
        const popovers = document.querySelectorAll(".mf-popover");
        if (popovers.length === 0) return;
        const target = e.target as HTMLElement;
        let outsideAll = true;
        for (const p of popovers) {
            if (p.contains(target)) { outsideAll = false; break; }
        }
        // A tap's compatibility click is hit-tested against the layout its own touchstart
        // produced — and a badge that re-wrapped on the reveal left the vacated end-of-line
        // space the finger is standing on over no claim box at all. That click names the
        // bare column, but it is the badge's own tap arriving late, not a dismissal aimed
        // outside: closing here removes the badge the tap just revealed (and the popover
        // the first tap opened). What tells the echo from a dismissal is that the click is
        // where the finger still is, when it still is there, and the hold the tap armed
        // still covers that point. A click the finger itself aimed outside — or a later one
        // after the tap's window has passed — still dismisses.
        if (outsideAll && !target.closest?.(".mf-segment-claim") && touchStart && badgeHold) {
            const dx = e.clientX - touchStart.x, dy = e.clientY - touchStart.y;
            if (Math.abs(dx) <= TOUCH_TAP_SLOP && Math.abs(dy) <= TOUCH_TAP_SLOP
                && Date.now() - touchStart.t <= TOUCH_COMPAT_CLICK_WINDOW
                && inBadgeHoldArea(badgeHold, touchStart.x, touchStart.y)) return;
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

    setupSqueezeRecovery();
}

let squeezeRecoverySetup = false;

/** Everything that has to happen when the space a header row has *changes*, rather than
 *  when a button is injected into it: the label caps the squeezer wrote describe a layout
 *  that may no longer exist, and only a fresh measure can say.
 *
 *  This lives apart from `setupGlobalHandlers` because it must not wait for that function.
 *  `setupGlobalHandlers` is reached from `upgradeToSegments`, which runs when a post gets
 *  its first claims — so on a page where nothing has been fact-checked yet there are
 *  buttons, their labels can be capped, and nothing is listening: window narrow, labels
 *  cut to "D…", window wide again, and the cap stays (live-reproduced on Bluesky, where the
 *  header band really does crush). The injection path installs it directly for that case;
 *  `globalHandlersSetup` still installs it on X exactly where it always did. */
function setupSqueezeRecovery() {
    if (squeezeRecoverySetup) return;
    squeezeRecoverySetup = true;

    // Coalesced like the scroll handler below: each squeeze forces a reflow, and raw
    // resize events fire continuously through a window drag.
    //
    // BOTH triggers re-arm on every event rather than bailing out while one is pending.
    // Dropping events during a drag ran the pass against an INTERMEDIATE layout and then
    // ignored the events that followed, so the caps stayed sized for a width the reader
    // had already left — the widen that should lift them produced no pass at all
    // (live-reproduced on Bluesky: stale caps held for the whole 4s after the window grew
    // back). Re-arming makes both a trailing pass: the frame runs one frame after the
    // drag pauses, the timer 300ms after it ends, so whichever lands last reads the layout
    // the reader actually stopped at.
    //
    // The timer is also the half that survives a throttled frame. A BACKGROUND tab (or an
    // unfocused window) throttles rAF to nothing, so a frame-only trigger never runs there
    // — precisely the case where a cap written in a narrow window has to come off.
    let topBtnSqueezeRaf = 0;
    let topBtnSqueezeTimer = 0;
    window.addEventListener("resize", () => {
        updateOpenPopover();
        if (topBtnSqueezeRaf) cancelAnimationFrame(topBtnSqueezeRaf);
        topBtnSqueezeRaf = requestAnimationFrame(() => {
            topBtnSqueezeRaf = 0;
            resqueezeAllTopButtons();
        });
        if (topBtnSqueezeTimer) window.clearTimeout(topBtnSqueezeTimer);
        topBtnSqueezeTimer = window.setTimeout(() => {
            topBtnSqueezeTimer = 0;
            if (topBtnSqueezeRaf) {
                cancelAnimationFrame(topBtnSqueezeRaf);
                topBtnSqueezeRaf = 0;
            }
            resqueezeAllTopButtons();
        }, 300);
    });
    // Window resize never fires when a narrow pane grows (side panel, split
    // view, zoom-to-fit): X's own layout reflows the header row in place and a
    // stale max-width cap sticks with room to spare. A ResizeObserver on the DOCUMENT's
    // own width catches every one of those, and it is the element that survives: these
    // SPAs re-render their feeds, so a row observed when it was injected is detached a
    // moment later and never reports again — a row observer alone silently stops working
    // (live-reproduced on Bluesky: the first narrow/widen pair recovered, the next two
    // steps ran no pass at all). Height is ignored deliberately: it changes on every feed
    // append, and a squeeze never needs redoing because a post was added below.
    if (typeof ResizeObserver !== 'undefined') {
        let lastDocWidth = document.documentElement.clientWidth;
        const docWidthObserver = new ResizeObserver(() => {
            const w = document.documentElement.clientWidth;
            if (w === lastDocWidth) return;
            lastDocWidth = w;
            resqueezeAllTopButtons();
        });
        const watchDocWidth = () => {
            if (document.documentElement) docWidthObserver.observe(document.documentElement);
            else setTimeout(watchDocWidth, 50);
        };
        watchDocWidth();
    }
    // Row-level, for the one case the document width cannot see: a layout that reflows a
    // header row without the document changing size. One observer for the whole page
    // (articles come and go); a WeakSet keeps each row observed exactly once. Observing is
    // inert: it only schedules updateTopButtonSqueeze, which is itself idempotent.
    if (typeof ResizeObserver !== 'undefined') {
        const topBtnRowObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const article = postOfButtonSlot(entry.target as Element);
                if (!article) continue;
                updateTopButtonSqueeze(article);
            }
            // Loop guard: our own maxWidth writes change label widths, which can
            // re-fire the observer — but updateTopButtonSqueeze is coalesced (rAF
            // + 300ms trail) and converges (caps only shrink while clip > 1px),
            // so each burst schedules at most one extra pass and the trail
            // pass settles it.
        });
        const topBtnRowsObserved = new WeakSet<Element>();
        const observeTopButtonRows = () => {
            for (const slot of Array.from(document.querySelectorAll<HTMLElement>('[mf-top-bar-id], [mf-on-hold-id], [translate-fc-id], [mf-refresh-id], [mf-visual-id]'))) {
                const row = slot.parentElement;
                if (row && !topBtnRowsObserved.has(row)) {
                    topBtnRowsObserved.add(row);
                    topBtnRowObserver.observe(row);
                }
            }
        };
        const topBtnRowsTimer = window.setInterval(observeTopButtonRows, 2000);
        // Clean up with the page: single-page-app navigations never unload the
        // content script, but if they ever do, don't leave a timer behind.
        window.addEventListener("beforeunload", () => window.clearInterval(topBtnRowsTimer));
        observeTopButtonRows();
    }
}

/** The element that stands for a post holding one of our button slots.
 *
 *  On X that is the enclosing `<article>`, which is also what `injectClassification`
 *  hands the squeezer. A DOM-fed platform has no articles at all — Bluesky's post roots
 *  are `div[data-testid^="feedItem-by-"]` — so `closest('article')` found nothing there
 *  and the resize path silently did no work: the labels kept a cap from a layout that no
 *  longer existed, on the one platform whose header band genuinely crushes. The adapter
 *  answers this question (`postElementFor`), so ask it.
 *
 *  Falling back to the slot's own parent row rather than null keeps a miss harmless:
 *  re-squeezing the row is exactly what the caller wanted, and `applyTopButtonSqueeze`
 *  is idempotent and reads the container out of whatever element it is given. */
function postOfButtonSlot(slot: Element): Element | null {
    const seam = platformSeam();
    if (seam) return seam.postElementFor(slot) ?? slot.parentElement;
    return slot.closest('article');
}

/** Re-run the top-button squeezer on every post holding one of our buttons.
 *  Shared by the window-resize handler above (grow AND shrink — the squeezer's
 *  caps-clear-first pass snaps labels back when space returns). */
function resqueezeAllTopButtons() {
    for (const slot of Array.from(document.querySelectorAll<HTMLElement>('[mf-top-bar-id], [mf-on-hold-id], [translate-fc-id], [mf-refresh-id], [mf-visual-id]'))) {
        const article = postOfButtonSlot(slot);
        if (article) updateTopButtonSqueeze(article);
    }
}

export function setupArticleHandlers(articleEl: Element) {
    const article = articleEl as HTMLElement;
    if (article.dataset.mfHandlers === "true") return;
    article.dataset.mfHandlers = "true";
    setupGlobalHandlers();

    function closestEl(el: Element, selector: string): HTMLElement | null {
        return el.closest(selector) as HTMLElement | null;
    }

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

    article.addEventListener("mouseenter", (e) => {
        if (isTouchInput()) return;
        const target = closestEl(e.target as Element, ".mf-segment-claim");
        if (!target) return;
        // A badge's adjective, its percentage and the verdict word are separate elements,
        // so crossing between them re-fires mouseenter with the pointer already inside the
        // claim. Restarting the timer there would push the preview popover back for as long
        // as the pointer keeps crossing slots.
        const from = e.relatedTarget as Node | null;
        const hoverSiblings = claimHoverSiblings(target);
        if (from && hoverSiblings.some(s => s === from || s.contains(from))) { armHoverClaim(target); return; }
        // The same goes for the gap between two lines of one highlight: re-entering the claim
        // after a crossing must not restart a wait that is already running, nor count down
        // again for a preview that is already open. Either way the claim is hover-armed —
        // arming is idempotent, and it is what lets the mousemove backstop settle a hover
        // whose departure no boundary event ever names.
        if ((hoverTimer && hoveredSegment && hoverSiblings.includes(hoveredSegment)) || (previewPopoverState?.trigger && hoverSiblings.includes(previewPopoverState.trigger))) { armHoverClaim(target); return; }
        startHoverPreview(target);
    }, true);

    article.addEventListener("mouseleave", (e) => {
        const target = closestEl(e.target as Element, ".mf-segment-claim");
        if (!target) return;
        // Same for the way out: moving between slots leaves the slot but not the claim, so
        // the preview must neither be cancelled nor dismissed.
        const to = e.relatedTarget as Node | null;
        if (to && claimHoverSiblings(target).some(s => s === to || s.contains(to))) return;
        // And crossing one of the claim's own line gaps is no departure either — measured
        // from the pointer, since that is the one thing that says where between the lines it
        // is. Without this, moving down a highlight to its badge dropped the badge unless the
        // crossing was quick enough to beat the dismissal.
        if (inClaimHoverArea(target, e.clientX, e.clientY)) return;
        disarmHoverClaim(target);
        cancelHoverPreview();
        schedulePreviewPopoverDismiss(target);
    }, true);

    article.addEventListener("click", (e) => {
        const target = closestEl(e.target as Element, ".mf-segment-claim");
        if (!target) return;

        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) return;

        // The claim is our own control, so a click on it must never also run the host
        // page's default action. On Reddit's feed a post's whole body is wrapped in the
        // card's permalink `<a>`, and the stopPropagation calls below do NOT cancel an
        // anchor's navigation — only preventDefault does — so without this the click that
        // opens the popover also navigates away and the popover is gone before it paints.
        // Inert on X, whose tweet text has no anchor around it.
        e.preventDefault();

        // A tap on the verdict badge is what shows its percentages on a touchscreen, where
        // there is no hover — the browser holds :hover on the tapped element. That only
        // works if the tap reaches the badge instead of being read as a click on the claim:
        // toggling the popover here would tear down the badge the tap was aimed at.
        const verdictBadge = closestEl(e.target as Element, `.${VERDICT_BADGE_CLASS}`);
        if (verdictBadge && target.contains(verdictBadge)) {
            e.stopPropagation();
            return;
        }

        // Flow B tap: an idle Annotate button click opens the popover
        // immediately AND triggers the annotation in the background (spec) —
        // not one or the other. Runs before the on-hold/pipeline branches
        // below; the Annotate badge only exists on settled claims, so those
        // branches never see it. A pending flight's hover-only badge is NOT a
        // button — tapping it just opens the popover (the second disjunct
        // requires the idle affordance, so a click on the claim TEXT while a
        // flight runs falls through to openPinnedPopover below instead of
        // re-dispatching through triggerAnnotateForSpan's no-op branch).
        if ((closestEl(e.target as Element, ".mf-annotate-badge") && spanWantsIdleAnnotate(target))
            || (spanWantsIdleAnnotate(target)
                && !(target as any)._mfPopoverOpen
                && !closestEl(e.target as Element, ".mf-inline-badge"))) {
            e.stopPropagation();
            disarmHoverClaim(target);
            cancelHoverPreview();
            dismissPreviewPopover();
            triggerAnnotateForSpan(target);
            openPinnedPopover(target);
            resyncHoverAtPointer(target);
            return;
        }

        e.stopPropagation();
        disarmHoverClaim(target);
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
          // What is being reclassified keeps the colour and badge of the verdict it is
          // replacing for as long as the re-run streams: that verdict is still the one on
          // screen, so only its badge gains the spinner. Grey and a researching word are
          // for a claim that has never had a verdict — the same predicate the build and
          // in-place paints use, so the three agree and the click moves no colour at all.
          const cachedP = parseFloat(target.dataset.cachedConfidence ?? "");
          const cachedV = parseFloat(target.dataset.cachedVeracity ?? "");
          const hasCachedVerdict = !isNaN(cachedP) && !isNaN(cachedV) && cachedP >= 0.2;
          const darkNow = isDarkSurface(target);
          paintClaimBg(target, hasCachedVerdict
            ? confidenceRgba(cachedP, 0.25, cachedV)
            : darkNow ? 'rgba(180,180,180,0.32)' : 'rgba(0,0,0,0.18)');
          target.dataset.hoverBg = hasCachedVerdict
            ? confidenceRgba(cachedP, 0.5, cachedV)
            : darkNow ? 'rgba(180,180,180,0.42)' : 'rgba(0,0,0,0.28)';
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
            (badge as HTMLElement).style.color = '#ffffff';
            (badge as HTMLElement).style.marginLeft = isRTL ? '0' : '0.27em';
            (badge as HTMLElement).style.marginRight = isRTL ? '0.27em' : '0';
            badge.innerHTML = '';
            const fcLabel = hasCachedVerdict
              ? verdictLabel(cachedP, cachedV, researchingSeed)
              : pickResearchingWord(researchingSeed);
            const fcSpinner = document.createElement("span");
            fcSpinner.className = "mf-fc-spinner";
            if (isRTL) {
              fcSpinner.style.marginRight = "0";
              fcSpinner.style.marginLeft = "0.27em";
              badge.appendChild(document.createTextNode(fcLabel));
              badge.appendChild(fcSpinner);
            } else {
              badge.appendChild(fcSpinner);
              badge.appendChild(document.createTextNode(fcLabel));
            }
            badge.classList.remove("mf-annotate-badge");
            badge.classList.add(VERDICT_BADGE_CLASS);
            syncBadgeLoadingClass(badge as HTMLElement);
          }
          const classificationId = claimIdForSeed;
          if (classificationId) {
            const ct = target.dataset.claimText;
            individuallyClickedOnHoldClaims.add(`${classificationId}:${ct}`);
            // The reader just clicked a control on this post, which is the whole
            // thing the top-of-tweet buttons record — so record it here too. Without
            // it the re-check they just ordered revokes the claim's own verdict (the
            // payload lands with note:null), that claim leaves the bypass set, and a
            // post whose only visible claim was that one drops back behind its
            // Reveal button: the click appears to hide the post it was made on, and
            // the latched verdict keeps it hidden until they click Reveal by hand.
            markVisualsEngaged(classificationId);
            selectionButtonShown.delete(classificationId);
            selectionButtonArmed.delete(classificationId);
            if (!onHoldScrollStates.has(classificationId) && ct) {
              onHoldScrollStates.set(classificationId, {
                mark: markAt(target),
                pendingClaimTexts: new Set([ct]),
                keptClaimTexts: new Set([ct])
              });
            } else if (onHoldScrollStates.has(classificationId) && ct) {
              onHoldScrollStates.get(classificationId)!.pendingClaimTexts.add(ct);
              onHoldScrollStates.get(classificationId)!.keptClaimTexts.add(ct);
            }
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
          paintClaimBg(target, isDarkSurface(target) ? 'rgba(180,180,180,0.32)' : 'rgba(0,0,0,0.18)');
          target.dataset.hoverBg = isDarkSurface(target) ? 'rgba(180,180,180,0.42)' : 'rgba(0,0,0,0.28)';
          const badge = target.querySelector(".mf-inline-badge") as HTMLElement | null;
          if (badge) {
            const isRTL = isRTLLocale(getEffectiveUILocale());
            badge.style.color = '#ffffff';
            badge.style.marginLeft = isRTL ? '0' : '0.27em';
            badge.style.marginRight = isRTL ? '0.27em' : '0';
            badge.innerHTML = '';
            const fcSpinner = document.createElement("span");
            fcSpinner.className = "mf-fc-spinner";
            if (isRTL) {
              fcSpinner.style.marginRight = "0";
              fcSpinner.style.marginLeft = "0.27em";
              badge.appendChild(document.createTextNode(pickResearchingWord(researchingSeed)));
              badge.appendChild(fcSpinner);
            } else {
              badge.appendChild(fcSpinner);
              badge.appendChild(document.createTextNode(pickResearchingWord(researchingSeed)));
            }
            syncBadgeLoadingClass(badge);
          }
          const classificationId = claimIdForSeed;
          if (classificationId) {
            const ct = target.dataset.claimText!;
            individuallyClickedOnHoldClaims.add(`${classificationId}:${ct}`);
            // Same as the on-hold badge above: a claim-level Fact-Check click is a
            // click on this post, so the post counts as engaged and its visuals stay
            // up through the re-check instead of dropping behind Reveal.
            markVisualsEngaged(classificationId);
            selectionButtonShown.delete(classificationId);
            selectionButtonArmed.delete(classificationId);
            if (!onHoldScrollStates.has(classificationId) && ct) {
              onHoldScrollStates.set(classificationId, {
                mark: markAt(target),
                pendingClaimTexts: new Set([ct]),
                keptClaimTexts: new Set([ct])
              });
            } else if (onHoldScrollStates.has(classificationId) && ct) {
              onHoldScrollStates.get(classificationId)!.pendingClaimTexts.add(ct);
              onHoldScrollStates.get(classificationId)!.keptClaimTexts.add(ct);
            }
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
        if (badge) {
            badge.remove();
            syncClaimBadgeLayout(targetTrigger);
        }
        restoreClaimTint(targetTrigger);
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

        mountPopover(popover, trigger);
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
            // Only the idle Annotate button re-creates permanent here: a touch
            // tap never hovers, so a transient flag would let the next
            // mouseleave tear down the badge the popover is sitting on. A
            // pending flight is hover-only like the classification loading
            // words — nothing to click, so nothing to pin.
            trigger.querySelector(".mf-standalone-spinner")?.remove();
            trigger.appendChild((trigger as any)._mfCreateBadge(trigger.dataset.reclassifyOnHold === "true" || spanWantsIdleAnnotate(trigger)));
            syncClaimBadgeLayout(trigger);
            // On touch the badge only ever appears here, after placement — and at the end of
            // a line it can wrap the trigger's box down under the window just placed.
            shiftPopoverBelowBadge(trigger);
        }
        refreshInPopoverOnboarding();
        // Last, once the window is at its final size and place: a host layer over it is invisible
        // to everything above this line.
        ensurePopoverVisible(popover, trigger);
    } catch (e) {
        console.error("[misinfo] showPopover failed:", e);
        if (popover && popover.parentElement) popover.remove();
        delete (trigger as any)._mfPopoverOpen;
        const badge = trigger.querySelector(".mf-inline-badge");
        if (badge && !spanWantsIdleAnnotate(trigger)) {
            badge.remove();
            syncClaimBadgeLayout(trigger);
        }
        restoreClaimTint(trigger);
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
        // No batch-refresh button on the claim row any more: it lives at the top of
        // the tweet now (beside Fact-Check All, or alone when neither button remains).
        appendTextRow(claimText, popover, "mf-popover-claim-text", undefined, translatePreBtn);
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
    spinner.style.marginLeft = isRTL ? "0" : "0.27em";
    spinner.style.marginRight = isRTL ? "0.27em" : "0";
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

/** The box that would crop a popover mounted in this element, in viewport coordinates, or
 *  null when nothing between it and the page clips.
 *
 *  A popover is `position: absolute` inside its container, so any ancestor of that container
 *  with a non-visible overflow CUTS it: everything past that ancestor's edge is simply not
 *  painted, and the reader is left with a strip of a popover instead of a popover. No z-index
 *  beats that — the clip is not about paint order. It is also not exotic: it is what a host
 *  does whenever the post sits in a column narrower than the window (a permalink dialog, a
 *  thread pane), which is exactly the case where placing the popover to the right — the
 *  placement with room on the page — would be cropped.
 *
 *  This is therefore a yes/no question ("can this container hold a popover at all?"), which
 *  `mountPopover` asks before choosing a host. Every ancestor is checked, not just the nearest,
 *  because one far up is enough to crop. An axis left `visible` does not clip, but a container
 *  that sets one axis to a non-visible value has the other compute to `auto` anyway, so testing
 *  whole elements costs nothing real.
 */
function clippingBounds(el: Element | null): { left: number; top: number; right: number; bottom: number } | null {
    let box: { left: number; top: number; right: number; bottom: number } | null = null;
    for (let cur = el; cur && cur !== document.documentElement; cur = cur.parentElement) {
        const style = getComputedStyle(cur);
        if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
        const r = cur.getBoundingClientRect();
        box = box
            ? {
                left: Math.max(box.left, r.left),
                top: Math.max(box.top, r.top),
                right: Math.min(box.right, r.right),
                bottom: Math.min(box.bottom, r.bottom),
            }
            : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }
    return box;
}

/** Mount a claim popover in the one place on this page that can hold it whole.
 *
 *  The timeline container is the default, and `position: absolute` inside it is worth keeping:
 *  the container scrolls the popover with its post for free. That only works while nothing
 *  between popover and page clips, though, and hosts do clip. Measured on a Facebook permalink
 *  comment: the comments column is 350..1050 wide, the claim ends at x=960, so the placement
 *  with room on the PAGE put the popover at 968..1328 — and the column's own `overflow: hidden`
 *  painted away all but its first 82px.
 *
 *  `document.body` is the escape, and `position: fixed` alone is not: the same column also sets
 *  `perspective`, which makes it the containing block for fixed descendants, and a fixed
 *  popover left in place still resolved its `left: 968px` against the column (measured: viewport
 *  x=1318). Body has no host between it and the page, so a fixed popover there is viewport-
 *  anchored with nothing to crop it — measured at the same coordinates, both its right and
 *  bottom edges hit-test as the popover itself instead of as the page behind it.
 *
 *  What it gives up is the free scroll-tracking, which `trackViewportFixedPopovers` restores.
 */
function mountPopover(popover: HTMLElement, trigger: HTMLElement): void {
    const host = topLayerHost(trigger);
    const container = getTimelineContainer(trigger);
    // A top-layer surface is not reachable from outside it by any z-index, so a window mounted
    // anywhere else is painted under it however large ours is. Ride the trigger's own surface.
    if (host && !host.contains(container)) {
        mountViewportFixed(popover, host);
        return;
    }
    if (clippingBounds(container)) {
        mountViewportFixed(popover, host);
        return;
    }
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    container.appendChild(popover);
}

/** The host's own top-layer surface containing the trigger, if there is one.
 *
 *  A `<dialog>` opened with `showModal()` is painted in the browser's TOP LAYER, which is stacked
 *  above every z-index on the page — our 2147483643 included — so no `z-index` we can write reaches
 *  over it and the only way in is to be inside it. Measured on LinkedIn's mobile search surface: the
 *  "N comments" control opens `DIALOG.ebumkj` covering the viewport, a claim in a comment lights up
 *  with its window open, and the window measured fixed, on screen and correctly placed while
 *  `elementFromPoint` at its own centre returned a span of that dialog's. */
function topLayerHost(trigger: HTMLElement): HTMLElement | null {
    const dialog = trigger.closest('dialog[open]');
    return dialog instanceof HTMLElement ? dialog : null;
}

/** The page's open `<dialog>` painted highest, if it has one: the last one in document order.
 *
 *  Same fact as `topLayerHost`, from the side that has no trigger — our own overlay chrome.
 *  Notifications (z:2147483645) and the floating buttons (z:2147483647) are mounted on the body
 *  and no z-index reaches out of the top layer. Measured on LinkedIn's mobile search surface:
 *  the comments control opens `DIALOG.ebumkj`, and `elementFromPoint` at the centre of a
 *  max-z-index element on the body returned that dialog. Measured in the same dialog: a fixed
 *  child lands at its own viewport coordinates — `transform`, `filter` and `contain` are `none`
 *  on the dialog and on every ancestor — and `elementFromPoint` then returns the child. */
function openTopLayerSurface(): HTMLElement | null {
    const dialogs = document.querySelectorAll<HTMLElement>('dialog[open]');
    return dialogs.length > 0 ? dialogs[dialogs.length - 1] : null;
}

/** Put our own overlay chrome where the reader can see it: inside the page's top-layer surface
 *  while one is open, on the body otherwise. */
function mountOverlayChrome(el: HTMLElement): void {
    const host = openTopLayerSurface() ?? document.body;
    if (el.parentElement !== host) host.appendChild(el);
    watchTopLayer();
}

/** Follow the page's top layer for chrome that is ALREADY on screen.
 *
 *  `mountOverlayChrome` decides where chrome goes as it appears, which covers the case the
 *  reader is actually in: a charge made inside the comments view raises its notification into
 *  the surface that is open at that moment. The other half is chrome that appeared BEFORE the
 *  surface did — a toast lives 5s and a floating button 10s, so the click that opens the
 *  page's comments easily lands inside that window, and a surface painted over them is the
 *  same bug. A `<dialog>` announces itself by gaining an `open` attribute or by being inserted
 *  already carrying one, so those are the only two mutations worth hearing: a feed mutates
 *  every frame and must not be walked. */
let topLayerWatcher: MutationObserver | null = null;
function watchTopLayer(): void {
    if (topLayerWatcher || !document.documentElement) return;
    const rehome = () => {
        const host = openTopLayerSurface();
        const chrome: HTMLElement[] = [];
        for (const state of Array.from(floatingButtonRegistry.values())) {
            if (state.btn?.isConnected) chrome.push(state.btn);
        }
        const container = document.querySelector<HTMLElement>('.mf-notif-container');
        if (container) chrome.push(container);
        for (const el of chrome) {
            // A surface is open: everything of ours belongs inside it. None is open: only
            // chrome the closing surface stranded inside a `<dialog>` still needs moving —
            // it would otherwise sit in a subtree that no longer paints.
            if (host || el.closest('dialog')) mountOverlayChrome(el);
        }
    };
    // One re-check per burst, not per record, and never a subtree walk: this observer sees
    // every frame of a feed, so all it may cost is a tag comparison per inserted node.
    let scheduled = false;
    const schedule = () => {
        if (scheduled) return;
        scheduled = true;
        queueMicrotask(() => { scheduled = false; rehome(); });
    };
    topLayerWatcher = new MutationObserver((records) => {
        for (const record of records) {
            if (record.type === 'attributes') {
                if ((record.target as Element).tagName === 'DIALOG') schedule();
                continue;
            }
            for (const node of Array.from(record.addedNodes)) {
                if (node.nodeType === 1 && (node as Element).tagName === 'DIALOG') { schedule(); break; }
            }
        }
    });
    topLayerWatcher.observe(document.documentElement, {
        childList: true, subtree: true, attributes: true, attributeFilter: ['open'],
    });
}

/** Mount a popover fixed to the viewport, inside `host` when the trigger lives in a top-layer
 *  surface and on `document.body` otherwise. The escape for both a container that would crop the
 *  window and a window the host paints over. */
function mountViewportFixed(popover: HTMLElement, host?: HTMLElement | null): void {
    (popover as any)._mfViewportFixed = true;
    popover.style.position = 'fixed';
    (host ?? document.body).appendChild(popover);
    trackViewportFixedPopovers();
}

/** Confirm the window just placed is the thing the reader would actually touch there, and move it to
 *  the body when it is not.
 *
 *  `mountPopover` mounts the window inside a container the HOST owns, which leaves one failure it
 *  cannot see: anything the host paints above that container covers the window. The reader then gets
 *  a highlight sitting in its window-open state with no window anywhere. A host's own composited
 *  layer is not something this file can enumerate per platform, and no z-index on our element
 *  reaches out of a container the host has already stacked it inside.
 *
 *  So ask the page instead of guessing: hit-test the window's own centre. Hit-testing follows paint
 *  order, so a window the reader cannot see is a window that is not the answer — covered, cropped,
 *  or placed off the viewport. That answer is the same whichever it was, and it is the escape
 *  `clippingBounds` already uses: mounted fixed to the viewport, where nothing the host stacks can
 *  reach it. A window that IS the answer is left exactly where it was, which is what keeps every
 *  platform that works today on the placement it has.
 *
 *  The one place a z-index cannot follow is a top-layer surface, which `topLayerHost` answers
 *  separately: a window moved out of it would be painted under it, however large our z-index.
 */
function ensurePopoverVisible(popover: HTMLElement, trigger: HTMLElement): void {
    if ((popover as any)._mfViewportFixed) return;
    // A dragged window was put where the reader wanted it; their placement is not ours to move.
    if ((popover as any)._mfManuallyPositioned) return;
    if (!popover.isConnected) return;
    const rect = popover.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const onScreen = cx >= 0 && cy >= 0 && cx <= window.innerWidth && cy <= window.innerHeight;
    const at = onScreen ? document.elementFromPoint(cx, cy) : null;
    if (at && at.closest('.mf-popover') === popover) return;
    mountViewportFixed(popover, topLayerHost(trigger));
    positionPopover(popover, trigger);
}

/** Keep body-mounted popovers with their post while anything scrolls.
 *
 *  A capture-phase listener, not a bubble one: scroll events do not bubble, so a listener on
 *  window only ever hears the document's own scroll — and on the hosts that need this, what
 *  scrolls is an inner container (the comments column), whose events reach window in the
 *  capture phase alone. One rAF per burst, and the scan is empty and free on every platform
 *  that mounts its popovers in the container as usual.
 */
let viewportFixedScrollRaf = 0;
let viewportFixedTracking = false;
function trackViewportFixedPopovers(): void {
    if (viewportFixedTracking) return;
    viewportFixedTracking = true;
    const reposition = () => {
        if (viewportFixedScrollRaf) return;
        viewportFixedScrollRaf = requestAnimationFrame(() => {
            viewportFixedScrollRaf = 0;
            for (const p of Array.from(document.querySelectorAll<HTMLElement>('.mf-popover'))) {
                if (!(p as any)._mfViewportFixed) continue;
                const t = (p as any)._mfTrigger as HTMLElement | undefined;
                if (!p.isConnected || !t || !t.isConnected) continue;
                positionPopover(p, t);
            }
        });
    };
    window.addEventListener('scroll', reposition, { capture: true, passive: true });
    window.addEventListener('resize', reposition, { passive: true });
}

function positionPopover(popover: HTMLElement, trigger: HTMLElement) {
    // A body-mounted popover is positioned in VIEWPORT coordinates (see mountPopover), so its
    // formula has no container term. It is also never frozen by a drag: nothing scrolls it back
    // into place with its post, so a frozen one would hang in the viewport while the post left.
    // The drag is re-applied as an offset at the end instead, exactly as the other
    // viewport-fixed family does (see positionOnboardingPopover).
    const viewportFixed = !!(popover as any)._mfViewportFixed;
    if ((popover as any)._mfManuallyPositioned && !viewportFixed) return;
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
    const offsetParent = viewportFixed ? null : ((popover.offsetParent as HTMLElement | null) ?? getTimelineContainer(trigger));
    const containerRect = offsetParent ? offsetParent.getBoundingClientRect() : { left: 0, top: 0 };
    const containerScrollTop = offsetParent ? offsetParent.scrollTop || 0 : 0;
    const containerScrollLeft = offsetParent ? offsetParent.scrollLeft || 0 : 0;
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
        // A body-mounted popover has to be able to LEAVE with its post, the way an
        // in-container one does when the container scrolls it out of sight — otherwise
        // scrolling the post away would park the window against the top edge of the screen
        // with nothing under it. A trigger already above the header has no top to be pushed
        // down to, so it keeps its own position and goes off-screen with the post.
        const topLimit = headerBottom + padding;
        if (targetViewportTop < topLimit) {
            targetViewportTop = viewportFixed ? Math.min(topLimit, trigRect.top) : topLimit;
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

    if (viewportFixed) {
        left += Number((popover as any)._mfDragDx) || 0;
        top += Number((popover as any)._mfDragDy) || 0;
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

/** Nudge a trigger's open popover(s) straight down just enough to uncover its badge.
 *
 *  Placement reads the trigger once, but the badge keeps growing after that: hovering the
 *  verdict word reveals the percentages, and at the end of a line that carries the badge
 *  onto the next one — growing the trigger's box downward, under a popover placed against
 *  the pre-reveal geometry. The ResizeObserver above never reports that growth: on an
 *  inline trigger it fires once with a 0x0 content rect and then stays silent across the
 *  whole reveal (probed in-page), so the reveal's own settle in armBadgeHold and the badge
 *  insertions that can wrap a trigger under an open popover (showPopover, updateOpenPopover's
 *  re-attach) call here directly, with the post-growth geometry live.
 *
 *  Only ever moves DOWN, and only by the live overlap with the badge: a popover above the
 *  trigger or to its right never intersects the badge, so those placements come back
 *  untouched — and so does anything the user dragged (_mfManuallyPositioned), which keeps
 *  working exactly as before. Popovers are fresh elements per open, so the next open
 *  starts un-dragged. Attached onboarding popovers re-stack from the claim popover and
 *  travel with it. Pinned and hover-preview popovers both carry _mfTrigger, so one scan
 *  covers both — a semi-transparent preview covers the badge just as opaquely. The shift
 *  never reverts when the badge shrinks back: the next streaming re-placement heals it,
 *  while yanking the window mid-read would fight the user, and re-hovering re-wraps into
 *  still-clear space. */
function shiftPopoverBelowBadge(trigger: HTMLElement): void {
    if (!trigger.isConnected) return;
    const badge = trigger.querySelector(".mf-inline-badge");
    if (!(badge instanceof HTMLElement)) return;
    const badgeRect = badge.getBoundingClientRect();
    if (badgeRect.width <= 0 || badgeRect.height <= 0) return;
    const trigRect = getTriggerViewportRect(trigger);
    const padding = 8;
    for (const p of Array.from(document.querySelectorAll(".mf-popover"))) {
        const popover = p as HTMLElement;
        if ((popover as any)._mfTrigger !== trigger) continue;
        if (!popover.isConnected) continue;
        // A dragged window keeps the user's placement — the same freeze positionPopover honours.
        if ((popover as any)._mfManuallyPositioned) continue;
        const popRect = popover.getBoundingClientRect();
        if (popRect.width <= 0 || popRect.height <= 0) continue;
        const overlaps = popRect.left < badgeRect.right && popRect.right > badgeRect.left
            && popRect.top < badgeRect.bottom && popRect.bottom > badgeRect.top;
        if (!overlaps) continue;
        // Clear the badge and whatever trigger line it sits on, keeping placement's own gap.
        const need = Math.max(badgeRect.bottom, trigRect.bottom) + padding - popRect.top;
        if (need <= 0) continue;
        const currentTop = parseFloat(popover.style.top || "");
        if (!isFinite(currentTop)) continue;
        popover.style.top = `${currentTop + need}px`;
        // Mirror the below-placement clamp: if the nudge itself pushes the window past the
        // viewport bottom, cap its height rather than spilling offscreen.
        const maxVTop = window.innerHeight - padding;
        if (popRect.bottom + need > maxVTop) {
            const maxH = maxVTop - (popRect.top + need);
            if (maxH > 60) {
                popover.style.maxHeight = `${maxH}px`;
                popover.style.overflowY = "auto";
            }
        }
        repositionAttachedOnboardingFor(popover);
    }
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
    // A dismissed state leaves no countdown behind it: the timer would otherwise fire against
    // whatever preview the same trigger holds next.
    if (previewPopoverState.leaveTimer) {
        clearTimeout(previewPopoverState.leaveTimer);
        previewPopoverState.leaveTimer = null;
    }
    const t = previewPopoverState.trigger;
    if (t) disarmHoverClaim(t);
    if (t && !(t as any)._mfPopoverOpen) {
        t.style.opacity = "";
        // Only the idle Annotate button survives a preview dismiss (spec) —
        // a pending flight is hover-only, like the classification loading
        // words, so its badge goes with the hover. Only transient hover
        // chrome is otherwise removed here. A flight still outstanding keeps
        // its stand-in spinner, mirroring teardownClaimHover.
        const badge = t.querySelector(".mf-inline-badge");
        if (badge && !spanWantsIdleAnnotate(t)) {
            badge.remove();
            if (isAnnotatePending(t)) ensureAnnotateStandin(t);
        }
        restoreClaimTint(t);
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

/** Hand a hover preview to the claim span that replaced the one it was hung on.
 *
 *  A rebuild is not a departure: it replaces the span under a stationary pointer several times
 *  through a single run — the verdict landing, every reasoning chunk, the annotation — while
 *  the claim itself never moves out from under the pointer. Taking the detached trigger as the
 *  end of the hover dismissed the semi-transparent window each time, and the fresh dwell
 *  re-opened it a second later, so the window blinked out and back exactly while the run was
 *  streaming. The replacement carries the same claim text, so re-point the window at it and let
 *  the pointer's own position decide the rest — the leave machinery takes it down as usual once
 *  the pointer really is off the claim.
 *
 *  Returns the span it adopted, or null when there is nothing to adopt: no preview, a preview
 *  hanging off the Fact-Checked button (its stand-in is no claim, and that window belongs to the
 *  button's own hover), a trigger that is still connected, no live replacement, or a pointer
 *  that is no longer on the claim at all. */
function adoptDetachedPreviewTrigger(only?: HTMLElement): HTMLElement | null {
    const state = previewPopoverState;
    if (!state) return null;
    if (only && state.popover !== only) return null;
    const trigger = state.trigger;
    if (!trigger || trigger.isConnected) return null;
    if ((trigger as any)._mfButtonPreview || (trigger as any)._mfVirtualLeft) return null;
    const dbClaimText = trigger.dataset.dbClaimText;
    const claimText = trigger.dataset.claimText;
    if (!dbClaimText && !claimText) return null;
    // The pointer is the authority: a claim's text can appear more than once on a page, and only
    // the replacement actually under the pointer is this window's. Two passes over the same
    // text-matched set, because "under the pointer" has two measures and they disagree exactly
    // where this matters: a pointer resting in the leading between a wrapped claim's lines — the
    // position a reader holds while reading the window this function exists to keep alive — is on
    // the claim by the guards' silhouette and off it by the strict hit-test. Only fall back when
    // the strict pass finds nothing, so a pointer genuinely on the text still resolves first.
    const candidates = Array.from(document.querySelectorAll<HTMLElement>(".mf-segment-claim")).filter(el =>
        dbClaimText ? el.dataset.dbClaimText === dbClaimText : el.dataset.claimText === claimText);
    const live = candidates.find(isPointerOverSpan) ?? candidates.find(isPointerInClaimHoverArea);
    if (!live) return null;
    (state.popover as any)._mfTrigger = live;
    state.trigger = live;
    // The replacement never hovered on its own, so the badge the window sits over has to be
    // minted here — the same hand-off the pinned path makes in updateOpenPopover. (The dwelling
    // hover that follows mints it too, but only when the pointer re-enters, which it does not.)
    if (!live.querySelector(".mf-inline-badge") && (live as any)._mfCreateBadge) {
        live.querySelector(".mf-standalone-spinner")?.remove();
        live.appendChild((live as any)._mfCreateBadge(live.dataset.reclassifyOnHold === "true" || spanWantsIdleAnnotate(live)));
        shiftPopoverBelowBadge(live);
    }
    // Deliberately no _mfPopoverOpen: a preview never carries it (showPreviewPopover refuses a
    // trigger that does), and dismissPreviewPopover's cleanup hangs off its absence.
    armHoverClaim(live);
    return live;
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

export function closePopover(trigger?: HTMLElement) {
    const pinnedPopovers = document.querySelectorAll(".mf-popover:not([data-preview='true'])");
    for (const p of pinnedPopovers) {
        if (trigger && (p as any)._mfTrigger !== trigger) continue;
        const t = (p as any)._mfTrigger as HTMLElement | undefined;
        if (t) {
            disarmHoverClaim(t);
            t.style.opacity = "";
            delete (t as any)._mfPopoverOpen;
            // Only the idle Annotate button is permanent (spec) — a popover
            // close must not take it. A pending flight is hover-only, like the
            // classification loading words, so its badge goes with the close —
            // but the flight is still outstanding, so its stand-in spinner
            // holds the state, mirroring teardownClaimHover. Every other badge
            // is transient hover chrome, removed here.
            const badge = t.querySelector(".mf-inline-badge");
            if (badge && !spanWantsIdleAnnotate(t)) {
                badge.remove();
                if (isAnnotatePending(t)) ensureAnnotateStandin(t);
            }
            restoreClaimTint(t);
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

    mountPopover(popover, trigger);
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
    if (!lastPointer) return false;
    return inPreviewRelatedArea(trigger, lastPointer.x, lastPointer.y);
}

/** Schedule preview popover dismissal 1 second after pointer leaves both
 *  the trigger and the popover. */
function schedulePreviewPopoverDismiss(trigger: HTMLElement) {
    if (!previewPopoverState || previewPopoverState.trigger !== trigger) return;
    if (isHoveringPreviewRelated(trigger)) {
        if (previewPopoverState.leaveTimer) {
            clearTimeout(previewPopoverState.leaveTimer);
            previewPopoverState.leaveTimer = null;
        }
        return;
    }
    if (previewPopoverState.leaveTimer) clearTimeout(previewPopoverState.leaveTimer);
    previewPopoverState.leaveTimer = setTimeout(() => {
        if (!previewPopoverState) return;
        // Another preview can take over while this countdown runs — the next claim's hover, or
        // the Fact-Checked button's list. The countdown belongs to the trigger that armed it,
        // and `isHoveringPreviewRelated` answers "not hovering" for any other owner, so without
        // this check it would dismiss a preview the pointer is sitting on.
        if (previewPopoverState.trigger !== trigger) return;
        // The countdown is spent whether or not it dismisses. Standing down with the timer still
        // recorded as pending would bar every later re-arm — the backstop refuses to start a
        // countdown while one is "running" — and leave the popover with no way down.
        previewPopoverState.leaveTimer = null;
        if (isHoveringPreviewRelated(trigger)) return;
        dismissPreviewPopover();
    }, 1000);
}


/** The trigger fields an open preview window reads (see updateOpenPopover). */
const PREVIEW_TRIGGER_FIELDS = [
    "claimRewritten", "claimText", "reasoning", "probability",
    "veracity", "sources", "claimLocale", "reasoningLocale", "refreshing",
] as const;

/** Re-stamp the Fact-Checked button's stand-in trigger from the claim it stands for.
 *
 *  A preview hung on a claim highlight stays live because its trigger IS the span: every
 *  delivery re-stamps that span's dataset and updateOpenPopover re-reads it on each pass,
 *  which is how the reasoning expands and the sources arrive at the end while the window is
 *  open. The button's hover list has no span of its own — it parks this stand-in over the
 *  claim row — so its dataset was written once, at hover time, and the open window kept that
 *  snapshot: the reasoning cut short at whatever had streamed by then, and the sources, which
 *  land last, missing outright.
 *
 *  The claim's own span is copied where there is one, because that dataset is exactly what
 *  hovering the highlight itself shows — same fields, same extraction — so the two windows
 *  cannot drift apart. A claim that rendered as list text instead of a highlight has no span
 *  to copy, and the held classification stands in. */
function syncButtonPreviewTrigger(trigger: HTMLElement) {
    const live = (trigger as any)._mfLiveClaim as { id: string; index: number } | undefined;
    if (!live) return;

    const span = document.querySelector<HTMLElement>(
        `.mf-segment-claim[data-mf-cid="${cssAttrValue(live.id)}"][data-claim-index="${live.index}"]`);
    if (span) {
        for (const field of PREVIEW_TRIGGER_FIELDS) {
            const value = span.dataset[field];
            if (value === undefined) delete trigger.dataset[field];
            else trigger.dataset[field] = value;
        }
        return;
    }

    const claim = allClassifications.find(c => c.id === live.id)?.claims?.[live.index];
    if (!claim) return;
    trigger.dataset.claimRewritten = (claim.rewritten && claim.rewritten !== claim.text) ? claim.rewritten : claim.text;
    trigger.dataset.claimText = claim.text;
    trigger.dataset.reasoning = extractReasoning(claim.note, claim.confidence, claim.veracity);
    trigger.dataset.probability = String(claim.confidence ?? "");
    trigger.dataset.veracity = String(claim.veracity ?? "");
    trigger.dataset.sources = JSON.stringify(claim.sources ?? []);
    trigger.dataset.claimLocale = claim.claimLocale ?? '';
    trigger.dataset.reasoningLocale = claim.reasoningLocale ?? '';
    trigger.dataset.refreshing = claim.refreshing ? "true" : "";
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
    (trigger as any)._mfButtonEl = anchorBtn;
    // Which claim this stand-in speaks for. The window it carries has to follow the research
    // as it streams, so it is resolved positionally — the way the button's own hover handler
    // looks its claim up — and re-stamped on every update (syncButtonPreviewTrigger).
    (trigger as any)._mfLiveClaim = { id: classification.id, index: Number(claimEl.dataset.claimIndex) };
    trigger.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;";
    trigger.dataset.claimRewritten = (claim.rewritten && claim.rewritten !== claim.text) ? claim.rewritten : claim.text;
    trigger.dataset.claimText = claim.text;
    // Same extraction the claim's own span carries: the "Label: " prefix belongs to the badge,
    // and leaving it on the reasoning is a second copy of the verdict the highlight popover
    // does not show.
    trigger.dataset.reasoning = extractReasoning(claim.note, claim.confidence, claim.veracity);
    trigger.dataset.probability = String(claim.confidence ?? "");
    trigger.dataset.veracity = String(claim.veracity ?? "");
    trigger.dataset.sources = JSON.stringify(claim.sources ?? []);
    trigger.dataset.batchId = classification.batchId;
    trigger.dataset.claimLocale = claim.claimLocale ?? '';
    trigger.dataset.reasoningLocale = claim.reasoningLocale ?? '';
    document.body.appendChild(trigger);
    syncButtonPreviewTrigger(trigger);

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

    link.className = "mf-source-link";
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
    // margin/padding reset inline as well as in the stylesheet: a host rule on `img` is
    // what pushes the icon out of the circle, and the inline copy holds even if the
    // stylesheet has not landed or is shadowed.
    img.style.cssText = "width: 16px; height: 16px; display: none; border-radius: 2px; margin: 0; padding: 0;";
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

/** How long an "Annotating" badge waits for a key to land before reverting to
 *  "Annotate" so the user can retry. A failure/skip broadcasts nothing (the
 *  background returns without painting), so without this the spinner would sit
 *  forever; a late arrival still reconciles through the normal path. */
const ANNOTATE_PENDING_TIMEOUT_MS = 60000;

/** How long an auto-seeded "Annotating" badge (Flow A, see injectClassifications'
 *  newly-settled seed) waits for a key before reverting to the idle Annotate
 *  affordance. Longer than the tap window: Flow A's run starts only after the
 *  research stream closes, so the verdict-to-key gap includes the stream tail
 *  plus the agent run (~20s+ observed). */
const ANNOTATE_AUTO_PENDING_TIMEOUT_MS = 180000;

/** Classification+claim keys with an annotation run in flight (tapped badge,
 *  no key yet). Module-level so the pending paint survives a full span
 *  rebuild, which recreates the dataset from the claim (no pending flag). */
const annotatePendingClaims = new Set<string>();
const annotatePendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Stable key for the pending set, from a span's live dataset. */
function annotateKeyForSpan(span: HTMLElement): string {
    return `${span.dataset.mfCid ?? ''}:${span.dataset.claimText ?? ''}`;
}

/** Flow A seeds: claim keys whose silent post-research annotation run is
 *  presumably in flight (set by the relay from the background's
 *  `annotateInFlight` marker — see broadcastClassification). A key lands here
 *  BEFORE its classification's paint (the relay seeds right after
 *  injectClassifications returns), so the badge factory and reconcile can
 *  already paint "Annotating" while the verdict is new; consumed when the key
 *  lands or the span settles (see isAnnotatePending / spanNeedsAnnotateBadge).
 *  Plain claim-text keys (`${tweetId}:${claimText}`), matching the pending set. */
const annotateSeededKeys = new Set<string>();

/** Record Flow A seeds arriving with a broadcast (exported for the relay).
 *  Additive: unknown keys are ignored everywhere they're read. */
export function setAnnotateSeeded(keys: Set<string>): void {
    for (const k of keys) {
        if (!annotatePendingClaims.has(k)) annotateSeededKeys.add(k);
    }
}

/** Clear a consumed seed (key landed, claim settled otherwise, timeout). */
function clearAnnotateSeed(key: string): void {
    annotateSeededKeys.delete(key);
}

/** Drop a tweet's Flow A seeds and Flow B pending keys. Called when a
 *  (re)preclassification resets the tweet's links (see injectClassifications):
 *  the previous round's runs can never land, so without this the fresh
 *  keyless claims inherit a ghost "Annotating". Pending timers left on
 *  spans self-clean (no-op delete + idle repaint) when they fire. */
function clearAnnotateStateForTweet(tweetId: string): void {
    const prefix = `${tweetId}:`;
    for (const k of annotateSeededKeys) if (k.startsWith(prefix)) annotateSeededKeys.delete(k);
    for (const k of annotatePendingClaims) {
        if (k.startsWith(prefix)) {
            annotatePendingClaims.delete(k);
            clearAnnotateTimeoutForKey(k);
        }
    }
}

/** Whether the span's claim has an annotation run in flight. */
function isAnnotatePending(span: HTMLElement): boolean {
    return annotatePendingClaims.has(annotateKeyForSpan(span));
}

/** Whether the span's claim has an annotation run in flight OR seeded to start:
 *  seeds promote to pending synchronously inside the badge factory/reconcile,
 *  so permanence decisions taken BEFORE that promotion (build path, mouseenter,
 *  showPopover) must treat a live seed as a flight — otherwise they'd mint a
 *  permanent button the promotion then repaints as "Annotating". */
function isAnnotateFlight(span: HTMLElement): boolean {
    // A present key (even an empty dict — "annotated, clean") means the run
    // already landed. The pending/seed sets can still hold this claim for a
    // moment: selection rebuilds mint a fresh span, then settleRebuiltSpanAnnotations
    // clears them. Treating that as a flight would paint a standalone spinner
    // onto a span that already has its verdict, and settle would keep it.
    if (!spanNeedsAnnotateBadge(span)) return false;
    const key = annotateKeyForSpan(span);
    return annotatePendingClaims.has(key) || annotateSeededKeys.has(key);
}

/** Clear a consumed Flow A seed for a claim key: the key landed (annotated),
 *  so nothing is in flight — or the claim settled another way (clean {},
 *  failed research) and the seed must not linger. */
function clearAnnotateSeedForClaim(classificationId: string, text: string): void {
    clearAnnotateSeed(`${classificationId}:${text}`);
}

/** Settle one claim span's annotation state against the claim it was just
 *  rebuilt from (X's in-place reconcile, extracted for a surface that rebuilds
 *  instead of updating in place — see `wrapClaimSegmentsInPlace`).
 *
 *  The span is fresh: its dataset was just stamped from `claim` by the factory,
 *  so "the key landed" reads as `claim.annotations` holding a key (even an empty
 *  dict — "annotated, clean"), and "still waiting" reads as the pending set /
 *  seed holding this span's key. Same state changes as the reconcile block in
 *  `upgradeToSegments` (5002-5088): land clears pending + seed + timer, and the
 *  inline paint re-derives from the stamped dataset. Same paint ownership too —
 *  the factory above already painted the badge, so this settles state only and
 *  removes a stale "Annotating" flight the factory minted from a seed/pending
 *  entry that the landed key has since superseded. `preferDict` is the resolver's
 *  locale-ranked dict choice, matching the build path's paint; `repaintNeeded`
 *  reports whether the inline paint signature moved (the caller nudges an open
 *  popover clear, exactly as the in-place path does). Pure span + claim in —
 *  span out; never touches X's spans, which keep their own reconcile. */
export function settleRebuiltSpanAnnotations(
    span: HTMLElement,
    claim: Claim,
    classificationId: string,
    preferDict?: string,
): { repaintNeeded: boolean } {
    const cid = span.dataset.mfCid ?? classificationId;
    const key = `${cid}:${span.dataset.claimText ?? claim.text}`;
    // `spanNeedsAnnotateBadge` is the same affordance gate the factory and the
    // in-place reconcile read: a PRESENT key (even an empty dict — "annotated,
    // clean") means annotated, so `false` here is "the key landed".
    const needsAnnotateNow = spanNeedsAnnotateBadge(span);
    if (!needsAnnotateNow) {
        annotatePendingClaims.delete(key);
        clearAnnotateSeed(key);
        clearAnnotateTimeout(span);
    } else {
        promoteAnnotateSeed(span);
    }
    const segStart = parseInt(span.dataset.mfSegStart ?? "", 10);
    const plain = mfPlainText(span);
    // A selection wrap that preserved page formatting (`<u>`/`<em>`/`<a>`)
    // would be flattened back to one text node if we always repainted. Skip
    // the paint unless there are ranges to draw — empty `{}` under a locale
    // is annotated-clean, not a strikethrough.
    if (!annotationsHaveRanges(claim.annotations)) {
        return { repaintNeeded: false };
    }
    const kept: HTMLElement[] = [];
    const badgeNow = span.querySelector(".mf-inline-badge");
    if (badgeNow instanceof HTMLElement) { badgeNow.remove(); kept.push(badgeNow); }
    const spinNow = span.querySelector(".mf-standalone-spinner");
    if (spinNow instanceof HTMLElement) {
        spinNow.remove();
        // Key landed: the factory may have minted this spinner while pending
        // was still set. Drop it. A live flight still wants it reattached —
        // unless a visible badge already carries the spinner.
        if (needsAnnotateNow && !badgeNow) kept.push(spinNow);
    }
    const sig = repaintInlineAnnotations(span, plain, isNaN(segStart) ? 0 : segStart, claim.annotations, kept, preferDict);
    const prev = span.dataset.mfStrike ?? '';
    span.dataset.mfStrike = sig;
    return { repaintNeeded: sig !== prev };
}

/** Whether a claim span wants the Annotate affordance (Flow B): idle button or
 *  pending flight. Read live from the dataset, like everything badge-related:
 *  the span is updated in place as the claim progresses, so render-time
 *  closures go stale. True only for a settled, classified claim — not on hold,
 *  not refreshing, carrying reasoning (the same gate the background's
 *  ANNOTATE_CLAIM handler enforces) — whose annotation object holds no key yet.
 *  A present key, even an empty dict, means "annotated" and suppresses it. */
function spanNeedsAnnotateBadge(span: HTMLElement): boolean {
    if (span.dataset.reclassifyOnHold === "true") return false;
    if (span.dataset.refreshing === "true") return false;
    if ((span.dataset.reasoning ?? "").trim() === "") return false;
    try {
        const parsed = JSON.parse(span.dataset.annotations ?? "{}");
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return Object.keys(parsed).length === 0;
        }
    } catch { /* corrupt reads as absent — the tap still works off the background's cache */ }
    return true;
}

/** Remove the standalone spinner stand-in, if present. */
function removeAnnotateStandin(span: HTMLElement): void {
    span.querySelector(".mf-standalone-spinner")?.remove();
}

/** Ensure a standalone spinner stand-in while an annotation run is in flight
 *  and no badge is showing it (the hover-only pending state, like the
 *  classification loading words). No-op when a badge or spinner exists. */
function ensureAnnotateStandin(span: HTMLElement): void {
    if (span.querySelector(".mf-inline-badge")) return;
    if (span.querySelector(".mf-standalone-spinner")) return;
    span.appendChild(createStandaloneSpinner(isRTLLocale(getEffectiveUILocale())));
}

/** Whether the span wants the IDLE Annotate button: the affordance gate holds
 *  and no annotation run is in flight (or seeded). Only this state owns the
 *  permanent badge — a pending "Annotating" flight is hover-only, like the
 *  classification loading words, with a stand-in spinner when idle. */
function spanWantsIdleAnnotate(span: HTMLElement): boolean {
    return spanNeedsAnnotateBadge(span) && !isAnnotateFlight(span);
}

/** Clear a claim key's pending-annotate timeout, if any. */
function clearAnnotateTimeoutForKey(key: string): void {
    const timer = annotatePendingTimers.get(key);
    if (timer !== undefined) {
        clearTimeout(timer);
        annotatePendingTimers.delete(key);
    }
}

/** Clear a span's pending-annotate timeout, if any. */
function clearAnnotateTimeout(span: HTMLElement): void {
    const key = annotateKeyForSpan(span);
    clearAnnotateTimeoutForKey(key);
    const timer = (span as any)._mfAnnotateTimer as ReturnType<typeof setTimeout> | undefined;
    if (timer !== undefined) {
        clearTimeout(timer);
        delete (span as any)._mfAnnotateTimer;
    }
}

/** Reset the pending-annotate state for a claim key immediately (e.g. on timeout or failure). */
function resetAnnotatePendingForKey(key: string): void {
    clearAnnotateTimeoutForKey(key);
    annotatePendingClaims.delete(key);

    const colonIdx = key.indexOf(":");
    const cid = colonIdx !== -1 ? key.slice(0, colonIdx) : "";
    const claimText = colonIdx !== -1 ? key.slice(colonIdx + 1) : "";
    const matchingSpans = Array.from(document.querySelectorAll<HTMLElement>('.mf-segment-claim')).filter(s => {
        return (!cid || s.dataset.mfCid === cid) && (!claimText || s.dataset.claimText === claimText);
    });

    for (const target of matchingSpans) {
        delete (target as any)._mfAnnotateTimer;
        if (spanNeedsAnnotateBadge(target)) {
            const b = target.querySelector(".mf-inline-badge.mf-annotate-badge") as HTMLElement | null;
            if (b) {
                paintAnnotateBadgeContent(b, false);
                (target as any)._mfBadgePermanent = b;
                pinBadgeLayout(b);
                syncClaimBadgeLayout(target);
            } else {
                target.querySelector(".mf-standalone-spinner")?.remove();
                const create = (target as any)._mfCreateBadge as ((permanent: boolean) => HTMLElement) | undefined;
                if (create && !target.querySelector(".mf-inline-badge")) {
                    const newBadge = create(true);
                    target.appendChild(newBadge);
                    pinBadgeLayout(newBadge);
                    syncClaimBadgeLayout(target);
                }
            }
        }
    }
    updateOpenPopover();
}

mfBus.addEventListener('mf-annotate-failed', ((e: CustomEvent) => {
    const detail = e.detail;
    if (!detail) return;
    const key = detail.key || (detail.classificationId && detail.claimText ? `${detail.classificationId}:${detail.claimText}` : null);
    if (key) {
        resetAnnotatePendingForKey(key);
    }
}) as EventListener);

/** Arm the pending-annotate timer for a claim key WITHOUT dispatching a run:
 *  shared by the Flow B tap's window and the Flow A newly-settled seed (see
 *  injectClassifications), which keep their own timeouts. The caller's window
 *  is stored on the span when connected (reconcile clears it); a late key
 *  reconciles through the normal in-place path, which clears pending either
 *  way. A no-op when the key is already pending, so tap and seed never stack
 *  timers. */
function armAnnotatePending(key: string, span: HTMLElement | null, timeoutMs: number): void {
    if (annotatePendingClaims.has(key)) return;
    annotatePendingClaims.add(key);
    clearAnnotateTimeoutForKey(key);

    const timer = setTimeout(() => {
        resetAnnotatePendingForKey(key);
    }, timeoutMs);

    annotatePendingTimers.set(key, timer);
    if (span) {
        (span as any)._mfAnnotateTimer = timer;
    }
}

/** Promote a claim's Flow A seed to the pending set: the span exists and its
 *  dataset still wants the Annotate affordance, so Flow A's run is genuinely
 *  outstanding — "Annotating", not the idle affordance. Same pending set as
 *  the tap (triggerAnnotateForSpan), minus the dispatch: Flow A needs no
 *  second run. Consumes the seed either way, so a keyless claim the seed
 *  misfired on (no run coming) falls back to idle Annotate exactly once
 *  instead of spinning for three minutes. Pending is hover-only like the
 *  classification loading words; every caller owns its own paint (badge
 *  repaint, stand-in, or swap), so this only arms state. A genuine flight
 *  drops the idle button's permanence here — never permanent, so a
 *  pre-existing marked button (a reclassified keyless claim's, promoted
 *  mid-`changed`) can't pin the working state. A misfire returns above with
 *  the marker untouched, so the idle button keeps its permanence.
 *  @returns true when a flight was armed, false on misfire/already-pending. */
function promoteAnnotateSeed(span: HTMLElement): boolean {
    const key = annotateKeyForSpan(span);
    const hadSeed = annotateSeededKeys.has(key);
    clearAnnotateSeed(key);
    // No seed outstanding means no Flow A run is coming for this claim: a
    // freshly linked keyless claim must offer the idle Annotate button, not
    // arm a 3-minute "Annotating" flight. (Two reconcile call sites invoke
    // this ungated on every keyless claim — without this check they mint a
    // pending flight out of nothing, which is the immediate-Annotating bug.)
    if (!hadSeed) return false;
    if (!spanNeedsAnnotateBadge(span) || annotatePendingClaims.has(key)) return false;
    armAnnotatePending(key, span, ANNOTATE_AUTO_PENDING_TIMEOUT_MS);
    delete (span as any)._mfBadgePermanent;
    return true;
}

/** Flow B tap: dispatch the annotations-only run and swap the idle button for
 *  the hover-only pending state (like the classification loading words). The
 *  caller opens the popover (spec: immediately). Safe to call twice: the
 *  pending set dedups, and the background dedups again server-side. A tap
 *  while a Flow A seed is pending opens the popover but launches NOTHING —
 *  Flow A is already annotating this claim; a concurrent Flow B would double
 *  the paid hold and race it on the same key. The background enforces the
 *  same rule (its ongoing-claim marker covers both flows). */
function triggerAnnotateForSpan(target: HTMLElement): void {
    const classificationId = mfCidForSpan(target);
    const claimText = target.dataset.claimText;
    if (!classificationId || !claimText) return;
    const key = `${classificationId}:${claimText}`;
    let badge = target.querySelector(".mf-inline-badge.mf-annotate-badge") as HTMLElement | null;
    if (!badge) {
        const create = (target as any)._mfCreateBadge as ((permanent: boolean) => HTMLElement) | undefined;
        if (create && !target.querySelector(".mf-inline-badge")) {
            badge = create(true);
            target.appendChild(badge);
        }
    }
    if (annotatePendingClaims.has(key)) {
        // Flow A's silent run (or a double tap) is already in flight: keep the
        // pending paint, open the popover via the caller, launch nothing.
        // Pending is hover-only (like the classification loading words), so
        // drop the idle button's permanent marker — the open popover keeps the
        // element alive, and hover/teardown rules own it from here.
        delete (target as any)._mfBadgePermanent;
        if (badge) paintAnnotateBadgeContent(badge, true, target);
        return;
    }
    armAnnotatePending(key, target, ANNOTATE_PENDING_TIMEOUT_MS);
    // The idle button becomes the working state: same hover-only rule — the
    // tap's popover holds the element, teardown/hover own the marker.
    delete (target as any)._mfBadgePermanent;
    if (badge) paintAnnotateBadgeContent(badge, true, target);
    mfBus.dispatchEvent(new CustomEvent('mf-annotate-claim', {
        detail: { classificationId, claimText }
    }));
}

/** Paint an existing badge element as the Annotate affordance (idle "Annotate"
 *  or the pending flight). Shared by the badge factory (fresh spans) and the
 *  in-place reconcile (the factory is out of scope there).
 *
 *  A pending flight shows the claim's own verdict with the spinner on it rather
 *  than the word "Annotating": the verdict is already known — it is why the claim
 *  carries an Annotate affordance at all — so the run only has to add the wheel
 *  and settling only has to take it away again. The `mf-annotate-badge` class
 *  stays on (four call sites look the flight up by it); `VERDICT_BADGE_CLASS`
 *  joins it so the percentage slots keep their hover reveal.
 *
 *  Falls back to the word when the badge is painted without its span. */
function paintAnnotateBadgeContent(badge: HTMLElement, pending: boolean, span?: HTMLElement): void {
    badge.classList.remove(VERDICT_BADGE_CLASS);
    badge.classList.add("mf-annotate-badge");
    badge.style.color = '#ffffff';
    const isRTL = isRTLLocale(getEffectiveUILocale());
    badge.style.marginLeft = isRTL ? '0' : '0.27em';
    badge.style.marginRight = isRTL ? '0.27em' : '0';
    badge.innerHTML = '';
    const s = span;
    const pendingProb = s ? parseFloat(s.dataset.probability ?? "") : NaN;
    if (pending && s && !isNaN(pendingProb)) {
        const rawVer = parseFloat(s.dataset.veracity ?? "");
        badge.classList.add(VERDICT_BADGE_CLASS);
        badge.innerHTML = verdictBadgeHtml(pendingProb, isNaN(rawVer) ? undefined : rawVer, annotateKeyForSpan(s));
        const sp = document.createElement("span");
        sp.className = "mf-fc-spinner";
        sp.style.marginLeft = isRTL ? "0" : "0.27em";
        sp.style.marginRight = isRTL ? "0.27em" : "0";
        if (isRTL) badge.appendChild(sp);
        else badge.insertBefore(sp, badge.firstChild);
    } else if (pending) {
        const sp = document.createElement("span");
        sp.className = "mf-fc-spinner";
        if (isRTL) {
            sp.style.marginRight = "0";
            sp.style.marginLeft = "0.27em";
            badge.appendChild(document.createTextNode(t("annotatingText")));
            badge.appendChild(sp);
        } else {
            badge.appendChild(sp);
            badge.appendChild(document.createTextNode(t("annotatingText")));
        }
    } else {
        badge.textContent = t("annotateButton");
    }
    syncBadgeLoadingClass(badge);
    pinBadgeLayout(badge);
}

/** Loading badges (spinner inside) drop the settled 0.15em optical nudge. */
function syncBadgeLoadingClass(badge: HTMLElement): void {
    badge.classList.toggle("mf-badge-loading", !!badge.querySelector(".mf-fc-spinner"));
    pinBadgeLayout(badge);
}

/** Words in an erroneous substring: at most one renders a diagonal overlay,
 *  longer matches get a per-line horizontal rule that wraps natively. */
function strikethroughWordCount(sub: string): number {
    return sub.trim().split(/\s+/).filter(Boolean).length;
}

/** Stable diagonal slant for a substring (its char codes pick one of two),
 *  so rebuilds don't flip the direction. */
function strikethroughDiagClass(sub: string): string {
    let h = 0;
    for (let i = 0; i < sub.length; i++) h = (h * 31 + sub.charCodeAt(i)) | 0;
    return (h & 1) === 0 ? "mf-diag-a" : "mf-diag-b";
}

/** Fully-opaque false-red for the strike line (a fully confident, fully false
 *  highlight's red without its partial transparency). */
function strikethroughRed(): string {
    const [r, g, b] = verdictColorChannels(1, -1);
    return `rgb(${r},${g},${b})`;
}

/** Fully-opaque false-red for the correction — same red as the strike line (a
 *  fully confident, fully false highlight's red without its partial
 *  transparency). */
function correctionRed(): string {
    return strikethroughRed();
}

/** Parse a bare-locale annotation object into absolute tweet-offset ranges,
 *  longest-pair-first within the painted dict. Ranges index the FULL tweet text,
 *  so callers convert to span-relative. A dict name may be passed to PREFER: when
 *  set, that dict's pairs come first (still longest-first) so the build and
 *  in-place paints follow the resolver's locale-ranked dict instead of each
 *  picking their own.
 *
 *  Only ONE locale paints: the top-ranked dict (the displayed locale via
 *  `prefer`) plus its same-base-language retags (en/en-US share a body).
 *  Ranges from different primary languages index DIFFERENT bodies, so merging
 *  them paints one locale's offsets onto another's text — e.g. the stale
 *  English pair striking a fragment of the Spanish body next to the live
 *  Spanish pair. Dicts for non-displayed languages are never merged in. */
function annotationRanges(annotations: Record<string, Record<string, string>>, prefer?: string): Array<{ s: number; e: number; corr: string }> {
    const dicts = Object.entries(annotations);
    if (dicts.length === 0) return [];
    const uiLocale = getEffectiveUILocale().split('-')[0];
    const scored: Array<{ locale: string; dict: Record<string, string>; score: number }> = [];
    for (const [locale, dict] of dicts) {
        if (!dict || typeof dict !== 'object') continue;
        const pairs = Object.entries(dict);
        const valid = pairs.filter(([k]) => {
            const m = /^(\d+),(\d+)$/.exec(k.trim());
            if (!m) return false;
            const s = Number(m[1]);
            const e = Number(m[2]);
            // `e === s` is a zero-width insertion point — the claim-leading insertion the agent
            // emits under an empty-string key. No renderer draws a strike for it, so it needs no
            // width to survive.
            return Number.isInteger(s) && Number.isInteger(e) && s >= 0 && e >= s;
        });
        if (valid.length === 0) continue;
        let score = 0;
        for (const [k] of valid) {
            const m = /^(\d+),(\d+)$/.exec(k.trim())!;
            score += Number(m[2]) - Number(m[1]);
        }
        scored.push({ locale, dict, score });
    }
    scored.sort((a, b) => {
        if (prefer !== undefined) {
            if (a.locale === prefer && b.locale !== prefer) return -1;
            if (b.locale === prefer && a.locale !== prefer) return 1;
        }
        if (b.score !== a.score) return b.score - a.score;
        if (a.locale === uiLocale && b.locale !== uiLocale) return -1;
        if (b.locale === uiLocale && a.locale !== uiLocale) return 1;
        return 0;
    });
    // Paint ONE locale only: the top-ranked dict plus same-base-language
    // retags (same body, e.g. en/en-US). Anything else indexes a different
    // tweet body and must not merge in.
    const topLocale = scored.length > 0 ? scored[0].locale : null;
    const topBase = topLocale !== null ? topLocale.split('-')[0].toLowerCase() : null;
    const out: Array<{ s: number; e: number; corr: string }> = [];
    for (const { locale, dict } of scored) {
        if (topBase !== null && locale.split('-')[0].toLowerCase() !== topBase) continue;
        const pairs: Array<{ s: number; e: number; corr: string }> = [];
        for (const [k, corr] of Object.entries(dict)) {
            const m = /^(\d+),(\d+)$/.exec(k.trim());
            if (!m) continue;
            const s = Number(m[1]);
            const e = Number(m[2]);
            if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e < s) continue;
            pairs.push({ s, e, corr: String(corr ?? '') });
        }
        pairs.sort((a, b) => ((b.e - b.s) - (a.e - a.s)) || a.s - b.s || a.e - b.e);
        out.push(...pairs);
    }
    // Span-ordered merge against ALL kept ranges: `out` arrives longest-first
    // (not span-ordered), so testing only the last-kept range misreads a
    // disjoint earlier-in-text range as an overlap and drops it. On a true
    // overlap the longer strike still wins, so a shorter correction never
    // nests inside a longer one.
    const overlaps = (a: { s: number; e: number }, b: { s: number; e: number }) => a.s < b.e && b.s < a.e;
    const merged: Array<{ s: number; e: number; corr: string }> = [];
    const insertOrdered = (r: { s: number; e: number; corr: string }) => {
        const at = merged.findIndex(m => m.s > r.s);
        if (at === -1) merged.push(r); else merged.splice(at, 0, r);
    };
    for (const r of out) {
        const clashing = merged.filter(m => overlaps(r, m));
        if (clashing.length === 0) {
            insertOrdered(r);
        } else if (clashing.every(m => (r.e - r.s) > (m.e - m.s))) {
            for (const m of clashing) merged.splice(merged.indexOf(m), 1);
            insertOrdered(r);
        }
        // else: dropped — a shorter (or equal) range inside a kept strike.
    }
    merged.sort((a, b) => a.s - b.s || a.e - b.e);
    return merged;
}

/** Signature of what the inline painter drew, for change detection and the
 *  mfStrike dataset. Span-relative ranges + corrections. */
function strikeSigForRanges(ranges: Array<{ s: number; e: number; corr: string }>): string {
    return JSON.stringify(ranges.map(r => [r.s, r.e, r.corr]));
}

/** Signature of a claim's stored annotations, for claimsEqual. */
function strikethroughSig(claim: Claim): string {
    return claim.annotations ? JSON.stringify(claim.annotations) : '';
}

/** `{[inner]}` is an insert-only correction: keep the keyed substring,
 *  paint `inner` after it, no strikethrough. Ordinary values strike. */
function unwrapInsertOnlyCorrection(corr: string): { text: string; insertOnly: boolean } {
    const raw = String(corr ?? '');
    if (raw.startsWith('{[') && raw.endsWith(']}') && raw.length >= 4) {
        return { text: raw.slice(2, -2), insertOnly: true };
    }
    return { text: raw, insertOnly: false };
}

/** Strip-and-repaint a claim span's inline annotation overlays (range keys, spec
 *  §strikethroughs): red strike + red correction over the highlight. Single
 *  entry point for the build and in-place paths — the "strip first" makes it
 *  idempotent, so no caller tracks whether the span already carries paint.
 *
 *  `text` is the span's plain segment text and `segStart` its offset into the
 *  displayed tweet body; absolute ranges convert to span-relative (pairs fully
 *  outside the span are skipped). Returns the signature of what was drawn (empty
 *  string when nothing — plain text restored, no paint), so callers can record
 *  the mfStrike dataset and detect paint vs. drift. `kept` (badge / stand-in
 *  spinner) is never touched: detached lively nodes are re-attached after the
 *  text rebuild, so the paint never eats the affordance. On an annotated-clean
 *  claim the strip restores the pristine highlight. */
export function repaintInlineAnnotations(
    span: HTMLElement,
    text: string,
    segStart: number,
    annotations: Record<string, Record<string, string>> | undefined,
    kept: HTMLElement[],
    preferDict?: string,
): string {
    for (const el of Array.from(span.childNodes)) {
        if (el instanceof HTMLElement && kept.includes(el)) continue;
        el.remove();
    }
    // An on-hold claim's stored ranges belong to the classification being replaced —
    // the highlight is carrying the plain "Fact-Check" badge precisely because that
    // result no longer matches this text. Painting them leaves a stale strike and its
    // correction over words nothing has re-derived yet, so the paint waits for the
    // click that starts the reclassification. Read live from the dataset, not from the
    // claim, for the same reason every badge predicate does: the span is updated in
    // place as the claim progresses. The strip above still runs, so this is also what
    // clears paint a span was already carrying when it went on hold.
    const onHold = span.dataset.reclassifyOnHold === 'true';
    if (onHold || !annotations || typeof annotations !== 'object') {
        // Append, never insertBefore(kept[0]): callers detach kept nodes first,
        // and a detached node is not a valid reference (throws NotFoundError).
        span.appendChild(document.createTextNode(text));
        for (const k of kept) span.appendChild(k);
        return '';
    }
    const abs = annotationRanges(annotations, preferDict);
    const rel: Array<{ s: number; e: number; corr: string }> = [];
    for (const r of abs) {
        const s = r.s - segStart;
        const e = r.e - segStart;
        // A zero-width range is an insertion point: it has no width to strike and no width
        // that could fall outside the segment, so only its own bounds can disqualify it. Every
        // other non-positive end is a range belonging to text before this segment.
        if (s === e ? s < 0 || s > text.length : e <= 0 || s >= text.length) continue;
        rel.push({ s: Math.max(0, s), e: Math.min(text.length, e), corr: r.corr });
    }
    const sig = strikeSigForRanges(rel);
    const red = strikethroughRed();
    const corrRed = correctionRed();
    let cursor = 0;
    const frag = document.createDocumentFragment();
    for (const r of rel) {
        if (r.s > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, r.s)));
        const sub = text.slice(r.s, r.e);
        const insert = unwrapInsertOnlyCorrection(r.corr);
        if (sub !== '') {
            if (insert.insertOnly) {
                // Insertion point stays in the line; the correction is appended
                // after it with no strikethrough.
                frag.appendChild(document.createTextNode(sub));
            } else {
                const wrap = document.createElement("span");
                wrap.className = "mf-strike";
                wrap.dataset.mfStrike = sub;
                const isWord = strikethroughWordCount(sub) <= 1;
                if (isWord) {
                    const inner = document.createElement("span");
                    inner.textContent = sub;
                    wrap.appendChild(inner);
                    const line = document.createElement("span");
                    line.className = `mf-strike-line ${strikethroughDiagClass(sub)}`;
                    line.style.backgroundColor = red;
                    wrap.appendChild(line);
                    pinStrikeLayout(wrap, inner, line);
                } else {
                    wrap.classList.add("mf-strike-h");
                    const inner = document.createElement("span");
                    inner.textContent = sub;
                    wrap.appendChild(inner);
                    pinStrikeLayout(wrap, inner);
                }
                frag.appendChild(wrap);
            }
        }
        cursor = r.e;
        // Correction sits just after the (struck or kept) substring. `{[…]}`
        // is insert-only: the client trims the brackets and skips the strike.
        if (insert.text !== '') {
            const shown = insert.text;
            // The spaces either side separate the correction from the words next to it — but only
            // where there is a word to separate it from. The struck span leaves the line and the
            // space that followed it does not, so an unconditional trailing space lands beside
            // that one and doubles it. (The popup's `AnnotatedText` and the app's
            // `AnnotatedClaimText` write the same pair; the guard belongs in all three.)
            const padBefore = sub !== '' && !/\s$/.test(sub);
            const padAfter = r.e < text.length && !/\s/.test(text[r.e]);
            const corr = document.createElement("span");
            corr.className = "mf-corr";
            corr.style.color = corrRed;
            pinInline(corr, {
                display: "inline",
                "line-height": "1",
                "vertical-align": "baseline",
                "font-weight": "700",
                "font-family": '"MFKalam", "Segoe Print", "Bradley Hand", "Chalkboard SE", "Marker Felt", "Comic Sans MS", cursive',
                "font-size": "1.12em",
            });
            corr.textContent = `${padBefore ? " " : ""}${shown}${padAfter ? " " : ""}`;
            frag.appendChild(corr);
        }
    }
    if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
    span.appendChild(frag);
    for (const k of kept) span.appendChild(k);
    return sig;
}

/** Resolve a span's classification id for claim-level actions (annotate):
 *  the stamped id, else the legacy article-link fallback. */
function mfCidForSpan(span: HTMLElement): string | null {
    const stamped = span.dataset.mfCid;
    if (stamped) return stamped;
    const article = span.closest('article');
    if (!article) return null;
    const link = article.querySelector<HTMLAnchorElement>('a[href*="/status/"]');
    if (!link) return null;
    const match = link.href.match(/\/status\/(\d+)/);
    return match ? match[1] : null;
}

/** Parse the span's annotation dataset into bare-locale → {range: correction}.
 *  Never throws — a corrupt dataset reads as no annotations. */
function triggerAnnotations(trigger: HTMLElement): Record<string, Record<string, string>> {
    try {
        const parsed = JSON.parse(trigger.dataset.annotations ?? "{}");
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {}
    return {};
}

/** Resolve the annotation dict to show for a trigger: the text locale first (its
 *  ranges index the displayed tweet text), then the UI base language, then the
 *  rest. Keys here are BARE locale prefixes — the background's RevisionGate
 *  already stripped the ":<hash>" revision suffix (unknown revisions dropped),
 *  so the key whose ranges index the displayed body is what's present; the rank
 *  below only orders same-prefix retags and other held locales (X's source/dest
 *  tags drift by region subtag — e.g. filed under "en" while displayed as
 *  "en-US").
 *
 *  Ranges are TWEET-absolute, so they convert to span-relative via the segment
 *  offset the build path stamps (mfSegStart); validation is bounds-checked
 *  against the span's plain text length. The span's plain text comes from
 *  mfPlainText (paint-aware), never trigger.textContent — the latter would
 *  include our own correction nodes and the badge label. Returns the
 *  span-relative pairs alongside the dict and key. */
function resolveTriggerAnnotations(trigger: HTMLElement): { dict: Record<string, string>; key: string; spanText: string; rel: Array<{ s: number; e: number; corr: string }> } | null {
    const all = triggerAnnotations(trigger);
    const keys = Object.keys(all);
    if (keys.length === 0) return null;
    const uiLocale = getEffectiveUILocale();
    const spanText = mfPlainText(trigger);
    const segStartRaw = parseInt(trigger.dataset.mfSegStart ?? "", 10);
    const segStart = isNaN(segStartRaw) ? 0 : segStartRaw;
    // Candidate keys: exact full-locale match first, then same-prefix retags,
    // then the UI base language, then the rest.
    const textLocaleFull = (trigger.dataset.textLocale ?? "").toLowerCase();
    const textLocaleBase = textLocaleFull.split('-')[0];
    const uiBase = uiLocale.split('-')[0].toLowerCase();
    const ordered = [...keys].sort((a, b) => {
        const rank = (k: string) => {
            const kl = k.toLowerCase();
            if (textLocaleFull && kl === textLocaleFull) return 0;
            if (textLocaleBase && kl.split('-')[0] === textLocaleBase) return 1;
            if (kl.split('-')[0] === uiBase) return 2;
            return 3;
        };
        return rank(a) - rank(b);
    });
    for (const k of ordered) {
        const dict = all[k];
        if (!dict || typeof dict !== 'object') continue;
        const entries = Object.entries(dict);
        if (entries.length === 0) {
            // "Annotated, nothing wrong" for a key that addresses this text — keep
            // looking: a LATER key may still hold corrections for it.
            continue;
        }
        // Convert to span-relative and bounds-check against THIS span's plain
        // text: a dict whose ranges don't land inside the span addresses a
        // different revision (or a drifted dataset) and must not paint — the
        // client-side backstop for same-language retags.
        const rel: Array<{ s: number; e: number; corr: string }> = [];
        let ok = true;
        for (const [range, corr] of entries) {
            const parts = range.split(',');
            const s = parseInt(parts[0] ?? "", 10), e = parseInt(parts[1] ?? "", 10);
            if (isNaN(s) || isNaN(e) || s < 0 || e < s) { ok = false; break; }
            const rs = s - segStart, re = e - segStart;
            // Zero-width = an insertion point, as in repaintInlineAnnotations. This resolver
            // fails the WHOLE dict on one range that does not land inside the span, so a
            // claim-leading insertion rejected here would blank every correction the dict has.
            if (rs === re ? rs < 0 || rs > spanText.length : re <= 0 || rs >= spanText.length) { ok = false; break; }
            rel.push({ s: Math.max(0, rs), e: Math.min(spanText.length, re), corr: String(corr ?? '') });
        }
        if (ok) {
            rel.sort((a, b) => a.s - b.s || a.e - b.e);
            return { dict, key: k, spanText, rel };
        }
    }
    // No key holds corrections — but a PRESENT key (even empty) still means
    // "annotated, clean", which suppresses the Annotate button. Report the
    // first key's emptiness rather than absence.
    return keys.length > 0 ? { dict: {}, key: keys[0], spanText, rel: [] } : null;
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

export function updateOpenPopover() {
    console.log(`[updateOpenPopover] running`);
    document.querySelectorAll(".mf-popover").forEach(p => {
        const popover = p as HTMLElement;
        let trigger = (popover as any)._mfTrigger as HTMLElement | undefined;
        if (!trigger) return;

        if (popover.dataset.preview === "true") {
            // The button's window hangs on a stand-in rather than on a claim span, so nothing
            // else re-stamps it as the research streams: pull the claim's current values in
            // before the reads below. No-op for a highlight's own preview.
            syncButtonPreviewTrigger(trigger);
            // A preview's trigger is transient by nature: the claim span a rebuild threw away,
            // or the stand-in span the Fact-Checked button's hover list parks on the claim's
            // rect. A rebuilt-away span is not a departure, though — the pointer is still on
            // the claim it was on, and dismissing here is what made the semi-transparent window
            // blink out as the verdict landed and again when the annotation did. So hand the
            // window to the replacement where there is one. (No `_mfPopoverOpen` goes with it:
            // a preview never carries that flag, and it is the flag's absence that lets
            // dismissPreviewPopover clean the claim up when the pointer finally leaves.)
            if (!trigger.isConnected) {
                const adopted = adoptDetachedPreviewTrigger(popover);
                if (!adopted) {
                    // Nothing to hand it to: the button's stand-in trigger, whose window belongs
                    // to the button's own hover, or a pointer that has left the claim. Only
                    // dismiss what this popover owns — another path's preview is not ours.
                    if (previewPopoverState?.popover === popover) dismissPreviewPopover();
                    return;
                }
                trigger = adopted;
            }
        } else if (!trigger.isConnected) {
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
                    // Same permanence rule as showPopover: only the idle
                    // Annotate button re-attaches permanent; a pending flight
                    // is hover-only like the classification loading words.
                    currentTrigger.querySelector(".mf-standalone-spinner")?.remove();
                    currentTrigger.appendChild((currentTrigger as any)._mfCreateBadge(currentTrigger.dataset.reclassifyOnHold === "true" || spanWantsIdleAnnotate(currentTrigger)));
                    // The replacement's badge can wrap on insertion, growing the trigger
                    // under its own window — same nudge as the reveal's settle.
                    shiftPopoverBelowBadge(currentTrigger);
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
export function findGrokRow(article: Element): { row: HTMLElement; btn: HTMLElement } | null {
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
    if (grokWrapper?.parentElement) return grokWrapper.parentElement as HTMLElement;

    const caretBtn = article.querySelector<HTMLElement>('button[data-testid="caret"]');
    if (caretBtn?.parentElement?.parentElement) return caretBtn.parentElement.parentElement as HTMLElement;

    const moreBtn = article.querySelector<HTMLElement>('button[aria-label*="More"]');
    if (moreBtn?.parentElement?.parentElement) return moreBtn.parentElement.parentElement as HTMLElement;

    const header = article.querySelector<HTMLElement>('[data-testid="User-Name"]');
    if (header && header.children.length > 1) return header.lastElementChild as HTMLElement;

    return null;
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
function createDisinfactLogoSvg(hoisted: boolean = false): SVGSVGElement {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    // 13px matches the label (`fontSize: 13px`) so the mark is the same height as
    // "Disinfact" and `align-items: center` on the wrap can actually center it.
    // The old 16px box + `marginTop: -5px` is what sat the bottle on the text
    // baseline and stretched the header (the extra 3px plus the pill's vertical
    // padding is Image #15).
    svg.setAttribute("width", "13");
    svg.setAttribute("height", "13");
    svg.setAttribute("viewBox", "0 0 128 128");
    svg.setAttribute("fill", "none");
    svg.style.flexShrink = "0";
    svg.style.display = "block";
    // Inside a button, translateY(-0.5px) aligns with the baseline of 13px type.
    // When hoisted in the enclosing area, translateY(0) optically centers it in the pill.
    svg.style.transform = hoisted ? "translateY(0)" : "translateY(-0.5px)";
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
/** Place a post's button container on whichever platform this document is.
 *
 *  `time` and `grokData` are X's placement anchors and are only consulted on X — the
 *  adapter finds its own anchors, because the *reason* X falls back from an action row
 *  to a Grok row to the timestamp does not generalise to a forum comment or a chat
 *  message. Call sites pass both so the X path stays byte-identical. */
export function placePostButtons(
    container: HTMLElement,
    root: Element,
    ref: PostRef,
    time: Element,
    grokData: { row: HTMLElement } | null,
): void {
    const seam = platformSeam();
    if (seam) {
        // Buttons keep full priority against the author cluster, exactly as on X: without
        // this the row's own shrinking would clip our labels at an arbitrary point with no
        // relation to how much the header overflowed, and `applyTopButtonSqueeze` would
        // never see a crush to respond to (both items would shrink in proportion). With
        // the container rigid, the cluster takes the whole shortfall, the squeeze pass
        // reads it, and the labels give way deliberately — right-to-left, down to a
        // 24px floor, never below.
        container.style.flexShrink = '0';
        // The squeeze-recovery wiring belongs to the button, not to the first set of
        // claims: a label capped in a narrow window has to snap back when the space
        // returns, and on these platforms that can happen long before any post on the
        // page has been fact-checked.
        setupSqueezeRecovery();
        seam.placeButtons(container, root, ref);
        return;
    }
    placeButtonContainer(container, root, time, grokData);
}

export function placeButtonContainer(container: HTMLElement, article: Element, time: Element, grokData: { row: HTMLElement } | null) {
    const MF_BTN_GAP = currentBtnGap();
    // On narrow screens tighten BOTH sides: only one of them carries the gap below, and the
    // other side still inherits the row's 8px, so leaving it untouched would look lopsided.
    if (window.innerWidth <= MF_NARROW_MAX_WIDTH) {
        container.style.marginLeft = MF_BTN_GAP_NARROW;
        container.style.marginRight = MF_BTN_GAP_NARROW;
    }
    // Full priority against X's shrinking name/handle: without this the Grok cluster
    // (flex item, min-width:0 via the classes we copy) compresses our pill and the
    // label ellipsizes while a gap opens to the left — Image #12.
    container.style.flexShrink = '0';
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
    updateTopButtonSqueeze(article);
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
const printContainerOriginalStyle = new Map<HTMLElement, string>();
const printContainersAdded = new Set<HTMLElement>();
const printRefreshHidden = new Set<HTMLElement>();

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

    // 1b. Hide standalone refresh + Reveal/Hide buttons while printing — the
    // button area reads as the "DisinfaX" label (step 2), and an icon or toggle
    // next to it would leak chrome into the capture. Restored verbatim on afterprint.
    for (const r of Array.from(document.querySelectorAll<HTMLElement>('[mf-top-bar-id], [mf-refresh-id], [mf-visual-id]'))) {
        printRefreshHidden.add(r);
        r.style.display = "none";
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

        const existing = article.querySelector<HTMLElement>(`[mf-top-bar-id="${classification.id}"], [mf-on-hold-id="${classification.id}"]`);
        if (existing) {
            printContainerOriginalHTML.set(existing, existing.innerHTML);
            printContainerOriginalStyle.set(existing, existing.style.cssText);
            const innerClass = existing.querySelector('div[dir="ltr"]')?.className ?? "";
            existing.innerHTML = "";
            existing.style.display = "";
            existing.style.backgroundColor = "transparent";
            existing.style.boxShadow = "none";
            existing.style.padding = "0";
            existing.appendChild(buildPrintLabel(innerClass));
            continue;
        }

        const container = document.createElement("div");
        container.classList.add("mf-btn-container");
        container.setAttribute("mf-top-bar-id", classification.id);
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
        // This loop selected the article whose *main* post is this classification
        // (getArticleMainStatusId above), so it is never the quoted card.
        placePostButtons(container, article, { id: classification.id }, time, grokData);
        printContainersAdded.add(container);
    }
}

function exitPrintMode() {
    for (const badge of printBadgesAdded) badge.remove();
    printBadgesAdded.clear();

    for (const [container, html] of printContainerOriginalHTML) {
        container.innerHTML = html;
        const origStyle = printContainerOriginalStyle.get(container);
        if (origStyle !== undefined) container.style.cssText = origStyle;
    }
    printContainerOriginalHTML.clear();
    printContainerOriginalStyle.clear();

    for (const container of printContainersAdded) container.remove();
    printContainersAdded.clear();

    for (const r of printRefreshHidden) r.style.display = "";
    printRefreshHidden.clear();
    // Print mode swaps container HTML wholesale; re-run the squeezer on every
    // article still holding a button so no stale max-width cap survives.
    for (const slot of Array.from(document.querySelectorAll<HTMLElement>('[mf-top-bar-id], [mf-on-hold-id], [translate-fc-id], [mf-refresh-id], [mf-visual-id]'))) {
        const article = slot.closest('article');
        if (article) updateTopButtonSqueeze(article);
    }
}

// ── Top-of-tweet batch refresh ──────────────────────────────────────────────
// The "re-reveal this tweet's claims" action (mf-refresh-batch) used to sit on the
// claim row inside the popover; it now lives at the top of the tweet instead. Two
// variants share one builder: beside Fact-Check All while that container is present
// (built inline by injectOnHoldButton), and alone in the same slot once the tweet is
// fully resolved (synced by syncBatchRefreshButton below). Neither is ever shown next
// to a Disinfact button — on-hold or translate variant — since that button IS the
// pending action. The reasoning refresh inside the popover is a different action
// (mf-refresh-claim) and is untouched.
// Clicking either variant removes the button at once and shows the wheel
// optimistically (transient in the kept standalone container, pre-existing in the
// beside wrap); the preclassifying broadcast then reconciles to the spinner state,
// and a 30s revert restores a clickable button if no broadcast ever arrives.

/** Icon SVG for the top-of-tweet refresh (same arrows as the old in-popover one). */
const TOP_BATCH_REFRESH_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>`;

/** Progressive truncation for the text-carrying top-of-tweet buttons (Disinfact,
 *  Fact-Check All, translate-labeled Disinfact — never the icon-only refresh).
 *  When the header row runs out of room, the label clamps from the RIGHT
 *  (ellipsis) while the logo stays fully visible, through intermediaries
 *  (e.g. Disinfact → Disinf… → Disi…). All three tiers are inline so X's row
 *  styles can't override them:
 *  the label's `max-width` cap is the knob `updateTopButtonSqueeze` turns, and
 *  `overflow-x: clip` (not `hidden`) avoids creating a scroll container.
 *
 *  The onboarding exemption is enforced at update time, not here: while the
 *  button's onboarding popover is showing, `updateTopButtonSqueeze` skips it
 *  entirely so the callout always points at the full, uncut button. */
function markTopButtonSqueezable(btn: HTMLButtonElement, label: HTMLElement) {
    label.classList.add('mf-topbtn-label');
    label.style.overflowX = 'clip';
    label.style.textOverflow = 'ellipsis';
    label.style.whiteSpace = 'nowrap';
    // The label is a flex item of its text-wrap div: without this, min-width:auto
    // refuses to shrink below content size and the maxWidth cap below does nothing.
    label.style.minWidth = '0';
    // Natural size by default; the squeezer only ever writes maxWidth.
    label.style.maxWidth = 'none';
    (btn as any)._mfTopBtnLabel = label;
}

/** Re-evaluate truncation for every squeezed top button in `article`'s header row.
 *  Called on resize (global handler), after each injection pass into the article,
 *  and when a standalone onboarding popover opens/closes (exemption flip).
 *
 *  Policy: buttons keep full priority — they only start truncating once the header
 *  is genuinely overflowing, and then they give way progressively, logo last.
 *  A button whose onboarding popover is currently showing is skipped, so the
 *  callout always anchors to the full label the copy describes.
 *
 *  Inject runs `placeButtonContainer` (and this) in the same turn the node is
 *  inserted; the Grok cluster's flex width is often still 0 then, so a sync
 *  measure writes a crop that sticks — our own insert is filtered out of the
 *  MutationObserver, so the 300ms host-heal never runs for page-load inject
 *  (theme toggles re-render X's DOM and do). Double rAF waits for that first
 *  layout; a coalesced 300ms trail catches fonts / X's own handle-ellipsis
 *  applying a frame later. */
const squeezeSoon = new Set<Element>();
const squeezeTrail = new Set<Element>();
let squeezeRaf = 0;
let squeezeTimer = 0;
function updateTopButtonSqueeze(article: Element) {
    squeezeSoon.add(article);
    squeezeTrail.add(article);
    if (!squeezeRaf) {
        squeezeRaf = requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                squeezeRaf = 0;
                const batch = Array.from(squeezeSoon);
                squeezeSoon.clear();
                for (const a of batch) applyTopButtonSqueeze(a);
            });
        });
    }
    if (!squeezeTimer) {
        squeezeTimer = window.setTimeout(() => {
            squeezeTimer = 0;
            const batch = Array.from(squeezeTrail);
            squeezeTrail.clear();
            for (const a of batch) applyTopButtonSqueeze(a);
        }, 300);
    }
}

/** Laid-out width of `el` if flex weren't shrinking it. `max-content` + bounding
 *  rect, not scrollWidth: X's a11y copy inside verified badges inflates scrollWidth
 *  (Image #42/#44). `hide` is taken out of flow so a timestamp-fallback button
 *  inside the cluster isn't counted twice. */
function measureUnconstrainedWidth(el: HTMLElement, hide?: HTMLElement | null): number {
    const prevHide = hide ? hide.style.display : '';
    if (hide) hide.style.display = 'none';
    const prevWidth = el.style.width;
    const prevMin = el.style.minWidth;
    const prevMax = el.style.maxWidth;
    const prevFlex = el.style.flexShrink;
    el.style.width = 'max-content';
    el.style.minWidth = 'max-content';
    el.style.maxWidth = 'none';
    el.style.flexShrink = '0';
    const w = el.getBoundingClientRect().width;
    el.style.width = prevWidth;
    el.style.minWidth = prevMin;
    el.style.maxWidth = prevMax;
    el.style.flexShrink = prevFlex;
    if (hide) hide.style.display = prevHide;
    return w;
}

/** The author cluster a DOM-fed platform's header row puts opposite our buttons.
 *
 *  The adapter's `placeButtons` puts the container in the post's header ROW, so the
 *  thing that shrinks when the row runs out of room is one of that row's other children
 *  — the [name][handle][time] cluster on Bluesky. Widest-wins rather than
 *  first-child-wins: the cluster is by far the widest thing in a header band, so a
 *  platform that also parks a small control in the same row (a menu, a follow button)
 *  still has its shrinkable element measured. A row whose other children are all
 *  unshrinkable is a safe miss — an unshrinkable element measures natural === visible,
 *  so the crush reads 0 and nothing is capped. */
function squeezableCluster(row: Element, container: Element): HTMLElement | null {
    let widest: HTMLElement | null = null;
    let widestW = -1;
    for (const child of Array.from(row.children)) {
        if (child === container) continue;
        const w = child.getBoundingClientRect().width;
        if (w > widestW) {
            widestW = w;
            widest = child as HTMLElement;
        }
    }
    return widest;
}

/** Whether the buttons and the row's other children are laid out on ONE line — the only
 *  arrangement in which our buttons can be the reason the author cluster is short of room.
 *
 *  A block-level bar in a block parent has a line to itself: every block child of a block
 *  box is sized to that box's width whether or not its siblings exist, so nothing it does
 *  can shrink them, and the max-content deficit such a sibling reports is its own
 *  line-breaking rather than a crush we caused. Telegram's messages without a sender line
 *  are exactly this shape — measured live, `.content-inner` is `display: block` and our
 *  bar, the media block and the body are three 448px-wide blocks stacked in it — and the
 *  media block's 304px phantom deficit capped the label to 35px of its natural 58 on a row
 *  with nothing beside it. A float is the opposite case and keeps its squeeze wherever it
 *  was put: the line boxes beside a float really do give way to it, which is how the
 *  comment-surface adapters park their buttons. */
function buttonsShareRowLine(row: Element, container: Element): boolean {
    const buttonStyle = getComputedStyle(container);
    if (buttonStyle.float !== 'none') return true;
    // An inline-level bar sits in a line box with whatever is beside it, so it always
    // competes; only a block-level one can be alone on its line, and even then only when
    // the parent is not laying its children out across one line.
    if (buttonStyle.display.startsWith('inline')) return true;
    const rowDisplay = getComputedStyle(row).display;
    return rowDisplay === 'flex' || rowDisplay === 'inline-flex'
        || rowDisplay === 'grid' || rowDisplay === 'inline-grid';
}

/** Smallest space, in px, that truncating a label has to give back to the header
 *  before it is allowed to. Below this the label is left at its natural width — see
 *  the cap loop in `applyTopButtonSqueeze`. */
const MIN_SQUEEZE_GAIN = 6;

/** Least room, in px, worth keeping a label for when a host has measured the space it
 *  left for the bar (`mf-seat-width`). Under this a label fits a letter and an ellipsis
 *  and nothing else, so a button that carries its own mark stands as the mark instead —
 *  the label is then the button's accessible name rather than its visible one. */
const MIN_SEAT_LABEL_WIDTH = 48;

function applyTopButtonSqueeze(article: Element) {
    if (!article.isConnected) return;
    // The bar that BELONGS to this article, not the first bar inside it, because a root can hold
    // another root's markup — the mobile Facebook story view is one scroller carrying the story
    // AND every comment under it, each comment with a pill of its own. The first bar in that
    // subtree is a comment's, and the re-seat below MOVES it (placeButtons appends the container
    // to the root it is handed and seats it there): measured on a live story view, four pills of
    // one comment's id sitting on the story's scroller, that comment left with none, and its name
    // answering on a root that is not its own. The article's own id is what the injector keyed the
    // bar with, so it selects exactly the one that belongs here. A page with no seam (X) keeps the
    // lookup it had: its key is the status id and `postIdOf` is not what named the bar.
    const ownId = platformSeam()?.postIdOf(article) ?? null;
    const own = ownId ? cssAttrValue(ownId) : null;
    const container = article.querySelector<HTMLElement>(
        own
            ? `[mf-top-bar-id="${own}"], [mf-on-hold-id="${own}"], [translate-fc-id="${own}"], [mf-refresh-id="${own}"], [mf-visual-id="${own}"]`
            : '[mf-top-bar-id], [mf-on-hold-id], [translate-fc-id], [mf-refresh-id], [mf-visual-id]'
    );
    if (!container) return;
    // A bar the host measured room for (`mf-seat-width`) is capped by that room, not by the
    // author cluster's crush: the seat is not a row we share with the cluster, so there is
    // nothing to give way to — and the clear loop below would wipe the seat cap on the very
    // next frame. The seat cap is the authority there, and this is where it gets refreshed.
    if (container.dataset.mfSeatWidth !== undefined) {
        // Asked again, every pass, by the adapter that MEASURED this seat. The host finishes
        // laying its own header out after the first measurement — a story's Join control, or the
        // header of the post it shares, can land in the band the seat was chosen from a frame or
        // more later — and a seat is only ever chosen from the DOM, so it has to be chosen again
        // while the DOM is still settling. This runs from the row observer and the interval that
        // already watch these bars, which is what makes the seat follow the host. It also frees a
        // bar whose story had no box when it was built (`-1`): the same pass seats it the moment
        // that story has a size. The measuring itself stays in the adapter, which is the only
        // thing that knows how to do it.
        const seam = platformSeam();
        if (seam) seam.placeButtons(container, article, { id: container.getAttribute('mf-top-bar-id') ?? '' });
        applySeatCap(container);
        return;
    }
    const row = container.parentElement;
    if (!row) return;

    const btns: HTMLButtonElement[] = [];
    const all: HTMLButtonElement[] = [];
    for (const b of Array.from(container.querySelectorAll<HTMLElement>('button[data-mf-charge], button[data-mf-visual]'))) {
        const label = (b as any)._mfTopBtnLabel as HTMLElement | undefined;
        if (!label || !label.isConnected) continue;
        all.push(b as HTMLButtonElement);
        // Onboarding exemption: a button whose OWN onboarding popover is currently
        // showing keeps its full label, so the callout always anchors to the full
        // label the copy describes. Each anchor's popover is built from its own
        // data-mf-charge, so own-type is the check.
        const pop = onboardingByAnchor.get(b);
        const charge = b.dataset.mfCharge ?? '';
        if (pop && pop.isConnected && onboardingActive(charge)) continue; // onboarding: full label
        btns.push(b as HTMLButtonElement);
    }
    if (all.length === 0) return;
    // Clear caps on EVERYTHING first — including newly-exempt buttons, which must
    // snap back to full width. A previous squeeze pass (e.g. at injection time,
    // before the popover opened) would otherwise leave a stale cap keeping the
    // button truncated while its popover shows. Caps are re-applied from scratch
    // after measuring, so the baseline reflects natural widths and never ratchets
    // downward on repeat calls.
    for (const b of all) ((b as any)._mfTopBtnLabel as HTMLElement).style.maxWidth = 'none';

    // Nothing to answer where the buttons are not on the author cluster's line in the
    // first place — see `buttonsShareRowLine`. The caps are cleared above and nothing is
    // written here, which is the right resting state for such an article: the labels sit
    // at their natural width however the row has been laid out around them.
    if (!buttonsShareRowLine(row, container)) return;

    // The header band and the author cluster inside it. On X the cluster is the
    // User-Name block, found by testid. On a DOM-fed platform `article` IS the post root
    // and the adapter has already put our container in the post's own header row as a
    // sibling of the author cluster, so the row is the header and the cluster is the
    // widest of its other children — see `squeezableCluster`. The crush test below is
    // then platform-neutral, which is the point: the rule the labels obey is "give way
    // once the header is genuinely overflowing", and it holds on every platform.
    const seam = platformSeam();
    const userName = seam ? null : article.querySelector<HTMLElement>('[data-testid="User-Name"]');
    const header = seam
        ? row as HTMLElement
        : (userName && row && !userName.contains(row) && userName.parentElement?.contains(row))
            ? userName.parentElement as HTMLElement
            : (userName ?? row);
    if (!header || header.clientWidth === 0) return;

    const userCluster = seam
        ? squeezableCluster(row, container)
        : ((userName?.firstElementChild as HTMLElement | null)
            ?? (header.firstElementChild as HTMLElement | null));

    const headerRect = header.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const headerGap = parseFloat(getComputedStyle(header).columnGap || getComputedStyle(header).gap || '0') || 0;
    const userRect = (userCluster && userCluster !== container && !userCluster.contains(container))
        ? userCluster.getBoundingClientRect()
        : null;
    const leftover = userRect ? (containerRect.left - userRect.right - headerGap) : 0;
    const hideInsideUser = userCluster && userCluster.contains(container) ? container : null;
    const naturalUserW = userCluster
        ? measureUnconstrainedWidth(userCluster, hideInsideUser)
        : 0;
    const actionEl = (row !== header && row !== userCluster) ? row : container;
    const actionWidth = actionEl.getBoundingClientRect().width;

    const userVisibleW = userRect ? userRect.width : -1;
    const crushed = userRect ? (naturalUserW - userVisibleW) : 0;

    // Crush-driven policy: the username's own crushed deficit (natural minus
    // visible) is the only signal we trust. Uncrushed name → never squeeze —
    // any "overflow" the old arithmetic reported in that state was phantom
    // (header measured as the User-Name block vs the row, container.right -
    // header.right, ...). This subsumes both the old ample-guard and the
    // Kalshi/BBC far-guard case without blocking real squeezes: after X
    // ellipsizes the name, space-between reopens the gap (the WSJ "Th..."
    // case: 90-130px crush with 30-48px leftover), and that state must squeeze.
    if (!userRect || crushed <= 1) return;

    // Proportional policy: each label gives way by the same FRACTION the author
    // cluster lost, instead of absorbing the whole deficit. Taking the whole
    // deficit let a single button soak up the entire crush down to the 24px floor
    // ("D…") while the header showed a merely elided handle — the button read as
    // destroyed and the row as barely compressed, which is backwards: the header
    // must not lose priority to the buttons. A shared fraction keeps the two in
    // step (header down a quarter → labels down a quarter, header and handle
    // eliding together), and the floor only engages when the row is genuinely out
    // of room. The 0.9 clamp keeps the floor as the last word, so no label is ever
    // squeezed to nothing however extreme the crush.
    const loss = Math.min(0.9, crushed / naturalUserW);
    const keep = 1 - loss;
    const measured = btns.map((b) => {
        const label = (b as any)._mfTopBtnLabel as HTMLElement;
        return { label, full: label.getBoundingClientRect().width };
    });
    for (const { label, full } of measured) {
        // Keep enough width for a letter + ellipsis (e.g. "Disinf…") instead of
        // collapsing the label to 0 / logo-only in one hop.
        const minLabelWidth = 24;
        const cap = Math.max(minLabelWidth, full * keep);
        // A cap is only worth writing when it hands the row back a real amount of
        // space. `text-overflow: ellipsis` fires on ANY deficit, down to a fraction
        // of a pixel, so a header that is merely rounding-level over (measured live
        // on Bluesky: 571px of content in a 568px row, a 3px crush across three
        // buttons) turned "Hide" into "Hi…" and "Fact-Check All" into
        // "Fact-Check…" — labels destroyed to buy back 0.4px each, while the host's
        // own handle ellipsis absorbs the whole deficit anyway. Staying at the
        // natural width there keeps every label legible and leaves the row exactly
        // as the platform would have laid it out without us.
        if (full - cap < MIN_SQUEEZE_GAIN) continue;
        label.style.maxWidth = `${cap}px`;
    }
}

/** Answer for the room a host measured and handed over (`mf-seat-width`), for bars whose
 *  seat is not a row we share with the author cluster but a window the host itself left.
 *
 *  The mobile Facebook story header is packed end to end: avatar, name, a localized
 *  Join/Follow, a meta line, and the app's own `…`, with a free window at the end of the
 *  first line that measured 0..56px against the 88px a labelled pill needs. So a labelled
 *  pill cannot be seated there at all, and capping the labels the way a squeezed desktop
 *  row does would show "D…" on every story. Under `MIN_SEAT_LABEL_WIDTH` a button that
 *  carries its own mark drops the words and stands as the mark, with the label kept as its
 *  accessible name; otherwise the labels share the room evenly. Nothing is ever drawn
 *  outside the measured window: a label wide enough to overhang is capped rather than
 *  allowed to cover the host's own row.
 *
 *  Called on every sync pass as well as at build time, because the host finishes laying its
 *  header out after we first measure it — a Join control that appears a frame later moves
 *  the window, and the cap has to follow the window, not the labels that were capped for
 *  the old one. */
function applySeatCap(container: HTMLElement) {
    const raw = container.dataset.mfSeatWidth;
    if (raw === undefined) return;
    // A measured ZERO is a measurement like any other — the header left no room at all — and it
    // is answered the same way. Treating it as "unmeasured" is what let an 88px labelled pill be
    // drawn into a window that had just been measured as empty.
    const seatWidth = Number(raw);
    if (!Number.isFinite(seatWidth) || seatWidth < 0) return;
    const labels = Array.from(container.querySelectorAll<HTMLElement>('.mf-topbtn-label'));
    if (!labels.length) return;
    // Measure from natural widths, so a repeat call cannot ratchet a cap downward, and
    // bring back any label a previous pass stood down as a mark — the window can widen.
    for (const label of labels) {
        label.style.maxWidth = 'none';
        label.style.display = '';
    }
    const chrome = container.getBoundingClientRect().width
        - labels.reduce((n, l) => n + l.getBoundingClientRect().width, 0);
    const room = Math.max(0, seatWidth - chrome);
    const share = Math.max(8, Math.floor(room / labels.length));
    const tight = room < MIN_SEAT_LABEL_WIDTH * labels.length;
    for (const label of labels) {
        const btn = label.closest('button');
        // A word this bar is about to show for the first time may never have resolved: the
        // label is written once, at build, in whichever content-script world handled the
        // injection — and on this host a dead world writes its raw key (see
        // `repairUnresolvedLabels`, whose watcher heals it a frame later, invisibly, while the
        // label sits hidden behind the mark). Revealing it would show "disinfactButton" as the
        // button's name. So resolve it here first, and if this world cannot either, keep
        // standing as the mark until one that can has healed the text.
        const text = (label.textContent ?? '').trim();
        if (CATALOG_KEY_SHAPE.test(text)) {
            const resolved = t(text);
            if (resolved === text) {
                label.style.display = 'none';
                continue;
            }
            label.textContent = resolved;
        }
        // Under MIN_SEAT_LABEL_WIDTH per label a word fits a letter and an ellipsis and
        // nothing else, so a button carrying its own mark stands as the mark and keeps the
        // word as its accessible name. A button with no mark has nothing to stand on and
        // takes the share instead — the bar is never wider than the room it was given.
        if (tight && btn?.querySelector('svg')) {
            btn.title = label.textContent ?? '';
            btn.setAttribute('aria-label', label.textContent ?? '');
            label.style.display = 'none';
            continue;
        }
        label.style.maxWidth = `${share}px`;
    }
}

/** Visible pill chrome + hover affordance for the top-of-tweet buttons (Disinfact,
 *  Fact-Check All, translate-labeled Disinfact, refresh icon). They inherit X's row
 *  className so they sit naturally in the row, but that class carries no button
 *  chrome of its own — without this they read as plain text next to Grok's
 *  identical-looking row items. The gray matches the row text color X uses
 *  (rgb(83, 100, 113)) so it reads on both light and dark themes.
 *
 *  `initialTint` is the Reveal/Hide verdict summary: per the design it is NOT
 *  hover chrome — it is the button's persistent background. The normal/hover
 *  paint closures below deliberately ignore it (the tint must survive any mouse
 *  pass untouched), and `_mfTopBtnSetTint` swaps it later WITHOUT re-entering
 *  this function: a verdict that lands while the reader is hovering the pill
 *  repaints that same element, where rebuilding the button would drop it out
 *  from under the pointer mid-click. Re-calling this function is not an option
 *  — it would stack a second pair of mouseenter/mouseleave listeners. */
function styleTopTweetButton(
    btn: HTMLButtonElement,
    iconOnly: boolean,
    initialTint?: { bg: string; hoverBg: string } | null,
    textBlack?: boolean
) {
    let tint = initialTint ?? undefined;
    // Ring is an inset shadow, not a border: a 1px border + 3px vertical padding
    // on top of 13px type is what pushed the tweet body down (Image #15). Zero
    // vertical padding keeps the pill the same height as Grok / the timestamp.
    btn.style.border = "none";
    btn.style.borderRadius = "999px";
    // A Reveal/Hide verdict tint paints over the gray default and its own ring;
    // otherwise the standard gray pill.
    btn.style.backgroundColor = tint?.bg ?? "rgba(83, 100, 113, 0.08)";
    btn.style.boxShadow = tint?.bg
        ? `inset 0 0 0 1px ${tint.bg}`
        : "inset 0 0 0 1px rgba(83, 100, 113, 0.35)";
    btn.style.padding = iconOnly ? "0 8px" : "0 10px";
    btn.style.lineHeight = "1";
    btn.style.height = "20px";
    btn.style.minHeight = "20px";
    btn.style.boxSizing = "border-box";
    btn.style.display = "inline-flex";
    btn.style.alignItems = "center";
    btn.style.justifyContent = "center";
    btn.style.flexShrink = "0";
    btn.style.alignSelf = "center";
    btn.style.transition = "background-color 120ms ease, box-shadow 120ms ease";
    if (textBlack) btn.style.color = "#000";

    const paintNormal = () => {
        if (tint) {
            btn.style.backgroundColor = tint.bg;
            btn.style.boxShadow = `inset 0 0 0 1px ${tint.bg}`;
            if (textBlack) btn.style.color = "#000";
            return;
        }
        btn.style.backgroundColor = "rgba(83, 100, 113, 0.08)";
        btn.style.boxShadow = "inset 0 0 0 1px rgba(83, 100, 113, 0.35)";
        btn.style.color = "rgb(83, 100, 113)";
    };
    const paintHover = () => {
        // Tinted buttons strengthen their own verdict fill on hover instead of
        // swapping to gray — the tint must survive any mouse pass untouched.
        if (tint) {
            btn.style.backgroundColor = tint.hoverBg;
            btn.style.boxShadow = `inset 0 0 0 1px ${tint.hoverBg}`;
            if (textBlack) btn.style.color = "#000";
            return;
        }
        btn.style.backgroundColor = "rgba(83, 100, 113, 0.16)";
        btn.style.boxShadow = "inset 0 0 0 1px rgba(83, 100, 113, 0.6)";
    };
    // Reused by click handlers that disable the button mid-hover: a disabled
    // button stops firing mouse events, so the mouseleave below would never run
    // and the hover tint would stick on the dimmed button.
    (btn as any)._mfTopBtnNormal = paintNormal;
    // Tracked rather than read back off :hover: the synthetic enter the browser
    // replays after a DOM change is not a real pointer position, and this button
    // must not need one to keep the fill it already has.
    let hovered = false;
    btn.addEventListener("mouseenter", () => {
        hovered = true;
        if (isTouchInput() || btn.disabled) return;
        paintHover();
    });
    btn.addEventListener("mouseleave", () => {
        hovered = false;
        if (btn.disabled) return;
        paintNormal();
    });
    // A verdict that arrives after the button was built repaints it where it
    // stands. The caller owns the text wrap's colour and the dataset marker; this
    // only owns the chrome it painted.
    (btn as any)._mfTopBtnSetTint = (next: { bg: string; hoverBg: string } | null | undefined) => {
        tint = next ?? undefined;
        if (hovered && !btn.disabled && !isTouchInput()) paintHover();
        else paintNormal();
    };
}

/** A claim participates in the Reveal/Hide verdict tint only when it carries a
 *  verdict — the tint must hint at the tweet's veracity, never at a claim with
 *  nothing to say. Mirrors the thresholds highlightBgColor uses: neutral below
 *  confidence 0.2.
 *
 *  A re-check in flight does NOT revoke this, for the same reason
 *  bypassEligibleClaim ignores it: the gates below already demand a verdict, so
 *  the flag can only ever veto a claim that has one, and it is the single input
 *  here that moves with no reader action at all. Left in, it recoloured the pill
 *  on every pass of a run the reader never touched. */
function tintEligibleClaim(cl: Claim): boolean {
    if (cl.confidence === undefined || cl.confidence === null) return false;
    if (cl.veracity === undefined || cl.veracity === null) return false;
    return cl.confidence >= 0.2;
}

/** Average verdict tint for a tweet's eligible claims (rounded per channel), at
 *  resting and hover opacity. Null when no claim is eligible — the button then
 *  renders as the standard gray pill. */
function averageVerdictTint(claims: Claim[] | null | undefined): { bg: string; hoverBg: string } | null {
    const eligible = (claims ?? []).filter(tintEligibleClaim);
    if (eligible.length === 0) return null;
    let r = 0, g = 0, b = 0;
    for (const cl of eligible) {
        const [cr, cg, cb] = verdictColorChannels(cl.confidence, cl.veracity);
        r += cr; g += cg; b += cb;
    }
    r = Math.round(r / eligible.length);
    g = Math.round(g / eligible.length);
    b = Math.round(b / eligible.length);
    return { bg: `rgba(${r}, ${g}, ${b}, 0.25)`, hoverBg: `rgba(${r}, ${g}, ${b}, 0.5)` };
}

/** The Reveal pill's own verdict tint, defined once so the bar's tint signature and
 *  the button's paint can never disagree: averaged over the tweet's claims, and only
 *  while the visuals are hidden behind the Reveal button. */
function pillVerdictTint(isReveal: boolean, claims: Claim[] | null | undefined): { bg: string; hoverBg: string } | null {
    return isReveal ? averageVerdictTint(claims) : null;
}

/** True when the tweet's cached preclassification visuals are hidden from view —
 *  revealed only via the Reveal button. The revealed set wins. The caller is
 *  responsible for main-tweet-only scoping (matching every other visual-gating
 *  call site); this stays a pure state lookup so the Hide button's own toggle
 *  click can reuse it for the article it already holds. */
function visualsHiddenFor(tweetId: string, claims: Claim[] | null | undefined): boolean {
    if (revealedVisualIds.has(tweetId)) return false;
    if (hiddenVisualIds.has(tweetId)) return true;
    if (!claims || claims.length === 0) return false;
    // Cached preclassification (DB hit, or the user's own earlier click) with no
    // engagement on any top-of-tweet action this session defaults to hidden.
    //
    // Only the user's own clicks count. `processingOnHoldIds` and
    // `processingTranslateFactChecksIds` are UI state our OWN injection writes: a tweet
    // with pending Disinfact claims is put into `processingOnHoldIds` by the pass that
    // builds its container (and by syncTopButtonBar), and the next pass clears it at the
    // top before the container check decides whether to put it back. Counting those as
    // engagement made this verdict alternate between passes — highlights painted on one
    // and stripped on the next — which is the flicker a reader sees.
    const engaged = factCheckAllClickedIds.has(tweetId) || refreshRunPendingIds.has(tweetId);
    // Remembered either way. This one verdict drives both the strip gate and the
    // Reveal/Hide button's own key, and it is re-derived on every injection pass, so any
    // input that can differ between two passes (a run settling, a flag clearing) could
    // otherwise take back the state the reader is already looking at. From here it moves
    // only on the reader's own Reveal/Hide click.
    (engaged ? revealedVisualIds : hiddenVisualIds).add(tweetId);
    return !engaged;
}

/** Main-tweet-scoped wrapper: quoted tweets never participate (their parent's
 *  row owns the one set of visual buttons). */
function visualsHidden(tweetId: string): boolean {
    const c = allClassifications.find(x => x.id === tweetId);
    if (!c) return false;
    return visualsHiddenFor(tweetId, c.claims);
}

/** Mark a tweet as engaged with — its visuals render normally from here on,
 *  regardless of the hidden set. Called by every top-of-tweet action button's
 *  click handler (Disinfact, Fact-Check All, translate, refresh). */
function markVisualsEngaged(tweetId: string) {
    revealedVisualIds.add(tweetId);
    hiddenVisualIds.delete(tweetId);
}

/** True when a claim keeps its highlight while the tweet's cached visuals stay
 *  hidden: classified (a note is the completion signal — see the isResearching
 *  comment in buildSegmentWrap) and clearing BOTH popup thresholds — confidence
 *  at or above the floor, veracity at or below the ceiling.
 *
 *  A re-check in flight does NOT revoke this, matching the rule the painter
 *  already follows (keep a claim's colour while it refreshes as long as it
 *  still carries a valid verdict). The gates below already require a complete
 *  verdict, so an awaited re-check can only be vetoed on a claim that HAS one —
 *  and that veto was the one input to the strip gate that could differ between
 *  two injection passes with no reader action at all: `reclassifyOnHold` is set
 *  and cleared by our own payloads as a run settles, so a claim flipped
 *  eligible -> ineligible -> eligible, stripping the reader's highlight and
 *  painting it back, which is the flicker. Nothing else here can move on its
 *  own. The reader's hidden/revealed state still moves only on their click. */
function bypassEligibleClaim(cl: Claim): boolean {
    if (!bypassSettings.enabled) return false;
    if (cl.confidence === undefined || cl.confidence === null) return false;
    if (cl.veracity === undefined || cl.veracity === null) return false;
    if (cl.note === undefined || cl.note === null || String(cl.note).trim() === '') return false;
    return cl.confidence >= bypassSettings.minConfidence && cl.veracity <= bypassSettings.minVeracity;
}

/** Subset of a tweet's claims still shown while hidden: those passing the bypass
 *  gate. The tweet only stays effective-hidden when this comes back empty — so a
 *  Reveal/Hide button with every claim bypassed still behaves as hidden for gating
 *  (button label, fallbacks suppressed) while the spans render untouched. */
function bypassedClaims(claims: Claim[] | null | undefined): Claim[] {
    return (claims ?? []).filter(bypassEligibleClaim);
}

/** True when this article shows the tweet's Reveal/Hide button AND its cached
 *  visuals are currently hidden — the only state where the bypass gate applies.
 *  Mirrors syncTopButtonBar's wantsVisual conditions that can still be live this
 *  far down injectClassification (onHold / preclassifying / translate holds
 *  already returned upstream; the claim-less case too): without the button there
 *  is nothing to stay hidden behind, so nothing bypasses. Main tweets only. */
function hiddenBehindToggle(article: Element, classification: Classification | QuotedClassification, isQuoted: boolean): boolean {
    if (isQuoted) return false;
    const cls = classification as Classification;
    if (disinfactRunPendingIds.has(classification.id)) return false;
    if (cls.localizingHighlights) return false;
    if (getArticleMainStatusId(article) !== classification.id) return false;
    return visualsHidden(classification.id);
}

/** Claim indices to render as plain text while hidden: every claim that fails the
 *  bypass gate. Null when the tweet isn't hidden behind its toggle (render
 *  everything, exactly as today); an empty set when hidden with all claims
 *  bypassed (renders identically to null — the distinction only matters to the
 *  strip gate in injectClassification, which counts bypassed claims itself). */
function hiddenPlainIndices(article: Element, classification: Classification | QuotedClassification, isQuoted: boolean): Set<number> | null {
    if (!hiddenBehindToggle(article, classification, isQuoted)) return null;
    const claims = classification.claims ?? [];
    const set = new Set<number>();
    claims.forEach((cl, i) => { if (!bypassEligibleClaim(cl)) set.add(i); });
    return set;
}

/** Change-detection signature for the set above: what the wrap was built with.
 *  A settings drag that promotes or demotes a claim flips this, forcing a full
 *  rebuild — the in-place update path only touches existing claim spans, so it
 *  could neither strip a demoted highlight nor build a promoted one. */
function hiddenPlainSig(set: Set<number> | null): string {
    return set && set.size > 0 ? [...set].sort((a, b) => a - b).join(',') : '';
}

const processingTranslateFactChecksIds = new Set<string>();

/** Open a clamped body the moment the reader asks us about the post.
 *
 *  A host that clamps a long body with CSS keeps the whole string in the DOM, so marks
 *  painted into it can sit in text the reader cannot see. `upgradeToSegments` opens the
 *  clamp as it paints a claim, but that is only one of the ways a body comes to carry marks
 *  — a highlight localization repaints an already-marked post through its own path — and a
 *  classification that comes back with no claims paints nothing at all, leaving the reader
 *  who just paid for it looking at three lines and an ellipsis. The reader clicked our
 *  button on this post; from that click on, the post is owed to them whole, whatever the
 *  answer turns out to be.
 *
 *  Called from every button we put on a post, before the button's own handler runs its
 *  work, and awaited by each of them — the paint has to land on the opened body.
 *
 *  Two kinds of clamp, because the platforms hold a body back in two different ways. The
 *  CSS one keeps every word in the DOM and hides the overflow, so clearing the declarations
 *  is the whole remedy and a no-op anywhere else, since it writes two declarations the host
 *  does not read. The other kind CUTS the words out of the page: three lines and an ellipsis
 *  ARE the body, there is no declaration to clear, and the only way to the rest is the host's
 *  own control — which the adapter drives (`revealClipped`, the same hook the sweep uses
 *  before a clipped post can be read at all). That one is a real click on the host answered a
 *  re-render later, so it is awaited, and it is asked `onDemand`: the reader is asking, and an
 *  adapter's retry bound must not answer their click with nothing.
 *
 *  A quoted card is left alone — the click was on the post, not on whoever it quotes. */
async function expandClampedBody(article: Element, id: string, isQuoted: boolean): Promise<void> {
    const textEl = findTweetTextElement(article, isQuoted, id);
    if (textEl) unclipPostBody(textEl);
    if (isQuoted) return;
    const seam = platformSeam();
    if (!seam?.revealClipped) return;
    await seam.revealClipped(article, { onDemand: true }).catch((e) => {
        console.error('[misinfo] opening a clipped post on demand failed', e);
    });
}

/** Build the Reveal (cached visuals hidden) / Hide (cached visuals shown) button. */
function buildVisualToggleButton(
    classification: Classification,
    article: Element,
    time: Element,
    refClass: string,
    innerClass: string,
    hidden: boolean,
    withLogo: boolean,
    isQuoted: boolean
): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.setAttribute("role", "button");
    btn.setAttribute("type", "button");
    btn.className = refClass;
    btn.dataset.mfVisual = hidden ? "reveal" : "hide";
    btn.style.cursor = "pointer";
    btn.style.color = "rgb(83, 100, 113)";

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

    if (withLogo) {
        textWrap.appendChild(createDisinfactLogoSvg());
    }

    const label = document.createElement("span");
    label.textContent = t(hidden ? "revealButton" : "hideButton");
    textWrap.appendChild(label);
    markTopButtonSqueezable(btn, label);

    btn.innerHTML = "";
    btn.appendChild(textWrap);
    const isReveal = hidden;
    // Painted through a closure rather than once at build: a verdict can land after the
    // bar exists, and the caller (syncTopButtonBar) repaints this button in place instead
    // of rebuilding the bar around it. The text colour is owned here, not by
    // styleTopTweetButton, precisely because it moves with the tint.
    const applyTint = (next: { bg: string; hoverBg: string } | null) => {
        const tinted = !!next;
        const textColor = tinted ? (isDarkMode() ? "#fff" : "#000") : "rgb(83, 100, 113)";
        btn.style.color = textColor;
        textWrap.style.color = textColor;
        if (tinted) btn.dataset.mfVisualTint = "true";
        else delete btn.dataset.mfVisualTint;
        (btn as any)._mfTopBtnSetTint?.(next);
    };
    (btn as any)._mfApplyTint = applyTint;
    styleTopTweetButton(btn, false, null, false);
    applyTint(pillVerdictTint(isReveal, classification.claims));

    btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = classification.id;
        // Which way this click toggles is read BEFORE the wait, and the wait is first: the post
        // the reader asked about has to be whole on screen before the visuals are read back off
        // it, and the host answers an expansion by re-rendering the post — this button's bar
        // with it — so what they clicked is the state to act on, not what the rebuild says
        // afterwards. The occurrences below are resolved after it returns for the same reason.
        const revealing = (btn.dataset.mfVisual ?? "") === "reveal";
        await expandClampedBody(article, id, isQuoted);
        if (revealing) {
            markVisualsEngaged(id);
        } else {
            hiddenVisualIds.add(id);
            revealedVisualIds.delete(id);
        }
        // The quoted-card occurrences are skipped: revealing is a main-tweet action, and
        // a quoted card's own visuals belong to whoever quotes it.
        // This button outlives the classification it was built from: the bar is reused
        // whenever its key is unchanged, while every later delivery replaces the held
        // object in `allClassifications` (annotations land there, never on this
        // closure). Re-rendering from the captured object would rebuild the wrap from a
        // pre-annotation snapshot — the annotation disappears and Annotate comes back.
        const current = allClassifications.find(x => x.id === id) || classification;
        for (const { time, article: art, isQuoted } of postOccurrences(id)) {
            if (isQuoted) continue;
            injectClassification(time, current, art, false);
        }
        updateTopButtonSqueeze(article);
    });
    return btn;
}

/** Build the Fact-Check All button. */
function buildFactCheckAllButton(
    classification: Classification,
    article: Element,
    refClass: string,
    innerClass: string,
    withLogo: boolean
): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.setAttribute("role", "button");
    btn.setAttribute("type", "button");
    btn.className = refClass;
    btn.style.cursor = "pointer";
    btn.style.color = "rgb(83, 100, 113)";
    styleTopTweetButton(btn, false);
    btn.style.pointerEvents = "auto";

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

    if (withLogo) {
        textWrap.appendChild(createDisinfactLogoSvg());
    }
    const label = document.createElement("span");
    label.textContent = t("factCheckAllButton");
    textWrap.appendChild(label);
    markTopButtonSqueezable(btn, label);
    btn.appendChild(textWrap);

    btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        btn.disabled = true;
        btn.style.opacity = "0.6";
        btn.style.cursor = "default";
        await expandClampedBody(article, classification.id, false);
        (btn as any)._mfTopBtnNormal?.();
        ((btn as any)._mfTopBtnLabel as HTMLElement | undefined)?.style.setProperty("max-width", "none");
        factCheckAllClickedIds.add(classification.id);
        markVisualsEngaged(classification.id);
        mfBus.dispatchEvent(new CustomEvent("mf-fact-check-all", {
            detail: { tweetId: classification.id }
        }));
    });
    btn.dataset.mfCharge = "factcheckall";
    (btn as any)._mfFcaPreRefresh = () => updateTopButtonSqueeze(article);
    return btn;
}

/** Build the Disinfact button. */
function buildDisinfactButton(
    classification: Classification,
    time: Element,
    article: Element,
    refClass: string,
    innerClass: string,
    withLogo: boolean,
    isQuoted: boolean
): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.dataset.mfCharge = "disinfact";
    btn.setAttribute("role", "button");
    btn.setAttribute("type", "button");
    btn.className = refClass;
    btn.style.cursor = "pointer";
    btn.style.color = "rgb(83, 100, 113)";

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

    if (withLogo) {
        textWrap.appendChild(createDisinfactLogoSvg());
    }
    const text = document.createElement("span");
    text.textContent = t("disinfactButton");
    textWrap.appendChild(text);
    markTopButtonSqueezable(btn, text);

    btn.appendChild(textWrap);
    styleTopTweetButton(btn, false);

    btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await expandClampedBody(article, classification.id, isQuoted);
        disinfactRunPendingIds.add(classification.id);
        processingOnHoldIds.add(classification.id);
        markVisualsEngaged(classification.id);

        onHoldScrollStates.set(classification.id, {
            mark: markAt(article),
            pendingClaimTexts: new Set(),
            keptClaimTexts: new Set()
        });

        mfBus.dispatchEvent(new CustomEvent("mf-process-on-hold", {
            detail: { tweetId: classification.id }
        }));

        syncTopButtonBar(time, classification, article, isQuoted);

        setTimeout(() => {
            if (!disinfactRunPendingIds.has(classification.id)) return;
            disinfactRunPendingIds.delete(classification.id);
            processingOnHoldIds.delete(classification.id);
            onHoldScrollStates.delete(classification.id);
            syncTopButtonBar(time, classification, article, isQuoted);
        }, CHARGE_REVERT_TIMEOUT_MS);
    });
    return btn;
}

/** Build the highlight-localization ("Localize") button: the translate-tweet
 *  action relabeled — its highlights were made for another language version
 *  and need repositioning for the current text, not a fresh preclassification.
 *  Coloured with the average highlight colour when at least one claim is
 *  fact-checked (tint-eligible), exactly like the Reveal button. */
function buildTranslateFactChecksButton(
    classification: Classification,
    time: Element,
    article: Element,
    refClass: string,
    innerClass: string,
    withLogo: boolean,
    isQuoted: boolean
): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.setAttribute("role", "button");
    btn.setAttribute("type", "button");
    btn.className = refClass;
    btn.dataset.mfCharge = "translate-tweet";
    btn.style.cursor = "pointer";
    btn.style.color = "rgb(83, 100, 113)";

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

    if (withLogo) {
        textWrap.appendChild(createDisinfactLogoSvg());
    }
    const text = document.createElement("span");
    text.textContent = t("localizeButton");
    textWrap.appendChild(text);
    markTopButtonSqueezable(btn, text);

    btn.appendChild(textWrap);
    // Same verdict tint as the Reveal button: the average highlight colour
    // when at least one claim is fact-checked, standard gray pill otherwise.
    const localizeTint = averageVerdictTint(classification.claims);
    const isLocalizeTinted = !!localizeTint;
    const localizeTextColor = isLocalizeTinted ? (isDarkMode() ? "#fff" : "#000") : "rgb(83, 100, 113)";
    btn.style.color = localizeTextColor;
    textWrap.style.color = localizeTextColor;
    styleTopTweetButton(btn, false, localizeTint ?? undefined, isLocalizeTinted);

    btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await expandClampedBody(article, classification.id, isQuoted);
        processingTranslateFactChecksIds.add(classification.id);
        markVisualsEngaged(classification.id);

        mfBus.dispatchEvent(new CustomEvent("mf-translate-fact-checks", {
            detail: { tweetId: classification.id }
        }));

        syncTopButtonBar(time, classification, article, isQuoted);

        setTimeout(() => {
            if (!processingTranslateFactChecksIds.has(classification.id)) return;
            processingTranslateFactChecksIds.delete(classification.id);
            syncTopButtonBar(time, classification, article, isQuoted);
        }, CHARGE_REVERT_TIMEOUT_MS);
    });
    return btn;
}

/** Build the icon-only top-of-tweet refresh button. */
function buildTopBatchRefreshButton(
    classification: Classification,
    time: Element,
    article: Element,
    refClass: string,
    isQuoted: boolean
): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.setAttribute("role", "button");
    btn.setAttribute("type", "button");
    btn.className = refClass;
    btn.style.cursor = "pointer";
    btn.style.color = "rgb(83, 100, 113)";
    styleTopTweetButton(btn, true);
    btn.style.pointerEvents = "auto";
    btn.title = t("refreshBatchTooltip");
    btn.dataset.mfCharge = "refresh-top";
    btn.innerHTML = TOP_BATCH_REFRESH_SVG;
    btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (btn.disabled) return;
        btn.disabled = true;
        const id = classification.id;
        await expandClampedBody(article, id, isQuoted);
        factCheckAllClickedIds.delete(id);
        refreshRunPendingIds.add(id);
        markVisualsEngaged(id);
        closePopover();
        mfBus.dispatchEvent(new CustomEvent("mf-refresh-batch", {
            detail: { batchId: classification.batchId, tweetId: id }
        }));
        syncTopButtonBar(time, classification, article, isQuoted);

        setTimeout(() => {
            if (!refreshRunPendingIds.has(id)) return;
            refreshRunPendingIds.delete(id);
            syncTopButtonBar(time, classification, article, isQuoted);
        }, CHARGE_REVERT_TIMEOUT_MS);
        refreshStandaloneOnboarding();
    });
    return btn;
}

/** Containers already sealed, so repeated syncs do not stack listeners on one bar. */
const hostSealedContainers = new WeakSet<Element>();

/** Keep our own controls' events off the host page.
 *
 *  Our bars are injected inside the host's own clickable regions: a Bluesky thread root wraps
 *  its header row — and so our pill — in the author's profile `<a>`, and a Reddit feed card
 *  wraps its whole body in the post's permalink. A link's navigation is a DEFAULT ACTION, not
 *  a bubbling handler, so `stopPropagation` alone leaves it armed: on Bluesky the click that
 *  starts a preclassification also opened the author's profile, and the page was gone before
 *  the bar could repaint. Both are therefore needed — `stopPropagation` keeps the host's own
 *  JS handlers from seeing the press (a React `role="link"` wrapper opens on click), and
 *  `preventDefault` cancels the anchor.
 *
 *  Sealing the container rather than each button covers every descendant control, including
 *  ones a later sync adds. Only `click`'s default is cancelled; `mousedown`'s is left alone
 *  so a click can still move focus, and our own handlers run earlier in the same bubble and
 *  are unaffected. */
export function sealHostEvents(container: HTMLElement) {
    if (hostSealedContainers.has(container)) return;
    hostSealedContainers.add(container);
    // The capture-phase listener is the one that actually cancels the anchor, and it has to be
    // in the capture phase. Every button we build stops propagation at its own target (to keep
    // React's root listener — which is what turns a host `role="link"` wrapper into a click —
    // from ever seeing the press), so an event that starts on one of our buttons never bubbles
    // back up to this container: measured live, the whole path was
    // `doc-capture → bar-capture → btn-target` and then nothing. A bubble-phase seal here is
    // therefore dead code on exactly the presses it exists for. Capture runs root-to-target, so
    // it cannot be skipped by a descendant, and `preventDefault` there leaves our own handlers
    // untouched. The bubble-phase listeners stay for controls that do not stop propagation
    // themselves, and for the presses a host might route through mousedown/pointerdown.
    container.addEventListener("click", (e) => e.preventDefault(), true);
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        container.addEventListener(type, (e) => {
            e.stopPropagation();
            if (type === "click") e.preventDefault();
        });
    }
}

/** Unified top button bar for a tweet: encloses all active buttons (Hide/Reveal,
 *  Disinfact / Fact-Check All, Refresh) in a single outer pill area with consistent
 *  spacing. If there is only 1 button, the DisinfaX logo is integrated within the
 *  button. If there is more than 1 button, the DisinfaX logo is hoisted outside the
 *  buttons to the far left inside the outer area, and individual buttons omit the logo.
 *  Verdict tint applies strictly to the Reveal/Hide button itself. */
function syncTopButtonBar(
    time: Element,
    classification: Classification | QuotedClassification,
    article: Element,
    isQuoted: boolean = false
) {
    injectStyles();
    const id = classification.id;
    const claims = classification.claims;
    const seam = platformSeam();
    const grokData = seam ? null : findGrokRow(article);
    const subscribeWrapper = seam ? null : findSubscribeWrapper(article);
    const refBtn = (subscribeWrapper?.querySelector("button") as HTMLElement | null) ?? grokData?.btn ?? (time as HTMLElement);
    // On X the reference button's class list is what makes our pill inherit X's font
    // metrics and colour tokens. Elsewhere that read is not style-neutral: the nearest
    // anchor on Reddit is the post root, and copying `shreddit-post`'s class list onto our
    // <button> would carry the post's own layout rules with it. The pill is already fully
    // specified inline by styleTopTweetButton, so the seam path takes neutral hook classes
    // and inherits nothing from the host.
    const refClass = seam ? 'mf-native-btn' : refBtn.className;
    const innerDiv = grokData?.btn.querySelector<HTMLElement>('div[dir="ltr"]');
    const innerClass = seam ? 'mf-native-btn-inner' : (innerDiv?.className ?? refClass);

    const cls = classification as Classification;

    // 1. Determine what buttons want to be in the bar:
    // A. Visual Toggle Button (Hide / Reveal)
    const wantsVisual = !isQuoted
        && !!claims && claims.length > 0
        && !cls.onHold
        && !cls.preclassifying
        && !disinfactRunPendingIds.has(id)
        && !cls.translateFactChecksOnHold
        && !cls.localizingHighlights;
    const isHidden = wantsVisual ? visualsHidden(id) : false;

    // B. Action Button
    const isProcessing = processingOnHoldIds.has(id);
    let actionType: "translate-tweet" | "factcheckall" | "disinfact" | null = null;
    if (!isQuoted) {
        if (cls.translateFactChecksOnHold) {
            actionType = "translate-tweet";
        } else if (cls.onHold && !disinfactRunPendingIds.has(id) && !cls.preclassifying) {
            actionType = "disinfact";
        } else if (disinfactRunPendingIds.has(id) || cls.preclassifying) {
            actionType = "factcheckall";
        } else if (claims && claims.some(cl => cl.reclassifyOnHold) && !factCheckAllClickedIds.has(id) && !shouldRemoveOnHoldButton(cls)) {
            processingOnHoldIds.add(id);
            actionType = "factcheckall";
        } else if (isProcessing && !factCheckAllClickedIds.has(id) && !shouldRemoveOnHoldButton(cls)) {
            actionType = "factcheckall";
        }
    }

    const isReveal = wantsVisual && isHidden;
    // The verdict tint is deliberately NOT part of the bar key: while it was, a tint that
    // moved on its own — a run streaming a verdict in, or the re-check flag the pill's own
    // gates used to read — tore the whole bar down and built a new one, and a fresh button
    // is never *entered*, so the fill dropped to its resting colour under a stationary
    // pointer and pulsed back on the browser's synthetic enter. That pulse is the flicker,
    // and a click landing inside it landed on a button that no longer existed.
    //
    // What this value is now: a signature only. pillVerdictTint is shared with
    // buildVisualToggleButton, so the signature and the pill's own paint can never
    // disagree, and a moved signature repaints that existing button in place.
    //
    // The raw claim list is passed, matching what the pill has always painted. The
    // bypassed-claims filter that used to sit here fed only the key, never the paint, so
    // dropping it changes nothing the reader sees; folding it into both would change the
    // pill's colour for anyone running with bypass on, which is not this fix's business.
    const tint = pillVerdictTint(isReveal, claims);
    const tintSig = tint?.bg ?? "";

    // When the Reveal button is present, all other buttons are hidden
    if (isReveal) {
        actionType = null;
    }

    // C. Refresh Button: shown when classification has a batchId, not in onHold/translate states
    const wantsRefresh = !isQuoted
        && !isReveal
        && !cls.translateFactChecksOnHold
        && !cls.onHold
        && !cls.preclassifying
        && !disinfactRunPendingIds.has(id)
        && !!cls.batchId
        && !refreshRunPendingIds.has(id);

    // D. Spinner: active while any background run / localization is in flight
    const wantsSpinner = refreshRunPendingIds.has(id)
        || disinfactRunPendingIds.has(id)
        || processingTranslateFactChecksIds.has(id)
        || !!cls.localizingHighlights
        || !!cls.preclassifying;

    // Count active clickable buttons:
    let buttonCount = 0;
    if (wantsVisual) buttonCount++;
    if (actionType !== null) buttonCount++;
    if (wantsRefresh) buttonCount++;
    // Structural only: which pill, which action, refresh, spinner. Anything cosmetic — the
    // verdict tint above all — is repainted on the live button rather than keyed here.
    const barKey = `${wantsVisual ? (isHidden ? "reveal" : "hide") : "none"}|${actionType ?? "none"}|${wantsRefresh}|${wantsSpinner}`;

    const existingContainer = article.querySelector<HTMLElement>(`[mf-top-bar-id="${id}"]`);

    if (buttonCount === 0 && !wantsSpinner) {
        existingContainer?.remove();
        return;
    }

    let container = existingContainer;
    if (!container) {
        container = document.createElement("div");
        container.classList.add("mf-btn-container");
        container.setAttribute("mf-top-bar-id", id);
    }
    sealHostEvents(container);

    // Paint order, not event handling. A host that covers a whole card with an absolutely
    // positioned overlay puts that overlay above every in-flow descendant, and hit-testing
    // follows paint order — so the press lands on the overlay and never reaches our buttons at
    // all. Reddit draws each feed post's permalink as `<a class="absolute inset-0">` inside
    // `shreddit-post`; measured there, `elementFromPoint` at the Disinfact pill's own centre
    // returned that anchor for 4 of 4 pills, and the click opened the post instead. The seal
    // above cannot help: `preventDefault` only cancels an event we are sent. Positioning the
    // container above an overlay that carries no z-index restores the hit test, and moves
    // nothing — `relative` with no offsets leaves the host's own layout and margins in charge.
    //
    // Skipped for a bar its adapter has seated itself: an absolutely positioned bar is already
    // above any overlay (its z-index is set by whoever seated it) and its offsets are the seat,
    // so rewriting `relative` here would drop it back into the host's flow — measured on the
    // mobile Facebook surface, whose rows are fixed-height boxes that an in-flow bar overflows.
    if (container.style.position !== 'absolute') {
        container.style.position = 'relative';
        container.style.zIndex = '1';
    }
    // Drop any old separated containers that are not this container
    for (const old of Array.from(article.querySelectorAll<HTMLElement>(`[mf-on-hold-id="${id}"]:not([mf-top-bar-id]), [translate-fc-id="${id}"]:not([mf-top-bar-id]), [mf-refresh-id="${id}"]:not([mf-top-bar-id]), [mf-visual-id="${id}"]:not([mf-top-bar-id])`))) {
        old.remove();
    }

    // An adapter that MEASURED where its button goes has to be asked again on every pass: the host
    // finishes laying its own header out after we first measure it. Measured on the mobile
    // Facebook surface, a Follow control the app rendered a frame later landed exactly on the seat
    // chosen before it existed — and a seat is only ever chosen from the DOM, so it has to be
    // chosen again while the DOM is still settling. Guarded on the measurement itself, so no
    // platform that seats its buttons without measuring is re-placed by this.
    const seatingSeam = container.isConnected ? platformSeam() : null;
    if (seatingSeam && container.dataset.mfSeatWidth !== undefined) {
        seatingSeam.placeButtons(container, article, { id, isQuoted });
    }
    applySeatCap(container);

    if (container.isConnected && container.dataset.mfBarKey === barKey) {
        // Same bar. A verdict tint that moved since the last pass is adopted by the button
        // that is already there — same element, same listeners, same pointer under it.
        if ((container.dataset.mfBarTint ?? "") !== tintSig) {
            container.dataset.mfBarTint = tintSig;
            (container.querySelector("button[data-mf-visual]") as any)?._mfApplyTint?.(tint);
        }
        return;
    }
    container.dataset.mfBarKey = barKey;
    container.dataset.mfBarTint = tintSig;

    const hasMultipleButtons = buttonCount > 1;
    const hasOuterPill = hasMultipleButtons || (buttonCount >= 1 && wantsSpinner);

    // Stable spinner slot: permanently stationed at the far right of container.
    // Preserving this node in the DOM tree prevents CSS @keyframes mf-spin resets.
    let spinnerSlot = container.querySelector<HTMLElement>(".mf-spinner-slot");
    if (!spinnerSlot) {
        spinnerSlot = document.createElement("span");
        spinnerSlot.className = "mf-spinner-slot";
        spinnerSlot.style.cssText = "display:none;align-items:center;justify-content:center;flex-shrink:0;";
        const spin = document.createElement("span");
        spin.className = "mf-spinner";
        spin.style.borderColor = "rgba(83, 100, 113, 0.2)";
        spin.style.borderTopColor = "rgba(83, 100, 113, 0.8)";
        spin.style.flexShrink = "0";
        spinnerSlot.appendChild(spin);
        container.appendChild(spinnerSlot);
    }

    // Clear previous children while preserving spinnerSlot
    for (const child of Array.from(container.children)) {
        if (child !== spinnerSlot) {
            child.remove();
        }
    }

    // A bar its adapter has seated OVER the host's own layout — positioned absolutely, as the
    // mobile Facebook surface does — is painted on top of the host's content, so its ground has to
    // be opaque: measured there, the poster's name and meta line read straight through the
    // translucent fill and garbled the label. The adapter that seated it says what to composite
    // over; a bar in the host's own flow keeps the translucent fill it shares with every platform.
    const seatBg = container.dataset.mfSeatBg ?? null;

    if (hasOuterPill) {
        // Outer pill chrome encompassing all buttons
        container.style.borderRadius = "999px";
        container.style.backgroundColor = seatBg ?? "rgba(83, 100, 113, 0.08)";
        container.style.boxShadow = "inset 0 0 0 1px rgba(83, 100, 113, 0.35)";
        container.style.padding = "0";
        container.style.gap = "4px";
        container.style.display = "inline-flex";
        container.style.alignItems = "center";
        container.style.minWidth = "0";
        container.style.flexShrink = "0";

        if (hasMultipleButtons) {
            // Hoisted DisinfaX logo on the far left outside the buttons
            const hoistedLogoWrap = document.createElement("div");
            hoistedLogoWrap.className = "mf-hoisted-logo";
            hoistedLogoWrap.style.cssText = `
                display: inline-flex;
                align-items: center;
                justify-content: center;
                flex-shrink: 0;
                color: rgb(83, 100, 113);
                margin-left: 4px;
                margin-right: -4px;
            `;
            hoistedLogoWrap.appendChild(createDisinfactLogoSvg(true));
            container.insertBefore(hoistedLogoWrap, spinnerSlot);
        }
    } else {
        // Single button with no spinner: container carries no chrome of its own, the button does —
        // unless the bar is seated over the host's layout, where the ground is what keeps the host's
        // words out of our label.
        container.style.borderRadius = "999px";
        container.style.backgroundColor = seatBg ?? "transparent";
        container.style.boxShadow = "none";
        container.style.padding = "0";
        container.style.gap = "0";
        container.style.display = "inline-flex";
        container.style.alignItems = "center";
        container.style.minWidth = "0";
        container.style.flexShrink = "0";
    }

    const withLogo = !hasMultipleButtons;

    // Left-to-right order:
    // [Hoisted Logo] -> [Hide / Reveal] -> [Action: FCA / Disinfact] -> [Refresh] -> [Spinner (if active)]
    if (wantsVisual) {
        const btn = buildVisualToggleButton(
            cls,
            article,
            time,
            refClass,
            innerClass,
            isHidden,
            withLogo,
            isQuoted
        );
        container.insertBefore(btn, spinnerSlot);
    }

    if (actionType === "factcheckall") {
        const btn = buildFactCheckAllButton(
            cls,
            article,
            refClass,
            innerClass,
            withLogo
        );
        container.insertBefore(btn, spinnerSlot);
    } else if (actionType === "disinfact") {
        const btn = buildDisinfactButton(
            cls,
            time,
            article,
            refClass,
            innerClass,
            withLogo,
            isQuoted
        );
        container.insertBefore(btn, spinnerSlot);
    } else if (actionType === "translate-tweet") {
        const btn = buildTranslateFactChecksButton(
            cls,
            time,
            article,
            refClass,
            innerClass,
            withLogo,
            isQuoted
        );
        container.insertBefore(btn, spinnerSlot);
    }

    if (wantsRefresh) {
        const btn = buildTopBatchRefreshButton(
            cls,
            time,
            article,
            refClass,
            isQuoted
        );
        container.insertBefore(btn, spinnerSlot);
    }

    if (wantsSpinner) {
        spinnerSlot.style.display = "inline-flex";
        spinnerSlot.style.marginRight = hasOuterPill ? "3px" : "0";
        spinnerSlot.style.marginLeft = "2px";
    } else {
        spinnerSlot.style.display = "none";
    }

    if (!container.isConnected) {
        placePostButtons(container, article, { id, isQuoted }, time, grokData);
    }

    updateTopButtonSqueeze(article);
    applySeatCap(container);
}

function syncVisualToggleButton(time: Element, classification: Classification, article: Element, isQuoted: boolean) {
    syncTopButtonBar(time, classification, article, isQuoted);
}

function syncBatchRefreshButton(time: Element, classification: Classification | QuotedClassification, article: Element, isQuoted: boolean) {
    syncTopButtonBar(time, classification as Classification, article, isQuoted);
}

function settleRefreshSlot(time: Element, classification: Classification | QuotedClassification, article: Element, isQuoted: boolean) {
    syncTopButtonBar(time, classification as Classification, article, isQuoted);
}

function injectOnHoldButton(time: Element, classification: Classification, article: Element, isQuoted: boolean = false) {
    syncTopButtonBar(time, classification, article, isQuoted);
}

function injectTranslateFactChecksButton(time: Element, classification: Classification, article: Element, isQuoted: boolean = false) {
    syncTopButtonBar(time, classification, article, isQuoted);
}

function syncTopWheel(article: Element, tweetId: string, localizing = false) {
    const c = allClassifications.find(x => x.id === tweetId);
    if (!c) return;
    const time = article.querySelector<HTMLElement>(`a[href*="/status/${tweetId}"]`);
    if (!time) return;
    const isQuoted = getArticleMainStatusId(article) !== tweetId;
    syncTopButtonBar(time, c, article, isQuoted);
}

// ── Main injection (drives both phases above) ───────────────────────────────

/** Tweet-id + DOM-lang pairs already forwarded as SET_DISPLAYED_LOCALE. Dedupes
 *  the inject loop (MutationObserver re-entry) so we don't re-broadcast every
 *  paint; a full reload empties the set. */
const displayedLocaleSent = new Set<string>();

/** X auto-translates on page load / display-language change without a click on
 *  its Show translation toggle, so the toggle handler never fires
 *  SET_DISPLAYED_LOCALE. A DB-hit tweet then injects as already-classified
 *  (Fact-Check All + refresh) against English highlights over Spanish text.
 *  Read the tweetText lang and, when it disagrees with the classification,
 *  hold for highlight localization (never auto-charge) and tell the background. */
function maybeSyncDisplayedLocaleFromDom(article: Element, classification: Classification) {
    if (classification.onHold || classification.preclassifying) return;
    const claims = classification.claims;
    if (!claims || claims.length === 0) return;
    const textEl = findTweetTextElement(article, false, classification.id);
    const domLang = textEl?.getAttribute('lang')?.trim();
    if (!domLang) return;
    const current = classification.textLocale;
    if (current && sameLanguage(domLang, current)) return;
    // The background re-decides the same on SET_DISPLAYED_LOCALE; this optimistic
    // set covers the gap before that broadcast lands.
    if (claims.some(cl => !resolveHighlightRange(cl.highlight, domLang))) {
        classification.translateFactChecksOnHold = true;
    }
    const key = `${classification.id}:${domLang}`;
    if (displayedLocaleSent.has(key)) return;
    displayedLocaleSent.add(key);
    mfBus.dispatchEvent(new CustomEvent('mf-set-displayed-locale', {
        detail: {
            tweetId: classification.id,
            textLocale: domLang,
            displayedText: textEl?.textContent ?? undefined,
        },
    }));
}

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

    // Nothing to paint means nothing may stay painted, in THIS root. The states below all
    // return before any highlight work — on-hold, mid-re-run, a claim-less broadcast, a
    // pending translation — so a wrap still standing here is a leftover the transition-scoped
    // teardown could not reach (see clearStaleSegmentPaint).
    if (!classification.claims || classification.claims.length === 0) {
        clearStaleSegmentPaint(article, classification.id);
    }

    if (!isQuoted) {
        maybeSyncDisplayedLocaleFromDom(article, classification as Classification);
        const domQuotedId = (classification as Classification).quoting?.id ?? findQuotedTweetIdInArticle(article, classification.id);
        if (domQuotedId) {
            requestQuotedDbFetch(domQuotedId, classification.id);
        }
        const clsItem = classification as Classification;
        if (!clsItem.onHold && !clsItem.preclassifying) {
            disinfactRunPendingIds.delete(clsItem.id);
            processingOnHoldIds.delete(clsItem.id);
        }
        if (!clsItem.translateFactChecksOnHold && !clsItem.localizingHighlights) {
            processingTranslateFactChecksIds.delete(clsItem.id);
        }
    }

    const staleOnHold = document.querySelector(`[mf-on-hold-id="${classification.id}"]:not([mf-top-bar-id])`);
    if (staleOnHold && !(classification as Classification).onHold && shouldRemoveOnHoldButton(classification as Classification)) {
        staleOnHold.remove();
        processingOnHoldIds.delete(classification.id);
        refreshRunPendingIds.delete(classification.id);
        disinfactRunPendingIds.delete(classification.id);
        settleRefreshSlot(time, classification, article, isQuoted);
    }
    const staleTFC = document.querySelector(`[translate-fc-id="${classification.id}"]:not([mf-top-bar-id])`);
    if (staleTFC && !(classification as Classification).translateFactChecksOnHold) {
        staleTFC.remove();
        processingTranslateFactChecksIds.delete(classification.id);
        settleRefreshSlot(time, classification, article, isQuoted);
    }

    if (isQuoted) {
        if ((classification as Classification).translateFactChecksOnHold || (classification as Classification).onHold) {
            article.querySelector(`[mf-on-hold-id="${classification.id}"]:not([mf-top-bar-id])`)?.remove();
            article.querySelector(`[translate-fc-id="${classification.id}"]:not([mf-top-bar-id])`)?.remove();
            article.querySelector(`[mf-unmatched="${classification.id}"]`)?.remove();
            syncBatchRefreshButton(time, classification, article, isQuoted);
            syncTopWheel(article, classification.id, !!(classification as Classification).localizingHighlights);
            return;
        }
    } else {
        // Tearing the visual toggle down in the pending-action states: the
        // button order (Hide, Reveal, Disinfact, …) presumes one action
        // button, so with a Disinfact/translate action live the toggle goes
        // away and returns via the sync call below once visuals are shown.
        if ((classification as Classification).translateFactChecksOnHold) {
            article.querySelector(`[mf-on-hold-id="${classification.id}"]:not([mf-top-bar-id])`)?.remove();
            article.querySelector(`[mf-unmatched="${classification.id}"]`)?.remove();
            article.querySelector(`[mf-visual-id="${classification.id}"]:not([mf-top-bar-id])`)?.remove();
            injectTranslateFactChecksButton(time, classification as Classification, article, isQuoted);
            syncBatchRefreshButton(time, classification, article, isQuoted);
            syncTopWheel(article, classification.id, !!(classification as Classification).localizingHighlights);
            return;
        }

        // A forced re-preclassification is running. Reuse the on-hold container so the
        // spinner appears exactly where the Disinfact button sits: processingOnHoldIds is
        // what makes injectOnHoldButton render the spinner state rather than the button.
        if ((classification as Classification).preclassifying) {
            processingOnHoldIds.add(classification.id);
            refreshRunPendingIds.delete(classification.id);
            disinfactRunPendingIds.delete(classification.id);
            injectOnHoldButton(time, classification as Classification, article, isQuoted);
            const fcaBtn = article.querySelector<HTMLElement>(`[mf-on-hold-id="${classification.id}"] button[data-mf-charge="factcheckall"]`);
            if (fcaBtn) { const cb = (fcaBtn as any)._mfFcaPreRefresh; if (typeof cb === 'function') cb(); }
            syncBatchRefreshButton(time, classification, article, isQuoted);
            syncTopWheel(article, classification.id, !!(classification as Classification).localizingHighlights);
            return;
        }

        if ((classification as Classification).onHold) {
            article.querySelector(`[mf-visual-id="${classification.id}"]:not([mf-top-bar-id])`)?.remove();
            injectOnHoldButton(time, classification as Classification, article, isQuoted);
            const fcaBtn = article.querySelector<HTMLElement>(`[mf-on-hold-id="${classification.id}"] button[data-mf-charge="factcheckall"]`);
            if (fcaBtn) { const cb = (fcaBtn as any)._mfFcaPreRefresh; if (typeof cb === 'function') cb(); }
            syncBatchRefreshButton(time, classification, article, isQuoted);
            syncTopWheel(article, classification.id, !!(classification as Classification).localizingHighlights);
            return;
        }
    }

    syncBatchRefreshButton(time, classification, article, isQuoted);
    syncTopWheel(article, classification.id, !!(classification as Classification).localizingHighlights);

    // A claim-less broadcast ends any optimistic refresh run still awaiting its
    // first claims (e.g. the worker found nothing): settle the slot now so the
    // button rebuilds for retry instead of stranding the wheel.
    if (!claims || claims.length === 0) {
        refreshRunPendingIds.delete(classification.id);
        disinfactRunPendingIds.delete(classification.id);
        settleRefreshSlot(time, classification, article, isQuoted);
        syncTopWheel(article, classification.id, !!(classification as Classification).localizingHighlights);
        return;
    }

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

    // The on-hold container may just have been created (pending claims) or removed
    // as resolved above — re-sync the standalone refresh against the final DOM.
    syncBatchRefreshButton(time, classification, article, isQuoted);
    syncTopWheel(article, classification.id, !!(classification as Classification).localizingHighlights);
    syncVisualToggleButton(time, classification as Classification, article, isQuoted);

    // Reveal/Hide gate (main tweets only): with cached preclassification visuals
    // hidden, strip any injected visuals in place and stop — derivation, spend,
    // buttons, fallback, and quoting are untouched. Phase-2 segments are cached
    // (upgradeToSegments runs on the NEXT pass after Reveal), so nothing is lost.
    // Scoped to this article's MAIN tweet: the strip selectors below match by
    // tweet id only, so without the guard a quoted pass sharing the article
    // would strip the parent's visuals (or vice versa).
    //
    // Hidden bypass: claims clearing the popup's confidence/veracity thresholds
    // keep their highlight, annotations, badge and popover while hidden. The
    // gate below only fires when NO claim bypasses; otherwise flow continues to
    // Phase 2, which renders just those claims (the rest as plain text).
    const behindToggle = hiddenBehindToggle(article, classification, isQuoted);
    const hiddenBypassed = behindToggle ? bypassedClaims(claims) : [];
    if (behindToggle && hiddenBypassed.length === 0) {
        for (const wrap of article.querySelectorAll<HTMLElement>('.mf-segment-wrap')) {
            const host = wrap.parentElement as (HTMLElement & { _mfOriginalNodes?: ChildNode[] }) | null;
            const originals = host?._mfOriginalNodes;
            if (host && originals?.length) {
                host.replaceChildren(...originals);
                delete host._mfOriginalNodes;
            } else {
                freezeSegmentWrap(wrap);
            }
        }
        const fallback = article.querySelector(`[classification-id="${classification.id}"]`);
        if (fallback) fallback.remove();
        const unmatched = article.querySelector(`[mf-unmatched="${classification.id}"]`);
        if (unmatched) unmatched.remove();
        return;
    }

    if (segments && segments.length > 0) {
        console.log(`[misinfo] injectClassification: Phase 2 for ${classification.id} (isQuoted=${isQuoted})`);
        const mainCls = classification as Classification;
        const clBatchId = mainCls.batchId ?? '';
        // While hidden, only the bypassed claims render as highlights; the rest
        // render as plain text (see buildSegmentWrap). Null everywhere else, so
        // every non-hidden path builds exactly what it always built.
        const hiddenPlain = hiddenPlainIndices(article, classification, isQuoted);
        // A post rendered as several blocks (Reddit's title above its body) is painted
        // one block at a time: the segments are cut to each region's slice of the
        // classified text and written into that region's element. Handing the whole set
        // to the first element would put the other blocks' words inside it — the same
        // text in two places, and the post looking like it says something it doesn't.
        // Nothing renders the text BETWEEN two regions (the separator the adapter joins
        // them with), so that text is dropped here exactly as it is absent from the page.
        // The classified text, rebuilt from the segments that carry its offsets. It is
        // handed to the adapter because the adapter is what maps that text onto the page's
        // elements, and on a platform whose text comes from an API the string classified
        // need not be the string the markup shows (a payload's caption against a clipped
        // render). An adapter that assumed otherwise would cut each region's slice at an
        // offset belonging to the wrong text — see PostRef.text.
        const classifiedText = segments.map((s) => s.text).join('');
        const regions: TextRegion[] | null | undefined = !isQuoted
            ? platformSeam()?.textRegions?.(article, { id: classification.id, text: classifiedText })
            : null;
        if (regions && regions.length > 1) {
            for (const region of regions) {
                const sliced = sliceSegmentsToRegion(segments, region.start, region.end);
                if (sliced.length === 0) continue;
                upgradeToSegments(article, classification, clBatchId, isQuoted, hiddenPlain, undefined, region.el, sliced);
            }
        } else {
            upgradeToSegments(article, classification, clBatchId, isQuoted, hiddenPlain);
        }
        if (!isQuoted && mainCls.quoting && mainCls.quoting.segments && mainCls.quoting.segments.length > 0) {
            upgradeToSegments(article, mainCls.quoting, clBatchId, true, undefined,
                mainCls.textLocale ?? mainCls.translatedLocale);
        }

        // First streamed claims have landed — any optimistic refresh-button run is
        // over (its wheel was handed to the pipeline's nested spinner above, or
        // never left the standalone slot when no preclassifying broadcast came,
        // e.g. Test Mode). Only OUR set is cleared: processingOnHoldIds outlives
        // the run on purpose (badge labels + Fact-Check All persistence).
        if (!isQuoted && refreshRunPendingIds.has(classification.id)) {
            refreshRunPendingIds.delete(classification.id);
        }
        if (!isQuoted && disinfactRunPendingIds.has(classification.id)) {
            disinfactRunPendingIds.delete(classification.id);
        }
        settleRefreshSlot(time, classification, article, isQuoted);
        syncTopWheel(article, classification.id, !!mainCls.localizingHighlights);

        // While hidden, only bypassed claims may keep a fallback box: anything
        // else rendering there would leak a verdict the user chose to keep hidden.
        // hiddenPlain is null off the hidden path, so every non-hidden tweet
        // computes exactly what it always computed.
        const fallbackMasked = (c: Claim, i: number) => hiddenPlain !== null && hiddenPlain.has(i);
        if (!mainCls.localizingHighlights) {
            const segmentClaimTexts = new Set<string>();
            for (const seg of segments) {
                if (seg.claimIndex !== null && claims[seg.claimIndex] && !hiddenPlain?.has(seg.claimIndex)) {
                    segmentClaimTexts.add(claims[seg.claimIndex].text);
                }
            }
            for (const seg of segments) {
                if (seg.claimIndex !== null && claims[seg.claimIndex]?.rewritten && !hiddenPlain?.has(seg.claimIndex)) {
                    segmentClaimTexts.add(claims[seg.claimIndex].rewritten!);
                }
            }
            const unmatched = claims.filter((c, i) => !fallbackMasked(c, i) && !segmentClaimTexts.has(c.text) && !segmentClaimTexts.has(c.rewritten ?? ''));
            const oldFallback = article.querySelector(`[classification-id="${classification.id}"]`);
            if (oldFallback) oldFallback.remove();
            sweepOrphanClaimBoxes(classification.id);
            if (unmatched.length > 0) {
                console.log(`[misinfo] injectClassification: ${unmatched.length} unmatched claims for ${classification.id}${RENDER_FALLBACK_CLAIM_BOXES ? ", rendering fallback box" : ", fallback box suppressed"}`);
            }
            if (RENDER_FALLBACK_CLAIM_BOXES && unmatched.length > 0) {
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
                    placeClaimBox(time, article, div, mainTweet);
                }
            } else {
                const unmatchedDiv = article.querySelector(`[mf-unmatched="${classification.id}"]`);
                if (unmatchedDiv) unmatchedDiv.remove();
            }
        }

        syncVisualToggleButton(time, classification as Classification, article, isQuoted);
        return;
    }

    if ((classification as Classification).localizingHighlights) {
        console.log(`[misinfo] injectClassification: suppressing Phase 1 fallback for ${classification.id} while localizing highlights`);
        syncTopWheel(article, classification.id, true);
        return;
    }
    // No Phase 1 fallback while hidden behind the toggle: the whole box is a
    // verdict leak, and bypassed claims already render inline via Phase 2 above.
    // BarKey still flips to reveal so the Reveal button takes Phase 2's place.
    if (hiddenBehindToggle(article, classification, isQuoted)) {
        article.querySelector(`[classification-id="${classification.id}"]`)?.remove();
        article.querySelector(`[mf-unmatched="${classification.id}"]`)?.remove();
        return;
    }
    console.log(`[misinfo] injectClassification: Phase 1 (fallback) for ${classification.id}${RENDER_FALLBACK_CLAIM_BOXES ? "" : ", box suppressed"}`);
    const mainTweet = !isQuoted && parseInt(article.getAttribute("tabindex") ?? "0") < 0;
    const existing = article.querySelector(`[classification-id="${classification.id}"]`);
    if (!RENDER_FALLBACK_CLAIM_BOXES) {
        if (existing) existing.remove();
    } else if (existing) {
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
        placeClaimBox(time, article, div, mainTweet);
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
