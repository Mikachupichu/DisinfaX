/** The LinkedIn adapter.
 *
 *  LinkedIn is a React app whose every class is a build hash (`m6fguo`, `m6fa49`), so nothing
 *  here keys on one. What it leaves instead is richer than Facebook's: `data-testid` on the
 *  body and on the page's own expander, and — on the two surfaces that matter — the object
 *  URNs themselves, rendered into element ids.
 *
 *  **Surfaces, and what a clipped body is.** The feed and a post's own page behave differently,
 *  and what separates them is whether the URL names the post:
 *
 *  - **The feed clips most posts, and a clipped post is integrated like any other.** The page's
 *    expander sits INSIDE the body element (measured a direct child of
 *    `[data-testid="expandable-text-box"]`) and clamps the VIEW without touching the DOM:
 *    LinkedIn renders the entire text into the body either way, so the body's `textContent` is
 *    the complete text with the expander's own label appended. Measured on three tagged bodies —
 *    expanding took them 1171→1164, 859→853 and 167→161, each down by exactly that label — so
 *    `bodyText` drops the label and the full text is what remains. Nothing has to be
 *    reconstructed, and there is no reason to withhold buttons: on X a clipped post carries
 *    them too, and the injection leaves the reader the whole text (`unclip`).
 *  - **A feed card is named by its own comments**, or failing that by its own words — see `Ids.`
 *    below. The comments are the exact name: every row rendered inside one card states the same
 *    parent URN, which is the id the post's own permalink yields. A card with no comment section
 *    rendered states nothing, and is named by the digest of its author and its text so that the
 *    reader still gets buttons on it.
 *  - **A post's own page shows it in full, and is where a post is integrated.** Measured: zero
 *    expanders on `…/feed/update/urn:li:activity:<id>/`, one `[role="listitem"]`, and every
 *    comment complete.
 *
 *  **Ids.** A post is named by the URN in its permalink — `urn:li:activity:<id>` from
 *  `/feed/update/…`, or the `-activity-<id>-` half of a `/posts/…` path. A comment is named by
 *  the URN LinkedIn renders into its own element id,
 *  `replaceableComment_urn:li:comment:(<parent>,<comment>)`, which is the same stable object id
 *  on the feed and on a permalink.
 *
 *  A **feed card states no id of its own**: LinkedIn renders no activity URN into a feed card's
 *  markup, and the one identifier it does leave, the `componentkey` tracking token, is a
 *  per-card anonymous key that a second fetch of the same feed does not reproduce. Naming a post
 *  by a positional or token id is what `post-id-names-one-text` forbids. It is named two other
 *  ways instead, in this order (`cardId`):
 *
 *  - **Its own comments, when they are rendered.** A comment's element id is
 *    `urn:li:comment:(<its post>,<its id>)` — its first field is the post it hangs on — and every
 *    row rendered inside one card states the SAME post (measured on six cards, each with 1, 2 or
 *    4 rows). That parent is exactly the id the post's own permalink yields: on the search
 *    surface it reads `urn:li:ugcPost:<n>`, the permalink `/feed/update/urn:li:ugcPost:<n>/`
 *    renders that same post, and the `activity:<n>` form with the same number renders nothing.
 *    So a card whose comment section is open is named exactly, with no new mechanism, no
 *    permission and no payload. This is not cosmetic: a comment chains to its post by that same
 *    URN, so a card named any other way would leave its own comments chained to an id nothing
 *    answers.
 *  - **Its own words, when they are not.** The digest of the author and the body's text — the
 *    same two fields the hash's own context is built from — names the card, so the reader gets
 *    buttons on it and it files a row under its text hash like any other post. The digest is
 *    remembered against the URN the moment a comment states one, so the card keeps one name when
 *    its comment section closes again, and the card and the post's own page agree.
 *
 *  The digest is only ever a name for a card that states nothing else, and it never has to be
 *  distinguished from a URN-derived one: the two are different strings for different surfaces,
 *  and the DB is keyed by the text hash both of them compute to.
 *
 *  This adapter does NOT reach for a MAIN-world interceptor to close the remaining gap (a card
 *  with no comment section rendered): a feed load issues no feed request at all, the flight
 *  stream is not embedded inline, and the keys a payload does mint are render-scoped, so there
 *  is no stream to read and nothing a key could be joined to.
 *
 *  Measured on 2026-09-30, from four channels, before settling on the two ways above — a hook on
 *  `fetch`/XHR installed before load, capturing every LinkedIn response over 20KB:
 *
 *  - **Network.** A feed load issues no feed request: the only captures across a load and a
 *    scroll of the real scroll container (`MAIN`) were
 *    `/flagship-web/rsc-action/actions/app-config` (1.1MB of component registry) and the nav
 *    GraphQL calls. Nothing carried the cards' content, so a MAIN-world hook has no feed stream
 *    to read even if a key existed to read it with.
 *  - **Inline payload.** No flight stream is embedded in the page: two inline `<script>`s,
 *    2146 characters between them, none of them containing a card key or a URN.
 *  - **Attributes.** A feed card carries exactly three: `class`, `role`, `componentkey`. The
 *    page's 76 `data-token-id` values are tracking tokens on icons and pixels (the first is an
 *    `svg`), never on the card — so the `trackingId` that the payload does state (×297) joins
 *    to nothing the DOM exposes.
 *  - **Text.** `document.body.innerText` holds no `urn:li:activity:` at all.
 *
 *  What none of that leaves is a key that could be joined to a card on screen: a card key is
 *  render-scoped, so fetching `/feed/` a second time reproduces a different set of 43-character
 *  keys than the ones live in the DOM.
 *
 *  A COMMENT is a different matter, and on the feed it is named even though the card holding it
 *  is not: a comment's own element id is `urn:li:comment:(<its object>,<its id>)`, whose first
 *  field is the POST it hangs on — measured on the feed as `activity:7510302384762413056` and on
 *  that post's own page as the same string, the URL there yielding the same one. So a feed
 *  comment chains to its post whether or not the post can be named, and a comment captured on
 *  two surfaces is one id over one hash.
 *
 *  **Authors.** LinkedIn renders the byline as the name, a verification glyph, and a degree
 *  ("• 3rd+") — and, inside the same anchor, a visually-hidden string for screen readers
 *  ("Joseph Michael Premium Profile 3rd+", measured). The hidden copy is a 1x1 box, so the name
 *  is read as the first LEAF span that renders wider than a couple of pixels, with the degree cut
 *  off at its separator. The verification badge is `svg#verified-small` — LinkedIn's own id for
 *  it, never its localized label — and it is read only for PRESENCE, which is what the classifier
 *  is told about.
 */
import type { MainTweet, Usertype } from '../../data/Tweets';
import { Usertype as UsertypeEnum } from '../../data/Tweets';
import { PLATFORM_HOSTS } from './hosts';
import { LONG_FORM_CHARS } from './types';
import type { CapturedPost, PlatformAdapter } from './types';

const ID_PREFIX = 'linkedin:';

/** A post and a comment are both `[role="listitem"]`-or-id shaped; the body is what says an
 *  element carries words at all. */
const BODY = '[data-testid="expandable-text-box"]';

/** The page's own "… more" control. It lives INSIDE the body element (measured as a direct
 *  child), which is what lets `bodyText` take its label back off the body's text. */
const EXPANDER = '[data-testid="expandable-text-button"]';

/** A comment root. LinkedIn mints the element's id from the comment's own URN —
 *  `replaceableComment_urn:li:comment:(<parent>,<comment>)` — which is the one place on either
 *  surface where a real object id reaches the DOM. */
const COMMENT_EL = '[id*="urn:li:comment:"]';

/** That URN, anchored to the end of the id: a reply nests a `…::0` sibling under the same
 *  prefix, and only the comment itself ends at the closing parenthesis. */
const COMMENT_URN = /urn:li:comment:\(([^,]+),(\d+)\)$/;

/** The prefix a comment's parent URN carries and a permalink's id does not: `postIdFromUrl`
 *  yields `ugcPost:<n>` for `/feed/update/urn:li:ugcPost:<n>/`, so dropping it is what makes
 *  the two names one string. */
const URN_PREFIX = /^urn:li:/;

/** A post's own page marks the post it is about in the card's component key. It is the only
 *  marker that separates the focused post from a feed card left rendered behind it, which is
 *  the difference between naming a post correctly and naming whichever card comes first. */
const DETAIL_POST = '[role="listitem"][componentkey*="FeedType_FEED_DETAIL"]';

/** Our own button container. Named here rather than imported for the same reason `hostText`
 *  mirrors `mfPlainText`: the injecting layer reaches adapters through the seam, never back. */
