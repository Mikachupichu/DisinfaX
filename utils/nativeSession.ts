/** The one session shared by the Safari app and its extension.
 *
 *  Both processes can renew it, which is only safe because exactly one of them ever talks to
 *  the refresh endpoint: this module routes every renewal through the native handler, which
 *  serialises them with a lock and keeps the rotated pair in the App Group. Letting
 *  supabase-js perform its own refresh here would have two clients presenting different
 *  generations of the same rotating token — the second one is either rejected (a sign-out
 *  we did not ask for) or flagged as token reuse, which revokes the whole family.
 *
 *  So in Safari builds the client keeps its own storage and its own idea of the session, but
 *  the only thing that can mint a new token is `AppSession` in Swift.
 *
 *  Only ever imported from `import.meta.env.SAFARI` branches, so this is tree-shaken out of
 *  the Chromium and Firefox bundles.
 */
import { browser } from 'wxt/browser';
import { BOUNDED_DIRECT_ATTEMPT_MS, callNativeHost, NATIVE_APP_ID } from './nativeHost';

/** A session the Swift side holds, in the units the extension already uses: epoch seconds. */
export interface NativeSession {
  accessToken: string;
  refreshToken?: string;
  /** Epoch seconds, matching supabase-js's `expires_at`. */
  expiresAt: number;
  userId?: string;
}

/** What a renewal attempt established — the same three cases the Swift side distinguishes,
 *  because the difference between "refused" and "could not ask" is the difference between
 *  signing the user out and not. */
type Renewal =
  | { kind: 'session'; session: NativeSession }
  | { kind: 'rejected' }
  | { kind: 'unavailable' };

/** One message to the containing app, direct first and relayed second.
 *
 *  Bounded, unlike the app's other native calls: these sit in the popup's startup path and
 *  in front of every renewal, so a transport that never answers must not become a screen
 *  that never loads. */
function native(direct: Record<string, unknown>, relay: Record<string, unknown>): Promise<any> {
  return callNativeHost(direct, relay, { directAttemptMs: BOUNDED_DIRECT_ATTEMPT_MS });
}

function sessionFrom(reply: any): NativeSession | null {
  if (!reply || typeof reply.accessToken !== 'string' || !reply.accessToken) return null;
  if (typeof reply.expiresAt !== 'number' || !Number.isFinite(reply.expiresAt)) return null;
  return {
    accessToken: reply.accessToken,
    refreshToken: typeof reply.refreshToken === 'string' ? reply.refreshToken : undefined,
    expiresAt: reply.expiresAt,
    userId: typeof reply.userId === 'string' ? reply.userId : undefined,
  };
}

/** The shared record, renewed first if it was close to expiring. Null means there is no
 *  session to have; an unreachable app is reported as no session, never as a sign-out — see
 *  `adoptNativeSession`, which is the only caller that has a session to lose. */
export async function readNativeSession(): Promise<NativeSession | null> {
  const reply = await native({ action: 'GET_SESSION' }, { type: 'MF_NATIVE_GET_SESSION' });
  return sessionFrom(reply);
}

async function renewNativeSession(): Promise<Renewal> {
  const reply = await native({ action: 'REFRESH_SESSION' }, { type: 'MF_NATIVE_REFRESH_SESSION' });
  const session = sessionFrom(reply);
  if (session) return { kind: 'session', session };
  if (reply?.rejected === true) return { kind: 'rejected' };
  return { kind: 'unavailable' };
}

/** When this device last ended its session, in epoch seconds — or null if it never has.
 *
 *  The one thing that has to travel app → extension, and nothing can push it: every other
 *  message on this channel is a request the extension makes. So the app stamps the shared
 *  container and this asks for the stamp (see the native `SIGNED_OUT_AT` action).
 *
 *  Direct only, unlike `native()`: the caller is the background, which is the context Safari is
 *  least likely to refuse, and the relay would be a message to itself. Bounded, because it is
 *  asked on a timer — an app that never answers must not become a poll that never ticks. */
