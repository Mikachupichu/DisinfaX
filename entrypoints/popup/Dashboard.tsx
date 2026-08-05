import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase } from './supabaseClient';
import { useT, getUiLocale, formatUsdNumber, giftPercent, formatPercent } from './i18n';
import { parseWorkerErrorMessage, codeToMessageKey } from '../../utils/errorCodes';

/** Render a USD amount with a smaller "US$" symbol vertically centered against the
 *  number (rather than baseline-aligned). Symbol size scales with the surrounding font
 *  size via `em`, so it works at any text size.
 *
 *  `hangUs` (default true): the small "US" hangs to the left, out of flow, so only
 *  "$<amount>" participates in centering — used for the balance. Set false to keep
 *  "US" in-flow so the whole "US$<amount>" centers as one unit — used in the buttons. */
function Usd({ value, locale, hangUs = true }: { value: number; locale: string; hangUs?: boolean }) {
  return (
    <span className="relative inline-flex items-center align-middle leading-none">
      <span className={`${hangUs ? 'absolute right-full top-1/2 -translate-y-1/2' : ''} text-[0.6em] font-semibold leading-none whitespace-nowrap`}>US</span>
      <span className="font-semibold leading-none">$</span>
      <span className="leading-none">{formatUsdNumber(value, locale)}</span>
    </span>
  );
}

const CHECKOUT_URL = 'https://create-checkout-session.michael-pouget01.workers.dev/';

/** Preset top-up amounts (USD). "custom" is a free-entry integer ≥ 5. */
const PRESETS = [5, 10, 15, 30] as const;
type Selection = '5' | '10' | '15' | '30' | 'custom';
const DEFAULT_SELECTION: Selection = '10';
const DEFAULT_CUSTOM = '23';

/** Narrow an arbitrary stored value to a Selection, so a stale or hand-edited storage
 *  entry can't put the component into a state the UI doesn't render. */
function isSelection(value: unknown): value is Selection {
  return typeof value === 'string' && (value === 'custom' || PRESETS.some(preset => String(preset) === value));
}

const STORE_SELECTION = 'mf_topup_selection';
const STORE_CUSTOM = 'mf_topup_custom_amount';

function storageGet(keys: string[]): Promise<Record<string, any>> {
  try { return Promise.resolve(chrome.storage.local.get(keys)) as Promise<Record<string, any>>; }
  catch { return Promise.resolve({}); }
}
function storageSet(obj: Record<string, any>): void {
  try { chrome.storage.local.set(obj); } catch { /* ignore */ }
}

/** Effective integer amount from the custom field's raw text (min $5). */
function customToAmount(raw: string): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 5 ? n : 5;
}

/** Split a template containing %TOKEN% markers into React nodes, substituting each
 *  token with the matching element (used for the ToS / Privacy links). */
function renderWithLinks(template: string, tokens: Record<string, React.ReactNode>): React.ReactNode[] {
  // The capturing group keeps the tokens themselves in the split output, so text and
  // tokens arrive interleaved and in order.
  const parts = template.split(/(%[A-Z]+%)/g);
  return parts.map((part, index) => {
    const token = /^%([A-Z]+)%$/.exec(part);
    if (token && tokens[token[1]] !== undefined) return <React.Fragment key={index}>{tokens[token[1]]}</React.Fragment>;
    return <React.Fragment key={index}>{part}</React.Fragment>;
  });
}

const InfoIcon = () => (
  <svg className="w-4 h-4 flex-shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="16" x2="12" y2="12" />
    <line x1="12" y1="8" x2="12.01" y2="8" />
  </svg>
);

const ChevronUp = () => (
  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="18 15 12 9 6 15" /></svg>
);
const ChevronDown = () => (
  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9" /></svg>
);

interface DashboardProps {
  /** The signed-in user. Part of the contract with App, which only renders Dashboard
   *  once a session exists; the balance and messages come from the background rather
   *  than from this object, so nothing here reads it yet. */
  user: User;
  onSignOut: () => void;
}

