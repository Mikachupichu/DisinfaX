/** The Telegram adapter — Telegram Web A, the app served at `web.telegram.org/a/`.
 *
 *  **One app, two of them.** `web.telegram.org` serves Telegram's Web A at `/a/` and the older
 *  Web K at `/k/`, and they share one session: opening `/k/` signs `/a/` out (measured). Only
 *  Web A's markup was ever measured, so the path gate in `onWebA` is what keeps this
 *  adapter from reading Web K's DOM with Web A's anchors — a different application that happens
 *  to share a host and a session, where every anchor here would be a guess.
 *
 *  **Surfaces.** Telegram's own instruction for this platform was posts and comments, and not
 *  1:1 messages: a private conversation is where the reader reads their own correspondence, and
 *  buttons on it are wrong for the same reason they would be on a mail client. That distinction
 *  is free here, because Telegram's id scheme already states it — a chat (a channel, a group, a
 *  supergroup) has a NEGATIVE peer id, and a one-to-one conversation is keyed by the person's own
 *  positive user id. The route's leading `-` is therefore the whole of the decision, and there is
 *  no surface check to get wrong: a DM's hash does not match, so nothing in it is ever captured,
 *  marked injected, or offered buttons.
 *
 *  Both integrated surfaces are ordinary message lists and both are read the same way: a
 *  channel's own view (posting from the channel, no per-message sender) and a discussion thread
 *  (one message per comment, each with its sender). Nothing here tells them apart, because
 *  nothing has to: the sender is read where it exists and the channel is named when it does not.
 *
 *  **Truncation.** None (measured). Across 21 messages in a live thread — the longest 1,028
 *  characters — no message carried an expander of any kind, and every body's `scrollHeight`
 *  exceeded its `clientHeight` by exactly the same 3px regardless of how much text it held,
 *  which is a box artifact rather than a clip (a clipped body would overflow by more the longer
 *  it got). Web A renders a long post in full in a bubble that grows, so `truncated-means-
 *  excluded` has nothing to exclude here and no expander check is needed. That is a measurement,
 *  not a promise: a future Web A that clips would need one.
 *
 *  **Translation.** Web A translates a message in place, and the side it is not showing is
 *  gone: with a post displayed in English, its Russian original is in no text node, no
 *  attribute, no inline script, no page store (measured across the app's four IndexedDB
 *  databases and both of its bundles) and no payload — Web A delivers over a WebSocket, so
 *  there is no response to read it from either. That matters because a post is identified by
 *  the hash of its SOURCE text, so a post filed under whichever language happened to be on
 *  screen would be two posts: classified, and billed, once per language.
 *
 *  So the source is read back off the host's own control — the message menu's
 *  Translate/Show Original item, found by Telegram's `i.icon-language` and never by its label,
 *  which is the one thing that changes between the two directions. It is driven with synthetic
 *  events and the message is put back the way it was, which is why this happens once per
 *  message, before it is captured, and only for messages the reader has not reached yet: the
 *  round trip is ~275ms with the other side on screen for ~200ms of it. A message whose source
 *  cannot be read is captured as its own source, so a failure costs the post its language, not
 *  its buttons.
 *
 *  **Ids.** `telegram:<listKey>:<messageId>`, both read from the DOM the message is rendered in:
 *  the element states its own id as `data-message-id`, and the list holding it states Telegram's
 *  key for that list as `data-list-key`, shaped `<peerId>_<topic>_<mode>` — measured,
 *  `-1003927562647_30346_thread` for a discussion thread and `-1001364081847_-1_thread` for a
 *  channel's own history.
 *
 *  Never from the route, which is a lagging proxy for what is on screen. Web A writes the open
 *  chat into `location.hash`, and measuring a channel → "N comments" transition at 300ms
 *  intervals showed the discussion group's list mounted and already keyed a full second before
 *  the hash named it — and while the hash still named the channel, BOTH lists were on screen at
 *  once. Naming from the route in that window branded the channel's own post with the GROUP's
 *  peer and left four messages carrying two button bars, one under each peer: the same post
 *  classified twice, and a post addressed as a chat it is not in. The list key is final the
 *  moment the list is rendered, so it is what the id is read from. It has to be the whole key and
 *  not the peer alone, because a message id only means anything within the list that rendered
 *  it, and the topic and mode segments are the part that says which list.
 *
 *  **Authors.** Web A carries a sender's name in up to four places, and which one is populated
 *  depends on the surface and on whether the sender has a profile photo — measured across one
 *  live thread: 2 of 21 messages named their sender in a title line, 17 on the avatar image's
 *  `alt`, and 2 on the avatar's `aria-label`, which is what Web A falls back to when the picture
 *  is a coloured initial and there is no image to carry an `alt` at all. A channel's own view has
 *  no per-message sender whatsoever (every post there is the channel's), so the channel is named
 *  from the header above the list. The chain reads them in that order and gives up rather than
 *  guesses: a sender it cannot name is left uncaptured, because a post classified under the wrong
 *  name is worse than a post with no buttons.
 *
 *  The verification badge is Telegram's own `svg.VerifiedIcon` — read for PRESENCE only, never
 *  for its translated label, and only within the block the name itself was read from. Measured:
 *  Web A renders one live in the chat list and one collapsed in the chat header for a verified
 *  peer, so presence is a real signal about a channel and never a node that exists for everyone.
 *  No title line in the thread measured carried one, which is the truth about Telegram's users:
 *  the badge is a channel's and a bot's, not a person's.
 *
 *  **The body, and the block inside it that is not the body.** A message's words are in
 *  `.text-content`, and the view count, the eye, the time and the reaction chips are inside that
 *  element too — as `.Reactions`, wrapping the meta, or as `.MessageMeta` bare, depending on the
 *  surface (measured: a discussion thread renders the wrapper, a channel's own view 11 of 11
 *  messages without it). Classifying the element's own text would feed the classifier a reaction
 *  tally and a view count as if the author had written them, and — the reason it is not merely
 *  untidy — the view count moves, so the post's hash would move with its traffic and the same
 *  words would be classified again every time it did. The subtree is cut out of the classified
 *  text instead, in both of its shapes. Nothing else in the body is: a message's markup down to
 *  its links is left exactly as the page built it, which is what `highlightInPlace` is for.
 *
 *  **Threads.** A channel post's discussion opens as a list of its own, and that list's key states
 *  its root: the topic segment is the id of the message the thread hangs off — the post's copy in
 *  the discussion group, rendered at the top of the same list as an embedded-sender message
 *  (measured: key `-1003927562647_30346_thread`, whose 30346 is the first message in it). Every
 *  comment in the list is linked to it, so the chain builder hands the classifier the post being
 *  discussed. The root copy is captured with no parent of its own, and a list whose topic is not a
 *  message id — Web A writes `-1` for a chat's own history — is not a thread at all, so its
 *  messages stand alone.
 *
 *  A reply to an individual message reaches its ancestor through the block Web A renders above the
 *  reply's body: the parent's author and the first ~200 characters of the parent's words, naming
 *  no id of any kind. That block is what the reply carries (`quotedMessage`) — the parent's own
 *  opening words under the parent's own name, contributing to the hash and to the classifier's
 *  context exactly as a quoted post does on X. It is measured to be the parent's SOURCE text
 *  whatever the reader has translated: with the quoted parent translated, and again with the reply
 *  itself translated, the block's words were unchanged (2026-09-30). The parent is also matched
 *  against the messages above it in the same list to name the reply's thread (`replyParentOf`),
 *  but the parent's full text deliberately does NOT reach the hash: Web A renders a window of a
 *  list and drops what leaves it, so a reply's parent is on the page only for a reader who
 *  scrolled past it, and hashing it would give one reply a different hash to each reader.
 */
