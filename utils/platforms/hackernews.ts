/** The Hacker News adapter.
 *
 *  HN is server-rendered `<table>` markup and the oldest in the rollout, which cuts both
 *  ways. Against it: there is no `data-testid` anywhere, so the anchors below are class
 *  names — the one place this rollout bends its "no class-name anchors" rule. For it:
 *  those classes are semantic rather than presentational (`athing` = a thing, `comtr` = a
 *  comment row, `commtext` = comment text, `titleline` = the headline, `ind` = indent),
 *  they are all that HN has ever had, and HN ships no build step and has not changed its
 *  markup in a decade. Nothing here keys on a style class, a locale string or a width.
 *
 *  The structural fact everything below rests on: **HN renders a thread as a FLAT LIST OF
 *  SIBLING ROWS.** Nesting is not in the DOM — a comment's depth is `td.ind[indent=N]`,
 *  and its replies are simply the rows that follow it. So the document order of
 *  `tr.athing[id]` is the thread in reading order, and reconstructing who replies to whom
 *  is this adapter's job rather than the DOM's gift. See `replyParentId` below.
 *
 *  **There is no network to under-use, and that is measured rather than assumed.** HN is
 *  the one platform in this rollout with nothing to intercept: a front page, an item page,
 *  `/ask`, `/newest`, `/threads` and `/newcomments` each fetched exactly seven things —
 *  the document, `news.css`, `hn.js`, `y18.svg`, `s.gif`, `triangle.svg` and the
 *  extension's own probe — and NOT ONE was XHR or fetch (measured 2026-10-01 over CDP's
 *  Network domain). Everything a reader sees arrived in the document, so there is no
 *  payload whose text could be fuller than the DOM's, and none of the fallbacks this
 *  rollout uses elsewhere apply. `sourceLanguage: 'en'` below is the one thing the network
 *  would otherwise have told us, and HN states it by policy instead.
 *
 *  **Nothing is truncated either**, so a comment's `textContent` is its whole text. On an
 *  846-comment item page: 0 comments with a clamped or hidden-overflow body, 0 carrying a
 *  "more"/"continue" link, and the longest — 2618 characters across 23 paragraphs —
 *  rendering at `height === scrollHeight` (561px) with `max-height: none`. The single
 *  comment whose text ends in an ellipsis ends in the AUTHOR's ellipsis; its length is
 *  whole. A `[-]` collapse toggle exists on all 846, but collapsing is a render of the
 *  rows below, not a cut of this row's text — see `captureRoots`.
 */
import type { MainTweet, Usertype } from '../../data/Tweets';
import { Usertype as UsertypeEnum } from '../../data/Tweets';
import { PLATFORM_HOSTS } from './hosts';
import { LONG_FORM_CHARS } from './types';
import type { CapturedPost, PlatformAdapter, TextRegion } from './types';

/** HN ids are bare integers, and they are the SAME SHAPE as an X status id's prefix — a
 *  `12345678` post id and a `1234567890123456789` status id both read as digits. The
 *  background fans a classification out to every connected relay rather than keying by
 *  tab, so ids are namespaced per platform to keep an HN row and a tweet from ever being
 *  taken for one another. */
const ID_PREFIX = 'hn:';

function namespaced(id: string): string {
  return ID_PREFIX + id;
}

/** Every post and comment row, on every HN view. Used as a single selector rather than a
 *  per-view one because HN renders the same markup on the front page, `/newest`, `/ask`,
 *  `/best`, item pages, `/threads`, `/newcomments` and a user's `/submitted` — the views
 *  differ in which rows they contain, not in how a row is built. */
const ROW_SELECTOR = 'tr.athing';

/** HN shows no verification badge: there is no concept of a verified account, and the
 *  green `<font>` some usernames carry marks an account younger than a day, which is the
 *  opposite of standing. Every HN account is therefore `Regular`. */
const HN_USERTYPE: Usertype = UsertypeEnum.Regular;

/** How a submission's headline and body are joined. Two newlines, so the worker reads
 *  them as separate paragraphs. Nothing renders the characters BETWEEN two regions, which
 *  is why the regions carry explicit offsets rather than being concatenated. */
const POST_JOIN = '\n\n';

