// Pure attendance rules: day classification, durations, monthly summary.
// No I/O here, so every rule is unit-tested in attendance.test.ts.
import type { DataSet, Leave, RemoteDay, Session, Settings } from './types';
import { MINUTE, addDays, daysBetween, minutesBetween, monthDays, weekdayOf } from './time';

export type DayStatus =
  | 'complete'      // GREEN  – completed office attendance ≥ target
  | 'short'         // RED    – completed office attendance < target
  | 'pending'       // ORANGE – no Clock Out yet
  | 'remote'        // BLUE
  | 'annual'        // PURPLE
  | 'sick'          // PURPLE
  | 'holiday'       // TEAL
  | 'weekend'       // GRAY
  | 'not_recorded'  // NEUTRAL – past working day with nothing recorded (NOT an absence)
  | 'today'         // NEUTRAL – today, nothing recorded yet
  | 'future';       // NEUTRAL – upcoming working day

export const STATUS_LABEL: Record<DayStatus, string> = {
  complete: 'Completed',
  short: 'Short',
  pending: 'Pending Clock Out',
  remote: 'Remote Work',
  annual: 'Annual Leave',
  sick: 'Sick Leave',
  holiday: 'Public Holiday',
  weekend: 'Weekend',
  not_recorded: 'Not Recorded',
  today: 'Not Recorded Yet',
  future: 'Upcoming',
};

export const TYPE_LABEL: Record<DayStatus, string> = {
  complete: 'Office',
  short: 'Office',
  pending: 'Office',
  remote: 'Remote Work',
  annual: 'Annual Leave',
  sick: 'Sick Leave',
  holiday: 'Public Holiday',
  weekend: 'Weekend',
  not_recorded: '—',
  today: '—',
  future: '—',
};

/** Hex colours used in the UI and in the Excel export. */
export const STATUS_COLOR: Record<DayStatus, { fg: string; bg: string }> = {
  complete: { fg: '#15803d', bg: '#dcfce7' },
  short: { fg: '#b91c1c', bg: '#fee2e2' },
  pending: { fg: '#c2410c', bg: '#ffedd5' },
  remote: { fg: '#1d4ed8', bg: '#dbeafe' },
  annual: { fg: '#7e22ce', bg: '#f3e8ff' },
  sick: { fg: '#7e22ce', bg: '#f3e8ff' },
  holiday: { fg: '#0f766e', bg: '#ccfbf1' },
  weekend: { fg: '#52525b', bg: '#e4e4e7' },
  not_recorded: { fg: '#52525b', bg: '#ffffff' },
  today: { fg: '#52525b', bg: '#ffffff' },
  future: { fg: '#a1a1aa', bg: '#ffffff' },
};

export interface DayInfo {
  date: string;
  weekday: number;
  isWorkingDay: boolean;
  status: DayStatus;
  session?: Session;
  remote?: RemoteDay;
  leave?: Leave;
  /** Completed sessions only. Pending sessions never get final hours. */
  workedMinutes: number | null;
  /** Only for completed office sessions on scheduled working days. */
  shortfallMinutes: number;
}

export type { DataSet } from './types';

export function sessionMinutes(s: Session): number | null {
  return s.clock_out ? minutesBetween(s.clock_in, s.clock_out) : null;
}

export function elapsedMinutes(s: Session, now: number): number {
  return Math.max(0, (now - Date.parse(s.clock_in)) / MINUTE);
}

export function expectedCompletion(s: Session): number {
  return Date.parse(s.clock_in) + s.required_minutes * MINUTE;
}

export function reminderTime(s: Session, leadMinutes: number): number {
  return Date.parse(s.clock_in) + Math.max(0, s.required_minutes - leadMinutes) * MINUTE;
}

export function shortfall(requiredMinutes: number, actualMinutes: number): number {
  return Math.max(0, requiredMinutes - actualMinutes);
}

export function isWorkingDay(date: string, settings: Settings): boolean {
  return settings.working_days.includes(weekdayOf(date));
}

export interface Index {
  sessionByDate: Map<string, Session>;
  remoteByDate: Map<string, RemoteDay>;
  leaveByDate: Map<string, Leave>;
}

export function buildIndex(data: DataSet): Index {
  const sessionByDate = new Map(data.sessions.map((s) => [s.work_date, s]));
  const remoteByDate = new Map(data.remote.map((r) => [r.work_date, r]));
  const leaveByDate = new Map<string, Leave>();
  for (const l of data.leaves) {
    for (const d of daysBetween(l.start_date, l.end_date)) leaveByDate.set(d, l);
  }
  return { sessionByDate, remoteByDate, leaveByDate };
}

