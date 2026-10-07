/** The Reddit adapter.
 *
 *  Reddit is server-rendered: an in-page same-origin fetch of a post-detail URL comes
 *  back with `<shreddit-post>`, `<shreddit-comment>` and the body markup already in the
 *  HTML (plain curl does not — Reddit serves a script-only shell to unrecognized
 *  clients, which is why the DOM must be probed through a real logged-in browser).
 *  Post content therefore comes from the DOM, and `captureRoots`/`capture` are
 *  implemented here rather than an XHR interceptor. Reddit does call
 *  `/svc/shreddit/graphql`, but only for modules and partials.
 *
 *  Re-measured 2026-10-01, because "server-rendered" is a claim that decays: every
 *  response a post or comment page fetches is HTML the DOM then renders, and NOTHING
 *  text-bearing stops at the network. A first load of a 46-comment thread made nine
 *  `/svc/shreddit/*` calls — user drawer, chat, left nav, header items — none carrying a
 *  post or a comment. The thread itself embeds no comment JSON (`script[t1…]`: 0 on the
 *  page). A detail page's partials are `comment-forest-empty-state`, `post-detail-modules`,
 *  `common-left-nav`, `banned-user-banner` and `subreddit-posting-eligibility-modal`; the
 *  crosspost hover card is never even requested. Feed pagination
 *  (`/svc/shreddit/community-more-posts/…`, 542 KB) IS a payload worth having and is not
 *  missed: it is `shreddit-post` markup — 74 of them in one response — which Reddit inserts
 *  into the DOM, where `captureRoots` reads it. And no text is truncated on the way in: a
 *  5701-character self-post body measures byte-identical on the feed card and on its detail
 *  page, with no `shreddit-expandable-content` and no computed `max-height` on either.
 *
 *  Ads need no exclusion code, and the reason is the tag vocabulary rather than a rule: a
 *  promoted post renders as `<shreddit-ad-post>`, a SIBLING of the feed's `<article>` and
 *  never a wrapper around one (measured 2026-10-01 on r/popular: the element contains no
 *  `shreddit-post` at all, and it carried no buttons). It is therefore outside
 *  `captureRoots`' `shreddit-post, shreddit-comment` query by construction. That is the
 *  whole of the ad handling and it is worth leaving alone — the element does carry its own
 *  `id="t3_…"`, `post-title` and `author`, so widening the selector to reach some other
 *  shape would file an advertiser's copy as a post and start painting buttons on it.
 *
 *  Every anchor below is a custom-element name, a `slot` name or a data attribute —
 *  Reddit's `shreddit-*` tag vocabulary and its `slot=` contract, not its Tailwind-ish
 *  classes (`text-neutral-content`, `flex justify-between`), which change freely. The
 *  two things that look stable and are NOT: `thingid` is null on posts (it works only
 *  on comments), and comments have no `id` attribute at all (only `thingid`). */
import type { MainTweet, Usertype } from '../../data/Tweets';
import { Usertype as UsertypeEnum } from '../../data/Tweets';
import { PLATFORM_HOSTS } from './hosts';
import { LONG_FORM_CHARS } from './types';
import type { CapturedPost, PlatformAdapter, TextRegion } from './types';

/** A post is `<shreddit-post id="t3_x">`; a comment is `<shreddit-comment thingid="t1_x">`
 *  with an empty `id`. Reddit's own `t1_`/`t3_` prefix separates the two kinds but says
 *  nothing about the platform, so ids are namespaced with the platform name as well:
 *  the background fans a classification out to every connected relay rather than keying
 *  by tab, so a bare Reddit id could otherwise be injected into an unrelated X timeline. */
const ID_PREFIX = 'reddit:';

/** `t3_`/`t1_` are Reddit's own type prefixes; keep them inside the namespaced id so a
 *  post and a comment that share a base-36 suffix stay distinct. */
function namespaced(fullname: string): string {
  return ID_PREFIX + fullname;
}

