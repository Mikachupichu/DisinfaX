/** Parsers for X's GraphQL timeline responses.
 *
 *  Each exported `parse*` function takes one intercepted response body (see
 *  entrypoints/capture.main.content.ts) and walks the shape X returns for that
 *  endpoint down to the list of tweet entries, then hands each entry to the shared
 *  `parseTweet`. The deep optional-chained paths mirror X's own response nesting;
 *  they are intentionally tolerant, since any shape change upstream should make a
 *  parser return nothing rather than throw.
 */

import { MainTweet, TweetType, TweetFieldType, Usertype, QuotedTweet } from '../data/Tweets';

/** Entry-id fragments for timeline rows that are not user tweets (ads, carousels,
 *  cursors, follow suggestions). Matched as substrings against `entryId`. */
const excludedEntryIds = ['promoted', 'stories', 'pinned', 'cursor', 'trends-accounts', 'trend', 'who-to-follow', 'toptabsrpusermodule'];

/** X's own assistant account, whose replies are never worth classifying. */
const ASSISTANT_SCREEN_NAME = "grok";

/** The @handle on a tweet_results result, or undefined if the payload lacks it. */
function screenNameOf(tweetResult: any): string | undefined {
    return tweetResult?.core?.user_results?.result?.core?.screen_name;
}

export function parseHomeTimeline(responseText: string): MainTweet[] | void {
    // Fixed-index instructions[0] misses the "Show N posts" prepend fetch, whose new
    // entries land in a later instruction (after a cache-clear/pin instruction at
    // index 0) — iterate all instructions like every other timeline parser instead.
    const instructions = JSON.parse(responseText)?.data?.home?.home_timeline_urt?.instructions;
    return parseTweets(collectAllEntries(instructions), TweetType.HomeTimeline);
}

export function parseTweetDetail(responseText: string): MainTweet[] | void {
    const parsed = JSON.parse(responseText);
    const instructions = parsed?.data?.threaded_conversation_with_injections_v2?.instructions;
    if (!instructions || !Array.isArray(instructions)) {
        console.log(`[parseTweetDetail] No instructions found in response`);
        return;
    }
    console.log(`[parseTweetDetail] Found ${instructions.length} instructions, searching for entries...`);

    // Collect entries from ALL instruction entries, not just [1]
    let allEntries: any[] = [];
    for (let i = 0; i < instructions.length; i++) {
        const entries = instructions[i]?.entries;
        if (entries && Array.isArray(entries)) {
            console.log(`[parseTweetDetail] instructions[${i}] has ${entries.length} entries: ${entries.map((e: any) => e.entryId).join(', ')}`);
            allEntries = allEntries.concat(entries);
        }
    }
    console.log(`[parseTweetDetail] Total ${allEntries.length} entries across all instructions`);

    const tweetType = TweetType.Detail;

    // Flatten: each entry may have items (ConversationThread) or direct itemContent,
    // or be an entry with its own nested items. Collect all individual tweet results.
    const tweetResultsList: { result: any; entryId: string }[] = [];

    for (const entry of allEntries) {
        const entryId = entry.entryId ?? '';
        if (excludedEntryIds.some(id => entryId.includes(id))) {
            console.log(`[parseTweetDetail] SKIP ${entryId}: excluded`);
            continue;
        }

        const items = entry.content?.items;
        const hasItems = items && Array.isArray(items);
        const itemContent = entry.content?.itemContent;
        const tweetResultDirect = itemContent?.tweet_results?.result;
        const tweetResultFirstItem = hasItems ? items[0]?.item?.itemContent?.tweet_results?.result : null;
        console.log(`[parseTweetDetail] Entry ${entryId}: hasItems=${hasItems}, hasItemContent=${!!itemContent}, hasTweetResultDirect=${!!tweetResultDirect}, hasTweetResultFirstItem=${!!tweetResultFirstItem}`);

        /** Log the accept/skip decision for one candidate and, when it is a keepable
         *  tweet, add it to tweetResultsList. `label` names the entry shape in the
         *  accept/skip lines, `logPrefix` is everything preceding `hasResult=` on the
         *  detail line, and `resultEntryId` is what a kept result is attributed to. */
        const collect = (tweetResult: any, label: string, resultEntryId: string, logPrefix: string) => {
            const username = screenNameOf(tweetResult);
            console.log(`[parseTweetDetail]   ${logPrefix}hasResult=${!!tweetResult}, hasUser=${!!username}, username=${username}, birdwatch=${!!tweetResult?.has_birdwatch_notes}`);
            if (username === ASSISTANT_SCREEN_NAME) return;
            if (tweetResult) {
                tweetResultsList.push({ result: tweetResult, entryId: resultEntryId });
                console.log(`[parseTweetDetail]   => ACCEPTED ${label}`);
            } else {
                console.log(`[parseTweetDetail]   => SKIPPED ${label}: no tweetResult`);
            }
        };

        if (hasItems) {
            // ConversationThread entry: iterate ALL items (main tweet + replies)
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                const tweetResult = item?.item?.itemContent?.tweet_results?.result;
                collect(tweetResult, `items[${i}]`, item.entryId ?? entryId, `items[${i}]: entryId=${item.entryId}, `);
            }
        } else {
            // Direct entry (no items array)
            collect(entry.content?.itemContent?.tweet_results?.result, 'direct', entryId, 'direct: ');
        }
    }

    console.log(`[parseTweetDetail] Extracted ${tweetResultsList.length} tweet results`);

    if (tweetResultsList.length === 0) return logTweetBatchParsingError(tweetType);

    let mainId: string | null = null;
    const tweetData: MainTweet[] = tweetResultsList.map(({ result }) => {
        const parsed = parseTweet(result, TweetType.Detail, mainId);
        if (parsed?.id && !mainId) mainId = parsed.id;
        return parsed;
    }).filter(Boolean) as MainTweet[];

    hydrateReplyChains(tweetData);
    return tweetData;
}

