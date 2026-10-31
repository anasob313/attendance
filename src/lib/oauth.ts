// "Continue with Google" via Supabase Auth (OAuth, implicit flow).
// The session returns in the URL fragment of the app address and is picked up
// by supabase-js (detectSessionInUrl), the same way e-mail links are.
import { supabase } from './supabase';

const URL_ = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? '';
const KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ?? '';

/**
 * New accounts are created with Google only. E-mail + password sign-up stays in
 * the code but is hidden until an e-mail sender is configured (needs a domain).
 * Existing e-mail accounts keep signing in with e-mail + password.
 */
export const EMAIL_SIGNUP_ENABLED = import.meta.env.VITE_EMAIL_SIGNUP === 'true';

let cached: Promise<boolean> | null = null;

/** Whether the Google provider is switched on in Supabase (public settings endpoint). */
export function googleAvailable(): Promise<boolean> {
  if (!cached) {
    cached = fetch(`${URL_.replace(/\/$/, '')}/auth/v1/settings`, { headers: { apikey: KEY } })
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => Boolean(s?.external?.google))
      .catch(() => { cached = null; return false; });
  }
  return cached;
}

export function appUrl(path = ''): string {
  return `${location.origin}${import.meta.env.BASE_URL}${path}`;
}

export async function signInWithGoogle(): Promise<string | null> {
  if (!(await googleAvailable())) {
    return 'Google sign-in is not available yet. Please try again later.';
  }
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: appUrl(), queryParams: { prompt: 'select_account' } },
  });
  return error ? error.message : null;
}
