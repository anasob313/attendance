import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { STATUS_LABEL, type DayStatus } from '../lib/attendance';
import { IconChevronLeft, IconX } from './icons';

/** Tailwind classes per status (light + dark). */
export const STATUS_STYLE: Record<DayStatus, { pill: string; cell: string; dot: string }> = {
  complete: { pill: 'bg-green-100 text-green-800 dark:bg-green-500/15 dark:text-green-300', cell: 'bg-green-100 text-green-900 dark:bg-green-500/20 dark:text-green-200', dot: 'bg-green-500' },
  short: { pill: 'bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300', cell: 'bg-red-100 text-red-900 dark:bg-red-500/20 dark:text-red-200', dot: 'bg-red-500' },
  pending: { pill: 'bg-orange-100 text-orange-800 dark:bg-orange-500/15 dark:text-orange-300', cell: 'bg-orange-100 text-orange-900 dark:bg-orange-500/20 dark:text-orange-200', dot: 'bg-orange-500' },
  remote: { pill: 'bg-blue-100 text-blue-800 dark:bg-blue-500/15 dark:text-blue-300', cell: 'bg-blue-100 text-blue-900 dark:bg-blue-500/20 dark:text-blue-200', dot: 'bg-blue-500' },
  annual: { pill: 'bg-purple-100 text-purple-800 dark:bg-purple-500/15 dark:text-purple-300', cell: 'bg-purple-100 text-purple-900 dark:bg-purple-500/20 dark:text-purple-200', dot: 'bg-purple-500' },
  sick: { pill: 'bg-purple-100 text-purple-800 dark:bg-purple-500/15 dark:text-purple-300', cell: 'bg-purple-100 text-purple-900 dark:bg-purple-500/20 dark:text-purple-200', dot: 'bg-purple-500' },
  holiday: { pill: 'bg-teal-100 text-teal-800 dark:bg-teal-500/15 dark:text-teal-300', cell: 'bg-teal-100 text-teal-900 dark:bg-teal-500/20 dark:text-teal-200', dot: 'bg-teal-500' },
  weekend: { pill: 'bg-zinc-200 text-zinc-700 dark:bg-white/10 dark:text-zinc-300', cell: 'bg-zinc-200/70 text-zinc-500 dark:bg-white/[0.06] dark:text-zinc-500', dot: 'bg-zinc-400' },
  not_recorded: { pill: 'bg-white text-zinc-600 ring-1 ring-zinc-300 dark:bg-transparent dark:text-zinc-400 dark:ring-white/20', cell: 'bg-white text-zinc-800 ring-1 ring-inset ring-zinc-200 dark:bg-transparent dark:text-zinc-300 dark:ring-white/10', dot: 'bg-white ring-1 ring-zinc-400' },
  today: { pill: 'bg-white text-zinc-600 ring-1 ring-zinc-300 dark:bg-transparent dark:text-zinc-400 dark:ring-white/20', cell: 'bg-white text-zinc-900 ring-1 ring-inset ring-zinc-200 dark:bg-transparent dark:text-white dark:ring-white/10', dot: 'bg-white ring-1 ring-zinc-400' },
  future: { pill: 'bg-transparent text-zinc-400 ring-1 ring-zinc-200 dark:ring-white/10', cell: 'bg-transparent text-zinc-400 dark:text-zinc-600', dot: 'bg-transparent ring-1 ring-zinc-300' },
};

export function StatusPill({ status, className = '' }: { status: DayStatus; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${STATUS_STYLE[status].pill} ${className}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${STATUS_STYLE[status].dot}`} />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function PageHeader({ title, back, right, subtitle }: { title: string; back?: string; right?: ReactNode; subtitle?: ReactNode }) {
  return (
    <header className="pt-safe sticky top-0 z-20 -mx-4 mb-3 bg-zinc-100/85 px-4 pb-3 backdrop-blur-xl dark:bg-zinc-950/85">
      <div className="flex min-h-11 items-center gap-2">
        {back && (
          <Link to={back} className="-ml-2 flex h-10 w-10 items-center justify-center rounded-full text-zinc-600 dark:text-zinc-300" aria-label="Back">
            <IconChevronLeft />
          </Link>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-[family-name:var(--font-display)] text-[28px] font-bold leading-tight tracking-tight">{title}</h1>
          {subtitle && <div className="text-sm text-zinc-500 dark:text-zinc-400">{subtitle}</div>}
        </div>
        {right}
      </div>
    </header>
  );
}

export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" role="dialog" aria-modal="true">
      <div className="animate-fade absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="animate-sheet relative flex max-h-[92dvh] w-full max-w-lg flex-col rounded-t-[28px] bg-zinc-50 shadow-2xl dark:bg-zinc-900">
        <div className="flex items-center gap-3 px-5 pb-2 pt-3">
          <div className="absolute left-1/2 top-2 h-1.5 w-10 -translate-x-1/2 rounded-full bg-zinc-300 dark:bg-zinc-700" />
          <h2 className="mt-3 flex-1 text-lg font-semibold">{title}</h2>
          <button onClick={onClose} className="mt-3 flex h-9 w-9 items-center justify-center rounded-full bg-zinc-200/80 text-zinc-600 dark:bg-white/10 dark:text-zinc-300" aria-label="Close">
            <IconX size={18} />
          </button>
        </div>
        <div className="pb-safe overflow-y-auto px-5 pb-6">{children}</div>
      </div>
    </div>
  );
}

export function Notice({ tone = 'info', children, action }: { tone?: 'info' | 'warn' | 'error' | 'success'; children: ReactNode; action?: ReactNode }) {
  const cls = {
    info: 'bg-zinc-900/5 text-zinc-700 dark:bg-white/5 dark:text-zinc-300',
    warn: 'bg-orange-100 text-orange-900 dark:bg-orange-500/15 dark:text-orange-200',
    error: 'bg-red-100 text-red-900 dark:bg-red-500/15 dark:text-red-200',
    success: 'bg-green-100 text-green-900 dark:bg-green-500/15 dark:text-green-200',
  }[tone];
  return (
    <div className={`flex items-start gap-3 rounded-2xl px-4 py-3 text-sm leading-relaxed ${cls}`}>
      <div className="flex-1">{children}</div>
      {action}
    </div>
  );
}

export function Spinner({ className = '' }: { className?: string }) {
  return <span className={`inline-block h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent ${className}`} aria-label="Loading" />;
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className="rounded-2xl bg-zinc-100 px-3.5 py-3 dark:bg-white/5">
      <div className={`tabular text-xl font-semibold ${tone ?? ''}`}>{value}</div>
      <div className="mt-0.5 text-xs leading-snug text-zinc-500 dark:text-zinc-400">{label}</div>
    </div>
  );
}
