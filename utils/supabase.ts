import { createClient, SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://pofekzkirnysbuqbxmvp.supabase.co';
const supabaseAnonKey = 'sb_publishable_4ZX8ljVPNImnvcpLl60Q_g_zgOK77Ua';

/** Custom storage adapter backed by chrome.storage.local so the auth session is
 *  shared across every extension context (popup, background service worker,
 *  content scripts) and survives service-worker restarts. */
const chromeStorageAdapter = {
  getItem: async (key: string): Promise<string | null> => {
    const data = await chrome.storage.local.get(key);
    return (data[key] as string) || null;
  },
  setItem: async (key: string, value: string): Promise<void> => {
    await chrome.storage.local.set({ [key]: value });
  },
  removeItem: async (key: string): Promise<void> => {
    await chrome.storage.local.remove(key);
  },
};

/** Single shared Supabase client for the whole extension. Both the popup (auth UI)
 *  and the background service worker (Realtime subscriptions + RPCs) use this so they
 *  share one authenticated session. */
export const supabase: SupabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: chromeStorageAdapter,
    autoRefreshToken: true,   // Automatically refreshes tokens in the background
    persistSession: true,     // Keeps session locked into local storage
    detectSessionInUrl: false, // Prevents extension from misinterpreting main tab window URLs
  },
});

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
  // Keep the Realtime auth token in sync with refreshes / sign-in / sign-out.
  return realtimeAuthReady;
}

// Propagate token changes to the Realtime socket for the life of the client.
supabase.auth.onAuthStateChange((_event, session) => {
  if (session?.access_token) {
    supabase.realtime.setAuth(session.access_token);
  }
});
