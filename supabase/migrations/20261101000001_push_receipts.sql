-- Push delivery evidence (2026-11-01).
--
-- Why: on 2026-11-01 a reminder was accepted by Apple's push service (HTTP 2xx)
-- but the owner saw nothing, and the server had no way to know whether the
-- iPhone displayed it. Also, every app start re-created the device row
-- (delete + insert), wiping last_success_at / failure_count.
--
-- 1. public.push_deliveries: one row per push sent to one device, with the
--    push service's answer and a receipt from the device's service worker
--    (displayed_at / display_error).
-- 2. register_push_subscription: update the existing row for an endpoint
--    instead of deleting and re-inserting it, so delivery history survives
--    app restarts. Ownership still moves to the account signed in on the device.
--
-- No existing rows are deleted or changed by this migration.

create table public.push_deliveries (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  session_id     uuid references public.attendance_sessions (id) on delete set null,
  kind           text not null check (kind in ('reminder', 'test')),
  endpoint_host  text not null default '' check (char_length(endpoint_host) <= 200),
  endpoint_hash  text not null check (endpoint_hash ~ '^[0-9a-f]{64}$'),  -- sha256 of the endpoint
  sent_at        timestamptz not null default now(),
  push_status    integer,              -- push service HTTP status (201 = accepted)
  push_error     text check (char_length(push_error) <= 500),
  displayed_at   timestamptz,          -- receipt from the device after showNotification()
  display_error  text check (char_length(display_error) <= 500)
);
create index push_deliveries_user_idx    on public.push_deliveries (user_id, sent_at desc);
create index push_deliveries_session_idx on public.push_deliveries (session_id);

alter table public.push_deliveries enable row level security;
create policy "own push deliveries: read" on public.push_deliveries
  for select to authenticated using (user_id = (select auth.uid()));

revoke all on public.push_deliveries from public, anon, authenticated, service_role;
grant select on public.push_deliveries to authenticated;
grant select, insert, update on public.push_deliveries to service_role;

-- Keep the device row (and its delivery history) when the app re-registers.
create or replace function public.register_push_subscription(
  p_endpoint text, p_p256dh text, p_auth text, p_label text default '')
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := private.require_uid();
  sub_id uuid;
begin
  if p_endpoint is null or p_endpoint !~ '^https://' or char_length(p_endpoint) > 2000
     or coalesce(p_p256dh, '') = '' or coalesce(p_auth, '') = ''
     or char_length(p_p256dh) > 200 or char_length(p_auth) > 100 then
    raise exception using errcode = 'AT400', message = 'Invalid push subscription.';
  end if;
  -- An endpoint belongs to one browser install. If another account used this
  -- device before, the device now belongs to this account (its history resets).
  insert into public.push_subscriptions as ps (user_id, endpoint, p256dh, auth, device_label)
  values (uid, p_endpoint, p_p256dh, p_auth, left(coalesce(p_label, ''), 120))
  on conflict (endpoint) do update
     set p256dh          = excluded.p256dh,
         auth            = excluded.auth,
         device_label    = excluded.device_label,
         created_at      = case when ps.user_id = excluded.user_id then ps.created_at else now() end,
         last_success_at = case when ps.user_id = excluded.user_id then ps.last_success_at end,
         failure_count   = case when ps.user_id = excluded.user_id then ps.failure_count else 0 end,
         user_id         = excluded.user_id
  returning ps.id into sub_id;
  return sub_id;
end;
$$;
revoke all on function public.register_push_subscription(text, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.register_push_subscription(text, text, text, text) to authenticated;

notify pgrst, 'reload schema';
