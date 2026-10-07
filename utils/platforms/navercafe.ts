/** The Naver Cafe adapter.
 *
 *  Naver Cafe (`cafe.naver.com`) is Korea's largest community platform: a "cafe" is a
 *  forum, and it holds boards of posts whose readers are the cafe's members. It is the
 *  first platform in this rollout whose own UI puts content somewhere other than the top
 *  document, and that fact shapes everything below.
 *
 *  **Comments only.** A cafe post is a long-form post — a title, a smart-editor body of
 *  paragraphs and images, and comments under it — i.e. the same kind of surface as a
 *  Substack article, and it gets the same treatment: no buttons, no classification, and the
 *  ordinary web text selection / right-click flow instead. The post's COMMENTS are the
 *  social unit and are integrated first-class, buttons and all. So are a comment's replies.
 *  A board's list of posts is dropped for the same reason its posts are: every row is a
 *  view of one of those long posts, which is exactly the "article rendered as a card in the
 *  reader's post lists" case that carries no buttons on Substack.
 *
 *  See `substack-social-surfaces-only`: per-claim buttons belong on the short social unit,
 *  and long-form prose is what the selection flow is for.
 *
 *  **Where a comment renders.** An article's comments live inside a same-origin iframe:
 *  the page is Naver's cafe chrome, and the post — its title, its writer line, its body, its
 *  comments and the comment box — all live inside `#cafe_main`, which Naver sizes to the
 *  frame's OWN content (measured: 10,998px of frame for a post whose reader sees 819px). So
 *  the frame never scrolls; the document above it does. This is the reason `frameScoped`
 *  exists (see types.ts) and the reason the coordinator measures "on screen" through the top
 *  window's viewport.
 *
 *  **The mobile reader.** `m.cafe.naver.com` is NOT that desktop reader at a narrow width: it
 *  is a `/ca-fe/` SPA that serves the whole article in one document with ZERO iframes, and it
 *  names none of the desktop anchors. It is integrated from the same adapter (the host rule
 *  already covers the subdomain — `*://*.cafe.naver.com/*` — so a coordinator is installed
 *  there either way, and the choice is between anchoring on it and finding nothing). Its
 *  comments are measured as `ul.comment_list > li`, named on `a.user > .nick_name` and worded
 *  in `.comment_content`; see `COMMENT_MOBILE` and the identity note below.
 *
 *  The consequence worth stating: because a comment is the only thing here that is a post,
 *  the class of "text the user selected that is NOT part of a post" is large on this
 *  platform — the whole article body is web text by design. `postElementFor` returns a
 *  comment only from inside a comment, so a selection anywhere in the article falls through
 *  to the web selection flow rather than being handed to a post.
 *
 *  **Anchors.** Naver serves a Next.js app whose presentational classes carry build hashes
 *  (`LevelIcon_LevelIcon__zegm_`, `AttachInfoBadge_wrap__czIf2`), and this rollout refuses
 *  those: they change on every deploy. Every anchor here is a semantic class Naver's own
 *  markup is written in — `CommentItem`, `comment_nick_box`, `comment_nickname`,
 *  `text_comment` — plus two ids (`#cafe_main`, and the numeric comment id Naver puts on
 *  each `li`, the same value the comment's reaction module carries as `data-cid`).
 *
 *  **Truncation.** Decided per surface from the rendered state (see
 *  `truncated-means-excluded`). Measured on two articles: no comment is clipped — the
 *  longest comment runs 129 characters, `overflow` is `visible` and no expander exists, so
 *  every comment is integrated whole. A comment Naver ever does clip will need this catch
 *  again, per root, at capture time.
 *
 *  **Padding.** Naver's comment markup carries the comment's words several times over,
 *  separated by long runs of `<br>` — the server's own reply, not a rendering artifact, and
 *  the reason `stripPadding` exists. It is removed at capture time, before the words are
 *  read, because the padding is not only wrong text to classify: it is 18,000px of element
 *  that no comment should be measured by, and it sits inside the very element the highlighter
 *  indexes its offsets against.
 *
 *  **One id, one text.** A comment is addressed by a name under the article it belongs to, and
 *  the two readers name a comment differently.
 *
 *  The desktop reader puts a NUMERIC id on the `li` (the same value the comment's reaction
 *  module carries as `data-cid`). That is used as-is: it is stable across renders and, unlike an
 *  ordinal, survives a comment being deleted, which would renumber every comment below it and
 *  leave one id naming two different texts — the collision `post-id-names-one-text` exists to
 *  prevent.
 *
 *  The mobile reader states NO id at all: measured, the `li` has no `id`, no `data-cid`, and
 *  nothing but Vue scope attributes (`data-v-…`), which are build hashes and so are exactly what
 *  this rollout refuses to anchor on. An ordinal is refused for the reason above. What is left
 *  is the comment's own words, so a mobile comment is named by a 64-bit digest of its author and
 *  its text (`wordsDigest`) — which survives a deletion the same way, and is stable across
 *  renders, because both fields are. Two consequences worth stating: a mobile comment that is
 *  EDITED answers to a new name, which is right — the text it names changed too; and Naver's
 *  pinned "best" comment is a second rendering of one already in the list (`best_comment`,
 *  measured on a real article), which the digest deliberately collapses onto ONE name, so the
 *  two renderings stay one comment rather than being classified twice.
 */