export function parseGenericTimelineById(responseText: string): MainTweet[] | void {
    return parseTweets(JSON.parse(responseText)?.data?.timeline?.timeline?.instructions?.[2]?.entries, TweetType.GenericTimelineById);
}

export function parseSearchTimeline(responseText: string): MainTweet[] | void {
    return parseTweets(JSON.parse(responseText)?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions?.[0]?.entries, TweetType.SearchTimeline);
}

export function parseExplorePage(responseText: string): MainTweet[] | void {
    return parseTweets(JSON.parse(responseText)?.data?.explore_page?.body?.initialTimeline?.timeline?.timeline?.instructions?.[1]?.entries?.[8]?.content?.items, TweetType.ExplorePage, true);
}

export function parseBookmarksTimeline(responseText: string): MainTweet[] | void {
    const parsed = JSON.parse(responseText);
    const instructions = parsed?.data?.bookmark_timeline_v2?.timeline?.instructions;
    if (instructions === undefined) probeUnknownShape('Bookmarks', parsed?.data);
    return parseTweets(collectAllEntries(instructions), TweetType.Bookmarks);
}

export function parseListTimeline(responseText: string): MainTweet[] | void {
    const parsed = JSON.parse(responseText);
    const instructions = parsed?.data?.list?.tweets_timeline?.timeline?.instructions;
    if (instructions === undefined) probeUnknownShape('List Timeline', parsed?.data);
    return parseTweets(collectAllEntries(instructions), TweetType.ListTimeline);
}

/** Covers every profile-tab query (UserTweets, UserTweetsAndReplies, Likes, UserMedia) —
 *  they all hang their instructions off the same `user.result.timeline` shape. */
export function parseUserTimeline(responseText: string): MainTweet[] | void {
    const parsed = JSON.parse(responseText);
    const instructions = parsed?.data?.user?.result?.timeline?.timeline?.instructions;
    if (instructions === undefined) probeUnknownShape('User Timeline', parsed?.data);
    return parseTweets(collectAllEntries(instructions), TweetType.UserTimeline);
}

