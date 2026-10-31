-- =====================================================================
-- Auth e-mail configuration (Gmail SMTP, Site URL, redirect URLs, templates)
--
-- Secure workflow — no credential ever passes through chat, Git, the app,
-- or an Edge Function:
--   1. The owner stores three values in Supabase Vault (dashboard):
--        attendance_mgmt_token  scoped personal access token — this project only,
--                               "Auth Config" + "Project Settings" read-write,
--                               shortest expiry; revoked right after use
--        attendance_smtp_user   Gmail address that sends the e-mails
--        attendance_smtp_pass   Gmail app password (16 letters)
--   2. This script reads them inside the database and makes ONE call to the
--      Supabase Management API. Only non-secret fields are returned.
--   3. Afterwards the Vault copies of the token and password are blanked
--      (see bottom) and the owner revokes the token.
-- =====================================================================

create extension if not exists http with schema extensions;
select extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '30000');

with v as (
  select
    max(btrim(decrypted_secret, E' \t\r\n"''')) filter (where name = 'attendance_mgmt_token') as tok,
    max(lower(regexp_replace(decrypted_secret, '[\s"'']', '', 'g'))) filter (where name = 'attendance_smtp_user') as usr,
    max(regexp_replace(decrypted_secret, '[\s"'']', '', 'g')) filter (where name = 'attendance_smtp_pass') as pwd
  from vault.decrypted_secrets
  where name in ('attendance_mgmt_token', 'attendance_smtp_user', 'attendance_smtp_pass')
),
body as (
  select v.tok, jsonb_build_object(
    'site_url', 'https://anasob313.github.io/attendance/',
    'uri_allow_list', 'https://anasob313.github.io/attendance/,https://anasob313.github.io/attendance/**',
    'external_email_enabled', true,
    'mailer_autoconfirm', false,                 -- email verification stays ON
    'mailer_secure_email_change_enabled', true,
    'password_min_length', 8,
    'smtp_host', 'smtp.gmail.com',
    'smtp_port', '587',
    'smtp_user', v.usr,
    'smtp_pass', v.pwd,
    'smtp_admin_email', v.usr,                   -- Gmail sends only "From" its own address
    'smtp_sender_name', 'Attendance',
    'smtp_max_frequency', 60,
    'rate_limit_email_sent', 30,
    'mailer_subjects_confirmation', 'Confirm your Attendance account',
    'mailer_subjects_recovery', 'Reset your Attendance password',
    'mailer_subjects_email_change', 'Confirm your new email address',
    'mailer_templates_confirmation_content', $tpl$<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#18181b">
<h2 style="margin:0 0 12px;font-size:20px">Confirm your email</h2>
<p style="margin:0 0 20px;font-size:15px;line-height:1.5">Tap the button below to confirm your email address and activate your Attendance account.</p>
<p style="margin:0 0 20px"><a href="{{ .ConfirmationURL }}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:12px;font-weight:600">Confirm email</a></p>
<p style="margin:0;font-size:13px;color:#71717a">If you did not create an account, you can ignore this email.</p>
</div>$tpl$,
    'mailer_templates_recovery_content', $tpl$<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#18181b">
<h2 style="margin:0 0 12px;font-size:20px">Reset your password</h2>
<p style="margin:0 0 20px;font-size:15px;line-height:1.5">Tap the button below to choose a new password for your Attendance account.</p>
<p style="margin:0 0 20px"><a href="{{ .ConfirmationURL }}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:12px;font-weight:600">Reset password</a></p>
<p style="margin:0;font-size:13px;color:#71717a">If you did not ask to reset your password, you can ignore this email. Your password will not change.</p>
</div>$tpl$,
    'mailer_templates_email_change_content', $tpl$<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#18181b">
<h2 style="margin:0 0 12px;font-size:20px">Confirm your new email</h2>
<p style="margin:0 0 20px;font-size:15px;line-height:1.5">Tap the button below to confirm {{ .NewEmail }} as the new email address for your Attendance account.</p>
<p style="margin:0 0 20px"><a href="{{ .ConfirmationURL }}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:12px;font-weight:600">Confirm new email</a></p>
<p style="margin:0;font-size:13px;color:#71717a">If you did not request this change, ignore this email.</p>
</div>$tpl$
  ) as payload, (v.tok is not null and v.usr like '%@%' and length(coalesce(v.pwd, '')) >= 16) as ready
  from v
),
r as (
  -- LATERAL call: the request is sent exactly once
  select h.status, h.content
  from body b
  cross join lateral extensions.http((
      'PATCH',
      'https://api.supabase.com/v1/projects/jhofnqvnjbxobjisfukx/config/auth',
      array[extensions.http_header('Authorization', 'Bearer ' || b.tok)],
      'application/json',
      b.payload::text
    )::extensions.http_request) as h
  where b.ready
)
-- Only non-secret fields are returned.
select r.status,
       case when r.status between 200 and 299 then null else left(r.content, 300) end as error,
       (r.content::jsonb ->> 'site_url')              as site_url,
       (r.content::jsonb ->> 'uri_allow_list')        as uri_allow_list,
       (r.content::jsonb ->> 'mailer_autoconfirm')    as mailer_autoconfirm,
       (r.content::jsonb ->> 'external_email_enabled') as email_enabled,
       (r.content::jsonb ->> 'smtp_host')             as smtp_host,
       (r.content::jsonb ->> 'smtp_port')             as smtp_port,
       (r.content::jsonb ->> 'smtp_sender_name')      as sender_name,
       ((r.content::jsonb ->> 'smtp_pass') is not null) as smtp_pass_set
  from r;

-- After a successful test: blank the Vault copies (UPDATE, so nothing is deleted)
-- select vault.update_secret(id, 'revoked') from vault.secrets
--  where name in ('attendance_mgmt_token', 'attendance_smtp_pass');
