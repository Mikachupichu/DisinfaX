/** The Quora adapter.
 *
 *  Six surfaces are integrated, and one is deliberately not. Integrated: a **feed story** in
 *  the reader's home feed, an **answer on a question page**, an **answer permalink** page
 *  (`/<Question>/answer/<Author>`), the **comments** under an answer, and the two **answer
 *  lists** that render whole answers with no answer item around them — a **topic page**
 *  (`/topic/<slug>`) and a **search result list** (`/search?q=…`). Not integrated: **Quora
 *  Spaces** long-form blog posts, for the reason articles are excluded on Substack — a Space
 *  post is a page of prose, which is what the ordinary web selection / right-click flow is
 *  for. Nothing here claims them, so that flow is left unrestricted across them.
 *
 *  The two list surfaces were the last found and are the reason `cardOf` exists: measured
 *  2026-10-02, neither renders a single `dom_annotate_question_answer_item` — the topic page
 *  wraps its 9 answers in `dom_annotate_multifeed_bundle_AnswersBundle`, and the search list
 *  wraps its 26 in nothing named at all — so before it there was no root to hand out and both
 *  surfaces got no buttons at all.
 *
 *  ## The clamp, and why this adapter clicks
 *
 *  Quora cuts a long body short and holds the rest behind its own affordance — `.qt_read_more`,
 *  the "(more)" the reader clicks. Unlike every other host's clamp, the text behind it is NOT
 *  in the DOM: measured, clicking it grew one answer's body from 308 to 545 characters and a
 *  feed card's from 424 to 1667, and the revealed text was in none of the page's own traffic —
 *  not in the GraphQL responses, not in the tchannel websocket, not in the document the server
 *  first sent. So there is nothing to read around it, and a post hashed while clamped hashes a
 *  PREFIX: the same answer would be two posts, one before the reader expanded it and one after.
 *
 *  A clipped root is therefore still a post — it is announced and it carries buttons like any
 *  other — and `revealClipped` drives the host's own affordance before `capture` reads it, the
 *  one place in this extension where the reader's page is asked for text rather than merely
 *  read. `capture` refuses a root that is still clipped, so the failure path is a retry on a
 *  later sweep and never a prefix. On a question page — where Quora clamps nothing — every
 *  answer is integrated from the start, with no click at all.
 *
 *  Which roots clip is Quora's to decide and it decides per view rather than per length:
 *  measured 2026-10-01, a question page's answer list clamps nothing (0 of 23 answers on three
 *  questions, all rendered whole), while the feed-shaped cards — the home feed, which is what
 *  `puppeteer_test_tribe_post_item_feed_story` is — clamp every story. Both are integrated.
 *
 *  ## Why the DOM, on a platform with a JSON API
 *
 *  Unlike every platform after X, Quora has no payload worth preferring. Measured while
 *  reading this rollout: its own GraphQL requests for a question page (`gql_para_POST`,
 *  `gql_POST`) return badge counts — upvote and comment totals — and not the answer bodies,
 *  and the page's tchannel websocket push carried the answers for none of the surfaces read.
 *  So the DOM is the source here rather than the fallback, and `captureNetwork` is absent
 *  because there is nothing to feed it.
 *
 *  ## Anchors
 *
 *  Every anchor is one of Quora's own semantic names — `dom_annotate_question_answer_item`,
 *  `puppeteer_test_answer_content`, `puppeteer_test_tribe_post_item_feed_story`,
 *  `dom_annotate_answer_action_bar_upvote`, `qt_read_more` — plus two of Quora's layout
 *  utility prefixes (`qu-display--block`, `qu-wordBreak--break-word`) and the `comment_id=`
 *  a comment's own permalink carries. None of it is a build-hashed class, and none of it is
 *  locale-dependent text.
 *
 *  ## Two structural facts that shape everything below
 *
 *  **Comments are flat.** A Quora thread renders every comment as a direct sibling inside
 *  one panel (`q-box qu-pt--small qu-bg--raised`, its own class, never named here) and shows
 *  depth as indentation alone — measured: depth 0 at x=395 and depth 1 at x=439 in a 610px
 *  column, no `data-*` attribute anywhere, no nesting. So a reply's parent cannot be read
 *  off ancestry; `replyParentIdOf` uses the indentation instead.
 *
 *  **An answer's text is spread across blocks.** On a question page the answer's body is one
 *  `puppeteer_test_answer_content` container that also holds an inline sibling the block
 *  selector misses (measured: 164 characters, of which the `display:block` blocks account
 *  for 133); on a permalink it is loose sibling blocks (measured: six blocks whose texts
 *  account for the whole body, with the answer's metrics — "43 vues · Afficher 2 votes
 *  positifs" — outside them). So the container is preferred where it exists and the blocks
 *  are the fallback, and the blocks are returned as regions so a claim is painted over the
 *  block it was measured in rather than over the first one.
 *
 *  **The datetime is the age label, and that is measured.** An answer's own timestamp is a
 *  relative label and nothing else — measured 2026-10-14 on a question page: `Updated 6y`, inside
 *  `a.answer_timestamp`, with no `title`, no `<time>` element anywhere on the page and no date in
 *  the page's shipped scripts. So the instant is that label read against the clock the post was
 *  swept at (`isoDatetimeFromAge`), which is a floor rather than a measurement: `6y` dates the
 *  post to the year, `2h` to the hour. A label in a language these spellings do not cover leaves
 *  the post undated, which is what it was before, rather than misdated.
 */
import type { MainTweet, Usertype } from '../../data/Tweets';
import { Usertype as UsertypeEnum } from '../../data/Tweets';
import { isoDatetimeFromAge } from '../datetime';
import { passageTextContent } from '../injecting';
import { PLATFORM_HOSTS } from './hosts';
import type { CapturedPost, PlatformAdapter, TextRegion } from './types';

/** Ids are namespaced for the reason every non-X platform namespaces them: the background
 *  fans a classification out to EVERY connected relay rather than keying by tab, so a bare
 *  id could be injected into an unrelated page. */
const ID_PREFIX = 'quora:';

function namespaced(id: string): string {
  return ID_PREFIX + id;
}