export function parseCommunityRankedTimeline(responseText: string): MainTweet[] | void {
    const parsed = JSON.parse(responseText);
    const instructions = parsed?.data?.viewer?.ranked_communities_timeline?.timeline?.instructions;
    if (instructions === undefined) probeUnknownShape('Community Timeline', parsed?.data);
    return parseTweets(collectAllEntries(instructions), TweetType.CommunityTimeline);
}

export function parseCommunityExploreTimeline(responseText: string): MainTweet[] | void {
    const parsed = JSON.parse(responseText);
    const instructions = parsed?.data?.viewer?.explore_communities_timeline?.timeline?.instructions;
    if (instructions === undefined) probeUnknownShape('Community Explore', parsed?.data);
    return parseTweets(collectAllEntries(instructions), TweetType.CommunityTimeline);
}

/** Fires once per community card as the Communities page renders (its call count
 *  matches the number of tweets that show up unclassified in the DOM there), so it's
 *  the likely real source of those tweets — but its response shape is still completely
 *  unknown. Probe unconditionally rather than guess a third wrong path. */
export function parseCommunityFetchOne(responseText: string): MainTweet[] | void {
    const parsed = JSON.parse(responseText);
    probeUnknownShape('Community Fetch One', parsed?.data);
}

/** Logs the key path down through every nested object/array under `data`, so the real
 *  shape of an endpoint we guessed wrong can be read directly off the console instead
 *  of guessing a third time. Stops descending once it hits an array (that's almost
 *  certainly the entries list or something holding it). */
function probeUnknownShape(label: string, data: any, path: string = 'data', depth: number = 0): void {
    if (depth > 8 || data == null || typeof data !== 'object') return;
    if (Array.isArray(data)) {
        console.log(`[misinfo] shape probe (${label}): ${path} is an array of length ${data.length}, keys of [0]: ${data[0] ? Object.keys(data[0]).join(', ') : 'n/a'}`);
        return;
    }
    for (const key of Object.keys(data)) {
        const child = data[key];
        const childPath = `${path}.${key}`;
        if (Array.isArray(child)) {
            console.log(`[misinfo] shape probe (${label}): ${childPath} is an array of length ${child.length}, keys of [0]: ${child[0] ? Object.keys(child[0]).join(', ') : 'n/a'}`);
        } else if (child && typeof child === 'object') {
            console.log(`[misinfo] shape probe (${label}): ${childPath} -> {${Object.keys(child).join(', ')}}`);
            probeUnknownShape(label, child, childPath, depth + 1);
        }
    }
}

/** Concatenates entries from every instruction that carries them, instead of assuming
 *  a fixed index — every timeline endpoint (Home/Following included) interleaves
 *  entries-bearing instructions with others (TimelineClearCache, TimelineTerminateTimeline,
 *  pin/prepend instructions, ...) at positions that vary by request, not just by page. */
function collectAllEntries(instructions: any[] | undefined): any[] | undefined {
    if (!instructions || !Array.isArray(instructions)) return undefined;
    let all: any[] = [];
    for (const instruction of instructions) {
        if (Array.isArray(instruction?.entries)) all = all.concat(instruction.entries);
    }
    return all;
}

/** Shared timeline-entry path: drop non-tweet and assistant rows, then parse what
 *  remains. `isItem` selects where the tweet payload hangs off an entry — explore-page
 *  rows nest it under `item`, every other timeline under `content`. */
function parseTweets(entries: any | undefined, tweetType: TweetType, isItem: boolean = false): MainTweet[] | void {
    if (entries === undefined) { logTweetParsingError(TweetFieldType.Entries, tweetType); return; }
    const isExcludedRow = (entry: any) => excludedEntryIds.some(id =>
        entry.entryId?.includes(id) || entry.content?.items?.[0]?.entryId?.includes(id));
    const tweets = entries.filter((entry: any) =>
        !isExcludedRow(entry) && screenNameOf(entry.content?.itemContent?.tweet_results?.result) !== ASSISTANT_SCREEN_NAME);
    if (!tweets) return logTweetBatchParsingError(tweetType);
    const tweetData: MainTweet[] = tweets.map((entry: any) => {
        const tweetResults = (isItem ? entry.item : entry.content)?.itemContent?.tweet_results?.result;
        if (!tweetResults) return logTweetResultsParsingError(tweetType);
        return parseTweet(tweetResults, tweetType);
    });
    // Resolve any in-batch reply parents to nested tweet objects (rare in timelines,
    // where the parent usually isn't in the payload → replyingTo stays null).
    hydrateReplyChains(tweetData);
    return tweetData;
}

