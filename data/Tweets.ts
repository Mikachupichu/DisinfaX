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