/* ── Quora's own names ─────────────────────────────────────────────────────────── */

/** One answer in a question page's answer list. */
const ANSWER_ITEM = '[class*="dom_annotate_question_answer_item"]';
/** The container an answer's body is rendered into, on the surfaces that have it. */
const ANSWER_CONTENT = '[class*="puppeteer_test_answer_content"]';
/** One story in the home feed. */
const FEED_STORY = '[class*="puppeteer_test_tribe_post_item_feed_story"]';
/** The action bar under an answer — the anchor the permalink root is measured up from. */
const PERMALINK_BAR = '[class*="dom_annotate_answer_action_bar_upvote"]';
/** The question a page is about, as the element carrying its words. In an answer permalink's
 *  card, in a topic page's answer card and in a search result; above the answers on a question
 *  page — and on every related-question row as well, which is why nothing here ever takes the
 *  first one on the page. */
const QUESTION_TITLE = 'div[class*="puppeteer_test_question_title"]';
/** The question column of a question page. Present only there, and holding the answers as
 *  well as the question, so it is read for its title alone. */
const QUESTION_MAIN = '[class*="puppeteer_test_question_main"]';
/** One paragraph-level block of an answer's body. Quora's own utility prefixes, on the one
 *  element type its rich-text renderer emits per block. */
const TEXT_BLOCK = '[class*="qu-display--block"][class*="qu-wordBreak--break-word"]';
/** A profile link. Quora's avatar link is one too and carries no text, which is why every
 *  read below takes the first one WITH text. */
const PROFILE_LINK = 'a[href*="/profile/"]';
/** A comment's own permalink, which is where its id is. */
const COMMENT_LINK = 'a[href*="comment_id="]';
/** Quora's clamp: the "read more" affordance, present only on a truncated post. */
const TRUNCATED = '.qt_read_more';
/** A post's own age label — the only statement of when it was written on the page (see the
 *  datetime note at the top). Relative, so it is read against the clock of the sweep that
 *  found it. Prefix-matched: the suffix, if the class ever grows one, is not this adapter's
 *  business. */
const TIMESTAMP = 'a[class*="answer_timestamp"]';
/** The content column, used only as the last fallback for `feedCenter`. */
const CONTENT_COLUMN = '#mainContent';
/** How two blocks of one answer's body are joined into the classified text. Only the
 *  separator matters to the model; the highlight layer drops it, since the character between
 *  two regions belongs to no region. */
const BLOCK_JOIN = '\n\n';
const COMMENT_ID = /comment_id=(\d+)/;
/** Breathing room between our buttons and whatever Quora floats at the post's right-hand end. */
const CORNER_GAP = 4;

/** How many times one root is asked to expand before it is left alone, and how long each ask
 *  waits. The affordance is gone once the body opens, so the bound only ever bites on a host
 *  that refused — and clicking forever is not an option, since every click is a mutation on
 *  the page and mutations are what drive the sweep. */
const MAX_EXPAND_ATTEMPTS = 3;
const EXPAND_POLL_MS = 25;
const EXPAND_POLLS = 40;

const expandAttempts = new WeakMap<Element, number>();

/** The expansion in flight, so only one runs at a time — the same reason Telegram serializes
 *  its flips. A card can be re-rendered while an earlier expansion is settling, and the queue
 *  is what lets the next one re-resolve its own body instead of clicking a detached node. */
let expanding: Promise<void> = Promise.resolve();

/* ── Roots ─────────────────────────────────────────────────────────────────────── */

/** The comment a link belongs to: the outermost ancestor that holds this link and no other.
 *
 *  This is the shape of a Quora thread read backwards — every comment owns exactly one
 *  comment permalink (its own), and the first ancestor that picks up a SECOND one is the
 *  panel holding the thread rather than any single comment in it.
 *
 *  The answer's OWN structure ends the ascent before the count rule can decide it: an answer
 *  with exactly one comment holds exactly one comment permalink too, so the card would
 *  otherwise be taken for the comment. Measured on a question page, that filed the answer
 *  under the comment's id — its text answered `quora:c:<comment>` and the comment itself had
 *  no root, so the pill landed on the answer's byline and the comment got none. A comment
 *  never holds the answer's action bar or a rendered answer body, so either one is the card. */
function commentRootOf(link: Element): Element | null {
  let root: Element | null = null;
  for (let el: Element | null = link; el && el !== document.body; el = el.parentElement) {
    if (el.matches(ANSWER_ITEM) || el.matches(FEED_STORY)) break;
    if (el.querySelector(PERMALINK_BAR) || el.querySelector(ANSWER_CONTENT)) break;
    const count = el.querySelectorAll(COMMENT_LINK).length;
    if (count > 1) break;
    if (count === 1) root = el;
  }
  return root;
}

/** Every comment currently rendered, in document order. */
function commentRoots(): Element[] {
  const out: Element[] = [];
  const seen = new Set<Element>();
  for (const link of Array.from(document.querySelectorAll(COMMENT_LINK))) {
    const root = commentRootOf(link);
    if (!root || seen.has(root)) continue;
    seen.add(root);
    out.push(root);
  }
  return out;
}

/** The comment root that contains `el`, innermost first, or null.
 *
 *  The first ancestor that holds a comment permalink at all decides it: if that ancestor is
 *  the root of the link it holds, `el` is inside that comment; if it is any higher, `el` sits
 *  beside the comment rather than in it, and no ancestor below it held a comment, so `el` is
 *  in none. */
function commentRootOfElement(el: Element): Element | null {
  for (let q: Element | null = el; q; q = q.parentElement) {
    const link = q.querySelector(COMMENT_LINK);
    if (!link) continue;
    return commentRootOf(link) === q ? q : null;
  }
  return null;
}

/** The comment roots inside `scope` — used to keep a parent's read out of its replies, which
 *  matters here even though replies are not nested, because an answer's read must not pick
 *  up the comment panel rendered inside the same answer card. */
function commentRootsWithin(scope: Element): Element[] {
  const out: Element[] = [];
  const seen = new Set<Element>();
  for (const link of Array.from(scope.querySelectorAll(COMMENT_LINK))) {
    const root = commentRootOf(link);
    if (!root || root === scope || seen.has(root)) continue;
    seen.add(root);
    out.push(root);
  }
  return out;
}

