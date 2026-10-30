-- =====================================================================
-- Personal Attendance Tracker — schema, security and business rules
-- Revision 2 (reviewed 2026-10-29)
--
-- Target : Supabase, PostgreSQL 15+ (new projects run PostgreSQL 17)
-- Run    : ONCE on a fresh project — SQL Editor → paste the whole file → Run
--          (or `supabase db push`). Runs in one transaction: if anything
--          fails, nothing is applied and you can fix and run it again.
--
-- Design notes
--  * Timestamps are timestamptz (UTC). A session's work_date is the local
--    calendar date of its Clock In in the user's configured timezone.
--  * One office session per user per day; at most one active session.
--  * Conflicting day classifications (office / remote / leave) are
--    rejected by triggers, so the rules also hold for direct table writes.
--    A per-user advisory lock serialises these checks, so two devices
--    writing at the same moment cannot create a conflict either.
--  * "Replace" flows run inside a single RPC call = one transaction.
--  * Reminder rows are reconciled by triggers on every change.
--  * Privileges are granted EXPLICITLY. Supabase no longer grants Data API
--    access to new tables automatically (new projects from 30 May 2026,
--    all projects from 30 Oct 2026), so this file does not rely on it.
--  * Internal helpers and trigger functions live in schema `private`,
--    which the Data API does not expose. Only the intended RPCs are in
--    `public`.
--  * Every function pins `search_path = ''` and schema-qualifies names.
-- =====================================================================

begin;

-- Refuse to run twice (the second run would fail half-way anyway).
do $guard$
begin
  if to_regclass('public.attendance_sessions') is not null then
    raise exception 'The attendance schema is already installed in this project. Nothing was changed.';
  end if;
end
$guard$;

create extension if not exists btree_gist with schema extensions;

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- Supabase already grants this; only fill it in if it is missing.
do $usage$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if not has_schema_privilege(r, 'public', 'usage') then
      execute format('grant usage on schema public to %I', r);
    end if;
  end loop;
end
$usage$;

-- ---------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------
create type public.leave_type as enum ('annual', 'sick', 'public_holiday');
create type public.reminder_status as enum
  ('scheduled', 'sending', 'sent', 'cancelled', 'skipped', 'failed');

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text not null default '' check (char_length(full_name) <= 120),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.user_settings (
  user_id       uuid primary key references auth.users (id) on delete cascade,
  work_minutes  integer  not null default 480 check (work_minutes between 60 and 1440),
  lead_minutes  integer  not null default 20  check (lead_minutes between 0 and 240),
  working_days  smallint[] not null default '{0,1,2,3,4}',   -- 0=Sun … 6=Sat
  timezone      text     not null default 'Asia/Riyadh',
  updated_at    timestamptz not null default now(),
  constraint lead_lt_work check (lead_minutes < work_minutes),
  constraint working_days_valid check (
    working_days <@ '{0,1,2,3,4,5,6}'::smallint[] and cardinality(working_days) between 1 and 7)
);

create table public.attendance_sessions (
  id                uuid primary key default gen_random_uuid(),   -- client may supply (idempotency)
  user_id           uuid not null default auth.uid() references auth.users (id) on delete cascade,
  work_date         date not null,              -- local date of clock_in (set by trigger)
  clock_in          timestamptz not null,
  clock_out         timestamptz,                -- null = active / pending
  required_minutes  integer not null,           -- snapshot of the target at creation
  timezone          text not null,              -- timezone used to derive work_date
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint out_after_in check (clock_out is null or clock_out > clock_in),
  constraint max_24h check (clock_out is null or clock_out - clock_in <= interval '24 hours'),
  constraint required_minutes_valid check (required_minutes between 1 and 1440),
  constraint one_session_per_day unique (user_id, work_date),
  constraint no_overlapping_sessions exclude using gist (
    user_id with =,
    tstzrange(clock_in, coalesce(clock_out, 'infinity'::timestamptz), '[)') with &&)
);
create unique index one_active_session_per_user
  on public.attendance_sessions (user_id) where clock_out is null;

create table public.remote_days (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  work_date   date not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint one_remote_per_day unique (user_id, work_date)
);

create table public.leaves (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  leave_type  public.leave_type not null,
  start_date  date not null,
  end_date    date not null,
  note        text not null default '' check (char_length(note) <= 200),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint leave_range_valid check (end_date >= start_date and end_date - start_date <= 366),
  constraint no_overlapping_leaves exclude using gist (
    user_id with =, daterange(start_date, end_date, '[]') with &&)
);

