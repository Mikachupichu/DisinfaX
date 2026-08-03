import React, { useState, useEffect } from 'react';
import { supabase } from './supabaseClient';
import { AuthChangeEvent, Session } from '@supabase/supabase-js';
import Dashboard from './Dashboard';
import { useT, getUiLocale, isRtl } from './i18n';

export default function App() {
  const t = useT();
  const locale = getUiLocale();
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [authError, setAuthError] = useState<string | null>(null);

  const [lastUsedProvider, setLastUsedProvider] = useState<string | null>(() => {
    return localStorage.getItem('disinfax_last_oauth_provider');
  });

  useEffect(() => {
    const checkSession = async () => {
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

  const handleOAuthLogin = async (provider: 'x' | 'google' | 'apple') => {
    setLoading(true);
    setAuthError(null);
    try {
      const extensionRedirectUrl = chrome.identity.getRedirectURL();
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo: extensionRedirectUrl,
          skipBrowserRedirect: true,
          scopes: provider === 'x' ? 'users.read' : (provider === 'google' ? 'openid' : (provider === 'apple' ? '' : undefined)),
        },
      });

      if (error) throw error;
      if (!data?.url) throw new Error('Could not produce OAuth handshake URL.');

      const authUrlResponse = await chrome.identity.launchWebAuthFlow({
        url: data.url,
        interactive: true,
      });

      if (!authUrlResponse) {
        throw new Error('Authentication flow was cancelled or failed.');
      }

      const urlObj = new URL(authUrlResponse);

      // 1. Check if the URL returned an explicit error from the provider
      const errorDescription = 
        urlObj.searchParams.get('error_description') || 
        new URLSearchParams(urlObj.hash.substring(1)).get('error_description');
        
      if (errorDescription) {
        throw new Error(`Provider Error: ${errorDescription}`);
      }

      // 2. Try Pathway A: PKCE Authorization Code Flow
      const code = urlObj.searchParams.get('code');
      
      if (code) {
        const { data: sessionData, error: sessionError } = 
          await supabase.auth.exchangeCodeForSession(code);
        if (sessionError) throw sessionError;
        
        // SUCCESS! Safe to commit and update state
        localStorage.setItem('disinfax_last_oauth_provider', provider);
        setLastUsedProvider(provider);
        
        setUser(sessionData.user);
        return; 
      }

      // 3. Try Pathway B: Implicit Grant Flow Fallback (Tokens in the Hash)
      const hashParams = new URLSearchParams(urlObj.hash.substring(1));
      const accessToken = hashParams.get('access_token');
      const refreshToken = hashParams.get('refresh_token');

      if (accessToken && refreshToken) {
        const { data: sessionData, error: sessionError } = 
          await supabase.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken,
          });
        if (sessionError) throw sessionError;
        localStorage.setItem('disinfax_last_oauth_provider', provider);
        setLastUsedProvider(provider);
        setUser(sessionData.user);
        return; // Exit successfully
      }

      // If neither pathway resolved, throw a clean fallback error
      throw new Error('Authentication succeeded, but no usable tokens or codes were found in the callback URL.');

    } catch (err: any) {
      console.error('OAuth Workflow Failed:', err);
      setAuthError(err.message || 'Authentication encountered an error.');
    } finally {
      setLoading(false);
    }
  };

  const handleSignOut = async () => {
    setLoading(true);
    await supabase.auth.signOut();
    setUser(null);
    setLoading(false);
  };

  if (loading) {
    return (
      <div className="w-[360px] h-[360px] flex items-center justify-center bg-zinc-950 text-zinc-200">
        <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-zinc-400"></div>
      </div>
    );
  }

  return (
    /* Reduced container min-height and added explicit padding to eliminate top/bottom gaps */
    <div dir={isRtl(locale) ? 'rtl' : 'ltr'} className="w-[360px] min-h-[360px] p-5 bg-zinc-950 text-zinc-100 flex flex-col justify-between font-sans selection:bg-zinc-800">

      {!user ? (
        <div className="flex flex-col flex-1 justify-center space-y-5 my-auto">
          <div className="text-center space-y-1">
            <div className="flex items-end justify-center gap-2">
              <svg className="w-8 h-8 flex-shrink-0 self-start" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="0.5" y="0.5" width="127" height="127" stroke="white"/>
                <path d="M50 80L75 104M50 104C59.7631 94.6274 65.2369 89.3726 75 80" stroke="white" stroke-width="8" stroke-linecap="square"/>
                <path d="M61.0703 38H55H49.0703V28.5C49.0703 24 49.0703 23 43.5703 20L46.5703 8H82.5703V17C75.4742 17.5988 61 17 61.5 23.5C66 24 61.5 23.5 66 24V28C66 28 66 28 61.0703 29C61.0703 33 61.0703 34 61.0703 38Z" fill="white"/>
                <path fill-rule="evenodd" clip-rule="evenodd" d="M39.0703 79.2793L39 120.5H79.8507C86.2804 120.5 98.0534 86.6027 76 64C69.901 57.5392 68.4742 53.9878 65.5703 45.3363L65.5744 38H61.0703H55H49.0703H45V45.5C38.4138 59.2877 39.6134 67.1243 39.0703 79.2793ZM53.5366 75.9306C93.5366 81.9306 80.5884 110.663 53.5884 109.163C51.5884 109.163 49.5884 108.663 49.5884 106.663L49.5366 79.4306C49.6146 77.438 50.5884 75.6626 53.5366 75.9306Z" fill="white"/>
                <path d="M45 45.5C38.4138 59.2877 39.6134 67.1243 39.0703 79.2793L39 120.5H79.8507C86.2804 120.5 98.0534 86.6027 76 64C69.901 57.5392 68.4742 53.9878 65.5703 45.3363L65.5744 38M45 45.5C45.0233 45.4511 44.9765 45.549 45 45.5ZM45 45.5V38H49.0703M65.5744 41V38H61.0703M49.0703 38V28.5C49.0703 24 49.0703 23 43.5703 20L46.5703 8H82.5703V17C75.4742 17.5988 61 17 61.5 23.5M49.0703 38H55H61.0703M61.5 23.5C61.0703 29 61.5 23.5 61.0703 29C61.0703 33 61.0703 34 61.0703 38M61.0703 29C66 28 66 28 66 28V24C61.5 23.5 66 24 61.5 23.5M53.5884 109.163C80.5884 110.663 93.5366 81.9306 53.5366 75.9306C50.5884 75.6626 49.6146 77.438 49.5366 79.4306L49.5884 106.663C49.5884 108.663 51.5884 109.163 53.5884 109.163Z" stroke="white" stroke-linecap="round"/>
                <path d="M45 44V43.5V43" stroke="white"/>
                <path d="M45 45V46" stroke="white"/>
                <path d="M91.5 7.5C91.5 9.5 88.4098 12.3719 86.4098 12.3719C88.4098 12.3719 91.4098 15.5 91.4098 17.3719C91.5 15.5 94.5 12.5 96.5 12.5C94.5 12.5 91.5 9.5 91.5 7.5Z" fill="white" stroke="white" stroke-linecap="round"/>
              </svg>
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
            {/* --- GOOGLE BUTTON --- */}
            <button
              onClick={() => handleOAuthLogin('google')}
              className="relative flex items-center justify-center gap-3 w-full bg-white text-black font-medium py-3 px-4 rounded-xl border border-zinc-200 hover:bg-zinc-50 transition-colors"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/>
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
              </svg>
              <span>{t('continueWithGoogle')}</span>
              {lastUsedProvider === 'google' && (
                <span className="absolute top-1 right-1 text-[8px] font-black tracking-wide uppercase bg-emerald-50 text-emerald-600 px-1.5 py-0.5 rounded-md border border-emerald-200 scale-90 origin-top-right">{t('lastUsed')}</span>
              )}
            </button>

            {/* --- APPLE BUTTON --- */}
            <button
              onClick={() => handleOAuthLogin('apple')}
              className="relative flex items-center justify-center gap-3 w-full bg-white text-black font-medium py-3 px-4 rounded-xl border border-zinc-200 hover:bg-zinc-50 transition-colors"
            >
              <svg className="w-5 h-5 fill-current" viewBox="0 0 24 24">
                <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M15.97 4.17c.66-.81 1.11-1.93.99-3.06-.96.04-2.13.64-2.82 1.45-.6.7-1.13 1.84-.99 2.94 1.07.08 2.16-.52 2.82-1.33z"/>
              </svg>
              <span>{t('continueWithApple')}</span>
              {lastUsedProvider === 'apple' && (
                <span className="absolute top-1 right-1 text-[8px] font-black tracking-wide uppercase bg-emerald-50 text-emerald-600 px-1.5 py-0.5 rounded-md border border-emerald-200 scale-90 origin-top-right">{t('lastUsed')}</span>
              )}
            </button>

            {/* --- X BUTTON --- */}
            <button
              onClick={() => handleOAuthLogin('x')}
              className="relative flex items-center justify-center gap-3 w-full bg-white text-black font-medium py-3 px-4 rounded-xl border border-zinc-200 hover:bg-zinc-50 transition-colors"
            >
              <svg className="w-5 h-5 fill-current" viewBox="0 0 24 24">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
              </svg>
              <span>{t('continueWithX')}</span>
              {lastUsedProvider === 'x' && (
                <span className="absolute top-1 right-1 text-[8px] font-black tracking-wide uppercase bg-emerald-50 text-emerald-600 px-1.5 py-0.5 rounded-md border border-emerald-200 scale-90 origin-top-right">{t('lastUsed')}</span>
              )}
            </button>

          </div>
        </div>
      ) : (
        <Dashboard user={user} onSignOut={handleSignOut} />
      )}

      {/* Footer layout compressed cleanly near bottom edge */}
      <div className="text-center space-y-0.5 mt-2 select-none">
        <div className="text-[10px] text-zinc-600">DisinfaX v1.0.0</div>
        {!user && <div className="text-[10px] text-zinc-700">{t('cleanupTagline')}</div>}
      </div>
    </div>
  );
}