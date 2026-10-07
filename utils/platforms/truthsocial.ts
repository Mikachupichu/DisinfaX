/** The Truth Social adapter.
 *
 *  Truth Social's web client is a Soapbox/Mastodon fork, so the site is unusual among the
 *  platforms added after X in two ways that decide everything below.
 *
 *  First, it HAS a real API, and its posts come from it. Every feed, thread and permalink
 *  is a `/api/v1/…` JSON response rendered client-side, so `captureNetwork` is the
 *  preferred half here exactly as the standing rule asks: the payload carries the post's
 *  language (`language`), the id it answers (`in_reply_to_id`) and its body as authored,
 *  and it arrives before the post is on screen. The DOM half underneath is not dead code
 *  — it is what covers a post no response this page load happened to carry.
 *
 *  Second, and more usefully, its markup is the one thing on this site with anchors worth
 *  keying on: Soapbox puts `data-testid` on the structural elements themselves —
 *  `status`, `account`, `status-content`, `markup`, `verified-badge`, `status-card-image`
 *  — which is a name the app maintains on purpose rather than a build hash. Nothing in
 *  this file keys on a class name.
 *
 *  The text a post is classified on is read from the DOM, not from the payload, even
 *  though the payload has it — see `postBlocks` for why the two must come from one
 *  extractor, and see the `content` field's note in `captureNetwork` for what the payload
 *  is used for instead.
 */
import type { MainTweet, QuotedTweet, Usertype } from '../../data/Tweets';
import { Usertype as UsertypeEnum } from '../../data/Tweets';
import { passageTextContent, sealHostEvents } from '../injecting';
import { PLATFORM_HOSTS } from './hosts';
import { LONG_FORM_CHARS } from './types';
import type { CapturedPost, PlatformAdapter, TextRegion } from './types';

/** Namespaces this platform's ids, as every platform after X does: the background
 *  broadcasts a classification to every connected relay rather than keying by tab, so a
 *  bare numeric id from here could otherwise be injected into an unrelated timeline. That
 *  risk is not theoretical on this platform — Truth Social ids are digit strings, the
 *  same shape X's status ids have. */
const ID_PREFIX = 'ts:';

/** A permalink is `/@handle/posts/<digits>`; the handle may be a remote `user@host`. */
const POST_PATH_RE = /^\/@[^/]+\/posts\/(\d+)/;
const POST_HREF_RE = /^\/@([^/]+)\/posts\/(\d+)/;

/** The API's canonical permalink form, `/@handle/<digits>`.
 *
 *  The permalink view renders THAT for the post it is showing — as an absolute URL on a
 *  plain anchor rather than on a `time`, which is why the byline rule below cannot find it.
 *  The byline's own avatar link is the bare `/@handle` and does not carry digits, so it is
 *  never mistaken for a permalink. */
const CANONICAL_PATH_RE = /^\/@([^/]+)\/(\d+)$/;

/** The app's own structural vocabulary, all `data-testid`s the fork maintains. */
const STATUS_SELECTOR = '[data-testid="status"]';
const ACCOUNT_SELECTOR = '[data-testid="account"]';
const CONTENT_SELECTOR = '[data-testid="status-content"]';
const MARKUP_SELECTOR = '[data-testid="markup"]';
const VERIFIED_SELECTOR = '[data-testid="verified-badge"]';
const ACTION_BAR_SELECTOR = '[data-testid="status-action-bar"]';

const TS_VERIFIED: Usertype = UsertypeEnum.Verified;
const TS_REGULAR: Usertype = UsertypeEnum.Regular;

/** Two newlines between a post's blocks so the worker reads them as separate paragraphs.
 *  The regions below carry the join: nothing renders the characters BETWEEN two regions,
 *  so a character here belonging to no region would be text written into an element that
 *  never held it. */
const POST_JOIN = '\n\n';

function isElement(node: unknown): node is Element {
  return !!node && typeof node === 'object' && (node as Node).nodeType === Node.ELEMENT_NODE;
}

/** Whether `el` is the permalink view's post container.
 *
 *  A status opened on its own carries no `data-testid="status"`: the fork renders its
 *  `Status` in a detailed variant there, and the one structural thing that separates that
 *  container from the wrappers around it is that the action bar is a DIRECT child of it —
 *  on a feed the status element sits two levels above its own bar. Both tests are testids;
 *  the `closest` test in front of them keeps this from firing inside a status, so it can
 *  never compete with a feed's own root. */
function isDetailRoot(el: Element): boolean {
  if (el.closest(STATUS_SELECTOR)) return false;
  if (!el.querySelector(':scope > ' + ACTION_BAR_SELECTOR)) return false;
  return !!el.querySelector(CONTENT_SELECTOR);
}

/** The post root that owns `node` — a status, or the permalink view's container.
 *
 *  Nearest, not outermost: a quote card and a retruth body render INSIDE the post that
 *  carries them, and an element inside one of those must resolve to ITS root. This is the
 *  boundary `ownWithin` scopes by. */
