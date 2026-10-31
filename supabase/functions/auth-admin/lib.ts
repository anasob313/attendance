// Pure helpers for the auth-admin function (unit-tested in lib.test.ts).

export const APP_URL = 'https://anasob313.github.io/attendance/';

/** The auth configuration this project should have. SMTP credentials are added at runtime. */
export function desiredAuthConfig(smtpUser: string, smtpPass: string) {
  return {
    site_url: APP_URL,
    uri_allow_list: [APP_URL, `${APP_URL}**`].join(','),
    external_email_enabled: true,
    mailer_autoconfirm: false,                 // email verification stays ON
    mailer_secure_email_change_enabled: true,  // confirm both old and new address
    password_min_length: 8,
    smtp_host: 'smtp.gmail.com',
    smtp_port: '587',
    smtp_user: smtpUser,
    smtp_pass: smtpPass,
    smtp_admin_email: smtpUser,                // Gmail only sends "From" the account itself
    smtp_sender_name: 'Attendance',
    smtp_max_frequency: 60,                    // ≥ 60 s between e-mails to the same address
    rate_limit_email_sent: 30,                 // per hour, project-wide (Gmail allows far more)
    mailer_subjects_confirmation: 'Confirm your Attendance account',
    mailer_subjects_recovery: 'Reset your Attendance password',
    mailer_subjects_email_change: 'Confirm your new email address',
    mailer_templates_confirmation_content: template(
      'Confirm your email',
      'Tap the button below to confirm your email address and activate your Attendance account.',
      '{{ .ConfirmationURL }}', 'Confirm email',
      'If you did not create an account, you can ignore this email.'),
    mailer_templates_recovery_content: template(
      'Reset your password',
      'Tap the button below to choose a new password for your Attendance account.',
      '{{ .ConfirmationURL }}', 'Reset password',
      'If you did not ask to reset your password, you can ignore this email. Your password will not change.'),
    mailer_templates_email_change_content: template(
      'Confirm your new email',
      'Tap the button below to confirm {{ .NewEmail }} as the new email address for your Attendance account.',
      '{{ .ConfirmationURL }}', 'Confirm new email',
      'If you did not request this change, ignore this email.'),
  };
}

function template(title: string, text: string, url: string, button: string, footer: string): string {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#18181b">
<h2 style="margin:0 0 12px;font-size:20px">${title}</h2>
<p style="margin:0 0 20px;font-size:15px;line-height:1.5">${text}</p>
<p style="margin:0 0 20px"><a href="${url}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:12px;font-weight:600">${button}</a></p>
<p style="margin:0;font-size:13px;color:#71717a">${footer}</p>
</div>`;
}

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

/** Non-secret view of the auth config, for auditing. */
export function summarizeConfig(c: Record<string, unknown>) {
  const pick = (k: string) => c[k];
  return {
    site_url: pick('site_url'),
    uri_allow_list: pick('uri_allow_list'),
    disable_signup: pick('disable_signup'),
    external_email_enabled: pick('external_email_enabled'),
    mailer_autoconfirm: pick('mailer_autoconfirm'),
    mailer_secure_email_change_enabled: pick('mailer_secure_email_change_enabled'),
    password_min_length: pick('password_min_length'),
    smtp_host: pick('smtp_host'),
    smtp_port: pick('smtp_port'),
    smtp_user: maskEmail(pick('smtp_user') as string),
    smtp_admin_email: maskEmail(pick('smtp_admin_email') as string),
    smtp_sender_name: pick('smtp_sender_name'),
    smtp_pass_set: Boolean(pick('smtp_pass')),
    smtp_max_frequency: pick('smtp_max_frequency'),
    rate_limit_email_sent: pick('rate_limit_email_sent'),
    mailer_otp_exp: pick('mailer_otp_exp'),
    jwt_exp: pick('jwt_exp'),
    mailer_subjects_confirmation: pick('mailer_subjects_confirmation'),
    mailer_subjects_recovery: pick('mailer_subjects_recovery'),
  };
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
