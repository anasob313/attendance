import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useData } from '../state/data';
import { useActions } from '../hooks/useActions';
import { useNow } from '../hooks/useNow';
import {
  activeSession, buildIndex, classifyDay, expectedCompletion, reminderTime, sessionMinutes,
} from '../lib/attendance';
import {
  HOUR, MINUTE, formatClock, formatDateLong, formatDateShort, formatMinutes, formatTime, localDate, todayIn,
} from '../lib/time';
import { KIND_LABEL } from '../lib/types';
import { enablePush, isIOS, isStandalone, pushSupport } from '../lib/push';
import { SyncBadge } from '../components/Layout';
import { DayEditor } from '../components/DayEditor';
import { Notice, Spinner, StatusPill } from '../components/ui';
import { IconBell, IconLaptop, IconPalm, IconUndo, IconUser } from '../components/icons';

function greeting(hour: number) {
  return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
}

function Ring({ progress, done }: { progress: number; done: boolean }) {
  const r = 104;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 240 240" className="absolute inset-0 h-full w-full -rotate-90" aria-hidden>
      <circle cx="120" cy="120" r={r} fill="none" strokeWidth="14" className="stroke-zinc-200 dark:stroke-white/10" />
      <circle cx="120" cy="120" r={r} fill="none" strokeWidth="14" strokeLinecap="round"
        className={done ? 'stroke-green-500' : 'stroke-zinc-900 dark:stroke-white'}
        strokeDasharray={c} strokeDashoffset={c * (1 - Math.min(1, Math.max(0, progress)))}
        style={{ transition: 'stroke-dashoffset 0.8s ease' }} />
    </svg>
  );
}

