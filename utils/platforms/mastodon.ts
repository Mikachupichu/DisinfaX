/** The Mastodon adapter.
 *
 *  Mastodon is the platform Truth Social's web client is a fork of, and it is the one
 *  platform here whose hosts cannot be enumerated: every instance is its own third-party
 *  domain. This adapter therefore claims exactly one — `mastodon.social`, the default
 *  instance, listed in `PLATFORM_HOSTS.mastodon` — and reaches every other instance through
 *  the runtime opt-in a reader grants it, which registers the same content scripts on that
 *  origin (see the seam in `main` of entrypoints/native.content.ts and
 *  utils/mastodonOptIn.ts). Everything below is about ONE instance's own markup, which
 *  every instance runs unchanged.
 *
 *  Where the fork is the same, this file reads it the way Truth Social's does. Mastodon gives
 *  less to key on: there are no `data-testid`s, so the anchors are the app's own class
 *  vocabulary (`status`, `status__content`, `status__info`, `detailed-status__*`) — the names
 *  its CSS and every instance's themes are written against, which is the closest thing this
 *  host has to a maintained name, and still a class name. They are used because there is
 *  nothing else, and every lookup below fails closed: no root found means no buttons, and the
 *  post stays fact-checkable as a plain web selection.
 *
 *  Two measured properties of the host decide the rest.
 *
 *  First, a post is one blob of markup whose parts are separable but whose edges are not
 *  stated. The id is on `data-id`, the permalink on the row's timestamp link (or, for a
 *  permalink's focal post, on its datetime link), and there is no conversation id and no
 *  `in_reply_to_id` anywhere in the markup. So a post's ancestry comes from the app's own API
 *  responses — `absorbThreadEdges` below, the only network hook this adapter has.
 *
 *  Second, the text is markup: a `<p>` per paragraph, with links, mentions and custom emoji
 *  inside it. It is read from the DOM and painted in place, like every platform after X that
 *  renders rich text.
 *
 *  The API is NOT used for posts, and that is a decision rather than an omission. Its
 *  `content` is HTML from which the renderer MOVES a trailing hashtag-only line into a bar of
 *  its own (measured in the app's `getHashtagBarForStatus`), its `language` is a guess the DOM
 *  states better (the `lang` the host put on the text), and it carries no verification signal
 *  at all. A post read from the payload and the same post read from the page would therefore
 *  be two different strings under one id. The payload's one irreplaceable fact is the
 *  ancestor chain, and that is all this adapter takes from it.
 */
import type { MainTweet, QuotedTweet, Usertype } from '../../data/Tweets';
import { Usertype as UsertypeEnum } from '../../data/Tweets';
import { passageTextContent, sealHostEvents } from '../injecting';
import { PLATFORM_HOSTS } from './hosts';
import { LONG_FORM_CHARS } from './types';
import type { CapturedPost, PlatformAdapter, TextRegion } from './types';

/** Namespaces this platform's ids. Mastodon's status ids are digit strings like X's and
 *  Truth Social's, and the background broadcasts a classification to every connected relay
 *  rather than keying by tab, so a bare one could otherwise land in an unrelated timeline. */
const ID_PREFIX = 'mastodon:';

/** A permalink is `/@handle/<digits>`; `/@handle` alone is the profile, so the digits are what
 *  separate the two. The handle may be a remote `user@host`. */
const CANONICAL_PATH_RE = /^\/@[^/]+\/(\d+)$/;

/** The same post under the app's other routes: `/web/statuses/<id>` is what an instance's own
 *  "open in web" links use, `/statuses/<id>` is where the app itself rewrites that address
 *  (measured — navigating to `/web/statuses/<id>` lands on `/statuses/<id>`), and
 *  `/users/<name>/statuses/<id>` is the ActivityPub-shaped one. All three render the permalink
 *  view, and the version segment is optional because which of them a given instance serves as
 *  its canonical address varies. */
const WEB_PATH_RE = /^\/(?:web\/)?statuses\/(\d+)/;
const USERS_PATH_RE = /^\/users\/[^/]+\/statuses\/(\d+)/;

