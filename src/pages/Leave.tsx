import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useData } from '../state/data';
import { leaveDayCount } from '../lib/attendance';
import { formatDateShort, todayIn } from '../lib/time';
import { KIND_LABEL, type Leave } from '../lib/types';
import { LeaveForm } from '../components/forms';
import { PageHeader, Sheet } from '../components/ui';
import { IconPlus } from '../components/icons';

export function LeavePage() {
  const { view, settings } = useData();
  const [params, setParams] = useSearchParams();
  const today = todayIn(settings.timezone);
  const [editing, setEditing] = useState<{ leave?: Leave; date?: string } | null>(null);

  useEffect(() => {
    const d = params.get('new');
    if (d) {
      setEditing({ date: /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : today });
      setParams({}, { replace: true });
    }
  }, [params, setParams, today]);

  const { upcoming, past } = useMemo(() => {
    const sorted = [...view.leaves].sort((a, b) => a.start_date.localeCompare(b.start_date));
    return {
      upcoming: sorted.filter((l) => l.end_date >= today),
      past: sorted.filter((l) => l.end_date < today).reverse(),
    };
  }, [view.leaves, today]);

  const year = today.slice(0, 4);
  const used = (type: 'annual' | 'sick') => view.leaves
    .filter((l) => l.leave_type === type && l.start_date.startsWith(year))
    .reduce((n, l) => n + leaveDayCount(l, settings), 0);

  const row = (l: Leave) => {
    const n = leaveDayCount(l, settings);
    const color = l.leave_type === 'public_holiday' ? 'bg-teal-500' : 'bg-purple-500';
    return (
      <button key={l.id} className="list-row w-full text-left" onClick={() => setEditing({ leave: l })}>
        <div className={`h-10 w-1.5 rounded-full ${color}`} />
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{KIND_LABEL[l.leave_type]}</div>
          <div className="truncate text-sm text-zinc-500">
            {l.start_date === l.end_date ? formatDateShort(l.start_date) : `${formatDateShort(l.start_date)} – ${formatDateShort(l.end_date)}`}
            {l.note && ` · ${l.note}`}
          </div>
        </div>
        <div className="text-right text-sm text-zinc-500"><span className="tabular font-semibold text-zinc-900 dark:text-white">{n}</span> {n === 1 ? 'day' : 'days'}</div>
      </button>
    );
  };

  return (
    <div className="tabbar-space mx-auto max-w-lg px-4">
      <PageHeader title="Leave" back="/"
        right={<button className="btn-primary !min-h-10 !rounded-full !px-3.5 text-sm" onClick={() => setEditing({ date: today })}><IconPlus size={18} />Add</button>} />
      <div className="grid grid-cols-2 gap-3">
        <div className="card !p-4"><div className="tabular text-2xl font-semibold text-purple-600 dark:text-purple-400">{used('annual')}</div><div className="text-xs text-zinc-500">Annual leave days in {year}</div></div>
        <div className="card !p-4"><div className="tabular text-2xl font-semibold text-purple-600 dark:text-purple-400">{used('sick')}</div><div className="text-xs text-zinc-500">Sick leave days in {year}</div></div>
      </div>
      <p className="mt-3 px-1 text-xs text-zinc-500">Annual and sick leave count working days only. Public holidays are entered by you — no holiday calendar is assumed.</p>

      <h2 className="section-title mt-6">Upcoming & current</h2>
      <div className="card list-divide !py-0">
        {upcoming.length ? upcoming.map(row) : <p className="py-6 text-center text-sm text-zinc-500">No upcoming leave.</p>}
      </div>
      {past.length > 0 && (
        <>
          <h2 className="section-title mt-6">Past</h2>
          <div className="card list-divide !py-0">{past.map(row)}</div>
        </>
      )}

      <Sheet open={!!editing} onClose={() => setEditing(null)} title={editing?.leave ? 'Edit leave' : 'Add leave'}>
        {editing && <LeaveForm key={editing.leave?.id ?? 'new'} leave={editing.leave} defaultDate={editing.date} onDone={() => setEditing(null)} />}
      </Sheet>
    </div>
  );
}
