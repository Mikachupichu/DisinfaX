/** The platform adapter contract.
 *
 *  Every method here corresponds to exactly one place where `utils/injecting.ts`
 *  hardcoded X. The X adapter is deliberately NOT a rewrite: it delegates to the same
 *  functions the X builds have always run, so introducing this seam cannot change X
 *  behaviour. Platforms added later implement these directly.
 *
 *  Adapters read the DOM only, and every id they return is opaque to the rest of the
 *  extension — nothing about a platform's markup or ids escapes past this boundary.
 */
import type { MainTweet } from '../../data/Tweets';

/** Identifies a supported platform.
 *
 *  `x` deliberately keeps X's bare numeric status ids: stored classifications, their
 *  hashes and their worker-side caches are all keyed on them, and re-keying would
 *  invalidate every existing row. Every other platform namespaces its ids with its own
 *  prefix instead, because the background fans a classification out to *every*
 *  connected relay (`broadcastClassification`) rather than keying by tab — so a bare
 *  `12345` from Reddit could otherwise be injected into an unrelated X timeline. */
export type PlatformId =
  | 'x'
  | 'reddit'
  | 'oldreddit'
  | 'hackernews'
  | 'bluesky'
  | 'mastodon'
  | 'substack'
  | 'threads'
  | 'truthsocial'
  | 'quora'
  | 'dcard'
  | 'ptt'
  | 'navercafe'
  | 'facebook'
  | 'linkedin'
  | 'telegram';

/** Which post a DOM element or highlight belongs to.
 *
 *  `isQuoted` mirrors the flag the X pipeline already threads through: a post can
 *  appear twice on one page (a timeline entry and the card it quotes), and the text
 *  element to annotate differs between the two. */
export interface PostRef {
  /** The id as the extension stores it — bare for X, namespaced elsewhere. */
  id: string;
  /** True when this is a quoted/nested card rather than the post itself. */
  isQuoted?: boolean;
  /** The text this post was classified on, when the caller has it in hand.
   *
   *  A platform can be fed from its API and still be read from the DOM — Threads takes a
   *  post's text from its payload while its elements come from the page — and then the
   *  classified text and the page's own text are not the same string: the payload holds the
   *  caption as authored, the page a clipped render of it. An adapter mapping one onto the
   *  other through this does so against the string the claim offsets were actually measured
   *  against; without it, an adapter can only assume, and a shifted slice paints a claim
   *  over words the claim never named. */
  text?: string;
}

/** One post or comment lifted out of a platform's DOM, ready to classify.
 *
 *  `post` is structurally a `MainTweet`, because the hash, the classify pipeline and
 *  the worker all already speak that shape — a platform adapter's job is only to fill
 *  it from markup instead of from a JSON payload.
 *
 *  Thread context is deliberately NOT built here. A capture records just its direct
 *  parent id, and `hydrateReplyChains()` (utils/parsing.ts) links the batch into the
 *  nested ancestor chain, reusing the cycle guard and depth bound X's parser already
 *  relies on. Building the chain per post instead would embed a copy of every ancestor
 *  in every descendant — quadratic prompt tokens on a deep thread. */
export interface CapturedPost {
  post: MainTweet;
  /** Id of the post this one directly replies to, when the platform exposes it. Fed
   *  into `hydrateReplyChains` through the same `__replyParentId` marker X's parser
   *  sets, so both capture paths converge on one linking implementation. */
  replyParentId?: string | null;
}

/** One element a post's classified text is rendered into, and the slice of that text
 *  it shows.
 *
 *  Regions are ordered and non-overlapping, and together they cover every character of
 *  the classified text: `el.textContent` must equal the text between `start` and `end`. */
export interface TextRegion {
  el: Element;
  /** Half-open offsets into the post's classified text: [start, end). */
  start: number;
  end: number;
}

export interface PlatformAdapter {
  id: PlatformId;

  /** Hostnames this adapter claims, lowercased and without a leading `www.`. */
  hosts: readonly string[];

