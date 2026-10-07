/** The hostnames each platform's content script runs on.
 *
 *  Deliberately separate from the adapters, and importing nothing: `utils/supabase.ts`
 *  has to ask "is this a platform page?" in order to decide whether the context may own
 *  the auth session, and the adapters reach back into the injected UI — importing them
 *  from there would form a cycle.
 *
 *  This is the single source of truth for platform hostnames. `registry.ts` matches
 *  against the same lists via each adapter's `hosts` field, and the lists here must stay
 *  in step with the content-script `matches` — which are declared per entrypoint
 *  (`entrypoints/native.content.ts`, `entrypoints/relay.content.ts`), not in
 *  `wxt.config.ts`: a host listed here with no match there is harmless, but a match there
 *  without an entry here would let a content script race the popup for the session slot
 *  and log the user out silently (see `ownsAuthSession` in utils/supabase.ts).
 *
 *  Hostnames only: no scheme, no path. Matching strips `www.` and lowercases.
 *
 *  A rule may begin with `.` to mean "that host and any subdomain of it". That exists for
 *  Substack, where every publication is `<pub>.substack.com` — an unbounded set that
 *  cannot be enumerated the way `bsky.app` or `news.ycombinator.com` can. The leading dot
 *  is what keeps the boundary honest: a bare `endsWith('substack.com')` would also claim
 *  `notsubstack.com`, and `foo.substack.com.evil.com` would be claimed by any rule that
 *  only tested containment.
 */
import type { PlatformId } from './types';

