/** The Bluesky adapter.
 *
 *  Bluesky is a React-Native-Web SPA: every post is fed by an XRPC JSON response, and the
 *  markup is `div`s whose classes are build hashes (`css-g5y9jx`, `r-13awgt0`). Those are
 *  regenerated on every deploy, so nothing below keys on a class. What it keys on instead
 *  is what bsky.app itself needs to stay testable: its `data-testid` vocabulary, its
 *  `data-word-wrap` marker, and the permalink structure of its own hrefs.
 *
 *  Two things the markup does NOT carry, both verified by live probe rather than assumed
 *  (see the file's notes on `replyParentId` and `sourceLanguage`): a post's ancestor chain
 *  and its text language. Bluesky's DOM renders a thread as a FLAT, uniformly-indented
 *  list — every thread item is a sibling with identical geometry and no nesting — so there
 *  is no indent to read and no parent pointer to follow. **Those two fields, and a quoted
 *  post's, come from the platform's own API instead**, which is why this adapter has a
 *  network half: `captureNetwork` below reads the records `entrypoints/bsky.capture.content.ts`
 *  forwards from every `/xrpc/` response, and the markup half is the fallback rather than
 *  the source. That interceptor matching the PATH rather than an endpoint list is what
 *  keeps it current — measured 2026-10-01, the thread page had moved to
 *  `app.bsky.unspecced.getPostThreadV2`, an endpoint name nothing here has ever listed.
 *
 *  **Nothing is truncated here**, so the markup half's ordinary `textContent` read is
 *  already the whole text. bsky does put `-webkit-line-clamp: 20` with `overflow: clip` on
 *  a post body (and 2- and 3-line clamps on display names), but a clamp is a VISUAL cut
 *  that leaves `textContent` complete, and on 991 sampled posts the longest body was 304
 *  characters with p99 at 300 and none over 1000 — a body would need roughly twenty
 *  rendered lines to reach that clamp, and bsky's own post cap cannot get there. Measured
 *  across a scrolled home feed and two search feeds: no body clamped, and no "Show more"
 *  control anywhere on the page.
 */
import type { MainTweet, Usertype } from '../../data/Tweets';
import { Usertype as UsertypeEnum } from '../../data/Tweets';
import { sealHostEvents } from '../injecting';
import { PLATFORM_HOSTS } from './hosts';
import type { CapturedPost, PlatformAdapter } from './types';

/** Bluesky ids are `(handle, rkey)` pairs, and neither half is globally unique on its own:
 *  the rkey is a per-repo record key. Both halves go in, and the platform name goes in
 *  front of them: the background fans a classification out to EVERY connected relay rather
 *  than keying by tab, so an unnamespaced id could otherwise be injected into an unrelated
 *  X timeline. */
const ID_PREFIX = 'bsky:';

function namespaced(handle: string, rkey: string): string {
  return `${ID_PREFIX}${handle}/${rkey}`;
}

/** The one href shape that names a post. On a feed a post carries its bare permalink; the
 *  focused post of a thread view has no bare permalink at all and instead carries the
 *  count links that hang off it (`/reposted-by`, `/liked-by`, `/quotes`), which share the
 *  same `/profile/<handle>/post/<rkey>` prefix. One regex covers both — and the trailing
 *  `/` in the optional segment is load-bearing, so that `/post/<rkey>` does not also match
 *  a longer unrelated path. */
const POST_HREF_RE = /^\/profile\/([^/]+)\/post\/([A-Za-z0-9]+)(?:\/|$)/;

/** Every element bsky.app puts around a single post, by the id it gives that element.
 *
 *  There are two vocabularies and they do NOT overlap: a feed item is
 *  `feedItem-by-<handle>` and a thread item is `postThreadItem-by-<handle>`, while some
 *  views (search, hashtag) carry no testid at all and must be found structurally. Verified
 *  on a thread page that a `postThreadItem` contains no `role="link"` wrapper whatsoever —
 *  its only `role="link"` descendants are `<a>` tags — so the role-based branch below is
 *  the feed/search shape and cannot be relied on for threads. */