import type { MainTweet, QuotedTweet, Usertype } from '../../data/Tweets';
import { UNKNOWN_LANGUAGE, Usertype as UsertypeEnum } from '../../data/Tweets';
import { appLanguage } from './capture';
import { PLATFORM_HOSTS } from './hosts';
import { LONG_FORM_CHARS } from './types';
import type { CapturedPost, PlatformAdapter } from './types';

const ID_PREFIX = 'telegram:';

/** A message, and the element its words are in. Telegram's own class names — the route's
 *  vocabulary — rather than the build-hashed names (`_8MQ78Qjd`) beside them, which change
 *  between releases. */
const MESSAGE_CLASS = 'Message';
const MESSAGE = `.${MESSAGE_CLASS}`;
const TEXT = '.text-content';

/** Web A's mark on a message that answers another one: this class on the message root, with the
 *  message it answers rendered as a quote above the body. */
const REPLY = 'has-reply';

/** Web A's credit line on a forwarded message: the share glyph plus the label saying where it
 *  came from, in the message's own title row. Who FORWARDED it is never named here — a channel
 *  that forwards shows only the source, and a group shows the forwarder as the message's sender —
 *  so this is what tells a forward from an ordinary post, and the row it sits in is the source's.
 *  Read off the class, never off the label's words, which are translated per reader. */
const FORWARD_ROW = '.forward-title-container';

/** Web A's ad slot: the sponsored message Telegram injects into a channel's list. It is a
 *  `.Message` like any other — mounted in the same list, holding a `.text-content` and a
 *  `.SponsoredMessage__button` call to action — but it is an ad rather than the channel's post,
 *  so it is not classified and gets no buttons.
 *
 *  Read off this class on the message root, never off Telegram's "Sponsored" label, which is
 *  translated per reader. Organic messages do not carry it: measured, one `SponsoredMessage` node
 *  in a live channel list against 19 organic messages, none of them with it. The app itself
 *  treats the class as the ad slot — putting it on an organic message collapsed that message to
 *  `display: none` (measured, and restored on removal) — so an organic post the host still shows
 *  cannot be carrying it, and this rule cannot take a post off a page that Telegram is rendering.
 *
 *  A filled ad was never observed (the node measured was the slot's own hidden template), and
 *  that template stated no `data-message-id`, so `postIdOf` was refusing ads incidentally before
 *  this rule existed. This is what makes the refusal deliberate: an ad that states an id would
 *  otherwise be filed as the channel's post and classified. */
const SPONSORED = 'SponsoredMessage';

/** That quote: Web A's block for the replied-to message, holding the author's line and their
 *  words — the words cut short, and the block stating no id of any kind. See `replyParentOf`. */
const QUOTE = '.message-subheader .embedded-text-wrapper';

/** The sender's name inside that block: `.message-title`, one per block, whose `.embedded-sender`
 *  span holds the name and nothing else (measured on a reply: the block's children are the words'
 *  paragraph and this name line, and the name line measures 21 characters to the words' 203). */
const QUOTE_SENDER = '.message-subheader .embedded-sender';

