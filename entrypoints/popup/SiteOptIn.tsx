import React, { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { useT } from './i18n';
import { platformForHost } from '../../utils/platforms/registry';
import {
  MASTODON_OPT_IN_MESSAGE,
  MASTODON_OPT_OUT_MESSAGE,
  instanceOriginPatterns,
  isInstanceOptedIn,
  normalizeInstanceHost,
  mastodonPageHost,
  type MastodonStatus,
} from '../../utils/mastodonOptIn';

/** The offer to turn DisinfaX on for the Mastodon instance in the active tab.
 *
 *  Mastodon is federated, so this is the only place the extension can learn that a given
 *  instance is one to work on: there is no host list to declare and no broad grant that
 *  would be acceptable to ask for at install time. See utils/mastodonOptIn.ts.
 *
 *  Renders nothing at all on every other page. The check runs once per popup open, and a
 *  host some adapter already claims statically is skipped without asking the background —
 *  those platforms are covered by their content-script matches and need no opt-in. */
export default function SiteOptIn() {
  const t = useT();
  const [status, setStatus] = useState<MastodonStatus | null>(null);
  const [tabId, setTabId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (cancelled || !tab?.id) return;
        // A tab the extension already has host access to reports its URL, so a platform with
        // its own content-script matches is waved off here without injecting anything.
        if (tab.url) {
          try {
            if (platformForHost(normalizeInstanceHost(new URL(tab.url).hostname))) return;
          } catch { /* not a URL that parses; the probe below is the answer either way */ }
        }
        // Asked from here, not from the background, and that is the whole point: this probe
        // needs host access to the tab, and the only access the extension has to an instance
        // it has not been granted is the `activeTab` grant the click that opened this popup
        // just produced. That grant belongs to the invocation, and the background — which
        // was not invoked — has none, so a probe asked from there can only ever come back
        // empty and the offer would never appear.
        //
        // It is also the only way to learn the host: an instance that is not enabled is a tab
        // `tabs.query` reports no URL for, which is why the probe answers with the hostname
        // rather than a yes/no.
        const probed = await browser.scripting.executeScript({
          target: { tabId: tab.id, frameIds: [0] },
          func: mastodonPageHost,
        });
        const probedHost = probed?.[0]?.result ?? null;
        if (cancelled || !probedHost) return;
        const host = normalizeInstanceHost(probedHost);
        if (platformForHost(host)) return;
        const alreadyOn = await isInstanceOptedIn(host);
        if (cancelled) return;
        setTabId(tab.id);
        setStatus({ isInstance: true, enabled: alreadyOn, host });
      } catch {
        /* No active tab to read, or a page we cannot inspect. Nothing to offer. */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (!status?.isInstance || !status.host) return null;
  const host = status.host;

  /** Ask for the grant BEFORE anything else is awaited.
   *
   *  `permissions.request` only works while this handler still holds the user's click, and
   *  an `await` ahead of it can spend that gesture — so the request is the first thing that
   *  happens, and the background (which cannot hold a gesture at all) is told afterwards.
   *  Only this one origin is ever requested, even though the manifest declares a broad
   *  optional pattern; Chrome refuses a request no declared entry covers, and the
   *  declaration is the envelope, not the ask. */
  const enable = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const granted = await browser.permissions.request({ origins: instanceOriginPatterns(host) });
      if (!granted) return;
      const reply = await browser.runtime.sendMessage({ type: MASTODON_OPT_IN_MESSAGE, host, tabId });
      if (reply?.ok) setStatus({ isInstance: true, enabled: true, host });
    } catch {
      /* Declined, or a browser that refused the request. The offer stands. */
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const reply = await browser.runtime.sendMessage({ type: MASTODON_OPT_OUT_MESSAGE, host, tabId });
      if (reply?.ok) setStatus({ isInstance: true, enabled: false, host });
    } catch {
      /* Nothing to undo. */
    } finally {
      setBusy(false);
    }
  };

  if (status.enabled) {
    return (
      <div className="flex items-center gap-2 p-2.5 bg-zinc-900/60 border border-zinc-800 rounded-xl text-xs text-zinc-300">
        <span className="flex-1 leading-relaxed break-words">{t('instanceEnabled', [host])}</span>
        <button
          type="button"
          onClick={disable}
          disabled={busy}
          className="flex-shrink-0 text-[11px] font-semibold text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer disabled:opacity-50"
        >
          {t('turnOff')}
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={enable}
      disabled={busy}
      className="flex items-center gap-2 w-full p-2.5 bg-emerald-950/40 border border-emerald-900 hover:border-emerald-700 rounded-xl text-xs font-semibold text-emerald-300 transition-colors cursor-pointer disabled:opacity-50 text-left"
    >
      <span className="flex-1 leading-relaxed break-words">{t('enableOnInstance', [host])}</span>
    </button>
  );
}