function rootOf(node: Node): Element | null {
  const el = isElement(node) ? node : node.parentElement;
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    if (cur.matches(STATUS_SELECTOR) || isDetailRoot(cur)) return cur;
  }
  return null;
}

/** The outermost post root containing `node`.
 *
 *  Outermost, not nearest, and that is the point: a quote card and a retruth body are
 *  rendered inside the post that carries them, and `allPostRoots` deliberately does not
 *  count a nested post as a post of its own (it has no permalink of its own on this
 *  surface, and its text belongs to the post that embedded it). Resolving to the outermost
 *  is therefore what makes `postElementFor` name a post we actually put buttons on — which
 *  is the whole question the selection rule asks. */
function nearestPost(node: Node): Element | null {
  const el = isElement(node) ? node : node.parentElement;
  let found: Element | null = null;
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    if (cur.matches(STATUS_SELECTOR) || isDetailRoot(cur)) found = cur;
  }
  return found;
}

/** The descendant of `root` matching `selector` that belongs to `root`'s OWN post —
 *  never to a post nested inside it.
 *
 *  Without this guard a quote card's `markup` or `account` would be read as the outer
 *  post's: `querySelector` returns the first match in document order, and a quote renders
 *  after the body it quotes, so the failure is silent — the outer post would be classified
 *  on the quoted post's words, or worse, the highlighter would paint a slice of one post
 *  into the other's element. */
function ownWithin(root: Element, selector: string): Element | null {
  for (const el of Array.from(root.querySelectorAll(selector))) {
    if (rootOf(el) === root) return el;
  }
  return null;
}

/** The card's OWN byline block — the avatar, display name, verified badge and handle of the
 *  account the card belongs to. On a retruth that is the booster's line, which is also the
 *  line the card's permalink hangs off. */
function ownAccount(root: Element): Element | null {
  return ownWithin(root, ACCOUNT_SELECTOR);
}

/** The byline of the post the card SHOWS.
 *
 *  The same element as `ownAccount` except on a retruth card, where the card belongs to the
 *  booster but the post does not: the original's byline is the last account belonging to the
 *  card, drawn above the original's body and under the booster's line. Buttons, author and
 *  verification all follow the post shown rather than the card. */
function shownAccount(root: Element): Element | null {
  if (!showsOnlyEmbedded(root)) return ownAccount(root);
  let found: Element | null = null;
  for (const el of Array.from(root.querySelectorAll(ACCOUNT_SELECTOR))) {
    if (rootOf(el) === root) found = el;
  }
  return found;
}

/** The `<a>` carrying the post's TIMESTAMP, which is the post's permalink and the only
 *  place on the row that names the post's id and its author's handle.
 *
 *  Found through the `time` element rather than through a `/posts/` href anywhere in the
 *  subtree: a retruth's body and a quote card both carry permalinks to OTHER posts, and
 *  the first `/posts/` link in document order would be whichever of those renders first. */
function timeLink(root: Element): Element | null {
  const time = ownAccount(root)?.querySelector('time');
  return time ? time.closest('a[href]') : null;
}

/** The `<a>` carrying the post's permalink where there is no timestamp to find — the
 *  permalink view, whose byline has none and which publishes the post's canonical URL on a
 *  plain span-and-anchor instead.
 *
 *  Read from anchors OUTSIDE the post's own body, and this is the whole reason it is not a
 *  one-line query: a post that links to another Truth Social post would otherwise be named
 *  by whatever it links to first, and a body link comes before the byline's own. */
function canonicalLink(root: Element): Element | null {
  const body = ownWithin(root, CONTENT_SELECTOR);
  for (const anchor of Array.from(root.querySelectorAll('a[href]'))) {
    if (rootOf(anchor) !== root || body?.contains(anchor)) continue;
    const href = anchor.getAttribute('href') ?? '';
    let path = href;
    try {
      path = new URL(href, document.baseURI).pathname;
    } catch {
      // A malformed href is never a permalink; the raw string is compared as it stands.
    }
    if (CANONICAL_PATH_RE.test(path)) return anchor;
  }
  return null;
}

/** The post's handle and id, from whichever permalink this surface publishes.
 *
 *  The timestamp's `/@handle/posts/<id>` first, because that is what every feed, thread and
 *  quoted card renders; the canonical `/@handle/<id>` only where there is no timestamp. */
function permalinkOf(root: Element): { handle: string; id: string } | null {
  const fromTime = (timeLink(root)?.getAttribute('href') ?? '').match(POST_HREF_RE);
  if (fromTime) return { handle: fromTime[1], id: fromTime[2] };
  const canonical = canonicalLink(root);
  const fromCanonical = canonical
    ? new URL(canonical.getAttribute('href') ?? '', document.baseURI).pathname.match(CANONICAL_PATH_RE)
    : null;
  return fromCanonical ? { handle: fromCanonical[1], id: fromCanonical[2] } : null;
}

