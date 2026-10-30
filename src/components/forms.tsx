import { useState } from 'react';
import { api } from '../lib/api';
import { leaveDayCount } from '../lib/attendance';
import { addDays, formatMinutes, fromInputValue, toInputValue, weekdayOf, WEEKDAY_LONG } from '../lib/time';
import type { Leave, LeaveType, Session } from '../lib/types';
import { useData } from '../state/data';
import { useActions } from '../hooks/useActions';
import { Notice, Spinner } from './ui';

/** Add / edit an office attendance record (also completes a forgotten Clock Out). */
export function SessionForm({ session, date, onDone }: { session?: Session; date: string; onDone: () => void }) {
  const { settings, editBlockedReason } = useData();
  const { withReplace, report, toast } = useActions();
  const tz = settings.timezone;
  const [inV, setIn] = useState(session ? toInputValue(session.clock_in, tz) : `${date}T08:00`);
  const [outV, setOut] = useState(session?.clock_out ? toInputValue(session.clock_out, tz) : session ? '' : `${date}T16:00`);
  const [busy, setBusy] = useState(false);

  const inD = fromInputValue(inV, tz);
  const outD = outV ? fromInputValue(outV, tz) : null;
  let error: string | null = null;
  if (!inD) error = 'Enter a valid Clock In time.';
  else if (inD.getTime() > Date.now() + 5 * 60_000) error = 'Clock In cannot be in the future.';
  else if (outV && !outD) error = 'Enter a valid Clock Out time.';
  else if (outD && outD <= inD) error = 'Clock Out must be after Clock In.';
  else if (outD && outD.getTime() > Date.now() + 5 * 60_000) error = 'Clock Out cannot be in the future.';
  else if (outD && outD.getTime() - inD.getTime() > 24 * 3600_000) error = 'A session cannot be longer than 24 hours.';
  const minutes = inD && outD && !error ? (outD.getTime() - inD.getTime()) / 60_000 : null;

  const save = async () => {
    if (error || !inD) return;
    setBusy(true);
    try {
      const id = session?.id ?? crypto.randomUUID();
      const res = await withReplace((r) => api.upsertSession(id, inD.toISOString(), outD ? outD.toISOString() : null, r), 'office');
      if (res) { toast('Attendance saved', { tone: 'success' }); onDone(); }
    } catch (e) { report(e); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3">
        <label className="field">
          <span className="label">Clock In</span>
          <input type="datetime-local" className="input" value={inV} onChange={(e) => setIn(e.target.value)} max={toInputValue(Date.now(), tz)} />
        </label>
        <label className="field">
          <span className="label">Clock Out {session && !session.clock_out && '(leave empty to keep it pending)'}</span>
          <input type="datetime-local" className="input" value={outV} onChange={(e) => setOut(e.target.value)} min={inV} max={toInputValue(Date.now(), tz)} />
        </label>
        <p className="text-xs text-zinc-500">Times are in {tz}. Overnight sessions belong to the Clock In date. Breaks are included.</p>
      </div>
      {minutes !== null && (
        <div className={`rounded-2xl px-4 py-3 text-sm font-medium ${minutes >= (session?.required_minutes ?? settings.work_minutes) ? 'bg-green-100 text-green-900 dark:bg-green-500/15 dark:text-green-200' : 'bg-red-100 text-red-900 dark:bg-red-500/15 dark:text-red-200'}`}>
          Actual working time: {formatMinutes(minutes)}
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {editBlockedReason && <Notice tone="warn">{editBlockedReason}</Notice>}
      <button className="btn-primary w-full" disabled={busy || !!error || !!editBlockedReason} onClick={save}>
        {busy ? <Spinner /> : 'Save attendance'}
      </button>
    </div>
  );
}

const LEAVE_TYPES: { value: LeaveType; label: string }[] = [
  { value: 'annual', label: 'Annual' },
  { value: 'sick', label: 'Sick' },
  { value: 'public_holiday', label: 'Public Holiday' },
];

export function LeaveForm({ leave, defaultDate, onDone }: { leave?: Leave; defaultDate?: string; onDone: () => void }) {
  const { settings, editBlockedReason, runOnline } = useData();
  const { withReplace, report, toast, confirm } = useActions();
  const [type, setType] = useState<LeaveType>(leave?.leave_type ?? 'annual');
  const [start, setStart] = useState(leave?.start_date ?? defaultDate ?? '');
  const [end, setEnd] = useState(leave?.end_date ?? defaultDate ?? '');
  const [note, setNote] = useState(leave?.note ?? '');
  const [busy, setBusy] = useState(false);

  const valid = /^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end);
  const error = !valid ? null : end < start ? 'End date must be on or after start date.' : end > addDays(start, 366) ? 'A leave record cannot be longer than one year.' : null;
  const count = valid && !error ? leaveDayCount({ start_date: start, end_date: end, leave_type: type }, settings) : 0;
  const totalDays = valid && !error ? Math.round((Date.parse(end) - Date.parse(start)) / 86400_000) + 1 : 0;
  const weekendNames = [0, 1, 2, 3, 4, 5, 6].filter((d) => !settings.working_days.includes(d)).map((d) => WEEKDAY_LONG[d].slice(0, 3));

  const save = async () => {
    if (!valid || error) return;
    setBusy(true);
    try {
      const res = await withReplace((r) => api.saveLeave({ id: leave?.id ?? crypto.randomUUID(), type, start, end, note }, r), type);
      if (res) { toast('Leave saved', { tone: 'success' }); onDone(); }
    } catch (e) { report(e); } finally { setBusy(false); }
  };

  const remove = async () => {
    if (!leave) return;
    if (!(await confirm({ title: 'Delete leave?', message: 'These days return to Not Recorded unless something else is recorded.', confirmLabel: 'DELETE', destructive: true }))) return;
    setBusy(true);
    try {
      await runOnline(() => api.deleteLeave(leave.id));
      toast('Leave deleted', { tone: 'success' });
      onDone();
    } catch (e) { report(e); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-1 rounded-2xl bg-zinc-200/70 p-1 dark:bg-white/10" role="radiogroup" aria-label="Leave type">
        {LEAVE_TYPES.map((t) => (
          <button key={t.value} role="radio" aria-checked={type === t.value} onClick={() => setType(t.value)}
            className={`rounded-xl px-2 py-2.5 text-sm font-semibold transition ${type === t.value ? 'bg-white shadow-sm dark:bg-zinc-700' : 'text-zinc-500 dark:text-zinc-400'}`}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className="field"><span className="label">Start date</span>
          <input type="date" className="input" value={start} onChange={(e) => { setStart(e.target.value); if (!end || end < e.target.value) setEnd(e.target.value); }} />
        </label>
        <label className="field"><span className="label">End date</span>
          <input type="date" className="input" value={end} min={start} onChange={(e) => setEnd(e.target.value)} />
        </label>
      </div>
      <label className="field"><span className="label">Note (optional)</span>
        <input className="input" value={note} maxLength={200} placeholder={type === 'public_holiday' ? 'e.g. National Day' : ''} onChange={(e) => setNote(e.target.value)} />
      </label>
      {valid && !error && (
        <div className="rounded-2xl bg-zinc-100 px-4 py-3 text-sm dark:bg-white/5">
          {type === 'public_holiday'
            ? <>{totalDays} day{totalDays === 1 ? '' : 's'} · {count} on working days</>
            : <><b>{count}</b> working day{count === 1 ? '' : 's'} of leave{weekendNames.length ? ` (${weekendNames.join(' & ')} excluded)` : ''}{start === end ? ` · ${WEEKDAY_LONG[weekdayOf(start)]}` : ''}</>}
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {editBlockedReason && <Notice tone="warn">{editBlockedReason}</Notice>}
      <button className="btn-primary w-full" disabled={busy || !valid || !!error || !!editBlockedReason} onClick={save}>
        {busy ? <Spinner /> : leave ? 'Save changes' : 'Add leave'}
      </button>
      {leave && (
        <button className="btn-ghost w-full text-red-600 dark:text-red-400" disabled={busy || !!editBlockedReason} onClick={remove}>Delete leave</button>
      )}
    </div>
  );
}