const CONTAINER = '[mf-top-bar-id]';

/** An author's link. LinkedIn uses one per author and does not vary it by surface. */
const AUTHOR = 'a[href*="/in/"], a[href*="/company/"], a[href*="/school/"]';

/** LinkedIn's own id for the verification glyph. Read for presence only — the string beside it
 *  is translated, and the plain member bug (`svg#linkedin-bug-small`) is not a verification. */
const VERIFIED_BADGE = 'svg#verified-small';

/** The separator between a name and its degree. Both glyphs are punctuation rather than
 *  translated words, so cutting at one is not a locale-dependent read. */
const DEGREE_SEP = /\s[•·]\s/;

const FEED_UPDATE = /\/feed\/update\/urn:li:(activity|ugcPost):(\d+)/;
const POSTS_ACTIVITY = /-activity-(\d+)(?:-|$|\/)/;

/** The m-surface: LinkedIn's server-driven mobile app, and the second application this adapter
 *  reads.
 *
 *  Measured 2026-10-05 on `linkedin.com/feed/` under an iPhone user agent, signed in: the mobile
 *  feed is a DIFFERENT application, not the desktop one restyled. Not one of the markers the
 *  desktop branch is built on survives the swap — no `[data-testid]` attribute exists anywhere on
 *  the page (the mobile app spells it `data-test-id`), no `[role="listitem"]`, no
 *  `urn:li:comment:` element ids, no `componentkey` — so on a feed holding eleven cards every
 *  desktop predicate answered zero, the whole surface stayed unannounced, and not one card carried
 *  a button.
 *
 *  What the mobile app states is, in one respect, better than the desktop app's markup: the card's
 *  own `<article>` carries `data-activity-urn`, the post's URN, which is the same string the post's
 *  permalink carries (`/feed/update/urn:li:<type>:<n>`), so this surface has no need of the words
 *  digest the desktop branch falls back on and no need of a rendered comment section to name a
 *  card. The commentary keeps its WHOLE text in the DOM — measured, a 63px box holding 1714
 *  characters, clipped by `overflow: hidden` and nothing else, with no ellipsis in the string — so
 *  a clipped mobile card hashes as its complete self, exactly as a desktop one does. */
const MOB_ART = 'article[data-activity-urn]';
const MOB_COMMENTARY = '[data-test-id="main-feed-activity-card__commentary"]';
const MOB_TEXT = '[data-feed-control="commentary_text"]';
const MOB_ACTOR = '[data-feed-control="actor"]';
const MOB_MENU = '[data-feed-control="control_menu"]';
/** The row that holds the author and the Follow control, and the control that ends it. */
const MOB_LOCKUP = '[data-test-id="main-feed-activity-card__entity-lockup"]';
const MOB_FOLLOW = '[data-feed-control="actor_follow_toggle"]';
/** The pill's seat, in the app's own idiom: laid over the layout rather than into it, on the
 *  author's own line, clear of the host controls that line runs into. */
const MOB_SEAT_GAP = 6;
const MOB_SEAT_Z = '2147483000';
const MOB_PILL_HEIGHT = 20;
const MOB_SEAT_CLASS = 'mf-btn-container';

const REGULAR: Usertype = UsertypeEnum.Regular;

const VERIFIED: Usertype = UsertypeEnum.Verified;

function namespaced(id: string): string {
  return ID_PREFIX + id;
}

/** A card of the mobile app: an `<article>` stating its own URN and carrying the mobile
 *  commentary. Both halves are element facts — a tag, an attribute and a test id — so nothing
 *  here moves with the reader's language or the app's styling. */
function isMobileRoot(root: Element): boolean {
  return root.tagName === 'ARTICLE' && root.hasAttribute('data-activity-urn') && root.querySelector(MOB_COMMENTARY) !== null;
}

/** Whether this document is the mobile app. The commentary marker is the mobile app's own and
 *  appears on no desktop page measured, so one query settles it for the whole document and a
 *  desktop page pays that query once per sweep rather than one per card. */
function isMobileDocument(): boolean {
  return document.querySelector(MOB_COMMENTARY) !== null;
}

/** A mobile card's words. The marker rides a wrapper when the app decides the commentary needs one
 *  — measured as the card's own `P` on one card and as a `DIV` wrapping that same `P` on the next
 *  — so the element holding the text is the `commentary_text` inside it, and that element carries
 *  the WHOLE text whether or not it is clipped on screen. */
function mobileBody(root: Element): Element | null {
  const box = root.querySelector(MOB_COMMENTARY);
  if (!box) return null;
  if (box.matches(MOB_TEXT)) return box;
  return box.querySelector(MOB_TEXT) ?? box;
}

/** The body of a post on either surface. Every reader of a body goes through this, so a mobile
 *  card is read by the same code the desktop one is. */
function bodyIn(root: Element): Element | null {
  return root.querySelector(BODY) ?? (isMobileRoot(root) ? mobileBody(root) : null);
}

/** A mobile card's byline: the control the app itself labels `actor`, which is the anchor naming
 *  the post's author.
 *
 *  Read by that control and not as "the card's first profile link", which is what the desktop
 *  branch would do: a mobile card carries the avatar's link first — `actor_picture`, measured at
 *  0 characters — and its context line can carry ANOTHER member's link above the byline, so a
 *  positional read files the post under whoever's picture or notice happens to come first. */
function mobileAuthor(root: Element): Element | null {
  const anchor = root.querySelector(MOB_ACTOR);
  return anchor && visibleName(anchor) ? anchor : null;
}

/** The pill's seat on a mobile card: the post's OWN line — the one the author's name is on, at the
 *  right of the author's own words and clear of the Follow control that ends that row.
 *
 *  Measured 2026-10-05 on the live feed: a card's lockup row is 358px wide and full — the author's
 *  column (avatar, name, credential, headline, time) runs to x261 and the Follow control starts at
 *  x277, a 16px seam — so there is nothing after the row's end to seat a pill at. What that row does
 *  leave is the rest of the NAME's line: measured, the name and credential reach x197 there, so the
 *  window before the Follow control is 80px. That is under the width a labelled pill needs, and the
 *  bar's own cap answers it the way it does everywhere else — the mark stands and the label becomes
 *  the button's accessible name. A card with no Follow control (the reader's own posts, or one where
 *  following is not offered) leaves the seat running to the row's end, and there the label stays.
 *
 *  The card's own provenance line above is deliberately NOT the seat, though the app's `…` sits at
 *  its end: it carries the FEED's words ("Suggested", "<name> commented on this", sometimes another
 *  member's link), not the post's row, and a pill there reads as belonging to that notice rather
 *  than to the post. The `…` is used only as a fallback anchor for a card that states no actor
 *  anchor at all — every observed card states one.
 *
 *  The seat is laid OVER the layout rather than into it, the same way (and for the same reason) the
 *  other server-driven surface does it (see facebook.ts): the host's rows are fixed-height inline
 *  boxes with no slack, so a node put into their flow is crushed or painted over. Position is
 *  measured from the anchor's own line, and the room from the laid-out TEXT of that line and never
 *  from its box — a box here spans the whole column, measured 390px wide around 197px of words.
 *  Width zero is the answer to "no room left", which the bar's renderer reads to stand as its mark. */
function mobileSeat(root: Element): { top: number; right: number; width: number } | null {
  const actor = root.querySelector(MOB_ACTOR);
  const menu = root.querySelector(MOB_MENU);
  const anchor = actor ?? menu;
  if (!anchor) return null;
  const line = anchor.getBoundingClientRect();
  if (line.height <= 0) return null;
  const follow = actor ? root.querySelector(MOB_FOLLOW) : null;
  const rowEl = (actor ? actor.closest(MOB_LOCKUP) : anchor.parentElement) ?? root;
  const row = rowEl.getBoundingClientRect();
  // What the line must stop before: the host's own control on it, else the `…` when the pill has
  // fallen back to the provenance line, else nothing and the row's own end is the end.
  const stopEl = follow ?? (actor ? null : menu);
  const right = stopEl ? stopEl.getBoundingClientRect().left - MOB_SEAT_GAP : row.right;
  let textRight = row.left;
  for (const el of Array.from(root.querySelectorAll('*'))) {
    if (el.closest(MOB_MENU) || el.closest(MOB_FOLLOW) || el.closest(`.${MOB_SEAT_CLASS}`)) continue;
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType !== Node.TEXT_NODE || !(node.textContent ?? '').trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width <= 0 || rect.height <= 0) continue;
        if (rect.top >= line.bottom || rect.bottom <= line.top) continue;
        textRight = Math.max(textRight, rect.right);
      }
    }
  }
  return {
    top: line.top + line.height / 2 - MOB_PILL_HEIGHT / 2,
    right,
    width: Math.max(0, right - MOB_SEAT_GAP - textRight),
  };
}

