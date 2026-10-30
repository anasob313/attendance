export type LeaveType = 'annual' | 'sick' | 'public_holiday';

export interface Session {
  id: string;
  user_id?: string;
  work_date: string;           // local date of clock_in (YYYY-MM-DD)
  clock_in: string;            // ISO (UTC)
  clock_out: string | null;    // null = active / pending
  required_minutes: number;    // target snapshot
  timezone: string;
  updated_at?: string;
}

export interface RemoteDay {
  id: string;
  work_date: string;
  updated_at?: string;
}

export interface Leave {
  id: string;
  leave_type: LeaveType;
  start_date: string;
  end_date: string;
  note: string;
  updated_at?: string;
}

export interface Settings {
  work_minutes: number;
  lead_minutes: number;
  working_days: number[];      // 0 = Sunday … 6 = Saturday
  timezone: string;
}

export interface Profile {
  id: string;
  full_name: string;
}

export type ReminderStatus = 'scheduled' | 'sending' | 'sent' | 'cancelled' | 'skipped' | 'failed';

export interface Reminder {
  session_id: string;
  fire_at: string;
  status: ReminderStatus;
  sent_at: string | null;
}

export interface PushDevice {
  id: string;
  endpoint: string;
  device_label: string;
  created_at: string;
  last_success_at: string | null;
}

export const DEFAULT_SETTINGS: Settings = {
  work_minutes: 480,
  lead_minutes: 20,
  working_days: [0, 1, 2, 3, 4],
  timezone: 'Asia/Riyadh',
};

export interface DataSet {
  sessions: Session[];
  remote: RemoteDay[];
  leaves: Leave[];
}

export interface Snapshot {
  sessions: Session[];
  remote: RemoteDay[];
  leaves: Leave[];
  reminders: Reminder[];
  settings: Settings;
  profile: Profile | null;
  fetchedAt: string | null;
}

export type ConflictKind = 'office' | 'remote' | LeaveType;

export interface Conflict {
  kind: ConflictKind;
  id: string;
  date: string;
  clock_in?: string;
  clock_out?: string | null;
  start_date?: string;
  end_date?: string;
}

export const KIND_LABEL: Record<ConflictKind, string> = {
  office: 'Office Attendance',
  remote: 'Remote Work',
  annual: 'Annual Leave',
  sick: 'Sick Leave',
  public_holiday: 'Public Holiday',
};