/** The row's own id, or null for a `tr.athing` that is not a post.
 *
 *  The numeric check is load-bearing: `/user?id=X` renders the profile header as a
 *  `tr.athing` with NO id, and treating that as a post would put a DisinfaX button on a
 *  user's join date. A row with no id is not addressable anyway — nothing could ever
 *  classify it or inject into it. */
function rowId(root: Element): string | null {
  const id = root.getAttribute('id') ?? '';
  return /^\d+$/.test(id) ? id : null;
}

/** Whether a row is a submission rather than a comment.
 *
 *  HN is inconsistent about the class it uses — an item page and `/threads` mark comments
 *  `tr.athing.comtr`, `/newcomments` marks them plain `tr.athing` — so the class cannot
 *  be the discriminator. What the row CONTAINS can: a submission carries the headline in
 *  `.titleline`, a comment never does. Testing for the submission positively means an
 *  unrecognized row is treated as a comment and then discarded for having no text, rather
 *  than being mistaken for a submission and classified. */
function isSubmission(root: Element): boolean {
  return !!root.querySelector('.titleline');
}

/** Whether this document is one post's own page — `/item?id=N`, the story with its comments
 *  laid out under it.
 *
 *  Every other view HN serves is an INDEX, and the list is long: the front page, `/news`,
 *  `/newest`, `/best`, `/past`, `/ask`, `/show`, `/jobs`, `/noobstories`, `/submitted`,
 *  `/favorites`, `/upvoted`, `/from?site=`, `/threads`, `/newcomments`. On all of those a
 *  submission row is a numbered headline that LINKS to the post — the headline is the row's
 *  only content, and the post's own text is not in the document at all (see `bodyElement`).
 *  A row that links to a post is not a post, so it gets no buttons: the reader opens it and
 *  the item page has them.
 *
 *  Comments are deliberately NOT gated. A comment row renders its own text wherever it is
 *  shown, so a comment is a comment on `/threads` and `/newcomments` too, and those views
 *  keep their buttons.
 *
 *  Read from the URL, not from a class, because a class is the one thing about this markup
 *  that is genuinely unstable — `isSubmission` above exists only because an item page marks
 *  comments `tr.athing.comtr` and `/newcomments` marks the same rows plain `tr.athing`.
 *  `/item?id=<digits>` has been the item page's address for the site's whole life, and it is
 *  what `postIdFromUrl` already reads. */
function isItemView(): boolean {
  if (location.pathname !== '/item') return false;
  const id = new URLSearchParams(location.search).get('id');
  return !!id && /^\d+$/.test(id);
}

/** A row that IS a post, as opposed to a row that merely names one. */
function isPostRow(root: Element): boolean {
  return !isSubmission(root) || isItemView();
}

/** A submission's headline. The anchor, never the enclosing `.titleline` span, whose
 *  textContent also carries the site bit — `(colo.to)` on a link post — which is HN's
 *  chrome, not the post. */
function titleElement(root: Element): Element | null {
  return root.querySelector('.titleline > a') ?? root.querySelector('.titleline');
}

/** Find `selector` in the bare `<tr>` rows HN renders AFTER a submission's own row.
 *
 *  A submission is not one row. Its own `tr.athing` holds the rank, the vote arrow and
 *  the headline, and everything else about it — the subtext (score, author, age) and, for
 *  a text post, the body — sits in sibling `<tr>`s that follow, carrying no class and no
 *  id. They are not `tr.athing` either, so `querySelector`-ing inside the submission row
 *  finds neither, which is what silently cost every submission its author.
 *
 *  The scan therefore walks forward rather than querying the row, and stops at the next
 *  post so a body or an author can never be borrowed from the submission below. */
function trailingElement(root: Element, selector: string): Element | null {
  let row: Element | null = root.nextElementSibling;
  for (let hops = 0; row && hops < 6; row = row.nextElementSibling, hops++) {
    if (row.classList.contains('athing')) break;
    const hit = row.querySelector(selector);
    if (hit) return hit;
  }
  return null;
}

