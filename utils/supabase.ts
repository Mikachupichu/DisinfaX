import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { browser } from 'wxt/browser';
import { isPlatformHost } from './platforms/hosts';

const supabaseUrl = 'https://pofekzkirnysbuqbxmvp.supabase.co';
/** Supabase's *publishable* (anon) key. This is designed to ship in client code: it
 *  grants no privileges by itself, and every table is gated by row-level security
 *  policies keyed on auth.uid(). It is not a secret. */
const supabaseAnonKey = 'sb_publishable_4ZX8ljVPNImnvcpLl60Q_g_zgOK77Ua';

/** Custom storage adapter backed by browser.storage.local so the auth session is
 *  shared across every extension context (popup, background service worker,
 *  content scripts) and survives service-worker restarts. */
const chromeStorageAdapter = {
  getItem: async (key: string): Promise<string | null> => {
    const data = await browser.storage.local.get(key);
    return (data[key] as string) || null;
  },
  setItem: async (key: string, value: string): Promise<void> => {
    await browser.storage.local.set({ [key]: value });
  },
  removeItem: async (key: string): Promise<void> => {
    await browser.storage.local.remove(key);
  },
};

/** Whether this JS context is allowed to own the authenticated session.
 *
 *  Content scripts must NEVER construct a persisting auth client: they share the
 *  session slot with the popup/background, and each page load runs
 *  `_recoverAndRefresh()` against it — a racy read there wipes the slot via
 *  `_removeSession()` (no server call), logging the user out with zero server
 *  logs. Content scripts need no Supabase API at all (relay/capture only pass
 *  messages; auth headers are minted in the background).
 *
 *  Detection is by hostname, because content scripts run on a platform page while the
 *  popup/background/options pages do not. It asks the platform host list rather than
 *  naming x.com so that adding a platform cannot introduce this bug by omission — the
 *  failure mode is a silent sign-out with no server-side trace, which is exactly the
 *  kind of thing that ships unnoticed. Best-effort: anything unrecognized keeps the
 *  session-owning client, so a detection miss degrades to the previous behaviour
 *  rather than signing anyone out. */
function ownsAuthSession(): boolean {
  try {
    const loc = (globalThis as { location?: { href?: unknown; hostname?: unknown } }).location;
    if (!loc || typeof loc.hostname !== 'string' || !loc.hostname) return true;
    return !isPlatformHost(loc.hostname);
  } catch {
    return true;
  }
}

/** Single shared Supabase client for the whole extension. Both the popup (auth UI)
 *  and the background service worker (Realtime subscriptions + RPCs) use this so they
 *  share one authenticated session.
 *
 *  In content-script contexts this is a sessionless client instead
 *  (persistSession:false → private in-memory storage, autoRefreshToken:false):
 *  it can never read, write, or wipe the shared slot. Defence in depth behind
 *  the utils/sources.ts severance — even if a future import re-drags this module
 *  into a content bundle, no client there can touch the session. */
const sessionOwner = ownsAuthSession();
export const supabase: SupabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
  auth: sessionOwner
    ? {
        storage: chromeStorageAdapter,
        autoRefreshToken: true,   // Automatically refreshes tokens in the background
        persistSession: true,     // Keeps session locked into local storage
        detectSessionInUrl: false, // Prevents extension from misinterpreting main tab window URLs
      }
    : {
        persistSession: false,    // Private in-memory storage: the shared slot is untouched
        autoRefreshToken: false,  // No timers, no _recoverAndRefresh rotation attempts
        detectSessionInUrl: false,
      },
});

/** The sign-in rows we offer, keyed by the name WE use for them.
 *
 *  Lives here rather than in the popup because two contexts need the same list and must
 *  not be able to disagree: the popup draws the buttons from it, and the background
 *  validates the provider before recording it for the "last used" badge (the Firefox
 *  flow completes while the popup is dead, so the background writes that value). A
 *  second copy of an allowlist is exactly the shape that drifts. */
export type OAuthProvider = 'x' | 'google' | 'apple' | 'facebook' | 'linkedin' | 'reddit';

/** The rows the sign-in screen offers, in the order it draws them. */
export const OAUTH_PROVIDERS: OAuthProvider[] = ['google', 'apple', 'x', 'facebook', 'linkedin', 'reddit'];

