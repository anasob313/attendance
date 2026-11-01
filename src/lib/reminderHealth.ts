// Tells the user when their reminder did not (provably) reach the phone.
// Evidence comes from the server: the reminder record and the delivery log,
// where the phone's service worker confirms each notification it displayed.
import { formatTime } from './time';

export interface ReminderRecord {
  status: 'scheduled' | 'sending' | 'sent' | 'cancelled' | 'skipped' | 'failed';
  fire_at: string;
  sent_at: string | null;
  last_error: string | null;
}

export interface DeliveryRecord {
  sent_at: string;
  push_status: number | null;
  displayed_at: string | null;
  display_error: string | null;
}

export interface ReminderHealthInput {
  now: number;
  sessionOpen: boolean;
  devices: number;
  reminder: ReminderRecord | null;
  deliveries: DeliveryRecord[];
  timezone: string;
}

export interface ReminderIssue {
  tone: 'warn' | 'error';
  text: string;
}

const MIN = 60_000;
/** How long after the reminder time a problem stays visible. */
const SHOW_FOR = 12 * 60 * MIN;
/** Receipt wait, including the server's one automatic re-send at +2 min. */
const CONFIRM_WAIT = 5 * MIN;

export function reminderIssue(i: ReminderHealthInput): ReminderIssue | null {
  const r = i.reminder;
  if (i.sessionOpen && i.devices === 0 && (!r || r.status === 'scheduled')) {
    return { tone: 'warn', text: 'No device is set up for notifications, so your reminder cannot be delivered. Turn them on in Settings.' };
  }
  if (!r) return null;
  const fire = Date.parse(r.fire_at);
  if (i.now - fire > SHOW_FOR || i.now < fire) return null;
  const at = formatTime(r.fire_at, i.timezone);

  if (r.status === 'skipped' && r.last_error === 'no registered devices') {
    return { tone: 'warn', text: `Your ${at} reminder could not be sent: no device was set up for notifications. Turn them on in Settings.` };
  }
  if (r.status === 'skipped' && r.last_error === 'all devices unsubscribed') {
    return { tone: 'warn', text: `Your ${at} reminder could not be sent: this device's notification registration expired. Open Settings and turn notifications on again.` };
  }
  if (r.status === 'skipped' && r.last_error === 'expired') {
    return { tone: 'error', text: `Your ${at} reminder was not sent on time because of a server delay.` };
  }
  if (r.status === 'failed') {
    return { tone: 'error', text: `Your ${at} reminder could not be delivered${r.last_error ? ` (${r.last_error.slice(0, 80)})` : ''}.` };
  }
  if (r.status === 'sent') {
    if (!i.deliveries.length) return null;                  // sent before delivery receipts existed
    if (i.deliveries.some((d) => d.displayed_at)) return null;
    const first = Math.min(...i.deliveries.map((d) => Date.parse(d.sent_at)));
    if (i.now - first < CONFIRM_WAIT) return null;
    const failedToShow = i.deliveries.find((d) => d.display_error)?.display_error;
    return {
      tone: 'warn',
      text: failedToShow
        ? `Your ${at} reminder reached this phone but could not be shown (${failedToShow.slice(0, 80)}).`
        : `Your ${at} reminder was sent${i.deliveries.length > 1 ? ` (${i.deliveries.length} attempts)` : ''}, but your phone did not confirm showing it. Check Focus / Do Not Disturb and iPhone Settings → Notifications → Attendance.`,
    };
  }
  return null;
}
