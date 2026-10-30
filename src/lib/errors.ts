import type { Conflict } from './types';

export class AppError extends Error {
  code: string;
  conflicts?: Conflict[];
  detail?: unknown;
  /** The request never reached the server (offline, DNS, timeout…). */
  network: boolean;
  /** The sign-in session is missing or expired. */
  auth: boolean;

  constructor(message: string, opts: Partial<Pick<AppError, 'code' | 'conflicts' | 'detail' | 'network' | 'auth'>> = {}) {
    super(message);
    this.name = 'AppError';
    this.code = opts.code ?? '';
    this.conflicts = opts.conflicts;
    this.detail = opts.detail;
    this.network = opts.network ?? false;
    this.auth = opts.auth ?? false;
  }
}

const NETWORK_RE = /failed to fetch|networkerror|load failed|network request failed|fetch failed|timeout|aborted|offline/i;

function parseJson(s: unknown): unknown {
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return s; }
}

interface PgLike { code?: string; message?: string; details?: string | null; hint?: string | null; status?: number }

export function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  const err = (e ?? {}) as PgLike & { name?: string };
  const message = String(err.message ?? e ?? 'Unknown error');
  const code = String(err.code ?? '');

  if ((e instanceof TypeError && NETWORK_RE.test(message)) || (!code && NETWORK_RE.test(message)) || err.name === 'AbortError') {
    return new AppError('No internet connection. Your change is kept and will sync automatically.', { code: 'NETWORK', network: true });
  }
  if (code === 'AT401' || code === 'PGRST301' || code === 'PGRST303' || /jwt expired|invalid jwt|not signed in/i.test(message) || err.status === 401) {
    return new AppError('Your sign-in has expired. Please sign in again — unsynced changes are kept on this device.', { code: 'AUTH', auth: true });
  }
  switch (code) {
    case 'AT409': {
      const conflicts = parseJson(err.details) as Conflict[];
      return new AppError('This day already has another attendance type.', { code, conflicts: Array.isArray(conflicts) ? conflicts : [] });
    }
    case 'AT400': case 'AT001': case 'AT002': case 'AT003': case 'AT004':
      return new AppError(message, { code, detail: parseJson(err.details) });
    case '23P01':
      return new AppError('This time range overlaps another attendance session. Adjust the times or fix the other session first.', { code });
    case '23505':
      return new AppError('This record already exists.', { code });
    case '23514':
      return new AppError('One of the values is outside the allowed range.', { code });
    case '42501':
      return new AppError('You are not allowed to do that.', { code });
    default:
      return new AppError(message || 'Something went wrong. Please try again.', { code });
  }
}
