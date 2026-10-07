/** The Threads adapter.
 *
 *  Threads is a React SPA whose markup carries no class names worth keying on: every
 *  element is a `div` with build-hash classes, and its own test-id attribute
 *  (`data-interactive-id`) is present on every post but EMPTY (measured: `""` on all of
 *  them), so it names nothing. What is stable, and what everything below keys on, is the
 *  app's own structural vocabulary — `data-pressable-container`, `role="button"` +
 *  `aria-haspopup="menu"`, `<time>`, `span[dir="auto"]` — and the permalink shape of its
 *  hrefs.
 *
 *  Threads DOES feed itself from GraphQL (`/api/graphql` and `/graphql/query`,
 *  form-encoded, every call carrying `fb_api_req_friendly_name`), and the TEXT comes from
 *  there: `captureNetwork` reads the caption as authored, and the markup is only asked
 *  where to paint it. The two sources differ, and measurement says the difference is always
 *  the renderer discarding text:
 *
 *  - A caption long enough to be clipped ends at `View N more` in the markup while the
 *    payload carries every paragraph.
 *  - An inline link renders as `meta.com/thefu…` where the payload has
 *    `meta.com/thefutureisforeveryone`.
 *  - The card and the media are not in the payload's caption at all — Threads marks them
 *    as attachments (`text_post_app_info.link_preview_attachment` is populated exactly on
 *    the post that renders a card) — so the words-only boundary is the payload's own shape
 *    rather than something inferred from the page.
 *
 *  The thread around a post comes from the payload as well, and it is what the ancestor chain
 *  is built from. A reply's parent is stated by POSITION rather than by a field:
 *  `text_post_app_info.direct_replies.edges[i].node.posts.edges` is one thread, its first
 *  entry answers the post that owns the connection and each later entry answers the one
 *  before it, so the interceptor carries a `parent` shortcode and this file turns it into a
 *  `replyParentId` for `hydrateReplyChains` to link. A post that QUOTES another carries it
 *  inline (`share_info.quoted_post`, copied into `quoted`), which is what fills `quoting` —
 *  the quote card itself is a container with no header, so it could never carry buttons and
 *  is never filed as a post of its own.
 *
 *  What the payload does not carry is not invented here: it says nothing about a post's
 *  language (`detected_language` and `original_lang_for_translations` are null on every post
 *  observed), so `sourceLanguage` stays empty. The renderer, by contrast, adds something of its
 *  own — the thread's position, appended to the last block (`… 2/5`) — and the DOM reading drops
 *  it (`isPositionBurst`) so that the markup-only path and the payload path classify one string.
 *  That last point is load-bearing rather than tidy: a post met with its payload and the same
 *  post met without it were hashed over two different strings until the burst was dropped,
 *  measured on one id, and the collision is the one `post-id-names-one-text` exists to refuse.
 *
 *  One post id must still name ONE text: the background's cache is id-keyed while its store
 *  is keyed by a hash of the text, so two surfaces naming different texts for one id collide.
 *  The caption is therefore captured once per id and remembered — and the two halves meet on
 *  the string the extension actually classified, which is what `postRegions` aligns the page
 *  against instead of assuming the page holds it verbatim.
 */
import type { MainTweet, QuotedTweet, Usertype } from '../../data/Tweets';
import { Usertype as UsertypeEnum } from '../../data/Tweets';
import { isPassageInvisible, sealHostEvents } from '../injecting';
import { appLanguage } from './capture';
import { PLATFORM_HOSTS } from './hosts';
import type { CapturedPost, PlatformAdapter, TextRegion } from './types';

/** Threads post codes are the shortcode of a globally unique post id (the permalink's
 *  `/@user/post/<code>` half is decoration — the same post is reachable as `/t/<code>`),
 *  so the code alone names one post and the prefix only says which platform. It is there
 *  because the background fans a classification out to EVERY connected relay rather than
 *  keying by tab, so an unnamespaced id could otherwise be injected into an unrelated X
 *  timeline. */
const ID_PREFIX = 'threads:';

/** `/post/<code>`, with or without the `/@user` half and with or without a trailing
 *  `/media`. A post's own permalink is the only href shape that names a post: the feed's
 *  card and the permalink page's root post carry it as the timestamp link, a comment
 *  carries its own. */
const POST_PATH_RE = /\/post\/([A-Za-z0-9_-]+)/;

/** The app's marker for anything it treats as pressable — a post, a comment, and the quote
 *  card a post embeds. There is no narrower marker: `data-interactive-id` rides on the same
 *  elements but is empty on all of them. */
const CONTAINER_SELECTOR = '[data-pressable-container="true"]';

/** The overflow menu's icon, which is what both surfaces draw and the only thing about that
 *  control they agree on: `viewBox="0 0 24 24"` drawn at width 20 on both, down to the path
 *  data. Nothing else in a post is drawn on that grid at that size — the action row is 18, 18,
 *  18 and 18.75 wide, the verified badge 12 and the unverified glyph 12 — so the size alone
 *  names it without reading its `title`, which is the reader's own language ("More", "Mehr")
 *  and would otherwise be a second, localizable identity for one control.
 *
 *  Measured on one feed, same harness, same session: 6 of 6 desktop containers carried a
 *  `[aria-haspopup="menu"][role="button"]` and 6 of 6 carried a `<time>`, against 0 of 7 phone
 *  containers carrying the menu and 7 of 7 carrying the time — every phone post was therefore
 *  dropped by `headerRow` before anything could be painted on it. */
const MENU_ICON = 'svg[viewBox="0 0 24 24"][width="20"]';

/** Threads' own overflow menu as the DESKTOP wording names it — and as its ICON proves it.
 *
 *  The icon is required here too, because the attribute alone is not unique to a post's menu:
 *  the phone's detail view also puts the reply SORT control inside the focal post, and that is
 *  a `[aria-haspopup="menu"][role="button"]` as well (its text reads "Sort"/"Top", its own
 *  subtree holds no icon). Measured on the phone's detail view of one permalink: the focal
 *  container's buttons in document order were Follow, Follow, ⋯, Like, Reply, Repost, Share,
 *  Sort, View activity — the ⋯ at index 2 with the icon, the sort control at index 7 with the
 *  attribute. This selector named the sort control, whose row holds no timestamp, so the walk
 *  in `headerRow` ran to the top of the post: measured, the header came back as the 438-char
 *  body wrapper with the post's own text as its text. A header that IS the post excludes every
 *  paragraph as header chrome, so the one post a detail view is centered on was the one post
 *  dropped — its replies, whose containers hold no sort control, painted normally.
 *
 *  Its presence is what makes a container a post/comment rather than the quote card inside
 *  one: a quote renders as a bare container with no menu and no header, which is also why it
 *  can never carry buttons. */
