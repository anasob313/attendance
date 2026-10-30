// Local stand-in for Supabase used by the browser tests.
// It runs the REAL migration (schema, RLS, RPCs, triggers) in PGlite and
// emulates the small part of the Auth + PostgREST HTTP API the app uses.
// Every request runs as the signed-in user's role, so RLS is enforced.
//
//   node e2e/mock-supabase.mjs  (listens on :54321)
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';

const PORT = Number(process.env.MOCK_PORT ?? 54321);
const migration = readFileSync(new URL('../supabase/migrations/20261029000001_schema.sql', import.meta.url), 'utf8');

const db = await PGlite.create({ extensions: { btree_gist } });
await db.exec(`
  create schema if not exists auth; create schema if not exists extensions;
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text unique, raw_user_meta_data jsonb not null default '{}', created_at timestamptz default now());
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema public, auth, extensions to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  set search_path = public, extensions;
`);
await db.exec(migration);

const passwords = new Map();
let lock = Promise.resolve();
const serial = (fn) => { const p = lock.then(fn, fn); lock = p.catch(() => {}); return p; };

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(user) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user.id, email: user.email, role: 'authenticated', aud: 'authenticated', exp })}.sig`;
}
function claims(req) {
  const t = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  try { const p = JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()); return p.sub ? p : null; } catch { return null; }
}
async function userRow(id) {
  const r = await db.query(`select id, email, raw_user_meta_data, created_at from auth.users where id = $1`, [id]);
  const u = r.rows[0];
  return u && { id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, user_metadata: u.raw_user_meta_data, app_metadata: {}, created_at: u.created_at.toISOString() };
}
async function session(id) {
  const user = await userRow(id);
  return { access_token: token(user), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: `r-${id}`, user };
}

// Requests are handled one at a time (see server), so role switching is safe.
async function asRole(uid, fn) {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid ?? ''}', false); set role ${uid ? 'authenticated' : 'anon'};`);
  try { return await fn(); } finally { await db.exec('reset role;'); }
}

