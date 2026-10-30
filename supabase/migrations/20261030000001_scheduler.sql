-- =====================================================================
-- Reminder scheduler (APPLIED to project jhofnqvnjbxobjisfukx on 2026-10-30)
-- Kept here as the record of what runs in production.
--
-- Vault secrets (values are NOT stored in this repository):
--   attendance_project_url  = https://<PROJECT_REF>.supabase.co
--   attendance_cron_secret  = same value as the function secret CRON_SECRET
-- =====================================================================
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- select vault.create_secret('https://<PROJECT_REF>.supabase.co', 'attendance_project_url');
-- select vault.create_secret('<CRON_SECRET>', 'attendance_cron_secret');

select cron.schedule('send-attendance-reminders', '* * * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'attendance_project_url')
           || '/functions/v1/send-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'attendance_cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000);
$$);