/** Reddit ids are base36. A permalink carries the BARE id, so the type prefix has to be
 *  re-added, and a comment permalink (`/comment/<id>/`) must not be mistaken for a post. */
const COMMENT_PERMALINK_RE = /\/comments\/[^/]+\/(?:[^/]+\/)?comment\/([a-z0-9]+)/i;
const POST_PERMALINK_RE = /\/comments\/([a-z0-9]+)/i;

/** Reddit shows no verification badge: `usertype` is one of exactly four strings the
 *  preclassify worker accepts, and "mod"/"OP"/flair markers are not verification — they
 *  are per-subreddit roles. So every Reddit account is `Regular`, which the worker's
 *  prompt already treats as "no special standing". */
const REDDIT_USERTYPE: Usertype = UsertypeEnum.Regular;

const POST_TAG = 'shreddit-post';
const COMMENT_TAG = 'shreddit-comment';
const BODY_TAG = 'shreddit-post-text-body';

/** The view context a submission states on its own page, as opposed to in a listing. */
const COMMENTS_CONTEXT = 'CommentsPage';

/** Whether a submission is a row in a listing rather than a post the reader has open.
 *
 *  Reddit builds a feed row and an opened post from the same `shreddit-post` element, and tells
 *  them apart in the markup: a row states its feed as `view-context` and sits inside a
 *  `shreddit-feed`, while the post on its own page states `CommentsPage` and has no feed above it.
 *  Measured on `/r/HotScienceNews/` at 390x844 — 27 posts, every one `SubredditFeed` inside a
 *  single `shreddit-feed` — against the permalink of one of those rows, which measured one post,
 *  `CommentsPage`, no feed. The desktop feed card is built the same way (`SubredditFeed` inside a
 *  `shreddit-feed` at 1400px), and the desktop post page the same as the mobile one.
 *
 *  A row is a title and a snippet the reader has to open to read, and Reddit clamps the snippet
 *  without offering to expand it, so buttons on a row would fact-check a teaser and, in a listing
 *  of 27 of them, clutter the list itself. The post the row opens keeps everything it has.
 *
 *  Only a submission is ever a row: a comment is listed nowhere, and it keeps its buttons and its
 *  place in its replies' ancestry. */
function isFeedRow(root: Element): boolean {
  if (root.tagName.toLowerCase() !== POST_TAG) return false;
  if (root.closest('shreddit-feed')) return true;
  const context = root.getAttribute('view-context');
  return context !== null && context !== COMMENTS_CONTEXT;
}

/** The submission a comment belongs to, and the parent it replies to. Both are rendered
 *  as attributes, so the whole ancestor chain is walkable without a network call. */
function fullnameOf(root: Element): string | null {
  const tag = root.tagName.toLowerCase();
  if (tag === POST_TAG) return root.getAttribute('id') || null;
  if (tag === COMMENT_TAG) return root.getAttribute('thingid') || null;
  return null;
}

/** The submission's language, which Reddit states outright on the post element
 *  (`post-language="en"`). A comment carries no language of its own, and a comments page
 *  is about exactly one submission, so the thread's language is the one on the page —
 *  which is also the language a comment is written in, since Reddit threads are not
 *  per-comment multi-lingual.
 *
 *  Null when the attribute is absent (an old renderer, a page with no post), which leaves
 *  the post to the shared unknown-language fallback rather than to a guess from the
 *  reader's own locale. */
function languageOf(root: Element): string | null {
  return root.getAttribute('post-language')
    ?? document.querySelector(`${POST_TAG}[post-language]`)?.getAttribute('post-language')
    ?? null;
}

/** How a post's title and body are joined in the classified text. Two newlines, so the
 *  worker reads them as separate paragraphs rather than one run-on sentence. Whatever
 *  sits between two regions is text no element renders, which is why the regions carry
 *  explicit offsets instead of being concatenated. */
const POST_JOIN = '\n\n';

/** The post's headline. A detail page renders it as `<h1 slot="title">`, the feed as the
 *  permalink `<a slot="title">` — two different tags for the same slot. */