const CONTAINER_SELECTOR =
  '[data-testid^="feedItem-by-"], [data-testid^="postThreadItem-by-"], div[role="link"]';

/** The markers that make a bare `div[role="link"]` a post rather than any other link the
 *  app draws. Only consulted on the structural branch: an element carrying a `feedItem-by`
 *  or `postThreadItem-by` testid is a post by definition. */
const POST_MARKER_SELECTOR = '[data-testid="postText"], [data-testid="replyBtn"]';

function isPostContainer(el: Element): boolean {
  const testid = el.getAttribute('data-testid') ?? '';
  if (testid.startsWith('feedItem-by-') || testid.startsWith('postThreadItem-by-')) return true;
  return el.tagName === 'DIV'
    && el.getAttribute('role') === 'link'
    && !!el.querySelector(POST_MARKER_SELECTOR);
}

/** A post's own text element: the word-wrap that belongs to THIS container.
 *
 *  `[data-word-wrap]` is on the text of a post and of every post it quotes. A quoted post
 *  renders as a nested container, so a plain `querySelector` would hand back the QUOTED
 *  post's words as if they were the outer post's. The check is therefore by ownership —
 *  walk up from the candidate and take it only if the nearest post container is the
 *  container being read — which makes the choice correct on any nesting depth rather than
 *  relying on the quote happening to come after the text in document order.
 *
 *  `data-testid="postText"` rides on the same element in the views that carry it (feeds,
 *  profile, search) and is absent on thread items, where `data-word-wrap` is the only
 *  marker — hence the union, which yields each element once in document order. */
function bodyElement(root: Element): Element | null {
  const candidates = root.querySelectorAll('[data-testid="postText"], [data-word-wrap]');
  for (const candidate of Array.from(candidates)) {
    if (owningContainer(candidate) === root) return candidate;
  }
  return null;
}

/** The INNERMOST post container an element sits in, id or no id — which is what
 *  distinguishes a post's own text from the text of a post it quotes. `nearestPost` cannot
 *  answer this: it deliberately skips past an id-less nested container to the outer post,
 *  so asking it would report a quote's words as the outer post's. */
function owningContainer(node: Node | null): Element | null {
  let el = node?.nodeType === Node.ELEMENT_NODE ? (node as Element) : node?.parentElement ?? null;
  for (; el; el = el.parentElement) {
    if (isPostContainer(el)) return el;
  }
  return null;
}

/** The post that owns an element, as its OUTERMOST container — or null when nothing
 *  post-shaped encloses it.
 *
 *  Walking up rather than using `closest` matters twice over. A quoted post's nested
 *  container matches the container selector yet has no anchors of its own, so it yields no
 *  id and the walk has to continue to the post that owns the quote. And continuing to the
 *  OUTERMOST container with an id — rather than stopping at the first — is what makes this
 *  agree with `allPostRoots()` on which element stands for a post, since a feed renders the
 *  post inside a `role="link"` wrapper and both match. A caller comparing the two, or
 *  asking `postIdOf` of the result, then gets the same answer either way. */
function nearestPost(node: Node | null): Element | null {
  let found: Element | null = null;
  let el = node?.nodeType === Node.ELEMENT_NODE ? (node as Element) : node?.parentElement ?? null;
  for (; el; el = el.parentElement) {
    if (isPostContainer(el) && postIdOfElement(el)) found = el;
  }
  return found;
}

function postIdOfElement(root: Element): string | null {
  for (const anchor of Array.from(root.querySelectorAll('a[href]'))) {
    const href = anchor.getAttribute('href') ?? '';
    const match = href.match(POST_HREF_RE);
    if (match) return namespaced(canonicalHandle(match[1]), match[2]);
  }
  return null;
}