/** The answer a permalink URL's path names, as `<Question slug>/answer/<Author>`, or null
 *  when the path is not an answer. Permissive about what precedes `/answer/` so both of
 *  Quora's URL shapes (`/<Question>/answer/<Author>` and `/answer/<Author>`) resolve, and
 *  the path is what makes the id stable: it is Quora's own canonical URL for that answer. */
function answerPath(pathname: string): string | null {
  const path = pathname.replace(/\/+$/, '');
  return /\/answer\/[^/]+$/.test(path) ? path.replace(/^\//, '') : null;
}

/** The namespaced id of the answer a root's own permalink points at, or null.
 *
 *  Read from the answer link inside the root rather than from the page URL, so the same
 *  answer reached from the question page and from its permalink is one id: measured, the
 *  DOM link and the permalink URL carry the identical path on both surfaces. */
function answerIdIn(root: Element): string | null {
  for (const link of Array.from(root.querySelectorAll('a[href*="/answer/"]'))) {
    const href = link.getAttribute('href');
    if (!href) continue;
    const path = answerPath(new URL(href, location.origin).pathname);
    if (path) return namespaced(`a:${path}`);
  }
  return null;
}

/** The id of the answer a feed story stands for.
 *
 *  A story carries no `/answer/` link — measured, its only post-shaped link is the date link
 *  under the byline, `/profile/<Author>/<slug>` — so that path is the id. Its own URL, and
 *  unique per story, unlike an author's profile.
 *
 *  Restricted to the story's own card, because a story can render a second author's card
 *  below it and the id must be the story's. */
function storyIdIn(root: Element): string | null {
  if (!root.matches(FEED_STORY)) return null;
  const card = bodyScope(root) ?? root;
  for (const link of Array.from(card.querySelectorAll(PROFILE_LINK))) {
    const href = link.getAttribute('href');
    if (!href) continue;
    const path = new URL(href, location.origin).pathname.replace(/\/+$/, '');
    if (/^\/profile\/[^/]+\/.+/.test(path)) return namespaced(`s:${path.replace(/^\//, '')}`);
  }
  return null;
}

/** The numeric id of the comment a root stands for, or null when the root is not a comment. */
function commentIdOf(root: Element): string | null {
  for (const link of Array.from(root.querySelectorAll(COMMENT_LINK))) {
    if (commentRootOf(link) !== root) continue;
    const match = COMMENT_ID.exec(link.getAttribute('href') ?? '');
    if (match) return match[1];
  }
  return null;
}

/** The answer a permalink page is about, as a namespaced id, or null on any other page. */
function pageAnswerId(): string | null {
  const path = answerPath(location.pathname);
  return path ? namespaced(`a:${path}`) : null;
}

/** The focal answer named by a SHARE URL, as a namespaced id, or null.
 *
 *  Quora has a second answer URL shape, and it is the one its own share button copies: the
 *  answer rendered inside its question's page and named only by the query, `<page>?…&
 *  target_type=answer&oid=<aid>`, with the path left as the question's (or a space's). There
 *  is then no `/answer/` path for `pageAnswerId` to read, no answer item, and no `/answer/`
 *  link anywhere in the page for `answerIdIn` to read either — the query is the only name
 *  that surface offers.
 *
 *  That `oid` is the answer and not the question: measured 2026-10-26 on
 *  `bulledinformation.quora.com/<Question>-1?…&oid=1477743700615780&target_type=answer`, the
 *  page's own server-rendered payload states `"__typename":"Answer","aid":1477743700615780`
 *  and `"oid":1477743700615780` for that answer, while the question carries its own id.
 *  Namespaced under `a:oid:` so a numeric aid can never be mistaken for a path id: the
 *  permalink surface names the same answer by its path, and the two are separate names for
 *  one text, which is what the id-keyed caches tolerate (they never key a name to two texts).
 *
 *  Gated on the page rendering exactly one answer, because that is what makes the query's
 *  claim true of the DOM the caller is about to read: a question page still listing its
 *  answers as `dom_annotate_question_answer_item`s names those items' own ids (that surface is
 *  whole on its own), and a page rendering several anonymous answer cards cannot say which of
 *  them the URL is pointing at, so it names none rather than the wrong one.
 *
 *  The answer arrives asynchronously on this surface, so a null is never remembered: the gate
 *  is re-measured until it holds, and only then is the id cached for this href. */
let shareAnswer: { href: string; id: string } | null = null;
function queryAnswerId(): string | null {
  const href = location.href;
  if (shareAnswer?.href === href) return shareAnswer.id;
  const params = new URLSearchParams(location.search);
  if (params.get('target_type') !== 'answer') return null;
  const oid = params.get('oid') ?? '';
  if (!/^\d+$/.test(oid)) return null;
  if (document.querySelector(ANSWER_ITEM)) return null;
  if (document.querySelectorAll(PERMALINK_BAR).length !== 1) return null;
  shareAnswer = { href, id: namespaced(`a:oid:${oid}`) };
  return shareAnswer.id;
}

/** The focal answer's root on an answer permalink page.
 *
 *  That answer has no test id of its own, so it is reached from the one thing on it Quora
 *  does name: the upvote action bar at its foot. Ascend from the bar to the last ancestor
 *  that still holds NO comment permalink — the answer's own card, since the bar sits inside
 *  it, and since the comment panel is the one thing below the bar that carries a
 *  `comment_id=`. Measured on
 *  `fr.quora.com/<Question>/answer/Edith-Donay`: `q-box qu-pt--medium qu-pb--tiny`, 634px
 *  wide, eight children — breadcrumb, title, byline, body, an empty node, the metrics line,
 *  the action bar, an empty node — with the metrics line correctly OUTSIDE the body.
 *
 *  Gated on the page naming one answer as its subject — by its path, or by a share URL's
 *  query (see `queryAnswerId`) — which is what keeps it from firing on a question page, where
 *  every answer item has one of these bars: there, the answer items are already the roots and
 *  this ascent would invent a second, overlapping root for one of them. `queryAnswerId` only
 *  answers when the page holds no answer item and a single bar, so that case stays closed. */
function permalinkAnswerRoot(): Element | null {
  if (!pageAnswerId() && !queryAnswerId()) return null;
  const bar = document.querySelector(PERMALINK_BAR);
  if (!bar) return null;
  let root: Element = bar;
  for (let el: Element | null = bar; el && el !== document.body; el = el.parentElement) {
    if (el.querySelector(COMMENT_LINK)) break;
    root = el;
  }
  return root;
}

/** The answer card an action bar sits in, or null when the bar is not inside one.
 *
 *  The ascent is the same shape as `commentRootOf`: a card owns exactly one action bar, and
 *  the first ancestor that picks up a SECOND is the list holding many cards rather than any
 *  one of them, so the card is the highest ancestor that still holds this bar alone. Among
 *  those, the one that also carries the answer's own `/answer/` permalink and its body is the
 *  card — measured, that ancestor is reached for every bar on every surface and carries
 *  exactly one bar, one body and no comment permalink.
 *
 *  On a question page this lands on the `dom_annotate_question_answer_item` itself, which is
 *  already a root; `answerRoots` dedupes, so the item stays the one root for that answer. */
function cardOf(bar: Element): Element | null {
  let card: Element | null = null;
  for (let el: Element | null = bar.parentElement; el && el !== document.body; el = el.parentElement) {
    if (el.querySelectorAll(PERMALINK_BAR).length !== 1) break;
    if (el.querySelector('a[href*="/answer/"]') && el.querySelector(ANSWER_CONTENT)) card = el;
  }
  return card;
}

/** Every answer root on the page: the answer items, the focal answer of a permalink page when
 *  it is not itself rendered as one of those, and the per-answer cards of the list surfaces
 *  that have no answer items at all.
 *
 *  Those last are the surfaces Quora renders whole answers on without an
 *  `dom_annotate_question_answer_item` anywhere: a topic page, whose answers sit in
 *  `dom_annotate_multifeed_bundle_AnswersBundle` cards, and a search result list, whose
 *  answers sit in no named container whatsoever — measured 2026-10-02, 9 answers on
 *  `/topic/Finance-et-banque` and 26 on `/search?q=intelligence artificielle`, both at 546px,
 *  every one of them with a body, an author, an answer permalink and an action bar, and
 *  neither surface producing a single root. They are answers like any other, so they are
 *  integrated like any other.
 *
 *  Roots are deduped by containment, since these sets overlap: a card sits inside an answer
 *  item on a question page, and can coincide with the focal answer on a permalink. The
 *  containment test keeps the surviving root the one that was added first, so the item wins
 *  over the card inside it and the measured focal root wins over a card covering it. */
function answerRoots(): Element[] {
  const focal = permalinkAnswerRoot();
  const out: Element[] = [];
  const add = (el: Element) => {
    if (out.some((root) => root.contains(el) || el.contains(root))) return;
    out.push(el);
  };
  for (const item of Array.from(document.querySelectorAll(ANSWER_ITEM))) {
    // A permalink page can render the focal answer inside an item as well; keeping both
    // would hang two pills on one answer under two roots for one id.
    if (focal && item.contains(focal)) continue;
    add(item);
  }
  // Before the cards, so a card that covers the focal answer yields to it.
  if (focal) add(focal);
  for (const bar of Array.from(document.querySelectorAll(PERMALINK_BAR))) {
    const card = cardOf(bar);
    if (card) add(card);
  }
  return out;
}

/* ── Text ──────────────────────────────────────────────────────────────────────── */

/** The element a root's body and byline should be read inside: the story's own card on a feed
 *  story, the root itself on every other surface.
 *
 *  A story root can hold a second author's byline and a second clamped block — a related
 *  answer card Quora renders underneath the story — so a body read scoped to the whole story
 *  root would fold that other card into the story's text. Scoping to the direct child that
 *  carries the story's own author link isolates it: measured, the story's own card is that
 *  child, and feed stories are never nested.
 *
 *  Null when a story has no such child, which makes it not a post rather than a post with
 *  someone else's text in it. */
function bodyScope(root: Element): Element | null {
  if (!root.matches(FEED_STORY)) return root;
  const link = authorLinkOf(root);
  if (!link) return null;
  for (const child of Array.from(root.children)) {
    if (child.contains(link)) return child;
  }
  return null;
}

/** The question `root` answers, as the element carrying its words, or null when it answers
 *  none.
 *
 *  Two shapes, told apart by where the title sits. A permalink's answer card, a topic page's
 *  answer card and a search result each hold the question inside themselves — measured, one
 *  title in every card. A question page's answer item holds none: there the question is the
 *  page's own heading above every item, and `QUESTION_MAIN` names that column without matching
 *  the related-question rows, which carry the same title element as the question itself.
 *
 *  A feed story never takes one: `bodyScope` exists because a story's root can hold a related
 *  answer card, and a question found in there belongs to that card, not to the story. */
function questionTitleOf(root: Element): Element | null {
  if (!root.matches(FEED_STORY)) {
    const own = root.querySelector(QUESTION_TITLE);
    if (own) return own;
  }
  if (!root.matches(ANSWER_ITEM)) return null;
  return document.querySelector(QUESTION_MAIN)?.querySelector(QUESTION_TITLE) ?? null;
}

/** The question a root answers, as the parts that open its classified text: the title, then
 *  any block Quora renders in the same box beside it.
 *
 *  Quora splits an answer over two regions the way Reddit splits a submission over its title
 *  and its body, and the two are ONE post's text — the classifier has to read both or it
 *  cannot tell what a claim is being made about (an answer saying "it worked" claims something
 *  about the question it answers). It is not an ancestor: a comment stays chained to the answer
 *  alone, and reaches the question through it.
 *
 *  The box is the highest ancestor of the title that still holds no answer of its own —
 *  measured, `q-box qu-pb--small` on a question page and the title's own box on a permalink,
 *  holding the title alone on all thirteen question pages and every permalink measured
 *  (2026-10-26). So no description is read from today's pages; the read is structural, so that
 *  a question stating one is classified whole instead of losing the half its answer is about. */
function questionParts(root: Element): { el: Element; text: string }[] {
  const title = questionTitleOf(root);
  if (!title) return [];
  const titleText = passageTextContent(title as HTMLElement).trim();
  if (!titleText) return [];

  let box: Element = title;
  for (let el = title.parentElement; el && el !== document.body; el = el.parentElement) {
    if (el.querySelector(PERMALINK_BAR) || el.querySelector(ANSWER_CONTENT)) break;
    box = el;
  }

  const out = [{ el: title, text: titleText }];
  for (const block of Array.from(box.querySelectorAll(TEXT_BLOCK))) {
    if (title.contains(block) || block.contains(title)) continue;
    const text = passageTextContent(block as HTMLElement).trim();
    if (text) out.push({ el: block, text });
  }
  return out;
}

/** The blocks a root's body is made of, in document order, each with the text this extension
 *  will classify for it. The question it answers opens the list (see `questionParts`).
 *
 *  `passageTextContent` and not `textContent`, for the reason the in-place highlighter reads
 *  the same way: this adapter paints over the page's own nodes, and the two have to agree on
 *  what the visible passage is, or a claim's offsets land on words the reader cannot see.
 *  Text belonging to a comment inside the same root is skipped — an answer's card contains
 *  its comment panel — and so is an empty block.
 *
 *  A root with no body of its own is not a post, and the question is not its text: a
 *  picture-only answer stays exactly as it was, unclassified, rather than being filed under
 *  the question's words. */
function bodyParts(root: Element): { el: Element; text: string }[] {
  const card = bodyScope(root);
  if (!card) return [];

  const body: { el: Element; text: string }[] = [];
  const container = card.querySelector(ANSWER_CONTENT);
  if (container) {
    const text = passageTextContent(container as HTMLElement).trim();
    if (text) body.push({ el: container, text });
  } else {
    const owned = commentRootsWithin(card);
    for (const block of Array.from(card.querySelectorAll(TEXT_BLOCK))) {
      if (owned.some((comment) => comment.contains(block))) continue;
      const text = passageTextContent(block as HTMLElement).trim();
      if (text) body.push({ el: block, text });
    }
  }
  if (body.length === 0) return [];
  return [...questionParts(root), ...body];
}

/** The classified text of a root: its blocks joined as they are joined by `textRegions`. */
function bodyText(root: Element): string {
  return bodyParts(root)
    .map((part) => part.text)
    .join(BLOCK_JOIN);
}

/** The expander that clamps a root's OWN body, or null when nothing of this root is clipped.
 *
 *  Read from the body inward, and structurally. Measured on a clamped answer: the affordance
 *  is a DESCENDANT of the element it clamps — `qt_read_more` inside a `q-absolute`, inside the
 *  clamped `q-text`, inside the `puppeteer_test_answer_content` container — so the body's own
 *  container is where it is looked for. A card whose body is loose sibling blocks (the
 *  permalink shape) falls back to the first expander no comment inside the root owns.
 *
 *  Null is a real answer and it is what keeps this honest: a card holds a comment thread, a
 *  clipped COMMENT is the comment's own business, and only a root with its own body expander
 *  counts as clipped. That is what a root without one keeps reading from the DOM as before. */
function expanderOf(root: Element): Element | null {
  const scope = bodyScope(root);
  if (!scope) return null;
  // One query on the common path: almost every post is not clamped, and this is asked on
  // every root of every sweep.
  if (!scope.querySelector(TRUNCATED)) return null;
  const container = scope.querySelector(ANSWER_CONTENT);
  if (container) {
    const inside = container.querySelector(TRUNCATED);
    if (inside) return inside;
  }
  const owned = scope.querySelector(COMMENT_LINK) ? commentRootsWithin(scope) : [];
  for (const more of Array.from(scope.querySelectorAll(TRUNCATED))) {
    if (owned.some((comment) => comment.contains(more))) continue;
    return more;
  }
  return null;
}

/* ── Author and header ─────────────────────────────────────────────────────────── */

/** The author's own profile link inside a scope: the first one that carries text and does
 *  not belong to a comment rendered inside the scope.
 *
 *  Quora's avatar link is a profile link too and carries no text, which is what the empty
 *  check is for — measured, it is the first `/profile/` link on every surface. The ownership
 *  test only runs where the scope holds a comment at all: an answer's card contains its
 *  comment panel, and the panel's authors must not be read as the answer's. */
function authorLinkOf(scope: Element): Element | null {
  const hasNested = !!scope.querySelector(COMMENT_LINK);
  for (const link of Array.from(scope.querySelectorAll(PROFILE_LINK))) {
    if (!(link.textContent ?? '').trim()) continue;
    if (hasNested) {
      const owner = commentRootOfElement(link);
      if (owner && owner !== scope) continue;
    }
    return link;
  }
  return null;
}

function authorOf(scope: Element): string {
  const link = authorLinkOf(scope);
  return link ? (link.textContent ?? '').trim() : '';
}

/** The row a post's buttons belong at the end of: the header bar carrying the byline.
 *
 *  Reached without naming a single one of Quora's build-hashed classes, in two steps that
 *  were measured on all four surfaces. First, from the author's own link, find the nearest
 *  flex ancestor that holds more than the name alone — either another element or more text —
 *  which is the byline row: the `Suivre` button and the credential line ("Précédent lieu :
 *  …") are what distinguish it from the wrappers around the name. Then keep climbing while
 *  the ancestor has exactly one element child and does not contain the body, promoting to any
 *  flex ancestor found on the way, and stop at the first ancestor that has more than one
 *  child or swallows the body — that is the column holding both header and body, so the row
 *  just below it is the header.
 *
 *  Measured rows: a question page's answer `q-flex qu-pt--tiny` (682×46), a permalink's
 *  answer `q-flex qu-alignItems--flex-start` (610×56: avatar, then a 566px byline), a comment
 *  `q-flex qu-alignItems--center qu-justifyContent--space-between` (566×20). All three are
 *  flex rows, which is what lets `placeButtons` push the pill to their right-hand end. */
function headerRowOf(root: Element): Element | null {
  const link = authorLinkOf(root);
  if (!link) return null;
  const nameLength = (link.textContent ?? '').trim().length;

  let row: Element | null = null;
  for (let el: Element | null = link; el && el !== root; el = el.parentElement) {
    const display = getComputedStyle(el).display;
    if (display !== 'flex' && display !== 'inline-flex') continue;
    if (el.children.length > 1 || (el.textContent ?? '').trim().length > nameLength) {
      row = el;
      break;
    }
  }
  if (!row) return null;

  const body = bodyParts(root).map((part) => part.el);
  for (let el: Element | null = row.parentElement; el && el !== root; el = el.parentElement) {
    if (el.children.length > 1) break;
    if (body.some((block) => el.contains(block))) break;
    if (getComputedStyle(el).display === 'flex') row = el;
  }
  return row;
}

/** How far the buttons must stay clear of the post's right-hand end.
 *
 *  Quora floats its own dismiss control over that corner — measured on a question page's
 *  answer: the byline row ends at x=845 and the control's box runs 814–852, on the author's
 *  name line. A button placed at the row's end therefore lands underneath it, which is what
 *  this insets past, putting ours to its left instead.
 *
 *  The control is found by where it sits — a textless control at the row's right-hand end and
 *  on the name's line — rather than by its label (`Cacher`, `Hide`, and everything else Quora
 *  translates) or its hashed classes. A post without one gets the full row. */
function cornerInset(root: Element, row: Element): number {
  const rowRect = row.getBoundingClientRect();
  for (const el of Array.from(root.querySelectorAll('button, [role="button"]'))) {
    if (el.closest('.mf-btn-container')) continue;
    if ((el.textContent ?? '').trim().length > 2) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.width > 48) continue;
    if (rect.top - rowRect.top > 20) continue;
    if (rowRect.right - rect.right > 24) continue;
    return Math.max(0, Math.round(rowRect.right - rect.left) + CORNER_GAP);
  }
  return 0;
}