/** The app's own class vocabulary. */
const STATUS_SELECTOR = '.status[data-id]';
const QUOTE_CARD_SELECTOR = '.status--is-quote[data-id]';
const DETAIL_SELECTOR = '.detailed-status__wrapper';
const INFO_SELECTOR = '.status__info';
const RELATIVE_TIME_SELECTOR = '.status__relative-time';
const NAME_SELECTOR = '.status__display-name';
const DETAIL_NAME_SELECTOR = '.detailed-status__display-name';
const DETAIL_DATETIME_SELECTOR = '.detailed-status__datetime';
const CONTENT_SELECTOR = '.status__content';
const TEXT_SELECTOR = '.status__content__text';
const WARNING_SELECTOR = '.content-warning';
const FILTER_WARNING_SELECTOR = '.content-warning--filter';
const QUOTE_SELECTOR = '.status__quote';

/** The host's own translation controls. The bar exists only while a translation is on
 *  screen; the idle button is what replaces it once the reader is back on the source. The
 *  `translate` class on the text element is NOT a signal for either state — measured, every
 *  rendered body carries it, translated or not, because the app hard-codes the string
 *  (Mastodon's `legacy/content.jsx`). */
const TRANSLATE_BAR_SELECTOR = '.translate-button';
const TRANSLATE_IDLE_SELECTOR = '.status__content__translate-button';

/** Paragraphs of one post are joined with a blank line, the same join Reddit, Quora and
 *  Hacker News use, so the worker reads them as separate paragraphs rather than as one run of
 *  words. `textRegions` is what keeps that join from reaching the page: the separator is
 *  written into no element. */
const POST_JOIN = '\n\n';

/** The character count past which a Mastodon post stops being something the reader takes in
 *  at a glance.
 *
 *  Mastodon DOES clamp a long body, but in PIXELS rather than characters: its own
 *  `legacy/content.jsx` collapses a status at `MAX_HEIGHT = 706` (22px × 32 lines, plus the
 *  2px of top padding) and the deployed CSS gives the collapsed class `max-height: 330px`.
 *  So unlike Reddit's six-line clamp or Facebook's "(more)" there is no character number to
 *  read the threshold off, and what a column actually cuts on is a band rather than a point:
 *  measured on mastodon.social's 600px column, the longest body left whole ran 1058
 *  characters and the shortest one collapsed ran 1998 — a wider window or a different font
 *  size moves both ends.
 *
 *  There is no number to read off this host at all, and no per-platform number any more: this
 *  is a host that clamps in PIXELS rather than characters, so the integration falls back to the
 *  universal `LONG_FORM_CHARS`. Applied on every surface, whether or not the host clamps that
 *  particular render — the same post is whole on a permalink and short in a column, and the
 *  answer must not depend on which one is on screen.
 *
 *  REPLIES ARE EXEMPT, and that is measured rather than stylistic: a reply is this platform's
 *  comment, comments are the shape always kept short enough for buttons, and the test is the
 *  payload's own `in_reply_to_id` — see `isLongForm`. */

/** How many reply edges to remember. One thread view states a whole chain (the measured focal
 *  status carried 1 ancestor and 7 descendants) and a feed scroll keeps arriving, so this is
 *  Facebook's comment-parent size rather than a handful. */
const MAX_REMEMBERED_PARENTS = 2048;

/** How many times to drive one of the host's own controls before giving up on a post, and how
 *  long to wait for the re-render it asks for. The host's state update is a React render,
 *  which lands in the same frame or the next. */
const MAX_REVEAL_ATTEMPTS = 3;
const REVEAL_POLLS = 20;
const REVEAL_POLL_MS = 25;

const MASTODON_REGULAR: Usertype = UsertypeEnum.Regular;

/** The post each post answers, keyed by the namespaced id of the CHILD — remembered across
 *  the two halves of a capture, because only the payload half can see a thread's structure and
 *  the DOM half is what files the post. A reply is read here for two things: its
 *  `replyParentId`, and whether it is a reply at all (see `isLongForm`).
 *
 *  Filled by `absorbThreadEdges`, which the coordinator also uses to correct a post it had
 *  already captured when the payload describing it arrived. On this platform that correction
 *  is a safety net rather than the mechanism: measured on a cold permalink load,
 *  `/api/v1/statuses/<id>/context` lands about a second BEFORE the first row renders, so the
 *  edges are in hand before anything can be captured. */
const threadParents = new Map<string, string>();