/** The ground under a seat on a mobile card, read off the first ancestor that paints anything.
 *  The app decides our container's background on every render, but it writes that chrome only
 *  when the bar's key changes and it runs before the seat is measured, so the ground is written
 *  here as well as handed to the bar. */
function mobileSurfaceColor(root: Element): string {
  for (let el: Element | null = root; el; el = el.parentElement) {
    const bg = getComputedStyle(el).backgroundColor;
    if (bg && bg !== 'transparent' && !/^rgba\(0, 0, 0, 0\)$/.test(bg)) return bg;
  }
  return '#ffffff';
}

function textOf(el: Element | null | undefined): string {
  return (el?.textContent ?? '').trim();
}

/** A body's text as the PAGE wrote it, with our own paint left out: the strike wrap (whose
 *  data holds the substring it covers), the correction node beside it, and the badges and
 *  spinners. Those are the only things we ever put inside a body, and a post's text has to
 *  read the same before and after it is annotated — `capture` files this string and a card is
 *  NAMED by it, so a name that moved when the reader's highlights arrived would be a second
 *  identity for one post.
 *
 *  The same walk as `mfPlainText` in utils/injecting.ts, which cannot be imported here: the
 *  injecting layer reaches the adapters through the seam (see `platformSeam`), so importing it
 *  back would close the cycle. */
function hostText(el: Element | null | undefined): string {
  let out = '';
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.nodeValue ?? '';
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const child = node as Element;
    if (child.classList.contains('mf-corr') || child.classList.contains('mf-inline-badge')
      || child.classList.contains('mf-standalone-spinner')) return;
    if (child.classList.contains('mf-strike')) {
      out += child.getAttribute('data-mf-strike') ?? child.textContent ?? '';
      return;
    }
    for (const grandchild of Array.from(child.childNodes)) walk(grandchild);
  };
  walk(el as Node);
  return out.trim();
}

/** A body's text as the reader reads it: the whole text, with the page's own "… more" label —
 *  which the expander contributes to the body's last child — taken back off.
 *
 *  A clipped body is not a prefix. LinkedIn renders the entire text whether or not it is clamped
 *  (measured: expanding three tagged bodies took them 1171→1164, 859→853 and 167→161, each down
 *  by exactly the label), so nothing is reconstructed here and a clipped post files the same
 *  complete text as the same post once the reader expands it — one id, one hash, one
 *  classification, before and after. */
/** The length at which a post stops being one the reader takes in at a glance.
 *
 *  Measured 2026-10-01 across a scrolled feed at 1280px: the bodies shown whole ran to 225
 *  characters and the shortest body LinkedIn clamped was 269, so the boundary is inside that
 *  gap — which is where this platform's own 250 came from. It is no longer per-platform: the
 *  cut is a LINE clamp (`-webkit-line-clamp: 2…5` on the body itself), so the character it
 *  lands on moves with the column's width, and a per-host number made the same length mean
 *  two things on two platforms. Every platform reads the universal `LONG_FORM_CHARS`. */

function bodyText(body: Element | null | undefined): string {
  const text = hostText(body);
  const label = textOf(body?.querySelector(EXPANDER));
  if (!label) return text;
  return (text.endsWith(label) ? text.slice(0, -label.length) : text.replace(label, '')).trim();
}

/** The wrapper LinkedIn puts around a body it can translate. Its `id` is
 *  `translatable-commentary-FeTranslationUrn(…, targetLocale=<locale>)`, so it names the content
 *  and the language a translation would be in. Read as an id attribute and a field name inside
 *  it — never a label — so nothing here moves with the reader's language. */
const COMMENTARY = '[id*="translatable-commentary"]';

/** That target locale. Measured as the same `targetLocale=en` in both the source-shown and the
 *  translation-shown state of one post, which is why it cannot answer the side on its own. */
const TARGET_LOCALE = /targetLocale=([A-Za-z]{2,3}(?:-[A-Za-z0-9]+)*)/;

/** The shortest `componentkey` worth testing against a remembered state key. Card keys measure
 *  39 and 43 characters; the bound only stops a short structural key — the commentary wrapper's
 *  own is the literal `translatable-commentary` — matching a state key's tail by accident. */
const MIN_JOIN_KEY = 16;

/** What LinkedIn's SDUI tree last said about each of its translation controls, keyed by the
 *  state key it minted for it (forwarded by `linkedin.capture.content.ts`). This is the only
 *  place a post's displayed SIDE is knowable: the card is byte-identical across a flip — 1391
 *  elements compared attribute by attribute, no difference — and the one thing that does change
 *  there is the control's own label, which is translated per reader. */
const translationStates = new Map<string, 'Original' | 'Translated'>();

/** The commentary wrapper inside a root, when the host wrapped this post's body in one. */
function commentaryNode(root: Element): Element | null {
  return root.matches(COMMENTARY) ? root : root.querySelector(COMMENTARY);
}

function targetLocale(node: Element): string | null {
  return (node.getAttribute('id') ?? '').match(TARGET_LOCALE)?.[1] ?? null;
}

/** The host's translation state for the component a node belongs to, and that component.
 *
 *  A state key ENDS with the `componentkey` of the element rendering that translation — the one
 *  holding both the commentary and the control — and `componentkey` is hierarchical, so the join
 *  is a suffix test walking up from the commentary. Measured across six posts: every post the
 *  state covered matched at its own component, and the value agreed with the side on screen. */
function translationState(node: Element): { state: 'Original' | 'Translated'; container: Element } | null {
  let el: Element | null = node;
  for (let i = 0; el && i < 10; i++, el = el.parentElement) {
    const key = el.getAttribute('componentkey');
    if (!key || key.length < MIN_JOIN_KEY) continue;
    for (const [stateKey, state] of translationStates) {
      if (stateKey.endsWith(key)) return { state, container: el };
    }
  }
  return null;
}

/** The language of the translation a root is showing, or null. Both halves are structural: the
 *  locale is a field in the commentary wrapper's own id, and the SIDE is the host's remembered
 *  translation state (see `translationStates`) — because nothing in the DOM differs between the
 *  two sides, and the one difference there is, the control's label, is translated per reader. */
function displayedLocale(root: Element): string | null {
  const node = commentaryNode(root);
  if (!node) return null;
  const locale = targetLocale(node);
  if (!locale) return null;
  return translationState(node)?.state === 'Translated' ? locale : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The deepest element both nodes sit inside — how "the host rendered this with the body" is
 *  told from "the host rendered this somewhere else in the same component". */
function sharedAncestor(a: Element, b: Element): Element | null {
  const seen = new Set<Element>();
  for (let el: Element | null = a; el; el = el.parentElement) seen.add(el);
  for (let el: Element | null = b; el; el = el.parentElement) if (seen.has(el)) return el;
  return null;
}

/** The host's own Show original / Show translation control for a root, or null.
 *
 *  Nothing here reads its label, which is translated per reader, and nothing reads a class, which
 *  is obfuscated and re-minted on every build. What identifies it is its PLACE: the host renders
 *  it inline with the body, so of the component's buttons it is the one whose shared ancestor
 *  with the body is deepest — the overflow menu sits up in the header row and Reply down in the
 *  action bar, both above the body's own block. Its own `componentkey` is a bare UUID where a
 *  sibling control carries none, and it is the only control there with no `aria-label`; both are
 *  checked as a second line of defence.
 *
 *  Measured on a comment: the body and this control are the SAME child of the component, while
 *  "View more options for …" and "Reply" are in other children of it. */
function translationToggle(root: Element): Element | null {
  const body = root.querySelector(BODY);
  if (!body) return null;
  let best: Element | null = null;
  let bestDepth = Infinity;
  for (const button of Array.from(root.querySelectorAll('button[componentkey]'))) {
    if (!UUID.test(button.getAttribute('componentkey') ?? '')) continue;
    if (button.hasAttribute('aria-label')) continue;
    if (button.closest('[data-mf-charge]')) continue;
    const ancestor = sharedAncestor(body, button);
    if (!ancestor) continue;
    let depth = 0;
    for (let el: Element | null = ancestor; el && el !== root; el = el.parentElement) depth++;
    if (depth < bestDepth) {
      bestDepth = depth;
      best = button;
    }
  }
  return best;
}

/** The posts whose own words have been read off the page, keyed by post id.
 *
 *  A post is identified by the hash of its SOURCE text, so the source — not whichever side
 *  happens to be on screen — is what `capture` files, for the post and for every post it is
 *  classified alongside. LinkedIn renders one side at a time and a flip swaps the body for the
 *  other, leaving the source nowhere on the page; this is that copy, read while the post was
 *  still showing its own words, kept so one post holds one identity whichever side the reader
 *  is looking at.
 *
 *  Bounded because each entry is a whole post's worth of text and a reader can translate a long
 *  way down a feed. Oldest out first: a post scrolled far past is the one least likely to be
 *  asked for again. */
const MAX_REMEMBERED_SOURCES = 64;
const rememberedSources = new Map<string, string>();

function rememberSource(id: string, text: string): void {
  rememberedSources.delete(id);
  rememberedSources.set(id, text);
  while (rememberedSources.size > MAX_REMEMBERED_SOURCES) {
    const oldest = rememberedSources.keys().next().value;
    if (oldest === undefined) break;
    rememberedSources.delete(oldest);
  }
}

/** The posts whose source could not be read back, so the flip is not attempted again.
 *
 *  A post first reached already translated has had its own words swapped out for the other side
 *  and the only way back to them is the host's own control, which is a visible flip. One that
 *  fails is left alone for the rest of the page's life: a second attempt would cost the reader
 *  another flip to fail in the same way, and the post is still usable as it stands — captured as
 *  its own source would have been a different identity, so it stays out of the batch instead. */
const sourceFailed = new Set<string>();

/** The flips in flight, so two are never on the page at once: each one re-renders the component
 *  it is in, and a second flip starting mid-render would read the side the first one left. */
let flipping: Promise<void> = Promise.resolve();

const FLIP_TIMEOUT_MS = 4000;
const FLIP_POLL_MS = 60;

/** Poll `read` until it answers, or give up. Used to wait out a host re-render, which is what
 *  both halves of a flip are: nothing here knows how long React takes, only that it does not
 *  happen synchronously with the click. `timeoutMs` is that wait's budget, defaulted to the
 *  flip's; `revealClipped` is the other caller and asks for less, being only insurance. */
async function settle<T>(read: () => T | null, timeoutMs: number = FLIP_TIMEOUT_MS): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const answer = read();
    if (answer !== null) return answer;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, FLIP_POLL_MS));
  }
}

