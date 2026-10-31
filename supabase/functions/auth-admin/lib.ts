// Pure helpers for the temporary auth-admin test runner (unit-tested in lib.test.ts).
// The Auth configuration itself lives in supabase/setup/auth_email.sql.

export const APP_URL = 'https://anasob313.github.io/attendance/';

/** Fields that must never leave the function. */
const SECRET_FIELDS = new Set(['smtp_pass', 'sms_twilio_auth_token', 'sms_messagebird_access_key', 'sms_vonage_api_secret',
  'sms_textlocal_api_key', 'sms_twilio_verify_auth_token', 'hook_send_email_secrets', 'hook_send_sms_secrets',
  'hook_custom_access_token_secrets', 'hook_mfa_verification_attempt_secrets', 'hook_password_verification_attempt_secrets',
  'saml_private_key', 'security_captcha_secret']);

export function maskEmail(e: string | null | undefined): string | null {
  if (!e) return e ?? null;
  const [u, d] = e.split('@');
  if (!d) return '***';
  return `${u.slice(0, 2)}***@${d}`;
}

/** Remove any secret value that might be echoed back by an API. */
export function redact(value: unknown, secrets: string[]): unknown {
  const s = JSON.stringify(value, (k, v) => (SECRET_FIELDS.has(k) ? (v ? '[set]' : v) : v));
  let out = s ?? 'null';
  for (const sec of secrets) if (sec && sec.length >= 6) out = out.split(sec).join('[redacted]');
  return JSON.parse(out);
}

/** Find the Supabase verification link inside an email body. */
export function extractVerifyLink(body: string): string | null {
  const decoded = body.replace(/&amp;/g, '&');
  const m = decoded.match(/https:\/\/[a-z0-9]+\.supabase\.co\/auth\/v1\/verify\?[^"'\s<>)]+/i);
  return m ? m[0] : null;
}

/** Parse the fragment of a redirect Location (#access_token=…&type=…). */
export function parseFragment(location: string): Record<string, string> {
  const i = location.indexOf('#');
  if (i < 0) return {};
  return Object.fromEntries(new URLSearchParams(location.slice(i + 1)));
}

/** Repair common copy/paste damage (spaces, quotes, "NAME=" prefix). */
export function cleanSecret(raw: string | undefined, name: string): string {
  let v = (raw ?? '').normalize('NFKC').trim();
  v = v.replace(/^["'`\u201c\u201d\u2018\u2019]+|["'`\u201c\u201d\u2018\u2019]+$/g, '').trim();
  v = v.replace(new RegExp(`^${name}\\s*[:=]\\s*`, 'i'), '');
  return v.replace(/^["'`\u201c\u201d\u2018\u2019]+|["'`\u201c\u201d\u2018\u2019]+$/g, '').trim();
}

/** Constant-time comparison for the admin secret. */
export function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0 && a.length > 0;
}
