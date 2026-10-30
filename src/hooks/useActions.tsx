// Attendance actions with the conflict dialog (CANCEL / REPLACE) and clear
// feedback about where the change is stored.
import { useCallback } from 'react';
import { useData } from '../state/data';
import { useUi } from '../state/ui';
import { AppError, toAppError } from '../lib/errors';
import { KIND_LABEL, type Conflict, type ConflictKind } from '../lib/types';
import { localConflicts } from '../lib/attendance';
import type { NewOp } from '../lib/sync';
import { formatDateShort, formatTime, localDate } from '../lib/time';

export function describeConflicts(conflicts: Conflict[], newKind: ConflictKind, tz: string): { title: string; message: string } {
  const label = KIND_LABEL[newKind];
  const uniq = conflicts.filter((c, i, a) => a.findIndex((x) => x.kind === c.kind && x.id === c.id) === i);
  if (uniq.length === 1) {
    const c = uniq[0];
    if (c.kind === 'office' && newKind === 'office') {
      const times = c.clock_in ? ` (${formatTime(c.clock_in, tz)} – ${c.clock_out ? formatTime(c.clock_out, tz) : 'no Clock Out'})` : '';
      return { title: 'Replace attendance?', message: `This day already has Office Attendance${times}. Would you like to replace it?` };
    }
    const isRange = c.start_date && c.end_date && c.start_date !== c.end_date;
    const what = isRange
      ? `${KIND_LABEL[c.kind]} (${formatDateShort(c.start_date!)} – ${formatDateShort(c.end_date!)})`
      : KIND_LABEL[c.kind];
    const subject = newKind === 'annual' || newKind === 'sick' || newKind === 'public_holiday' ? 'Part of this period' : 'This day';
    return {
      title: `Replace ${KIND_LABEL[c.kind]}?`,
      message: `${subject} is already marked as ${what}. Would you like to replace it with ${label}?${isRange ? ' The other leave is shortened, not deleted entirely.' : ''}`,
    };
  }
  const lines = uniq.map((c) => `${KIND_LABEL[c.kind]} on ${formatDateShort(c.kind === 'office' && c.clock_in ? localDate(c.clock_in, tz) : c.date)}`);
  return {
    title: 'Replace existing records?',
    message: `These days already have other records: ${lines.join(', ')}. Would you like to replace them with ${label}?`,
  };
}

export function useActions() {
  const data = useData();
  const { confirm, toast } = useUi();
  const tz = data.settings.timezone;

  const feedback = useCallback((status: 'synced' | 'saved_locally', success: string) => {
    if (status === 'synced') toast(success, { tone: 'success' });
    else toast(`${success} — saved on this device, will sync when you are back online.`);
  }, [toast]);

  /** Queue-backed action (works offline). Returns true when kept. */
  const run = useCallback(async (op: NewOp, kind: ConflictKind, success: string, undo?: () => void): Promise<boolean> => {
    const r = await data.perform(op);
    if (r.status !== 'failed') {
      if (undo) toast(r.status === 'synced' ? success : `${success} (saved on this device)`, { action: { label: 'Undo', run: undo } });
      else feedback(r.status, success);
      return true;
    }
    if (r.error.code === 'AT409' && r.error.conflicts?.length) {
      const d = describeConflicts(r.error.conflicts, kind, tz);
      if (await confirm({ ...d, confirmLabel: 'REPLACE', cancelLabel: 'CANCEL', destructive: true })) {
        const r2 = await data.retry(r.opId, { replace: true });
        if (r2.status !== 'failed') { feedback(r2.status, success); return true; }
        data.discard(r.opId);
        toast(r2.error.message, { tone: 'error' });
        return false;
      }
      data.discard(r.opId);
      return false;
    }
    data.discard(r.opId);          // user is here and has seen the reason
    toast(r.error.message, { tone: 'error', duration: 6000 });
    void data.refresh();
    return false;
  }, [confirm, data, feedback, toast, tz]);

  /** Ask before replacing, based on what this device already knows. */
  const confirmLocal = useCallback(async (date: string, kind: ConflictKind, selfId?: string): Promise<boolean | null> => {
    const found = localConflicts(date, data.view, selfId).filter((c) => !(kind === 'remote' && c.kind === 'remote'));
    if (!found.length) return false;
    const d = describeConflicts(found.map((c) => ({ ...c, date })), kind, tz);
    const ok = await confirm({ ...d, confirmLabel: 'REPLACE', cancelLabel: 'CANCEL', destructive: true });
    return ok ? true : null;      // null = cancelled
  }, [confirm, data.view, tz]);

  /** Online-only server call with the same CANCEL / REPLACE flow. */
  const withReplace = useCallback(async <T,>(fn: (replace: boolean) => Promise<T>, kind: ConflictKind): Promise<T | null> => {
    try {
      return await data.runOnline(() => fn(false));
    } catch (e) {
      const err = toAppError(e);
      if (err.code === 'AT409' && err.conflicts?.length) {
        const d = describeConflicts(err.conflicts, kind, tz);
        if (!(await confirm({ ...d, confirmLabel: 'REPLACE', cancelLabel: 'CANCEL', destructive: true }))) return null;
        return await data.runOnline(() => fn(true));
      }
      throw err;
    }
  }, [confirm, data, tz]);

  const report = useCallback((e: unknown) => {
    const err = e instanceof AppError ? e : toAppError(e);
    toast(err.message, { tone: 'error', duration: 6000 });
  }, [toast]);

  return { run, confirmLocal, withReplace, report, toast, confirm };
}