const MENU_ATTR_SELECTOR = `[aria-haspopup="menu"][role="button"]:has(${MENU_ICON})`;

/** The same menu named by its icon alone, which is the fallback for the phone surface, where
 *  the attribute is simply absent. */
const MENU_ICON_SELECTOR = `[role="button"]:has(${MENU_ICON})`;

/** The verified badge, identified without reading a word of it.
 *
 *  A verified account renders a 12px glyph drawn from a 24-unit grid in the header, and its
 *  `<title>` child (which the browser shows as the tooltip) is the only element inside it.
 *  Measured across a feed: the badge is `viewBox="0 0 24 24"` with a `:scope > title`; the
 *  overflow menu is the same viewBox at width 20 with its title as an ATTRIBUTE
 *  (`title="More"`), and the "·Author" chip beside a reply's name is width 12 from a
 *  `viewBox="0 0 12 13"` with no width. An unverified author still renders a 12px
 *  `viewBox="0 0 24 24"` glyph in the same place, WITHOUT a title child — so the title child,
 *  not the size, is what marks the badge. Reading only its presence (never its text) is what
 *  keeps this correct in every locale: the same element's title reads "Verified", "Verifiziert"
 *  or anything else, and the classifier is told about the badge either way. */
const VERIFIED_BADGE_SELECTOR = 'svg[viewBox="0 0 24 24"][width="12"]:has(> title)';

/** A post body's paragraph. Threads wraps each paragraph of a caption in its own
 *  `span[dir="auto"]`; `dir="auto"` is the app's own bidi handling rather than a class, and
 *  it is on the paragraph and on nothing else in the body. */
const PARAGRAPH_SELECTOR = 'span[dir="auto"]';

const THREADS_USERTYPE: Usertype = UsertypeEnum.Regular;
const THREADS_VERIFIED: Usertype = UsertypeEnum.Verified;

/** How a post's paragraphs are joined in the classified text — the same separator X and
 *  Reddit use, so the worker reads them as separate paragraphs. Nothing renders it; the
 *  regions below carry explicit offsets, which is what lets the highlighter drop it. */
const POST_JOIN = '\n\n';

/** The nearest container an element sits in, id or no id. This is what distinguishes a
 *  post's own text from the text of a post it QUOTES: a quote is a container nested inside
 *  the post embedding it, so a plain `querySelectorAll` would read the quoted author's
 *  words as the quoting author's. */
function owningContainer(node: Node | null): Element | null {
  const el = node?.nodeType === Node.ELEMENT_NODE ? (node as Element) : node?.parentElement ?? null;
  return el?.closest(CONTAINER_SELECTOR) ?? null;
}

/** The id a container's own permalink names, or null when it holds none. */
function postIdOfElement(root: Element): string | null {
  for (const anchor of Array.from(root.querySelectorAll('a[href]'))) {
    const code = (anchor.getAttribute('href') ?? '').match(POST_PATH_RE)?.[1];
    if (code) return ID_PREFIX + code;
  }
  return null;
}

/** The post's header line: the row carrying the author name, the timestamp and the overflow
 *  menu.
 *
 *  Found by walking UP from the menu to the tightest ancestor that also contains the post's
 *  timestamp, which is the shape both surfaces agree on. Measured on a feed card: the header
 *  is a 543x21 two-column grid (`513px 30px`) whose first cell holds a `display:flex` row of
 *  [name 106px][timestamp area, `flex-grow: 1`] and whose second holds the menu.
 *
 *  Nothing here reads the timestamp's own text: a relative time is `17h` in English and
 *  something else elsewhere. The element is used only for its position.
 *
 *  The FIRST menu and the FIRST `<time>` in the container are the post's own, because the
 *  header precedes the body in document order — a quoted post's timestamp sits inside the
 *  body, below.
 *
 *  The menu is read under its desktop wording first and by icon second, so a surface that
 *  ships the control without the attribute is still recognized as a post and nothing about
 *  the desktop reading changes. */
function headerRow(root: Element): Element | null {
  const menu = root.querySelector(MENU_ATTR_SELECTOR) ?? root.querySelector(MENU_ICON_SELECTOR);
  const time = root.querySelector('time');
  if (!menu || !time) return null;
  for (let el = menu.parentElement; el && el !== root; el = el.parentElement) {
    if (el.contains(time)) return el;
  }
  return null;
}

/** Whether the painter considers `el`, or any ancestor of it up to and including `root`,
 *  invisible.
 *
 *  `isPassageInvisible` is the highlighter's own predicate — the one that decides which
 *  subtrees its passage walk refuses to read — so applying it upward makes the captured
 *  text and the painted text agree about what the post says rather than inventing a second
 *  notion of visibility here.
 *
 *  It is what excludes a post page's reply COMPOSER, whose empty-state prompt is a
 *  `span[dir="auto"]` sitting inside the post's own container: measured, "Reply to
 *  <author>…" is three levels below a `div[aria-hidden="true"]`, while the post's real
 *  caption paragraphs have no such ancestor. Including it would append a sentence the
 *  post's author never wrote to the classified text — and because the prompt changes with
 *  the reply target, one post id would then name two texts, which is the cache collision
 *  the DOM-fed choice exists to avoid. */
function hiddenWithin(root: Element, el: Element): boolean {
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    if (isPassageInvisible(cur)) return true;
    if (cur === root) break;
  }
  return false;
}