/** Telegram's own mark on a body it is showing a translation of: an `i.icon` on the meta row,
 *  present while the translation is displayed and absent while the source is. It is the only
 *  statement the app makes about which side is on screen — the language picker marks nothing,
 *  names no current language, and is sorted by English name, so its row order says nothing
 *  either (measured). */
const TRANSLATED_MARK = '.message-translated';

/** The block Web A appends inside `.text-content`: reaction chips, view count, "edited", the
 *  time, the sender's signature. Not the author's words, so never classified.
 *
 *  It renders in two shapes, and which one is a property of the surface rather than of the
 *  message: in a discussion thread the meta is wrapped in this element, and in a channel's own
 *  view the element is not rendered at all and the meta sits directly in `.text-content`
 *  (measured: 11 of 11 channel posts had `.MessageMeta` and no `.Reactions`). BOTH are cut out
 *  of the classified text, because the view count is not the author's and it is not even
 *  stable — classifying it would hash the post against its own traffic and re-classify the
 *  same words every time the count moved. */
const NON_BODY = '.Reactions, .MessageMeta';

/** The meta row: the view count, the eye, the time. `display: flex`, floated right, on the
 *  last line of the bubble. It is where the buttons ride when a message has no title line —
 *  see `placeButtons`. */
const META = '.MessageMeta';

/** The sender's line above the bubble, present only when Web A decides to show it. */
const TITLE = '.message-title';

/** The block Web A renders the replied-to message in. The name inside it is the name of the
 *  person answered, and the message's own sender is named elsewhere — see `ownTitle`. */
const EMBEDDED = '.EmbeddedMessage';

/** The name inside that line. `sender-title` is an ordinary sender's and `embedded-sender` is a
 *  channel post's (measured on a post embedded in a discussion group); the container is the
 *  fallback for a name that has neither. */
const TITLE_NAME = '.sender-title, .embedded-sender';

/** Telegram's class for the verification glyph, beside the name it belongs to. */
const BADGE = 'svg.VerifiedIcon';

/** The bubble's content box, which holds the title line and the body. */
const CONTENT_INNER = '.content-inner';

/** The container Web A groups a sender's consecutive messages in. A message without its own
 *  title line is named by this group's avatar. */
const GROUP = '[id^="message-group-"]';

/** A peer's picture. When there is one the name is on the image's `alt`; when the peer has no
 *  photo this is a coloured initial and the name is on the box's `aria-label`. */
const AVATAR = '.Avatar';

/** The chat's own header, above the message list — where a channel's name and badge live, on
 *  the one surface whose messages name nobody. */
const CHAT_INFO = '.ChatInfo';

/** The content column. Telegram lays the app out in three id'd columns and this is the middle
 *  one, the one holding the messages; the floating buttons belong over it rather than over the
 *  chat list beside it. */
const COLUMN = '#MiddleColumn';

/** The list of messages Web A renders, and its own key for that list — see the header, which is
 *  where the id comes from and why the route is not. */
const LIST = '.MessageList';
const LIST_KEY = 'data-list-key';

/** A list key's own shape: the chat's peer id, then the topic and the mode. The peer id is
 *  SIGNED, and that sign is what says a list is a chat rather than a one-to-one conversation —
 *  see the header on why that is the whole of the "not a 1:1 message" decision. */
const LIST_KEY_PEER = /^-\d+_/;

/** Web A serves the app under a version prefix, and only one of the two is looked at. */
const WEB_A_PATH = '/a/';

/** The host's own per-message menu, and the item on it that flips the message between its
 *  translation and its source. The item's anchor is Telegram's `i.icon-language` — the same
 *  icon in both directions — so it is found by where it sits rather than by its label, which
 *  reads "Translate" or "Show Original" depending on the side shown. */
const MENU_ITEM = '.MenuItem';
const LANGUAGE_ICON = 'icon-language';

const REGULAR: Usertype = UsertypeEnum.Regular;
const VERIFIED: Usertype = UsertypeEnum.Verified;

function namespaced(id: string): string {
  return ID_PREFIX + id;
}

function textOf(el: Element | null | undefined): string {
  return (el?.textContent ?? '').trim();
}

let webACache: { path: string; value: boolean } | null = null;

/** Whether this document is the app this adapter was measured on. Web K is the same host and a
 *  different application — see the header — and its path is the only thing that says which. */
function onWebA(): boolean {
  if (webACache?.path !== location.pathname) {
    webACache = { path: location.pathname, value: location.pathname.startsWith(WEB_A_PATH) };
  }
  return webACache.value;
}

/** The key of the list a message is rendered in, or null when it is in no such list.
 *
 *  This is the message's own statement of which chat it belongs to, and it is read from the
 *  element rather than from the route so that two lists on screen at once — which is what a
 *  channel's own history and its discussion are, mid-transition — name themselves correctly.
 *  The sign is the chat test: a one-to-one conversation is keyed by the person's own positive
 *  user id, and is not a surface this adapter has any business on. */
function listKeyOf(root: Element): string | null {
  const key = root.closest(LIST)?.getAttribute(LIST_KEY);
  return key && LIST_KEY_PEER.test(key) ? key : null;
}

/** Every on-screen message that carries words.
 *
 *  Visibility is the whole of the filter and it is not an optimization: Web A keeps a chat it has
 *  already rendered mounted beside the one being read — measured through a channel → discussion
 *  transition, 49 messages were on screen at once across the two lists, and in an earlier view 18
 *  of 39 `.Message` elements were the other chat's, at zero width.
 *
 *  A message with no `.text-content` is a photo, a sticker, a service line or a deleted stub —
 *  nothing to classify — so it is not a root either. A sponsored message is an ad rather than a
 *  post — see `SPONSORED` — so it is not a root either. */