function titleElement(root: Element): Element | null {
  return root.querySelector('[slot="title"]');
}

/** The element a post's BODY renders into: the slotted child of `shreddit-post-text-body`,
 *  never that wrapper itself.
 *
 *  `shreddit-post-text-body` is a shadow host whose only slot is named `text-body`, so it
 *  renders nothing but its slotted children. A `<span>` inserted directly into it carries
 *  no `slot` attribute, lands in no slot, and paints at 0×0 — with the slotted child
 *  destroyed by the same write, the post body disappears from the page entirely. The
 *  slotted child is a `<div slot="text-body">` on a detail page and an `<a slot="text-body">`
 *  (the permalink) on a feed, so it is selected by slot name rather than by tag. */
function postBodyElement(root: Element): Element | null {
  return root.querySelector(`${BODY_TAG} > [slot="text-body"]`);
}

/** Whether this post has its WHOLE text rendered yet.
 *
 *  Reddit fills the two slots at different moments. SSR ships both in the HTML, but a
 *  client-side render — feed pagination, a feed→detail navigation, and the post's own
 *  re-render as its body arrives — mints the elements in separate steps, so a sweep can
 *  land on a root carrying one of the two and not the other. Measured on the detail page of
 *  t3_1wxdn3w: no `<shreddit-post>` at 439 ms, both slots filled by 620 ms.
 *
 *  A reading taken in that window is a PARTIAL post, and a partial post is not a smaller
 *  version of this one — it is a different post. The text is what a post is FILED under
 *  (`canonicalContext` hashes `fullText`), so the tap that classified the title alone wrote
 *  its claims under one hash while every later annotation — hashing the body-inclusive text
 *  the page had settled on — subscribed against another. Nothing joins the two: the claims
 *  sit under a hash no annotation will ever ask for, and the subscription that asks for the
 *  text on screen resolves no tweet row, so the badge spins out its whole window in silence.
 *
 *  Refusing here costs nothing. `capture` returning null is already "not a classifiable
 *  post" to the sweep (native.content.ts), which re-reads the root on the next mutation —
 *  and the mutation that fills the missing slot is exactly such a mutation.
 *
 *  A post with no body is complete with its title alone: Reddit renders the body's wrapper
 *  only for a submission that HAS a body, so an ABSENT wrapper means nothing further is
 *  coming, while an EMPTY one means the body is still on its way in. */
function postComplete(root: Element): boolean {
  if (!titleElement(root)?.textContent?.trim()) return false;
  if (!root.querySelector(BODY_TAG)) return true;
  return !!postBodyElement(root)?.textContent?.trim();
}

/** The blocks a post's text is made of, in reading order: the title, then the body.
 *
 *  Reddit puts the claim in the TITLE for link posts (an r/science headline has no body
 *  at all) and in the body for self posts, so both are fact-checked as one submission —
 *  splitting them would bill two classifications for one post, and the worker could not
 *  see that the body answers the title. Body text is not truncated in the DOM: a feed and
 *  its detail page return the identical string, the feed only clamps it visually, so no
 *  "See more" click is needed to capture it. */
/** The length at which Reddit stops showing a post whole.
 *
 *  A feed clamps a self-post's body to six lines and hides the rest behind its own control
 *  (`-webkit-line-clamp: 6` with `overflow: hidden`); a detail page shows the same string
 *  whole. Measured 2026-10-01 across a scrolled r/AmItheAsshole feed at 1280px: the longest
 *  body shown whole ran 478 characters and the shortest Reddit clamped was 543 — which is
 *  where this platform's own 500 came from, and why it is now the universal
 *  `LONG_FORM_CHARS`: the cut is a LINE clamp, so the character it lands on moves with the
 *  column's width, and a per-host number made the same length mean two things on two
 *  platforms. Applied to the detail page too. */

function postParts(root: Element): { el: Element; text: string }[] {
  const parts: { el: Element; text: string }[] = [];
  const titleEl = titleElement(root);
  const title = titleEl?.textContent?.trim() ?? '';
  if (titleEl && title) parts.push({ el: titleEl, text: title });
  const bodyEl = postBodyElement(root);
  const body = bodyEl?.textContent?.trim() ?? '';
  if (bodyEl && body) parts.push({ el: bodyEl, text: body });
  return parts;
}

