import { useMemo, useState } from 'react';
import { useData } from '../state/data';
import { STATUS_LABEL, sessionMinutes, type DayStatus } from '../lib/attendance';
import { MONTH_NAMES, formatDateShort, formatMinutes, formatTime, formatTimeOnDate } from '../lib/time';
import { KIND_LABEL } from '../lib/types';
import { DayEditor } from '../components/DayEditor';
import { SyncBadge } from '../components/Layout';
import { PageHeader, STATUS_STYLE } from '../components/ui';

interface Item { key: string; date: string; status: DayStatus; title: string; detail: string; right: string }

export function HistoryPage() {
  const { view, settings } = useData();
  const tz = settings.timezone;
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'office' | 'remote' | 'leave' | 'pending'>('all');

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const s of view.sessions) {
      const mins = sessionMinutes(s);
      const status: DayStatus = mins === null ? 'pending' : mins >= s.required_minutes ? 'complete' : 'short';
      out.push({
        key: `s${s.id}`, date: s.work_date, status, title: 'Office Attendance',
        detail: `${formatTime(s.clock_in, tz)} – ${s.clock_out ? formatTimeOnDate(s.clock_out, tz, s.work_date) : 'no Clock Out yet'}`,
        right: mins !== null ? formatMinutes(mins) : 'Pending',
      });
    }
    for (const r of view.remote) {
      out.push({ key: `r${r.id}`, date: r.work_date, status: 'remote', title: 'Remote Work', detail: 'No hours recorded', right: '' });
    }
    for (const l of view.leaves) {
      const st: DayStatus = l.leave_type === 'public_holiday' ? 'holiday' : l.leave_type;
      out.push({
        key: `l${l.id}`, date: l.start_date, status: st, title: KIND_LABEL[l.leave_type],
        detail: l.start_date === l.end_date ? (l.note || 'One day') : `${formatDateShort(l.start_date)} – ${formatDateShort(l.end_date)}${l.note ? ` · ${l.note}` : ''}`,
        right: '',
      });
    }
    return out
      .filter((i) => filter === 'all'
        || (filter === 'office' && ['complete', 'short', 'pending'].includes(i.status))
        || (filter === 'pending' && i.status === 'pending')
        || (filter === 'remote' && i.status === 'remote')
        || (filter === 'leave' && ['annual', 'sick', 'holiday'].includes(i.status)))
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [view, tz, filter]);

  const groups = useMemo(() => {
    const g = new Map<string, Item[]>();
    for (const i of items) {
      const k = i.date.slice(0, 7);
      if (!g.has(k)) g.set(k, []);
      g.get(k)!.push(i);
    }
    return [...g.entries()];
  }, [items]);

  const pendingCount = view.sessions.filter((s) => !s.clock_out).length;

  return (
    <div className="tabbar-space mx-auto max-w-lg px-4">
      <PageHeader title="History" right={<SyncBadge />} />
      <div className="-mx-4 mb-4 flex gap-2 overflow-x-auto px-4 pb-1">
        {(['all', 'office', 'remote', 'leave', 'pending'] as const).map((f) => (
          <button key={f} onClick={() => setFilter(f)}
            className={`whitespace-nowrap rounded-full px-3.5 py-1.5 text-sm font-semibold capitalize ${filter === f ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900' : 'bg-white text-zinc-600 ring-1 ring-black/5 dark:bg-white/10 dark:text-zinc-300'}`}>
            {f}{f === 'pending' && pendingCount ? ` (${pendingCount})` : ''}
          </button>
        ))}
      </div>
      {groups.length === 0 && <p className="py-16 text-center text-sm text-zinc-500">No records yet.</p>}
      {groups.map(([ym, list]) => (
        <section key={ym} className="mb-5">
          <h2 className="section-title">{MONTH_NAMES[Number(ym.slice(5)) - 1]} {ym.slice(0, 4)}</h2>
          <div className="card list-divide !py-0">
            {list.map((i) => (
              <button key={i.key} className="list-row w-full text-left" onClick={() => setSelected(i.date)}>
                <div className={`h-10 w-1.5 shrink-0 rounded-full ${STATUS_STYLE[i.status].dot}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{formatDateShort(i.date)}</span>
                    <span className="truncate text-sm text-zinc-500">{i.title}</span>
                  </div>
                  <div className="truncate text-sm text-zinc-500">{i.detail}</div>
                </div>
                <div className="text-right">
                  <div className="tabular font-semibold">{i.right}</div>
                  <div className="text-[11px] text-zinc-500">{STATUS_LABEL[i.status]}</div>
                </div>
              </button>
            ))}
          </div>
        </section>
      ))}
      <DayEditor date={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