/** Click the host's control over to the other side, read the body there, and click back.
 *
 *  Both clicks are on the host's own control and change nothing but which side this reader sees.
 *  The click back runs whatever the read did, so the reader is never left on a side they did not
 *  choose. The control is re-found on every poll rather than held: the flip re-renders the
 *  component, so the element clicked is usually gone by the time the new side is up, and one
 *  that was measured before the re-render would keep reporting its stale label forever.
 *
 *  The only signal that the flip happened is that the control's own label CHANGED — the two sides
 *  are otherwise byte-identical, measured element by element. Its text is never matched against,
 *  only compared with itself, so this reads the same in any reader's language. Returns null when
 *  the label never moved: a click that did nothing is not a source, and filing the side still on
 *  screen would give the post a different identity in each of its languages. */
async function readOtherSide(root: Element, toggle: Element): Promise<string | null> {
  const labelBefore = textOf(toggle);
  (toggle as HTMLElement).click();
  const source = await settle(() => {
    const control = translationToggle(root);
    const body = textOf(root.querySelector(BODY));
    return control && body && textOf(control) !== labelBefore ? body : null;
  });
  const back = translationToggle(root);
  if (back) (back as HTMLElement).click();
  await settle(() => {
    const control = translationToggle(root);
    return control && textOf(control) === labelBefore ? true : null;
  });
  return source;
}

/** The post id a URL names, or null when the URL is not a post's own page. */
function postIdFromUrl(url: URL): string | null {
  const update = url.pathname.match(FEED_UPDATE);
  if (update) return `${update[1]}:${update[2]}`;
  const posts = url.pathname.match(POSTS_ACTIVITY);
  return posts ? `activity:${posts[1]}` : null;
}

/** The post this page is about, read once per URL rather than per call: every root is asked
 *  for its id on every mutation, and `new URL` on each of those is pure waste. */
let pageIdCache: { href: string; id: string | null } | null = null;
function pageId(): string | null {
  if (pageIdCache?.href !== location.href) {
    pageIdCache = { href: location.href, id: postIdFromUrl(new URL(location.href)) };
  }
  return pageIdCache.id;
}

/** The comment URN an element carries, when that element IS a comment root. */
function commentUrn(root: Element): { parent: string; comment: string } | null {
  if (!root.matches(COMMENT_EL)) return null;
  const m = (root.getAttribute('id') ?? '').match(COMMENT_URN);
  return m ? { parent: m[1], comment: m[2] } : null;
}

/** The Nearest comment root an element sits in, excluding the element itself. LinkedIn does not
 *  nest them (see `replyParentsOf`), so this is asked only for a layout that does. */
function enclosingComment(el: Element): Element | null {
  let cur: Element | null = el.parentElement;
  for (let i = 0; cur && i < 12; i++) {
    if (commentUrn(cur)) return cur;
    cur = cur.parentElement;
  }
  return null;
}

/** The post a card's own rendered comments name, or null.
 *
 *  A comment's element id is `urn:li:comment:(<its post>,<its id>)` — its first field is the
 *  POST — and every row rendered inside one card states the same one (measured on six cards on
 *  a search page, each holding 1, 2 or 4 rows). The `urn:li:` prefix is dropped because that is
 *  exactly what `postIdFromUrl` yields for the same post's permalink (`/feed/update/urn:li:
 *  ugcPost:<n>/` → `ugcPost:<n>`), so the card and the post's own page produce ONE id. */
function cardPostId(root: Element): string | null {
  const memo = cardUrns.get(root);
  if (memo) return memo;
  for (const row of Array.from(root.querySelectorAll(COMMENT_EL))) {
    const urn = commentUrn(row);
    if (!urn) continue;
    const id = namespaced(urn.parent.replace(URN_PREFIX, ''));
    cardUrns.set(root, id);
    return id;
  }
  return null;
}

/** The URNs already read off a card. Only a FOUND one is remembered: a card whose comment
 *  section is not rendered yet states nothing, and one that has just been opened states its post
 *  — so a remembered absence would be a name that never arrives. */
const cardUrns = new WeakMap<Element, string>();

/** The digest that names a card stating no URN: the author and the body's text, the same two
 *  fields the classifier's context is built from (`canonicalContext`).
 *
 *  Two accumulators rather than one because this is an IDENTITY — two posts sharing a name is
 *  the collision `post-id-names-one-text` refuses, and 64 bits over a page's worth of cards is
 *  not a risk worth taking for four lines. */