/** The header band: the row inside the SHOWN byline that holds the name column and the
 *  trailing cluster, and that the buttons are placed into. On a card that shows an embedded
 *  post, that is the embedded post's byline — the embedded post is the post, so its own
 *  header line is where its buttons belong.
 *
 *  On a feed this is "the byline block's own child that contains the timestamp", so it
 *  survives the row being restructured around the name as long as the timestamp stays in
 *  it. The permalink view has no timestamp to find it by, but nests the same band one level
 *  further in: the account element holds the name row as its only child, and that row is
 *  laid out exactly as the feed's header is — the byline as its first cell and a trailing
 *  cell after it.
 *
 *  Reading the account's OWN child rather than the account's parent matters for more than
 *  the buttons. The row above the account has a single cell on a permalink, so a container
 *  placed first in it takes the whole cell order with it: measured, the byline sat at x421
 *  on its own and at x763 with our container in that row, because the container's
 *  `margin-left: auto` is what absorbed the free space. The band below the account is the
 *  host's own row, and nothing we put in it moves the byline. */
function headerRow(root: Element): Element | null {
  const account = shownAccount(root);
  const time = account?.querySelector('time');
  if (account && time) {
    for (let el: Element | null = time.parentElement; el && el !== account; el = el.parentElement) {
      if (el.parentElement === account) return el;
    }
    return null;
  }
  if (account && isDetailRoot(root)) return account.firstElementChild;
  return null;
}

/** What a retruth card shows, keyed by the retruth's own post id, and what a quoting post
 *  quotes, keyed by the quoting post's id. Both pairings come from the payload, because
 *  neither post's id is anywhere in the markup: the shown post's own timestamp is not inside
 *  an anchor, and the card's only permalink is the sharer's line.
 *
 *  They are separate maps because the payload's two relationships carry different force. A
 *  retruth IS another post — it has no words of its own, so its card shows the post it wraps,
 *  full stop. A quote is a post of its own, and gives way to the post it names only when its
 *  own body renders as nothing.
 *
 *  A card id always denotes the same post, so an entry cannot go stale in a way that matters;
 *  the cap only bounds a session that scrolls for hours without reloading. */
const CARD_LIMIT = 400;
const retruthShows = new Map<string, string>();
const quoteNames = new Map<string, string>();

/** Posts the platform itself marked as advertisements, by the id they would have been filed
 *  under. They are left without buttons rather than classified, as on X.
 *
 *  The payload's `sponsored` boolean is the only ad marker on this platform: the DOM's is a
 *  translated label, which this rollout refuses to key on, and the fork gives an ad no
 *  structural marker of its own. So an ad the payload described is skipped, and one only the
 *  markup ever showed is not — the marker travels with the payload and with nothing else.
 *  Measured over a long feed sample (2026-10-01), every organic status carried `false`. */
const SPONSORED_LIMIT = 400;
const sponsoredIds = new Set<string>();

function rememberSponsored(id: string): void {
  if (sponsoredIds.size >= SPONSORED_LIMIT) {
    const oldest = sponsoredIds.values().next().value;
    if (oldest !== undefined) sponsoredIds.delete(oldest);
  }
  sponsoredIds.add(id);
}