/** The source of a post the host is showing a translation of, and the language that source is
 *  in. Remembered because `capture` runs after the host has been put back the way the reader
 *  had it: the flip reads the source, these keep it, and the page is left showing the
 *  translation. Capped the way Telegram's is, for the same reason — the reader may flip a post
 *  back and forth any number of times. */
const sourceBodies = new Map<string, string>();
const sourceLanguages = new Map<string, string>();
const MAX_REMEMBERED_SOURCES = 256;

/** Attempts per post per control, so a control the host is refusing to accept is not clicked
 *  at forever. */
const revealAttempts = new Map<string, number>();
const sourceAttempts = new Map<string, number>();

/** One host-driven interaction at a time for the whole page. Every flip this adapter makes —
 *  opening a warned body, switching a body's language — replaces the body it acts on and
 *  waits for the re-render, and two in flight at once is a race the reader would see. One
 *  chain rather than one per kind, because the two kinds act on the same posts. */
let hostInteraction: Promise<void> = Promise.resolve();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run one host interaction after whatever is already in flight. */
function queueHostInteraction(run: () => Promise<void>): Promise<void> {
  hostInteraction = hostInteraction.then(run).catch(() => {});
  return hostInteraction;
}

function isElement(node: unknown): node is Element {
  return node instanceof Element;
}

/** Whether this element is one of the two shapes a post root takes: a row in a list, or the
 *  focal post of a permalink. Both are addressed the same way everywhere else in this file. */
function isPostRoot(el: Element): boolean {
  return el.matches(STATUS_SELECTOR) || el.matches(DETAIL_SELECTOR);
}

/** The nearest post root containing `node`, itself included. */
function rootOf(node: Node | null): Element | null {
  let el = isElement(node) ? node : node?.parentElement ?? null;
  while (el) {
    if (isPostRoot(el)) return el;
    el = el.parentElement;
  }
  return null;
}

/** The first element matching `selector` that belongs to `root` rather than to a post nested
 *  inside it. A post's markup contains any post it quotes, and the two must never be confused:
 *  everything below reads through this, so a quote's body is never read as its carrier's. */
function ownWithin(root: Element, selector: string): Element | null {
  for (const el of Array.from(root.querySelectorAll(selector))) {
    if (rootOf(el) === root) return el;
  }
  return null;
}

/** The post's own content block, or null when the host is not rendering one. */
function ownContent(root: Element): Element | null {
  return ownWithin(root, CONTENT_SELECTOR);
}

/** The element the host put the post's own language on. */
function textContainer(root: Element): Element | null {
  return ownWithin(root, TEXT_SELECTOR);
}

/** The host's own statement that it is holding this post's body back, on the two warnings that
 *  hold one: the content warning and the reader's own keyword filter. */
function warningElement(root: Element): Element | null {
  return ownWithin(root, WARNING_SELECTOR);
}

/** The post's paragraphs — the blocks `postText` joins and `textRegions` maps back onto the
 *  page. The host renders the server's HTML, which wraps each paragraph in its own `<p>`, so
 *  this is usually several elements; a body that renders as one run of text falls back to the
 *  text container itself so the post is still read whole. */
function bodyBlocks(root: Element): Element[] {
  const container = textContainer(root);
  if (!container) return [];
  const paragraphs = Array.from(container.querySelectorAll(':scope > p'));
  if (paragraphs.length > 0) return paragraphs;
  return passageTextContent(container as HTMLElement).trim() ? [container] : [];
}

function blockText(block: Element): string {
  return passageTextContent(block as HTMLElement).trim();
}

/** A post's words as the reader sees them: its paragraphs, in order, joined by a blank line.
 *
 *  Read from the markup rather than from the payload, for the reason this file's header gives
 *  — the renderer moves a trailing hashtag-only line out of the body into a bar of its own, so
 *  the payload's string and the page's string differ for the same post, and a claim measured
 *  against one and painted over the other lands on words it never named.
 *
 *  That bar (`.hashtag-bar`) is a sibling of this content and is deliberately NOT read. It is
 *  not a copy of what the body says: measured, it renders its tags run together with no
 *  separator and truncates the list behind a localized counter — one read verbatim as
 *  `#Existentialism#AI#efficiency…and 9 more`. Reading it would therefore hash and classify
 *  words the author never wrote, in the READER's language rather than the post's, and would
 *  count tags the body may not contain at all. Hashtags written inline in the prose stay in
 *  the body and are read with it. */