function parseTweet(tweetResults: any, tweetType: TweetType, mainId: string | null = null): MainTweet | null {
    const legacy = tweetResults.legacy;
    if (!legacy) return logTweetParsingError(TweetFieldType.Legacy, tweetType);

    // For retweets/reposts in timeline views, classify and inject against the
    // original tweet rather than the repost wrapper. The DOM status link in a
    // repost points to the original tweet, so the extension must key the
    // pipeline on that original ID to find and decorate the reposted tweet.
    // Detail views are excluded because they render the retweet entry itself.
    const retweetedResult = legacy.retweeted_status_result?.result;
    if (retweetedResult && tweetType !== TweetType.Detail && tweetType !== TweetType.MainDetail) {
        return parseTweet(retweetedResult, tweetType, mainId);
    }

    const id = tweetResults.rest_id ?? legacy.id_str;
    if (!id) return logTweetParsingError(TweetFieldType.ID, tweetType);

    const text = tweetResults.note_tweet?.note_tweet_results?.result?.text ?? legacy.full_text;
    if (!text) return logTweetParsingError(TweetFieldType.Text, tweetType);

    // Raw original-language body. This exact string is what gets hashed to key the
    // tweet in the DB, so keep it verbatim (no note_tweet expansion, no trimming).
    const fullText = legacy.full_text;

    const core = tweetResults.core;
    if (!core) return logTweetParsingError(TweetFieldType.Core, tweetType);

    const userResults = core.user_results?.result;
    if (!userResults) return logTweetParsingError(TweetFieldType.User, tweetType);

    const username = userResults.core?.name;
    if (!username) return logTweetParsingError(TweetFieldType.Username, tweetType);

    const verification = userResults.verification;
    const usertype = verification?.verified_type as Usertype ?? (verification?.verified || userResults.is_blue_verified ? Usertype.Verified : Usertype.Regular);

    const replyParentId: string | null = legacy.in_reply_to_status_id_str ?? mainId ?? null;
    const conversationId = legacy.conversation_id_str ?? id;

    // Extract Grok auto-translation data if available
    const grokData = tweetResults.grok_translated_post_with_availability?.data;
    const isTranslatable = tweetResults.is_translatable === true || tweetResults.grok_translated_post_with_availability != null;
    if (tweetResults.grok_translated_post_with_availability) {
        console.log(`[parseTweet] grok found for ${id}:`, JSON.stringify(tweetResults.grok_translated_post_with_availability).slice(0, 200));
    }
    const translatedText: string | undefined = grokData?.translation || undefined;
    // The original locale is always available from legacy.lang; when Grok translated,
    // source_language should match it, but we prefer the explicit value when present.
    const sourceLanguage: string | undefined = grokData?.source_language || legacy.lang || undefined;
    // Destination language only makes sense when Grok actually translated the tweet.
    const destinationLanguage: string | undefined = (isTranslatable && grokData?.destination_language) ? grokData.destination_language : undefined;

    let quoting: QuotedTweet | null = null;
    const quotedStatusResult = tweetResults.quoted_status_result?.result;
    if (quotedStatusResult)
        quoting = parseTweet(quotedStatusResult, tweetType, mainId);

    // `replyingTo` starts null; hydrateReplyChains() later swaps it for the parsed
    // PARENT TWEET OBJECT using the transient __replyParentId marker below (stripped
    // before the tweet leaves the parser). We never emit a bare status ID — quoted
    // tweets and unresolvable parents simply keep replyingTo = null.
    const tweet = { id, text, fullText, username, quoting, replyingTo: null, usertype, conversationId, translatedText, sourceLanguage, destinationLanguage } as MainTweet;
    if (replyParentId) (tweet as any).__replyParentId = replyParentId;
    return tweet;
}

