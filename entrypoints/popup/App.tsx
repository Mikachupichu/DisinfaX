import React, { useState, useEffect } from 'react';
import { supabase, OAUTH_PROVIDERS, SUPABASE_PROVIDER, OAUTH_SCOPES, asOAuthProvider } from './supabaseClient';
import type { OAuthProvider } from './supabaseClient';
import { AuthChangeEvent, Session, User } from '@supabase/supabase-js';
import Dashboard from './Dashboard';
import FactCheckGuide from './FactCheckGuide';
import { dismissFactCheckGuide, factCheckGuideDue } from '../../utils/guideOverlay';
import { useT, getUiLocale, isRtl } from './i18n';
import { useResolvedScheme } from './theme';
import { browser } from 'wxt/browser';
import { callNativeHost, NATIVE_CALLBACK_SCHEME } from '../../utils/nativeHost';
import {
  adoptNativeSession,
  markPopupOpened,
  NATIVE_SIGNOUT_KEY,
  publishLastProvider,
  readLastProvider,
  requestNativeSignIn,
} from '../../utils/nativeSession';
import { SUPABASE_AUTH_STORAGE_KEY } from '../../utils/supabase';

/** Where the provider sends the user back on Safari, on BOTH platforms — and the same value
 *  the macOS ASWebAuthenticationSession is asked to catch, so one entry in Supabase's Redirect
 *  URLs allowlist covers the two.
 *
 *  iOS used to redirect to our own https://disinfax.app/success so a content script could
 *  harvest the callback without host access to a social site. That needs a per-site grant on
 *  disinfax.app, and Safari only offers one through a prompt the user has no reason to expect:
 *  sign-in then completed only if they happened to open the popup while sitting on that exact
 *  page, and otherwise did nothing at all. The app relay replaces it — the redirect opens the
 *  containing app, which parks the callback in the App Group container for the extension to
 *  collect. See TopUpHandoff.swift and pullPendingNativeAuth in entrypoints/background.ts. */
const NATIVE_AUTH_CALLBACK_URL = 'disinfax://auth-callback';

/** True on iPhone/iPad. One Safari build serves macOS and iOS, so this cannot be decided
 *  at build time via import.meta.env.SAFARI — and the two need different OAuth transports:
 *  macOS presents ASWebAuthenticationSession through the containing app, while an iOS app
 *  extension has no window to present it from and must use a Safari tab instead.
 *  The maxTouchPoints clause catches iPadOS, which reports itself as "MacIntel". */
function isIosOrIpadOs(): boolean {
  try {
    return /iPad|iPhone|iPod/.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  } catch {
    return false;
  }
}

/** Remembers the provider used for the last successful sign-in so it can be badged on
 *  return visits. Popup-local (extension origin), and only written after a session is
 *  actually established. */
const LAST_PROVIDER_STORAGE_KEY = 'disinfax_last_oauth_provider';

/** When that provider was recorded, in epoch milliseconds. The app keeps the same fact for its
 *  own sign-in buttons in the shared container, and neither side can read the other's storage —
 *  so both stamp it, and whichever is newer is the one both surfaces badge. */
const LAST_PROVIDER_AT_KEY = 'disinfax_last_oauth_provider_at';

/** Written just before a user-chosen sign-out so the background can tell it apart from a
 *  session the SERVER killed. Both look identical from the auth slot alone, and the
 *  background raises a "you're not signed in" notice for the server-killed case (see
 *  consumeIntentionalSignOut in entrypoints/background.ts) — which must not appear when
 *  the user is the one who signed out. Read-and-cleared by the background. */
const INTENTIONAL_SIGNOUT_KEY = 'mf_intentional_signout';

/** The DisinfaX spray-bottle wordmark logo. Uses the variants shipped in
 *  public/icon/ (same source as the toolbar icon and manifest icons) instead of a
 *  hardcoded inline copy, so updating those files updates this too.
 *
 *  White on the dark panel, black on the light one — a white mark on white is no mark at
 *  all. Keyed on the resolved scheme, not on the preference, so Automatic picks whichever
 *  the system is asking for. */