create table public.push_subscriptions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users (id) on delete cascade,
  endpoint         text not null unique,
  p256dh           text not null,
  auth             text not null,
  device_label     text not null default '' check (char_length(device_label) <= 120),
  created_at       timestamptz not null default now(),
  last_success_at  timestamptz,
  failure_count    integer not null default 0
);

create table public.reminders (
  session_id  uuid primary key references public.attendance_sessions (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  fire_at     timestamptz not null,
  status      public.reminder_status not null,
  attempts    integer not null default 0,
  sent_at     timestamptz,
  last_error  text,
  updated_at  timestamptz not null default now()
);

create index sessions_user_date_idx on public.attendance_sessions (user_id, work_date);
create index remote_user_date_idx   on public.remote_days (user_id, work_date);
create index leaves_user_idx        on public.leaves (user_id, start_date);
create index push_user_idx          on public.push_subscriptions (user_id);
create index reminders_due_idx      on public.reminders (fire_at) where status = 'scheduled';
create index reminders_user_idx     on public.reminders (user_id);

-- ---------------------------------------------------------------------
-- Row Level Security: every row is visible/changeable only by its owner
-- ---------------------------------------------------------------------
alter table public.profiles            enable row level security;
alter table public.user_settings       enable row level security;
alter table public.attendance_sessions enable row level security;
alter table public.remote_days         enable row level security;
alter table public.leaves              enable row level security;
alter table public.push_subscriptions  enable row level security;
alter table public.reminders           enable row level security;

create policy "own profile: read"   on public.profiles for select to authenticated using (id = (select auth.uid()));
create policy "own profile: update" on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy "own settings: read"   on public.user_settings for select to authenticated using (user_id = (select auth.uid()));
create policy "own settings: update" on public.user_settings for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy "own sessions" on public.attendance_sessions for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own remote" on public.remote_days for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own leaves" on public.leaves for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own push subs: read"   on public.push_subscriptions for select to authenticated using (user_id = (select auth.uid()));
create policy "own push subs: delete" on public.push_subscriptions for delete to authenticated using (user_id = (select auth.uid()));
create policy "own reminders: read" on public.reminders for select to authenticated using (user_id = (select auth.uid()));
-- No insert/update policy on reminders or push_subscriptions for users:
-- those rows are written only by security-definer functions below.

-- ---------------------------------------------------------------------
-- Table privileges (explicit; nothing for anon)
-- ---------------------------------------------------------------------
revoke all on public.profiles, public.user_settings, public.attendance_sessions, public.remote_days,
              public.leaves, public.push_subscriptions, public.reminders
  from public, anon, authenticated, service_role;

grant select, update                 on public.profiles            to authenticated;
grant select, update                 on public.user_settings       to authenticated;
grant select, insert, update, delete on public.attendance_sessions to authenticated;
grant select, insert, update, delete on public.remote_days         to authenticated;
grant select, insert, update, delete on public.leaves              to authenticated;
grant select, delete                 on public.push_subscriptions  to authenticated;
grant select                         on public.reminders           to authenticated;

-- Used by the send-reminders Edge Function (service_role bypasses RLS).
grant select, insert, update, delete on public.profiles, public.user_settings, public.attendance_sessions,
  public.remote_days, public.leaves, public.push_subscriptions, public.reminders
  to service_role;

-- ---------------------------------------------------------------------
-- Private helpers (not reachable through the Data API)
-- ---------------------------------------------------------------------
create function private.require_uid() returns uuid
language plpgsql stable set search_path = '' as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception using errcode = 'AT401', message = 'You are not signed in. Please sign in again.';
  end if;
  return uid;
end;
$$;

-- Serialises classification changes per user until the transaction ends.
create function private.lock_user(p_user uuid) returns void
language plpgsql volatile set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('attendance:' || p_user::text, 0));
end;
$$;

create function private.user_tz(p_user uuid) returns text
language sql stable set search_path = '' as $$
  select coalesce((select s.timezone from public.user_settings s where s.user_id = p_user), 'Asia/Riyadh');
$$;

create function private.local_date(p_user uuid, p_ts timestamptz) returns date
language sql stable set search_path = '' as $$
  select (p_ts at time zone private.user_tz(p_user))::date;
$$;