/** Replace each top-level tweet's parent status-ID (captured as __replyParentId by
 *  parseTweet) with the actual parsed PARENT TWEET OBJECT when that parent is present
 *  in this batch/thread; otherwise leave replyingTo = null. The preclassify agent
 *  expects reply context as a nested tweet (original-language text, exactly like a
 *  quoted tweet), never a bare ID, and the tweet hash covers it.
 *
 *  Hardened against a hostile host platform (X could return malformed thread data):
 *  linking is acyclic by construction (an edge is skipped if the parent's ancestry
 *  already contains the child), and chain depth is bounded so a pathologically deep
 *  thread can't overflow the recursive hash / JSON serialization. All __replyParentId
 *  markers are stripped afterward so they never reach the hash input, worker, or agent. */
export function hydrateReplyChains(tweets: (MainTweet | null | void)[]): void {
    const MAX_THREAD_DEPTH = 20;
    const list = tweets.filter(Boolean) as MainTweet[];
    if (list.length === 0) return;

    const byId = new Map<string, MainTweet>();
    const parentIdOf = new Map<string, string | null>();
    for (const t of list) {
        byId.set(t.id, t);
        parentIdOf.set(t.id, ((t as any).__replyParentId as string | undefined) ?? null);
    }

    // Would linking child→parent close a cycle? Walk parent IDs (bounded by a seen-set).
    const linksToCycle = (childId: string, startParentId: string): boolean => {
        const seen = new Set<string>();
        let cur: string | null | undefined = startParentId;
        while (cur) {
            if (cur === childId || seen.has(cur)) return true;
            seen.add(cur);
            cur = parentIdOf.get(cur) ?? null;
        }
        return false;
    };

    for (const t of list) {
        const parentId = parentIdOf.get(t.id) ?? null;
        if (parentId && parentId !== t.id && byId.has(parentId) && !linksToCycle(t.id, parentId)) {
            t.replyingTo = byId.get(parentId)!;
        }
    }

    // Bound the linked chain depth (defensive: a malicious platform could craft a
    // thousands-deep thread that would overflow recursive hashing/serialization).
    for (const t of list) {
        let node: MainTweet | null = t;
        let depth = 0;
        while (node?.replyingTo) {
            if (++depth >= MAX_THREAD_DEPTH) { node.replyingTo = null; break; }
            node = node.replyingTo;
        }
    }

    // Strip transient parent-ID markers throughout the nested structure so they never
    // reach the hash input / worker / agent.
    const stripMarkers = (t: MainTweet | null, depth: number): void => {
        if (!t || depth > MAX_THREAD_DEPTH) return;
        delete (t as any).__replyParentId;
        stripMarkers(t.quoting as MainTweet | null, depth + 1);
        stripMarkers(t.replyingTo, depth + 1);
    };
    for (const t of list) stripMarkers(t, 0);
}

// ---- Parse-failure logging ----
// Each helper returns the value its callers propagate, so a failure can be reported
// and bailed out of in a single `return logX(...)`.

/** No usable tweet entries at all in a response. */
function logTweetBatchParsingError(tweetType: TweetType): void {
    console.log(`${tweetType.charAt(0) + tweetType.slice(1).toLowerCase()} tweet parsing failed.`);
}

/** An entry survived filtering but carried no tweet_results payload. */
function logTweetResultsParsingError(tweetType: TweetType): null {
    console.log(`Tweet extraction failed for a ${tweetType.toLowerCase()} entry.`);
    return null;
}

/** A specific expected field was missing from an otherwise present tweet payload. */
function logTweetParsingError(tweetFieldType: TweetFieldType, tweetType: TweetType, isQuoted: boolean = false): null {
    console.log(`${isQuoted ? 'Quoting t' : 'T'}weet ${tweetFieldType} extraction failed for a ${tweetType.toLowerCase()} entry.`);
    return null;
}