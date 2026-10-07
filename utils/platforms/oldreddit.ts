/** The old.reddit.com adapter.
 *
 *  Reddit serves two separate applications, and this is the legacy one. `old.reddit.com`
 *  answers 200 with no redirect and renders a table-based DOM that shares NOTHING with the
 *  shreddit app the apex serves: measured 2026-10-03, the page carries zero `shreddit-*`
 *  elements, and every anchor `reddit.ts` reads is absent from it. So this is its own
 *  adapter rather than a second branch inside that one, and the two share no code beyond
 *  the shape of a `MainTweet`.
 *
 *  Every anchor below was measured on the legacy DOM rather than inherited from a habit:
 *
 *  - A post is `div.thing.id-t3_x.link`, a comment `div.thing.id-t1_x.comment`. Both state
 *    their id in `data-fullname` (`t3_…`/`t1_…`) and their author in `data-author`. The `id`
 *    attribute says the same thing with a `thing_` prefix, and `data-fullname` is read
 *    because it is the bare value Reddit's own API uses.
 *  - A post's body lives at `.expando > form.usertext > .usertext-body > .md`; a comment's
 *    at `.entry > form.usertext > .usertext-body > .md`. A comment's `.entry` was measured to
 *    contain ZERO nested things (its replies live in a `.child` div that is a SIBLING of
 *    `.entry`), which is what makes `:scope > .entry …` a safe way to read a comment's own
 *    body rather than one of its descendants'.
 *  - The header line is `p.tagline` in both cases — directly under `.entry` for a comment,
 *    under `.top-matter` for a post. It is inline content, not a flex row, so the buttons are
 *    placed with a right float (see `placeButtons`).
 *  - A comment's PARENT is stated nowhere in the markup: measured on 154 replies,
 *    `data-parent-fullname` appears zero times. The DOM nesting is therefore the only source,
 *    and it is the true one-level edge — a reply is a descendant of its parent's thing. A
 *    top-level comment has no thing ancestor at all (its ancestry runs
 *    `.sitetable.nestedlisting → .commentarea → .content → body`), so the walk stops at the
 *    submission, which is also what makes `closest`-style walking here unable to escape into
 *    the post.
 *  - No language is stated anywhere: `.md` carries no `lang`, there is no per-post language
 *    attribute, and `html.lang` is the READER's locale rather than the post's. Every post
 *    therefore falls to the shared unknown-language fallback, which is the honest answer.
 *  - Ads carry NO exclusion code, for the same reason the shreddit adapter's do not: a
 *    promoted thing is marked on itself (`class="promoted"`, `data-promoted="true"`) and is
 *    filtered out of `captureRoots`. This account is served none (measured across 339 KB of
 *    front-page and r/all HTML: zero), so the marker is taken from Reddit's own vocabulary
 *    rather than from a live specimen — but it costs nothing and it is the flag the platform
 *    documents.
 *  - A LISTING row is a headline and a LINK to a post, not the post. This front end holds a
 *    self-post's body back on a listing entirely (measured on 25 self-posts: `.expando` renders
 *    `expando-uninitialized` around a `span.error` reading "loading...", and the listing as
 *    SERVED carries no body either — 308 KB with zero `thing` and zero `usertext-body`
 *    occurrences), and a link post's whole text on a listing is its title. So a post is read on
 *    its OWN page — Reddit's `…/comments/<id>/…` shape — where the self-text is painted open at
 *    its natural height (measured at 845 characters inside a plain `div.expando` carrying no
 *    expander control at all), and nowhere else. This is not a workaround for the held-back
 *    body; it is the answer to it. Asking the host for a row's body costs a paced network fetch
 *    (measured: 24 serialized clicks, 12 served, 13 still stranded two minutes later), and what
 *    it buys is the post's words read as a row — a surface where the reader sees a headline, not
 *    a post. Offering to fact-check that would be offering to check something the reader is not
 *    reading. The reader who wants the post opens it, which is the same click, made by the
 *    person who wants the result.
 *
 *  One thing this adapter deliberately does NOT do is reuse `reddit.ts`'s id namespace. The
 *  stored classification is keyed on the hash of the post's TEXT, not on the id, so the two
 *  adapters still share a row whenever they produce the same string — which is the case the
 *  namespace would have been protecting. What a shared namespace would have ADDED is a
 *  collision: the id is what the background fans a classification out BY, so a post held
 *  under `reddit:t3_x` in a www tab and under the same id in an old.reddit tab would have one
 *  tab's claims painted onto the other's text the moment the two renders differed by a
 *  character. Two namespaces cannot do that, and cost nothing. */