-- All classifications on [p_from, p_to] other than the row p_self.
create function private.find_conflicts(p_user uuid, p_from date, p_to date, p_self uuid)
returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(x.c order by x.c->>'date'), '[]'::jsonb) from (
    select jsonb_build_object('kind', 'office', 'id', s.id, 'date', s.work_date,
             'clock_in', s.clock_in, 'clock_out', s.clock_out) as c
      from public.attendance_sessions s
     where s.user_id = p_user and s.work_date between p_from and p_to
       and s.id is distinct from p_self
    union all
    select jsonb_build_object('kind', 'remote', 'id', r.id, 'date', r.work_date)
      from public.remote_days r
     where r.user_id = p_user and r.work_date between p_from and p_to
       and r.id is distinct from p_self
    union all
    select jsonb_build_object('kind', l.leave_type::text, 'id', l.id, 'date', l.start_date,
             'start_date', l.start_date, 'end_date', l.end_date)
      from public.leaves l
     where l.user_id = p_user and l.start_date <= p_to and l.end_date >= p_from
       and l.id is distinct from p_self
  ) x;
$$;

-- VOLATILE on purpose: after waiting for the lock, the conflict query
-- must see rows committed by the other transaction.
create function private.assert_no_conflict(p_user uuid, p_from date, p_to date, p_self uuid)
returns void language plpgsql volatile set search_path = '' as $$
declare
  c jsonb;
begin
  perform private.lock_user(p_user);
  c := private.find_conflicts(p_user, p_from, p_to, p_self);
  if jsonb_array_length(c) > 0 then
    raise exception using errcode = 'AT409', message = 'conflict', detail = c::text;
  end if;
end;
$$;

-- Remove every classification on [p_from, p_to] except p_keep.
-- Leaves that only partly overlap are trimmed/split, never lost entirely.
create function private.clear_range(p_user uuid, p_from date, p_to date, p_keep uuid)
returns void language plpgsql volatile set search_path = '' as $$
declare
  l public.leaves;
begin
  delete from public.attendance_sessions s
   where s.user_id = p_user and s.work_date between p_from and p_to and s.id is distinct from p_keep;
  delete from public.remote_days r
   where r.user_id = p_user and r.work_date between p_from and p_to and r.id is distinct from p_keep;
  for l in select * from public.leaves lv
            where lv.user_id = p_user and lv.start_date <= p_to and lv.end_date >= p_from
              and lv.id is distinct from p_keep
  loop
    delete from public.leaves lv where lv.id = l.id;
    if l.start_date < p_from then
      insert into public.leaves (user_id, leave_type, start_date, end_date, note)
      values (l.user_id, l.leave_type, l.start_date, p_from - 1, l.note);
    end if;
    if l.end_date > p_to then
      insert into public.leaves (user_id, leave_type, start_date, end_date, note)
      values (l.user_id, l.leave_type, p_to + 1, l.end_date, l.note);
    end if;
  end loop;
end;
$$;

create function private.validate_session_times(p_in timestamptz, p_out timestamptz)
returns void language plpgsql stable set search_path = '' as $$
begin
  if p_in is null then
    raise exception using errcode = 'AT400', message = 'Clock In time is required.';
  end if;
  if p_in < timestamptz '2000-01-01 00:00:00+00' then
    raise exception using errcode = 'AT400', message = 'Clock In time is not valid.';
  end if;
  if p_in > now() + interval '5 minutes' then
    raise exception using errcode = 'AT400', message = 'Clock In cannot be in the future.';
  end if;
  if p_out is not null then
    if p_out > now() + interval '5 minutes' then
      raise exception using errcode = 'AT400', message = 'Clock Out cannot be in the future.';
    end if;
    if p_out <= p_in then
      raise exception using errcode = 'AT400', message = 'Clock Out must be after Clock In.';
    end if;
    if p_out - p_in > interval '24 hours' then
      raise exception using errcode = 'AT400', message = 'A session cannot be longer than 24 hours.';
    end if;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- New user bootstrap (profile + default settings)
-- ---------------------------------------------------------------------
create function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, left(coalesce(new.raw_user_meta_data->>'full_name', ''), 120))
  on conflict (id) do nothing;
  insert into public.user_settings (user_id) values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

create trigger attendance_on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();

-- Users who signed up before this migration ran also get a profile and settings.
insert into public.profiles (id, full_name)
select u.id, left(coalesce(u.raw_user_meta_data->>'full_name', ''), 120) from auth.users u
on conflict (id) do nothing;
insert into public.user_settings (user_id)
select u.id from auth.users u
on conflict (user_id) do nothing;

-- ---------------------------------------------------------------------
-- Validation triggers
-- ---------------------------------------------------------------------
create function private.sessions_before() returns trigger
language plpgsql set search_path = '' as $$
declare
  s public.user_settings;
  tz text;