function allRoots(): Element[] {
  if (!onWebA()) return [];
  const roots: Element[] = [];
  for (const el of Array.from(document.querySelectorAll(MESSAGE))) {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (!el.querySelector(TEXT)) continue;
    if (!listKeyOf(el)) continue;
    if (el.classList.contains(SPONSORED)) continue;
    roots.push(el);
  }
  return roots;
}

/** The id an element states, for an element that IS a message. The data attribute alone is not
 *  enough: Web A hangs `data-message-id` on `.bottom-marker` placeholders too, which are not
 *  messages and hold no text. */
function postIdOf(root: Element): string | null {
  if (!root.classList.contains(MESSAGE_CLASS)) return null;
  const listKey = listKeyOf(root);
  if (!listKey) return null;
  const message = root.getAttribute('data-message-id');
  return message && /^\d+$/.test(message) ? namespaced(`${listKey}:${message}`) : null;
}

/** The title line that belongs to THIS message.
 *
 *  A reply renders the replied-to message's own line inside its embedded block, ahead of
 *  anything else on the message (measured on a reply: its only `.message-title` was the embedded
 *  one, naming the person answered). Reading that line would attribute the reply to the account
 *  it answers and hang this message's buttons on that account's row, so the embedded block is
 *  skipped rather than searched. A message whose sender is named nowhere else then falls through
 *  to the avatar and the chat header, which is where Web A keeps the real name.
 *
 *  A FORWARDED message is credited to where it came from and never to whoever forwarded it, and
 *  Web A writes the source into the row carrying its credit line: measured, one `.message-title`
 *  holding `.forward-title-container` (the share glyph and the label) beside `.sender-title` (the
 *  source's own name). That row is taken first — it is the row this platform already puts its
 *  buttons at the end of — so both the name read off it and the buttons riding it are the
 *  source's, in a channel where it is the only name on the message and in a group where the
 *  forwarder's name can also be there as the sender. */
function ownTitle(root: Element): Element | null {
  const credit = root.querySelector(FORWARD_ROW)?.closest(TITLE) ?? null;
  if (credit && !credit.closest(EMBEDDED)) return credit;
  for (const line of Array.from(root.querySelectorAll(TITLE))) {
    if (!line.closest(EMBEDDED)) return line;
  }
  return null;
}

/** The author's name and whether they carry Telegram's verification badge.
 *
 *  Read where Web A actually put it, in the order it populates the four carriers. Each step falls
 *  through only when the one before it is empty, so a title line that exists but holds no name
 *  does not hide the avatar that does. */
function authorOf(root: Element): { name: string; verified: boolean } {
  const title = ownTitle(root);
  if (title) {
    const name = textOf(title.querySelector(TITLE_NAME) ?? title.querySelector('.message-title-name'));
    if (name) return { name, verified: !!title.querySelector(BADGE) };
  }

  // No title line: the sender is named on the avatar instead, which Web A fills two ways — the
  // image's `alt` when the peer has a photo, and the box's `aria-label` when it does not. A
  // group-sender avatar is shared by every message in its group, so it is the group's that is
  // looked in.
  const avatar = (root.closest(GROUP) ?? root).querySelector(AVATAR);
  if (avatar) {
    const name = (avatar.querySelector('img[alt]')?.getAttribute('alt') ?? avatar.getAttribute('aria-label') ?? '').trim();
    return { name, verified: !!title?.querySelector(BADGE) };
  }

  // A channel's own view names nobody per message: every post there is the channel's, and the
  // channel is named once in the header above the list.
  const info = document.querySelector(CHAT_INFO);
  if (!info) return { name: '', verified: false };
  const headerAvatar = info.querySelector(AVATAR);
  const name = textOf(info.querySelector('.fullName'))
    || (headerAvatar?.querySelector('img[alt]')?.getAttribute('alt') ?? headerAvatar?.getAttribute('aria-label') ?? '').trim();
  return { name, verified: !!info.querySelector(BADGE) };
}

/** The message's own words: the body with the block Web A appends to it cut out.
 *
 *  See the header — `.Reactions` holds a reaction tally, a view count and a timestamp, all of
 *  which are inside `.text-content` and none of which are the author's. Only the trailing
 *  whitespace is touched otherwise: the classified text has to be the element's own text so the
 *  claim offsets land on the words they were measured against. */
function bodyText(root: Element): string {
  const body = root.querySelector(TEXT);
  if (!body) return '';
  const clone = body.cloneNode(true) as Element;
  for (const junk of Array.from(clone.querySelectorAll(NON_BODY))) junk.remove();
  return textOf(clone);
}

/** The words of every message this adapter has captured on this page, by id.
 *
 *  Web A renders a window of a list and drops what leaves it, so a reply's parent is often gone
 *  from the page by the time the reply is read, though the reader had already scrolled past it.
 *  This is what the reply block's quote is matched against then. The DISPLAYED side is kept,
 *  because the displayed side is what the quote quotes. */
const capturedBodies = new Map<string, string>();

/** How long a reply's block is given to fill in before the reply is filed without it.
 *
 *  Web A mounts a reply's block empty and fills it in a moment later (measured: the block was
 *  mounted, empty, 3.1s after the list rendered, and held the parent's words — 203 characters of
 *  them — at 6.1s). A reading taken inside that window sees no parent and no quote, and nothing
 *  re-captures a post once it is filed — so the ancestor would be missing from the hash and from
 *  the classifier's context for the rest of the page's life. The wait is bounded because a block
 *  that never fills — a reply to something this account cannot see — must not cost the message
 *  its buttons. */
