import { useState } from 'react';
import { api } from '../lib/api';
import { buildIndex, classifyDay, sessionMinutes } from '../lib/attendance';
import { formatDateLong, formatDateShort, formatMinutes, formatTime, formatTimeOnDate, todayIn } from '../lib/time';
import { KIND_LABEL } from '../lib/types';
import { useData } from '../state/data';
import { useActions } from '../hooks/useActions';
import { LeaveForm, SessionForm } from './forms';
import { IconEdit, IconLaptop, IconPalm, IconPlus, IconTrash, IconUndo } from './icons';
import { Notice, Sheet, Spinner, StatusPill } from './ui';

type Mode = 'view' | 'session' | 'leave' | 'moveRemote';

export function DayEditor({ date, onClose }: { date: string | null; onClose: () => void }) {
  return (
    <Sheet open={!!date} onClose={onClose} title={date ? formatDateLong(date) : ''}>
      {date && <DayEditorBody key={date} date={date} onClose={onClose} />}
    </Sheet>
  );
}

function DayEditorBody({ date, onClose }: { date: string; onClose: () => void }) {
  const data = useData();
  const { run, report, confirm, toast, withReplace } = useActions();
  const tz = data.settings.timezone;
  const today = todayIn(tz);
  const info = classifyDay(date, buildIndex(data.view), data.settings, today);
  const [mode, setMode] = useState<Mode>('view');
  const [busy, setBusy] = useState(false);
  const [moveTo, setMoveTo] = useState(date);
  const s = info.session;
  const blocked = data.editBlockedReason;

  const guard = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); } catch (e) { report(e); } finally { setBusy(false); }
  };

  if (mode === 'session') {
    return (
      <div className="space-y-4">
        <button className="btn-ghost -ml-3" onClick={() => setMode('view')}>‹ Back</button>
        <SessionForm session={s} date={date} onDone={onClose} />
      </div>
    );
  }
  if (mode === 'leave') {
    return (
      <div className="space-y-4">
        <button className="btn-ghost -ml-3" onClick={() => setMode('view')}>‹ Back</button>
        <LeaveForm leave={info.leave} defaultDate={date} onDone={onClose} />
      </div>
    );
  }
  if (mode === 'moveRemote' && info.remote) {
    return (
      <div className="space-y-4">
        <button className="btn-ghost -ml-3" onClick={() => setMode('view')}>‹ Back</button>
        <label className="field"><span className="label">Move Remote Work to</span>
          <input type="date" className="input" value={moveTo} onChange={(e) => setMoveTo(e.target.value)} />
        </label>
        {blocked && <Notice tone="warn">{blocked}</Notice>}
        <button className="btn-primary w-full" disabled={busy || !moveTo || moveTo === date || !!blocked}
          onClick={() => guard(async () => {
            const res = await withReplace((r) => api.setRemote(moveTo, r, info.remote!.id.startsWith('local:') ? null : info.remote!.id), 'remote');
            if (res) { toast('Remote Work moved', { tone: 'success' }); onClose(); }
          })}>
          {busy ? <Spinner /> : 'Save'}
        </button>
      </div>
    );
  }

  const worked = s ? sessionMinutes(s) : null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill status={info.status} />
        {!info.isWorkingDay && info.status !== 'weekend' && <span className="text-xs text-zinc-500">Weekend day</span>}
      </div>

      {/* Office attendance -------------------------------------------- */}
      {s && (
        <section className="card !p-4">
          <div className="text-sm font-semibold text-zinc-500">Office Attendance</div>
          <div className="mt-2 grid grid-cols-3 gap-2 text-center">
            <div><div className="text-xs text-zinc-500">Clock In</div><div className="tabular font-semibold">{formatTime(s.clock_in, tz)}</div></div>
            <div><div className="text-xs text-zinc-500">Clock Out</div><div className="tabular font-semibold">{s.clock_out ? formatTimeOnDate(s.clock_out, tz, date) : '—'}</div></div>
            <div><div className="text-xs text-zinc-500">Worked</div><div className="tabular font-semibold">{worked !== null ? formatMinutes(worked) : 'Pending'}</div></div>
          </div>
          {info.shortfallMinutes > 0 && <p className="mt-2 text-center text-sm text-red-600 dark:text-red-400">Short by {formatMinutes(info.shortfallMinutes)}</p>}
          <div className="mt-4 grid gap-2">
            {!s.clock_out && (
              <button className="btn-primary" disabled={busy} onClick={() => guard(async () => {
                if (await run({ kind: 'clock_out', args: { id: s.id, at: new Date().toISOString() } }, 'office', 'Clocked out')) onClose();
              })}>Clock Out now</button>
            )}
            <button className="btn-secondary" onClick={() => setMode('session')}><IconEdit size={18} />{s.clock_out ? 'Edit times / date' : 'Set Clock Out time'}</button>
            {s.clock_out && (
              <button className="btn-secondary" disabled={busy} onClick={() => guard(async () => {
                if (await run({ kind: 'undo_clock_out', args: { id: s.id } }, 'office', 'Clock Out undone — session active again')) onClose();
              })}><IconUndo size={18} />Undo Clock Out</button>
            )}
            <button className="btn-secondary" disabled={busy} onClick={() => guard(async () => {
              const ok = await confirm({ title: 'Convert to Remote Work?', message: `The office attendance (${formatTime(s.clock_in, tz)}${s.clock_out ? ` – ${formatTime(s.clock_out, tz)}` : ''}) will be removed and this day marked as Remote Work.`, confirmLabel: 'CONVERT' });
              if (ok && await run({ kind: 'set_remote', args: { date, replace: true } }, 'remote', 'Converted to Remote Work')) onClose();
            })}><IconLaptop size={18} />Convert to Remote Work</button>
            <button className="btn-ghost text-red-600 dark:text-red-400" disabled={busy || !!blocked} onClick={() => guard(async () => {
              if (!(await confirm({ title: 'Delete attendance?', message: 'This office attendance record will be permanently deleted.', confirmLabel: 'DELETE', destructive: true }))) return;
              await data.runOnline(() => api.deleteSession(s.id));
              toast('Attendance deleted', { tone: 'success' });
              onClose();
            })}><IconTrash size={18} />Delete attendance</button>
            {blocked && <p className="text-center text-xs text-zinc-500">Editing and deleting need a connection. {blocked}</p>}
          </div>
        </section>
      )}

      {/* Remote work --------------------------------------------------- */}
      {info.remote && (
        <section className="card !p-4">
          <div className="flex items-center gap-2 font-semibold text-blue-700 dark:text-blue-300"><IconLaptop size={20} />Remote Work</div>
          <p className="mt-1 text-sm text-zinc-500">Marked as completed remote work. No working hours are recorded.</p>
          <div className="mt-4 grid gap-2">
            <button className="btn-secondary" disabled={busy} onClick={() => guard(async () => {
              if (await run({ kind: 'delete_remote', args: { date } }, 'remote', 'Remote Work removed')) onClose();
            })}><IconUndo size={18} />Undo / remove Remote Work</button>
            <button className="btn-secondary" onClick={() => setMode('session')}><IconEdit size={18} />Convert to Office Attendance</button>
            <button className="btn-secondary" disabled={!!blocked} onClick={() => setMode('moveRemote')}>Change date</button>
          </div>
        </section>
      )}

      {/* Leave ------------------------------------------------------------ */}
      {info.leave && (
        <section className="card !p-4">
          <div className={`flex items-center gap-2 font-semibold ${info.leave.leave_type === 'public_holiday' ? 'text-teal-700 dark:text-teal-300' : 'text-purple-700 dark:text-purple-300'}`}>
            <IconPalm size={20} />{KIND_LABEL[info.leave.leave_type]}
          </div>
          <p className="mt-1 text-sm text-zinc-500">
            {info.leave.start_date === info.leave.end_date ? formatDateShort(info.leave.start_date) : `${formatDateShort(info.leave.start_date)} – ${formatDateShort(info.leave.end_date)}`}
            {info.leave.note && ` · ${info.leave.note}`}
          </p>
          <div className="mt-4 grid gap-2">
            <button className="btn-secondary" onClick={() => setMode('leave')}><IconEdit size={18} />Edit or delete leave</button>
            {!s && <button className="btn-secondary" onClick={() => setMode('session')}>Record office attendance instead</button>}
            {!info.remote && !s && (
              <button className="btn-secondary" disabled={busy} onClick={() => guard(async () => {
                const ok = await confirm({ title: 'Replace leave with Remote Work?', message: `This day is already marked as ${KIND_LABEL[info.leave!.leave_type]}. Would you like to replace it with Remote Work?`, confirmLabel: 'REPLACE', destructive: true });
                if (ok && await run({ kind: 'set_remote', args: { date, replace: true } }, 'remote', 'Marked as Remote Work')) onClose();
              })}>Mark as Remote Work instead</button>
            )}
          </div>
        </section>
      )}

      {/* Nothing recorded ----------------------------------------------- */}
      {!s && !info.remote && !info.leave && (
        <section className="space-y-2">
          {info.status === 'not_recorded' && (
            <p className="text-sm text-zinc-500">Nothing is recorded for this day. This is not treated as an absence.</p>
          )}
          <button className="btn-primary w-full" onClick={() => setMode('session')}><IconPlus size={18} />Add office attendance</button>
          <button className="btn-secondary w-full" disabled={busy} onClick={() => guard(async () => {
            if (await run({ kind: 'set_remote', args: { date, replace: false } }, 'remote', 'Marked as Remote Work')) onClose();
          })}><IconLaptop size={18} />Mark as Remote Work</button>
          <button className="btn-secondary w-full" onClick={() => setMode('leave')}><IconPalm size={18} />Add leave or holiday</button>
        </section>
      )}
    </div>
  );
}
