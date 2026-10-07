/** The Dcard adapter.
 *
 *  Three surfaces are integrated: a **post page** (`/f/<forum>/p/<id>`), a **comment** under
 *  one — including on the comment's own permalink, `/f/<forum>/p/<id>/b/<floor>` — and a
 *  **feed card** in `/f`, which shows the post's title and Dcard's own excerpt of its body.
 *
 *  ## A feed card is its own post, not a smaller view of the one it previews
 *
 *  A card is not the post page in a shorter box: it renders the post's title and an excerpt
 *  Dcard cut for it. Measured on one card whose post runs 846 characters: an 11-character
 *  title beside a 100-character excerpt, matching that post's own text for its first 54
 *  characters and diverging after — a different string, so a different post as far as an id is
 *  concerned. The background caches classifications by id and files them by a hash of the text,
 *  so one id over two texts serves one surface's claims to the other; a card therefore carries
 *  `card:<post>` where the post page carries `p:<post>`. What the two DO share is the
 *  conversation: a card's `conversationId` is the post's own, so a post and its card are one
 *  thread.
 *
 *  ## The clamp
 *
 *  Dcard draws a card's excerpt in a one-line box (`-webkit-line-clamp: 1` with
 *  `overflow: hidden`; measured 20px of box around 60px of text) and renders a post page's own
 *  body and every comment in full (measured `scrollHeight === clientHeight` on both). The
 *  clamp is CSS over text the card is already holding — the clamped `<p>` measured 100
 *  characters, which is exactly what the pagination payload's own `excerpt` field holds for
 *  the same post, while its box shows the first third of them. So there is nothing to read
 *  around it and nothing to drive: the card's whole text is in the DOM, and the card is
 *  captured with all of it. A reader who follows a claim into a clipped excerpt is given the
 *  rest of it by `unclip`, which clears the clamp — presentation only, never the string the
 *  hash is taken over, so the id is the same before and after.
 *
 *  That 100 characters is also the host's cut: the same post's own API record pairs `excerpt:
 *  100` with `content: 573`, so a card at the limit is holding a clipped post rather than a
 *  short one, and a post is never identified by text we know is partial. Such a card is a
 *  long-form post here (`isLongForm`) — which, since the long-post change, means only that a
 *  passage selected inside it stays a passage instead of firing the post whole. It is captured
 *  and announced like every other root and carries the same buttons; a card whose whole body
 *  fits the excerpt is simply not long-form. The buttons on a card are also the only way to
 *  un-clip it: `unclip` runs off a click.
 *
 *  ## Why the DOM, on a platform with a JSON API
 *
 *  Posts never arrive over XHR here. The feed and a post page are server-rendered, and the only
 *  content requests the page makes are the comment list
 *  (`/service/api/v3/posts/<id>/comments`) and feed pagination (`globalPaging/page`), whose
 *  widgets do carry post records. Neither is preferred:
 *
 *  - the pagination record for a card carries the same `title` and the same `excerpt` the card
 *    renders — measured, 11 and 100 characters on both sides of one post — and no field holding
 *    the post itself. There is nothing longer in it to prefer, and reading it would only add a
 *    join back to the element our buttons attach to and the highlighter paints;
 *  - a comment payload would need the same join, and the rule that one id names one text is
 *    only guaranteed by reading the render that is actually on screen.
 *
 *  So the DOM is the source rather than the fallback, and `captureNetwork` is absent because
 *  there is nothing to feed it.
 *
 *  ## Anchors
 *
 *  Dcard's own semantic names only: the `data-doorplate` attribute carrying a comment's floor
 *  (`1`, `4`, and `4-1` for a reply to B4) and the `comment-<uuid>` id on a comment row, plus
 *  the URL shapes `/f/<forum>/p/<id>` and `/b/<floor>`. Dcard ships no `data-testid` on any
 *  post surface (measured), so the rest is the page's structure. Nothing here is a build-hashed
 *  class, a CSS-module name, or a translated label.
 *
 *  ## Two structural facts that shape everything below
 *
 *  **Comments are flat, and live outside the article.** A reply is a sibling of the comment it
 *  answers, not a child — measured: depth 1 sits at the same left edge as depth 0, and a reply
 *  is marked only by its doorplate (`4-1` answers `4`), so its parent is read from that label
 *  rather than from ancestry. The comment list also sits in a section beside the `<article>`
 *  rather than inside it (measured: an article holds no `/b/` link at all), which is why
 *  `postElementFor` can treat "inside a comment" and "inside the post" as disjoint cases.
 *
 *  **A root is a plate with two halves, one level down; the content column is the half that
 *  holds the timestamp.** A comment is `div#comment-<uuid>` holding a floor plate whose two
 *  children are the avatar rail and the content column, and the column's children are the
 *  identity row (the author and the vote/menu cluster), the comment's own words, and the
 *  floor/actions row. A post page's `<article>` holds a header block (views, headline, byline),
 *  the body wrapper, and an empty spacer. A feed card's `<article>` [728×302] wraps one row
 *  [728×302] of [avatar rail, content column] — the rail is 32×32 and holds a letter or an
 *  image, and the column [640×290] holds the header grid (with the timestamp), the title, the
 *  excerpt, the media and the action row. Everything is read by walking children and testing
 *  what they hold — a timestamp or a control — never by index, and never by class: the only
 *  thing that separates the rail from the column is that the column holds the timestamp.
 */