export default function Dashboard({ onSignOut }: DashboardProps) {
  const t = useT();
  const locale = getUiLocale();

  const [total, setTotal] = useState<number | null>(null);
  const [messages, setMessages] = useState<string[]>([]);
  const [selection, setSelection] = useState<Selection>(DEFAULT_SELECTION);
  const [customInput, setCustomInput] = useState<string>(DEFAULT_CUSTOM);
  const [loaded, setLoaded] = useState(false);
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [disclaimerExpanded, setDisclaimerExpanded] = useState(false);
  const customRef = useRef<HTMLInputElement>(null);

  // Load persisted selection + custom amount, current balance, and messages.
  useEffect(() => {
    (async () => {
      const stored = await storageGet([STORE_SELECTION, STORE_CUSTOM]);
      if (isSelection(stored[STORE_SELECTION])) setSelection(stored[STORE_SELECTION]);
      if (typeof stored[STORE_CUSTOM] === 'string' && stored[STORE_CUSTOM].trim()) setCustomInput(stored[STORE_CUSTOM]);
      setLoaded(true);
    })();

    // Balance: ask the background hub for the current total, then live-update below.
    try {
      chrome.runtime.sendMessage({ type: 'MF_FUNDS_GET' }, (response: any) => {
        if (chrome.runtime.lastError) return;
        if (response && typeof response.total === 'number') setTotal(response.total);
      });
    } catch { /* ignore */ }

    // Messages (usually none).
    try {
      chrome.runtime.sendMessage({ type: 'MF_MESSAGES_GET' }, (response: any) => {
        if (chrome.runtime.lastError) return;
        const list = Array.isArray(response?.messages) ? response.messages : [];
        setMessages(pickMessages(list, locale));
      });
    } catch { /* ignore */ }

    const listener = (message: any) => {
      if (message?.type === 'MF_FUNDS_UPDATE' && typeof message.total === 'number') {
        setTotal(message.total);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => { try { chrome.runtime.onMessage.removeListener(listener); } catch { /* ignore */ } };
  }, [locale]);

  const persistSelection = useCallback((sel: Selection) => { setSelection(sel); storageSet({ [STORE_SELECTION]: sel }); }, []);

  const commitCustom = useCallback((raw: string) => {
    setCustomInput(raw);
    storageSet({ [STORE_CUSTOM]: raw });
  }, []);

  const selectedAmount = selection === 'custom' ? customToAmount(customInput) : Number(selection);

  const stepCustom = (delta: number) => {
    const next = String(Math.max(5, customToAmount(customInput) + delta));
    commitCustom(next);
  };

  const startCheckout = async () => {
    setCheckoutError(null);
    setCheckoutBusy(true);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      const response = await fetch(CHECKOUT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ amount: selectedAmount }),
      });
      if (!response.ok) {
        // The worker reports failures as {"error": "..."} but may also return plain
        // text, so fall back to the raw body when it isn't JSON.
        const body = await response.text();
        let failureMessage = body;
        try {
          const parsed = JSON.parse(body);
          if (parsed?.error) failureMessage = parsed.error;
        } catch { /* not JSON — keep the raw body */ }
        // Recognized error codes (see utils/errorCodes.ts) use this extension's own
        // localized text instead of whatever the worker sent after the dash.
        const parsedError = parseWorkerErrorMessage(failureMessage, locale);
        const messageKey = parsedError.code != null ? codeToMessageKey(parsedError.code) : null;
        const resolvedMessage = messageKey ? t(messageKey) : parsedError.text;
        throw new Error(resolvedMessage || t('checkoutError'));
      }
      const { url } = await response.json();
      if (!url) throw new Error(t('checkoutError'));
      // Hand off to the background, which opens the Stripe tab and closes it on the
      // redirect back to disinfax.app. Then close the popup.
      try { chrome.runtime.sendMessage({ type: 'MF_OPEN_CHECKOUT', url }); } catch { /* ignore */ }
      window.close();
    } catch (err: any) {
      setCheckoutError(err?.message || t('checkoutError'));
    } finally {
      setCheckoutBusy(false);
    }
  };

  // The "agree" sentence (with the ToS/Privacy links) is ALWAYS shown so the links
  // are never hidden. Up to ~140 total characters are shown collapsed: the agree
  // sentence plus as much of the trailing FX + jurisdiction text as fits; the rest
  // hides behind "Show more".
  const DISCLAIMER_COLLAPSED_CHARS = 140;
  const disclaimerRest = `${t('disclaimerFx')} ${t('disclaimerJurisdiction')}`.replace(/\s+/g, ' ').trim();
  // Measure the agree sentence with its links resolved to plain text, since that is
  // what occupies the character budget on screen.
  const agreePlainLength = t('disclaimerAgree').replace('%TOS%', t('termsOfService')).replace('%PRIVACY%', t('privacyPolicy')).replace(/\s+/g, ' ').trim().length;
  const disclaimerRestBudget = Math.max(0, DISCLAIMER_COLLAPSED_CHARS - agreePlainLength);
  const disclaimerRestPreview = disclaimerRest.slice(0, disclaimerRestBudget).trimEnd();
  const disclaimerNeedsTruncate = disclaimerRestPreview.length < disclaimerRest.length;

  return (
    <div className="flex flex-col flex-1 gap-4">
      {/* ── Messages (usually none) ── */}
      {messages.length > 0 && (
        <div className="flex flex-col gap-2">
          {messages.map((message, index) => (
            <div key={index} className="flex items-start gap-2 p-2.5 bg-red-950/50 border border-red-900 rounded-xl text-red-300 text-xs leading-relaxed">
              <InfoIcon />
              <span className="whitespace-pre-wrap break-words">{message}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── Balance ── */}
      <div className="text-center pt-1">
        <div className="text-[10px] uppercase tracking-widest text-zinc-500 mb-1">{t('balanceLabel')}</div>
        <div className="text-4xl font-black tracking-tight text-white tabular-nums break-all">
          {total === null ? '—' : <Usd value={total} locale={locale} />}
        </div>
      </div>

      {/* ── Top-up options ── */}
      <div className="grid grid-cols-2 gap-2.5">
        {PRESETS.map((presetAmount) => {
          const isSelected = selection === String(presetAmount);
          const bonusPercent = giftPercent(presetAmount);
          return (
            <button
              key={presetAmount}
              onClick={() => persistSelection(String(presetAmount) as Selection)}
              className={`relative py-2.5 rounded-xl border text-sm font-semibold transition-colors ${isSelected ? 'border-emerald-500 bg-emerald-950/40 text-white' : 'border-zinc-800 bg-zinc-900/50 text-zinc-300 hover:border-zinc-700'}`}
            >
              <Usd value={presetAmount} locale={locale} hangUs={false} />
              {bonusPercent > 0 && (
                <span className="absolute -top-1.5 -right-1.5 text-[8px] font-black tracking-wide uppercase bg-emerald-500 text-black px-1.5 py-0.5 rounded-md scale-90 origin-top-right whitespace-nowrap">
                  +{formatPercent(bonusPercent, locale)}% {t('gifted')}
                </span>
              )}
            </button>
          );
        })}

        {/* Custom: a button that becomes a stepper field when selected. */}
        {selection === 'custom' ? (
          <div className="relative col-span-2">
            {giftPercent(customToAmount(customInput)) > 0 && (
              <span className="absolute -top-2 left-2 z-10 text-[8px] font-black tracking-wide uppercase bg-emerald-500 text-black px-1.5 py-0.5 rounded-md whitespace-nowrap">
                +{formatPercent(giftPercent(customToAmount(customInput)), locale)}% {t('gifted')}
              </span>
            )}
            <div className="flex items-stretch rounded-xl border border-emerald-500 bg-emerald-950/40 overflow-hidden">
              {/* "US$" prefix for the editable field. Spelled out rather than reusing
                  <Usd> because there is no amount to render here — the number lives in
                  the adjacent <input> — and this copy needs its own optical nudge. */}
              <span className="flex items-center pl-3 pr-0 text-sm text-white select-none"><span className="relative inline-flex items-center align-middle leading-none"><span className="relative top-[0.75px] text-[0.6em] font-semibold leading-none whitespace-nowrap">US</span><span className="font-semibold leading-none">$</span></span></span>
              <input
                ref={customRef}
                type="text"
                inputMode="numeric"
                value={customInput}
                onChange={(e) => commitCustom(e.target.value.replace(/[^0-9]/g, ''))}
                onBlur={() => commitCustom(String(customToAmount(customInput)))}
                aria-label={t('customAmountLabel')}
                className="flex-1 min-w-0 bg-transparent py-2.5 text-sm font-semibold text-white outline-none"
              />
              <div className="flex flex-col border-l border-emerald-500/40">
                <button onClick={() => stepCustom(1)} aria-label={t('increase')} className="flex-1 px-2 text-zinc-300 hover:text-white hover:bg-emerald-900/40"><ChevronUp /></button>
                <button
                  onClick={() => stepCustom(-1)}
                  aria-label={t('decrease')}
                  disabled={customToAmount(customInput) <= 5}
                  className="flex-1 px-2 text-zinc-300 hover:text-white hover:bg-emerald-900/40 border-t border-emerald-500/40 disabled:text-zinc-600 disabled:hover:bg-transparent disabled:hover:text-zinc-600 disabled:cursor-not-allowed"
                ><ChevronDown /></button>
              </div>
            </div>
          </div>
        ) : (
          <button
            onClick={() => { persistSelection('custom'); setTimeout(() => customRef.current?.focus(), 0); }}
            className="col-span-2 py-2.5 rounded-xl border border-zinc-800 bg-zinc-900/50 text-zinc-300 hover:border-zinc-700 text-sm font-semibold transition-colors"
          >
            {t('customTopup')}
          </button>
        )}
      </div>

      {/* ── Top Up + disclaimer ── */}
      <div className="flex flex-col gap-2">
        {checkoutError && (
          <div className="p-2 text-xs bg-red-950/50 border border-red-900 rounded-xl text-red-400 text-center">{checkoutError}</div>
        )}
        <button
          onClick={startCheckout}
          disabled={checkoutBusy || !loaded}
          className="w-full py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white font-semibold text-sm transition-colors"
        >
          {checkoutBusy ? t('processing') : t('topUp')}
        </button>

        <div className="text-[8px] leading-tight text-zinc-600 px-1">
          <p className="text-center">
            {renderWithLinks(t('disclaimerAgree'), {
              TOS: <a key="tos" href="https://disinfax.app/terms-of-use" target="_blank" rel="noreferrer" className="text-zinc-400 underline hover:text-zinc-200">{t('termsOfService')}</a>,
              PRIVACY: <a key="pp" href="https://disinfax.app/privacy-policy" target="_blank" rel="noreferrer" className="text-zinc-400 underline hover:text-zinc-200">{t('privacyPolicy')}</a>,
            })}
            {disclaimerExpanded
              ? <>{' '}{t('disclaimerFx')}{' '}{t('disclaimerJurisdiction')}</>
              : (disclaimerRestPreview && <>{' '}{disclaimerRestPreview}</>)}
            {!disclaimerExpanded && disclaimerNeedsTruncate ? '…' : null}
          </p>
          {disclaimerNeedsTruncate && (
            <button
              type="button"
              onClick={() => setDisclaimerExpanded(v => !v)}
              aria-expanded={disclaimerExpanded}
              className="mx-auto mt-0.5 flex items-center gap-0.5 rounded px-1 py-0.5 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60 font-semibold"
            >
              {disclaimerExpanded ? t('showLess') : t('showMore')}
              <svg className={`w-2.5 h-2.5 transition-transform ${disclaimerExpanded ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9" /></svg>
            </button>
          )}
        </div>
      </div>

      <button
        onClick={onSignOut}
        className="w-full py-2 px-4 text-zinc-400 hover:text-white bg-zinc-900/50 hover:bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-xs font-medium rounded-xl transition-all duration-150 cursor-pointer"
      >
        {t('signOut')}
      </button>
    </div>
  );
}

/** Extract the current-locale string from each message dictionary (fallback English).
 *  Entries may also arrive as bare strings, which are taken as-is. */
function pickMessages(list: any[], locale: string): string[] {
  const base = locale.split('-')[0].toLowerCase();
  const picked: string[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') {
      if (typeof entry === 'string') picked.push(entry);
      continue;
    }
    let text = entry[locale];
    if (typeof text !== 'string') {
      // No exact locale key — accept any entry for the same base language, then fall
      // back to English, then to whatever string the dictionary has.
      const sameLanguage = Object.entries(entry).find(([key, value]) =>
        typeof value === 'string' && (key === base || key.toLowerCase().startsWith(base + '-')));
      text = sameLanguage
        ? (sameLanguage[1] as string)
        : (typeof entry.en === 'string' ? entry.en : Object.values(entry).find(value => typeof value === 'string') as string);
    }
    if (typeof text === 'string' && text.trim()) picked.push(text);
  }
  return picked;
}
