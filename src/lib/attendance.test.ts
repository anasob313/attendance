import { describe, expect, it } from 'vitest';
import {
  buildIndex, classifyDay, expectedCompletion, leaveDayCount, monthReport, reminderTime,
  sessionMinutes, shortfall,
} from './attendance';
import { DEFAULT_SETTINGS, type Leave, type Session } from './types';
import {
  formatClock, formatMinutes, formatTime, fromInputValue, localDate, toInputValue, weekdayOf, zonedToUtc,
} from './time';

const TZ = 'Asia/Riyadh';
const at = (date: string, time: string) => zonedToUtc(date, time, TZ).toISOString();
const session = (date: string, inT: string, outDate: string | null, outT?: string, id = date): Session => ({
  id, work_date: date, clock_in: at(date, inT), clock_out: outDate ? at(outDate, outT!) : null,
  required_minutes: 480, timezone: TZ,
});

describe('time helpers', () => {
  it('converts Riyadh wall clock to UTC and back', () => {
    expect(at('2026-10-29', '08:00')).toBe('2026-10-29T05:00:00.000Z');
    expect(localDate('2026-10-29T21:30:00Z', TZ)).toBe('2026-10-30');
    expect(formatTime('2026-10-29T05:00:00Z', TZ)).toBe('8:00 AM');
    expect(toInputValue('2026-10-29T05:00:00Z', TZ)).toBe('2026-10-29T08:00');
    expect(fromInputValue('2026-10-29T08:00', TZ)?.toISOString()).toBe('2026-10-29T05:00:00.000Z');
  });
  it('handles DST zones', () => {
    // New York: 2026-03-08 springs forward, 2026-11-01 falls back
    expect(zonedToUtc('2026-03-09', '09:00', 'America/New_York').toISOString()).toBe('2026-03-09T13:00:00.000Z');
    expect(zonedToUtc('2026-11-02', '09:00', 'America/New_York').toISOString()).toBe('2026-11-02T14:00:00.000Z');
  });
  it('weekday numbering is 0=Sunday', () => {
    expect(weekdayOf('2026-10-29')).toBe(4); // Thursday
    expect(weekdayOf('2026-10-30')).toBe(5); // Friday
  });
  it('formats durations', () => {
    expect(formatMinutes(510)).toBe('8h 30m');
    expect(formatMinutes(450)).toBe('7h 30m');
    expect(formatClock((7 * 3600 + 30 * 60 + 15) * 1000)).toBe('07:30:15');
  });
});

describe('working hours (test cases 1-3)', () => {
  it('08:00 → 16:00 = exactly 8h, GREEN, no shortfall', () => {
    const s = session('2026-10-25', '08:00', '2026-10-25', '16:00');
    expect(sessionMinutes(s)).toBe(480);
    const d = classifyDay('2026-10-25', buildIndex({ sessions: [s], remote: [], leaves: [] }), DEFAULT_SETTINGS, '2026-10-29');
    expect(d.status).toBe('complete');
    expect(d.shortfallMinutes).toBe(0);
  });
  it('08:00 → 16:30 = 8h30, not capped', () => {
    const s = session('2026-10-25', '08:00', '2026-10-25', '16:30');
    expect(sessionMinutes(s)).toBe(510);
  });
  it('08:00 → 15:30 = 7h30, RED, shortfall 30m', () => {
    const s = session('2026-10-25', '08:00', '2026-10-25', '15:30');
    const d = classifyDay('2026-10-25', buildIndex({ sessions: [s], remote: [], leaves: [] }), DEFAULT_SETTINGS, '2026-10-29');
    expect(d.workedMinutes).toBe(450);
    expect(d.status).toBe('short');
    expect(d.shortfallMinutes).toBe(30);
    expect(shortfall(480, 510)).toBe(0);
  });
});