function remember(map: Map<string, string>, key: string, value: string): void {
  if (map.size >= CARD_LIMIT) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

/** Which post each post answers, by the id of the one it answers.
 *
 *  The DOM cannot say this. A reply states its parent as a byline — "Replying to @handle" —
 *  and the handle is a rendered, translated string, which this rollout refuses to key on;
 *  the status element carries no role, no attribute and no structural marker that separates a
 *  reply from a root (measured: a tag feed's roots and a thread's replies are both
 *  `[data-testid="status"]` with `role="link"`). The payload's `in_reply_to_id` is the only
 *  statement of it, and the interceptor already forwards it on every record it harvests,
 *  including the thread responses a permalink loads its replies from.
 *
 *  Recorded as an edge rather than as a capture: it is a fact about the post whether or not
 *  anything files it, so it is written before the loop below decides to skip the record. The
 *  cap matches the other maps' — one session's worth, never a thing that goes stale. */
const replyParents = new Map<string, string>();

function rememberReplyParent(id: string, parentId: string | null): void {
  if (!parentId) return;
  const parent = ID_PREFIX + parentId;
  if (parent === id) return;
  remember(replyParents, id, parent);
}

/** The id of the post this root REPRESENTS — the post the reader is being shown, which on a
 *  card that carries none of its own is the one embedded in it.
 *
 *  A card whose embedded post no payload has described yet cannot be named at all: the DOM
 *  gives only the card's own id, and filing the embedded post's words under it would give one
 *  id two texts. Null is the honest answer, and an unnamed card is skipped by every caller. */
function postIdOfElement(root: Element): string | null {
  const permalink = permalinkOf(root);
  if (!permalink) return null;
  const card = ID_PREFIX + permalink.id;
  const retruth = retruthShows.get(card);
  if (retruth) return retruth;
  if (!showsOnlyEmbedded(root)) return card;
  return quoteNames.get(card) ?? null;
}

/** The author's handle, taken from the markup's own links rather than from the byline's
 *  text, so nothing here depends on how the platform renders or localizes a name. */
function handleOf(root: Element): string {
  if (showsOnlyEmbedded(root)) {
    const href = shownAccount(root)?.querySelector('a[href^="/@"]')?.getAttribute('href') ?? '';
    return href.startsWith('/@') ? (href.slice(2).split('/')[0] ?? '') : '';
  }
  return permalinkOf(root)?.handle ?? '';
}

function isVerified(root: Element): boolean {
  return !!shownAccount(root)?.querySelector(VERIFIED_SELECTOR);
}

/** The markup element holding the body of the post the card SHOWS, and whether that body
 *  came from a block embedded in the card rather than from the card's first markup.
 *
 *  A share of another post renders the sharer's own body FIRST and, when that body carries
 *  text, the embedded post after it. So a card whose first markup belonging to it has no
 *  text is showing a post that is not its own: that is what an `RT: <url>` share looks like,
 *  where the platform strips the marker and leaves the sharer's body empty. A post that
 *  quotes with a comment is the ordinary case — its own markup holds the comment — and "the
 *  first markup belonging to the card that has text" separates the two without reading a
 *  class name or a label. */
function ownBody(root: Element): { markup: Element | null; embedded: boolean } {
  const markups = Array.from(root.querySelectorAll(MARKUP_SELECTOR)).filter((el) => rootOf(el) === root);
  if (markups.length === 0) return { markup: null, embedded: false };
  const withText = markups.find((el) => passageTextContent(el as HTMLElement).trim().length > 0);
  if (!withText) return { markup: markups[0], embedded: false };
  return { markup: withText, embedded: withText !== markups[0] };
}

/** Whether the card's own body renders as nothing and the post it is showing is the embedded
 *  one — a retruth, or a share whose `RT: <url>` marker the platform stripped. That post, not
 *  the card, is what the extension classifies and puts buttons on.
 *
 *  This is the DOM's own account of it, and it is deliberately the only signal: a post that
 *  quotes another WITH a comment has its own visible words and stays a post of its own, which
 *  is exactly the difference this draws. */
function showsOnlyEmbedded(root: Element): boolean {
  return ownBody(root).embedded;
}

/** The character count at which a Truth Social post stops being taken in at a glance.
 *
 *  The host clamps on HEIGHT, not on a count: the body element carries `max-h-40`
 *  (160px — eight lines at the body's own `leading-5`) and `overflow-hidden`, and the whole
 *  string stays in the DOM behind it. So the number cannot be read off the host at all — the
 *  height of a box is not a character count, and it moves with the column's width. This
 *  platform used the sibling height-clamped hosts' number, 250; there is no per-platform
 *  number any more, and every platform reads the universal `LONG_FORM_CHARS`. */

/** Whether the host is holding part of this post's body back right now.
 *
 *  The clamp classes are on EVERY body, not only an overflowing one — measured across a
 *  feed, all three of a tag page's posts carried `max-h-40` and `overflow-hidden` while one
 *  of them overflowed by 136px and the others by 8px — so the class list says nothing. What
 *  says it is the box itself: content taller than a hidden-overflow box is content the
 *  reader cannot see. Cheap by construction, two layout reads and no text. */
function bodyClamped(root: Element): boolean {
  const body = ownBody(root).markup;
  if (!body) return false;
  return body.scrollHeight > body.clientHeight + 1;
}

/** The elements holding the shown post's body text, in reading order.
 *
 *  The body is one `markup` element that is ITSELF the single block when the post has one
 *  paragraph (`content` was `<p>…</p>`, so the renderer put the paragraph's contents
 *  straight into it) and holds the blocks as children when it has more than one
 *  (`content` was `<p>a</p><p>b</p>`). Reading the children when they exist and the
 *  element itself otherwise is what makes a one-paragraph and a two-paragraph post the
 *  same shape to everything downstream.
 *
 *  The link card and the media sit outside `markup` — in fact the card's own text has its
 *  own `data-testid`s (`status-card-image`, `status-card-description`) precisely so it can
 *  be told apart — so a shared article's headline is never classified as if the poster had
 *  written it. That is the same reason a quote card's body is not here: it belongs to the
 *  quoted post. A retruth's body IS here, because on a retruth the embedded post is what the
 *  reader is reading. */
function postBlocks(root: Element): Element[] {
  const markup = ownBody(root).markup;
  if (!markup) return [];
  const children = Array.from(markup.children);
  const blocks = children.length > 0 ? children : [markup];
  return blocks;
}

/** The text of one block.
 *
 *  `passageTextContent`, not `textContent`, and this is load-bearing rather than tidy:
 *  these strings become the offsets the highlight layer paints at, and that layer locates
 *  a region's slice by searching for it inside what `passageTextContent` reads back out of
 *  the element. Two extractors that disagree by one character — a screen-reader-only span
 *  counted on one side and dropped on the other — put a claim's highlight on the wrong
 *  words. Both sides go through this one function so they cannot disagree. */
function blockText(block: Element): string {
  return passageTextContent(block as HTMLElement).trim();
}

function postParts(root: Element): { el: Element; text: string }[] {
  const parts: { el: Element; text: string }[] = [];
  for (const el of postBlocks(root)) {
    const text = blockText(el);
    if (text) parts.push({ el, text });
  }
  return parts;
}

function postText(root: Element): string {
  return postParts(root).map((part) => part.text).join(POST_JOIN);
}

function postRegions(root: Element): TextRegion[] {
  const regions: TextRegion[] = [];
  let at = 0;
  for (const part of postParts(root)) {
    regions.push({ el: part.el, start: at, end: at + part.text.length });
    at += part.text.length + POST_JOIN.length;
  }
  return regions;
}

/** Every post on the page that should carry buttons: a post root with a permalink of its
 *  own — a feed status, or the permalink view's container — not nested inside another root,
 *  and actually laid out.
 *
 *  The nesting test is what keeps a quote card or a retruth's body from being treated as a
 *  post: neither is a post the reader can open on its own from the feed, and both would
 *  otherwise also be counted twice — once here and once as the post that carries them.
 *
 *  The geometry test excludes the zero-width copies a virtualized list leaves behind:
 *  this feed is react-virtuoso, so items that scroll out are taken out of the document and
 *  items that scroll in are added, and a container mid-mount measures zero. */
function allPostRoots(): Element[] {
  const candidates: Element[] = Array.from(document.querySelectorAll(STATUS_SELECTOR));
  // The permalink view's own container, for the status on screen when no status element
  // owns it: found by walking up from the body, because the container itself carries no
  // `data-testid` to select on.
  for (const content of Array.from(document.querySelectorAll(CONTENT_SELECTOR))) {
    if (content.closest(STATUS_SELECTOR)) continue;
    for (let cur: Element | null = content; cur; cur = cur.parentElement) {
      if (isDetailRoot(cur)) {
        candidates.push(cur);
        break;
      }
    }
  }
  const roots: Element[] = [];
  for (const el of candidates) {
    if (roots.includes(el)) continue;
    // A root inside another root is not a post of its own: on a feed that is a quoted post
    // or a retruth body, which has no permalink here and whose words belong to the outer post.
    if (el.parentElement && rootOf(el.parentElement)) continue;
    if (!permalinkOf(el)) continue;
    if (el.getBoundingClientRect().width <= 0) continue;
    roots.push(el);
  }
  return roots;
}

function postRoots(id: string): Element[] {
  return allPostRoots().filter((root) => postIdOfElement(root) === id);
}

/** Every post root whose OWN permalink names `postId`, whatever post it turns out to show.
 *  `postRoots` cannot answer this: it asks what a root SHOWS. */
function rootsNamed(postId: string): Element[] {
  return allPostRoots().filter((root) => {
    const permalink = permalinkOf(root);
    return permalink ? ID_PREFIX + permalink.id === postId : false;
  });
}

/** One status record, as the MAIN-world interceptor forwards it. `id` is the post's own,
 *  which the interceptor has already read through a retruth; `wrapperId` is the retruth it
 *  was read out of, when it was one, and `quoted` the post it quotes, when it quotes one. */
interface NetStatus {
  id: string;
  content: string;
  language: string | null;
  inReplyToId: string | null;
  createdAt: string | null;
  account: { acct: string; displayName: string | null; verified: boolean };
  wrapperId: string | null;
  sponsored: boolean;
  quoted: NetQuoted | null;
}

/** The post a quoting post quotes. Its body comes along because a quote is part of the
 *  quoting post's hash and of the context it is classified in — the quoted post is not a
 *  post of its own on this surface, having no buttons and no feed row of its own. */
interface NetQuoted {
  id: string;
  content: string;
  language: string | null;
  account: { acct: string; displayName: string | null; verified: boolean };
}

const MAX_NETWORK_RECORDS = 200;

function asNetStatus(value: unknown): NetStatus | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const account = record.account as Record<string, unknown> | undefined;
  if (typeof record.id !== 'string' || !/^\d{6,}$/.test(record.id)) return null;
  if (typeof record.content !== 'string' || record.content.length === 0) return null;
  if (!account || typeof account !== 'object' || typeof account.acct !== 'string' || account.acct.length === 0) return null;
  const quoted = asNetQuoted(record.quoted);
  return {
    id: record.id,
    content: record.content,
    language: typeof record.language === 'string' && record.language.length > 0 ? record.language : null,
    inReplyToId: typeof record.inReplyToId === 'string' && record.inReplyToId.length > 0 ? record.inReplyToId : null,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : null,
    account: {
      acct: account.acct,
      displayName: typeof account.displayName === 'string' ? account.displayName : null,
      verified: account.verified === true,
    },
    wrapperId: typeof record.wrapperId === 'string' && /^\d{6,}$/.test(record.wrapperId) ? record.wrapperId : null,
    sponsored: record.sponsored === true,
    quoted,
  };
}