function wordsDigest(root: Element): string | null {
  const body = root.querySelector(BODY);
  const anchor = authorAnchor(root);
  const text = bodyText(body);
  const username = anchor ? visibleName(anchor) : '';
  if (!text || !username) return null;
  const words = `${username}\u001f${text}`;
  let a = 5381;
  let b = 2166136261;
  for (let i = 0; i < words.length; i++) {
    const c = words.charCodeAt(i);
    a = ((a * 33) ^ c) >>> 0;
    b = Math.imul(b ^ c, 16777619) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/** What each card's words were named, keyed by their digest and valued by the post URN its own
 *  comments stated. A card is named by its comments when they are rendered and by its words when
 *  they are not; remembering the first against the second is what keeps ONE name when the
 *  comment section closes again, in the same life and on the post's own page.
 *
 *  Bounded like `rememberedSources`: a long feed is a lot of cards, and a card scrolled far past
 *  is the one least likely to be asked for again. */
const MAX_RESOLVED_CARDS = 512;
const resolvedCards = new Map<string, string>();

/** The digest each root's words were first read as. Held per ELEMENT, which is what makes a
 *  name survive the one thing that can change a card's body under it: the reader translating it
 *  (the body is swapped for the other side, and the source is nowhere on the page). A card first
 *  seen already translated is deliberately NOT remembered — the words on screen are not the
 *  post's, and the name is the source's — so it is named once the reader puts it back, or once
 *  its comments state its URN. */
const cardKeys = new WeakMap<Element, string>();

/** The name of a card: its post's URN when its own comments state one, otherwise its own words.
 *
 *  Null when it can be named neither way — a card with no words or no author carries nothing to
 *  classify, and a card whose body is showing a translation is a card whose source is nowhere in
 *  the DOM to name it by. */
function cardId(root: Element): string | null {
  const key = cardKey(root);
  const urnId = cardPostId(root);
  if (key && urnId) resolvedCards.set(key, urnId);
  if (urnId) return urnId;
  return key ? resolvedCards.get(key) ?? namespaced(`text:${key}`) : null;
}

/** The digest of a card's words, remembered per element. */
function cardKey(root: Element): string | null {
  const memo = cardKeys.get(root);
  if (memo) return memo;
  if (displayedLocale(root)) return null;
  const key = wordsDigest(root);
  if (!key) return null;
  cardKeys.set(root, key);
  while (resolvedCards.size > MAX_RESOLVED_CARDS) {
    const oldest = resolvedCards.keys().next().value;
    if (oldest === undefined) break;
    resolvedCards.delete(oldest);
  }
  return key;
}

/** The mark LinkedIn puts on a REPLY: `data-sdui-anchor-id` on the thread glyph it draws at the
 *  reply's own indent, whose value is `comment-urn:li:comment:(<post>,<that reply>)::0`. Measured
 *  on `urn:li:activity:7510302384762413056`: its two replies carry it, its two comments on the
 *  post do not, and the id inside names the REPLY itself. The attribute never names the row a
 *  reply answers — its URN parents to the POST, like every other comment's — so the edge is read
 *  from the reply's own words instead (`replyParentsOf`). */
const REPLY_ANCHOR = '[data-sdui-anchor-id^="comment-urn:li:comment:"]';

/** Whether a comment root is a reply rather than a comment on the post. */
function isReply(root: Element): boolean {
  return !!root.querySelector(REPLY_ANCHOR);
}

/** The person a reply addresses: the first author link inside its body. LinkedIn's own Reply
 *  control writes that `@Name` at the head of the text, and it is the page's only statement of
 *  who a reply answers. Read with `visibleName`, the same reader a row's own author is read with,
 *  so the two are directly comparable. */
function mentionedName(root: Element): string {
  const body = root.querySelector(BODY);
  if (!body) return '';
  for (const a of Array.from(body.querySelectorAll(AUTHOR))) {
    const name = visibleName(a);
    if (name) return name;
  }
  return '';
}

/** A reply's ancestors: the comment that starts its thread, and the row it actually answers.
 *
 *  Nothing on the page states the edge. A reply's URN parents to the POST, exactly as a top-level
 *  comment's does — measured, all four URNs on `urn:li:activity:7510302384762413056` name the
 *  activity — and the rows are not nested either: every comment is a flat child of the list, no
 *  row a descendant of another, and no element carries a comment's parent. What the host does say
 *  is WHICH rows are replies (`isReply`) and, in the reply's own body, WHO it answers
 *  (`mentionedName`). Measured on a search-results thread that holds both kinds at once: replies
 *  whose `@Name` is the comment above them, and replies whose `@Name` is the reply above them — so
 *  a reply does not necessarily answer the comment it hangs under, and the mention is what tells
 *  the two apart. The row answered is therefore the nearest preceding row in the thread that the
 *  reply mentions; when it mentions nobody in the thread, the thread's comment is the answer,
 *  which is the ancestor the host's own indentation draws. Both are needed: the thread's comment
 *  is the conversation the reply belongs to, while the row answered is what its hash chains to.
 *
 *  `enclosingComment` is asked first for a layout that nests the rows after all. */
function replyParentsOf(root: Element): { thread: Element | null; target: Element | null } {
  const nested = enclosingComment(root);
  if (nested) return { thread: nested, target: nested };
  const urn = commentUrn(root);
  if (!urn || !isReply(root)) return { thread: null, target: null };
  const name = mentionedName(root);
  let thread: Element | null = null;
  let target: Element | null = null;
  for (const row of Array.from(document.querySelectorAll(COMMENT_EL))) {
    if (row === root) break;
    const other = commentUrn(row);
    if (!other || other.parent !== urn.parent) continue;
    // A comment on the post starts a thread; only rows after the last one are this reply's.
    if (!isReply(row)) { thread = row; target = null; continue; }
    if (!name) continue;
    const anchor = authorAnchor(row);
    if (anchor && visibleName(anchor) === name) target = row;
  }
  return { thread, target: target ?? thread };
}

/** Every element on the page that carries a post's or a comment's words. */
function allRoots(): Element[] {
  const roots: Element[] = [];
  for (const li of Array.from(document.querySelectorAll('[role="listitem"]'))) {
    // A comment inside a feed card is its own post with its own id; it must not be handed to
    // the card as well, or one element becomes two posts over one text.
    if (enclosingComment(li)) continue;
    if (li.querySelector(BODY)) roots.push(li);
  }
  for (const c of Array.from(document.querySelectorAll(COMMENT_EL))) {
    // The `…::0` sub-element shares the id's prefix but is not a comment.
    if (commentUrn(c) && c.querySelector(BODY)) roots.push(c);
  }
  // The mobile app's cards, which carry none of the markers above. Gated on the document so a
  // desktop page pays one query for the whole sweep rather than one per candidate.
  if (isMobileDocument()) {
    for (const art of Array.from(document.querySelectorAll(MOB_ART))) {
      if (isMobileRoot(art)) roots.push(art);
    }
  }
  return roots;
}

/** The post root a page that names a post is showing.
 *
 *  The detail marker is preferred because it is the only thing that tells the focused post
 *  apart from a feed card left behind it. When it is absent the fallback is allowed only if
 *  the page holds exactly ONE body-bearing post — with two or more candidates there is no way
 *  to say which the URL names, and guessing would key the wrong text under the page's id. */
function pagePostRoot(): Element | null {
  const posts = allRoots().filter((root) => !commentUrn(root));
  const marked = posts.filter((root) => root.matches(DETAIL_POST));
  if (marked.length) return marked[0];
  return posts.length === 1 ? posts[0] : null;
}

function postIdOf(root: Element): string | null {
  // A mobile card names itself: `data-activity-urn` is the post's URN, so the SAME post reached
  // through its permalink (`postIdFromUrl`) and through this card produce one id, with no digest
  // and no comment section needed. A reshare's card also states `data-featured-activity-urn` —
  // the post it is showing — and `data-attributed-urn`, the `urn:li:share:…` object behind it.
  // Neither is read: filing the reshare's own commentary under the original's id would put two
  // posts' words under one name the moment the original is also on screen.
  if (isMobileRoot(root)) {
    const urn = root.getAttribute('data-activity-urn');
    return urn && urn.startsWith('urn:li:') ? namespaced(urn.replace(URN_PREFIX, '')) : null;
  }
  const urn = commentUrn(root);
  if (urn) return namespaced(`comment:${urn.comment}`);
  // A page that names a post names exactly one root; every other post on it — a feed card
  // behind the focused post — is named the ordinary way, by its comments or its words.
  const id = pageId();
  if (id && root === pagePostRoot()) return namespaced(id);
  return cardId(root);
}

/** The author's link inside a root: the LAST one that names someone before the root's own words.
 *
 *  An avatar's link is the same shape with no text in it, so an empty one is skipped. The link is
 *  taken from the END of the run rather than the start because a card does not always begin with
 *  its byline: LinkedIn draws a social-context line above it — "Followed by <someone>",
 *  "<someone> commented", "<someone> reposted this" — and that line's actor is a profile link of
 *  exactly the same shape, so the first named one is a different person from the post's author.
 *  Measured on a feed card carrying "Followed by …": two named author links appeared before the
 *  body, a 16-character banner actor and the 31-character byline below it. Reading the first filed
 *  the post under the banner's actor — in the identity (`wordsDigest`), in `capture`'s username,
 *  and therefore in the hash and the classifier's context, not just on screen.
 *
 *  Stopping at the root's own body is what keeps the rest of the run out: a mention inside the
 *  post's words, a headline link, and every comment's author are all at or after it. The last
 *  named link before the body is the byline on both shapes measured — a card with a banner and a
 *  card without one — and the per-row-links count is why: a byline row carries three profile
 *  links and exactly one of them names anyone.
 *
 *  A root with no body cannot be bounded this way; it falls back to the first named link, which is
 *  what this always returned. */
function authorAnchor(root: Element): Element | null {
  if (isMobileRoot(root)) return mobileAuthor(root);
  const body = root.querySelector(BODY);
  let first: Element | null = null;
  let last: Element | null = null;
  for (const a of Array.from(root.querySelectorAll(AUTHOR))) {
    if (!visibleName(a)) continue;
    if (!body) { first ??= a; continue; }
    if (body.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING) break;
    last = a;
  }
  return body ? last : first;
}

/** The element whose OWN text nodes carry the author's name.
 *
 *  The anchor is walked in document order and the first element holding text of its own wins,
 *  with a leaf laid out a pixel wide skipped as the screen-reader copy — the same two rules the
 *  name reader has always used, stopping at the element that holds the name rather than running
 *  on through everything else the anchor wraps.
 *
 *  The `children` guard on the width test is what keeps a `display:contents` wrapper — 0x0 but
 *  holding the real byline — from being mistaken for a hidden copy. */
function nameHolder(el: Element): Element | null {
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      if ((child.nodeValue ?? '').trim()) return el;
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const node = child as Element;
    // The verification glyph is an `svg`; its text is the badge's own title.
    if (node.tagName === 'SVG') continue;
    if (!node.children.length && node.getBoundingClientRect().width <= 2) continue;
    const found = nameHolder(node);
    if (found) return found;
  }
  return null;
}

/** The author's name as the reader sees it.
 *
 *  LinkedIn renders a screen-reader string into the SAME anchor as the visible name — measured,
 *  "Sonny Tai Premium Profile 3rd+…" beside the real byline — and nothing about it says so: no
 *  `aria-hidden`, same tag, no class of its own, and in a comment it comes FIRST in document
 *  order, so "the first non-empty span" reads the degree and calls it the author (measured: the
 *  name came back as "• 3rd+"). What does separate the two copies is that the hidden one is laid
 *  out 1x1 px, so a leaf element that renders a pixel wide is the screen reader's and its
 *  subtree is skipped. The degree, where there is one, is then cut at the bullet LinkedIn
 *  separates it with. Neither the geometry nor the bullet is a label or a class, so neither
 *  moves with the reader's language.
 *
 *  The name is read from the ONE element that holds it, never from the whole anchor. An anchor
 *  wraps more than the name on the rows that state a chip instead of a degree, and the degree
 *  cut above does not save those — measured on a post's own author replying to his post, whose
 *  anchor holds the name, LinkedIn's "Author" chip and the author's headline in that order, and
 *  which filed as "Gerardo BonillaAuthorCo-Founder of Temso AI | Market your products to AI
 *  agents": the chip's word is the READER's ("Auteur"), the headline is the author's own and
 *  changes when they edit it, and both are inside the post's hash (`canonicalContext` is
 *  `username + '\x1f' + fullText`), so one comment hashed two ways across readers and re-hashed
 *  when its author edited their profile. Reading the holder stops at the name; the two rows
 *  measured with a degree — a post root and two comments — read exactly as they did before.
 *
 *  The walk spans TEXT NODES rather than picking a `span`, because LinkedIn does not agree with
 *  itself about which element holds the name: a post puts it in a span of its own, while a
 *  comment leaves it bare beside the badge, where no leaf span contains it at all. */
function visibleName(anchor: Element): string {
  const holder = nameHolder(anchor);
  if (!holder) return '';
  let out = '';
  for (const node of Array.from(holder.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) out += node.nodeValue ?? '';
  }
  return out.split(DEGREE_SEP)[0].replace(/\s+/g, ' ').trim();
}

/** The host's own control cluster, as the run of `button` children at the END of the header
 *  row. Matching on the element being a button — rather than on containing one — is what keeps
 *  a `Follow` button that sits in its own wrapper from being swept into the run. */
function trailingRun(row: Element): Element[] {
  const kids = Array.from(row.children);
  let i = kids.length;
  while (i > 0 && kids[i - 1].tagName === 'BUTTON') i--;
  return kids.slice(i);
}

function trailingControl(row: Element): Element | null {
  return trailingRun(row)[0] ?? null;
}

/** The box the host's controls occupy — the Follow button and the overflow menu — which is the
 *  line our own buttons are centred on.
 *
 *  The whole run rather than its first element: the two controls are different heights (measured
 *  48px for Follow and 32px for the menu) and are centred on each other, so their union is the
 *  line the reader sees them on. Returns null when the run is empty or nothing in it is laid
 *  out, which leaves the caller its author-anchored fallback. */
function controlsBox(row: Element): { top: number; height: number } | null {
  let top = Infinity;
  let bottom = -Infinity;
  for (const el of trailingRun(row)) {
    const rect = el.getBoundingClientRect();
    if (rect.height <= 0) continue;
    top = Math.min(top, rect.top);
    bottom = Math.max(bottom, rect.bottom);
  }
  return Number.isFinite(top) && bottom > top ? { top, height: bottom - top } : null;
}

/** The header row: the nearest flex ancestor of the name that also holds a control. Found by
 *  the control's place in the row, never by its label, which is translated ("View more options
 *  for …" in English and something else per reader).
 *
 *  On a card that carries a social-context banner the control test can miss, and the miss is not
 *  harmless: measured on such a card, the byline's row was a `flex` whose children are
 *  `[byline block, degree, wrapper]` — the Follow control inside that trailing wrapper rather than
 *  a `button` child of the row — so no `flex` ancestor ended in a control and this returned null,
 *  leaving the post with no buttons at all. So a second, purely positional read is tried: the last
 *  level above the byline that does NOT yet contain the card's own body. On both shapes measured
 *  that is the byline's row — on a card without a banner the two rules agree on the same element,
 *  so nothing that works today is re-decided; the fallback only answers where this used to return
 *  null. Bounded like the walk above, and it gives up rather than climbing to the root, which
 *  contains the body by definition. */
function headerRow(root: Element, anchor: Element): Element | null {
  let el: Element | null = anchor;
  for (let i = 0; el && el !== root && i < 8; i++) {
    if (getComputedStyle(el).display === 'flex' && trailingControl(el)) return el;
    el = el.parentElement;
  }
  const body = root.querySelector(BODY);
  if (!body) return null;
  let up: Element | null = anchor;
  let last: Element | null = null;
  for (let i = 0; up && up !== root && i < 10; i++, up = up.parentElement) {
    if (up.contains(body)) break;
    last = up;
  }
  return last;
}

/** The row's own child that holds the author — what our buttons are inserted immediately
 *  AFTER, so they sit right beside the name and ahead of everything else on the line.
 *
 *  That one insert point reads correctly on both surfaces because of where each keeps its
 *  timestamp. A post holds the name, the credential AND the time in a single block, so inserting
 *  after the block leaves the buttons to the right of the time, on the name's line. A comment
 *  keeps only the name and the credential in the anchor and lays the time out as the NEXT
 *  sibling, so inserting after the anchor is what places the buttons to the LEFT of the time —
 *  which is where they belong there (measured: `[anchor, 17h, Follow, "…"]`).
 *
 *  Inserting before the host's first control instead reads the same on a post but lands the
 *  buttons to the right of the time in a comment, because a timestamp is not a control.
 *
 *  Nothing here reads a label: the control's is translated ("Suivre", "Folgen" …). */
function authorRowChild(row: Element, anchor: Element): Element | null {
  let from: Element = anchor;
  while (from.parentElement && from.parentElement !== row) from = from.parentElement;
  return from.parentElement === row ? from : null;
}

/** A COMMENT row's timestamp: the first sibling after the author's block that is not one of the
 *  host's controls, which is where LinkedIn lays the time out. Null when the row holds none —
 *  or when a control comes first, which means this row does not have the measured shape and the
 *  buttons are better left where a post's go than guessed at. Never read by its label: a
 *  relative time is `17h` here and something else elsewhere, and a control's label is
 *  translated. */
function stampSiblingAfter(after: Element): Element | null {
  for (let el = after.nextElementSibling; el; el = el.nextElementSibling) {
    if (el.querySelector('button, [role="button"]')) return null;
    if (el.textContent?.trim()) return el;
  }
  return null;
}

/** Whether a body is showing less than it holds. LinkedIn clamps a long body with CSS on the body
 *  itself, so the overflow is the whole test — read by `unclip` and `revealClipped` so the two
 *  agree on what "still closed" means. */
function heldBack(body: Element): boolean {
  return body.scrollHeight > body.clientHeight + 1;
}

/** How long `revealClipped` waits for the host to finish withdrawing its own control. Bounded and
 *  short: the wait is insurance against painting into a subtree React is midway through, and a
 *  host that keeps its control has nothing for React to remove, so painting is safe either way. */
const OPEN_TIMEOUT_MS = 1200;

export const linkedinAdapter: PlatformAdapter = {
  id: 'linkedin',
  hosts: PLATFORM_HOSTS.linkedin ?? [],

  postIdFromUrl(url) {
    const id = postIdFromUrl(url);
    return id ? namespaced(id) : null;
  },

  postRoots(id) {
    return allRoots().filter((root) => postIdOf(root) === id);
  },

  postIdOf,

  /** A post or a comment, judged for length — see LONG_FORM_CHARS.
   *
   *  A comment is never long-form: the reader gets its buttons whatever it says. The body
   *  measured is the one the post is filed from, which is the whole text either way — LinkedIn's
   *  clamp is presentation only and leaves the string intact (see `bodyText`), so this reads the
   *  same length the classifier would. */
  isLongForm(root) {
    if (commentUrn(root)) return false;
    return bodyText(bodyIn(root)).length >= LONG_FORM_CHARS;
  },

  textElement(root) {
    return bodyIn(root);
  },

  /** Show the whole body once we have painted marks into it.
   *
   *  LinkedIn clamps a long body with CSS on the body element ITSELF — measured across a feed,
   *  `display: flow-root`, `-webkit-box-orient: vertical`, `-webkit-line-clamp: 2…5`,
   *  `overflow: hidden`, `max-height: none`, so a 320px body is laid out 60px tall — and hides
   *  the rest behind its own "… more" control, a child of that same body. Highlights are painted
   *  into the body's own text nodes, so a reader who follows a claim into a clipped post would be
   *  reading a hijacked view: three lines, an ellipsis, and marks on whichever of them happened
   *  to be visible.
   *
   *  Two declarations are the whole of it, and they are enough: measured on a live card, clearing
   *  `-webkit-line-clamp` and `overflow` alone takes it from 60px to its full 320px, and the host
   *  then withdraws its own "… more" without being asked — the control is rendered on a
   *  measurement of the body, so it goes as soon as the body stops overflowing. The clearing also
   *  HOLDS: the same card measured for twelve seconds afterwards kept the full height, so the
   *  host is not re-clamping behind us and this need not be re-applied.
   *
   *  The host's control is deliberately left in the DOM rather than removed. It is React's node,
   *  and a node deleted from outside React is the classic way to break reconciliation on the
   *  host's next render of that subtree — the very subtree our `<span class="mf-segment-wrap">`
   *  lives in. Nothing here changes the text (the clamped body already holds all of it), so the
   *  hash and the id are untouched either way.
   *
   *  The mobile app clamps by a different means and needs a third declaration. Measured on a live
   *  card: a body holding 2289 characters computed `height: 63px; max-height: 63px` with
   *  `-webkit-line-clamp: none` — a fixed height, not a line count — and the two declarations
   *  above, applied for real, left it at exactly 63px, with the whole string still in the DOM and
   *  none of it on screen. Clearing the height as well is what expands it (the same card then
   *  measured 2289px). So the height is released too, and only when the element is actually
   *  showing less than it holds, which is what the two measurements side by side say: the body
   *  that is whole measures equal and is left alone, whichever surface it came from. */
  unclip(textElement) {
    const body = textElement as HTMLElement;
    if (heldBack(body)) {
      body.style.height = 'auto';
      body.style.maxHeight = 'none';
    }
    body.style.webkitLineClamp = 'unset';
    body.style.overflow = 'visible';
  },

  /** Let the host finish taking its own "… more" back out of the body, before we paint into it.
   *
   *  LinkedIn clamps with CSS on the body and keeps its control as a direct child of that body
   *  (see `unclip`), so what the host is watching is the overflow: clearing it makes the host
   *  re-render the post to withdraw the control, and it does that in its own time. The paint that
   *  follows moves the body's children into `.mf-segment-wrap`, the control among them, and by
   *  then React's removal of a node it owns finds that node gone from the body it recorded — which
   *  throws, and LinkedIn answers an uncaught throw with its error boundary. The reader's page is
   *  replaced. Waiting here is what keeps the two apart.
   *
   *  The click is conditional because `unclip` has usually done the expanding already: asking a
   *  body that is already whole could be read as the opposite request. The wait is not
   *  conditional — it covers the case where the clamp is cleared and the host's removal is still
   *  in flight, which is the one that crashes.
   *
   *  Declares this WITHOUT `bodyClipped`, and that pairing is the point: the sweep expands only a
   *  host that needs it, and a clipped LinkedIn body is complete in the DOM already (`bodyText`
   *  reads all of it), so nothing is gained by clicking the page on every pass. Only the reader's
   *  own click pays for this wait, which is also why there is no attempt bound here. */
  async revealClipped(root) {
    const body = bodyIn(root);
    if (!body) return;
    if (heldBack(body)) (body.querySelector(EXPANDER) as HTMLElement | null)?.click();
    await settle(() => (root.isConnected && body.querySelector(EXPANDER) ? null : true), OPEN_TIMEOUT_MS);
  },

  // LinkedIn bodies are markup: a post can carry mentions, hashtags and links, and the page
  // renders them as elements. Rebuilding the body from the classified string would flatten
  // them, so highlights wrap the page's own text nodes in place instead.
  highlightInPlace: true,

  placeButtons(container, root) {
    // A card named by its words and later by its comments arrives under a second id, and the
    // container dedupe is per id (`article.querySelector('[mf-top-bar-id="<id>"]')`), so the
    // first pill would simply be left where it was and the card would carry two. Anything else
    // holding this root is superseded by definition — except a nested comment's own pill, which
    // is placed inside the same subtree and belongs to a different post id entirely.
    for (const old of Array.from(root.querySelectorAll<HTMLElement>(CONTAINER))) {
      if (old === container || enclosingComment(old)) continue;
      old.remove();
    }

    // A mobile card's buttons go on the post's own line — the author's — placed the way the
    // sibling desktop surface places them, right of the author's own block and clear of the
    // control that ends that row. See `mobileSeat` for what that row leaves and why the card's
    // provenance line above it is not the seat.
    if (isMobileRoot(root)) {
      // A card the app has built but recycled off-screen has no box: every edge measures zero,
      // and seating from that rectangle puts the pill at the column's left edge on a card that
      // then appears. Nothing can be measured here, so nothing is placed, and the next pass that
      // seats it — once the card has a box — is the one that decides where it goes.
      const rect = root.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        container.dataset.mfSeatWidth = '-1';
        container.style.visibility = 'hidden';
        if (container.parentElement !== root) root.appendChild(container);
        return;
      }
      const seat = mobileSeat(root);
      if (!seat) return;
      container.style.visibility = '';
      container.style.float = '';
      container.style.marginLeft = '';
      container.style.marginRight = '';
      container.style.marginTop = '';
      container.style.position = 'absolute';
      container.style.zIndex = MOB_SEAT_Z;
      // The ground is written here as well as told to the bar's own renderer, which decides the
      // container's background on every render but writes that chrome only when its key changes.
      const surface = mobileSurfaceColor(root);
      container.dataset.mfSeatBg = surface;
      container.style.backgroundColor = surface;
      // The width the app left, for the bar's renderer: a row with no room for words gets the
      // mark instead of a label crushed to nothing.
      container.dataset.mfSeatWidth = String(Math.round(seat.width));
      // Only when it is not already there: this runs on every pass that re-measures the seat, and
      // re-appending a node that is already the root's last child is a DOM mutation with no
      // effect on the layout.
      if (container.parentElement !== root) root.appendChild(container);
      // Anchored by its RIGHT edge, not its left: the bar's width is not known here — the
      // renderer that decides how much of the label survives runs after this — and an edge held
      // at a distance from the row's end stays put while the bar's width changes under it.
      const block = (container.offsetParent as HTMLElement | null) ?? root;
      const blockRect = block.getBoundingClientRect();
      container.style.left = 'auto';
      container.style.right = `${Math.round(blockRect.right - seat.right)}px`;
      container.style.top = `${Math.round(seat.top - blockRect.top)}px`;
      return;
    }

    // A post's buttons go on the line the author's name is on, immediately to the RIGHT of the
    // author's own block — which for a post puts them to the right of the time too, because the
    // block holds the name, the credential AND the time. A COMMENT keeps only the name and the
    // credential in that block and lays the time out as the NEXT sibling (measured:
    // `[anchor, 17h, Follow, "…"]`), so the same insert point put a comment's pill to the LEFT
    // of its time; a comment's goes to the right of it instead, the position every platform
    // here shares. See authorRowChild for which row-child is the one to insert after.
    const anchor = authorAnchor(root);
    if (!anchor) return;
    const row = headerRow(root, anchor);
    if (!row) return;
    const after = authorRowChild(row, anchor);
    if (!after) return;
    const stamp = commentUrn(root) ? stampSiblingAfter(after) : null;
    if (stamp) stamp.insertAdjacentElement('afterend', container);
    else after.after(container);

    // The insert point leaves the buttons flush against whatever follows, and on a post that is
    // the next thing on the line. LinkedIn's own rhythm in this row is 8px (avatar to byline,
    // and the gap before the byline's own controls), so the buttons take the same on both sides:
    // on a comment that is the gap off the "17h" behind them.
    container.style.marginLeft = stamp ? '8px' : '';
    container.style.marginRight = '8px';

    // The row is top-aligned, and the buttons are centred on the line the host's own controls
    // sit on — the Follow button and the overflow menu — rather than on the author cluster's
    // top edge. The two differ because the author block is the taller element (48px against
    // 32px, measured) and carries a margin the controls do not; centring on the name instead
    // leaves the buttons reading as part of the byline rather than as a peer of Follow.
    //
    // Everything is measured from the live boxes rather than written down, so it follows the
    // host if either margin changes, and a row with no control to centre on falls back to the
    // author's line.
    const rowTop = row.getBoundingClientRect().top;
    const controls = controlsBox(row);
    const height = container.getBoundingClientRect().height;
    const delta = controls && height > 0
      ? controls.top + controls.height / 2 - rowTop - height / 2
      : anchor.getBoundingClientRect().top - rowTop;
    container.style.marginTop = Number.isFinite(delta) && delta > 0 ? `${Math.round(delta)}px` : '';
  },

  feedCenter() {
    // The content column is as wide as a post's own root, so a post is what to measure — the
    // column, not the viewport, is what the floating buttons belong over.
    const root = pagePostRoot() ?? allRoots()[0];
    if (!root) return null;
    const rect = root.getBoundingClientRect();
    return rect.width > 0 ? rect.left + rect.width / 2 : null;
  },

  isPostTarget(id) {
    return allRoots().some((root) => postIdOf(root) === id);
  },

  postElementFor(node) {
    const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    if (!el) return null;
    // A card of the mobile app, named by its own URN: a selection anywhere inside it belongs to
    // it. The mobile surface renders no comment rows yet, so there is no inner root to prefer.
    const card = el.closest(MOB_ART);
    if (card && isMobileRoot(card) && postIdOf(card)) return card;
    // Innermost first: a reply sits inside the comment it answers, and a selection in the
    // reply must be handed to the reply rather than to the comment around it.
    const comment = enclosingComment(el);
    if (comment && postIdOf(comment)) return comment;
    const detail = el.closest(DETAIL_POST);
    if (detail && pageId() && detail === pagePostRoot()) return detail;
    return null;
  },

  captureRoots() {
    return allRoots();
  },

  /** The language of the translation this post is showing, or null.
   *
   *  The two halves come from different places, and neither is a label. The locale is a field in
   *  the commentary wrapper's own id. The SIDE is the host's remembered translation state,
   *  which reaches us from the payload (`linkedin.capture.content.ts`) because nothing in the
   *  DOM differs across a flip. A post the state does not cover reads as its own source — right
   *  for every post the reader has never translated, and the behaviour this adapter had before
   *  the state existed for the rest. */
  displayedTranslationLocale(root) {
    return displayedLocale(root);
  },

  /** The body of the side on screen. Read only when the reader's own flip is being reported. */
  displayedText(root) {
    return textOf(bodyIn(root)) || null;
  },

  /** Read a translated post's own words back off the host's control.
   *
   *  LinkedIn renders one side at a time, so a post the reader has translated has had its source
   *  swapped out for the other language and the source is nowhere on the page. `capture` files
   *  the SOURCE — the hash, and with it every stored classification and highlight key, is
   *  computed from it — so without this a post first reached already translated has nothing to be
   *  filed under and is dropped from the batch outright: no buttons on it, and never classified.
   *  That is a post the reader can see going unintegrated, which is the one thing this adapter is
   *  not allowed to do.
   *
   *  The flip is visible, so it happens once per post, before the post is captured, and is undone
   *  before this returns — `native.content.ts` orders the batch so off-screen posts go first and
   *  skips whatever is under the pointer. */
  async revealSource(root) {
    const id = postIdOf(root);
    if (!id || rememberedSources.has(id) || sourceFailed.has(id)) return;
    // Nothing to recover: the post is showing its own words, which `capture` reads directly.
    // This is the ordinary case, and the one that costs nothing.
    if (!displayedLocale(root)) return;

    flipping = flipping
      .then(async () => {
        // Re-checked inside the queue: the post may have scrolled out and been re-rendered
        // while an earlier flip was in flight.
        if (!root.isConnected || rememberedSources.has(id) || sourceFailed.has(id)) return;
        if (!displayedLocale(root)) return;
        const toggle = translationToggle(root);
        if (!toggle) {
          sourceFailed.add(id);
          return;
        }
        const source = await readOtherSide(root, toggle);
        if (source === null) {
          sourceFailed.add(id);
          return;
        }
        rememberSource(id, source);
      })
      .catch((e) => {
        console.error("[misinfo] linkedin: reading a post's source failed", e);
      });
    return flipping;
  },

  /** Remember what the host's translation controls are showing.
   *
   *  Not a capture: a record is a state key and the word `Original` or `Translated`, and it names
   *  no post, no author and no text. It is remembered for one reader — `displayedTranslationLocale`
   *  — because it answers the one question about a translated post that its own DOM cannot. */
  absorbTranslations(records) {
    for (const record of records) {
      if (!record || typeof record !== 'object') continue;
      const { key, state } = record as { key?: unknown; state?: unknown };
      if (typeof key !== 'string' || key.length === 0) continue;
      if (state !== 'Original' && state !== 'Translated') continue;
      translationStates.set(key, state);
    }
  },

  capture(root): CapturedPost | null {
    const id = postIdOf(root);
    if (!id) return null;

    const body = bodyIn(root);
    if (!body) return null;

    // What is filed is the post's SOURCE, never the side on screen — the hash, and with it every
    // stored classification and highlight key, is computed from `fullText`. While the reader is
    // looking at the post's own words the two are the same thing; while they are looking at a
    // translation it is the copy `rememberSource` kept from before the flip, because the flip
    // swapped the body for the other side and LinkedIn renders one side at a time. A post first
    // reached already translated has its source read back off the host's own control before it
    // gets here (`revealSource`), so it is filed under the same identity as everyone else's copy
    // of it rather than under the translation, which would give one post a different hash in each
    // of its languages — classified, and billed, once per language as if each were a new post.
    const locale = displayedLocale(root);
    const shown = bodyText(body);
    const remembered = rememberedSources.get(id);
    // The remembered source wins whenever there is one: it is the identity, and reading the side
    // on screen in its place would undo the flip's work on the sweep where the host's translation
    // state happens to be mid-update.
    const text = remembered ?? shown;
    const anchor = authorAnchor(root);
    const username = anchor ? visibleName(anchor) : '';
    // A post with no words carries nothing to fact-check, and one with no name carries no
    // context to classify it with. Either way it stays out of the batch rather than spending a
    // classification on it.
    if (!text || !username) return null;
    if (!locale) rememberSource(id, text);

    const urn = commentUrn(root);
    if (urn) {
      // A reply has two ancestors and the page states neither in an attribute: the comment its
      // thread starts from, and the row it answers; see `replyParentsOf`.
      // The URL is asked for the post first, and the comment's
      // own URN second, for the surfaces that have no post in the URL: a comment rendered on
      // the FEED states its post exactly as one on the post's own page does (measured,
      // `activity:7510302384762413056` in both), so `namespaced` of either yields the SAME id
      // and the comment links to the same post on both. Reading the URL alone left every feed
      // comment with no parent at all — the same words filed under two ids, an orphan on the
      // feed and a chained comment on the post's page — which is what `post-id-names-one-text`
      // refuses. The URL still wins where it names a post, because it is what the post's OWN
      // root is filed under and the two must agree.
      const { thread, target } = replyParentsOf(root);
      const threadId = thread ? postIdOf(thread) : null;
      const parentId = target ? postIdOf(target) : null;
      const post = pageId() ?? urn.parent;
      return {
        post: {
          id,
          text,
          fullText: text,
          // The side on screen, carried beside the source the way Telegram and Threads carry
          // theirs: the background needs to know which of the two the reader is reading before
          // it can localize the highlight ranges into that language.
          translatedText: locale ? shown : undefined,
          destinationLanguage: locale ?? undefined,
          username,
          usertype: anchor?.querySelector(VERIFIED_BADGE) ? VERIFIED : REGULAR,
          // Every row in a thread belongs to the same conversation, replies to replies included:
          // the thread's comment, not the row answered, which may itself be a reply.
          conversationId: threadId ?? namespaced(post),
          quoting: null,
          replyingTo: null,
        } as MainTweet,
        replyParentId: parentId ?? namespaced(post),
      };
    }

    return {
      post: {
        id,
        text,
        fullText: text,
        translatedText: locale ? shown : undefined,
        destinationLanguage: locale ?? undefined,
        username,
        usertype: anchor?.querySelector(VERIFIED_BADGE) ? VERIFIED : REGULAR,
        conversationId: id,
        quoting: null,
        replyingTo: null,
      } as MainTweet,
      replyParentId: null,
    };
  },
};