const QUOTE_WAIT_MS = 10_000;
const awaitingQuoteSince = new Map<string, number>();

/** Whether a reply's block has had its chance to fill in. See `QUOTE_WAIT_MS`.
 *
 *  Keyed by post id rather than by element: Web A re-renders a message as it scrolls, and a
 *  clock that restarted with every re-render would keep deferring a reply whose block never
 *  fills. */
function quoteSettled(id: string, root: Element): boolean {
  if (!root.classList.contains(REPLY)) return true;
  if (quotedOpening(root)) {
    awaitingQuoteSince.delete(id);
    return true;
  }
  const since = awaitingQuoteSince.get(id);
  if (since === undefined) {
    awaitingQuoteSince.set(id, Date.now());
    return false;
  }
  return Date.now() - since >= QUOTE_WAIT_MS;
}

/** The message a reply answers, as far as Web A's DOM says — or null when it says nothing.
 *
 *  Web A renders the replied-to message as a quote above the reply's body: the author's line, and
 *  the first ~200 characters of their words cut with a trailing ellipsis. The block states no id
 *  — its elements carry a class and nothing else, the app holds no state a page script can read,
 *  and the socket it receives messages on carries encrypted MTProto, so nothing there names the
 *  parent either. What the quote does give is the parent's own opening words, and the parent is
 *  above the reply in the list — so the parent is the message above this one, in the same list,
 *  whose words start with the quoted run, and the NEAREST such message is the one, because a
 *  list is in time order and a later message that reads alike is not the one answered. A parent
 *  short enough to be quoted whole matches by equality; a longer one matches on ~200 characters,
 *  which no two messages share.
 *
 *  Candidates come from the messages on screen AND from `capturedBodies`, the messages this
 *  adapter has already filed: Web A keeps only a window of the list mounted, so by the time a
 *  reply is read its parent may have been dropped from the page while the reader had already
 *  scrolled past it. A parent nothing remembers is not guessed at, and what this link is FOR is
 *  now only the thread the reply belongs to (`conversationId`) — the ancestor's words reach the
 *  hash through the block itself, for every reply alike, which is exactly why the link is not
 *  allowed to carry them (see `capture`).
 */
function replyParentOf(root: Element): string | null {
  if (!root.classList.contains(REPLY)) return null;
  const opening = quotedOpening(root);
  if (!opening) return null;

  const self = postIdOf(root);
  if (!self) return null;
  const list = listOfId(self);
  const own = messageNumber(self);
  if (!list || own === null) return null;

  // Nearest first: a message id only orders within its own list, and every candidate here is in
  // this reply's.
  const bodies = new Map<string, string>();
  for (const candidate of Array.from(document.querySelectorAll(MESSAGE))) {
    const id = postIdOf(candidate);
    if (id && listOfId(id) === list) bodies.set(id, bodyText(candidate));
  }
  for (const [id, body] of capturedBodies) if (listOfId(id) === list) bodies.set(id, body);

  let parent: string | null = null;
  let nearest = -Infinity;
  for (const [id, body] of bodies) {
    const number = messageNumber(id);
    if (number === null || number >= own || number <= nearest) continue;
    if (body.startsWith(opening)) { nearest = number; parent = id; }
  }
  return parent;
}

/** A message id's list key and message number: `telegram:<list key>:<message id>`, where the
 *  list key is everything between the prefix and the LAST colon — the key is Web A's and holds
 *  no colon of its own. */
function listOfId(id: string): string | null {
  const rest = id.startsWith(ID_PREFIX) ? id.slice(ID_PREFIX.length) : '';
  const cut = rest.lastIndexOf(':');
  return cut > 0 ? rest.slice(0, cut) : null;
}

function messageNumber(id: string): number | null {
  const cut = id.lastIndexOf(':');
  const tail = id.slice(cut + 1);
  return /^\d+$/.test(tail) ? Number(tail) : null;
}

/** The words a reply block quotes, with Web A's own truncation mark cut off.
 *
 *  The ellipsis is the host's, not the parent's: the parent's own words carry no such mark. Both
 *  readers of this block go through here so a reply is matched against a parent by exactly the
 *  string it would file as a quote — read one way for the match and the other for the hash, one
 *  reply would name its parent and quote it differently. */
function quotedOpening(root: Element): string {
  const block = root.querySelector(QUOTE);
  if (!block) return '';
  return textOf(block).replace(/(?:\.{3}|…)+$/u, '').trim();
}

/** The message a reply quotes — what every reply carries as its ancestor.
 *
 *  Web A's reply block names no id, so the parent has to be captured as something else, and the
 *  reply is captured as a QUOTE: the block is the parent's own opening words under the parent's own
 *  name, which is the same context a quoted post carries on X and the same contribution to the
 *  hash — `canonicalContext` walks `quoting`, so the ancestor's words reach every lookup and every
 *  classification. It is used for EVERY reply, whether or not the parent could also be found in
 *  the list: the block is what the reply states for itself, while the parent's own capture depends
 *  on the reader having scrolled to it, and one reply must not hash two ways (see `capture`).
 *
 *  The block is the parent's SOURCE text, not the side the reader is reading: measured 2026-09-30,
 *  translating the quoted parent (668 characters of it, marked `.message-translated`) and
 *  translating the reply itself both left the block's words exactly as they were untranslated.
 *
 *  It states no id, deliberately. The block is a prefix of the parent's words, not the parent,
 *  and an id here would let the two identify each other: a quoted side is fetched from the
 *  database by id and its claims are injected into whatever element that id names, and this id
 *  names nothing on the page — the parent, when it is captured at all, is captured as its own
 *  message with its own id. An empty one is the same statement the popup's typed claims make: a
 *  piece of text with no account behind it that can be looked up. */
