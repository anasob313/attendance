import { describe, expect, it } from 'vitest';
import { reminderIssue, type ReminderHealthInput } from './reminderHealth';

const fire = '2026-11-01T13:45:44Z';          // 4:45 PM Riyadh
const base = (over: Partial<ReminderHealthInput> = {}): ReminderHealthInput => ({
  now: Date.parse('2026-11-01T14:00:00Z'),
  sessionOpen: true,
  devices: 1,
  reminder: { status: 'sent', fire_at: fire, sent_at: '2026-11-01T13:46:01Z', last_error: null },
  deliveries: [{ sent_at: '2026-11-01T13:46:01Z', push_status: 201, displayed_at: '2026-11-01T13:46:03Z', display_error: null }],
  timezone: 'Asia/Riyadh',
  ...over,
});

describe('reminder health', () => {
  it('no warning when the phone confirmed the reminder', () => {
    expect(reminderIssue(base())).toBeNull();
  });
  it('warns when the phone never confirmed it (after the automatic re-send window)', () => {
    const r = reminderIssue(base({ deliveries: [
      { sent_at: '2026-11-01T13:46:01Z', push_status: 201, displayed_at: null, display_error: null },
      { sent_at: '2026-11-01T13:48:01Z', push_status: 201, displayed_at: null, display_error: null },
    ] }));
    expect(r?.tone).toBe('warn');
    expect(r?.text).toContain('4:45 PM');
    expect(r?.text).toContain('2 attempts');
    expect(r?.text).toContain('did not confirm');
  });
  it('waits for the receipt before warning', () => {
    expect(reminderIssue(base({ now: Date.parse('2026-11-01T13:48:00Z'), deliveries: [
      { sent_at: '2026-11-01T13:46:01Z', push_status: 201, displayed_at: null, display_error: null },
    ] }))).toBeNull();
  });
  it('no warning for reminders sent before receipts existed', () => {
    expect(reminderIssue(base({ deliveries: [] }))).toBeNull();
  });
  it('reports a display error from the phone', () => {
    const r = reminderIssue(base({ deliveries: [{ sent_at: '2026-11-01T13:46:01Z', push_status: 201, displayed_at: null, display_error: 'showNotification failed: X' }] }));
    expect(r?.text).toContain('could not be shown');
  });
  it('warns while working when no device is registered', () => {
    const r = reminderIssue(base({ devices: 0, reminder: { status: 'scheduled', fire_at: fire, sent_at: null, last_error: null }, deliveries: [] }));
    expect(r?.text).toContain('No device is set up');
  });
  it('explains skipped and failed reminders', () => {
    expect(reminderIssue(base({ reminder: { status: 'skipped', fire_at: fire, sent_at: null, last_error: 'no registered devices' }, deliveries: [] }))?.text).toContain('no device was set up');
    expect(reminderIssue(base({ reminder: { status: 'failed', fire_at: fire, sent_at: null, last_error: '500: boom' }, deliveries: [] }))?.tone).toBe('error');
  });
  it('stops showing 12 hours after the reminder time, and never before it', () => {
    const d = [{ sent_at: '2026-11-01T13:46:01Z', push_status: 201, displayed_at: null, display_error: null }];
    expect(reminderIssue(base({ now: Date.parse('2026-11-02T02:00:00Z'), deliveries: d }))).toBeNull();
    expect(reminderIssue(base({ now: Date.parse('2026-11-01T13:00:00Z'), deliveries: d, reminder: { status: 'scheduled', fire_at: fire, sent_at: null, last_error: null } }))).toBeNull();
  });
});
