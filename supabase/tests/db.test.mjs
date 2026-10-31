// Real-database tests for the schema, RLS policies, RPCs and reminder logic.
// Runs the actual migration inside PGlite (PostgreSQL 17 compiled to WASM)
// with a minimal stand-in for Supabase's `auth` schema and roles.
//
//   npm run test:db
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';

const migration = readFileSync(new URL('../migrations/20261029000001_schema.sql', import.meta.url), 'utf8');

const SUPABASE_STUB = `
  create schema if not exists auth;
  create schema if not exists extensions;
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text,
    raw_user_meta_data jsonb not null default '{}'
  );
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema public, auth, extensions to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  -- Supabase today: functions are still auto-granted, tables are NOT
  -- (new projects since 30 May 2026). The migration must grant explicitly.
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  set search_path = public, extensions;
`;

let db;
const users = {};
const EARLY = randomUUID();

async function asUser(uid, fn) {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid ?? ''}', false); set role ${uid ? 'authenticated' : 'anon'};`);
  try { return await fn(); } finally { await db.exec('reset role;'); }
}
async function asService(fn) {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false); set role service_role;`);
  try { return await fn(); } finally { await db.exec('reset role;'); }
}
const q = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
async function expectError(promise, code) {
  try { await promise; } catch (e) {
    if (code) assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    return e;
  }
  assert.fail(`expected error ${code ?? ''}`);
}
// "today at HH:MM in Riyadh" minus N days, as an ISO timestamp
async function riyadh(daysAgo, hhmm) {
  const r = await one(
    `select ((((now() at time zone 'Asia/Riyadh')::date - $1::int) + $2::time) at time zone 'Asia/Riyadh') as ts`,
    [daysAgo, hhmm]);
  return r.ts.toISOString();
}
async function newUser(name) {
  const id = randomUUID();
  await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`,
    [id, `${name}@example.com`, JSON.stringify({ full_name: name })]);
  return id;
}
const reminderOf = (sid) => one(`select status, fire_at from reminders where session_id = $1`, [sid]);