/** A submission's body, or null for a link post.
 *
 *  Only a text post (Ask HN, Show HN, a self post) has one, and HN renders it on the item
 *  page ONLY — every list view shows the headline alone, and it does not SEND the body to
 *  a list view at all rather than hiding it there. Measured 2026-10-01 on `/ask`: 0
 *  `.toptext` elements anywhere in the whole document, against 16 submissions on the page.
 *
 *  **That makes one submission hash two ways, and it is the one thing on this platform
 *  left unfixed** — `post-id-names-one-text` in the DB's terms. Item 49893157 is
 *  `29 + '\\n\\n' + 265` characters from its item page and that same 29 characters from its
 *  `/ask` row, under an id (`hn:49893157`) both surfaces state. The body is not truncated
 *  and not withheld behind an expander — it is simply in another document — so no DOM
 *  read can recover it here and the adapter files what the reader was shown.
 *
 *  Closing it would take a same-host fetch of `item?id=<id>` (no new permission: the
 *  Firebase API is a different origin and would require one), which the site itself never
 *  makes from a list view. Whether that is worth a request per text post per page load
 *  against a site that rate-limits, to collapse two DB rows into one, is a product call
 *  rather than a defect to settle here — and the capture path is synchronous, so it is
 *  also not a change to make in passing. The tell that a row IS a text post is free when
 *  it does get made: a text post's headline anchors to `item?id=<its own id>`. */
function bodyElement(root: Element): Element | null {
  return trailingElement(root, '.toptext');
}

/** The account behind a row.
 *
 *  A comment's header is inside its own row (`.comhead`), but a submission's is not: HN
 *  credits it in the trailing subtext row, next to the score and the posting age. Missing
 *  that made every submission reach the classifier with no author at all. */
function authorElement(root: Element): Element | null {
  return isSubmission(root)
    ? trailingElement(root, '.subtext a.hnuser')
    : root.querySelector('.comhead a.hnuser');
}

/** A comment's text. `.commtext` is present on every comment that has text to show; a
 *  deleted or flagged one renders none, which is why this can be null. */
function commentElement(root: Element): Element | null {
  return root.querySelector('.commtext');
}

/** The blocks a submission's text is made of, in reading order: the headline, then the
 *  body when there is one.
 *
 *  Both are classified as ONE post — they are one submission, and the worker cannot see
 *  that a body answers its own headline if the two arrive as separate classifications. */
function postParts(root: Element): { el: Element; text: string }[] {
  const parts: { el: Element; text: string }[] = [];
  const titleEl = titleElement(root);
  const title = titleEl?.textContent?.trim() ?? '';
  if (titleEl && title) parts.push({ el: titleEl, text: title });
  const bodyEl = bodyElement(root);
  const body = bodyEl?.textContent?.trim() ?? '';
  if (bodyEl && body) parts.push({ el: bodyEl, text: body });
  return parts;
}

/** Text of a submission as one string. Must stay EXACTLY the concatenation of the
 *  region slices below: the highlight layer rewrites each region with the segments cut
 *  out of this string, so a character here that belongs to no region is a character
 *  written into an element that never held it. */
