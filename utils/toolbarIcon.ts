/** Toolbar icon theming.
 *
 *  The extension ships three colour variants of the logo in `public/icon/`:
 *  `-black` for light browser UI, `-white` for dark browser UI, and `-gray` as
 *  a neutral fallback that stays legible on either.
 *
 *  Only the TOOLBAR icon can be recoloured at runtime, through
 *  `chrome.action.setIcon`. The manifest `icons` — shown on chrome://extensions,
 *  in the extensions menu and on the Web Store listing — are static, which is
 *  why those are declared as the gray variant in `wxt.config.ts`.
 *
 *  The swap cannot be driven from the background directly: an MV3 service worker
 *  has no DOM, so `matchMedia('(prefers-color-scheme: dark)')` does not exist
 *  there. So the contexts that DO have a DOM (the popup, and the x.com relay
 *  content script) report the preference and watch it for changes, while the
 *  background — the only context permitted to call `chrome.action` — applies it.
 *
 *  The last reported preference is cached in extension storage so the right icon
 *  is restored immediately when the service worker wakes, without waiting for a
 *  DOM context to appear and report again.
 */

/** Message the DOM contexts send to the background with the current preference. */
export const COLOR_SCHEME_MESSAGE = 'MF_COLOR_SCHEME';

/** Extension-storage key holding the last reported preference (a boolean). */
const CACHED_PREFERS_DARK_KEY = 'mfPrefersDark';

const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)';

/** Sizes present for every colour variant under `public/icon/`. */
const ICON_SIZES = [16, 32, 48, 96, 128] as const;

/** Build the size→path map `setIcon` expects. Paths are relative
 *  to the extension root, where WXT copies the contents of `public/`. */
function iconPathsFor(variant: 'black' | 'white'): Record<string, string> {
  const paths: Record<string, string> = {};
  for (const size of ICON_SIZES) paths[String(size)] = `icon/${size}-${variant}.png`;
  return paths;
}

/** The toolbar-button namespace, which is spelled differently per manifest version:
 *  `action` on MV3 (Chromium), `browserAction` on MV2 (Firefox and Safari, which WXT
 *  builds as MV2 — their manifests declare `browser_action`). WXT's `browser` export is
 *  just `globalThis.browser ?? globalThis.chrome` with no API aliasing, so the fallback
 *  has to be spelled out here or `setIcon` would throw on those two targets. */
function toolbarAction(): { setIcon(details: { path: Record<string, string> }): Promise<void> } | null {
  const api = (browser as any).action ?? (browser as any).browserAction;
  return api?.setIcon ? api : null;
}

/** Background-side: point the toolbar icon at the variant that contrasts with
 *  the browser UI, and remember the preference for the next service-worker wake.
 *  A dark UI needs the white logo, a light UI the black one. */
export async function applyToolbarIcon(prefersDark: boolean): Promise<void> {
  try {
    await toolbarAction()?.setIcon({ path: iconPathsFor(prefersDark ? 'white' : 'black') });
  } catch (e) {
    console.warn('[toolbarIcon] setIcon failed:', e);
  }
  try {
    await browser.storage.local.set({ [CACHED_PREFERS_DARK_KEY]: prefersDark });
  } catch { /* cache is best-effort */ }
}

/** Background-side: re-apply the last known preference on startup. Does nothing
 *  when none was ever reported, leaving the neutral gray manifest icon in place. */
export async function restoreToolbarIcon(): Promise<void> {
  try {
    const stored = await browser.storage.local.get(CACHED_PREFERS_DARK_KEY);
    const prefersDark = stored?.[CACHED_PREFERS_DARK_KEY];
    if (typeof prefersDark === 'boolean') await applyToolbarIcon(prefersDark);
  } catch { /* leave the manifest default */ }
}

/** DOM-side: report the current colour scheme to the background and keep
 *  reporting whenever the user switches theme. Safe to call from any context
 *  with a DOM; a no-op where `matchMedia` is unavailable. */
export function reportColorScheme(): void {
  if (typeof matchMedia !== 'function') return;

  const send = (prefersDark: boolean) => {
    try {
      // Fire-and-forget: the background sends no reply, and there is no
      // receiver at all while the popup is the only context alive.
      void browser.runtime.sendMessage({ type: COLOR_SCHEME_MESSAGE, prefersDark })
        ?.catch?.(() => { /* background asleep or not listening yet */ });
    } catch { /* ignore */ }
  };

  const query = matchMedia(DARK_SCHEME_QUERY);
  send(query.matches);
  query.addEventListener('change', event => send(event.matches));
}
