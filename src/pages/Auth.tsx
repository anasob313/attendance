import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { EMAIL_SIGNUP_ENABLED, appUrl, signInWithGoogle } from '../lib/oauth';
import { useAuth } from '../state/auth';
import { Notice, Spinner } from '../components/ui';

function friendly(message: string): string {
  if (/invalid login credentials/i.test(message)) return 'Incorrect email or password.';
  if (/email not confirmed/i.test(message)) return 'Please confirm your email first — check your inbox for the confirmation link.';
  if (/already registered|already exists/i.test(message)) return 'An account with this email already exists. Try signing in or resetting your password.';
  if (/email address not authorized|error sending/i.test(message)) return 'Email sending is not available for this address. If you use Google to sign in, choose “Continue with Google” instead.';
  if (/rate limit|too many/i.test(message)) return 'Too many attempts. Please wait a few minutes and try again.';
  if (/failed to fetch|load failed|network/i.test(message)) return 'No internet connection.';
  return message;
}

function GoogleLogo() {
  return (
    <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.3 0-9.7-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

/** "Continue with Google" — creates the account on first use, signs in afterwards. */
function GoogleButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      <button type="button" disabled={busy}
        className="btn w-full bg-white text-zinc-900 ring-1 ring-zinc-300 dark:bg-zinc-800 dark:text-white dark:ring-white/15"
        onClick={async () => {
          setBusy(true);
          setError(null);
          const err = await signInWithGoogle();     // navigates to Google on success
          if (err) { setError(err); setBusy(false); }
        }}>
        {busy ? <Spinner /> : <><GoogleLogo />Continue with Google</>}
      </button>
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}

function Divider({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-3 text-xs font-medium uppercase tracking-wider text-zinc-400">
      <span className="h-px flex-1 bg-zinc-200 dark:bg-white/10" />{text}<span className="h-px flex-1 bg-zinc-200 dark:bg-white/10" />
    </div>
  );
}

function AuthShell({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="pt-safe pb-safe mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-5">
      <div className="mb-8 flex flex-col items-center text-center">
        <img src={`${import.meta.env.BASE_URL}icons/icon-192.png`} alt="" className="h-16 w-16 rounded-[18px] shadow-lg" />
        <h1 className="mt-5 font-[family-name:var(--font-display)] text-[28px] font-bold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-zinc-500">{subtitle}</p>}
      </div>
      <div className="card">{children}</div>
      {footer && <div className="mt-6 text-center text-sm text-zinc-500">{footer}</div>}
    </div>
  );
}

export function LoginPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleted] = useState(() => {
    try {
      const v = sessionStorage.getItem('attendance:account-deleted');
      sessionStorage.removeItem('attendance:account-deleted');
      return v === '1' || params.get('deleted') === '1';
    } catch { return false; }
  });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password }).catch((x) => ({ error: x as Error }));
    setBusy(false);
    if (error) setError(friendly(error.message));
    else navigate('/', { replace: true });
  };

  return (
    <AuthShell title="Attendance" subtitle="Your personal work-hours tracker"
      footer={<>New here? <Link to="/signup" className="font-semibold text-zinc-900 underline dark:text-white">Create an account</Link></>}>
      <form className="space-y-4" onSubmit={submit}>
        {deleted && <Notice tone="success">Your account and all of its data were deleted.</Notice>}
        {params.get('expired') && <Notice tone="warn">Please sign in again. Unsynced changes on this device are kept.</Notice>}
        <GoogleButton />
        <Divider text="or with email" />
        <label className="field"><span className="label">Email</span>
          <input className="input" type="email" autoComplete="email" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field"><span className="label">Password</span>
          <input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <Notice tone="error">{error}</Notice>}
        <button className="btn-primary w-full" disabled={busy}>{busy ? <Spinner /> : 'Sign in'}</button>
        <Link to="/forgot" className="block text-center text-sm font-medium text-zinc-500">Forgot password?</Link>
      </form>
    </AuthShell>
  );
}

