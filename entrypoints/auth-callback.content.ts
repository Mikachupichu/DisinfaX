/** OAuth callback harvester — iOS/iPadOS sign-in only.
 *
 *  macOS drives OAuth through the containing app's ASWebAuthenticationSession, which
 *  returns the callback URL directly over native messaging. iOS cannot: an app extension
 *  has no UIApplication.shared and no UIScene, so it has no window to present that sheet
 *  from, and the session simply never appears. See AuthManager.swift.
 *
 *  So on iOS the popup opens the provider's URL in an ordinary Safari tab instead, and
 *  this script — which runs on the redirect target — hands whatever the provider returned
 *  back to the background, where the Supabase client can complete the exchange.
 *
 *  Matches the whole site rather than a dedicated callback route because the redirect
 *  lands on the site ROOT — a content script cannot be injected into Safari's
 *  network-error page, so the target has to be a URL that actually loads, and
 *  /auth-callback 404s. The handler below no-ops unless the URL actually carries OAuth
 *  parameters, so ordinary disinfax.app visits are unaffected.
 *
 *  Safari-only: Chromium and Firefox use browser.identity and never take this path.
 */
export default defineContentScript({
  matches: ['*://*.disinfax.app/*'],
  include: ['safari'],
  runAt: 'document_start',
  main() {
    try {
      const url = new URL(location.href);
      // PKCE puts `?code=` in the query; the implicit grant puts tokens in the fragment.
      // Which one arrives depends on the Supabase client's flowType, so read both.
      const hashParams = new URLSearchParams(url.hash.replace(/^#/, ''));

      const errorDescription =
        url.searchParams.get('error_description') ?? hashParams.get('error_description');
      const code = url.searchParams.get('code');
      const accessToken = hashParams.get('access_token');
      const refreshToken = hashParams.get('refresh_token');

      if (!errorDescription && !code && !(accessToken && refreshToken)) return;

      // Fire-and-forget: the background owns the exchange and closes this tab. Nothing
      // here awaits a reply, because this page is about to be torn down either way.
      void browser.runtime
        .sendMessage({ type: 'MF_AUTH_CALLBACK', code, accessToken, refreshToken, errorDescription })
        ?.catch?.(() => { /* background asleep or already handled */ });
    } catch (e) {
      console.error('[auth-callback] failed to parse callback URL:', e);
    }
  },
});