/* ── Ids ───────────────────────────────────────────────────────────────────────── */

/** The id a root stands for, or null when it is not a post this adapter integrates.
 *
 *  Two refusals, both the same refusal at heart — an id is only ever handed out for content
 *  the extension can classify and point at:
 *
 *  - a root with **no author link**: the classified context is required to carry the
 *    username, so a post whose byline is missing is not one we can classify;
 *  - a root that names **nothing** — no answer, no comment, no story.
 *
 *  A post that fails either is not announced, not captured, and not treated as a native post
 *  by the selection rule. A CLIPPED root is deliberately not on this list: the reader can see
 *  it, so it is integrated like any other post, with its whole text read back before capture
 *  (see `revealClipped`). */
function idOf(root: Element): string | null {
  const comment = commentIdOf(root);
  const id = comment
    ? namespaced(`c:${comment}`)
    : (answerIdIn(root) ?? storyIdIn(root) ?? shareAnswerIdOf(root));
  return id && authorLinkOf(root) ? id : null;
}

/** The id a share URL gives the focal answer, when `root` is that answer's root.
 *
 *  The one surface with no `/answer/` link to read an id from (see `queryAnswerId`), so the
 *  URL stands in — and only for the root `permalinkAnswerRoot` measured, so nothing else on
 *  the page can borrow the answer's name. */