/** Every `did → handle` pair seen in an XRPC response, for the life of the page.
 *
 *  A Bluesky post's uri names its author by DID (`at://did:plc:…/app.bsky.feed.post/…`),
 *  while the extension ids every post by handle, so the two have to be bridged somewhere.
 *  This is that bridge, and it is filled only with pairs the server itself sent — a post's
 *  author carries both. Two things depend on it: a reply's parent, whose uri arrives as a
 *  bare DID, and a permalink rendered in DID form, which would otherwise be a SECOND id
 *  for a post already captured and billed under its handle. */
const didToHandle = new Map<string, string>();

/** A profile name from a permalink as the extension should key it: a DID is resolved
 *  through the map when the page has told us its handle, and left alone otherwise (an
 *  unresolved DID still names one post consistently, which is all an id has to do). */
function canonicalHandle(name: string): string {
  return name.startsWith('did:') ? (didToHandle.get(name) ?? name) : name;
}

/** The rkey half of a post uri — the record key, unique within its repo. */
function rkeyOfUri(uri: string): string | null {
  const match = uri.match(/\/app\.bsky\.feed\.post\/([A-Za-z0-9]+)/);
  return match?.[1] ?? null;
}

/** The extension id for a post uri, or null when it names no post or its author cannot be
 *  named. `handle` short-circuits the DID map for a response that carries both. */
function idOfUri(uri: string, handle: string | null): string | null {
  const rkey = rkeyOfUri(uri);
  if (!rkey) return null;
  const did = uri.match(/^at:\/\/([^/]+)\//)?.[1] ?? '';
  const name = handle ?? (did ? didToHandle.get(did) : undefined);
  return name ? namespaced(name, rkey) : null;
}

export interface NetAuthor {
  handle: string;
  did: string | null;
  displayName: string | null;
  verification: { verifiedStatus: string | null; trustedVerifierStatus: string | null } | null;
}

export interface NetPost {
  uri: string;
  text: string;
  langs: string[] | null;
  parentUri: string | null;
  author: NetAuthor;
  quote: { uri: string; text: string; author: NetAuthor } | null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Validate one forwarded record. These arrive from the page, so every field is checked
 *  and nothing is coerced: a record that does not carry a post's own uri, an author and a
 *  body is dropped rather than filled in with a default. */
function asNetPost(value: unknown): NetPost | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, any>;
  const uri = str(o.uri);
  const text = typeof o.text === 'string' ? o.text : null;
  const author = asNetAuthor(o.author);
  if (!uri || text === null || !author || !uri.includes('/app.bsky.feed.post/')) return null;
  const quoteAuthor = o.quote ? asNetAuthor(o.quote.author) : null;
  return {
    uri,
    text,
    langs: Array.isArray(o.langs) ? o.langs.filter((l: unknown) => typeof l === 'string') : null,
    parentUri: str(o.parentUri),
    author,
    quote: o.quote && quoteAuthor && typeof o.quote.text === 'string' && str(o.quote.uri)
      ? { uri: str(o.quote.uri)!, text: o.quote.text, author: quoteAuthor }
      : null,
  };
}

function asNetAuthor(value: unknown): NetAuthor | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, any>;
  const handle = str(o.handle);
  if (!handle) return null;
  const v = o.verification;
  return {
    handle,
    did: str(o.did),
    displayName: str(o.displayName),
    verification: v && typeof v === 'object'
      ? {
          verifiedStatus: str(v.verifiedStatus),
          trustedVerifierStatus: str(v.trustedVerifierStatus),
        }
      : null,
  };
}

/** The handle half of a namespaced id — the account a post belongs to. */
function handleOf(id: string): string {
  const rest = id.startsWith(ID_PREFIX) ? id.slice(ID_PREFIX.length) : id;
  return rest.split('/')[0] ?? '';
}

