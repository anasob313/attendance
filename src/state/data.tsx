// App data store: server snapshot (cached for offline use) + offline queue.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { AppError, toAppError } from '../lib/errors';
import {
  applyOps, cacheKey, loadQueue, makeOp, runQueue, saveQueue,
  type NewOp, type OpResult, type QueuedOp,
} from '../lib/sync';
import { DEFAULT_SETTINGS, type DataSet, type Profile, type Settings, type Snapshot } from '../lib/types';
import { supabase } from '../lib/supabase';
import { currentEndpoint } from '../lib/push';

export type SyncStatus = 'synced' | 'pending' | 'local' | 'failed';
export type PerformResult =
  | { status: 'synced' }
  | { status: 'saved_locally' }
  | { status: 'failed'; error: AppError; opId: string };

interface DataApi {
  userId: string;
  email: string;
  loading: boolean;
  loadError: string | null;
  snapshot: Snapshot;
  view: DataSet;
  settings: Settings;
  profile: Profile | null;
  ops: QueuedOp[];
  online: boolean;
  syncing: boolean;
  syncStatus: SyncStatus;
  lastSyncedAt: string | null;
  authExpired: boolean;
  /** Why online-only editing is unavailable right now (null = allowed). */
  editBlockedReason: string | null;
  refresh(): Promise<void>;
  perform(op: NewOp): Promise<PerformResult>;
  retry(opId: string, opts?: { replace?: boolean }): Promise<PerformResult>;
  discard(opId: string): void;
  runOnline<T>(fn: () => Promise<T>): Promise<T>;
  patchSnapshot(p: Partial<Snapshot>): void;
  signOut(): Promise<void>;
}

const Ctx = createContext<DataApi | null>(null);

const emptySnapshot = (): Snapshot => ({
  sessions: [], remote: [], leaves: [], reminders: [], settings: DEFAULT_SETTINGS, profile: null, fetchedAt: null,
});

function readCache(uid: string): Snapshot | null {
  try {
    const raw = localStorage.getItem(cacheKey(uid));
    return raw ? { ...emptySnapshot(), ...(JSON.parse(raw) as Snapshot) } : null;
  } catch {
    return null;
  }
}

function writeCache(uid: string, s: Snapshot) {
  try { localStorage.setItem(cacheKey(uid), JSON.stringify(s)); } catch { /* storage full: data is still on the server */ }
}

