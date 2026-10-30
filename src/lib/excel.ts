// Real .xlsx export (write-excel-file, maintained, styling support).
import writeExcelFile from 'write-excel-file/universal';
import type { Cell, Row, SheetData } from 'write-excel-file/universal';
import {
  STATUS_COLOR, STATUS_LABEL, TYPE_LABEL, leaveDayCount, monthReport, sessionMinutes,
  type DayInfo, type DayStatus, type MonthReport,
} from './attendance';
import { MONTH_NAMES, WEEKDAY_LONG, formatMinutes, formatTimeOnDate, formatTime, localDate } from './time';
import type { DataSet, Settings } from './types';

const HEADER_BG = '#18181b';
const HEADER_FG = '#ffffff';
const BORDER = '#d4d4d8';

const neutral = new Set<DayStatus>(['not_recorded', 'today', 'future']);

function header(text: string): Cell {
  return { value: text, fontWeight: 'bold', backgroundColor: HEADER_BG, textColor: HEADER_FG, alignVertical: 'center', wrap: true, borderColor: BORDER, borderStyle: 'thin' };
}
function cell(value: string | number | null, extra: Record<string, unknown> = {}): Cell {
  if (value === null || value === '') return { value: '', type: String, borderColor: BORDER, borderStyle: 'thin', ...extra } as Cell;
  return { value, borderColor: BORDER, borderStyle: 'thin', alignVertical: 'center', ...extra } as Cell;
}

export function monthFileName(year: number, month: number) {
  return `Attendance_Report_${MONTH_NAMES[month - 1]}_${year}.xlsx`;
}

function dayRow(d: DayInfo, tz: string): Row {
  const color = STATUS_COLOR[d.status];
  const tint = neutral.has(d.status) ? {} : { backgroundColor: color.bg };
  const s = d.session;
  const hours = d.workedMinutes !== null ? Math.round((d.workedMinutes / 60) * 100) / 100 : null;
  const [y, m, day] = d.date.split('-').map(Number);
  return [
    cell(`${String(day).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`, tint),
    cell(WEEKDAY_LONG[d.weekday], tint),
    cell(s ? formatTime(s.clock_in, tz) : '', tint),
    cell(s?.clock_out ? formatTimeOnDate(s.clock_out, tz, d.date) : s ? 'Pending' : '', tint),
    hours !== null ? cell(hours, { ...tint, type: Number, format: '0.00' }) : cell(s ? 'Pending' : '', tint),
    cell(d.workedMinutes !== null ? formatMinutes(d.workedMinutes) : '', tint),
    cell(TYPE_LABEL[d.status] === '—' ? '' : TYPE_LABEL[d.status], tint),
    cell(STATUS_LABEL[d.status], { backgroundColor: neutral.has(d.status) ? '#ffffff' : color.bg, textColor: color.fg, fontWeight: 'bold' }),
  ];
}

export function buildMonthSheets(report: MonthReport, employeeName: string, settings: Settings): { data: SheetData; sheet: string; columns: { width: number }[]; stickyRowsCount?: number; orientation?: 'landscape' }[] {
  const monthLabel = `${MONTH_NAMES[report.month - 1]} ${report.year}`;
  const daily: SheetData = [
    [{ value: `Attendance Report — ${monthLabel}`, fontWeight: 'bold', fontSize: 14, columnSpan: 8 }, null, null, null, null, null, null, null],
    [{ value: `Employee: ${employeeName || '—'}`, columnSpan: 4 }, null, null, null,
      { value: `Timezone: ${settings.timezone}`, columnSpan: 4, align: 'right' }, null, null, null],
    ['Date', 'Day', 'Clock In', 'Clock Out', 'Actual Working Hours', 'Duration', 'Attendance Type', 'Attendance Status'].map(header),
    ...report.days.map((d) => dayRow(d, settings.timezone)),
  ];

  const s = report.summary;
  const line = (label: string, value: string | number): Row => [cell(label, { fontWeight: 'bold' }), cell(value, { align: 'right' })];
  const legend = (st: DayStatus, meaning: string): Row => [
    cell(STATUS_LABEL[st], { backgroundColor: STATUS_COLOR[st].bg, textColor: STATUS_COLOR[st].fg, fontWeight: 'bold' }), cell(meaning),
  ];
  const summary: SheetData = [
    [{ value: 'Monthly Summary', fontWeight: 'bold', fontSize: 14, columnSpan: 2 }, null],
    line('Employee Name', employeeName || '—'),
    line('Reporting Month', monthLabel),
    line('Daily Target', formatMinutes(settings.work_minutes)),
    [cell(''), cell('')],
    [header('Item'), header('Value')],
    line('Scheduled Working Days', s.scheduledWorkingDays),
    line('Completed Office Days', s.completedOfficeDays),
    line('Short Working Days', s.shortWorkingDays),
    line('Remote Working Days', s.remoteDays),
    line('Annual Leave Days', s.annualLeaveDays),
    line('Sick Leave Days', s.sickLeaveDays),
    line('Public Holidays', s.publicHolidays),
    line('Pending Attendance Days', s.pendingDays),
    line('Not Recorded Days', s.notRecordedDays),
    line('Total Actual Recorded Working Hours', formatMinutes(s.totalWorkedMinutes)),
    line('Total Shortfall Hours', formatMinutes(s.totalShortfallMinutes)),
    [cell(''), cell('')],
    [header('Status colour'), header('Meaning')],
    legend('complete', `Office attendance of ${formatMinutes(settings.work_minutes)} or more`),
    legend('short', 'Office attendance below the daily target'),
    legend('pending', 'Clock Out not recorded yet'),
    legend('remote', 'Remote Work (no hours recorded)'),
    legend('annual', 'Annual or Sick Leave'),
    legend('holiday', 'Public Holiday'),
    legend('weekend', 'Weekend'),
    legend('not_recorded', 'Nothing recorded — not a confirmed absence'),
  ];

  return [
    { data: daily, sheet: 'Daily Attendance', orientation: 'landscape' as const, columns: [{ width: 12 }, { width: 11 }, { width: 11 }, { width: 18 }, { width: 11 }, { width: 10 }, { width: 15 }, { width: 18 }], stickyRowsCount: 3 },
    { data: summary, sheet: 'Summary', columns: [{ width: 36 }, { width: 44 }] },
  ];
}

