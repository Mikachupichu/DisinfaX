import { useEffect, useState } from 'react';

/** Effective UI locale for the popup: the `mfLocale` test override first, then the
 *  browser UI language, then navigator.language.
 *
 *  Unlike the relay and background — which deliberately avoid localStorage because
 *  theirs would be the host page's — the popup runs on the extension's own origin, so
 *  its localStorage is private to the extension and safe to read here. */
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
    // Named token: look it up, then resolve it to a substitution when the placeholder's
    // content is itself a positional `$n` reference, or use its literal content.
    msg = msg.replace(/\$([A-Za-z0-9_]+)\$/g, (whole, name: string) => {
      const placeholder = entry.placeholders?.[name.toLowerCase()];
      if (!placeholder) return whole;
      const positional = /^\$(\d+)$/.exec(placeholder.content);
      if (!positional) return placeholder.content;
      const index = parseInt(positional[1], 10) - 1;
      return subs?.[index] !== undefined ? subs[index] : whole;
    });
  }
  if (subs) {
    // Bare positional token, e.g. `$1`. Left as written when no substitution was given.
    msg = msg.replace(/\$(\d+)/g, (whole, position: string) => {
      const index = parseInt(position, 10) - 1;
      return subs[index] !== undefined ? subs[index] : whole;
    });
  }
  // `$$` is the escape for a literal dollar sign; unescape last so it can't be
  // mistaken for a token above.
  return msg.replace(/\$\$/g, '$');
}

/** Translation function hook. Uses chrome.i18n (browser UI locale) by default, which
 *  is correct for real users. When an `mfLocale` test override differs from the
 *  browser locale, its `_locales/<locale>/messages.json` is loaded and preferred so
 *  the popup can be previewed in any language. Falls back to the key itself. */