/** The rows a post's text is made of, in reading order: its own body paragraphs.
 *
 *  A paragraph is a `span[dir="auto"]` of THIS container's body. Five things are excluded,
 *  each for a measured reason:
 *  - text inside a nested container, which is a QUOTE's words rather than the post's
 *    (measured: a quoting post's container holds the quote's paragraphs as `span[dir="auto"]`
 *    siblings of its own);
 *  - anything inside `role="button"`, which is where the app's own chrome lives (the
 *    `Translate` affordance, the action row's counts);
 *  - anything inside the header row, which is where the `·Author` chip and the name cluster
 *    live — both `span[dir="auto"]`, neither part of the claim;
 *  - anything ABOVE the header row, which is where the app puts its own label for a post it
 *    is presenting rather than what the author wrote: measured on a profile, the pinned
 *    post carries a `span[dir="auto"]` reading `Pinned` as a block of its own, before the
 *    author line. Position is the whole test — the label is otherwise indistinguishable from
 *    a one-word paragraph — and it holds in every locale and under any restyle, because a
 *    post's header is always its first line and anything in front of it belongs to the page;
 *  - anything the painter calls invisible, which is the reply composer's prompt (see
 *    `hiddenWithin`).
 *  An outer paragraph that is itself inside a paragraph span is skipped as well, so a
 *  caption's inline markup yields one entry per paragraph rather than one per nesting level.
 *
 *  The text of each paragraph is `paragraphText` — the highlighter's own extractor, not
 *  `textContent`, with the host's inline controls dropped. The highlighter locates the
 *  classified text inside the element's VISIBLE passage (hidden and `aria-hidden` subtrees
 *  excluded), so the two sides have to agree on what the element says or a post whose body
 *  holds a visually-hidden node would classify text the painter cannot find and silently lose
 *  every highlight. The one deliberate exception is the `[role="button"]` chrome below, and it
 *  is safe for the reason given there: it sits after the words it follows, so it cannot move
 *  one of them.
 *
 *  One more exclusion, applied to what is left, keeps the post's attachments out — see
 *  `textEnd`. */
/** The words of one paragraph, with the host's own inline chrome left out.
 *
 *  `passageTextContent` is the highlighter's extractor and the two sides normally have to read
 *  a paragraph the same way — but the host nests its own chrome INSIDE the caption's
 *  `span[dir="auto"]`, as siblings of the author's words, and `paragraphElements` cannot see it
 *  (the caption span is not itself inside a `[role="button"]`, and these are not their own
 *  paragraphs). Two shapes were measured, and they are dropped for two different reasons.
 *
 *  The `Translate` control is a `[role="button"]` and is dropped as one. It reached the
 *  classified text: measured, a caption of 13 characters was captured as 24 — itself, the
 *  `\xa0\xa0` separator the host writes before the control, and `Translate`. Two independent
 *  captures matched to the character, and the same on the displayed side (`Hello everyone 🤗❤️`
 *  + `\xa0\xa0` + `See original` = 33, exactly the payload's `text`). That label is translated
 *  per reader AND swaps for `See original` when the reader flips the post, so one post would
 *  hash differently for two readers and differently again on each side — a second identity for
 *  one text, the collision `post-id-names-one-text` refuses, and with it every stored
 *  classification and highlight key for the post.
 *
 *  The `1/2` that follows it is NOT a button and is dropped by `isPositionBurst` — see there for
 *  the measurement, and for why dropping only the label was not enough.
 *
 *  Only those two kinds of subtree are dropped; everything else is read exactly as the painter
 *  reads it, invisibility test included, so the two sides cannot disagree. Dropping them cannot
 *  move a caption's own characters: the host renders this chrome at the END of the words it
 *  follows, so every offset the worker computes still indexes the same character of the
 *  painter's passage, and the containment test `alignedRegions` runs is unaffected either way. */
const POSITION_BURST = /^\s*\d+\s*\/\s*\d+\s*$/;

/** Whether a subtree is the host's own position indicator — `1/2`, `2/5` — rather than words.
 *
 *  Measured on a post reached from a thread search: the caption's `span[dir="auto"]` ends with a
 *  `DIV` holding three one-character `SPAN`s whose text reads `1/2`, sitting after a `\xa0`
 *  separator, beside the author's own `SPAN` and the `Translate` button. It carries NO `role` —
 *  this file's earlier reading, that it was a `[role="button"]` like the label, is measurably
 *  wrong, and the label-only fix proved it: the payload came back with `Translate` gone and the
 *  burst still in the text, on both sides.
 *
 *  It has to go, and not for tidiness. This adapter classifies the CAPTION THE API SENT when it
 *  has one (`postText`), and that caption carries no position — the markup adds it. So one post
 *  met with its payload in hand and the same post met without it were classified over two
 *  different strings. Measured on one post, same id, same moment: the permalink's payload `text`
 *  was 25 characters, and the search page's DOM fallback was those same words plus the burst —
 *  two different hashes (`…99d9508…` against `…3d8bef3…`) for one post. That is a second identity
 *  for one text, the collision `post-id-names-one-text` refuses, and it re-bills a
 *  classification the reader has already paid for. Dropping the burst makes the two agree: the
 *  DOM paragraph reads 25 characters once `postParts` trims the separators away, character for
 *  character what the payload said.
 *
 *  Read from the SHAPE of the subtree's words, never from a class or a label: digits and a slash
 *  are the same in every locale, so this is not the translated-text case the rollout refuses.
 *  The residual risk is the mirror image — a caption whose own paragraph is nothing but `n/m`
 *  would be dropped from the markup while the payload kept it, re-opening the same split from the
 *  other side. No such caption was met, and a paragraph of bare numerals is far likelier to be a
 *  host counter than a claim. */
function isPositionBurst(el: Element): boolean {
  return POSITION_BURST.test(el.textContent ?? '');
}

function paragraphText(el: Element): string {
  const out: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) { out.push((node as Text).data); return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const child = node as Element;
    if (child.getAttribute('role') === 'button' || isPassageInvisible(child) || isPositionBurst(child)) return;
    for (const grandchild of Array.from(child.childNodes)) walk(grandchild);
  };
  for (const child of Array.from(el.childNodes)) walk(child);
  return out.join('');
}

function paragraphElements(root: Element): Element[] {
  const header = headerRow(root);
  const candidates: Element[] = [];
  for (const span of Array.from(root.querySelectorAll(PARAGRAPH_SELECTOR))) {
    if (owningContainer(span) !== root) continue;
    if (span.closest('[role="button"]')) continue;
    if (header?.contains(span)) continue;
    // `header.compareDocumentPosition(span)` describes SPAN's position, so PRECEDING here
    // means the span comes before the header — the page's own labels, never the post's words.
    if (header && (header.compareDocumentPosition(span) & Node.DOCUMENT_POSITION_PRECEDING)) continue;
    if (hiddenWithin(root, span)) continue;
    let nested = false;
    for (let el = span.parentElement; el && el !== root; el = el.parentElement) {
      if (el.tagName === 'SPAN' && el.getAttribute('dir') === 'auto') { nested = true; break; }
    }
    if (nested) continue;
    candidates.push(span);
  }
  // Only the post's own words. Everything else in a post's body — the link card's domain and
  // headline, the media, the `View N more` affordance — is a `span[dir="auto"]` under a plain
  // `div` too, so nothing about a span's own markup separates a headline from a sentence.
  // Its position does. See `textEnd`.
  return candidates.slice(0, textEnd(root, candidates));
}