  /** Whether this platform renders its posts inside a same-origin child frame rather
   *  than in the top document.
   *
   *  The coordinator runs in EVERY frame of a platform page (`allFrames` on the content
   *  script) because a platform's own UI can put a post anywhere, and Naver Cafe is the
   *  one that does: an article — the post, its comments, its buttons — is a same-origin
   *  `#cafe_main` iframe, while a board's list of articles is the top document.
   *
   *  Every other platform's posts are in the top frame, so their coordinator must bail in
   *  a child frame rather than treat a frame's chrome as a page of posts; an adapter that
   *  does not set this is only ever driven from frame 0. Set it and the coordinator runs
   *  here too, and measures "on screen" through the TOP window's viewport — a frame sized
   *  to its own content has no viewport of its own to measure against. */
  frameScoped?: boolean;

  /** The post id a permalink points at, or null when this URL is not a single post.
   *  Used to re-apply injections after in-page navigation (feed → detail → back). */
  postIdFromUrl(url: URL): string | null;

  /** Every on-screen element whose text a classification with this id covers.
   *  Returns [] when the post is not currently in the DOM — callers already read
   *  that as "nothing to point at" and do nothing. */
  postRoots(id: string): Element[];

  /** The id of the post a root element represents, or null when it is a quoted card
   *  or not a post at all. This is what lets a caller tell a main post from a nested
   *  one rather than guessing from layout. */
  postIdOf(root: Element): string | null;

  /** The element holding a post's body text, or null when the structure does not
   *  match. Never returns the injected highlights themselves. */
  textElement(root: Element, ref: PostRef): Element | null;

  /** Every element a post's classified text is spread across, with the slice of that
   *  text each one renders — or null/undefined when the post's text is all in
   *  `textElement`.
   *
   *  A platform can render one post as several sibling blocks (Reddit: a title above
   *  its body) while still classifying them as ONE post, because the worker reads them
   *  together and splitting them would bill two classifications for one submission.
   *  The highlight layer rebuilds the content of whichever element it is handed, so it
   *  can only paint one block — handed two blocks' worth of segments it writes the
   *  title into the body. Returning the regions lets it cut the segments and paint each
   *  block with its own slice.
   *
   *  `textElement` must be one of these, so a caller that needs a single anchor keeps
   *  working. Optional: X needs none, a tweet being a single element. */
  textRegions?(root: Element, ref: PostRef): TextRegion[] | null;

  /** Paint highlights over the post's own text nodes instead of replacing the
   *  element's content with the classified text.
   *
   *  The default (X) rebuilds the element from `segments`, which is right for a body
   *  that is a single inline run of plain text: the rebuild has to re-mint X's links,
   *  and X's renderer needs its own child nodes handed back on a language switch.
   *  A platform whose body is markup — Reddit's markdown, and most of the platforms
   *  after it — cannot survive that: rebuilding from text flattens links, headings and
   *  list items into one paragraph. Those platforms opt in here, and the highlight
   *  layer then wraps the claimed stretches in place, leaving the rest of the body's
   *  DOM — every element, every link, every font — exactly as the page built it. */
  highlightInPlace?: boolean;

  /** Insert `container` into `root` at the platform's top-of-post position. Only
   *  called when `container` is not already connected.
   *
   *  When every anchor the placement knows of is missing — including its own structural
   *  fallbacks — insert NOTHING and leave the container detached. A pill dropped
   *  somewhere plausible instead (the top of the post, say) is both wrong to look at and
   *  worse than absent, because the post then counts as injected: the selection rule
   *  below treats a post carrying our buttons as one the extension has already handled
   *  and hands the user's selection to the post's own flow instead of fact-checking it.
   *  A post we could not place buttons on must stay a post we can still be used on, so
   *  the miss costs it the buttons and nothing else.
   *
   *  Rendering nothing is also what keeps a platform's markup change survivable: the
   *  anchor breaks, no post is marked injected, and selecting the post's text still
   *  fact-checks it as a web selection. */
  placeButtons(container: HTMLElement, root: Element, ref: PostRef): void;

  /** Horizontal center of the platform's feed column, or null to fall back to the
   *  viewport center. Keeps the floating buttons over the feed rather than the page. */
  feedCenter(): number | null;

  /** Whether this id currently belongs to a native post on this page. Decides whether
   *  the floating buttons center on the feed and whether a selection counts as a
   *  native post rather than a web selection. */
  isPostTarget(id: string): boolean;