begin
  if tg_op = 'UPDATE' then
    new.user_id := old.user_id;          -- ownership can never change
    new.created_at := old.created_at;
  end if;
  select * into s from public.user_settings us where us.user_id = new.user_id;
  tz := coalesce(s.timezone, 'Asia/Riyadh');

  perform private.validate_session_times(new.clock_in, new.clock_out);

  if tg_op = 'INSERT' or new.clock_in is distinct from old.clock_in then
    new.work_date := (new.clock_in at time zone tz)::date;
    new.timezone := tz;
  else
    new.work_date := old.work_date;
    new.timezone := old.timezone;
  end if;
  if tg_op = 'INSERT' and new.required_minutes is null then
    new.required_minutes := coalesce(s.work_minutes, 480);
  end if;

  perform private.assert_no_conflict(new.user_id, new.work_date, new.work_date, new.id);
  new.updated_at := now();
  return new;
end;
$$;

create trigger sessions_before before insert or update on public.attendance_sessions
  for each row execute function private.sessions_before();

create function private.remote_before() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    new.user_id := old.user_id;
    new.created_at := old.created_at;
  end if;
  if new.work_date < date '2000-01-01' or new.work_date > (now() + interval '400 days')::date then
    raise exception using errcode = 'AT400', message = 'Remote Work date is not valid.';
  end if;
  perform private.assert_no_conflict(new.user_id, new.work_date, new.work_date, new.id);
  new.updated_at := now();
  return new;
end;
$$;

create trigger remote_before before insert or update on public.remote_days
  for each row execute function private.remote_before();

create function private.leaves_before() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    new.user_id := old.user_id;
    new.created_at := old.created_at;
  end if;
  if new.start_date is null or new.end_date is null or new.end_date < new.start_date then
    raise exception using errcode = 'AT400', message = 'End date must be on or after start date.';
  end if;
  if new.end_date - new.start_date > 366 then
    raise exception using errcode = 'AT400', message = 'A leave record cannot be longer than one year.';
  end if;
  perform private.assert_no_conflict(new.user_id, new.start_date, new.end_date, new.id);
  new.updated_at := now();
  return new;
end;
$$;

create trigger leaves_before before insert or update on public.leaves
  for each row execute function private.leaves_before();

create function private.settings_before() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.user_id := old.user_id;
  begin
    perform now() at time zone new.timezone;
  exception when others then
    raise exception using errcode = 'AT400', message = 'Unknown timezone: ' || coalesce(new.timezone, '(empty)');
  end;
  new.working_days := (select array_agg(distinct d order by d) from unnest(new.working_days) as t(d));
  new.updated_at := now();
  return new;
end;
$$;

create trigger settings_before before update on public.user_settings
  for each row execute function private.settings_before();

create function private.profiles_before() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.id := old.id;
  new.created_at := old.created_at;
  new.full_name := btrim(coalesce(new.full_name, ''));
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_before before update on public.profiles
  for each row execute function private.profiles_before();