export function classifyDay(date: string, idx: Index, settings: Settings, today: string): DayInfo {
  const working = isWorkingDay(date, settings);
  const base = { date, weekday: weekdayOf(date), isWorkingDay: working, workedMinutes: null, shortfallMinutes: 0 };

  const session = idx.sessionByDate.get(date);
  if (session) {
    const worked = sessionMinutes(session);
    if (worked === null) return { ...base, status: 'pending', session };
    const ok = worked >= session.required_minutes;
    return {
      ...base,
      status: ok ? 'complete' : 'short',
      session,
      workedMinutes: worked,
      shortfallMinutes: working ? shortfall(session.required_minutes, worked) : 0,
    };
  }
  const remote = idx.remoteByDate.get(date);
  if (remote) return { ...base, status: 'remote', remote };

  const leave = idx.leaveByDate.get(date);
  if (leave) {
    if (leave.leave_type === 'public_holiday') return { ...base, status: 'holiday', leave };
    if (working) return { ...base, status: leave.leave_type, leave };
    return { ...base, status: 'weekend', leave };          // weekend inside a leave range
  }
  if (!working) return { ...base, status: 'weekend' };
  if (date > today) return { ...base, status: 'future' };
  if (date === today) return { ...base, status: 'today' };
  return { ...base, status: 'not_recorded' };
}

/** Number of leave days that count against working days. */
export function leaveDayCount(leave: Pick<Leave, 'start_date' | 'end_date' | 'leave_type'>, settings: Settings): number {
  const days = daysBetween(leave.start_date, leave.end_date);
  return days.filter((d) => isWorkingDay(d, settings)).length;
}

export interface MonthSummary {
  scheduledWorkingDays: number;
  completedOfficeDays: number;
  shortWorkingDays: number;
  remoteDays: number;
  annualLeaveDays: number;
  sickLeaveDays: number;
  publicHolidays: number;
  pendingDays: number;
  notRecordedDays: number;
  totalWorkedMinutes: number;
  totalShortfallMinutes: number;
}

export interface MonthReport {
  year: number;
  month: number;
  days: DayInfo[];
  summary: MonthSummary;
}

export function monthReport(year: number, month: number, data: DataSet, settings: Settings, today: string): MonthReport {
  const idx = buildIndex(data);
  const days = monthDays(year, month).map((d) => classifyDay(d, idx, settings, today));
  const s: MonthSummary = {
    scheduledWorkingDays: 0, completedOfficeDays: 0, shortWorkingDays: 0, remoteDays: 0,
    annualLeaveDays: 0, sickLeaveDays: 0, publicHolidays: 0, pendingDays: 0,
    notRecordedDays: 0, totalWorkedMinutes: 0, totalShortfallMinutes: 0,
  };
  for (const d of days) {
    const holidayOnWorkingDay = d.isWorkingDay && d.leave?.leave_type === 'public_holiday';
    if (d.isWorkingDay && !holidayOnWorkingDay) s.scheduledWorkingDays++;
    switch (d.status) {
      case 'complete':
      case 'short':
        s.completedOfficeDays++;
        if (d.status === 'short' && d.isWorkingDay) s.shortWorkingDays++;   // weekend work is extra
        s.totalWorkedMinutes += d.workedMinutes ?? 0;
        s.totalShortfallMinutes += d.shortfallMinutes;
        break;
      case 'pending': s.pendingDays++; break;
      case 'remote': s.remoteDays++; break;
      case 'annual': s.annualLeaveDays++; break;
      case 'sick': s.sickLeaveDays++; break;
      case 'holiday': if (d.isWorkingDay) s.publicHolidays++; break;
      case 'not_recorded': s.notRecordedDays++; break;
      default: break;
    }
  }
  return { year, month, days, summary: s };
}

/** The oldest session without Clock Out, if any (forgotten Clock Out). */
export function activeSession(sessions: Session[]): Session | undefined {
  return sessions.filter((s) => !s.clock_out).sort((a, b) => a.clock_in.localeCompare(b.clock_in))[0];
}

/** Every classification on `date` other than `selfId` — mirrors the server rule. */
export function localConflicts(date: string, data: DataSet, selfId?: string) {
  const out: { kind: 'office' | 'remote' | Leave['leave_type']; id: string }[] = [];
  for (const s of data.sessions) if (s.work_date === date && s.id !== selfId) out.push({ kind: 'office', id: s.id });
  for (const r of data.remote) if (r.work_date === date && r.id !== selfId) out.push({ kind: 'remote', id: r.id });
  for (const l of data.leaves) {
    if (l.start_date <= date && l.end_date >= date && l.id !== selfId) out.push({ kind: l.leave_type, id: l.id });
  }
  return out;
}

export function nextDay(date: string) {
  return addDays(date, 1);
}
