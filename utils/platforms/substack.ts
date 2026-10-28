/** The Substack adapter.
 *
 *  Substack is a publishing platform, and only its SOCIAL surfaces are integrated: the
 *  **notes** of the reader (`substack.com`, `/notes`, `/@handle/note/c-<id>`) and the
 *  **comments** under any post. A publication's ARTICLE — the long-form body of
 *  `<pub>.substack.com/p/<slug>`, and the same article previewed as a card in the reader's
 *  post lists — is not a post here and carries no buttons: an article is a page of prose,
 *  which is exactly what the ordinary web selection / right-click flow is for, and dressing
 *  a 9,000-character essay in per-claim buttons is not what this integration is for. So the
 *  article is absent from `postRoots`, from `captureRoots` and from `postElementFor`, which
 *  is also what leaves the selection flow unrestricted across an article page.
 *
 *  Both remaining surfaces are SERVER-RENDERED, which is unusual in this rollout and decides
 *  the design here: every other platform after X had to be read from JSON because its markup
 *  was a hydration artifact that arrived truncated or late. Substack ships the whole note as
 *  HTML on the first byte, so the DOM is complete on arrival and is the better source rather
 *  than the fallback. A note's language is the one thing the DOM cannot answer — see
 *  `publicationLanguage` below.
 *
 *  Anchors are Substack's own semantic names (`comment`, `comment-body`, and the reader's
 *  `feedCommentBody`) plus two attributes that are data rather than style:
 *  a comment's `#comment-<id>` anchor and a feed item's `data-entity-key`. Only where
 *  Substack has no name for a thing — a note's body, which is the one element in its feed
 *  rendered by a rich-text component, and the focal note of a note permalink page, which
 *  carries no attribute at all — does this file fall back to a prefix or structural match,
 *  and neither touches one of the build-hashed utility classes (`pc-gap-12`,
 *  `flex-grow-rzmknG`) that make up the rest of Substack's class soup.
 *
 *  The one structural fact that shapes the comment half: **Substack nests replies inside
 *  their parent's element.** A `div.comment` contains its own header, body and actions AND
 *  a nested list holding every descendant. So `root.textContent` of a parent is the entire
 *  subtree, and every read below is scoped to the comment that owns the node rather than to
 *  the subtree it happens to sit in. Without that, one top-level comment would be classified
 *  as a single post containing the whole thread.
 */
import type { MainTweet, Usertype } from '../../data/Tweets';
import { Usertype as UsertypeEnum } from '../../data/Tweets';
import { PLATFORM_HOSTS } from './hosts';
import { appLanguage } from './capture';
import { isoDatetime } from '../datetime';
import { LONG_FORM_CHARS } from './types';
import type { CapturedPost, PlatformAdapter } from './types';

/** Ids are namespaced for the reason every non-X platform namespaces them: the background
 *  fans a classification out to EVERY connected relay rather than keying by tab, so a bare
 *  numeric id could be injected into an unrelated page. Substack makes this sharper than
 *  most — a note and a post comment share one numeric space (`c-<id>` on both), so the
 *  namespace is what keeps them apart from X's status ids and from every other platform's. */
const ID_PREFIX = 'substack:';

function namespaced(id: string): string {
  return ID_PREFIX + id;
}

/** Whether the page belongs to a publication rather than to the reader.
 *
 *  Found by what the page CONTAINS rather than by class: Substack stamps the same `article`
 *  tag on widgets elsewhere on the page, and the class that distinguishes a publication's
 *  article (`newsletter-post`, `podcast-post`, ...) varies with the post type.
 *  `.post-header` and `.available-content` are the two things only one has.
 *
 *  The article itself is deliberately NOT a post — see this file's header — so this exists
 *  for the one question the page's own shape can answer: which language the comments under
 *  it are written in. */
function publicationPage(): boolean {
  return !!document.querySelector('article .post-header, article .available-content');
}

/** The language a publication's post page declares for its own content.
 *
 *  `<html lang>` on such a page is the publication's language setting — Substack writes it
 *  from the publication's configuration, so it describes what the publication and its
 *  readers write there. Measured on `ayetv.substack.com/p/donald-trump-interview-1987`:
 *  `htmlLang="en"`, with no `inLanguage` in either JSON-LD block, no `lang` on the article
 *  or its body, and no language in any inline JSON — the root element is the only place it
 *  appears at all.
 *
 *  Only a publication page gets this, which is what the `publicationPage()` guard is for.
 *  The reader at the apex mixes several publications' notes into one page whose
 *  `<html lang>` is the READER's UI language, so reading it there would file a Korean note's
 *  ranges under English and lose them. Those posts are left to the shared unknown-language
 *  fallback in `nameCapturedLanguage`, which is a stable key rather than a wrong one. */
function publicationLanguage(): string | null {
  if (!publicationPage()) return null;
  return document.documentElement.lang || null;
}

/** Every comment in a thread, nested ones included. Each is its own root — a reply gets
 *  its own DisinfaX buttons, at its own header, at whatever depth it sits. */
const COMMENT = 'div.comment';
/** A note card in the reader. `data-entity-key` is Substack's own key for a feed item and
 *  carries the entity's id — `c-<n>` for a note, `p-<n>` for a post — so the `c-` prefix
 *  both selects the notes and yields the id, with no second lookup.
 *
 *  The key is Substack's rendering key and not always the CARD's own id: every row of a note
 *  permalink's thread carries the key of the note the page is about. See `ownNoteId`. */
const NOTE_CARD = '[data-entity-key^="c-"]';

/** The id in a comment's own anchor. Substack writes `#comment-<id>` and, next to it,
 *  `#comment-<id>-reply`; the numeric-anchored pattern takes the first and refuses the
 *  second. Scoped by ownership because a parent's subtree contains every descendant's
 *  anchor too. */
function commentId(root: Element): string | null {
  for (const el of Array.from(root.querySelectorAll('[id]'))) {
    if (el.closest(COMMENT) !== root) continue;
    const match = /^comment-(\d+)$/.exec(el.getAttribute('id') ?? '');
    if (match) return match[1];
  }
  return null;
}

/** The `.comment-body` that belongs to THIS comment, not to one of its descendants. The
 *  ownership test is what makes nesting safe: a parent's own body precedes its replies in
 *  document order, but relying on that would be a bet on Substack's render order rather
 *  than a statement about which comment the text belongs to. */
function ownCommentBody(root: Element): Element | null {
  for (const body of Array.from(root.querySelectorAll('.comment-body'))) {
    if (body.closest(COMMENT) === root) return body;
  }
  return null;
}

/** A note's body. `.feedCommentBody` is the rich-text container Substack wraps a feed
 *  note's text in; `FeedProseMirror` is the editor's own marker on the node inside it,
 *  used as the fallback for the version where the wrapper is absent. */
const NOTE_BODY = '[class*="feedCommentBody"], [class*="FeedProseMirror"]';

function noteBody(root: Element): Element | null {
  return root.querySelector(NOTE_BODY);
}