-- ---------------------------------------------------------------------
-- Reminder reconciliation (one reminder per session, never late)
-- ---------------------------------------------------------------------
create function private.reconcile_reminder(p_session uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  s public.attendance_sessions;
  lead_min integer;
  fire timestamptz;
  cur public.reminder_status;
begin
  select * into s from public.attendance_sessions a where a.id = p_session;
  if not found then
    return;                                   -- row deleted; FK cascade removes reminder
  end if;
  select r.status into cur from public.reminders r where r.session_id = s.id;

  if s.clock_out is not null then
    update public.reminders r set status = 'cancelled', updated_at = now()
     where r.session_id = s.id and r.status in ('scheduled', 'sending', 'failed');
    return;
  end if;

  if cur = 'sent' then
    return;                                   -- exactly one notification per session
  end if;

  select us.lead_minutes into lead_min from public.user_settings us where us.user_id = s.user_id;
  lead_min := coalesce(lead_min, 20);
  fire := s.clock_in + make_interval(mins => greatest(s.required_minutes - lead_min, 0));

  insert into public.reminders (session_id, user_id, fire_at, status, attempts, updated_at)
  values (s.id, s.user_id, fire,
          case when fire <= now() then 'skipped'::public.reminder_status
               else 'scheduled'::public.reminder_status end,
          0, now())
  on conflict (session_id) do update
    set fire_at = excluded.fire_at, status = excluded.status,
        attempts = 0, last_error = null, updated_at = now();
end;
$$;

create function private.sessions_after() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.reconcile_reminder(new.id);
  return null;
end;
$$;

create trigger sessions_after_ins after insert on public.attendance_sessions
  for each row execute function private.sessions_after();
create trigger sessions_after_upd after update of clock_in, clock_out, required_minutes
  on public.attendance_sessions for each row execute function private.sessions_after();

create function private.settings_after() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  sid uuid;
begin
  -- The target of a session that is still running follows the new setting;
  -- completed (historical) sessions keep their snapshot.
  if new.work_minutes is distinct from old.work_minutes then
    update public.attendance_sessions a set required_minutes = new.work_minutes
     where a.user_id = new.user_id and a.clock_out is null;
  end if;
  for sid in select a.id from public.attendance_sessions a
              where a.user_id = new.user_id and a.clock_out is null loop
    perform private.reconcile_reminder(sid);
  end loop;
  return null;
end;
$$;

create trigger settings_after after update on public.user_settings
  for each row execute function private.settings_after();

-- ---------------------------------------------------------------------
-- RPC: attendance actions (SECURITY INVOKER → RLS applies to the caller)
-- Error codes: AT400 invalid input · AT401 not signed in · AT409 conflict
--   AT001 already clocked in · AT002 day already has office attendance
--   AT003 session not found · AT004 already clocked out
-- ---------------------------------------------------------------------
create function public.clock_in(p_id uuid, p_at timestamptz default null, p_replace boolean default false)
returns public.attendance_sessions
language plpgsql set search_path = '' as $$
declare
  uid uuid := private.require_uid();
  at_ts timestamptz := coalesce(p_at, now());
  v public.attendance_sessions;
  d date;
  c jsonb;
begin
  if p_id is null then
    raise exception using errcode = 'AT400', message = 'A session id is required.';
  end if;
  perform private.lock_user(uid);

  select * into v from public.attendance_sessions a where a.id = p_id and a.user_id = uid;
  if found then return v; end if;                       -- retry of the same action
  perform private.validate_session_times(at_ts, null);

  select * into v from public.attendance_sessions a where a.user_id = uid and a.clock_out is null;
  if found then
    raise exception using errcode = 'AT001', message = 'You are already clocked in.',
      detail = jsonb_build_object('id', v.id, 'date', v.work_date, 'clock_in', v.clock_in)::text;
  end if;

  d := private.local_date(uid, at_ts);
  select * into v from public.attendance_sessions a where a.user_id = uid and a.work_date = d;
  if found then
    raise exception using errcode = 'AT002',
      message = 'Office attendance is already recorded for this day. Use Undo Clock Out or edit the record.',
      detail = jsonb_build_object('id', v.id, 'date', v.work_date)::text;
  end if;

  c := private.find_conflicts(uid, d, d, p_id);
  if jsonb_array_length(c) > 0 then
    if not coalesce(p_replace, false) then
      raise exception using errcode = 'AT409', message = 'conflict', detail = c::text;
    end if;
    perform private.clear_range(uid, d, d, p_id);
  end if;

  insert into public.attendance_sessions (id, user_id, clock_in)
  values (p_id, uid, at_ts) returning * into v;
  return v;
end;
$$;

create function public.clock_out(p_id uuid, p_at timestamptz default null)
returns public.attendance_sessions
language plpgsql set search_path = '' as $$
declare
  uid uuid := private.require_uid();
  at_ts timestamptz := coalesce(p_at, now());
  v public.attendance_sessions;
begin
  select * into v from public.attendance_sessions a where a.id = p_id and a.user_id = uid for update;
  if not found then
    raise exception using errcode = 'AT003', message = 'No active session was found to clock out.';
  end if;
  if v.clock_out is not null then
    if v.clock_out = at_ts then return v; end if;         -- retry of the same action
    raise exception using errcode = 'AT004', message = 'This session is already clocked out.',
      detail = jsonb_build_object('id', v.id, 'clock_out', v.clock_out)::text;
  end if;
  update public.attendance_sessions a set clock_out = at_ts where a.id = v.id returning * into v;
  return v;
end;
$$;

create function public.undo_clock_out(p_id uuid)
returns public.attendance_sessions
language plpgsql set search_path = '' as $$
declare
  uid uuid := private.require_uid();
  v public.attendance_sessions;
  other public.attendance_sessions;
begin
  perform private.lock_user(uid);
  select * into v from public.attendance_sessions a where a.id = p_id and a.user_id = uid for update;
  if not found then
    raise exception using errcode = 'AT003', message = 'Session not found.';
  end if;
  if v.clock_out is null then return v; end if;           -- already active (retry)
  select * into other from public.attendance_sessions a
   where a.user_id = uid and a.clock_out is null and a.id <> v.id;
  if found then
    raise exception using errcode = 'AT001',
      message = 'Another session is active. Clock out of it before undoing this Clock Out.';
  end if;
  update public.attendance_sessions a set clock_out = null where a.id = v.id returning * into v;
  return v;
end;
$$;

-- Manual add / edit (also used to complete a forgotten Clock Out).
create function public.upsert_session(
  p_id uuid, p_clock_in timestamptz, p_clock_out timestamptz default null, p_replace boolean default false)
returns public.attendance_sessions
language plpgsql set search_path = '' as $$
declare
  uid uuid := private.require_uid();
  d date;
  c jsonb;
  v public.attendance_sessions;
begin
  if p_id is null then
    raise exception using errcode = 'AT400', message = 'A session id is required.';
  end if;
  perform private.validate_session_times(p_clock_in, p_clock_out);
  perform private.lock_user(uid);
  d := private.local_date(uid, p_clock_in);
  c := private.find_conflicts(uid, d, d, p_id);
  if jsonb_array_length(c) > 0 then
    if not coalesce(p_replace, false) then
      raise exception using errcode = 'AT409', message = 'conflict', detail = c::text;
    end if;
    perform private.clear_range(uid, d, d, p_id);
  end if;

  update public.attendance_sessions a
     set clock_in = p_clock_in, clock_out = p_clock_out
   where a.id = p_id and a.user_id = uid
  returning * into v;
  if not found then
    insert into public.attendance_sessions (id, user_id, clock_in, clock_out)
    values (p_id, uid, p_clock_in, p_clock_out) returning * into v;
  end if;
  return v;
end;
$$;

create function public.delete_session(p_id uuid) returns boolean
language plpgsql set search_path = '' as $$
declare
  uid uuid := private.require_uid();
begin
  delete from public.attendance_sessions a where a.id = p_id and a.user_id = uid;
  return found;
end;
$$;

create function public.set_remote(p_date date, p_replace boolean default false, p_id uuid default null)
returns public.remote_days
language plpgsql set search_path = '' as $$
declare
  uid uuid := private.require_uid();
  v public.remote_days;
  c jsonb;
begin
  if p_date is null then
    raise exception using errcode = 'AT400', message = 'Date is required.';
  end if;
  perform private.lock_user(uid);
  if p_id is not null then                                -- move an existing record (edit)
    select * into v from public.remote_days r where r.id = p_id and r.user_id = uid;
    if not found then
      raise exception using errcode = 'AT003', message = 'Remote Work record not found.';
    end if;
    if v.work_date = p_date then return v; end if;
  else
    select * into v from public.remote_days r where r.user_id = uid and r.work_date = p_date;
    if found then return v; end if;                       -- idempotent
  end if;

  c := private.find_conflicts(uid, p_date, p_date, p_id);
  if jsonb_array_length(c) > 0 then
    if not coalesce(p_replace, false) then
      raise exception using errcode = 'AT409', message = 'conflict', detail = c::text;
    end if;
    perform private.clear_range(uid, p_date, p_date, p_id);
  end if;

  if p_id is not null then
    update public.remote_days r set work_date = p_date where r.id = p_id and r.user_id = uid returning * into v;
  else
    insert into public.remote_days (user_id, work_date) values (uid, p_date) returning * into v;
  end if;
  return v;
end;
$$;

create function public.delete_remote(p_date date) returns boolean
language plpgsql set search_path = '' as $$
declare
  uid uuid := private.require_uid();
begin
  delete from public.remote_days r where r.user_id = uid and r.work_date = p_date;
  return found;
end;
$$;

create function public.save_leave(
  p_id uuid, p_type public.leave_type, p_start date, p_end date,
  p_note text default '', p_replace boolean default false)
returns public.leaves
language plpgsql set search_path = '' as $$
declare
  uid uuid := private.require_uid();
  v public.leaves;
  c jsonb;
begin
  if p_type is null then
    raise exception using errcode = 'AT400', message = 'Leave type is required.';
  end if;
  if p_start is null or p_end is null or p_end < p_start then
    raise exception using errcode = 'AT400', message = 'End date must be on or after start date.';
  end if;
  perform private.lock_user(uid);
  c := private.find_conflicts(uid, p_start, p_end, p_id);
  if jsonb_array_length(c) > 0 then
    if not coalesce(p_replace, false) then
      raise exception using errcode = 'AT409', message = 'conflict', detail = c::text;
    end if;
    perform private.clear_range(uid, p_start, p_end, p_id);
  end if;

  update public.leaves l
     set leave_type = p_type, start_date = p_start, end_date = p_end, note = coalesce(p_note, '')
   where l.id = p_id and l.user_id = uid
  returning * into v;
  if not found then
    insert into public.leaves (id, user_id, leave_type, start_date, end_date, note)
    values (coalesce(p_id, gen_random_uuid()), uid, p_type, p_start, p_end, coalesce(p_note, ''))
    returning * into v;
  end if;
  return v;
end;
$$;

create function public.delete_leave(p_id uuid) returns boolean
language plpgsql set search_path = '' as $$
declare
  uid uuid := private.require_uid();
begin
  delete from public.leaves l where l.id = p_id and l.user_id = uid;
  return found;
end;
$$;

-- Explicit, user-requested recalculation of historical targets.
create function public.recalculate_required_minutes(p_from date default null, p_to date default null)
returns integer language plpgsql set search_path = '' as $$
declare
  uid uuid := private.require_uid();
  wm integer;
  n integer;
begin
  select us.work_minutes into wm from public.user_settings us where us.user_id = uid;
  if wm is null then
    raise exception using errcode = 'AT400', message = 'Your settings could not be found.';
  end if;
  update public.attendance_sessions a set required_minutes = wm
   where a.user_id = uid
     and (p_from is null or a.work_date >= p_from)
     and (p_to is null or a.work_date <= p_to)
     and a.required_minutes <> wm;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---------------------------------------------------------------------
-- RPC: push subscriptions (one row per device endpoint)
-- ---------------------------------------------------------------------
create function public.register_push_subscription(
  p_endpoint text, p_p256dh text, p_auth text, p_label text default '')
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := private.require_uid();
  new_id uuid;
begin
  if p_endpoint is null or p_endpoint !~ '^https://' or char_length(p_endpoint) > 2000
     or coalesce(p_p256dh, '') = '' or coalesce(p_auth, '') = ''
     or char_length(p_p256dh) > 200 or char_length(p_auth) > 100 then
    raise exception using errcode = 'AT400', message = 'Invalid push subscription.';
  end if;
  -- An endpoint belongs to one browser install. If another account used this
  -- device before, it must stop receiving this device's reminders.
  delete from public.push_subscriptions ps where ps.endpoint = p_endpoint;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, device_label)
  values (uid, p_endpoint, p_p256dh, p_auth, left(coalesce(p_label, ''), 120))
  returning id into new_id;
  return new_id;