/** The account's display-name anchor, which is where the verification badge attaches.
 *
 *  An account renders two profile anchors at the top of its post: the display name, then
 *  `@handle`. The display name is the one whose text does not begin with `@` — and bsky
 *  writes the handle anchor's leading space as `&nbsp;`, so the check is made after
 *  stripping whitespace. A display name that genuinely begins with `@` would be read as
 *  the handle anchor; the cost is only that the badge is missed, never that a badge is
 *  invented. */
function displayNameAnchor(root: Element): Element | null {
  const anchors = Array.from(root.querySelectorAll('a[href^="/profile/"]'));
  return anchors.find((a) => {
    const text = (a.textContent ?? '').replace(/ /g, ' ').trim();
    return text.length > 0 && !text.startsWith('@');
  }) ?? null;
}

/** Whether the account carries Bluesky's verification badge.
 *
 *  A verified account renders a text-free `<div>` holding an `<svg>` between the display
 *  name and the handle; an unverified account renders no such element AT ALL (verified
 *  live against a verified and an unverified account on the same page). The empty text and
 *  the `svg` are both required: the avatar sits in the same row as a text-free `<div>`, and
 *  what distinguishes it is that it holds an `<img>`, not an `<svg>`. */
function isVerified(root: Element): boolean {
  const row = displayNameAnchor(root)?.parentElement;
  if (!row) return false;
  for (const el of Array.from(row.querySelectorAll('div'))) {
    if ((el.textContent ?? '').trim() === '' && el.querySelector('svg')) return true;
  }
  return false;
}

const BSKY_VERIFIED: Usertype = UsertypeEnum.Verified;
const BSKY_UNVERIFIED: Usertype = UsertypeEnum.Regular;

/** Whether an author payload says the account wears a badge.
 *
 *  Bluesky has two: a Bluesky-issued verification (`verifiedStatus: "valid"`) and the
 *  trusted-verifier status Bluesky itself wears. Both render as the same text-free
 *  badge element this file's DOM check looks for — verified live against `bsky.app`
 *  (trusted verifier, `verifiedStatus: "none"`), three Bluesky-verified accounts
 *  (`verifiedStatus: "valid"`), and an unverified one (neither), where the DOM badge and
 *  this rule agreed on all five. Reading only `verifiedStatus` would drop the badge from
 *  every trusted-verifier account, and the badge is part of what the classifier is told. */
function authorIsVerified(author: NetAuthor): boolean {
  const v = author.verification;
  return v?.verifiedStatus === 'valid' || v?.trustedVerifierStatus === 'valid';
}

/** A network post as the classify pipeline's own shape.
 *
 *  `username` is the HANDLE, not the display name, even though X puts a display name
 *  there: the DOM half of this same adapter sets the handle, and `computeTweetHash` mixes
 *  the username in — so a display name here would give one post two hashes depending on
 *  which half captured it, which reads as a cache miss and re-bills the user. */
function postFromNetwork(record: NetPost): MainTweet | null {
  const id = idOfUri(record.uri, record.author.handle);
  if (!id) return null;
  // The same rule the DOM half applies (a body-less post carries nothing to fact-check),
  // and the same trim, so that one post cannot hash two ways.
  const text = record.text.trim();
  if (!text) return null;

  const quoteId = record.quote ? idOfUri(record.quote.uri, record.quote.author.handle) : null;
  const quoteText = record.quote ? record.quote.text.trim() : '';
  const quoting = record.quote && quoteId && quoteText
    ? {
        id: quoteId,
        text: quoteText,
        fullText: quoteText,
        username: record.quote.author.handle,
        usertype: authorIsVerified(record.quote.author) ? BSKY_VERIFIED : BSKY_UNVERIFIED,
        conversationId: quoteId,
      }
    : null;

  const post: MainTweet = {
    id,
    text,
    fullText: text,
    username: record.author.handle,
    usertype: authorIsVerified(record.author) ? BSKY_VERIFIED : BSKY_UNVERIFIED,
    conversationId: id,
    quoting,
    replyingTo: null,
  };
  const lang = record.langs?.find((l) => typeof l === 'string' && l.length > 0);
  if (lang) post.sourceLanguage = lang;
  return post;
}

