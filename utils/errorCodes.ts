/** Error codes shared with the Cloudflare Workers backend.
 *
 *  Every worker prefixes its user-facing error text with a numeric code, e.g.
 *  `"3 - You're not signed in. Please sign in and try again."`. This lets the
 *  extension show its OWN localized copy for conditions it recognizes — the text
 *  after the dash is only a fallback, read by an extension version that predates a
 *  code the backend has started sending, or that talks to a worker that hasn't been
 *  updated yet. The backend only ever sends this fallback in English; recognized
 *  codes are localized entirely on the extension side (see the per-locale
 *  `_locales` message files' keys named after `ERROR_CODE_MESSAGE_KEYS` below).
 *
 *  This scheme exists so a worker's raw failure (a Postgres error, an upstream AI
 *  provider's error body, a stack trace) never has to be relayed to the caller to be
 *  human-readable — the worker logs that detail for its own developers and returns a
 *  numbered, sanitized sentence instead. An attacker probing the workers directly
 *  (bypassing the extension entirely) also only ever sees these numbered sentences,
 *  not backend implementation detail.
 *
 *  Kept dependency-free (no DOM, no chrome.* APIs) so it can be imported from every
 *  context that parses a worker error: the background service worker, the popup, and
 *  (transitively) the content-script relay. */
import { sameLanguage } from "../data/Classification";

/** Numeric codes recognized by this version of the extension. Each maps to a
 *  per-locale message-file key carrying the extension's own localized text —
 *  see ERROR_CODE_MESSAGE_KEYS below. Keep these numbers stable: they are the
 *  contract with the backend, which sends the same numbers regardless of the
 *  English wording it currently has after the dash. */
export const ERROR_CODES = {
  BALANCE_TOO_LOW: 1,
  ACCOUNT_SUSPENDED: 2,
  NOT_SIGNED_IN: 3,
  INVALID_REQUEST: 4,
  SERVICE_UNAVAILABLE: 5,
  REGION_NOT_SUPPORTED: 6,
  INVALID_AMOUNT: 7,
  NOT_FOUND: 8,
} as const;

export type ErrorCode = typeof ERROR_CODES[keyof typeof ERROR_CODES];

/** i18n message key (in the per-locale `_locales` message files) holding this
 *  extension's own localized text for a recognized code, disregarding whatever
 *  English fallback the worker sent after the dash. */
const ERROR_CODE_MESSAGE_KEYS: Record<number, string> = {
  [ERROR_CODES.BALANCE_TOO_LOW]: 'errBalanceTooLow',
  [ERROR_CODES.ACCOUNT_SUSPENDED]: 'errAccountSuspended',
  [ERROR_CODES.NOT_SIGNED_IN]: 'errNotSignedIn',
  [ERROR_CODES.INVALID_REQUEST]: 'errInvalidRequest',
  [ERROR_CODES.SERVICE_UNAVAILABLE]: 'errServiceUnavailable',
  [ERROR_CODES.REGION_NOT_SUPPORTED]: 'errRegionNotSupported',
  [ERROR_CODES.INVALID_AMOUNT]: 'errInvalidAmount',
  [ERROR_CODES.NOT_FOUND]: 'errNotFound',
};

/** The i18n key for a recognized code, or null when the code isn't one this version
 *  of the extension knows about (an older extension talking to a newer backend). */
export function codeToMessageKey(code: number): string | null {
  return ERROR_CODE_MESSAGE_KEYS[code] ?? null;
}

export type ParsedWorkerError = {
  /** Set when the leading number matches a code this extension recognizes. `text` is
   *  null in this case — the caller looks up its OWN message via codeToMessageKey()
   *  and disregards whatever the backend sent after the dash entirely. */
  code: number | null;
  /** The text to display directly, already resolved to a single string. Set whenever
   *  `code` is null: either the worker sent an unrecognized code (this is the picked
   *  locale's text, or the plain fallback text, per the rules below), or the string
   *  didn't match the "N - text" shape at all (this is the whole original string). */
  text: string | null;
};

/** Parse a worker's error message against the "N - text" convention.
 *
 *  - No leading "<number> - " at all → { code: null, text: <the whole original string> }.
 *  - Leading number matches a code this extension recognizes → { code, text: null };
 *    the caller must look up its own localized text for `code` and ignore the rest.
 *  - Leading number is NOT recognized → falls back to the text after the dash:
 *      - If that text is a `{...}` JSON object, it's a dictionary of locale → message.
 *        Pick the extension's locale, else a locale sharing the same base language,
 *        else an English variant, else whatever's first in the dictionary.
 *      - Otherwise use that text verbatim.
 *
 *  `uiLocale` is the extension's current display locale (e.g. "pt-BR"), used only for
 *  the locale-dictionary fallback above. */
export function parseWorkerErrorMessage(message: string, uiLocale: string): ParsedWorkerError {
  const trimmed = (message ?? '').trim();
  const match = /^(\d+)\s*-\s*([\s\S]*)$/.exec(trimmed);
  if (!match) return { code: null, text: trimmed || null };

  const code = parseInt(match[1], 10);
  const rest = match[2];

  if (codeToMessageKey(code) !== null) return { code, text: null };

  return { code: null, text: resolveUnrecognizedCodeText(rest, uiLocale) };
}

/** Resolve the fallback text for an unrecognized code: a locale dictionary if the
 *  text is curly-brace-enclosed JSON, otherwise the text itself. */
function resolveUnrecognizedCodeText(rest: string, uiLocale: string): string {
  const trimmedRest = rest.trim();
  if (trimmedRest.startsWith('{') && trimmedRest.endsWith('}')) {
    try {
      const dict = JSON.parse(trimmedRest);
      if (dict && typeof dict === 'object' && !Array.isArray(dict)) {
        const picked = pickLocaleFromDict(dict as Record<string, string>, uiLocale);
        if (picked !== null) return picked;
      }
    } catch { /* not valid JSON despite the braces — fall through to plain text */ }
  }
  return rest;
}

/** Locale-keyed dictionary lookup: exact locale, then same base language, then an
 *  English variant, then whatever's first. Mirrors data/Classification.ts's
 *  sameLanguage() base-language comparison used elsewhere in the extension. */
function pickLocaleFromDict(dict: Record<string, string>, uiLocale: string): string | null {
  if (typeof dict[uiLocale] === 'string') return dict[uiLocale];

  for (const [key, value] of Object.entries(dict)) {
    if (typeof value === 'string' && sameLanguage(key, uiLocale)) return value;
  }

  for (const [key, value] of Object.entries(dict)) {
    if (typeof value === 'string' && sameLanguage(key, 'en')) return value;
  }

  const first = Object.values(dict).find(value => typeof value === 'string');
  return (first as string) ?? null;
}