const DisinfaxLogo = () => (
  <img
    src={useResolvedScheme() === 'light' ? '/icon/96-black.png' : '/icon/96-white.png'}
    alt=""
    className="w-8 h-8 flex-shrink-0 self-start"
  />
);

/** Google's mark keeps its brand colours, so unlike the others it does not use
 *  `fill-current`.
 *
 *  This is Google's own published sign-in artwork (`public/google-logo.png`) rather
 *  than a transcription of it. A conic gradient masked through a hand-entered letter
 *  outline was what stood here, and a sweep wraps: its red runs from 289deg round to
 *  4deg, so the seam lands on the end of the crossbar, where the logo is blue. */
const GoogleIcon = () => (
  <img src="/google-logo.png" alt="" aria-hidden="true" className="w-5 h-5" />
);

const AppleIcon = () => (
  <svg className="w-5 h-5 fill-current" viewBox="0 0 24 24">
    <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M15.97 4.17c.66-.81 1.11-1.93.99-3.06-.96.04-2.13.64-2.82 1.45-.6.7-1.13 1.84-.99 2.94 1.07.08 2.16-.52 2.82-1.33z"/>
  </svg>
);

const XIcon = () => (
  <svg className="w-5 h-5 fill-current" viewBox="0 0 24 24">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
  </svg>
);

/** Like Google's, these three keep their brand colours on the white button rather than
 *  inheriting `fill-current`, so all four read as the service's own mark. */
const FacebookIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#1877F2" d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.1 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.68.24 2.68.24v2.97h-1.51c-1.49 0-1.96.93-1.96 1.89v2.25h3.33l-.53 3.49h-2.8V24C19.61 23.1 24 18.1 24 12.07z"/>
  </svg>
);

const LinkedInIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#0A66C2" d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.13 1.45-2.13 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zM7.12 20.45H3.55V9h3.57v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.72v20.56C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.72V1.72C24 .77 23.2 0 22.22 0z"/>
  </svg>
);

const RedditIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="12" fill="#FF4500"/>
    <path fill="#fff" d="M19.5 12a1.5 1.5 0 0 0-2.55-1.06 7.4 7.4 0 0 0-3.9-1.23l.83-3.9 2.71.58a1.06 1.06 0 1 0 .12-.73l-3.02-.64a.36.36 0 0 0-.43.28l-.92 4.31a7.4 7.4 0 0 0-4 1.23A1.5 1.5 0 1 0 6.9 13.6a2.9 2.9 0 0 0-.05.55c0 2.8 3.24 5.07 7.15 5.07s7.15-2.27 7.15-5.07a2.9 2.9 0 0 0-.05-.55A1.5 1.5 0 0 0 19.5 12zM9.2 13.8a1.06 1.06 0 1 1 2.12 0 1.06 1.06 0 0 1-2.12 0zm5.9 3.14c-.75.75-2.19.81-2.6.81-.41 0-1.85-.06-2.6-.81a.3.3 0 0 1 .42-.42c.48.47 1.5.63 2.18.63s1.7-.16 2.18-.63a.3.3 0 0 1 .42.42zm-.42-2.08a1.06 1.06 0 1 1 0-2.12 1.06 1.06 0 0 1 0 2.12z"/>
  </svg>
);

/** One provider row on the sign-in screen, badged when it was the last one used. */
/** Whether the four social sign-in rows are offered on the sign-in screen.
 *
 *  All four are built and wired (see utils/supabase.ts), but none of them can currently complete:
 *  Reddit gates new API clients behind a manual approval, Meta has this account under a
 *  device-trust restriction, and the extension is still a friends-only beta besides. Google and
 *  Apple are unaffected. Set this back to `true` to restore all four rows — no other change is
 *  needed, and each provider starts working on its own as soon as it is enabled in Supabase. */
const SHOW_SOCIAL_SIGNIN = false;

