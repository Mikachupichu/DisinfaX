/** Fact-checking anywhere: the user selects text on ANY webpage and Disinfacts it.
 *
 *  Injected on demand (never declared in the manifest) via `browser.scripting` under an
 *  `activeTab` grant, so the extension runs only on a page the user explicitly acted on
 *  with the toolbar button or the context menu item — see wxt.config.ts.
 *
 *  This script owns everything the PAGE does: capturing the selection and its surrounding
 *  context, drawing the "Disinfacting" indicator, wrapping the selection in claim
 *  highlights, and showing the claim popover. Every network call and all claim research
 *  happens in the background: an MV3 content script's fetch is subject to the HOST page's
 *  CORS rules, so it cannot reach the workers or Supabase the way the extension's own
 *  contexts can — and the balance gate around a research call lives in the background.
 *  Results arrive over the `classify` port, the same one the X.com UI uses, filtered to
 *  this selection's id.
 *
 *  The claims are anchored onto the page's own DOM rather than listed in a panel, so the
 *  user reads the verdicts on the text they were already reading. */
import { breakupWithHighlights } from '../utils/textBreakup';
import {
  closePopover,
  factCheckColor,
  getInlineStyles,
  refreshInPopoverOnboarding,
  setAnnotateSeeded,
  settleRebuiltSpanAnnotations,
  setupArticleHandlers as setupClaimHandlers,
  showNotification,
  trackSelectionFloatingButtons,
  updateOpenPopover,
  verdictBadgeHtml,
  verdictLabel,
  wrapClaimSegmentsInPlace,
  passageTextContent,
  isPassageInvisible,
} from '../utils/injecting';
import { mfBus } from '../utils/mfBus';
import type { Claim, Classification, TextSegment } from '../data/Classification';

