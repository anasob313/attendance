// Supabase Edge Function: sends due attendance reminders via Web Push.
//
// Called every minute by pg_cron (see supabase/setup/cron.sql) with the
// header `x-cron-secret`. Also offers POST {"type":"test"} for a signed-in
// user to send a test notification to their own devices.
//
// Deploy:  supabase functions deploy send-reminders --no-verify-jwt
// Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, CRON_SECRET
// (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.)
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { dispatch, safeEqual, type Subscription } from './dispatch.ts';
import { readConfig } from './config.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SERVICE_ROLE_KEY') ?? '';
const config = readConfig((k) => Deno.env.get(k));
const CRON_SECRET = config.cronSecret;

// Never crash at start-up: a bad secret is reported in the response instead.
let configError: string | null = config.problems.length ? config.problems.join('; ') : null;
if (!configError) {
  try {
    webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  } catch (e) {
    configError = `VAPID setup failed: ${String((e as Error)?.message ?? e)}`;
  }
}
if (configError) console.error('send-reminders misconfigured:', configError);

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

function send(sub: Subscription, payload: string, opts: { ttlSeconds: number; topic: string }) {
  return webpush.sendNotification(
    { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
    payload,
    { TTL: opts.ttlSeconds, urgency: 'high', topic: opts.topic, timeout: 10_000 },
  );
}

async function subscriptionsOf(userId: string): Promise<Subscription[]> {
  const { data, error } = await admin.from('push_subscriptions').select('id, endpoint, p256dh, auth').eq('user_id', userId);
  if (error) throw error;
  return data ?? [];
}

async function runDispatch() {
  return dispatch({
    async claim() {
      const { data, error } = await admin.rpc('claim_due_reminders', { p_limit: 200 });
      if (error) throw error;
      return data ?? [];
    },
    subscriptions: subscriptionsOf,
    send,
    async removeSubscription(id) {
      await admin.from('push_subscriptions').delete().eq('id', id);
    },
    async markDelivered(id) {
      await admin.from('push_subscriptions').update({ last_success_at: new Date().toISOString(), failure_count: 0 }).eq('id', id);
    },
    async markFailure(id) {
      const { data } = await admin.from('push_subscriptions').select('failure_count').eq('id', id).maybeSingle();
      const n = (data?.failure_count ?? 0) + 1;
      // A device that keeps failing for weeks is almost certainly gone.
      if (n >= 20) await admin.from('push_subscriptions').delete().eq('id', id);
      else await admin.from('push_subscriptions').update({ failure_count: n }).eq('id', id);
    },
    async finish(sessionId, outcome, error) {
      const { error: e } = await admin.rpc('finish_reminder', { p_session: sessionId, p_outcome: outcome, p_error: error ?? null });
      if (e) throw e;
    },
    now: () => Date.now(),
    log: (m, x) => console.error(m, x),
  });
}

async function sendTest(req: Request) {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return json({ error: 'Not signed in' }, 401);
  const subs = await subscriptionsOf(data.user.id);
  if (!subs.length) return json({ error: 'No devices are registered for notifications.' }, 400);
  const payload = JSON.stringify({
    title: 'Test notification',
    body: 'Notifications are working on this device.',
    tag: `test-${Date.now()}`,
    url: '/settings',
  });
  const results = await Promise.allSettled(subs.map((s) => send(s, payload, { ttlSeconds: 300, topic: 'test' })));
  let delivered = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') delivered++;
    else if ([404, 410].includes((r.reason as { statusCode?: number })?.statusCode ?? 0)) {
      await admin.from('push_subscriptions').delete().eq('id', subs[i].id);
    }
  }
  return json({ devices: subs.length, delivered });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return json({ error: 'Function is not configured (missing Supabase environment).' }, 500);
  }
  if (configError) return json({ error: 'Function is not configured', problems: config.problems.length ? config.problems : [configError] }, 500);
  const body = await req.json().catch(() => ({}));
  try {
    if (body?.type === 'test') return await sendTest(req);
    if (!safeEqual(req.headers.get('x-cron-secret') ?? '', CRON_SECRET)) return json({ error: 'Forbidden' }, 403);
    const summary = await runDispatch();
    if (summary.claimed) console.log('reminders', summary);
    return json(summary);
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
