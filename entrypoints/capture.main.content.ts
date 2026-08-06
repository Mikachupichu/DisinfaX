/** Tweet capture, MAIN-world half.
 *
 *  X renders its timelines from GraphQL XHRs whose payloads carry far more than the
 *  DOM shows — full untruncated bodies, quoted tweets, Grok translations. This script
 *  patches XMLHttpRequest.prototype.open to read those responses as they land, parses
 *  the ones belonging to a known timeline endpoint, and forwards the tweets to the
 *  isolated-world relay (entrypoints/relay.content.ts) via window.postMessage.
 *
 *  It has to run in the MAIN world: the page's own XMLHttpRequest is a different object
 *  from the one a content script sees in its isolated world, so patching from there
 *  would intercept nothing. The trade-off is that this script shares a global scope with
 *  the host page, which is why it does nothing but parse and forward — the relay
 *  verifies every message's origin before trusting it.
 */
import {
    parseHomeTimeline,
    parseTweetDetail,
    parseGenericTimelineById,
    parseSearchTimeline,
    parseExplorePage,
    parseBookmarksTimeline,
    parseListTimeline,
    parseUserTimeline,
    parseCommunityRankedTimeline,
    parseCommunityExploreTimeline,
    parseCommunityFetchOne
} from '../utils/parsing';
import { MainTweet } from '../data/Tweets';

/** The GraphQL endpoints worth parsing, matched as substrings of the request URL.
 *  Order is significant: the first marker found in the URL wins. `label` is only used
 *  to describe the batch in the console. */
const TIMELINE_ENDPOINTS: { marker: string; label: string; parse: (responseText: string) => MainTweet[] | void }[] = [
    { marker: 'HomeTimeline',              label: 'Home Timeline',           parse: parseHomeTimeline },
    { marker: 'HomeLatestTimeline',        label: 'Following Timeline',      parse: parseHomeTimeline },
    { marker: 'TweetDetail',               label: 'Detail',                  parse: parseTweetDetail },
    { marker: 'GenericTimelineById',       label: 'Generic Timeline by ID',  parse: parseGenericTimelineById },
    { marker: 'SearchTimeline',            label: 'Search Timeline',         parse: parseSearchTimeline },
    { marker: 'ExplorePage',               label: 'Explore Page',            parse: parseExplorePage },
    { marker: 'Bookmarks',                 label: 'Bookmarks',               parse: parseBookmarksTimeline },
    { marker: 'ListLatestTweetsTimeline',  label: 'List Timeline',           parse: parseListTimeline },
    // Substring match: also catches UserTweetsAndReplies, which shares this shape.
    { marker: 'UserTweets',                label: 'User Timeline',           parse: parseUserTimeline },
    { marker: 'Likes',                     label: 'User Timeline (Likes)',   parse: parseUserTimeline },
    { marker: 'UserMedia',                 label: 'User Timeline (Media)',   parse: parseUserTimeline },
    { marker: 'CommunitiesRankedTimeline', label: 'Community Timeline',      parse: parseCommunityRankedTimeline },
    { marker: 'CommunitiesExploreTimeline',label: 'Community Explore',       parse: parseCommunityExploreTimeline },
    { marker: 'CommunitiesFetchOneQuery',  label: 'Community Fetch One',     parse: parseCommunityFetchOne },
];

export default defineContentScript({
  matches: ['*://x.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    console.log('DisinfaX: Active');
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(_method, url) {
        this.addEventListener('load', async function() {
            const link = url.toString();

            // NOTE: this patch only wraps XMLHttpRequest, which is sufficient for every
            // endpoint in TIMELINE_ENDPOINTS. It deliberately does NOT see X's tweet
            // translation, which is `fetch('POST https://api.x.com/2/grok/translation.json')`
            // routed through X's own service worker — confirmed by a temporary XHR probe here
            // staying completely silent while the network panel showed the request. Observing
            // it would mean patching window.fetch in the MAIN world, i.e. intercepting every
            // request the host page makes; see the toggle handler in relay.content.ts for how
            // the displayed locale is resolved without doing that.
            const endpoint = TIMELINE_ENDPOINTS.find(candidate => link.includes(candidate.marker));
            if (!endpoint) {
                // Surface GraphQL calls we don't recognize yet, so unhandled pages
                // (Bookmarks, profile tabs, Lists, Communities, ...) can be identified
                // from the console instead of guessing at operation names.
                if (link.includes('/graphql/')) {
                    const match = link.match(/\/graphql\/[^/]+\/([^/?]+)/);
                    console.log(`[misinfo] unrecognized GraphQL endpoint: ${match?.[1] ?? link}`);
                }
                return;
            }

            const parsedTweets = endpoint.parse(this.responseText);
            console.log(`Extracted Tweet ${endpoint.label}:`, parsedTweets);

            // The timeline parsers return a null placeholder for entries they could not
            // parse, so drop those before anything downstream assumes a real tweet.
            const validTweets = (parsedTweets ?? []).filter((t: any) => t != null);
            if (validTweets.length === 0) return;

            window.postMessage({
                type: 'X_DATA_CAPTURED',
                tweets: validTweets
            }, '*');
        });
        return originalOpen.apply(this, arguments as any);
    };
  },
});
