/** The PTT adapter.
 *
 *  PTT (`www.ptt.cc`) is Taiwan's largest bulletin board, and its web front end is the oldest
 *  markup in this rollout after Hacker News: server-rendered, no `data-testid` anywhere, no
 *  framework, and a DOM shaped by the same templates for a decade. The anchors below are
 *  therefore class names, for the same reason HN's are — they are semantic (`r-ent` = one row
 *  of a board's list, `push` = one comment, `article-metaline` = one line of an article's own
 *  metadata block) rather than presentational, and PTT ships no build step that could rename
 *  them. Nothing here keys on a style class, a locale string or a width.
 *
 *  Three surfaces, two of which carry a post:
 *
 *  - **A board index** (`/bbs/<Board>/index.html`, and the same rows on its search page) is a
 *    list of `div.r-ent`: a headline line, then a line carrying the author, PTT's own row menu,
 *    the date and the row's mark. **A row is not a post.** It carries the article's headline
 *    and nothing else — the body is on the article page alone — so what a row names is an
 *    article the reader has to click to read. Like every other index row in this rollout it
 *    gets no buttons and is not classified; the article page has them. The rows are still read
 *    for one thing, the column they sit in, which is what `feedCenter` centers over.
 *  - **An article page** (`/bbs/<Board>/M.<ts>.A.<hash>.html`) is one `#main-content` holding
 *    the article's metadata lines, its body, PTT's `※` footer lines, and one `div.push` per
 *    comment — all flat siblings, which is the structural fact the body handling below rests
 *    on: **the body is not an element.** PTT interleaves the article's own text with label
 *    spans and links as direct children of the container, so there is nothing that holds the
 *    body alone.
 *  - **A push** is one comment on that article, rendered as a single line: a 推/噓/→ tag, the
 *    pusher's handle, the words, and a timestamp floated to the row's right-hand end.
 *
 *  **Nothing is clamped, on any surface.** Measured 2026-10-01 across a board index and an
 *  article page: not one element holding text has `scrollWidth > clientWidth` or
 *  `scrollHeight > clientHeight`, and none carries a `-webkit-line-clamp` or a `max-height` —
 *  the only overflowing box on either page is a 40×43 `overflow: auto hidden` container that
 *  holds no text at all. A row's headline wraps rather than clips, an article's body is
 *  server-rendered whole (`#main-content` measured 2830×2830 with `overflow: visible`), a page
 *  with 33 comments renders all 33 inline, and there is no "還有 N 則推文" affordance anywhere.
 *  The one string PTT does keep short is the headline itself, and it is short on EVERY surface
 *  alike: measured, a row's headline equals the article's own 標題 line character for
 *  character and appears in the page's `<title>`. So that is the platform's content rather than
 *  a render hiding it, and there is nothing here to reveal: no adapter seam, and no id refused
 *  for being clipped. Every article and every push is integrated as it stands.
 *
 *  **One id, one text**, held trivially here: the only things PTT classifies are an article page
 *  and the pushes on it, and both take their id from the page's own path. The board rows were
 *  the one thing that needed a namespace of their own for this — a row's text is the headline
 *  alone and the article's is the headline plus the body, so the two could never share an id —
 *  and dropping rows as posts dropped that second name with them.
 */
import type { MainTweet, Usertype } from '../../data/Tweets';
import { Usertype as UsertypeEnum } from '../../data/Tweets';
import { PLATFORM_HOSTS } from './hosts';
import { LONG_FORM_CHARS } from './types';
import type { CapturedPost, PlatformAdapter, TextRegion } from './types';

/** PTT ids are namespaced for the same reason every platform's after X are: the background
 *  fans a classification out to *every* connected relay rather than keying by tab, so a bare
 *  article filename could otherwise be injected into an unrelated page. */
const ID_PREFIX = 'ptt:';

/** Separates an article's id from one of its comments. */
const PUSH_SEP = '#';

/** One comment on an article page. */
const PUSH_SELECTOR = 'div.push';