import type { MainTweet, Usertype } from '../../data/Tweets';
import { Usertype as UsertypeEnum } from '../../data/Tweets';
import { PLATFORM_HOSTS } from './hosts';
import { LONG_FORM_CHARS } from './types';
import type { CapturedPost, PlatformAdapter, TextRegion } from './types';

/** This adapter's own namespace. See the header for why it is not `reddit:`. */
const ID_PREFIX = 'oldreddit:';

function namespaced(fullname: string): string {
  return ID_PREFIX + fullname;
}

/** A comment permalink is `/r/<sub>/comments/<postid>/<slug>/<commentid>/` — the comment id is
 *  the LAST path segment, and there is no literal `comment` segment to key on (which is the
 *  shape the shreddit adapter's own regex reads). The slug is optional in Reddit's router but
 *  always present on a permalink the site itself generates, and a URL carrying the post id
 *  alone must be read as a POST, so this is tried before the post pattern. */
const COMMENT_PERMALINK_RE = /\/comments\/[^/]+\/[^/]+\/([a-z0-9]+)\/?$/i;
const POST_PERMALINK_RE = /\/comments\/([a-z0-9]+)/i;

/** Reddit shows no verification badge, and this front end shows less than the modern one —
 *  no `usertype` at all, and "mod"/"OP"/flair markers are per-subreddit roles rather than
 *  verification. So every account is `Regular`, exactly as it is on the shreddit adapter. */
const OLDREDDIT_USERTYPE: Usertype = UsertypeEnum.Regular;

const THING_SEL = '.thing.link, .thing.comment';

/** How a post's title and body are joined in the classified text. Two newlines, so the worker
 *  reads them as separate paragraphs. Kept identical to the shreddit adapter's, so a post whose
 *  text is the same on both front ends hashes to the same stored row. */
const POST_JOIN = '\n\n';

/** Whether the page being read IS a post — Reddit's own permalink shape, `…/comments/<id>/…`.
 *
 *  A listing row is a headline and a link; the post is on the other side of that link, and this
 *  front end does not even put its body in the page (see the header). So a thing is read as a
 *  post only on a page that is ABOUT a post, which is also the only surface where the reader is
 *  reading the words being checked. Comments state their own text wherever they appear and are
 *  not gated by this. */
function onPostPage(): boolean {
  return POST_PERMALINK_RE.test(location.pathname);
}

function isPostRoot(root: Element): boolean {
  return root.classList.contains('thing') && root.classList.contains('link') && onPostPage();
}

function isCommentRoot(root: Element): boolean {
  return root.classList.contains('thing') && root.classList.contains('comment');
}

/** The legacy front end marks a promoted thing on the thing itself. */
function isPromoted(root: Element): boolean {
  return root.classList.contains('promoted') || root.getAttribute('data-promoted') === 'true';
}

function fullnameOf(root: Element): string | null {
  return root.getAttribute('data-fullname') || null;
}

/** A post's headline anchor. The `(self.<sub>)` suffix old.reddit shows beside a self post is
 *  a SIBLING `span.domain`, not part of this anchor, so the title read here is the title. */
function titleElement(root: Element): Element | null {
  return root.querySelector(':scope > .entry .top-matter a.title')
    ?? root.querySelector('a.title');
}

/** The element a post's BODY renders into, on the post's own page — the only page a post is
 *  read from. Measured path: `.expando > form.usertext > .usertext-body > .md`. A LINK post
 *  has none, which is how its title comes to be its whole text. */
function postBodyElement(root: Element): Element | null {
  return root.querySelector('.expando .usertext-body .md')
    ?? root.querySelector('.expando .md');
}

/** The element a COMMENT's own body renders into. Scoped to the thing's own `.entry`, whose
 *  replies are not inside it (see the header), so this can only ever return this comment's
 *  text and never a reply's. */
function commentBodyElement(root: Element): Element | null {
  return root.querySelector(':scope > .entry .usertext-body .md')
    ?? root.querySelector(':scope > .entry .md');
}

/** The header line our buttons join: `p.tagline`, under `.top-matter` on a post and directly
 *  under `.entry` on a comment. Scoped to `.entry` so a comment resolves to its own tagline
 *  rather than a nested reply's. */
function taglineOf(root: Element): Element | null {
  return root.querySelector(':scope > .entry .tagline')
    ?? root.querySelector(':scope > .tagline');
}

/** The submission a comment belongs to. Read from the comment's own permalink, which names it
 *  (`/comments/<postid>/…`), and falling back to the page's post thing — a comments page is
 *  about exactly one submission, so that fallback is exact rather than a guess. */