  /* ── Long-form posts: the reader chooses which way in ────────────────────────────
   *
   *  A long post is reached two ways, and the reader's own action picks between them. The
   *  PILL is the fast way in: it classifies — and bills — the whole body, and clicking it
   *  behaves exactly as clicking the pill on any other post does. A SELECTION inside the
   *  post is the slow way in: the reader pays for the passage they asked about and nothing
   *  else, read inside the post's own bounds, with the post's author, ancestors and quotes
   *  as its context. Neither displaces the other, and nothing about the post stops being
   *  first-class — it is still captured, and still the ancestor in its comments' hash and
   *  classification context (see [[buttonless-surfaces-stay-in-the-chain]]).
   *
   *  So this hook no longer decides whether a post has buttons; the threshold decides only
   *  which of the two ways a SELECTION is read. See `entrypoints/selection.ts` for where
   *  that is resolved.
   *
   *  Answered per ROOT, because the same post can be rendered whole on one surface and
   *  clamped on another, and the answer must not depend on which one is on screen: the
   *  threshold is the length at which the HOST stops showing a post whole, applied
   *  wherever the post appears rather than only where it is actually clamped.
   *
   *  MEASURED, once, for every platform: `LONG_FORM_CHARS`. It is the same number whether or
   *  not this particular host clips this particular render, because whether a post is long is
   *  a fact about the post rather than about the column width the reader happens to be
   *  looking at it in. See that constant for why it stopped being per-platform.
   *
   *  WHICH POST TYPES ARE JUDGED AT ALL is the other half of the rule, and it is decided per
   *  platform rather than per number:
   *
   *  - A post type that is almost always long is judged long-form unconditionally and not
   *    counted (Quora answers): its selection is always the passage one, and its pill is
   *    the click-the-whole-thing option beside it.
   *  - A post type that is almost always short is never long-form, whatever its length: a
   *    selection inside it fires the post whole, exactly as it always has. That is every
   *    platform's COMMENTS and comments-on-comments, which is the shape this integration is
   *    for — and it is why each `isLongForm` refuses comments before it measures anything.
   *  - Everything in between is judged against the platform's number, on every surface,
   *    whether or not the host happens to clamp it there.
   *
   *  A platform whose own post cap is already below the universal number cannot reach it and
   *  does not implement the hook — Bluesky (300) and Threads (500). Truth Social was listed
   *  here as a 500-character platform and is not one: measured, its composer takes posts past
   *  3000 characters (a live feed carried 2629, 3007 and 2329), and what it actually does is
   *  clamp the BODY at 160px of height. It implements the hook — see its `isLongForm`. */

  /** Whether a selection inside this root is read as a passage in the post rather than as
   *  a click on the post.
   *
   *  Has to be cheap — it is asked once per root per sweep, and again for every root a
   *  selection touches — and it must not itself expand the post, so a root whose host
   *  hides the rest behind a "See more" is judged on what is on screen. Present only on
   *  the platforms where a long post is a routine shape; everywhere else a selection
   *  inside a post always fires the post, as before.
   *
   *  `ref` is passed by the callers that have it in hand; X needs it to find the post's
   *  own text inside a container that also holds whatever the post quotes. */
  isLongForm?(root: Element, ref?: PostRef): boolean;

  /** The nearest ancestor native post element containing `node`, or null. Drives the
   *  rule that a selection lying entirely inside a post is not a web selection. */
  postElementFor(node: Node): Element | null;

  /* ── DOM capture ────────────────────────────────────────────────────────────────
   *
   *  Optional, and present only on platforms whose posts reach the extension through
   *  the DOM. X leaves these undefined because its posts arrive as JSON from the
   *  MAIN-world XHR interceptor (capture.main.content.ts), which carries fields the
   *  rendered markup never shows. A platform that fetches its posts as JSON should
   *  grow an interceptor of its own rather than be forced through markup. */

  /** Every post/comment currently rendered that should carry DisinfaX buttons. Runs on
   *  DOM mutations, so it must be cheap and must not return injected markup of ours. */
  captureRoots?(): Element[];

  /** Lift one root into a classify payload, or null when the element is not a
   *  classifiable post (a deleted stub, a "load more" shell, an ad). */
  capture?(root: Element): CapturedPost | null;

