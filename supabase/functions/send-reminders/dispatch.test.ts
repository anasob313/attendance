// deno test --allow-net --allow-env --allow-read supabase/functions/send-reminders/dispatch.test.ts
import { strict as A } from 'node:assert';
const assertEquals = (a: unknown, b: unknown) => A.deepStrictEqual(a, b);
const assert = (v: unknown) => A.ok(v);
import webpush from 'npm:web-push@3.6.7';
import ece from 'npm:http_ece@1.2.0';
import { createECDH, randomBytes } from 'node:crypto';
import { buildPayload, dispatch, safeEqual, type Deps, type DueReminder } from './dispatch.ts';

const reminder = (over: Partial<DueReminder> = {}): DueReminder => ({
  session_id: '11111111-2222-3333-4444-555555555555',
  user_id: 'u1',
  fire_at: '2026-10-29T12:40:00Z',
  clock_in: '2026-10-29T05:00:00Z',       // 08:00 Riyadh
  required_minutes: 480,
  lead_minutes: 20,
  timezone: 'Asia/Riyadh',
  ...over,
});

function fakeDeps(over: Partial<Deps> & { statuses?: number[] } = {}) {
  const log: string[] = [];
  const statuses = over.statuses ?? [201];
  const deps: Deps = {
    claim: async () => [reminder()],
    subscriptions: async () => statuses.map((_, i) => ({ id: `s${i}`, endpoint: `https://push.example/${i}`, p256dh: 'k', auth: 'a' })),
    send: async (sub, _payload, opts) => {
      log.push(`send ${sub.id} ttl=${opts.ttlSeconds} topic=${opts.topic}`);
      const code = statuses[Number(sub.id.slice(1))];
      if (code >= 300) throw Object.assign(new Error(`status ${code}`), { statusCode: code });
    },
    removeSubscription: async (id) => void log.push(`remove ${id}`),
    markDelivered: async (id) => void log.push(`ok ${id}`),
    markFailure: async (id) => void log.push(`fail ${id}`),
    finish: async (sid, outcome) => void log.push(`finish ${outcome}`),
    now: () => Date.parse('2026-10-29T12:40:00Z'),
    ...over,
  };
  return { deps, log };
}

Deno.test('payload text matches the requirement', () => {
  const p = buildPayload(reminder());
  assertEquals(p.body, '20 minutes remaining until you complete your 8 working hours.');
  assertEquals(p.detail, 'Expected completion: 4:00 PM');
  assertEquals(p.tag, 'session-11111111-2222-3333-4444-555555555555');
});

Deno.test('sends to every registered device and removes expired ones', async () => {
  const { deps, log } = fakeDeps({ statuses: [201, 410, 201] });
  const s = await dispatch(deps);
  assertEquals(s.sent, 1);
  assertEquals(s.removedSubscriptions, 1);
  assert(log.includes('remove s1'));
  assert(log.includes('ok s0') && log.includes('ok s2'));
  assert(log.includes('finish sent'));
  // TTL = time left until the 8h are complete (20 min), topic de-duplicates
  assert(log.some((l) => l.includes('ttl=1200 topic=11111111222233334444555555555555')));
});

Deno.test('transient failure on every device → retry, not silently dropped', async () => {
  const { deps, log } = fakeDeps({ statuses: [500, 503] });
  const s = await dispatch(deps);
  assertEquals(s.retried, 1);
  assert(log.includes('finish retry'));
});

Deno.test('no devices → skipped', async () => {
  const { deps, log } = fakeDeps({ subscriptions: async () => [] });
  await dispatch(deps);
  assert(log.includes('finish skipped'));
});

Deno.test('cron secret comparison', () => {
  assert(safeEqual('abc123', 'abc123'));
  assert(!safeEqual('abc123', 'abc124'));
  assert(!safeEqual('', ''));
});

Deno.test('web-push encrypts a payload a browser can decrypt (runs in Deno)', () => {
  const vapid = webpush.generateVAPIDKeys();
  const receiver = createECDH('prime256v1');
  receiver.generateKeys();
  const authSecret = randomBytes(16);
  const sub = {
    endpoint: 'https://web.push.apple.com/QGuQyavXutnMtxm4ss',
    keys: { p256dh: receiver.getPublicKey('base64url'), auth: authSecret.toString('base64url') },
  };
  const payload = JSON.stringify(buildPayload(reminder()));
  const req = webpush.generateRequestDetails(sub, payload, {
    vapidDetails: { subject: 'mailto:test@example.com', publicKey: vapid.publicKey, privateKey: vapid.privateKey },
    TTL: 1200, urgency: 'high', topic: 'abc',
  });
  assertEquals(req.method, 'POST');
  assertEquals(req.headers['Content-Encoding'], 'aes128gcm');
  assertEquals(req.headers.TTL, 1200);
  assert(String(req.headers.Authorization).startsWith('vapid t='));
  const plain = ece.decrypt(Buffer.from(req.body), { version: 'aes128gcm', privateKey: receiver, authSecret });
  assertEquals(JSON.parse(plain.toString()).body, '20 minutes remaining until you complete your 8 working hours.');
});

// ---- secret cleanup (values pasted on a phone) ---------------------------
import { readConfig } from './config.ts';

Deno.test('config: repairs common paste damage and verifies the key pair', () => {
  const kp = webpush.generateVAPIDKeys();
  const good = { VAPID_PUBLIC_KEY: kp.publicKey, VAPID_PRIVATE_KEY: kp.privateKey, VAPID_SUBJECT: 'mailto:a@b.co', CRON_SECRET: 'x'.repeat(64) };
  assertEquals(readConfig((k) => (good as Record<string, string>)[k]).problems, []);
  const damaged = {
    VAPID_PUBLIC_KEY: ` VAPID_PUBLIC_KEY=${kp.publicKey.replace(/--/g, '—').replace(/-/g, '–')}\n`,
    VAPID_PRIVATE_KEY: `"${kp.privateKey}"`,
    VAPID_SUBJECT: ' a@b.co ',
    CRON_SECRET: `CRON_SECRET=${'x'.repeat(64)} `,
  };
  const c = readConfig((k) => (damaged as Record<string, string>)[k]);
  assertEquals(c.problems, []);
  assertEquals(c.publicKey, kp.publicKey);
  assertEquals(c.privateKey, kp.privateKey);
  assertEquals(c.subject, 'mailto:a@b.co');
  assertEquals(c.cronSecret, 'x'.repeat(64));
  webpush.setVapidDetails(c.subject, c.publicKey, c.privateKey);   // accepted by the real library
});

Deno.test('config: reports wrong values without leaking private ones', () => {
  const a = webpush.generateVAPIDKeys();
  const b = webpush.generateVAPIDKeys();
  const c = readConfig((k) => ({ VAPID_PUBLIC_KEY: a.publicKey, VAPID_PRIVATE_KEY: b.privateKey, VAPID_SUBJECT: 'hello', CRON_SECRET: '' } as Record<string, string>)[k]);
  assert(c.problems.some((p) => p.includes('not a matching pair')));
  assert(c.problems.some((p) => p.includes('VAPID_SUBJECT')));
  assert(c.problems.some((p) => p.includes('CRON_SECRET')));
  assert(!c.problems.join(' ').includes(b.privateKey));
});