function submissionFullname(root: Element): string | null {
  const match = (root.getAttribute('data-permalink') || '').match(POST_PERMALINK_RE);
  if (match) return `t3_${match[1]}`;
  return document.querySelector('.thing.link')?.getAttribute('data-fullname') ?? null;
}

/** The comment a comment directly replies to, or null when it is top-level.
 *
 *  The DOM nesting is the only source — the markup states no parent edge at all (measured:
 *  zero of 154 replies carry `data-parent-fullname`). The walk takes the nearest ancestor
 *  comment thing that HAS a fullname rather than simply the nearest one, because a deleted
 *  comment keeps its thing in the tree with the attribute stripped (measured: 3 of 154
 *  replies sit under exactly such a stub). Naming its own parent is impossible there, and
 *  reaching past the stub to the nearest namable ancestor is the honest reading — the
 *  alternative is the submission, which would assert "replies to the post" for a comment
 *  that does not. */
function parentCommentFullname(root: Element): string | null {
  for (let el = root.parentElement, hops = 0; el && hops < 128; el = el.parentElement, hops++) {
    if (el.classList.contains('thing') && el.classList.contains('comment')) {
      const fullname = el.getAttribute('data-fullname');
      if (fullname) return fullname;
    }
  }
  return null;
}

function postParts(root: Element): { el: Element; text: string }[] {
  const parts: { el: Element; text: string }[] = [];
  const titleEl = titleElement(root);
  const title = titleEl?.textContent?.trim() ?? '';
  if (titleEl && title) parts.push({ el: titleEl, text: title });
  const bodyEl = postBodyElement(root);
  const body = bodyEl?.textContent?.trim() ?? '';
  // A link post has no body and its title IS its whole text; a self post's body is rendered on
  // the post's own page, which is the only page this adapter reads a post from (see
  // `onPostPage`). So there is nothing to recover here and nothing to remember.
  if (bodyEl && body) parts.push({ el: bodyEl, text: body });
  return parts;
}

/** A post's text as one string — the title, then the body. Must stay EXACTLY the
 *  concatenation of `postRegions`' slices: the highlight layer rewrites each region with the
 *  segments cut out of this string. */
function postText(root: Element): string {
  return postParts(root).map(p => p.text).join(POST_JOIN);
}

/** `postParts` as ranges into `postText`. */
function postRegions(root: Element): TextRegion[] {
  const regions: TextRegion[] = [];
  let at = 0;
  for (const part of postParts(root)) {
    regions.push({ el: part.el, start: at, end: at + part.text.length });
    at += part.text.length + POST_JOIN.length;
  }
  return regions;
}

function commentText(root: Element): string {
  return commentBodyElement(root)?.textContent?.trim() ?? '';
}

function captureRoots(): Element[] {
  const out: Element[] = [];
  for (const root of document.querySelectorAll(THING_SEL)) {
    if (!isPromoted(root)) out.push(root);
  }
  return out;
}

function postRoots(id: string): Element[] {
  const out: Element[] = [];
  for (const root of captureRoots()) {
    const fullname = fullnameOf(root);
    if (fullname && namespaced(fullname) === id) out.push(root);
  }
  return out;
}

