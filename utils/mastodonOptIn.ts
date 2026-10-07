/** The runtime opt-in that turns DisinfaX on for one Mastodon instance.
 *
 *  Mastodon is federated: `fosstodon.org`, `mastodon.online` and every other instance are
 *  separate third-party domains run by different people. There is therefore no host suffix
 *  to match and no list of hosts to enumerate in the manifest, and a required
 *  all-hosts grant would put "Read and change all your data on all websites" in front of
 *  every user at install time — including the ones who never open an instance.
 *
 *  So the manifest declares that pattern as OPTIONAL (see wxt.config.ts) and the reader
 *  grants it one origin at a time, from a click, on the instance they are looking at. Only
 *  that origin is ever requested; the broad declaration exists because Chrome refuses a
 *  requested origin that no declared entry covers.
 *
 *  `mastodon.social` is the one host outside this path: it is the default instance, declared
 *  statically in the manifest and in `PLATFORM_HOSTS.mastodon`, so it needs no opt-in — and
 *  so it must never get a registration from here as well. `isStaticMastodonHost` is the line
 *  between the two, and every write below is behind it.
 *
 *  Everything here is shared by the three contexts that have to agree on it — the popup,
 *  which asks for the grant, and the background, which owns the registration — so the
 *  storage key, the script ids and the idempotence rule live in one place.
 */
import { PLATFORM_HOSTS, hostMatchesRule } from './platforms/hosts';
/** Where the opted-in instances are recorded, as normalized hostnames. Read on every
 *  content-script start, so it stays a plain array of strings. */
export const MASTODON_INSTANCES_KEY = 'disinfax_mastodon_instances';

/** Prefix for the dynamically registered script ids. Two scripts per instance, so the
 *  suffix names which half and the host names the instance. */
const SCRIPT_ID_PREFIX = 'disinfax-mastodon';

/** The built halves of the integration, exactly as `wxt build` writes them.
 *
 *  `native.js` is the coordinator every platform runs; `mastodon.js` is the MAIN-world
 *  interceptor that reads thread parents out of the instance's own API responses. The
 *  interceptor must go in the MAIN world or it would patch a different `fetch` and
 *  `XMLHttpRequest` than the page's and observe nothing. */
export const MASTODON_COORDINATOR_FILE = 'content-scripts/native.js';
export const MASTODON_INTERCEPTOR_FILE = 'content-scripts/mastodon.js';

/** Messages the popup and the background exchange.
 *
 *  There is deliberately no status message. Whether the active tab is an instance is a
 *  question about a page, and answering it costs an injection that only the popup — which
 *  holds the `activeTab` grant the popup-opening click produced — can make. The background
 *  is asked only for the two changes it alone can make: recording the choice and owning the
 *  registration. */
export const MASTODON_OPT_IN_MESSAGE = 'MF_MASTODON_OPT_IN';
export const MASTODON_OPT_OUT_MESSAGE = 'MF_MASTODON_OPT_OUT';

export interface MastodonStatus {
  /** Whether the page in the active tab is a Mastodon instance at all. */
  isInstance: boolean;
  /** Whether this instance has already been opted in. */
  enabled: boolean;
  /** The hostname the two answers are about, or null when the tab could not be read. */
  host: string | null;
}

/** The same normalization `normalizeHost` applies for static platforms, applied here so a
 *  host is spelled one way in storage, in a registered match and in a lookup. Mastodon
 *  instances are not ordinarily `www.`-prefixed, but a reader who lands on
 *  `www.<instance>` must not be offered a second, separate opt-in for the same site. */
export function normalizeInstanceHost(hostname: string): string {
  return hostname.replace(/^www\./i, '').toLowerCase();
}

/** The one origin pattern a grant and a registration are made for. `*://` covers the
 *  instance over http and https alike — an instance reached over plain http is the same
 *  site, and Chrome treats the two as one origin for a match pattern written this way. */
export function instanceOriginPatterns(host: string): string[] {
  return [`*://${host}/*`];
}