function postText(root: Element): string {
  return bodyBlocks(root)
    .map(blockText)
    .filter(Boolean)
    .join(POST_JOIN);
}

/** `postText` as ranges into it. Must stay EXACTLY the concatenation of the slices: the
 *  highlight layer rewrites each region with the segments cut out of this string, so a
 *  character here that belongs to no region is a character written into an element that never
 *  held it. */
function postRegions(root: Element): TextRegion[] {
  const regions: TextRegion[] = [];
  let at = 0;
  for (const block of bodyBlocks(root)) {
    const text = blockText(block);
    if (!text) continue;
    regions.push({ el: block, start: at, end: at + text.length });
    at += text.length + POST_JOIN.length;
  }
  return regions;
}

/** The id the markup states for an element, whatever post that element turns out to be. A row
 *  carries it on `data-id`; the permalink's focal post carries it only in the datetime link it
 *  renders, in its canonical `/@handle/<digits>` form. */
function statedId(el: Element): string | null {
  const own = el.getAttribute('data-id');
  if (own && /^\d+$/.test(own)) return own;
  // Both links are read through `ownWithin`, and that is the whole point of this line: a
  // permalink's focal post renders any post it quotes inside itself, and the quoted post's own
  // timestamp link comes FIRST in document order — measured on a quote permalink, the two
  // matches in order are the card's `/@GeoWire/117369224288435055` and then the carrier's own
  // `.detailed-status__datetime`. Taking whichever the browser listed first captured the
  // carrier under the QUOTED post's id, which is a post this file never addresses (a quote
  // card is not a root) — so that id named the quoted post on one surface and the carrier on
  // another, and the two would share a cache entry, a chain and a hash key.
  const link =
    ownWithin(el, `${DETAIL_DATETIME_SELECTOR}[href]`) ?? ownWithin(el, `${RELATIVE_TIME_SELECTOR}[href]`);
  const href = link?.getAttribute('href') ?? '';
  const match = href.match(CANONICAL_PATH_RE);
  return match ? match[1] : null;
}

/** The post this element IS, or null when it is a post rendered inside another one.
 *
 *  A quote card is a real status with a real id — it is the post being quoted — but it is not
 *  a post this extension addresses: it renders no action bar, so it has no header of its own
 *  for our buttons to land in, and classifying it would spend a classification on a post whose
 *  result has nowhere to go. Its words stay out of the quoting post's body for the same
 *  reason they are read separately there: they belong to the quoted post — and they are
 *  carried as that post, in `quoting`. */
function postIdOfElement(root: Element): string | null {
  if (root.matches(QUOTE_CARD_SELECTOR)) return null;
  const raw = statedId(root);
  return raw ? ID_PREFIX + raw : null;
}

/** The account a post is by, as the handle its byline links to — `user` for a local account,
 *  `user@host` for a remote one. Read from the byline anchor rather than from the display
 *  name's words, because it is the same string the permalink is built from: two surfaces
 *  showing one post then state one author. */
function handleOf(root: Element): string {
  const link = ownWithin(root, NAME_SELECTOR) ?? ownWithin(root, DETAIL_NAME_SELECTOR);
  const href = link?.getAttribute('href') ?? '';
  return href.startsWith('/@') ? (href.slice(2).split('/')[0] ?? '') : '';
}

/** Whether the host is holding this post's body back behind one of its own controls.
 *
 *  This is NOT a CSS clamp. On a post the host has gated — a content warning, or the reader's
 *  own keyword filter — it renders no `.status__content` at all until asked, so the words are
 *  nowhere in the DOM and there is nothing to hash. Measured, the host's control is a clean
 *  toggle: one click renders the body, the next takes it away again.
 *
 *  A FILTERED post is not ours to open: the reader's own filter setting is what put the
 *  warning there, and clicking through it would undo a choice they made about their own
 *  reading — so it is left alone, and the post stays uncaptured until the reader opens it
 *  themselves.
 *
 *  Cheap by construction — two queries and an ancestor walk, no text read — because it is
 *  asked for every root on every sweep. */
function bodyClipped(root: Element): boolean {
  const warning = warningElement(root);
  if (!warning || warning.matches(FILTER_WARNING_SELECTOR)) return false;
  return ownContent(root) === null;
}