  /* ── A body the host is holding back ────────────────────────────────────────────
   *
   *  A post is identified by the hash of its text, so a host that renders only part of a
   *  post and holds the rest behind its own control ("(more)", "See more") cannot be filed
   *  from what is on screen: a hash over a clipped prefix names no post at all. So a post
   *  the host has withheld is filed from its PAYLOAD where the platform carries one, and
   *  otherwise waits for the reader.
   *
   *  A clamp is painted, and the host's own control is what makes that safe. Our painter
   *  moves a body's own children into a wrapper of ours (`renderSegmentsInPlace`); the
   *  host's expander re-renders the body it belongs to, and when that control is one of the
   *  children we moved, the host's `removeChild` lands on a node whose parent is now our
   *  wrapper and throws — measured on Substack (every card on the feed gone in two seconds)
   *  and again on LinkedIn (`NotFoundError: Failed to execute 'removeChild'`, the post torn
   *  out of the DOM). So the painter never moves it: `bodyControl` names the host's own
   *  control for the body about to be wrapped, and everything up to that control is wrapped
   *  while the control is left exactly where the host put it. Measured on LinkedIn with that
   *  one change, the reader's own press expanded the body with no throw, the wrapper intact,
   *  and the whole text inside it.
   *
   *  So a clipped body IS painted, and the clamp does the clipping for us: a highlight past
   *  the cut is hidden by the host's own box until the reader expands the post, and a
   *  highlight the cut runs through is simply cut with it. Nothing is ever keyed on a prefix,
   *  because a prefix names no post. A body the host is holding back is instead filed from its
   *  payload where the platform carries one, read back off the page where the host's own
   *  affordance can be pressed (`revealClipped`), and left for the reader where neither is
   *  available.
   *
   *  Present wherever `capture` or the painter has a clipped post to think about. A platform
   *  that can neither file nor paint a clipped post leaves this off and lets `capture` refuse
   *  it on its own reading. */

  /** Whether the host is currently showing less of this root's body than it holds — a CSS
   *  clamp whose words are all in the DOM, or a cut whose words are not there at all. Read
   *  by the painter for every post it is about to paint into, and by `capture` on the
   *  platforms where a cut prefix names no post. Cheap: a measurement of the box, or a
   *  query for the host's own affordance, and nothing else. */
  bodyClipped?(root: Element): boolean;

  /** Give a clipped body its whole text back, by driving the host's own affordance.
   *
   *  Called, and awaited, immediately before `capture` reads a clipped post, and only for
   *  posts the reader has reached. It is a real interaction with the host, so it is expected
   *  to be serialized by the adapter and to leave the page more readable than it found it —
   *  unlike `revealSource`, there is nothing to put back: the reader is owed the text the host
   *  was holding. What the host offers instead of a way back is its own business, and measured
   *  on the two hosts that cut a string out of the page rather than hiding a box, there is none
   *  to take: Quora's "(more)" is gone once the answer opens, and the m-site's expander is gone
   *  once the story opens, with no "less" control behind either. A gated body on Mastodon is
   *  the one toggle, and it still stays open: everything downstream reads the body back out of
   *  the page — the hash, the highlight ranges, the anchor our buttons are placed against — so
   *  a body shut again after the read is a classified post with no buttons on it at all.
   *
   *  Only for a host where the text is reachable no other way. A CSS clamp needs none of this
   *  (every word is already in the DOM), and neither does a host that states the whole text in
   *  a payload, so an implementation must return early for any root whose text it can already
   *  read, and press only for the ones it cannot.
   *
   *  `capture` is not required to file the post if this fails. A post whose text is still
   *  clipped is one nothing can hash, so it is skipped for this pass and tried again on a later
   *  one; the adapter must bound its own retries rather than click forever.
   *
   *  `onDemand` names a second reason for the call: the reader clicked one of our buttons on
   *  this post and the body they were owed did not open. The bounds above are sized for a sweep
   *  — they exist so a host refusing to open cannot be clicked at on every pass — and a reader
   *  asking is not a sweep, so an exhausted budget must not answer their click with nothing.
   *  Same hook, same page state, one unrefusable try. */
  revealClipped?(root: Element, opts?: { onDemand?: boolean }): Promise<void>;