/** Most records one forwarded message may carry. A response is page-controlled data, so
 *  the work a single message can cause is bounded before any of it is read. */
const MAX_NETWORK_RECORDS = 400;

/** The post's top header band — the row carrying the author name, the handle and the
 *  timestamp.
 *
 *  A bsky post is a column of [header row, body, action bar]. The header row is a
 *  `flex/row` with `flex-grow: 1` holding a shrink-wrapped cluster of
 *  [name][handle][· time], and the column that holds the body sits immediately above it.
 *  So walking up from the display-name anchor and stopping at the first ancestor that
 *  contains the body lands exactly on the header band: measured on a feed item, the path
 *  is A(name) → 3 nested rows → the header row (515px wide, `flex/row`,
 *  `align-items: center`, `grow: 1`) → the content column, which is the first ancestor to
 *  contain the body.
 *
 *  Two things are deliberately not used here: no class name (they are build hashes) and no
 *  reading of the timestamp's own text — a relative time is `21h` in English and something
 *  else elsewhere, and bsky shows an absolute date on older posts.
 *
 *  `align-items: stretch` is a stop as well as a skip. A row that stretches its children
 *  is never the header band — the avatar row is one (measured: `flex/row`,
 *  `align-items: stretch`, containing the whole post) — and a pill dropped into one is
 *  stretched to the row's full width, which is the full-width bar this replaced. It also
 *  gives media-only posts, which have no body to stop at, a correct answer: their walk
 *  reaches the avatar row, skips it, and keeps the header found below it. */
function headerRow(root: Element): Element | null {
  const name = displayNameAnchor(root);
  if (!name) return null;
  const body = bodyElement(root);
  let header: Element | null = null;
  for (let el: Element | null = name; el && el !== root; el = el.parentElement) {
    if (body && el.contains(body)) break;
    const style = getComputedStyle(el);
    if (style.display.includes('flex') && style.flexDirection === 'row' && style.alignItems !== 'stretch') {
      header = el;
    }
  }
  return header;
}

/** The element our controls may be placed in: the header band CONTAINING the author's link,
 *  never the link itself.
 *
 *  `headerRow` keeps the OUTERMOST row it walks past, and in React-Native-Web the author's
 *  profile anchor is itself a `flex/row/ai:center` box — so on a thread root the anchor IS what
 *  it returns, and appending there parked the pill inside `<a href="/profile/<handle>">`. Every
 *  press on it therefore also navigated to the author's profile: a link's navigation is a
 *  default action, which no amount of `stopPropagation` cancels. bsky draws its own Follow
 *  button as a SIBLING of that anchor rather than a child of it (measured: the band row is
 *  `[avatar, author anchor, Follow]`), and that is the shape copied here. The walk also returns
 *  null rather than the anchor if it finds nothing better, leaving the caller its fallback.
 *
 *  The row must not hold the post body: a row that does is the avatar row (a whole feed item's
 *  content sits beside its avatar), and the pill dropped in one spans the post. The stretch
 *  guard in `headerRow` skips that row, which is precisely why the anchor below it wins there. */
function bandHost(header: Element, root: Element): Element | null {
  const link = header.closest('a[href]');
  const body = bodyElement(root);
  for (let el: Element | null = link ? link.parentElement : header; el && root.contains(el); el = el.parentElement) {
    if (el.closest('a[href]')) continue;
    const style = getComputedStyle(el);
    if (!style.display.includes('flex') || style.flexDirection !== 'row') continue;
    if (body && el.contains(body)) return null;
    return el;
  }
  return null;
}