/** The host's own control for opening a warned body: the button inside the warning. */
function warningButton(root: Element): HTMLElement | null {
  const button = warningElement(root)?.querySelector('button');
  return button instanceof HTMLElement ? button : null;
}

/** The host's own control for switching a post between its translation and its source: the
 *  "Show original" button inside the translation's bar while a translation is on screen, and
 *  the "Translate" button once the reader is back on the source. */
function translateControl(root: Element): HTMLElement | null {
  const bar = ownWithin(root, TRANSLATE_BAR_SELECTOR);
  if (bar) {
    const button = bar.querySelector('button');
    return button instanceof HTMLElement ? button : null;
  }
  const idle = ownWithin(root, TRANSLATE_IDLE_SELECTOR);
  return idle instanceof HTMLElement ? idle : null;
}

/** Read the source side of a post the host is showing a translation of, remember it, and put
 *  the post back on the translation.
 *
 *  The source's own language is read on the way through, while the source is the side on
 *  screen and the `lang` attribute therefore belongs to it. Assumes it is already inside the
 *  host-interaction queue; both the hook that owns the flip and the warning gate use it. */
async function readSourceSide(root: Element, id: string): Promise<void> {
  if (sourceBodies.has(id)) return;
  if (!shownTranslationLocale(root)) return;
  const before = postText(root);
  const control = translateControl(root);
  if (!control) return;
  control.click();
  for (let i = 0; i < REVEAL_POLLS; i++) {
    await sleep(REVEAL_POLL_MS);
    const now = postText(root);
    if (now && now !== before) {
      sourceBodies.set(id, now);
      const language = textContainer(root)?.getAttribute('lang');
      if (language) sourceLanguages.set(id, language);
      break;
    }
  }
  while (sourceBodies.size > MAX_REMEMBERED_SOURCES) {
    const oldest = sourceBodies.keys().next().value;
    if (oldest === undefined) break;
    sourceBodies.delete(oldest);
    sourceLanguages.delete(oldest);
  }
  // Back the way the reader had it, whether or not the source was read: leaving the post
  // flipped would be a change to the page this has no business making.
  if (!shownTranslationLocale(root)) translateControl(root)?.click();
}

/** The language of the translation a post is showing, or null when it is showing its own
 *  words.
 *
 *  The marker is the host's own translation bar, which renders only while a translation is on
 *  screen. The locale is the `lang` on the text, which the host switches to the translation's
 *  language when it shows one (`status.getIn(['translation','language']) || status.get('language')`).
 *
 *  NOT VERIFIED SIGNED OUT. The host renders this control only for a signed-in reader, so
 *  this half is written from the app's source and its measured absence rather than from a live
 *  flip: signed out the bar is on no post, this returns null everywhere, and nothing that
 *  depends on it ever runs. */
function shownTranslationLocale(root: Element): string | null {
  if (!ownWithin(root, TRANSLATE_BAR_SELECTOR)) return null;
  return textContainer(root)?.getAttribute('lang') || null;
}

/** A post's body as the reader is reading it, for the one path that reports a flip the reader
 *  made themselves. See `displayedText` in types.ts. */
function shownBody(root: Element): string | null {
  return postText(root) || null;
}

/** The post this root is showing a quote of, or null. The quote is a full status card in a box
 *  of its own, a SIBLING of the carrier's content rather than a part of it, so the carrier's
 *  own text is never polluted by it — and the card is not captured as a post, for the reason
 *  `postIdOfElement` gives. Its id, author and words are carried here instead: a post that
 *  quotes another is classified in the context of what it quotes, and its hash covers it. */
function quotedPost(root: Element): QuotedTweet | null {
  const card = ownWithin(root, QUOTE_SELECTOR)?.querySelector(STATUS_SELECTOR) ?? null;
  if (!card) return null;
  const raw = statedId(card);
  if (!raw) return null;
  const text = postText(card);
  if (!text) return null;
  const id = ID_PREFIX + raw;
  return {
    id,
    text,
    fullText: text,
    username: handleOf(card),
    // Mastodon shows no verification badge on a post or on a quote card — an account's
    // verified links live on its profile, not in its byline — so there is no signal to read
    // here and none is invented.
    usertype: MASTODON_REGULAR,
    conversationId: id,
  };
}

