// The Supabase client now lives in utils/supabase.ts so the background service
// worker can share the same authenticated session (needed for Realtime). This
// module is kept as a thin re-export so existing popup imports keep working.
export { supabase } from '../../utils/supabase';