  /** Note which of `roots` are showing a translation rather than the post's own words, on a
   *  platform whose markup cannot say so.
   *
   *  Called, and awaited, at the top of the clipped pass — before `bodyClipped` is asked about
   *  any of these roots — because an adapter that can only tell a translated body apart by its
   *  WORDS (a language detector, for a host that swaps the text in place without updating what
   *  its markup states) has to answer before the pass decides what is held back. Implementations
   *  must cache their verdict per element: the pass runs again on every mutation. Nothing may
   *  change for a root the adapter cannot judge; a root left without a verdict is read exactly
   *  as it is today. */
  detectTranslatedSides?(roots: Element[]): Promise<void>;

  /** The host's own control for the body `body` is, or null when this body holds none.
   *
   *  Named so the painter can leave it alone: `renderSegmentsInPlace` wraps everything in
   *  the body UP TO whatever this returns and never moves the control itself, which is what
   *  lets the host re-render from its own control without the `removeChild` that a moved
   *  control causes. See the block above for the measurement.
   *
   *  Implementing this is what says the platform's clipped bodies may be painted at all —
   *  the painter asks for it before it paints one. A platform whose clamp it cannot name the
   *  control of leaves this off: its clipped bodies stay unpainted until the reader opens
   *  them, which is where the whole text is painted for the first time. */
  bodyControl?(body: Element): Element | null;

  /* ── The host's own translation ─────────────────────────────────────────────────
   *
   *  A platform can translate a post in place, in which case only one side of it is
   *  ever in the DOM and the side that is missing may be missing entirely — Telegram
   *  renders the translation in place of the original, and the original is then in no
   *  text node, no attribute, no page store and no payload (measured; Web A delivers
   *  over a WebSocket, so there is no response to read either).
   *
   *  That matters because a post is identified by the hash of its SOURCE text
   *  (`canonicalContext` in utils/intelligence.ts), so the two sides of one post are
   *  one post. A platform that leaves the source readable needs neither hook below,
   *  and most do. */

  /** Recover a post's own text when the platform is showing a translation of it.
   *
   *  Called, and awaited, immediately before `capture` reads a post the platform is
   *  displaying a translation of, so `capture` sees a page left exactly as it was:
   *  whatever this does to the host's own controls must be undone before it returns.
   *
   *  It is called once per post, before the post is captured, and — because it is
   *  visible to the reader when it happens at all — only for posts the reader has
   *  reached. A post whose source cannot be recovered is read as its own source, which
   *  is what happens today; nothing downstream has to handle a half-read post.
   *
   *  `true` asks for another pass soon: the attempt did not land and the post may still be
   *  recovered — the usual case is a first pass that ran before the host had hydrated the
   *  control the flip presses. Sweeps otherwise follow the page's own mutations, and a feed
   *  the reader only looks at makes none, so without this the second attempt never happens
   *  and the post never gets its buttons. Answer `false` (or nothing) once nothing more can
   *  be done, including after the adapter's own attempts are spent. */
  revealSource?(root: Element): Promise<void | boolean>;

  /** The language of the translation this post is showing, or null when it is showing
   *  its own text — which is also the answer for a platform with no translation at all.
   *
   *  Asked on every sweep for every post in reach, so it has to be cheap: one query, no
   *  text read. Read for two things. It decides which posts need `revealSource`, and it
   *  notices the reader flipping a post to the other side themselves — the one thing
   *  about a post that can change after it has been captured, and the thing that decides
   *  which language its highlights have to address.
   *
   *  The locale is part of the answer rather than a separate question because it is what
   *  a flip is reported AS: the background files highlights under it. A platform that can
   *  say a translation is on screen but not what language it is in returns `und` — never a
   *  guess — and sets `translationLocaleIsGuessed` so the side is reported by its body.
   *
   *  Returns null for a post whose source is on screen even when the source's own
   *  language is known — this hook is about the DISPLAYED side, and the source's language
   *  is the capture's business, not this one's.
   *
   *  Returns `undefined` for a post whose side the platform cannot name AT ALL — not the
   *  source, not a translation it can name. A page whose side must be learned by flipping
   *  answers this until it has learned one, and null there is a lie with a cost: the flip
   *  to the translation is reported as a return to the source, the body on screen is
   *  recorded as the capture's, and the next press classifies the side nobody is reading.
   *  Such a side is reported by its BODY (`bodyOnly`, the same path as
   *  `translationLocaleIsGuessed`), and `sideUnknown` is what says it may need a flip
   *  first. */
  displayedTranslationLocale?(root: Element): string | null | undefined;