/** Every post currently rendered, outermost only. A root nested inside another is a quote card
 *  (or a quote card inside one), and is addressed only through the post that carries it.
 *  Rendered-ness is filtered here, at the single point every consumer goes through, so
 *  capture, injection and centering cannot disagree about which posts exist: a row that is in
 *  the DOM but collapsed measures zero width, and a post missed mid-render is picked up by the
 *  next sweep, since rendering a post is itself a mutation. */
function allPostRoots(): Element[] {
  const out: Element[] = [];
  for (const el of Array.from(document.querySelectorAll(`${STATUS_SELECTOR}, ${DETAIL_SELECTOR}`))) {
    if (el.parentElement && rootOf(el.parentElement)) continue;
    if (el.getBoundingClientRect().width <= 0) continue;
    out.push(el);
  }
  return out;
}

/** The row our buttons go into: the header bar of a list row, the byline of the permalink's
 *  focal post. Both are flex rows that already hold the post's name. */
function headerRow(root: Element): Element | null {
  if (root.matches(DETAIL_SELECTOR)) return ownWithin(root, DETAIL_NAME_SELECTOR);
  return root.querySelector(`:scope > ${INFO_SELECTOR}`);
}

/** Sit the pill on the timestamp's words rather than in the middle of the row.
 *
 *  The host's timestamp is a 40px tap target whose globe and "1h" sit on its FIRST line, not
 *  in its middle — the anchor is a block box holding one line of text at the top — so a pill
 *  centred in the 46px row lands a visible 9px below the words it stands beside. (Measured on
 *  mastodon.social, signed out.)
 *
 *  The pill is therefore placed at the row's content top and carried down to the timestamp's
 *  line by the distance between the two, measured here rather than assumed: that distance is a
 *  tap-target height plus a line-height, and both are a theme's to change, so a constant would
 *  be right in one theme and wrong in the next. Idempotent — the margin is cleared before it is
 *  measured, so running again on an already-placed pill re-derives the same number. */
function alignToTrailingWords(container: HTMLElement, trailing: Element): void {
  container.style.alignSelf = 'flex-start';
  container.style.marginTop = '0px';
  const words = trailing.querySelector('time') ?? trailing;
  const wordBox = words.getBoundingClientRect();
  const ownBox = container.getBoundingClientRect();
  container.style.marginTop = `${Math.round(
    wordBox.top + wordBox.height / 2 - (ownBox.top + ownBox.height / 2),
  )}px`;
}

