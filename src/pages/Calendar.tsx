import { useMemo, useState } from 'react';
import { useData } from '../state/data';
import { monthReport, type DayStatus } from '../lib/attendance';
import { MONTH_NAMES, WEEKDAY_SHORT, formatMinutes, todayIn, weekdayOf } from '../lib/time';
import { DayEditor } from '../components/DayEditor';
import { SyncBadge } from '../components/Layout';
import { PageHeader, STATUS_STYLE } from '../components/ui';
import { IconChevronLeft, IconChevronRight } from '../components/icons';

export function useMonthNav(tz: string) {
  const today = todayIn(tz);
  const [ym, setYm] = useState(() => ({ y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) }));
  const shift = (d: number) => setYm(({ y, m }) => {
    const t = y * 12 + (m - 1) + d;
    return { y: Math.floor(t / 12), m: (t % 12) + 1 };
  });
  return { ...ym, today, shift, set: setYm };
}

const LEGEND: { status: DayStatus; label: string }[] = [
  { status: 'complete', label: 'Complete' },
  { status: 'short', label: 'Short' },
  { status: 'pending', label: 'Pending' },
  { status: 'remote', label: 'Remote' },
  { status: 'annual', label: 'Leave' },
  { status: 'holiday', label: 'Holiday' },
  { status: 'weekend', label: 'Weekend' },
  { status: 'not_recorded', label: 'Not recorded' },
];

export function CalendarPage() {
  const { view, settings } = useData();
  const tz = settings.timezone;
  const { y, m, today, shift } = useMonthNav(tz);
  const [selected, setSelected] = useState<string | null>(null);
  const report = useMemo(() => monthReport(y, m, view, settings, today), [y, m, view, settings, today]);
  const lead = weekdayOf(report.days[0].date);

  return (
    <div className="tabbar-space mx-auto max-w-lg px-4">
      <PageHeader title="Calendar" right={<SyncBadge />} />
      <section className="card !p-3">
        <div className="flex items-center justify-between px-1 pb-3">
          <button className="flex h-10 w-10 items-center justify-center rounded-full hover:bg-zinc-100 dark:hover:bg-white/10" onClick={() => shift(-1)} aria-label="Previous month"><IconChevronLeft /></button>
          <div className="text-lg font-semibold">{MONTH_NAMES[m - 1]} {y}</div>
          <button className="flex h-10 w-10 items-center justify-center rounded-full hover:bg-zinc-100 dark:hover:bg-white/10" onClick={() => shift(1)} aria-label="Next month"><IconChevronRight /></button>
        </div>
        <div className="grid grid-cols-7 gap-1.5 text-center text-[11px] font-semibold uppercase text-zinc-400">
          {WEEKDAY_SHORT.map((d) => <div key={d}>{d.slice(0, 2)}</div>)}
        </div>
        <div className="mt-1.5 grid grid-cols-7 gap-1.5">
          {Array.from({ length: lead }).map((_, i) => <div key={`e${i}`} />)}
          {report.days.map((d) => {
            const day = Number(d.date.slice(8));
            const isToday = d.date === today;
            return (
              <button key={d.date} onClick={() => setSelected(d.date)}
                className={`relative flex aspect-square flex-col items-center justify-center rounded-xl text-[15px] font-semibold transition active:scale-95 ${STATUS_STYLE[d.status].cell} ${isToday ? 'outline outline-2 outline-offset-1 outline-zinc-900 dark:outline-white' : ''}`}
                aria-label={`${d.date} ${d.status}`}>
                <span className="tabular">{day}</span>
                {d.workedMinutes !== null && <span className="tabular text-[9px] font-medium opacity-80">{formatMinutes(d.workedMinutes).replace(' ', '')}</span>}
                {d.status === 'pending' && <span className="text-[9px] font-medium">open</span>}
              </button>
            );
          })}
        </div>
      </section>
      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 px-1 text-xs text-zinc-500">
        {LEGEND.map((l) => (
          <span key={l.status} className="flex items-center gap-1.5"><span className={`h-2.5 w-2.5 rounded-full ${STATUS_STYLE[l.status].dot}`} />{l.label}</span>
        ))}
      </div>
      <p className="mt-3 px-1 text-xs text-zinc-500">Tap a day to add, edit, convert or delete records. “Not recorded” is not an absence.</p>
      <DayEditor date={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
