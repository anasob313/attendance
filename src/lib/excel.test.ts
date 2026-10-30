import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { fullExportWorkbook, monthFileName, monthWorkbook } from './excel';
import { DEFAULT_SETTINGS, type DataSet } from './types';
import { zonedToUtc } from './time';

const at = (d: string, t: string) => zonedToUtc(d, t, 'Asia/Riyadh').toISOString();
const data: DataSet = {
  sessions: [
    { id: '1', work_date: '2026-10-04', clock_in: at('2026-10-04', '08:00'), clock_out: at('2026-10-04', '16:30'), required_minutes: 480, timezone: 'Asia/Riyadh' },
    { id: '2', work_date: '2026-10-05', clock_in: at('2026-10-05', '08:00'), clock_out: at('2026-10-05', '15:30'), required_minutes: 480, timezone: 'Asia/Riyadh' },
    { id: '3', work_date: '2026-10-07', clock_in: at('2026-10-07', '08:00'), clock_out: null, required_minutes: 480, timezone: 'Asia/Riyadh' },
    { id: '4', work_date: '2026-10-29', clock_in: at('2026-10-29', '22:00'), clock_out: at('2026-10-30', '06:00'), required_minutes: 480, timezone: 'Asia/Riyadh' },
  ],
  remote: [{ id: 'r', work_date: '2026-10-08' }],
  leaves: [
    { id: 'l', leave_type: 'annual', start_date: '2026-10-11', end_date: '2026-10-15', note: '' },
    { id: 'h', leave_type: 'public_holiday', start_date: '2026-10-22', end_date: '2026-10-22', note: 'Holiday' },
  ],
};

describe('excel export (test case 17)', () => {
  it('names the file as required', () => {
    expect(monthFileName(2026, 10)).toBe('Attendance_Report_October_2026.xlsx');
  });

  it('produces a real xlsx (zip) workbook', async () => {
    const blob = await monthWorkbook(2026, 10, data, DEFAULT_SETTINGS, 'Test User', '2026-10-31');
    const buf = Buffer.from(await blob.arrayBuffer());
    expect(buf.subarray(0, 2).toString()).toBe('PK');
    if (process.env.EXPORT_DIR) writeFileSync(`${process.env.EXPORT_DIR}/${monthFileName(2026, 10)}`, buf);
    const full = await fullExportWorkbook(data, DEFAULT_SETTINGS, 'Test User', 'test@example.com');
    const fbuf = Buffer.from(await full.arrayBuffer());
    expect(fbuf.subarray(0, 2).toString()).toBe('PK');
    if (process.env.EXPORT_DIR) writeFileSync(`${process.env.EXPORT_DIR}/Attendance_Export.xlsx`, fbuf);
  });
});