/** Whether the reader is being shown this card at all.
 *
 *  A note permalink keeps the HOME FEED mounted and hides it by clipping: the column is
 *  `width: 0; overflow: hidden`, and the feed's cards keep their entity keys inside it.
 *  Measured on `/@thisweekinaiclub/note/c-360009941` reached by tapping that note in the
 *  feed: five keyed cards sat in a column measuring 0x17885 with `overflow: hidden`, the
 *  focal note's own copy among them, while the page's real thread rendered at 390px beside
 *  it.
 *
 *  Counting those cards does two visible kinds of harm. Their buttons are seated into a
 *  header row that has no width, so the bar overflows a clipped box rather than sitting in
 *  a header. And the focal note's own copy is a card pointing at itself — exactly the shape
 *  `heroNote` reads as "the note is already rendered as an ordinary card" — so the real,
 *  keyless hero is refused and the note the page is about gets no buttons at all: the
 *  button that is gone when a note is opened from the feed, and back after a reload, which
 *  is the render in which this column is not there.
 *
 *  The clipping is read from the ancestor that does it, not from the card's own box: the
 *  card inside that column still measures 32px wide and `checkVisibility` answers true for
 *  it. What the reader can see of it is nothing. */
function clippedFromReader(el: Element): boolean {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const cs = getComputedStyle(p);
    // No box of its own to clip anything: Substack wraps whole columns in `display: contents`
    // (measured: a 0x0 `variables-…` div on every card, visible feed included).
    if (cs.display === 'contents') continue;
    const clips = cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
    if (clips && (p.clientWidth === 0 || p.clientHeight === 0)) return true;
  }
  return false;
}

/* ── The feed's clamp ───────────────────────────────────────────────────────────────
 *
 *  A note the feed cannot show whole is CUT, not hidden: measured at 390px on the home feed,
 *  a note running to 616 characters in its payload renders as its first 210 plus a `See more`
 *  anchor, and the rest is in no text node — Substack re-renders the body from the payload
 *  when the anchor is clicked.
 *
 *  A post is NAMED by its text (`canonicalContext`), and `capture` deliberately files the
 *  payload's whole note rather than the page's cut render, so that one note does not become
 *  two posts — one hashed whole, one hashed at its prefix — depending on which surface the
 *  reader met it on.
 *
 *  So a cut note is filed whole and painted on the words the host IS showing, with the clamp
 *  doing the clipping: a mark past the cut stays hidden until the reader opens the note, and a
 *  mark the cut runs through is cut with it. That works only because the painter leaves this
 *  anchor alone (`bodyControl`). It used to move it — the whole body's children went into our
 *  wrapper, the anchor among them — and the reader's next click then re-rendered the body the
 *  way a React tree does it, `removeChild` on the nodes it still believes it owns, and the page
 *  died outright: measured twice, `NotFoundError: Failed to execute 'removeChild'`, every card
 *  on the feed gone (5 → 0) in the two seconds that followed. With the anchor left where the
 *  host wrote it there is nothing of ours to reconcile against, and the note keeps its own
 *  clamp — unlike X, whose body is whole under a style the host lifts by itself. */

/** Substack's own control for a note it has cut. Its class carries a hashed suffix
 *  (`seeMore-D88zkH`), which is the same shape as `feedCommentBody` — the prefix is what is
 *  matched, and it is what the host calls this thing. */
const SEE_MORE = '[class*="seeMore-"]';

/** The host's own clamp control for this root, or null when its body is whole.
 *
 *  Ownership is what the loop is for: a note that quotes another note carries the quoted
 *  one's control too, and a thread carries every comment's — reading one of those as this
 *  root's would name a different post's body as cut. A root's own control is the one whose
 *  nearest card or comment is the root itself.
 *
 *  Asked by `capture` for every root it is handed and by the painter for every post it is
 *  about to paint into, so the single query comes first and the ownership walk happens only
 *  where a control was found at all: almost every note is not cut. */
function expanderOf(root: Element): Element | null {
  if (!root.querySelector(SEE_MORE)) return null;
  for (const box of Array.from(root.querySelectorAll(SEE_MORE))) {
    const owner = box.closest(`${NOTE_CARD}, ${COMMENT}`);
    if (owner && owner !== root) continue;
    return (box.querySelector('a, button, [role="button"]') ?? box) as Element;
  }
  return null;
}

/** The length at which a note stops being one the reader takes in at a glance.
 *
 *  Measured on the feed: a note whose payload runs to 616 characters is rendered as its
 *  first 348, ending at the reader's own `See more` anchor (`filed=348 shown=348` beside
 *  `payload=616`). This is not a hard line the host draws — its renderer clips where it
 *  likes, and the markup is a prefix while the payload holds the whole — which is why this
 *  platform set its own number BELOW every clip measured rather than at one. There is no
 *  per-platform number any more: every platform reads the universal `LONG_FORM_CHARS`, and
 *  the error it leaves here is the safe one.
 *
 *  The clip does reach this measure, and it is answered where the note is filed: `isLongForm`
 *  reads the same two sources `capture` does, in the same order, so a cut note is measured on
 *  its own words rather than on the prefix the feed happens to be showing. */

