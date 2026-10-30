import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useData } from '../state/data';
import { useUi } from '../state/ui';
import type { QueuedOp } from '../lib/sync';
import { formatDateShort, formatTime } from '../lib/time';
import { describeConflicts } from '../hooks/useActions';
import { IconAlert, IconCalendar, IconChart, IconCheck, IconClock, IconCloudOff, IconList, IconSettings } from './icons';
import { Notice, Sheet, Spinner } from './ui';

const tabs = [
  { to: '/', label: 'Today', icon: IconClock, end: true },
  { to: '/calendar', label: 'Calendar', icon: IconCalendar },
  { to: '/history', label: 'History', icon: IconList },
  { to: '/reports', label: 'Reports', icon: IconChart },
  { to: '/settings', label: 'Settings', icon: IconSettings },
];

export function Layout() {
  const { authExpired } = useData();
  const navigate = useNavigate();
  return (
    <div className="min-h-dvh">
      {authExpired && (
        <div className="pt-safe fixed inset-x-0 top-0 z-40 px-4">
          <Notice tone="error" action={<button className="font-semibold underline" onClick={() => navigate('/login?expired=1')}>Sign in</button>}>
            Your sign-in expired. Unsynced changes are kept on this device.
          </Notice>
        </div>
      )}
      <Outlet />
      <nav className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-black/5 bg-white/85 backdrop-blur-xl dark:border-white/10 dark:bg-zinc-900/85">
        <div className="mx-auto grid max-w-lg grid-cols-5 px-1 pt-1.5">
          {tabs.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end}
              className={({ isActive }) => `flex flex-col items-center gap-0.5 rounded-xl py-1 text-[11px] font-medium ${isActive ? 'text-zinc-900 dark:text-white' : 'text-zinc-400 dark:text-zinc-500'}`}>
              <Icon size={24} />
              {label}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}

export function describeOp(op: QueuedOp, tz: string): string {
  switch (op.kind) {
    case 'clock_in': return `Clock In ${formatDateShort(op.args.workDate)} at ${formatTime(op.args.at, tz)}`;
    case 'clock_out': return `Clock Out at ${formatTime(op.args.at, tz)}`;
    case 'undo_clock_out': return 'Undo Clock Out';
    case 'set_remote': return `Remote Work on ${formatDateShort(op.args.date)}`;
    case 'delete_remote': return `Remove Remote Work on ${formatDateShort(op.args.date)}`;
  }
}

const STATE_LABEL: Record<QueuedOp['state'], string> = { local: 'SAVED LOCALLY', pending: 'SYNC PENDING', failed: 'SYNC FAILED' };

/** Compact sync indicator with a details sheet. */
export function SyncBadge() {
  const data = useData();
  const { confirm, toast } = useUi();
  const [open, setOpen] = useState(false);
  const tz = data.settings.timezone;
  const s = data.syncStatus;

  const badge = s === 'failed'
    ? { cls: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300', icon: <IconAlert size={15} />, text: 'Sync failed' }
    : s === 'local'
      ? { cls: 'bg-orange-100 text-orange-800 dark:bg-orange-500/15 dark:text-orange-300', icon: <IconCloudOff size={15} />, text: 'Saved locally' }
      : s === 'pending' || data.syncing
        ? { cls: 'bg-zinc-200 text-zinc-700 dark:bg-white/10 dark:text-zinc-300', icon: <Spinner className="!h-3.5 !w-3.5" />, text: 'Sync pending' }
        : !data.online
          ? { cls: 'bg-zinc-200 text-zinc-600 dark:bg-white/10 dark:text-zinc-400', icon: <IconCloudOff size={15} />, text: 'Offline' }
          : { cls: 'text-zinc-500 dark:text-zinc-400', icon: <IconCheck size={15} />, text: 'Synced' };

  const resolve = async (op: QueuedOp, action: 'retry' | 'replace' | 'discard') => {
    if (action === 'discard') {
      const ok = await confirm({ title: 'Discard this change?', message: `“${describeOp(op, tz)}” will be removed from this device and never sent to the server.`, confirmLabel: 'DISCARD', destructive: true });
      if (ok) data.discard(op.opId);
      return;
    }
    const r = await data.retry(op.opId, { replace: action === 'replace' });
    if (r.status === 'synced') toast('Synced', { tone: 'success' });
    else if (r.status === 'failed') toast(r.error.message, { tone: 'error' });
  };

  return (
    <>
      <button onClick={() => setOpen(true)} className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${badge.cls}`} aria-label={`Sync status: ${badge.text}`}>
        {badge.icon}{badge.text}
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Sync status">
        <div className="space-y-3">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {data.online ? 'Connected.' : 'Offline — Clock In, Clock Out and Remote Work are saved on this device and sync automatically.'}{' '}
            {data.lastSyncedAt && <>Last confirmed by the server at {formatTime(data.lastSyncedAt, tz)}.</>}
          </p>
          {data.ops.length === 0 && <Notice tone="success">All changes are synced and confirmed by the server.</Notice>}
          {data.ops.map((op) => (
            <div key={op.opId} className="rounded-2xl bg-white p-4 ring-1 ring-black/5 dark:bg-white/5 dark:ring-white/10">
              <div className="flex items-center justify-between gap-2">
                <div className="font-medium">{describeOp(op, tz)}</div>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wide ${op.state === 'failed' ? 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300' : op.state === 'local' ? 'bg-orange-100 text-orange-800 dark:bg-orange-500/20 dark:text-orange-300' : 'bg-zinc-200 text-zinc-700 dark:bg-white/10 dark:text-zinc-300'}`}>
                  {STATE_LABEL[op.state]}
                </span>
              </div>
              <div className="mt-1 text-xs text-zinc-500">Recorded {formatDateShort(op.createdAt.slice(0, 10))} {formatTime(op.createdAt, tz)}</div>
              {op.state === 'failed' && op.error && (
                <div className="mt-2 text-sm text-red-700 dark:text-red-300">
                  {op.error.code === 'AT409' && op.error.conflicts?.length
                    ? describeConflicts(op.error.conflicts, op.kind === 'clock_in' ? 'office' : 'remote', tz).message
                    : op.error.message}
                </div>
              )}
              {op.state === 'failed' && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {op.error?.code === 'AT409' && (op.kind === 'clock_in' || op.kind === 'set_remote')
                    ? <button className="btn-primary !min-h-10 text-sm" onClick={() => resolve(op, 'replace')}>Replace</button>
                    : <button className="btn-primary !min-h-10 text-sm" onClick={() => resolve(op, 'retry')}>Retry</button>}
                  <button className="btn-secondary !min-h-10 text-sm" onClick={() => resolve(op, 'discard')}>Discard</button>
                </div>
              )}
            </div>
          ))}
          {data.ops.some((o) => o.state !== 'failed') && data.online && (
            <button className="btn-secondary w-full" onClick={() => data.retry(data.ops[0].opId)}>Sync now</button>
          )}
        </div>
      </Sheet>
    </>
  );
}