/** Where a post's text stops, as an index into `candidates`.
 *
 *  This is the boundary X draws with `data-testid="card.wrapper"` standing outside
 *  `data-testid="tweetText"`: the words are the post, the card and the rest are the
 *  platform's additions, and only the words are classified. Threads marks no such boundary,
 *  but it renders to the same shape. Measured on this platform's posts, a body is a row of
 *  plain `div` blocks — one block per paragraph, then whatever the post attached: a media
 *  grid, a link card (itself a thumbnail block and a headline block), a `View N more`
 *  affordance — and every one of those holds its words in a `span[dir="auto"]`, a headline
 *  from a sentence. Only one thing separates them, and it is on the side of the additions:
 *  they carry media, and paragraphs do not.
 *
 *  So the post is its leading run of blocks and the first block carrying media ends it.
 *  Everything from that block onwards is dropped, which is what removes a card's domain and
 *  its headline together even though only the first of the two holds the thumbnail: the cut
 *  is by document order, so the headline falls after it.
 *
 *  An emoji is not media here — measured, a post whose text ends in one has no `img` in its
 *  block — so a post's own emoji never ends its text. And a media-only post cuts at its first
 *  block and yields nothing, which is the right answer for a post with no words: `capture`
 *  drops it rather than spending a classification on a description of a picture. */
function textEnd(root: Element, candidates: Element[]): number {
  for (let i = 0; i < candidates.length; i++) {
    const block = blockOf(root, candidates[i]);
    if (block?.querySelector('img, video')) return i;
  }
  return candidates.length;
}

/** The block a span belongs to: the lowest ancestor that is one of several children.
 *
 *  A post's body is a row of blocks and the walk stops at the row's own child, while a span
 *  that is the body's only text keeps walking outwards to that body and is unaffected. No
 *  class name, attribute or text is read, so a restyle cannot move the boundary, and neither
 *  can a locale. */
function blockOf(root: Element, span: Element): Element | null {
  for (let el: Element | null = span.parentElement; el && el !== root; el = el.parentElement) {
    const parent = el.parentElement;
    if (parent && parent !== root && parent.children.length > 1) return el;
  }
  return null;
}

/** A post's text, one trimmed paragraph per block.
 *
 *  Trimming each paragraph is what keeps the classified text from carrying the app's
 *  indentation, and it is safe for the offsets below: a region's slice is located inside its
 *  element's own passage, so a leading space the classified text does not have is simply
 *  text the region does not cover. */
function postParts(root: Element): { el: Element; text: string }[] {
  const parts: { el: Element; text: string }[] = [];
  for (const el of paragraphElements(root)) {
    const text = paragraphText(el).trim();
    if (text) parts.push({ el, text });
  }
  return parts;
}

/** Translations the app has handed over, in the squeezed form `squeeze` produces, oldest
 *  first.
 *
 *  The flipped body carries no `lang`, no `data-*` and no class that survives a build
 *  (measured), and the one other mark is the inline control's own label — `Translate` /
 *  `See original` — which is exactly the locale-dependent text the extension is not allowed
 *  to key on. So the translation itself is what a flipped post is recognised by, and this is
 *  the first of the two ways it is recognised.
 *
 *  Measured on this platform: a flip always costs a request. The first flip of a post is one
 *  `POST /api/graphql` answered by `xdt_translate_comment`, and flipping the SAME post again
 *  on a page loaded since — the case where the app could have served it from its own store
 *  without asking — was measured to issue that request again. So this list is populated
 *  wherever a translation comes from here. It is still not the only test (see
 *  `sourceOnScreen`), because "the app fetched it" is an assumption about the host's
 *  internals, and the cost of that assumption being wrong is a post whose highlights are
 *  painted at one side's offsets over the other side's words. */
const shownTranslations: string[] = [];

/** How many translations to keep, and how short one may be before it is thrown away.
 *
 *  Bounded because a translation is a whole post's worth of text and a reader can flip a long
 *  way down a feed; 32 covers everything that can be on screen at once with room to spare.
 *  The floor exists because a few characters cannot identify anything — a short body could
 *  contain them by coincidence, and reporting the wrong side is what makes the background
 *  paint one side's ranges over the other's words. */
const MAX_SHOWN_TRANSLATIONS = 32;
const MIN_TRANSLATION_LENGTH = 16;

/** How much of a translation is enough to recognise it on the page.
 *
 *  A prefix rather than the whole string because the renderer ellipsises a link inside a long
 *  translation (`meta.com/thefu…`) while the fetched copy holds it in full, so requiring all
 *  of it would miss exactly the posts with a link in their opening words. */
const TRANSLATION_PROBE = 32;

/** Text with every whitespace run removed — the form two copies of one text are compared in.
 *
 *  Whitespace is what the two sides do NOT agree on: the payload separates a translation's
 *  paragraphs with a blank line while the renderer puts each paragraph in its own block, so
 *  the page's `textContent` runs them together with nothing in between. Stripping it leaves
 *  the characters both sides genuinely share, which is what makes a prefix of one findable in
 *  the other. */
function squeeze(text: string): string {
  return text.replace(/\s+/g, '');
}

/** What the platform's own API said a post's caption is, keyed by the id it names.
 *
 *  Module scope rather than an argument because a post's two halves reach the adapter
 *  through different calls: `captureNetwork` is handed the payload, while `capture` and
 *  `textRegions` are handed an element during a sweep or an injection and know only the id.
 *  Keeping it here is what makes the classified text and the regions that carry its offsets
 *  come from ONE string — the caption — even though only the second of them can see the
 *  page. */
const networkCaptions = new Map<string, string[]>();

/** The parent and the quoted post the payload named for a post, keyed the same way and for
 *  the same reason as `networkCaptions`: the two halves of a capture reach this adapter
 *  through different calls, and only the payload half can see a thread's structure. A post
 *  captured from the markup after the payload described it — a permalink whose hydration
 *  blob landed a moment late — is filed with its ancestors rather than without them. */
const networkParents = new Map<string, string>();
const networkQuotes = new Map<string, QuotedTweet>();

/** A caption's paragraphs.
 *
 *  A blank line separates them (`caption.text` uses "\n\n", the same join `postText` uses),
 *  and the renderer puts each one in its own body block, so this list and the page's blocks
 *  describe one post in the same order. */
function captionBlocks(text: string): string[] {
  return text.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
}

/** Text of a post as one string: the caption when the API has described this post, the
 *  markup otherwise. This is what `capture` classifies, and it is the fallback `postRegions`
 *  aligns against when its caller has no classified text in hand. */