function quotedMessage(root: Element): QuotedTweet | null {
  if (!root.classList.contains(REPLY)) return null;
  const text = quotedOpening(root);
  if (!text) return null;
  const block = root.querySelector(QUOTE)?.parentElement ?? null;
  const sender = textOf(block?.querySelector(QUOTE_SENDER)) || textOf(block?.querySelector('.message-title'));
  return {
    id: '',
    text,
    fullText: text,
    username: sender,
    // The block shows no badge for the sender — it names them and stops — so the standing is
    // unknown rather than absent, and "None" is what X files an account it cannot verify as.
    usertype: block?.querySelector(BADGE) ? VERIFIED : REGULAR,
  };
}

/* ── Reading the side that is not on screen ──────────────────────────────────────────────
 *
 *  Web A translates a message in place: the translation replaces the original in the DOM and
 *  the original is then in no text node, no attribute, no inline script and no page store —
 *  and there is no response to read it from either, because Web A delivers over a WebSocket.
 *  The host's own control is therefore the only way to the source, and the reader's own
 *  "Show Original" is what is driven here: a message's menu is opened with a synthetic
 *  contextmenu and the item that flips it is activated.
 *
 *  Everything below is measured rather than assumed (2026-09-29): the menu takes synthetic
 *  events, the item is findable ~5ms later, the flip lands in ~10ms, and a full round trip —
 *  flip, read, flip back — is ~275ms with the other side on screen for ~200ms of it and the
 *  menu hit-testable for about a frame at each end. It is a real, if brief, change to what the
 *  reader is looking at, which is why the coordinator only ever asks for posts the reader has
 *  not reached yet.
 */

/** Whether Web A is covering this message's own words with a translation of them. */
function isTranslated(root: Element): boolean {
  return !!root.querySelector(TRANSLATED_MARK);
}

/** Synthetic input — untrusted events are the only kind a content script can dispatch, and
 *  Web A accepts them on both the message and its menu. */
function mouseOn(target: Element, type: string, x: number, y: number, button: number, buttons: number): void {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button, buttons }));
}

function pointerOn(target: Element, type: string, x: number, y: number, buttons: number): void {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0, buttons, pointerId: 1, pointerType: 'mouse' }));
}

/** The open menu's translate/show-original item, or null while no such menu is on screen.
 *  Bounded by its own size, because a menu that has been closed is still in the DOM at zero
 *  width. The icon is Telegram's in both directions — the item's LABEL is what changes — so
 *  the item is found by where it sits and never by its text. */
function languageItem(): HTMLElement | null {
  for (const item of Array.from(document.querySelectorAll<HTMLElement>(MENU_ITEM))) {
    if (!item.querySelector('i')?.classList.contains(LANGUAGE_ICON)) continue;
    if (item.getBoundingClientRect().width > 20) return item;
  }
  return null;
}

/** Close the host's menu without choosing anything from it, for the paths that opened one and
 *  then could not use it. Escape is what the app's own menus close on. */
function dismissMenu(): void {
  for (const target of [languageItem() ?? document.body, document]) {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
  }
}

/** Flip a message between the two sides of its translation, the way the reader's own
 *  right-click and menu pick does. Resolves true once the body's text has actually changed. */
async function flipSide(root: Element): Promise<boolean> {
  const body = root.querySelector(TEXT);
  if (!body || !root.isConnected) return false;
  const rect = body.getBoundingClientRect();
  const x = Math.round(rect.left + Math.min(100, rect.width / 2));
  const y = Math.round(rect.top + Math.min(40, rect.height / 2));
  const before = bodyText(root);

  pointerOn(body, 'pointerdown', x, y, 2);
  mouseOn(body, 'mousedown', x, y, 2, 2);
  pointerOn(body, 'pointerup', x, y, 0);
  mouseOn(body, 'mouseup', x, y, 2, 0);
  mouseOn(body, 'contextmenu', x, y, 2, 0);

  let item: HTMLElement | null = null;
  for (let i = 0; i < 40 && !item; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    item = languageItem();
  }
  if (!item) return false;

  const itemRect = item.getBoundingClientRect();
  const itemX = Math.round(itemRect.left + itemRect.width / 2);
  const itemY = Math.round(itemRect.top + itemRect.height / 2);
  pointerOn(item, 'pointerdown', itemX, itemY, 1);
  mouseOn(item, 'mousedown', itemX, itemY, 0, 1);
  pointerOn(item, 'pointerup', itemX, itemY, 0);
  mouseOn(item, 'mouseup', itemX, itemY, 0, 0);
  item.click();

  for (let i = 0; i < 100; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (!root.isConnected) return false;
    if (bodyText(root) !== before) return true;
  }
  return false;
}

/** The source bodies read back off the host's toggle, keyed by message id, and the ids that
 *  could not be read back. Both live for the page: an id only means anything within the list
 *  that rendered the message, and a page load re-reads whatever it renders. */
const sourceBodies = new Map<string, string>();
const sourceFailed = new Set<string>();

