import { useSyncExternalStore } from 'react';
import {
  THEME_DEFAULT,
  THEME_STORE_KEY,
  applySchemeClass,
  normalizeThemePref,
  resolvedScheme,
  type ThemePref,
  type ThemeScheme,
} from '../../utils/theme';

/** The Appearance setting, as the popup sees it.
 *
 *  The popup's own localStorage holds a mirror of the extension-storage value. It is
 *  private to the extension — unlike the relay's, whose localStorage would be the host
 *  page's — and it reads synchronously, which `storage.local` cannot: the class has to
 *  be on `<html>` before the first paint or a dark-mode user watches the panel open
 *  light and flip. So the mirror decides the first paint, and the authoritative
 *  storage.local value (plus every later change) lands on top of it. Same dual write as
 *  the active-tab key in Dashboard.
 *
 *  The content scripts read only `storage.local`, so this mirror is a popup-local
 *  optimisation and never a second source of truth: a value written here is written to
 *  both stores in the same call. */

function readMirror(): ThemePref {
  try {
    return normalizeThemePref(localStorage.getItem(THEME_STORE_KEY));
  } catch {
    return THEME_DEFAULT;
  }
}

let pref: ThemePref = readMirror();
let scheme: ThemeScheme = resolvedScheme(pref);
const listeners = new Set<() => void>();

// Applied at import time so the very first render already has the right palette: the
// popup's entry imports this module before it renders anything.
applySchemeClass(scheme);

function publish(next: ThemePref): void {
  const nextScheme = resolvedScheme(next);
  if (next === pref && nextScheme === scheme) return;
  pref = next;
  scheme = nextScheme;
  applySchemeClass(scheme);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The user's preference (which may be `auto`). */
export function useThemePref(): ThemePref {
  return useSyncExternalStore(subscribe, () => pref);
}

/** The scheme it currently resolves to — what the stylesheets are already painting,
 *  and so the one the logo's white/black variant has to match. */
export function useResolvedScheme(): ThemeScheme {
  return useSyncExternalStore(subscribe, () => scheme);
}

export function setThemePref(next: ThemePref): void {
  publish(next);
  try { localStorage.setItem(THEME_STORE_KEY, next); } catch { /* mirror is best-effort */ }
  try {
    void browser.storage.local.set({ [THEME_STORE_KEY]: next }).catch(() => { /* ignore */ });
  } catch { /* ignore */ }
}

/** Load the authoritative value and follow it from here on. Called once from the
 *  popup's entry, before the first render. */
export function initPopupTheme(): void {
  try {
    if (typeof matchMedia === 'function') {
      matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        // Only `auto` follows the system; an explicit choice outranks it both ways.
        if (pref === 'auto') publish(pref);
      });
    }
  } catch { /* follow the system on the next open instead */ }

  try {
    browser.storage.local.get(THEME_STORE_KEY)
      .then((stored: Record<string, any>) => publish(normalizeThemePref(stored?.[THEME_STORE_KEY])))
      .catch(() => { /* keep the mirror's value */ });
  } catch { /* keep the mirror's value */ }

  try {
    browser.storage.onChanged.addListener((changes: Record<string, any>, area: string) => {
      if (area !== 'local' || !(THEME_STORE_KEY in changes)) return;
      publish(normalizeThemePref(changes[THEME_STORE_KEY]?.newValue));
    });
  } catch { /* ignore */ }
}