import type { MainTweet, Usertype } from '../../data/Tweets';
import { Usertype as UsertypeEnum } from '../../data/Tweets';
import { passageTextContent } from '../injecting';
import { PLATFORM_HOSTS } from './hosts';
import type { CapturedPost, PlatformAdapter } from './types';

/** Naver Cafe ids are namespaced for the same reason every platform's after X are: the
 *  background fans a classification out to *every* connected relay rather than keying by
 *  tab, so a bare article number could otherwise be injected into an unrelated page. */
const ID_PREFIX = 'navercafe:';

/** Separates an article's id from one of its comments. */
const COMMENT_SEP = '#';

/** A comment, the line its nickname is on, its name, and its words — the DESKTOP reader, which
 *  renders inside the article frame. */
const COMMENT = 'li.CommentItem';
const COMMENT_REPLY = 'CommentItem--reply';
const COMMENT_NICK_BOX = '.comment_nick_box';
const COMMENT_NICKNAME = '.comment_nickname';
const COMMENT_TEXT = 'span.text_comment';

/** The MOBILE reader, which is a different app rather than the desktop one at a narrow width.
 *
 *  `m.cafe.naver.com` does not serve the frame the desktop reader nests its article in — measured,
 *  the mobile article is one document with ZERO iframes — and it names none of the desktop
 *  anchors. What it does serve is a `/ca-fe/` SPA whose comments are these: a `li` per comment
 *  (classed `reply` for a reply, `best_comment` for the pinned copy) inside the same
 *  `ul.comment_list`, with the name on `a.user > .nick_name` and the words on `.comment_content`.
 *
 *  Every one of those is a class Naver's markup is written in rather than a build hash, the same
 *  kind of anchor the desktop set uses. `best_comment` matters: a pinned comment is rendered
 *  TWICE, once pinned and once in the list (measured), and the identity below is what keeps those
 *  two renderings one comment rather than two. */
const COMMENT_MOBILE = 'ul.comment_list > li';
const COMMENT_REPLY_MOBILE = 'reply';
const COMMENT_HEADER_MOBILE = '.comment_header';
const COMMENT_NICKNAME_MOBILE = '.comment_header a.user .nick_name';
const COMMENT_TEXT_MOBILE = '.comment_content';

/** Marks an id built from a comment's own words rather than read off the element. A decimal
 *  desktop id and a `w`-prefixed digest cannot be mistaken for one another, and they share a key
 *  space — both are what a comment is addressed by. */
const WORDS_ID_PREFIX = 'w';

/** The list the comments are rendered into, and the box that holds it. Both are Naver's own
 *  semantic names, and they are read only to center the floating buttons over the column the
 *  comments occupy — never to find a post. */
const COMMENT_LIST = 'ul.comment_list';
const COMMENT_BOX = '.CommentBox';