/** The quoted post, validated the same way as a status: a snowflake id, a body, and an
 *  author. Null for anything else, so a payload that names a quote in a shape this file
 *  does not know leaves the quoting post exactly as it would have been without one. */
function asNetQuoted(value: unknown): NetQuoted | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const account = record.account as Record<string, unknown> | undefined;
  if (typeof record.id !== 'string' || !/^\d{6,}$/.test(record.id)) return null;
  if (typeof record.content !== 'string' || record.content.length === 0) return null;
  if (!account || typeof account !== 'object' || typeof account.acct !== 'string' || account.acct.length === 0) return null;
  return {
    id: record.id,
    content: record.content,
    language: typeof record.language === 'string' && record.language.length > 0 ? record.language : null,
    account: {
      acct: account.acct,
      displayName: typeof account.displayName === 'string' ? account.displayName : null,
      verified: account.verified === true,
    },
  };
}

/** A post's blocks as its own HTML describes them, for a post the DOM has not rendered
 *  yet.
 *
 *  This is the minority path — `captureNetwork` prefers the DOM's blocks whenever the post
 *  is already on screen — and it exists because the payload lands first: a post the reader
 *  has not reached yet has no element to read, and refusing to classify it until it
 *  renders would put the buttons back on the slow path this platform's API exists to
 *  avoid. `DOMParser` is what makes it safe to run on page-authored data: its document is
 *  inert, so nothing in a post's HTML can load, run, or reach the live page. */
