// deno test supabase/functions/auth-admin/lib.test.ts
import { strict as A } from 'node:assert';
import { APP_URL, cleanSecret, desiredAuthConfig, extractVerifyLink, maskEmail, parseFragment, redact, safeEqual, summarizeConfig } from './lib.ts';

Deno.test('desired config keeps email verification on and points links at the live app', () => {
  const c = desiredAuthConfig('sender@gmail.com', 'abcd efgh ijkl mnop');
  A.equal(c.mailer_autoconfirm, false);
  A.equal(c.external_email_enabled, true);
  A.equal(c.site_url, APP_URL);
  A.equal(c.uri_allow_list, `${APP_URL},${APP_URL}**`);
  A.equal(c.smtp_admin_email, 'sender@gmail.com');
  for (const k of ['mailer_templates_confirmation_content', 'mailer_templates_recovery_content', 'mailer_templates_email_change_content'] as const) {
    A.ok(c[k].includes('{{ .ConfirmationURL }}'), k);
  }
});

Deno.test('audit view never contains the SMTP password', () => {
  const s = summarizeConfig({ smtp_pass: 'super-secret-pass', smtp_user: 'sender@gmail.com', site_url: APP_URL });
  A.equal(JSON.stringify(s).includes('super-secret-pass'), false);
  A.equal(s.smtp_pass_set, true);
  A.equal(s.smtp_user, 'se***@gmail.com');
  A.equal(maskEmail(null), null);
});

Deno.test('redact removes secret fields and secret values anywhere', () => {
  const r = redact({ smtp_pass: 'x', nested: { msg: 'token sbp_123456789 leaked' } }, ['sbp_123456789']) as Record<string, unknown>;
  A.equal(r.smtp_pass, '[set]');
  A.equal(JSON.stringify(r).includes('sbp_123456789'), false);
});

Deno.test('extracts the verify link from an HTML email', () => {
  const html = '<a href="https://jhofnqvnjbxobjisfukx.supabase.co/auth/v1/verify?token=abc&amp;type=signup&amp;redirect_to=https://anasob313.github.io/attendance/">Confirm</a>';
  A.equal(extractVerifyLink(html), 'https://jhofnqvnjbxobjisfukx.supabase.co/auth/v1/verify?token=abc&type=signup&redirect_to=https://anasob313.github.io/attendance/');
  A.equal(extractVerifyLink('no link here'), null);
});

Deno.test('parses the session fragment of a redirect', () => {
  const f = parseFragment(`${APP_URL}reset-password#access_token=t&expires_in=3600&type=recovery`);
  A.equal(f.type, 'recovery');
  A.equal(f.access_token, 't');
  A.deepEqual(parseFragment(APP_URL), {});
});

Deno.test('secret helpers', () => {
  A.equal(cleanSecret(' "SMTP_USER=a@b.co" ', 'SMTP_USER'), 'a@b.co');
  A.equal(cleanSecret('\u201cabcd efgh\u201d', 'SMTP_PASSWORD'), 'abcd efgh');
  A.ok(safeEqual('abc', 'abc'));
  A.ok(!safeEqual('abc', 'abd'));
  A.ok(!safeEqual('', ''));
});