function postText(root: Element): string {
  const id = postIdOfElement(root);
  const caption = id ? networkCaptions.get(id) : undefined;
  if (caption) return caption.join(POST_JOIN);
  return postParts(root).map(p => p.text).join(POST_JOIN);
}

/** The body the page is SHOWING, as one string — the opposite reading of `postText`, which
 *  prefers the caption as authored whatever the page is doing.
 *
 *  The two differ exactly when the reader has flipped the post into a translation, and this
 *  is the side the background has to measure a flip's ranges against. It is built from
 *  `postParts` — the highlighter's own extractor over the paragraphs the painter reads — so
 *  the offsets the worker computes are into the same characters that are on screen. */
function displayedBody(root: Element): string {
  return postParts(root).map(p => p.text).join(POST_JOIN);
}

/** How much of the post's own words is enough to recognise them on the page.
 *
 *  Shorter than `TRANSLATION_PROBE` because this probe is drawn from a post's opening WORDS
 *  rather than from a whole fetched body, and a short post's opening word can be its whole
 *  text ("Путин"). Four characters is where a run stops being something a translation into
 *  another language reproduces by coincidence, which is the only way this test can be wrong. */
const MIN_SOURCE_PROBE = 4;

/** The opening words of a post as authored, as a probe for "is the source what is on screen".
 *
 *  The first word long enough to be evidence, and — skipping any word carrying a dot — the
 *  words after it. The dot matters: the renderer ellipsises a link inside a paragraph
 *  (`meta.com/thefu…` where the payload has `meta.com/thefutureisforeveryone`), so a probe
 *  taken from a link would be absent from the page on a post showing its own words, which
 *  reads as a translation — the one direction this test must never be wrong in.
 *
 *  Null when the opening block offers nothing usable, which the caller treats as no opinion
 *  rather than as evidence. */
function sourceProbe(block: string | undefined): string | null {
  if (!block) return null;
  for (const word of block.split(/\s+/)) {
    const clean = squeeze(word);
    if (clean.length < MIN_SOURCE_PROBE || clean.includes('.')) continue;
    return clean.slice(0, TRANSLATION_PROBE);
  }
  return null;
}

/** Whether the post's own opening words are on the page.
 *
 *  The second way a flipped post is recognised, and the one that does not depend on having
 *  watched the app fetch the translation. When the page shows the post's own words, the first
 *  thing the author wrote is on screen whatever the renderer did to the rest of it — clipping
 *  cuts a caption's TAIL and a crop keeps its head — so their absence is the page showing
 *  something else.
 *
 *  Answers "yes" rather than "no" whenever it has nothing to judge by, which is what keeps a
 *  post this adapter holds no caption for from being called a translation. */
function sourceOnScreen(root: Element, shown: string): boolean {
  const id = postIdOfElement(root);
  const caption = id ? networkCaptions.get(id) : undefined;
  const probe = sourceProbe(caption?.[0]);
  return probe === null || shown.includes(probe);
}

/** Whether the post is on screen in a translation of it rather than in its own words.
 *
 *  Two tests, either of which is enough, and both built on the fact that nothing on the page
 *  says which side is showing (see `shownTranslations`): the translation the app handed over
 *  is in the body, or the post's own opening words are not.
 *
 *  `textContent` rather than `postParts` because this is asked on every sweep for every post
 *  in reach and so has to be one property read. Its one blind spot is text the painter would
 *  skip — a visually-hidden node's words — which cannot make a post look translated unless it
 *  already contains a fetched translation verbatim. */
function isTranslated(root: Element): boolean {
  const shown = squeeze(root.textContent ?? '');
  if (!shown) return false;
  if (shownTranslations.some((translation) => shown.includes(translation.slice(0, TRANSLATION_PROBE)))) return true;
  return !sourceOnScreen(root, shown);
}

/** A post's text as the blocks it is made of, each with the offset it starts at.
 *
 *  Blocks are separated by a blank line — the join `postText` writes, and the one a caption
 *  uses — so this is that join read backwards. An offset is where a block's first character
 *  actually sits in the text rather than a running sum of the lengths before it, which keeps
 *  them right whatever spacing the text arrived with. */
function textBlocks(text: string): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = [];
  // A block is a run with no blank line in it: any non-newline, then any mix of non-newlines
  // and single newlines. A lone newline is a soft break inside a paragraph, two are the
  // separator.
  for (const match of text.matchAll(/[^\n]+(?:\n(?!\n)[^\n]*)*/g)) {
    const raw = match[0];
    if (!raw.trim()) continue;
    out.push({
      text: raw.trim(),
      start: (match.index ?? 0) + (raw.length - raw.trimStart().length),
    });
  }
  return out;
}

/** Where each block of a post's text is on the page.
 *
 *  `text` is the string this post was classified on — the one its claims' offsets are into —
 *  and the page is only asked WHERE that text appears. The two are not always equal (a
 *  payload's caption against the renderer's crop of it, and on a post the DOM reached first,
 *  a crop the payload was never allowed to overwrite), so a block is matched to the body
 *  block that CONTAINS it, in order, and takes that block's range in the classified text.
 *
 *  Containing is enough rather than equality because that is what the painter needs — it
 *  locates a region's slice inside the block's passage and leaves whatever surrounds it
 *  alone — and it is what measured reality looks like: a rendered block is its caption
 *  paragraph exactly, or its paragraph with the thread's position appended (`… 2/5`), and
 *  both paint at the paragraph's own offsets.
 *
 *  A block no element contains yields no region, which is the honest outcome for the ways the
 *  page can fail to hold one: the tail of a clipped caption is not rendered at all, and a
 *  paragraph whose inline link was ellipsised is no longer its paragraph. Either way the
 *  block is still part of the classified text — the worker reads the post as authored — and
 *  goes unpainted rather than being painted at an offset that does not exist on the page. */
function alignedRegions(root: Element, text: string): TextRegion[] {
  const blocks = paragraphElements(root);
  const passages = blocks.map((block) => paragraphText(block).trim());
  const regions: TextRegion[] = [];
  let cursor = 0;
  for (const block of textBlocks(text)) {
    for (let i = cursor; i < blocks.length; i++) {
      if (!passages[i].includes(block.text)) continue;
      regions.push({ el: blocks[i], start: block.start, end: block.start + block.text.length });
      cursor = i + 1;
      break;
    }
  }
  return regions;
}

/** `postText` as ranges into it — into whichever string the caller classified, when it has
 *  one, and into this adapter's own reading of the post otherwise.
 *
 *  Falling back to `postText` (rather than to the markup) keeps the fallback on the same
 *  caption-first rule the capture uses, so an id whose text this adapter knows still gets
 *  its regions computed from that text. When nothing has been captured yet both halves
 *  derive the same string, and the alignment lands each block on the own block it came
 *  from — byte for byte the ranges the old accumulation produced. */