import type { MainTweet, Usertype } from '../../data/Tweets';
import { Usertype as UsertypeEnum } from '../../data/Tweets';
import { passageTextContent } from '../injecting';
import { PLATFORM_HOSTS } from './hosts';
import { LONG_FORM_CHARS } from './types';
import type { CapturedPost, PlatformAdapter, TextRegion } from './types';

/** Ids are namespaced for the reason every non-X platform namespaces them: the background fans
 *  a classification out to EVERY connected relay rather than keying by tab, so a bare id could
 *  be injected into an unrelated page. */
const ID_PREFIX = 'dcard:';

function namespaced(id: string): string {
  return ID_PREFIX + id;
}

/* ── Dcard's own names ─────────────────────────────────────────────────────────── */

/** A comment row: the id Dcard puts on it, `comment-<uuid>`, which is a comment's only stable
 *  hook. */
const COMMENT_ROOT = 'div[id^="comment-"]';
/** Dcard's own floor plate: `data-doorplate="1"`, `"4"`, and `"4-1"` for a reply to B4. */
const DOORPLATE = '[data-doorplate]';
/** A post permalink, `/f/<forum>/p/<id>`, with a comment's `/b/<floor>` on the end. */
const POST_PATH = /^\/f\/[^/]+\/p\/(\d+)(?:\/b\/([^/?#]+))?\/?$/;
/** Any link to a post, wherever it appears in a root. */
const POST_LINK = 'a[href*="/p/"]';
/** A comment's own permalink. */
const COMMENT_LINK = 'a[href*="/b/"]';
/** The last resort for reading a root, when its text is spread wider than any single block. */
const POST_ELEMENT = 'article';
/** How two blocks of one root's text are joined into the classified string. Only the separator
 *  matters to the model; the highlight layer drops it, since the character between two regions
 *  belongs to no region. */
const BLOCK_JOIN = '\n\n';
/** How many wrapper levels `blocksIn` will unwrap before deciding a container is the block. */
const BLOCK_DEPTH = 4;
/** The largest box Dcard draws an author's initial in as a badge — measured 20×20 on a post
 *  page's byline. The square-ness test is what keeps a short name from being read as one. */
const AVATAR_MAX = 24;
/** Breathing room between our buttons and a control cluster at the row's right-hand end. */
const CORNER_SLACK = 4;

/* ── URLs ──────────────────────────────────────────────────────────────────────── */

/** The post and floor a permalink path names, or null when the path is not a post. */
function postPath(pathname: string): { post: string; floor: string | null } | null {
  const match = POST_PATH.exec(pathname);
  return match ? { post: match[1], floor: match[2] ?? null } : null;
}

/** The same read off a link's `href`, which may be relative. */
function postPathOf(href: string): { post: string; floor: string | null } | null {
  return postPath(new URL(href, location.origin).pathname);
}

/** The post the page itself is about, or null on a page that is not one post (the feed, a
 *  forum, a profile). */
function pagePostId(): string | null {
  return postPath(location.pathname)?.post ?? null;
}

/* ── Reading a root's own text ─────────────────────────────────────────────────── */

/** The visible passage of an element, the same string the in-place highlighter indexes. */
function textOf(el: Element): string {
  return passageTextContent(el as HTMLElement).trim();
}

/** The blocks of `container`: its text-bearing children, descending through a lone wrapper
 *  that holds all of the container's text.
 *
 *  Two of Dcard's own rows are excluded by what they hold rather than by name — a row carrying
 *  a timestamp (the byline, the floor/actions row) and a row carrying a control (a header's
 *  follow button, the vote/menu cluster, a card's action row) are chrome, not the post's words.
 *
 *  The fallback matters: when the container carries text of its own beside its children — a
 *  comment that mentions someone, so that its words are a text node and an `<a>` rather than a
 *  block — the container itself is the block, and the mention is not mistaken for the whole
 *  comment. It applies only where nothing was skipped: a container whose children were
 *  deliberately skipped (a comment's column, holding its identity and action rows) is
 *  structure, and its leftover text must not be classified as the comment's. */
function blocksIn(container: Element, depth = 0): Element[] {
  const total = textOf(container).length;
  const out: Element[] = [];
  let accounted = 0;
  let skipped = false;
  for (const child of Array.from(container.children)) {
    const len = textOf(child).length;
    accounted += len;
    // A row Dcard owns: one carrying a timestamp (a post page's byline, a card's header grid, a
    // comment's floor row) or a control cluster (a comment's vote/menu cluster, a card's action
    // row). A timestamp is decisive on its own, whatever the row weighs: a comment's floor row is
    // timestamp + Reply/Quote/Share + its permalink, and over a short or deleted body it is most
    // of what the column says — reading it as the comment classifies "Reply Quote Share". The
    // minority test is for a control cluster only, because a post's own body holds controls too
    // (Dcard wraps every image in a `role="button"`), and a body carrying most of the words is
    // the content rather than chrome.
    const timed = !!child.querySelector('time');
    const chrome = timed || (!!child.querySelector('button, [role="button"]') && len * 2 <= total);
    if (chrome) {
      skipped = true;
      continue;
    }
    if (len) out.push(child);
  }
  if (!skipped && accounted < total) return [container];
  if (out.length === 1 && depth < BLOCK_DEPTH && out[0].children.length > 0) {
    const inner = blocksIn(out[0], depth + 1);
    if (inner.length) return inner;
  }
  return out;
}

/** An article's content column: the child holding the post's own timestamp together with the
 *  post's own words.
 *
 *  Measured, because this is exactly where the two article surfaces differ. A feed card's
 *  `<article>` [728×302] wraps one row [728×302] of [avatar rail, content column], and the
 *  column [640×290] holds the header grid — the timestamp is INSIDE it, beside the title, the
 *  excerpt, the media and the action row. A post page's `<article>` IS the column: its header
 *  block, which carries the timestamp, sits BESIDE the body rather than around it, so none of
 *  its children holds the timestamp with the words. Both halves of the test are needed: the
 *  avatar rail is a child without a timestamp, and a post page's header block is a child with
 *  one. This is what keeps a card's one-character avatar initial from being read as the card's
 *  text, and its excerpt from being missed. */
function columnOf(root: Element): Element {
  // Stepped into rather than taken in one hop: a card's wrapper holds the timestamp too — it
  // holds the column that holds it — and stopping there would leave the avatar rail as the
  // wrapper's other child. The innermost qualifier is the column.
  //
  // A child qualifies only while it holds nearly ALL of what is above it (the tenth of slack
  // covers a tag or a label beside the words). That is what a card's wrapper and its column
  // both are, and it is what a post page's header block is not: the header and the body split
  // the article's text between them, so a post whose headline outweighs its body does not have
  // its body read as chrome and dropped.
  let el = root;
  for (let depth = 0; depth < BLOCK_DEPTH; depth++) {
    const total = textOf(el).length;
    const next = Array.from(el.children).find((child) =>
      child.querySelector('time') && textOf(child).length * 10 >= total * 9);
    if (!next) break;
    el = next;
  }
  return el;
}

/** A comment's content column: the floor plate's child that carries the comment's text. The
 *  plate's other child is the avatar rail, which holds an image and no words (measured).
 *
 *  Read off the plate rather than off the row above it, because which of the two carries
 *  `data-doorplate` is not pinned by a measurement: `doorplateOf` takes the root's own
 *  attribute or the first one under it. */
function commentColumnOf(root: Element): Element | null {
  const plate = root.matches(DOORPLATE) ? root : root.querySelector(DOORPLATE);
  if (!plate) return null;
  let best: Element | null = null;
  let bestLen = 0;
  for (const child of Array.from(plate.children)) {
    const len = textOf(child).length;
    if (len > bestLen) {
      best = child;
      bestLen = len;
    }
  }
  return best;
}

/** The elements a root's own text is rendered in, in document order. */
function bodyBlockElements(root: Element): Element[] {
  const column = root.matches(COMMENT_ROOT) ? commentColumnOf(root) : columnOf(root);
  return column ? blocksIn(column) : [];
}

/** The floor Dcard prints on a comment: its own label for the comment, and its only marker of
 *  what a reply answers. */
function doorplateOf(root: Element): string | null {
  const plate = root.matches(DOORPLATE) ? root : root.querySelector(DOORPLATE);
  return plate?.getAttribute('data-doorplate') ?? null;
}

/* ── Author and header ─────────────────────────────────────────────────────────── */

/** An article's header block: the child that holds the post's own timestamp. Used only on a
 *  post page, for the headline. */
function headerBlockOf(root: Element): Element | null {
  const time = root.querySelector('time');
  if (!time) return null;
  for (const child of Array.from(root.children)) if (child.contains(time)) return child;
  return null;
}

/** An article's byline row: the nearest laid-out ancestor of the post's own timestamp holding
 *  more than the timestamp alone.
 *
 *  This is the row the AUTHOR is read off, on both article surfaces. Measured 2026-10-01: a
 *  post page's byline (a 680×20 row of the avatar badge, the school and the timestamp) and a
 *  card's identity line (596×20 then, 640×20 on a later measurement, the school and the
 *  timestamp) both answer to it, while the wrappers between the timestamp and the row hold the
 *  timestamp alone and are skipped. Both rows have been seen as `flex` and as `grid`, so both
 *  are accepted — see the display test below for what reading only one of them cost. What
 *  Dcard draws on that line is the poster's school on either surface — a post page states no
 *  other account name, and a card states the forum instead on the line above — so reading it
 *  is what makes a card and the post it previews name the same account to the classifier. */
function bylineRowOf(root: Element): Element | null {
  const time = root.querySelector('time');
  if (!time) return null;
  for (let el: Element | null = time; el && el !== root; el = el.parentElement) {
    const display = getComputedStyle(el).display;
    // The row is a laid-out row: flex or grid, which is how Dcard has drawn it on the two
    // surfaces at different times — measured 2026-10-01, a card's identity line answered to
    // `flex`, and measured again on the same surface, `grid`. Reading only one of the two
    // refused EVERY feed card an id (an id requires an author), so the whole surface was
    // skipped: every card captured nothing, announced nothing and rendered no buttons. The
    // test is on the box, never on a class, and the walk still stops at the nearest ancestor
    // holding more than the timestamp — the wrappers between the two hold the timestamp alone.
    if (!/^(inline-)?(flex|grid)$/.test(display)) continue;
    if (el.children.length > 1) return el;
  }
  return null;
}

/** A comment's floor row: its column's child holding the comment's own `<time>` — the row that
 *  prints the comment's floor number and its timestamp beside the reply controls.
 *
 *  Not the identity row. Measured 2026-10-04 on a post page, a comment's column holds three
 *  children: the identity row (the name and the 145px vote/menu cluster, no timestamp at all),
 *  the text, and this row. Seating the buttons off the identity row put them at the right-hand
 *  end of the VOTE cluster — a different line from the `3樓 · 10-02` they belong beside, and the
 *  position the ask rejected. */
function commentFloorRow(root: Element): Element | null {
  const column = commentColumnOf(root);
  const time = root.querySelector('time');
  if (!column || !time) return null;
  return Array.from(column.children).find((child) => child.contains(time)) ?? null;
}

/** A comment's identity row: its column's child carrying the vote/menu cluster, which is also
 *  the row the author's name is on. Found by the control it holds rather than by index. */
function commentIdentityRow(root: Element): Element | null {
  const column = commentColumnOf(root);
  if (!column) return null;
  for (const child of Array.from(column.children)) {
    if (child.querySelector('button, [role="button"]')) return child;
  }
  return null;
}

/** A post page's own top line: the row above the title that carries its words and no timestamp.
 *
 *  A post page states the post's view count on a line of its own above the title — measured
 *  2026-10-01: a 680×33 flex row as the first child of the header block, holding one 11-character
 *  child and nothing else, with no control at its right end. The ask on that surface was for our
 *  buttons immediately after the count rather than out at the line's end, which is what the
 *  `inline` seat does.
 *
 *  The row holding the title is refused by identity, so a post whose views line is absent (a
 *  brand-new post, or a layout that drops it) returns null and falls back to the byline row
 *  rather than seating the buttons on a headline. */
function viewsLineOf(root: Element): Element | null {
  const header = headerBlockOf(root);
  if (!header) return null;
  const title = focalTitleOf(root);
  for (const child of Array.from(header.children)) {
    if (child.querySelector('time')) break;
    if (!textOf(child)) continue;
    if (title && child.contains(title)) return null;
    return child;
  }
  return null;
}

/** Where a root's buttons go: the row, and whether they sit inside it right after the row's own
 *  words (`inline`) or are pushed out to the row's right-hand end.
 *
 *  A root's buttons belong on the line Dcard's own ⋮ menu is on — the identity line of a card,
 *  the identity row of a comment. A post page's header is the exception: it carries no menu on
 *  its top line and its byline is a line below the title, so the views line above the title is
 *  where the ask put them. */
function buttonSeatOf(root: Element): { row: Element; inline: boolean } | null {
  if (root.matches(COMMENT_ROOT)) {
    const row = commentIdentityRow(root);
    return row ? { row, inline: false } : null;
  }
  const byline = bylineRowOf(root);
  if (!byline) return null;
  if (!cardPostId(root)) {
    const views = viewsLineOf(root);
    if (views) return { row: views, inline: true };
  }
  return { row: menuLineOf(byline), inline: false };
}

/** The row a root's author is read from. */
function headerRowOf(root: Element): Element | null {
  return root.matches(COMMENT_ROOT) ? commentIdentityRow(root) : bylineRowOf(root);
}

/** An article identity block's leading line, or the row itself when the identity is one line.
 *
 *  A feed card splits its identity in two and Dcard's ⋮ sits beside the FIRST line, not the row
 *  the author is read from. Measured 2026-10-01 on a card: a 3-child block holding the forum
 *  line (596×20 at y 208), the school-and-timestamp line (596×20 at y 228) and the menu (32×20
 *  at y 208 — the first line's own height). Our buttons go on the first line, beside the menu,
 *  which is where the same ask put them on LinkedIn: on the name line, next to the host's ⋯.
 *  A post page's byline is one row and is returned as it is.
 *
 *  Read structurally — an earlier sibling row of the same block, carrying words and no
 *  timestamp — rather than by any of Dcard's classes, and only ever within the row's own parent,
 *  so a layout that stops splitting the identity leaves the byline row alone. */
function menuLineOf(row: Element): Element {
  const parent = row.parentElement;
  if (!parent) return row;
  const rows = Array.from(parent.children);
  const idx = rows.indexOf(row);
  if (idx <= 0) return row;
  const above = rows.slice(0, idx).find((el) => !el.querySelector('time') && !!textOf(el));
  return above ?? row;
}

/** The author's name on a header row.
 *
 *  The row's own first child reads it, minus the author's initial where Dcard draws one as a
 *  badge at the start of the name: measured, a post page's byline row begins with a 20×20 link
 *  carrying "J" beside the name, while a card's name line and a comment's identity row begin
 *  with the name itself. The badge is found by its box — small, square, one or two characters,
 *  and at the start of the holder's text — never by its content, so a short name that is not a
 *  badge (a 25×17 link) is left alone.
 *
 *  A badge is also only a badge when it is not the WHOLE of what its holder says. A one- or
 *  two-character display name is a square box of the same size as an initial, and stripping it
 *  leaves no name at all — which refuses the post an id, so the post renders with no buttons
 *  anywhere it appears. Measured: a search card whose author is named `CH` (its avatar letter is
 *  the separate `Z` on the rail) was skipped on every surface for exactly this reason. Keeping
 *  the text when nothing would remain costs at worst an initial used as a name on a row that
 *  states no other. */
function nameOf(row: Element | null): string {
  const holder = row?.firstElementChild;
  if (!holder) return '';
  const text = textOf(holder);
  for (const el of Array.from(holder.querySelectorAll('*'))) {
    const badge = textOf(el);
    if (!badge || badge.length > 2) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.width > AVATAR_MAX) continue;
    if (Math.abs(rect.width - rect.height) > 2) continue;
    if (!text.startsWith(badge)) continue;
    const rest = text.slice(badge.length).trim();
    if (!rest) continue;
    return rest;
  }
  return text;
}

/* ── The clamp ─────────────────────────────────────────────────────────────────── */

/** Whether Dcard is hiding part of what `el` shows: it holds more content than its box and its
 *  overflow is not visible, which is what a clamp is. An element that is not laid out at all
 *  (an inline box, or one not yet rendered) has no box to judge and is not read as clamped.
 *
 *  Asked only for presentation (`unclip`), never to decide whether a root is a post: the text
 *  behind a clamp is in the DOM, so a clamped root is a post like any other — see this file's
 *  header. */
function hidesContent(el: Element): boolean {
  const box = el as HTMLElement;
  if (box.clientHeight === 0) return false;
  if (box.scrollHeight <= box.clientHeight + 1) return false;
  return getComputedStyle(el).overflowY !== 'visible';
}

/* ── Ids ───────────────────────────────────────────────────────────────────────── */

/** The post a feed card previews: the permalink the card carries in its header, which is its
 *  timestamp's own link (measured).
 *
 *  A link inside the card's own text is not it — a post that links to another Dcard post would
 *  otherwise be read as a card for that post — so the card's text blocks are excluded, and the
 *  page's own post falls through to the second half of `articleIdOf` with no permalink of its
 *  own. */
function cardPostId(root: Element): string | null {
  const blocks = bodyBlockElements(root);
  for (const link of Array.from(root.querySelectorAll(POST_LINK))) {
    const href = link.getAttribute('href');
    if (!href) continue;
    const path = postPathOf(href);
    if (!path || path.floor) continue;
    if (blocks.some((block) => block.contains(link))) continue;
    return path.post;
  }
  return null;
}

/** The id of an article: the post a card previews, or the post the page is about.
 *
 *  A card is taken first, and what is left on a post page is the page's own post — which
 *  carries no permalink to itself (measured: the article of a post page holds no `/p/` link at
 *  all, its byline's timestamp linking to the author instead). A byline is required of it, so a
 *  stray article with no post in it is not handed the page's id.
 *
 *  A card is named `card:<post>` rather than by the post's own id, because the two surfaces
 *  render different strings — the post's excerpt against the post itself — and an id names
 *  exactly one text (see this file's header). */
function articleIdOf(root: Element): string | null {
  const card = cardPostId(root);
  if (card) return namespaced(`card:${card}`);
  const page = pagePostId();
  return page && root.querySelector('time') ? namespaced(`p:${page}`) : null;
}

/** The post and floor a comment root stands for, or null when the root names neither.
 *
 *  The floor is Dcard's own doorplate label, and the post is read off the comment's own
 *  permalink — every comment row carries one (measured: `B1` under the post's floor row points
 *  at `/f/talk/p/262218882/b/1`), which is what makes a comment's id the same on the post page
 *  and on the comment's own permalink page. The page's post is the fallback, so a comment
 *  rendered without its permalink still names the thread it is in rather than nothing. */
function commentKeyOf(root: Element): { post: string; floor: string } | null {
  const floor = doorplateOf(root);
  if (!floor) return null;
  for (const link of Array.from(root.querySelectorAll(COMMENT_LINK))) {
    const href = link.getAttribute('href');
    if (!href) continue;
    const path = postPathOf(href);
    if (path) return { post: path.post, floor };
  }
  const page = pagePostId();
  return page ? { post: page, floor } : null;
}

/** The id a root stands for, or null when it is not a post this adapter integrates.
 *
 *  Two refusals, both of them the same refusal at heart — an id is only handed out for content
 *  the extension can classify and point at:
 *
 *  - a root with **no header row**, or one whose row names **no author**: the classified
 *    context is required to carry the username, so a root without one is not classifiable;
 *  - a root that names **nothing** — no post, no comment.
 *
 *  A root that fails either is not announced, not captured, and not treated as a native post
 *  by the selection rule. A root Dcard is clamping is NOT refused: the text behind the clamp is
 *  on the page already, and the reader is shown all of it when a claim is painted into it. */
function idOf(root: Element): string | null {
  if (!nameOf(headerRowOf(root))) return null;
  if (root.matches(COMMENT_ROOT)) {
    const key = commentKeyOf(root);
    return key ? namespaced(`c:${key.post}:${key.floor}`) : null;
  }
  return articleIdOf(root);
}

/** Every comment currently rendered, in document order. */
function commentRoots(): Element[] {
  return Array.from(document.querySelectorAll(COMMENT_ROOT));
}

/** Every article currently rendered: a post page's own post, and one per feed card. */
function articleRoots(): Element[] {
  return Array.from(document.querySelectorAll(POST_ELEMENT));
}

/** The roots an id is currently rendered as. A comment permalink page names a comment AND the
 *  post it is under, so both kinds of root are looked for on every page rather than by the
 *  shape of the URL. */
function postRoots(id: string): Element[] {
  const out: Element[] = [];
  const bare = id.startsWith(ID_PREFIX) ? id.slice(ID_PREFIX.length) : id;
  const roots = bare.startsWith('c:') ? commentRoots() : [...articleRoots(), ...commentRoots()];
  for (const root of roots) if (idOf(root) === id) out.push(root);
  return out;
}

/* ── Text ──────────────────────────────────────────────────────────────────────── */

/** The headline of the post a page is about: the heading inside the article's header block.
 *
 *  Null for a feed card, whose title is one of its blocks already and whose header holds only
 *  the forum label, the byline and the follow control — so this neither duplicates the title
 *  nor picks up the forum label as if it were the post's words. */
function focalTitleOf(root: Element): Element | null {
  if (root.matches(COMMENT_ROOT)) return null;
  if (cardPostId(root)) return null;
  return headerBlockOf(root)?.querySelector('h1, h2, h3') ?? null;
}

/** The blocks a root's own text is made of, in document order, each with the text this
 *  extension will classify for it. */
function bodyParts(root: Element): { el: Element; text: string }[] {
  const out: { el: Element; text: string }[] = [];
  const title = focalTitleOf(root);
  if (title) out.push({ el: title, text: textOf(title) });
  for (const el of bodyBlockElements(root)) {
    // A header block is classified whole only when it holds the bulk of the post, and the
    // headline is inside it then: it must not be classified a second time on its own.
    if (title && el !== title && el.contains(title)) continue;
    out.push({ el, text: textOf(el) });
  }
  return out.filter((part) => part.text);
}

/** The comment a reply answers, as an id, or null for a comment at the top of a thread.
 *
 *  Dcard renders a thread flat and marks a reply only in its floor label — measured: `4-1` and
 *  `4-2` are siblings of `4`, at the same left edge. So the parent is the comment whose own
 *  floor is the reply's prefix, and the thread is read from the labels rather than from
 *  ancestry, which names nothing here. */
function replyParentIdOf(comment: { post: string; floor: string }): string | null {
  const dash = comment.floor.indexOf('-');
  return dash > 0 ? namespaced(`c:${comment.post}:${comment.floor.slice(0, dash)}`) : null;
}

/* ── Capture ───────────────────────────────────────────────────────────────────── */

/** Dcard shows no verification badge on the identity rows of the surfaces integrated here —
 *  measured across a post page's byline (an avatar initial, the name, a follow control, the
 *  timestamp), a card's name line and a comment's identity row (a school or profession line
 *  and a name): the only small marks on the page belong to Dcard's own chrome. So every account
 *  is `Regular` rather than inferred from a mark that was not found. Dcard's comment payload
 *  carries a `verifiedBadge` flag, so if a badge element turns up for a verified account, this
 *  is where to read it. */
const DCARD_USERTYPE: Usertype = UsertypeEnum.Regular;

/** The length of body past which a post stops being one the reader takes in at a glance.
 *
 *  Dcard's own cut is the 100 characters a card's excerpt holds (measured — see the clamp note
 *  at the top of this file), and that is where this platform's number came from. It is no
 *  longer per-platform: a card's excerpt is a fact about a CARD, and the same post runs whole
 *  on its own page, so every platform reads the universal `LONG_FORM_CHARS`. */

export const dcardAdapter: PlatformAdapter = {
  // The apex and `www.` both serve the app, so the suffix rule covers the pair without naming
  // each host.
  id: 'dcard',
  hosts: PLATFORM_HOSTS.dcard ?? [],

  postIdFromUrl(url) {
    const path = postPath(url.pathname);
    if (!path) return null;
    return path.floor ? namespaced(`c:${path.post}:${path.floor}`) : namespaced(`p:${path.post}`);
  },

  postRoots,

  postIdOf(root) {
    return idOf(root);
  },

  textElement(root) {
    const parts = bodyParts(root);
    if (parts.length === 0) return null;
    // The longest block, which is the one a single anchor should point at when the text is
    // spread across several. `textRegions` below carries the whole picture.
    let best = parts[0];
    for (const part of parts) if (part.text.length > best.text.length) best = part;
    return best.el;
  },

  textRegions(root): TextRegion[] | null {
    const parts = bodyParts(root);
    if (parts.length < 2) return null;
    // Offsets walk the joined text the caller classifies, one block at a time, so each block is
    // painted with the slice of the classification that was measured over it.
    const regions: TextRegion[] = [];
    let at = 0;
    for (const part of parts) {
      regions.push({ el: part.el, start: at, end: at + part.text.length });
      at += part.text.length + BLOCK_JOIN.length;
    }
    return regions;
  },

  // A post's body is rich text — a headline, paragraphs, links, images — and a comment's is at
  // least one paragraph of it, emoji included. Rebuilding either from the classified string
  // would flatten all of that, so highlights go over the page's own text nodes.
  highlightInPlace: true,

  /** Show the whole text once we have painted marks into it.
   *
   *  Dcard clamps a card's excerpt to one line on the excerpt element ITSELF — measured, a
   *  20px box (`-webkit-line-clamp: 1`, `overflow: hidden`) around 60px of text — so a reader
   *  who follows a claim past the first third of the excerpt would be reading a hijacked view:
   *  three claims may be inside the string and one of them visible.
   *
   *  Two declarations, the same two LinkedIn needs: clearing `-webkit-line-clamp` and
   *  `overflow` takes the box to its content's full height. Nothing here changes the text, so
   *  the hash and the id are untouched; the element is left as it was found apart from the
   *  clamp, and Dcard's own re-render of the card is free to clamp it again (the hook is
   *  re-applied with the marks, which is what `unclip` is for).
   *
   *  Asked of the element handed in and of everything under it: which level carries the clamp
   *  is the host's business, and a body is read back from the box that holds it. */
  /** Whether this root is a post Dcard will not show whole — the long-form case, which gets
   *  no buttons and is fact-checked by selecting a passage inside it.
   *
   *  The number is Dcard's own: a card's excerpt holds the post body's first 100 characters,
   *  measured, and that is exactly the `excerpt` its pagination payload carries (see the clamp
   *  note at the top of this file). So 100 characters of body is where the host itself stops
   *  showing a post whole, and applying it here rather than asking "is this root clamped right
   *  now" is what keeps the answer the same on every surface — a post page clamps nothing and
   *  would otherwise never be long-form, though it is the surface where a pill hurts most: the
   *  entire body is on screen, the reader wants the end of it, and the whole post above would
   *  be classified and billed before they could act.
   *
   *  Judged on the text each surface itself files, and the two surfaces agree rather than
   *  disagree: a card files the excerpt, and an excerpt that reaches 100 characters is a cut
   *  the host made — measured, every card of a longer post renders exactly 100 characters in
   *  its excerpt `<p>`, and the same post's own API record pairs `excerpt: 100` with
   *  `content: 573`. So the card at the limit is a clipped post, not a short one, and it is
   *  long-form for the same reason its page is.
   *
   *  The comparison is `>=` rather than `>` and the direction of the error is deliberate: a
   *  body of exactly 100 characters shown whole loses its pill, where a clipped 100 that we
   *  read as short would file a hash taken over text we know is partial. A withheld pill costs
   *  the reader a click; a clipped hash costs the DB the post.
   *
   *  The post's whole body is reachable — `/service/api/v2/posts/<id>` answers with
   *  `content` — and it is deliberately NOT fetched to put a pill back on the card: a post's
   *  classified text and the text on screen are the same string everywhere else in this
   *  integration, and that is what lets `textRegions` paint a claim at an offset. Capturing
   *  573 characters into a card that renders 100 would leave most of every classification
   *  with nothing to paint on. */
  isLongForm(root) {
    if (root.matches(COMMENT_ROOT)) return false;
    const title = focalTitleOf(root);
    let body = 0;
    for (const part of bodyParts(root)) {
      if (title && part.el === title) continue;
      body += part.text.length;
    }
    return body >= LONG_FORM_CHARS;
  },

  unclip(textElement) {
    for (const el of [textElement, ...Array.from(textElement.querySelectorAll('*'))]) {
      if (!hidesContent(el)) continue;
      const box = el as HTMLElement;
      box.style.webkitLineClamp = 'unset';
      box.style.overflow = 'visible';
    }
  },

  placeButtons(container, root) {
    // A comment's buttons go immediately to the RIGHT of its own timestamp — `3樓 · 10-02
    // [Disinfact] Reply Quote Share` — the position every platform here shares. The floor row
    // spans the column and its timestamp sits at the row's left end, so the seat a POST takes
    // (the row's right-hand end, inset past the trailing vote/menu cluster) would park a
    // comment's pill some 400px from the time it belongs to.
    if (root.matches(COMMENT_ROOT)) {
      const row = commentFloorRow(root) ?? commentIdentityRow(root);
      if (!row) return;
      container.style.marginLeft = '8px';
      container.style.alignSelf = 'center';
      container.style.flexShrink = '0';
      // Inserted after the row's own child that CARRIES the timestamp, not after the `<time>`
      // itself, for the reason `commentHeaderLine` gives on Facebook: a pill dropped inside the
      // stamp's own block sits beside the stamp rather than following the header. See Reddit's
      // `placeButtons` for the same walk.
      let anchor: Element | null = row.querySelector('time');
      while (anchor && anchor.parentElement !== row) anchor = anchor.parentElement;
      if (anchor && anchor !== row) anchor.insertAdjacentElement('afterend', container);
      else row.appendChild(container);
      return;
    }
    // At the top of the post, in the row Dcard draws its own identity on — the same place they
    // take on X, Bluesky, Reddit, Substack and Quora. `buttonSeatOf` finds that row structurally,
    // so none of this depends on a class Dcard hashes.
    const seat = buttonSeatOf(root);
    if (seat) {
      const row = seat.row;
      // `marginLeft: auto` is what pushes the buttons to the right end of the row when the row
      // is a flex container — every one of these is — and does nothing when it is not, so a
      // layout change degrades to "the buttons are in the header" rather than to nowhere. A
      // post page's views line takes the same 8px gap the inline seats use on Facebook, PTT and
      // Naver Cafe instead, so the buttons read as following the count.
      container.style.marginLeft = seat.inline ? '8px' : 'auto';
      container.style.alignSelf = 'center';
      container.style.flexShrink = '0';
      // A row that ends in one of Dcard's own control clusters keeps it: ours goes immediately
      // to its left. That is a comment's vote/menu cluster (measured: 145px wide at 994–1139,
      // ending exactly at the row's right edge) — the position the same ask produced on Quora,
      // beside the host's trailing control rather than where it is. Found by where it sits and
      // the control it holds, never by its label.
      const last = row.lastElementChild;
      if (last && isTrailingControl(row, last)) row.insertBefore(container, last);
      else row.appendChild(container);
      return;
    }
    // No header row: leave the container detached rather than dropping it at the top of the
    // post. A post carrying our buttons is one the selection rule hands the user's selection
    // off to, so a pill placed anywhere else on the post would cost the user the web-select
    // path on that post. Detached, the post keeps working: it simply has no buttons. See
    // `placeButtons` in types.ts.
  },

  feedCenter() {
    // The measure is the content column, not the viewport — Dcard lays the feed in a column
    // beside its own navigation, and a card's box is wider than that column because its media
    // is full-bleed (measured: a 728px article around a 640px column, and a 596px name line
    // inside it). The column is what the floating buttons should sit over.
    for (const root of [...articleRoots(), ...commentRoots()]) {
      const column = root.matches(COMMENT_ROOT) ? commentColumnOf(root) : columnOf(root);
      const rect = (column ?? root).getBoundingClientRect();
      if (rect.width > 0) return rect.left + rect.width / 2;
    }
    return null;
  },

  isPostTarget(id) {
    return postRoots(id).length > 0;
  },

  postElementFor(node) {
    const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    if (!el) return null;
    // Innermost first, and the two cases are disjoint: the comment list sits outside the
    // article (measured), so a selection in a comment can never belong to the post behind it.
    // Every branch goes through `idOf`, so a selection only becomes a native post where the
    // extension really has one — buttons on it and a text it files.
    const comment = el.closest(COMMENT_ROOT);
    if (comment && idOf(comment)) return comment;
    const article = el.closest(POST_ELEMENT);
    if (article && idOf(article)) return article;
    return null;
  },

  captureRoots() {
    // Every article and comment the page has rendered, whether or not Dcard is clamping any of
    // it: what a root is worth is decided by `idOf` and `capture`, which the sweep, the
    // announcer and the selection rule all ask anyway.
    return [...articleRoots(), ...commentRoots()];
  },

  capture(root): CapturedPost | null {
    const id = idOf(root);
    if (!id) return null;

    const parts = bodyParts(root);
    const text = parts.map((part) => part.text).join(BLOCK_JOIN);
    // A post can be a picture with no words and a comment can be deleted with its shell left
    // behind. Neither carries anything to fact-check, so they stay out of the batch rather than
    // spending a classification on an empty string.
    if (!text) return null;

    const comment = root.matches(COMMENT_ROOT) ? commentKeyOf(root) : null;
    // The post is the thread: a comment's is the post it is under, and a feed card's is the post
    // it previews — the same conversation the post page itself carries, so the three surfaces
    // are one thread rather than three, even though a card is filed under its own id.
    const card = comment ? null : cardPostId(root);
    const conversation = comment ? namespaced(`p:${comment.post}`)
      : card ? namespaced(`p:${card}`)
      : id;
    const post = {
      id,
      text,
      // The DOM is the only source here, so the rendered text IS the raw text. X separates
      // these because its payload carries both a note_tweet expansion and a legacy body; markup
      // read off the page has no such split.
      fullText: text,
      username: nameOf(headerRowOf(root)),
      usertype: DCARD_USERTYPE,
      conversationId: conversation,
      quoting: null,
      replyingTo: null,
    } as MainTweet;

    // Language deliberately left unset. Dcard carries no per-post language markup — only
    // `<html lang>`, which is the reader's UI language — and its forums run from Chinese to
    // English within one page. `nameCapturedLanguage` puts an unnamed post under the shared
    // unknown key, which is stable rather than wrong.
    return {
      post,
      replyParentId: comment ? (replyParentIdOf(comment) ?? conversation) : null,
    };
  },
};

/** Whether `child` is a control cluster sitting at its row's right-hand end, which our buttons
 *  go to the left of. */
function isTrailingControl(row: Element, child: Element): boolean {
  if (!child.querySelector('button, [role="button"]')) return false;
  const rect = child.getBoundingClientRect();
  if (rect.width === 0) return false;
  return row.getBoundingClientRect().right - rect.right <= CORNER_SLACK;
}