export function scriptIdFor(kind: 'coordinator' | 'interceptor', host: string): string {
  return `${SCRIPT_ID_PREFIX}-${kind}-${host}`;
}

/** Every instance the reader has opted in, newest last. Never throws: a storage read that
 *  fails is an absent list, which reads as "nothing opted in" — the safe direction, since
 *  it can only ever mean fewer injections, never a misattributed one. */
export async function readOptedInInstances(): Promise<string[]> {
  try {
    const stored = await browser.storage.local.get(MASTODON_INSTANCES_KEY);
    const list = stored?.[MASTODON_INSTANCES_KEY];
    return Array.isArray(list) ? list.filter((h): h is string => typeof h === 'string' && h.length > 0) : [];
  } catch {
    return [];
  }
}

export async function writeOptedInInstances(instances: string[]): Promise<void> {
  await browser.storage.local.set({ [MASTODON_INSTANCES_KEY]: instances });
}

/** Whether `hostname` is an instance the reader has already opted in. */
export async function isInstanceOptedIn(hostname: string): Promise<boolean> {
  const host = normalizeInstanceHost(hostname);
  return (await readOptedInInstances()).includes(host);
}

/** Whether the manifest already matches this instance statically.
 *
 *  `mastodon.social` is declared in `PLATFORM_HOSTS.mastodon` and in both content scripts'
 *  `matches`, so it needs no opt-in and must never get a runtime registration as well: the
 *  registered copy and the static one would both inject, giving that page two coordinators
 *  and two sets of buttons. `hosts.ts` imports nothing, so reading the rule from there is
 *  safe in the service worker — the reason the check is not made against the adapter
 *  registry, which is not. */
export function isStaticMastodonHost(hostname: string): boolean {
  const host = normalizeInstanceHost(hostname);
  return (PLATFORM_HOSTS.mastodon ?? []).some((rule) => hostMatchesRule(host, rule));
}

/** The registrations for one instance, as `chrome.scripting.registerContentScripts` takes
 *  them. `persistAcrossSessions` is what makes the opt-in survive a browser restart without
 *  the background having to re-register anything. */
function scriptSpecsFor(host: string) {
  const matches = instanceOriginPatterns(host);
  return [
    {
      id: scriptIdFor('interceptor', host),
      js: [MASTODON_INTERCEPTOR_FILE],
      matches,
      runAt: 'document_start' as const,
      world: 'MAIN' as const,
      allFrames: false,
      persistAcrossSessions: true,
    },
    {
      id: scriptIdFor('coordinator', host),
      js: [MASTODON_COORDINATOR_FILE],
      matches,
      runAt: 'document_start' as const,
      allFrames: true,
      persistAcrossSessions: true,
    },
  ];
}

/** Remove this instance's registrations. Returns quietly when there were none, so it is
 *  safe to call before registering as well as when tearing down. */
export async function unregisterInstanceScripts(host: string): Promise<void> {
  for (const kind of ['interceptor', 'coordinator'] as const) {
    try {
      await browser.scripting.unregisterContentScripts({ ids: [scriptIdFor(kind, host)] });
    } catch {
      /* not registered — the expected case on a first opt-in */
    }
  }
}

/** Register one half of one instance, tolerating both halves of the race with the browser.
 *
 *  One id at a time, and never in a batch, because `registerContentScripts` is atomic: a
 *  single rejected id means NONE of the scripts are registered. There is a second writer
 *  here — Chrome itself restores every `persistAcrossSessions` registration the moment the
 *  extension starts, asynchronously and in an order nothing on this side can rely on — so a
 *  batch that raced that restore would fail whole, and it would fail in the one window that
 *  matters: after this function's own unregister and before its register. The instance would
 *  then be left with neither half, which is a page with no buttons at all.
 *
 *  Registering one id at a time contains that: a collision costs only the id it happens on.
 *  And a collision is not even a failure to report — "duplicate script ID" means the restore
 *  has already put exactly this registration there, which is what the call was for. Only an
 *  error with another cause is worth propagating, since that is the one the caller's catch
 *  is meant to see (a revoked grant, say, which the popup has to re-ask for). */