export const mastodonAdapter: PlatformAdapter = {
  id: 'mastodon',

  /** The one instance claimed without asking — the default, and the list's only entry that is
   *  a single host rather than a platform's whole surface. Every OTHER instance is a distinct
   *  third-party domain the reader grants at runtime; this list is what the coordinator reads
   *  to decide which hosts are already reachable, so an opt-in never has to be offered for a
   *  host that is statically matched. See utils/platforms/hosts.ts and utils/mastodonOptIn.ts. */
  hosts: PLATFORM_HOSTS.mastodon ?? [],

  postIdFromUrl(url: URL) {
    const canonical = url.pathname.match(CANONICAL_PATH_RE);
    if (canonical) return ID_PREFIX + canonical[1];
    const web = url.pathname.match(WEB_PATH_RE) ?? url.pathname.match(USERS_PATH_RE);
    return web ? ID_PREFIX + web[1] : null;
  },

  postRoots(id: string): Element[] {
    return allPostRoots().filter((root) => postIdOfElement(root) === id);
  },

  postIdOf(root: Element): string | null {
    return postIdOfElement(root);
  },

  /** The first block of the body. `textRegions` carries the whole of it, and a post whose body
   *  is one paragraph — the ordinary case — has exactly one region, which the highlight layer
   *  uses only when there is more than one; the single block therefore has to be reachable on
   *  its own, and this is it. */
  textElement(root: Element): Element | null {
    return bodyBlocks(root)[0] ?? null;
  },

  textRegions(root: Element): TextRegion[] {
    return postRegions(root);
  },

  /** The body is markup — paragraphs, links, mentions, custom emoji — so it is painted in
   *  place rather than rebuilt from the classified text, the same choice every platform after
   *  X that renders rich text makes. */
  highlightInPlace: true,

  placeButtons(container: HTMLElement, root: Element): void {
    const header = headerRow(root);
    if (!header) return;
    // Both header shapes are the host's own, and the permalink's byline is an anchor the
    // reader could otherwise be sent to: the click this pill is about to take must not become
    // a navigation. The same seal every host-anchored placement uses.
    sealHostEvents(container);
    container.style.marginLeft = 'auto';
    container.style.alignSelf = 'center';
    container.style.flexShrink = '0';
    // The row's timestamp link is the host's own trailing control, and ours goes immediately
    // to its left — the position this ask produced on every other platform here. The focal
    // post's byline holds no timestamp of its own, so its pill takes the end of the row.
    const trailing = root.matches(DETAIL_SELECTOR) ? null : ownWithin(root, RELATIVE_TIME_SELECTOR);
    if (trailing && trailing.parentElement === header) {
      header.insertBefore(container, trailing);
      alignToTrailingWords(container, trailing);
      return;
    }
    header.appendChild(container);
  },

  /** The host clamps a long body with `max-height` and keeps the whole string in the DOM, so a
   *  painted claim can be sitting in text the reader cannot see. Clearing the clamp is the
   *  whole of what this owes: the host's own "read more" button is left where it is, and
   *  nothing about the text changes. */
  unclip(textElement: Element): void {
    const content = textElement.closest(CONTENT_SELECTOR);
    if (!(content instanceof HTMLElement)) return;
    content.style.maxHeight = 'none';
    content.style.overflow = 'visible';
  },

  feedCenter(): number | null {
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

  isPostTarget(id: string): boolean {
    return allPostRoots().some((root) => postIdOfElement(root) === id);
  },

  /** A reply is this platform's comment, and comments always get buttons whatever their
   *  length — the shape this integration is for. Everything else is judged on the words the
   *  reader can see, at the platform's number.
   *
   *  Reply-ness is taken from the payload rather than from the markup because the markup does
   *  not state it on every surface: the same post is a `.status-reply` in its own thread and a
   *  bare permalink elsewhere, and the answer must not depend on which one is on screen. The
   *  payload's `in_reply_to_id` says it once, for the post itself. */
  isLongForm(root: Element): boolean {
    const id = postIdOfElement(root);
    if (!id) return false;
    if (threadParents.has(id)) return false;
    return postText(root).length >= LONG_FORM_CHARS;
  },

  postElementFor(node: Node): Element | null {
    return rootOf(node);
  },

  captureRoots(): Element[] {
    return allPostRoots();
  },

  bodyClipped(root: Element): boolean {
    return bodyClipped(root);
  },

  /** Open a gated post the reader has reached, so its whole body can be read and hashed.
   *
   *  The host renders no content element at all while the gate is shut, so the words are
   *  nowhere in the DOM and there is nothing to hash; its control is a toggle — measured, one
   *  click renders the body and the next takes it away again — and this leaves it open, which
   *  is what this hook's contract asks: there is nothing to put back, the reader is owed the
   *  text. It also has to stay open: everything downstream reads the body out of the page —
   *  the hash, the highlight ranges, the text anchor the buttons are placed against — so a
   *  gate shut again after the read would leave a classified post with no buttons on it at
   *  all (measured: the shared injector no-ops a post whose text anchor is missing).
   *
   *  If the post is ALSO showing a translation, the source is read through the host's own
   *  control first, while the gate is open. This hook runs after `revealSource`, and that one
   *  finds no control to drive when the gate is shut — the translation bar lives inside the
   *  body the gate was hiding.
   *
   *  Retried a bounded number of times: a gate the host is refusing to open is one nothing can
   *  hash, and is left for a later sweep rather than clicked at forever. */
  async revealClipped(root: Element, opts?: { onDemand?: boolean }): Promise<void> {
    const id = postIdOfElement(root);
    if (!id) return;
    if (!opts?.onDemand) {
      if ((revealAttempts.get(id) ?? 0) >= MAX_REVEAL_ATTEMPTS) return;
      revealAttempts.set(id, (revealAttempts.get(id) ?? 0) + 1);
    }
    return queueHostInteraction(async () => {
      if (!bodyClipped(root)) return;
      const open = warningButton(root);
      if (!open) return;
      open.click();
      for (let i = 0; i < REVEAL_POLLS; i++) {
        await sleep(REVEAL_POLL_MS);
        if (!bodyClipped(root)) break;
      }
      if (bodyClipped(root)) return;
      await readSourceSide(root, id);
    });
  },

  displayedTranslationLocale(root: Element): string | null {
    return shownTranslationLocale(root);
  },

  /** Put a post back on its own words, read them, and put the page back the way the reader
   *  had it.
   *
   *  The host replaces the body in place rather than keeping a second copy, so while a
   *  translation is showing the source is nowhere on the page — and a post identified by the
   *  hash of its source would otherwise be filed under the hash of its translation, one post
   *  under two ids. The flip is driven through the host's own control and undone before this
   *  returns, which is what `revealSource`'s contract asks: `capture` must see a page left
   *  exactly as it was.
   *
   *  NOT VERIFIED SIGNED OUT: the host renders its translate control only for a signed-in
   *  reader, so signed out this finds nothing and returns — the bar is on no post. */
  async revealSource(root: Element): Promise<void> {
    const id = postIdOfElement(root);
    if (!id) return;
    if (sourceBodies.has(id)) return;
    if ((sourceAttempts.get(id) ?? 0) >= MAX_REVEAL_ATTEMPTS) return;
    sourceAttempts.set(id, (sourceAttempts.get(id) ?? 0) + 1);
    return queueHostInteraction(() => readSourceSide(root, id));
  },

  displayedText(root: Element): string | null {
    return shownBody(root);
  },

  capture(root: Element): CapturedPost | null {
    const id = postIdOfElement(root);
    if (!id) return null;
    // A body the host is still holding back has no words to hash; `revealClipped` opens it and
    // a later sweep files it.
    if (bodyClipped(root)) return null;

    const shown = postText(root);
    const destination = shownTranslationLocale(root);
    // The remembered source wins whenever there is one: it is the post's identity, and reading
    // the side on screen in its place would undo the flip's work on the sweep where the host's
    // translation state happens to be mid-update.
    const remembered = sourceBodies.get(id);
    const text = remembered ?? shown;
    if (!text) return null;

    const language = remembered ? (sourceLanguages.get(id) ?? '') : (textContainer(root)?.getAttribute('lang') ?? '');
    const post = {
      id,
      text,
      fullText: text,
      username: handleOf(root),
      // Mastodon states verification nowhere in a post's markup — an account's verified links
      // live on its profile page, and the API's `Account` has no `verified` key either — so
      // there is no signal here and none is invented.
      usertype: MASTODON_REGULAR,
      // The platform has no conversation concept: a post's thread is its reply chain, which is
      // carried by `replyParentId` below rather than by a group id.
      conversationId: id,
      quoting: quotedPost(root),
      replyingTo: null,
      // The side on screen, carried beside the source the way Telegram's and LinkedIn's are:
      // the background has to know which of the two the reader is reading before it can
      // localize the highlight ranges into that language.
      translatedText: destination ? shown : undefined,
      destinationLanguage: destination ?? undefined,
      // Absent rather than guessed when the host states none, so the shared unknown-language
      // fallback keys the highlights instead of the reader's own UI locale.
      ...(language ? { sourceLanguage: language } : {}),
    } as MainTweet;

    return { post, replyParentId: threadParents.get(id) ?? null };
  },

  /** Take in the one thing the markup cannot say: which post each post answers.
   *
   *  Not a capture — an edge names no text, no author and no language, so nothing here is
   *  classified. The map it fills is what `capture` reads a reply's parent from, and what the
   *  coordinator uses to correct a post it filed before the payload describing it arrived (on
   *  this platform a safety net: the context response lands about a second before the first
   *  row renders, measured on a cold permalink load). */
  absorbThreadEdges(records: unknown[]): Map<string, string> {
    for (const value of records) {
      if (!value || typeof value !== 'object') continue;
      const { id, parentId } = value as { id?: unknown; parentId?: unknown };
      if (typeof id !== 'string' || typeof parentId !== 'string') continue;
      if (!/^\d+$/.test(id) || !/^\d+$/.test(parentId) || id === parentId) continue;
      threadParents.set(ID_PREFIX + id, ID_PREFIX + parentId);
    }
    while (threadParents.size > MAX_REMEMBERED_PARENTS) {
      const oldest = threadParents.keys().next().value;
      if (oldest === undefined) break;
      threadParents.delete(oldest);
    }
    return threadParents;
  },
};