/** How Naver breaks a paragraph inside a comment. Two `<br>`, measured — and the number the
 *  padding is told apart by, because Naver's padding runs are tens of `<br>` long. */
const COMMENT_PARAGRAPH_BRS = 2;

/** The two shapes an article's own URL takes: the current `/cafes/<cafeId>/articles/<id>`
 *  route, which is also what the frame itself is served, and the legacy
 *  `ArticleRead.nhn?clubid=…&articleid=…` the frame is still given on some paths. An
 *  article's id is not an id any post here has — it is the namespace a comment's id lives
 *  under, and the conversation every comment on the article belongs to. */
const ARTICLE_PATH = /\/cafes\/(\d+)\/articles\/(\d+)/;

/** Naver Cafe has no verified-account concept. Its marks are cafe-rank cosmetics (a level
 *  icon whose meaning is the cafe's own) and a "written by the author" flag Naver puts on a
 *  post author's own comments; neither says anything about the account behind the words, so
 *  every account is `Regular` rather than inferred from a mark that means something else. */
const NAVER_USERTYPE: Usertype = UsertypeEnum.Regular;

/** Which cafe and which article a location names, or null when it names neither. */
interface ArticleRef {
  cafe: string;
  article: string;
}

function namespaced(id: string): string {
  return ID_PREFIX + id;
}

/** A comment's words, as the highlighter indexes them.
 *
 *  Naver breaks a comment's lines with `<br>`, and `textContent` contributes nothing for one, so
 *  the plain read welds them together: measured on this article, 20 of 46 comment bodies carry a
 *  `<br>` and every one of them read back short of what the page renders — a two-line comment
 *  arrived as `…시간당 0.5리터가스 : 키로당…`, one run of words no reader ever saw. Each `<br>` is
 *  worth exactly one character of `innerText`, measured, which is why the fix is to read it as
 *  the newline it renders rather than to guess at the text.
 *
 *  `passageTextContent` is also what the in-place highlighter indexes, and that is the point
 *  rather than a convenience: the classified string and the offsets into it must be one string,
 *  or a claim's offsets land on words the reader cannot see. Its chrome-dropping matters here for
 *  the same reason. */
function passageText(el: Element | null | undefined): string {
  return el ? passageTextContent(el as HTMLElement).trim() : '';
}

/** Text of an element, or '' when it is missing — the shape every adapter's `textOf` has. */
function textOf(el: Element | null | undefined): string {
  return el?.textContent?.trim() ?? '';
}

/** The cafe and article a URL names, from either of the two shapes Naver uses. */
function articleRef(url: URL | Location): ArticleRef | null {
  const path = url.pathname.match(ARTICLE_PATH);
  if (path) return { cafe: path[1], article: path[2] };
  // A `Location` has no `searchParams` of its own, and both of the two shapes are read here
  // rather than only the `URL` one because a comment's article id comes off `location`.
  const search = new URL(url.href).searchParams;
  const cafe = search.get('clubid');
  const article = search.get('articleid');
  return cafe && article ? { cafe, article } : null;
}

/** The cafe and article THIS document is showing. The article frame is served the same cafe
 *  and article ids as the page around it, so a comment's article is read from the frame's
 *  own location. */
function pageId(): string | null {
  const ref = articleRef(location);
  return ref ? `${ref.cafe}:${ref.article}` : null;
}

/** The name and words of a mobile comment, read the ONE way — so that the id a comment is
 *  addressed by and the text it is captured as can never be computed from different reads.
 *
 *  Naver's padding is stripped here rather than at the call sites because the mobile reader is
 *  read from five of them (the id, the roots, the text element, placement and the capture); with
 *  the strip anywhere else the digest would be taken over words the capture never saw, and one
 *  comment would answer to an id derived from text the rest of the pipeline does not hold.
 *  `stripPadding` is idempotent, so a later call is a no-op. */
function mobileFields(root: Element): { username: string; text: string } | null {
  const body = root.querySelector(COMMENT_TEXT_MOBILE);
  if (!body) return null;
  stripPadding(body);
  const text = passageText(body);
  const username = textOf(root.querySelector(COMMENT_NICKNAME_MOBILE));
  return text && username ? { username, text } : null;
}