export function useT(): (key: string, subs?: string[]) => string {
  const [override, setOverride] = useState<MsgMap | null>(null);

  useEffect(() => {
    const uiLocale = getUiLocale();
    let browserLocale = 'en';
    try { browserLocale = (chrome as any)?.i18n?.getUILanguage?.() || 'en'; } catch { /* ignore */ }
    // chrome.i18n already covers the browser locale — only load an override.
    if (!uiLocale || uiLocale.split('-')[0].toLowerCase() === browserLocale.split('-')[0].toLowerCase()) return;
    // Try the full locale first (`pt_BR`), then its base language (`pt`).
    const candidates = [uiLocale.replace(/-/g, '_'), uiLocale.split('-')[0]];
    let cancelled = false;
    (async () => {
      for (const candidate of candidates) {
        try {
          const url = (chrome as any)?.runtime?.getURL?.(`_locales/${candidate}/messages.json`);
          if (!url) continue;
          const response = await fetch(url);
          if (response.ok) {
            const messages = await response.json();
            if (!cancelled) setOverride(messages);
            return;
          }
        } catch { /* try next candidate */ }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (key: string, subs?: string[]): string => {
    if (override && override[key]) return formatRawMessage(override[key], subs);
    try {
      const translated = (chrome as any)?.i18n?.getMessage?.(key, subs);
      if (translated) return translated;
    } catch { /* ignore */ }
    // Surfacing the key beats rendering an empty string when a message is missing.
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
  // Count how many decimals actually carry information by padding to four and stripping
  // the trailing zeros. The '.' halts the strip, so an integer leaves "23." → 0 decimals.
  const withoutTrailingZeros = rounded.toFixed(4).replace(/0+$/, '');
  const decimalPoint = withoutTrailingZeros.indexOf('.');
  const significantDecimals = decimalPoint === -1 ? 0 : withoutTrailingZeros.length - decimalPoint - 1;
  // A lone decimal reads as an unfinished price, so pad "0.1" out to "0.10".
  const fractionDigits = significantDecimals === 0 ? 0 : significantDecimals === 1 ? 2 : significantDecimals;
  return new Intl.NumberFormat(locale, { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits }).format(rounded);
}

/** True when the locale writes a currency symbol AFTER the number (e.g. French
 *  "3,24 $US"). Probed from the platform's own USD formatting so every locale —
 *  including ones never explicitly considered — follows its own convention. Only
 *  the position is taken from the probe; the symbol text stays this extension's
 *  "US$" branding. Falls back to prefix when the locale is unrecognized. */
export function usdSymbolAfterAmount(locale: string = getUiLocale()): boolean {
  try {
    // Underscore form ("pt_BR") is valid for `_locales/` lookup but not for Intl.
    const tag = locale.replace(/_/g, '-');
    const parts = new Intl.NumberFormat(tag, { style: 'currency', currency: 'USD' }).formatToParts(1);
    const currencyIdx = parts.findIndex(part => part.type === 'currency');
    const integerIdx = parts.findIndex(part => part.type === 'integer');
    return currencyIdx !== -1 && integerIdx !== -1 && currencyIdx > integerIdx;
  } catch {
    return false;
  }
}

/** Format just the numeric part of a USD amount with exactly two decimals, rounded
 *  to the closest cent (e.g. "0.60" — never "00.60", "0.6" or "0.605"). Used for
 *  gifted-bonus amounts, which must always show cents. */
export function formatUsdExactCents(amount: number, locale: string = getUiLocale()): string {
  const rounded = Math.round((amount + Number.EPSILON) * 100) / 100;
  return new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(rounded);
}

/** Format a USD amount as a string ("US$3.24" vs "3,24 US$" depending on the
 *  locale — the suffix form uses a non-breaking space, matching the platform
 *  convention; see formatUsdNumber for the numeric rules). */
export function formatUsd(amount: number, locale: string = getUiLocale()): string {
  const number = formatUsdNumber(amount, locale);
  return usdSymbolAfterAmount(locale) ? `${number} US$` : `US$${number}`;
}

/** Base languages written right-to-left (used to set the popup's `dir`). */
const RTL_LANGS = new Set(['ar', 'arc', 'ckb', 'dv', 'fa', 'he', 'iw', 'ku', 'nqo', 'ps', 'sd', 'syr', 'ug', 'ur', 'yi']);

/** True when the locale's base language is written right-to-left. */
export function isRtl(locale: string = getUiLocale()): boolean {
  const base = (locale || '').split(/[-_]/)[0].toLowerCase();
  return RTL_LANGS.has(base);
}

/** Payment-processing fees deducted from a top-up: a percentage plus a flat charge. */
const PROCESSING_FEE_RATE = 0.021;
const PROCESSING_FEE_FLAT_USD = 0.30;
/** Share of a top-up the service is willing to give up, fees included. Because the flat
 *  fee weighs more on small amounts, this budget is fully consumed at $1 (2.1% of $1 +
 *  $0.30 = $0.321, i.e. 32.1%) and only larger top-ups have anything left over to gift. */
const GIVEAWAY_BUDGET_PERCENT = 32.1;

/** Bonus percentage gifted for a top-up amount — mirrors calculateTotalCredit in the
 *  stripe-webhook worker exactly. Returns 0 for $1 (and anything ≤ $1). */
export function giftPercent(amount: number): number {
  if (!amount || amount <= 0) return 0;
  // Fraction of the top-up that survives processing fees...
  const netRatio = ((1 - PROCESSING_FEE_RATE) * amount - PROCESSING_FEE_FLAT_USD) / amount;
  // ...so this is what the fees cost, as a percentage of the top-up.
  const feePercent = (1 - netRatio) * 100;
  // Whatever remains of the budget after fees becomes the user's bonus. Clamped
  // with an epsilon, not just at zero: at $1 the subtraction leaves a ~7e-15 float
  // residue, and the badge renders whenever this returns > 0 — so without the epsilon
  // the $1 button would show "Bonus: Extra 0% - US$0.00 Gifted".
  const bonus = GIVEAWAY_BUDGET_PERCENT - feePercent;
  return bonus < 1e-9 ? 0 : bonus;
}

/** Dollar value of the gifted bonus for a top-up amount, rounded to the closest cent.
 *  Derived from the rounded total credit rather than the raw percent, so the badge
 *  matches what stripe-webhook actually credits cent-for-cent (e.g. $3 → $0.60). */
export function giftDollars(amount: number): number {
  if (!amount || amount <= 0) return 0;
  const total = Math.round(amount * (100 + giftPercent(amount))) / 100;
  return Math.round((total - amount) * 100) / 100;
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
  // 1. Exact locale match.
  if (typeof dict[locale] === 'string') return dict[locale];
  // 2. Any entry sharing the base language, regardless of region.
  for (const [key, value] of Object.entries(dict)) {
    const keyLower = key.toLowerCase();
    if (typeof value === 'string' && (keyLower === base || keyLower.startsWith(base + '-'))) return value;
  }
  // 3. English, then whatever is there, so something always renders.
  if (typeof dict.en === 'string') return dict.en;
  const firstAvailable = Object.values(dict).find(value => typeof value === 'string');
  return (firstAvailable as string) ?? '';
}
