export interface Tweet {
    id: string;
    text: string;
    /** The raw original-language tweet body from legacy.full_text. This is the exact
     *  string used to compute the tweet hash (see computeTweetHash), so it must match
     *  byte-for-byte what any backend worker hashes. Unlike `text`, it never uses the
     *  note_tweet (long-tweet) expansion — it is always legacy.full_text verbatim. */
    fullText: string;
    username: string;
    usertype: Usertype;
    conversationId?: string;
}

export type QuotedTweet = Tweet

export interface References {
    quoting: QuotedTweet | null,
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

export enum Usertype {
    Business = "Business",
    Government = "Government",
    Verified = "Verified",
    Regular = "None"
}

export enum TweetType {
    HomeTimeline = "Home Timeline",
    Detail = "Detail",
    MainDetail = "Main Detail",
    GenericTimelineById = "Generic Timeline by ID",
    SearchTimeline = "Search Timeline",
    ExplorePage = "Explore Page"
}

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