/** The host's own trailing control inside the band — bsky's Follow button, wrapped in a plain
 *  `div` — so the pill is inserted to its LEFT at the right end of the line. Null when the band
 *  holds no such control, which is the common case: only an account the reader does not follow
 *  has a Follow button, and then the pill takes the row's right end itself.
 *
 *  Our own container is skipped rather than treated as the end of the row. It is a child of this
 *  same row and can already be sitting last (the Follow button renders late, after the first
 *  placement), so a plain "look at the last child" test would find our pill, conclude there is
 *  no control to sit beside, and leave it parked on the wrong side of the button for good. */
function trailingControl(host: Element): Element | null {
  for (let el = host.lastElementChild; el; el = el.previousElementSibling) {
    if (el.matches("[mf-top-bar-id]") || el.querySelector("[mf-top-bar-id]")) continue;
    return el.querySelector('button, [role="button"]') ? el : null;
  }
  return null;
}

/** Every post currently RENDERED, outermost container only.
 *
 *  A quoted post is a container nested inside the post quoting it, so the sweep has to drop
 *  any container that has a container above it — otherwise the quote would be captured
 *  twice, once as the outer post (its own text plus the quote's) and once as a post of its
 *  own. It cannot be captured on its own even in principle: a quote renders WITH NO
 *  ANCHORS, so nothing inside it names it and it can never be addressed, classified or
 *  highlighted.
 *
 *  Rendered-ness is filtered here, at the single point every consumer goes through, so that
 *  capture, injection and centering cannot disagree about which posts exist. */
function allPostRoots(): Element[] {
  const out: Element[] = [];
  for (const el of Array.from(document.querySelectorAll(CONTAINER_SELECTOR))) {
    if (!isPostContainer(el)) continue;
    if (el.parentElement?.closest(CONTAINER_SELECTOR) && nearestPost(el.parentElement)) continue;
    if (!isRendered(el)) continue;
    out.push(el);
  }
  return out;
}

/** Whether a post is actually laid out on the page.
 *
 *  A thread page renders the SAME post twice: the visible column, and a second `0×0`
 *  `postThreadScreen` that holds the whole thread rather than the part on screen (measured:
 *  17 items at zero size against 2 rendered). Reading the raw container set therefore
 *  classified the entire hidden thread — posts the reader cannot see, and would not
 *  understand being charged for — and it also put buttons into a subtree nothing displays.
 *  Width is the test rather than an ancestor check because the collapse is on the subtree
 *  root, not on the post, so there is no stable attribute to look for.
 *
 *  A post missed because it was mid-render at the moment of a sweep is picked up by the
 *  next one: the relay re-sweeps on every host mutation, and rendering a post IS a
 *  mutation. */
function isRendered(root: Element): boolean {
  return root.getBoundingClientRect().width > 0;
}

function postRoots(id: string): Element[] {
  return allPostRoots().filter((root) => postIdOfElement(root) === id);
}