export function DataProvider({ userId, email, children }: { userId: string; email: string; children: ReactNode }) {
  const cached = useMemo(() => readCache(userId), [userId]);
  const [snapshot, setSnapshot] = useState<Snapshot>(cached ?? emptySnapshot());
  const [loading, setLoading] = useState(!cached);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ops, setOps] = useState<QueuedOp[]>(() => loadQueue(localStorage, userId));
  const [navOnline, setNavOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const [reachable, setReachable] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(cached?.fetchedAt ?? null);
  const [authExpired, setAuthExpired] = useState(false);

  const opsRef = useRef(ops);
  const snapRef = useRef(snapshot);
  const flushLock = useRef<Promise<void> | null>(null);
  const lastRefresh = useRef(0);

  const commitOps = useCallback((next: QueuedOp[]) => {
    opsRef.current = next;
    saveQueue(localStorage, userId, next);      // persisted before/after every step
    setOps(next);
  }, [userId]);

  const commitSnapshot = useCallback((next: Snapshot) => {
    snapRef.current = next;
    writeCache(userId, next);
    setSnapshot(next);
  }, [userId]);

  const patchSnapshot = useCallback((p: Partial<Snapshot>) => commitSnapshot({ ...snapRef.current, ...p }), [commitSnapshot]);

  const online = navOnline && reachable;

  const handleError = useCallback((err: AppError) => {
    if (err.network) setReachable(false);
    if (err.auth) setAuthExpired(true);
  }, []);

  const refresh = useCallback(async () => {
    lastRefresh.current = Date.now();
    try {
      const data = await api.fetchEverything();
      setReachable(true);
      setAuthExpired(false);
      setLoadError(null);
      const now = new Date().toISOString();
      commitSnapshot({ ...data, fetchedAt: now });
      setLastSyncedAt(now);
    } catch (e) {
      const err = toAppError(e);
      handleError(err);
      if (!err.network && !err.auth) setLoadError(err.message);
    } finally {
      setLoading(false);
    }
  }, [commitSnapshot, handleError]);

  const applyResult = useCallback((op: QueuedOp, r: OpResult) => {
    const s = snapRef.current;
    let sessions = s.sessions;
    let remote = s.remote;
    if (r.session) sessions = [...sessions.filter((x) => x.id !== r.session!.id), r.session];
    if (r.remote) remote = [...remote.filter((x) => x.work_date !== r.remote!.work_date), r.remote];
    if (r.deletedRemoteDate) remote = remote.filter((x) => x.work_date !== r.deletedRemoteDate);
    if (op.kind === 'set_remote' && r.replaced) sessions = sessions.filter((x) => x.work_date !== op.args.date);
    if (op.kind === 'clock_in' && r.replaced) remote = remote.filter((x) => x.work_date !== op.args.workDate);
    commitSnapshot({ ...s, sessions, remote });
  }, [commitSnapshot]);

  const execute = useCallback(async (op: QueuedOp): Promise<OpResult> => {
    switch (op.kind) {
      case 'clock_in':
        return { session: await api.clockIn(op.args.id, op.args.at, op.args.replace), replaced: op.args.replace };
      case 'clock_out':
        return { session: await api.clockOut(op.args.id, op.args.at) };
      case 'undo_clock_out':
        return { session: await api.undoClockOut(op.args.id) };
      case 'set_remote':
        return { remote: await api.setRemote(op.args.date, op.args.replace), replaced: op.args.replace };
      case 'delete_remote':
        await api.deleteRemote(op.args.date);
        return { deletedRemoteDate: op.args.date };
    }
  }, []);

  const flush = useCallback(async (): Promise<void> => {
    while (flushLock.current) await flushLock.current;
    if (!opsRef.current.length) return;
    const run = (async () => {
      setSyncing(true);
      try {
        const outcome = await runQueue({ get: () => opsRef.current, set: commitOps }, async (op) => {
          const r = await execute(op);
          applyResult(op, r);
          return r;
        });
        if (outcome.error) handleError(outcome.error);
        if (outcome.stoppedBy !== 'network') setReachable(true);
        if (outcome.synced.length) {
          setLastSyncedAt(new Date().toISOString());
          // a replace or reminder change happened server-side: pull the truth
          void refresh();
        }
      } finally {
        setSyncing(false);
      }
    })();
    flushLock.current = run;
    try { await run; } finally { if (flushLock.current === run) flushLock.current = null; }
  }, [applyResult, commitOps, execute, handleError, refresh]);

  const resultFor = useCallback((opId: string): PerformResult => {
    const op = opsRef.current.find((o) => o.opId === opId);
    if (!op) return { status: 'synced' };
    if (op.state === 'failed') {
      return { status: 'failed', opId, error: new AppError(op.error?.message ?? 'Sync failed', { code: op.error?.code, conflicts: op.error?.conflicts }) };
    }
    return { status: 'saved_locally' };
  }, []);

  const perform = useCallback(async (newOp: NewOp): Promise<PerformResult> => {
    const op = makeOp(newOp, navigator.onLine && reachable);
    commitOps([...opsRef.current, op]);          // saved on the device first
    if (!navigator.onLine) return { status: 'saved_locally' };
    await flush();
    return resultFor(op.opId);
  }, [commitOps, flush, reachable, resultFor]);

  const retry = useCallback(async (opId: string, opts: { replace?: boolean } = {}) => {
    commitOps(opsRef.current.map((o) => {
      if (o.opId !== opId) return o;
      const args = opts.replace && 'replace' in o.args ? { ...o.args, replace: true } : o.args;
      return { ...o, args, state: 'pending', error: undefined } as QueuedOp;
    }));
    setReachable(true);
    await flush();
    return resultFor(opId);
  }, [commitOps, flush, resultFor]);

  const discard = useCallback((opId: string) => {
    commitOps(opsRef.current.filter((o) => o.opId !== opId));
  }, [commitOps]);

  const editBlockedReason = !online
    ? 'You are offline. This change needs an internet connection and will be available when you are back online.'
    : ops.length
      ? 'Finish syncing your pending changes first.'
      : null;

  const runOnline = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    if (opsRef.current.length && navigator.onLine) await flush();
    if (!navigator.onLine) throw new AppError('You are offline. This change needs an internet connection.', { network: true, code: 'NETWORK' });
    if (opsRef.current.length) throw new AppError('Finish syncing your pending changes first (see the sync status at the top).');
    try {
      const r = await fn();
      setReachable(true);
      await refresh();
      return r;
    } catch (e) {
      const err = toAppError(e);
      handleError(err);
      throw err;
    }
  }, [flush, handleError, refresh]);

  const signOut = useCallback(async () => {
    try {
      const ep = await currentEndpoint();
      if (ep) await api.unregisterPush(ep);     // this device stops getting this account's reminders
    } catch { /* offline: the server drops it when the next user registers this device */ }
    try { localStorage.removeItem(cacheKey(userId)); } catch { /* ignore */ }
    await supabase.auth.signOut({ scope: 'local' });
  }, [userId]);

  // ---- lifecycle -------------------------------------------------------
  useEffect(() => {
    void (async () => {
      if (navigator.onLine) {
        await flush();
        await refresh();
      } else {
        setLoading(false);
      }
    })();
    const onOnline = () => { setNavOnline(true); setReachable(true); void flush().then(refresh); };
    const onOffline = () => setNavOnline(false);
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || !navigator.onLine) return;
      void flush();
      if (Date.now() - lastRefresh.current > 15_000) void refresh();
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && navigator.onLine) {
        void flush();
        if (Date.now() - lastRefresh.current > 110_000) void refresh();
      }
    }, 30_000);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const view = useMemo(() => applyOps(snapshot, ops), [snapshot, ops]);
  const syncStatus: SyncStatus = ops.some((o) => o.state === 'failed') ? 'failed'
    : ops.some((o) => o.state === 'local') ? 'local'
      : ops.length ? 'pending' : 'synced';

  const value: DataApi = {
    userId, email, loading, loadError, snapshot, view,
    settings: snapshot.settings, profile: snapshot.profile, ops,
    online, syncing, syncStatus, lastSyncedAt, authExpired, editBlockedReason,
    refresh, perform, retry, discard, runOnline, patchSnapshot, signOut,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useData() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useData outside DataProvider');
  return v;
}