before(async () => {
  db = await PGlite.create({ extensions: { btree_gist } });
  await db.exec(SUPABASE_STUB);
  // someone signed up before the migration was run
  await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, 'early@example.com', '{"full_name":"Early Bird"}')`, [EARLY]);
  await db.exec(migration);
  await db.exec(readFileSync(new URL('../migrations/20261031000001_oauth_profile_name.sql', import.meta.url), 'utf8'));
  users.a = await newUser('Alice');
  users.b = await newUser('Bob');
});

test('sign-up bootstraps profile and default settings', async () => {
  const p = await one(`select full_name from profiles where id = $1`, [users.a]);
  assert.equal(p.full_name, 'Alice');
  const s = await one(`select * from user_settings where user_id = $1`, [users.a]);
  assert.equal(s.work_minutes, 480);
  assert.equal(s.lead_minutes, 20);
  assert.deepEqual(s.working_days, [0, 1, 2, 3, 4]);
  assert.equal(s.timezone, 'Asia/Riyadh');
});

test('clock in: idempotent, single active session, reminder at +7h40', async () => {
  const id = randomUUID();
  const at = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
  await asUser(users.a, async () => {
    const s1 = await one(`select * from clock_in($1, $2)`, [id, at]);
    assert.equal(s1.clock_out, null);
    const s2 = await one(`select * from clock_in($1, $2)`, [id, at]);           // network retry
    assert.equal(s2.id, s1.id);
    const n = await one(`select count(*)::int as n from attendance_sessions`);
    assert.equal(n.n, 1);
    await expectError(q(`select * from clock_in($1)`, [randomUUID()]), 'AT001'); // double tap / 2nd device
    const r = await reminderOf(id);
    assert.equal(r.status, 'scheduled');
    assert.equal(r.fire_at.getTime() - new Date(at).getTime(), (7 * 60 + 40) * 60 * 1000);
  });
});

test('clock out: cancels reminder, duplicate/invalid clock-outs handled', async () => {
  await asUser(users.a, async () => {
    const s = await one(`select * from attendance_sessions where clock_out is null`);
    const out = new Date().toISOString();
    const done = await one(`select * from clock_out($1, $2)`, [s.id, out]);
    assert.ok(done.clock_out);
    assert.equal((await reminderOf(s.id)).status, 'cancelled');
    const again = await one(`select * from clock_out($1, $2)`, [s.id, out]);  // retry, same timestamp
    assert.equal(again.clock_out.getTime(), done.clock_out.getTime());
    await expectError(q(`select * from clock_out($1)`, [s.id]), 'AT004');      // second, different tap
    await expectError(q(`select * from clock_out($1)`, [randomUUID()]), 'AT003'); // no active session
    // clocking in again the same day is refused (use Undo instead)
    await expectError(q(`select * from clock_in($1)`, [randomUUID()]), 'AT002');
  });
});

test('undo clock out restores the same session and reconciles the reminder', async () => {
  await asUser(users.a, async () => {
    const s = await one(`select * from attendance_sessions order by created_at desc limit 1`);
    const u = await one(`select * from undo_clock_out($1)`, [s.id]);
    assert.equal(u.id, s.id);
    assert.equal(u.clock_out, null);
    assert.equal(u.clock_in.getTime(), s.clock_in.getTime());
    assert.equal((await one(`select count(*)::int n from attendance_sessions`)).n, 1);
    assert.equal((await reminderOf(s.id)).status, 'scheduled');               // fire time still ahead
    // edit Clock In so the reminder time is already past → not sent late
    await q(`select * from upsert_session($1, $2, null)`, [s.id, new Date(Date.now() - 9 * 3600e3).toISOString()]);
    assert.equal((await reminderOf(s.id)).status, 'skipped');
    // edit back to 2h ago → rescheduled to clock_in + 7h40
    const ci = new Date(Date.now() - 2 * 3600e3).toISOString();
    await q(`select * from upsert_session($1, $2, null)`, [s.id, ci]);
    const r = await reminderOf(s.id);
    assert.equal(r.status, 'scheduled');
    assert.equal(r.fire_at.getTime(), new Date(ci).getTime() + 460 * 60e3);
    await q(`select * from clock_out($1)`, [s.id]);
  });
});

test('durations: exactly 8h, 8h30, 7h30 stored without capping', async () => {
  await asUser(users.a, async () => {
    const cases = [[10, '08:00', '16:00', 480], [11, '08:00', '16:30', 510], [12, '08:00', '15:30', 450]];
    for (const [ago, a, b, mins] of cases) {
      const s = await one(`select * from upsert_session($1, $2, $3)`, [randomUUID(), await riyadh(ago, a), await riyadh(ago, b)]);
      assert.equal((s.clock_out - s.clock_in) / 60000, mins);
      assert.equal(s.required_minutes, 480);
    }
  });
});

test('invalid timestamps are rejected', async () => {
  await asUser(users.a, async () => {
    const future = new Date(Date.now() + 3600e3).toISOString();
    await expectError(q(`select * from upsert_session($1, $2)`, [randomUUID(), future]), 'AT400');
    await expectError(q(`select * from upsert_session($1, $2, $3)`, [randomUUID(), await riyadh(20, '10:00'), await riyadh(20, '09:00')]), 'AT400');
    await expectError(q(`select * from upsert_session($1, $2, $3)`, [randomUUID(), await riyadh(21, '08:00'), await riyadh(19, '08:00')]), 'AT400');
  });
});

test('overnight session belongs to the Clock In date and counts 8h', async () => {
  await asUser(users.a, async () => {
    const s = await one(`select * from upsert_session($1, $2, $3)`,
      [randomUUID(), await riyadh(31, '22:00'), await riyadh(30, '06:00')]);
    const expectedDate = await one(`select ((now() at time zone 'Asia/Riyadh')::date - 31) as d`);
    assert.equal(s.work_date.toISOString().slice(0, 10), expectedDate.d.toISOString().slice(0, 10));
    assert.equal((s.clock_out - s.clock_in) / 3600e3, 8);
    // a session overlapping it is refused
    await expectError(q(`select * from upsert_session($1, $2, $3)`,
      [randomUUID(), await riyadh(30, '05:00'), await riyadh(30, '09:00')]), '23P01');
  });
});

test('remote work: conflict dialog data, replace, undo, conversion', async () => {
  await asUser(users.b, async () => {
    const d = (await one(`select ((now() at time zone 'Asia/Riyadh')::date) as d`)).d.toISOString().slice(0, 10);
    const r = await one(`select * from set_remote($1)`, [d]);
    const r2 = await one(`select * from set_remote($1)`, [d]);                // idempotent
    assert.equal(r.id, r2.id);
    const e = await expectError(q(`select * from clock_in($1)`, [randomUUID()]), 'AT409');
    assert.equal(JSON.parse(e.detail)[0].kind, 'remote');
    // REPLACE: remote → office, atomically
    const sid = randomUUID();
    await q(`select * from clock_in($1, null, true)`, [sid]);
    assert.equal((await one(`select count(*)::int n from remote_days`)).n, 0);
    // convert office → remote (replace) removes the session and its reminder
    await expectError(q(`select * from set_remote($1)`, [d]), 'AT409');
    await q(`select * from set_remote($1, true)`, [d]);
    assert.equal((await one(`select count(*)::int n from attendance_sessions`)).n, 0);
    assert.equal((await one(`select count(*)::int n from reminders`)).n, 0);
    // undo accidental remote → day back to not recorded
    assert.equal((await one(`select delete_remote($1) as ok`, [d])).ok, true);
    assert.equal((await one(`select count(*)::int n from remote_days`)).n, 0);
  });
});

test('leave: overlap prevention, replace splits leave, conflicts with remote', async () => {
  await asUser(users.b, async () => {
    const base = (await one(`select ((now() at time zone 'Asia/Riyadh')::date - 60) as d`)).d;
    const day = (n) => new Date(base.getTime() + n * 86400e3).toISOString().slice(0, 10);
    const L = await one(`select * from save_leave(null, 'annual', $1, $2)`, [day(0), day(6)]);
    await expectError(q(`select * from save_leave(null, 'sick', $1, $2)`, [day(5), day(8)]), 'AT409');
    await expectError(q(`select * from set_remote($1)`, [day(3)]), 'AT409');
    // office attendance on day 3 with REPLACE splits the leave into [0..2] and [4..6]
    await q(`select * from upsert_session($1, $2, $3, true)`,
      [randomUUID(), await riyadh(57, '08:00'), await riyadh(57, '16:00')]);
    const rows = await q(`select start_date, end_date from leaves order by start_date`);
    assert.deepEqual(rows.map(r => [r.start_date.toISOString().slice(0, 10), r.end_date.toISOString().slice(0, 10)]),
      [[day(0), day(2)], [day(4), day(6)]]);
    assert.ok(L.id);
    // multi-day public holiday after the leave, editable and deletable
    const h = await one(`select * from save_leave(null, 'public_holiday', $1, $2, 'National Day')`, [day(10), day(12)]);
    const h2 = await one(`select * from save_leave($1, 'public_holiday', $2, $3, 'National Day')`, [h.id, day(10), day(13)]);
    assert.equal(h2.id, h.id);
    assert.equal((await one(`select delete_leave($1) as ok`, [h.id])).ok, true);
  });
});

test('forgotten clock out stays pending and blocks a new Clock In until fixed', async () => {
  const c = await newUser('Carol');
  await asUser(c, async () => {
    const sid = randomUUID();
    await q(`select * from clock_in($1, $2)`, [sid, await riyadh(1, '08:00')]);
    const e = await expectError(q(`select * from clock_in($1)`, [randomUUID()]), 'AT001');
    assert.equal(JSON.parse(e.detail).id, sid);
    assert.equal((await one(`select clock_out from attendance_sessions where id = $1`, [sid])).clock_out, null);
    await q(`select * from upsert_session($1, $2, $3)`, [sid, await riyadh(1, '08:00'), await riyadh(1, '16:10')]);
    await q(`select * from clock_in($1)`, [randomUUID()]);
  });
});

test('RLS: users never see or change each other\'s data', async () => {
  const aSession = (await asUser(users.a, () => one(`select id from attendance_sessions limit 1`))).id;
  await asUser(users.b, async () => {
    assert.equal((await one(`select count(*)::int n from attendance_sessions where user_id = $1`, [users.a])).n, 0);
    assert.equal((await one(`select count(*)::int n from reminders where user_id = $1`, [users.a])).n, 0);
    assert.equal((await one(`select count(*)::int n from profiles`)).n, 1);
    assert.equal((await one(`select count(*)::int n from user_settings`)).n, 1);
    assert.equal((await one(`select delete_session($1) as ok`, [aSession])).ok, false);
    const upd = await db.query(`update attendance_sessions set clock_out = now() where id = $1`, [aSession]);
    assert.equal(upd.affectedRows, 0);
    await expectError(q(`insert into attendance_sessions (user_id, clock_in) values ($1, now() - interval '1 hour')`, [users.a]), '42501');
    await expectError(q(`select * from claim_due_reminders()`), '42501');
    await expectError(q(`insert into reminders (session_id, user_id, fire_at, status) values ($1, $2, now(), 'scheduled')`, [aSession, users.b]), '42501');
  });
  await asUser(null, async () => {
    await expectError(q(`select * from attendance_sessions`), '42501');
    await expectError(q(`select * from clock_in($1)`, [randomUUID()]), '42501');
  });
});

test('settings: per-user, validated, reconcile active reminders', async () => {
  const d = await newUser('Dan');
  await asUser(d, async () => {
    const sid = randomUUID();
    const ci = new Date(Date.now() - 3600e3).toISOString();
    await q(`select * from clock_in($1, $2)`, [sid, ci]);
    await q(`update user_settings set lead_minutes = 30`);
    assert.equal((await reminderOf(sid)).fire_at.getTime(), new Date(ci).getTime() + 450 * 60e3);
    await q(`update user_settings set work_minutes = 540`);           // running session follows
    assert.equal((await one(`select required_minutes from attendance_sessions where id = $1`, [sid])).required_minutes, 540);
    assert.equal((await reminderOf(sid)).fire_at.getTime(), new Date(ci).getTime() + 510 * 60e3);
    await expectError(q(`update user_settings set timezone = 'Mars/Olympus'`), 'AT400');
    await expectError(q(`update user_settings set lead_minutes = 600`), '23514');
  });
  const other = await asUser(users.a, () => one(`select work_minutes, lead_minutes from user_settings`));
  assert.deepEqual(other, { work_minutes: 480, lead_minutes: 20 });
});

test('historical targets are preserved unless recalculation is requested', async () => {
  await asUser(users.a, async () => {
    await q(`update user_settings set work_minutes = 420, lead_minutes = 20`);
    const before = await q(`select required_minutes from attendance_sessions where clock_out is not null`);
    assert.ok(before.every(r => r.required_minutes === 480));
    const n = (await one(`select recalculate_required_minutes() as n`)).n;
    assert.ok(n >= 1);
    const after = await q(`select required_minutes from attendance_sessions`);
    assert.ok(after.every(r => r.required_minutes === 420));
    await q(`update user_settings set work_minutes = 480`);
    await q(`select recalculate_required_minutes()`);
  });
});

test('timezone setting decides the session date', async () => {
  const e = await newUser('Eve');
  await asUser(e, async () => {
    await q(`update user_settings set timezone = 'UTC'`);
    // 23:30 UTC three days ago is already the next day in Riyadh
    const ts = (await one(`select (((now() at time zone 'UTC')::date - 3) + time '23:30') at time zone 'UTC' as ts`)).ts;
    const s = await one(`select * from upsert_session($1, $2, $3)`, [randomUUID(), ts, new Date(ts.getTime() + 3600e3)]);
    const utcDate = (await one(`select ((now() at time zone 'UTC')::date - 3) as d`)).d;
    assert.equal(s.work_date.toISOString().slice(0, 10), utcDate.toISOString().slice(0, 10));
    assert.equal(s.timezone, 'UTC');
  });
});

test('dispatcher: due reminder claimed once, outdated ones skipped, sent never repeats', async () => {
  const f = await newUser('Frank');
  const sid = randomUUID();
  await asUser(f, () => q(`select * from clock_in($1, $2)`, [sid, new Date(Date.now() - 3600e3).toISOString()]));
  await db.query(`update reminders set fire_at = now() - interval '1 minute' where session_id = $1`, [sid]);
  const claimed = await asService(() => q(`select * from claim_due_reminders()`));
  assert.equal(claimed.filter(r => r.session_id === sid).length, 1);
  assert.equal(claimed[0].lead_minutes, 20);
  const again = await asService(() => q(`select * from claim_due_reminders()`));
  assert.equal(again.filter(r => r.session_id === sid).length, 0);           // no duplicate
  await asService(() => q(`select finish_reminder($1, 'sent')`, [sid]));
  assert.equal((await reminderOf(sid)).status, 'sent');
  // editing Clock In after delivery does not schedule a 2nd notification
  await asUser(f, () => q(`select * from upsert_session($1, $2, null)`, [sid, new Date(Date.now() - 1800e3).toISOString()]));
  assert.equal((await reminderOf(sid)).status, 'sent');
  // a reminder the dispatcher missed by >15 min is skipped, not sent late
  const g = await newUser('Gina');
  const sid2 = randomUUID();
  await asUser(g, () => q(`select * from clock_in($1, $2)`, [sid2, new Date(Date.now() - 3600e3).toISOString()]));
  await db.query(`update reminders set fire_at = now() - interval '20 minutes' where session_id = $1`, [sid2]);
  const c2 = await asService(() => q(`select * from claim_due_reminders()`));
  assert.equal(c2.filter(r => r.session_id === sid2).length, 0);
  assert.equal((await reminderOf(sid2)).status, 'skipped');
  // transient failure → retried once more on the next tick
  const h = await newUser('Hank');
  const sid3 = randomUUID();
  await asUser(h, () => q(`select * from clock_in($1, $2)`, [sid3, new Date(Date.now() - 3600e3).toISOString()]));
  await db.query(`update reminders set fire_at = now() - interval '1 minute' where session_id = $1`, [sid3]);
  await asService(() => q(`select * from claim_due_reminders()`));
  await asService(() => q(`select finish_reminder($1, 'retry', 'timeout')`, [sid3]));
  assert.equal((await reminderOf(sid3)).status, 'scheduled');
});

test('push subscriptions: per device, moved when another account signs in on it', async () => {
  const ep = 'https://web.push.apple.com/device-1';
  await asUser(users.a, () => q(`select register_push_subscription($1, 'k', 'a', 'iPhone')`, [ep]));
  await asUser(users.a, () => q(`select register_push_subscription($1, 'k', 'a', 'iPad')`, [ep + '-ipad']));
  assert.equal((await asUser(users.a, () => one(`select count(*)::int n from push_subscriptions`))).n, 2);
  await asUser(users.b, () => q(`select register_push_subscription($1, 'k2', 'a2', 'iPhone')`, [ep]));
  assert.equal((await asUser(users.a, () => one(`select count(*)::int n from push_subscriptions`))).n, 1);
  assert.equal((await asUser(users.b, () => one(`select count(*)::int n from push_subscriptions`))).n, 1);
  await expectError(asUser(users.a, () => q(`select register_push_subscription('http://evil', 'k', 'a')`)), 'AT400');
});

test('account deletion removes only that user\'s data', async () => {
  const bBefore = await asUser(users.b, () => one(`select count(*)::int n from leaves`));
  await asUser(users.a, () => q(`select delete_my_account()`));
  for (const t of ['attendance_sessions', 'remote_days', 'leaves', 'push_subscriptions', 'reminders', 'user_settings']) {
    assert.equal((await one(`select count(*)::int n from ${t} where user_id = $1`, [users.a])).n, 0, t);
  }
  assert.equal((await one(`select count(*)::int n from profiles where id = $1`, [users.a])).n, 0);
  assert.equal((await one(`select count(*)::int n from auth.users where id = $1`, [users.a])).n, 0);
  const bAfter = await asUser(users.b, () => one(`select count(*)::int n from leaves`));
  assert.equal(bAfter.n, bBefore.n);
  assert.equal((await one(`select count(*)::int n from auth.users where id = $1`, [users.b])).n, 1);
});

test('users created before the migration are backfilled', async () => {
  assert.equal((await one(`select full_name from profiles where id = $1`, [EARLY])).full_name, 'Early Bird');
  assert.equal((await one(`select work_minutes from user_settings where user_id = $1`, [EARLY])).work_minutes, 480);
});

test('running the migration twice is refused without changing anything', async () => {
  const e = await expectError(db.exec(migration));
  assert.match(e.message, /already installed/);
  await db.exec('rollback');
  assert.equal((await one(`select count(*)::int n from auth.users`)).n > 0, true);
});

test('internal helpers are not exposed in the public (API) schema', async () => {
  const exposed = await q(`select p.proname from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1`);
  assert.deepEqual(exposed.map((r) => r.proname), [
    'claim_due_reminders', 'clock_in', 'clock_out', 'delete_leave', 'delete_my_account', 'delete_remote',
    'delete_session', 'finish_reminder', 'ping', 'recalculate_required_minutes', 'register_push_subscription',
    'save_leave', 'set_remote', 'undo_clock_out', 'unregister_push_subscription', 'upsert_session',
  ]);
  const mutable = await q(`select p.proname from pg_proc p
    where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`);
  assert.deepEqual(mutable, [], 'every function pins search_path');
});

test('privileges: anon has nothing but ping; no TRUNCATE; service_role works', async () => {
  await asUser(null, async () => {
    assert.equal((await one(`select public.ping() as v`)).v, 'ok');
    for (const t of ['profiles', 'user_settings', 'attendance_sessions', 'remote_days', 'leaves', 'push_subscriptions', 'reminders']) {
      await expectError(q(`select 1 from public.${t} limit 1`), '42501');
    }
    await expectError(q(`select public.delete_my_account()`), '42501');
    await expectError(q(`select public.register_push_subscription('https://x', 'k', 'a')`), '42501');
  });
  const b = users.b;
  await asUser(b, async () => {
    await expectError(q(`truncate public.attendance_sessions`), '42501');
    await expectError(q(`select private.reconcile_reminder(gen_random_uuid())`), '42501');
    await expectError(q(`select public.finish_reminder(gen_random_uuid(), 'sent')`), '42501');
    await expectError(q(`update public.push_subscriptions set user_id = user_id`), '42501');
  });
  await asService(async () => {
    const r = await q(`select id from public.push_subscriptions limit 1`);
    if (r[0]) await q(`update public.push_subscriptions set failure_count = failure_count + 1 where id = $1`, [r[0].id]);
    await q(`delete from public.push_subscriptions where id = gen_random_uuid()`);
  });
});

test('direct table writes still obey conflict rules (no RPC bypass)', async () => {
  const u = await newUser('Direct');
  await asUser(u, async () => {
    const d = (await one(`select ((now() at time zone 'Asia/Riyadh')::date - 3) as d`)).d.toISOString().slice(0, 10);
    await q(`insert into public.remote_days (work_date) values ($1)`, [d]);
    await expectError(q(`insert into public.leaves (leave_type, start_date, end_date) values ('sick', $1, $1)`, [d]), 'AT409');
    await expectError(q(`insert into public.attendance_sessions (clock_in) values ((($1::date) + time '08:00') at time zone 'Asia/Riyadh')`, [d]), 'AT409');
  });
});

test('Google sign-up: profile name comes from full_name or name', async () => {
  const id1 = randomUUID(), id2 = randomUUID();
  await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, 'g1@example.com', $2)`, [id1, JSON.stringify({ name: 'Only Name' })]);
  await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, 'g2@example.com', $2)`, [id2, JSON.stringify({ full_name: 'Full Name', name: 'Other' })]);
  assert.equal((await one(`select full_name from profiles where id = $1`, [id1])).full_name, 'Only Name');
  assert.equal((await one(`select full_name from profiles where id = $1`, [id2])).full_name, 'Full Name');
  assert.equal((await one(`select work_minutes from user_settings where user_id = $1`, [id1])).work_minutes, 480);
});