function shareAnswerIdOf(root: Element): string | null {
  const id = queryAnswerId();
  return id && permalinkAnswerRoot() === root ? id : null;
}

/** The post a permalink points at, or null when this URL is not one post: an answer
 *  permalink and a comment permalink are, and a question page, a profile and the feed are
 *  not. */
function postIdFromPath(url: URL): string | null {
  const comment = COMMENT_ID.exec(url.search);
  if (comment) return namespaced(`c:${comment[1]}`);
  const answer = answerPath(url.pathname);
  return answer ? namespaced(`a:${answer}`) : null;
}

/** The post a comment belongs to: the answer it is under. Off a comment's own page that is
 *  the answer root it is rendered inside; on one it is the answer the page is about. Its own
 *  id is the last resort, so a comment always carries the thread it was written in.
 *
 *  The feed is the surface with neither: its answers are cards reached from the action bar
 *  they own, not answer items, and the page URL is the feed rather than any answer. Measured
 *  2026-10-26: a story's comments were captured with no parent at all — `replyingTo` null, so
 *  the chain the hash is built from was empty and the classifier judged each comment with no
 *  idea what question it answered. The card is found the same way its root is (`cardOf`), from
 *  the one bar the comment's own ancestors hold. */
function conversationIdOf(root: Element, id: string): string {
  const answer = root.closest(ANSWER_ITEM);
  if (answer) return idOf(answer) ?? id;
  const page = pageAnswerId() ?? queryAnswerId();
  if (page) return page;
  for (let el: Element | null = root.parentElement; el && el !== document.body; el = el.parentElement) {
    const bars = el.querySelectorAll(PERMALINK_BAR);
    if (bars.length === 0) continue;
    if (bars.length > 1) break;
    const card = cardOf(bars[0]);
    if (card && card.contains(root)) return idOf(card) ?? id;
    break;
  }
  return id;
}

