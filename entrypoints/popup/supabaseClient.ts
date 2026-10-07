// The Supabase client now lives in utils/supabase.ts so the background service
// worker can share the same authenticated session (needed for Realtime). This
// module is kept as a thin re-export so existing popup imports keep working.
export {
  supabase,
  OAUTH_PROVIDERS,
  SUPABASE_PROVIDER,
  OAUTH_SCOPES,
  asOAuthProvider,
} from '../../utils/supabase';
export type { OAuthProvider } from '../../utils/supabase';
