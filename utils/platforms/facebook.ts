/** The Facebook adapter.
 *
 *  Facebook is the first platform here whose markup is a React bundle with NO stable
 *  wrapper to select: measured on the home feed, `data-pagelet`, `data-ft`, `data-testid`,
 *  `role="feed"` and `aria-posinset` are all absent (0 of each), and every class is a
 *  build-hashed utility (`x1n2onr6`, `xdj266r`) that this rollout refuses on principle.
 *
 *  What Facebook DOES leave is the `data-ad-rendering-role` family — one element per story
 *  carrying each of `profile_name`, `story_message`, `meta`, `like_button`,
 *  `comment_button`, `share_button`. Those are semantic, unhashed, and stable across the
 *  builds measured, so they are this adapter's whole vocabulary. The one thing they do NOT
 *  give is the post CONTAINER, which has no attribute of its own: it is computed, as the
 *  nearest ancestor of a `profile_name` that also holds a `like_button` — the same walk the
 *  page's own renderer implies, and the reason `captureRoots` is not a single selector.
 *  The set is also not the same on every surface: a **home-feed story carries no `meta`**,
 *  so nothing may be found by that role alone. `placeButtons` finds the header bar by the
 *  control it holds instead, which is present on both.
 *
 *  **Surfaces.** A feed story is a short social unit and is integrated first-class, buttons
 *  and all; so is every comment under one. Two things are deliberately NOT:
 *
 *  - **A link preview's title and description.** On a link post those two roles are the
 *    SHARED page's words, not the poster's, and the worker would be judging the news site
 *    rather than the person sharing it. The post's own words are `story_message` alone.
 *
 *  - **Video-first surfaces — the reel player and a Page's videos** (`onVideoSurface`). These
 *    carry no post to integrate: the story vocabulary is absent or bodyless there, measured as
 *    `profile_name` 0 on the reel feed and `story_message` 0 on a Page's video permalink. What
 *    they DO carry is the comment list, rendered from the same markup an ordinary post's
 *    comments use, so comments were being integrated on surfaces that have no post: measured at
 *    6 comment rows with 6 bars on `/reel/`, 1 with 1 on a Page's video tab, and 3 with 3 once a
 *    video was opened. Reels and videos are out of scope including their comments, so the whole
 *    surface is refused rather than its comment rows filtered one by one — a partial refusal
 *    would start integrating a future build of these pages whose player grew the vocabulary.
 *
 *  **Quotes stay null, and that is a measurement rather than an omission.** A post sharing
 *  another post would be a `quoting` edge, but none was found to build one against: two full
 *  sweeps of the home feed (top to bottom and back) and one of a Page timeline never produced
 *  a story root holding a second `profile_name`. Facebook's model does have the slot — a story
 *  node carries `"attached_story"` — and every story in the INITIAL payload had it `null`.
 *  A later capture of the scrolled feed's own GraphQL bodies (21 responses, 3.1 MB, all parsed)
 *  does find it populated: of 51 nodes carrying the key, 12 were non-null, so a share is stated
 *  in the payload after all. What is still missing is the join — a DOM root to the story node
 *  stating its own `attached_story` — so `quoting: null` remains the honest value here.
 *
 *  **Sponsored stories are filtered, by the one marker measured to be ad-only.** The tempting
 *  attributes are traps: `data-ad-comet-preview="message"` sits on a descendant of an ORGANIC
 *  NatGeo post's `story_message`, and `data-ad-preview` was measured on an organic friend post
 *  as well, so a filter on either matches every post and would remove the whole platform. The
 *  marker that does separate them is the ad-rendering role `cta`, the call-to-action element
 *  Facebook renders inside a sponsored story: verified 2026-10-04 on the home feed against a
 *  live ad whose own header states the host's `Ad` label and whose body carries the
 *  advertiser's landing page — the same root that was carrying our pill — while 14 organic
 *  posts on a Page's timeline and every organic feed story beside it held none (see `AD_CTA`).
 *  A link preview's `description` role is NOT usable instead: an ad carries one whenever its
 *  creative links out, so it is present on organic link posts too.
 *
 *  The payload was checked too, on the theory that Facebook's own model must name an ad. An
 *  earlier read of the bootstrap blob found `"sponsored_data"` and `"ad_id"` in a bundle
 *  fragment and in ad DESTINATION urls (`utm_medium=paidsocial`) and concluded neither was a
 *  story-level flag. Re-measured against the feed's own GraphQL responses (21 bodies, 3.1 MB,
 *  every one parsed), the halves split: `"sponsored_data"` appears on THREE STORY NODES — the
 *  same objects that state `message`, `attachments`, `comet_sections` and `is_text_only_story` —
 *  and is `null` on all three, so it is a story-level field that is empty for an organic story
 *  and whose non-null value would be the ad flag; `"ad_id"` appears nine times and is SET every
 *  time, always on a standalone ad-identity node (`client_token`, `lbl_adv_iden`) that never
 *  carries a `message`. A later interception of the feed's own GraphQL while ads were on screen
 *  (2026-10-04) read no `sponsored_data` at all, set or null, so the payload route is not the
 *  one taken — the DOM role is, because it was observed on the ad itself rather than read off
 *  the schema. The payload's story ids still join a root to its own payload entry
 *  (`absorbPostIds`), which is what would let a payload marker be used the day one is observed
 *  on an ad.
 *
 *  No long-form surface needed the article rule here: Facebook has no article product left on
 *  the web. Truncation does occur, though — a long comment and a Page's post were both measured
 *  cut off behind the page's own `See more` — and what happens to one is decided by whether the
 *  whole text is stated anywhere else.
 *
 *  Both are. The page's own payload states a story's complete message (`postIdMessages`) and
 *  what each comment says (`commentTexts`), so a truncated post or comment is filed under a text
 *  whose VISIBLE part is the page's own characters verbatim and whose remainder comes from the
 *  payload — never under the prefix alone, which names nothing (`wholeBodyText`,
 *  `wholeCommentText`). The two maps are separate because the payload states them in different
 *  fields: a story's words at `message.text`, a comment's at `body.text`, the same comment under
 *  the same decimal id its permalink spells in `comment_id` (see `collectCommentTexts`).
 *  `bodyTruncated` is what reads the clip, structurally rather than by the expander's translated
 *  label; `bodyClamped` stays as the catch for a clip that is a computed style instead, which
 *  nothing measured so far has been.
 *
 *  **Ids.** Facebook exposes real object ids, and this adapter reads them rather than
 *  synthesizing one. The id a post is filed under is the `post_id` the host's own payload
 *  states for its story, resolved from whichever name the rendered markup happens to carry
 *  (see `absorbPostIds`): the canonical `a[href*="/posts/pfbid…"]` permalink, the `set=pcb.<id>` a
 *  photo post's links carry — that number IS the story's `post_id`, measured twice — or the
 *  id of one of the post's photos in an `?fbid=` link. A comment's own author link
 *  base64-encodes `comment:<post id>_<commentId>`, the same decimal space. All are Facebook's
 *  own object ids, stable across renders — which `post-id-names-one-text` needs, since a
 *  positional id would rename every post below a deleted one. A root whose markup offers no id
 *  gets NO id rather than a guessed one: no id means no buttons and no classification, and a
 *  wrong id would key two different texts under one name.
 *
 *  **A post and a comment were named in different id spaces until the payload was read, and
 *  that is what closes it.** Measured on a 9GAG permalink: the post root's own id was
 *  `pfbid035XQ…`, every comment decoded to `1576089941223700`, and the post root's 316KB of
 *  markup never mentioned that decimal number — so a parent link built from the decoded id
 *  joined nothing, measured as 0 of 22 comments with an ancestor, a total loss that looked
 *  like silence. `enclosingPostId` answers from the DOM instead, which is independent of which
 *  name was chosen and is what makes the join work; with the payload's id on hand the two
 *  sides now agree, and the markup's own name for the story is resolved to that id as well.
 *  Comment ids, by contrast, are ALL decimal — a reply's parent link and its own id come out
 *  of the same space — so comment-to-comment edges join directly.
 *
 *  **Language.** A post's own words come from the DOM, which carries them complete behind these
 *  anchors — including while a translation is showing, which is the point below. The translation
 *  does not come from the DOM: Facebook's own `See translation` fetches it over
 *  `POST /api/graphql/` and the response carries the translated text with no source and no locale
 *  beside it. So a SECOND thing is read from the network — `facebook.capture.content.ts`, which
 *  forwards those translations, the thread edges the markup gets wrong beyond one level, and
 *  the story ids the markup never states — while nothing here ever constructs a request.
 *  That distinction is what keeps this clear of the rotating `doc_id` values
 *  `x-timeline-op-renames` warns about: the interceptor observes the app's own calls rather than
 *  making any.
 *
 *  **A flip does not take the source away.** Measured on a Spanish post, before the flip the
 *  visible words were Spanish and after it the control read `Hide Translation` and the English
 *  ran as sibling `dir="auto"` blocks — with the single `story_message`, still holding the
 *  Spanish, in the same root. Both sides are in the document at once, so the element
 *  `textElement` names is the post's own words whatever the reader has done, and what is FILED is
 *  always that. The hash a post is identified by is computed from its text, so filing the
 *  translation instead would give one post a second identity, classified and billed a second
 *  time. `looksTranslated` guards the one case the rule does not cover — a post met already
 *  translated with the translation rendered into that same element — where `rememberSource`'s
 *  copy is used, or the post goes unfiled.
 */
import type { MainTweet, Usertype } from '../../data/Tweets';
import { Usertype as UsertypeEnum } from '../../data/Tweets';
import { appLanguage } from './capture';
import { collectCommentTexts, collectPostIds } from './facebookPostIds';
import { PLATFORM_HOSTS } from './hosts';
import { passageTextContent } from '../injecting';
import { LONG_FORM_CHARS } from './types';
import type { CapturedPost, PlatformAdapter, TextRegion } from './types';

const ID_PREFIX = 'facebook:';

/** Facebook's one semantic hook: a role attribute it puts on one element per story. */
const ROLE = 'data-ad-rendering-role';
const NAME = `[${ROLE}="profile_name"]`;
const MESSAGE = `[${ROLE}="story_message"]`;
const LIKE_BUTTON = `[${ROLE}="like_button"]`;

/** The story's own footer, the roles a COMMENT never carries. A comment row has a like button
 *  of its own, so the like button alone cannot tell a story container from a comment — the
 *  share button can, which is what `enclosingPostId`'s fallback keys on. */
const SHARE_BUTTON = `[${ROLE}="share_button"]`;

/** A paid placement: the call-to-action element Facebook renders inside a sponsored story.
 *
 *  The `cta` role is the ONE ad marker measured that organic posts do not carry. Verified
 *  2026-10-04 against a live ad on the home feed — the root holding this role is the story
 *  whose own header states the host's `Ad` label and whose body carries the advertiser's
 *  landing page, a "See details" control and a link preview — while none of 14 organic posts
 *  on a Page's timeline held it, and none of the organic feed stories beside it did either.
 *  The tempting attributes are NOT usable: `data-ad-comet-preview` sits inside an organic
 *  post's own `story_message` and `data-ad-preview` on organic posts too, which is what the
 *  header records. `cta` is a PREFIX because the value measured is `cta-` with the CTA kind
 *  absent; matching the prefix keeps a value that names its kind caught as well.
 *
 *  A link preview's description, by contrast, is NOT a marker: an ad carries one whenever its
 *  creative has a link, so `[${ROLE}="description"]` is present on ads and organic link posts
 *  alike (measured on both). */
const AD_CTA = `[${ROLE}^="cta"]`;

/** Whether this story is a paid placement, read from the story root itself.
 *
 *  Scoped to the root, never to the document, so an ad elsewhere in the feed cannot condemn
 *  the story beside it. */
function sponsored(root: Element): boolean {
  return !!root.querySelector(AD_CTA);
}

/** The host's own controls, whatever they are. Facebook labels the story's menu with a
 *  translated sentence ("Actions for this post by …"), so a control is found by its role and
 *  its place in a row, never by its label. */
const CONTROL = '[role="button"]';

/** A comment. Its `aria-label` is English text that translates, so its VALUE is never read
 *  — only its presence, which is what separates a real comment from the two empty
 *  `role="article"` loaders the feed also renders. */
const COMMENT = '[role="article"][aria-label]';
const COMMENT_ID = 'data-commentid';

/** The run of text inside a body. Facebook splits a multi-paragraph body across sibling
 *  `div[dir="auto"]` nodes, so a body is the JOIN of these and not the first one. */
const DIR_AUTO = 'div[dir="auto"]';

/** The text runs of a story on a surface that renders it without a role vocabulary.
 *
 *  A photo permalink's story panel is the one surface measured that writes its runs as
 *  `span[dir="auto"]` — 3 of them, its name, its audience line and a 3981-character body — while
 *  the comment list beside them in the same column writes `div[dir="auto"]` like every other
 *  surface does (41 of them). `DIR_AUTO` stays DIV-only because a comment's words are read through
 *  it: widening that reading to every tag would fold a comment's own inner spans into its text. */
const STORY_RUN = '[dir="auto"]';

/** The links a commenter's name could be written on. `aria-hidden` is the first thing read,
 *  because a row states its name TWICE on the profile it links to — a hidden copy carrying the
 *  badge, then the words themselves — and the hidden one is never the name the reader sees. */
const COMMENT_AUTHOR = 'a[role="link"]:not([aria-hidden="true"])';

/** A comment's own permalink, which is a link in the row too and never the commenter's name. */
const COMMENT_PERMALINK = /[?&](?:comment_id|reply_comment_id)=/;

/** A verified account's badge. Matched by its `viewBox`, never by its `<title>`, which is
 *  the localized string "Verified account" and so differs per reader. */
const VERIFIED_BADGE = 'svg[role="img"][viewBox="0 0 12 12"]';

/** A post's own permalink, and the legacy shapes the same link takes. */
const PERMALINK =
  'a[href*="/posts/pfbid"], a[href*="story_fbid="], a[href*="fbid="], a[href*="set=pcb."], a[href*="/groups/"][href*="/posts/"]';
const PFBID = /\/posts\/(pfbid[0-9A-Za-z]+)/;
const STORY_FBID = /[?&]story_fbid=(\d+)/;
const PHOTO_FBID = /[?&]fbid=(\d+)/;
/** A GROUP's post, named `…/groups/<groupId>/posts/<postId>` in plain decimal.
 *
 *  Measured on a group photo opened in the viewer
 *  (`/photo/?fbid=1486698226840829&set=gm.3006634934732718`), where the post's own permalink
 *  and every comment's timestamp link are written this way and NONE of the three legacy shapes
 *  appear: no `pfbid`, no `story_fbid=`, and the `?fbid=` in the address bar names the photo,
 *  not the post. So the post was unnameable — `postIdIn` answered null, which left each of its
 *  six comments without a parent as well (`enclosingPostId` finds the container by containment
 *  but still asks `postIdIn` for the id). The number is the post's own: it is not the photo's
 *  (`38791061597206378` against `1486698226840829` on that post).
 *
 *  Narrow to `/groups/` on purpose. The same decimal shape is also how a legacy PAGE post is
 *  addressed (`/<page>/posts/<id>`), but a root's markup can carry a related post's link and
 *  none of those was measured; a group's own posts are what this was read from. */