export function SignupPage() {
  const [form, setForm] = useState({ name: '', email: '', password: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const navigate = useNavigate();

  const problem = form.password && form.password.length < 8 ? 'Use at least 8 characters for your password.'
    : form.confirm && form.password !== form.confirm ? 'Passwords do not match.' : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (problem || !form.name.trim()) return;
    setBusy(true);
    setError(null);
    const { data, error } = await supabase.auth.signUp({
      email: form.email.trim(),
      password: form.password,
      options: { data: { full_name: form.name.trim() }, emailRedirectTo: appUrl() },
    }).catch((x) => ({ data: { session: null, user: null }, error: x as Error }));
    setBusy(false);
    if (error) return setError(friendly(error.message));
    if (data.session) navigate('/', { replace: true });
    else setSent(true);
  };

  if (sent) {
    return (
      <AuthShell title="Check your email" subtitle={form.email}
        footer={<Link to="/login" className="font-semibold text-zinc-900 underline dark:text-white">Back to sign in</Link>}>
        <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
          We sent a confirmation link. Open it, then sign in. On iPhone, sign in inside the Home Screen app afterwards — it keeps its own sign-in.
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Create account" footer={<>Already have an account? <Link to="/login" className="font-semibold text-zinc-900 underline dark:text-white">Sign in</Link></>}>
      <div className="space-y-4">
        <GoogleButton />
        <p className="text-center text-xs leading-relaxed text-zinc-500">
          Your attendance records are private to your account. Google confirms your email and handles account recovery.
        </p>
      </div>
      {EMAIL_SIGNUP_ENABLED && <div className="mt-5"><Divider text="or with email" /></div>}
      {EMAIL_SIGNUP_ENABLED && <form className="mt-4 space-y-4" onSubmit={submit}>
        <label className="field"><span className="label">Full name</span>
          <input className="input" autoComplete="name" required maxLength={120} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        <label className="field"><span className="label">Email</span>
          <input className="input" type="email" autoComplete="email" inputMode="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </label>
        <label className="field"><span className="label">Password</span>
          <input className="input" type="password" autoComplete="new-password" required minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </label>
        <label className="field"><span className="label">Confirm password</span>
          <input className="input" type="password" autoComplete="new-password" required value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} />
        </label>
        {(problem || error) && <Notice tone="error">{problem ?? error}</Notice>}
        <button className="btn-primary w-full" disabled={busy || !!problem}>{busy ? <Spinner /> : 'Create account'}</button>
      </form>}
    </AuthShell>
  );
}

export function ForgotPage() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: appUrl('reset-password') })
      .catch((x) => ({ error: x as Error }));
    setBusy(false);
    if (error && !/rate limit/i.test(error.message)) setError(friendly(error.message));
    else setDone(true);
  };

  return (
    <AuthShell title="Reset password" footer={<Link to="/login" className="font-semibold text-zinc-900 underline dark:text-white">Back to sign in</Link>}>
      {done ? (
        <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
          If an account exists for {email}, a reset link is on its way. The link opens in your browser; set the new password there, then sign in to the app.
        </p>
      ) : (
        <form className="space-y-4" onSubmit={submit}>
          <Notice>Signed up with Google? You don’t have a password here — go back and choose “Continue with Google”. Google handles recovery of your Google account.</Notice>
          <label className="field"><span className="label">Email</span>
            <input className="input" type="email" autoComplete="email" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          {error && <Notice tone="error">{error}</Notice>}
          <button className="btn-primary w-full" disabled={busy}>{busy ? <Spinner /> : 'Send reset link'}</button>
        </form>
      )}
    </AuthShell>
  );
}

export function ResetPasswordPage() {
  const { user, clearRecovery } = useAuth();
  const navigate = useNavigate();
  const [pw, setPw] = useState({ next: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = pw.next && pw.next.length < 8 ? 'Use at least 8 characters.' : pw.confirm && pw.next !== pw.confirm ? 'Passwords do not match.' : null;

  if (!user) {
    return (
      <AuthShell title="Link expired" footer={<Link to="/forgot" className="font-semibold text-zinc-900 underline dark:text-white">Request a new link</Link>}>
        <p className="text-sm text-zinc-600 dark:text-zinc-300">This password-reset link is invalid or has expired.</p>
      </AuthShell>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (problem) return;
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: pw.next });
    setBusy(false);
    if (error) return setError(friendly(error.message));
    clearRecovery();
    history.replaceState(null, '', import.meta.env.BASE_URL);
    navigate('/', { replace: true });
  };

  return (
    <AuthShell title="Choose a new password" subtitle={user.email}>
      <form className="space-y-4" onSubmit={submit}>
        <label className="field"><span className="label">New password</span>
          <input className="input" type="password" autoComplete="new-password" required value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
        </label>
        <label className="field"><span className="label">Confirm new password</span>
          <input className="input" type="password" autoComplete="new-password" required value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
        </label>
        {(problem || error) && <Notice tone="error">{problem ?? error}</Notice>}
        <button className="btn-primary w-full" disabled={busy || !!problem || !pw.next}>{busy ? <Spinner /> : 'Save password'}</button>
      </form>
    </AuthShell>
  );
}

export function SetupRequiredPage() {
  return (
    <AuthShell title="Setup required">
      <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
        This build is missing its Supabase configuration. Set <code>VITE_SUPABASE_URL</code>, <code>VITE_SUPABASE_ANON_KEY</code> and{' '}
        <code>VITE_VAPID_PUBLIC_KEY</code> in your hosting environment variables (or <code>.env.local</code>) and rebuild. See SETUP.md.
      </p>
    </AuthShell>
  );
}
