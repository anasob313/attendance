// Timezone-aware date helpers built on Intl (no extra dependencies).
// Dates are 'YYYY-MM-DD' strings in the user's configured timezone;
// instants are ISO strings / epoch ms (UTC).

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(key: string, make: () => Intl.DateTimeFormat) {
  let f = fmtCache.get(key);
  if (!f) {
    f = make();
    fmtCache.set(key, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function toMs(t: Date | string | number): number {
  return typeof t === 'number' ? t : typeof t === 'string' ? Date.parse(t) : t.getTime();
}

interface Parts { year: number; month: number; day: number; hour: number; minute: number; second: number }

export function zonedParts(t: Date | string | number, tz: string): Parts {
  const f = fmt(`parts|${tz}`, () => new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }));
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(new Date(toMs(t)))) {
    if (x.type !== 'literal') p[x.type] = Number(x.value);
  }
  return { year: p.year, month: p.month, day: p.day, hour: p.hour % 24, minute: p.minute, second: p.second };
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Local calendar date (YYYY-MM-DD) of an instant in a timezone. */
export function localDate(t: Date | string | number, tz: string): string {
  const p = zonedParts(t, tz);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

export function todayIn(tz: string, now: number = Date.now()): string {
  return localDate(now, tz);
}

/** Offset (ms) of the timezone at an instant: wall-clock-as-UTC minus UTC. */
export function tzOffsetMs(t: number, tz: string): number {
  const p = zonedParts(t, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(t / 1000) * 1000;
}

/** Convert a wall-clock date + time in `tz` to a UTC Date. */
export function zonedToUtc(date: string, time: string, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm, ss = 0] = time.split(':').map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm, ss);
  let guess = wall - tzOffsetMs(wall, tz);
  const second = wall - tzOffsetMs(guess, tz);   // correct across DST edges
  if (second !== guess) guess = second;
  return new Date(guess);
}

/** 'YYYY-MM-DDTHH:mm' (for <input type="datetime-local">) in tz. */
export function toInputValue(t: Date | string | number, tz: string): string {
  const p = zonedParts(t, tz);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

export function fromInputValue(v: string, tz: string): Date | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2})?$/.exec(v);
  if (!m) return null;
  return zonedToUtc(m[1], m[2], tz);
}

/** 0 = Sunday … 6 = Saturday, for a YYYY-MM-DD date. */
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function addDays(date: string, n: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + n * DAY;
  return new Date(t).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function monthDays(year: number, month: number): string[] {
  const first = `${pad(year, 4)}-${pad(month)}-01`;
  const last = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return daysBetween(first, last);
}

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function formatTime(t: Date | string | number, tz: string): string {
  return fmt(`time|${tz}`, () => new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true,
  })).format(new Date(toMs(t)));
}

export function formatDateLong(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return `${WEEKDAY_LONG[weekdayOf(date)]}, ${d} ${MONTH_NAMES[m - 1]} ${y}`;
}

export function formatDateShort(date: string): string {
  const [, m, d] = date.split('-').map(Number);
  return `${WEEKDAY_SHORT[weekdayOf(date)]} ${d} ${MONTH_NAMES[m - 1].slice(0, 3)}`;
}

/** Time of an instant, with the local date when it differs from `refDate`. */
export function formatTimeOnDate(t: string, tz: string, refDate: string): string {
  const d = localDate(t, tz);
  return d === refDate ? formatTime(t, tz) : `${formatTime(t, tz)} (${formatDateShort(d)})`;
}

/** 510 → "8h 30m", 480 → "8h 00m" */
export function formatMinutes(totalMinutes: number): string {
  const sign = totalMinutes < 0 ? '-' : '';
  const m = Math.abs(Math.round(totalMinutes));
  return `${sign}${Math.floor(m / 60)}h ${pad(m % 60)}m`;
}

/** Live timer: 27_015_000 → "07:30:15" */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** 480 → "8", 510 → "8.5", 500 → "8h 20m" */
export function formatHoursPlain(minutes: number): string {
  if (minutes % 60 === 0) return String(minutes / 60);
  if (minutes % 30 === 0) return String(minutes / 60);
  return formatMinutes(minutes);
}

export function minutesBetween(a: string | number | Date, b: string | number | Date): number {
  return (toMs(b) - toMs(a)) / MINUTE;
}

export function listTimeZones(): string[] {
  const anyIntl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  const zones = anyIntl.supportedValuesOf?.('timeZone') ?? [];
  const base = zones.length ? zones : ['Asia/Riyadh', 'UTC'];
  return base.includes('UTC') ? base : [...base, 'UTC'];
}