end;
$$;

create function public.unregister_push_subscription(p_endpoint text)
returns boolean language plpgsql set search_path = '' as $$
declare
  uid uuid := private.require_uid();
begin
  delete from public.push_subscriptions ps where ps.endpoint = p_endpoint and ps.user_id = uid;
  return found;
end;
$$;

-- ---------------------------------------------------------------------
-- RPC: account deletion (cascades to every user-owned row)
-- ---------------------------------------------------------------------
create function public.delete_my_account() returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := private.require_uid();
begin
  delete from auth.users u where u.id = uid;   -- FKs cascade: profile, settings,
  return found;                                -- sessions, remote, leaves, push, reminders
end;
$$;

-- ---------------------------------------------------------------------
-- Dispatcher functions (service_role only — called by the Edge Function)
-- ---------------------------------------------------------------------
create function public.claim_due_reminders(p_limit integer default 200)
returns table (
  session_id uuid, user_id uuid, fire_at timestamptz, clock_in timestamptz,
  required_minutes integer, lead_minutes integer, timezone text)
language plpgsql set search_path = '' as $$
#variable_conflict use_column
begin
  -- Never deliver an outdated reminder (e.g. the dispatcher was down).
  update public.reminders r set status = 'skipped', last_error = 'expired', updated_at = now()
   where r.status = 'scheduled' and r.fire_at < now() - interval '15 minutes';
  -- Safety net: the session is no longer active.
  update public.reminders r set status = 'cancelled', updated_at = now()
   where r.status = 'scheduled' and r.fire_at <= now()
     and not exists (select 1 from public.attendance_sessions s
                      where s.id = r.session_id and s.clock_out is null);
  -- Recover a send that crashed midway.
  update public.reminders r set status = 'scheduled', updated_at = now()
   where r.status = 'sending' and r.updated_at < now() - interval '3 minutes'
     and r.fire_at > now() - interval '15 minutes';

  return query
  with due as (
    select r.session_id from public.reminders r
     where r.status = 'scheduled' and r.fire_at <= now()
     order by r.fire_at
     limit greatest(coalesce(p_limit, 200), 1)
     for update skip locked
  ), claimed as (
    update public.reminders r
       set status = 'sending', attempts = r.attempts + 1, updated_at = now()
      from due where r.session_id = due.session_id
    returning r.session_id, r.user_id, r.fire_at
  )
  select c.session_id, c.user_id, c.fire_at, s.clock_in, s.required_minutes,
         coalesce(us.lead_minutes, 20), coalesce(us.timezone, 'Asia/Riyadh')
    from claimed c
    join public.attendance_sessions s on s.id = c.session_id
    left join public.user_settings us on us.user_id = c.user_id;