  /** Whether the platform cannot say which side a post is showing, and the post carries the
   *  host's translation control, so `revealSource` has to flip it to learn which side is up.
   *
   *  Asked on every sweep for every post in reach. It exists because a platform can hide its
   *  translation state across page loads: the side is then in the DOM only as the control's own
   *  label, which is translated per reader, so it has to be learned by flipping once — and until
   *  it is learned, `capture` must not file a body that may be the translation. A platform that
   *  can always answer `displayedTranslationLocale` needs neither this nor the deferral. */
  sideUnknown?(root: Element): boolean;

  /** Whether `displayedTranslationLocale` names a side only by DEFAULT: the host translates
   *  into a target chosen in its own UI and states nothing, so the honest answer is `und`
   *  (an unknown language) and the side is identified by the BODY instead.
   *
   *  A platform that sets this reports every translated side by body alone
   *  (`bodyOnly` in `maybeSyncDisplayedLocaleFromDom`). Ranges are filed `<locale>:<hash>`, so
   *  `und` still tells the source, the translation and every other rendering apart by hash —
   *  while naming a guess hands another language's offsets to the painter. Measured on
   *  Telegram, switching the target from English to French painted the English ranges over the
   *  French words instead of offering that side a Localize. `und` is also the key a paid
   *  localization of such a side files its own ranges under.
   *
   *  Only where `displayedText` is the whole body. A platform whose rendered translation is a
   *  clamp of, or a re-fetch of, a stored string keeps its named locale: those are renderings
   *  of the same side, and a body-first report would drop this side's ranges on the wrong
   *  hash. */
  translationLocaleIsGuessed?: boolean;

  /** The body of the side a post is showing, for the one path that has to hand the
   *  background a text along with a locale.
   *
   *  Asked only when the reader's own flip is being reported, never on a sweep — this is a
   *  text read, and the hook above is deliberately one query and no text.
   *
   *  It exists because a post captured with only one side on screen has no destination
   *  language for the background to resolve the other side from: a post read in its source
   *  and flipped afterwards arrives with a locale and nothing else, and the background then
   *  localizes against the text it holds — the source — while filing the ranges under the
   *  locale the reader is looking at. Those ranges are measured against words the claims
   *  never named. Passing the displayed text is what makes the two agree. */
  displayedText?(root: Element): string | null;

  /** The two sides of ONE post the platform is showing at the same time, or null when it
   *  is showing one.
   *
   *  A platform that REPLACES a post's words with a translation has one side on screen and
   *  needs neither hook here. A platform that ADDS the translation beside them has both, and
   *  then `textElement` names only one of them: the side the reader is reading. This is how
   *  the other side is named, so its highlights can be painted under it as well — one post,
   *  two bodies, both sourced from the same claims and both following the same Hide/Reveal.
   *
   *  Returns the pair NAMED rather than merely listed, because the painter needs to know
   *  which is which: the one `textElement` does not return is the one still to be painted.
   *  Null when either side is absent — a post with one side has nothing to pair — and null
   *  when the two are the same element or one contains the other. */
  dualTextElements?(root: Element, ref: PostRef): { source: Element; translation: Element } | null;

  /** Seat a post's SECOND button group at the platform's own translation-side row, the row
   *  the reader turns the translation off in.
   *
   *  The counterpart of `placeButtons` for the side `textElement` does not name: the first
   *  group stays where it has always been, and this one is what makes the pair read as two
   *  sides of one post rather than one post with a stray pill. Implemented only where that
   *  row has been measured to have room — an adapter that cannot say where it goes leaves
   *  this off, and its second side carries highlights and no buttons. */
  placeTranslationButtons?(container: HTMLElement, root: Element, ref: PostRef): void;

  /* ── Network capture ────────────────────────────────────────────────────────────
   *
   *  Optional, and the preferred source wherever a platform feeds its own UI from a
   *  JSON API: a payload carries fields the rendered markup never shows (a post's
   *  language, its ancestor chain, its full untruncated body), and it arrives before
   *  the post is rendered, so the buttons are there the moment the post is. The DOM
   *  path stays as the fallback for posts no response covers. */