export default defineUnlistedScript(() => {
  // Subframes get the file too on older builds that ignore frameIds: only the top
  // frame owns the selection, the wrap and the popover. A frame copy installs
  // nothing, answers nothing, and returns before touching the DOM or the runtime.
  // The popup no longer uses tabs.sendMessage (Safari delivered that to every
  // iframe and prompted for tracker origins); start is handed over in this world.
  try {
    if (window.self !== window.top) return;
  } catch {
    return;
  }

  /** Which copy of this script owns the page.
   *
   *  The background injects this file on every context-menu click and on every popup probe,
   *  so a page accumulates copies. Only the newest one acts; the rest stay mounted and
   *  silent (see `current` below).
   *
   *  This used to be a plain boolean latch, set once and never cleared, on the grounds that
   *  it dies with the process anyway. It does not die with the *extension*, which is the
   *  thing that actually changes: reloading the extension with a page open leaves the page's
   *  flag set while the listeners behind it belong to a context that no longer exists, so
   *  every later injection read the flag, returned, and registered nothing. The page went
   *  permanently mute — the background logged a bare `undefined` for the menu click and the
   *  popup read "nothing is selected", both with a clean console — and only a page reload
   *  could clear it.
   *
   *  Ownership is therefore a *handler*, not a counter. The newest copy installs its own
   *  message listener and then retires the previous copy's, so at most one listener is ever
   *  registered and a superseded copy cannot go on listening. That distinction is the whole
   *  point: a counter tells a stale copy to keep quiet, but it leaves the stale copy's
   *  listener *installed*, and a listener that declines a message by returning is
   *  indistinguishable, at the sender, from a message that arrived nowhere. Where the sender
   *  settles on the first non-answering listener — Safari does — the newest copy's reply is
   *  lost behind an older copy's silence, and every symptom is the mute page this replaced
   *  the latch to fix: a bare `undefined` in the background, nothing at all in the page.
   *
   *  `FLAG` is kept for the background's diagnostic read, which reports it as proof the file
   *  reached this line; ownership itself is `RESPONDER`. */
  const FLAG = '__mfSelectionInjected';
  const RESPONDER = '__mfSelectionResponder';
  /** Safari's executeScript file world often has `browser`/`chrome` as script
   *  locals that are NOT on `globalThis`. WXT then binds its `browser` to
   *  `globalThis.chrome`, which is undefined, and the first `browser.runtime`
   *  access throws — before this file can publish the responder. Ask the
   *  locals via eval (the identifier must not be rewritten) and cache the
   *  winner on globalThis so later WXT reads succeed too. */
  function ext(): any {
    const g = globalThis as any;
    if (g.browser?.runtime) return g.browser;
    if (g.chrome?.runtime) return g.chrome;
    try {
      const b = eval('typeof browser !== "undefined" ? browser : null');
      if (b?.runtime) { g.browser = b; return b; }
    } catch { /* no local browser */ }
    try {
      const c = eval('typeof chrome !== "undefined" ? chrome : null');
      if (c?.runtime) { g.chrome = c; return c; }
    } catch { /* no local chrome */ }
    return null;
  }
  ext();
  /** One `classify` port for the whole page, shared across injected copies of this file.
   *
   *  The background injects this script on every context-menu click and every popup probe,
   *  and each copy used to `connect()` its own port. `broadcastNotification` fans a spend
   *  out to every live port, and every copy painted the toast (`MF_NOTIFICATION` is not
   *  gated on `pending`, so a leftover copy still shows it). One charge then stacked
   *  identical banners — the thing that looks like being billed twice. iPhone Safari does
   *  the same inject-per-gesture, which is why this showed up there with a single
   *  extension and no leftover Mac app instances.
   *
   *  The handler pointer is swapped only when a copy actually begins a run, so a probe
   *  that takes ownership (and retires the previous onMessage listener) does not steal
   *  CLASSIFICATION updates or notifications from the copy that still has the wrap. */
  const PORT_KEY = '__mfClassifyPort';
  const PORT_HANDLER_KEY = '__mfClassifyPortHandler';
  const w = window as unknown as Record<string, unknown>;
  const generation = (typeof w[FLAG] === 'number' ? (w[FLAG] as number) : 0) + 1;
  w[FLAG] = generation;

  /** The listener this copy installs, assigned in the entry-points block below and read by
   *  `current`. Declared here because `current` is a hoisted function declaration and would
   *  otherwise reach a `const` in its dead zone if anything asked before that block ran. */
  let owner: unknown;

  /** Whether this copy is still the one the page is on. Every entry point that acts on a
   *  message asks this first: two copies both answering one click would each start a
   *  fact-check, and the page-world handoff is a single `dataset` slot that cannot be
   *  consumed twice. */
  function current(): boolean {
    return owner !== undefined && w[RESPONDER] === owner;
  }

  const MAX_BEFORE_WORDS = 250;
  const MAX_AFTER_WORDS = 25;

  /** Block-level elements whose text bounds the context window. Deliberately a union of
   *  the common prose containers: `closest()` matches the INNERMOST one, which is what
   *  keeps one paragraph's context from leaking in a sibling paragraph's text. */
  const BLOCK_SELECTOR =
    'p,li,dd,dt,td,th,caption,figcaption,blockquote,pre,article,section,aside,main,div,h1,h2,h3,h4,h5,h6';

  const MSG_START = 'MF_SELECTION_START';
  const MSG_PROBE = 'MF_SELECTION_PROBE';

  type SelectionCapture = {
    id: string;
    /** Up to MAX_BEFORE_WORDS words preceding the selection, or "" when it opens a block. */
    before: string;
    /** Up to MAX_AFTER_WORDS words following the selection, or "" at the end of a block. */
    after: string;
    /** The selection's OWN text, taken from the DOM after extraction so it is guaranteed
     *  to align character-for-character with the offsets the worker returns ranges in. */
    selected: string;
    wrap: HTMLElement | null;
    /** Viewport coordinates just under the selection, read in the page's own world while
     *  the selection was still live. Only carried when there is no wrap to anchor to —
     *  without it a surface that cannot be wrapped gets its claims floated at the top of
     *  the window, attached to nothing. */
    rect?: { x: number; y: number } | null;
    /** Skip the web-select pipeline: the selection only hit X tweets that already
     *  have button injections, and those tweets were fired as Disinfact instead. */
    tweetOnly?: boolean;
    /** Reselect of a passage that already had highlights: skip the hash-hit so
     *  the worker re-preclassifies and the new wrap is the only one left. */
    force?: boolean;
  };

  /** The capture being fact-checked. Held past the start so the streaming updates that
   *  follow (verdicts landing on the claims already rendered) still have a target. */
  let pending: SelectionCapture | null = null;
  /** Every in-flight web-select wrap on this page (leftover islands after an X
   *  tweet split, or a reselect). CLASSIFICATION is matched by id against this. */
  const liveCaptures = new Map<string, SelectionCapture>();
  /** Extra leftover islands from a split X selection, consumed by begin(). */
  let extraLeftoverCaptures: SelectionCapture[] = [];
  let port: Browser.runtime.Port | null = null;
  let hud: HTMLElement | null = null;
  /** The last classification the background sent for this selection. Kept so the scroll
   *  handler can ask whether the run has settled without going back over the port. */
  let latest: Classification | null = null;
  /** Scroll events fire for every scroller on the page and far faster than the answer to
   *  "are the highlights off-screen?" can change, so the check is rate-limited. */
  let lastFloatingCheckAt = 0;
  const FLOATING_CHECK_INTERVAL_MS = 200;

  // ── Small helpers ──────────────────────────────────────────────────────────

  function t(key: string, fallback: string): string {
    try {
      // The generated message-key union only covers the keys this build declares; the
      // lookup is deliberately dynamic so a locale missing a string still falls back.
      return ext()?.i18n?.getMessage(key) || fallback;
    } catch {
      return fallback;
    }
  }

  function uiLocale(): string {
    try {
      return ext()?.i18n?.getUILanguage() || 'en';
    } catch {
      return 'en';
    }
  }

  // ── Styles ─────────────────────────────────────────────────────────────────

  /** The X.com stylesheet gives the claim spans, the badges and the popover their real look,
   *  so a webpage's highlights are the ones the user sees on a tweet. The rules below cover
   *  only what is unique to this flow: the "Disinfacting" indicator, and the z-index the
   *  popover needs on a page whose own chrome is stacked high. */
  const SELECTION_STYLES = `
/* .mf-popover is z-index 1 in the X stylesheet, which is right inside a tweet's own
   stacking context and wrong on an arbitrary page: a sticky header or a cookie bar with a
   four-digit z-index would draw over the window. The popover is appended to a container on
   THIS page, so the comparison is against this page's z-indices, not X's. */
.mf-popover { z-index: 2147483647 !important; }
.mf-sel-hud {
    position: absolute;
    z-index: 2147483646;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    border-radius: 999px;
    background: #16181c;
    color: #e7e9ea;
    font: 500 13px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    box-shadow: 0 2px 10px rgba(0,0,0,0.35);
    pointer-events: none;
    max-width: min(420px, 90vw);
}
@media (prefers-color-scheme: light) {
    .mf-sel-hud { background: #ffffff; color: #0f1419; box-shadow: 0 2px 10px rgba(0,0,0,0.18); }
}
.mf-sel-hud .mf-spinner { width: 13px; height: 13px; margin-right: 0; }
.mf-sel-hud-list {
    position: fixed;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
    pointer-events: auto;
    padding: 10px 12px;
    border-radius: 12px;
    max-height: 60vh;
    overflow-y: auto;
}
.mf-sel-hud-row { display: flex; align-items: flex-start; gap: 8px; }
`;

  function injectStyles(): void {
    const style = document.createElement('style');
    style.dataset.mfSelection = 'true';
    style.textContent = getInlineStyles() + SELECTION_STYLES;
    (document.head || document.documentElement).appendChild(style);
  }

  // ── Capture ────────────────────────────────────────────────────────────────

  /** How many neighbouring blocks a context window may reach into before it gives up. The
   *  selection's own block is always the first step; this bounds the walk so a page with
   *  thousands of siblings cannot turn a selection into a full-document scan, and so the
   *  context stays "nearby text" rather than the whole article. */
  const MAX_CONTEXT_BLOCKS = 8;

  /** Story body the sibling walk is allowed to leave the enclosing block for. Innermost
   *  match: `articleBody` is the body itself, `article` is the story, `main` is the
   *  last-resort landmark. Ads, recirc and tickers sit NEXT to these, so a hash that
   *  never leaves this root does not move when CBC swaps them. No match → same-block
   *  only (see contextBefore / contextAfter): today's body-wide sibling walk was what
   *  pulled those ads into `before`/`after`. */
  const ARTICLE_ROOT_SELECTOR = '[itemprop="articleBody"], article, main';

  /** Elements whose text is code or chrome, never prose. A sibling `<div>` holding an
   *  inline `<script>` (or a `<style>` block) would otherwise contribute its source to the
   *  context — text the user never saw on the page. */
  const NON_PROSE = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|HEAD|TITLE|SVG|CANVAS|IFRAME)$/;

  /** Landmarks that are next to the story, not in it. Skipped as siblings and as
   *  subtrees so a recirc `<aside>` inside `article` cannot become `contextAfter`. */
  const CHROME = /^(ASIDE|NAV|FOOTER|HEADER|MENU)$/;
  const CHROME_ROLES = new Set(['complementary', 'navigation', 'banner', 'contentinfo', 'search', 'menu']);

  function articleRoot(el: Element | null | undefined): Element | null {
    return el?.closest(ARTICLE_ROOT_SELECTOR) ?? null;
  }

  function isChrome(el: Element): boolean {
    if (CHROME.test(el.tagName)) return true;
    if (el.hasAttribute('hidden')) return true;
    if (el.getAttribute('aria-hidden') === 'true') return true;
    if (isPassageInvisible(el)) return true;
    const role = (el.getAttribute('role') ?? '').toLowerCase();
    return CHROME_ROLES.has(role);
  }

  /** The preceding sibling worth reading, or null at the edge of the article (or the
   *  container, when there is no article). Never climbs to a parent: a paragraph's
   *  neighbours are its siblings, and ascending would pull in headers, nav, and
   *  sidebars that have nothing to do with the claim. `root` is the article the
   *  selection lives in — a sibling outside it is an ad/recirc slot, not prose. */
  function previousContextBlock(node: Element, root: Element | null): Element | null {
    let prev = node.previousElementSibling;
    while (prev && (NON_PROSE.test(prev.tagName) || isChrome(prev))) prev = prev.previousElementSibling;
    if (!prev) return null;
    if (root && !root.contains(prev)) return null;
    return prev;
  }

  function nextContextBlock(node: Element, root: Element | null): Element | null {
    let next = node.nextElementSibling;
    while (next && (NON_PROSE.test(next.tagName) || isChrome(next))) next = next.nextElementSibling;
    if (!next) return null;
    if (root && !root.contains(next)) return null;
    return next;
  }

  function toWords(text: string): string[] {
    return text.trim().split(/\s+/).filter(Boolean);
  }

  /** Strip leading/trailing whitespace from the wrap's own text nodes so
   *  `selected` and the DOM the worker ranges index stay the same string.
   *  Does not flatten formatting — empty edge text nodes are left (or
   *  emptied) in place. */
  function trimWrapTextEdges(root: HTMLElement): void {
    const nodes: Text[] = [];
    const walk = (n: Node) => {
      for (const c of Array.from(n.childNodes)) {
        if (c.nodeType === Node.TEXT_NODE) nodes.push(c as Text);
        else if (c.nodeType === Node.ELEMENT_NODE) {
          if (isPassageInvisible(c as Element)) continue;
          walk(c);
        }
      }
    };
    walk(root);
    for (const n of nodes) {
      const stripped = n.data.replace(/^\s+/, '');
      if (stripped.length === n.data.length) break;
      n.data = stripped;
      if (n.data.length > 0) break;
    }
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (!n.isConnected) continue;
      const stripped = n.data.replace(/\s+$/, '');
      if (stripped.length === n.data.length) break;
      n.data = stripped;
      if (n.data.length > 0) break;
    }
  }

  /** Leading/trailing whitespace is never a claim. Trim it off the three
   *  strings the worker hashes, and off the wrap those strings must still
   *  match character-for-character. */
  function trimCapture(capture: SelectionCapture): SelectionCapture {
    const before = capture.before.trim();
    const after = capture.after.trim();
    if (capture.wrap?.isConnected) {
      trimWrapTextEdges(capture.wrap);
      return { ...capture, before, after, selected: (passageTextContent(capture.wrap) || capture.selected).trim() };
    }
    return { ...capture, before, after, selected: capture.selected.trim() };
  }

  /** A selection edge: the text node (or element child index) the walk stops at. */
  type Edge = { container: Node; offset: number };

  /** Append the prose inside `node` to `out`, skipping [[NON_PROSE]] subtrees. With an
   *  `edge`, the newline-free text is cut at that boundary — `side` says which half is
   *  wanted. Returns true only when a `before` edge has been consumed, so the ancestors
   *  know to stop walking.
   *
   *  A hand-rolled walk rather than a DOM Range because Range.toString() hands back every
   *  text node it spans, `<script>` source included, and there is no way to filter it. */
  function collect(node: Node, out: string[], side: 'before' | 'after', edge: Edge | null): boolean {
    if (edge && node === edge.container) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.nodeValue ?? '';
        out.push(side === 'before' ? text.slice(0, edge.offset) : text.slice(edge.offset));
      } else {
        const kids = Array.from(node.childNodes);
        const from = side === 'before' ? 0 : Math.min(edge.offset, kids.length);
        const to = side === 'before' ? Math.min(edge.offset, kids.length) : kids.length;
        for (let i = from; i < to; i++) collect(kids[i], out, side, edge);
      }
      // `after`: everything past this point is wanted, so the ancestors keep walking.
      return side === 'before';
    }
    if (node.nodeType === Node.TEXT_NODE) {
      out.push(node.nodeValue ?? '');
      return false;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    if (NON_PROSE.test((node as Element).tagName)) return false;
    if (isChrome(node as Element)) return false;
    if (isPassageInvisible(node as Element)) return false;
    for (const kid of Array.from(node.childNodes)) {
      if (collect(kid, out, side, edge)) return true;
    }
    return false;
  }

  function contextText(node: Node, side: 'before' | 'after', edge: Edge | null): string {
    const out: string[] = [];
    collect(node, out, side, edge);
    return out.join('');
  }

  /** The `max` words immediately preceding the selection, reaching back through the
   *  enclosing block and then — only inside an article root — its preceding siblings.
   *  No article / articleBody / main: stay in this block. The sibling walk is what
   *  used to swallow CBC's rotating ads into the hash. */
  function contextBefore(edge: Edge, block: Element, max: number, root: Element | null): string {
    const words: string[] = [];
    let node: Element | null = block;
    let at: Edge | null = edge;
    const hopsCap = root ? MAX_CONTEXT_BLOCKS : 1;
    for (let hops = 0; node && hops < hopsCap && words.length < max; hops++) {
      // Only the tail can survive the `max` cut, so a long block never materializes more
      // text than the cap needs.
      const chunk = toWords(contextText(node, 'before', at)).slice(-max);
      if (chunk.length) words.unshift(...chunk);
      at = null; // whole blocks from here out
      node = root ? previousContextBlock(node, root) : null;
    }
    return words.slice(-max).join(' ');
  }

  /** The `max` words immediately following the selection, reaching forward through the
   *  enclosing block and then — only inside an article root — its following siblings. */
  function contextAfter(edge: Edge, block: Element, max: number, root: Element | null): string {
    const words: string[] = [];
    let node: Element | null = block;
    let at: Edge | null = edge;
    const hopsCap = root ? MAX_CONTEXT_BLOCKS : 1;
    for (let hops = 0; node && hops < hopsCap && words.length < max; hops++) {
      const chunk = toWords(contextText(node, 'after', at)).slice(0, max);
      if (chunk.length) words.push(...chunk);
      at = null;
      node = root ? nextContextBlock(node, root) : null;
    }
    return words.slice(0, max).join(' ');
  }

  /** Text between the start of the enclosing block and the selection, then that same block
   *  from the selection's end to its close. Inside an article root, each side spills into
   *  neighbouring story blocks when its own runs out — the common case of a selection that
   *  OPENS its paragraph would otherwise send no `before` at all, leaving a bare "he will
   *  sign it next week" with nothing to resolve "he" against. Outside an article, there is
   *  no spill: sibling chrome is what used to poison the hash. */
  function contextAround(range: Range): { before: string; after: string } {
    let before = '';
    let after = '';
    try {
      const startEl =
        range.startContainer.nodeType === Node.ELEMENT_NODE
          ? (range.startContainer as Element)
          : range.startContainer.parentElement;
      const endEl =
        range.endContainer.nodeType === Node.ELEMENT_NODE
          ? (range.endContainer as Element)
          : range.endContainer.parentElement;

      const startBlock = startEl?.closest(BLOCK_SELECTOR) ?? document.body;
      const endBlock = endEl?.closest(BLOCK_SELECTOR) ?? document.body;
      const startRoot = articleRoot(startBlock);
      const endRoot = articleRoot(endBlock);

      if (startBlock) {
        before = contextBefore({ container: range.startContainer, offset: range.startOffset }, startBlock, MAX_BEFORE_WORDS, startRoot);
      }
      if (endBlock) {
        after = contextAfter({ container: range.endContainer, offset: range.endOffset }, endBlock, MAX_AFTER_WORDS, endRoot);
      }
    } catch (err) {
      // Context is a bonus, never a requirement — a detached or mid-re-render selection
      // must not stop the fact-check itself.
      console.log('[selection] context extraction failed:', err);
    }
    return { before, after };
  }

  /** The same context, measured around a wrap element instead of a live range.
   *
   *  This is what lets the read happen in the page's own world without duplicating any of
   *  the walking above: only the extraction of the selection needs a live Range, and the
   *  wrap it leaves behind sits in the DOM both worlds share. Everything the wrap's edges
   *  need — the text before it and the text after it — is an edge on its parent at the
   *  wrap's own child index, which is exactly the shape `collect` already cuts at. */
  function contextAroundElement(el: Element): { before: string; after: string } {
    let before = '';
    let after = '';
    try {
      const parent = el.parentNode;
      if (parent) {
        const at = Array.prototype.indexOf.call(parent.childNodes, el);
        const block = el.parentElement?.closest(BLOCK_SELECTOR) ?? document.body;
        const root = articleRoot(block);
        before = contextBefore({ container: parent, offset: at }, block, MAX_BEFORE_WORDS, root);
        after = contextAfter({ container: parent, offset: at + 1 }, block, MAX_AFTER_WORDS, root);
      }
    } catch (err) {
      // As above: context is a bonus, never a requirement.
      console.log('[selection] page-world context extraction failed:', err);
    }
    return { before, after };
  }

  /** Whether this world can read the range's boundaries at all.
   *
   *  Safari gives an extension's isolated world a selection object of its own, and one that
   *  holds a range can still fail to hand that range's containers across the world boundary:
   *  `isCollapsed` reads false and `rangeCount` reads 1 while `startContainer` comes back
   *  undefined. Reading `.isConnected` (or `.nodeType`) off that throws, and every caller
   *  here is a deferred message handler, so the throw left the message unanswered — the
   *  background logged `undefined` and the page's own world, the one place the selection IS
   *  readable, was never asked. An unreadable range is therefore "nothing this world can
   *  read", never an error. */
  function rangeIsReadable(range: Range | null | undefined): range is Range {
    return !!range && !!range.startContainer && !!range.endContainer;
  }

  /** The element last right-clicked, and Firefox's `menus.getTargetElement` id for
   *  this click. A lazy Disinfact (no real selection) expands from that node. */
  let lastContextTarget: Element | null = null;
  let pendingTargetElementId: number | null = null;

  document.addEventListener('contextmenu', (e) => {
    lastContextTarget = e.target instanceof Element ? e.target : null;
  }, true);

  function resolveContextTarget(): Element | null {
    if (typeof pendingTargetElementId === 'number') {
      try {
        const api = ext() as any;
        const el = api?.menus?.getTargetElement?.(pendingTargetElementId)
          ?? api?.contextMenus?.getTargetElement?.(pendingTargetElementId);
        if (el instanceof Element) return el;
      } catch { /* Firefox-only API, or the id already expired */ }
    }
    return lastContextTarget?.isConnected ? lastContextTarget : null;
  }

  /** A right-click "selection": empty (Firefox), one character, or one word. */
  function isThinText(text: string): boolean {
    const t = text.trim();
    return t.length === 0 || t.length === 1 || !/\s/.test(t);
  }

  function expandRangeToNeighborLines(range: Range): Range {
    const startEl =
      range.startContainer.nodeType === Node.ELEMENT_NODE
        ? (range.startContainer as Element)
        : range.startContainer.parentElement;
    const block = startEl?.closest(BLOCK_SELECTOR);
    if (!block || block === document.body || block === document.documentElement) return range;
    const root = articleRoot(block);
    const from = previousContextBlock(block, root) ?? block;
    const to = nextContextBlock(block, root) ?? block;
    const expanded = document.createRange();
    try {
      expanded.setStartBefore(from);
      expanded.setEndAfter(to);
    } catch {
      return range;
    }
    return expanded;
  }

  function rangeFromTarget(el: Element): Range | null {
    const block = el.closest(BLOCK_SELECTOR);
    if (!block || block === document.body || block === document.documentElement) return null;
    const seed = document.createRange();
    try {
      seed.selectNodeContents(block);
      seed.collapse(true);
    } catch {
      return null;
    }
    return expandRangeToNeighborLines(seed);
  }

  /** True for a selection inside a form field, where there is no text node to wrap and
   *  replacing the contents would rewrite the user's own input. */
  function isInEditable(range: Range): boolean {
    const el =
      range.startContainer.nodeType === Node.ELEMENT_NODE
        ? (range.startContainer as Element)
        : range.startContainer.parentElement;
    if (!el) return false;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return true;
    return el instanceof HTMLElement && el.isContentEditable;
  }

  function onXHost(): boolean {
    const h = location.hostname.replace(/^www\./, '');
    return h === 'x.com' || h === 'twitter.com' || h.endsWith('.x.com') || h.endsWith('.twitter.com');
  }

  function rangeIntersectsElement(range: Range, el: Element): boolean {
    try {
      const nr = document.createRange();
      nr.selectNodeContents(el);
      return range.compareBoundaryPoints(Range.START_TO_END, nr) < 0
        && range.compareBoundaryPoints(Range.END_TO_START, nr) > 0;
    } catch {
      return el.contains(range.startContainer) || el.contains(range.endContainer)
        || range.startContainer === el || range.endContainer === el;
    }
  }

  function tweetIdFromArticle(article: Element): string | null {
    const links = article.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]');
    for (const link of Array.from(links)) {
      if (link.closest('article') !== article) continue;
      const m = (link.getAttribute('href') || '').match(/\/status\/(\d+)/);
      if (m) return m[1];
    }
    return null;
  }

  /** Tweets whose Disinfact/refresh chrome is already injected — the only tweets
   *  that must not go through web-select. X articles and tweets whose anchors
   *  were missing stay on the web-select path. Nested quoted articles are
   *  their own tweets: a quote's buttons do not count as the outer's. */
  function ownButton(article: Element, selector: string): HTMLElement | null {
    for (const el of Array.from(article.querySelectorAll<HTMLElement>(selector))) {
      if (el.closest('article') === article) return el;
    }
    return null;
  }

  function articleHasButtonInjections(article: Element): boolean {
    return !!ownButton(
      article,
      '[data-mf-charge="disinfact"], [data-mf-charge="refresh-top"], [data-mf-charge="factcheckall"], [data-mf-charge="translate-tweet"], [mf-on-hold-id], [mf-top-bar-id], [translate-fc-id], [mf-refresh-id], [mf-visual-id]',
    );
  }

  function injectedTweetArticlesIntersecting(range: Range): Element[] {
    if (!onXHost()) return [];
    const seen = new Set<Element>();
    const ancestor = range.commonAncestorContainer;
    const root = ancestor.nodeType === Node.ELEMENT_NODE
      ? (ancestor as Element)
      : ancestor.parentElement;
    if (!root) return [];
    const scope = root.closest('article')?.parentElement ?? root;
    for (const article of Array.from(scope.querySelectorAll('article'))) {
      if (!articleHasButtonInjections(article)) continue;
      if (!tweetIdFromArticle(article)) continue;
      if (rangeIntersectsElement(range, article)) seen.add(article);
    }
    const startArticle = (range.startContainer.nodeType === Node.ELEMENT_NODE
      ? (range.startContainer as Element)
      : range.startContainer.parentElement)?.closest('article');
    const endArticle = (range.endContainer.nodeType === Node.ELEMENT_NODE
      ? (range.endContainer as Element)
      : range.endContainer.parentElement)?.closest('article');
    for (const a of [startArticle, endArticle]) {
      if (a && articleHasButtonInjections(a) && tweetIdFromArticle(a) && rangeIntersectsElement(range, a)) {
        seen.add(a);
      }
    }
    return Array.from(seen).sort((a, b) =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1,
    );
  }

  function fireTweetAsDisinfact(article: Element): void {
    const disinfact = ownButton(article, 'button[data-mf-charge="disinfact"]');
    if (disinfact) { disinfact.click(); return; }
    const refresh = ownButton(article, 'button[data-mf-charge="refresh-top"]');
    if (refresh) { refresh.click(); return; }
    const tweetId = tweetIdFromArticle(article);
    if (!tweetId) return;
    mfBus.dispatchEvent(new CustomEvent('mf-process-on-hold', { detail: { tweetId } }));
  }

  function leftoverRanges(range: Range, holes: Element[]): Range[] {
    if (holes.length === 0) return [range.cloneRange()];
    const pieces: Range[] = [];
    let fromContainer: Node = range.startContainer;
    let fromOffset = range.startOffset;
    for (const hole of holes) {
      try {
        const piece = document.createRange();
        piece.setStart(fromContainer, fromOffset);
        piece.setEndBefore(hole);
        if (piece.compareBoundaryPoints(Range.START_TO_START, range) < 0) {
          piece.setStart(range.startContainer, range.startOffset);
        }
        if (piece.compareBoundaryPoints(Range.END_TO_END, range) > 0) {
          piece.setEnd(range.endContainer, range.endOffset);
        }
        if (!piece.collapsed && piece.toString().trim()) pieces.push(piece);
      } catch { /* hole detached or inverted */ }
      try {
        const after = document.createRange();
        after.setStartAfter(hole);
        fromContainer = after.startContainer;
        fromOffset = after.startOffset;
      } catch {
        return pieces;
      }
    }
    try {
      const tail = document.createRange();
      tail.setStart(fromContainer, fromOffset);
      tail.setEnd(range.endContainer, range.endOffset);
      if (!tail.collapsed && tail.toString().trim()) pieces.push(tail);
    } catch { /* inverted */ }
    return pieces.filter((p) => !holes.some((h) => rangeIntersectsElement(p, h)));
  }

  /** Fold a previous web-select wrap back to the page's own nodes so a reselect
   *  can own that area. Claim spans become their children; the wrap itself is
   *  unwrapped. X tweet wraps (no `data-mf-sel-wrap`) are left alone. */
  function foldSelectionWrap(wrap: HTMLElement): void {
    for (const span of Array.from(wrap.querySelectorAll('.mf-segment-claim'))) {
      for (const chrome of Array.from(span.querySelectorAll('.mf-inline-badge, .mf-standalone-spinner'))) {
        chrome.remove();
      }
      if (span.childNodes.length === 0) span.replaceWith(document.createTextNode(span.textContent ?? ''));
      else span.replaceWith(...Array.from(span.childNodes));
    }
    if (!wrap.parentNode) { wrap.remove(); return; }
    wrap.replaceWith(...Array.from(wrap.childNodes));
  }

  function unwrapOverlappingSelectionWraps(range: Range): boolean {
    const wraps = Array.from(document.querySelectorAll<HTMLElement>('.mf-segment-wrap[data-mf-sel-wrap="true"]'))
      .filter((w) => w.isConnected && rangeIntersectsElement(range, w))
      .sort((a, b) => (b.contains(a) ? -1 : a.contains(b) ? 1 : 0));
    if (wraps.length === 0) return false;
    for (const wrap of wraps) foldSelectionWrap(wrap);
    return true;
  }

  /** What the document's selection actually looks like, for the log. A null from
   *  `readSelection` has four causes that are indistinguishable from outside — no
   *  selection, a collapsed one, an unconnected range, an editable host, blank text — and
   *  "the extension did nothing" is the same report for all five. This is the only way to
   *  tell them apart without a debugger, so it reports the whole state rather than the
   *  verdict. Never throws: it runs only on a path that has already failed. */
  function describeSelection(): string {
    try {
      const sel = window.getSelection();
      if (!sel) return 'no selection object';
      if (sel.rangeCount === 0) return 'rangeCount 0';
      const range = sel.getRangeAt(0);
      // Named explicitly rather than left to the catch below, because this is the one state
      // that reads as a live selection here and still cannot be read: the verdict otherwise
      // arrives as "unreadable: TypeError", which says nothing about whose fault it is.
      if (!rangeIsReadable(range)) {
        return `collapsed=${sel.isCollapsed} rangeCount=${sel.rangeCount} range containers unreadable in this world`;
      }
      const text = range.toString();
      return [
        `collapsed=${sel.isCollapsed}`,
        `rangeCount=${sel.rangeCount}`,
        // The selection's own string as well as its range's, because they are not the same
        // thing and the difference is the whole Safari story: this world's selection can
        // carry the text while its range carries none of it.
        `selText=${String(sel).length}`,
        `len=${text.length}`,
        `trimmed=${text.trim().length}`,
        `connected=${range.startContainer.isConnected && range.endContainer.isConnected}`,
        `editable=${isInEditable(range)}`,
        `head=${JSON.stringify(text.slice(0, 40))}`,
      ].join(' ');
    } catch (err) {
      return `unreadable: ${String(err)}`;
    }
  }

  /** Read the current selection, and — only when `extract` — also re-parent it into a
   *  `.mf-segment-wrap` so claim ranges can be wrapped inside it.
   *
   *  `extract: false` is the probe the popup runs on open, and it MUST stay
   *  non-destructive: a popup opened for any other reason would otherwise consume the
   *  user's selection and leave them with nothing highlighted.
   *
   *  On extraction the wrap owns the text: `selected` is read back OUT of the DOM rather
   *  than from `selection.toString()`, because `toString()` normalizes whitespace across
   *  block boundaries (inserting newlines a selection of several paragraphs never had) and
   *  those extra characters would shift every range the worker computes. */
  function readSelection(extract: boolean, opts?: { expandThin?: boolean }): SelectionCapture | null {
    const sel = window.getSelection();
    let range: Range | null = null;
    if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
      const live = sel.getRangeAt(0);
      const usable = rangeIsReadable(live)
          && live.startContainer.isConnected
          && live.endContainer.isConnected
          && !isInEditable(live)
          && live.toString().trim();
      if (usable) {
        range = opts?.expandThin && isThinText(live.toString())
          ? expandRangeToNeighborLines(live)
          : live;
      }
    }
    // Context-menu Disinfact only: a collapsed/empty click (Firefox) or a
    // leftover word-click still expands from the node that was right-clicked.
    if (!range && opts?.expandThin) {
      const target = resolveContextTarget();
      if (target && !isChrome(target) && !NON_PROSE.test(target.tagName)) {
        const expanded = rangeFromTarget(target);
        if (expanded && rangeIsReadable(expanded) && expanded.toString().trim()) range = expanded;
      }
    }
    if (!range) return null;
    if (!rangeIsReadable(range)) return null;
    if (!range.startContainer.isConnected || !range.endContainer.isConnected) return null;
    if (isInEditable(range)) return null;
    if (!range.toString().trim()) return null;

    if (extract) extraLeftoverCaptures = [];
    const overlapping = extract && unwrapOverlappingSelectionWraps(range);
    if (overlapping && (!range.startContainer?.isConnected || !range.endContainer?.isConnected)) {
      const live = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
      if (live && rangeIsReadable(live) && live.startContainer.isConnected && live.endContainer.isConnected) {
        range = live;
      }
    }
    const injectedTweets = extract ? injectedTweetArticlesIntersecting(range) : [];
    if (extract && injectedTweets.length > 0) {
      for (const article of injectedTweets) fireTweetAsDisinfact(article);
      const leftovers = leftoverRanges(range, injectedTweets);
      sel?.removeAllRanges();
      extraLeftoverCaptures = [];
      if (leftovers.length === 0) {
        return {
          id: `sel_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          before: '',
          after: '',
          selected: '',
          wrap: null,
          tweetOnly: true,
        };
      }
      const leftoverCaptures: SelectionCapture[] = [];
      for (let i = leftovers.length - 1; i >= 0; i--) {
        const cap = wrapRange(leftovers[i], overlapping);
        if (cap) leftoverCaptures.unshift(cap);
      }
      if (leftoverCaptures.length === 0) {
        return {
          id: `sel_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          before: '',
          after: '',
          selected: '',
          wrap: null,
          tweetOnly: true,
        };
      }
      leftoverCaptures[0].force = leftoverCaptures[0].force || overlapping;
      extraLeftoverCaptures = leftoverCaptures.slice(1).map((c) => ({ ...c, force: c.force || overlapping }));
      return leftoverCaptures[0];
    }

    if (!extract) {
      const { before, after } = contextAround(range);
      const id = `sel_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      return trimCapture({ id, before, after, selected: range.toString(), wrap: null });
    }

    const capture = wrapRange(range, overlapping);
    if (capture) sel?.removeAllRanges();
    return capture;
  }

  function wrapRange(range: Range, force: boolean): SelectionCapture | null {
    if (!rangeIsReadable(range)) return null;
    if (!range.toString().trim()) return null;
    const { before, after } = contextAround(range);
    const id = `sel_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    let wrap: HTMLElement | null = null;
    let selected = range.toString();
    try {
      wrap = document.createElement('span');
      wrap.className = 'mf-segment-wrap';
      wrap.dataset.mfSelWrap = 'true';
      wrap.appendChild(range.extractContents());
      range.insertNode(wrap);
      selected = passageTextContent(wrap) || wrap.textContent || selected;
    } catch (err) {
      console.log('[selection] could not wrap the selection in place:', err);
      wrap?.remove();
      wrap = null;
    }
    if (!selected.trim()) {
      wrap?.remove();
      return null;
    }
    return trimCapture({ id, before, after, selected, wrap, force });
  }

  /** A capture with nothing to anchor to: the claims still render, they just render as a
   *  list instead of wrapped spans. The popup-took-focus path already produces these, and
   *  so does a page-world read whose range could not be re-parented. */
  function unanchored(selected: string, rect?: { x: number; y: number } | null): SelectionCapture {
    return trimCapture({ id: `pw_${Date.now().toString(36)}`, before: '', after: '', selected, wrap: null, rect });
  }

  /** The selection's text with no range behind it — the one thing this world can read on
   *  Safari, where the selection carries the whole string but its range carries nothing.
   *
   *  Last resort, after both worlds have tried: a page whose selection cannot be wrapped
   *  anywhere should still get fact-checked, with its claims listed. Note the text comes
   *  from `toString()` and so has the whitespace normalization `readSelection` warns about
   *  — harmless here, because with no range there is nothing for the offsets to shift. */
  function readSelectionTextOnly(): SelectionCapture | null {
    const sel = window.getSelection();
    const text = sel ? String(sel) : '';
    return text.trim() ? unanchored(text) : null;
  }

  /** Collect the capture the page's own world has just made, if there is one.
   *
   *  Safari's isolated world gets a selection object of its own per document, and it stays
   *  empty while the page's holds the whole selection — so on Safari `readSelection` above
   *  never sees anything, and this is the read that works. Chrome shares one selection
   *  across worlds, so there the local read wins first and this finds nothing to collect.
   *
   *  The handoff is the wrap itself, through the DOM both worlds see, and the id is what
   *  makes it this capture's wrap and not an older Disinfact's: the page world writes it
   *  onto the document element and it is consumed here, once. */
  function captureFromPageWorld(): SelectionCapture | null {
    const tweetOnly = document.documentElement.dataset.mfSelTweetOnly === '1';
    const force = document.documentElement.dataset.mfSelForce === '1';
    const extraIds = (document.documentElement.dataset.mfSelIds ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const tweetIds = (document.documentElement.dataset.mfSelTweetIds ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    delete document.documentElement.dataset.mfSelTweetOnly;
    delete document.documentElement.dataset.mfSelForce;
    delete document.documentElement.dataset.mfSelIds;
    delete document.documentElement.dataset.mfSelTweetIds;
    for (const tweetId of tweetIds) {
      mfBus.dispatchEvent(new CustomEvent('mf-process-on-hold', { detail: { tweetId } }));
    }
    const collectWrap = (wrapId: string): SelectionCapture | null => {
      const wrap = document.querySelector<HTMLElement>(`[data-mf-sel-id="${wrapId}"]`);
      const selected = wrap ? (passageTextContent(wrap) || wrap.textContent || '') : '';
      if (!wrap?.isConnected || !selected.trim()) {
        wrap?.remove();
        return null;
      }
      const { before, after } = contextAroundElement(wrap);
      return trimCapture({ id: wrapId, before, after, selected, wrap, force });
    };
    const id = document.documentElement.dataset.mfSelId;
    delete document.documentElement.dataset.mfSelId;
    const ids = extraIds.length > 0 ? extraIds : (id ? [id] : []);
    const captures: SelectionCapture[] = [];
    for (const wrapId of ids) {
      const cap = collectWrap(wrapId);
      if (cap) captures.push(cap);
    }
    extraLeftoverCaptures = captures.slice(1);
    if (captures[0]) return captures[0];
    if (tweetOnly || tweetIds.length > 0) {
      return {
        id: `sel_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        before: '',
        after: '',
        selected: '',
        wrap: null,
        tweetOnly: true,
      };
    }
    if (id) console.log('[selection] page-world wrap held no text');
    return null;
  }

  /** Ask the background for the page's own selection. The page script cannot run code in
   *  the page's world itself — `scripting` is not an API a content script is given — and
   *  the background is the only context that can.
   *
   *  Resolves to the background's reply: `{ok:true}` after a wrap the capture above can
   *  collect, or `{ok:false, why, text}` when the page's world could read the text but not
   *  re-parent the range, which still fact-checks — just unanchored. */
  async function requestPageWorldCapture(): Promise<any> {
    try {
      const reply = await ext()?.runtime.sendMessage({ type: 'MF_SELECTION_PAGE_WORLD_CAPTURE' });
      console.log('[selection] page-world capture answered:', JSON.stringify(reply));
      return reply ?? null;
    } catch (err) {
      console.log('[selection] page-world capture request failed:', err);
      return null;
    }
  }

  /** The same question, read-only. The probe must never consume the selection: the popup
   *  opens for the balance far more often than it opens to Disinfact something. */
  async function requestPageWorldProbe(): Promise<string> {
    try {
      const reply: any = await ext()?.runtime.sendMessage({ type: 'MF_SELECTION_PAGE_WORLD_PROBE' });
      return typeof reply?.text === 'string' ? reply.text : '';
    } catch (err) {
      console.log('[selection] page-world probe request failed:', err);
      return '';
    }
  }

  // ── The "Disinfacting" indicator ───────────────────────────────────────────

  function removeHud(): void {
    hud?.remove();
    hud = null;
  }

  function showHud(capture: SelectionCapture): void {
    removeHud();
    const el = document.createElement('div');
    el.className = 'mf-sel-hud';

    const spinner = document.createElement('span');
    spinner.className = 'mf-spinner';
    const label = document.createElement('span');
    label.textContent = t('disinfacting', 'Disinfacting');

    el.appendChild(spinner);
    el.appendChild(label);
    document.body.appendChild(el);
    hud = el;

    // Anchored to the wrap when one exists, so it appears exactly where the user is
    // reading; otherwise on the selection the page's world measured; otherwise centred,
    // since no anchor survived.
    if (capture.wrap?.isConnected) {
      const rect = capture.wrap.getBoundingClientRect();
      el.style.top = `${window.scrollY + Math.max(8, rect.top - 34)}px`;
      el.style.left = `${window.scrollX + Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - 220))}px`;
    } else if (!placeBelowSelection(el, capture)) {
      el.style.position = 'fixed';
      el.style.top = '12px';
      el.style.left = '50%';
      el.style.transform = 'translateX(-50%)';
    }
  }

  /** Put a panel at the selection when there is no wrap to hang it on.
   *
   *  A surface that cannot be wrapped — an editor's own text above all — otherwise reports
   *  from the top of the window, with nothing connecting the verdict to the words it is
   *  about. The coordinates come from the page's own world, measured while the selection
   *  was still live, and are viewport-relative, so the panel is fixed rather than absolute.
   *  Returns false when there was no anchor to use, leaving the caller its centring. */
  function placeBelowSelection(el: HTMLElement, capture: SelectionCapture | null | undefined): boolean {
    const rect = capture?.rect;
    if (!rect) return false;
    el.style.position = 'fixed';
    el.style.transform = 'none';
    el.style.top = `${Math.max(8, Math.min(rect.y, window.innerHeight - 80))}px`;
    el.style.left = `${Math.max(8, Math.min(rect.x, window.innerWidth - 300))}px`;
    return true;
  }

  // ── Claim rendering ────────────────────────────────────────────────────────

  // ── The verdict badge ───────────────────────────────────────────────────────

  /** Which part of a badge a point falls in: the slot or the verdict word it belongs to,
   *  rather than the node itself, since the widening moves no part out from under a point
   *  that stays within it. (badgePartOf, utils/injecting.ts.) */
  /** Synthetic-coordinate-safe hit-test, same contract as the page's own
   *  `mfElementFromPoint` (utils/injecting.ts): a dispatched event naming no
   *  coordinates reads as "nothing hit", never a throw. Duplicated (not imported)
   *  because that helper is module-private to the page bundle. */
  function selElementFromPoint(x: number, y: number): Element | null {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    try {
      return document.elementFromPoint(x, y);
    } catch {
      return null;
    }
  }

  function badgePartAt(x: number, y: number): Element | null {
    return selElementFromPoint(x, y)?.closest('.mf-badge-verdict, .mf-badge-slot') ?? null;
  }

  /** Hold a badge open while the pointer is with it, for as long as its hover has widened it.
   *
   *  Hovering the verdict word reveals the slots that hold no adjective — a score of 0.9 or
   *  better has none — and the widening slides the badge's own parts out from under the
   *  pointer that widened them: the hover is lost, the badge shrinks back under the pointer,
   *  and it widens again, flickering at frame rate. So the reveal is held (mf-badge-held)
   *  until the pointer follows it or leaves the badge.
   *
   *  The same watch the page's badges get from armBadgeHold/releaseBadgeHold, and the same
   *  one the popup's own VerdictBadge runs — scoped to this badge's subtree because a
   *  popover owns its nodes, where the page's version has to watch document-wide over tweet
   *  text that the page rewrites. */
  function wireBadgeHold(badge: HTMLElement): void {
    let hold: { part: Element | null; x: number; y: number } | null = null;
    const release = () => {
      hold = null;
      badge.classList.remove('mf-badge-held');
    };
    badge.addEventListener('mouseover', (ev) => {
      // Only an adjective-less slot changes the badge's width, so only its reveal moves
      // anything. Arming on an adjective the badge already shows would reveal a slot the
      // pointer never asked for.
      if (!badge.querySelector('.mf-badge-empty')) return;
      const enteredOn = (ev.target as Element | null)?.closest('.mf-badge-verdict, .mf-badge-empty');
      if (!enteredOn) return;
      const alreadyHeld = badge.classList.contains('mf-badge-held');
      const part = enteredOn.closest('.mf-badge-verdict, .mf-badge-slot');
      const next = { part, x: ev.clientX, y: ev.clientY };
      hold = next;
      // On now, ahead of the recalc the reveal is waiting on — the reveal is exactly what
      // the settle below has to measure.
      badge.classList.add('mf-badge-held');
      requestAnimationFrame(() => {
        // Released, or re-armed elsewhere, between the hover and this frame: not ours.
        if (hold !== next) return;
        // Whether the reveal cost the pointer anything is answered by where the pointer is
        // now against where its hover landed. The same part means nothing moved and the
        // hover itself is holding the reveal open — unless this badge was already held, in
        // which case it is not this hover's to drop.
        if (!alreadyHeld && badgePartAt(next.x, next.y) === part) release();
      });
    });
    badge.addEventListener('mouseleave', release);
    // A tap reveals the badge (there is no hover to leave behind on touch); the container's
    // own listener puts it back when the user taps anywhere else.
    badge.addEventListener('touchstart', () => badge.classList.add('mf-badge-held'), { passive: true });
  }

  /** Undo a tap-revealed badge when the tap lands anywhere else in the same container. */
  function wireBadgeTouchReset(container: HTMLElement): void {
    container.addEventListener('touchstart', (ev) => {
      if ((ev.target as Element | null)?.closest?.('.mf-verdict-badge')) return;
      for (const b of Array.from(container.querySelectorAll('.mf-verdict-badge.mf-badge-held'))) {
        b.classList.remove('mf-badge-held');
      }
    }, true);
  }

  /** The popover's verdict badge — the page's own badge, built the page's own way.
   *
   *  A settled verdict gets verdictBadgeHtml: the adjectives, the locale's separators and the
   *  percentage each part swaps to on hover, exactly as a tweet's badge has them, with the
   *  same hold that keeps a widening reveal from flickering under the pointer.
   *
   *  Anything still in flight keeps a plain pill instead, on the same three-way split the
   *  page's own fallback claim box makes: on-hold ("Fact-Check" — that is what the click
   *  does) in grey, a researching or not-yet-scored claim with the spinner and its researching
   *  word, and only a settled verdict taking the adjective slots. A claim that is merely
   *  waiting to be clicked must not read "Fact-Checking": nothing is running for it. */
  function claimBadge(claim: Claim, classificationId: string): HTMLElement {
    const isOnHold = claim.reclassifyOnHold === true;
    const showSpinner = !isOnHold
      && (claim.confidence === undefined || claim.confidence === null || claim.refreshing === true);
    const slotBadge = !showSpinner && !isOnHold;

    const badge = document.createElement('span');
    // The same class the page's badge carries — the reveal and hold rules in the stylesheet
    // are written against it — and only when this really is a slot badge.
    if (slotBadge) badge.className = 'mf-verdict-badge';
    // The page's own geometry and colours (factCheckColor), and nothing inline but those:
    // the slots' reveal, and what the pointer does to it, are all in the stylesheet.
    badge.setAttribute(
      'style',
      'display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px;'
        + ' font-size: 12px; font-weight: 600; white-space: nowrap; align-self: flex-start; '
        + (isOnHold
          ? 'color: rgb(180, 180, 180); background: rgba(128, 128, 128, 0.25);'
          : factCheckColor(claim.confidence, claim.veracity))
        + ';'
    );

    if (showSpinner) {
      const spinner = document.createElement('span');
      spinner.className = 'mf-fc-spinner';
      badge.appendChild(spinner);
    }
    if (slotBadge) {
      // Safe as markup: verdictBadgeHtml escapes every piece it interpolates, so this is the
      // badge builder's own output rather than page or model text.
      badge.innerHTML = verdictBadgeHtml(claim.confidence, claim.veracity, `${classificationId}:${claim.text}`);
      wireBadgeHold(badge);
    } else {
      // verdictLabel is the page's own label for a badge with no slots to fill: the
      // researching word while nothing is settled (seeded so it stays stable between
      // redraws), and the composed adjective + verdict otherwise.
      badge.appendChild(document.createTextNode(
        isOnHold
          ? t('factCheckButton', 'Fact-Check')
          : verdictLabel(claim.confidence, claim.veracity, `${classificationId}:${claim.text}`)
      ));
    }
    return badge;
  }

  /** Claims whose ranges could not be anchored inline. A plain list keeps the verdicts
   *  readable rather than silently dropping them. */
  function renderClaimList(claims: Claim[], classificationId: string, capture?: SelectionCapture): void {
    removeHud();
    const el = document.createElement('div');
    el.className = 'mf-sel-hud mf-sel-hud-list';
    // Same anchoring as the indicator it replaces: at the selection when the page's world
    // could measure one, at the top of the window when nothing survived to point at.
    if (!placeBelowSelection(el, capture)) {
      el.style.position = 'fixed';
      el.style.top = '12px';
      el.style.left = '50%';
      el.style.transform = 'translateX(-50%)';
    }
    for (const claim of claims) {
      const row = document.createElement('div');
      row.className = 'mf-sel-hud-row';
      row.appendChild(claimBadge(claim, classificationId));
      const label = document.createElement('span');
      label.textContent = claim.rewritten || claim.text;
      row.appendChild(label);
      el.appendChild(row);
    }
    wireBadgeTouchReset(el);
    document.body.appendChild(el);
    hud = el;
  }

  /** Render a classification's claims onto the wrapped selection.
   *
   *  The highlights and the popover are built by the SAME code the X.com feed uses
   *  (`makeClaimSegmentNodes` + `setupClaimHandlers` from utils/injecting.ts), so a passage
   *  on a webpage gets a tweet's verdict tints, inline badges, 1s hover preview, pinned
   *  draggable popover, copy/translate/refresh controls, sources and disclaimer — not a
   *  lookalike.
   *
   *  Re-wrapped on every update, over the selection's own DOM (`wrapClaimSegmentsInPlace`):
   *  the claim spans are new each time, which keeps a streaming classification correct by
   *  construction, but the passage between them — its elements and their fonts — is the
   *  page's own and is left alone. The one piece of X state a fresh span would lose is
   *  carried across: the reveal animation is keyed per claim (`data-mf-anim-key`), so it
   *  does not replay, and an open popover is re-attached to the new span by
   *  `updateOpenPopover`. */
  function renderClaims(capture: SelectionCapture, classification: Classification): void {
    const claims = classification.claims;
    if (!claims || claims.length === 0) return;

    let segments: TextSegment[] | null = null;
    try {
      // Ranges were computed against the selection text and keyed by the locale it was
      // sent under, which is the UI locale of this page (see MF_SELECTION_BEGIN).
      segments = breakupWithHighlights(capture.selected, claims, uiLocale());
    } catch (err) {
      console.log('[selection] segment build failed:', err);
    }

    const wrap = capture.wrap;
    const anchorable = !!wrap && wrap.isConnected && segments && segments.some((s) => s.claimIndex !== null);
    if (!anchorable) {
      // The worker could not anchor a single claim (or the page text could not be
      // wrapped): leave the page alone and list the claims instead.
      renderClaimList(claims, classification.id, capture);
      return;
    }

    // `uiLocale()` is the text locale: the ranges in this classification's `highlight` and
    // `annotations` were keyed under the locale MF_SELECTION_BEGIN sent, and that is what
    // both the breakup above and the popover's annotation resolution read them by.
    //
    // In place, on the wrap the selection already made — not `buildSegmentWrap`, which
    // builds the passage fresh as one flat run. A selection that spans block elements
    // (a headline and the standfirst under it, the CBC case) holds those blocks inside the
    // wrap, and a flat rebuild took them with it: the headline re-rendered inline, in the
    // standfirst's font, on the standfirst's line, with its highlight anchored in the
    // paragraph. Keeping the same wrap object also keeps the popover, the page-world
    // capture and the "Fact-Checked" button's scroll-back pointing at the passage.
    // False means the page re-rendered under the run: the fold-back inside the
    // rebuild already stripped the old spans, and the wrap's text no longer matches
    // the segments, so the passage would be left as bare text with nothing shown.
    // The claims still stand — list them rather than showing nothing at all.
    if (!wrapClaimSegmentsInPlace(wrap!, segments!, claims, classification.batchId, classification.id, uiLocale())) {
      console.log('[selection] wrap text drifted mid-run — listing claims instead of bare text');
      renderClaimList(claims, classification.id, capture);
      return;
    }
    const wrapped = new Set(
      Array.from(wrap!.querySelectorAll<HTMLElement>(".mf-segment-claim"))
        .map((span) => span.dataset.claimIndex)
        .filter((idx): idx is string => idx != null),
    );
    const missed = claims
      .map((claim, i) => ({ claim, i }))
      .filter(({ i }) => segments!.some((s) => s.claimIndex === i) && !wrapped.has(String(i)));
    if (missed.length > 0) {
      console.log(
        '[selection] wrap skipped',
        missed.length,
        'located claim(s):',
        missed.map(({ claim }) => claim.text.slice(0, 80)),
      );
    }
    // The factory above stamped fresh datasets from the claims, but a rebuild
    // cannot run X's in-place annotate reconcile (the spans it would update are
    // gone). Settle each fresh span against its claim instead — the same state
    // changes X makes when the key lands (clear pending/seed/timer) or is still
    // awaited (promote the seed), plus the inline repaint off the stamped
    // dataset. Without this a landed key leaves its "Annotating" flight
    // standing and its corrections unpainted. Verdict badges need nothing: the
    // factory already derived them from the same dataset.
    for (const span of Array.from(wrap!.querySelectorAll<HTMLElement>(".mf-segment-claim"))) {
      const idx = parseInt(span.dataset.claimIndex ?? "", 10);
      const claim = !isNaN(idx) ? claims[idx] : undefined;
      if (!claim) continue;
      settleRebuiltSpanAnnotations(span, claim, classification.id);
    }
    wrap!.dataset.mfSelWrap = 'true';
    // Both worlds' handoff and every selection-side lookup go through this attribute
    // (`selectionWrap` in utils/injecting.ts, and the page-world capture that stamps it
    // there), so the wrap has to carry it or the "Fact-Checked" button loses the passage it
    // scrolls back to.
    wrap!.dataset.mfSelId = classification.id;

    // The X.com handlers, on this wrap instead of a tweet's article. Mouseenter/mouseleave
    // drive the hover tint, the badge and the 1s preview; click opens the pinned popover,
    // runs a re-classification off an on-hold badge, and triggers annotations off an idle
    // Annotate badge. `setupArticleHandlers` is container-agnostic — it only stamps
    // dataset.mfHandlers and adds three capture-phase listeners — and it is idempotent
    // against the document-level half via setupGlobalHandlers.
    setupClaimHandlers(wrap!);

    removeHud();
    capture.wrap = wrap!;

    // The rebuild detached the span any open popover was attached to. It re-attaches to the
    // matching new span (same claim text) and repaints from the fresh dataset, so a verdict
    // landing, an annotation run finishing or a re-Disinfact updates the window in place
    // instead of leaving it describing a state the page has moved past.
    updateOpenPopover();
    // Repositioning the popover can change its height — reasoning streams in, sources and
    // the offboard/annotation callouts attach — and the callouts are stacked from the
    // popover's bottom edge. On X the next injectClassifications pass re-runs refreshOnboarding()
    // and drags them along; this surface has no such pass, so without this the callout keeps
    // the offset it was given when the popover was shorter and rides up over the reasoning.
    refreshInPopoverOnboarding();
  }

  // ── Background channel ─────────────────────────────────────────────────────

  function connect(opts?: { takeHandler?: boolean }): Browser.runtime.Port {
    const takeHandler = opts?.takeHandler === true;
    const existing = w[PORT_KEY] as Browser.runtime.Port | undefined;
    if (existing) {
      port = existing;
      if (takeHandler || typeof w[PORT_HANDLER_KEY] !== 'function') {
        w[PORT_HANDLER_KEY] = onPortMessage;
      }
      return existing;
    }
    const runtime = ext()?.runtime;
    if (!runtime?.connect) throw new Error('no-extension-runtime');
    const p = runtime.connect({ name: 'classify' });
    p.onMessage.addListener((message: any) => {
      const handler = w[PORT_HANDLER_KEY] as ((m: any) => void) | undefined;
      if (typeof handler === 'function') handler(message);
    });
    p.onDisconnect.addListener(() => {
      if (w[PORT_KEY] === p) w[PORT_KEY] = undefined;
      port = null;
    });
    w[PORT_KEY] = p;
    if (takeHandler || typeof w[PORT_HANDLER_KEY] !== 'function') {
      w[PORT_HANDLER_KEY] = onPortMessage;
    }
    port = p;
    return p;
  }

  function send(message: unknown): void {
    try {
      connect().postMessage(message);
    } catch (err) {
      console.log('[selection] send failed:', err);
      port = null;
      w[PORT_KEY] = undefined;
    }
  }

  /** Tell the popup (if it is the thing that started this) that preclassification has
   *  begun arriving, so it can dismiss itself and reveal the highlights underneath. Sent
   *  on the FIRST classification for this selection, including an empty one — otherwise a
   *  passage with no claims would leave the popup spinning forever. */
  let arrivedSent = false;
  function notifyArrived(): void {
    if (arrivedSent) return;
    arrivedSent = true;
    try {
      // Nothing may be listening: the context-menu path never opens a popup, and the
      // popup may already be gone. A rejected send is expected, not an error.
      void ext()?.runtime.sendMessage({ type: 'MF_SELECTION_ARRIVED' })?.catch?.(() => {});
    } catch { /* no receiver */ }
  }

  /** Only THIS selection's classifications are ours: the background broadcasts to every
   *  connected port, and the X.com tab's UI shares this channel. */
  function onPortMessage(message: any): void {
    // Everything the X.com UI announces, announced here too: a balance change after a
    // top-up, an error that ended a run, the empty-balance notice. That is what makes
    // notifications work away from x.com instead of only on it.
    // Deliberately not conditioned on `pending`: a top-up finishes in the popup, long
    // after the selection that injected this script, and a notification dropped in that
    // gap is one the user never sees. What can be shown is bounded by the page, not by
    // whether a run happens to be live.
    if (message?.type === 'MF_NOTIFICATION') {
      const data = message.data;
      if (!data?.kind) return;
      showNotification(data.kind, { amount: data.amount, text: data.text, code: data.code });
      return;
    }
    if (message?.type !== 'CLASSIFICATION') return;
    const data: Classification | undefined = message.data;
    const capture = (data && liveCaptures.get(data.id)) ?? (data && pending && data.id === pending.id ? pending : null);
    if (!data || !capture) return;

    // `preclassifying` is the background's own "we have started" marker, broadcast
    // before the worker is even asked anything. Only the real preclassification counts
    // as arriving — dismissing the popup on the marker alone would close it within
    // milliseconds and the user would never see the indicator they triggered.
    if (!data.preclassifying) notifyArrived();

    if (!data.claims || data.claims.length === 0) {
      // While `preclassifying` is set, claims may yet arrive and the indicator stays.
      // Without it this is the run's last word — an empty passage, or a failed one —
      // and the indicator has nothing left to wait for.
      if (!data.preclassifying) removeHud();
      return;
    }

    // `annotateInFlight` is a background→content control signal, not claim data (see
    // broadcastClassification), and the relay strips it into the page's annotate-seed set
    // before rendering — the badge factory and the in-place reconcile consume seeds
    // synchronously inside injectClassifications, so seeding AFTER would leave a fresh span
    // painting an idle "Annotate" while a run the user already paid for is on its way. The
    // marker must come off the claim either way: Claim is not supposed to carry it, and a
    // stale one would suppress the affordance for good.
    const annotating = new Set<string>();
    for (const cl of data.claims) {
      if ((cl as { annotateInFlight?: boolean }).annotateInFlight) {
        annotating.add(`${data.id}:${cl.text}`);
        delete (cl as { annotateInFlight?: boolean }).annotateInFlight;
      }
    }
    if (annotating.size > 0) setAnnotateSeeded(annotating);

    latest = data;
    renderClaims(capture, data);
    // The run has just moved on. If its highlights are off-screen — the user read past the
    // passage while the verdicts were landing — this is the moment to offer them the way back.
    trackSelectionFloatingButtons(data);
  }

  /** Styles and the background port are created HERE rather than at load, because this
   *  file is also injected into every page the user merely opens the popup on, purely to
   *  ask whether anything is selected. Injecting X.com's stylesheet and holding a port
   *  open on a page that never gets Disinfacted would be a real cost for nothing. */
  let ready = false;
  function ensureReady(): void {
    if (ready) return;
    ready = true;
    injectStyles();
    connect({ takeHandler: true });
  }

  function beginCapture(capture: SelectionCapture): void {
    capture = trimCapture(capture);
    if (!capture.selected.trim()) return;
    liveCaptures.set(capture.id, capture);
    showHud(capture);
    // Start of the surrounding prose the worker gets — check whether a
    // Substack thread's earlier posts made it into `before`.
    console.log(
      '[selection] context start | before:',
      JSON.stringify(capture.before.slice(0, 500)),
      `(${capture.before.length} chars)`,
      '| after:',
      JSON.stringify(capture.after.slice(0, 200)),
      `(${capture.after.length} chars)`,
    );
    send({
      type: 'MF_SELECTION_BEGIN',
      data: {
        id: capture.id,
        before: capture.before,
        selected: capture.selected,
        after: capture.after,
        locale: uiLocale(),
        force: capture.force === true,
      },
    });
  }

  function begin(): void {
    if (!pending) return;
    const extras = extraLeftoverCaptures;
    extraLeftoverCaptures = [];
    // Per-selection, not per-page: a second Disinfact on the same page must be able to
    // dismiss a popup again.
    arrivedSent = false;
    // The previous selection's run is none of this one's business, and a classification
    // that never settled would otherwise have the scroll handler re-checking it forever.
    latest = null;
    // A popover from the previous selection describes text this run is about to replace, and
    // it is attached to a span the rebuild below is going to throw away — updateOpenPopover
    // would then re-attach it to whichever new claim happens to carry the same words. X
    // closes its popovers on the same event (`closePopover()` with no trigger closes every
    // pinned one), and renderClaims opens nothing of its own.
    closePopover();
    ensureReady();
    if (pending.tweetOnly) {
      notifyArrived();
      removeHud();
      pending = extras[0] ?? null;
      for (const extra of extras) beginCapture(extra);
      return;
    }
    // The background hashes `${before}${selected}${after}` and only preclassifies
    // `selected`; the before/after exist to resolve a claim that is missing its subject.
    beginCapture(pending);
    for (const extra of extras) beginCapture(extra);
  }

  // ── Entry points ───────────────────────────────────────────────────────────

  const onRuntimeMessage = (message: any, _sender: any, sendResponse: (r: any) => void) => {
    // Logged ahead of the gate, and it is the point of the line: "the message never reached
    // a listener" and "a listener declined it" are the same silence at the background — it
    // logs a bare `undefined` for both — and the two need opposite fixes. A message that
    // arrives is answered or named; a message that does not arrive leaves no trace at all.
    console.log('[selection] runtime message:', message?.type, '| owner:', current());
    // A superseded copy answers nothing. Returning without calling sendResponse is what
    // leaves the reply to the newest copy — `undefined` here would look exactly like the
    // no-receiver case the background logs, so this must be a bare return and not a reply.
    // Only sound because the registration below retires the previous copy's listener: with
    // one listener installed there is no older, silent one left for the sender to settle on.
    if (!current()) return undefined;
    if (message?.type === MSG_PROBE) {
      // Deferred because the read may have to make a round trip to the page's own world;
      // the `return true` below holds the channel open for it.
      void (async () => {
        // Both this handler and the start handler below answer from inside a catch as well
        // as from the end, and that is the point of them: a throw between here and the
        // reply used to reject this promise into nothing, so the popup read "nothing is
        // selected" and the background logged a bare `undefined`, with the actual reason —
        // an unreadable range, a bad context walk — visible only to a page console nobody
        // had open. A failure now arrives named.
        try {
          // The popup has just taken focus, which leaves the page's selection intact but
          // blurred. Re-reading it here is what makes "select text → open the popup" work.
          // Read-only: opening the popup for the balance must not eat the selection.
          let found = readSelection(false);
          if (!found) {
            // This world has nothing, which on Safari is the normal case rather than a
            // failure. Ask the only context that can see the page's selection.
            const text = await requestPageWorldProbe();
            found = text.trim() ? unanchored(text) : readSelectionTextOnly();
          }
          pending = found;
          // Logged for the same reason as the start path below: the popup's "nothing is
          // selected" and the page's own loss of the selection are otherwise the same signal.
          if (!pending) console.log('[selection] probe found nothing:', describeSelection());
          sendResponse({
            hasSelection: !!pending,
            preview: pending ? pending.selected.slice(0, 200) : '',
          });
        } catch (err) {
          console.log('[selection] probe failed:', err, '|', describeSelection());
          sendResponse({ hasSelection: false, preview: '' });
        }
      })();
      return true;
    }
    if (message?.type === MSG_START) {
      // Deferred for the same reason as the probe above.
      void (async () => {
        try {
          // Always re-read: the text selected NOW is what the user means, and it is regularly
          // a different selection from whatever a previous probe or a previous Disinfact left
          // in `pending`. A stale capture must never win — that would fact-check text the user
          // has already moved on from, and unwrap the selection they just made.
          if (typeof message.targetElementId === 'number') pendingTargetElementId = message.targetElementId;
          const expandThin = message.expandThin === true;
          let fresh = readSelection(true, { expandThin }) ?? captureFromPageWorld();
          pendingTargetElementId = null;
          if (!fresh) {
            // Nothing in this world. On Safari that is every time — the page's world is the
            // only one holding the selection — so ask for it there and collect what it wraps.
            if (expandThin) document.documentElement.dataset.mfSelExpandThin = '1';
            else delete document.documentElement.dataset.mfSelExpandThin;
            const page = await requestPageWorldCapture();
            fresh = captureFromPageWorld()
              ?? (page?.text?.trim() ? unanchored(page.text, page.rect) : null)
              ?? readSelectionTextOnly();
          }
          if (fresh) {
            pending = fresh;
          } else if (message.keepProbe === false || !pending) {
            // Nothing is selected and there is nothing to fall back on. For the context-menu
            // path there never is (no probe ran), so this is simply "selection was lost".
            console.log('[selection] nothing selected — nothing to Disinfact:', describeSelection());
            sendResponse({ ok: false, reason: 'no-selection' });
            return;
          } else {
            // The popup took the page's focus and the page dropped its selection on blur.
            // Fall back to what the probe read — unanchored, so the claims render as a list.
            pending = { ...pending, wrap: null };
          }
          begin();
          sendResponse({ ok: true });
        } catch (err) {
          // Named, because this reply is the only thing that reaches the background's log:
          // `undefined` there means "no answer came back" and says nothing about why.
          console.log('[selection] start failed:', err, '|', describeSelection());
          sendResponse({ ok: false, reason: `error: ${String(err)}` });
        }
      })();
      return true;
    }
    return undefined;
  };

  // Publish the responder BEFORE any runtime API call. Safari's injected-file
  // world can throw on `browser.runtime` (WXT's polyfill reads globalThis);
  // if that throw happens first, the background sees `no-responder` and both
  // the popup and the context menu do nothing. The background already hands
  // start/probe to `__mfSelectionResponder` in-world, so the listener on
  // `runtime.onMessage` is optional — the published handler is the one that
  // must exist.
  const previousOwner = w[RESPONDER];
  w[RESPONDER] = onRuntimeMessage;
  owner = onRuntimeMessage;
  const runtime = ext()?.runtime;
  try {
    runtime?.onMessage?.addListener(onRuntimeMessage as any);
  } catch (err) {
    console.log('[selection] runtime.onMessage unavailable:', err);
  }
  if (typeof previousOwner === 'function' && previousOwner !== onRuntimeMessage) {
    try {
      runtime?.onMessage?.removeListener(previousOwner as any);
    } catch (err) {
      // Earliest copy still wins the reply on a browser that settles on the first listener
      // to decline, so a failure here is worth naming rather than swallowing.
      console.log('[selection] previous copy\'s listener could not be retired:', err);
    }
  }

  // A notification is clickable wherever it appears, so the money message the user taps
  // leads to the balance it is about. The toast dispatches onto the in-process bus, and
  // this bundle holds its own copy of it — on x.com the relay's copy is the one usually
  // wired to the toast it drew, and nothing here would ever hear that one. Forwarding it
  // the same way the relay does keeps a click on a non-X page from doing nothing at all.
  // The background is the only context that may open the popup, and the only one holding
  // the user-gesture grant that makes openPopup() legal.
  mfBus.addEventListener('mf-open-popup', ((e: CustomEvent) => {
    // Gated like the message listener: every mounted copy hears the bus, and the background
    // is what opens the popup, so unguarded copies would open one per copy.
    if (!current()) return;
    send({ type: 'MF_OPEN_POPUP', data: e.detail });
  }) as EventListener);

  // ── The popover's own actions ──────────────────────────────────────────────
  //
  // The popover is built by utils/injecting.ts on X.com and here, and it announces what the
  // user asked for on the in-process bus rather than sending anything itself: on X the relay
  // owns the port and forwards them. This bundle has no relay, so it forwards them itself —
  // the same four intents, in the same shapes, over the same `classify` port the
  // classification came in on. A claim's controls would otherwise be inert on a webpage:
  // the buttons would spin and nothing would happen.
  //
  // Gated like the message listener, and for the same reason: every mounted copy hears the
  // bus, so an unguarded copy would send one of each per copy. `uiLocale()` is the locale on
  // both sides of these calls — the UI language this page's run was sent under.
  const forwardIntent = (type: string, e: CustomEvent) => {
    if (!current()) return;
    send({ type, data: { ...e.detail, locale: uiLocale() } });
  };
  mfBus.addEventListener('mf-refresh-claim', ((e: CustomEvent) => {
    forwardIntent('REFRESH_CLAIM', e);
  }) as EventListener);
  mfBus.addEventListener('mf-translate-claim', ((e: CustomEvent) => {
    forwardIntent('TRANSLATE_CLAIM', e);
  }) as EventListener);
  mfBus.addEventListener('mf-annotate-claim', ((e: CustomEvent) => {
    forwardIntent('ANNOTATE_CLAIM', e);
  }) as EventListener);
  mfBus.addEventListener('mf-reclassify-on-hold-click', ((e: CustomEvent) => {
    forwardIntent('RECLASSIFY_ON_HOLD_CLICK', e);
  }) as EventListener);

  // No popover dismissal listeners here: the X.com ones are already installed by
  // setupGlobalHandlers() (a document click outside any .mf-popover and outside the claim
  // itself, and Escape), and a second copy of our own would only diverge from the behaviour
  // being matched.
  window.addEventListener('scroll', () => {
    // The HUD is position:absolute anchored to the wrap, so it re-anchors as the page moves.
    // The popover is not repositioned here: it is absolutely positioned inside the container
    // it was appended to and scrolls with its own highlight, exactly as on X.
    if (hud && pending?.wrap?.isConnected) {
      const rect = pending.wrap.getBoundingClientRect();
      hud.style.top = `${window.scrollY + Math.max(8, rect.top - 34)}px`;
    }
    // Reading on past the passage is how its highlights leave the screen, and that — with the
    // run finished — is exactly when the "Fact-Checked" button has something to offer. The
    // tracker is a no-op until then and once it has fired, so this stays cheap.
    if (latest && Date.now() - lastFloatingCheckAt >= FLOATING_CHECK_INTERVAL_MS) {
      lastFloatingCheckAt = Date.now();
      trackSelectionFloatingButtons(latest);
    }
  }, true);
});