describe('notification timing (test case 4)', () => {
  it('Clock In 08:00 → reminder 15:40, complete 16:00', () => {
    const s = session('2026-10-29', '08:00', null);
    expect(formatTime(reminderTime(s, 20), TZ)).toBe('3:40 PM');
    expect(formatTime(expectedCompletion(s), TZ)).toBe('4:00 PM');
  });
});

describe('overnight (test case 15)', () => {
  it('Thu 22:00 → Fri 06:00 is one 8h record on Thursday', () => {
    const s = session('2026-10-29', '22:00', '2026-10-30', '06:00');
    expect(sessionMinutes(s)).toBe(480);
    const r = monthReport(2026, 10, { sessions: [s], remote: [], leaves: [] }, DEFAULT_SETTINGS, '2026-10-31');
    expect(r.days.find((d) => d.date === '2026-10-29')?.status).toBe('complete');
    expect(r.days.find((d) => d.date === '2026-10-30')?.status).toBe('weekend');
  });
});

describe('monthly report (test cases 9, 12-14, 16)', () => {
  const sessions = [
    session('2026-10-04', '08:00', '2026-10-04', '16:00'),          // Sun complete
    session('2026-10-05', '08:00', '2026-10-05', '15:30'),          // Mon short 30m
    session('2026-10-06', '08:00', '2026-10-06', '17:00'),          // Tue complete 9h
    session('2026-10-07', '08:00', null),                            // Wed pending (forgotten)
    session('2026-10-10', '09:00', '2026-10-10', '12:00'),          // Sat (weekend work) 3h
  ];
  const remote = [{ id: 'r1', work_date: '2026-10-08' }];            // Thu
  const leaves: Leave[] = [
    { id: 'l1', leave_type: 'annual', start_date: '2026-10-11', end_date: '2026-10-17', note: '' }, // Sun–Sat
    { id: 'l2', leave_type: 'sick', start_date: '2026-10-18', end_date: '2026-10-18', note: '' },
    { id: 'l3', leave_type: 'public_holiday', start_date: '2026-10-22', end_date: '2026-10-24', note: '' }, // Thu–Sat
  ];
  const r = monthReport(2026, 10, { sessions, remote, leaves }, DEFAULT_SETTINGS, '2026-10-26');
  const st = (d: string) => r.days.find((x) => x.date === d)?.status;

  it('classifies every day with the right colour status', () => {
    expect(st('2026-10-04')).toBe('complete');
    expect(st('2026-10-05')).toBe('short');
    expect(st('2026-10-07')).toBe('pending');
    expect(st('2026-10-08')).toBe('remote');
    expect(st('2026-10-09')).toBe('weekend');
    expect(st('2026-10-12')).toBe('annual');
    expect(st('2026-10-16')).toBe('weekend');     // Friday inside annual leave
    expect(st('2026-10-18')).toBe('sick');
    expect(st('2026-10-22')).toBe('holiday');
    expect(st('2026-10-24')).toBe('holiday');     // holiday shown on Saturday too
    expect(st('2026-10-21')).toBe('not_recorded');
    expect(st('2026-10-26')).toBe('today');
    expect(st('2026-10-27')).toBe('future');      // future days never count as missing
  });

  it('summarises without inventing hours', () => {
    expect(r.summary).toEqual({
      scheduledWorkingDays: 20,      // 21 Sun–Thu days in Oct 2026 minus 1 working-day holiday
      completedOfficeDays: 4,        // includes the Saturday session
      shortWorkingDays: 1,
      remoteDays: 1,
      annualLeaveDays: 5,            // Sun–Thu only, Fri/Sat excluded
      sickLeaveDays: 1,
      publicHolidays: 1,             // only Thursday 22 is a working day
      pendingDays: 1,
      notRecordedDays: 5,            // 1, 19, 20, 21, 25 Oct (past working days only)
      totalWorkedMinutes: 480 + 450 + 540 + 180,
      totalShortfallMinutes: 30,     // weekend session creates no shortfall
    });
  });

  it('leave day count excludes the weekend', () => {
    expect(leaveDayCount(leaves[0], DEFAULT_SETTINGS)).toBe(5);
  });
});
