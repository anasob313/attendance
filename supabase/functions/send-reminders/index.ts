// Supabase Edge Function: sends due attendance reminders via Web Push.
//
// Called every minute by pg_cron (see supabase/setup/cron.sql) with the
// header `x-cron-secret`. Also:
//  * POST {"type":"test","delaySeconds"?:0-60} — a signed-in user sends a test
//    notification to their own devices (delayed = same format as a real
//    reminder, so it can be checked with the app closed and the phone locked);
//    with x-cron-secret, {"type":"test","userId":…} does the same for support.
//  * POST {"type":"receipt","id","endpoint","error"?} — sent by the device's
//    service worker after it displayed (or failed to display) a notification.
// Every push is recorded in public.push_deliveries with the push service's
// answer and the device receipt. Each cron run also re-sends, once, any
// reminder the device has not confirmed after 2 minutes (watchdog).
//
// Deploy:  supabase functions deploy send-reminders --no-verify-jwt
// Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, CRON_SECRET
// (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.)
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { dispatch, retryUnconfirmed, safeEqual, type SendMeta, type SendOptions, type Subscription } from './dispatch.ts';
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
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

async function sha256hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Send one push to one device and record it (with the push service's answer). */
async function send(sub: Subscription, payload: string, opts: SendOptions, meta: SendMeta) {
  const id = crypto.randomUUID();
  let host = '';
  try { host = new URL(sub.endpoint).host; } catch { /* keep empty */ }
  const { error: logError } = await admin.from('push_deliveries').insert({
    id, user_id: meta.userId, session_id: meta.sessionId, kind: meta.kind, retry_of: meta.retryOf ?? null,
    endpoint_host: host.slice(0, 200), endpoint_hash: await sha256hex(sub.endpoint),
  });
  if (logError) console.error('push_deliveries insert failed', logError.message);
  // The device's service worker sends the receipt for this id.
  const body = JSON.stringify({ ...JSON.parse(payload), deliveryId: logError ? undefined : id });
  try {
    const res = await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      body,
      { TTL: opts.ttlSeconds, urgency: 'high', topic: opts.topic, timeout: 10_000 },
    );
    if (!logError) await admin.from('push_deliveries').update({ push_status: res.statusCode }).eq('id', id);
    return res;
  } catch (e) {
    const err = e as { statusCode?: number; body?: string; message?: string };
    if (!logError) {
      await admin.from('push_deliveries').update({
        push_status: err.statusCode ?? null,
        push_error: `${err.message ?? 'error'} ${err.body ?? ''}`.trim().slice(0, 500),
      }).eq('id', id);
    }
    throw e;
  }
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

async function runRetry() {
  return retryUnconfirmed({
    async claimUnconfirmed() {
      const { data, error } = await admin.rpc('claim_unconfirmed_reminders', { p_wait_seconds: 120 });
      if (error) throw error;
      return data ?? [];
    },
    subscriptions: subscriptionsOf,
    hash: sha256hex,
    send,
    now: () => Date.now(),
    log: (m, x) => console.error(m, x),
  });
}

/** Test notification. delaySeconds > 0 sends it later in the same format as a real reminder. */
async function sendTestTo(userId: string, delaySeconds: number) {
  const subs = await subscriptionsOf(userId);
  if (!subs.length) return json({ error: 'No devices are registered for notifications.' }, 400);
  const asReminder = delaySeconds > 0;
  const payload = JSON.stringify(asReminder
    ? {
        title: 'Attendance reminder (test)',
        body: '20 minutes remaining until you complete your 8 working hours.',
        detail: 'Test only — no attendance record was changed.',
        tag: `test-${Date.now()}`,
        url: '/settings',
      }
    : {
        title: 'Test notification',
        body: 'Notifications are working on this device.',
        tag: `test-${Date.now()}`,
        url: '/settings',
      });
  // Same delivery options as a real reminder (urgency high, a TTL, a topic).
  const opts = { ttlSeconds: asReminder ? 1200 : 300, topic: crypto.randomUUID().replace(/-/g, '') };
  const run = async () => {
    const results = await Promise.allSettled(subs.map((s) => send(s, payload, opts, { userId, sessionId: null, kind: 'test' })));
    let delivered = 0;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'fulfilled') delivered++;
      else if ([404, 410].includes((r.reason as { statusCode?: number })?.statusCode ?? 0)) {
        await admin.from('push_subscriptions').delete().eq('id', subs[i].id);
      }
    }
    return delivered;
  };
  if (!asReminder) {
    const delivered = await run();
    return json({ devices: subs.length, delivered });
  }
  const later = (async () => {
    await new Promise((r) => setTimeout(r, delaySeconds * 1000));
    await run();
  })().catch((e) => console.error('delayed test failed', e));
  if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(later);
  else await later;
  return json({ devices: subs.length, scheduled: true, delaySeconds });
}

async function sendTest(req: Request, body: { delaySeconds?: unknown; userId?: unknown }) {
  const delay = Math.min(60, Math.max(0, Math.floor(Number(body?.delaySeconds) || 0)));
  // Support path (server-side only): the cron secret may test a given user's devices.
  const cron = req.headers.get('x-cron-secret');
  if (cron) {
    if (!safeEqual(cron, CRON_SECRET)) return json({ error: 'Forbidden' }, 403);
    if (typeof body?.userId !== 'string' || !UUID.test(body.userId)) return json({ error: 'userId required' }, 400);
    return sendTestTo(body.userId, delay);
  }
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return json({ error: 'Not signed in' }, 401);
  return sendTestTo(data.user.id, delay);
}

/** Receipt from a device: the notification was displayed (or failed to display). */
async function receipt(body: { id?: unknown; endpoint?: unknown; error?: unknown }) {
  if (typeof body?.id !== 'string' || !UUID.test(body.id) || typeof body?.endpoint !== 'string' || !body.endpoint.startsWith('https://')) {
    return json({ error: 'Bad receipt' }, 400);
  }
  const hash = await sha256hex(body.endpoint);
  const patch = typeof body.error === 'string' && body.error
    ? { display_error: body.error.slice(0, 500) }
    : { displayed_at: new Date().toISOString() };
  const { data, error } = await admin.from('push_deliveries').update(patch)
    .eq('id', body.id).eq('endpoint_hash', hash).is('displayed_at', null).select('id');
  if (error) return json({ error: 'Could not record receipt' }, 500);
  return json({ ok: (data ?? []).length === 1 });
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
    if (body?.type === 'receipt') return await receipt(body);
    if (body?.type === 'test') return await sendTest(req, body);
    if (!safeEqual(req.headers.get('x-cron-secret') ?? '', CRON_SECRET)) return json({ error: 'Forbidden' }, 403);
    const summary = await runDispatch();
    // Watchdog: re-send reminders the device did not confirm (never blocks dispatch).
    const watchdog = await runRetry().catch((e) => {
      console.error('watchdog failed', e);
      return { unconfirmed: 0, resent: 0, notResent: 0, error: String((e as Error)?.message ?? e) };
    });
    if (summary.claimed || watchdog.unconfirmed) console.log('reminders', summary, 'watchdog', watchdog);
    return json({ ...summary, watchdog });
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
