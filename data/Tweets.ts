export interface Tweet {
    /** The tweet's own status id. For a repost this is the ORIGINAL tweet's id, not the
     *  repost wrapper's, so it matches the status link X renders in the DOM. */
    id: string;
    /** The tweet body as displayed: the note_tweet (long-tweet) expansion when there is
     *  one, otherwise legacy.full_text. This is what gets highlighted, so it is the text
     *  claim offsets are measured against. */
    text: string;
    /** The raw original-language tweet body from legacy.full_text. This is the exact
     *  string used to compute the tweet hash (see computeTweetHash), so it must match
     *  byte-for-byte what any backend worker hashes. Unlike `text`, it never uses the
     *  note_tweet (long-tweet) expansion — it is always legacy.full_text verbatim. */
    fullText: string;
    /** The author's display name (X's `core.name`), not the @handle. */
    username: string;
    usertype: Usertype;
    /** Id of the thread this tweet belongs to; falls back to the tweet's own id when X
     *  omits it. */
    conversationId?: string;
    /** When the post was written, as an ISO 8601 instant in UTC (`2026-10-14T13:27:04Z`), or
     *  the last time it was edited when the host states that and the authoring time is the older
     *  of the two.
     *
     *  Stated only as far down as the platform stated it. A host handing over a time is believed
     *  for that time and no further, so one whose own value reads `1:14 PM` produces
     *  `2026-10-14T13:14Z` and not a `:00` it never looked at; a host that states only an AGE
     *  states no instant at all, and the value carries that age's own unit: `2026-10-14T04Z` for
     *  `5h`, `2026-10-11` for `3d`, `2020` for `6y`. Fields neither could place are ABSENT rather
     *  than zeroed — a zero is indistinguishable from a post written at exactly that second, and
     *  the prompt is told to read this value as the present moment, so a defaulted one would be
     *  read as fact. Consumers must therefore not assume a full instant is always present.
     *
     *  What reads it is the preclassify prompt's "today is" note: a post saying "this morning" or
     *  "last month" is only resolvable against the moment it was WRITTEN, so the note is built
     *  from this rather than from the wall clock the request happens to arrive at. The agent's
     *  own JSON never carries it (`agentView` drops it) — the note is the one place the model
     *  sees it.
     *
     *  Absent rather than guessed when there is nothing to read: a host that states no absolute
     *  time for a post, a label in a spelling the age reader does not cover, and everything that
     *  is not a post at all (a claim typed into the popup, a passage selected on a page) all
     *  leave it out. It is deliberately outside the hash (`canonicalContext` covers
     *  the username and the text alone), so a post classified before this field existed keeps
     *  its row and its cache key. */
    datetime?: string;
}

/** A quoted tweet carries no references of its own — nesting stops at one level. */
export type QuotedTweet = Tweet;

/** The other tweets a tweet points at, resolved to full objects rather than bare ids so
 *  the preclassify agent and the tweet hash both see the surrounding context. */
export interface References {
    quoting: QuotedTweet | null;
    /** The tweet this one is replying to, as a fully-parsed nested tweet (original
     *  source-language text, same as `quoting`) — NOT a bare status ID. Populated by
     *  hydrateReplyChains() when the parent is present in the same batch/thread; null
     *  otherwise. Part of the tweet hash, so the preclassify agent and the hash both
     *  see real reply-thread context. */
    replyingTo: MainTweet | null
}

export type MainTweet = Tweet & References & {
    /** Grok-translated tweet text (X's automatic translation). Present when
     *  the tweet has been auto-translated by Grok for the viewer's locale. */
    translatedText?: string;
    /** The source locale of the original tweet (e.g. "ja"). Present when
     *  grok_translated_post_with_availability/is_translatable is true. */
    sourceLanguage?: string;
    /** The destination locale of the translation (e.g. "en"). Present when
     *  grok_translated_post_with_availability/is_translatable is true. */
    destinationLanguage?: string;
}

/** The language key for a post on a platform that states its language NOWHERE — neither
 *  in its payload nor in its markup.
 *
 *  Every highlight range is persisted under "<language>:<text hash>", so a post with no
 *  language has no key to file its ranges under. The background falls back to the reader's
 *  own UI locale in that case, which looks harmless and is not: the same post read by a
 *  French-UI user and an English-UI user is filed under two different keys, so the second
 *  reader finds no highlights for their locale and is offered a paid re-localization of a
 *  post that is already classified. A single named key makes the choice reader-independent.
 *
 *  `und` is ISO 639-3's "undetermined" code and is already what X emits from `legacy.lang`
 *  when it cannot name a language, so nothing downstream is seeing a value it has never
 *  seen. It is deliberately not "NA" (the obvious-looking spelling): `na` is Nauruan's
 *  ISO 639-1 code, so a key spelled that way would claim to be a real language. */
export const UNKNOWN_LANGUAGE = 'und';

/** The longest text a fact-check run will accept, on every platform and on every surface:
 *  a post's own body, or a passage the reader has selected.
 *
 *  A capability limit, not a layout one. Past roughly this length both agents come back
 *  with a handful of the claims the text actually makes, so the reader waits out a run and
 *  is billed for a fraction of an answer. It is read in two places — the background drops a
 *  post over it before anything else runs (see `processFullBatch`), and the selection script
 *  refuses a passage over it before a run starts — which is why the number lives here rather
 *  than beside either one of them.
 *
 *  Deliberately not `LONG_FORM_CHARS` (500), a different number measuring a different thing,
 *  and deciding nothing. */
export const MAX_CLASSIFY_CHARS = 1500;

/** Account standing, mirroring X's `verification.verified_type` values. `Regular` uses
 *  X's own "None" string so an unverified account round-trips through the raw payload. */
export enum Usertype {
    Business = "Business",
    Government = "Government",
    Verified = "Verified",
    Regular = "None"
}

/** What the preclassify worker accepts: a tweet, or a claim standing in for one.
 *
 *  The two identity fields are empty when no account stands behind the text — a claim typed
 *  into the popup's Fact-Check tab, or a passage the user selected on a page. X's standings
 *  have no value for "there is no account", so the empty string means exactly that, and the
 *  worker's prompt is told to ignore both fields in that case.
 *
 *  `fullText` is NOT part of that anonymity: it carries the text the worker hashes and the
 *  model fact-checks, so it is never empty however anonymous the input is.
 *
 *  `MainTweet` is assignable to this, so nothing in the X.com path has to change. */
export type ClaimInput = Omit<MainTweet, 'usertype'> & { usertype: Usertype | '' };

/** Which X endpoint a batch of tweets came from. Used to pick the right response shape
 *  in utils/parsing.ts and to label parse failures in the logs. */
export enum TweetType {
    HomeTimeline = "Home Timeline",
    Detail = "Detail",
    MainDetail = "Main Detail",
    GenericTimelineById = "Generic Timeline by ID",
    SearchTimeline = "Search Timeline",
    ExplorePage = "Explore Page",
    Bookmarks = "Bookmarks",
    ListTimeline = "List Timeline",
    UserTimeline = "User Timeline",
    CommunityTimeline = "Community Timeline"
}

/** Names the payload field that was missing when parsing fails. The string values are
 *  interpolated straight into the log line, which is why they read as prose. */
export enum TweetFieldType {
    ID = "ID",
    Text = "text",
    User = "user",
    Username = "username",
    Usertype = "usertype",
    Core = "core",
    Legacy = "legacy",
    Entries = "batch of"
}