/** Text of a post as one string. Must stay EXACTLY the concatenation of `postRegions`'
 *  slices: the highlight layer rewrites each region with the segments cut out of this
 *  string, so a character here that belongs to no region is a character written into an
 *  element that never held it. */
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

/** The single element that stands for a post's text. The body carries the claim in most
 *  posts and is far the longer of the two, so it is the anchor callers get when they need
 *  one; a link post has no body and falls back to its title. See `textRegions` for the
 *  two-block reality. */
function bodyElement(root: Element): Element | null {
  const tag = root.tagName.toLowerCase();
  if (tag === POST_TAG) return postBodyElement(root) ?? titleElement(root);
  if (tag === COMMENT_TAG) return root.querySelector('[slot="comment"]');
  return null;
}

function commentText(root: Element): string {
  return root.querySelector('[slot="comment"]')?.textContent?.trim() ?? '';
}

/** A post's header line: the byline row Reddit renders as `<community> · <time>` over the
 *  author's name, with the overflow menu at its right-hand end. Both views have one under
 *  the same slot name — a detail page's `#pdp-credit-bar` and a feed card's own credit
 *  bar — which is why it is the first choice. `ssr-post-content-header` (an empty,
 *  full-width block directly above the title, on a detail page only) is the fallback for
 *  a render that drops the credit bar.
 *
 *  The buttons go INSIDE a slotted element, never directly into the post: `shreddit-post`
 *  renders through an OPEN SHADOW ROOT with named slots, so its light-DOM children are
 *  placed by slot NAME, and a container with no `slot` attribute is assigned to the
 *  DEFAULT slot, which the shadow template renders AFTER the body. Measured on a post
 *  detail page: the container sat immediately before `<h1 slot="title">` in the light DOM
 *  but painted at y=1117, below an 888px body, instead of at the title's y=124. Naming a
 *  slot ourselves would work only until Reddit renames or re-templates one.
 *
 *  Reddit posts have NO action row — `shreddit-post-action-row` and `[slot="actionRow"]`
 *  are absent on both views — so the header line is the only row available, and it is
 *  also the row the requirement asks for: `at the top` on a post with a byline is inline
 *  on that byline, at its right-hand end. */
function postHeaderRow(root: Element): Element | null {
  return root.querySelector('[slot="credit-bar"]')
    ?? root.querySelector('[slot="ssr-post-content-header"]');
}

/** The row at the right-hand end of a post's header line: the one Reddit anchors its own
 *  overflow menu in. Our buttons join that row as its FIRST child, so the row grows
 *  leftward from the card's right edge and every control already in it — the menu
 *  included — keeps the position it had. Returns null when the post renders no menu, and
 *  the header itself when the menu's row IS the header (the credit bar is a flex row
 *  itself), which the caller treats as "append to the end" instead.
 *
 *  Not the menu's `parentElement`: that differs per view. On a detail page the menu is a
 *  direct child of the header's right-hand flex row, but on a feed card it sits inside a
 *  per-menu `shreddit-async-loader` wrapper whose `display` is `block`. A container
 *  dropped in there shares a line with nothing — measured on a feed card, it rendered as
 *  a 91px block hanging off a 32px-wide wrapper, past the card's right edge and over the
 *  sidebar, with Reddit's own menu pushed onto the line below it. The enclosing flex row
 *  is the thing both views agree on. */
function postHeaderEnd(header: Element): Element | null {
  let el: Element | null = header.querySelector('shreddit-post-overflow-menu');
  if (!el) return null;
  while (el.parentElement && el.parentElement !== header
         && !/flex|grid/.test(getComputedStyle(el.parentElement).display)) {
    el = el.parentElement;
  }
  return el.parentElement;
}