export const PLATFORM_HOSTS: Partial<Record<PlatformId, readonly string[]>> = {
  x: ['x.com', 'twitter.com'],
  // `sh.reddit.com` is Reddit's newer web app on its own name, and it serves the same
  // shreddit DOM as `reddit.com` — measured 2026-10-04, the same comparison the `oldreddit`
  // note below records — so it is a second NAME for this entry rather than an entry of its
  // own. Written out rather than as a `.reddit.com` suffix rule, which would also claim
  // `old.reddit.com`: that host is the legacy application the next entry owns.
  reddit: ['reddit.com', 'sh.reddit.com'],
  // Reddit's LEGACY front end, which is a different application on its own host rather than
  // another view of the one above: measured 2026-10-03, `old.reddit.com` serves a 200 with no
  // redirect and a table-based DOM carrying ZERO `shreddit-*` elements, while `reddit.com`
  // (and `sh.reddit.com`) serve the shreddit app. It is therefore a separate entry rather
  // than a second name on `reddit`'s list, and that separation is load-bearing: an adapter
  // claims the hosts of its OWN list, so putting this name under `reddit` would hand
  // old.reddit.com to the shreddit adapter, which reads none of its anchors.
  oldreddit: ['old.reddit.com'],
  hackernews: ['news.ycombinator.com'],
  bluesky: ['bsky.app'],
  // Every Substack publication, plus the reader at the apex — notes and the subscriptions
  // feed live on `substack.com` itself, publications on their own subdomains. Custom-domain
  // publications (`platformer.news` and the like) are NOT covered: they are an unbounded,
  // unenumerable set of third-party domains, and claiming them would mean a `*://*/*`
  // content script that runs on the whole web.
  substack: ['.substack.com'],
  // Threads serves the same app from `threads.com` and its `threads.net` alias, and the
  // canonical host is the `www.` one. All three are listed because the app re-renders the
  // same posts on each; matching strips `www.` before comparison, so the two bare names
  // cover their own `www.` forms as well.
  threads: ['threads.com', 'threads.net'],
  truthsocial: ['truthsocial.com'],
  // Mastodon is federated — `mastodon.social`, `fosstodon.org` and every other instance are
  // separate third-party domains, an unbounded set no suffix rule can honestly claim. Every
  // OTHER instance is reached through the runtime opt-in (utils/mastodonOptIn.ts).
  //
  // `mastodon.social` is the exception and is listed here as a static host, because it is
  // the default: Mastodon GmbH runs it, the official apps and joinmastodon.org suggest it
  // first, and it holds the largest share of the network's users. One host in the permission
  // list buys the majority of Mastodon readers buttons with no opt-in at all, and the
  // federated case is still served — so this is the list's only entry that is a single
  // instance rather than a platform's whole surface.
  mastodon: ['mastodon.social'],
  // Quora serves every reader from a locale subdomain of its own — `fr.quora.com`,
  // `es.quora.com` and the rest — and redirects the apex to `www.`, so the same suffix rule
  // Substack needs applies here: the set is unbounded and Quora's own, and enumerating the
  // locales it might serve would only ever be a snapshot.
  quora: ['.quora.com'],
  // Dcard serves the app from `www.dcard.tw` and redirects the apex to it; matching strips
  // `www.` before comparison, so one bare name covers both.
  dcard: ['dcard.tw'],
  // PTT's web front end is `www.ptt.cc`, and the apex redirects to it; matching strips `www.`
  // before comparison, so one bare name covers both. The board's own terminal protocol
  // (`ptt.cc:23`) is not a host this extension has any business on.
  ptt: ['ptt.cc'],
  // Naver Cafe serves every cafe from `cafe.naver.com`, and it is the first platform here
  // whose own UI puts a post in a CHILD FRAME: an article's post body and its comments
  // render inside a same-origin `cafe.naver.com/ca-fe/…` iframe, while a board's list of
  // articles is the top document (see `frameScoped` in types.ts). One host covers both,
  // because the frame is on the same host as the page holding it.
  //
  // The `.`-prefixed suffix rule covers cafe subdomains beyond the apex — `m.cafe.naver.com`
  // among them — for the same reason Substack and Quora use it: those subdomains are Naver's
  // own, and `foo.cafe.naver.com.evil.com` is not claimed by it. Both readers are integrated:
  // `m.cafe.naver.com` does NOT redirect to the apex, it serves a different SPA (measured: one
  // document, no iframes, none of the desktop anchors), so the adapter carries a second anchor
  // set for it rather than relying on the host rule to find the desktop one.
  navercafe: ['.cafe.naver.com'],
  // Facebook serves its desktop app from the apex, which redirects to `www.`, and from the
  // `web.` alias that redirects to `www.` in turn. All three are listed because a redirect
  // is not a guarantee the other name was never used.
  //
  // `m.facebook.com` is claimed because it serves a SECOND application — the server-driven
  // mobile site — and does not redirect anywhere: measured 2026-10-05 with an iPhone user agent,
  // it answers 200 in place, and `www.facebook.com` answers 302 pointing AT it. That is the
  // reverse of the direction an earlier reading found, so the split is served both ways and
  // neither name can be relied on to hand back the other; both are listed for that reason. Which
  // application a reader gets is the user agent's business and the adapter reads whichever
  // arrived (see the mobile section of ./facebook.ts), so listing both costs nothing.
  //
  // `mbasic.facebook.com` is deliberately NOT claimed. It answers 200 in place rather than
  // redirecting to `m.`, so a reader can land on it — but it is a third application, the old
  // HTML-only one, and none of its markup has been measured, so there is nothing to anchor on
  // there. Claiming it would only move that surface's auth routing while leaving it without
  // buttons — a change with no reader-visible gain. It stays out until its anchors are read.
  facebook: ['facebook.com', 'web.facebook.com', 'm.facebook.com'],
  // LinkedIn serves the same desktop app from a locale subdomain per reader — `de.linkedin.com`,
  // `fr.linkedin.com` and the rest — and the set is LinkedIn's own and unbounded, so this is
  // the `.`-prefixed suffix rule rather than a list of locales, the same choice Quora's entry
  // makes. It is a broader claim than Substack's in one respect: it also covers LinkedIn's
  // marketing and help subdomains, which are ordinary pages no adapter root is found in. That
  // is the same trade Naver Cafe's entry accepts for its mobile reader, and the alternative —
  // enumerating locales — would be a snapshot that silently loses buttons in each new market.
  linkedin: ['.linkedin.com'],
  // Telegram serves two separate web clients from one host, and they share a session: `/a/` is
  // the app this adapter reads, `/k/` is the older one, and opening the second signs the first
  // out (measured). A host rule cannot say "this path only", so the one host is claimed and the
  // path gate lives in the adapter instead — see the header of utils/platforms/telegram.ts.
  telegram: ['web.telegram.org'],
};

/** Whether `host` is covered by one entry of a platform's host list.
 *
 *  `rule` is either an exact hostname or a `.`-prefixed suffix meaning that host and any
 *  subdomain of it. `host` must already be normalized (see `normalizeHost`). */
export function hostMatchesRule(host: string, rule: string): boolean {
  if (!rule.startsWith('.')) return host === rule;
  return host === rule.slice(1) || host.endsWith(rule);
}

export function isPlatformHost(hostname: string): boolean {
  const host = hostname.replace(/^www\./i, '').toLowerCase();
  for (const hosts of Object.values(PLATFORM_HOSTS)) {
    if (hosts?.some((rule) => hostMatchesRule(host, rule))) return true;
  }
  return false;
}