export async function readNativeSignedOutAt(): Promise<number | null> {
  try {
    const reply: any = await Promise.race([
      (browser.runtime as any).sendNativeMessage(NATIVE_APP_ID, { action: 'SIGNED_OUT_AT' }),
      new Promise(resolve => setTimeout(() => resolve(undefined), BOUNDED_DIRECT_ATTEMPT_MS)),
    ]);
    return typeof reply?.signedOutAt === 'number' && Number.isFinite(reply.signedOutAt)
      ? reply.signedOutAt
      : null;
  } catch {
    return null;
  }
}

/** The session stored in this browser profile, or null. */
async function storedSession(storageKey: string): Promise<any | null> {
  try {
    const raw = await browser.storage.local.get(storageKey);
    const value = raw?.[storageKey];
    if (typeof value !== 'string') return null;
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** A GoTrue `/token` body, assembled from the shared record.
 *
 *  The user object is carried over from the session this replaces rather than invented:
 *  the server's own refresh response includes it, and a locally-made one that omitted it
 *  would replace a real identity with null everywhere the popup reads `session.user`. */
function sessionBody(session: NativeSession, previous: any): Record<string, unknown> {
  const user: Record<string, unknown> =
    previous?.user && typeof previous.user === 'object' ? { ...previous.user } : {};
  if (session.userId) user.id = session.userId;

  return {
    access_token: session.accessToken,
    token_type: 'bearer',
    // Both spellings, as GoTrue sends them. `expires_in` is the fallback for a client that
    // computes its own expiry; `expires_at` is what this one actually reads.
    expires_in: Math.max(1, Math.round(session.expiresAt - Date.now() / 1000)),
    expires_at: Math.floor(session.expiresAt),
    refresh_token: session.refreshToken,
    user,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A `fetch` that answers the refresh endpoint from the shared record.
 *
 *  Everything else — the RPCs, Realtime, the sign-in exchange — passes straight through.
 *  Only `/auth/v1/token?grant_type=refresh_token` is intercepted, because that is the one
 *  request that would rotate the token the app also holds. */
export function createNativeFetch(authStorageKey: string): typeof fetch {
  return async (input: any, init?: any): Promise<Response> => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input));
    const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
    if (method !== 'POST' || !url.includes('/auth/v1/token') || !url.includes('grant_type=refresh_token')) {
      return fetch(input, init);
    }

    const renewal = await renewNativeSession();

    if (renewal.kind === 'session') {
      // A record from before refresh tokens were shared: nothing to renew with, so fall back
      // to the request this wrapper was here to prevent. Rare and self-correcting — the
      // response it gets is published back through the storage adapter.
      if (!renewal.session.refreshToken) return fetch(input, init);
      const previous = await storedSession(authStorageKey);
      return jsonResponse(200, sessionBody(renewal.session, previous));
    }

    if (renewal.kind === 'rejected') {
      // The exact shape GoTrue sends when a refresh token is gone: supabase-js reads a 400
      // here as "this session is dead" and clears the slot, which is correct — the server has
      // already said so, and keeping it would only fail the next request instead.
      return jsonResponse(400, {
        error: 'invalid_grant',
        error_description: 'Invalid Refresh Token: Refresh Token Not Found',
      });
    }

    // Not a 4xx. supabase-js treats every 5xx from this endpoint as retryable and keeps the
    // session it has; a 4xx would sign the user out because the app was briefly unreachable.
    return jsonResponse(503, {
      error: 'server_error',
      error_description: 'The session could not be renewed right now.',
    });
  };
}

/** When this profile signed itself out, in epoch milliseconds.
 *
 *  The app's copy of the session is cleared by the same sign-out, but that travels over
 *  native messaging while the empty slot is what the popup and the background react to
 *  first — and emptying it is exactly what makes adoption look necessary. Without this
 *  marker a sign-out re-adopts the very session it just ended, and the user is signed back
 *  in on the next popup open. Local, so it is durable by the time the slot empties. */
export const NATIVE_SIGNOUT_KEY = 'mf_native_signout_at';

/** Supabase's access-token lifetime, which is how far past a sign-out a session minted
 *  before it can still be valid. A session minted after the sign-out expires later than
 *  this bound, which is what tells adoption the two apart. */
const ACCESS_TOKEN_LIFETIME_S = 3600;

/** Takes the shared record when this profile has nothing usable of its own.
 *
 *  The case that matters: someone signs in through the app and never opens the popup, so
 *  extension storage is empty while the device is signed in. Without this the extension would
 *  draw its signed-out screen for a signed-in user. A profile that already holds a live
 *  session is left alone — its refresh will bring it up to date through `nativeFetch` anyway.
 *
 *  Returns whether anything was written. */
export async function adoptNativeSession(authStorageKey: string): Promise<boolean> {
  const stored = await storedSession(authStorageKey);
  const live = typeof stored?.expires_at === 'number' && stored.expires_at > Date.now() / 1000 + 60;
  if (live) return false;

  // A session this profile ended must never be handed back by the app, however the app's
  // record came to still be there.
  const signedOutAt = (await browser.storage.local.get(NATIVE_SIGNOUT_KEY))[NATIVE_SIGNOUT_KEY];

  const session = await readNativeSession();
  // A refresh token is what makes a session renewable; without one this is not a session the
  // extension can hold, and supabase-js would reject the record as invalid.
  if (!session?.refreshToken) return false;
  if (typeof signedOutAt === 'number' && session.expiresAt <= signedOutAt / 1000 + ACCESS_TOKEN_LIFETIME_S) {
    return false;
  }

  await browser.storage.local.set({
    [authStorageKey]: JSON.stringify(sessionBody(session, stored)),
  });
  return true;
}

/** Publishes this profile's session to the app.
 *
 *  Called after supabase-js writes a session — a sign-in, or a refresh started before this
 *  module existed — so the app can use it without the popup ever having been opened. Last
 *  write wins on expiry on the Swift side, so publishing an older generation is harmless. */
export async function publishNativeSession(authStorageKey: string): Promise<void> {
  const stored = await storedSession(authStorageKey);
  if (!stored?.access_token || !stored?.refresh_token || typeof stored.expires_at !== 'number') return;

  // The same rule as adoption, from the other direction: a refresh that lands just after a
  // sign-out can still write the old session back into this profile's slot, and publishing
  // it would hand the app a session the user has already ended. A session the user started
  // after signing out is minted later than this bound, so it still goes through.
  const signedOutAt = (await browser.storage.local.get(NATIVE_SIGNOUT_KEY))[NATIVE_SIGNOUT_KEY];
  if (typeof signedOutAt === 'number' && stored.expires_at <= signedOutAt / 1000 + ACCESS_TOKEN_LIFETIME_S) return;

  const payload = {
    accessToken: stored.access_token,
    refreshToken: stored.refresh_token,
    expiresAt: stored.expires_at,
    userId: typeof stored.user?.id === 'string' ? stored.user.id : undefined,
  };
  await native({ action: 'PUBLISH_SESSION', ...payload }, { type: 'MF_NATIVE_PUBLISH_SESSION', ...payload });
}

/** When the app ended the session this profile is holding, in epoch milliseconds — or null if
 *  it has not.
 *
 *  The mirror image of the sign-out guard in `adoptNativeSession` and `publishNativeSession`:
 *  there this profile refuses a record older than its own sign-out, here it ends a session older
 *  than the app's. A session started since then — the user signing back in — is minted later
 *  than the sign-out, which is what tells the two apart.
 *
 *  The answer is the app's own sign-out instant rather than the moment this noticed it, because
 *  it is also the stamp the caller leaves for `adoptNativeSession`: that one refuses a record
 *  minted at or before it, so stamping "now" would refuse the session the app minted a minute
 *  before — the popup would draw its signed-out screen for a user who is signed in, until the
 *  next rotation an hour away.
 *
 *  Null on anything it cannot establish: no session here, no stamp from the app, a record with
 *  no expiry, or an app that did not answer. Signing someone out on a guess is the failure this
 *  whole shared session exists to prevent, and the caller asks again a few seconds later. */
export async function appEndedSessionAt(authStorageKey: string): Promise<number | null> {
  // Read locally first, so a signed-out profile never wakes the app to ask.
  const stored = await storedSession(authStorageKey);
  if (typeof stored?.access_token !== 'string' || !stored.access_token) return null;
  if (typeof stored.expires_at !== 'number' || !Number.isFinite(stored.expires_at)) return null;

  const savedAt = await readNativeSignedOutAt();
  if (savedAt === null) return null;

  return stored.expires_at - ACCESS_TOKEN_LIFETIME_S <= savedAt ? savedAt : null;
}

/** Records that the popup has been opened at least once. The app uses it to decide whether
 *  the extension can be assumed enabled, so it is never cleared. */
export async function markPopupOpened(): Promise<void> {
  await native({ action: 'POPUP_OPENED' }, { type: 'MF_NATIVE_POPUP_OPENED' });
}

/** Records that a fact-check on a page selection actually began. The app uses it to decide
 *  whether the second guide overlay is still owed, so it is never cleared. */
export async function markSelectionFactCheck(): Promise<void> {
  await native({ action: 'MARK_SELECTION_FACTCHECK' }, { type: 'MF_NATIVE_MARK_SELECTION_FACTCHECK' });
}

/** The provider the device's last successful sign-in used, stamped in epoch milliseconds.
 *
 *  The app keeps its own copy and the popup keeps one in extension storage, and neither can read
 *  the other's; the stamp is what lets them agree, so whichever signed in last is the one both
 *  badge. */
export async function readLastProvider(): Promise<{ provider: string; at: number } | null> {
  const reply = await native({ action: 'GET_LAST_PROVIDER' }, { type: 'MF_NATIVE_GET_LAST_PROVIDER' });
  if (typeof reply?.provider !== 'string' || !reply.provider) return null;
  if (typeof reply?.at !== 'number' || !Number.isFinite(reply.at)) return null;
  return { provider: reply.provider, at: reply.at };
}

/** Reports a sign-in the extension completed, so the app badges the same provider. Best-effort,
 *  like everything else about the badge: an unreachable app costs the badge, never the session. */
export async function publishLastProvider(provider: string): Promise<void> {
  const at = Date.now();
  await native({ action: 'LAST_PROVIDER', provider, at }, { type: 'MF_NATIVE_LAST_PROVIDER', provider, at });
}

/** The iOS major version this extension is running on, asked of its own native handler, or
 *  null where none answers.
 *
 *  The browser cannot be asked: Safari froze its user agent, so the string still reports the
 *  version a phone shipped with and an iPhone on 27 reads exactly as one on 26 does. The
 *  guide's extensions mark is drawn one way from 27 on and another before it, and it has to be
 *  the same drawing the app's own instructions use — so the version comes from the same
 *  process the app asks, not from the page. */
export async function readNativeOsMajor(): Promise<number | null> {
  // The relay alone rather than `native()`'s direct-then-relay: this is asked only on iOS,
  // where the direct transport is accepted and never calls back, so the direct attempt would
  // be a second and a half of the guide drawing no mark at all before the same reply arrived.
  try {
    const reply: any = await browser.runtime.sendMessage({ type: 'MF_NATIVE_OS_VERSION' });
    const major = reply?.major;
    return typeof major === 'number' && Number.isInteger(major) && major > 0 ? major : null;
  } catch {
    return null;
  }
}

/** Asks the app to run a sign-in. The popup cannot: it has no window for the provider's
 *  sheet, and opening the provider in a tab strands the flow in Safari. */
export async function requestNativeSignIn(provider: 'google' | 'apple'): Promise<boolean> {
  const reply = await native(
    { action: 'OPEN_SIGN_IN', provider },
    { type: 'MF_NATIVE_OPEN_SIGN_IN', provider },
  );
  return reply?.opened === true;
}
