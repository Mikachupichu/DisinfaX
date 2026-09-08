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
 *  Matches x.com rather than disinfax.app so the extension needs no host access to its
 *  own site: the redirect target's content is irrelevant (this tab exists only to be
 *  harvested and closed), and x.com is already granted on every build. The redirect
 *  carries a `disinfax_oauth=callback` marker (see AUTH_CALLBACK_URL in popup/App.tsx)
 *  and this handler no-ops unless it is present, so ordinary x.com visits — and any
 *  `?code=` X itself might ever use — are unaffected. relay.content.ts and
 *  capture.main.content.ts bail on the same marker so the logged-out X landing page's
 *  sample tweets are never captured into the pipeline on a tab about to be torn down.
 *
 *  Runs at document_start so the params are read before X's SPA boot can route away —
 *  notably when the user is logged out of X, where the 302 lands with `?code=` in the
 *  bar and the background exchanges and closes the tab before any /login push matters.
 *
 *  Safari-only: Chromium and Firefox use browser.identity and never take this path.
 */
export default defineContentScript({
  matches: ['*://x.com/*'],
  include: ['safari'],
  runAt: 'document_start',
  main() {
    try {
      const url = new URL(location.href);
      if (url.searchParams.get('disinfax_oauth') !== 'callback') return;
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
