
import { MainTweet, TweetType, TweetFieldType, Usertype, QuotedTweet } from '../data/Tweets';

export function parseHomeTimeline(responseText: string): MainTweet[] | void {
    return parseTweets(JSON.parse(responseText)?.data?.home?.home_timeline_urt?.instructions?.[0]?.entries, TweetType.HomeTimeline);
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

        if (hasItems) {
            // ConversationThread entry: iterate ALL items (main tweet + replies)
            for (let i = 0; i < items.length; i++) {
                const tweetResult = items[i]?.item?.itemContent?.tweet_results?.result;
                const hasUser = !!tweetResult?.core?.user_results?.result?.core?.screen_name;
                const username = tweetResult?.core?.user_results?.result?.core?.screen_name;
                console.log(`[parseTweetDetail]   items[${i}]: entryId=${items[i].entryId}, hasResult=${!!tweetResult}, hasUser=${hasUser}, username=${username}, birdwatch=${!!tweetResult?.has_birdwatch_notes}`);
                if (tweetResult?.core?.user_results?.result?.core?.screen_name === "grok") continue;
                if (tweetResult) {
                    tweetResultsList.push({ result: tweetResult, entryId: items[i].entryId ?? entryId });
                    console.log(`[parseTweetDetail]   => ACCEPTED items[${i}]`);
                } else {
                    console.log(`[parseTweetDetail]   => SKIPPED items[${i}]: no tweetResult`);
                }
            }
        } else {
            // Direct entry (no items array)
            const tweetResult = entry.content?.itemContent?.tweet_results?.result;
            const hasUser = !!tweetResult?.core?.user_results?.result?.core?.screen_name;
            const username = tweetResult?.core?.user_results?.result?.core?.screen_name;
            console.log(`[parseTweetDetail]   direct: hasResult=${!!tweetResult}, hasUser=${hasUser}, username=${username}, birdwatch=${!!tweetResult?.has_birdwatch_notes}`);
            if (tweetResult?.core?.user_results?.result?.core?.screen_name === "grok") continue;
            if (tweetResult) {
                tweetResultsList.push({ result: tweetResult, entryId });
                console.log(`[parseTweetDetail]   => ACCEPTED direct`);
            } else {
                console.log(`[parseTweetDetail]   => SKIPPED direct: no tweetResult`);
            }
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

function parseTweets(entries: any | undefined, tweetType: TweetType, isItem: boolean = false): MainTweet[] | void {
    if (entries === undefined) { logTweetParsingError(TweetFieldType.Entries, tweetType); return; }
    const tweets = entries.filter((entry: any) => !excludedEntryIds.some(id => entry.entryId?.includes(id) || entry.content?.items?.[0]?.entryId?.includes(id)) && entry.content?.itemContent?.tweet_results?.result?.core?.user_results?.result?.core?.screen_name !== "grok");
    if (!tweets) return logTweetBatchParsingError(tweetType);
    const tweetData: MainTweet[] = tweets.map((entry: any) => {
        const tweetResults = (isItem ? entry.item : entry.content)?.itemContent?.tweet_results?.result;
        if (!tweetResults) return logTweetResultsParsingError(tweetType);
        return parseTweet(tweetResults, tweetType);
    });
    return tweetData;
}

function parseTweet(tweetResults: any, tweetType: TweetType, mainId: string | null = null): MainTweet | null {
    const legacy = tweetResults.legacy;
    if (!legacy) return logTweetParsingError(TweetFieldType.Legacy, tweetType);

    const id = tweetResults.rest_id ?? legacy.id_str;
    if (!id) return logTweetParsingError(TweetFieldType.ID, tweetType);

    const text = tweetResults.note_tweet?.note_tweet_results?.result?.text ?? legacy.full_text;
    if (!text) return logTweetParsingError(TweetFieldType.Text, tweetType);

    const core = tweetResults.core;
    if (!core) return logTweetParsingError(TweetFieldType.Core, tweetType);

    const userResults = core.user_results?.result;
    if (!userResults) return logTweetParsingError(TweetFieldType.User, tweetType);

    const username = userResults.core?.name;
    if (!username) return logTweetParsingError(TweetFieldType.Username, tweetType);

    const verification = userResults.verification;
    const usertype = verification?.verified_type as Usertype ?? (verification?.verified || userResults.is_blue_verified ? Usertype.Verified : Usertype.Regular);

    const replyingTo = legacy.in_reply_to_status_id_str ?? mainId ?? null;
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
    else if (!replyingTo) return { id, text, username, quoting: null, replyingTo: null, usertype, conversationId, translatedText, sourceLanguage, destinationLanguage } as MainTweet

    return { id, text, username, quoting, replyingTo, usertype, conversationId, translatedText, sourceLanguage, destinationLanguage } as MainTweet;
}

const excludedEntryIds = ['promoted', 'stories', 'pinned', 'cursor', 'trends-accounts', 'trend', 'who-to-follow', 'toptabsrpusermodule'];

function logTweetBatchParsingError(tweetType: TweetType): void {
    console.log(`${tweetType.charAt(0) + tweetType.slice(1).toLowerCase()} tweet parsing failed.`);
}
function logTweetResultsParsingError(tweetType: TweetType): null {
    console.log(`Tweet extraction failed for a ${tweetType.toLowerCase()} entry.`);
    return null;
}
function logTweetParsingError(tweetFieldType: TweetFieldType, tweetType: TweetType, isQuoted: boolean = false): null {
    console.log(`${isQuoted ? 'Quoting t' : 'T'}weet ${tweetFieldType} extraction failed for a ${tweetType.toLowerCase()} entry.`);
    return null;
}