export const blueskyAdapter: PlatformAdapter = {
  id: 'bluesky',
  hosts: PLATFORM_HOSTS.bluesky ?? [],

  postIdFromUrl(url) {
    const match = url.pathname.match(/^\/profile\/([^/]+)\/post\/([A-Za-z0-9]+)/);
    return match ? namespaced(match[1], match[2]) : null;
  },

  postRoots,

  postIdOf(root) {
    return isPostContainer(root) ? postIdOfElement(root) : null;
  },

  textElement(root) {
    return bodyElement(root);
  },

  // No `isLongForm`, deliberately: Bluesky caps a post well below `LONG_FORM_CHARS` — the
  // home feed measured 23 posts with a longest of 302 characters — so no post here is ever
  // long-form and the hook could only ever answer false.

  // A Bluesky body is text with live facets — links, mentions, hashtags — each rendered as
  // its own anchor, plus inline emoji images. Rebuilding it from the classified text, which
  // is what a tweet body tolerates, would flatten every one of those into plain characters
  // and delete the emoji. Highlights go over the page's own text nodes instead.
  highlightInPlace: true,

  placeButtons(container, root) {
    // The post's top line, immediately after the author cluster:
    // `name @handle · 3h [ Disinfact ]`.
    //
    // Two earlier placements were both wrong. `root.prepend` put the container above a
    // reply's 12px rail spacer — the block that continues the vertical rail connecting a
    // reply to its parent — so the buttons sat in the gutter between two posts. Inserting
    // it before the author row (as a child of the post's own column) fixed that but drew a
    // full-width bar across the top of the post, because the post's column is a flex
    // container and `align-items: stretch` stretched our `inline-flex` pill to its full
    // width. The header band is a ROW, so a pill placed in it is sized by its own content.
    //
    // A third one is fixed here: floating the pill to the band's right end with
    // `margin-left: auto`. The band spans the content column and the author cluster ends at
    // the timestamp, so `auto` parked the pill 86–179px to the right of the time it belongs
    // to (measured on the live feed, five posts at a 1400px window). Beside the time is the
    // seat a comment takes on every platform here, and on a post it is the end of the
    // header's own text.
    //
    // Placement is the first moment the container exists and it can be clicked before the
    // bar's first sync, so seal it here as well; the call is idempotent and is the same
    // shared seal the sync applies.
    sealHostEvents(container);

    const header = headerRow(root);
    const host = header ? bandHost(header, root) : null;
    if (host) {
      // The band row stretches its children vertically; a pill left to stretch would be drawn
      // as tall as the avatar.
      container.style.alignSelf = 'center';
      const trailing = trailingControl(host);
      if (trailing) {
        // The host's own trailing control — bsky's Follow button — takes the band's right end
        // and is held there by the slack our `auto` margin consumes, so joining it keeps that
        // control where bsky drew it.
        container.style.marginLeft = 'auto';
        if (container.parentElement !== host || container.nextElementSibling !== trailing) {
          host.insertBefore(container, trailing);
        }
        return;
      }
      // No control of the host's in the band (the ordinary case — measured on all eight bands
      // sampled across a feed and a profile): the author cluster is the band's last child, so
      // appending puts the pill directly to the right of the timestamp.
      container.style.marginLeft = '';
      if (container.parentElement !== host || container.nextElementSibling !== null) {
        host.appendChild(container);
      }
      return;
    }
    // No header band found (an unexpected layout): fall back to the top of the post's own
    // box, before the first child that holds a profile link — which is the author row, and
    // which leaves any rail spacer above it where it belongs.
    container.style.marginLeft = '';
    container.style.alignSelf = '';
    const authorHost = Array.from(root.children).find((child) => child.querySelector('a[href^="/profile/"]'));
    const text = bodyElement(root);
    const textHost = text ? Array.from(root.children).find((child) => child.contains(text)) : null;
    const fallback = authorHost ?? textHost;
    if (fallback) root.insertBefore(container, fallback);
    // Neither an author row nor a body block: leave the container detached. Prepending
    // it to the post's box is what the two placements above were fixed AWAY from — it
    // lands in a reply's rail gutter — and a post carrying our buttons is a post the
    // selection rule hands the user's selection off to, so a misplaced pill would also
    // cost the user the web-select path on this post. Detached, the post keeps working:
    // it simply has no buttons. See `placeButtons` in types.ts.
  },

  feedCenter() {
    // Derived from the posts themselves rather than from a page container: the content
    // column is exactly the horizontal span the posts occupy, so its center is the feed's
    // center whatever the window width and whether or not a sidebar is present. A page
    // container would be wrong on the wide window where the shell fills the viewport while
    // the posts do not. Returns null (the caller's viewport fallback) when nothing is
    // rendered yet.
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

  capture(root: Element): CapturedPost | null {
    const id = postIdOfElement(root);
    if (!id) return null;

    const text = bodyElement(root)?.textContent?.trim() ?? '';
    // A post with no text at all — media-only, or a container bsky renders empty — carries
    // nothing to fact-check. Returning null keeps it out of the batch rather than spending
    // a classification on an empty string. Three such containers were present in the first
    // live sweep of a feed.
    if (!text) return null;

    const post = {
      id,
      text,
      // Bluesky's DOM is the only source here, so the displayed text IS the raw text. X
      // separates these because its JSON carries both a note_tweet expansion and the
      // legacy body; markup has no such split.
      fullText: text,
      username: handleOf(id),
      usertype: isVerified(root) ? BSKY_VERIFIED : BSKY_UNVERIFIED,
      // `conversationId` is not read anywhere in the extension or the workers, so the
      // honest value is this post's own id: on a feed, nothing on the page says which
      // thread a post belongs to.
      conversationId: id,
      // Null here because the markup cannot name a quote, not because there is none. A
      // quoted post renders as a nested container with NO anchors at all — measured
      // 2026-10-01 on three quoted posts: `a[href]` count 0, `/profile/` links 0, while the
      // quoted TEXT was present (149, 180 and 12 characters). So the words are readable and
      // both the id and the author are not, and a `quoting` built from the words alone would
      // be a second, differently-hashed reading of a post the network half already files
      // with its id, handle and badge. The payload is what fills this; see `postFromNetwork`.
      quoting: null,
      // Always null, and NOT for want of looking. A Bluesky thread page renders its items
      // as flat siblings — verified live: all 15 items on a thread page had zero nesting,
      // parent-role links, and identical geometry (same left edge, same width), and opening
      // a reply directly showed that view renders no ancestor at all. There is therefore no
      // DOM source for a reply's parent, and inventing one would put a fabricated
      // conversation in front of the classifier. The real chain exists in the
      // `app.bsky.feed.getPostThread` response, which is what `captureNetwork` reads.
      replyingTo: null,
    } as MainTweet;

    // No language here either, and unlike the parent above there is nothing to go looking
    // for: the markup carries none. Measured on a live feed — the only `lang` in the page is
    // `<html lang>`, which is the app's UI locale, and the post body's attributes are
    // exactly `dir`, `data-word-wrap`, `class`, `data-testid` and `style`. The platform's own
    // statement of a post's language is `record.langs` in the response, so this half leaves
    // the field to the shared unknown-language fallback rather than guessing from the reader.
    return { post, replyParentId: null };
  },

  /** The preferred half: posts as bsky.app's own API described them.
   *
   *  This runs BEFORE the post is on screen, so a reader scrolling a feed gets buttons on
   *  the posts the API already returned rather than on the ones the sweep happens to have
   *  caught — and each post carries its language (which the highlight ranges are keyed by)
   *  and its parent. The DOM half stays in place underneath: the sweep still captures any
   *  post no response covered, which is how a post rendered from a cache or a server-side
   *  render is still fact-checked. */
  captureNetwork(records: unknown[]): CapturedPost[] {
    const parsed: NetPost[] = [];
    for (const value of records.slice(0, MAX_NETWORK_RECORDS)) {
      const record = asNetPost(value);
      if (record) parsed.push(record);
    }

    // Every author is mapped before any parent is resolved: a reply's parent arrives as a
    // bare DID, and the handle that names it usually sits on a different record of the
    // same response (the parent post itself, in a thread), so one pass cannot see it.
    for (const record of parsed) {
      if (record.author.did) didToHandle.set(record.author.did, record.author.handle);
      if (record.quote?.author.did) didToHandle.set(record.quote.author.did, record.quote.author.handle);
    }

    const captured: CapturedPost[] = [];
    for (const record of parsed) {
      const post = postFromNetwork(record);
      if (!post) continue;
      // Resolved whether or not the parent is in this batch: the chain builder links
      // against every post captured on this page, so a parent announced earlier is a
      // valid link, and an unresolvable one is left null rather than guessed at.
      captured.push({
        post,
        replyParentId: record.parentUri ? idOfUri(record.parentUri, null) : null,
      });
    }
    return captured;
  },
};