/** An article page's own container. It exists on no other view (measured: the board index has
 *  none), which is half of what makes it a safe anchor; the other half is the metadata line
 *  `articleRoot` also requires. */
const MAIN_ID = 'main-content';

/** A board index's own container. Nothing on that page is a post, so this is not a root — it is
 *  the column the selection UI's own buttons center over when a reader selects a headline there,
 *  which is the web-selection path. */
const LIST_CONTAINER = '.r-list-container';

/** One line of an article's metadata block. A plain one holds the author, the headline or the
 *  timestamp; the `-right` variant is the block's corner box carrying the board's name. */
const METALINE = 'article-metaline';
const METALINE_RIGHT = 'article-metaline-right';

/** The span inside a metadata line that holds the value rather than the label. */
const META_VALUE = '.article-meta-value';

const PUSH_USERID = '.push-userid';
const PUSH_CONTENT = '.push-content';

/** An article's filename: `M.<unix ts>.A.<hash>`, the shape an article page's own path carries.
 *  Nothing else on PTT has it. */
const ARTICLE_FILE = /M\.\d+\.A\.[0-9A-Za-z]+/;

/** How an article's headline and body are joined in its classified text. Two newlines, so the
 *  worker reads them as separate paragraphs. Nothing renders the characters BETWEEN two
 *  regions, which is why the regions carry explicit offsets. */
const POST_JOIN = '\n\n';

/** PTT shows no verification badge: there is no concept of a verified account on the board, and
 *  the marks its list rows carry (a bold `爆` in the nrec column, `M` for a saved post, `!` for
 *  one PTT flagged) belong to the *post*, not to the account behind it. Every account is
 *  therefore `Regular` rather than inferred from a mark that means something else. */
const PTT_USERTYPE: Usertype = UsertypeEnum.Regular;

function namespaced(id: string): string {
  return ID_PREFIX + id;
}

/** A post id without its namespace. */
function bare(id: string): string {
  return id.startsWith(ID_PREFIX) ? id.slice(ID_PREFIX.length) : id;
}

/** Text of an element, or '' when it is missing — the shape every adapter's `textOf` has. */
function textOf(el: Element | null | undefined): string {
  return el?.textContent?.trim() ?? '';
}

/** The article filename a PTT path carries, or null for a path that is not an article's. Read
 *  off the page's own `location.pathname` (`/bbs/Stock/M.1790601312.A.75E.html`). */
function fileFromPath(path: string): string | null {
  return path.match(ARTICLE_FILE)?.[0] ?? null;
}

/** The article the page itself is showing. */
function pageFile(): string | null {
  return fileFromPath(location.pathname);
}

/** An article page's container, or null when this page is not showing an article.
 *
 *  `#main-content` alone is not enough: the metadata line is what makes the container an
 *  article rather than some other view that happens to reuse the id, and a container mistaken
 *  for an article would have its entire contents — every row of a list, every comment —
 *  classified as one post's body.
 *
 *  The metadata line is searched for among DESCENDANTS rather than direct children because
 *  after the article has been painted it no longer has direct children: the highlight layer
 *  moves everything the container held into its own `display: contents` wrap, so a test that
 *  insisted on a direct child would answer "this is not an article" about the very article it
 *  just painted, and every later pass would fail to find the post it was updating. */
function articleRoot(): Element | null {
  const main = document.getElementById(MAIN_ID);
  if (!main) return null;
  return main.querySelector(`.${METALINE}`) ? main : null;
}

/** Whether an element is the highlight layer's own in-place wrap (see `canvasChildren`). */
function isOurWrap(el: Element): boolean {
  return el.classList.contains('mf-segment-wrap');
}

/** A container's children as the PAGE's own markup has them, with our wrap treated as
 *  transparent.
 *
 *  Once a post is painted, our wrap holds every child the container had — the article's
 *  metadata lines, its body, its footer and all of its comments; a comment's words, for a
 *  comment. Every function below counts in terms of the page's own children (where the
 *  article's body starts and ends, which line carries the author's name), and all of them run
 *  again on every later pass, so they have to read through the wrap rather than around it. The
 *  wrap is `display: contents`, so unpacking it here is not an approximation of the layout: the
 *  unpacked children are laid out exactly where the page put them. */
