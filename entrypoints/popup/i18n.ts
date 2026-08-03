import { useEffect, useState } from 'react';

/** Effective UI locale for the popup: the `mfLocale` test override (localStorage)
 *  first, then the browser UI language, then navigator.language. */
export function getUiLocale(): string {
  try {
    const override = localStorage?.getItem?.('mfLocale');
    if (override && override !== 'auto') return override;
  } catch { /* ignore */ }
  try {
    return (chrome as any)?.i18n?.getUILanguage?.() || navigator.language || 'en';
  } catch {
    return navigator.language || 'en';
  }
}

type RawMessageEntry = { message: string; placeholders?: Record<string, { content: string }> };
type MsgMap = Record<string, RawMessageEntry>;

/** Format a raw `_locales` entry the way chrome.i18n.getMessage does: resolve named
 *  `$PLACEHOLDER$` tokens via the entry's placeholders map, then bare `$1`/`$2`. */
function formatRawMessage(entry: RawMessageEntry, subs?: string[]): string {
  let msg = entry.message;
  if (entry.placeholders) {
    msg = msg.replace(/\$([A-Za-z0-9_]+)\$/g, (whole, name: string) => {
      const ph = entry.placeholders?.[name.toLowerCase()];
      if (!ph) return whole;
      const m = /^\$(\d+)$/.exec(ph.content);
      if (!m) return ph.content;
      const idx = parseInt(m[1], 10) - 1;
      return subs?.[idx] !== undefined ? subs[idx] : whole;
    });
  }
  if (subs) {
    msg = msg.replace(/\$(\d+)/g, (whole, num: string) => {
      const idx = parseInt(num, 10) - 1;
      return subs[idx] !== undefined ? subs[idx] : whole;
    });
  }
  return msg.replace(/\$\$/g, '$');
}

/** Translation function hook. Uses chrome.i18n (browser UI locale) by default, which
 *  is correct for real users. When an `mfLocale` test override differs from the
 *  browser locale, its `_locales/<locale>/messages.json` is loaded and preferred so
 *  the popup can be previewed in any language. Falls back to the key itself. */
export function useT(): (key: string, subs?: string[]) => string {
  const [override, setOverride] = useState<MsgMap | null>(null);

  useEffect(() => {
    const loc = getUiLocale();
    let browser = 'en';
    try { browser = (chrome as any)?.i18n?.getUILanguage?.() || 'en'; } catch { /* ignore */ }
    // chrome.i18n already covers the browser locale — only load an override.
    if (!loc || loc.split('-')[0].toLowerCase() === browser.split('-')[0].toLowerCase()) return;
    const candidates = [loc.replace(/-/g, '_'), loc.split('-')[0]];
    let cancelled = false;
    (async () => {
      for (const c of candidates) {
        try {
          const url = (chrome as any)?.runtime?.getURL?.(`_locales/${c}/messages.json`);
          if (!url) continue;
          const res = await fetch(url);
          if (res.ok) { const json = await res.json(); if (!cancelled) setOverride(json); return; }
        } catch { /* try next candidate */ }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (key: string, subs?: string[]): string => {
    if (override && override[key]) return formatRawMessage(override[key], subs);
    try {
      const m = (chrome as any)?.i18n?.getMessage?.(key, subs);
      if (m) return m;
    } catch { /* ignore */ }
    return key;
  };
}

/** Format just the numeric part of a USD amount (no "US$"), rounded to 4 decimals,
 *  in the locale's number format. Trailing-zero rules:
 *   - no significant decimals → integer, no decimal separator (e.g. "23");
 *   - exactly one significant decimal → padded to two (e.g. "0.1" → "0.10");
 *   - two or more → shown as-is (e.g. "0.15", "0.1234"). */
export function formatUsdNumber(amount: number, locale: string = getUiLocale()): string {
  const rounded = Math.round((amount + Number.EPSILON) * 10000) / 10000;
  const trimmed = rounded.toFixed(4).replace(/0+$/, '');
  const dot = trimmed.indexOf('.');
  const decimals = dot === -1 ? 0 : trimmed.length - dot - 1;
  const frac = decimals === 0 ? 0 : decimals === 1 ? 2 : decimals;
  return new Intl.NumberFormat(locale, { minimumFractionDigits: frac, maximumFractionDigits: frac }).format(rounded);
}

/** Format a USD amount as "US$X" (string form; see formatUsdNumber for the rules). */
export function formatUsd(amount: number, locale: string = getUiLocale()): string {
  return `US$${formatUsdNumber(amount, locale)}`;
}

/** Base languages written right-to-left (used to set the popup's `dir`). */
const RTL_LANGS = new Set(['ar', 'arc', 'ckb', 'dv', 'fa', 'he', 'iw', 'ku', 'nqo', 'ps', 'sd', 'syr', 'ug', 'ur', 'yi']);

/** True when the locale's base language is written right-to-left. */
export function isRtl(locale: string = getUiLocale()): boolean {
  const base = (locale || '').split(/[-_]/)[0].toLowerCase();
  return RTL_LANGS.has(base);
}

/** Bonus percentage gifted for a top-up amount — mirrors the create-checkout-session
 *  worker exactly. Returns 0 for $5 (and anything ≤ $5). */
export function giftPercent(amount: number): number {
  if (!amount || amount <= 0) return 0;
  const feeRatio = ((1 - 0.029) * amount - 0.30) / amount;
  const feePercent = (1 - feeRatio) * 100;
  const gainPercent = 8.9 - feePercent;
  return Math.max(0, gainPercent);
}

/** Format a percentage value with up to 2 decimals, trailing zeros trimmed, in the
 *  locale's number format (e.g. "3", "3.24", or "3,24" in French). */
export function formatPercent(pct: number, locale: string = getUiLocale()): string {
  return new Intl.NumberFormat(locale, { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(pct);
}

/** Pick the message string for the current locale from a locale-keyed dictionary
 *  (e.g. {"en": "...", "fr": "..."}), falling back to English then any value. */
export function pickLocalized(dict: Record<string, string>, locale: string = getUiLocale()): string {
  if (!dict || typeof dict !== 'object') return '';
  const base = locale.split('-')[0].toLowerCase();
  if (typeof dict[locale] === 'string') return dict[locale];
  for (const [k, v] of Object.entries(dict)) {
    if (typeof v === 'string' && (k === base || k.toLowerCase().startsWith(base + '-') || k.toLowerCase() === base)) return v;
  }
  if (typeof dict.en === 'string') return dict.en;
  const first = Object.values(dict).find(v => typeof v === 'string');
  return (first as string) ?? '';
}