end;
$$;

-- p_outcome: 'sent' | 'retry' | 'failed' | 'skipped'
create function public.finish_reminder(p_session uuid, p_outcome text, p_error text default null)
returns void language plpgsql set search_path = '' as $$
begin
  update public.reminders r
     set status = case
                    when p_outcome = 'sent' then 'sent'::public.reminder_status
                    when p_outcome = 'skipped' then 'skipped'::public.reminder_status
                    when p_outcome = 'retry' and r.attempts < 3
                         and r.fire_at > now() - interval '10 minutes' then 'scheduled'::public.reminder_status
                    else 'failed'::public.reminder_status
                  end,
         sent_at = case when p_outcome = 'sent' then now() else r.sent_at end,
         last_error = left(p_error, 1000),
         updated_at = now()
   where r.session_id = p_session and r.status = 'sending';
end;
$$;

-- Harmless heartbeat for the optional keep-alive job (free projects pause
-- after a week without activity). Returns no user data.
create function public.ping() returns text
language sql stable set search_path = '' as $$ select 'ok'::text $$;

-- ---------------------------------------------------------------------
-- Function privileges (explicit: PUBLIC gets EXECUTE on new functions by
-- default in PostgreSQL, and Supabase also grants it to anon/authenticated)
-- ---------------------------------------------------------------------
revoke all on all functions in schema private from public, anon, authenticated, service_role;