export function Dashboard() {
  const data = useData();
  const { run, confirmLocal, report, toast } = useActions();
  const navigate = useNavigate();
  const now = useNow(1000);
  const [busy, setBusy] = useState(false);
  const [editDate, setEditDate] = useState<string | null>(null);
  const [pushState, setPushState] = useState(() => pushSupport());
  const [permission, setPermission] = useState(() => (typeof Notification !== 'undefined' ? Notification.permission : 'default'));

  const { settings, view, snapshot, profile } = data;
  const tz = settings.timezone;
  const today = todayIn(tz, now);
  const active = activeSession(view.sessions);
  const info = classifyDay(today, buildIndex(view), settings, today);
  const firstName = (profile?.full_name || '').split(' ')[0];
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(now));

  useEffect(() => { setPushState(pushSupport()); }, [permission]);

  const guard = async (fn: () => Promise<unknown>) => {
    if (busy) return;               // double-tap protection
    setBusy(true);
    try { await fn(); } catch (e) { report(e); } finally { setBusy(false); }
  };

  const clockIn = () => guard(async () => {
    const at = new Date().toISOString();
    const workDate = localDate(at, tz);
    const replace = await confirmLocal(workDate, 'office');
    if (replace === null) return;
    await run({ kind: 'clock_in', args: { id: crypto.randomUUID(), at, workDate, requiredMinutes: settings.work_minutes, timezone: tz, replace } },
      'office', `Clocked in at ${formatTime(at, tz)}`);
  });

  const clockOut = () => guard(async () => {
    if (!active) return;
    const at = new Date().toISOString();
    const id = active.id;
    await run({ kind: 'clock_out', args: { id, at } }, 'office', `Clocked out at ${formatTime(at, tz)}`,
      () => void run({ kind: 'undo_clock_out', args: { id } }, 'office', 'Clock Out undone — timer resumed'));
  });

  const markRemote = () => guard(async () => {
    const replace = await confirmLocal(today, 'remote');
    if (replace === null) return;
    await run({ kind: 'set_remote', args: { date: today, replace } }, 'remote', 'Today is marked as Remote Work',
      () => void run({ kind: 'delete_remote', args: { date: today } }, 'remote', 'Remote Work undone'));
  });

  const turnOnReminders = async () => {
    try {
      await enablePush();
      toast('Reminders are on for this device', { tone: 'success' });
    } catch (e) { report(e); }
    setPermission(typeof Notification !== 'undefined' ? Notification.permission : 'default');
  };

  if (data.loading) {
    return <div className="flex min-h-dvh items-center justify-center"><Spinner /></div>;
  }

  // ---- working state ----------------------------------------------------
  let main: React.ReactNode;
  if (active) {
    const elapsedMs = Math.max(0, now - Date.parse(active.clock_in));
    const targetMs = active.required_minutes * MINUTE;
    const done = elapsedMs >= targetMs;
    const reminder = snapshot.reminders.find((r) => r.session_id === active.id);
    const fireAt = reminderTime(active, settings.lead_minutes);
    const startedEarlier = active.work_date !== today;
    const reminderText = !reminder
      ? (data.ops.length ? 'Reminder is scheduled once this syncs.' : `Reminder at ${formatTime(fireAt, tz)}`)
      : reminder.status === 'scheduled' || reminder.status === 'sending' ? `Reminder at ${formatTime(reminder.fire_at, tz)}`
        : reminder.status === 'sent' ? `Reminder sent at ${formatTime(reminder.sent_at ?? reminder.fire_at, tz)}`
          : reminder.status === 'skipped' ? 'No reminder — its time had already passed'
            : reminder.status === 'failed' ? 'Reminder could not be delivered' : '';

    main = (
      <>
        {startedEarlier && (
          <Notice tone={elapsedMs > 14 * HOUR ? 'warn' : 'info'}
            action={<button className="font-semibold underline" onClick={() => setEditDate(active.work_date)}>Fix</button>}>
            {elapsedMs > 14 * HOUR
              ? <>Forgot to clock out? This session started {formatDateShort(active.work_date)} at {formatTime(active.clock_in, tz)}. Set the correct Clock Out time.</>
              : <>Overnight session started {formatDateShort(active.work_date)}.</>}
          </Notice>
        )}
        <section className="card flex flex-col items-center !py-7">
          <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-orange-600 dark:text-orange-400"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-orange-500" />In progress</span>
          <div className="relative mt-3 aspect-square w-64 max-w-full">
            <Ring progress={elapsedMs / targetMs} done={done} />
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <div className="text-xs font-medium uppercase tracking-widest text-zinc-500">Working</div>
              <div className="tabular mt-1 font-[family-name:var(--font-display)] text-[44px] font-semibold leading-none tracking-tight">{formatClock(elapsedMs)}</div>
              <div className={`mt-2 text-sm font-medium ${done ? 'text-green-600 dark:text-green-400' : 'text-zinc-500'}`}>
                {done ? `Target reached · +${formatMinutes((elapsedMs - targetMs) / MINUTE)}` : `${formatMinutes((targetMs - elapsedMs) / MINUTE)} remaining`}
              </div>
            </div>
          </div>
          <div className="mt-5 grid w-full grid-cols-2 gap-3 text-center">
            <div className="rounded-2xl bg-zinc-100 py-3 dark:bg-white/5">
              <div className="text-xs text-zinc-500">Clock In</div>
              <div className="tabular text-lg font-semibold">{formatTime(active.clock_in, tz)}</div>
            </div>
            <div className="rounded-2xl bg-zinc-100 py-3 dark:bg-white/5">
              <div className="text-xs text-zinc-500">{formatMinutes(active.required_minutes)} complete at</div>
              <div className="tabular text-lg font-semibold">{formatTime(expectedCompletion(active), tz)}</div>
            </div>
          </div>
          <div className="mt-3 flex items-center gap-1.5 text-sm text-zinc-500"><IconBell size={16} />{reminderText}</div>
        </section>
        <button className="btn-primary btn-xl w-full" disabled={busy} onClick={clockOut}>CLOCK OUT</button>
        <button className="btn-ghost mx-auto block text-sm" onClick={() => setEditDate(active.work_date)}>Edit this session</button>
      </>
    );
  } else if (info.session) {
    // ---- completed today ----------------------------------------------
    const s = info.session;
    const worked = sessionMinutes(s) ?? 0;
    main = (
      <>
        <section className="card text-center">
          <StatusPill status={info.status} />
          <div className="tabular mt-4 font-[family-name:var(--font-display)] text-5xl font-semibold tracking-tight">{formatMinutes(worked)}</div>
          <div className="mt-1 text-sm text-zinc-500">
            {info.status === 'complete'
              ? (worked > s.required_minutes ? `Target met · +${formatMinutes(worked - s.required_minutes)}` : 'Target met')
              : `Short by ${formatMinutes(s.required_minutes - worked)}`}
          </div>
          <div className="mt-5 grid grid-cols-2 gap-3">
            <div className="rounded-2xl bg-zinc-100 py-3 dark:bg-white/5"><div className="text-xs text-zinc-500">Clock In</div><div className="tabular text-lg font-semibold">{formatTime(s.clock_in, tz)}</div></div>
            <div className="rounded-2xl bg-zinc-100 py-3 dark:bg-white/5"><div className="text-xs text-zinc-500">Clock Out</div><div className="tabular text-lg font-semibold">{formatTime(s.clock_out!, tz)}</div></div>
          </div>
        </section>
        <div className="grid grid-cols-2 gap-3">
          <button className="btn-secondary" disabled={busy} onClick={() => guard(() => run({ kind: 'undo_clock_out', args: { id: s.id } }, 'office', 'Clock Out undone — timer resumed'))}>
            <IconUndo size={18} /><span className="whitespace-nowrap">Undo Clock Out</span>
          </button>
          <button className="btn-secondary" onClick={() => setEditDate(today)}>Edit</button>
        </div>
      </>
    );
  } else if (info.remote) {
    main = (
      <>
        <section className="card text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300"><IconLaptop size={30} /></div>
          <div className="mt-4 text-2xl font-semibold">Remote Work</div>
          <p className="mt-1 text-sm text-zinc-500">Today is recorded as a remote working day. No Clock In or hours needed.</p>
        </section>
        <div className="grid grid-cols-2 gap-3">
          <button className="btn-secondary" disabled={busy} onClick={() => guard(() => run({ kind: 'delete_remote', args: { date: today } }, 'remote', 'Remote Work removed'))}>
            <IconUndo size={18} />Undo
          </button>
          <button className="btn-secondary" disabled={busy} onClick={clockIn}>Switch to Office</button>
        </div>
      </>
    );
  } else if (info.leave && info.status !== 'weekend') {
    main = (
      <>
        <section className="card text-center">
          <div className={`mx-auto flex h-16 w-16 items-center justify-center rounded-full ${info.status === 'holiday' ? 'bg-teal-100 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300' : 'bg-purple-100 text-purple-700 dark:bg-purple-500/15 dark:text-purple-300'}`}><IconPalm size={30} /></div>
          <div className="mt-4 text-2xl font-semibold">{KIND_LABEL[info.leave.leave_type]}</div>
          <p className="mt-1 text-sm text-zinc-500">
            {info.leave.start_date === info.leave.end_date ? 'Today' : `${formatDateShort(info.leave.start_date)} – ${formatDateShort(info.leave.end_date)}`}
            {info.leave.note && ` · ${info.leave.note}`}
          </p>
        </section>
        <div className="grid grid-cols-2 gap-3">
          <button className="btn-secondary" onClick={() => setEditDate(today)}>Manage</button>
          <button className="btn-secondary" disabled={busy} onClick={clockIn}>Clock In anyway</button>
        </div>
      </>
    );
  } else {
    // ---- nothing recorded today ---------------------------------------
    main = (
      <>
        <section className="card text-center !py-8">
          <div className="text-sm font-medium text-zinc-500">{info.isWorkingDay ? 'Not clocked in yet' : 'Weekend'}</div>
          <div className="tabular mt-2 font-[family-name:var(--font-display)] text-5xl font-semibold tracking-tight">{formatTime(now, tz)}</div>
          <p className="mx-auto mt-2 max-w-xs text-sm text-zinc-500">
            {info.isWorkingDay ? `Your ${formatMinutes(settings.work_minutes)} start when you clock in. Breaks are included.` : 'No attendance needed today. You can still clock in if you work.'}
          </p>
        </section>
        <button className="btn-primary btn-xl w-full" disabled={busy} onClick={clockIn}>CLOCK IN</button>
        <div className="grid grid-cols-2 gap-3">
          <button className="btn-secondary !min-h-16 flex-col !gap-1 text-[13px] tracking-wide" disabled={busy} onClick={markRemote}><IconLaptop size={20} />REMOTE WORK</button>
          <button className="btn-secondary !min-h-16 flex-col !gap-1 text-[13px] tracking-wide" onClick={() => navigate(`/leave?new=${today}`)}><IconPalm size={20} />LEAVE</button>
        </div>
      </>
    );
  }

  const showInstall = isIOS() && !isStandalone();

  return (
    <div className="tabbar-space mx-auto max-w-lg px-4">
      <header className="pt-safe pb-4">
        <div className="flex items-center justify-between gap-3">
          <div className="truncate text-sm font-medium text-zinc-500">{formatDateLong(today)}</div>
          <div className="flex shrink-0 items-center gap-2">
            <SyncBadge />
            <Link to="/account" className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-zinc-600 ring-1 ring-black/5 dark:bg-white/10 dark:text-zinc-300" aria-label="Profile">
              <IconUser size={18} />
            </Link>
          </div>
        </div>
        <h1 className="mt-0.5 font-[family-name:var(--font-display)] text-[30px] font-bold leading-tight tracking-tight">
          {greeting(hour)}{firstName ? `, ${firstName}` : ''}
        </h1>
      </header>

      <div className="space-y-4">
        {data.loadError && <Notice tone="error" action={<button className="font-semibold underline" onClick={() => data.refresh()}>Retry</button>}>{data.loadError}</Notice>}
        {!data.online && <Notice tone="warn">You are offline. Clock In, Clock Out and Remote Work still work and will sync automatically.</Notice>}
        {main}
        {showInstall && (
          <Notice action={<Link to="/install" className="font-semibold underline">How</Link>}>
            Add this app to your Home Screen to get the 8-hour reminder.
          </Notice>
        )}
        {!showInstall && pushState.ok && permission === 'default' && (
          <Notice action={<button className="font-semibold underline" onClick={turnOnReminders}>Turn on</button>}>
            Get a reminder {settings.lead_minutes} minutes before your {formatMinutes(settings.work_minutes)} are complete.
          </Notice>
        )}
        <div className="grid grid-cols-2 gap-3 pt-2 text-sm">
          <Link to="/calendar" className="card !p-4 font-medium">Calendar<div className="text-xs font-normal text-zinc-500">Month at a glance</div></Link>
          <Link to="/reports" className="card !p-4 font-medium">Monthly report<div className="text-xs font-normal text-zinc-500">Summary & Excel</div></Link>
          <Link to="/history" className="card !p-4 font-medium">History<div className="text-xs font-normal text-zinc-500">All records</div></Link>
          <Link to="/leave" className="card !p-4 font-medium">Leave<div className="text-xs font-normal text-zinc-500">Annual, sick, holidays</div></Link>
        </div>
      </div>
      <DayEditor date={editDate} onClose={() => setEditDate(null)} />
    </div>
  );
}