/** A comment's header line — the row Reddit renders as `name · time · flair`, which is
 *  the row our buttons belong in.
 *
 *  `[slot="commentMeta"]` is the platform's own name for it (a slot contract, like the
 *  rest of this file's anchors) and it sits inside the comment's `summary`. Found from
 *  the root rather than by walking, so a comment nested in another comment resolves to
 *  its OWN meta row. */
function commentHeaderRow(root: Element): Element | null {
  return root.querySelector('summary [slot="commentMeta"]');
}

function postRoots(id: string): Element[] {
  const out: Element[] = [];
  for (const root of document.querySelectorAll(`${POST_TAG}, ${COMMENT_TAG}`)) {
    if (isFeedRow(root)) continue;
    const fullname = fullnameOf(root);
    if (fullname && namespaced(fullname) === id) out.push(root);
  }
  return out;
}

export const redditAdapter: PlatformAdapter = {
  id: 'reddit',
  hosts: PLATFORM_HOSTS.reddit ?? [],

  postIdFromUrl(url) {
    const comment = url.pathname.match(COMMENT_PERMALINK_RE);
    if (comment) return namespaced(`t1_${comment[1]}`);
    const post = url.pathname.match(POST_PERMALINK_RE);
    if (post) return namespaced(`t3_${post[1]}`);
    return null;
  },

  postRoots,

  /** A submission or a comment, judged for length — see LONG_FORM_CHARS.
   *
   *  The body alone is measured, not `postText`: the host's cut falls on the body, and a link
   *  post's title (the only text it has) is never the thing a feed clamps. Comments are never
   *  long-form — they keep their buttons, and they are still their replies' ancestors. */
  isLongForm(root) {
    if (root.tagName.toLowerCase() !== POST_TAG) return false;
    const body = postBodyElement(root);
    return !!body && (body.textContent?.trim().length ?? 0) >= LONG_FORM_CHARS;
  },

  postIdOf(root) {
    const fullname = fullnameOf(root);
    return fullname ? namespaced(fullname) : null;
  },

  textElement(root) {
    return bodyElement(root);
  },

  textRegions(root) {
    // A comment is one block and takes the ordinary single-element path; only a post is
    // split between a title and a body.
    if (root.tagName.toLowerCase() !== POST_TAG) return null;
    return postRegions(root);
  },

  // A Reddit body is rendered markdown: links, blockquotes, list items, code. Rebuilding
  // it from the classified text — which is what a tweet body tolerates — collapses all of
  // that into one run of plain text, so the post the reader is looking at stops being the
  // post Reddit rendered. Highlights go over the page's own text nodes instead.
  highlightInPlace: true,

  placeButtons(container, root) {
    // A post's buttons go in the post's own header line, to the LEFT of its Join control
    // where it has one — `r/mod · 1y ago [Disinfact] [Join] [...]` — and at the right-hand
    // end of that line where it does not. A comment's go immediately to the RIGHT OF ITS
    // TIMESTAMP — `name · 1m ago [Disinfact]`. A comment's body (the first child of `[slot="comment"]`,
    // where this used to put them) is not a header: the pill started a line of its own below
    // the header AND was measured against the body's paragraphs by the squeeze pass, whose
    // `squeezableCluster` takes the widest sibling in the container's row — a paragraph's
    // max-content width minus its wrapped width reads as a phantom crush and capped the
    // labels to their 24px floor, "Disi…" in a comment with room to spare.
    const isPost = root.tagName.toLowerCase() === POST_TAG;
    // A listing row is a title and a snippet, not a post the reader can read: no buttons on it
    // (see `isFeedRow`). The post it opens is not a row and is placed exactly as before.
    if (isFeedRow(root)) return;
    const header = isPost ? postHeaderRow(root) : commentHeaderRow(root);
    // No header line on this render: leave the container detached rather than inserting
    // it anywhere plausible. A direct child of `shreddit-post` paints BELOW the body (see
    // postHeaderRow), and a post carrying our buttons is a post the selection rule hands
    // the user's selection off to — so a misplaced pill would also cost the user the
    // web-select path on this post. Detached, the post keeps working: it simply has no
    // buttons. See `placeButtons` in types.ts.
    if (!header) return;

    // `align-self: center` keeps the container off the row's stretch, and `flex-shrink: 0`
    // keeps the host from crushing our pill instead of eliding the header's own text.
    container.style.alignSelf = 'center';
    container.style.flexShrink = '0';

    if (isPost) {
      // A card that offers the community's Join control puts our buttons immediately to its
      // LEFT — `r/mod · 1y ago [Disinfact] [Join] [...]`, measured on the home feed at
      // 1400px with the pill at x=950 and Join at 893–950. That is the reader's own
      // instruction for this platform, and it is also the only arrangement in which the
      // pill is not the last thing between the byline and the card's edge. The control is
      // found by its tag, which is a custom-element name rather than a class or a label,
      // and it sits in the header row on every view that has one (a comments page renders
      // none — measured, and the branch below is what those fall to).
      const join = header.querySelector('shreddit-join-button');
      if (join) {
        container.style.marginLeft = '';
        join.insertAdjacentElement('beforebegin', container);
        return;
      }
      // No Join control — a comments page, or a community the reader is already in. The row
      // is a flex box, so `margin-left: auto` is what pushes the container to its right-hand
      // end. Our buttons go in the row Reddit's own overflow menu sits in —
      // `r/mod · 1y ago [Disinfact] [...]` — as its first child. See postHeaderEnd for why
      // that row rather than the menu's parent, and why the header itself is the append
      // fallback.
      container.style.marginLeft = 'auto';
      const end = postHeaderEnd(header);
      if (end && end !== header) {
        end.insertBefore(container, end.firstElementChild);
        return;
      }
      header.appendChild(container);
      return;
    }

    // A comment's header line spans the whole column, so `margin-left: auto` — which is what
    // put the pill there before — parked it at the far RIGHT EDGE of a ~700px row, some 450px
    // from the timestamp it belongs to. The pill is inserted after the row's own child that
    // CARRIES the `<time>`, not after the `<time>` itself: that child is the whole
    // `name · time` group, and a pill dropped inside it would land between the name and the
    // time rather than after both. No auto margin here — the row's own gap spaces it.
    container.style.marginLeft = '';
    let anchor: Element | null = null;
    for (let el: Element | null = header.querySelector('time'); el; el = el.parentElement) {
      if (el.parentElement === header) { anchor = el; break; }
    }
    if (anchor) anchor.insertAdjacentElement('afterend', container);
    else header.appendChild(container);
  },

  feedCenter() {
    // Both views agree at 566px on a 1200px viewport: the feed is offset left by the
    // sidebar, so the viewport center would put the buttons over the sidebar. A
    // comments page has no `shreddit-feed` and falls back to the content column.
    const column = document.querySelector('shreddit-feed')
      ?? document.querySelector('main')
      ?? document.querySelector('#main-content');
    if (!column) return null;
    const rect = column.getBoundingClientRect();
    return rect.width > 0 ? rect.left + rect.width / 2 : null;
  },

  isPostTarget(id) {
    return postRoots(id).length > 0;
  },

  postElementFor(node) {
    const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    return el?.closest(`${POST_TAG}, ${COMMENT_TAG}`) ?? null;
  },

  captureRoots() {
    // A listing's rows are left out here rather than at the buttons, so a row is never captured,
    // hashed, announced or classified at all — a feed of 27 rows is 27 classifications the reader
    // never asked for, and nothing is lost by not reading a teaser (see `isFeedRow`).
    return Array.from(document.querySelectorAll(`${POST_TAG}, ${COMMENT_TAG}`))
      .filter((root) => !isFeedRow(root));
  },

  capture(root: Element): CapturedPost | null {
    const tag = root.tagName.toLowerCase();
    const fullname = fullnameOf(root);
    if (!fullname) return null;
    if (tag !== POST_TAG && tag !== COMMENT_TAG) return null;

    const isPost = tag === POST_TAG;
    // A post is one submission spanning two slots, so it is filed whole or not at all —
    // see `postComplete` for the render window this refuses and why a partial reading is a
    // hash no later annotation can reach.
    if (isPost && !postComplete(root)) return null;
    const text = isPost ? postText(root) : commentText(root);
    // A post whose title AND body are both empty (a deleted stub, a media-only post)
    // carries nothing to fact-check. Returning null keeps it out of the batch entirely
    // rather than spending a classification on an empty string.
    if (!text) return null;

    // `author` is the handle; Reddit has no separate display name, so it is the only
    // thing to send. On a comments page the submission's own `author` is present too,
    // which is why posts and comments share this read.
    const username = root.getAttribute('author') ?? '';

    const post = {
      id: namespaced(fullname),
      text,
      // Reddit's DOM is the only source here, so the displayed text IS the raw text.
      // X separates these because its JSON has both a note_tweet expansion and the
      // legacy body; there is no such split in markup.
      fullText: text,
      username,
      usertype: REDDIT_USERTYPE,
      // A comment sits in its submission's thread; a post is its own thread.
      conversationId: isPost ? namespaced(fullname) : namespaced(root.getAttribute('postid') ?? fullname),
      // A CROSSPOST names its original, and the original is deliberately NOT carried here.
      // The markup states it in `content-href` (`/r/doordash/comments/1wth8f2/is_this_normal/`)
      // and as the title anchor's href, so the identity is not the problem — the CONTENT is.
      // Reddit crossposts as a repost, not a quote card: the crosspost adopts the original's
      // TITLE as its own `post-title` (measured on five: `post-title` "Is this normal?" against
      // the original's slug `is_this_normal/`), renders the original's media, and renders the
      // original's BODY nowhere at all. Measured 2026-10-01 on t3_1usckdj, whose original
      // t3_1u67im8 carries a 24-character body: that body's first 20 characters appear in
      // neither the crosspost's page text nor its media container, while the original's title
      // does. So the text this post is judged on is already exactly the text on screen, and a
      // `quoting` filled from here would repeat the title we are already sending (the hash
      // reads `username` and `fullText` only — `canonicalContext` never sees an id) while
      // inventing an author we do not have. Fetching the original's page for its body would
      // put text in the hash that the reader of the crosspost never saw.
      quoting: null,
      replyingTo: null,
    } as MainTweet;

    // Reddit's own reading of the post's language, when it has one. Left absent otherwise
    // so `nameCapturedLanguage` fills in the shared unknown key.
    const language = languageOf(root);
    if (language) post.sourceLanguage = language;

    // The direct parent, left as an id for `hydrateReplyChains` to resolve against the
    // rest of the batch — which is what turns these into the nested ancestor chain the
    // preclassify agent reads.
    //
    // Reddit states the edge ITSELF, as `parentid` on the comment element, and it is the
    // true one-level edge rather than the rendered nesting: measured 2026-10-01 on a
    // 46-comment thread, `parentid` agreed with the nearest rendered `shreddit-comment`
    // ancestor on all 14 replies and NONE of them named the submission instead — including
    // the depth-2 and depth-3 replies, where a reparenting renderer would have flattened.
    // The nesting walk was reading the same edge, but only while the parent happened to be
    // rendered: on a "continue this thread" page the ancestor sits on another page, and
    // `closest()` then finds nothing and the old code fell through to the SUBMISSION —
    // asserting "replies to the post" for a comment that replies to a comment, which is a
    // wrong ancestor chain rather than a short one. `parentid` yields the honest edge and
    // lets the chain stop where the batch stops.
    //
    // A top-level comment carries no `parentid` at all (measured: all 32 of them) and
    // states its submission as `postid` instead, so the submission is its parent — which is
    // what keeps this non-null for every comment on the page.
    let replyParentId: string | null = null;
    if (!isPost) {
      const parentFullname = root.getAttribute('parentid') ?? root.getAttribute('postid');
      replyParentId = parentFullname ? namespaced(parentFullname) : null;
    }

    return { post, replyParentId };
  },
};
