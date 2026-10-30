import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
// The public "anon" / "publishable" key. It is safe in the browser: every
// table is protected by Row Level Security. NEVER put the service_role /
// secret key in a VITE_ variable.
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isConfigured = Boolean(url && key);
export const VAPID_PUBLIC_KEY = (import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined) ?? '';
export const FUNCTIONS_URL = url ? `${url.replace(/\/$/, '')}/functions/v1` : '';

export const supabase = createClient(url ?? 'https://not-configured.invalid', key ?? 'not-configured', {
  auth: {
    persistSession: true,       // stay signed in across app restarts
    autoRefreshToken: true,
    detectSessionInUrl: true,   // e-mail confirmation & password-reset links
    storageKey: 'attendance-auth',
  },
});