function blocksFromContent(html: string): string[] {
  let parsed: Document;
  try {
    parsed = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return [];
  }
  const children = Array.from(parsed.body.children);
  const blocks = children.length > 0 ? children : [parsed.body];
  const out: string[] = [];
  for (const block of blocks) {
    // Imported into this document so the same invisibility rules apply — `passageTextContent`
    // reads `getComputedStyle`, which a foreign document's nodes cannot answer. Detached,
    // so it is never laid out, and class- and attribute-driven hiding (which is what a
    // Mastodon fork uses for its `span.invisible` URL prefixes) is still honoured.
    let text = '';
    try {
      text = passageTextContent(document.importNode(block, true) as HTMLElement).trim();
    } catch {
      text = (block.textContent ?? '').trim();
    }
    if (text) out.push(text);
  }
  return out;
}

/** The quoted post as the `quoting` field carries it.
 *
 *  Its body is taken from the PAYLOAD even when the card is on screen, where every other
 *  text on this platform prefers the DOM. The reason the others prefer it does not apply
 *  here: those strings are what the highlight layer searches the painted element for, so
 *  they have to come from the extractor that reads that element. A quoted post is context,
 *  never highlighted, and its card may not be rendered at all — reading it from the markup
 *  when it happens to be on screen would let the same post hash two ways. */
function quotedTweet(quoted: NetQuoted): QuotedTweet {
  const id = ID_PREFIX + quoted.id;
  const text = blocksFromContent(quoted.content).join(POST_JOIN);
  return {
    id,
    text,
    fullText: text,
    username: quoted.account.acct,
    usertype: quoted.account.verified ? TS_VERIFIED : TS_REGULAR,
    conversationId: id,
  };
}

