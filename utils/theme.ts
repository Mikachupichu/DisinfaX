/** Appearance: light, dark, or follow the system.
 *
 *  The preference is one extension-storage entry so the popup and the in-page
 *  windows always agree, and it is resolved to a concrete scheme per document and
 *  written as a class on `<html>` — `mf-theme-light` / `mf-theme-dark`. The
 *  stylesheets key off that class rather than off `prefers-color-scheme`, because
 *  the user can override the system from the popup's Settings: a media query alone
 *  can be followed but never overridden in either direction.
 *
 *  The class goes on `<html>`, not on each window, because the in-page windows live
 *  in two separate content-script bundles (utils/injecting.ts and
 *  entrypoints/selection.ts) that share a document but not a module scope — the
 *  resolved scheme has nowhere else to travel.
 */

export type ThemePref = 'light' | 'auto' | 'dark';
export type ThemeScheme = 'light' | 'dark';

/** Extension-storage key. The popup also mirrors it into its own localStorage,
 *  which is readable synchronously — see entrypoints/popup/theme.ts. */
export const THEME_STORE_KEY = 'mf_theme';

/** Follow the system until told otherwise. */
export const THEME_DEFAULT: ThemePref = 'auto';

export const THEME_LIGHT_CLASS = 'mf-theme-light';
export const THEME_DARK_CLASS = 'mf-theme-dark';

const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)';

/** A stored value narrowed to one of the three, so a stale or hand-edited entry
 *  cannot leave the class off `<html>` entirely and drop the light windows back to
 *  the dark palette. */
export function normalizeThemePref(raw: unknown): ThemePref {
  return raw === 'light' || raw === 'dark' || raw === 'auto' ? raw : THEME_DEFAULT;
}

/** Whether the system asks for a dark UI. False where matchMedia is missing (the
 *  service worker) or throws (a locked-down document). */
export function systemPrefersDark(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia(DARK_SCHEME_QUERY).matches;
  } catch {
    return false;
  }
}

/** The scheme a preference resolves to right now. */
export function resolvedScheme(pref: ThemePref): ThemeScheme {
  return pref === 'auto' ? (systemPrefersDark() ? 'dark' : 'light') : pref;
}

/** Put the resolved scheme on `<html>`, where the stylesheets read it. Toggling to
 *  a state the element is already in writes nothing, so this can be called on every
 *  repaint without waking a host page's MutationObserver. A no-op in a context with
 *  no document (the service worker, which imports this module's neighbours). */
export function applySchemeClass(scheme: ThemeScheme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.toggle(THEME_LIGHT_CLASS, scheme === 'light');
  root.classList.toggle(THEME_DARK_CLASS, scheme === 'dark');
}