const GROUP_POST_ID = /\/groups\/[^/?#]+\/posts\/(\d+)/;
/** A post's own id wherever a comment's permalink path states one — the tightest source there
 *  is for a comment's parent, because the href is that comment's own link. */
const POST_IN_PATH = /\/posts\/(\d+)/;
/** A photo post's OWN id, from the `set=pcb.<id>` parameter its links carry.
 *
 *  The host's payload states the same number twice for a photo post: the album attachment's
 *  `mediaset_token` is `pcb.<id>`, and the story's own `post_id` is that id (measured on a
 *  four-photo post). Where `?fbid=` names ONE PHOTO — and a four-photo post offers four of
 *  them, plus a fifth number for the album — `pcb` names the post, once. */
const PHOTO_PCB = /[?&]set=pcb\.(\d+)/;

/** The `comment_id` a comment's author link carries: base64 of `comment:<post>_<comment>`.
 *  Read because it names the POST a comment hangs under, which the comment's own markup
 *  otherwise never states — its root is a bare `role="article"` inside the post's DOM. */
const COMMENT_ID_PARAM = /[?&]comment_id=([^&]+)/;
/** The same parameter where the page states it in plain decimal rather than base64 — a group's
 *  posts write it that way (see `commentRef`). */
const PLAIN_COMMENT_ID_PARAM = /[?&]comment_id=(\d+)/;

/** The parameter that separates a reply's own timestamp link from a top-level comment's.
 *  A reply's permalink is `?comment_id=<the comment it answers>&reply_comment_id=<itself>`;
 *  a top-level comment's is `?comment_id=<itself>` alone. Both values are plain decimal.
 *  `HAS_REPLY_PARAM` is the mention itself, whatever its value: on a link that has it, the
 *  `comment_id` beside it names the parent, so it is not a self-id even when it is malformed. */
const REPLY_LINK = 'a[href*="reply_comment_id="]';
const HAS_REPLY_PARAM = /[?&]reply_comment_id=/;
const REPLY_COMMENT_ID_PARAM = /[?&]reply_comment_id=(\d+)/;

const REGULAR: Usertype = UsertypeEnum.Regular;
const VERIFIED: Usertype = UsertypeEnum.Verified;

function namespaced(id: string): string {
  return ID_PREFIX + id;
}

/** The payload's own name for a post, from the adapter's namespaced one.
 *
 *  Everything this adapter reads off the page is keyed the way the payload states it and is
 *  namespaced only on the way out (see `postIdOf`), so the maps the payload fills are asked in
 *  the payload's spelling rather than the adapter's. */
function bareId(id: string): string {
  return id.startsWith(ID_PREFIX) ? id.slice(ID_PREFIX.length) : id;
}

function textOf(el: Element | null | undefined): string {
  return (el?.textContent ?? '').trim();
}

/** A body's own words, with the page's own expander taken out of them.
 *
 *  Facebook writes its "See more"/"See less" INSIDE the body's `dir="auto"` run —
 *  `…<div role="button">See less</div>` — so a plain `textContent` reads that label back as if
 *  it were the post's own words. Measured on a search feed: all five story bodies read 9-10
 *  characters longer than the run's own words, the 8-character label plus the space before it.
 *  It reached everything that reading decides — the post's hash, and so its identity, the context
 *  the classifier is handed, and the length two renders of one post are ranked by. The label is
 *  TRANSLATED, so the same post hashed differently in each UI language it was read in, and on a
 *  permalink it made the feed card behind the modal read LONGER than the modal's own render of
 *  the same story — so the card won the ranking, and its buttons were painted behind the modal
 *  while the post the reader was looking at got none.
 *
 *  Only the ordinary reading is affected: a body the page has TRUNCATED is read through
 *  `visiblePrefix`, which drops these controls already. */
function bodyWords(el: Element | null | undefined): string {
  if (!el) return '';
  const clone = el.cloneNode(true) as Element;
  for (const control of Array.from(clone.querySelectorAll(CONTROL))) control.remove();
  return (clone.textContent ?? '').trim();
}

/** An element's own words, with any badge inside it dropped.
 *
 *  `textContent` includes an SVG `<title>`, which is not rendered as text but IS part of
 *  the string — so a verified account's name reads back as "National Geographic Verified
 *  account". The classifier must be given the name the reader sees. */
function ownText(el: Element | null): string {
  if (!el) return '';
  const clone = el.cloneNode(true) as Element;
  for (const svg of Array.from(clone.querySelectorAll('svg'))) svg.remove();
  return (clone.textContent ?? '').trim();
}

/** A story's username: the words on the profile link inside the name element.
 *
 *  `ownText` alone on the name element is not the name. Measured on a search result whose post WAS
 *  captured (`facebook:2011127539570075`), the role element holds the name link and, beside it,
 *  the host's own relationship control — " · Join", or " · Follow" on a page the reader has not
 *  followed — as a `[role="button"]` sibling, and the adapter filed that post under
 *  "Quebec City Travel · Join". The control's words are written in the READER's language, and the
 *  name is part of the post's own hash (`canonicalContext`), so the same post hashed differently
 *  per reader and re-hashed the moment the reader followed the account.
 *
 *  The link is read first because its words are the name and nothing else: measured on four
 *  surfaces (group feed, home feed, page timeline, search results), every name link carried the
 *  name alone, a verified account's badge is an `<svg>` `ownText` already drops, and the
 *  separator and the control sit outside it. The name element is still the fallback, because a
 *  story with no profile to link to states no link at all — a group's "Anonymous participant" has
 *  zero, and their name lives inside the very `[role="button"]` a broader rule would have
 *  dropped. */
function storyAuthor(name: Element | null): string {
  if (!name) return '';
  for (const link of Array.from(name.querySelectorAll('a[role="link"]'))) {
    const own = ownText(link);
    if (own) return own;
  }
  return ownText(name);
}

/** The post container a `profile_name` sits in: the nearest ancestor that also holds the
 *  story's like button. Capped, because a markup change that removes the like button would
 *  otherwise walk to `document.body` and take the whole page for one post. */
function postRootOf(name: Element): Element | null {
  let el: Element | null = name;
  for (let i = 0; el && el !== document.body && i < 20; i++) {
    if (el.querySelector(LIKE_BUTTON)) return el;
    el = el.parentElement;
  }
  return null;
}

/** The id of the post a comment hangs under, found by containment rather than by decoding.
 *
 *  A comment's own `comment_id` encodes a NUMERIC post id — `comment:<postId>_<commentId>` —
 *  which is the number the post is filed under whenever the payload describing it has been
 *  read (`postIdIn`). Containment is what covers the rest: on a permalink page measured before
 *  that join existed, the post resolved to a pfbid while all 22 comments decoded to one numeric
 *  id, so not one comment's parent was in the captured set and `hydrateReplyChains` — which
 *  links only ids it is given — left every comment with NO ancestor. A comment renders inside
 *  its post's own subtree, so walking up to the nearest ancestor holding a non-comment
 *  `profile_name` names the very post this adapter files, whichever alias its payload turned
 *  out to state, and a post whose payload has not arrived is still linked the same way. */
function enclosingPostId(comment: Element): string | null {
  const story = enclosingPost(comment);
  return story ? postIdIn(story) : null;
}

/** The story CONTAINER a comment hangs under, by the same containment walk `enclosingPostId`
 *  decodes the id from. Split out because more than the id is asked of it: an ad's comments are
 *  not integrated either, and that question is about the story element, not about its name.
 *
 *  Bounded by the two walks' own stops — the nearest ancestor holding a non-comment
 *  `profile_name`, or the footer-only container beside it — so it can never climb to the feed
 *  and take an ad somewhere else in it for this comment's story. */
function enclosingPost(comment: Element): Element | null {
  let el: Element | null = comment.parentElement;
  for (let i = 0; el && el !== document.body && i < 30; i++) {
    // One selector per level, not `querySelectorAll`: this runs for every comment on every
    // DOM mutation. A story's own name precedes any commenter's inside it, so the first
    // `profile_name` in the subtree is the right one to test — inside a comment means this
    // level is not the post yet, so keep walking.
    const name = el.querySelector(NAME);
    if (name && !name.closest(COMMENT)) {
      const root = postRootOf(name);
      if (root && root !== comment) return root;
    }
    el = el.parentElement;
  }
  // Some comments sit in a container that has the story's footer but NO `profile_name` — on a
  // post permalink page, 11 of 22 were like that — so the walk above never finds a post root
  // for them. Those containers do still carry the story's permalink, so the fallback looks for
  // the nearest ancestor holding one. Bounded by requiring the story footer beside it: a
  // comment's own links are not a post, and a commenter's shared link must not be read as one.
  el = comment.parentElement;
  for (let i = 0; el && el !== document.body && i < 30; i++) {
    if (el.querySelector(LIKE_BUTTON) && el.querySelector(SHARE_BUTTON) && postIdIn(el)) return el;
    el = el.parentElement;
  }
  return null;
}

/** The host's own menu control inside a row, or null when the row holds none.
 *
 *  A row is only a story's header bar if it carries this: the control is what the buttons
 *  are inset from, and looking for it is also what tells the header bar apart from the flex
 *  rows nested inside it (the name's own line is a flex row too, and holds no control).
 *  Buttons belonging to the author's name are excluded, so a name that is itself a button
 *  cannot be mistaken for the menu. */
function menuControl(row: Element): Element | null {
  const name = row.querySelector(NAME);
  const buttons = Array.from(row.querySelectorAll(CONTROL)).filter((b) => !name?.contains(b));
  return buttons.length ? buttons[buttons.length - 1] : null;
}

/** Whether an element has a box of its own on the page. */
function hasBox(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0;
}

/** Whether an element, or anything inside it, is on the page at all.
 *
 *  Facebook hides whole pages in the DOM rather than removing them: opening a photo out of the
 *  feed puts the viewer on screen and leaves the feed `display: none` behind it. Measured on
 *  that surface (`/photo/?fbid=1411849487767999&set=a.176106994675594` opened from the feed),
 *  the hidden subtree held the page's chrome and a complete render of the story — and the ONLY
 *  role vocabulary in the whole document (`profile_name`, `story_message`, the footer's three
 *  buttons) while the viewer on screen stated none. `nearViewport` reads a hidden element's
 *  `0,0,0,0` rect as inside every screen, so that copy was announced, classified, and given a
 *  bar at a spot the reader has never seen; `postRoots` hands back every element carrying an
 *  id, so the hidden root also drags a second bar into that subtree. A story that is not on the
 *  page is not a post: it gets no buttons and no classification, exactly like a truncated one.
 *
 *  Asked of the scope as a whole rather than of the element's own box, because Facebook wraps
 *  run after run in `display: contents` — which lays out no box of its own — and a root that is
 *  one would otherwise be refused while it is plainly on screen. The descent is paid only when
 *  the scope has no box of its own, which is the hidden case; there the walk stops at the first
 *  run it reads, since every descendant of a `display: none` subtree has no box either. */
function painted(scope: Element): boolean {
  if (hasBox(scope)) return true;
  for (const run of Array.from(scope.querySelectorAll(STORY_RUN))) if (hasBox(run)) return true;
  return false;
}

/** Whether a root is part of a surface the page has laid OVER everything else.
 *
 *  A dialog is what the reader is looking at; what it covers keeps a box of its own, which is
 *  why `painted` cannot tell the two apart. Read as the platform's own role, never as a class —
 *  measured on the permalink modal the reader opens with a post's "[n] comments" control. */
function inDialog(el: Element): boolean {
  return el.closest('[role="dialog"]') !== null;
}

/** Whether this page is one of Facebook's video-first surfaces rather than a post surface.
 *
 *  Video is played on routes of its own and none of them is a post: the reel feed and its
 *  permalinks (`/reel/…`), the watch player (`/watch/…`, measured redirecting into `/reel/`),
 *  and a Page's video tab and video permalinks (`/<page>/videos/…`). A reel or a video has no
 *  words of its own to judge, and its comment list is the same markup an ordinary post's
 *  comments use — so without this the extension integrates comments on a surface it has no
 *  business on. Both refusals are needed together (`postRootsFromDom` and `commentRoots`): the
 *  posts on these routes are found by `footerStoryRoots` on some builds, and the comments are
 *  found by the plain comment selector on every one.
 *
 *  Read from the PATH, never from the markup. It is the one thing on these pages identical for
 *  every reader and every build; the player's own markup is build-hashed classes and its
 *  controls are translated labels, both of which this rollout refuses (`no brittle anchors`).
 *  Segments are compared whole, so a path that merely contains the letters — `/reelsomething` —
 *  is not caught. */
function onVideoSurface(): boolean {
  const segments = location.pathname.split('/');
  for (const segment of segments) {
    if (segment === 'reel' || segment === 'reels' || segment === 'video' || segment === 'videos') return true;
  }
  return segments[1] === 'watch';
}

function postRootsFromDom(): Element[] {
  if (onVideoSurface()) return [];
  // One id, one text — `post-id-names-one-text`. Facebook renders the SAME story more than
  // once on a permalink page: the post opens in a `role="dialog"` laid over the feed, and
  // the card left behind is a SHORTER render of that same story (measured: 414 characters
  // in the dialog, 178 in the card behind, both carrying one identical permalink). Two
  // roots under one id would leave which of the two texts gets classified — and which gets
  // painted — up to DOM order, so the fuller render wins. The shorter one is a prefix of
  // it, and a prefix names nothing on its own — the post's hash is over its whole text, so the
  // shorter render would be filed as a second post that does not exist.
  //
  // The lengths are read only when an id actually collides, which keeps the common case —
  // one root per post — a single query per post and no text read at all.
  //
  // A root nobody can see is not in the running at all (`painted`): the hidden feed behind a
  // photo viewer carries its own copy of the story, and it is a COPY, not the thing the reader
  // is reading. It is also the copy that wins on length — the feed card behind a viewer was
  // expanded, the viewer's own render was not — so leaving it in would file the post under
  // words the reader cannot see and paint there.
  const byId = new Map<string, { root: Element; len: number | null }>();
  const claim = (id: string, root: Element): void => {
    const seen = byId.get(id);
    if (!seen) {
      byId.set(id, { root, len: null });
      return;
    }
    // The render the reader is LOOKING AT wins over the copy behind it, whatever their lengths:
    // a modal's copy and the card beneath it hold the same words, so length cannot separate them
    // and whichever the scan met first would decide where the buttons go. Measured on a search
    // feed, the card was met first and took them, leaving the post in the modal buttonless while
    // its comments — whose own rows are their own roots — kept theirs.
    if (inDialog(root) !== inDialog(seen.root)) {
      if (inDialog(root)) byId.set(id, { root, len: bodyLength(root) });
      return;
    }
    const len = bodyLength(root);
    const seenLen = seen.len ?? bodyLength(seen.root);
    if (len > seenLen) byId.set(id, { root, len });
    else seen.len = seenLen;
  };
  for (const name of Array.from(document.querySelectorAll(NAME))) {
    // A commenter's name is a `profile_name` too, and its nearest like button is the
    // COMMENT's. Skipping it here is what keeps a comment from being captured as a post
    // as well — one element must not become two posts with two ids over one text.
    if (name.closest(COMMENT)) continue;
    const root = postRootOf(name);
    if (!root || !painted(root)) continue;
    // A paid placement is not integrated: no buttons, no classification, and no entry in the
    // batch it could be linked into as somebody's ancestor (see `sponsored`).
    if (sponsored(root)) continue;
    const id = postIdIn(root);
    if (!id) continue;
    claim(id, root);
  }
  // The blocks on a surface whose markup states no role vocabulary for the story, which is a
  // photo permalink and the lightbox over a feed (see `footerStoryRoots`). They are claimed
  // through the same map, so a lightbox opened over the feed and the card left behind it — one
  // id rendered twice, the modal's copy and the feed's — collapse to the fuller render exactly
  // as two role roots do.
  for (const block of footerStoryRoots()) {
    const id = postIdIn(block);
    if (id) claim(id, block);
  }
  return Array.from(byId.values(), (entry) => entry.root);
}

/** The comments the reader can see. A hidden copy of the page holds comment rows too, and a
 *  comment nobody can read is not a comment — its words would be classified and its ancestors
 *  linked against a post that is not on the page (`painted`). A comment on a video-first page is
 *  not a comment either, whatever it looks like: those pages render their comment list from this
 *  same markup, and there is no post under it to hang one from (`onVideoSurface`). */
function commentRoots(): Element[] {
  if (onVideoSurface()) return [];
  return Array.from(document.querySelectorAll(COMMENT)).filter(
    (root) => hasBox(root) && !underSponsoredStory(root),
  );
}

/** Whether a comment sits under a story this adapter refuses as a paid placement.
 *
 *  An ad's comment list is part of the ad. Integrated, a comment there would be classified
 *  and drawn as if it stood on its own — and its `enclosingPostId` would name a post that is
 *  in no batch at all, so it would be filed with no ancestor and no pill to reach it. */
function underSponsoredStory(comment: Element): boolean {
  const story = enclosingPost(comment);
  return !!story && sponsored(story);
}

/** What each block found by `footerStoryRoots` is made of — its body, its header bar and its
 *  author link — keyed by the block. A surface whose markup states no role vocabulary for the
 *  story states none of the three either, so all three are found once, structurally, and the
 *  capture, the painter and the highlighter are handed the same elements (see `storyMessage`). */
const footerBlocks = new WeakMap<Element, { body: Element; row: Element; author: Element }>();

/** The bar a story's own controls sit in: the nearest ancestor of its like button that also holds
 *  its share button. Every surface measured puts both in one row — a feed story, a post
 *  permalink, a photo permalink — and that row is what a block is found from. */
function footerRowOf(like: Element): Element | null {
  let el: Element | null = like;
  for (let i = 0; el && el !== document.body && i < 8; i++, el = el.parentElement) {
    if (el.querySelector(SHARE_BUTTON)) return el;
  }
  return null;
}

/** What a story's own block can be, seen from its footer row: every child of the row's ancestors
 *  that holds a `dir="auto"` run of its own but neither the row, a comment, nor a role element —
 *  nearest ancestor first, so the story's own block is reached before anything that encloses it.
 *
 *  A photo permalink is what this exists for. Measured there
 *  (`/photo/?fbid=1954544955982401&set=a.754418329328409`): the whole document holds exactly
 *  three role elements, all of them the story's footer, so `postRootsFromDom` found no root at
 *  all and the story behind the comments got no buttons and no classification — while the panel
 *  itself renders as three siblings (header+body, the footer row, the comment list, all three
 *  under the story's column) and says nothing about which is which. The header and the body are
 *  what the reader is looking at, so they are what the block is.
 *
 *  A candidate is only a candidate: the footer's own furniture qualifies by this description too
 *  — the row's ancestor holds the like and comment COUNTS as a sibling subtree — and `footerStoryRoots`
 *  is what tells them apart, by the author link and the words a story block has and a count does
 *  not. Returning every level's candidates rather than one is what lets a level be rejected
 *  without giving up the story above it: the first reading of this walked to the first level with
 *  a single candidate, found the counts there, and stopped. */
function storyBlockCandidates(footer: Element): Element[] {
  const out: Element[] = [];
  let el: Element | null = footer.parentElement;
  for (let i = 0; el && el !== document.body && i < 10; i++, el = el.parentElement) {
    for (const child of Array.from(el.children)) {
      if (child.contains(footer)) continue;
      if (child.querySelector(COMMENT)) continue;
      if (child.querySelector(`[${ROLE}]`)) continue;
      if (!child.querySelector(STORY_RUN)) continue;
      out.push(child);
    }
  }
  return out;
}

/** The story's author link inside a block that has no `profile_name`: the one link whose address
 *  is a single path segment and which carries words of its own.
 *
 *  Both halves are load-bearing, and both were measured on the photo permalink's header. A single
 *  segment is what a profile address is — the avatar's link points at
 *  `/stories/332901924813387/UzpfSVND…` (two segments) and the audience control's at a bare
 *  `?__tn__=…` query. Words of its own is what separates the name from an avatar whose link DOES
 *  point at the profile: `ownText` drops SVG, so a link whose only text is a `<title>` reads as
 *  empty and the name beside it wins. An element with an `href` it cannot parse is skipped rather
 *  than guessed at. */
function blockAuthorLink(block: Element): Element | null {
  for (const a of Array.from(block.querySelectorAll('a[href]'))) {
    const href = a.getAttribute('href');
    if (!href) continue;
    let path: string;
    try {
      path = new URL(href, location.href).pathname;
    } catch {
      continue;
    }
    if (!/^\/[^/?#]+\/?$/.test(path)) continue;
    if (ownText(a)) return a;
  }
  return null;
}

/** The header bar inside such a block: the topmost ancestor of the author link that stops short
 *  of the body.
 *
 *  With a body in hand that is the definition — the header is everything above it. Without one
 *  (the body is read from the header's own runs) the stop is the run count: a header holds the
 *  name and the audience line, so the first ancestor holding more than two runs is the container
 *  that has taken the body in. Measured on the photo permalink, both readings name the same
 *  element: the name's own line and the header row hold two runs each, and the container below
 *  the header row holds three. A link with no wrapper at all is not a bar, and `null` says so. */
function blockHeaderRow(block: Element, body: Element | null): Element | null {
  const link = blockAuthorLink(block);
  if (!link) return null;
  let row: Element = link;
  while (row.parentElement && row.parentElement !== block) {
    const parent = row.parentElement;
    const taken = body ? parent.contains(body) : parent.querySelectorAll(STORY_RUN).length > 2;
    if (taken) break;
    row = parent;
  }
  return row === link ? null : row;
}

/** The story's words inside such a block, and the id they name when the payload states them.
 *
 *  The payload's text comes first: the same payload states this post's id, so a run holding its
 *  words IS its body — the only join there is where the markup names the story nowhere. The two
 *  sides are compared squeezed, because the payload keeps the newlines a post's paragraphs are
 *  written with while the renderer puts each paragraph in its own block and runs them together
 *  with nothing between.
 *
 *  With nothing to match — a payload not read yet, or a page showing a TRANSLATION of the post —
 *  the longest run outside the header stands in, but only when it is longer than everything
 *  inside the header. A caption shorter than the account's own name is otherwise
 *  indistinguishable from one, and guessing there would file this post's id under another post's
 *  words, which `post-id-names-one-text` refuses. A block this side cannot read is a block with
 *  no buttons, which is exactly what that surface has today. */
function blockBodyOf(block: Element, row: Element | null): { body: Element; postId: string | null } | null {
  const runs = Array.from(block.querySelectorAll(STORY_RUN)).filter((run) => !row || !row.contains(run));
  let matched: { body: Element; postId: string | null } | null = null;
  let longest: Element | null = null;
  for (const run of runs) {
    if (!longest || textOf(run).length > textOf(longest).length) longest = run;
    if (matched) continue;
    const shown = squeeze(textOf(run));
    if (shown.length < MIN_MESSAGE_MATCH) continue;
    for (const [postId, text] of postIdMessages) {
      // Cut to the fingerprint here rather than when it was stored, because the same entry is
      // read whole by `wholeBodyText`. `squeeze` of an already-squeezed string is that string,
      // so this compares exactly what storing the fingerprint used to compare.
      const message = squeeze(text).slice(0, MESSAGE_FINGERPRINT);
      if (!message.startsWith(shown) && !shown.startsWith(message)) continue;
      matched = { body: run, postId };
      break;
    }
  }
  if (matched) return matched;
  if (!longest) return null;
  const header = row ? Math.max(0, ...Array.from(row.querySelectorAll(STORY_RUN)).map((el) => textOf(el).length)) : 0;
  return textOf(longest).length > header ? { body: longest, postId: null } : null;
}

/** The story the page's own address names, when it names one the payload has resolved.
 *
 *  A photo permalink's address states one of the post's PHOTOS (`?fbid=…`), which is an alias the
 *  payload resolves to the story's `post_id` — so this is still the network's answer, named by
 *  the markup, never a guess: a name no payload has stated resolves to nothing and the block is
 *  left without an id rather than filed under its photo's number. */
function documentStoryId(): string | null {
  const name = permalinkId(location.pathname + location.search);
  return name ? postIdAliases.get(name) ?? null : null;
}

/** The story blocks on a surface whose markup states no role vocabulary for them (see
 *  `storyBlockCandidates`), each frozen — id, body, header bar and author — as it is found.
 *
 *  Frozen for the same reason a role root is (`postIdIn`): a block answers with one id for its
 *  whole life, and every later read of its body or its header has to agree with the capture that
 *  has already been paid for.
 *
 *  The address fallback is used only when the page holds exactly ONE such block. A page whose
 *  address names one photo while showing one story is what a photo permalink is; a page naming
 *  one photo while showing several would leave which story the address means unknowable — and an
 *  id bound to the wrong story is worse than no buttons at all. */
function footerStoryRoots(): Element[] {
  // The payload may be exactly what identifies these blocks, so the page's own blobs are read
  // first — the same gate `postIdIn` passes before it resolves anything.
  scanEmbeddedPostIds();
  const found: Array<{ block: Element; body: Element; postId: string | null; row: Element; author: Element }> = [];
  const seen = new Set<Element>();
  for (const like of Array.from(document.querySelectorAll(LIKE_BUTTON))) {
    // A comment's footer is a like button too, and the block above it is the comment's own row.
    if (like.closest(COMMENT)) continue;
    // A hidden copy of the page states the same footer (measured: the two like buttons on a
    // viewer opened over the feed, one on screen and one inside the hidden feed), and its
    // block is not the one the reader is looking at.
    if (!painted(like)) continue;
    const footer = footerRowOf(like);
    if (!footer) continue;
    for (const block of storyBlockCandidates(footer)) {
      if (seen.has(block)) continue;
      // The role vocabulary, where it exists, is the better reading and has already been taken
      // by `postRootsFromDom`: a candidate holding it is this story, and no higher candidate is.
      if (block.querySelector(MESSAGE)) break;
      const author = blockAuthorLink(block);
      if (!author) continue;
      const rough = blockHeaderRow(block, null);
      const hit = blockBodyOf(block, rough);
      if (!hit) continue;
      const row = blockHeaderRow(block, hit.body) ?? rough;
      if (!row) continue;
      seen.add(block);
      found.push({ block, body: hit.body, postId: hit.postId, row, author });
      break;
    }
  }
  const addressed = found.length === 1 ? documentStoryId() : null;
  const roots: Element[] = [];
  for (const candidate of found) {
    // Remembered before anything names the block: its words are read off the body recorded here,
    // so a block's digest is only computable once that is in place (see `rootWordsOf`).
    footerBlocks.set(candidate.block, { body: candidate.body, row: candidate.row, author: candidate.author });
    // The block's own words are the last resort, and they are what a photo permalink or a
    // lightbox card rests on when neither its markup nor the page's address names the story.
    const id = candidate.postId ?? addressed ?? postIdIn(candidate.block);
    if (!id) continue;
    resolvedRootIds.set(candidate.block, id);
    roots.push(candidate.block);
  }
  return roots;
}

/** The id a URL's permalink encodes, or null when it carries none of the three shapes. */
function permalinkId(href: string): string | null {
  const pfbid = href.match(PFBID);
  if (pfbid) return pfbid[1];
  const story = href.match(STORY_FBID);
  if (story) return story[1];
  const photo = href.match(PHOTO_FBID);
  return photo ? photo[1] : null;
}

function postIdIn(root: Element): string | null {
  // The id a root was FIRST resolved to, remembered for as long as the element lives. A root
  // must answer with one id for its whole life: `postRoots`, `isPostTarget` and
  // `enclosingPostId` all compare an id against `postIdOf(root)`, so a root whose id changes
  // under it — which is what a payload arriving after the first sweep would otherwise do —
  // would leave the post it was captured as unreachable while its markup kept a second
  // identity. Frozen here rather than at capture so every caller agrees, including the ones
  // that run before the capture (see `absorbPostIds` for when the payload can be late).
  const frozen = resolvedRootIds.get(root);
  if (frozen !== undefined) return frozen;
  scanEmbeddedPostIds();
  // Preference, not document order. A root offers several ids and they are not
  // interchangeable: `…/posts/pfbid…` is Facebook's canonical permalink, `set=pcb.<id>` is
  // the post's own id for a photo post (see `PHOTO_PCB`), and `?fbid=` names one PHOTO — a
  // four-photo post offers four of those plus a fifth for the album, so whichever link came
  // first in the markup would name one post four or five ways, the collision
  // `post-id-names-one-text` forbids.
  //
  // Each name is first offered to the payload's own map, which is the only side that knows
  // the story's `post_id`: the markup never states it. A name the map does not know is kept
  // as it is, so a post whose payload has not been seen is still filed under the name its
  // markup carries rather than skipped.
  let pfbid: string | null = null;
  let story: string | null = null;
  let group: string | null = null;
  let pcb: string | null = null;
  let photo: string | null = null;
  for (const a of Array.from(root.querySelectorAll(PERMALINK))) {
    const href = a.getAttribute('href') ?? '';
    pfbid ??= href.match(PFBID)?.[1] ?? null;
    story ??= href.match(STORY_FBID)?.[1] ?? null;
    // A group post's own id outranks the photo ids below for the reason `pcb` does: it names
    // the POST, where `?fbid=` names one photo of it (see `GROUP_POST_ID`).
    group ??= href.match(GROUP_POST_ID)?.[1] ?? null;
    pcb ??= href.match(PHOTO_PCB)?.[1] ?? null;
    photo ??= href.match(PHOTO_FBID)?.[1] ?? null;
  }
  for (const name of [pfbid, story, group, pcb, photo]) {
    if (!name) continue;
    const resolved = postIdAliases.get(name);
    if (resolved) {
      resolvedRootIds.set(root, resolved);
      rememberTextId(root, resolved);
      return resolved;
    }
  }
  const fallback = pfbid ?? story ?? group ?? pcb ?? photo;
  if (fallback) {
    resolvedRootIds.set(root, fallback);
    rememberTextId(root, fallback);
    return fallback;
  }
  // Nothing in the markup names this story at all. Its own words do (see `rootWordsOf`): the
  // payload's id for those words when the payload described them, and a digest of them when it
  // did not. Without this the story is unnameable — no pill, and every comment under it left
  // without a parent, because `enclosingPostId` can only find the post by asking this.
  //
  // Frozen like any other name, so a story captured under it keeps ONE identity for the
  // element's life: a later render stating the real id joins through `textIdNames` rather than
  // renaming this root under a capture that has already been paid for.
  const words = rootWordsOf(root);
  if (!words) return null;
  const named = textIdNames.get(words.key) ?? postIdMarks.get(words.mark) ?? null;
  const name = named ?? TEXT_ID_PREFIX + words.key;
  if (named) textIdNames.set(words.key, named);
  resolvedRootIds.set(root, name);
  return name;
}

/** The words a root states as a name, or null when it states none to be named by.
 *
 *  The author is read exactly as `capture` reads it — the name's own role where the surface
 *  states one, the block's author link where it does not — so the two cannot disagree about whose
 *  post this is. */
function rootWordsOf(root: Element): { key: string; mark: string } | null {
  const memo = rootWords.get(root);
  if (memo) return memo;
  if (isTranslated(root)) return null;
  const body = storyMessage(root);
  const link = footerBlocks.get(root)?.author ?? null;
  const username = storyAuthor(root.querySelector(NAME) ?? link);
  const text = squeeze(bodyWords(body));
  if (!text || !username) return null;
  const words = { key: wordsDigest(username, text), mark: text.slice(0, MESSAGE_FINGERPRINT) };
  rootWords.set(root, words);
  return words;
}

/** Remember which digest these words are, when a root states both a digest and a real id (see
 *  `postIdIn`). The mark would do the same and cheaper, but only where the payload described the
 *  story — this is the join that also covers a story the payload never carried. */
function rememberTextId(root: Element, id: string): void {
  const words = rootWordsOf(root);
  if (!words || words.mark.length < MIN_MESSAGE_MATCH) return;
  textIdNames.set(words.key, id);
  while (textIdNames.size > MAX_REMEMBERED_TEXT_IDS) {
    const oldest = textIdNames.keys().next().value;
    if (oldest === undefined) break;
    textIdNames.delete(oldest);
  }
}

/** The `comment:<post>_<comment>` pair a comment's own links encode, or null.
 *
 *  A comment root carries NO id attribute of its own: `data-commentid` marks the one
 *  comment a permalink FOCUSES, not every comment in the thread (measured — it was absent
 *  from all eight comment roots on one post, and present on the post root that arrived
 *  from a comment permalink). So the id comes from the link every comment's own markup
 *  carries, whose `comment_id` parameter is base64 of `comment:<postFbid>_<commentId>`.
 *  Decoded defensively: it is a page-authored string, and one that fails to decode simply
 *  leaves the comment without an id — no buttons, rather than a guessed one. */
function commentRef(root: Element): { post: string; comment: string } | null {
  const attr = root.getAttribute(COMMENT_ID);
  const links = Array.from(root.querySelectorAll('a[href]'));
  for (const a of links) {
    const param = (a.getAttribute('href') ?? '').match(COMMENT_ID_PARAM);
    if (!param) continue;
    try {
      const m = atob(decodeURIComponent(param[1])).match(/^comment:(\d+)_(\d+)/);
      // The attribute, when present, is the same number in plain decimal; prefer it so a
      // root that has one does not depend on the link staying where it is.
      if (m) return { post: m[1], comment: attr || m[2] };
    } catch { /* not base64 after all: nothing to read */ }
  }
  if (attr) return { post: '', comment: attr };
  // A GROUP's posts state the two numbers in PLAIN DECIMAL instead. Measured on the group photo
  // above (`GROUP_POST_ID`): each of its six comment rows carried exactly one `comment_id` link
  // — its own timestamp, `2h`/`4h`/`7h` — shaped `…/groups/<gid>/posts/<postId>/?comment_id=<n>`,
  // and `atob` on those numbers either threw or produced garbage, so every one of the six went
  // unfiled (`announcing 0 post(s)` on every sweep of that page) while six comments of the same
  // size on an album photo resolved and got their buttons.
  //
  // The self-id is read the way `commentParentId` reads a parent, because on this shape the two
  // are the same parameter: the host writes `?comment_id=<the comment it answers>` on a REPLY's
  // link and `?comment_id=<itself>` on a top-level comment's (see `REPLY_LINK`). Checked against
  // the host's own statement on that post — the reply revealed under its first comment names
  // `comment_id=38797313466581191`, which is the id the sibling above it states for itself. A
  // link that mentions `reply_comment_id` is therefore read from that parameter only, never from
  // its `comment_id`, which on it is the parent. Two links stating different numbers are two
  // different statements, and a guessed id is worse than none: the row is left without one, as a
  // link that fails to decode leaves it.
  let self: string | null = null;
  let post = '';
  for (const a of links) {
    const href = a.getAttribute('href') ?? '';
    const found = HAS_REPLY_PARAM.test(href)
      ? href.match(REPLY_COMMENT_ID_PARAM)?.[1] ?? null
      : href.match(PLAIN_COMMENT_ID_PARAM)?.[1] ?? null;
    if (!found) continue;
    if (self !== null && self !== found) return null;
    self = found;
    post ||= href.match(POST_IN_PATH)?.[1] ?? href.match(STORY_FBID)?.[1] ?? href.match(PHOTO_FBID)?.[1] ?? '';
  }
  return self ? { post, comment: self } : null;
}

/** The comment a comment answers, when it answers one, in plain decimal — or null for a
 *  top-level comment.
 *
 *  Its own timestamp link is the host's own statement of the relationship: a reply reads
 *  `…?comment_id=<the comment it answers>&reply_comment_id=<itself>`, where a top-level
 *  comment reads `…?comment_id=<itself>` and carries no `reply_comment_id` at all. Both are
 *  structural parameters, where the row's `aria-label` — `Reply by Marin Taraba to Otto Kis's
 *  comment` — is an English sentence that translates, so the label's VALUE is never matched.
 *
 *  Checked against the host's own comment payload, which carries the same edge explicitly as
 *  `comment_direct_parent`: on a 9GAG permalink the two replies resolved to the comment that
 *  payload named, and the twelve top-level ones carried no `reply_comment_id` and no parent.
 *
 *  Correct ONE LEVEL UP, and wrong beyond it: the link names the comment a reply answers
 *  when that comment is top-level, and the thread's ROOT when the reply answers another
 *  reply (measured 120/120 right at depth 1, 0/32 at depth 2). The layout cannot make up
 *  the difference — no comment root is nested inside another (0 of 31 sub-replies), and the
 *  direct parent's id appears nowhere in a sub-reply's own 13–19KB of markup (0 of 12). So
 *  this is the fallback, and `commentParents` — filled from the payload — is what a comment
 *  the host's API described is filed with instead.
 *
 *  The value is in the same legacy-decimal space as a comment's own id (see `commentRef`), so
 *  the two join directly — as does the post itself, which is filed under the payload's own
 *  `post_id` once that payload has been read (see `postIdIn`). */
function commentParentId(root: Element): string | null {
  const param = (root.querySelector(REPLY_LINK)?.getAttribute('href') ?? '').match(/[?&]comment_id=(\d+)/);
  return param ? param[1] : null;
}

/** The id a root stands for, or null when it is not a post this adapter integrates.
 *
 *  Called for every root on every DOM mutation, so it is one query at most per branch and
 *  never walks the tree. */
function postIdOf(root: Element): string | null {
  // The mobile app's own stories, named by their words (see the mobile section below). Gated on
  // the element, so a desktop root never reaches that reading and no desktop answer changes.
  if (isMobileRoot(root)) {
    // A comment before a story: both are `MContainer`s, and asking the story's reader first
    // would take the comment's own words for the story around it — the scroller holds every
    // comment on the page, so it would answer with one comment's name for the whole thread.
    if (isMobileComment(root)) {
      const comment = mobileCommentId(root);
      return comment ? namespaced(comment) : null;
    }
    const bare = mobileBareId(root);
    return bare ? namespaced(bare) : null;
  }
  if (root.matches(COMMENT)) {
    const ref = commentRef(root);
    return ref ? namespaced(ref.comment) : null;
  }
  const id = postIdIn(root);
  return id ? namespaced(id) : null;
}

/** Whether a body is clipped by the page, i.e. whether the reader is being shown a prefix.
 *
 *  Locale-independent by construction: a computed line clamp or a height-bounded, hidden
 *  overflow is a fact about the layout, where the expander's own label ("See more") is a
 *  translated string this rollout refuses to match on. Nothing measured so far trips it —
 *  see this file's header — so this is the catch for the first surface that does. */
function bodyClamped(body: Element): boolean {
  let el: Element | null = body;
  for (let i = 0; el && el !== document.body && i < 8; i++) {
    const cs = getComputedStyle(el);
    const clamp = (cs as unknown as { webkitLineClamp?: string }).webkitLineClamp;
    if (clamp && clamp !== 'none') return true;
    if (cs.overflow !== 'visible' && cs.overflow !== 'auto') {
      const max = parseFloat(cs.maxHeight);
      if (Number.isFinite(max) && el.scrollHeight > max) return true;
    }
    el = el.parentElement;
  }
  return false;
}

/** A story's own words: the element its body's `dir="auto"` runs join into.
 *
 *  The role where the surface states one. A photo permalink and the lightbox over a feed state
 *  none — measured, the whole document holds three role elements and all three are the story's
 *  footer — so those blocks are read structurally and their body frozen when the block is found
 *  (see `footerStoryRoots`).
 *
 *  A body that is only a link preview has neither, and the ad body carries its own marker, which
 *  is read only to RECOGNISE it (see `capture`). */
function storyMessage(root: Element): Element | null {
  const direct = root.querySelector(MESSAGE);
  return direct ?? footerBlocks.get(root)?.body ?? null;
}

/** How much text a root carries, for choosing between two renders of one post. */
function bodyLength(root: Element): number {
  return bodyWords(storyMessage(root)).length;
}

/** The length at which a post stops being one the reader takes in at a glance.
 *
 *  Measured 2026-10-01 on a group feed at 1400px: every clipped story rendered the SAME 262
 *  characters of `dir="auto"` run — 254 of the post's own text plus the page's 8-character
 *  "See more" control, which the run holds inside itself — while the posts shown whole were
 *  191 and 89. That is where this platform's own 250 came from. It is no longer per-platform:
 *  two lines is a fact about this column, not about the post — the same 400-character story
 *  is shown whole on a permalink — so every platform reads the universal `LONG_FORM_CHARS`. */

/** Whether the page is showing a PREFIX of a piece of text — a comment's body or a story's.
 *
 *  Facebook truncates in place: the text keeps its `dir="auto"` run, is cut, and the page
 *  writes an ellipsis and its own expander INSIDE that same run —
 *  `…<div role="button">See more</div>`, measured on a comment of 262 characters and again on
 *  a Page's post. Both halves are read structurally: the control by its role, never by its
 *  translated label, and the ellipsis as the character the page leaves at the cut once the
 *  control is taken out of the text.
 *
 *  Layout is no help here, which is why this is not what `bodyClamped` asks. Measured, the box
 *  around a truncated body and the box around a complete one report the same 8px of hidden
 *  overflow — that 8px belongs to a descendant, not to the clip — so no computed style
 *  separates the two. The expander's presence does.
 *
 *  What a body the page is showing a prefix of is FOR: it tells the caller the rendered words are a
 *  prefix rather than the whole text, so the rest can be supplied from the page's own payload —
 *  `wholeBodyText` for a story's message, `wholeCommentText` for a comment's body. A body that is
 *  truncated is never filed as the prefix alone (see `truncated-means-excluded`). */
function bodyTruncated(root: Element): boolean {
  return truncationControl(root) !== null;
}

/** The page's own expander inside a body it is showing a prefix of, or null when nothing is
 *  being held back.
 *
 *  The element itself when it IS a run, whatever tag it is written with: a photo permalink's
 *  body is a `span[dir="auto"]`, and `DIR_AUTO`'s DIV-only reading would look past it and see a
 *  body with no runs at all — which is a body that is never truncated, on the one surface whose
 *  texts are the longest measured.
 *
 *  The control returned is the LAST one in the run, which is where the expander sits: the run
 *  ends `…<div role="button">See more</div>`, so any other control inside the words — a mention,
 *  a link preview's own button — is before it. Its LABEL is never read; it is a translated string
 *  this rollout refuses to match on. */
function truncationControl(root: Element): Element | null {
  const runs =
    root.getAttribute('dir') === 'auto' ? [root] : Array.from(root.querySelectorAll(DIR_AUTO));
  for (const el of runs) {
    const controls = Array.from(el.querySelectorAll(CONTROL));
    if (controls.length === 0) continue;
    const clone = el.cloneNode(true) as Element;
    for (const control of Array.from(clone.querySelectorAll(CONTROL))) control.remove();
    if (!/…$/.test((clone.textContent ?? '').trim())) continue;
    return controls[controls.length - 1];
  }
  return null;
}

/** Whether a body's own words still stop at the cut the page leaves there.
 *
 *  `truncationControl`'s first half without its second: the ellipsis inside the run — the page
 *  cuts a body in place and writes it there — with no regard for the control beside it. The two
 *  come apart for real, and in the direction that matters: the page removes its control the
 *  moment it is clicked, and the text it was holding arrives a re-render later, so a body read in
 *  that window still stops at the cut with no control to point at it. Read only to know the words
 *  are a prefix; completing them is `wholeBodyText`'s job. */
function endsAtCut(body: Element): boolean {
  const runs = body.getAttribute('dir') === 'auto' ? [body] : Array.from(body.querySelectorAll(DIR_AUTO));
  for (const el of runs) {
    const clone = el.cloneNode(true) as Element;
    for (const control of Array.from(clone.querySelectorAll(CONTROL))) control.remove();
    if (/…$/.test((clone.textContent ?? '').trim())) return true;
  }
  return false;
}

/** The expander holding back a root's own words, whichever kind of root this is: a story states
 *  its words at `story_message`, a comment states them on the row itself. */
function expanderOf(root: Element): Element | null {
  const body = root.matches(COMMENT) ? root : storyMessage(root);
  return body ? truncationControl(body) : null;
}

/** A root's own body length, clipped or not — how much of that text the page is holding.
 *
 *  The signal an expansion is watched for. It is read as the joined `dir="auto"` runs for a
 *  comment and as the story's own message for a story, which is the same split `expanderOf`
 *  makes, so the number moves with the body the expander belongs to and with nothing else. */
function ownBodyLength(root: Element): number {
  return root.matches(COMMENT) ? (commentText(root) ?? '').length : bodyLength(root);
}

/** How many times the page's expander may be clicked for one root before it is left alone.
 *
 *  Copied from `quora.ts` rather than shared, because the two are bounded for the same reason
 *  and not by the same fact: a control that will not open must not be clicked forever, and the
 *  host re-renders its own DOM on interaction, so a root can outlive the element that was
 *  clicked. Three is what Quora's clamp needed; the failure it guards against here is the same
 *  one — a click that changes nothing, retried on every sweep. */
const MAX_EXPAND_ATTEMPTS = 3;
const EXPAND_POLL_MS = 25;
const EXPAND_POLLS = 40;
const expandAttempts = new WeakMap<Element, number>();
/** The tail of the expansions, so the clicks are one at a time.
 *
 *  A click is a real interaction with the host and the host answers it by re-rendering, so two
 *  overlapping clicks would interleave two of those re-renders under each other's polls. Held
 *  as the promise rather than a flag so each caller awaits the whole queue ahead of it. */
let expanding: Promise<void> = Promise.resolve();

/** The part of a truncated body that is actually on screen: its words with the page's own
 *  expander taken out and the ellipsis at the cut removed. */
function visiblePrefix(body: Element): string {
  const clone = body.cloneNode(true) as Element;
  for (const control of Array.from(clone.querySelectorAll(CONTROL))) control.remove();
  return (clone.textContent ?? '').replace(/…\s*$/, '').trim();
}

/** Where in `full` the words `visible` end, or -1 when `full` does not begin with them.
 *
 *  Compared the way a payload and a render are compared everywhere else in this file, with every
 *  whitespace run removed (`squeeze`): the payload separates paragraphs with a newline where the
 *  renderer runs them together with nothing between. The index returned is into `full` itself, so
 *  the caller keeps `visible` verbatim — which is what makes the offsets the classifier returns
 *  into the first part of the text land on the page's own characters. */
function endOfVisiblePrefix(full: string, visible: string): number {
  const target = squeeze(visible);
  if (!target) return -1;
  let j = 0;
  for (let i = 0; i < full.length; i++) {
    const ch = full[i];
    if (/\s/.test(ch)) continue;
    if (j >= target.length || ch !== target[j]) return -1;
    if (++j === target.length) return i + 1;
  }
  return -1;
}

/** A post's own words, whole, where the page shows only a prefix of them.
 *
 *  Facebook truncates a long body in place: the words keep their `dir="auto"` run, are cut, and
 *  the page writes an ellipsis and its own expander INSIDE that run (see `bodyTruncated`). The
 *  prefix alone cannot be filed — it names nothing, so the post would be skipped entirely, and
 *  the words the classifier was shown would be words the reader cannot see.
 *
 *  The page's own payload states the story's whole message (`postIdMessages`), so the body is
 *  completed from it: the page's characters VERBATIM up to the cut, and the payload's remainder
 *  after it. Keeping the visible part byte-identical is the point — every claim the classifier
 *  places in the first part then has an offset that lands on the characters the page is
 *  painting. The remainder is joined the way the page joins it rather than as the payload spells
 *  it, because the words are not just a place to put offsets: they ARE the post's identity (see
 *  the join below).
 *
 *  Returns '' when there is nothing to file: the payload holds no text for this story, or holds
 *  a text this body does not begin — a stale entry, or a body showing a TRANSLATION of the post,
 *  whose visible words are not the payload's. Both are the refusal this used to be, kept for the
 *  cases the payload cannot answer rather than applied to every clipped post. */
function wholeBodyText(id: string, body: Element, shown: string): string {
  const text = sourceText(id, shown);
  // The expander is the ordinary evidence that these words are a prefix, but it is not the only
  // evidence and not always still in the document: a page that has answered a click removes its
  // control before the text it was holding lands. Words still stopping at the cut are a prefix
  // whatever the page has done with the control — filing them files a text that stops
  // mid-sentence, which is hashed, classified and billed as a post of its own and which no later
  // read of the same post agrees with (see `endsAtCut`, `post-id-names-one-text`). So the cut
  // standing in the words is asked as well, and such a body is completed from the payload exactly
  // as a body whose expander is still drawn. Returns '' when the payload cannot complete it,
  // which keeps the post out of the batch rather than filing its prefix.
  // The ellipsis read comes first for the same reason it does in `bodyClipped`: this runs on
  // every capture for every root, and a complete body is dismissed by one string read.
  const drawn = bodyTruncated(body);
  if (!drawn && (!(body.textContent ?? '').includes('…') || !endsAtCut(body))) return text;
  const full = postIdMessages.get(bareId(id));
  if (!full) return '';
  const visible = visiblePrefix(body);
  const end = endOfVisiblePrefix(full, visible);
  if (end < 0) return '';
  // The payload is not the render (see `endOfVisiblePrefix`): it separates the author's
  // paragraphs with a newline where the page runs them together with nothing between. Taken
  // verbatim, the completed text is a SECOND identity for a post that already has a row —
  // measured on a clipped search-feed story whose row is this same text with the paragraph break
  // removed (`facebook:1224195383044868`: the rendered reading was in the DB with 9 claims, the
  // completed one found nothing, and the post showed a Disinfact button over a preclassification
  // it already had). Whitespace is one thing to the reader and another to the hash, so the
  // remainder is joined the way the page joins it — the gap between blocks contributes nothing —
  // and only then is the text the post's own.
  return visible + full.slice(end).replace(/\s*\n\s*/g, '');
}

/** A comment's words as the page is showing them, with its own expander taken out.
 *
 *  The same join as `commentText` — a comment's text is its `dir="auto"` runs, each read with the
 *  page's own controls taken out (`bodyWords`) — but with the ellipsis at the cut dropped as
 *  well, which is what the truncated run is left holding (see `bodyTruncated`). That one
 *  character is the whole difference, and it is why this exists: the payload states no cut, so a
 *  prefix still carrying the page's ellipsis would not be found in it. */
function visibleCommentPrefix(root: Element): string {
  const parts: string[] = [];
  for (const el of Array.from(root.querySelectorAll(DIR_AUTO))) {
    const clone = el.cloneNode(true) as Element;
    for (const control of Array.from(clone.querySelectorAll(CONTROL))) control.remove();
    const text = (clone.textContent ?? '').trim().replace(/…\s*$/, '').trim();
    if (text.length > 0) parts.push(text);
  }
  return parts.join('\n');
}

/** A comment's own words, whole, where the page shows only a prefix of them.
 *
 *  The same treatment a truncated post gets (`wholeBodyText`) and for the same reason: the
 *  prefix alone names nothing, so the comment would be skipped entirely — and the words the
 *  classifier was shown would be words the reader cannot see. The payload states what the
 *  comment says (see `commentTexts`), under the id the markup already names it by, so the
 *  visible part is kept VERBATIM and the payload supplies the remainder.
 *
 *  Returns '' when there is nothing to file — the payload holds no text for this comment, or
 *  holds one this row does not begin, which is the refusal this used to be for every clipped
 *  comment. A row the payload cannot answer still stays out rather than being filed clipped.
 *
 *  The comparison is exact on purpose, and so it is worth knowing what makes it fail. Measured on
 *  one post's ten comments, 8 rows' rendered words are a payload text verbatim and 2 differ by 2-4
 *  characters in the MIDDLE — the renderer and the payload do not spell every character the same
 *  way, so a row is complete only where the page's cut falls before the first such character. A
 *  looser match here would move the seam between the page's characters and the payload's, and
 *  every claim the classifier placed after it would be painted over the wrong words; refusing is
 *  the failure that costs a button rather than a wrong highlight. */
function wholeCommentText(id: string, root: Element, shown: string): string {
  // Same rule as a story's body, and the same window: a comment whose expander has been clicked
  // away before its text landed still ends at the page's cut (see `wholeBodyText`).
  if (!bodyTruncated(root) && (!(root.textContent ?? '').includes('…') || !endsAtCut(root))) {
    return sourceText(id, shown);
  }
  const full = commentTexts.get(bareId(id));
  if (!full) return '';
  const visible = visibleCommentPrefix(root);
  const end = endOfVisiblePrefix(full, visible);
  return end < 0 ? '' : visible + full.slice(end);
}

/** How a comment's blocks are joined into the one text that gets classified.
 *
 *  The page renders a comment as sibling `dir="auto"` runs and the classifier is handed them
 *  as one string, so the separator is this extension's rather than the page's. It exists as a
 *  named constant because `commentParts` and `commentText` cut the classified text and the
 *  regions the highlight layer paints out of the SAME characters: a `textRegions` that walked
 *  a different separator would put every later block's offsets on the wrong words. */
const COMMENT_BLOCK_JOIN = '\n';

/** A comment's words, block by block, in document order, each with the text it holds.
 *
 *  One reading, three readers: `commentText` joins these into the classified string and
 *  `textRegions` measures the spans of that string each block shows, so the two cannot
 *  disagree about where one block ends. Empty runs are dropped and each run's text is trimmed,
 *  which is what makes the offsets into the join land on the page's own visible characters. */
function commentParts(root: Element): { el: Element; text: string }[] {
  const out: { el: Element; text: string }[] = [];
  for (const el of Array.from(root.querySelectorAll(DIR_AUTO))) {
    // The run's own words, not its `textContent`: the page writes its expander inside the run
    // it expands, and a comment's label would otherwise be filed as part of what the comment
    // says (see `bodyWords`). Read here rather than at each caller because `commentText` and
    // `textRegions` both come off this one reading, and they must not disagree.
    const text = bodyWords(el);
    if (text.length > 0) out.push({ el, text });
  }
  return out;
}

/** A comment's words: the join of its `dir="auto"` runs, which is where Facebook puts a
 *  comment's text at every nesting depth. Returns null when the comment has none — a
 *  sticker- or photo-only comment carries nothing to classify. */
function commentText(root: Element): string | null {
  const parts = commentParts(root);
  return parts.length ? parts.map((part) => part.text).join(COMMENT_BLOCK_JOIN) : null;
}

/** The element a comment's name is written on, or null when the row states no link for its
 *  author.
 *
 *  Reading "the first link" is wrong in two directions, both measured on one group photo opened
 *  in the viewer (`/photo/?fbid=1486698226840829&set=gm.3006634934732718`, its six comment rows):
 *
 *  - A row's links include the comment's own PERMALINK (its timestamp, `…?comment_id=<its own
 *    id>`) and, for some members, an avatar link — `aria-hidden` absent, its words an image, its
 *    label "Profile picture" — while the row's only other link is the name. On that page the
 *    comment by DynamicAvocado6035 put the avatar first, so "the first link" was wordless, its
 *    name read back empty, and the row was refused outright (`!username`): five of the six
 *    comments got buttons and the sixth got nothing, with no text, no clamp and no truncation
 *    to explain it.
 *  - A row can state NO link for its author at all: the anonymous participant's row has exactly
 *    one link, its timestamp, so "the first link" made the commenter's name "7h" — a wrong
 *    classification context, which is the one thing the name is read for.
 *
 *  So a candidate must carry words of its own and must not be the row's own timestamp link; the
 *  avatar and the timestamp are the two links that fail those tests. The test is against the
 *  TIMESTAMP rather than against the permalink SHAPE, because the name link is a permalink too on
 *  the surfaces that render a comment as one bubble — measured on a page post's comment: the
 *  bubble's header is `Name · 4h`, both links carrying `?comment_id=`, the name's with no
 *  `aria-label` and the timestamp's with the host's 36-character one — so a shape test skipped the
 *  name and left that row named by the first `dir="auto"` block, which on that surface is the
 *  comment's BODY: the comment was filed with its own words as its author's name. Bounded to the
 *  text ABOVE the body: a mention inside the words is a link to a profile too, and a row with no
 *  name link of its own would otherwise take the first person it mentions for its author. */
function commentAuthorEl(root: Element): Element | null {
  const body = root.querySelector(DIR_AUTO);
  const stamp = commentStampEl(root);
  for (const link of Array.from(root.querySelectorAll(COMMENT_AUTHOR))) {
    if (stamp && link.contains(stamp)) continue;
    if (body && !(link.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
    if (ownText(link)) return link;
  }
  return null;
}

/** A commenter's name: the words on their own link, with no badge text folded in.
 *
 *  A commenter with no profile to link to — Facebook's "Anonymous participant" — is named by
 *  the first run of the row instead: measured, a comment row's header states its name, its
 *  timestamp and then its body as separate `dir="auto"` runs, name first, on every one of those
 *  six rows. */
function commentAuthor(root: Element): string {
  const link = commentAuthorEl(root);
  if (link) return ownText(link);
  for (const run of Array.from(root.querySelectorAll(STORY_RUN))) {
    const text = textOf(run);
    if (text) return text;
  }
  return '';
}

/** The line a comment's header is written on — the one its buttons are placed at the end of.
 *
 *  A comment renders its header as two sibling blocks, the commenter's name and the time, and
 *  the buttons belong AFTER the time, as they do on every platform here. The name's own parent
 *  is a block that ends before the time — measured on a comment row: the line's children are one
 *  div holding the name and another holding `· 9w` — so appending there lands the buttons between
 *  the two.
 *
 *  Read from the TIMESTAMP outwards and bounded by the comment's BODY, which is the one border
 *  this line has on every surface: the header line is the highest ancestor of the time that still
 *  holds no part of the body. Read from the name instead, the line came out wrong wherever the
 *  name is not a link of its own — on a page post's comment the name link carries the row's own
 *  permalink, so a name-first walk found nothing, fell back to the row's first `dir="auto"` block
 *  (that surface's BODY), and resolved the line to the whole bubble: the buttons landed between
 *  the header and the body instead of after the time.
 *
 *  Falls back to the timestamp's own parent on a row whose header cannot be separated from the
 *  body, which is the tightest line such a row offers. */
/** The link carrying a comment's own TIMESTAMP — its permalink, `…?comment_id=<its own id>`.
 *  Null on a row that states none.
 *
 *  Not simply the first permalink link in the row. The avatar link carries one too, and so does
 *  the NAME link on the surfaces that render a comment as a bubble — measured on a page post's
 *  comment: the row's three permalinks are the avatar (`aria-hidden="true"`, no words), the name
 *  (8 characters, no `aria-label`) and the time (2 characters, the host's 36-character
 *  `aria-label`), in that order. Taking the first put the row's buttons inside the avatar/bubble
 *  gutter, 66px tall and a column away from the time they belong to.
 *
 *  So: never an `aria-hidden` link, never one BELOW the body, the host's own `aria-label` if the
 *  row states one (the timestamp is the link that does), and otherwise the last of them — the
 *  timestamp is written after the name. */
function commentStampEl(root: Element): Element | null {
  const body = root.querySelector(DIR_AUTO);
  let last: Element | null = null;
  for (const link of Array.from(root.querySelectorAll('a[href]'))) {
    if (link.getAttribute('aria-hidden') === 'true') continue;
    if (!COMMENT_PERMALINK.test(link.getAttribute('href') ?? '')) continue;
    if (body && !(link.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
    if (link.getAttribute('aria-label')) return link;
    last = link;
  }
  return last;
}

function commentHeaderLine(root: Element, stamp: Element): Element | null {
  const body = root.querySelector(DIR_AUTO);
  let line: Element = stamp;
  for (let el: Element | null = stamp.parentElement; el && el !== root; el = el.parentElement) {
    if (body && el.contains(body)) break;
    line = el;
  }
  return line === stamp ? stamp.parentElement ?? null : line;
}

function isVerified(el: Element | null): boolean {
  return !!el?.querySelector(VERIFIED_BADGE);
}

/** How many fetched translations to remember, and how short one may be before it is thrown away.
 *
 *  Bounded because a translation is a whole post's worth of text and a reader can flip a long
 *  way down a feed; 32 covers everything that can be on screen at once with room to spare. The
 *  floor exists because a few characters identify nothing — a short body could contain them by
 *  coincidence, and calling the wrong side a translation is what would make the background paint
 *  one side's ranges over the other side's words. */
const MAX_SHOWN_TRANSLATIONS = 32;
const MIN_TRANSLATION_LENGTH = 16;

/** How much of a translation is enough to recognise it on the page.
 *
 *  A prefix rather than the whole string: the fetched copy is the entire post with its newlines
 *  and hashtags, while the page renders it as separate blocks and may ellipsise a link inside
 *  it, so requiring all of it would miss posts that are plainly translated. */
const TRANSLATION_PROBE = 32;

/** Text with every whitespace run removed — the form two copies of one text are compared in.
 *
 *  Whitespace is what the two sides do NOT agree on: the payload separates paragraphs with a
 *  newline while the renderer puts each in its own block, so the page's `textContent` runs them
 *  together with nothing in between. Stripping it leaves the characters both sides share. */
function squeeze(text: string): string {
  return text.replace(/\s+/g, '');
}

/** The translations Facebook's own GraphQL has handed over, most recent last.
 *
 *  Facebook shows a post in one language at a time and the side not on screen is nowhere on the
 *  page, so the only way to know what is being shown is to have watched the app fetch it — which
 *  `facebook.capture.content.ts` does. Nothing else on the page says it: measured on a Spanish
 *  post, clicking `See translation` swapped the visible words for their English ones and changed
 *  nothing else but the link's own locale-dependent label. */
const shownTranslations: string[] = [];

/** Whether the post is on screen in a translation of it rather than in its own words.
 *
 *  `textContent` rather than the painted body because this is asked on every sweep for every post
 *  in reach and so has to be one property read. Its blind spot is text the painter would skip —
 *  a visually-hidden node's words — which cannot make a post look translated unless it already
 *  contains a fetched translation verbatim. */
function isTranslated(root: Element): boolean {
  if (shownTranslations.length === 0) return false;
  const shown = squeeze(root.textContent ?? '');
  if (!shown) return false;
  return shownTranslations.some((translation) => shown.includes(translation.slice(0, TRANSLATION_PROBE)));
}

/** The body the page is SHOWING, as one string — what a flip's ranges have to be measured
 *  against. Read through the same extractor `textElement` names, so the offsets the worker
 *  computes are into the characters the painter will use. */
function shownBody(root: Element): string {
  const el = root.matches(COMMENT) ? root.querySelector(DIR_AUTO) : storyMessage(root);
  return bodyWords(el);
}

/** Whether a piece of text IS one of the translations the app fetched.
 *
 *  The only way to recognise the translated side, because nothing structural marks it: the
 *  fetched copy is the whole body while the page renders it as separate blocks, so the test is
 *  a prefix of it appearing inside the candidate, whitespace squeezed. */
function looksTranslated(text: string): boolean {
  if (!text || shownTranslations.length === 0) return false;
  const candidate = squeeze(text);
  return shownTranslations.some((translation) => candidate.includes(translation.slice(0, TRANSLATION_PROBE)));
}

/** The translated side, when that is what the page is painting.
 *
 *  A flip does NOT take the post's own words away: measured on a flipped Spanish post, the
 *  single `story_message` still held the Spanish while the English ran as sibling `dir="auto"`
 *  blocks in the same root — both sides in the document at once. So the source is the element
 *  `textElement` names, and this is the other one, found by the only thing that distinguishes
 *  it: its text is the string the app's own response delivered. Returns null when no run in the
 *  root is a fetched translation. */
function translatedBody(root: Element): string | null {
  for (const el of Array.from(root.querySelectorAll(DIR_AUTO))) {
    const text = textOf(el);
    if (text && looksTranslated(text)) return text;
  }
  return null;
}

/** The post's own words, given the text the page is showing in the element `textElement` names.
 *
 *  The two are the same thing in the ordinary case, including a flipped post, because Facebook
 *  leaves the source where it was and paints the translation beside it. They differ only for a
 *  post first met already translated with the translation rendered into that same element: there
 *  the remembered copy is the source, and with no copy nothing is returned and the post goes
 *  unfiled rather than filed as its own translation. */
function sourceText(id: string, shown: string): string {
  if (looksTranslated(shown)) return rememberedSources.get(id) ?? '';
  rememberSource(id, shown);
  return shown;
}

/** The posts whose own words have been read off the page, keyed by post id.
 *
 *  A FALLBACK, not the ordinary path. Facebook keeps the source on the page across a flip (see
 *  `translatedBody`), so the element `textElement` names is the source and is read directly. This
 *  covers the one case where it is not: a post the reader meets ALREADY translated may render the
 *  translation into that same element, and then the source is only in the copy taken while the
 *  post still showed its own words.
 *
 *  A post is identified by the hash of its SOURCE text, so filing the translation instead would
 *  give one post a different hash in each of its languages — classified, and billed, once per
 *  language as if each were a new post. Bounded because each entry is a whole post's worth of
 *  text and a reader can translate a long way down a feed; oldest out first. */
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

/** The comment each comment answers, as the host's own thread payload stated it — the edge
 *  only the network can supply beyond one level (see `absorbThreadEdges`).
 *
 *  The markup names the edge for a reply to a comment and lies for a reply to a reply: a
 *  sub-reply's own link names the thread's ROOT. Measured on one 7.4K-comment post, whose
 *  expanded payload covered 152 comments, of which 32 were at depth 2: the DOM's link
 *  matched the payload's `comment_direct_parent` for 120 of 120 depth-1 comments and 0 of
 *  32 depth-2 ones — all 32 named the same top-level comment. So a sub-reply is the one
 *  case where this map is not an optimization but the only true answer, and a comment it
 *  covers is never given the markup's reading.
 *
 *  Keyed by the adapter's own id for the comment, because both sides are namespaced before
 *  they are stored: the payload states plain decimal, and everything downstream keys by
 *  `postIdOf`. Bounded because a thread can run to thousands and each entry is two ids;
 *  oldest out first. */
const MAX_REMEMBERED_PARENTS = 1024;
const commentParents = new Map<string, string>();

/** The story each of the payload's other names stands for, keyed by that other name — the
 *  join between a post's own id and the ids its markup carries (see `facebookPostIds.ts` and
 *  `absorbPostIds`).
 *
 *  Filled from two sources, because a feed page states its posts through both: the page's
 *  server-rendered `script[type="application/json"]` blobs, which this side can read itself
 *  and scans before it files anything (`scanEmbeddedPostIds`), and the app's own
 *  `/api/graphql/` responses, which only the MAIN world can see and which arrive through
 *  `absorbPostIds`. Bounded because a feed scroll runs to hundreds of posts and each one
 *  brings a handful of aliases; oldest out first. */
const MAX_REMEMBERED_ALIASES = 4096;
const postIdAliases = new Map<string, string>();

/** The story's own words, as the payload states them, keyed by the id the payload files it
 *  under — the other half of the join `postIdAliases` makes, for the surfaces where the markup
 *  names the story nowhere and offers no alias to resolve (see `NetPostId.message`).
 *
 *  The WHOLENESS of the stored string is what two places depend on: a panel is recognised by it
 *  (squeezed and cut to `MESSAGE_FINGERPRINT` at the comparison, never here), and a post the page
 *  shows only a prefix of takes the rest of its words from it (`wholeBodyText`). The payload
 *  states a story's message in full — measured, 4063 characters for a photo permalink whose
 *  markup names the story nowhere — so what is kept is the whole string rather than a prefix.
 *
 *  Bounded hard, and much lower than the alias map: one entry is a post's whole text rather
 *  than a handful of digits, and only the few stories that can be on screen at once can need
 *  matching. Oldest out first, like the alias map. */
const MAX_REMEMBERED_MESSAGES = 256;
const postIdMessages = new Map<string, string>();

/** What each comment says, as the payload states it, keyed by the comment's own id in the
 *  decimal space its permalink already uses (see `collectCommentTexts`).
 *
 *  Kept for one reason: a comment the page has truncated is completed from it, exactly as a
 *  truncated post is completed from `postIdMessages` (`wholeCommentText`). Its own words are
 *  stated at `body.text` rather than a story's `message.text`, which is why this is a second
 *  map rather than a second use of the first.
 *
 *  Bounded like the story map and for the same reason — an entry is a comment's whole text —
 *  but higher, because one expanded thread covers hundreds of comments where a screen holds a
 *  handful of stories. Oldest out first. */
const MAX_REMEMBERED_COMMENT_TEXTS = 512;
const commentTexts = new Map<string, string>();

/** How much of a story's text is enough to recognise it on the page, and how short a run may be
 *  before it is not evidence of anything. The floor is the same one translations use and for the
 *  same reason: a few characters appear in half the posts on a page, so matching one would bind
 *  a panel to an id on coincidence. */
const MESSAGE_FINGERPRINT = 200;
const MIN_MESSAGE_MATCH = 16;


/** The id each root was resolved to, so a root answers with one id for its whole life (see
 *  `postIdIn`). Keyed by element, never by id: a re-render builds new elements, and those are
 *  free to resolve against a fuller map. */
const resolvedRootIds = new WeakMap<Element, string>();

/** The prefix that marks a name built from a story's own words rather than stated by the host.
 *  Distinct from a decimal id and from a `pfbid…`, so nothing downstream can mistake one for the
 *  other — the two live in the same key space (`postIdOf`). */
const TEXT_ID_PREFIX = 'text:';

/** The digest of a story's words: its author and its text, the same two fields a classification's
 *  context is built from (`canonicalContext`).
 *
 *  Two accumulators rather than one because this is an IDENTITY — two stories sharing a name is
 *  the collision `post-id-names-one-text` refuses, and 64 bits over a page's worth of stories is
 *  not a risk worth taking for four lines. */
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

/** The digest of each root's words and the mark they are recognised by, read once per element.
 *
 *  Held per ELEMENT for the reason `resolvedRootIds` is: a name must not move under a capture
 *  that has already been paid for. A root first seen already translated is deliberately NOT
 *  remembered — the words on screen are not the post's, so a name built from them would name the
 *  translation rather than the post, which is the second identity `sourceText` refuses too. */
const rootWords = new WeakMap<Element, { key: string; mark: string }>();

/** The story each of the payload's texts was recognised by, keyed by the mark of its words and
 *  valued by the story's own id.
 *
 *  This is the join that upgrades a text-named root to the id the payload filed it under, for the
 *  surfaces whose markup names the story nowhere at all (see `postIdIn`) — the direction
 *  `postIdAliases` cannot cover, because it is keyed by names the markup actually states. Bounded
 *  like `postIdMessages`, which it shadows: one entry is a story's whole text. */
const MAX_REMEMBERED_MARKS = 512;
const postIdMarks = new Map<string, string>();

/** The story each digest was later found to be, keyed by the digest and valued by the real id —
 *  the other direction of the join above, for a root stating words no payload entry described but
 *  that another render of the same post names outright. Bounded like the rest; oldest out first. */
const MAX_REMEMBERED_TEXT_IDS = 1024;
const textIdNames = new Map<string, string>();

/** Blobs already read, so a page whose blobs never change costs one pass. */
const scannedBlobs = new WeakSet<Element>();
/** When the last pass over the page's blobs ran, kept because `postIdIn` is called for every
 *  root and every comment on every sweep and a page that keeps adding blobs must not turn that
 *  into a parse per call. A second is far below the rate at which Facebook adds a page's worth
 *  of posts, and the pass itself is a query over a few dozen script tags. */
const BLOB_SCAN_INTERVAL_MS = 1000;
let lastBlobScan = 0;

/** Read the story ids out of the page's own server-rendered payload.
 *
 *  Facebook renders a feed's first screen from JSON embedded in `<script
 *  type="application/json">` blobs rather than from a request the MAIN-world hook could see —
 *  measured on a feed load: 3 blobs, 160–250KB, carrying 7 stories between them, and no
 *  `/api/graphql/` response carrying a feed story at all. A soft navigation does the same. So
 *  the blobs are the network's other half here, and this side reads them directly, before the
 *  first root is filed, which is what keeps a post's id from arriving after it was captured. */
function scanEmbeddedPostIds(): void {
  const now = Date.now();
  if (now - lastBlobScan < BLOB_SCAN_INTERVAL_MS) return;
  lastBlobScan = now;
  for (const blob of Array.from(document.querySelectorAll('script[type="application/json"]'))) {
    if (scannedBlobs.has(blob)) continue;
    scannedBlobs.add(blob);
    const text = blob.textContent ?? '';
    // Both gates before the parse: a blob this large is only worth parsing when it states a
    // story or a comment, and most of the page's blobs are other things entirely. A post page
    // states both in one blob — measured, one 300KB blob carrying the story and ten comments
    // with their whole texts — so one parse serves both harvests.
    const hasStories = text.includes('"post_id"');
    const hasComments = text.includes('"legacy_fbid"');
    if (!hasStories && !hasComments) continue;
    try {
      const payload: unknown = JSON.parse(text);
      if (hasStories) rememberPostIds(collectPostIds(payload));
      if (hasComments) rememberCommentTexts(collectCommentTexts(payload));
    } catch {
      // Page-authored data: a blob this side cannot read is one it does not learn from.
    }
  }
}

/** Remember which story each name stands for, in the shape both sources of this arrive in —
 *  the page's own blobs and the MAIN world's forward of the app's responses.
 *
 *  Validated field by field: this is page-authored data reaching an adapter, so a record whose
 *  id is not a decimal number, or whose alias is neither a decimal number nor a `pfbid…`, is
 *  dropped rather than stored — an alias nothing queries would only take room from one that
 *  something does. An alias equal to the story's own id is dropped for the same reason. */
function rememberPostIds(records: unknown[]): void {
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const { postId, aliases, message } = record as { postId?: unknown; aliases?: unknown; message?: unknown };
    if (typeof postId !== 'string' || !/^\d+$/.test(postId)) continue;
    if (!Array.isArray(aliases)) continue;
    for (const alias of aliases) {
      if (typeof alias !== 'string' || alias === postId) continue;
      if (!/^(pfbid[0-9A-Za-z]+|\d+)$/.test(alias)) continue;
      postIdAliases.set(alias, postId);
    }
    if (typeof message !== 'string') continue;
    const mark = squeeze(message).slice(0, MESSAGE_FINGERPRINT);
    if (mark.length < MIN_MESSAGE_MATCH) continue;
    postIdMessages.set(postId, message);
    // The story's words as a name as well as as a completion of a clipped body: a surface whose
    // markup names the story nowhere states its words all the same, and this is what recognises
    // them as this story's (see `rootWordsOf`).
    postIdMarks.set(mark, postId);
  }
  while (postIdMarks.size > MAX_REMEMBERED_MARKS) {
    const oldest = postIdMarks.keys().next().value;
    if (oldest === undefined) break;
    postIdMarks.delete(oldest);
  }
  while (postIdAliases.size > MAX_REMEMBERED_ALIASES) {
    const oldest = postIdAliases.keys().next().value;
    if (oldest === undefined) break;
    postIdAliases.delete(oldest);
  }
  while (postIdMessages.size > MAX_REMEMBERED_MESSAGES) {
    const oldest = postIdMessages.keys().next().value;
    if (oldest === undefined) break;
    postIdMessages.delete(oldest);
  }
}

/** Remember what each comment says, validated the way the ids above are: this is page-authored
 *  data reaching an adapter, so a record whose id is not a decimal number, or whose text is too
 *  short to be evidence of anything, is dropped rather than stored. */
function rememberCommentTexts(records: unknown[]): void {
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const { commentId, text } = record as { commentId?: unknown; text?: unknown };
    if (typeof commentId !== 'string' || !/^\d+$/.test(commentId)) continue;
    if (typeof text !== 'string') continue;
    if (squeeze(text).length < MIN_MESSAGE_MATCH) continue;
    commentTexts.set(commentId, text);
  }
  while (commentTexts.size > MAX_REMEMBERED_COMMENT_TEXTS) {
    const oldest = commentTexts.keys().next().value;
    if (oldest === undefined) break;
    commentTexts.delete(oldest);
  }
}

/* ------------------------------------------------------------------------------------------------
 * The mobile app — the `weblite` m-site
 * ------------------------------------------------------------------------------------------------
 *
 * A phone user agent on a host this adapter already claims is served a SECOND application rather
 * than the desktop one: Facebook's server-driven mobile site. Measured on all three of
 * iPhone-on-`www.`, iPhone-on-`m.` and Android-on-`www.`: the same vocabulary, and not one anchor
 * shared with the desktop design (`data-ad-rendering-role` 0, `role="article"` 0, `profile_name`
 * 0, and no anchor at all inside a story). That is why a reader on a phone has been getting no
 * buttons on a platform whose every desktop surface has them.
 *
 * **The vocabulary, all of it measured.** A story is a child of the app's own scroller,
 * `MContainer[data-type="vscroller"]`. Its interaction chips are the DIRECT CHILDREN of a
 * container inside it: measured, three or more `[role="button"][data-action-id]` sit as siblings
 * in one row, which is also what tells a story's own row from a comment's (a comment's row is one
 * or two chips). The words are a `TextArea` in the feed and a `ServerTextArea` on a story page,
 * both `data-type="text"`. The host's own "See translation" affordance is a text component too,
 * and the one structural difference is that it carries a chip INSIDE it where a body carries
 * none — which is how the body is told apart from it without reading its translated label.
 *
 * **A clipped body can be completed, and the app does it whole.** A body the app is showing a
 * prefix of ends in a short, childless `<span>` holding the ellipsis and the app's expander —
 * measured `... See more`, written with three ASCII dots rather than `…`, which is why the
 * desktop reader's `…` test finds nothing here. Clicking that span re-renders the story: the
 * words come back WHOLE and the expander is gone entirely, not left behind as a "less" control.
 * So `bodyClipped`/`revealClipped` drive it exactly as Quora's does, and a mobile post is filed
 * with its whole text rather than a prefix (`truncated-means-excluded`).
 *
 * **There is no host id, and that is measured rather than assumed.** No `post_id`, no
 * `story_fbid`, no id attribute on a story root and none in the inline scripts; the app's data
 * does not arrive in anything the MAIN-world hook could read (147 binary WebSocket frames at
 * `kaios-d.facebook.com`, zero text frames, and no `/api/graphql/` on this surface at all). A
 * story PAGE's address states one (`?story_fbid=<digits>&id=<digits>`, the same decimal space
 * `STORY_FBID` already reads), but a feed story states none and the feed is where a reader
 * starts — so a mobile post is named by the digest of its own words and author, the machinery
 * `rootWordsOf` already carries for a desktop root that states no id (`TEXT_ID_PREFIX` +
 * `wordsDigest`). Both fields are read off the same two places on every surface a mobile post
 * renders on — the body's text component and the header row's first text component — so one post
 * seen in the feed and again on its own story page is named the same way twice.
 *
 * **A story's comments are integrated, and their ancestor is the story.** The app renders a
 * story's comments inside the same scroller as the story, and marks each comment's own container
 * with an attribute no story carries (`MOB_COMMENT` — measured, 27 of them under a live story
 * page against none on the story's own header above them, whose words-and-small-row shape is
 * otherwise a comment's). So this adapter refuses to read a comment as a story and reads a
 * comment's words off the one component the app labels without giving it an action
 * (`MOB_COMMENT_TEXT`), its author off the name line above it, and files it with the story on
 * screen as its parent — the shape the desktop surface states for a top-level comment, and the
 * chain the workers are handed. A comment still showing a prefix is refused exactly as a story
 * is, so nothing is filed short.
 *
 * **A comment that answers another comment is integrated too, off the screen the app opens for a
 * thread.** Replies are not shown in the story's own comment list at all: tapping a "View previous
 * N replies" chip opens a screen of its own, and that screen is where a comment's ancestor is
 * another comment. The app states that ancestor by the shape of the screen — the comment the screen
 * is about sits at the page's smallest left offset and every answer one step in (measured: 60
 * against 91, and 64 against 95 on another) — and its nesting is one level deep, which is the same
 * claim the desktop surface files for the same relation: measured there, a reply's permalink names
 * the comment answered when that comment is top-level and the thread's ROOT when the answer answers
 * another answer, right at depth one (120/120) and wrong beyond it (0/32). So every answer on that
 * screen is filed under the comment the screen is about, and the person an answer addresses stays
 * what the app writes beside it — a mention, never read as an ancestor, because a name is not an
 * identity and a guessed ancestor is the single outcome this adapter must never produce.
 * The story is not on that screen, so the thread's own comment is left uncaptured there rather
 * than filed with no ancestor — it is normally already filed off the story view, which is where a
 * reader reaches the thread from, and a reply is filed only when that comment is one this page has
 * already filed. A sponsor's paid placement is not filtered either — the desktop marker
 * (`data-ad-rendering-role^="cta"`) does not exist here and no replacement has been measured. Both
 * are gaps rather than silent misbehaviour, and both are listed where the rollout's open items are.
 *
 * **Nothing here can reach a desktop page.** Every mobile read is gated on the element itself
 * (`isMobileRoot`: a root is mobile iff it is a `MContainer`), and a desktop page carries zero
 * `data-mcomponent` nodes — measured on a live home feed, 0 against 5 `data-ad-rendering-role`.
 * So each hook below either extends a desktop answer or returns nothing where a desktop root is
 * concerned, and no desktop path changes. */

const MOB_COMPONENT = 'data-mcomponent';
const MOB_SCROLL = '[data-mcomponent="MContainer"][data-type="vscroller"]';
const MOB_TEXT = '[data-mcomponent="TextArea"], [data-mcomponent="ServerTextArea"]';
/** The app's own label on a sponsored story's card — the `sponsored-story-photo` test id, matched by
 *  its prefix so the app's other sponsored markers are caught with it (see `mobileSponsored`). */
const MOB_SPONSORED = '[data-testid^="sponsored-"]';
/** The component the app makes a comment's own words.
 *
 *  Four facts, every one of them measured over a live story page's whole comment list: the
 *  comment's text is a text component, the app labels it, the app makes it tappable, and — the
 *  fact that picks it out from everything else in the block — the app gives it no
 *  `data-action-id`. A comment's words are reached by a long gesture rather than by a tap, and
 *  the app says so in the markup as well as in the label it writes beside them.
 *
 *  That last fact is what tells it from the app's own reaction summary, which sits in the same
 *  block with the same label and the same tap target and DOES carry an action id (measured: an
 *  empty summary reading no words at all, and the labelled one that follows the words). The
 *  label itself is never read: it is a translated sentence in the reader's own language. */
const MOB_COMMENT_TEXT =
  '[data-mcomponent="TextArea"][role="button"][aria-label]:not([data-action-id]), ' +
  '[data-mcomponent="ServerTextArea"][role="button"][aria-label]:not([data-action-id])';
/** The attribute the app puts on a comment's own container, and on no story's.
 *
 *  Measured: 27 of them under a live story page, one per comment and a second on the wrapper
 *  around each; zero on the story's own header above them, which is the same words-and-small-row
 *  shape a comment is and would otherwise be read as one — and zero across a live search feed,
 *  whose story headers are that same shape again. */
const MOB_LONG_CLICK = 'data-long-click-action-id';
const MOB_COMMENT = `[data-mcomponent="MContainer"][${MOB_LONG_CLICK}]`;
const MOB_CHIP = '[role="button"][data-action-id]';
/** How many chips in a row make it a STORY's row rather than a comment's. Measured: a story's
 *  own row holds three or more (Like, Comment, Share), a comment's one or two. */
const MOB_CHIP_ROW = 3;
/** How long the app's own inline affordance may read before it is not that affordance. The
 *  measured one is 12 characters; the cap is what keeps a real sentence out. */
const MOB_LABEL_LIMIT = 40;
/** How far up a node is walked looking for the story container it belongs to. A selection inside
 *  a post resolves in a handful of levels; the cap is what stops a walk that never finds one. */
const MOB_MAX_WALK = 30;
/** Clearance between our pill and the app's own control at the end of the row it is seated beside,
 *  so that control stays tappable. */
const MOB_SEAT_GAP = 6;
/** The pill is laid over the app's layout rather than into it, so it has to outrank the components
 *  the app paints after the row it sits on. Measured: at this value the pill paints whole. */
const MOB_SEAT_Z = '2147483000';
/** The height the bar's own renderer gives a pill. Read here to centre the seat on the line the
 *  app left free, which is what keeps a 20px pill inside that line's band. */
const MOB_PILL_HEIGHT = 20;
/** Shortest component that can be a line of the header rather than a rule the app draws across
 *  it, and how far below a line's top another component still belongs to that line. */
const MOB_LINE_MIN_HEIGHT = 8;
const MOB_LINE_GAP = 8;
/** Room, in px, that makes a line of the header worth seating on at all rather than a line the
 *  search walks past on its way to one that can actually hold the pill. */
const MOB_PILL_MIN_WIDTH = 24;
/** How long an image's longer side must be to count as a picture rather than a glyph. Measured on
 *  the m-site: a story's own action row carries the three reaction icons as images, every one of
 *  them 16px square, where the poster's face is 48 and a photo fills the column. */
const MOB_PICTURE_MIN = 32;

/** Whether a root is one of the mobile app's own story containers.
 *
 *  The whole dispatch turns on this, and it is deliberately a fact about the ELEMENT rather than
 *  about the document: a desktop page holds no `data-mcomponent` node at all, so a desktop root
 *  can never be mistaken for a mobile one and no desktop path can be diverted by accident. */
function isMobileRoot(root: Element): boolean {
  return root.getAttribute(MOB_COMPONENT) === 'MContainer';
}

/** Whether a root is one of the app's comment containers rather than a story.
 *
 *  A fact about the ELEMENT, the same way `isMobileRoot` is, and about the same element: a
 *  comment's container is a `MContainer` too, so the two are told apart by the mark the app
 *  puts on the first and on no story (see `MOB_COMMENT`). A story is therefore never read as a
 *  comment, and this cannot change a desktop answer either. */
function isMobileComment(root: Element): boolean {
  return isMobileRoot(root) && root.hasAttribute(MOB_LONG_CLICK);
}

/** Whether the page on screen is the mobile app rather than the desktop one.
 *
 *  Read from the app's own scroller, the one anchor every mobile surface carries — a feed, a
 *  story page and a permalink alike. A desktop page holds none (measured), so nothing that
 *  answers this question can change a desktop answer. */
function isMobileDocument(): boolean {
  return document.querySelector(MOB_SCROLL) !== null;
}

/** The app's own scroller: the widest `vscroller` on the page. */
function mobileScroller(): Element | null {
  let best: Element | null = null;
  for (const el of Array.from(document.querySelectorAll(MOB_SCROLL))) {
    if (!best || el.children.length > best.children.length) best = el;
  }
  return best;
}

/** The row of interaction chips inside a scope: a container whose direct children are three or
 *  more chips. Found from the chips rather than by scanning every `div`, because this runs for
 *  every root on every sweep. */
function chipRowIn(scope: Element): Element | null {
  for (const chip of Array.from(scope.querySelectorAll(MOB_CHIP))) {
    const row = chip.parentElement;
    if (!row || row === scope) continue;
    let chips = 0;
    for (const child of Array.from(row.children)) {
      if (child.getAttribute('role') === 'button' && child.hasAttribute('data-action-id')) chips++;
    }
    if (chips >= MOB_CHIP_ROW) return row;
  }
  return null;
}

/** Whether a fragment carries a picture of its own — content imagery, or the poster's face.
 *
 *  An image is not the same thing as a picture: the app renders its reaction icons as images too,
 *  so a story's own action row answers an image test while holding nothing but three 16px glyphs
 *  and the counts beside them. That is what made the detail view name its own action row as the
 *  story (see `mobileRoots`), and with the row read as the story it had no header to take an author
 *  from, so nothing was captured and the surface got no button at all. */
function hasPicture(el: Element): boolean {
  for (const im of Array.from(el.querySelectorAll('img'))) {
    const r = im.getBoundingClientRect();
    if (Math.max(r.width, r.height) >= MOB_PICTURE_MIN) return true;
  }
  return false;
}

/** Every story the app has rendered: a child of the scroller holding words and a chip row.
 *
 *  With one exception, and it is the story's own detail view — the page a feeder's tap opens, on
 *  `/story.php` and on a group permalink alike. That page is not a story the scroller HOLDS but
 *  the scroller itself: the app renders it as several sibling fragments, a header, a body, its
 *  media and its own action row, so the fragment carrying the chip row is only the action row.
 *  Measured on a live group permalink: eleven children in the scroller, the image-bearing header
 *  three of them above the row, and the fragment holding the row carrying no image at all. Read
 *  the children's way, that page answered with the row — and a root with no header is a root with no
 *  author, so `mobileBareId` named no post, `captureMobile` refused it, and the whole surface got
 *  no button, while the same post had one on the feed it was opened from.
 *
 *  Told apart by three facts that hold together only here: the scroller carries exactly one chip
 *  row, that row's own fragment holds no picture, and a picture-bearing sibling sits above it. A
 *  feed trips the first — measured on a live home feed, six stories and six chip rows, one inside
 *  each story's own child — and the second independently, because every story's header carries the
 *  poster's picture inside the SAME child as its own row. So a feed answer is exactly what it was.
 *
 *  "No picture" has to mean no PICTURE and not no image: on a Page's `/story.php` the row's own
 *  fragment holds the three reaction icons as images, so an image test read the action row as a
 *  picture-holding story, the guard below refused it, and the page fell through to the row — which
 *  is the very answer this whole branch exists to prevent. Measured there: the row's images are
 *  16px square, and every sibling above it that is worth calling a picture is 48 or a full column
 *  (see `hasPicture`). The group permalink this was first measured on carried a row with no image
 *  at all, which is why the size never had to be said before.
 *
 *  The root is the scroller rather than the run of fragments because a root is held by the ELEMENT
 *  it is: a story spread over siblings has no one element of its own, and the scroller is the
 *  smallest that contains all of it. Every mobile reading then resolves off it the way it resolves
 *  off a feed story — header, body, author and seat alike — and so does a selection made anywhere
 *  in the story, which `mobileRootFor` walks up to that same element. */
function mobileRoots(): Element[] {
  const scroller = mobileScroller();
  if (!scroller) return [];
  const kids = Array.from(scroller.children);
  const rows = kids.filter((kid) => chipRowIn(kid));
  if (rows.length === 1) {
    const above = kids.slice(0, kids.indexOf(rows[0]));
    if (!hasPicture(rows[0]) && above.some((kid) => kid.querySelector('img'))) return [scroller];
  }
  return kids.filter((kid) => kid.querySelector(MOB_TEXT) && chipRowIn(kid));
}

/** The container a node belongs to, for a selection made inside one: the comment it is in when
 *  it is in a comment, the story otherwise.
 *
 *  Innermost first, which is the rule the desktop surface states for the same question — a
 *  selection in a comment belongs to the comment and not to the story around it, and a comment's
 *  own ancestry is what the story becomes. A comment is inside the story's scroller, so the walk
 *  has to answer with the comment before it reaches the scroller, or the selection made in a
 *  comment would be handed the whole story's words as its own. */
function mobileRootFor(node: Node): Element | null {
  if (!document.querySelector(MOB_SCROLL)) return null;
  const start = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  if (!start) return null;
  let cur: Element | null = start;
  for (let i = 0; cur && cur !== document.body && i < MOB_MAX_WALK; i++) {
    if (isMobileComment(cur)) return cur;
    if (isMobileRoot(cur) && chipRowIn(cur)) return cur;
    cur = cur.parentElement;
  }
  return null;
}

/** A story's header: the element holding the poster's picture that is not also the story's own
 *  action row's container.
 *
 *  A header band cannot hold the story's action row, and that one fact is this whole rule. On the
 *  feed the two are siblings, so the first image-holding child is the header and nothing here
 *  moves. Measured on the search results surface, a story's box wraps header, body and action row
 *  in ONE image-holding container: read as the header it swallowed the body with it, so `mobileBody`
 *  below found no text anywhere in the root, the post formed no name, and the whole surface stayed
 *  unannounced — five story-shaped rows, every one of them with the app's own expander still
 *  standing, and not a button on any of them. So a container that holds the row is descended
 *  through rather than answered with, and the first container inside it that does not hold the row
 *  is the header. Bounded by that same fact: each step enters a strictly smaller subtree that still
 *  holds the row.
 *
 *  A story's box can also open with the app's own social-context bar — "Ada follows MINI." — which
 *  stands ABOVE the header inside the same root and carries a picture too: the follower's face, not
 *  the poster's. Read by picture alone, that bar is the first thing the rule meets, so the pill was
 *  seated on it instead of on the post, and the poster's name was read off it — which is not the
 *  poster's name at all but the app's own sentence about a different person, differing from reader
 *  to reader, so the same post was named differently per viewer. What tells the two apart is what
 *  the app put there rather than whose words they are: the poster's fragment carries the story's
 *  own controls — the picture the reader taps through to the page, and the app's own `…` — and the
 *  context bar carries none (measured on a live feed ad: the follower's bar has no control at all,
 *  the header under it has two). So a child with a picture AND a control is the header, and one
 *  with a picture and no control is only remembered: a story whose header really does carry no
 *  control keeps the header it has today. */
function mobileHeader(root: Element, row: Element | null = chipRowIn(root)): Element | null {
  const own = isMobileComment(root);
  let fallback: Element | null = null;
  for (const kid of Array.from(root.children)) {
    if (!kid.querySelector('img')) continue;
    if (!own && inCommentBlock(kid)) continue;
    if (row && kid.contains(row)) {
      const inner = mobileHeader(kid, row);
      if (inner) return inner;
      continue;
    }
    if (own) return kid;
    if (kid.querySelector(CONTROL)) return kid;
    if (!fallback) fallback = kid;
  }
  return fallback;
}

/** The app's own social-context rows in a story's root: the fragments ABOVE the header that carry
 *  a picture but none of the story's controls — "Ada follows MINI.", and whatever else the app
 *  chooses to say there. Read as rows rather than by their words, which differ per reader and per
 *  language, and that is the whole reason they are named here: what the app says about who follows
 *  whom is not the post, so it may be neither the post's name nor the post's words. */
function mobileContextRows(root: Element, header: Element | null): Element[] {
  if (!header) return [];
  return Array.from(root.children).filter(
    (kid) =>
      kid !== header &&
      kid.querySelector('img') !== null &&
      kid.querySelector(CONTROL) === null &&
      (kid.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
  );
}

/** The child where a story stops speaking for itself: the first picture-bearing fragment after its
 *  header, with the story's own action row and the app's social-context rows left out.
 *
 *  A quoted post's words are not the quoter's words, and the app introduces them the way it
 *  introduces a post's own author. Measured on a live quote of another reader's post, the root held
 *  [the quoter's header; the quoted author's row; the quoted words], so the quoter's own text ran
 *  out at that second row. Read as a fragment, never by the words inside it, which belong to
 *  another reader and another language.
 *
 *  A story's own body is unaffected: the app writes a caption BEFORE the photo it belongs to, so
 *  the poster's words stay inside, or ahead of, this fragment — measured across the feed, where
 *  every story's own words sat in the fragment that carried its pictures. */
function mobileEmbeddedRow(root: Element, header: Element | null, row: Element | null): Element | null {
  if (!header) return null;
  for (const kid of Array.from(root.children)) {
    if (kid === header || inCommentBlock(kid)) continue;
    if (row && kid.contains(row)) continue;
    if (!kid.querySelector('img')) continue;
    if (header.compareDocumentPosition(kid) & Node.DOCUMENT_POSITION_FOLLOWING) return kid;
  }
  return null;
}

/** Whether a fragment is an author row rather than a post's own words.
 *
 *  The app annotates the name-and-date line of every author row it draws — its own header's, and the
 *  header of a post a story carries — with an `aria-label` the reader never sees, and a fragment
 *  holding one is that row. Measured live: every story header carried one ("Terry Toope, 1 day ago,
 *  Public group"), so did the author row of a shared marketplace post ("Robert Rentals, Sep 28,
 *  Public group"), and a post's own words carried none — the one other labeled fragment in a pass
 *  over the feed was a photo album's "+10 more". Read by the label's presence, never its words,
 *  which are written in the reader's language. */
function mobileAuthorRow(el: Element): boolean {
  for (const text of Array.from(el.querySelectorAll(MOB_TEXT))) {
    if (text.getAttribute('aria-label')) return true;
  }
  return false;
}

/** The colour the app is painting behind a story.
 *
 *  A pill laid over the app's own layout needs a ground of its own: measured on the m-site, the
 *  poster's name and its meta line run under the right-hand end of the header row, and the pill's
 *  translucent fill let those words read straight through its label. Read from the nearest opaque
 *  ancestor rather than named here, so the app's own light and dark surfaces are followed without
 *  this code knowing which is which. */
function mobileSurfaceColor(from: Element): string {
  let cur: Element | null = from;
  for (let i = 0; cur && i < MOB_MAX_WALK; i++) {
    const bg = getComputedStyle(cur).backgroundColor;
    if (bg && bg !== 'transparent' && !/,\s*0(?:\.0+)?\s*\)$/.test(bg)) return bg;
    cur = cur.parentElement;
  }
  return '#fff';
}

/** The room the app leaves at the end of a story's header row, in viewport coordinates.
 *
 *  This seat cannot be chosen, only measured. Measured over a live feed, the header's first line
 *  always ends with something of the app's — the poster's name, a personalized Join/Follow, often
 *  both — the app's own `…` closes the row, and the gap between the two came out 0..56px on every
 *  story sampled, against the 88px a labelled pill needs. The other two bands that looked
 *  promising are each blocked for a reason worth keeping: the action row is three full-width
 *  chips, and anything below the row is outside the story's fixed-height box, where the next story
 *  paints over it. The lower band — where the meta line runs, the same trap
 *  `host-name-element-carries-host-chrome` records for the desktop surface — is not blocked as a
 *  surface, only as a place to PUT something unmeasured, and its own words are read like every
 *  other line's.
 *
 *  So the answer is the room the app actually left: the free run that ends where the `…` begins,
 *  on whichever line of the header leaves the most of it, and `width` is that run. The bar's
 *  renderer is handed the width and answers for it — a row with no room for words gets the mark
 *  instead of a label crushed to nothing. */
function mobileWindow(root: Element, header: Element | null, end: Element | null): { right: number; top: number; width: number } {
  const rootRect = root.getBoundingClientRect();
  const headerRect = header?.getBoundingClientRect() ?? null;
  const anchor = (end ?? header)?.getBoundingClientRect() ?? null;
  const right = (anchor ? (end ? anchor.left : anchor.right) : rootRect.right) - MOB_SEAT_GAP;
  let top = anchor ? anchor.top : rootRect.top + MOB_SEAT_GAP;
  let width = Math.max(0, right - rootRect.left - MOB_SEAT_GAP);
  if (!header || !headerRect) return { right, top, width };

  // The lines of the header, top to bottom. Hairlines are skipped: the app draws a full-width
  // one-pixel component at the top of some stories, and read as a line of text it measures the
  // window across the whole screen and reports no room at all.
  const runs = Array.from(header.querySelectorAll(MOB_TEXT))
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height >= MOB_LINE_MIN_HEIGHT);
  const lines: Array<{ top: number; bottom: number }> = [];
  for (const run of runs) {
    const line = lines.find((l) => run.top < l.top + MOB_LINE_GAP);
    if (line) line.bottom = Math.max(line.bottom, run.bottom);
    else lines.push({ top: run.top, bottom: run.bottom });
  }
  // The band under the last line counts too: a header whose words are all on its first line
  // leaves that band free across the whole width, and the full label fits there.
  const last = lines[lines.length - 1];
  if (last && headerRect.bottom - last.bottom >= MOB_PILL_HEIGHT) {
    lines.push({ top: last.bottom, bottom: headerRect.bottom });
  }
  // Read across the whole STORY, not just the header: a story that shares a post carries a second
  // header inside the same band, and that one is not a descendant of the first — measured, a band
  // this helper reported as empty was covered by a name line and a control belonging to the shared
  // card, so the pill was seated straight over them. The band is still bounded by the header's own
  // lines, so the story's body — which lives below the header's box — never enters the count.
  const content = Array.from(root.querySelectorAll(`${MOB_TEXT}, [role="button"]`))
    .filter((el) => !el.closest('.mf-btn-container'))
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0 && r.right <= right + MOB_SEAT_GAP);
  // Lines top to bottom, so "the first line with room" is the topmost one.
  lines.sort((a, b) => a.top - b.top);
  // Every line gets a band at least as tall as the pill. A line thinner than the pill is not a
  // line without room: measured, a header whose name wraps to two lines ends in a 16px meta line
  // whose words stop 138px short of the row's end, and dropping it for its height is what left
  // those stories with a measured 0 and a pill drawn over the app's own Join control — the same
  // band, rediscovered as 112..132px once the band is only asked to be tall enough to hold the
  // pill. It grows DOWNWARD through the empty header beneath it; only when the header's own bottom
  // edge stops that does it grow upward instead, where the content read below holds it to whatever
  // the line above actually covers.
  const bands = lines
    .map((line, i) => {
      // The line's own index is carried, not the band's: the bands are filtered below, and what
      // the seat needs to know is which ROW of words it chose, so it can ask what the rows above
      // and below it leave free.
      if (line.bottom - line.top >= MOB_PILL_HEIGHT) return { ...line, i };
      const down = Math.min(headerRect.bottom, line.top + MOB_PILL_HEIGHT);
      if (down - line.top >= MOB_PILL_HEIGHT) return { top: line.top, bottom: down, i };
      return { top: Math.max(headerRect.top, line.bottom - MOB_PILL_HEIGHT), bottom: line.bottom, i };
    })
    .filter((band) => band.bottom - band.top >= MOB_PILL_HEIGHT)
    .map((band) => {
      const inBand = content.filter((r) => r.top < band.bottom && r.bottom > band.top);
      const contentRight = inBand.length ? Math.max(...inBand.map((r) => r.right)) : rootRect.left;
      return { ...band, w: Math.max(0, right - contentRight - MOB_SEAT_GAP) };
    });
  // The topmost line that can hold the pill, not the widest line: the app's `…` closes the
  // header's FIRST line, and a pill one line lower reads as a second row of the header rather
  // than as part of that end. Ties in room are common (a line with nothing after the name), so
  // the topmost is the one the eye is already on. A header whose first line carries no room at
  // all still gets its pill — on the widest line there is, which is the best that surface offers.
  const chosen = bands.find((b) => b.w >= MOB_PILL_MIN_WIDTH) ?? bands.reduce<typeof bands[number] | null>(
    (best, b) => (!best || b.w > best.w ? b : best), null);
  if (chosen) {
    width = chosen.w;
    const centre = chosen.top + (chosen.bottom - chosen.top - MOB_PILL_HEIGHT) / 2;
    // Level with the `…`: that control is what the eye reads the header's end as, so the pill is
    // centred on IT rather than on the line's own box.
    //
    // The two boxes are not the same box, and asking whether the chosen line CONTAINS the `…`'s
    // centre is what this replaces. Measured on a live feed story: the app gives that control a
    // 33px tap target against a 21px line, hung so its centre falls 12px above the line's own top
    // — so the containment test answered no while the control plainly ends that line, and the pill
    // was centred on the line instead: a line's depth below the dots beside it. What says the
    // control ends this line is the two boxes MEETING, which they do on every story measured.
    const anchorCentre = anchor ? anchor.top + anchor.height / 2 : null;
    const endsThisLine = anchor !== null && anchor.top < chosen.bottom && anchor.bottom > chosen.top;
    // The room the pill may take is bounded by the rows of WORDS above and below the chosen one,
    // never by the chosen row's own box: a control hung above its line is not a row of words, and
    // fencing the pill at the line is exactly what held it away from the dots. Nothing here can
    // straddle two rows — the first line's own top is the ceiling when it is the first row, the
    // header's top otherwise.
    const lo = chosen.i > 0 ? lines[chosen.i - 1].bottom : headerRect.top;
    const hi = chosen.i < lines.length - 1 ? lines[chosen.i + 1].top : headerRect.bottom;
    top = endsThisLine && anchorCentre !== null && hi - lo >= MOB_PILL_HEIGHT
      ? Math.min(Math.max(anchorCentre - MOB_PILL_HEIGHT / 2, lo), hi - MOB_PILL_HEIGHT)
      : centre;
  }
  return { right, top, width };
}

/** The control the app itself ends a row with: the one furthest right inside the scope.
 *
 *  By geometry rather than by position in the row, because a row can carry more than one control
 *  and DOM order is not what decides which one ends it — a page's localized Follow/Join sits in
 *  the name, and the desktop reading of the same surface was once fooled by exactly that control
 *  (see `host-name-element-carries-host-chrome`). Measured on the m-site's header row: the
 *  rightmost control is the app's own `…` menu, which our pill must clear.
 *
 *  Controls that span the row are skipped: a whole-row button is not the row's END, and taking
 *  one for it puts the window's right edge at the screen edge — measured, that reported no room
 *  at all on stories carrying one. */
function mobileEndControl(scope: Element): Element | null {
  const scopeRect = scope.getBoundingClientRect();
  let best: Element | null = null;
  let bestLeft = -Infinity;
  for (const el of Array.from(scope.querySelectorAll('[role="button"]'))) {
    const rect = el.getBoundingClientRect();
    if (rect.left < scopeRect.left + scopeRect.width * 0.5) continue;
    if (rect.left > bestLeft) {
      bestLeft = rect.left;
      best = el;
    }
  }
  return best;
}

/** The app's own expander inside a body it is showing a prefix of, or null.
 *
 *  Structural, never by label: the LAST child of a `dir="auto"` run, a short childless `<span>`
 *  that opens with the ellipsis the app writes at the cut. Measured `... See more` — three ASCII
 *  dots, so the `…` a desktop run is recognised by is not what this surface writes. */
function mobileExpanderIn(body: Element | null): Element | null {
  if (!body) return null;
  const runs = body.getAttribute('dir') === 'auto' ? [body] : Array.from(body.querySelectorAll('div[dir="auto"]'));
  for (const run of runs) {
    const kids = Array.from(run.children);
    const last = kids[kids.length - 1];
    if (!last || last.tagName !== 'SPAN' || last.children.length > 0) continue;
    const label = (last.textContent ?? '').trim();
    if (!label || label.length > MOB_LABEL_LIMIT) continue;
    if (!label.startsWith('...') && !label.startsWith('…')) continue;
    return last;
  }
  return null;
}

/** A story's own words: the app's text component for the body.
 *
 *  The longest candidate is the body, measured by its text with the app's own controls taken out
 *  (`bodyWords`) rather than by whether it holds one — which is what separates it from the "See
 *  translation" affordance beside it, whose whole content IS a control and so reads as no words at
 *  all, while a body that merely links somewhere still reads as its own sentence. Excluding a
 *  component for CONTAINING a control would drop a post with a link in it.
 *
 *  Read from the components BEFORE the story's chip row, so a story page's comments — which follow
 *  their post's row — can never be mistaken for the post, and with the header child left out so a
 *  post shorter than its own author's name is still read as the post. The app's social-context rows
 *  are left out with it (`mobileContextRows`), because they stand above the header and say nothing
 *  about the post: on a post whose own words are shorter than the app's sentence about a follower,
 *  the longest candidate would be that sentence. Words the story merely carries — a quoted post's,
 *  which follow the row that introduces their author — are left out too (`mobileEmbeddedRow`), the
 *  author row with them where the fragment is one (`mobileAuthorRow`), so a story that says nothing
 *  of its own is read as having no text rather than as saying the words, or the name, of the post it
 *  quotes: no text, no anchor, and the story is passed over rather than given a pill.
 *
 *  A story the app is showing a translation of carries BOTH renderings in this one container, its
 *  own words and the app's rendering of them as siblings (measured: 94 French words, the app's
 *  21-word English rendering, then its "Translated from French" line). The reading below picks the
 *  longest of them, which is the post's own words in every story measured so far — a translation
 *  arrives clamped to a few lines and so reads shorter than what it translated. Which of the two
 *  is which is a question this surface answers structurally, not by the words, and it is answered
 *  where the second rendering is painted rather than here. */
function mobileBody(root: Element): Element | null {
  // A comment is read as the component the app makes its words with, which is also the one
  // capture files its text from — NOT by the header-excluded search below.
  //
  // On a comment block the avatar, the name line and the words sit in ONE image-holding
  // container (measured: `MTransactional`, three children), so `mobileHeader` answers with that
  // container, every text component in the block is inside it, and the search below returned no
  // body at all. A comment with no body has no text anchor, and a missing anchor skips injection
  // WHOLE — no pill and no highlight — on comments the page had already captured and announced.
  // Measured on a live story view: 6 of 30 comments, and the same 6 every sweep.
  //
  // Reading the block's own text component fixes that and keeps the painted offsets on the very
  // element the classified text was read from, which is what the highlighter aligns against.
  if (isMobileComment(root)) return mobileCommentBody(root);
  const row = chipRowIn(root);
  const header = mobileHeader(root);
  const context = mobileContextRows(root, header);
  const embedded = mobileEmbeddedRow(root, header, row);
  // An author row is not the post's own content even where it stands: a story that carries a post
  // and says nothing itself has that other post's author row as its first picture-bearing fragment,
  // and its name line would otherwise be read as this story's words (measured live on a shared
  // marketplace post, whose reader had written nothing at all).
  const carried = embedded !== null && mobileAuthorRow(embedded);
  let best: Element | null = null;
  let bestLen = 0;
  for (const el of Array.from(root.querySelectorAll(MOB_TEXT))) {
    if (inCommentBlock(el)) continue;
    if (header && header.contains(el)) continue;
    if (context.some((ctx) => ctx.contains(el))) continue;
    // Words belonging to a post this one merely carries (see `mobileEmbeddedRow`). They are what a
    // story that says nothing of its own would otherwise be read as saying — measured on a live
    // quote, where the quoted words outran the quoter's own, of which there were none.
    if (
      embedded &&
      (carried || !embedded.contains(el)) &&
      embedded.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING
    )
      continue;
    if (row && (el.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_PRECEDING)) continue;
    const len = bodyWords(el).length;
    if (len > bestLen) {
      best = el;
      bestLen = len;
    }
  }
  return best;
}

/** A story's words as the classifier and the painter both read them.
 *
 *  Through `passageTextContent`, the highlighter's own extractor, so the classified string and
 *  the offsets into it are one string rather than two. A body still showing a prefix is read with
 *  the app's expander taken off the end of it — that reading is only ever used to name the root
 *  before the expander is driven, never to classify it (see `captureMobile`). */
function mobileWords(body: Element | null): string {
  if (!body) return '';
  const whole = passageTextContent(body as HTMLElement).trim();
  const expander = mobileExpanderIn(body);
  if (!expander) return whole;
  const label = passageTextContent(expander as HTMLElement).trim();
  return (label && whole.endsWith(label) ? whole.slice(0, whole.length - label.length) : whole).trim();
}

/** A story's author: the words of the first text component in its header row.
 *
 *  The header row of a mobile story holds several text components — measured on one story, five:
 *  the name, a separator, the host's own relationship control ("Join"), the page's own subtitle
 *  and its metadata — so the first one that says anything is taken rather than joining them all.
 *
 *  Read with the app's own controls taken out (`bodyWords`, not `ownText`), which is the lesson
 *  this platform already paid for once: Facebook's name element carries a localized Follow/Join
 *  control inside it, and those words reached the post's hash on the desktop design (see
 *  `host-name-element-carries-host-chrome`). The name is part of a mobile post's hash too, so a
 *  reader's own language reaching it would name the same post differently per reader — which is
 *  the one thing the hash must not do. A component that is nothing but such a control therefore
 *  reads as no words at all and is skipped, exactly as the "See translation" affordance is. */
function mobileAuthor(root: Element): string {
  const header = mobileHeader(root);
  if (!header) return '';
  for (const el of Array.from(header.querySelectorAll(MOB_TEXT))) {
    const words = bodyWords(el);
    if (words) return words;
  }
  return '';
}

/** Whether this story is a paid placement, read from the story itself.
 *
 *  The mobile app labels a sponsored story's own card the way it labels nothing else: measured on
 *  live feed ads, the ad's card carried a `data-testid` opening `sponsored-`
 *  (`sponsored-story-photo`), while every organic card measured beside it carried
 *  `post-profile-image-N` / `story-photo-N` and no `sponsored-` value at all — 90-odd cards over
 *  several feed loads. Scoped to the story root, never to the document, so an ad elsewhere in the
 *  feed cannot condemn the story beside it.
 *
 *  Refused the way a desktop paid placement is (see `sponsored`): not integrated at all — no
 *  buttons, no classification, and no id, which is also what keeps an ad's own comments out, since
 *  a comment's ancestor here is the story's name and an unnamed story names no parent. */
function mobileSponsored(root: Element): boolean {
  return !!root.querySelector(MOB_SPONSORED);
}

/** The name a mobile root is filed under: a digest of its author and its words.
 *
 *  Not frozen per element the way a desktop root's name is, and deliberately: the words of a
 *  clipped body are a prefix until the expander is driven, and a name frozen at that moment would
 *  file the post under a name built from a prefix it does not have. Re-read, the name is the same
 *  on every pass once the body is whole, which is all the freezing was for. */
function mobileBareId(root: Element): string | null {
  if (mobileSponsored(root)) return null;
  const body = mobileBody(root);
  const words = squeeze(mobileWords(body));
  const username = mobileAuthor(root);
  if (!words || !username) return null;
  return TEXT_ID_PREFIX + wordsDigest(username, words);
}

/** A comment's own words component inside its block, or null.
 *
 *  The app's own reaction summary can wear the same label and the same tap target, and the one
 *  thing it never carries is the absence of an action id — which is what `MOB_COMMENT_TEXT`
 *  asks for, so the summary is never read as the comment however much of it the app is
 *  showing. What is left is asked to say something, because a comment the reader has left empty
 *  is a comment with nothing to classify. */
function mobileCommentBody(root: Element): Element | null {
  for (const el of Array.from(root.querySelectorAll(MOB_COMMENT_TEXT))) {
    if (bodyWords(el)) return el;
  }
  return null;
}

/** Whether an element is one of the app's comment blocks, or sits inside one.
 *
 *  The story on the app's own story view is read off the SCROLLER, whose subtree also holds every
 *  comment the page has rendered — so a story's words and its name have to be read with the
 *  comments taken out of scope, or the longest comment becomes the story's body and a comment's
 *  own name becomes its author. Measured on a story view: the story was named off the top
 *  comment's author and words, so that comment's id and the story's id were one and the same
 *  string — the comment then lost its own pill to the story's (the injector seats a bar on every
 *  root a name resolves to), and its parent edge named the comment itself. */
function inCommentBlock(el: Element): boolean {
  return el.closest(MOB_COMMENT) !== null;
}

/** The component holding a comment's author, and its words.
 *
 *  Read as the element rather than only as its words, because the badge's own anchor is the name
 *  (the desktop comment branch reads the same way). The app marks the name line the way it marks
 *  nothing else in the block: a tap action of its own AND hidden from the reading order — the
 *  poster's name is the line a screen reader is not asked to announce twice. Everything else in
 *  a comment that carries an action is either below the words (the reply control, the reaction
 *  summary) or carries no action at all, so the search runs BACKWARD from the words and stops at
 *  the first such line above them.
 *
 *  Taken as one component, never joined with its neighbours, which is what keeps the app's own
 *  localized chrome out of the name: measured, a page's relationship control ("Join") is a
 *  component of its own beside the name rather than inside it, the trap the desktop surface paid
 *  for once (see `host-name-element-carries-host-chrome`). */
function mobileCommentAuthorEl(root: Element): Element | null {
  const body = mobileCommentBody(root);
  if (!body) return null;
  const parts = Array.from(root.querySelectorAll(MOB_TEXT));
  const at = parts.indexOf(body);
  for (let i = at - 1; i >= 0; i--) {
    const el = parts[i];
    if (!el.hasAttribute('data-action-id') || !el.hasAttribute('aria-hidden')) continue;
    if (bodyWords(el)) return el;
  }
  return null;
}

function mobileCommentAuthor(root: Element): string {
  return bodyWords(mobileCommentAuthorEl(root));
}

/** The name a mobile comment is filed under: a digest of its author and its words.
 *
 *  The same machinery a mobile story is named by, and for the same measured reason — the app
 *  states no comment id anywhere on this surface: no `a[href*="comment_id="]`, no
 *  `a[href*="reply_comment_id="]`, no `[data-commentid]`, and no id in anything the page ships.
 *  Re-read rather than frozen, so a comment whose words are completed is named the same way on
 *  every pass once they are whole. */
function mobileCommentId(root: Element): string | null {
  const body = mobileCommentBody(root);
  if (!body) return null;
  const words = squeeze(mobileWords(body));
  const username = mobileCommentAuthor(root);
  if (!words || !username) return null;
  return TEXT_ID_PREFIX + wordsDigest(username, words);
}

/** Every comment block the app has rendered inside a scope, in the order it laid them out.
 *
 *  Innermost wins. The app wraps a comment's container in a second one carrying the same mark
 *  (measured, two levels), and a root is held by the element it is — the inner one, which is the
 *  comment itself; the wrapper is the list's own row and holds the padding around it.
 *
 *  A block is a block only when its own words can be read, which is what keeps a container the
 *  app marks for a long-press menu without ever filling it with a comment out of the listings
 *  below — measured, five such containers on a live search feed, a story card and a result row
 *  among them. */
function mobileCommentBlocks(scope: Element): Element[] {
  const found: Element[] = [];
  for (const el of Array.from(scope.querySelectorAll(MOB_COMMENT))) {
    if (mobileCommentBody(el)) found.push(el);
  }
  return found.filter((el) => !found.some((other) => other !== el && el.contains(other)));
}

/** The ids this adapter has filed off the mobile surface in this page's life.
 *
 *  A reply's ancestor is not always on the surface the reply is: the comment a thread screen's
 *  answers hang under is filed off the STORY view, and that screen holds the same comment with
 *  nothing to say whether the reader ever saw the story. An answer filed under an id nobody filed
 *  would be announced with no chain at all, and an announce is permanent — a later pass does not
 *  come back for an edge the comment's own words have not grown past. So a thread screen files
 *  nothing until the comment it is about is one this page has filed, which is exactly what this is
 *  for, and it is populated where every mobile filing passes (`capture`). */
const filedMobileIds = new Set<string>();

/** The comment each answer on a thread screen answers, for the answers that can be filed.
 *
 *  A thread screen is the surface the app opens from a story's "View previous N replies" chip. The
 *  story is not on it, and neither is any comment's id — measured, no comment href and no id in
 *  anything the page ships. What the app does state is the shape of the thread: the comment the
 *  screen is about sits at the page's smallest left offset and its answers one step in (measured:
 *  60 against 91, and 64 against 95 on another).
 *
 *  Every answer on that screen hangs under that comment, and that is the host's own structure
 *  rather than a reading of the layout. A comment on this surface nests ONE level: an answer to
 *  another answer is still a child of the thread's own comment, and the person it addresses is
 *  recorded beside it as a mention instead of as an ancestor — which is also what the screen's own
 *  rendering says, every answer at one indent under the comment and none inside another. The
 *  desktop surface states the same relationship outright in its permalink, where the parameter
 *  names the comment answered when that comment is top-level and the THREAD'S ROOT when the answer
 *  answers another answer: measured 120/120 right at depth one and 0/32 at depth two. So the
 *  thread's own comment is what every answer here is filed under, the same one-level claim the
 *  desktop surface files, and the mention at the head of an answer is deliberately NOT read: a name
 *  is not an identity, and a name states who an answer addresses rather than what it hangs under.
 *
 *  The comment the screen is about is left unfiled here — its own ancestor is the story, which is
 *  not on this surface — and it is usable as an ancestor only when this page has already filed it,
 *  which reaching the screen by tapping through the story view normally means. Until then nothing
 *  here is filed at all. */
function mobileThreadEdges(scroller: Element): Map<Element, Element> {
  const edges = new Map<Element, Element>();
  // A block the app is not laying out has no indent to read and no place in the listing: its box
  // is empty, and a thread's own comment scrolled out of the app's window would otherwise be read
  // from a zero offset as though it sat at the base of a thread it is not in.
  const blocks = mobileCommentBlocks(scroller).filter((block) => {
    const rect = block.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  if (blocks.length < 2) return edges;
  const lefts = blocks.map((block) => Math.round(block.getBoundingClientRect().left));
  const least = Math.min(...lefts);
  const own = blocks.filter((_, at) => lefts[at] === least);
  // Nothing is indented under anything, so this is a listing whose rows happen to carry a
  // comment's mark rather than a thread — a feed, a search result, a story card. The depth of the
  // wrapper cannot stand in for this reading: measured, one thread held its comment three levels
  // deep and its answers four, and another held every block at three.
  if (own.length === blocks.length) return edges;
  // Two comments at the base indent are two threads' own comments, and which one this screen is
  // about is no longer on the page.
  if (own.length !== 1) return edges;
  const focus = own[0];
  const focusId = mobileCommentId(focus);
  if (!focusId || !filedMobileIds.has(namespaced(focusId))) return edges;
  for (const block of blocks) {
    if (block !== focus) edges.set(block, focus);
  }
  return edges;
}

/** The id of the post a mobile comment hangs under, or null when this page cannot state one.
 *
 *  Two surfaces state it and no others. On the story's own view it is the story, named by the same
 *  digest the story's own root resolves to. On a thread screen it is the comment the screen is
 *  about, which every answer on that screen hangs under (see `mobileThreadEdges`). Everywhere else —
 *  a feed, a listing — a comment is left alone, and the story it would otherwise be filed under is
 *  the scroller's own first story, which is nobody's ancestor. */
function mobileCommentParentId(root: Element): string | null {
  const scroller = mobileScroller();
  if (!scroller) return null;
  const stories = mobileRoots();
  if (stories.length === 1 && stories[0] === scroller) {
    const story = mobileBareId(scroller);
    return story ? namespaced(story) : null;
  }
  if (stories.length > 0) return null;
  const parent = mobileThreadEdges(scroller).get(root);
  if (!parent) return null;
  const id = mobileCommentId(parent);
  return id ? namespaced(id) : null;
}

/** Every comment on this page whose ancestor can be named: the ones under the story on screen, and
 *  the answers on a thread screen whose ancestor this page has filed.
 *
 *  Empty unless the page is one of those two surfaces — `mobileRoots` answering with the scroller
 *  itself, which is the story's own view and nothing else, or answering with nothing at all while
 *  the scroller holds an indented thread of comments. That is what makes a comment's ancestor
 *  NAMEABLE: the story is on screen, so the digest the story is filed under is the parent, and it
 *  is the same element the story's own root resolves to, so a story and its comments are one
 *  thread rather than one thread and a stranger. The thread screen states the other ancestor, the
 *  comment the screen exists for, and it is the one comment on that screen that is NOT returned
 *  here: the story is not on it, so filing it there would file it with no ancestor, and a capture
 *  is kept — the comment would then be read as a root on every surface for the rest of the page's
 *  life. It is normally already filed off the story view, which is where a reader reaches the
 *  thread from. */
function mobileCommentRoots(): Element[] {
  const scroller = mobileScroller();
  if (!scroller) return [];
  const stories = mobileRoots();
  if (stories.length === 1 && stories[0] === scroller) return mobileCommentBlocks(scroller);
  if (stories.length > 0) return [];
  return Array.from(mobileThreadEdges(scroller).keys());
}

/** Where a mobile comment's pill goes: just after the name, on the comment's own first line.
 *
 *  The name line is the one line of a comment the app leaves free. Below the name the block is
 *  furniture — the words themselves, then the meta row holding the time, the reaction and reply
 *  controls and their counts — and a pill laid over the words would obscure the very text it is
 *  there to act on. So the pill sits at the start of the room that line has left, which is the end
 *  of the name wherever nothing follows it, and it is placed by that LEFT edge so it reads as part
 *  of the line the name is on rather than as something hanging off the comment's far end.
 *
 *  The room is measured from the content rather than from the comment's box: the app's name
 *  component fills its line, so its own right edge says where the LINE ends and not where the
 *  words on it do (see `mobileWindow`, which measures the same way for the same reason). What
 *  bounds the pill on the left is therefore the rightmost thing the app itself drew on that line —
 *  name, badge, or a control beside them — and never our own container. */
function mobileCommentWindow(root: Element): { left: number; top: number; width: number } {
  const rect = root.getBoundingClientRect();
  const line = mobileCommentAuthorEl(root)?.getBoundingClientRect() ?? rect;
  const right = rect.right - MOB_SEAT_GAP;
  const content = Array.from(root.querySelectorAll(`${MOB_TEXT}, [role="button"]`))
    .filter((el) => !el.closest('.mf-btn-container'))
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0 && r.top < line.bottom && r.bottom > line.top && r.right <= right);
  const contentRight = content.length ? Math.max(...content.map((r) => r.right)) : rect.left;
  const left = contentRight + MOB_SEAT_GAP;
  return { left, top: line.top, width: Math.max(0, right - left) };
}

/** Drive the app's own expander on a body it is showing a prefix of.
 *
 *  Serialized through the same queue `revealClipped` uses, and bounded the same way: two clicks
 *  racing would interleave two of the app's re-renders under each other's polls, and a control
 *  that refuses to open must not be clicked on every sweep. The signal watched for is the
 *  expander going away, with the body growing as the fallback for the day the app leaves it
 *  behind — and the body is looked up again on every poll, because the app answers by re-rendering
 *  the story: the element that was clicked is detached by the time the answer arrives (measured),
 *  so a poll holding the old node reads a body that is no longer on the page. */
const mobileExpandAttempts = new WeakMap<Element, number>();

/** Press a control the way a tap does.
 *
 *  The mobile app is a tap-driven document: a bare `click()` is only the last of the events a
 *  finger produces, and the app's own handler is bound to the pointer pair on this surface. Both
 *  are dispatched, in the order a real tap produces them, so the app answers whichever one it
 *  listens for. */
function tapHost(el: Element): void {
  const target = el as HTMLElement;
  const rect = target.getBoundingClientRect();
  const init = {
    bubbles: true,
    cancelable: true,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  };
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    const event = type.startsWith('pointer')
      ? new PointerEvent(type, init)
      : new MouseEvent(type, init);
    target.dispatchEvent(event);
  }
}

async function revealMobileClipped(root: Element, opts?: { onDemand?: boolean }): Promise<void> {
  if (!mobileExpanderIn(mobileBody(root))) return;
  if (!opts?.onDemand) {
    const attempts = (mobileExpandAttempts.get(root) ?? 0) + 1;
    mobileExpandAttempts.set(root, attempts);
    if (attempts > MAX_EXPAND_ATTEMPTS) return;
  }
  expanding = expanding
    .then(async () => {
      if (!root.isConnected) return;
      const control = mobileExpanderIn(mobileBody(root));
      if (!control) return;
      const before = mobileWords(mobileBody(root)).length;
      tapHost(control);
      for (let i = 0; i < EXPAND_POLLS; i++) {
        await new Promise((resolve) => setTimeout(resolve, EXPAND_POLL_MS));
        if (!root.isConnected) return;
        if (!mobileExpanderIn(mobileBody(root))) return;
        if (mobileWords(mobileBody(root)).length > before) return;
      }
      console.warn('[misinfo] facebook: a clipped mobile post would not expand; it stays out of this batch');
    })
    .catch((e) => {
      console.error('[misinfo] facebook: expanding a clipped mobile post failed', e);
    });
  return expanding;
}

/** Compose a mobile post for classification, or refuse it.
 *
 *  Refused while the app is still holding text back, for the reason every adapter here refuses
 *  one: a prefix names no post, and this surface has no payload that could complete it — the
 *  expander is the only road to the rest of the text, so a body that would not open is left
 *  uncaptured rather than filed short (mastodon.ts refuses a clipped root the same way). A later
 *  sweep tries again, up to `MAX_EXPAND_ATTEMPTS`. */
function captureMobile(root: Element): CapturedPost | null {
  // A comment is composed by its own reader. Both are `MContainer`s and the dispatch above
  // cannot tell them apart, so the mark the app puts on a comment's container is what decides
  // here (see `isMobileComment`).
  if (isMobileComment(root)) return captureMobileComment(root);
  const id = mobileBareId(root);
  if (!id) return null;
  const body = mobileBody(root);
  if (!body) return null;
  if (mobileExpanderIn(body)) return null;
  const text = mobileWords(body);
  const username = mobileAuthor(root);
  if (!text || !username) return null;
  return {
    post: {
      id: namespaced(id),
      text,
      fullText: text,
      username,
      // The badge is looked for with the same anchor the desktop design uses, inside the story's
      // own header. Unmeasured on this surface: if the mobile app draws its badge another way, a
      // verified poster reads as Regular — context only, never identity, since the name is read
      // off the page either way.
      usertype: isVerified(mobileHeader(root)) ? VERIFIED : REGULAR,
      conversationId: namespaced(id),
      quoting: null,
      replyingTo: null,
    } as MainTweet,
    replyParentId: null,
  };
}

/** Compose a mobile comment for classification, or refuse it.
 *
 *  Refused while the app is still holding text back, exactly as a mobile post is and for the
 *  reason every adapter here refuses one: a prefix names no comment, and this surface has no
 *  payload that could complete it — the expander is the only road to the rest of the words.
 *
 *  Its ancestor is read off the surface it is on: the story it hangs under, on the story's own
 *  view — named by the same digest the story itself is filed under, so a story and its comments
 *  are one thread rather than two unrelated posts, which is the shape
 *  `buttonless-surfaces-stay-in-the-chain` records for a story that gets no buttons of its own and
 *  the shape the desktop surface states for a top-level comment (post ← comment) — and the comment
 *  the thread screen is about, on that screen, which every answer there hangs under because that
 *  surface nests one level deep (see `mobileCommentParentId`, `mobileThreadEdges`).
 *
 *  Which of those it is has already been settled by the listing that put this comment in the batch
 *  at all: the story's own view files every comment it holds, and a thread screen files only the
 *  answers whose ancestor resolved (see `mobileCommentRoots`). So an ancestor that cannot be read
 *  here is one the app has not finished rendering, never one that is absent — and the comment is
 *  refused rather than filed as a root, because a capture is kept: the comment's own words are
 *  what a later sweep compares, so a root filed now would never be given its edge. */
function captureMobileComment(root: Element): CapturedPost | null {
  const body = mobileCommentBody(root);
  if (!body || mobileExpanderIn(body)) return null;
  const text = mobileWords(body);
  const author = mobileCommentAuthorEl(root);
  const username = bodyWords(author);
  if (!text || !username) return null;
  const id = mobileCommentId(root);
  if (!id) return null;
  const parentId = mobileCommentParentId(root);
  if (!parentId) return null;
  // Refused rather than filed onto itself: an ancestor's name is read off the page the same way
  // this comment's is, and a comment that resolved to its own name would be its own ancestor.
  if (parentId === namespaced(id)) return null;
  return {
    post: {
      id: namespaced(id),
      text,
      fullText: text,
      username,
      // The badge is looked for with the anchor the desktop comment branch uses — the commenter's
      // own name line, widened to the line it sits on. Unmeasured on this surface: if the mobile
      // app draws its badge another way, a verified commenter reads as Regular — context only,
      // never identity, since the name is read off the page either way.
      usertype: isVerified(author?.parentElement ?? null) ? VERIFIED : REGULAR,
      // A comment belongs to the thread it hangs under. On the story's own view that thread is the
      // story, which is what the ancestor above names; on a thread screen the story is not on the
      // page, and the nearest thread this page can name is the comment being answered. Nothing
      // reads this field — it is carried for the shape of the payload, not for a reader.
      conversationId: parentId,
      quoting: null,
      replyingTo: null,
    } as MainTweet,
    replyParentId: parentId,
  };
}

export const facebookAdapter: PlatformAdapter = {
  id: 'facebook',
  hosts: PLATFORM_HOSTS.facebook ?? [],

  postIdFromUrl(url) {
    // A permalink page names its post in the path; a feed page names none, which is why
    // the feed's posts are identified from their own markup instead (see `postIdIn`).
    //
    // The mobile app's own story pages are the exception: their address DOES state a
    // `story_fbid`, and it is deliberately not used, because a mobile post is named on the feed
    // by a digest of its words and the feed is where a reader meets it. Answering with the
    // payload's id here would give one post two identities — filed twice, classified twice, billed
    // twice — which is the rule `post-id-names-one-text` forbids. The digest is reachable from the
    // story page too, off the same two places (see `mobileBareId`), so the post is named the same
    // way on both and the address is left alone.
    if (isMobileDocument()) return null;
    const id = permalinkId(url.pathname + url.search);
    return id ? namespaced(id) : null;
  },

  postRoots(id) {
    return [...postRootsFromDom(), ...commentRoots(), ...mobileRoots(), ...mobileCommentRoots()].filter(
      (root) => postIdOf(root) === id,
    );
  },

  postIdOf,

  /** A story or a comment, judged for length — see LONG_FORM_CHARS.
   *
   *  Comments are never long-form: they are the shape this integration is for, and a comment
   *  the page truncates is completed from the page's own payload rather than dropped, so it
   *  carries its whole text and its buttons either way. That is also why the measurement is
   *  scoped to the root's OWN message: a story's markup holds its comments, and a truncated
   *  comment inside a short story would otherwise condemn the story. */
  /** Whether this root's own words are both held back by the page AND unanswerable from the
   *  page's own payload.
   *
   *  Two conditions rather than the one Quora asks, because this clip is not that clip. Quora's
   *  "(more)" holds text that is in NO response the page makes — measured, clicking it grew an
   *  answer from 308 to 545 characters and from 424 to 1667 — so there a clipped answer is a
   *  post nothing can be said about until it is opened. Facebook STATES the text it is holding
   *  back: a story's whole message is in its own payload (`postIdMessages`) and a comment's on
   *  its row entry (`commentTexts`), so an ordinary feed post is completed without touching the
   *  page at all — that is what `wholeBodyText` and `wholeCommentText` are for, and clicking
   *  there would expand a post on the reader's screen for no gain.
   *
   *  What is left is the body the payload cannot answer: the SEARCH feed, whose results arrive as
   *  a different response shape (`SearchResultsFeed`) carrying no `message` field. Measured
   *  2026-10-03 at 1400px on `/search/top?q=trump`: three story bodies, each 169 characters ending
   *  in the page's own expander, no payload entry for any of them, `announcing 0 post(s)` on every
   *  sweep, and buttons on none of them until the reader clicked "See more" themselves — and the
   *  buttons then stayed after "See less", because by then the text had been read once and filed.
   *
   *  So the question is not whether the payload has HEARD of this id but whether it can COMPLETE
   *  this body, and the two are not the same question. Measured 2026-10-04 on the same feed: a
   *  card whose payload held an entry for its id — `postIdMessages.has(id)` true, so this hook
   *  said "the payload answers, leave it to the reader" — where that entry's text shared its first
   *  character with the words on screen in one case and its first two in another, and nothing
   *  beyond. `wholeBodyText` refuses on exactly that (`endOfVisiblePrefix` < 0), so `capture`
   *  dropped the post on every one of 217 sweeps while nothing ever opened it: no buttons at all
   *  until the reader expanded the card by hand, after which it was filed and kept its buttons
   *  through "See less". So the id and the words disagree, and the entry is no promise: asked
   *  through the same two functions `capture` will ask through, and a body they cannot complete is
   *  opened exactly as a body the payload never mentioned.
   *
   *  Asked for every root on every mutation, so the cheap questions come first: the id, then a read
   *  of the body's own text for the ellipsis the page leaves at a cut (`bodyTruncated` keys on the
   *  same character), and only then the two clones a body that may be cut costs — the expander's
   *  read of the run, and the prefix `wholeBodyText` matches against the payload. An ordinary feed
   *  post, whose body is complete, is still dismissed by the ellipsis read alone. */
  bodyClipped(root) {
    // The mobile app states no payload this adapter can read, so the expander it left in the body
    // is not a shortcut around a longer text — it is the only road to the rest of it, and a body
    // carrying one is a body being held back. (See the mobile section: `bodyTruncated`'s `…` test
    // finds nothing there, because that surface writes three ASCII dots.)
    if (isMobileRoot(root)) return mobileExpanderIn(mobileBody(root)) !== null;
    const id = postIdOf(root);
    if (!id) return false;
    const body = root.matches(COMMENT) ? root : storyMessage(root);
    if (!body) return false;
    // Nothing the page cut can be held back without the ellipsis it writes at the cut, so a body
    // holding none is a complete body: the common root, and the answer that costs one string read.
    if (!(body.textContent ?? '').includes('…')) return false;
    if (!bodyTruncated(body)) return false;
    const shown = root.matches(COMMENT) ? (commentText(root) ?? '') : bodyWords(body);
    if (!shown) return false;
    const whole = root.matches(COMMENT)
      ? wholeCommentText(id, body, shown)
      : wholeBodyText(id, body, shown);
    return whole === '';
  },

  /** Give a body the payload cannot complete its whole text back, by driving the page's own
   *  expander.
   *
   *  Serialized and bounded exactly as Quora's is, and for the same reasons: the click is a real
   *  interaction with the host, which answers it by re-rendering, so two of them racing would
   *  interleave two of those re-renders under each other's polls; and a control that refuses to
   *  open must not be clicked forever. `expanding` is the queue rather than a flag so that every
   *  caller awaits the whole of it.
   *
   *  The signal watched for is the body growing, with the affordance going away as the second
   *  way the wait can be over — the same pair Quora watches, and the same poll, because this is
   *  the same kind of host control. The affordance alone is not enough of an answer: the page
   *  removes it as soon as it is clicked and writes the words a re-render later, and a body read
   *  in that window is still the prefix. Nothing is put back: the reader is owed the text the
   *  page was holding, so an expansion is a page left MORE readable than it was found. A root
   *  whose body will not open keeps its prefix and stays out of this batch, which costs it a
   *  button rather than a wrong one; a later sweep tries again, and after `MAX_EXPAND_ATTEMPTS`
   *  it is left alone so a refusal cannot be paid for on every sweep. */
  async revealClipped(root, opts) {
    if (isMobileRoot(root)) return revealMobileClipped(root, opts);
    if (!expanderOf(root)) return;
    if (!opts?.onDemand) {
      const attempts = (expandAttempts.get(root) ?? 0) + 1;
      expandAttempts.set(root, attempts);
      if (attempts > MAX_EXPAND_ATTEMPTS) return;
    }

    expanding = expanding
      .then(async () => {
        if (!root.isConnected) return;
        const more = expanderOf(root);
        if (!more) return;
        const before = ownBodyLength(root);
        (more as HTMLElement).click();
        for (let i = 0; i < EXPAND_POLLS; i++) {
          await new Promise((resolve) => setTimeout(resolve, EXPAND_POLL_MS));
          if (!root.isConnected) return;
          if (ownBodyLength(root) > before) return;
          // The control going away is the page answering, but the answer it gives that way is not
          // always the text: it is removed the moment it is clicked and the words arrive a
          // re-render later, and the body read in between is the prefix the page was holding —
          // which `capture` would then file as the post's own words (see `endsAtCut`). So the
          // wait ends on the words having grown, or on the control being gone with the cut gone
          // from the words as well: the two ways there is nothing left to wait for.
          const body = root.matches(COMMENT) ? root : storyMessage(root);
          if (!expanderOf(root) && !(body && endsAtCut(body))) return;
        }
        console.warn('[misinfo] facebook: a clipped post would not expand; it stays out of this batch');
      })
      .catch((e) => {
        console.error('[misinfo] facebook: expanding a clipped post failed', e);
      });
    return expanding;
  },

  isLongForm(root) {
    if (isMobileRoot(root)) {
      const body = mobileBody(root);
      if (!body) return false;
      return mobileExpanderIn(body) !== null || mobileWords(body).length >= LONG_FORM_CHARS;
    }
    if (root.matches(COMMENT)) return false;
    const body = storyMessage(root);
    if (!body) return false;
    return bodyTruncated(body) || textOf(body).length >= LONG_FORM_CHARS;
  },

  textElement(root) {
    if (isMobileRoot(root)) return mobileBody(root);
    if (root.matches(COMMENT)) return root.querySelector(DIR_AUTO);
    return storyMessage(root);
  },

  // A comment is classified as ONE post — the worker reads its blocks together — but the page
  // renders it as sibling `dir="auto"` runs, which is the shape this hook exists for. Handed
  // the whole classified text and only the first run, the in-place painter can find no fit at
  // all: the classified string is not inside that run, and no leading stretch of it long enough
  // to align on is either, so the highlight is dropped silently. Measured on the comment that
  // prompted this — two paragraphs, EVERY claim in the second — the page showed the claim row
  // and not one highlight. With the regions the painter is handed each run and the slice of the
  // classified text that run shows, so a claim highlights in the paragraph it was found in.
  //
  // A story states all of its words in one element (`story_message`) and needs none of this;
  // so does a one-run comment, whose single region would be the element `textElement` already
  // returns. Both return null and leave the ordinary path untouched.
  //
  // A comment the page TRUNCATED is left out as well. There the classified text is not this
  // join: `wholeCommentText` files the runs with the page's expander taken out and the payload
  // supplying the remainder, so the runs hold a stretch of characters the classified string does
  // not — measuring regions off them would put a later run's slice on the wrong words, and a
  // misaligned highlight is worse than none. The runs are aligned again once the expander has
  // been clicked, which is what the capture waits for; this is the row where that click failed.
  textRegions(root) {
    // A mobile story states all of its words in one text component, so the element `textElement`
    // already returns is the whole classified string and needs no regions — the same answer a
    // one-run comment gets.
    if (isMobileRoot(root)) return null;
    if (!root.matches(COMMENT)) return null;
    if (bodyTruncated(root)) return null;
    const parts = commentParts(root);
    if (parts.length < 2) return null;
    const regions: TextRegion[] = [];
    let at = 0;
    for (const part of parts) {
      regions.push({ el: part.el, start: at, end: at + part.text.length });
      at += part.text.length + COMMENT_BLOCK_JOIN.length;
    }
    return regions;
  },

  // Both bodies are markup — a post's can hold links, mentions and emoji, a comment's is
  // split across sibling blocks — so rebuilding either from the classified string would
  // flatten the page's own DOM. Highlights wrap the page's text nodes in place instead.
  highlightInPlace: true,

  placeButtons(container, root) {
    // A mobile story's buttons go at the right-hand end of the story's own header, in the same
    // place they take on the desktop surface, and clear of the `…` menu the app ends that header
    // with.
    //
    // They are laid OVER the app's layout rather than into it, and that is the whole of this
    // branch. The m-site lays its components out at fixed inline heights and positions them
    // absolutely inside `position: relative` containers, so a sibling added in flow does not
    // enlarge anything: measured, a pill of ours inserted after the action row grew no container,
    // overflowed the row's box by 20px, and was painted over by the next story — which starts at
    // the height the app computed, not at the height we made. Measured the same way, a pill
    // inserted INTO the row's flex line is crushed to a 3px sliver, because the app's own chips
    // are positioned absolutely and paint over in-flow content. A laid-over pill changes no
    // host geometry at all, so it cannot displace or squeeze anything (see
    // `placement-follows-the-hosts-row-end`).
    //
    // Two measured traps this avoids, and the first one is not the one it looks like: the app's
    // containers are `pointer-events: none` and turn it back on inside their own tappable rows, so
    // a hit test at the pill's own centre reports a host element — which reads like occlusion
    // while the pill is in fact painted whole, but is not: the pill INHERITS that `none`, so the
    // tap goes through it to the row underneath and opens the story (the seat below answers it).
    // The second is z-index: the app paints its components in DOM order at equal z-index, so a pill
    // inside the story root's own stacking context needs MOB_SEAT_Z to stay above the components
    // that follow the row it sits on.
    //
    // Where that is, is not ours to choose: `mobileWindow` MEASURES the room the app left at the
    // end of the header's first line, because there is nowhere else on the story the pill can go
    // without covering something — see that helper. Anywhere outside the root is not an option
    // either: a seat outside the root is never wired and never cleaned up.
    if (isMobileRoot(root)) {
      // A story the app has in the DOM but recycled off-screen has no box: every edge of it
      // measures zero, and seating from that put the pill at the far left of a story that then
      // appeared — measured, `right: 6px` on a root whose own rectangle was 0x0. Nothing can be
      // measured here, so nothing is placed: the bar is left unpainted and the next pass that
      // seats it, once the root has a box, is the one that decides where it goes.
      const rootRect = root.getBoundingClientRect();
      if (rootRect.width <= 0 || rootRect.height <= 0) {
        container.dataset.mfSeatWidth = '-1';
        container.style.visibility = 'hidden';
        if (container.parentElement !== root) root.appendChild(container);
        return;
      }
      container.style.visibility = '';
      // A comment's seat is its own name line; a story's is the room the app left at the end of
      // its header (see the two helpers). Both are laid over the app's layout the same way, and
      // a comment is an `MContainer` like a story, so it is the mark that decides which.
      const comment = isMobileComment(root);
      const header = comment ? null : mobileHeader(root);
      const end = header ? mobileEndControl(header) : null;
      container.style.float = '';
      container.style.marginLeft = '';
      container.style.marginTop = '';
      container.style.position = 'absolute';
      container.style.zIndex = MOB_SEAT_Z;
      // And TAPPABLE, which on this surface is a property the pill has to ask for itself. The app
      // sets `pointer-events: none` on the containers it lays out and turns it back on inside the
      // rows it wants tapped, so a seat that says nothing inherits the `none` and is inert however
      // whole it paints: measured on a live feed, a tap at the pill's own centre hit-tested to a
      // host `MContainer`, never reached the pill's own listeners, and navigated to the story —
      // exactly the report this answers. With the property set, the same tap hits the pill, fires
      // the button, and does not navigate. The bar's own sealing already stops the host from
      // hearing the events once they arrive; this is only what lets them arrive.
      container.style.pointerEvents = 'auto';
      // The ground is written here as well as told to the bar's own renderer. That renderer decides
      // the container's background on every render, but two measured facts stop it from being the
      // one that lands: it writes chrome only when the bar key changes, and it runs BEFORE this
      // attribute is set — so on the first paint the dataset alone left the container at
      // `rgba(0, 0, 0, 0)` with the host's own words reading through the label.
      const surface = mobileSurfaceColor(root);
      container.dataset.mfSeatBg = surface;
      container.style.backgroundColor = surface;
      const seat = comment ? mobileCommentWindow(root) : mobileWindow(root, header, end);
      // The width the app left, for the bar's renderer: a row with no room for words gets the mark
      // instead of a label crushed to nothing (see `mf-seat-width` there).
      container.dataset.mfSeatWidth = String(Math.round(seat.width));
      // Only when it is not already there: this runs on every pass that re-measures the seat, and
      // re-appending a node that is already the root's last child is a DOM mutation with no
      // effect on the layout — noise the host's own observers would have to answer for.
      if (container.parentElement !== root) root.appendChild(container);
      // A comment's pill is anchored by its LEFT edge — the start of the room its own name line
      // left, which is where the name ends — so it reads as part of the line the name is on. A
      // story's stays anchored by its RIGHT edge, at the end of the header row: the bar's own width
      // is not known here (the renderer that decides how much of the label survives runs after
      // this), and each of those edges holds still while that width changes under it.
      const block = (container.offsetParent as HTMLElement | null) ?? root;
      const blockRect = block.getBoundingClientRect();
      if ('left' in seat) {
        container.style.right = 'auto';
        container.style.left = `${Math.round(seat.left - blockRect.left)}px`;
      } else {
        container.style.left = 'auto';
        container.style.right = `${Math.round(blockRect.right - seat.right)}px`;
      }
      container.style.top = `${Math.round(seat.top - blockRect.top)}px`;
      return;
    }
    // A comment's buttons go at the right-hand end of its header line, AFTER the time, the
    // position they take on every platform here. That line is inline content rather than a
    // flex row, so a right float is the equivalent of the other adapters' `marginLeft: auto`:
    // it lands at the end of the line its text is on.
    //
    // The line is not the name's own parent. A comment renders its header as two sibling
    // blocks — measured: one div holding the name, another holding "· 9w" — so appending to
    // the name's parent puts the buttons BETWEEN the name and the time; the line has to be
    // found from the comment's own timestamp, bounded above the body (see commentHeaderLine).
    // The name itself is still read through `commentAuthorEl`, because taking the row's first
    // link instead would have put the buttons inside an avatar or a timestamp.
    if (root.matches(COMMENT)) {
      // A comment's buttons go immediately to the RIGHT of its own timestamp — `Name · 9w
      // [Disinfact]`. A right float instead parks them at the far right edge of the header
      // line, which on a comment is a full column away from the time they belong to; that is
      // what this used to do, and the position every platform here now shares.
      container.style.float = '';
      container.style.marginLeft = '8px';
      const stamp = commentStampEl(root);
      if (!stamp) return;
      const line = commentHeaderLine(root, stamp);
      if (!line || !line.contains(stamp)) return;
      // Inserted after the line's own child that CARRIES the timestamp, not after the stamp
      // itself: measured, a comment's header is sibling blocks — one holding the name, a
      // second holding `· 9w` — and a pill dropped inside the stamp's own block would sit
      // beside the stamp rather than following the whole header. See commentHeaderLine.
      let anchor: Element = stamp;
      while (anchor.parentElement && anchor.parentElement !== line) anchor = anchor.parentElement;
      if (anchor.parentElement === line) anchor.insertAdjacentElement('afterend', container);
      else line.appendChild(container);
      return;
    }
    // A story's buttons go at the right-hand end of its header bar, inset out of the way
    // of the "…" control that occupies that corner: inserted BEFORE it rather than over it.
    // The bar is the nearest flex ancestor of the name that also holds that control —
    // found by where it sits, never by any label on it.
    //
    // The control, and not the story's `meta` line, is what the row is found by, because a
    // HOME-FEED story carries no `meta` role at all: measured, its whole header holds none
    // (the only `meta` on the page belonged to another element entirely), so a row looked up
    // by meta was never found there, `placeButtons` returned early and a feed story got no
    // buttons at all — while the classification behind them had already run and been paid
    // for. A page's own feed does carry `meta`, and its header bar holds this same control,
    // so one rule covers both.
    // The name's role where the surface states one, the header bar frozen with the block where it
    // states none (see `footerStoryRoots`) — the same row either way, and the same search for the
    // control the buttons are inset from, because that search is by position and holds no label.
    let row: Element | null = root.querySelector(NAME) ?? footerBlocks.get(root)?.row ?? null;
    let menu: Element | null = null;
    for (let i = 0; row && row !== root && i < 8; i++) {
      if (getComputedStyle(row).display === 'flex') {
        menu = menuControl(row);
        if (menu) break;
      }
      row = row.parentElement;
    }
    if (!row || row === root || !menu) return;
    container.style.marginLeft = 'auto';
    // Inserted before the row's own child that HOLDS the control, not the control itself:
    // measured, the control sits three levels inside the row (the row's child is the cluster
    // that carries it), and `insertBefore` takes a child rather than any descendant. Handing
    // it the control throws `NotFoundError`, and a throw here does not merely misplace one
    // bar — it propagates out of the injection and abandons every remaining post in the
    // batch, so a story that had already been captured, announced and PAID FOR came out with
    // no buttons and nothing logged to say why. The cluster lands at the same place the
    // control does, so the buttons still sit at the row's right-hand end, inset clear of it.
    let anchor: Element = menu;
    while (anchor.parentElement && anchor.parentElement !== row) anchor = anchor.parentElement;
    if (anchor.parentElement !== row) return;
    row.insertBefore(container, anchor);

    // The row is top-aligned, and the host's own "…" control insets itself from the row's top —
    // measured 8px, which is why the control reads as sitting slightly lower than the name. Level
    // with the NAME line instead, the buttons read as part of the name; inset by the control's own
    // offset they ride the line the row's other furniture is on, which is where they belong. The
    // offset is measured from the live boxes rather than written down, so it follows the host if
    // that inset ever changes.
    //
    // Cleared first: `placeButtons` runs again on every re-injection, and a margin left over from
    // the previous pass would be measured as part of the container's own position, read as "no
    // offset needed" and stripped — so the buttons would drop back to the name on every second
    // pass.
    container.style.marginTop = '';
    const centre = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.top + r.height / 2;
    };
    const delta = Math.round(centre(menu) - centre(container));
    if (Number.isFinite(delta) && delta > 0) container.style.marginTop = `${delta}px`;
  },

  feedCenter() {
    // The feed column is as wide as a story's own root, so a story is what to measure —
    // the column, not the viewport, is what the floating buttons belong over.
    const story = postRootsFromDom()[0] ?? commentRoots()[0] ?? mobileRoots()[0];
    if (!story) return null;
    const rect = story.getBoundingClientRect();
    return rect.width > 0 ? rect.left + rect.width / 2 : null;
  },

  isPostTarget(id) {
    return [...postRootsFromDom(), ...commentRoots(), ...mobileRoots(), ...mobileCommentRoots()].some(
      (root) => postIdOf(root) === id,
    );
  },

  postElementFor(node) {
    const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    if (!el) return null;
    // The mobile app's own stories first, and by containment rather than by any host link: a
    // mobile story holds no anchor at all inside itself (measured), so a selection made in one is
    // resolved by walking up to the container it sits in.
    const mobile = mobileRootFor(node);
    if (mobile && postIdOf(mobile)) return mobile;
    // Innermost first: a comment sits inside the story that holds it, and a selection in
    // the comment must be handed to the comment rather than to the story around it.
    const comment = el.closest(COMMENT);
    if (comment && postIdOf(comment)) return comment;
    for (let cur: Element | null = el; cur && cur !== document.body; cur = cur.parentElement) {
      if (cur.querySelector?.(LIKE_BUTTON) && postIdIn(cur)) return cur;
    }
    return null;
  },

  captureRoots() {
    return [...postRootsFromDom(), ...commentRoots(), ...mobileRoots(), ...mobileCommentRoots()];
  },

  /** Which language the page is being translated into, when the post on screen is a translation.
   *
   *  Facebook translates into the reader's own language and the response says nothing about
   *  which one it was (`data.node.translation` carries `message` and no locale), so the document's
   *  own language is the name — the same reading `telegram.ts` and `threads.ts` take, and the
   *  same caveat: it names the language a highlight range gets filed under, never the text
   *  itself, which is read from the page. Null when the post is showing its own words, and null
   *  when the document states no language at all, which is read as "no translation to describe"
   *  rather than as a language named nothing. */
  displayedTranslationLocale(root) {
    return isTranslated(root) ? appLanguage() : null;
  },

  /** The side on screen, read only when the reader's own flip is being reported.
   *
   *  The TRANSLATION, not the element `textElement` names: a flip leaves the post's own words
   *  where they were and paints the translation beside them, so the run carrying the fetched
   *  string is the one the reader is reading. Falls back to that element only if nothing in the
   *  root matches a fetched translation, which a report of a flip should not reach. */
  displayedText(root) {
    if (!isTranslated(root)) return null;
    return translatedBody(root) ?? (shownBody(root) || null);
  },

  /** Take in the translations the app's own GraphQL hands over.
   *
   *  Not a capture: a record is one string and it names no post, no author and no id the page
   *  carries — Facebook's story id reaches the DOM nowhere, so the only join available is the
   *  text itself, matched against the body on screen by `isTranslated`. It is remembered for one
   *  reader because it answers the one question Facebook's markup cannot: which side is showing. */
  absorbTranslations(records) {
    for (const record of records) {
      if (!record || typeof record !== 'object') continue;
      const { text } = record as { text?: unknown };
      if (typeof text !== 'string' || text.length < MIN_TRANSLATION_LENGTH) continue;
      if (shownTranslations.includes(text)) continue;
      shownTranslations.push(text);
    }
    while (shownTranslations.length > MAX_SHOWN_TRANSLATIONS) shownTranslations.shift();
  },

  /** Take in the thread edges the app's own GraphQL states.
   *
   *  Not a capture: an edge names no text, no author and no language, so there is nothing to
   *  classify and nothing to announce. It is one fact about a comment — which comment it
   *  answers — and it is the fact the markup gets wrong, so it is remembered rather than
   *  filed (see `commentParents`).
   *
   *  Every field is validated: this is page-authored data reaching an adapter, so a record
   *  with a non-numeric id, a malformed one, or an edge pointing at itself is dropped rather
   *  than stored. The whole map is returned, not just the new edges, so the caller can put
   *  right a comment it captured before the payload describing it arrived. */
  absorbThreadEdges(records) {
    for (const record of records) {
      if (!record || typeof record !== 'object') continue;
      const { id, parentId } = record as { id?: unknown; parentId?: unknown };
      if (typeof id !== 'string' || typeof parentId !== 'string') continue;
      if (!/^\d+$/.test(id) || !/^\d+$/.test(parentId) || id === parentId) continue;
      commentParents.set(namespaced(id), namespaced(parentId));
    }
    while (commentParents.size > MAX_REMEMBERED_PARENTS) {
      const oldest = commentParents.keys().next().value;
      if (oldest === undefined) break;
      commentParents.delete(oldest);
    }
    return commentParents;
  },

  /** Take in the ids the app's own responses state for the posts they carry.
   *
   *  Not a capture: an id names no text, no author and no language, so there is nothing to
   *  classify and nothing to announce. It settles which story a post root stands for when the
   *  markup names that story only by a `pfbid…` or by one of its photos (see `postIdIn`), and
   *  a root captured after it arrives is filed under the story's own id. A root captured
   *  before it keeps the name its markup stated: an id is frozen per root (see `postIdIn`), so
   *  a late payload cannot leave one root answering to two ids — one element must not become
   *  two posts, the rule `postRootsFromDom` enforces for the same reason. */
  absorbPostIds(records) {
    rememberPostIds(records);
  },

  /** Take in what the app's own responses say each comment says.
   *
   *  Not a capture either: a comment's words are captured off the page, and this only supplies
   *  the rest of a text the page chose to truncate (`wholeCommentText`). Remembered so that a
   *  clipped comment is filed whole, whether its payload was read from a blob before the
   *  comment was swept or arrived here after it. */
  absorbCommentTexts(records) {
    rememberCommentTexts(records);
  },

  capture(root): CapturedPost | null {
    // The mobile app's own stories are composed by their own reader: no payload stands behind
    // them, so a body the app is holding back is refused rather than completed. Every mobile
    // filing is remembered on the way out, because a thread screen's answers are filed under a
    // comment that was filed off the STORY view and nothing on the thread screen says whether the
    // reader ever saw it (see `filedMobileIds`).
    if (isMobileRoot(root)) {
      const lifted = captureMobile(root);
      if (lifted) filedMobileIds.add(lifted.post.id);
      return lifted;
    }
    const id = postIdOf(root);
    if (!id) return null;
    // A paid placement, refused here as well as at the root scan: a story is also reached
    // through `captureRoots`' comment list and through the ancestor walk that lifts a chain,
    // and an ad must not be classified — nor be linked into a batch as somebody's ancestor —
    // whichever way it arrives. A comment's own subtree is not searched for the role: the
    // marker is the story's, and a comment that quotes a link to an ad is not an ad.
    if (!root.matches(COMMENT) && sponsored(root)) return null;

    if (root.matches(COMMENT)) {
      // A comment a computed style is clipping still holds all of its words, so it stays
      // refused; a comment TRUNCATED in place is completed from the page's own payload, which
      // states what the comment says under the id its own permalink already names it by
      // (`wholeCommentText`). Checked before anything is remembered either way, so a prefix is
      // never kept as a comment's own words.
      if (bodyClamped(root)) return null;
      const shown = commentText(root) ?? '';
      const username = commentAuthor(root);
      // A comment with no words carries nothing to fact-check, and one with no name
      // carries no context to classify it with. Either way it stays out of the batch
      // rather than spending a classification on it.
      if (!shown || !username) return null;
      const text = wholeCommentText(id, root, shown);
      if (!text) return null;
      const destination = isTranslated(root) ? appLanguage() : null;
      const transcribed = destination ? translatedBody(root) : null;
      const ref = commentRef(root);
      // The post this comment hangs under: the DOM's answer first, because the decoded one
      // is a different name for the same post (see `enclosingPostId`) and would leave the
      // parent unlinkable. The decoded id stays as the fallback for a comment whose post root
      // is not on screen.
      const story = enclosingPostId(root) ?? ref?.post ?? null;
      // The comment it answers, when it answers one. Only the comment ids join each other
      // here (both are legacy decimal); the story is resolved by containment because its own
      // id is a pfbid. The payload is asked first because the markup is right for one level
      // only: a reply to a reply is named by its link as a child of the thread's root.
      const parent = commentParents.get(id) ?? commentParentId(root);
      return {
        post: {
          id,
          text,
          fullText: text,
          translatedText: transcribed ?? undefined,
          destinationLanguage: transcribed ? destination ?? undefined : undefined,
          username,
          usertype: isVerified(commentAuthorEl(root)?.parentElement ?? null) ? VERIFIED : REGULAR,
          // A comment belongs to the story it hangs under; the fallback is the comment
          // itself, so a thread is never merged into an unrelated one.
          conversationId: story ? namespaced(story) : id,
          quoting: null,
          replyingTo: null,
        } as MainTweet,
        // A comment's ancestor is the comment it answers, and a top-level comment's is the
        // story: the chain is post ← comment ← comment, exactly the shape the host's own
        // payload describes with `depth` 0 against `depth` 1. The layout is flat — no comment
        // root sits inside another — so the edge comes from the reply's own permalink rather
        // than from nesting (see `commentParentId`). A comment whose parent is not on screen
        // links to nothing, and `relink` adds it on a later sweep once the parent is captured.
        replyParentId: parent ? namespaced(parent) : story ? namespaced(story) : null,
      };
    }

    const body = storyMessage(root);
    if (!body) return null;
    // A body a computed style is clipping still holds all of its words, so it stays refused;
    // a body TRUNCATED in place is completed from the page's own payload (`wholeBodyText`).
    if (bodyClamped(body)) return null;
    const shown = bodyWords(body);
    // The name's role where the surface states one; the author link where it states none — the
    // block's own header, found when the block was (see `footerStoryRoots`).
    const link = footerBlocks.get(root)?.author ?? null;
    const author = root.querySelector(NAME) ?? link;
    const username = storyAuthor(author);
    if (!shown || !username) return null;
    const text = wholeBodyText(id, body, shown);
    if (!text) return null;
    const destination = isTranslated(root) ? appLanguage() : null;
    const transcribed = destination ? translatedBody(root) : null;
    return {
      post: {
        id,
        text,
        fullText: text,
        translatedText: transcribed ?? undefined,
        destinationLanguage: transcribed ? destination ?? undefined : undefined,
        username,
        // The name's role carries the badge inside it; a surface with no `profile_name` puts the
        // badge beside the author link instead, so the search is widened to the link's own line.
        // A `VERIFIED` read as `Regular` would be a wrong classification context, which is the
        // one thing the badge is read for.
        usertype: isVerified(root.querySelector(NAME) ?? link?.parentElement ?? null) ? VERIFIED : REGULAR,
        conversationId: id,
        quoting: null,
        replyingTo: null,
      } as MainTweet,
      replyParentId: null,
    };
  },
};