function canvasChildren(root: Element): ChildNode[] {
  const out: ChildNode[] = [];
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === Node.ELEMENT_NODE && isOurWrap(node as Element)) {
      for (const inner of Array.from(node.childNodes)) out.push(inner);
      continue;
    }
    out.push(node);
  }
  return out;
}

/** Whether an element is one of an article's metadata lines, corner box included. */
function isMetaline(el: Element): boolean {
  return el.classList.contains(METALINE) || el.classList.contains(METALINE_RIGHT);
}

/** Whether a node is one of PTT's own footer lines about the article (`※ 發信站: …`, and the
 *  `※ 文章網址: …` / `※ 編輯: …` lines under it). `f2` is PTT's small-print class, and the
 *  article template uses it for nothing else. */
function isF2(node: ChildNode): boolean {
  return node.nodeType === Node.ELEMENT_NODE
    && (node as Element).tagName === 'SPAN'
    && (node as Element).classList.contains('f2');
}

function isPush(node: ChildNode): boolean {
  return node.nodeType === Node.ELEMENT_NODE && (node as Element).matches(PUSH_SELECTOR);
}

/** The article's body: the `#main-content` children between the metadata block and the first
 *  comment, minus PTT's trailing footer lines.
 *
 *  Nodes rather than one element, because there is no element that holds the body: the
 *  article's words arrive as loose text nodes interleaved with PTT's label spans and the
 *  author's links, and a run of contiguous siblings is the only honest unit for them.
 *  `bodyText` is therefore exactly a contiguous slice of the container's own text, which is
 *  what the highlight layer's in-place matcher requires. */
function bodyNodes(root: Element): ChildNode[] {
  const kids = canvasChildren(root);
  let start = 0;
  for (let i = 0; i < kids.length; i++) {
    const el = kids[i];
    if (el.nodeType === Node.ELEMENT_NODE && isMetaline(el as Element)) start = i + 1;
  }
  let end = kids.length;
  for (let i = start; i < kids.length; i++) {
    if (isPush(kids[i])) { end = i; break; }
  }
  while (end > start && isF2(kids[end - 1])) end--;
  return kids.slice(start, end);
}

/** The article's body text, contiguous in `#main-content`'s own text by construction. */
function bodyText(root: Element): string {
  return bodyNodes(root).map((node) => node.textContent ?? '').join('');
}

/** An article's metadata lines, in the order PTT renders them. */
function plainMetalines(root: Element): Element[] {
  return canvasChildren(root)
    .filter((node): node is Element => node.nodeType === Node.ELEMENT_NODE)
    .filter((el) => el.classList.contains(METALINE));
}

/** The line the author's name is on: the FIRST metadata line.
 *
 *  Found by position, never by the 作者 label PTT prints before the name — that label is
 *  Chinese, and a locale-dependent anchor is exactly what this rollout refuses. PTT's article
 *  template is fixed: the author's line, then the headline's, then the timestamp's. */
function authorLine(root: Element): Element | null {
  return plainMetalines(root)[0] ?? null;
}

/** The author's name, which the article's buttons are placed beside. */
function authorElement(root: Element): Element | null {
  return authorLine(root)?.querySelector(META_VALUE) ?? null;
}

/** The article's headline, or null when the page has none.
 *
 *  The second metadata line, by the same template fact as `authorLine`; its VALUE span is
 *  returned rather than the line, so a highlight wraps the headline and never the 標題 label
 *  in front of it. */
function titleElement(root: Element): Element | null {
  return plainMetalines(root)[1]?.querySelector(META_VALUE) ?? null;
}

/** The comment's own words.
 *
 *  `.push-content` opens with the separator PTT prints between the handle and the words
 *  (`: 難怪噴成這樣`), which is the row's punctuation rather than something the commenter
 *  said — and it is not part of what a claim would name, so it is dropped from the classified
 *  text rather than carried into the offsets. */