export const oldRedditAdapter: PlatformAdapter = {
  id: 'oldreddit',
  hosts: PLATFORM_HOSTS.oldreddit ?? [],

  postIdFromUrl(url) {
    const comment = url.pathname.match(COMMENT_PERMALINK_RE);
    if (comment) return namespaced(`t1_${comment[1]}`);
    const post = url.pathname.match(POST_PERMALINK_RE);
    if (post) return namespaced(`t3_${post[1]}`);
    return null;
  },

  postRoots,

  /** Whether a post's body is long enough that a selection inside it is read as a passage
   *  rather than as a click on the post.
   *
   *  This front end never clamps a body it is showing — measured on a post's own page, the
   *  self-text renders whole at its natural height with no `max-height` and no "more" control
   *  — so the threshold is the platform-neutral one (see LONG_FORM_CHARS)
   *  rather than a number read off a host cut. Posts on this front end routinely reach it.
   *
   *  Comments are never long-form: a comment keeps its buttons and a selection inside it
   *  fires the comment whole, as on every platform. A link post has no body at all, so it can
   *  never reach the threshold — which is correct: its title is a headline, not a passage. */
  isLongForm(root) {
    if (!isPostRoot(root)) return false;
    const body = postBodyElement(root);
    return !!body && (body.textContent?.trim().length ?? 0) >= LONG_FORM_CHARS;
  },

  postIdOf(root) {
    const fullname = fullnameOf(root);
    return fullname ? namespaced(fullname) : null;
  },

  textElement(root) {
    return isPostRoot(root)
      ? postBodyElement(root) ?? titleElement(root)
      : commentBodyElement(root);
  },

  textRegions(root) {
    // A comment is one block and takes the ordinary single-element path; only a post is split
    // between a title and a body.
    if (!isPostRoot(root)) return null;
    return postRegions(root);
  },

  // A legacy Reddit body is server-rendered markdown — links, blockquotes, list items, code.
  // Rebuilding it from the classified text would flatten all of that, so highlights wrap the
  // page's own text nodes in place.
  highlightInPlace: true,

  placeButtons(container, root) {
    // The tagline is inline content, not a flex row, so there is no `margin-left: auto` to
    // push with: a right float is the equivalent, and it lands the pill at the end of the
    // line its text is on — the same position a comment's header takes on Facebook, and the
    // one the requirement asks for (`submitted 1y ago by Author  [Disinfact]`).
    //
    // Appending to the tagline rather than to the thing puts the buttons on the header line
    // for both kinds: a post's own control row (`ul.flat-list.buttons`) is a SIBLING of the
    // tagline inside `.entry`, so the line above it is the header, not the action row.
    //
    // Left DETACHED when there is no tagline, rather than appended somewhere plausible — see
    // `placeButtons` in types.ts: a post carrying our buttons is one the selection rule hands
    // the reader's selection off to, so a misplaced pill costs them the web-select path too.
    const tagline = taglineOf(root);
    if (!tagline) return;
    container.style.marginLeft = '8px';
    // A comment's buttons go immediately to the RIGHT of its own timestamp — `user 1 point
    // 1 year ago [Disinfact]` — the position every platform here shares. The tagline spans the
    // whole column and a comment's time sits near its left end, so the right float a POST takes
    // would park a comment's pill some 400px from the time it belongs to.
    if (isCommentRoot(root)) {
      container.style.float = '';
      let anchor: Element | null = tagline.querySelector('time');
      while (anchor && anchor.parentElement !== tagline) anchor = anchor.parentElement;
      if (anchor && anchor !== tagline) {
        anchor.insertAdjacentElement('afterend', container);
        return;
      }
      tagline.appendChild(container);
      return;
    }
    container.style.float = 'right';
    tagline.appendChild(container);
  },

  feedCenter() {
    // `#siteTable` holds the submission and its comment area. The viewport center would put
    // the floating buttons over the sidebar.
    const column = document.querySelector('#siteTable') ?? document.querySelector('.content');
    if (!column) return null;
    const rect = column.getBoundingClientRect();
    return rect.width > 0 ? rect.left + rect.width / 2 : null;
  },

  isPostTarget(id) {
    return postRoots(id).length > 0;
  },

  postElementFor(node) {
    const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    return el?.closest(THING_SEL) ?? null;
  },

  captureRoots,

  capture(root: Element): CapturedPost | null {
    const fullname = fullnameOf(root);
    if (!fullname) return null;
    const isPost = isPostRoot(root);
    if (!isPost && !isCommentRoot(root)) return null;

    const text = isPost ? postText(root) : commentText(root);
    // Nothing to fact-check: a deleted stub, a media-only post, a comment body the host has
    // not rendered. Returning null keeps it out of the batch rather than spending a
    // classification on an empty string.
    if (!text) return null;

    const post = {
      id: namespaced(fullname),
      text,
      // The DOM is the only source here, so the displayed text IS the raw text.
      fullText: text,
      username: root.getAttribute('data-author') ?? '',
      usertype: OLDREDDIT_USERTYPE,
      // A comment sits in its submission's thread; a post is its own thread.
      conversationId: namespaced(isPost ? fullname : (submissionFullname(root) ?? fullname)),
      // This front end renders a crosspost as a repost that adopts the original's title and
      // carries none of its body, so there is no quoted text on the page to attribute — the
      // same finding the shreddit adapter records, and read the same way.
      quoting: null,
      replyingTo: null,
    } as MainTweet;

    // No language is stated on this front end (see the header), so `sourceLanguage` is left
    // absent and `nameCapturedLanguage` fills in the shared unknown key — which is what a
    // reader's own locale must NOT be used to guess at.

    // The direct parent, left as an id for `hydrateReplyChains` to resolve against the rest of
    // the batch. A top-level comment's parent is its submission, which is also the post this
    // page renders, so the chain links without a network call.
    let replyParentId: string | null = null;
    if (!isPost) {
      const parent = parentCommentFullname(root) ?? submissionFullname(root);
      replyParentId = parent ? namespaced(parent) : null;
    }

    return { post, replyParentId };
  },
};
