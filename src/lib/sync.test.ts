import { describe, expect, it } from 'vitest';
import { applyOps, clearDay, loadQueue, makeOp, memoryQueue, runQueue, saveQueue, type QueuedOp } from './sync';
import { AppError } from './errors';
import type { DataSet } from './types';

const empty: DataSet = { sessions: [], remote: [], leaves: [] };
let n = 0;
const uuid = () => `op-${++n}`;

function memoryKV() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}

describe('optimistic view', () => {
  it('clock in → clock out → undo, offline', () => {
    const ops: QueuedOp[] = [
      makeOp({ kind: 'clock_in', args: { id: 's1', at: '2026-10-29T05:00:00Z', workDate: '2026-10-29', requiredMinutes: 480, timezone: 'Asia/Riyadh', replace: false } }, false, uuid),
      makeOp({ kind: 'clock_out', args: { id: 's1', at: '2026-10-29T13:00:00Z' } }, false, uuid),
    ];
    let v = applyOps(empty, ops);
    expect(v.sessions[0].clock_out).toBe('2026-10-29T13:00:00Z');
    ops.push(makeOp({ kind: 'undo_clock_out', args: { id: 's1' } }, false, uuid));
    v = applyOps(empty, ops);
    expect(v.sessions[0].clock_out).toBeNull();
    expect(v.sessions[0].clock_in).toBe('2026-10-29T05:00:00Z');   // original timestamp preserved
    expect(ops.every((o) => o.state === 'local')).toBe(true);        // "SAVED LOCALLY"
  });

  it('replace removes the conflicting classification and splits leave', () => {
    const data: DataSet = {
      sessions: [], remote: [{ id: 'r', work_date: '2026-10-28' }],
      leaves: [{ id: 'l', leave_type: 'annual', start_date: '2026-10-25', end_date: '2026-10-29', note: '' }],
    };
    const v = clearDay(data, '2026-10-27');
    expect(v.leaves.map((l) => [l.start_date, l.end_date])).toEqual([['2026-10-25', '2026-10-26'], ['2026-10-28', '2026-10-29']]);
    const v2 = applyOps(data, [makeOp({ kind: 'set_remote', args: { date: '2026-10-25', replace: true } }, true, uuid)]);
    expect(v2.remote.map((r) => r.work_date).sort()).toEqual(['2026-10-25', '2026-10-28']);
    expect(v2.leaves[0].start_date).toBe('2026-10-26');
  });

  it('failed operations are not shown as applied', () => {
    const op = { ...makeOp({ kind: 'set_remote', args: { date: '2026-10-25', replace: false } }, true, uuid), state: 'failed' as const };
    expect(applyOps(empty, [op]).remote).toHaveLength(0);
  });
});

describe('queue replay (test cases 18, 19)', () => {
  const clockIn = () => makeOp({ kind: 'clock_in', args: { id: 's1', at: '2026-10-29T05:00:00Z', workDate: '2026-10-29', requiredMinutes: 480, timezone: 'Asia/Riyadh', replace: false } }, false, uuid);
  const clockOut = () => makeOp({ kind: 'clock_out', args: { id: 's1', at: '2026-10-29T13:00:00Z' } }, false, uuid);

  it('network failure keeps everything SAVED LOCALLY, retry later syncs once', async () => {
    const calls: string[] = [];
    let online = false;
    const server = new Map<string, unknown>();
    const exec = async (op: QueuedOp) => {
      calls.push(op.kind);
      if (!online) throw new TypeError('Failed to fetch');
      if (op.kind === 'clock_in') server.set(op.args.id, op.args.at);  // idempotent by id
      return {};
    };
    const ops = [clockIn(), clockOut()];
    const r1 = await runQueue(memoryQueue(ops), exec);
    expect(r1.stoppedBy).toBe('network');
    expect(r1.ops).toHaveLength(2);
    expect(r1.ops.every((o) => o.state === 'local')).toBe(true);
    online = true;
    const r2 = await runQueue(memoryQueue(r1.ops), exec);
    expect(r2.stoppedBy).toBe('done');
    expect(r2.ops).toHaveLength(0);
    expect(r2.synced.map((s) => s.op.kind)).toEqual(['clock_in', 'clock_out']);
    expect(server.size).toBe(1);
    // replaying the same op (lost response) is harmless
    await runQueue(memoryQueue([clockIn()]), exec);
    expect(server.size).toBe(1);
  });

  it('server conflict → SYNC FAILED, queue stops, nothing discarded', async () => {
    const exec = async (op: QueuedOp) => {
      if (op.kind === 'clock_in') throw new AppError('conflict', { code: 'AT409', conflicts: [{ kind: 'remote', id: 'r', date: '2026-10-29' }] });
      return {};
    };
    const r = await runQueue(memoryQueue([clockIn(), clockOut()]), exec);
    expect(r.stoppedBy).toBe('failed');
    expect(r.ops).toHaveLength(2);
    expect(r.ops[0].state).toBe('failed');
    expect(r.ops[0].error?.conflicts?.[0].kind).toBe('remote');
    // a second run does not skip past the failed op
    const r2 = await runQueue(memoryQueue(r.ops), exec);
    expect(r2.ops).toHaveLength(2);
  });

  it('expired sign-in keeps the op pending for after re-login', async () => {
    const exec = async () => { throw new AppError('expired', { code: 'AUTH', auth: true }); };
    const r = await runQueue(memoryQueue([clockIn()]), exec);
    expect(r.stoppedBy).toBe('auth');
    expect(r.ops[0].state).toBe('pending');
  });

  it('actions added during a replay are kept', async () => {
    const store = memoryQueue([clockIn()]);
    const late = clockOut();
    const exec = async (op: QueuedOp) => {
      if (op.kind === 'clock_in') store.set([...store.get(), late]);   // user taps while syncing
      return {};
    };
    const r = await runQueue(store, exec);
    expect(r.synced.map((s) => s.op.kind)).toEqual(['clock_in', 'clock_out']);
    expect(store.get()).toHaveLength(0);
  });

  it('persists per user', () => {
    const kv = memoryKV();
    saveQueue(kv, 'u1', [clockIn()]);
    expect(loadQueue(kv, 'u1')).toHaveLength(1);
    expect(loadQueue(kv, 'u2')).toHaveLength(0);
    saveQueue(kv, 'u1', []);
    expect(loadQueue(kv, 'u1')).toHaveLength(0);
  });
});