function pushText(root: Element): string {
  return textOf(root.querySelector(PUSH_CONTENT)).replace(/^[:：]\s*/, '').trim();
}

/** The handle behind a comment, or '' when PTT renders none. */
function pushUser(root: Element): string {
  return textOf(root.querySelector(PUSH_USERID));
}

/** A stable tag for one comment's text within its article.
 *
 *  A push carries no id of its own — PTT has no per-comment markup at all beyond the row — so
 *  one is derived from what the comment IS: the handle, the words, and (so that a handle
 *  pushing the same words twice in the same minute is still two comments) nothing else. The
 *  handle is the discriminator for two people saying the same thing, the hash for one person
 *  saying two things. An ORDINAL would be the tempting shortcut and the wrong one: PTT deletes
 *  a push by removing its row, which would renumber every comment below it and leave one id
 *  naming two different texts — the collision `post-id-names-one-text` exists to prevent. */
function pushKey(root: Element): string | null {
  const user = pushUser(root);
  const text = pushText(root);
  if (!user || !text) return null;
  return `${user}-${contentTag(text)}`;
}

/** A short, stable tag for a string: FNV-1a, base 36. Only ever compared for equality. */
function contentTag(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** Which of PTT's two post surfaces a root is, or null for anything else — a board row among
 *  the rest, since a row is a link to an article rather than an article. */
function kindOf(root: Element): 'article' | 'push' | null {
  if (root.matches(PUSH_SELECTOR)) return 'push';
  if (root.id === MAIN_ID && root.querySelector(`.${METALINE}`)) return 'article';
  return null;
}

/** The blocks an article's text is made of, in reading order: the headline, then the body.
 *
 *  Both are classified as ONE post — they are one article, and a headline answered by its own
 *  body is exactly what the worker cannot see if the two arrive as separate classifications.
 *  A news article's headline is usually the claim, so neither block can be dropped in favour of
 *  the other. */
function articleParts(root: Element): { el: Element; text: string }[] {
  const parts: { el: Element; text: string }[] = [];
  const titleEl = titleElement(root);
  const title = textOf(titleEl);
  if (titleEl && title) parts.push({ el: titleEl, text: title });
  // The body region points at the container ITSELF, and its text is the contiguous run within
  // that container's own text — which is what the in-place matcher needs, since it locates the
  // classified run inside the element it is handed. Measured: the wrap it then builds is
  // `display: contents`, so moving the container's children into it leaves every child exactly
  // where PTT's own stylesheet put it — same box, same font, same float, for the metadata
  // lines, the body, the footer and all 121 comments.
  const body = bodyText(root).trim();
  if (body) parts.push({ el: root, text: body });
  return parts;
}

/** `articleParts` as ranges into the article's classified text, OUTERMOST BLOCK FIRST.
 *
 *  The order is load-bearing, not presentational. The blocks nest — the headline's value span
 *  is inside the container the body is painted on — and the highlight layer finds a block's
 *  existing wrap with a DESCENDANT query. Painted inner-first, the body's pass finds the
 *  headline's wrap, reads it as the body's own stale wrap and discards it, leaving the headline
 *  unwrapped and its claims unpainted. Painted outermost-first, the body's pass sees only what
 *  it built itself and the headline's pass — which has no descendants to confuse it — lands
 *  last and stays. */
function articleRegions(root: Element): TextRegion[] | null {
  const parts = articleParts(root);
  // One block is the ordinary single-element case: `textElement` is already that element, and
  // the caller has nothing to slice.
  if (parts.length < 2) return null;
  const regions: TextRegion[] = [];
  let at = 0;
  for (const part of parts) {
    regions.push({ el: part.el, start: at, end: at + part.text.length });
    at += part.text.length + POST_JOIN.length;
  }
  return regions.reverse();
}

function postRoots(id: string): Element[] {
  const want = namespaced(bare(id));
  const out: Element[] = [];
  const main = articleRoot();
  if (main) out.push(main);
  for (const push of document.querySelectorAll(PUSH_SELECTOR)) out.push(push);
  return out.filter((root) => postIdOf(root) === want);
}

/** The id a root stands for, or null when it is not a post this adapter integrates. Board rows
 *  are not among them — see this file's header. */
function postIdOf(root: Element): string | null {
  const kind = kindOf(root);
  if (kind === 'push') {
    const file = pageFile();
    const key = pushKey(root);
    return file && key ? namespaced(`${file}${PUSH_SEP}${key}`) : null;
  }
  if (kind === 'article') {
    const file = pageFile();
    return file ? namespaced(file) : null;
  }
  return null;
}

export const pttAdapter: PlatformAdapter = {
  id: 'ptt',
  hosts: PLATFORM_HOSTS.ptt ?? [],

  postIdFromUrl(url) {
    const file = fileFromPath(url.pathname);
    return file ? namespaced(file) : null;
  },

  postRoots,

  postIdOf,

  /** An article, judged for length — PTT clamps nothing, so the number is
   *  LONG_FORM_CHARS, read off the article's headline plus body, the one text
   *  the article page classifies.
   *
   *  Pushes are PTT's comments and are not judged: they are the short shape, they keep their
   *  buttons, and the article they answer stays their ancestor either way.
   *
   *  A board row is not judged because it is not classified at all. */
  isLongForm(root) {
    if (kindOf(root) !== 'article') return false;
    return articleParts(root).reduce((n, part) => n + part.text.length, 0) >= LONG_FORM_CHARS;
  },

  textElement(root) {
    const kind = kindOf(root);
    if (kind === 'push') return root.querySelector(PUSH_CONTENT);
    // An article's text is spread across two blocks, and the body is by far the longer of the
    // two, so the container is the anchor a caller that needs one gets. `textRegions` carries
    // the whole picture.
    const parts = articleParts(root);
    let best: Element | null = null;
    let longest = -1;
    for (const part of parts) {
      if (part.text.length > longest) { longest = part.text.length; best = part.el; }
    }
    return best;
  },

  textRegions(root) {
    if (kindOf(root) !== 'article') return null;
    return articleRegions(root);
  },

  // Both an article's body and a comment's text are markup rather than a plain run: PTT
  // interleaves the words with its own label spans and with the links the poster wrote, and a
  // news article's body is paragraphs of them. Rebuilding either from the classified string
  // would flatten the labels into the article's own text and turn every link into a raw URL,
  // so highlights go over the page's own text nodes.
  highlightInPlace: true,

  placeButtons(container, root) {
    const kind = kindOf(root);
    // On both surfaces the buttons go at the right-hand end of the line the post's NAME is on,
    // inset out of the way of whatever PTT keeps in that corner — the same place they take on
    // X, Reddit, Substack, Dcard and Quora.
    //
    // PTT lays these rows out as blocks with FLOATS rather than as flex rows, so the idiom the
    // other adapters use (`marginLeft: auto` on a flex row) does nothing here. A right float of
    // our own is its equivalent: floats are placed in document order from the edge outwards, so
    // a container appended LAST to a row already ending in right floats lands immediately to
    // the left of them, and one appended to a row whose corner control is absolutely positioned
    // lands at the edge, inset by the margin below.
    container.style.float = 'right';
    container.style.marginLeft = '8px';

    if (kind === 'article') {
      const line = authorLine(root);
      if (!line) return;
      // The board's name sits in the block's top-right corner as an absolutely positioned box,
      // on the SAME line as the author — measured at 1148..1300 of a 1200px column. Inset our
      // container past it, measured rather than assumed: the box's width is the board's name,
      // so it changes with the board and no constant would hold.
      // A DESCENDANT lookup, not a child one: once highlights are painted the container's
      // direct children are all inside the highlight layer's own wrap (see `canvasChildren`).
      const corner = root.querySelector(`.${METALINE_RIGHT}`);
      const box = corner?.getBoundingClientRect();
      if (box && box.width > 0) {
        const gap = line.getBoundingClientRect().right - box.left + 8;
        if (gap > 0) container.style.marginRight = `${Math.round(gap)}px`;
      }
      line.appendChild(container);
      return;
    }

    if (kind === 'push') {
      // A comment is one line whose right-hand end is its timestamp, so the container appended
      // last rides the line's top and sits immediately left of that timestamp.
      root.appendChild(container);
    }
    // No line found: the container stays detached rather than being dropped somewhere
    // plausible. A post carrying our buttons is a post the selection rule hands the user's
    // selection off to, so a misplaced pill would also cost the user the web-select path on
    // that post. Detached, the post keeps working: it simply has no buttons. See `placeButtons`
    // in types.ts.
  },

  feedCenter() {
    // PTT lays both views out in one fixed-width column, and it is the column — not the
    // viewport — that the floating buttons belong over. Both containers measure the same
    // (100..1300 of a 1400px viewport here), but they are two different elements and either
    // could move on its own.
    const column = articleRoot() ?? document.querySelector(LIST_CONTAINER);
    if (!column) return null;
    const rect = column.getBoundingClientRect();
    return rect.width > 0 ? rect.left + rect.width / 2 : null;
  },

  isPostTarget(id) {
    return postRoots(id).length > 0;
  },

  postElementFor(node) {
    const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    if (!el) return null;
    // Innermost first, and the two cases are disjoint. Every branch goes through the id. A
    // selection inside a board row is deliberately NOT one of them: the row is a link to an
    // article, so it stays a web selection rather than being handed to a post that is not there.
    const push = el.closest(PUSH_SELECTOR);
    if (push && postIdOf(push)) return push;
    const main = el.closest(`#${MAIN_ID}`);
    if (main && kindOf(main) === 'article' && postIdOf(main)) return main;
    return null;
  },

  captureRoots() {
    // A page is an article, or an article with its comments, or a board list — and a board list
    // has nothing here to capture, because a row on it is a link to an article rather than an
    // article. `articleRoot` is where the "is this page an article" question is answered, so it
    // is asked once here and once in `postIdOf` rather than at every call site.
    const out: Element[] = [];
    const main = articleRoot();
    if (main) out.push(main);
    for (const push of document.querySelectorAll(PUSH_SELECTOR)) out.push(push);
    return out;
  },

  capture(root): CapturedPost | null {
    const kind = kindOf(root);
    const id = postIdOf(root);
    if (!kind || !id) return null;

    if (kind === 'push') {
      const text = pushText(root);
      const username = pushUser(root);
      // A push with no words (PTT renders empty `→` rows) carries nothing to fact-check, and
      // one with no handle carries no context to classify it with. Either way it stays out of
      // the batch rather than spending a classification on it.
      if (!text || !username) return null;
      return {
        post: {
          id,
          text,
          // The DOM is the only source here, so the displayed text IS the raw text. X
          // separates these because its JSON carries both a note_tweet expansion and a legacy
          // body; markup read off the page has no such split.
          fullText: text,
          username,
          usertype: PTT_USERTYPE,
          // Every comment on an article is that article's conversation, and a comment replies
          // to the article itself — PTT threads its pushes flat, so the article is what a
          // comment is answering and the context a classifier most needs.
          conversationId: namespaced(pageFile() ?? bare(id)),
          quoting: null,
          replyingTo: null,
        } as MainTweet,
        replyParentId: pageFile() ? namespaced(pageFile()!) : null,
      };
    }

    const parts = articleParts(root);
    const text = parts.map((part) => part.text).join(POST_JOIN);
    const username = textOf(authorElement(root));
    // An article with neither headline nor body, or one whose metadata block names no author,
    // is not classifiable — the context has to carry the name.
    if (!text || !username) return null;
    return {
      post: {
        id,
        text,
        fullText: text,
        username,
        usertype: PTT_USERTYPE,
        conversationId: id,
        quoting: null,
        replyingTo: null,
      } as MainTweet,
      replyParentId: null,
    };
  },
};
