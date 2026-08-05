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

/** Account standing, mirroring X's `verification.verified_type` values. `Regular` uses
 *  X's own "None" string so an unverified account round-trips through the raw payload. */
export enum Usertype {
    Business = "Business",
    Government = "Government",
    Verified = "Verified",
    Regular = "None"
}

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