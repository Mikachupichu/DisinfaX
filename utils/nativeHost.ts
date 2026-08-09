/** Safari native-messaging bridge (containing app ⇄ extension).
 *
 *  Only ever used from Safari builds — every call site sits inside an
 *  `import.meta.env.SAFARI` branch, so this whole module is tree-shaken out of the
 *  Chromium and Firefox bundles.
 *
 *  Two transports, tried in order, because the platforms disagree about which is
 *  allowed and the disagreement is not documented anywhere reliable:
 *
 *    1. Direct from the calling context. Verified working on macOS — this is what
 *       returned a real `{ url, callbackUrl }` from the host during bring-up.
 *    2. Relayed through the background script. Several write-ups claim Safari only
 *       services sendNativeMessage from the background; that contradicts (1) on macOS,
 *       but may still hold on iOS, where the direct call appears to never call back.
 *
 *  Trying (1) then (2) avoids having to know which platform wants which, and costs
 *  nothing on the path that already works.
 */
import { browser } from 'wxt/browser';

/** Bundle identifier of the CONTAINING APP — must match PRODUCT_BUNDLE_IDENTIFIER of the
 *  app target in DisinfaX.xcodeproj (the extension target is that plus ".Extension").
 *  Safari resolves the helper application from this; a stale value fails with
 *  "Couldn't communicate with a helper application" and nothing more specific. Defined
 *  once here so it cannot drift out of sync between the popup and the background again. */
export const NATIVE_APP_ID = 'app.disinfax';

/** Custom URL scheme the app registers so ASWebAuthenticationSession can catch the OAuth
 *  redirect. Must match the `redirectTo` the popup hands to Supabase. */
export const NATIVE_CALLBACK_SCHEME = 'disinfax';

/** A reply from the Swift host, or `{ error }` if neither transport could reach it. */
export async function callNativeHost(
  directPayload: Record<string, unknown>,
  relayMessage: Record<string, unknown>,
): Promise<any> {
  // 1. Direct.
  try {
    const res = await (browser.runtime as any).sendNativeMessage(NATIVE_APP_ID, directPayload);
    // A host that resolves with nothing is treated as unreachable so the relay still
    // gets a turn, rather than surfacing a confusing empty success to the user.
    if (res) return res;
    console.warn('[nativeHost] direct sendNativeMessage resolved empty; trying background relay');
  } catch (e: any) {
    console.warn('[nativeHost] direct sendNativeMessage failed; trying background relay:', e?.message ?? e);
  }

  // 2. Relayed through the background.
  try {
    const res = await browser.runtime.sendMessage(relayMessage);
    return res ?? { error: 'The DisinfaX app did not respond.' };
  } catch (e: any) {
    console.error('[nativeHost] background relay failed:', e?.message ?? e);
    return { error: e?.message || 'Could not reach the DisinfaX app.' };
  }
}