/** The comment a reply answers, as a namespaced id, or null for a top-level one.
 *
 *  Quora renders a thread as a flat list and shows depth as indentation, so ancestry names no
 *  parent — measured, both comments of a two-comment thread are direct siblings in the same
 *  panel (x=395 and x=439 in a 610px column). The parent is therefore the nearest PRECEDING
 *  comment in the same panel that sits further left: a reply is indented past what it
 *  answers, so the last comment above it with a smaller left edge is its parent at any depth.
 *  Comparing edges rather than offsets keeps that true across widths and zoom.
 *
 *  Null when nothing precedes it the thread panel can reach — a top-level comment, or the
 *  first one — and `capture` then falls back to the answer, exactly as Reddit's does to the
 *  submission, so the thread context is never empty. */
function replyParentIdOf(root: Element): string | null {
  let panel: Element | null = null;
  for (let el = root.parentElement; el && el !== document.body; el = el.parentElement) {
    if (el.querySelectorAll(COMMENT_LINK).length > 1) {
      panel = el;
      break;
    }
  }
  if (!panel) return null;

  const left = root.getBoundingClientRect().left;
  let parent: Element | null = null;
  for (const link of Array.from(panel.querySelectorAll(COMMENT_LINK))) {
    const other = commentRootOf(link);
    if (!other) continue;
    if (other === root) break;
    if (other.getBoundingClientRect().left < left) parent = other;
  }
  const id = parent ? commentIdOf(parent) : null;
  return id ? namespaced(`c:${id}`) : null;
}