const IDENT = /^[a-z_][a-z0-9_]*$/;
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
  'Access-Control-Expose-Headers': 'Content-Range',
};
function send(res, status, body) {
  res.writeHead(status, { ...cors, 'Content-Type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}
function pgError(res, e) {
  const status = e.code === '42501' ? 403 : ['23505', '23P01'].includes(e.code) ? 409 : 400;
  send(res, status, { code: e.code, message: e.message, details: e.detail ?? null, hint: e.hint ?? null });
}

function whereFrom(params, args) {
  const conds = [];
  for (const [k, v] of params) {
    if (['select', 'order', 'limit', 'offset', 'columns'].includes(k)) continue;
    if (!IDENT.test(k)) throw Object.assign(new Error(`bad column ${k}`), { code: 'PGRST100' });
    const m = /^(eq|neq|gte|gt|lte|lt|in|is)\.(.*)$/.exec(v);
    if (!m) continue;
    const [, op, val] = m;
    if (op === 'in') { args.push(val.replace(/^\(|\)$/g, '').split(',')); conds.push(`"${k}"::text = any($${args.length}::text[])`); }
    else if (op === 'is') conds.push(`"${k}" is ${val === 'null' ? 'null' : 'not null'}`);
    else { args.push(val); conds.push(`"${k}" ${{ eq: '=', neq: '<>', gte: '>=', gt: '>', lte: '<=', lt: '<' }[op]} $${args.length}`); }
  }
  return conds.length ? ` where ${conds.join(' and ')}` : '';
}

async function rest(req, res, url, body) {
  const uid = claims(req)?.sub ?? null;
  const parts = url.pathname.replace('/rest/v1/', '').split('/');
  const wantsObject = (req.headers.accept ?? '').includes('vnd.pgrst.object');

  if (parts[0] === 'rpc') {
    const fn = parts[1];
    if (!IDENT.test(fn)) return send(res, 404, { message: 'not found' });
    const info = await db.query(`select t.typtype from pg_proc p join pg_type t on t.oid = p.prorettype where p.proname = $1 and p.pronamespace = 'public'::regnamespace`, [fn]);
    if (!info.rows.length) return send(res, 404, { code: 'PGRST202', message: `function ${fn} not found` });
    const args = [];
    const named = Object.entries(body ?? {}).map(([k, v]) => {
      args.push(v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));
      return `${k} => $${args.length}`;
    });
    const composite = info.rows[0].typtype === 'c';
    const sql = composite
      ? `select to_json(r) as v from public.${fn}(${named.join(', ')}) r`
      : `select to_json(public.${fn}(${named.join(', ')})) as v`;
    try {
      const r = await asRole(uid, () => db.query(sql, args));
      return send(res, 200, r.rows[0]?.v ?? null);
    } catch (e) { return pgError(res, e); }
  }

  const table = parts[0];
  if (!IDENT.test(table)) return send(res, 404, {});
  const params = url.searchParams;
  const args = [];
  try {
    if (req.method === 'GET') {
      const cols = (params.get('select') ?? '*').split(',').map((c) => c.trim()).filter(Boolean);
      if (!cols.every((c) => c === '*' || IDENT.test(c))) throw Object.assign(new Error('bad select'), { code: 'PGRST100' });
      let sql = `select ${cols.map((c) => (c === '*' ? '*' : `"${c}"`)).join(', ')} from public."${table}"${whereFrom(params, args)}`;
      const order = params.get('order');
      if (order) sql += ` order by ${order.split(',').map((o) => { const [c, d] = o.split('.'); if (!IDENT.test(c)) throw new Error('bad order'); return `"${c}" ${d === 'desc' ? 'desc' : 'asc'}`; }).join(', ')}`;
      if (params.get('limit')) sql += ` limit ${Number(params.get('limit'))}`;
      if (params.get('offset')) sql += ` offset ${Number(params.get('offset'))}`;
      const r = await asRole(uid, () => db.query(`select coalesce(json_agg(t), '[]'::json) as v from (${sql}) t`, args));
      const rows = r.rows[0].v;
      if (wantsObject) return rows.length === 1 ? send(res, 200, rows[0]) : send(res, 406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' });
      return send(res, 200, rows);
    }
    if (req.method === 'PATCH') {
      const sets = Object.entries(body ?? {}).map(([k, v]) => {
        if (!IDENT.test(k)) throw new Error('bad column');
        args.push(Array.isArray(v) ? `{${v.join(',')}}` : v === null ? null : String(v));
        return `"${k}" = $${args.length}`;
      });
      const r = await asRole(uid, () => db.query(`with u as (update public."${table}" set ${sets.join(', ')}${whereFrom(params, args)} returning *) select coalesce(json_agg(u), '[]'::json) as v from u`, args));
      const rows = r.rows[0].v;
      if (wantsObject) return rows.length === 1 ? send(res, 200, rows[0]) : send(res, 406, { code: 'PGRST116', message: 'no rows' });
      return send(res, 200, rows);
    }
    if (req.method === 'DELETE') {
      await asRole(uid, () => db.query(`delete from public."${table}"${whereFrom(params, args)}`, args));
      return send(res, 204);
    }
  } catch (e) { return pgError(res, e); }
  return send(res, 405, {});
}

async function auth(req, res, url, body) {
  const path = url.pathname.replace('/auth/v1/', '');
  if (path === 'signup' && req.method === 'POST') {
    const exists = await db.query(`select 1 from auth.users where email = $1`, [body.email]);
    if (exists.rows.length) return send(res, 422, { code: 'user_already_exists', msg: 'User already registered', message: 'User already registered' });
    const id = randomUUID();
    await (db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [id, body.email, JSON.stringify(body.data ?? {})]));
    passwords.set(body.email, body.password);
    return send(res, 200, await session(id));
  }
  if (path === 'token') {
    const grant = url.searchParams.get('grant_type');
    if (grant === 'password') {
      const r = await db.query(`select id from auth.users where email = $1`, [body.email]);
      if (!r.rows.length || passwords.get(body.email) !== body.password) {
        return send(res, 400, { code: 'invalid_credentials', error: 'invalid_grant', error_description: 'Invalid login credentials', msg: 'Invalid login credentials', message: 'Invalid login credentials' });
      }
      return send(res, 200, await session(r.rows[0].id));
    }
    if (grant === 'refresh_token') return send(res, 200, await session(String(body.refresh_token).slice(2)));
  }
  const c = claims(req);
  if (path === 'user' && req.method === 'GET') return c ? send(res, 200, await userRow(c.sub)) : send(res, 401, { message: 'invalid JWT' });
  if (path === 'user' && req.method === 'PUT') {
    if (!c) return send(res, 401, { message: 'invalid JWT' });
    if (body.password) passwords.set(c.email, body.password);
    if (body.data) await (db.query(`update auth.users set raw_user_meta_data = raw_user_meta_data || $2::jsonb where id = $1`, [c.sub, JSON.stringify(body.data)]));
    return send(res, 200, await userRow(c.sub));
  }
  if (path === 'logout') return send(res, 204);
  if (path === 'recover') return send(res, 200, {});
  return send(res, 404, { message: `auth ${path} not mocked` });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204);
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : null;
  return serial(() => handle(req, res, url, body));
});

async function handle(req, res, url, body) {
  try {
    if (url.pathname.startsWith('/rest/v1/')) return await rest(req, res, url, body);
    if (url.pathname.startsWith('/auth/v1/')) return await auth(req, res, url, body);
    if (url.pathname === '/functions/v1/send-reminders') return send(res, 200, { devices: 0, delivered: 0 });
    // test helper: run SQL as superuser (inspect state / move reminder times)
    if (url.pathname === '/__admin/sql' && req.method === 'POST') {
      const r = await db.query(body.sql, body.params ?? []);
      return send(res, 200, JSON.parse(JSON.stringify(r.rows)));
    }
    return send(res, 404, { message: 'not found' });
  } catch (e) {
    console.error(e);
    return send(res, 500, { message: String(e) });
  }
}
server.listen(PORT, () => console.log(`mock supabase on http://localhost:${PORT}`));
