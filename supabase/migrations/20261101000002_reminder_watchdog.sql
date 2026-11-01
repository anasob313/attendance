-- Reminder watchdog (2026-11-01).
--
-- A reminder that the push service accepted but the device never confirmed
-- (no receipt from the service worker within 2 minutes) is sent once more to
-- that device, while the 8 hours are not yet complete and the session is still
-- open. The resend uses the same notification tag, so the phone shows a single
-- notification even if the first one did arrive. Both attempts stay recorded in
-- public.push_deliveries; the app warns the user when neither was confirmed.
--
-- No existing rows are deleted or changed by this migration.

alter table public.push_deliveries
  add column retry_of   uuid references public.push_deliveries (id) on delete set null,
  add column retried_at timestamptz;

create index push_deliveries_unconfirmed_idx on public.push_deliveries (sent_at)
  where kind = 'reminder' and displayed_at is null and retried_at is null;

-- service_role only: claims unconfirmed reminder deliveries (each at most once).
create function public.claim_unconfirmed_reminders(p_wait_seconds integer default 120)
returns table (
  delivery_id uuid, user_id uuid, session_id uuid, endpoint_hash text,
  clock_in timestamptz, clock_out timestamptz, required_minutes integer,
  lead_minutes integer, timezone text)
language plpgsql set search_path = '' as $$
#variable_conflict use_column
begin
  return query
  with due as (
    select d.id from public.push_deliveries d
     where d.kind = 'reminder' and d.retry_of is null and d.retried_at is null
       and d.displayed_at is null and d.display_error is null
       and d.push_status between 200 and 299 and d.session_id is not null
       and d.sent_at < now() - make_interval(secs => greatest(coalesce(p_wait_seconds, 120), 30))
       and d.sent_at > now() - interval '30 minutes'
     order by d.sent_at
     limit 100
     for update skip locked
  ), claimed as (
    update public.push_deliveries d set retried_at = now()
      from due where d.id = due.id
    returning d.id, d.user_id, d.session_id, d.endpoint_hash
  )
  select c.id, c.user_id, c.session_id, c.endpoint_hash, s.clock_in, s.clock_out,
         s.required_minutes, coalesce(us.lead_minutes, 20), coalesce(us.timezone, 'Asia/Riyadh')
    from claimed c
    join public.attendance_sessions s on s.id = c.session_id
    left join public.user_settings us on us.user_id = c.user_id;
end;
$$;
revoke all on function public.claim_unconfirmed_reminders(integer) from public, anon, authenticated, service_role;
grant execute on function public.claim_unconfirmed_reminders(integer) to service_role;

notify pgrst, 'reload schema';