function postRoots(id: string): Element[] {
  const out: Element[] = [];
  const bare = id.startsWith(ID_PREFIX) ? id.slice(ID_PREFIX.length) : id;

  if (/^a:/.test(bare)) {
    for (const root of answerRoots()) if (idOf(root) === id) out.push(root);
    return out;
  }
  if (/^c:\d+$/.test(bare)) {
    for (const root of commentRoots()) if (idOf(root) === id) out.push(root);
    return out;
  }
  if (/^s:/.test(bare)) {
    for (const story of Array.from(document.querySelectorAll(FEED_STORY))) {
      if (idOf(story) === id) out.push(story);
    }
    return out;
  }
  return out;
}

/* ── Capture ───────────────────────────────────────────────────────────────────── */

/** Quora shows no verification badge anywhere in its markup. An answer's byline is an avatar,
 *  the name, a `Suivre` button and a credential line — "Précédent lieu : Ubugrad,
 *  Karpatska-Livonia" and the like — and a credential is a self-reported line of biography,
 *  not a platform-attested status. So every account is `Regular` rather than inferred from
 *  the one mark that exists. */
const QUORA_USERTYPE: Usertype = UsertypeEnum.Regular;

export const quoraAdapter: PlatformAdapter = {
  // `quora.com` serves the app from a locale subdomain per reader (`fr.quora.com` and the
  // rest), and the apex redirects to `www.`, so the suffix rule is the right form here: an
  // enumerated list would have to name every locale Quora might serve.
  id: 'quora',
  hosts: PLATFORM_HOSTS.quora ?? [],

  postIdFromUrl: postIdFromPath,

  postRoots,

  postIdOf(root) {
    return idOf(root);
  },

  textElement(root) {
    // What the root itself holds: a question page's heading belongs to the page rather than to
    // any one answer under it (see `questionParts`), and this names the element the gate and
    // the highlighter measure a side against.
    const parts = bodyParts(root).filter((part) => root.contains(part.el));
    if (parts.length === 0) return null;
    // The longest block, which is the one a single anchor should point at when the body is
    // spread across several. `textRegions` below carries the whole picture.
    let best = parts[0];
    for (const part of parts) if (part.text.length > best.text.length) best = part;
    return best.el;
  },

  textRegions(root): TextRegion[] | null {
    const parts = bodyParts(root);
    if (parts.length < 2) return null;
    // Offsets walk the joined text the caller classifies, one block at a time, so each block
    // is painted with the slice of the classification that was measured over it.
    const regions: TextRegion[] = [];
    let at = 0;
    for (const part of parts) {
      // A part the root does not hold keeps its place in the walk but gets no span to paint.
      // On a question page the heading above the answers is one element every answer under it
      // is classified with, and a wrap from one answer's claims would be stripped by another
      // answer's Hide — the empty span paints nothing (see `sliceSegmentsToRegion`).
      regions.push(root.contains(part.el)
        ? { el: part.el, start: at, end: at + part.text.length }
        : { el: part.el, start: at, end: at });
      at += part.text.length + BLOCK_JOIN.length;
    }
    return regions;
  },

  // An answer's body is rich text — `<p>` per paragraph, links, images, bold and italics —
  // and a comment's is at least one paragraph of it. Rebuilding either from the classified
  // string would flatten all of that into one paragraph, so highlights go over the page's own
  // text nodes.
  highlightInPlace: true,

  placeButtons(container, root) {
    // Inline at the right-hand end of the header bar, the same place they take on Bluesky,
    // Reddit and Substack. The bar is the byline row on every surface here; `headerRowOf`
    // finds it structurally, so none of this depends on a class Quora hashes.
    const host = headerRowOf(root);
    if (host) {
      // `marginLeft: auto` is what pushes the buttons to the right end of the row when the
      // row is a flex container — which every one of these is — and does nothing when it is
      // not, so a layout change degrades to "the buttons are in the header". The byline
      // column loses their width, which can wrap a long credential line; the alternative is
      // no buttons at all, and every other platform's pill takes header width too.
      container.style.marginLeft = 'auto';
      // The name's own line, not the middle of the byline block: Quora's byline is two lines
      // (name, then the credential), and centering across both drops the buttons between them
      // — under the platform's dismiss control, which sits on the name's line. Aligned to the
      // top, they read as part of the byline the username is on.
      container.style.alignSelf = 'flex-start';
      container.style.flexShrink = '0';
      const inset = cornerInset(root, host);
      if (inset) container.style.marginRight = `${inset}px`;
      host.appendChild(container);
      return;
    }
    // No header row: leave the container detached rather than prepending it to the post. A
    // post carrying our buttons is one the selection rule hands the user's selection off to,
    // so a pill dropped at the top of the post instead of in its header would also cost the
    // user the web-select path on that post. Detached, the post keeps working: it simply has
    // no buttons. See `placeButtons` in types.ts.
  },

  feedCenter() {
    // The measure is the content column, not the viewport: Quora lays the feed and a
    // question's answers in a column beside its own navigation, and on a wide window that
    // column and the window's center do not agree. The first post's own box is that column's
    // inner width, which is what the floating buttons should sit over.
    const firstBar = document.querySelector(PERMALINK_BAR);
    const column =
      document.querySelector(ANSWER_ITEM) ??
      permalinkAnswerRoot() ??
      (firstBar ? cardOf(firstBar) : null) ??
      document.querySelector(FEED_STORY) ??
      commentRoots()[0] ??
      document.querySelector(CONTENT_COLUMN);
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
    // Innermost first: a selection inside a comment belongs to the comment, not to the answer
    // whose card holds it. Every branch goes through `idOf`, so a comment inside an answer's
    // card is a post of its own and the answer around it is not mistaken for it.
    const comment = commentRootOfElement(el);
    if (comment && idOf(comment)) return comment;
    const answer = el.closest(ANSWER_ITEM);
    if (answer && idOf(answer)) return answer;
    const focal = permalinkAnswerRoot();
    if (focal && focal.contains(el) && idOf(focal)) return focal;
    const story = el.closest(FEED_STORY);
    if (story && idOf(story)) return story;
    // A list surface's answer — a topic page's, a search result's — has no answer item to name
    // it, so it is reached the way its root was: from the action bar it owns. The first
    // ancestor holding one decides it, and holding exactly one keeps a selection that lands
    // between two cards from claiming the list around them.
    for (let q: Element | null = el; q && q !== document.body; q = q.parentElement) {
      const bar = q.querySelector(PERMALINK_BAR);
      if (!bar) continue;
      const card = q.querySelectorAll(PERMALINK_BAR).length === 1 ? cardOf(bar) : null;
      if (card && card.contains(el) && idOf(card)) return card;
      break;
    }
    return null;
  },

  captureRoots() {
    return [...answerRoots(), ...Array.from(document.querySelectorAll(FEED_STORY)), ...commentRoots()];
  },

  /** Whether Quora is holding this root's body back behind its own "(more)".
   *
   *  Quora is the one platform where the clamp is a CUT rather than a hidden box: clicking
   *  "(more)" grew an answer's body from 308 to 545 characters, and from 424 to 1667 on a feed
   *  card, and the text it reveals is in no response the page makes. So a clipped root here is
   *  one `capture` cannot name at all (see its guard), and one the painter leaves alone: the
   *  words past the cut are not in the page, so there is nothing to paint them onto until
   *  someone opens it. Quora's own "(more)" is the only way in, and pressing it is what
   *  `revealClipped` does — this hook is what tells the sweep which roots still need it. */
  bodyClipped(root) {
    return expanderOf(root) !== null;
  },

  /** Every answer is long-form, unconditionally — the one post type that is almost always
   *  long, so it is not measured at all.
   *
   *  Measured while building the clamp hook: Quora's "(more)" hid the rest of a 545-character
   *  answer at 308 characters, and of a 1667-character one at 424. The shortest answer the
   *  host itself chose to clip is 545 characters, so any threshold here would only ever
   *  decide which answers are short, and those would be answers whose buttons nobody wants:
   *  a reader fact-checking one selects a passage anyway. So an answer root keeps the smart
   *  selection and carries the buttons whether or not it is clamped, on a question page —
   *  where Quora clamps nothing — exactly as on the feed, where it clamps every story.
   *
   *  Comments are never long-form: they are the short shape by nature, they keep their
   *  buttons, and the answer they answer stays their ancestor either way. */
  isLongForm(root) {
    return commentIdOf(root) === null;
  },

  // Quora is the one platform where the clamp has to be driven rather than read around. Its
  // "(more)" does not reveal text the DOM was already holding — measured, clicking it grew an
  // answer's body from 308 to 545 characters, and from 424 to 1667 on a feed card — and the
  // text it reveals is in no response the page makes. That is why this hook exists and why it
  // clicks: the alternative is hashing a prefix, which names no post at all.
  //
  // The reader is left to press their own "(more)" in the two ways it matters: a root under the
  // pointer is skipped by the sweep before it ever gets here, and a root's own attempts are
  // bounded, so a card that opens on the reader's press is captured by an ordinary later sweep
  // whether or not we were the one who opened it.
  async revealClipped(root, opts) {
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
        const before = bodyText(root).length;
        (more as HTMLElement).click();
        // The affordance disappears when the body opens (measured), so that is the signal; the
        // text growing is the fallback for the day Quora leaves it behind as "less".
        for (let i = 0; i < EXPAND_POLLS; i++) {
          await new Promise((resolve) => setTimeout(resolve, EXPAND_POLL_MS));
          if (!root.isConnected) return;
          if (!expanderOf(root) || bodyText(root).length > before) return;
        }
        console.warn('[misinfo] quora: a clipped post would not expand; it stays out of this batch');
      })
      .catch((e) => {
        console.error('[misinfo] quora: expanding a clipped post failed', e);
      });
    return expanding;
  },

  capture(root: Element): CapturedPost | null {
    const id = idOf(root);
    if (!id) return null;

    // Still clamped, so this post has no text to be named by. Left for a later sweep — where
    // `revealClipped` has already spent its tries — rather than filed under the prefix the
    // page is showing, which is the one thing that must never identify a post.
    if (expanderOf(root)) return null;

    const text = bodyText(root);
    // An answer can be a picture with no words and a comment can be deleted with its shell
    // left behind. Neither carries anything to fact-check, so they stay out of the batch
    // rather than spending a classification on an empty string.
    if (!text) return null;

    const commentId = commentIdOf(root);
    // When this post was written, to the precision the page states it in.
    const datetime = isoDatetimeFromAge(root.querySelector(TIMESTAMP)?.textContent);
    const post = {
      id,
      text,
      // The DOM is the only source here, so the rendered text IS the raw text. X separates
      // these because its payload carries both a note_tweet expansion and a legacy body;
      // markup read off the page has no such split.
      fullText: text,
      username: authorOf(root),
      usertype: QUORA_USERTYPE,
      // The answer is the thread a comment belongs to, and an answer or a story is its own.
      conversationId: commentId ? conversationIdOf(root, id) : id,
      quoting: null,
      replyingTo: null,
      // The post's own age, as a floor (see the datetime note at the top). Read off this root
      // rather than the page: an answer's label sits inside the answer and a comment's inside
      // the comment, and neither can answer for the other.
      ...(datetime ? { datetime } : {}),
    } as MainTweet;

    // Language deliberately left unset. Quora carries no per-post language markup at all —
    // only `<html lang>`, which on `fr.quora.com` is the reader's UI language while the
    // answers on the same page run from French to English — so naming it would file an
    // answer's ranges under a language it is not written in. `nameCapturedLanguage` puts
    // those under the shared unknown key, which is stable rather than wrong.
    return {
      post,
      replyParentId: commentId ? (replyParentIdOf(root) ?? conversationIdOf(root, id)) : null,
    };
  },
};