async function registerScriptSpec(spec: { id: string }): Promise<void> {
  try {
    await browser.scripting.unregisterContentScripts({ ids: [spec.id] });
  } catch {
    /* not registered — the expected case on a first opt-in */
  }
  try {
    await browser.scripting.registerContentScripts([spec] as any);
  } catch (error) {
    if (!/duplicate/i.test(String((error as Error)?.message ?? ''))) throw error;
  }
}

/** Register both halves for one instance.
 *
 *  Unregisters first so the call is idempotent: re-registering a live id throws, and this
 *  runs both on a fresh opt-in and on the repair pass that reconciles storage with the
 *  registrations the browser actually holds. Both halves go on independently — see
 *  `registerScriptSpec` for why neither may be allowed to take the other down with it. */
export async function registerInstanceScripts(host: string): Promise<void> {
  if (isStaticMastodonHost(host)) return;
  for (const spec of scriptSpecsFor(host)) await registerScriptSpec(spec);
}

/** Bring the browser's registrations back in step with the stored opt-ins, and drop any
 *  registration whose instance is no longer stored. Run on startup and on install: the
 *  registrations a previous browser session made are restored by `persistAcrossSessions`,
 *  but a permission the reader revoked outside the extension leaves a registration that can
 *  never inject, and storage is the source of truth for which should exist.
 *
 *  Never throws. This is housekeeping, and a failure here must not stop the background. */
export async function reconcileInstanceScripts(): Promise<void> {
  try {
    const instances = await readOptedInInstances();
    // A static host is never wanted as a registration, so a record left over from before
    // `mastodon.social` was declared is dropped here rather than kept as a live duplicate.
    const wanted = new Set(instances.filter((host) => !isStaticMastodonHost(host)));
    const held: { id: string }[] = await browser.scripting.getRegisteredContentScripts();
    for (const script of held) {
      if (!script.id.startsWith(`${SCRIPT_ID_PREFIX}-`)) continue;
      // `disinfax-mastodon-<kind>-<host>`: the host is everything after the second dash,
      // and a host cannot contain one.
      const host = script.id.split('-').slice(3).join('-');
      if (!wanted.has(host)) {
        try {
          await browser.scripting.unregisterContentScripts({ ids: [script.id] });
        } catch {
          /* already gone */
        }
      }
    }
    for (const host of instances) {
      try {
        await registerInstanceScripts(host);
      } catch {
        /* the grant is gone; leave the record so the popup can re-ask */
      }
    }
  } catch {
    /* housekeeping only */
  }
}

/** Injected into the active tab to ask whether the page is a Mastodon instance — and which.
 *
 *  It answers with the host rather than a boolean because the caller has no other way to
 *  learn it. `tabs.query` reports a URL only for a tab the extension can already reach, and
 *  an instance that has not been enabled is exactly the tab it cannot: that is why the offer
 *  has to be made at all. This probe is the one read that succeeds there, because the click
 *  that opened the popup granted `activeTab` for this one tab — so it is also the only source
 *  of the name to ask a grant for.
 *
 *  Self-contained on purpose: `scripting.executeScript` serializes this function and runs
 *  it in the tab, so it cannot close over anything in this module.
 *
 *  Both markers are part of the HTML template every instance serves, before and after the
 *  app hydrates, on every route — `#mastodon` is the element the app mounts into, and
 *  `script#initial-state` is the server-rendered state blob. Neither is a class the host
 *  styles, so neither can be changed by a theme or a release that renames a stylesheet, and
 *  both are shared by the Mastodon forks (Glitch-soc, Hometown) that are meant to work. */
export function mastodonPageHost(): string | null {
  const isInstance = !!document.querySelector('#mastodon') || !!document.querySelector('script#initial-state');
  return isInstance ? location.hostname : null;
}