/** A profile link in its `/@handle` form — what a note and a post byline use. */
const HANDLE_URL = /^\/@([^/?#]+)/;

/** Substack's other account URL, `/profile/<user id>-<slug>`, which is what a PUBLICATION's
 *  own account link uses: absolute (`https://substack.com/profile/...`) on a post page and
 *  root-relative (`/profile/...`) on the reader. The relative form is the one that went
 *  unrecognized, and a publication-authored note was left with no header row to place its
 *  buttons in — they landed at the top of the card instead of inline at the end of the row. */
const PROFILE_URL = /^(?:https:\/\/(?:www\.)?substack\.com)?\/profile\/\d+-([^/?#]+)/;

/** The profile link a scope really belongs to — the one whose nearest comment is the scope
 *  itself, so a parent never borrows a child's byline. A no-op for a scope that contains no
 *  comments at all, which is every scope but a comment.
 *
 *  The handle is the better value of the two URL forms where it exists — it is the account's
 *  stable name, where the profile slug is derived from the display name and changes when that
 *  does — so `/@` wins when both are present. */
function authorOf(scope: Element): { name: string; handle: string | null } {
  const link = authorLinkOf(scope);
  if (!link) return { name: '', handle: null };
  const href = (link.getAttribute('href') ?? '').split('?')[0];
  const handle = HANDLE_URL.exec(href)?.[1] ?? PROFILE_URL.exec(href)?.[1] ?? null;
  return { name: (link.textContent ?? '').trim(), handle };
}

/** The author's own profile link inside a scope, in either of the two forms above. */
function authorLinkOf(scope: Element): Element | null {
  let fallback: Element | null = null;
  for (const link of Array.from(scope.querySelectorAll('a[href]'))) {
    const owner = link.closest(COMMENT);
    if (owner && owner !== scope) continue;
    if (!(link.textContent ?? '').trim()) continue;
    const href = (link.getAttribute('href') ?? '').split('?')[0];
    if (HANDLE_URL.test(href)) return link;
    if (!fallback && PROFILE_URL.test(href)) fallback = link;
  }
  return fallback;
}

/** The row a post's buttons belong at the end of: the header bar that carries the byline.
 *
 *  Reached without naming a single one of Substack's build-hashed classes. The rule is
 *  structural: walk up from the author's own link and stop at the highest ancestor that
 *  still does NOT contain the body — the header row is by definition a sibling row of the
 *  body, so the first ancestor that swallows the body is the column holding both, and the
 *  row just below it is the header. That is how the same rule lands on a comment's
 *  `author · date` row and a note's. */
function headerRowOf(root: Element): Element | null {
  const body = root.classList.contains('comment') ? ownCommentBody(root) : noteBody(root);
  const link = authorLinkOf(root);
  if (!link) return null;
  let row: Element | null = null;
  for (let el: Element | null = link; el && el !== root; el = el.parentElement) {
    if (body && el.contains(body)) break;
    row = el;
  }
  return row;
}

/** The child a header row ends in, when it is one of Substack's own control clusters.
 *
 *  Measured 2026-10-01 on a note: the row ends in a 42×20 cluster holding the `More options`
 *  and `Hide note` buttons — the host's own controls, which keep their place. Ours go
 *  immediately to their left, the position the same ask produced on Quora, Reddit and Dcard,
 *  and the one the buttons already hold on X beside the host's ⋯. A subscribe button, where
 *  the reader is not subscribed yet, stands further left and stays there: what the run's own
 *  controls are grouped by is Substack's business, not ours.
 *
 *  Read structurally — a control is a `button` or a `[role="button"]` somewhere inside the
 *  child — and never past the author's own link, so a row that ends in its byline (every
 *  comment, measured) keeps the buttons at its right end as before. `container` is skipped so
 *  the rule lands on the same child on every injection, which is what makes re-placing the
 *  buttons idempotent. */
function trailingControlsOf(row: Element, container: Element, link: Element | null): Element | null {
  const kids = Array.from(row.children).filter((child) => child !== container);
  const last = kids[kids.length - 1];
  if (!last || (link && last.contains(link))) return null;
  return last.querySelector('button, [role="button"]') ? last : null;
}

/** The comment a nested comment answers, as a namespaced id, or null for a top-level one.
 *  A reply is DOM-nested inside its parent, so the nearest enclosing `div.comment` IS the
 *  direct parent — no indent arithmetic, and no guessing at Substack's ordering. */
function replyParentIdOf(root: Element): string | null {
  const parent = root.parentElement?.closest(COMMENT);
  if (!parent) return null;
  const id = commentId(parent);
  return id ? namespaced(`c-${id}`) : null;
}

/** The note a payload says this one answers, as a namespaced id, or null.
 *
 *  The fallback the DOM needs on this platform, twice over. A note permalink renders no
 *  ancestor at all, so a note's parent exists nowhere on the page; and a comment answering the
 *  note itself is nested in the note's thread rather than in another `div.comment`, so
 *  `replyParentIdOf` finds no parent for it even though the payload names one. Both come back
 *  as the tail of `ancestor_path`. */
function payloadParentId(entity: NoteEntity | undefined): string | null {
  return entity?.parent ? namespaced(`c-${entity.parent}`) : null;
}

/** The id of the note a URL stands for, or null when the path is not one note.
 *
 *  A note permalink is the only page whose URL names a post: `/@<handle>/note/c-<id>`, in
 *  the same numeric space the reader calls the note by. `/p/<slug>` names an ARTICLE and is
 *  deliberately not claimed — an article is not a post here; see this file's header — and
 *  every other page (`/archive`, `/about`, a section index) is not one either. */
function postIdFromPath(url: URL): string | null {
  const path = url.pathname.replace(/\/+$/, '');
  const note = /^\/@[^/]+\/note\/(c-\d+)$/.exec(path);
  return note ? namespaced(note[1]) : null;
}

/** The post a page's comments belong to, or null when this page shows no post. */
function pagePostId(): string | null {
  return postIdFromPath(new URL(location.href));
}

/** Substack's `data-testid="user-badge"` is a subscription-tier mark, not a verification
 *  status, and it is the same test id on both surfaces that carry one: the publication
 *  rosette beside a note's or a post's byline, and a comment's `subscriberBadge`. Both are
 *  marks of a PAID subscriber, and the reader's own payload is what says so — a profile
 *  arrives with `bestsellerBadgeEnabled` / `bestsellerTier` next to a separate verification
 *  field the rendered page never shows. The rosette is worth stating explicitly because its
 *  seal-with-a-check reads as a verification tick at a glance, which is the one way this
 *  mark could be mis-reported as identity verification rather than as a subscription tier.
 *
 *  Nothing on the page says an account is verified, so every account is `Regular` rather
 *  than inferred from the one badge that exists. Measured 2026-09-28, while reading the
 *  reader's payload; no code change follows from it. */
const SUBSTACK_USERTYPE: Usertype = UsertypeEnum.Regular;

/** The note a card's own permalink names, or null when the card carries no such link.
 *
 *  A note's header ends in the timestamp, and the timestamp links to the note's own
 *  permalink. It is the FIRST `/note/` link in the card, because a quoted note renders BELOW
 *  that header inside its own keyed element — the same ownership rule `ownTranslationControl`
 *  applies to the translate control, and here it is the difference between filing a card as
 *  itself and filing it as the note it quotes.
 *
 *  This outranks `data-entity-key` because the key is Substack's rendering key and not always
 *  the card's own id. On a note permalink the reader renders the ancestors as rows of the ONE
 *  entity the page is about, and keys every row with that note: measured on
 *  `/@gurdeep212/note/c-349973906`, the two rows above the focal note both carry
 *  `data-entity-key="c-349973906"` while their own permalinks name `c-349963969` and
 *  `c-349966257`. The key names the conversation; only the link names the note. Reading the
 *  key alone files both ancestors as the focal note — and since `captured` is id-keyed, the
 *  focal note is then never captured at all, so the post the page is about is the one post on
 *  it with no buttons. */
function ownNoteId(root: Element): string | null {
  for (const link of Array.from(root.querySelectorAll('a[href*="/note/c-"]'))) {
    // A nested post's links speak for the nested post, never for the one holding it.
    const keyed = link.closest('[data-entity-key]');
    if (keyed && keyed !== root && root.contains(keyed)) continue;
    const comment = link.closest(COMMENT);
    if (comment && comment !== root && root.contains(comment)) continue;
    const match = /\/note\/(c-\d+)/.exec((link.getAttribute('href') || '').split('?')[0]);
    if (match) return match[1];
  }
  return null;
}

/** The focal note of a note permalink page (`/@<handle>/note/c-<id>`).
 *
 *  That note is the one note in the reader with no `data-entity-key`. Every card in a feed
 *  is rendered from a feed payload and carries the key; the hero is rendered from the note
 *  the page is about, and Substack stamps no data attribute on it at all — no key, no
 *  test id, no entity URL, only build-hashed classes this file never names. What it does
 *  have is a link to itself: the timestamp at the end of its header row points at the
 *  note's own permalink. That link is the way in.
 *
 *  From it, ascend to the SMALLEST ancestor that also holds the note's own body. That is
 *  the hero card exactly: the header (and so the self-link) and the body are its two
 *  halves. Ascending further looks for the same thing but cannot stop on it — see below.
 *
 *  The ascent must be bounded by the note's CONTENT and not by a keyed ancestor, which is
 *  what an earlier version of this did: climb until the next ancestor holds a
 *  `data-entity-key`, on the reasoning that a keyed entity is a feed card below the hero.
 *  On a freshly-loaded permalink that bound does not exist yet — the feed has not hydrated,
 *  so there is no key anywhere on the page — and the walk went straight past the note to
 *  the reader's own page container (`reader-nav-root`), which then answered `isHeroNote`
 *  because it contains the self-link too. Measured on
 *  `substack.com/@thisweekinaiclub/note/c-341043171`: the page container was captured under
 *  the note's id, hung a pill in the page's top-right corner above the note it belonged to,
 *  and — because `captured` is id-keyed — kept the real keyed card from ever being captured
 *  for that id once it did render.
 *
 *  Three other bounds keep it from firing anywhere else, and the first is the strong one:
 *  the page's own path must be a note permalink (which `pagePostId` only reports for
 *  `/@<handle>/note/c-<n>`) — there is no other surface where a keyless note is the page's
 *  subject. Then a self-link must exist inside the root, which is what makes the ascent
 *  start in the hero rather than at the document; and the walk refuses to return a hero
 *  whose id a real card already carries, so on a page that renders the note as an ordinary
 *  keyed card the card stays the single root for that id and its buttons are not doubled.
 *
 *  That last bound asks the card whether it IS the note and not merely whether it is keyed
 *  with it: a permalink's thread is keyed with the focal note throughout (see `ownNoteId`),
 *  so the keyed-and-pointing-at-itself form is the only one that takes the note's place. */
function heroNote(): Element | null {
  const page = pagePostId();
  if (!page) return null;
  const bare = page.slice(ID_PREFIX.length);
  if (!/^c-\d+$/.test(bare)) return null;
  for (const card of Array.from(document.querySelectorAll(NOTE_CARD))) {
    if (card.getAttribute('data-entity-key') !== bare) continue;
    // The feed's own copy of this note, left mounted and clipped behind the permalink, is
    // not the page rendering it as a card — see `clippedFromReader`.
    if (clippedFromReader(card)) continue;
    // Keyed with this note's id AND pointing at it: the note is already rendered as an
    // ordinary card below, so there is no hero and the card stays its single root. A row
    // keyed with this note's id but permalinking elsewhere is an ancestor of the note, not
    // the note — which is the whole of a permalink's thread that renders above the focal
    // note (see `ownNoteId`) — and it must not stand in for it.
    if (ownNoteId(card) === bare) return null;
  }
  // Every link to this note, because a permalink carries more than one: the note's own
  // permalink sits in its header, and the clipped copy of the feed the reader arrived from —
  // still mounted — carries one too, appearing EARLIER in the document. Taking the first
  // therefore starts the ascent inside that copy and returns a clipped box as the hero, which
  // is a bar nobody can see. Each is tried in turn instead, and a clipped ascent is abandoned.
  const selfLinks = Array.from(document.querySelectorAll(`a[href*="/note/${bare}"]`));
  for (const selfLink of selfLinks) {
    for (let el = selfLink.parentElement; el && el !== document.body; el = el.parentElement) {
      if (el.querySelector('[data-entity-key]')) break;
      if (el.querySelector(NOTE_BODY)) {
        if (!clippedFromReader(el)) return el;
        break;
      }
    }
  }
  return null;
}

/** Whether `root` is that keyless hero — the predicate `idOf` needs, which must not walk
 *  the page the way `heroNote` does: it is asked about roots that carry keys and roots on
 *  a post page's comment thread too, and all it has to answer is whether this one is the
 *  note the page is about.
 *
 *  A container is not a hero: the note's own permalink lives in its header, so every
 *  ancestor of the note — up to the reader's page container — contains a link to it. The
 *  `data-entity-key` clause is what tells the note apart from the boxes around it, and it
 *  has to be here as well as in `heroNote` because this is the predicate a root is judged
 *  by, whatever found it. */
function isHeroNote(root: Element, page: string): boolean {
  const bare = page.slice(ID_PREFIX.length);
  if (!/^c-\d+$/.test(bare)) return false;
  if (!root.querySelector(`a[href*="/note/${bare}"]`)) return false;
  return !root.querySelector('[data-entity-key]');
}

/** The id of the post a root element stands for, or null when it is not one.
 *
 *  Two shapes, one namespace. A feed note carries its id on `data-entity-key`. A comment
 *  carries it in its own `#comment-<id>` anchor, and both are the SAME numeric space —
 *  Substack's reader calls a comment `c-<id>` and the post page anchors it at
 *  `#comment-<id>` — which is why one prefix covers both and why a note and the comment it
 *  becomes on a post page are one id rather than two. An article has no id here at all: it
 *  is not a post; see this file's header. */
function idOf(root: Element): string | null {
  const key = root.getAttribute('data-entity-key');
  if (key) {
    if (!/^c-\d+$/.test(key)) return null;
    // The key where the card has no permalink of its own, the card's own note where it has
    // one and the two disagree — a thread row keyed with the focal note's id (see
    // `ownNoteId`).
    return namespaced(ownNoteId(root) ?? key);
  }
  const id = commentId(root);
  if (id) return namespaced(`c-${id}`);
  // Keyless and not a comment: on a note permalink page that is the focal note, which has
  // no id in its markup and takes the page's own.
  const page = pagePostId();
  return page && isHeroNote(root, page) ? page : null;
}

function postRoots(id: string): Element[] {
  const out: Element[] = [];
  const bare = id.startsWith(ID_PREFIX) ? id.slice(ID_PREFIX.length) : id;

  // Notes and comments are the only posts here, and they share one numeric space, so every
  // id that names one of them is `c-<n>`. Anything else — an article's path id, another
  // platform's id — names nothing on this page.
  const entity = /^c-\d+$/.exec(bare);
  if (!entity) return out;

  const numeric = entity[0].slice(2);
  for (const comment of Array.from(document.querySelectorAll(COMMENT))) {
    if (commentId(comment) === numeric && !clippedFromReader(comment)) out.push(comment);
  }
  for (const card of Array.from(document.querySelectorAll(NOTE_CARD))) {
    // The card's own permalink decides, not its key: on a note permalink every row of the
    // thread is keyed with the focal note's id, so the key alone would answer for one id
    // with the whole thread (see `ownNoteId`).
    if ((ownNoteId(card) ?? card.getAttribute('data-entity-key')) !== entity[0]) continue;
    // The clipped copy a permalink keeps of the surface it was reached from is not a place
    // the reader can be shown a post — see `clippedFromReader`.
    if (clippedFromReader(card)) continue;
    out.push(card);
  }
  // The focal note of a note permalink page is keyless, so it is only reachable
  // structurally — and only for the id the page is about.
  if (pagePostId() === id) {
    const hero = heroNote();
    if (hero) out.push(hero);
  }
  return out;
}

/* ── What the reader is showing, and the note's own words ─────────────────────── */

/** The control Substack renders to flip a note between its own words and a translation of
 *  them, in the one form that says WHICH side is up.
 *
 *  The class is the only mark the swap leaves: the note's body carries no `lang`, no `data-*`
 *  and no stable class either way (measured), so there is nothing in the words themselves to
 *  read. What does change is the control's ELEMENT — a note showing a translation renders
 *  `<button class="… translateButton-<hash> …" aria-haspopup="menu">`, and the same control on
 *  a note showing its own words is a bare `<span class="… translateButton-<hash>">` — and a
 *  note whose words the reader's language already matches carries no control at all. Tag and
 *  class together are therefore the whole test, and neither is the label the element happens
 *  to carry: `Translated` / `Translate` / `See original` are locale-dependent copy, which is
 *  the one thing this extension is not allowed to key on.
 *
 *  `[class*=]` on a build-hashed class follows the same rule as this adapter's other two
 *  prefix matches (`feedCommentBody`, `FeedProseMirror`) and for the same reason: the hash
 *  changes per build, the name does not. */
const TRANSLATE_CONTROL = 'button[class*="translateButton-"]';

/** The translate control belonging to THIS post, not to one of its children.
 *
 *  Both surfaces nest: a comment's replies are inside the comment's own element, and a note
 *  quoting another note renders the quoted one inside it. A `querySelector` would happily
 *  answer with a nested post's control, and the two sides of a nested post are independent —
 *  a quoted note can be translated while the note quoting it is not — so the answer would be
 *  about the wrong post. The tests are the ones this file already uses for ownership: the
 *  nearest `div.comment`, and the entity key the nested card carries (`data-entity-key`),
 *  which a feed note has and the keyless focal note of a permalink does not. */
function ownTranslationControl(root: Element): Element | null {
  const first = root.querySelector(TRANSLATE_CONTROL);
  if (!first) return null;
  const key = root.getAttribute('data-entity-key');
  for (const control of Array.from(root.querySelectorAll(TRANSLATE_CONTROL))) {
    if (root.classList.contains('comment') && control.closest(COMMENT) !== root) continue;
    const owner = control.closest('[data-entity-key]');
    if (key && owner && owner.getAttribute('data-entity-key') !== key) continue;
    return control;
  }
  return null;
}

/** Whether the reader is looking at a translation of this post's words rather than at the
 *  words themselves. Asked on every sweep for every post in reach, so it is the one query
 *  above and nothing more. */
function isShowingTranslation(root: Element): boolean {
  return !!ownTranslationControl(root);
}

/** What the reader's own API said about a note, remembered by id.
 *
 *  Three facts, and each of them is one the page cannot state: the note as its author wrote
 *  it (the source survives in no text node, no attribute and no page store while a
 *  translation is on screen), the language those words are in, and the language the reader is
 *  reading them in. The last two are what a highlight localization needs — ranges recomputed
 *  for the locale being read — and the first is what identifies the note at all, since a
 *  post's hash is computed from its source text.
 *
 *  Filled from the reader's own responses (see `captureNetwork`) and read by `capture`, which
 *  stays the single place a post is filed from: the payload is right about the note's
 *  identity and the page is right about everything else — the author as displayed, the reply
 *  nesting, which conversation the post belongs to — and keeping one filing site is what
 *  keeps those from disagreeing. */
interface NoteEntity {
  /** The note's own words, in the one shape the page and this store agree on: see
   *  `asNoteEntity` for why this is the renderer's reading and not the authored body. */
  source: string;
  /** Whether `source` is exactly what the reader puts on the page.
   *
   *  When it is, the two are interchangeable and this adapter prefers the payload, because
   *  the payload has the whole note where a feed card has a prefix of it. When it is not —
   *  the payload carried no document this could rebuild, or one holding a node the rebuild
   *  does not know — the page's own reading is the only trustworthy one, and filing the
   *  approximation instead would put a post's claims' offsets against a string no element on
   *  the page contains. */
  exact: boolean;
  /** The language the note is written in, or null when the payload names none. */
  language: string | null;
  /** The note's text in the language the reader is reading it in, rebuilt from the payload's
   *  own `translation` document, or null when the payload states none.
   *
   *  `source`'s counterpart on the other side, and preferred over the page in the same order
   *  and for the same reason: the feed CLIPS a long card, and the clip plus Substack's own
   *  `See more` label sit inside the element this adapter reads. */
  translated: string | null;
  /** The language a displayed translation is in, or null when the payload names none. */
  target: string | null;
  /** The note this one directly answers, as a bare `c-` id, or null for a top-level note. */
  parent: string | null;
  /** The author's display name, as the payload states it. Used only where the page cannot
   *  state it: a note the page renders takes its author from the markup, as every other
   *  post on this platform does. */
  name: string;
  /** When the note was written, as an ISO 8601 instant in UTC, or null when the payload
   *  stated nothing this could read. Reaches the preclassify prompt's "today is" note, which
   *  resolves a relative reference ("this morning", "last week") against the moment a post was
   *  written.
   *
   *  The payload's edit time wins over its authoring time, which is the reading the field is
   *  for: `edited_at` is stated only once the author HAS edited the note, so when it is there
   *  it is the later of the two and the only one the post's own words were written against.
   *  The instant itself is read off the ONE field the payload states it in — a note permalink
   *  renders no `<time>` element and ships no date, so this response is the only place it
   *  exists — and dropped rather than guessed when unreadable (see `isoDatetime`). */
  datetime: string | null;
}

const noteEntities = new Map<string, NoteEntity>();
/** Far above any page's live post count — a note is filed the first time it is rendered, so
 *  this only ever holds posts the reader has not reached — and bounded so a long scroll
 *  cannot grow it without limit. */
const MAX_NOTE_ENTITIES = 600;

/** When each note was first seen on the page without a payload describing it, so a note that
 *  is never described is still filed rather than waiting forever (see `capture`). Bounded
 *  like `noteEntities` and for the same reason: entries are dropped when the wait ends. */
const noteWaitStarted = new Map<string, number>();
/** How long a note may wait for the reader's own description of it. The response is issued
 *  before the card is drawn, so it lands within a tick or two of the markup in the ordinary
 *  case, and this only has to outlast a slow one; every payload absorb sweeps, so the note is
 *  filed by the sweep that follows its description rather than at this deadline. */
const NOTE_PAYLOAD_WAIT_MS = 2500;

/** Read one forwarded record as a note, or null when it is not one.
 *
 *  Two readings of a note's words arrive here and they are not the same string. The
 *  RENDERED one is what the reader puts on the page; the plain one is the authored body with
 *  its blank lines removed, which is how the renderer joins paragraphs. The rendered reading
 *  is preferred, and the reason is not tidiness — it is that only it is the SAME string
 *  everywhere the note appears: the feed clips a long note behind a `See more` anchor (~250
 *  chars measured) while the note's own permalink shows it whole, so a store holding the
 *  page's reading would hash one note two ways depending on the surface, and the feed's way
 *  would be a prefix of the note with Substack's own link text in it.
 *
 *  The plain reading is kept for the notes the page never renders — an ancestor, whose text
 *  nothing on screen can be compared against — where an approximation that is stable is
 *  worth more than none. It is exact for a note carrying no link and no mention; for a note
 *  with either, `rendered` is the one to use, and it is present for every note measured.
 *
 *  `exact` says which of the two this is, and the adapter's rule is: file the payload only
 *  where it is exact, and otherwise file the page. */
function asNoteEntity(record: unknown): NoteEntity | null {
  if (!record || typeof record !== 'object') return null;
  const value = record as Record<string, unknown>;
  const rendered = typeof value.rendered === 'string' ? value.rendered.trim() : '';
  const plain = typeof value.plain === 'string' ? value.plain : '';
  const source = rendered || plain;
  if (!source) return null;
  const tag = (input: unknown): string | null => {
    if (typeof input !== 'string') return null;
    const trimmed = input.trim().toLowerCase();
    return trimmed || null;
  };
  const parent = typeof value.parent === 'string' && /^\d+$/.test(value.parent) ? value.parent : null;
  const written = isoDatetime(typeof value.date === 'string' ? value.date : null) ?? null;
  const edited = isoDatetime(typeof value.editedAt === 'string' ? value.editedAt : null) ?? null;
  return {
    source,
    exact: rendered.length > 0,
    // Trimmed like `rendered` above, and for the same reason: the page's reading of the same
    // string is trimmed, so the two have to agree character for character where they are the
    // same string.
    translated: typeof value.translated === 'string' && value.translated.trim() ? value.translated.trim() : null,
    language: tag(value.language),
    target: tag(value.autotranslateTo),
    parent,
    name: typeof value.name === 'string' ? value.name.trim() : '',
    // The later of the two when both are stated, which is what makes this "written, or last
    // edited": an `edited_at` before the `date` is not a statement about this note's own words,
    // so the authoring time stands.
    datetime: edited && written && edited > written ? edited : written ?? edited,
  };
}

export const substackAdapter: PlatformAdapter = {
  id: 'substack',
  hosts: PLATFORM_HOSTS.substack ?? [],

  postIdFromUrl: postIdFromPath,

  postRoots,

  postIdOf(root) {
    return idOf(root);
  },

  /** A note or a comment, judged for length — see LONG_FORM_CHARS.
   *
   *  Comments are never long-form: a publication's comments are the short social unit here,
   *  server-rendered and complete, and they keep their buttons whatever they say. A note is
   *  measured on its own words — the payload's reading where the page's state states one, the
   *  page's otherwise — in the same order `capture` files it under and for the same reason: a
   *  note the feed cut renders as a prefix of itself, and the number is about the note, not
   *  about how much of it this page happens to be showing. */
  isLongForm(root) {
    if (root.classList.contains('comment')) return false;
    const id = idOf(root);
    const entity = id ? noteEntities.get(id) : null;
    const text = (entity && entity.exact ? entity.source : null)
      ?? noteBody(root)?.textContent?.trim()
      ?? '';
    return text.length >= LONG_FORM_CHARS;
  },

  textElement(root) {
    if (root.classList.contains('comment')) return ownCommentBody(root);
    return noteBody(root);
  },

  // A note's body and a comment's body are each ONE element holding one string — neither is
  // split across blocks — so both take the shared single-region path and this adapter has no
  // `textRegions` of its own.

  // Substack bodies are rich text: `<p>` per paragraph, `<a>` for links, headings, lists,
  // and inline images. Rebuilding one from the classified string would flatten all of it
  // into a single paragraph, so the highlight goes over the page's own text nodes.
  highlightInPlace: true,

  placeButtons(container, root) {
    // Buttons go at the top of the post, inline in its header bar — the same place they take
    // on Bluesky. The header bar is the `author · date` row on a comment and on a note;
    // `headerRowOf` finds both structurally, so none of it depends on a class Substack hashes.
    const host = headerRowOf(root);
    if (host) {
      // `marginLeft: auto` is what pushes the buttons to the right end of the row when the
      // row is a flex container — which every one of these is — and does nothing at all
      // when it is not, so a layout change degrades to "the buttons are in the header"
      // rather than to a broken row.
      container.style.marginLeft = 'auto';
      container.style.alignSelf = 'center';
      container.style.flexShrink = '0';
      // The row ends in Substack's own controls and they keep their place: ours go immediately
      // to their left, the position the same ask produced on Quora, Reddit and Dcard.
      const trailing = trailingControlsOf(host, container, authorLinkOf(root));
      if (trailing) host.insertBefore(container, trailing);
      else host.appendChild(container);
      return;
    }
    // No header row: leave the container detached rather than prepending it to the post.
    // The rule this follows is the same on every platform — a post carrying our buttons is
    // one the selection rule hands the user's selection off to, so a pill dropped at the
    // top of the post instead of in its header would also cost the user the web-select
    // path on that post. Detached, the post keeps working: it simply has no buttons. See
    // `placeButtons` in types.ts.
  },

  feedCenter() {
    // The measure is the content column, not the viewport: the reader lays its notes in one,
    // and on a wide window that column and the window's center do not agree.
    const column = document.querySelector(NOTE_CARD) ?? heroNote();
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
    // Innermost first: a selection inside a reply belongs to the reply, not to the
    // top-level comment it is nested in.
    const comment = el.closest(COMMENT);
    if (comment && commentId(comment)) return comment;
    const card = el.closest(NOTE_CARD);
    if (card) return card;
    const hero = heroNote();
    if (hero?.contains(el)) return hero;
    // An article is not a post here, so a selection anywhere in one is left to the ordinary
    // web selection flow; see this file's header.
    return null;
  },

  captureRoots() {
    const roots: Element[] = [];
    // The keyless focal note of a note permalink page, ahead of the feed below it: it is
    // the post the page is about, so it is the first one announced.
    const hero = heroNote();
    if (hero) roots.push(hero);
    // Every comment, nested included: each is its own post with its own buttons. A post the
    // reader is not being shown is not one of them — see `clippedFromReader`; on a permalink
    // that is the whole home feed, left mounted and clipped behind the note.
    for (const comment of Array.from(document.querySelectorAll(COMMENT))) {
      if (!clippedFromReader(comment)) roots.push(comment);
    }
    for (const card of Array.from(document.querySelectorAll(NOTE_CARD))) {
      if (!clippedFromReader(card)) roots.push(card);
    }
    return roots;
  },

  /** Whether the host is holding this root's body back behind its own `See more`.
   *
   *  `capture` reads the payload rather than the prefix, and the painter wraps the body's own
   *  words while leaving this anchor where the host put it — see the clamp block above for what
   *  painting one without that costs. Nothing opens it: the reader's own click is what does. */
  bodyClipped(root) {
    return expanderOf(root) !== null;
  },

  /** This body's own `See more`, scoped the way `expanderOf` scopes it: a note that quotes
   *  another carries the quoted one's anchor too, and only the anchor whose card is this body's
   *  own is its control.
   *
   *  The BOX is what this returns, not the `<a>` inside it. The painter builds its wrap in
   *  whatever HOLDS the control and moves only what comes before it (measured: the box is a
   *  direct child of the body, the anchor sits two levels deeper), so handing it the anchor
   *  gives it that anchor's own wrapper — a box holding nothing but the anchor, and so nothing
   *  to wrap. The body then went unpainted with no diagnostic. */
  bodyControl(body) {
    if (!body.querySelector(SEE_MORE)) return null;
    const owner = body.closest(`${NOTE_CARD}, ${COMMENT}`);
    for (const box of Array.from(body.querySelectorAll(SEE_MORE))) {
      const holder = box.closest(`${NOTE_CARD}, ${COMMENT}`);
      if (holder && holder !== owner) continue;
      return box as Element;
    }
    return null;
  },

  capture(root: Element): CapturedPost | null {
    const id = idOf(root);
    if (!id) return null;

    const isComment = root.classList.contains('comment');
    const entity = noteEntities.get(id);
    // The payload's reading of this note where the page's own state states one — the words the
    // card was rendered from, and so the note's own. Read here rather than below because the
    // cut guard underneath needs it.
    const own = entity && entity.exact ? entity.source : null;

    // Still cut, so the markup is a prefix of this note. The page is left as the reader has it,
    // and the note is filed from the payload above: the same string its author wrote, the same
    // hash its row is filed under, and a post the reader can still be shown marks in — the ones
    // that fall below the cut are the page's own business, not a reason to open it (see the
    // clamp block at the top of this file). What a cut costs is the part of the reading below
    // it, never the post.
    //
    // Without a payload the prefix is all this page holds, and a prefix names no post — one id
    // must not name two texts. Such a note waits for the response that describes it, which is
    // also what sweeps again: a cut note is left uncaptured rather than filed under its own
    // opening words.
    if (expanderOf(root) && !own) return null;

    // A note reaches the page twice: CLIPPED into its markup, and whole in the payload the
    // reader rendered it from. The payload always exists — a card is drawn from one, and a
    // permalink's focal note from the page's own shipped state — but it arrives here through
    // the page's message channel, a tick or two behind the markup, and this sweep can fall in
    // that tick. Measured while chasing the focal note of `/@gurdeep212/note/c-349973906`,
    // whose markup was captured and billed at t=418ms with its payload landing at t=426ms
    // (the two reverse on a cold worker): on the feed, 34 of 36 cards were captured before
    // their payload, four of them at the renderer's clip — `filed=348 shown=348` beside a
    // payload running to 616 characters.
    //
    // What that costs is not only the words. A note hashed on its clipped text is a DIFFERENT
    // post to the cache and to the DB than the same note hashed whole — the reader's own
    // payload would not match it, so one note ends up as two rows, and the same for a
    // permalink note filed without the ancestors that arrive with its payload. Neither can be
    // amended afterwards: the hash is what the reader's row was billed on (see
    // `absorbNetworkRecords`). So a note the reader has not described yet waits for its
    // description instead — bounded twice over, because a post filed as the page shows it is
    // still better than a post never filed: the wait ends at the page's own load, or once it
    // has gone on longer than any response the reader was going to send.
    //
    // Comments are exempt deliberately. A publication page's comments are server-rendered and
    // may have no payload to wait for at all; the reader's notes are the surface this is about.
    if (!isComment && !entity) {
      const now = Date.now();
      const started = noteWaitStarted.get(id) ?? (noteWaitStarted.set(id, now), now);
      // A card the reader scrolls past before its wait ends would otherwise leave its stamp
      // behind for as long as the page lives, so the map is evicted like `noteEntities`.
      while (noteWaitStarted.size > MAX_NOTE_ENTITIES) {
        const oldest = noteWaitStarted.keys().next().value;
        if (oldest === undefined) break;
        noteWaitStarted.delete(oldest);
      }
      if (document.readyState !== 'complete' || now - started < NOTE_PAYLOAD_WAIT_MS) return null;
    }
    noteWaitStarted.delete(id);

    const body = isComment ? ownCommentBody(root) : noteBody(root);
    const shown = body?.textContent?.trim() ?? '';
    const translated = isShowingTranslation(root);

    // A note the reader is being shown a translation of is filed under its OWN words, and the
    // payload is the only copy of them this page has. Without one there is nothing to file the
    // post under: the translation's hash would become the post's identity — a second,
    // unrelated post as far as the cache and the DB are concerned — so the post is left
    // uncaptured until the response that described it arrives, which is the ordinary case,
    // since Substack fetches a note before it renders it.
    //
    // `exact` and not merely `entity`: the same rule has to hold for the text below, and the
    // approximation is no more the note's own words than the translation is.
    if (translated && !own) return null;

    // The payload's reading first, the page's as the fallback — the same order Threads uses
    // and for the same reason. Where the page shows the whole note the two are the same
    // string (verified character for character, see `asNoteEntity`), so this changes nothing;
    // where the page CLIPS one, this is what keeps the post from being hashed on its own
    // first 250 characters.
    const text = own ?? shown;
    // When the note was written, as the reader's own response stated it. Absent for a note no
    // response has described — a publication's server-rendered comment, whose payload this
    // adapter may never see — rather than guessed from the page, which states no instant at all.
    const datetime = entity?.datetime ?? undefined;
    // A comment can be deleted with its shell left behind, and a note can be an image with
    // no words. Neither carries anything to fact-check, so they stay out of the batch
    // rather than spending a classification on an empty string.
    if (!text) return null;

    const post = {
      id,
      text,
      // The page and the payload are the same string here, so the text is its own raw form.
      // X separates these because its payload carries both a note_tweet expansion and a legacy
      // body; a note is one body either way, and the payload's blank lines are the renderer's
      // paragraph joins rather than part of the text (`asNoteEntity`).
      fullText: text,
      username: authorOf(root).name,
      usertype: SUBSTACK_USERTYPE,
      // The note a page is about is the note its comments are under.
      conversationId: isComment ? (pagePostId() ?? id) : id,
      quoting: null,
      replyingTo: null,
      ...(datetime ? { datetime } : {}),
    } as MainTweet;

    if (translated && entity) {
      // The other side, carried beside the source the way Telegram and Threads carry it. The
      // hash — and with it the cache entry and every stored highlight key — is computed from
      // `fullText`, so the source identifies the post whatever the reader is reading; this is
      // what tells the background which of the two is on screen. Named only when the payload
      // or the document names the language: the background requires BOTH fields before it
      // treats a post as translated, and a locale nothing can be filed under is worse than
      // none. A post whose translation cannot be named is classified as its own source, which
      // is exactly what this platform did before any of this existed.
      const target = entity.target ?? (publicationPage() ? null : appLanguage());
      if (target) {
        // The payload's reading of the translation where it has one for this very language,
        // the page's where it does not — the same order as the source above and for the same
        // reason. The feed clips a long card behind a `See more` anchor that sits inside the
        // element read above, so filing that would measure every range against a prefix of the
        // translation with Substack's own link text on the end, and would hash one note two
        // ways depending on whether the reader met it on the feed or on its own page.
        post.translatedText = (entity.target === target ? entity.translated : null) ?? shown;
        post.destinationLanguage = target;
      }
      if (entity.language) post.sourceLanguage = entity.language;
    } else {
      // The payload's statement of the language is the one to trust where it exists — it is
      // the author's own note's language, which the page never states. Falling back, a comment
      // on a publication's page is written in the language the publication declares; notes and
      // the reader's comments are not, because the reader mixes publications and states only
      // the reader's own UI language, so those get the shared unknown key instead of a wrong
      // one.
      const language = entity?.language ?? publicationLanguage();
      if (language) post.sourceLanguage = language;
    }

    return {
      post,
      // The DOM's answer where it has one — a reply nested in its parent is the direct parent
      // by construction, with no arithmetic — and the payload's where it does not.
      replyParentId: isComment ? replyParentIdOf(root) ?? payloadParentId(entity) : payloadParentId(entity),
    };
  },

  /** Which language the reader is reading a translated note in, or null.
   *
   *  Null in the two cases where this platform has nothing to report: the note is showing its
   *  own words, or no language can be named for the side on screen. The second is not
   *  bookkeeping — a translation whose language cannot be named has no key to file its
   *  highlight ranges under, and the background resolves the flip against the locale it is
   *  told, so a wrong name would file the ranges of one language under another.
   *
   *  That is why the document's own language is trusted only on the reader. At the apex
   *  `substack.com` is one page serving the reader, and its `<html lang>` is the language the
   *  reader reads in — the language Substack translates into, and the one the payload's
   *  `autotranslate_to` agrees with (measured: `en` both). On a publication page the same
   *  attribute is the PUBLICATION's language, which for a comment there is the language it was
   *  written in rather than the one it is being read in, so nothing is claimed unless the
   *  payload named it.
   *
   *  Deliberately no `revealSource`: Telegram needs one because it renders one side at a time
   *  and the other is nowhere on the page, so its source has to be read back off the host's own
   *  menu. Here the source came with the payload that `captureNetwork` read, so there is
   *  nothing to recover and no reason to touch the page — no menu to open and close, and no
   *  visible change for a reader who is simply scrolling. */
  displayedTranslationLocale(root) {
    if (!isShowingTranslation(root)) return null;
    const id = idOf(root);
    const named = id ? noteEntities.get(id)?.target ?? null : null;
    return named ?? (publicationPage() ? null : appLanguage());
  },

  /** The text on screen, which is what a flip's highlight ranges have to be measured against.
   *
   *  Asked only when a flip is being reported, never on a sweep, so the read here is
   *  affordable — and it is the same string `capture` files as `translatedText`, so the ranges
   *  the background stores for the translated side are keyed by the text the painter will be
   *  handed back. That is also why it resolves the side the same way `capture` does, payload
   *  before page: a flip reported against the page's clipped reading while the post was filed
   *  under the payload's whole one would store ranges no element holds. */
  displayedText(root) {
    if (!isShowingTranslation(root)) return null;
    const id = idOf(root);
    const fromPayload = id ? noteEntities.get(id)?.translated ?? null : null;
    if (fromPayload) return fromPayload;
    const body = root.classList.contains('comment') ? ownCommentBody(root) : noteBody(root);
    return body?.textContent?.trim() || null;
  },

  /** Remember what the reader's own API said about the notes it just fetched, and file the
   *  ones the page will never render.
   *
   *  The remembering half is what the page cannot do for itself: the note's own words, the
   *  two languages, and the note above it. `capture` files every post the page renders, and
   *  takes its text and its parent from here when this store has them — so a feed card is
   *  filed whole rather than clipped, and a note that answers another is filed with the note
   *  it answers rather than as a top-level post.
   *
   *  The filing half is only for ANCESTORS — the notes a response carries in `parentComments`
   *  and a permalink does not render. They have no element to be captured from, so if this did
   *  not emit them the chain would stop at the first note the page shows, and the hash of every
   *  post below it would be missing the context it is classified in. Deliberately NOT the
   *  whole payload, which is where this adapter parts company with Threads: Threads files every
   *  record from its payload, and Substack cannot, because a post here is filed with the side
   *  it is showing (`translatedText` / `destinationLanguage`, from `capture`) and Substack
   *  auto-translates by default, so a post filed from the payload alone would lose the half of
   *  it the reader is reading. A page-rendered note is therefore always left to `capture`.
   *
   *  An emitted ancestor is not announced: `announceVisible` is the only billing gate and it
   *  asks for a rendered root, which an ancestor by definition has not. Its text still reaches
   *  the hash through `replyingTo`, which is the whole point of filing it. */
  captureNetwork(records: unknown[]): CapturedPost[] {
    let kept = 0;
    const described: string[] = [];
    for (const value of records.slice(0, MAX_NOTE_ENTITIES)) {
      const record = value as Record<string, unknown> | null;
      const key = record && typeof record.key === 'string' ? record.key : '';
      if (!/^c-\d+$/.test(key)) continue;
      const entity = asNoteEntity(value);
      if (!entity) continue;
      kept++;
      described.push(namespaced(key));
      // Re-set rather than added, so a note the reader flips again takes the newer statement
      // (the payload's `autotranslate_to` is what the app itself rewrites on a manual flip)
      // and so re-reading a response cannot evict anything but the oldest.
      noteEntities.delete(namespaced(key));
      noteEntities.set(namespaced(key), entity);
    }
    while (noteEntities.size > MAX_NOTE_ENTITIES) {
      const oldest = noteEntities.keys().next().value;
      if (oldest === undefined) break;
      noteEntities.delete(oldest);
    }

    const out: CapturedPost[] = [];
    let ancestors = 0;
    for (const value of records.slice(0, MAX_NOTE_ENTITIES)) {
      const record = value as Record<string, unknown> | null;
      if (!record || record.ancestor !== true) continue;
      const key = typeof record.key === 'string' ? record.key : '';
      if (!/^c-\d+$/.test(key)) continue;
      const id = namespaced(key);
      const entity = noteEntities.get(id);
      // Not in `described` means a previous response already described it and it has already
      // been filed; the chain linker re-reads the whole captured set on every absorb, so a
      // link that was missing then is made on the next pass.
      if (!entity || !described.includes(id)) continue;
      // Skipped when the page turns out to render it after all — a publication's comment
      // thread renders its ancestors, unlike a note permalink — so this never puts a second,
      // payload-derived reading next to the markup's for a post the reader can see.
      if (postRoots(id).length > 0) continue;
      const conversationId = pagePostId() ?? id;
      out.push({
        post: {
          id,
          text: entity.source,
          fullText: entity.source,
          username: entity.name,
          usertype: SUBSTACK_USERTYPE,
          conversationId,
          quoting: null,
          replyingTo: null,
          ...(entity.datetime ? { datetime: entity.datetime } : {}),
        } as MainTweet,
        replyParentId: payloadParentId(entity),
      });
      ancestors++;
    }

    console.log(`[misinfo] substack: payload described ${kept}/${records.length} note(s); ${noteEntities.size} known`
      + (ancestors > 0 ? `; ${ancestors} ancestor(s) filed` : ''));
    return out;
  },
};
