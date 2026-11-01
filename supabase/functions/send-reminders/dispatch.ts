// Reminder dispatch logic, kept free of I/O so it can be unit-tested.
// index.ts wires it to Supabase (service role) and the web-push library.

export interface DueReminder {
  session_id: string;
  user_id: string;
  fire_at: string;
  clock_in: string;
  required_minutes: number;
  lead_minutes: number;
  timezone: string;
}

export interface Subscription {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface SendOptions {
  ttlSeconds: number;
  topic: string;
}

/** Who/what a push is for (used to record the delivery). */
export interface SendMeta {
  userId: string;
  sessionId: string | null;
  kind: 'reminder' | 'test';
  /** Set when this push re-sends an unconfirmed reminder delivery. */
  retryOf?: string;
}

export interface Deps {
  claim(): Promise<DueReminder[]>;
  subscriptions(userId: string): Promise<Subscription[]>;
  /** Resolves on 2xx; rejects with an error carrying `statusCode` otherwise. */
  send(sub: Subscription, payload: string, opts: SendOptions, meta: SendMeta): Promise<unknown>;
  removeSubscription(id: string): Promise<void>;
  markDelivered(id: string): Promise<void>;
  markFailure(id: string): Promise<void>;
  finish(sessionId: string, outcome: 'sent' | 'retry' | 'failed' | 'skipped', error?: string): Promise<void>;
  now(): number;
  log?(msg: string, extra?: unknown): void;
}

export function hoursLabel(minutes: number): string {
  const h = minutes / 60;
  return Number.isInteger(h) ? String(h) : (Math.round(h * 100) / 100).toString();
}

export function buildPayload(r: DueReminder) {
  const completeAt = new Date(Date.parse(r.clock_in) + r.required_minutes * 60_000);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: r.timezone, hour: 'numeric', minute: '2-digit', hour12: true }).format(completeAt);
  return {
    title: 'Attendance reminder',
    body: `${r.lead_minutes} minutes remaining until you complete your ${hoursLabel(r.required_minutes)} working hours.`,
    detail: `Expected completion: ${time}`,
    tag: `session-${r.session_id}`,     // one notification per session on the device
    url: '/',
    completeAt: completeAt.toISOString(),
  };
}

const GONE = new Set([404, 410]);

export async function dispatch(deps: Deps) {
  const due = await deps.claim();
  const summary = { claimed: due.length, sent: 0, skipped: 0, retried: 0, failed: 0, removedSubscriptions: 0 };

  for (const r of due) {
    try {
      const subs = await deps.subscriptions(r.user_id);
      if (!subs.length) {
        await deps.finish(r.session_id, 'skipped', 'no registered devices');
        summary.skipped++;
        continue;
      }
      const payload = JSON.stringify(buildPayload(r));
      const completeAt = Date.parse(r.clock_in) + r.required_minutes * 60_000;
      // After the 8 hours are complete the reminder is pointless: let the
      // push service drop it instead of delivering it late.
      const ttlSeconds = Math.max(60, Math.floor((completeAt - deps.now()) / 1000));
      const topic = r.session_id.replace(/-/g, '').slice(0, 32);

      const results = await Promise.allSettled(subs.map((s) => deps.send(s, payload, { ttlSeconds, topic }, { userId: r.user_id, sessionId: r.session_id, kind: 'reminder' })));
      let delivered = 0;
      let gone = 0;
      const errors: string[] = [];
      for (let i = 0; i < results.length; i++) {
        const res = results[i];
        const sub = subs[i];
        if (res.status === 'fulfilled') {
          delivered++;
          await deps.markDelivered(sub.id);
          continue;
        }
        const code = (res.reason as { statusCode?: number })?.statusCode;
        if (code && GONE.has(code)) {
          gone++;
          await deps.removeSubscription(sub.id);             // expired / unsubscribed device
        } else {
          errors.push(`${code ?? 'network'}: ${String((res.reason as Error)?.message ?? res.reason).slice(0, 120)}`);
          await deps.markFailure(sub.id);
        }
      }
      summary.removedSubscriptions += gone;
      if (delivered > 0) {
        await deps.finish(r.session_id, 'sent');
        summary.sent++;
      } else if (gone === subs.length) {
        await deps.finish(r.session_id, 'skipped', 'all devices unsubscribed');
        summary.skipped++;
      } else {
        await deps.finish(r.session_id, 'retry', errors.join(' | '));
        summary.retried++;
      }
    } catch (e) {
      deps.log?.('dispatch error', e);
      await deps.finish(r.session_id, 'retry', String((e as Error)?.message ?? e)).catch(() => {});
      summary.failed++;
    }
  }
  return summary;
}

/** A reminder delivery accepted by the push service but never confirmed by the device. */
export interface Unconfirmed {
  delivery_id: string;
  user_id: string;
  session_id: string;
  endpoint_hash: string;
  clock_in: string;
  clock_out: string | null;
  required_minutes: number;
  lead_minutes: number;
  timezone: string;
}

export interface RetryDeps {
  claimUnconfirmed(): Promise<Unconfirmed[]>;
  subscriptions(userId: string): Promise<Subscription[]>;
  hash(endpoint: string): Promise<string>;
  send(sub: Subscription, payload: string, opts: SendOptions, meta: SendMeta): Promise<unknown>;
  now(): number;
  log?(msg: string, extra?: unknown): void;
}

/**
 * Re-send, once, each reminder the device did not confirm. Same payload and tag
 * as the original (the phone replaces rather than duplicates it). Skipped when
 * the session is closed, the 8 hours are (almost) complete, or the device is gone.
 */
export async function retryUnconfirmed(deps: RetryDeps) {
  const list = await deps.claimUnconfirmed();
  const summary = { unconfirmed: list.length, resent: 0, notResent: 0 };
  for (const u of list) {
    try {
      const completeAt = Date.parse(u.clock_in) + u.required_minutes * 60_000;
      if (u.clock_out || completeAt - deps.now() < 60_000) { summary.notResent++; continue; }
      const subs = await deps.subscriptions(u.user_id);
      let target: Subscription | undefined;
      for (const s of subs) if ((await deps.hash(s.endpoint)) === u.endpoint_hash) { target = s; break; }
      if (!target) { summary.notResent++; continue; }
      const payload = JSON.stringify(buildPayload({
        session_id: u.session_id, user_id: u.user_id, fire_at: '', clock_in: u.clock_in,
        required_minutes: u.required_minutes, lead_minutes: u.lead_minutes, timezone: u.timezone,
      }));
      await deps.send(target, payload,
        { ttlSeconds: Math.max(60, Math.floor((completeAt - deps.now()) / 1000)), topic: u.session_id.replace(/-/g, '').slice(0, 32) },
        { userId: u.user_id, sessionId: u.session_id, kind: 'reminder', retryOf: u.delivery_id });
      summary.resent++;
    } catch (e) {
      deps.log?.('retry error', e);
      summary.notResent++;
    }
  }
  return summary;
}

/** Constant-time string comparison for the cron shared secret. */
export function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0 && a.length > 0;
}