function postRegions(root: Element, classifiedText?: string): TextRegion[] {
  return alignedRegions(root, classifiedText ?? postText(root));
}

/** Every container on the page that is a post or a comment — outermost only, rendered only.
 *
 *  Outermost-only is what drops a quote card: it is a container nested in the post quoting
 *  it, and it can never be addressed on its own (no menu, so no header, so nowhere for our
 *  buttons to go), so capturing it would spend a classification on a post whose result has
 *  nowhere to land. Its text is excluded from the outer post's capture too (see
 *  `paragraphElements`), so the quote is simply not part of any claim — the same treatment
 *  Bluesky's DOM half gives it.
 *
 *  Rendered-ness is filtered here, at the single point every consumer goes through, so that
 *  capture, injection and centering cannot disagree about which posts exist. Threads
 *  virtualizes (`data-virtualized` markers appear around the feed), and a container that is
 *  in the DOM but collapsed measures zero width. A post missed because it was mid-render
 *  during a sweep is picked up by the next one: rendering a post IS a mutation, and the
 *  relay re-sweeps on every host mutation. */
function allPostRoots(): Element[] {
  const out: Element[] = [];
  for (const el of Array.from(document.querySelectorAll(CONTAINER_SELECTOR))) {
    if (!headerRow(el)) continue;
    if (el.parentElement?.closest(CONTAINER_SELECTOR)) continue;
    if (el.getBoundingClientRect().width <= 0) continue;
    out.push(el);
  }
  return out;
}

/** The OUTERMOST post container an element sits in, or null when nothing post-shaped
 *  encloses it.
 *
 *  Walking to the outermost rather than stopping at the first keeps this in agreement with
 *  `allPostRoots()` on which element stands for a post, so a caller asking `postIdOf` of the
 *  result gets the same answer either way. A selection inside a quote therefore reads as a
 *  selection inside the post that quotes it, which is what the selection rule wants: the
 *  quote is not a post the extension can be used on. */
function nearestPost(node: Node | null): Element | null {
  const el = node?.nodeType === Node.ELEMENT_NODE ? (node as Element) : node?.parentElement ?? null;
  if (!el) return null;
  let found: Element | null = null;
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    if (headerRow(cur)) found = cur;
  }
  return found;
}

function postRoots(id: string): Element[] {
  return allPostRoots().filter((root) => postIdOfElement(root) === id);
}

/** The account a post belongs to: the `/@user` half of its own permalink.
 *
 *  Read from the permalink rather than from the name anchor because it is the same element
 *  the id came from, so the two can never disagree about which account a post belongs to.
 *  The name anchor's text is the display name on some renders and the handle on others, and
 *  `computeTweetHash` mixes the username in — a display name would give one post two hashes
 *  depending on which surface captured it, which reads as a cache miss and re-bills. */
function usernameOf(root: Element): string {
  for (const anchor of Array.from(root.querySelectorAll('a[href]'))) {
    const href = anchor.getAttribute('href') ?? '';
    const match = href.match(/^\/@([^/]+)\/post\/([A-Za-z0-9_-]+)/);
    if (match) return match[1];
  }
  return '';
}

function isVerified(root: Element): boolean {
  return !!headerRow(root)?.querySelector(VERIFIED_BADGE_SELECTOR);
}

/** One post record, as the MAIN-world interceptor forwards it. */
interface NetPost {
  code: string;
  text: string;
  username: string;
  verified: boolean;
  /** Shortcode of the post this one answers, when the payload stated it. */
  parent: string | null;
  /** The post this one embeds, when it embeds one. */
  quoted: NetQuoted | null;
}

/** An embedded post, as the interceptor forwards it. */
interface NetQuoted {
  code: string;
  text: string;
  username: string;
  verified: boolean;
}

const CODE_RE = /^[A-Za-z0-9_-]{5,}$/;

function asNetQuoted(value: unknown): NetQuoted | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const code = record.code;
  if (typeof code !== 'string' || !CODE_RE.test(code)) return null;
  const text = typeof record.text === 'string' ? record.text : '';
  if (!captionBlocks(text).length) return null;
  const username = typeof record.username === 'string' ? record.username : '';
  if (!username) return null;
  return { code, text, username, verified: record.verified === true };
}

/** A record arrives as page-authored data, so every field read is validated here rather
 *  than trusted: the interceptor's own shape test is a convenience for what it forwards,
 *  and this is the boundary that decides what the extension will act on. */
function asNetPost(value: unknown): NetPost | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const code = record.code;
  if (typeof code !== 'string' || !CODE_RE.test(code)) return null;
  const text = typeof record.text === 'string' ? record.text : '';
  if (!captionBlocks(text).length) return null;
  const username = typeof record.username === 'string' ? record.username : '';
  if (!username) return null;
  const parent = typeof record.parent === 'string' && CODE_RE.test(record.parent) ? record.parent : null;
  return {
    code,
    text,
    username,
    verified: record.verified === true,
    parent,
    quoted: asNetQuoted(record.quoted),
  };
}

/** The post a record embeds, in the shape the hash and the classifier read.
 *
 *  A `QuotedTweet` is a plain `Tweet` — one level, no references of its own — so the quoted
 *  post's own text is all there is to fill; `conversationId` is its own id for the same
 *  reason the captured post's is (see `capture`), nothing on the page says otherwise. */
function quotedTweet(quoted: NetQuoted): QuotedTweet {
  const id = ID_PREFIX + quoted.code;
  return {
    id,
    text: quoted.text,
    fullText: quoted.text,
    username: quoted.username,
    usertype: quoted.verified ? THREADS_VERIFIED : THREADS_USERTYPE,
    conversationId: id,
  };
}

const MAX_NETWORK_RECORDS = 200;

/** One translation, as the MAIN-world interceptor forwards it: the app's own rendering of a
 *  post's words, and the numeric id it belongs to. */
interface NetTranslation {
  id: string;
  translation: string;
}

/** Validated at this boundary for the same reason posts are: it is page-authored data. The
 *  numeric id is checked but not used — see `absorbTranslations` — so a record whose id is
 *  shaped unexpectedly is dropped rather than half-read. */
function asNetTranslation(value: unknown): NetTranslation | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || !record.id) return null;
  if (typeof record.translation !== 'string' || !record.translation.trim()) return null;
  return { id: record.id, translation: record.translation };
}

