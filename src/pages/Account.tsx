import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useData } from '../state/data';
import { useUi } from '../state/ui';
import { useAuth } from '../state/auth';
import { api } from '../lib/api';
import { supabase } from '../lib/supabase';
import { toAppError } from '../lib/errors';
import { cacheKey, queueKey } from '../lib/sync';
import { currentEndpoint } from '../lib/push';
import { formatDateLong, localDate } from '../lib/time';
import { Notice, PageHeader, Sheet, Spinner } from '../components/ui';
import { IconDownload, IconTrash } from '../components/icons';

export function AccountPage() {
  const data = useData();
  const { user } = useAuth();
  const { toast } = useUi();
  const navigate = useNavigate();
  const [name, setName] = useState(data.profile?.full_name ?? '');
  const [pw, setPw] = useState({ next: '', confirm: '' });
  const [busy, setBusy] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');

  const tz = data.settings.timezone;
  const pwError = pw.next && pw.next.length < 8 ? 'Use at least 8 characters.' : pw.confirm && pw.next !== pw.confirm ? 'Passwords do not match.' : null;

  const task = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try { await fn(); } catch (e) { toast(toAppError(e).message, { tone: 'error', duration: 6000 }); } finally { setBusy(null); }
  };

  const exportAll = () => task('export', async () => {
    const { fullExportWorkbook, saveFile } = await import('../lib/excel');
    const blob = await fullExportWorkbook(data.view, data.settings, data.profile?.full_name ?? '', data.email);
    await saveFile(blob, `Attendance_Export_${localDate(Date.now(), tz)}.xlsx`);
  });

  const deleteAccount = () => task('delete', async () => {
    if (!data.online) throw new Error('You need an internet connection to delete your account.');
    try { const ep = await currentEndpoint(); if (ep) await api.unregisterPush(ep); } catch { /* deleted with the account anyway */ }
    await api.deleteAccount();
    try {
      localStorage.removeItem(cacheKey(data.userId));
      localStorage.removeItem(queueKey(data.userId));
    } catch { /* ignore */ }
    try { sessionStorage.setItem('attendance:account-deleted', '1'); } catch { /* ignore */ }
    await supabase.auth.signOut({ scope: 'local' });
    navigate('/login', { replace: true });
  });

  return (
    <div className="tabbar-space mx-auto max-w-lg px-4">
      <PageHeader title="Profile" back="/settings" />
      <div className="space-y-6">
        <section className="card space-y-4">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-zinc-900 text-xl font-semibold text-white dark:bg-white dark:text-zinc-900">
              {(data.profile?.full_name || data.email || '?').trim().charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0">
              <div className="truncate text-lg font-semibold">{data.profile?.full_name || 'No name'}</div>
              <div className="truncate text-sm text-zinc-500">{data.email}</div>
              {user?.created_at && <div className="text-xs text-zinc-400">Member since {formatDateLong(localDate(user.created_at, tz))}</div>}
            </div>
          </div>
          <label className="field"><span className="label">Full name</span>
            <input className="input" value={name} maxLength={120} autoComplete="name" onChange={(e) => setName(e.target.value)} />
          </label>
          <button className="btn-primary w-full" disabled={!name.trim() || name.trim() === data.profile?.full_name || !!busy || !!data.editBlockedReason}
            onClick={() => task('name', async () => {
              const p = await data.runOnline(() => api.saveProfile(data.userId, name.trim()));
              data.patchSnapshot({ profile: p });
              toast('Name updated', { tone: 'success' });
            })}>
            {busy === 'name' ? <Spinner /> : 'Save name'}
          </button>
        </section>

        <section className="card space-y-4">
          <h2 className="font-semibold">Change password</h2>
          <label className="field"><span className="label">New password</span>
            <input className="input" type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
          </label>
          <label className="field"><span className="label">Confirm new password</span>
            <input className="input" type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
          </label>
          {pwError && <Notice tone="error">{pwError}</Notice>}
          <button className="btn-primary w-full" disabled={!pw.next || !!pwError || pw.next !== pw.confirm || !!busy || !data.online}
            onClick={() => task('pw', async () => {
              const { error } = await supabase.auth.updateUser({ password: pw.next });
              if (error) throw error;
              setPw({ next: '', confirm: '' });
              toast('Password changed', { tone: 'success' });
            })}>
            {busy === 'pw' ? <Spinner /> : 'Change password'}
          </button>
        </section>

        <section className="card space-y-3">
          <h2 className="font-semibold">Your data</h2>
          <p className="text-sm text-zinc-500">Download every attendance, remote work and leave record as an Excel workbook.</p>
          <button className="btn-secondary w-full" disabled={!!busy} onClick={exportAll}>
            {busy === 'export' ? <Spinner /> : <><IconDownload size={18} />Export all records (.xlsx)</>}
          </button>
        </section>

        <section className="card space-y-3">
          <h2 className="font-semibold text-red-600 dark:text-red-400">Delete account</h2>
          <p className="text-sm text-zinc-500">Permanently deletes your account, attendance, remote work, leave, settings and notification devices. Other users are not affected.</p>
          <button className="btn-secondary w-full text-red-600 dark:text-red-400" onClick={() => setDeleteOpen(true)}><IconTrash size={18} />Delete my account…</button>
        </section>
      </div>

      <Sheet open={deleteOpen} onClose={() => { setDeleteOpen(false); setConfirmText(''); }} title="Delete account">
        <div className="space-y-4">
          <Notice tone="error">
            This cannot be undone. All of your records are deleted from the server immediately{data.ops.length ? `, including ${data.ops.length} unsynced change(s) on this device` : ''}.
          </Notice>
          <p className="text-sm text-zinc-600 dark:text-zinc-300">Export your data first if you may need it.</p>
          <button className="btn-secondary w-full" disabled={!!busy} onClick={exportAll}>
            {busy === 'export' ? <Spinner /> : <><IconDownload size={18} />Export my data first</>}
          </button>
          <label className="field">
            <span className="label">Type DELETE to confirm</span>
            <input className="input" value={confirmText} autoCapitalize="characters" autoComplete="off" onChange={(e) => setConfirmText(e.target.value)} />
          </label>
          <button className="btn-danger w-full" disabled={confirmText !== 'DELETE' || !!busy || !data.online} onClick={deleteAccount}>
            {busy === 'delete' ? <Spinner /> : 'Permanently delete my account'}
          </button>
          {!data.online && <p className="text-center text-xs text-zinc-500">Requires an internet connection.</p>}
        </div>
      </Sheet>
    </div>
  );
}
