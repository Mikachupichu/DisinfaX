import {
    parseHomeTimeline,
    parseTweetDetail,
    parseGenericTimelineById,
    parseSearchTimeline,
    parseExplorePage
} from '../utils/parsing';
import { MainTweet } from '../data/Tweets';

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
            let parsedTweets: MainTweet[] | void = undefined;
            if (link.includes('HomeTimeline')) {
                parsedTweets = parseHomeTimeline(this.responseText);
                console.log('Extracted Tweet Home Timeline:', parsedTweets);
            } else if (link.includes('TweetDetail')) {
                parsedTweets = parseTweetDetail(this.responseText);
                console.log('Extracted Tweet Detail:', parsedTweets);
            } else if (link.includes('GenericTimelineById')) {
                parsedTweets = parseGenericTimelineById(this.responseText);
                console.log('Extracted Tweet Generic Timeline by ID:', parsedTweets);
            } else if (link.includes('SearchTimeline')) {
                parsedTweets = parseSearchTimeline(this.responseText);
                console.log('Extracted Tweet Search Timeline:', parsedTweets);
            } else if (link.includes('ExplorePage')) {
                parsedTweets = parseExplorePage(this.responseText);
                console.log('Extracted Tweet Explore Page:', parsedTweets);
            }
            if ((parsedTweets?.length ?? 0) > 0) {
                const validTweets = parsedTweets!.filter((t: any) => t != null);
                if (validTweets.length > 0) {
                    window.postMessage({
                        type: 'X_DATA_CAPTURED',
                        tweets: validTweets
                    }, '*');
                }
            }
        });
        return originalOpen.apply(this, arguments as any);
    };
  },
});