export async function monthWorkbook(year: number, month: number, data: DataSet, settings: Settings, employeeName: string, today: string): Promise<Blob> {
  const report = monthReport(year, month, data, settings, today);
  const sheets = buildMonthSheets(report, employeeName, settings);
  return writeExcelFile(sheets, { fontFamily: 'Calibri', fontSize: 11 }).toBlob();
}

/** Every record the user has, for "Export my data" / before account deletion. */
export async function fullExportWorkbook(data: DataSet, settings: Settings, employeeName: string, email: string): Promise<Blob> {
  const tz = settings.timezone;
  const sessions: SheetData = [
    ['Date', 'Clock In', 'Clock Out', 'Actual Working Hours', 'Duration', 'Target', 'Status', 'Clock In (UTC)', 'Clock Out (UTC)'].map(header),
    ...[...data.sessions].sort((a, b) => a.clock_in.localeCompare(b.clock_in)).map((s) => {
      const mins = sessionMinutes(s);
      const st: DayStatus = mins === null ? 'pending' : mins >= s.required_minutes ? 'complete' : 'short';
      return [
        cell(s.work_date), cell(formatTime(s.clock_in, tz)),
        cell(s.clock_out ? formatTimeOnDate(s.clock_out, tz, s.work_date) : 'Pending'),
        mins !== null ? cell(Math.round((mins / 60) * 100) / 100, { type: Number, format: '0.00' }) : cell('Pending'),
        cell(mins !== null ? formatMinutes(mins) : ''), cell(formatMinutes(s.required_minutes)),
        cell(STATUS_LABEL[st], { backgroundColor: STATUS_COLOR[st].bg, textColor: STATUS_COLOR[st].fg, fontWeight: 'bold' }),
        cell(s.clock_in), cell(s.clock_out ?? ''),
      ] as Row;
    }),
  ];
  const remote: SheetData = [
    [header('Date'), header('Type')],
    ...[...data.remote].sort((a, b) => a.work_date.localeCompare(b.work_date))
      .map((r) => [cell(r.work_date), cell('Remote Work', { backgroundColor: STATUS_COLOR.remote.bg })] as Row),
  ];
  const typeName = { annual: 'Annual Leave', sick: 'Sick Leave', public_holiday: 'Public Holiday' } as const;
  const leaves: SheetData = [
    ['Type', 'Start', 'End', 'Working Days', 'Note'].map(header),
    ...[...data.leaves].sort((a, b) => a.start_date.localeCompare(b.start_date)).map((l) => [
      cell(typeName[l.leave_type], { backgroundColor: STATUS_COLOR[l.leave_type === 'public_holiday' ? 'holiday' : 'annual'].bg }),
      cell(l.start_date), cell(l.end_date), cell(leaveDayCount(l, settings), { type: Number }), cell(l.note),
    ] as Row),
  ];
  const account: SheetData = [
    [header('Field'), header('Value')],
    [cell('Name'), cell(employeeName || '—')],
    [cell('Email'), cell(email)],
    [cell('Exported at'), cell(`${localDate(Date.now(), tz)} ${formatTime(Date.now(), tz)}`)],
    [cell('Daily target'), cell(formatMinutes(settings.work_minutes))],
    [cell('Reminder lead time'), cell(`${settings.lead_minutes} minutes`)],
    [cell('Working days'), cell(settings.working_days.map((d) => WEEKDAY_LONG[d]).join(', '))],
    [cell('Timezone'), cell(tz)],
  ];
  return writeExcelFile([
    { data: sessions, sheet: 'Office Attendance', columns: [{ width: 12 }, { width: 11 }, { width: 18 }, { width: 11 }, { width: 10 }, { width: 9 }, { width: 12 }, { width: 26 }, { width: 26 }], stickyRowsCount: 1 },
    { data: remote, sheet: 'Remote Work', columns: [{ width: 12 }, { width: 14 }], stickyRowsCount: 1 },
    { data: leaves, sheet: 'Leave', columns: [{ width: 16 }, { width: 12 }, { width: 12 }, { width: 13 }, { width: 30 }], stickyRowsCount: 1 },
    { data: account, sheet: 'Account', columns: [{ width: 20 }, { width: 40 }] },
  ], { fontFamily: 'Calibri', fontSize: 11 }).toBlob();
}

/** Save a file: share sheet on iPhone (Save to Files), download elsewhere. */
export async function saveFile(blob: Blob, fileName: string) {
  const type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const file = new File([blob], fileName, { type });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (isIOS && nav.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: fileName });
      return;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;   // user closed the share sheet
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