/** One flip at a time, for the whole page. Two at once would open two menus — and the second
 *  one's search for its item would find the first one's, i.e. act on the wrong message.
 *  Serialized here rather than in the coordinator because it is this app's menu, not the
 *  coordinator's sweep, that cannot be in two places at once. */
let flipping: Promise<void> = Promise.resolve();

/** Read the side of a translated message that is not on screen: flip the message, read it,
 *  and flip it back.
 *
 *  A restore that fails leaves the message on the wrong side, in front of the reader, so it is
 *  retried once. Giving up after that is survivable rather than merely tolerable: what is
 *  returned is the text the message is NOW showing, and `capture` re-reads which side that is
 *  from the same mark this does — so the message is captured as its own source, and the
 *  reader's next flip is reported to the background like any other. */
async function readOtherSide(root: Element): Promise<string | null> {
  const startedTranslated = isTranslated(root);
  if (!(await flipSide(root))) {
    dismissMenu();
    return null;
  }
  const shown = bodyText(root);
  for (let attempt = 0; attempt < 2 && isTranslated(root) !== startedTranslated; attempt++) {
    await flipSide(root);
  }
  if (isTranslated(root) !== startedTranslated) {
    dismissMenu();
    console.error('[misinfo] telegram: a message was left on its other side after reading it');
  }
  return shown || null;
}

