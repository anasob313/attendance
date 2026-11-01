import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useData } from '../state/data';
import { useUi } from '../state/ui';
import { api } from '../lib/api';
import { toAppError } from '../lib/errors';
import { WEEKDAY_SHORT, formatDateShort, formatMinutes, isValidTimeZone, listTimeZones } from '../lib/time';
import { currentEndpoint, disablePush, enablePush, isIOS, isStandalone, pushSupport, sendTestPush } from '../lib/push';
import type { PushDevice, Settings } from '../lib/types';
import { PageHeader, Notice, Spinner } from '../components/ui';
import { SyncBadge } from '../components/Layout';
import { IconBell, IconChevronRight, IconLogout, IconPalm, IconShare, IconUser } from '../components/icons';

export function SettingsPage() {
  const data = useData();
  const { toast, confirm } = useUi();
  const [form, setForm] = useState<Settings>(data.settings);
  const [saving, setSaving] = useState(false);
  // Follow server changes only when their content changes (not on every refresh).
  const serverKey = JSON.stringify(data.settings);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setForm(JSON.parse(serverKey) as Settings), [serverKey]);

  const dirty = JSON.stringify(form) !== JSON.stringify(data.settings);
  const hours = Math.floor(form.work_minutes / 60);
  const mins = form.work_minutes % 60;
  const err = form.lead_minutes >= form.work_minutes ? 'The reminder must come before the end of the working duration.'
    : form.working_days.length === 0 ? 'Choose at least one working day.'
      : !isValidTimeZone(form.timezone) ? 'Unknown timezone.' : null;

  const save = async () => {
    setSaving(true);
    const workChanged = form.work_minutes !== data.settings.work_minutes;
    try {
      const saved = await data.runOnline(() => api.saveSettings(data.userId, form));
      data.patchSnapshot({ settings: saved });
      toast('Settings saved. Any running reminder was rescheduled.', { tone: 'success' });
      if (workChanged && await confirm({
        title: 'Recalculate past records?',
        message: `Completed days keep their original target unless you recalculate. Apply ${formatMinutes(saved.work_minutes)} to all past attendance records?`,
        confirmLabel: 'RECALCULATE', cancelLabel: 'KEEP HISTORY',
      })) {
        const n = await data.runOnline(() => api.recalculate());
        toast(`${n} record${n === 1 ? '' : 's'} recalculated`, { tone: 'success' });
      }
    } catch (e) {
      toast(toAppError(e).message, { tone: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const zones = listTimeZones();

  return (
    <div className="tabbar-space mx-auto max-w-lg px-4">
      <PageHeader title="Settings" right={<SyncBadge />} />

      <div className="space-y-6">
        <section>
          <h2 className="section-title">Account</h2>
          <div className="card list-divide !py-0">
            <Link to="/account" className="list-row"><span className="flex items-center gap-3"><IconUser size={20} />{data.profile?.full_name || 'Profile'}<span className="text-sm text-zinc-500">{data.email}</span></span><IconChevronRight size={18} /></Link>
            <Link to="/leave" className="list-row"><span className="flex items-center gap-3"><IconPalm size={20} />Leave & holidays</span><IconChevronRight size={18} /></Link>
            <Link to="/install" className="list-row"><span className="flex items-center gap-3"><IconShare size={20} />Install on iPhone</span><IconChevronRight size={18} /></Link>
          </div>
        </section>

        <section>
          <h2 className="section-title">Working schedule</h2>
          <div className="card space-y-4">
            <div className="field">
              <span className="label">Required daily working duration (breaks included)</span>
              <div className="grid grid-cols-2 gap-3">
                <select className="input" value={hours} aria-label="Hours"
                  onChange={(e) => setForm({ ...form, work_minutes: Number(e.target.value) * 60 + mins })}>
                  {Array.from({ length: 16 }, (_, i) => i + 1).map((h) => <option key={h} value={h}>{h} hours</option>)}
                </select>
                <select className="input" value={mins} aria-label="Minutes"
                  onChange={(e) => setForm({ ...form, work_minutes: hours * 60 + Number(e.target.value) })}>
                  {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map((m) => <option key={m} value={m}>{m} min</option>)}
                </select>
              </div>
            </div>
            <label className="field">
              <span className="label">Reminder before completion</span>
              <select className="input" value={form.lead_minutes} onChange={(e) => setForm({ ...form, lead_minutes: Number(e.target.value) })}>
                {[5, 10, 15, 20, 25, 30, 45, 60].map((m) => <option key={m} value={m}>{m} minutes before</option>)}
              </select>
              <span className="text-xs text-zinc-500">
                Clock In 08:00 → reminder at {formatClockLabel(8 * 60 + form.work_minutes - form.lead_minutes)}, complete at {formatClockLabel(8 * 60 + form.work_minutes)}.
              </span>
            </label>
            <div className="field">
              <span className="label">Working days (others are weekend)</span>
              <div className="grid grid-cols-7 gap-1.5">
                {WEEKDAY_SHORT.map((d, i) => {
                  const on = form.working_days.includes(i);
                  return (
                    <button key={d} aria-pressed={on}
                      onClick={() => setForm({ ...form, working_days: on ? form.working_days.filter((x) => x !== i) : [...form.working_days, i].sort() })}
                      className={`rounded-xl py-2.5 text-xs font-semibold ${on ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900' : 'bg-zinc-100 text-zinc-500 dark:bg-white/5'}`}>
                      {d}
                    </button>
                  );
                })}
              </div>
            </div>
            <label className="field">
              <span className="label">Timezone</span>
              <select className="input" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
                {zones.map((z) => <option key={z} value={z}>{z}</option>)}
              </select>
              <span className="text-xs text-zinc-500">Existing records keep the date they were recorded on.</span>
            </label>
            {err && <Notice tone="error">{err}</Notice>}
            {data.editBlockedReason && dirty && <Notice tone="warn">{data.editBlockedReason}</Notice>}
            <div className="grid grid-cols-2 gap-3">
              <button className="btn-secondary" disabled={!dirty || saving} onClick={() => setForm(data.settings)}>Reset</button>
              <button className="btn-primary" disabled={!dirty || saving || !!err || !!data.editBlockedReason} onClick={save}>{saving ? <Spinner /> : 'Save'}</button>
            </div>
            <button className="btn-ghost w-full text-sm" disabled={!!data.editBlockedReason}
              onClick={async () => {
                if (!(await confirm({ title: 'Recalculate all records?', message: `Apply the current target (${formatMinutes(data.settings.work_minutes)}) to every past attendance record. Colours and shortfall will be recalculated.`, confirmLabel: 'RECALCULATE' }))) return;
                try {
                  const n = await data.runOnline(() => api.recalculate());
                  toast(`${n} record${n === 1 ? '' : 's'} recalculated`, { tone: 'success' });
                } catch (e) { toast(toAppError(e).message, { tone: 'error' }); }
              }}>
              Recalculate historical records…
            </button>
          </div>
        </section>

        <NotificationsSection />

        <section>
          <button className="btn-secondary w-full text-red-600 dark:text-red-400" onClick={async () => {
            const pending = data.ops.length;
            const ok = await confirm({
              title: 'Sign out?',
              message: pending ? `${pending} change${pending === 1 ? ' is' : 's are'} not synced yet. They stay on this device and sync after you sign in again.` : 'Reminders stop on this device until you sign in again.',
              confirmLabel: 'SIGN OUT', destructive: true,
            });
            if (ok) await data.signOut();
          }}><IconLogout size={18} />Sign out</button>
          <p className="mt-4 text-center text-xs text-zinc-400">Personal attendance tracker · not connected to any employer system</p>
        </section>
      </div>
    </div>
  );
}

function formatClockLabel(totalMinutes: number) {
  const m = ((totalMinutes % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, '0');
  return `${((h + 11) % 12) + 1}:${mm} ${h < 12 ? 'AM' : 'PM'}`;
}

function NotificationsSection() {
  const data = useData();
  const { toast, confirm } = useUi();
  const [support, setSupport] = useState(pushSupport());
  const [thisDevice, setThisDevice] = useState<string | null>(null);
  const [devices, setDevices] = useState<PushDevice[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setSupport(pushSupport());
    setThisDevice(await currentEndpoint());
    if (!data.online) return;
    try { setDevices(await api.listDevices()); } catch { setDevices(null); }
  }, [data.online]);
  useEffect(() => { void load(); }, [load]);

  const enabledHere = !!thisDevice && devices?.some((d) => d.endpoint === thisDevice);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } catch (e) { toast(toAppError(e).message, { tone: 'error', duration: 7000 }); } finally { setBusy(false); void load(); }
  };

  return (
    <section>
      <h2 className="section-title">Notifications</h2>
      <div className="card space-y-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-100 dark:bg-white/10"><IconBell size={18} /></div>
          <div className="text-sm">
            <div className="font-semibold">8-hour reminder</div>
            <div className="text-zinc-500">
              One notification {data.settings.lead_minutes} minutes before your {formatMinutes(data.settings.work_minutes)} are complete, sent by the server even when the app is closed or the phone is locked. Delivery normally takes seconds to a minute but is not guaranteed to the second.
            </div>
          </div>
        </div>

        {!support.ok && (
          <Notice tone={support.reason === 'install' ? 'info' : 'warn'} action={support.reason === 'install' ? <Link to="/install" className="font-semibold underline">How</Link> : undefined}>
            {support.message}
          </Notice>
        )}

        {support.ok && (
          enabledHere ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <button className="btn-secondary" disabled={busy || !data.online} onClick={() => act(async () => {
                  const r = await sendTestPush();
                  toast(`Test sent to ${r.delivered ?? 0} of ${r.devices} device${r.devices === 1 ? '' : 's'}`, { tone: 'success' });
                })}>Send test</button>
                <button className="btn-secondary" disabled={busy} onClick={() => act(async () => { await disablePush(); toast('Notifications turned off on this device'); })}>Turn off here</button>
              </div>
              <button className="btn-secondary w-full" disabled={busy || !data.online} onClick={() => act(async () => {
                await sendTestPush(30);
                toast('Test reminder in 30 seconds — close the app and lock your phone now.', { tone: 'success' });
              })}>Test reminder with the app closed (30 s)</button>
            </div>
          ) : (
            <button className="btn-primary w-full" disabled={busy || !data.online}
              onClick={() => act(async () => { await enablePush(); toast('Notifications are on for this device', { tone: 'success' }); })}>
              {busy ? <Spinner /> : 'Enable notifications on this device'}
            </button>
          )
        )}

        {devices && devices.length > 0 && (
          <div>
            <div className="label mb-1">Registered devices</div>
            <div className="list-divide">
              {devices.map((d) => (
                <div key={d.id} className="list-row text-sm">
                  <div className="min-w-0">
                    <div className="font-medium">{d.device_label || 'Device'}{d.endpoint === thisDevice && <span className="ml-2 rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-bold text-green-700 dark:bg-green-500/15 dark:text-green-300">THIS DEVICE</span>}</div>
                    <div className="text-xs text-zinc-500">Added {formatDateShort(d.created_at.slice(0, 10))}{d.last_success_at && ` · last delivered ${formatDateShort(d.last_success_at.slice(0, 10))}`}</div>
                  </div>
                  <button className="text-sm font-semibold text-red-600 dark:text-red-400" disabled={busy} onClick={async () => {
                    if (!(await confirm({ title: 'Remove device?', message: 'This device will stop receiving reminders.', confirmLabel: 'REMOVE', destructive: true }))) return;
                    await act(async () => { await api.removeDevice(d.id); });
                  }}>Remove</button>
                </div>
              ))}
            </div>
          </div>
        )}
        {isIOS() && isStandalone() && (
          <p className="text-xs leading-relaxed text-zinc-500">
            iPhone tips: keep the Home Screen app installed (removing it deletes the subscription), allow notifications in Settings → Notifications → Attendance, and note that Focus modes can silence them.
          </p>
        )}
      </div>
    </section>
  );
}