function postText(root: Element): string {
  return postParts(root).map((p) => p.text).join(POST_JOIN);
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

/** The element that stands for the address of a comment's thread. */
function submissionOnPage(): string | null {
  const sub = document.querySelector('tr.athing.submission');
  return sub ? rowId(sub) : null;
}

/** The story a comment belongs to, as a bare HN id.
 *
 *  HN only tells a comment which story it is under when the comment is rendered OUT of
 *  its thread — a `/newcomments` or `/threads` row carries a `context` link of the form
 *  `item?id=<story>#<comment>`, whose fragment is the comment itself and whose id is the
 *  story. On an item page no such link exists, but the page's own submission row does.
 *  When neither is present the comment stands as its own conversation, which is the
 *  honest answer rather than a guess. */
function conversationIdOf(root: Element): string {
  const id = rowId(root)!;
  if (isSubmission(root)) return namespaced(id);
  const context = root.querySelector('.navs a[href^="item?id="][href*="#"]');
  const story = context?.getAttribute('href')?.match(/item\?id=(\d+)/)?.[1];
  if (story) return namespaced(story);
  const onPage = submissionOnPage();
  return namespaced(onPage ?? id);
}

/** The comment a row directly replies to, or null when it is top level in what is shown.
 *
 *  Three mechanisms, in order. The first is HN's OWN statement of the edge and the other
 *  two are reconstructions, which is why it leads:
 *
 *  1. **The `parent` link.** Every nested comment prints one — measured 2026-10-01 on an
 *     item page, 690 of the 825 comments carried it and the 135 without were exactly the
 *     indent-0 set. Its href is a fragment (`#49913854`) when the parent is on this page
 *     and `item?id=49900466` when it is not, which is the same distinction the reader
 *     sees: a `/threads` comment at indent 0 whose parent lives in another story carries
 *     the off-page form, and its id is then a real ancestor that simply is not in the
 *     batch. HN ships one language, so the link text is a fixed token rather than a
 *     locale-dependent one.
 *
 *  2. **Indent**, when there is no link to read. On an item page and on `/threads` every
 *     comment sits in one flat list and carries `td.ind[indent=N]`; the direct parent is
 *     the nearest PRECEDING comment row with a smaller indent — not the immediately
 *     preceding one, which on a chain of siblings is an unrelated branch. Kept because it
 *     is the only reconstruction available if a render drops the nav row, and because it
 *     is an independent reading of the same edge: on the item page above it agreed with
 *     the link on all 690 nested comments, and on `/threads` on all 3 whose parent was on
 *     the page, so preferring the link changes nothing measured and costs nothing if the
 *     two ever diverge.
 *
 *     Note that `/newcomments` renders NO indent cells at all (measured: 0 of 30 rows), so
 *     there the link is not merely preferred — it is the only source.
 *
 *  3. **The story itself.** A top-level comment on a story page replies to the STORY, so
 *     HN prints no `parent` link for it (the parent is the page) and its indent is 0, which
 *     leaves the mechanisms above empty. The submission IS in the batch and IS that
 *     comment's ancestor, so it is named here — otherwise the classifier reads a story's
 *     top-level comments with no idea what they are replying to, which is the one piece of
 *     context a comment most often depends on. Gated on a submission row being present, so
 *     the detached views are untouched: `/newcomments` and `/threads` have no submission
 *     row, and their `parent` link has already given the real answer.
 *
 *  A parent that is not in the batch resolves to nothing downstream, so a `/threads`
 *  top-level comment — whose parent lives in another story entirely — costs nothing. */
function replyParentId(root: Element): string | null {
  for (const link of Array.from(root.querySelectorAll('.navs a[href]'))) {
    if ((link.textContent ?? '').trim() !== 'parent') continue;
    const href = link.getAttribute('href') ?? '';
    const id = href.startsWith('#')
      ? href.slice(1)
      : href.match(/^item\?id=(\d+)$/)?.[1] ?? null;
    if (id && /^\d+$/.test(id)) return namespaced(id);
  }

  const indentTd = root.querySelector('td.ind[indent]');
  if (indentTd) {
    const indent = parseInt(indentTd.getAttribute('indent') ?? '', 10);
    if (Number.isFinite(indent) && indent > 0) {
      for (let row = root.previousElementSibling; row; row = row.previousElementSibling) {
        if (!row.classList.contains('athing') || !rowId(row) || isSubmission(row)) continue;
        const parentIndent = parseInt(row.querySelector('td.ind[indent]')?.getAttribute('indent') ?? '', 10);
        if (Number.isFinite(parentIndent) && parentIndent < indent) return namespaced(rowId(row)!);
      }
    }
  }

  const story = submissionOnPage();
  return story ? namespaced(story) : null;
}

function postRoots(id: string): Element[] {
  const out: Element[] = [];
  const bare = id.startsWith(ID_PREFIX) ? id.slice(ID_PREFIX.length) : id;
  for (const root of document.querySelectorAll(ROW_SELECTOR)) {
    if (rowId(root) === bare && isPostRow(root)) out.push(root);
  }
  return out;
}

export const hackerNewsAdapter: PlatformAdapter = {
  id: 'hackernews',
  hosts: PLATFORM_HOSTS.hackernews ?? [],

  postIdFromUrl(url) {
    const id = url.searchParams.get('id');
    return id && /^\d+$/.test(id) ? namespaced(id) : null;
  },

  postRoots,

  postIdOf(root) {
    const id = rowId(root);
    return id ? namespaced(id) : null;
  },

  /** A submission, judged for length — HN clamps nothing, so the number is
   *  LONG_FORM_CHARS. The headline counts with the body: a self-post's
   *  headline is its first line, and a submission is classified as one text either way.
   *
   *  Comments are the short shape by nature and are not judged at all. HN can render a long
   *  one, but a comment is what a reader replies into and what the buttons exist for; the
   *  length that makes a STORY long-form does not make the reply under it long-form. */
  isLongForm(root) {
    if (!isSubmission(root)) return false;
    return postText(root).length >= LONG_FORM_CHARS;
  },

  textElement(root) {
    return isSubmission(root) ? (bodyElement(root) ?? titleElement(root)) : commentElement(root);
  },

  textRegions(root) {
    // A comment is one block and takes the ordinary single-element path; only a
    // submission is split between a headline and a body.
    if (!isSubmission(root)) return null;
    return postRegions(root);
  },

  // HN comment text is markup, not a plain run: `<p>` separates paragraphs, `<a>` links,
  // `<i>` emphasis — and `<p>` in particular is how HN renders a blank line, so rebuilding
  // the body from the classified text would collapse every paragraph break into the text
  // and lose the links. Highlights go over the page's own text nodes instead.
  highlightInPlace: true,

  placeButtons(container, root) {
    // A row that only links to a post gets nothing at all — an index page's headlines are
    // links, and a button beside a link is a button on the wrong document. See `isItemView`.
    if (!isPostRow(root)) return;
    // A comment's buttons go at the END of its own head line — `user 2 hours ago [–] |
    // parent | context Disinfact` — after everything the row itself says, rather than beside
    // the age. HN does NOT end a comment's meta line at the time: `[-]` (the fold toggle) and
    // the `| parent | context | …` links come after it, all of them inside `SPAN.navs`, which
    // is the head line's last child (measured on an item page, whose head reads
    // `A.hnuser, SPAN.age, SPAN., SPAN.navs`). Seating beside the age, which is what this
    // used to do, put our pill in the middle of the host's own sentence and split the time
    // from the controls it introduces. Prepending to the comment's CELL, which is what it did
    // before that, was worse still: the head line carries the age and the cell spans the
    // column, so the pill and the time it belongs to were a line apart.
    //
    // This is the platform-local answer to "right of the row content", so it does not
    // generalize: each host ends its meta line with something different, and the seat is
    // wherever THAT host's row actually ends.
    //
    // A submission's buttons go at the right end of its headline line — `[arrow] Title
    // (site) [Disinfact]`. Following the headline within its own cell, rather than
    // prepending to that cell, is the change here: prepending, which is what this used to
    // do, split the vote arrow from the headline it points at. That seat is reached only on
    // the submission's own item page; an index page's rows never get here at all.
    //
    // The seat has to stay INSIDE the submission's own `tr.athing`. Parking the pill in the
    // subtext row — the sibling `<tr>` carrying `109 points by snesheht 1 hour ago | hide |
    // …` — looks like the better seat, because that row holds the author and the age, but it
    // is outside `postRoots`, so the sweep's own-chrome cleanup never reaches it and every
    // re-injection appends another pill: measured live, 120 bars over 30 submissions at
    // exactly four apiece, none of them inside a root, each left with only the host's own
    // anchor behaviour. A pill outside the root is not our button at all.
    if (!isSubmission(root)) {
      const head = root.querySelector('.comhead');
      if (head) {
        head.appendChild(container);
        return;
      }
      // No head line to sit in: fall back to the cell holding the comment, which is the
      // top-of-comment position such a row offers.
      const cell = root.querySelector('.comment')?.closest('td');
      if (cell) cell.insertBefore(container, cell.firstChild);
      return;
    }
    // The headline LINE, not the cell: `td.title` holds the rank number in a second cell of
    // the same class, and `.titleline` is the one node that names the headline's own row.
    const line = root.querySelector('.titleline');
    if (line) {
      line.insertAdjacentElement('afterend', container);
      return;
    }
    // No headline line found: leave the container detached rather than prepending it to the
    // row. HN's rows are a table — a child of `tr.athing` is not a laid-out cell, so the
    // pill would land outside the table's columns — and a post carrying our buttons is a
    // post the selection rule hands the user's selection off to, so a misplaced pill would
    // also cost the user the web-select path on this post. Detached, the post keeps working:
    // it simply has no buttons. See `placeButtons` in types.ts.
  },

  feedCenter() {
    // HN's whole page is one 85%-wide table pinned to the viewport, so this is very
    // nearly the viewport center — but it is the table, not the viewport, that the feed
    // is laid out in, and on a wide window the two stop agreeing. The comment column is
    // narrower still (indent cells take the difference), so the table is the right unit.
    const main = document.getElementById('hnmain');
    if (!main) return null;
    const rect = main.getBoundingClientRect();
    return rect.width > 0 ? rect.left + rect.width / 2 : null;
  },

  isPostTarget(id) {
    return postRoots(id).length > 0;
  },

  postElementFor(node) {
    const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    if (!el) return null;
    const own = el.closest(ROW_SELECTOR);
    if (own) return rowId(own) && isPostRow(own) ? own : null;
    // A text post's body is rendered in a bare sibling `<tr>`, so nothing inside it has a
    // `tr.athing` ancestor — yet that text IS the post's. Without walking back to the
    // submission it belongs to, a selection inside an Ask HN body looks like a selection
    // on the page at large and gets fact-checked as one, which is exactly the case the
    // selection rule exists to refuse.
    if (!el.closest('.toptext')) return null;
    let row: Element | null = el.closest('tr')?.previousElementSibling ?? null;
    for (let hops = 0; row && hops < 6; row = row.previousElementSibling, hops++) {
      if (row.classList.contains('athing')) return rowId(row) ? row : null;
    }
    return null;
  },

  captureRoots() {
    // `noshow` is how HN hides a collapsed comment's DESCENDANTS: their rows stay in the
    // DOM and keep their text, at `display: none`.
    //
    // The collapsed row ITSELF is not `noshow` and is not dropped — measured 2026-10-01,
    // folding a comment left that row visible (49px, its whole 261-character text intact)
    // and marked 57 rows below it. So this filter is exactly "the replies the reader has
    // folded away", never the comment they folded, and a folded comment still carries its
    // buttons and is still classified.
    //
    // Dropping them is deliberate, and it is the one place this adapter reads the rule
    // "never skip" narrowly: the text is in the DOM, but it is `display: none`, so a
    // classification would be billed for text no reader can see and its buttons would be
    // painted into a hidden subtree. Nothing is lost permanently — the rows are captured
    // the moment the reader expands the parent, which is when they become readable.
    //
    // `isPostRow` then drops an index page's submission rows, which are links to posts
    // rather than posts. Dropping them here is what keeps them out of the batch as well as
    // off the page: there is nothing on a front-page row to classify, so capturing one would
    // bill for a headline the reader is about to click THROUGH, and the reader who wants it
    // classified opens the post and finds the buttons waiting. Comments are never dropped by
    // it — `/threads` and `/newcomments` keep theirs.
    return Array.from(document.querySelectorAll(ROW_SELECTOR))
      .filter((row) => !row.classList.contains('noshow') && isPostRow(row));
  },

  capture(root: Element): CapturedPost | null {
    const id = rowId(root);
    if (!id) return null;

    const isPost = isSubmission(root);
    const text = isPost ? postText(root) : (commentElement(root)?.textContent?.trim() ?? '');
    // A submission whose headline and body are both empty, or a comment that HN renders
    // with no text (deleted, flagged), carries nothing to fact-check. Returning null keeps
    // it out of the batch rather than spending a classification on an empty string.
    if (!text) return null;

    const username = authorElement(root)?.textContent?.trim() ?? '';

    const post = {
      id: namespaced(id),
      text,
      // HN's DOM is the only source here, so the displayed text IS the raw text. X
      // separates these because its JSON carries both a note_tweet expansion and the
      // legacy body; markup has no such split.
      fullText: text,
      username,
      usertype: HN_USERTYPE,
      // HN is English-only by policy, so its text language is a fact about the platform
      // rather than a guess. This matters because the background derives the locale the
      // highlight ranges are keyed by from `sourceLanguage`, falling back to the UI
      // locale when it is absent — which would file an English HN post's ranges under
      // whatever language the reader's interface is in, and lose them if they ever
      // switched. X always knows a tweet's language; the DOM does not, so the one
      // platform where the answer is fixed states it.
      sourceLanguage: 'en',
      conversationId: conversationIdOf(root),
      quoting: null,
      replyingTo: null,
    } as MainTweet;

    return { post, replyParentId: isPost ? null : replyParentId(root) };
  },
};