/** The digest of a comment's author and its words.
 *
 *  The mobile `li` carries no id of any kind — measured: no `id`, no `data-cid`, only Vue scope
 *  attributes (`data-v-…`), which are build hashes and so are exactly what this rollout refuses
 *  to anchor on. A POSITION will not do either: deleting a comment would renumber every comment
 *  below it and leave one id naming two different texts, the collision `post-id-names-one-text`
 *  exists to prevent. Its own words survive all of that, and they are what the DB is keyed on.
 *
 *  Two accumulators rather than one: this is an IDENTITY, and 64 bits over a thread is not a risk
 *  worth taking for four lines. The separator is a unit separator, which no comment can contain. */
function wordsDigest(username: string, text: string): string {
  const words = `${username}${text}`;
  let a = 5381;
  let b = 2166136261;
  for (let i = 0; i < words.length; i++) {
    const c = words.charCodeAt(i);
    a = ((a * 33) ^ c) >>> 0;
    b = Math.imul(b ^ c, 16777619) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/** The id a mobile comment is addressed by, or null when it states no words or no name. */
function mobileCommentId(root: Element): string | null {
  const fields = mobileFields(root);
  return fields ? WORDS_ID_PREFIX + wordsDigest(fields.username, fields.text) : null;
}

/** Whether a root is a reply. The two readers mark it differently — a class on the desktop
 *  reader's own element, a class on the mobile reader's `li` — and neither class exists on the
 *  other's markup. */
function isReply(root: Element): boolean {
  return root.matches(COMMENT)
    ? root.classList.contains(COMMENT_REPLY)
    : root.matches(COMMENT_MOBILE) && root.classList.contains(COMMENT_REPLY_MOBILE);
}

/** The id a root stands for, or null when it is not a post this adapter integrates.
 *
 *  A comment is the only post here — see this file's header on why the article and the
 *  board's rows are not. The desktop reader names a comment, the mobile reader's comments are
 *  named by their own words (see `mobileCommentId`). */
function postIdOf(root: Element): string | null {
  const page = pageId();
  if (!page) return null;
  const id = root.matches(COMMENT) ? root.id : root.matches(COMMENT_MOBILE) ? mobileCommentId(root) : null;
  return id ? namespaced(`${page}${COMMENT_SEP}${id}`) : null;
}

/** The comment a reply answers: the nearest comment above it that is not itself a reply.
 *
 *  Naver renders a thread's replies flat in one `ul.comment_list`, immediately after the
 *  comment they answer, and marks only the reply — so the parent is a POSITION, which is
 *  the same way Quora's adapter reads its nesting. Consecutive replies to one comment each
 *  walk past their siblings to the same parent. */
function commentParentId(root: Element): string | null {
  if (!isReply(root)) return null;
  let prev = root.previousElementSibling;
  while (prev && isReply(prev)) prev = prev.previousElementSibling;
  return prev ? postIdOf(prev) : null;
}

/** Every comment on the page, in the reader that is serving it.
 *
 *  The desktop reader answers first and only when it has comments at all: no page is served by
 *  both readers, so the two sets are never mixed, and a desktop article with its comments not
 *  yet rendered falls through to the mobile selector, which finds nothing there either. */
function commentRoots(): Element[] {
  const desktop = Array.from(document.querySelectorAll(COMMENT));
  if (desktop.length) return desktop;
  return Array.from(document.querySelectorAll(COMMENT_MOBILE)).filter((root) => isMobileComment(root));
}

/** Whether a `li` in a comment list is one this adapter integrates — the mobile reader's
 *  comments state their words and their name, and a pinned comment is a second rendering of one
 *  that is already in the list, which the digest collapses onto the same id rather than counting
 *  twice. */
function isMobileComment(root: Element): boolean {
  return root.matches(COMMENT_MOBILE) && mobileFields(root) !== null;
}

/** Where Naver's padding begins, as an index into the text element's child nodes, or -1 for
 *  a comment that carries none.
 *
 *  Naver writes a comment's words, then writes them again and again, separating the copies
 *  with long runs of `<br>`. Measured on one two-line comment: nine copies of its two lines,
 *  827 `<br>` between them, and 18,289px of page. The copies are exact, and Naver's own
 *  comments API (`article.cafe.naver.com/gw/v4/.../comments`) returns the same padded string,
 *  so the padding is the server's doing rather than a rendering artifact — a scraped blob
 *  instead of the words, which is the shape of a scraper deterrent.
 *
 *  The boundary is the first run of more than `COMMENT_PARAGRAPH_BRS` breaks, which is
 *  longer than the break Naver's own editor writes between paragraphs — and it is only
 *  treated as a boundary when the words after it repeat the first line of the comment, so a
 *  comment whose author really did type two blank lines is cut only if it also repeats itself
 *  word for word. Returned at the start of the run rather than at the repeated words, so the
 *  blank run goes with the copies it separates. */
function paddingStart(body: Element): number {
  const children = body.childNodes;
  let breaks = 0;
  let runStart = 0;
  let firstLine: string | null = null;
  for (let i = 0; i < children.length; i++) {
    const node = children[i];
    if (node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === 'BR') {
      if (breaks === 0) runStart = i;
      breaks += 1;
      continue;
    }
    if (node.nodeType !== Node.TEXT_NODE) continue;
    const line = node.nodeValue?.trim();
    if (!line) continue;
    if (firstLine !== null && breaks > COMMENT_PARAGRAPH_BRS && line === firstLine) return runStart;
    if (firstLine === null) firstLine = line;
    breaks = 0;
  }
  return -1;
}

/** Drop Naver's padding, leaving the text element holding the comment once.
 *
 *  The repetitions are not the comment, and leaving them in costs three things. `capture`
 *  reads the element's text, so it would classify the words over and over as one run. The
 *  highlighter indexes that element's text nodes and refuses to paint when their length is
 *  not the classified length — so with the padding in place NO comment could be annotated,
 *  and with the classified text trimmed but the padding still there, a claim's offsets would
 *  resolve into a padding copy thousands of pixels below the words. And the element measures
 *  18,000px tall, which is what makes every comment on the page answer `nearViewport`.
 *
 *  Runs once, before the comment is read: a second call finds no padding and does nothing. */
function stripPadding(body: Element | null): void {
  if (!body) return;
  const start = paddingStart(body);
  if (start < 0) return;
  while (body.childNodes.length > start) body.removeChild(body.lastChild as Node);
}

export const naverCafeAdapter: PlatformAdapter = {
  id: 'navercafe',
  hosts: PLATFORM_HOSTS.navercafe ?? [],
  // Every comment is inside the article frame, and the frame is served the article's own
  // ids. Without this the coordinator would bail in the frame and nothing would be
  // integrated at all.
  frameScoped: true,

  postIdFromUrl(url) {
    const ref = articleRef(url);
    // The article names the thread its comments belong to, which is the id a comment's
    // parent falls back to — but the article itself is not a post, so nothing is injected
    // from this id on its own.
    return ref ? namespaced(`${ref.cafe}:${ref.article}`) : null;
  },

  postRoots(id) {
    return commentRoots().filter((root) => postIdOf(root) === id);
  },

  postIdOf,

  textElement(root) {
    if (root.matches(COMMENT)) return root.querySelector(COMMENT_TEXT);
    return root.matches(COMMENT_MOBILE) ? root.querySelector(COMMENT_TEXT_MOBILE) : null;
  },

  // A comment's text is markup rather than a plain run: it can carry an emoji, a link or a
  // sticker. Rebuilding it from the classified string would flatten all of that into the
  // comment's own words, so highlights go over the page's own text nodes.
  highlightInPlace: true,

  placeButtons(container, root) {
    const mobile = !root.matches(COMMENT) && root.matches(COMMENT_MOBILE);
    if (!root.matches(COMMENT) && !mobile) return;
    // The buttons go at the right-hand end of the line the commenter's NAME is on — the
    // same place they take on X, Reddit, Substack, Dcard, Quora and PTT.
    //
    // That line is a block of INLINE content rather than a flex row, so the idiom the other
    // adapters use (`marginLeft: auto` on a flex row) does nothing here, and the block's own
    // text would put the container on a line of its own instead. A right float is the
    // equivalent: it is placed at the right-hand end of the line its text is on, and the
    // text flows around it exactly as it would around a word. Measured: the container lands
    // at that line's right-hand end (721..798 of a line ending at 798) and the comment's
    // height is unchanged.
    // The mobile reader's name line is a FLEX row (measured `display:flex` / `flex-wrap:nowrap`),
    // and a float is ignored on a flex item: measured with the float in place, the container sat
    // 50-128px short of the row's right edge, right after the name. An auto inline-start margin is
    // the flex equivalent, and it is what every other adapter's flex row uses.
    if (mobile) {
      container.style.marginLeft = 'auto';
    } else {
      container.style.float = 'right';
      container.style.marginLeft = '8px';
    }
    // The mobile reader puts the name on `.comment_header` rather than `.comment_nick_box`, but
    // it is the same line of the same comment — the row the commenter's name is on — so the
    // buttons go to the same end of it.
    const line = root.querySelector(mobile ? COMMENT_HEADER_MOBILE : COMMENT_NICK_BOX);
    // No line found: the container stays detached rather than being dropped somewhere
    // plausible. A post carrying our buttons is a post the selection rule hands the user's
    // selection off to, so a misplaced pill would also cost the user the web-select path on
    // that post. Detached, the post keeps working: it simply has no buttons. See
    // `placeButtons` in types.ts.
    if (line) line.appendChild(container);
  },

  feedCenter() {
    // The column the comments occupy, which is the column the article's own text occupies
    // too — inside the frame both start at the frame's left padding and end at its right.
    // It is the column, not the frame's viewport, that the floating buttons belong over.
    const column = document.querySelector(COMMENT_LIST) ?? document.querySelector(COMMENT_BOX);
    if (!column) return null;
    const rect = column.getBoundingClientRect();
    return rect.width > 0 ? rect.left + rect.width / 2 : null;
  },

  isPostTarget(id) {
    return commentRoots().some((root) => postIdOf(root) === id);
  },

  postElementFor(node) {
    const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    if (!el) return null;
    // Through the id, so a comment Naver renders without one is not a post here and a
    // selection inside it stays a web selection rather than being handed to a post that
    // could not be classified. Everything else on the page — the article body above all —
    // is deliberately not a post, which is what keeps the article's own text selectable.
    const comment = el.closest(COMMENT) ?? el.closest(COMMENT_MOBILE);
    return comment && postIdOf(comment) ? comment : null;
  },

  captureRoots() {
    return commentRoots();
  },

  capture(root): CapturedPost | null {
    const id = postIdOf(root);
    if (!id) return null;
    const page = pageId();
    const mobile = !root.matches(COMMENT) && root.matches(COMMENT_MOBILE);
    const body = root.querySelector(mobile ? COMMENT_TEXT_MOBILE : COMMENT_TEXT);
    stripPadding(body);
    const text = passageText(body);
    const username = textOf(root.querySelector(mobile ? COMMENT_NICKNAME_MOBILE : COMMENT_NICKNAME));
    // A comment with no words (Naver renders a sticker-only comment) carries nothing to
    // fact-check, and one with no name carries no context to classify it with. Either way
    // it stays out of the batch rather than spending a classification on it.
    if (!text || !username) return null;
    return {
      post: {
        id,
        text,
        // The DOM is the only source here, so the displayed text IS the raw text.
        fullText: text,
        username,
        usertype: NAVER_USERTYPE,
        // Every comment belongs to the article's conversation, whichever comment it answers.
        conversationId: page ? namespaced(page) : id,
        quoting: null,
        replyingTo: null,
      } as MainTweet,
      // A reply names the comment above it and a top-level comment names the article, which
      // is the post it is answering and the context a classifier most needs.
      replyParentId: commentParentId(root) ?? (page ? namespaced(page) : null),
    };
  },
};