-- Helpers called (as the signed-in user) by the RPCs and validation triggers.
grant execute on function
  private.require_uid(), private.lock_user(uuid), private.user_tz(uuid),
  private.local_date(uuid, timestamptz), private.find_conflicts(uuid, date, date, uuid),
  private.assert_no_conflict(uuid, date, date, uuid), private.clear_range(uuid, date, date, uuid),
  private.validate_session_times(timestamptz, timestamptz)
to authenticated, service_role;
-- private.reconcile_reminder and the trigger functions: no grants
-- (they run only inside triggers, owned by the migration role).

revoke all on function
  public.clock_in(uuid, timestamptz, boolean), public.clock_out(uuid, timestamptz),
  public.undo_clock_out(uuid), public.upsert_session(uuid, timestamptz, timestamptz, boolean),
  public.delete_session(uuid), public.set_remote(date, boolean, uuid), public.delete_remote(date),
  public.save_leave(uuid, public.leave_type, date, date, text, boolean), public.delete_leave(uuid),
  public.recalculate_required_minutes(date, date),
  public.register_push_subscription(text, text, text, text),
  public.unregister_push_subscription(text), public.delete_my_account(),
  public.claim_due_reminders(integer), public.finish_reminder(uuid, text, text),
  public.ping()
from public, anon, authenticated, service_role;

grant execute on function
  public.clock_in(uuid, timestamptz, boolean), public.clock_out(uuid, timestamptz),
  public.undo_clock_out(uuid), public.upsert_session(uuid, timestamptz, timestamptz, boolean),
  public.delete_session(uuid), public.set_remote(date, boolean, uuid), public.delete_remote(date),
  public.save_leave(uuid, public.leave_type, date, date, text, boolean), public.delete_leave(uuid),
  public.recalculate_required_minutes(date, date),
  public.register_push_subscription(text, text, text, text),
  public.unregister_push_subscription(text), public.delete_my_account()
to authenticated;

grant execute on function public.claim_due_reminders(integer), public.finish_reminder(uuid, text, text)
  to service_role;

grant execute on function public.ping() to anon, authenticated, service_role;

commit;

-- Ask the Data API to pick up the new tables and functions now.
notify pgrst, 'reload schema';
