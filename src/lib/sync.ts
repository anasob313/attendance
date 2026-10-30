// Offline queue for the actions that are safe to perform offline:
// Clock In, Clock Out, Undo Clock Out, Remote Work on/off.
//
// * Every action is written to localStorage BEFORE any network call, with
//   the original timestamp of the tap, so nothing is lost if the app is
//   closed or the connection drops.
// * Actions are replayed in order. Each server call is idempotent (client
//   generated session ids / per-day remote rows), so a retry after a lost
//   response can never create a duplicate.
// * A server-side rejection (e.g. a conflict created on another device)
//   marks the action SYNC FAILED and stops the queue; the user chooses
//   Retry, Replace or Discard. Nothing is dropped silently.
import type { Conflict, DataSet } from './types';
import type { Leave, RemoteDay, Session } from './types';
import { type AppError, toAppError } from './errors';
import { addDays } from './time';

export interface OpArgs {
  clock_in: { id: string; at: string; workDate: string; requiredMinutes: number; timezone: string; replace: boolean };
  clock_out: { id: string; at: string };
  undo_clock_out: { id: string };
  set_remote: { date: string; replace: boolean };
  delete_remote: { date: string };
}
export type OpKind = keyof OpArgs;
export type OpState = 'local' | 'pending' | 'failed';
export interface OpError { message: string; code: string; conflicts?: Conflict[] }

export type QueuedOp = {
  [K in OpKind]: {
    opId: string;
    kind: K;
    args: OpArgs[K];
    createdAt: string;
    state: OpState;
    attempts: number;
    error?: OpError;
  }
}[OpKind];

export type NewOp = { [K in OpKind]: { kind: K; args: OpArgs[K] } }[OpKind];

export function makeOp(op: NewOp, online: boolean, uuid: () => string = () => crypto.randomUUID()): QueuedOp {
  return { ...op, opId: uuid(), createdAt: new Date().toISOString(), state: online ? 'pending' : 'local', attempts: 0 } as QueuedOp;
}

// ---------------------------------------------------------------------
// Local mirror of the server's "replace" rule, for the optimistic view
// ---------------------------------------------------------------------
export function clearDay(data: DataSet, date: string, keepId?: string): DataSet {
  const leaves: Leave[] = [];
  for (const l of data.leaves) {
    if (l.id === keepId || l.start_date > date || l.end_date < date) { leaves.push(l); continue; }
    if (l.start_date < date) leaves.push({ ...l, id: `${l.id}:a`, end_date: addDays(date, -1) });
    if (l.end_date > date) leaves.push({ ...l, id: `${l.id}:b`, start_date: addDays(date, 1) });
  }
  return {
    sessions: data.sessions.filter((s) => s.work_date !== date || s.id === keepId),
    remote: data.remote.filter((r) => r.work_date !== date || r.id === keepId),
    leaves,
  };
}

/** Server data with not-yet-confirmed actions applied on top. */
export function applyOps(data: DataSet, ops: QueuedOp[]): DataSet {
  let v: DataSet = { sessions: [...data.sessions], remote: [...data.remote], leaves: [...data.leaves] };
  for (const op of ops) {
    if (op.state === 'failed') continue;
    switch (op.kind) {
      case 'clock_in': {
        const a = op.args;
        if (v.sessions.some((s) => s.id === a.id)) break;
        if (a.replace) v = clearDay(v, a.workDate);
        v.sessions.push({
          id: a.id, work_date: a.workDate, clock_in: a.at, clock_out: null,
          required_minutes: a.requiredMinutes, timezone: a.timezone,
        });
        break;
      }
      case 'clock_out':
        v.sessions = v.sessions.map((s) => (s.id === op.args.id && !s.clock_out ? { ...s, clock_out: op.args.at } : s));
        break;
      case 'undo_clock_out':
        v.sessions = v.sessions.map((s) => (s.id === op.args.id ? { ...s, clock_out: null } : s));
        break;
      case 'set_remote': {
        const d = op.args.date;
        if (v.remote.some((r) => r.work_date === d)) break;
        if (op.args.replace) v = clearDay(v, d);
        v.remote.push({ id: `local:${op.opId}`, work_date: d });
        break;
      }
      case 'delete_remote':
        v.remote = v.remote.filter((r) => r.work_date !== op.args.date);
        break;
    }
  }
  return v;
}

export interface OpResult { session?: Session; remote?: RemoteDay; deletedRemoteDate?: string; replaced?: boolean }
export type Executor = (op: QueuedOp) => Promise<OpResult>;

export interface RunOutcome {
  ops: QueuedOp[];
  synced: { op: QueuedOp; result: OpResult }[];
  stoppedBy: 'done' | 'network' | 'auth' | 'failed';
  error?: AppError;
}

/** Where the queue lives. Reads always return the latest list, so actions
 *  added while a replay is running are never overwritten. */
export interface QueueStore { get(): QueuedOp[]; set(ops: QueuedOp[]): void }

export function memoryQueue(initial: QueuedOp[] = []): QueueStore {
  let ops = initial;
  return { get: () => ops, set: (v) => { ops = v; } };
}

/** Replay queued operations in order, one at a time. */
export async function runQueue(store: QueueStore, exec: Executor): Promise<RunOutcome> {
  const synced: RunOutcome['synced'] = [];
  const update = (opId: string, f: (o: QueuedOp) => QueuedOp) =>
    store.set(store.get().map((o) => (o.opId === opId ? f(o) : o)));

  for (;;) {
    const head = store.get()[0];
    if (!head) return { ops: store.get(), synced, stoppedBy: 'done' };
    if (head.state === 'failed') return { ops: store.get(), synced, stoppedBy: 'failed' };
    update(head.opId, (o) => ({ ...o, state: 'pending', attempts: o.attempts + 1, error: undefined }) as QueuedOp);
    const current = store.get().find((o) => o.opId === head.opId)!;
    try {
      const result = await exec(current);
      synced.push({ op: current, result });
      store.set(store.get().filter((o) => o.opId !== head.opId));
    } catch (e) {
      const err = toAppError(e);
      if (err.network) {
        store.set(store.get().map((o) => (o.state === 'failed' ? o : ({ ...o, state: 'local' }) as QueuedOp)));
        return { ops: store.get(), synced, stoppedBy: 'network', error: err };
      }
      if (err.auth) return { ops: store.get(), synced, stoppedBy: 'auth', error: err };
      update(head.opId, (o) => ({ ...o, state: 'failed', error: { message: err.message, code: err.code, conflicts: err.conflicts } }) as QueuedOp);
      return { ops: store.get(), synced, stoppedBy: 'failed', error: err };
    }
  }
}

// ---------------------------------------------------------------------
// Persistence (per user, so a shared device never mixes accounts)
// ---------------------------------------------------------------------
export interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

export const queueKey = (uid: string) => `attendance:v1:${uid}:queue`;
export const cacheKey = (uid: string) => `attendance:v1:${uid}:snapshot`;

export function loadQueue(kv: KV, uid: string): QueuedOp[] {
  try {
    const raw = kv.getItem(queueKey(uid));
    const ops = raw ? (JSON.parse(raw) as QueuedOp[]) : [];
    return Array.isArray(ops) ? ops : [];
  } catch {
    return [];
  }
}

export function saveQueue(kv: KV, uid: string, ops: QueuedOp[]) {
  if (ops.length) kv.setItem(queueKey(uid), JSON.stringify(ops));
  else kv.removeItem(queueKey(uid));
}
