-- =====================================================================
-- NOT YET APPLIED — needs the owner's approval (it contains DELETE).
-- Daily clean-up of scheduler run logs (> 3 days) and finished reminder
-- records (> 120 days). Never touches attendance, leave or remote data.
-- Without it, cron.job_run_details grows ~1,440 rows/day.
-- =====================================================================
create or replace function private.housekeeping() returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from cron.job_run_details where end_time < now() - interval '3 days';
  delete from public.reminders
   where status in ('sent', 'cancelled', 'skipped', 'failed')
     and updated_at < now() - interval '120 days';
end;
$$;
revoke all on function private.housekeeping() from public, anon, authenticated, service_role;
select cron.schedule('attendance-housekeeping', '17 3 * * *', 'select private.housekeeping()');