export const telegramAdapter: PlatformAdapter = {
  id: 'telegram',
  hosts: PLATFORM_HOSTS.telegram ?? [],

  // A URL cannot name one of these. Web A's route says which chat is open, but a message id only
  // means anything within the list that rendered it, and that list's key is the rendering's, not
  // the route's — see the header. Nothing calls this today (`postIdFromUrl` is read for in-page
  // navigation, which the sweep already covers by re-reading the DOM), and a route-derived guess
  // here is the bug this adapter was just cured of.
  postIdFromUrl() {
    return null;
  },

  postRoots(id) {
    return allRoots().filter((root) => postIdOf(root) === id);
  },

  postIdOf,

  /** A message, judged for length — Telegram clamps nothing, so the number is
   *  LONG_FORM_CHARS, read off the message's own words with the block Web A
   *  appends to every body (reactions, views, "edited", the time, a signature) taken out, so
   *  that a message is not called long for the chrome under it.
   *
   *  Telegram has no comment type. Every message in the list is a post, replies included,
   *  and each is judged on its own words — there is no shape here that is always short and
   *  earns buttons regardless. A reply's quote block is not part of the body: `TEXT` does
   *  not contain it, so the words of the message being answered never make the reply read
   *  long. The quoted message is that reply's ancestor in the hash and in the classifier's
   *  context either way (see `capturedBodies`). */
  isLongForm(root) {
    return bodyText(root).length >= LONG_FORM_CHARS;
  },

  textElement(root) {
    return root.querySelector(TEXT);
  },

  // A message's body is markup — links, mentions, and the emoji Telegram renders as images —
  // and Web A's `pre-wrap` whitespace is part of its layout. Rebuilding the element from the
  // classified string would flatten all of it, so highlights wrap the page's own text nodes.
  highlightInPlace: true,

  placeButtons(container, root) {
    // A message with a title line puts its buttons at that line's right-hand end, which is where
    // this platform's own "name · time" bar belongs (and where the spacer Web A already keeps on
    // that line is trying to push things). The auto margin is what pins them to the end whether
    // or not the spacer is present: in a flex row an auto margin takes the free space before
    // `flex-grow` is consulted, so the buttons land on the right edge either way.
    const title = ownTitle(root);
    if (title) {
      container.style.display = '';
      container.style.justifyContent = '';
      container.style.marginLeft = 'auto';
      container.style.marginRight = '';
      container.style.alignItems = '';
      title.appendChild(container);
      return;
    }

    // A message with no title line has no top line to ride on, so its buttons ride the meta row
    // instead — the line Web A already gives every message for its view count and its time. In
    // flow above the body they cost every channel post 20px of empty bubble (measured), and on a
    // tall post they sat off-screen above the words they belong to.
    //
    // They take the row's LEFT end, with the view count and the time staying at its right. The
    // row is a right float that hugs its own text, so it is stretched to the bubble's width for
    // this, and the auto margin is what holds the buttons at one end and the count at the other.
    // Measured at no cost on every post that has a bar: the last line of the body gives back the
    // width the float was taking from it and the row takes a line of its own, which cancels. At
    // worst it is the 18px of that row, no more than the row above the body was costing.
    //
    // The row is there on every message measured (11 of 11 channel posts), and a message without
    // one is handled below rather than left without buttons.
    const meta = root.querySelector(META) as HTMLElement | null;
    if (meta) {
      meta.style.width = '100%';
      meta.style.marginLeft = '0';
      container.style.display = 'inline-flex';
      container.style.justifyContent = '';
      container.style.marginLeft = '';
      container.style.alignItems = 'center';
      container.style.marginRight = 'auto';
      meta.insertBefore(container, meta.firstChild);
      return;
    }

    // No meta row at all — not measured on this app, but a message that has none still gets its
    // buttons, on a line of their own at the top of the bubble. In flow rather than floated or
    // overlaid: a message's first block can be a photo of any size, and anything taken out of
    // flow would sit on top of it.
    const inner = root.querySelector(CONTENT_INNER);
    if (!inner) return;
    container.style.display = 'flex';
    container.style.justifyContent = 'flex-end';
    container.style.marginLeft = '';
    container.style.marginRight = '';
    container.style.alignItems = '';
    inner.insertBefore(container, inner.firstChild);
  },

  feedCenter() {
    if (!onWebA()) return null;
    const column = document.querySelector(COLUMN);
    if (!column) return null;
    const rect = column.getBoundingClientRect();
    return rect.width > 0 ? rect.left + rect.width / 2 : null;
  },

  isPostTarget(id) {
    return allRoots().some((root) => postIdOf(root) === id);
  },

  postElementFor(node) {
    if (!onWebA()) return null;
    const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    const message = (el as Element | null)?.closest?.(MESSAGE);
    if (!message) return null;
    // A photo or a service line is not a post we can be used on, so a selection inside one stays
    // an ordinary web selection rather than being handed to a post with no text to classify. A
    // message in a one-to-one conversation is not a post here at all, for the reason in the
    // header, so a selection inside one is left to the browser too. A sponsored message is an ad
    // rather than a post for the same reason — see `SPONSORED`.
    if (!listKeyOf(message)) return null;
    if (message.classList.contains(SPONSORED)) return null;
    return message.querySelector(TEXT) ? message : null;
  },

  captureRoots() {
    return allRoots();
  },

  displayedTranslationLocale(root) {
    // Null while the message shows its own words, and also when the document names no
    // language: a translation that cannot be named has nothing to file its highlights
    // under, and `capture` reads such a message as its own source rather than inventing a
    // key for it.
    return isTranslated(root) ? appLanguage() : null;
  },

  displayedText(root) {
    // Whatever side is on screen, which is what the background has to measure a flip's
    // ranges against. A message Web A renders is complete — it truncates nothing behind a
    // "see more" — so the body read here is the whole of what was classified.
    return bodyText(root) || null;
  },

  async revealSource(root) {
    const id = postIdOf(root);
    if (!id || sourceBodies.has(id) || sourceFailed.has(id)) return;
    // Nothing to recover: the message is showing its own words, which `capture` reads
    // directly. This is the ordinary case, and the one that costs nothing.
    if (!isTranslated(root)) return;

    flipping = flipping.then(async () => {
      // Re-checked inside the queue: the message may have scrolled out and been re-rendered
      // (Web A virtualizes its lists) while an earlier flip was in flight.
      if (!root.isConnected || sourceBodies.has(id) || sourceFailed.has(id) || !isTranslated(root)) return;
      const source = await readOtherSide(root);
      if (source === null) {
        // Left alone for the rest of the page's life. A second attempt would cost the reader
        // another visible flip to fail in the same way, and the message is still perfectly
        // usable: it is captured as its own source, which is all this platform did before any
        // of this existed.
        sourceFailed.add(id);
        return;
      }
      sourceBodies.set(id, source);
    }).catch((e) => {
      console.error('[misinfo] telegram: reading a message\'s source failed', e);
    });
    return flipping;
  },

  capture(root): CapturedPost | null {
    const id = postIdOf(root);
    if (!id) return null;

    const shown = bodyText(root);
    if (!shown) return null;
    capturedBodies.set(id, shown);

    // A reply the host is still filling in is not filed yet: its block is both what names the
    // parent and what carries the parent's words, and a post is captured once. See
    // `quoteSettled` — this is the only place a reply is allowed to wait.
    if (!quoteSettled(id, root)) return null;

    const author = authorOf(root);
    if (!author.name) return null;

    // Telegram renders one side of a message at a time and the other side is nowhere on the
    // page, so a message showing a translation has had its own words read back off the host's
    // toggle already (see `revealSource`). The post is identified by its SOURCE text — the
    // hash, and with it every stored classification and highlight key, is computed from
    // `fullText` — so that is what is filed, with the translation carried beside it as the
    // displayed side. Filing the displayed side as the source instead gives one post a
    // different hash in each of its languages: classified, and billed, once per language as
    // if each were a different post.
    const source = sourceBodies.get(id);
    const destination = isTranslated(root) ? appLanguage() : null;
    // A translation whose language cannot be named is not worth claiming: the locale is the
    // key its highlight ranges are filed under, and a key nothing else reads hides them. Such
    // a message is read as its own source instead, which classifies the text on screen under
    // the platform's unknown-language key — honest, and exactly what happens anyway when the
    // source could not be read back.
    const translatedBody = source && destination ? shown : undefined;
    const text = translatedBody ? source! : shown;

    // A reply's ancestor reaches the hash as the QUOTE BLOCK and nothing else — see
    // `quotedMessage`, and `replyParentOf` for the link that is deliberately not used here. The
    // block is a fixed ~200 characters of the parent's own opening words under the parent's own
    // name, and it is there whenever this account can see the parent at all; the parent's FULL
    // text is only available when the reply's parent happened to be on the page — Web A renders a
    // window of the list and drops what leaves it — so hashing it would give one reply a
    // different hash to each reader according to where they entered the channel, and file it as
    // two posts. What the reply still takes from the link is the THREAD it belongs to
    // (`conversationId`, which no hash covers), so a reply whose parent is reachable stays one
    // thread with it.
    const parent = replyParentOf(root);

    return {
      post: {
        id,
        text,
        fullText: text,
        translatedText: translatedBody,
        destinationLanguage: translatedBody ? destination! : undefined,
        username: author.name,
        usertype: author.verified ? VERIFIED : REGULAR,
        conversationId: parent ?? id,
        quoting: quotedMessage(root),
        replyingTo: null,
      } as MainTweet,
      replyParentId: null,
    };
  },
};
