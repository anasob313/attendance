// Thin, typed wrappers around Supabase. Every call runs with the signed-in
// user's JWT, so Row Level Security restricts it to that user's rows.
import { supabase } from './supabase';
import type { DeliveryRecord, ReminderRecord } from './reminderHealth';
import { AppError, toAppError } from './errors';
import type { Leave, LeaveType, Profile, PushDevice, Reminder, RemoteDay, Session, Settings } from './types';

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  let res;
  try {
    res = await supabase.rpc(fn, args);
  } catch (e) {
    throw toAppError(e);
  }
  if (res.error) throw toAppError(res.error);
  return res.data as T;
}

const SESSION_COLS = 'id, work_date, clock_in, clock_out, required_minutes, timezone, updated_at';

async function fetchAllRows<T>(table: string, cols: string, order: string): Promise<T[]> {
  const page = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += page) {
    let res;
    try {
      res = await supabase.from(table).select(cols).order(order).order('id').range(from, from + page - 1);
    } catch (e) {
      throw toAppError(e);
    }
    if (res.error) throw toAppError(res.error);
    const rows = (res.data ?? []) as unknown as T[];
    out.push(...rows);
    if (rows.length < page) return out;
  }
}

function normSettings(s: Settings): Settings {
  return { ...s, working_days: [...(s.working_days ?? [])].map(Number).sort() };
}

export const api = {
  // ---- reads --------------------------------------------------------
  async fetchEverything() {
    const since = new Date(Date.now() - 3 * 86400_000).toISOString();
    const [sessions, remote, leaves, settingsRes, profileRes, remindersRes] = await Promise.all([
      fetchAllRows<Session>('attendance_sessions', SESSION_COLS, 'work_date'),
      fetchAllRows<RemoteDay>('remote_days', 'id, work_date, updated_at', 'work_date'),
      fetchAllRows<Leave>('leaves', 'id, leave_type, start_date, end_date, note, updated_at', 'start_date'),
      supabase.from('user_settings').select('work_minutes, lead_minutes, working_days, timezone').maybeSingle(),
      supabase.from('profiles').select('id, full_name').maybeSingle(),
      supabase.from('reminders').select('session_id, fire_at, status, sent_at').gte('fire_at', since),
    ]).catch((e) => { throw toAppError(e); });
    for (const r of [settingsRes, profileRes, remindersRes]) if (r.error) throw toAppError(r.error);
    if (!settingsRes.data) throw new AppError('Your settings could not be loaded. Please sign out and sign in again.');
    return {
      sessions, remote, leaves,
      settings: normSettings(settingsRes.data as Settings),
      profile: (profileRes.data as Profile) ?? null,
      reminders: (remindersRes.data ?? []) as Reminder[],
    };
  },

  // ---- attendance (offline-capable; all idempotent) ----------------
  clockIn: (id: string, at: string, replace = false) =>
    rpc<Session>('clock_in', { p_id: id, p_at: at, p_replace: replace }),
  clockOut: (id: string, at: string) => rpc<Session>('clock_out', { p_id: id, p_at: at }),
  undoClockOut: (id: string) => rpc<Session>('undo_clock_out', { p_id: id }),
  setRemote: (date: string, replace = false, id: string | null = null) =>
    rpc<RemoteDay>('set_remote', { p_date: date, p_replace: replace, p_id: id }),
  deleteRemote: (date: string) => rpc<boolean>('delete_remote', { p_date: date }),

  // ---- attendance (online only) ------------------------------------
  upsertSession: (id: string, clockIn: string, clockOut: string | null, replace = false) =>
    rpc<Session>('upsert_session', { p_id: id, p_clock_in: clockIn, p_clock_out: clockOut, p_replace: replace }),
  deleteSession: (id: string) => rpc<boolean>('delete_session', { p_id: id }),
  saveLeave: (l: { id: string; type: LeaveType; start: string; end: string; note: string }, replace = false) =>
    rpc<Leave>('save_leave', { p_id: l.id, p_type: l.type, p_start: l.start, p_end: l.end, p_note: l.note, p_replace: replace }),
  deleteLeave: (id: string) => rpc<boolean>('delete_leave', { p_id: id }),
  recalculate: () => rpc<number>('recalculate_required_minutes', {}),

  // ---- settings & profile -------------------------------------------
  async saveSettings(userId: string, s: Settings) {
    const { data, error } = await supabase.from('user_settings')
      .update({ work_minutes: s.work_minutes, lead_minutes: s.lead_minutes, working_days: s.working_days, timezone: s.timezone })
      .eq('user_id', userId)
      .select('work_minutes, lead_minutes, working_days, timezone').single();
    if (error) throw toAppError(error);
    return normSettings(data as Settings);
  },
  async saveProfile(id: string, fullName: string) {
    const { data, error } = await supabase.from('profiles').update({ full_name: fullName }).eq('id', id)
      .select('id, full_name').single();
    if (error) throw toAppError(error);
    await supabase.auth.updateUser({ data: { full_name: fullName } });
    return data as Profile;
  },

  // ---- push devices -------------------------------------------------
  registerPush: (endpoint: string, p256dh: string, auth: string, label: string) =>
    rpc<string>('register_push_subscription', { p_endpoint: endpoint, p_p256dh: p256dh, p_auth: auth, p_label: label }),
  unregisterPush: (endpoint: string) => rpc<boolean>('unregister_push_subscription', { p_endpoint: endpoint }),
  async listDevices(): Promise<PushDevice[]> {
    const { data, error } = await supabase.from('push_subscriptions')
      .select('id, endpoint, device_label, created_at, last_success_at').order('created_at');
    if (error) throw toAppError(error);
    return (data ?? []) as PushDevice[];
  },
  async removeDevice(id: string) {
    const { error } = await supabase.from('push_subscriptions').delete().eq('id', id);
    if (error) throw toAppError(error);
  },

  // ---- reminder delivery evidence (read-only) ------------------------
  async reminderHealth(sessionId: string): Promise<{ devices: number; reminder: ReminderRecord | null; deliveries: DeliveryRecord[] }> {
    const [subs, rem, dels] = await Promise.all([
      supabase.from('push_subscriptions').select('id', { count: 'exact', head: true }),
      supabase.from('reminders').select('status, fire_at, sent_at, last_error').eq('session_id', sessionId).maybeSingle(),
      supabase.from('push_deliveries').select('sent_at, push_status, displayed_at, display_error')
        .eq('session_id', sessionId).eq('kind', 'reminder').order('sent_at'),
    ]);
    const err = subs.error ?? rem.error ?? dels.error;
    if (err) throw toAppError(err);
    return { devices: subs.count ?? 0, reminder: (rem.data as ReminderRecord | null) ?? null, deliveries: (dels.data ?? []) as DeliveryRecord[] };
  },

  // ---- account ------------------------------------------------------
  deleteAccount: () => rpc<boolean>('delete_my_account', {}),
};
