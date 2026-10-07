/** Resolves the platform adapter for a hostname.
 *
 *  One entry per supported platform. The list is explicit rather than pattern-based
 *  because host patterns are how a platform's own subdomains (and its CDNs) leak in:
 *  a wildcard here would claim hosts the adapter cannot actually read. The one exception
 *  is a `.`-prefixed rule in PLATFORM_HOSTS (see its header), which is written per
 *  platform precisely because that platform's own subdomains are the product rather than
 *  a leak — Substack, where every publication is a subdomain, and Quora, which serves each
 *  reader from a locale subdomain of its own.
 */
import type { PlatformAdapter, PlatformId } from './types';
import { blueskyAdapter } from './bluesky';
import { dcardAdapter } from './dcard';
import { facebookAdapter } from './facebook';
import { hackerNewsAdapter } from './hackernews';
import { linkedinAdapter } from './linkedin';
import { mastodonAdapter } from './mastodon';
import { naverCafeAdapter } from './navercafe';
import { oldRedditAdapter } from './oldreddit';
import { pttAdapter } from './ptt';
import { quoraAdapter } from './quora';
import { redditAdapter } from './reddit';
import { substackAdapter } from './substack';
import { telegramAdapter } from './telegram';
import { threadsAdapter } from './threads';
import { truthSocialAdapter } from './truthsocial';
import { xAdapter } from './x';
import { hostMatchesRule } from './hosts';

const ADAPTERS: readonly PlatformAdapter[] = [
  xAdapter,
  redditAdapter,
  // Reddit's legacy front end, which is a different application on its own host rather than a
  // second name for the entry above — see PLATFORM_HOSTS.oldreddit. It is listed directly
  // after `redditAdapter` because the two are one platform to a reader, though their host
  // lists cannot overlap, so the order is a reading aid rather than a precedence.
  oldRedditAdapter,
  hackerNewsAdapter,
  blueskyAdapter,
  substackAdapter,
  threadsAdapter,
  truthSocialAdapter,
  quoraAdapter,
  dcardAdapter,
  pttAdapter,
  naverCafeAdapter,
  facebookAdapter,
  linkedinAdapter,
  telegramAdapter,
  // Federated, and the only entry here that claims no host: its instances are opted in at
  // runtime, one origin at a time. See the header of ./mastodon.ts.
  mastodonAdapter,
];

/** Lowercase and drop a leading `www.` so `www.x.com` and `x.com` match one entry. */
export function normalizeHost(hostname: string): string {
  return hostname.replace(/^www\./i, '').toLowerCase();
}

/** The adapter for this hostname, or null when the host is not a supported platform.
 *  Null is the expected state on every ordinary webpage — fact-checking anywhere does
 *  not go through an adapter. */
export function platformForHost(hostname: string): PlatformAdapter | null {
  const host = normalizeHost(hostname);
  return ADAPTERS.find((a) => a.hosts.some((rule) => hostMatchesRule(host, rule))) ?? null;
}

export function platformIds(): readonly PlatformId[] {
  return ADAPTERS.map((a) => a.id);
}