export const threadsAdapter: PlatformAdapter = {
  id: 'threads',
  hosts: PLATFORM_HOSTS.threads ?? [],

  postIdFromUrl(url) {
    const code = url.pathname.match(/^\/@[^/]+\/post\/([A-Za-z0-9_-]+)/)?.[1]
      ?? url.pathname.match(/^\/t\/([A-Za-z0-9_-]+)/)?.[1];
    return code ? ID_PREFIX + code : null;
  },

  postRoots,

  postIdOf(root) {
    return headerRow(root) ? postIdOfElement(root) : null;
  },

  textElement(root, ref) {
    // The block the post's first block landed in: the single-element path is handed this and
    // searches it for the classified text, so pointing it at the page's first body block
    // would be wrong for a post whose first block is one the classified text does not contain.
    const regions = postRegions(root, ref.text);
    if (regions.length > 0) return regions[0].el;
    return postParts(root)[0]?.el ?? null;
  },

  // No `isLongForm`, deliberately: Threads caps a post at the universal `LONG_FORM_CHARS`
  // rather than past it, so the hook could only ever answer false on the reader's own posts.

  // A Threads caption is markup: @mentions and #hashtags are links, emoji are their own
  // elements, and a long caption is split across paragraph spans. Rebuilding it from the
  // classified text — which is what a tweet body tolerates — would flatten all of that, so
  // highlights go over the page's own text nodes instead.
  highlightInPlace: true,

  textRegions(root, ref) {
    // One block takes the ordinary single-element path; only a text of two or more blocks
    // needs its segments cut.
    const regions = postRegions(root, ref.text);
    return regions.length > 1 ? regions : null;
  },

  placeButtons(container, root) {
    // The post's top line, at its right-hand end: `lauragoesthere · 17h   [Disinfact]  [⋯]`.
    //
    // A Threads reply is rendered as a post of its own — same root, same header — so this is the
    // post rule on both, the one the ask stated while looking at Bluesky's identical header:
    // "inline on that header bar, at its right-hand end". It is NOT the comment rule that
    // Facebook, Reddit, Dcard, LinkedIn and Hacker News take, because there is no comment
    // element here to hang a separate seat off.
    //
    // The header is a two-column GRID (`513px 30px`, `grid-auto-flow: row`), and that is why
    // the container does not go into the header itself: measured with a 120px dummy, a third
    // child of the grid does not start a third column — it wraps to a second ROW, taking the
    // header from 21px to 42px and pushing Threads' own menu onto the line below. The grid's
    // first cell is instead a plain `display: flex` row of [name][timestamp area], so the
    // container goes there, as its last child: measured, the row stays one line at 21px, the
    // timestamp area gives up the width (401px → 275px for a 120px pill) because it is the
    // only child with `flex-grow`/`flex-shrink`, the name keeps its full width, and the pill
    // lands flush against the cell's right edge — immediately left of the gap and the menu,
    // which is the same position the pill takes on Bluesky, beside the host's own trailing
    // control rather than displacing it.
    //
    // Placement is the first moment the container exists and it can be clicked before the
    // bar's first sync, so seal it here as well; the call is idempotent and is the same
    // shared seal the sync applies.
    sealHostEvents(container);

    const header = headerRow(root);
    const time = root.querySelector('time');
    const host = header && time
      ? Array.from(header.children).find((child) => child.contains(time))
      : null;
    if (host && host !== header) {
      // The row is a flex box, so the container is sized by its own content and pushed to the
      // right; `align-self` keeps it off the row's stretch (the avatar column beside this row
      // is taller than the header line).
      container.style.marginLeft = 'auto';
      container.style.alignSelf = 'center';
      container.style.flexShrink = '0';
      if (container.parentElement !== host) host.appendChild(container);
      return;
    }
    // No header line on this render: leave the container detached rather than inserting it
    // anywhere plausible. A post carrying our buttons is a post the selection rule hands the
    // user's selection off to (a selection lying entirely inside a post is not a web
    // selection), so a misplaced pill would also cost the user the web-select path on this
    // post. Detached, the post keeps working: it simply has no buttons. See `placeButtons`
    // in types.ts.
    container.style.marginLeft = '';
    container.style.alignSelf = '';
  },

  feedCenter() {
    // Derived from the posts themselves rather than from a page container: the content
    // column is exactly the horizontal span the posts occupy, so its center is the feed's
    // center whatever the window width and whether or not the navigation rail is present. A
    // page container would be wrong on the wide window where the shell fills the viewport
    // while the posts do not. Returns null (the caller's viewport fallback) when nothing is
    // rendered yet.
    let left = Infinity;
    let right = -Infinity;
    for (const root of allPostRoots()) {
      const rect = root.getBoundingClientRect();
      if (rect.width <= 0) continue;
      left = Math.min(left, rect.left);
      right = Math.max(right, rect.right);
    }
    return right > left ? (left + right) / 2 : null;
  },

  isPostTarget(id) {
    return postRoots(id).length > 0;
  },

  postElementFor(node) {
    return nearestPost(node);
  },

  captureRoots() {
    return allPostRoots();
  },

  capture(root: Element): CapturedPost | null {
    const id = postIdOfElement(root);
    if (!id) return null;

    const caption = networkCaptions.get(id);
    const shown = displayedBody(root);
    const translated = isTranslated(root);

    // A translated body is not the post's text, and the caption is the only copy of the
    // post's own words this adapter will ever have. Without one there is nothing to file the
    // post under: capturing the translation would give the post the translation's hash as
    // its identity — a second, unrelated post as far as the cache and the DB are concerned —
    // and the caption arriving a moment later would then silently re-point one id at two
    // texts. So the post is left uncaptured until the payload describes it, which is the
    // ordinary case: the caption is fetched before the markup that renders it, and the very
    // fact that a translation was offered means the app had the post in hand.
    if (translated && !caption) return null;

    const text = caption ? caption.join(POST_JOIN) : shown;
    // A post with no text at all — media-only, or a container whose body holds only a link
    // card — carries nothing to fact-check. Returning null keeps it out of the batch rather
    // than spending a classification on an empty string.
    if (!text) return null;

    // Which side is on screen, named only when the app's language is known: a translation
    // whose language cannot be named has no key to file its highlight ranges under, and the
    // background requires BOTH fields before it treats the post as translated at all. Such a
    // post is classified as its own source, which is exactly what this platform did before
    // any of this existed.
    const destination = translated ? appLanguage() : null;

    const post = {
      id,
      text,
      // The caption when the API has described this post, the markup otherwise — one string
      // either way, so `text` and `fullText` are the same here. X separates them because its
      // JSON carries both a note_tweet expansion and the legacy body; a caption is one body.
      fullText: text,
      // The other side, carried beside the source the same way Telegram carries it. The hash
      // — and with it the cache entry and every stored highlight key — is computed from
      // `fullText`, so the source is what identifies the post whatever the reader is reading;
      // this is what tells the background which of the two is on screen. Without it a post
      // captured while already translated would be classified, and billed, a second time when
      // the reader flipped it back.
      translatedText: destination ? shown : undefined,
      destinationLanguage: destination ?? undefined,
      username: usernameOf(root),
      usertype: isVerified(root) ? THREADS_VERIFIED : THREADS_USERTYPE,
      // `conversationId` is not read anywhere in the extension or the workers, so the honest
      // value is this post's own id: nothing on the page says which thread a post belongs to.
      conversationId: id,
      // The payload's quoted post, when the payload described this one. The markup could
      // never supply it: a quote renders as a nested container with no header, which is why
      // it is excluded from this post's own text (see `paragraphElements`) and why it can
      // never be a post of its own.
      quoting: networkQuotes.get(id) ?? null,
      // Resolved by `hydrateReplyChains` from the id below, and only when the parent is in
      // the same batch — which is the ordinary case on a thread, where the whole chain is
      // captured together.
      replyingTo: null,
    } as MainTweet;

    // No language either: the markup carries none, and the payload's own statement of it
    // (`detected_language`) is null on every post observed. Left absent so the shared
    // `nameCapturedLanguage` fills in the stable unknown key rather than a guess from the
    // reader's UI locale.
    return { post, replyParentId: networkParents.get(id) ?? null };
  },

  /** Which language the app is translating into, when the post on screen is a translation.
   *
   *  Null in the two cases where this platform has nothing to report: the post is showing its
   *  own words, or the document names no language. The second is the same rule the captured
   *  side follows — a translation that cannot be named has no key to file its ranges under —
   *  and it is why `appLanguage` returning null is not treated as a language named nothing.
   *
   *  Deliberately no `revealSource`: Telegram needs one because it renders one side at a time
   *  and the other side is nowhere on the page, so its source has to be read back off the
   *  host's own toggle. Here the source is already in hand — the caption came from the payload
   *  that `capture` files — so there is nothing to recover and no reason to touch the page. */
  displayedTranslationLocale(root) {
    return isTranslated(root) ? appLanguage() : null;
  },

  /** The text on screen, which is what a flip's highlight ranges have to be measured against.
   *
   *  Asked only when a flip is being reported, never on a sweep, so the real read here is
   *  affordable — and it is the same string `capture` files as `translatedText`, so the ranges
   *  the background stores for the translated side are keyed by the text the painter will be
   *  handed back. */
  displayedText(root) {
    return isTranslated(root) ? displayedBody(root) || null : null;
  },

  /** The preferred half: the posts Meta's own GraphQL responses described.
   *
   *  The caption from here is what gets classified — see this file's header for what the
   *  rendered one is missing — and it is remembered under the post's id, because the
   *  highlighter is handed an element and an id rather than a payload and has to paint the
   *  same string that was classified.
   *
   *  Nothing the payload does not say is invented. A post's language stays unknown
   *  (`detected_language` is null on every post observed), so it is left for the shared
   *  fallback rather than guessed. Its thread is not guessed either — it is read from the
   *  payload and carried as an id for `hydrateReplyChains` to resolve, so a post whose
   *  parent is not in the same batch is left with no ancestor rather than a fabricated one. */
  captureNetwork(records: unknown[]): CapturedPost[] {
    const captured: CapturedPost[] = [];
    const seen = new Set<string>();
    for (const value of records.slice(0, MAX_NETWORK_RECORDS)) {
      const record = asNetPost(value);
      if (!record) continue;
      const id = ID_PREFIX + record.code;
      if (seen.has(id)) continue;
      seen.add(id);

      const caption = captionBlocks(record.text);
      if (!caption.length) continue;
      // Remembered before the post is built: the text below and the regions the highlighter
      // asks for later have to be this one string.
      networkCaptions.set(id, caption);

      // The thread, remembered the same way and for the same reason — `capture` may be
      // asked for this post's element before or after this call, and both answers have to
      // agree about its ancestors.
      const parentId = record.parent ? ID_PREFIX + record.parent : null;
      if (parentId) networkParents.set(id, parentId);
      if (record.quoted) networkQuotes.set(id, quotedTweet(record.quoted));

      const root = postRoots(id)[0] ?? null;
      const text = caption.join(POST_JOIN);
      const post = {
        id,
        text,
        fullText: text,
        // The payload's account is the same on every surface; the markup's is the fallback,
        // and the two agree whenever both are present — each is the `/@user` half of the
        // permalink, which `computeTweetHash` mixes into the post's hash.
        username: record.username || (root ? usernameOf(root) : ''),
        // Verified if either source says so: both are the platform's own statement, and the
        // page is what decides whether the badge is on screen for this reader.
        usertype: record.verified || (root ? isVerified(root) : false) ? THREADS_VERIFIED : THREADS_USERTYPE,
        conversationId: id,
        quoting: record.quoted ? quotedTweet(record.quoted) : null,
        replyingTo: null,
      } as MainTweet;

      captured.push({ post, replyParentId: parentId });
    }
    return captured;
  },

  /** Take in the translations the app's own GraphQL hands over.
   *
   *  Threads fetches a translation on demand — a first flip of a post is one POST to
   *  `/api/graphql` answered by `xdt_translate_comment` — and the response is the displayed
   *  side of a post the adapter already knows the source of. It is forwarded here rather than
   *  folded into `captureNetwork` because it is not a post: it carries no caption, no author
   *  and no code, and treating it as one would file a translation as a post's own words.
   *
   *  Keyed by TEXT and not by the id it arrives with. That id is the post's numeric id, while
   *  everything this adapter addresses is keyed by the permalink's shortcode, and no payload
   *  observed carries both — so there is no mapping to make. There does not need to be one: a
   *  translation belongs to one post, so a body containing it names that post. */
  absorbTranslations(records: unknown[]): void {
    for (const value of records.slice(0, MAX_NETWORK_RECORDS)) {
      const record = asNetTranslation(value);
      if (!record) continue;
      const text = squeeze(record.translation);
      if (text.length < MIN_TRANSLATION_LENGTH) continue;
      if (shownTranslations.includes(text)) continue;
      shownTranslations.push(text);
    }
    while (shownTranslations.length > MAX_SHOWN_TRANSLATIONS) shownTranslations.shift();
  },
};
