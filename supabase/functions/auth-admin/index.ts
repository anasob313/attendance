// Supabase Edge Function: auth-admin
//
// TEMPORARY test runner for the email set-up (removed after testing).
// Holds NO tokens or SMTP credentials — Auth is configured from SQL using a
// scoped token kept only in Vault (see supabase/setup/auth_email.sql).
// Called from SQL with pg_net and the header `x-admin-secret` (= CRON_SECRET,
// read from Vault). Responses never contain secrets.
//
// Actions (POST JSON {"action": ...}):
//   e2e_start / e2e_confirm / e2e_isolation / e2e_reset / e2e_cleanup
//              real-email test using throw-away mail.tm inboxes
//
// Deploy: verify_jwt = false (authenticated by x-admin-secret instead).
import { APP_URL, cleanSecret, extractVerifyLink, parseFragment, redact, safeEqual } from './lib.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const REF = new URL(SUPABASE_URL || 'https://x.supabase.co').hostname.split('.')[0];
// Public key (also committed in .env.production); env var preferred when present.
const ANON = Deno.env.get('SUPABASE_ANON_KEY') || 'sb_publishable_5Gq-gOjaMtCIDmIPv6ofvw_UgNqikHd';
const ADMIN_SECRET = cleanSecret(Deno.env.get('CRON_SECRET'), 'CRON_SECRET');
const SECRETS = [ADMIN_SECRET];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(redact(body, SECRETS)), { status, headers: { 'Content-Type': 'application/json' } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- Auth REST
async function auth(path: string, init: RequestInit & { token?: string } = {}) {
  const headers: Record<string, string> = { apikey: ANON, 'Content-Type': 'application/json' };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  const res = await fetch(`${SUPABASE_URL}/auth/v1${path}`, { ...init, headers });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 200) }; }
  return { status: res.status, data };
}
async function login(email: string, password: string) {
  const r = await auth('/token?grant_type=password', { method: 'POST', body: JSON.stringify({ email, password }) });
  return { status: r.status, token: r.data.access_token as string | undefined, error: r.data.error_code ?? r.data.msg ?? r.data.error };
}
async function rest(path: string, token: string, init: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...init,
    headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  const text = await res.text();
  let data: unknown = text;
  try { data = JSON.parse(text); } catch { /* keep */ }
  return { status: res.status, data };
}

// ---------------------------------------------------------------- mail.tm inboxes
const MAILTM = 'https://api.mail.tm';
interface Inbox { address: string; password: string; id: string; token: string }
interface TestUser { email: string; password: string; inbox: Inbox }

async function newInbox(): Promise<Inbox> {
  const d = await (await fetch(`${MAILTM}/domains`)).json();
  const domain = (d['hydra:member'] ?? []).find((x: { isActive: boolean }) => x.isActive)?.domain;
  if (!domain) throw new Error('mail.tm: no active domain');
  const address = `att-${crypto.randomUUID().slice(0, 12)}@${domain}`;
  const password = crypto.randomUUID();
  const acc = await fetch(`${MAILTM}/accounts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address, password }) });
  if (!acc.ok) throw new Error(`mail.tm account ${acc.status}`);
  const { id } = await acc.json();
  const t = await fetch(`${MAILTM}/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address, password }) });
  const { token } = await t.json();
  return { address, password, id, token };
}

/** Wait for the n-th email in the inbox and return its verify link + subject + sender. */
async function waitForEmail(inbox: Inbox, nth: number, timeoutMs = 75_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await fetch(`${MAILTM}/messages`, { headers: { Authorization: `Bearer ${inbox.token}` } });
    if (r.ok) {
      const list = ((await r.json())['hydra:member'] ?? []) as { id: string; createdAt: string }[];
      list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      if (list.length >= nth) {
        const m = await (await fetch(`${MAILTM}/messages/${list[nth - 1].id}`, { headers: { Authorization: `Bearer ${inbox.token}` } })).json();
        const body = [...(m.html ?? []), m.text ?? ''].join('\n');
        return { subject: m.subject as string, from: m.from?.address as string, link: extractVerifyLink(body), seconds: Math.round((Date.now() - start) / 1000) };
      }
    }
    await sleep(4000);
  }
  return null;
}

/** Open a verification link like a browser would, without following the final redirect. */
async function followVerify(link: string) {
  const res = await fetch(link, { redirect: 'manual' });
  const location = res.headers.get('location') ?? '';
  const frag = parseFragment(location);
  return {
    status: res.status,
    redirectTarget: location.split('#')[0],
    type: frag.type ?? null,
    error: frag.error_description ?? frag.error ?? null,
    accessToken: frag.access_token ?? null,
  };
}

// ---------------------------------------------------------------- actions
async function e2eStart() {
  const users: TestUser[] = [];
  const signups = [];
  for (let i = 0; i < 2; i++) {
    const inbox = await newInbox();
    const u = { email: inbox.address, password: `Test-${crypto.randomUUID()}`, inbox };
    users.push(u);
    const r = await auth(`/signup?redirect_to=${encodeURIComponent(APP_URL)}`, {
      method: 'POST', body: JSON.stringify({ email: u.email, password: u.password, data: { full_name: `E2E Test ${i + 1}` } }),
    });
    signups.push({ status: r.status, sessionReturned: Boolean(r.data.access_token), confirmed: Boolean((r.data as { confirmed_at?: string }).confirmed_at), error: r.data.msg ?? r.data.error_code ?? null });
  }
  // before confirming, sign-in must be refused
  const early = await login(users[0].email, users[0].password);
  return { users, signups, loginBeforeConfirm: { status: early.status, error: early.error } };
}