/** Supabase's own name for each row, which is not always ours.
 *
 *  LinkedIn must be the OIDC provider: `linkedin` is the older one and drives LinkedIn's
 *  deprecated OAuth 2.0 endpoints. Reddit is not one of Supabase's built-in providers at all, so
 *  it is addressed through the custom OAuth2 provider configured in the dashboard — the
 *  identifier there has to be `reddit` for this string to resolve. The three others are the
 *  provider's own name. These values go straight into `signInWithOAuth`, so the union they form
 *  is what type-checks them against Supabase's own list. */
export const SUPABASE_PROVIDER = {
  google: 'google',
  apple: 'apple',
  x: 'x',
  facebook: 'facebook',
  linkedin: 'linkedin_oidc',
  reddit: 'custom:reddit',
} as const satisfies Record<OAuthProvider, string>;

/** The scopes each provider is asked for. `openid` is what makes Google and LinkedIn return an
 *  ID token, and LinkedIn's OIDC app is only allowed those three; Reddit's `identity` is the
 *  scope that lets the custom provider read `/api/v1/me`. Facebook's `email` is the smallest
 *  scope that yields a usable identity, and Apple is asked for nothing, as before. */
export const OAUTH_SCOPES = {
  google: 'openid',
  apple: '',
  x: 'users.read',
  facebook: 'email',
  linkedin: 'openid profile email',
  reddit: 'identity',
} as const satisfies Record<OAuthProvider, string>;

/** Narrow an untrusted value (a stored badge, a message from the popup) to a provider we
 *  actually offer, or null. */
export function asOAuthProvider(value: unknown): OAuthProvider | null {
  return OAUTH_PROVIDERS.includes(value as OAuthProvider) ? (value as OAuthProvider) : null;
}

let refreshInFlight: Promise<void> | null = null;
const REFRESH_MARGIN_SECONDS = 60;

/** Ensure the current session's access token isn't expired (or about to be) before a
 *  caller uses it, refreshing first if needed.
 *
 *  `autoRefreshToken`'s proactive refresh runs off an in-memory timer, which doesn't
 *  survive a Manifest V3 service-worker restart (idle workers are killed after ~30s).
 *  If the token happens to expire while the worker is asleep, nothing refreshes it
 *  until something asks — and a single user click can fire SEVERAL worker requests in
 *  parallel (e.g. translating multiple claims + relocating highlights at once), each
 *  independently calling getSession() and each getting the same stale token, so all
 *  of them fail authentication together. Concurrent callers share this ONE in-flight
 *  refresh instead of each racing to read the same expired session. */
export function ensureFreshSession(): Promise<void> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const { data } = await supabase.auth.getSession();
      const session = data.session;
      if (!session) { console.log('[ensureFreshSession] no session found'); return; }
      const secondsToExpiry = (session.expires_at ?? 0) - Date.now() / 1000;
      if (secondsToExpiry <= REFRESH_MARGIN_SECONDS) {
        console.log(`[ensureFreshSession] token expires in ${secondsToExpiry.toFixed(0)}s, refreshing...`);
        const { error } = await supabase.auth.refreshSession();
        if (error) console.error('[ensureFreshSession] refresh failed:', error.message);
        else console.log('[ensureFreshSession] refresh succeeded');
      } else {
        console.log(`[ensureFreshSession] token fresh (expires in ${secondsToExpiry.toFixed(0)}s), no refresh needed`);
      }
    })().finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

let realtimeAuthReady: Promise<void> | null = null;

/** Ensure the persisted session is loaded and the Realtime socket is authenticated
 *  before opening any channel. The session is read asynchronously from
 *  chrome.storage.local, so a channel opened too early would connect without the
 *  user's access token and silently receive nothing (RLS filters by auth.uid()).
 *
 *  Safe to await repeatedly — the work runs once and the same promise is reused. */
export function ensureRealtimeAuth(): Promise<void> {
  if (!realtimeAuthReady) {
    realtimeAuthReady = (async () => {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (token) supabase.realtime.setAuth(token);
    })().catch(err => {
      // Reset so a later call can retry after a transient failure.
      realtimeAuthReady = null;
      throw err;
    });
  }
  return realtimeAuthReady;
}

// Propagate token changes to the Realtime socket for the life of the client.
supabase.auth.onAuthStateChange((_event, session) => {
  if (session?.access_token) {
    supabase.realtime.setAuth(session.access_token);
  }
});