  /** Turn records forwarded by the platform's MAIN-world interceptor into classify
   *  payloads. `records` is page-authored data of the platform's own shape, so an
   *  implementation validates every field it reads and drops anything it cannot name. */
  captureNetwork?(records: unknown[]): CapturedPost[];

  /** Take in a platform's own translation of a post, forwarded from the same MAIN-world
   *  interceptor as `captureNetwork` and validated the same way.
   *
   *  Not a capture: a translation carries no post identity, no author and no source text —
   *  it is the one thing only the platform can tell us about a post we already hold, and it
   *  exists solely because the reader asked for it. It is therefore state to be remembered,
   *  not a payload to be classified: a platform whose DOM cannot say which side is on screen
   *  uses it to answer `displayedTranslationLocale`, and a platform whose payload carries
   *  both sides needs it not at all and omits the hook. */
  absorbTranslations?(records: unknown[]): void;

  /** Take in the thread edges a platform's own API states, forwarded from the same
   *  MAIN-world interceptor as `captureNetwork` and validated the same way.
   *
   *  Like `absorbTranslations`, not a capture: an edge names no text and no author, so
   *  there is nothing to classify — it is one fact about a comment the page also renders,
   *  and it exists only because some hosts state a thread edge in their markup
   *  INCOMPLETELY. Facebook's reply link names the comment a reply answers when that
   *  comment is top-level, and the thread's ROOT when the reply answers another reply
   *  (measured 120/120 right at depth 1, 0/32 at depth 2), and no part of the rendered
   *  layout makes up the difference. Every ancestor is part of the post's hash, so a
   *  sub-reply filed with the markup's reading carries the wrong chain.
   *
   *  Returns the edges now remembered, keyed by the adapter's own id for the child and
   *  valued by its parent's, so the coordinator can correct a comment it captured before
   *  the payload that describes it arrived. A comment captured after the payload needs no
   *  correction: the adapter reads its own map while capturing. */
  absorbThreadEdges?(records: unknown[]): Map<string, string>;

  /** Take in the id a platform's own payload states for a post, and the other names the same
   *  payload uses for it, forwarded from the same MAIN-world interceptor as `captureNetwork`
   *  and validated the same way.
   *
   *  Not a capture: an id names no text, no author and no language. It is the join between the
   *  id a post is filed under and the ids its markup carries — the host naming ONE post several
   *  ways, which leaves a post and its own comments unable to link. Facebook's markup states a
   *  story's `pfbid…` or the id of one of its PHOTOS, and neither is the story's own `post_id`,
   *  which is the number its comments' links encode (see `facebookPostIds.ts`).
   *
   *  A platform whose markup already states the id it files under omits the hook. */
  absorbPostIds?(records: unknown[]): void;

  /** Take in what a platform's own payload says each comment says, keyed by the comment's own
   *  id, forwarded from the same MAIN-world interceptor as `absorbPostIds`.
   *
   *  Not a capture either: a comment's words are read off the page, and this only supplies the
   *  remainder of a text the page chose to show a prefix of — the same job `postIdMessages`
   *  does for a truncated post. Facebook states a comment's words at a field of its own, under
   *  the decimal id the comment's permalink already names it by (see `collectCommentTexts`). */
  absorbCommentTexts?(records: unknown[]): void;
}

/** The length past which a post stops being one the reader takes in at a glance.
 *
 *  ONE number, on every platform, deliberately. It used to be measured per platform — the
 *  character count at which that host's own "more" appears — and that turned out to measure
 *  the HOST'S LAYOUT rather than the post: Facebook clips at two lines, so its number came
 *  out at 250, while the same 300-character post is shown whole in a wide column and clipped
 *  in a narrow one. The reader got a different meaning for the same length on every platform,
 *  and the numbers drifted (100, 250, 500, 1500) for no reason they could see.
 *
 *  500 is long by every platform's measure — past every clip any of them was measured at —
 *  so a post under it is one the reader has read, and a post over it is one whose WHOLE body
 *  is classified and billed before any part of it can be acted on.
 *
 *  This decides only which of the two ways a SELECTION inside a post is read (see
 *  `isLongForm`); it has not decided whether a post has buttons since the long-post change. */
export const LONG_FORM_CHARS = 500;