async function e2eConfirm(users: TestUser[]) {
  // Both inboxes are watched at the same time to stay inside the function time limit.
  return await Promise.all(users.map(async (u) => {
    const mail = await waitForEmail(u.inbox, 1);
    if (!mail?.link) return { delivered: Boolean(mail), mail };
    const v = await followVerify(mail.link);
    const l = await login(u.email, u.password);
    return { delivered: true, subject: mail.subject, fromMasked: mail.from?.replace(/^(.{2}).*@/, '$1***@'), secondsToArrive: mail.seconds,
      verify: { status: v.status, redirectTarget: v.redirectTarget, type: v.type, error: v.error, sessionInRedirect: Boolean(v.accessToken) },
      loginAfterConfirm: l.status };
  }));
}

async function e2eIsolation(users: TestUser[]) {
  const a = await login(users[0].email, users[0].password);
  const b = await login(users[1].email, users[1].password);
  if (!a.token || !b.token) return { error: 'login failed', a: a.status, b: b.status };
  const d = '2020-01-05';
  const created = await rest('/rpc/set_remote', a.token, { method: 'POST', body: JSON.stringify({ p_date: d }) });
  const sess = await rest('/rpc/upsert_session', a.token, { method: 'POST', body: JSON.stringify({ p_id: crypto.randomUUID(), p_clock_in: '2020-01-06T05:00:00Z', p_clock_out: '2020-01-06T13:00:00Z' }) });
  const aSees = await rest('/remote_days?select=id', a.token);
  const aSessions = await rest('/attendance_sessions?select=id', a.token);
  const bSeesRemote = await rest('/remote_days?select=id', b.token);
  const bSeesSessions = await rest('/attendance_sessions?select=id', b.token);
  const bSeesProfiles = await rest('/profiles?select=id', b.token);
  const bDeletes = await rest('/rpc/delete_remote', b.token, { method: 'POST', body: JSON.stringify({ p_date: d }) });
  const aStill = await rest('/remote_days?select=id', a.token);
  const anon = await fetch(`${SUPABASE_URL}/rest/v1/attendance_sessions?select=id`, { headers: { apikey: ANON } });
  const len = (x: { data: unknown }) => (Array.isArray(x.data) ? x.data.length : `error ${JSON.stringify(x.data).slice(0, 80)}`);
  return {
    aCreatedRemote: created.status, aCreatedSession: sess.status,
    aSeesOwnRemote: len(aSees), aSeesOwnSessions: len(aSessions),
    bSeesARemote: len(bSeesRemote), bSeesASessions: len(bSeesSessions), bSeesProfiles: len(bSeesProfiles),
    bDeleteOfADay: bDeletes.data, aStillHasRemote: len(aStill),
    anonymousRead: anon.status,
  };
}

async function e2eReset(user: TestUser) {
  const r = await auth(`/recover?redirect_to=${encodeURIComponent(`${APP_URL}reset-password`)}`, { method: 'POST', body: JSON.stringify({ email: user.email }) });
  const mail = await waitForEmail(user.inbox, 2);
  if (!mail?.link) return { requestStatus: r.status, delivered: Boolean(mail), mail };
  const v = await followVerify(mail.link);
  if (!v.accessToken) return { requestStatus: r.status, subject: mail.subject, verify: v };
  const newPassword = `New-${crypto.randomUUID()}`;
  const upd = await auth('/user', { method: 'PUT', token: v.accessToken, body: JSON.stringify({ password: newPassword }) });
  const oldLogin = await login(user.email, user.password);
  const newLogin = await login(user.email, newPassword);
  return {
    requestStatus: r.status, subject: mail.subject, secondsToArrive: mail.seconds,
    verify: { status: v.status, redirectTarget: v.redirectTarget, type: v.type, error: v.error },
    setNewPassword: upd.status, loginWithOldPassword: oldLogin.status, loginWithNewPassword: newLogin.status,
    newPassword,   // throw-away test account; returned so cleanup can sign in
  };
}

async function e2eCleanup(users: TestUser[]) {
  const out = [];
  for (const u of users) {
    const l = await login(u.email, u.password);
    let deleted: unknown = 'not signed in';
    if (l.token) deleted = (await rest('/rpc/delete_my_account', l.token, { method: 'POST', body: '{}' })).data;
    const after = await login(u.email, u.password);
    const inbox = await fetch(`${MAILTM}/accounts/${u.inbox.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${u.inbox.token}` } });
    out.push({ accountDeleted: deleted, loginAfterDelete: after.status, inboxDeleted: inbox.status });
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!ADMIN_SECRET || !safeEqual(req.headers.get('x-admin-secret') ?? '', ADMIN_SECRET)) return json({ error: 'Forbidden' }, 403);
  const body = await req.json().catch(() => ({}));
  try {
    switch (body.action) {
      case 'e2e_start': return json(await e2eStart());
      case 'e2e_confirm': return json(await e2eConfirm(body.users));
      case 'e2e_isolation': return json(await e2eIsolation(body.users));
      case 'e2e_reset': return json(await e2eReset(body.user));
      case 'e2e_cleanup': return json(await e2eCleanup(body.users));
      default: return json({ error: 'unknown action' }, 400);
    }
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