export const truthSocialAdapter: PlatformAdapter = {
  id: 'truthsocial',
  hosts: PLATFORM_HOSTS.truthsocial ?? [],

  postIdFromUrl(url) {
    // Both permalink forms: the `/@handle/posts/<id>` the app itself writes, and the
    // `/@handle/<id>` a canonical Mastodon URL uses, which opens the same post. They are
    // matched separately because the id is the first group in one and the second in the
    // other.
    const posts = url.pathname.match(POST_PATH_RE);
    if (posts) return ID_PREFIX + posts[1];
    const canonical = url.pathname.match(CANONICAL_PATH_RE);
    return canonical ? ID_PREFIX + canonical[2] : null;
  },

  postRoots,
  textRegions: postRegions,

  postIdOf(root) {
    return root.matches(STATUS_SELECTOR) || isDetailRoot(root) ? postIdOfElement(root) : null;
  },

  textElement(root) {
    return postParts(root)[0]?.el ?? null;
  },

  /** A post or a reply, judged for length — see LONG_FORM_CHARS.
   *
   *  A reply is this platform's comment, and comments always get buttons whatever their
   *  length; this decides only how a SELECTION inside one is read. Reply-ness comes from the
   *  payload's `in_reply_to_id` (see `replyParents`) because the markup does not state it, and
   *  the sample that settled it — one thread's `context/descendants`, which is what the
   *  interceptor feeds the adapter — ran at a median of 61 characters with a p90 of 270, the
   *  short shape this exemption is for. That is the same rule its software family already
   *  follows: Mastodon refuses replies by `threadParents`, and this is the same fork.
   *
   *  Measured on the host's own clamp state as well as on the count, because the clamp is a
   *  height and a narrow column reaches it well before the number does. */
  isLongForm(root) {
    const id = postIdOfElement(root);
    if (!id) return false;
    if (replyParents.has(id)) return false;
    return bodyClamped(root) || postText(root).length >= LONG_FORM_CHARS;
  },

  /** Show the whole body once we have painted marks into it.
   *
   *  The host clamps a long body with `max-h-40` and `overflow-hidden` ON THE BODY ELEMENT
   *  ITSELF — measured on a live tag feed, a 646-character post laid out 160px tall with
   *  136px of its text behind the clamp — and keeps the whole string in the DOM, so a painted
   *  claim can be sitting in words the reader cannot see. The clamp above the fold on a
   *  multi-paragraph post is on `markup`, which is the PARENT of the block `textElement`
   *  hands back, so the search goes through `closest` rather than clearing on the element it
   *  is given: clearing the child would leave the clamp exactly where it was. (On a
   *  one-paragraph post the two are the same element, so this covers both.)
   *
   *  Cleared on the body, and nowhere else. Measured afterwards for twelve seconds: the box
   *  stayed open (160px -> 292px, `max-height` reading `none` throughout), so the host does
   *  not re-clamp behind us and this need not be re-applied. Unlike LinkedIn's, this host does
   *  NOT withdraw its own "Show More" when the body stops overflowing — it stays, and is
   *  left there: it is React's node inside the very subtree our `<span class="mf-segment-wrap">`
   *  lives in, and a node deleted from outside React is the classic way to break
   *  reconciliation on the host's next render. It is also harmless — the body is already
   *  fully shown, so a reader who presses it only sets the state the render is already in,
   *  and it goes then.
   *
   *  Nothing here changes the text — the clamped body already holds all of it — so the hash
   *  and the id are untouched either way. */
  unclip(textElement) {
    const body = textElement.closest(MARKUP_SELECTOR) ?? textElement;
    if (!(body instanceof HTMLElement)) return;
    body.style.maxHeight = 'none';
    body.style.overflow = 'visible';
  },

  // A Truth Social body is markup the fork rendered: paragraphs, live links and mentions
  // as their own anchors, inline custom-emoji images, and (in a shared post) a card. The
  // rebuild path X's tweets tolerate would flatten all of that into one plain paragraph,
  // so highlights go over the post's own text nodes instead.
  highlightInPlace: true,

  placeButtons(container, root) {
    sealHostEvents(container);
    const header = headerRow(root);
    // A post whose byline block or timestamp is missing cannot be placed: the container
    // stays detached and the post keeps working as a web selection. See `placeButtons` in
    // types.ts for why a plausible-looking fallback is worse than none.
    if (!header) return;
    // The row lays its cells out with `justify-between`, so a third child inserted without
    // this would be spread into the gap between the name column and the trailing cell —
    // the middle of the row, not its right end. `margin-left: auto` absorbs the free space
    // ahead of the pill instead, which is what puts it at the right-hand end of the
    // header line, beside the host's own trailing control rather than after it.
    container.style.marginLeft = 'auto';
    container.style.alignSelf = 'center';
    // The row stretches its children vertically; a pill left to stretch would be drawn as
    // tall as the avatar.
    const trailing = header.lastElementChild;
    if (trailing && trailing !== container) {
      if (container.parentElement !== header || container.nextElementSibling !== trailing) {
        header.insertBefore(container, trailing);
      }
      return;
    }
    header.appendChild(container);
  },

  feedCenter() {
    // Derived from the posts rather than from a page container: the content column is
    // exactly what the posts span, so its center is the feed's center at any window width
    // and whether or not the right rail is present. Null (the caller's viewport fallback)
    // when nothing is rendered yet.
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

  isPostTarget(id) {
    return postRoots(id).length > 0;
  },

  postElementFor(node) {
    return nearestPost(node);
  },

  captureRoots() {
    return allPostRoots();
  },

  /** The fallback half: a post rendered from a cache, or from a response this page load
   *  never carried, is still fact-checked. It knows nothing the API knows — no language, no
   *  parent — and says so rather than guessing. */
  capture(root: Element): CapturedPost | null {
    const id = postIdOfElement(root);
    if (!id) return null;
    // An advertisement the payload named is left to the platform. This half only knows the
    // ones a response has already described — see `sponsoredIds`.
    if (sponsoredIds.has(id)) return null;
    const text = postText(root);
    // A media-only status carries nothing to fact-check. Returning null keeps it out of
    // the batch rather than spending a classification on an empty string.
    if (!text) return null;

    const post = {
      id,
      text,
      // The DOM is the only source here, so the displayed text IS the authored text. X
      // separates these because its payload carries both a note_tweet expansion and the
      // legacy body; markup has no such split.
      fullText: text,
      username: handleOf(root),
      usertype: isVerified(root) ? TS_VERIFIED : TS_REGULAR,
      // Nothing on the page says which conversation a post belongs to.
      conversationId: id,
      // Null here for the same reason `replyingTo` is, and it is a stronger case: the quoted
      // post's ID is not in the markup at all — its timestamp is not inside an anchor — so a
      // quoted post read off this half could not even be named, let alone hashed. The payload
      // carries both, so `captureNetwork` fills it.
      quoting: null,
      // Null here, and filled by `captureNetwork` when the payload is what described this
      // post: `in_reply_to_id` is the platform's own statement of the parent, and the DOM
      // has no such pointer — the byline names the handle it answers, not the id.
      replyingTo: null,
    } as MainTweet;

    // No language in the markup either: the only `lang` in the page is `<html lang>`, the
    // app's own UI locale. The shared unknown-language fallback names it instead of the
    // reader's locale being mistaken for the post's.
    return { post, replyParentId: null };
  },

  /** The preferred half: posts as Truth Social's own API described them.
   *
   *  Each record carries a post's language and its parent id, neither of which the markup
   *  has, and it arrives before the post is rendered. The TEXT still comes from the DOM
   *  whenever the post is already on screen — see `blocksFromContent` — because the
   *  highlight layer locates its slices by searching the painted element's passage, so the
   *  classified text and that passage have to be produced by one extractor.
   *
   *  Shares are read in two passes because a card and the post it shows are named
   *  differently: the payload names the embedded post, the card names the sharer. Learning
   *  the pairing first is what lets the loop below find the card and take that embedded
   *  post's text, author and verification off it. */
  captureNetwork(records: unknown[]): CapturedPost[] {
    const captured: CapturedPost[] = [];
    const seen = new Set<string>();
    for (const value of records.slice(0, MAX_NETWORK_RECORDS)) {
      const record = asNetStatus(value);
      if (!record) continue;
      const card = ID_PREFIX + record.id;
      // A retruth's record IS the post it wraps (the interceptor read through the envelope),
      // so its envelope names the card; a quote keeps its own id and names the post it quotes.
      if (record.wrapperId) remember(retruthShows, ID_PREFIX + record.wrapperId, card);
      if (record.quoted) remember(quoteNames, card, ID_PREFIX + record.quoted.id);
    }
    for (const value of records.slice(0, MAX_NETWORK_RECORDS)) {
      const record = asNetStatus(value);
      if (!record) continue;
      const id = ID_PREFIX + record.id;
      if (seen.has(id)) continue;
      seen.add(id);
      // An edge, not a post: recorded before anything below can skip the record, because
      // whether this post was written in reply to another is true of it either way, and
      // `isLongForm` asks it about posts this loop never captured.
      rememberReplyParent(id, record.inReplyToId);
      // Named here so the markup half can skip it too, then dropped: an advertisement is not
      // something the reader asked to have fact-checked.
      if (record.sponsored) {
        rememberSponsored(id);
        continue;
      }

      // A card that shows another post in place of a body of its own has nothing to classify,
      // and the DOM is the authority on that: the payload's text for such a post is the
      // `RT: <url>` marker the renderer strips, and spending a classification on words nobody
      // can see is exactly what this platform's API is used to avoid. The post it shows is
      // classified under its own id, from the same card.
      if (record.quoted && rootsNamed(id).some((named) => showsOnlyEmbedded(named))) continue;

      // The DOM is preferred for the text and it is also the authority when it is present:
      // it is what the reader is looking at and what the highlighter will paint into.
      const root = postRoots(id)[0] ?? null;
      const text = root ? postText(root) : blocksFromContent(record.content).join(POST_JOIN);
      if (!text) continue;

      const post = {
        id,
        text,
        fullText: text,
        username: root ? handleOf(root) : record.account.acct,
        // The DOM is asked first when there is one — a badge the page is showing is the
        // post's verification status as this reader sees it.
        usertype: (root ? isVerified(root) : record.account.verified) ? TS_VERIFIED : TS_REGULAR,
        conversationId: id,
        // The post this one quotes, quoted verbatim from the same payload that named its id,
        // so a quoting post's hash and the context it is classified in both carry it.
        quoting: record.quoted ? quotedTweet(record.quoted) : null,
        replyingTo: null,
        // The payload's own statement of the post's language. Absent (rather than guessed)
        // when the platform did not give one, so the shared unknown-language fallback keys
        // the highlights instead of the reader's UI locale.
        ...(record.language ? { sourceLanguage: record.language } : {}),
      } as MainTweet;

      captured.push({
        post,
        replyParentId: record.inReplyToId ? ID_PREFIX + record.inReplyToId : null,
      });
    }
    return captured;
  },
};