function OAuthButton({ icon, label, isLastUsed, lastUsedLabel, onClick }: {
  icon: React.ReactNode;
  label: string;
  isLastUsed: boolean;
  lastUsedLabel: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className="relative flex items-center justify-center gap-3 w-full bg-white text-black font-medium py-3 px-4 rounded-xl border border-zinc-200 hover:bg-zinc-50 transition-colors"
    >
      {icon}
      <span>{label}</span>
      {isLastUsed && (
        <span className="absolute top-1 right-1 text-[8px] font-black tracking-wide uppercase bg-emerald-50 text-emerald-600 px-1.5 py-0.5 rounded-md border border-emerald-200 scale-90 origin-top-right">{lastUsedLabel}</span>
      )}
    </button>
  );
}

export default function App() {
  const t = useT();
  const locale = getUiLocale();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [authError, setAuthError] = useState<string | null>(null);
  /** Set by Dashboard while a webpage-selection fact-check is starting up. Only effect:
   *  the footer below is not rendered, so the popup reads as the indicator alone. */
  const [selectionActive, setSelectionActive] = useState(false);
  /** Whether the overlay owes its guide — asked of the app on Safari, of extension storage
   *  everywhere else, because a tap on it has to dismiss the app's copy too. */
  const [guideDue, setGuideDue] = useState(false);

  const [lastUsedProvider, setLastUsedProvider] = useState<string | null>(() => {
    // Guarded because this runs during the first render: a throwing localStorage
    // (Safari can restrict it under some privacy settings) would take the whole popup
    // down over a cosmetic badge. Matches the defensive access in ./i18n.ts.
    try { return localStorage.getItem(LAST_PROVIDER_STORAGE_KEY); } catch { return null; }
  });

  // The Firefox background flow (MF_WEB_AUTH) completes the session while this popup
  // is dead, so the background records the provider in browser.storage.local — the
  // only store both contexts share. Prefer it when present; localStorage above covers
  // the Chrome/Safari paths and older stored values.
  useEffect(() => {
    browser.storage.local.get(LAST_PROVIDER_STORAGE_KEY).then((r: any) => {
      const stored = r?.[LAST_PROVIDER_STORAGE_KEY];
      // Membership in the same list the buttons are drawn from, so adding a provider
      // cannot leave the badge validating against a stale set.
      if (OAUTH_PROVIDERS.includes(stored)) setLastUsedProvider(stored);
    }).catch(() => { /* badge is best-effort */ });
  }, []);

  // Safari: the app runs its own sign-in as well — its landing page, and the popup's iOS hand-off —
  // and records the provider where this profile cannot see it. The two stamps decide, so a sign-in
  // here is not overwritten by an older one there.
  useEffect(() => {
    if (!import.meta.env.SAFARI) return;
    readLastProvider().then(record => {
      if (!record || !OAUTH_PROVIDERS.includes(record.provider as OAuthProvider)) return;
      let here = 0;
      try { here = Number(localStorage.getItem(LAST_PROVIDER_AT_KEY)) || 0; } catch { /* badge is best-effort */ }
      if (record.at <= here) return;
      try {
        localStorage.setItem(LAST_PROVIDER_STORAGE_KEY, record.provider);
        localStorage.setItem(LAST_PROVIDER_AT_KEY, String(record.at));
      } catch { /* badge is best-effort */ }
      setLastUsedProvider(record.provider);
    }).catch(() => { /* badge is best-effort */ });
  }, []);

  useEffect(() => {
    const checkSession = async () => {
      // Safari: a sign-in this profile never saw — the app's own landing page, or a session
      // the app renewed while this one was closed — is taken from the shared record before
      // the signed-out screen can be drawn. Only when there is nothing usable here; a live
      // session is left to the refresh path, which keeps it in step on its own.
      if (import.meta.env.SAFARI) {
        try { await adoptNativeSession(SUPABASE_AUTH_STORAGE_KEY); }
        catch { /* best-effort: the record is read again at the next refresh */ }
        // The app tells its Safari instructions apart by whether the popup has ever been
        // opened — before that, the extension may not even be enabled. So this is the one
        // moment that fact becomes true.
        void markPopupOpened();
      }

      const { data: { session } } = await supabase.auth.getSession();
      setUser(session?.user ?? null);
      setLoading(false);
    };

    checkSession();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event: AuthChangeEvent, session: Session | null) => {
        setUser(session?.user ?? null);
      }
    );

    return () => subscription.unsubscribe();
  }, []);

  // The guide the app draws over its panes, drawn here too while the same conditions hold.
  // Asked once per sign-in rather than on a timer: the answer changes when the user does the
  // thing it describes (or taps it away), and either of those is followed by this component
  // being closed, so there is nothing to poll for. Keyed on whether there is a user rather
  // than on the user object, which changes identity on every token refresh.
  const signedIn = !!user;
  useEffect(() => {
    if (!signedIn) { setGuideDue(false); return; }
    let cancelled = false;
    factCheckGuideDue()
      .then(due => { if (!cancelled) setGuideDue(due); })
      .catch(() => { /* the guide is an extra; nothing to report */ });
    return () => { cancelled = true; };
  }, [signedIn]);

  // Safari only: a sign-in done in the containing app — which is where the provider's sheet
  // lives — writes nothing this profile can hear about. There is no push from app to extension
  // (see `readNativeSignedOutAt`), so while the popup is open and signed out it asks for the
  // shared record itself. Without this the only thing that ever asks is the background's
  // adoption, which runs on events and on a one-minute alarm — so a popup left open behind the
  // app's sheet kept drawing the signed-out screen long after the sign-in had finished.
  //
  // A local message rather than a network call, so a second is cheap, and it stops the moment
  // there is a user. A record that does not complete is not asked for twice.
  useEffect(() => {
    if (!import.meta.env.SAFARI || signedIn) return;
    let cancelled = false;
    let busy = false;
    let tried: string | null = null;
    const timer = setInterval(async () => {
      // One ask at a time: a tick that is waiting on an app which is not answering would
      // otherwise be joined by the next one every second.
      if (busy) return;
      busy = true;
      try {
        await adoptNativeSession(SUPABASE_AUTH_STORAGE_KEY);
        const raw = await browser.storage.local.get(SUPABASE_AUTH_STORAGE_KEY);
        const stored = raw?.[SUPABASE_AUTH_STORAGE_KEY];
        const record = typeof stored === 'string' ? JSON.parse(stored) : null;
        if (cancelled || !record?.access_token || !record?.refresh_token) return;
        if (record.access_token === tried) return;
        // Adoption writes the slot, but this client read its session once at startup and would
        // go on believing there is none. Handing it the record is what makes it the session the
        // popup is now using — and setSession fires SIGNED_IN, which draws the signed-in screen.
        await supabase.auth.setSession({
          access_token: record.access_token,
          refresh_token: record.refresh_token,
        });
        // Only once it has been accepted: marking the token before the call would stop the
        // retry for the one token this popup has to adopt, over a single throw.
        tried = record.access_token;
      } catch { /* the next tick asks again */ }
      finally { busy = false; }
    }, 1000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [signedIn]);

  /** Record the provider that just worked, so it can be badged next time. */
  const rememberProvider = (provider: OAuthProvider) => {
    // Swallowed deliberately: this runs AFTER the session is established, inside the
    // sign-in try block. An unguarded throw here would surface as an auth error to a
    // user who is, in fact, now signed in — over a badge that failed to persist.
    try { localStorage.setItem(LAST_PROVIDER_STORAGE_KEY, provider); } catch { /* badge is best-effort */ }
    try { localStorage.setItem(LAST_PROVIDER_AT_KEY, String(Date.now())); } catch { /* badge is best-effort */ }
    // Mirrored to browser.storage.local so every flow reads the same value: the
    // Firefox background flow (MF_WEB_AUTH) completes while this popup is dead and
    // writes there directly — see the mount effect above.
    try { void browser.storage.local.set({ [LAST_PROVIDER_STORAGE_KEY]: provider }); } catch { /* badge is best-effort */ }
    // Safari: the app draws the same badge on its own sign-in buttons, and this is the only way
    // it hears about a sign-in the popup completed.
    if (import.meta.env.SAFARI) {
      void publishLastProvider(provider).catch(() => { /* badge is best-effort */ });
    }
    setLastUsedProvider(provider);
  };

  const handleOAuthLogin = async (provider: OAuthProvider) => {
    setLoading(true);
    setAuthError(null);
    try {
      if (import.meta.env.SAFARI) {
        // -------------------------------------------------------------
        // SAFARI FLOW
        //   iOS   — the whole sign-in happens in the app. An app extension has no window to
        //           present the provider's sheet, and a Safari tab is worse than useless: the
        //           redirect leaves for the app, the popup is long gone, and Safari is left
        //           showing the provider on a loading page with no way back. So the popup only
        //           asks the app to start, and the app owns the flow from the first tap. There
        //           is nothing to collect afterwards either — the extension adopts the shared
        //           session record the next time it starts.
        //   macOS — the containing app presents ASWebAuthenticationSession and returns
        //           the callback URL over native messaging, so this popup finishes the
        //           exchange itself.
        // -------------------------------------------------------------
        const nativeProvider = provider === 'google' || provider === 'apple' ? provider : null;
        if (isIosOrIpadOs() && nativeProvider) {
          // Remembered now: the app opens over the popup, so this component will not be alive
          // to record a success. It is only a badge — the session itself is not in doubt.
          rememberProvider(provider);
          const opened = await requestNativeSignIn(nativeProvider);
          if (!opened) {
            // The extension is not always allowed to open its containing app — on a device the
            // native open answers `false` — so the popup page hands the scheme to the system
            // instead. The same two routes the top-up hand-off already falls back to, and for
            // the same reason: neither is guaranteed, and only one has to work.
            const handoffUrl = `disinfax://signin?provider=${nativeProvider}`;
            try { await browser.tabs.create({ url: handoffUrl }); } catch { /* Safari may refuse a non-http scheme here */ }
            try { window.open(handoffUrl, '_blank'); } catch { /* popup blocker or scheme refusal */ }
            // Unconfirmable by design, like the top-up hand-off: if either route opened the app,
            // it takes focus and this is never seen — so the message only surfaces when nothing
            // actually opened.
            throw new Error('Could not open the DisinfaX app to sign in.');
          }
          return;
        }

        // 1. Generate OAuth URL & store PKCE verifier in Supabase JS storage. The verifier
        //    lives in browser.storage.local (see utils/supabase.ts), which is where the
        //    exchange below reads it from.
        const { data, error } = await supabase.auth.signInWithOAuth({
          provider: SUPABASE_PROVIDER[provider],
          options: {
            redirectTo: NATIVE_AUTH_CALLBACK_URL,
            skipBrowserRedirect: true,
            scopes: OAUTH_SCOPES[provider],
          },
        });

        if (error) throw error;
        if (!data?.url) throw new Error('Could not produce OAuth handshake URL.');

        // 2. Pass the generated URL to the Swift host to open via
        //    ASWebAuthenticationSession. callNativeHost() tries the direct call first
        //    (proven on macOS) and falls back to relaying through the background — see
        //    utils/nativeHost.ts for why both transports exist.
        const nativeRes: any = await callNativeHost(
          { action: 'SIGN_IN', url: data.url, callbackUrlScheme: NATIVE_CALLBACK_SCHEME },
          { type: 'MF_NATIVE_SIGN_IN', url: data.url },
        );

        if (!nativeRes || nativeRes.error) {
          throw new Error(nativeRes?.error || 'Authentication flow was cancelled or failed.');
        }

        // 3. Option A: Direct Token Pair (if Swift app exchanges token natively)
        if (nativeRes.access_token && nativeRes.refresh_token) {
          const { data: sessionData, error: sessionError } = await supabase.auth.setSession({
            access_token: nativeRes.access_token,
            refresh_token: nativeRes.refresh_token,
          });
          if (sessionError) throw sessionError;

          rememberProvider(provider);
          setUser(sessionData.user);
          return;
        }

        // 4. Option B: parse the callback URL the host caught. Which half of it carries
        //    the credential depends on the client's flowType: PKCE puts `?code=` in the
        //    query, the implicit grant puts `#access_token=&refresh_token=` in the
        //    fragment. utils/supabase.ts sets no flowType, so the default applies —
        //    check both, exactly as the Chromium branch below does.
        const callbackUrl = nativeRes.callbackUrl || nativeRes.url;
        const parsedCallback = callbackUrl ? new URL(callbackUrl) : null;
        const hashParams = parsedCallback ? new URLSearchParams(parsedCallback.hash.replace(/^#/, '')) : null;

        // A provider-side rejection lands in either half too; surface its own message
        // rather than the generic failure below.
        const errorDescription = parsedCallback?.searchParams.get('error_description')
          ?? hashParams?.get('error_description');
        if (errorDescription) throw new Error(`Provider Error: ${errorDescription}`);

        // Pathway A: PKCE authorization code.
        const code = nativeRes.code || parsedCallback?.searchParams.get('code') || null;
        if (code) {
          const { data: sessionData, error: sessionError } = await supabase.auth.exchangeCodeForSession(code);
          if (sessionError) throw sessionError;

          rememberProvider(provider);
          setUser(sessionData.user);
          return;
        }

        // Pathway B: implicit grant — tokens ride in the fragment.
        const hashAccessToken = hashParams?.get('access_token');
        const hashRefreshToken = hashParams?.get('refresh_token');
        if (hashAccessToken && hashRefreshToken) {
          const { data: sessionData, error: sessionError } = await supabase.auth.setSession({
            access_token: hashAccessToken,
            refresh_token: hashRefreshToken,
          });
          if (sessionError) throw sessionError;

          rememberProvider(provider);
          setUser(sessionData.user);
          return;
        }

        throw new Error('Authentication succeeded, but no usable tokens or codes were returned.');
      } else {
        const extensionRedirectUrl = browser.identity.getRedirectURL();
        const { data, error } = await supabase.auth.signInWithOAuth({
          provider: SUPABASE_PROVIDER[provider],
          options: {
            redirectTo: extensionRedirectUrl,
            skipBrowserRedirect: true,
            scopes: OAUTH_SCOPES[provider],
          },
        });

        if (error) throw error;
        if (!data?.url) throw new Error('Could not produce OAuth handshake URL.');

        // Firefox closes the popup when the auth window opens, which destroys this very
        // context mid-await — the callback then arrives with nobody to receive it. So the
        // background runs the flow there and completes the session exchange itself; this
        // await may simply never resolve, and that is fine, because the session is already
        // in storage by then and is picked up when the popup is reopened.
        //
        // Chrome keeps its existing in-popup path: it works today, and rerouting it would
        // risk a regression for no gain.
        if (import.meta.env.FIREFOX) {
          const relayed: any = await browser.runtime.sendMessage({
            type: 'MF_WEB_AUTH',
            url: data.url,
            provider,
          });
          if (relayed?.error) throw new Error(relayed.error);
          const { data: refreshed } = await supabase.auth.getSession();
          if (refreshed.session?.user) {
            rememberProvider(provider);
            setUser(refreshed.session.user);
          }
          return;
        }

        // Drive the handshake in Chrome's own auth window rather than a tab, so the
        // provider redirects back to the extension's identity URL.
        const callbackUrl = await browser.identity.launchWebAuthFlow({
          url: data.url,
          interactive: true,
        });

        if (!callbackUrl) {
          throw new Error('Authentication flow was cancelled or failed.');
        }

        const parsedCallback = new URL(callbackUrl);

        // 1. Check if the URL returned an explicit error from the provider.
        // Providers put this in the query string or the fragment, so check both.
        const errorDescription =
          parsedCallback.searchParams.get('error_description') ||
          new URLSearchParams(parsedCallback.hash.substring(1)).get('error_description');

        if (errorDescription) {
          throw new Error(`Provider Error: ${errorDescription}`);
        }

        // 2. Try Pathway A: PKCE Authorization Code Flow
        const code = parsedCallback.searchParams.get('code');

        if (code) {
          const { data: sessionData, error: sessionError } =
            await supabase.auth.exchangeCodeForSession(code);
          if (sessionError) throw sessionError;

          // SUCCESS! Safe to commit and update state
          rememberProvider(provider);
          setUser(sessionData.user);
          return;
        }

        // 3. Try Pathway B: Implicit Grant Flow Fallback (Tokens in the Hash)
        const hashParams = new URLSearchParams(parsedCallback.hash.substring(1));
        const accessToken = hashParams.get('access_token');
        const refreshToken = hashParams.get('refresh_token');

        if (accessToken && refreshToken) {
          const { data: sessionData, error: sessionError } =
            await supabase.auth.setSession({
              access_token: accessToken,
              refresh_token: refreshToken,
            });
          if (sessionError) throw sessionError;
          rememberProvider(provider);
          setUser(sessionData.user);
          return; // Exit successfully
        }

        // If neither pathway resolved, throw a clean fallback error
        throw new Error('Authentication succeeded, but no usable tokens or codes were found in the callback URL.');
    }

    } catch (err: any) {
      console.error('OAuth Workflow Failed:', err);
      setAuthError(err.message || 'Authentication encountered an error.');
    } finally {
      setLoading(false);
    }
  };

  // End the session on this device and clear local state. Shared by Sign Out and Delete
  // Account; the only difference is that on the delete path the account is already gone
  // server-side, so the sign-out call itself can fail and is tolerated.
  const endLocalSession = async () => {
    setLoading(true);
    // Mark the intent BEFORE the session goes, so the background — which learns of this
    // only from the storage change — can suppress the "you're not signed in" notice it
    // raises when a session disappears unbidden. Awaited so the marker is durable before
    // the slot empties; a failure here is not worth blocking the sign-out over, and
    // degrades to today's behaviour (a notice the user did not strictly need).
    try { await browser.storage.local.set({ [INTENTIONAL_SIGNOUT_KEY]: Date.now() }); } catch { /* best-effort */ }
    // Safari only, and for the same reason the marker above is written first: emptying the
    // session slot is what makes the background reach for the shared record, so a sign-out
    // that does not say it happened here gets adopted straight back from the app. Best-effort
    // like the marker — without it the app's own clear still ends the session.
    if (import.meta.env.SAFARI) {
      try { await browser.storage.local.set({ [NATIVE_SIGNOUT_KEY]: Date.now() }); } catch { /* best-effort */ }
    }
    // Local scope only: the default is 'global', which revokes EVERY session on the
    // account — signing out on one device silently logged the user out everywhere else.
    // A Sign Out button should end the session on this device only.
    try { await supabase.auth.signOut({ scope: 'local' }); } catch { /* account already deleted */ }
    // Direct revocation alongside the background relay (storage.onChanged →
    // refreshActiveState → clearNativeAccount): two independent paths because
    // neither is guaranteed — the background may be suspended at this moment.
    // Fire-and-forget + Safari-only: sign-out completes identically if the
    // host is unreachable; worst case is today's relay-only behaviour.
    if (import.meta.env.SAFARI) {
      void callNativeHost(
        { action: 'CLEAR_ACCOUNT' },
        { type: 'MF_NATIVE_CLEAR_ACCOUNT' },
      ).catch(() => { /* best-effort; the background relay covers */ });
    }
    setUser(null);
    setLoading(false);
  };

  const handleSignOut = async () => {
    await endLocalSession();
  };

  // Deletes the account and its data. Resolves to a message to display, or null on
  // success — on success the session is already down and this component is unmounting.
  const handleDeleteAccount = async (): Promise<string | null> => {
    const { error } = await supabase.rpc('delete_my_account');
    if (error) return error.message;
    await endLocalSession();
    return null;
  };

  if (loading) {
    return (
      <div className="w-full min-h-[360px] flex items-center justify-center bg-zinc-950 text-zinc-200">
        <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-zinc-400"></div>
      </div>
    );
  }

  // Horizontal padding stays at 20px; vertical is zero, so content starts at the very top
  // and ends at the very bottom — vertical space is the scarce one, most of all inside the
  // iOS modal sheet at its half-height detent.
  return (
    <div dir={isRtl(locale) ? 'rtl' : 'ltr'} className="relative w-full min-h-[360px] px-5 bg-zinc-950 text-zinc-100 flex flex-col justify-between font-sans selection:bg-zinc-800">

      {!user ? (
        <div className="flex flex-col flex-1 justify-center space-y-5 my-auto">
          <div className="text-center space-y-1">
            <div className="flex items-end justify-center gap-2">
              <DisinfaxLogo />
              <h1 className="text-3xl font-black tracking-tight text-white">DisinfaX</h1>
            </div>
            <p className="text-xs text-zinc-400 max-w-[260px] mx-auto leading-relaxed">
              {t('landingTagline1')}<br />{t('landingTagline2')}
            </p>
          </div>

          {authError && (
            <div className="p-2.5 text-xs bg-red-950/50 border border-red-900 rounded-xl text-red-400 text-center">
              {authError}
            </div>
          )}

          {/* Unified layout shape profile and enlarged logo vector blocks */}
          <div className="flex flex-col gap-3 w-full max-w-[320px] mx-auto mt-6">
            <OAuthButton
              icon={<GoogleIcon />}
              label={t('continueWithGoogle')}
              isLastUsed={lastUsedProvider === 'google'}
              lastUsedLabel={t('lastUsed')}
              onClick={() => handleOAuthLogin('google')}
            />
            <OAuthButton
              icon={<AppleIcon />}
              label={t('continueWithApple')}
              isLastUsed={lastUsedProvider === 'apple'}
              lastUsedLabel={t('lastUsed')}
              onClick={() => handleOAuthLogin('apple')}
            />
            {SHOW_SOCIAL_SIGNIN && (
              <>
                <OAuthButton
                  icon={<XIcon />}
                  label={t('continueWithX')}
                  isLastUsed={lastUsedProvider === 'x'}
                  lastUsedLabel={t('lastUsed')}
                  onClick={() => handleOAuthLogin('x')}
                />
                <OAuthButton
                  icon={<FacebookIcon />}
                  label={t('continueWithFacebook')}
                  isLastUsed={lastUsedProvider === 'facebook'}
                  lastUsedLabel={t('lastUsed')}
                  onClick={() => handleOAuthLogin('facebook')}
                />
                <OAuthButton
                  icon={<LinkedInIcon />}
                  label={t('continueWithLinkedIn')}
                  isLastUsed={lastUsedProvider === 'linkedin'}
                  lastUsedLabel={t('lastUsed')}
                  onClick={() => handleOAuthLogin('linkedin')}
                />
                <OAuthButton
                  icon={<RedditIcon />}
                  label={t('continueWithReddit')}
                  isLastUsed={lastUsedProvider === 'reddit'}
                  lastUsedLabel={t('lastUsed')}
                  onClick={() => handleOAuthLogin('reddit')}
                />
              </>
            )}
          </div>
        </div>
      ) : (
        <Dashboard user={user} onSignOut={handleSignOut} onDeleteAccount={handleDeleteAccount} onSelectionActive={setSelectionActive} />
      )}

      {/* Footer sits flush against the content above it, hard on the bottom edge. Hidden
          while a webpage selection owns the popup, so the "Disinfacting" indicator is the
          only thing in it — the shape the loading state at the top of this component
          already takes. */}
      {!selectionActive && (
      <div className="text-center space-y-0.5 select-none">
        {/* Read from the manifest, never hardcoded. A literal "v1.0.0" here survived a
            version bump and made a correctly-updated build look stale — it cost a real
            debugging detour chasing an installation problem that did not exist. */}
        <div className="text-[10px] text-zinc-600">DisinfaX v{browser.runtime.getManifest().version}</div>
        {user && <div className="text-[9px] leading-tight text-zinc-600">{t('aiDisclaimer')}</div>}
        {!user && <div className="text-[10px] text-zinc-700">{t('cleanupTagline')}</div>}
      </div>
      )}
      {/* Last, so it covers the footer too: the guide is asking to be read before the popup is
          used, and it is never drawn on the landing page — a signed-out reader has no balance to
          spend and no session to fact-check with. Suppressed while a selection run is starting,
          which needs the popup's whole face for its own indicator. */}
      {signedIn && guideDue && !selectionActive && (
        <FactCheckGuide
          ios={import.meta.env.SAFARI && isIosOrIpadOs()}
          onDismiss={() => { setGuideDue(false); void dismissFactCheckGuide(); }}
        />
      )}
    </div>
  );
}
