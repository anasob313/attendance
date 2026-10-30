import { useMemo, useState } from 'react';
import { useData } from '../state/data';
import { useUi } from '../state/ui';
import { STATUS_LABEL, TYPE_LABEL, monthReport } from '../lib/attendance';
import { MONTH_NAMES, WEEKDAY_SHORT, formatMinutes, formatTime, formatTimeOnDate } from '../lib/time';
import { toAppError } from '../lib/errors';
import { useMonthNav } from './Calendar';
import { DayEditor } from '../components/DayEditor';
import { SyncBadge } from '../components/Layout';
import { PageHeader, STATUS_STYLE, Spinner, Stat } from '../components/ui';
import { IconChevronLeft, IconChevronRight, IconDownload } from '../components/icons';

export function ReportsPage() {
  const { view, settings, profile, ops } = useData();
  const { toast } = useUi();
  const tz = settings.timezone;
  const { y, m, today, shift, set } = useMonthNav(tz);
  const [selected, setSelected] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const r = useMemo(() => monthReport(y, m, view, settings, today), [y, m, view, settings, today]);
  const s = r.summary;
  const years = Array.from({ length: 7 }, (_, i) => Number(today.slice(0, 4)) - 5 + i);

  const exportXlsx = async () => {
    setExporting(true);
    try {
      const { monthFileName, monthWorkbook, saveFile } = await import('../lib/excel');
      const blob = await monthWorkbook(y, m, view, settings, profile?.full_name ?? '', today);
      await saveFile(blob, monthFileName(y, m));
    } catch (e) {
      toast(toAppError(e).message, { tone: 'error' });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="tabbar-space mx-auto max-w-lg px-4">
      <PageHeader title="Reports" right={<SyncBadge />} />
      <div className="flex items-center gap-2">
        <button className="flex h-11 w-11 items-center justify-center rounded-full bg-white ring-1 ring-black/5 dark:bg-white/10" onClick={() => shift(-1)} aria-label="Previous month"><IconChevronLeft /></button>
        <select className="input flex-1 !min-h-11 !py-2 font-semibold" value={m} onChange={(e) => set({ y, m: Number(e.target.value) })} aria-label="Month">
          {MONTH_NAMES.map((n, i) => <option key={n} value={i + 1}>{n}</option>)}
        </select>
        <select className="input w-28 !min-h-11 !py-2 font-semibold" value={y} onChange={(e) => set({ y: Number(e.target.value), m })} aria-label="Year">
          {years.map((yy) => <option key={yy} value={yy}>{yy}</option>)}
        </select>
        <button className="flex h-11 w-11 items-center justify-center rounded-full bg-white ring-1 ring-black/5 dark:bg-white/10" onClick={() => shift(1)} aria-label="Next month"><IconChevronRight /></button>
      </div>

      <section className="card mt-4 !p-4">
        <div className="flex items-baseline justify-between">
          <h2 className="font-semibold">Summary</h2>
          <span className="text-xs text-zinc-500">Target {formatMinutes(settings.work_minutes)} / day</span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Stat label="Total recorded working hours" value={formatMinutes(s.totalWorkedMinutes)} />
          <Stat label="Total shortfall" value={formatMinutes(s.totalShortfallMinutes)} tone={s.totalShortfallMinutes ? 'text-red-600 dark:text-red-400' : ''} />
        </div>
        <div className="mt-2 grid grid-cols-3 gap-2">
          <Stat label="Scheduled working days" value={s.scheduledWorkingDays} />
          <Stat label="Completed office days" value={s.completedOfficeDays} tone="text-green-600 dark:text-green-400" />
          <Stat label="Short working days" value={s.shortWorkingDays} tone={s.shortWorkingDays ? 'text-red-600 dark:text-red-400' : ''} />
          <Stat label="Remote working days" value={s.remoteDays} tone="text-blue-600 dark:text-blue-400" />
          <Stat label="Annual leave days" value={s.annualLeaveDays} tone="text-purple-600 dark:text-purple-400" />
          <Stat label="Sick leave days" value={s.sickLeaveDays} tone="text-purple-600 dark:text-purple-400" />
          <Stat label="Public holidays" value={s.publicHolidays} tone="text-teal-600 dark:text-teal-400" />
          <Stat label="Pending attendance" value={s.pendingDays} tone={s.pendingDays ? 'text-orange-600 dark:text-orange-400' : ''} />
          <Stat label="Not recorded days" value={s.notRecordedDays} />
        </div>
        <p className="mt-3 text-xs leading-relaxed text-zinc-500">
          Future days are never counted. “Not recorded” is not an absence. Pending sessions have no final hours. Remote Work, leave and holidays add no hours and no shortfall.
        </p>
        <button className="btn-primary mt-4 w-full" onClick={exportXlsx} disabled={exporting}>
          {exporting ? <Spinner /> : <><IconDownload size={18} />Download Excel (.xlsx)</>}
        </button>
        {ops.length > 0 && <p className="mt-2 text-center text-xs text-orange-600">Includes changes that are not synced yet.</p>}
      </section>

      <section className="card mt-4 !p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead className="text-[11px] uppercase tracking-wide text-zinc-500">
              <tr className="border-b border-zinc-200 dark:border-white/10">
                <th className="py-3 pl-4 pr-2 font-semibold">Date</th>
                <th className="px-2 font-semibold">In</th>
                <th className="px-2 font-semibold">Out</th>
                <th className="px-2 font-semibold">Hours</th>
                <th className="px-2 font-semibold">Type</th>
                <th className="py-3 pl-2 pr-4 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-white/5">
              {r.days.map((d) => (
                <tr key={d.date} onClick={() => setSelected(d.date)} className="cursor-pointer active:bg-zinc-50 dark:active:bg-white/5">
                  <td className="whitespace-nowrap py-2.5 pl-4 pr-2">
                    <span className="tabular font-semibold">{d.date.slice(8)}</span>
                    <span className="ml-1.5 text-zinc-500">{WEEKDAY_SHORT[d.weekday]}</span>
                  </td>
                  <td className="tabular whitespace-nowrap px-2">{d.session ? formatTime(d.session.clock_in, tz) : ''}</td>
                  <td className="tabular whitespace-nowrap px-2">{d.session ? (d.session.clock_out ? formatTimeOnDate(d.session.clock_out, tz, d.date) : '—') : ''}</td>
                  <td className="tabular whitespace-nowrap px-2">{d.workedMinutes !== null ? formatMinutes(d.workedMinutes) : ''}</td>
                  <td className="whitespace-nowrap px-2 text-zinc-500">{TYPE_LABEL[d.status] === '—' ? '' : TYPE_LABEL[d.status]}</td>
                  <td className="py-2.5 pl-2 pr-4">
                    <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_STYLE[d.status].pill}`}>{STATUS_LABEL[d.status]}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <DayEditor date={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
