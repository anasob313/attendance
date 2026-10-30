// Toasts and confirmation dialogs.
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

interface Toast { id: number; message: string; tone: 'info' | 'success' | 'error'; action?: { label: string; run: () => void } }
interface ConfirmOptions {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

interface UiApi {
  toast(message: string, opts?: { tone?: Toast['tone']; action?: Toast['action']; duration?: number }): void;
  confirm(opts: ConfirmOptions): Promise<boolean>;
}

const Ctx = createContext<UiApi | null>(null);

export function UiProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dialog, setDialog] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const seq = useRef(0);

  const toast = useCallback<UiApi['toast']>((message, opts = {}) => {
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-1), { id, message, tone: opts.tone ?? 'info', action: opts.action }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), opts.duration ?? (opts.action ? 8000 : 3500));
  }, []);

  const confirm = useCallback<UiApi['confirm']>((opts) => new Promise<boolean>((resolve) => setDialog({ ...opts, resolve })), []);

  const close = (v: boolean) => {
    dialog?.resolve(v);
    setDialog(null);
  };

  return (
    <Ctx.Provider value={{ toast, confirm }}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 top-0 z-[60] flex flex-col items-center gap-2 px-4 pt-safe">
        {toasts.map((t) => (
          <div key={t.id} role="status"
            className={`animate-pop pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-2xl px-4 py-3 text-sm font-medium shadow-lg ring-1 ring-black/5 backdrop-blur ${
              t.tone === 'error' ? 'bg-red-600 text-white' : t.tone === 'success' ? 'bg-zinc-900/95 text-white dark:bg-white/95 dark:text-zinc-900' : 'bg-zinc-900/95 text-white dark:bg-white/95 dark:text-zinc-900'}`}>
            <span className="flex-1">{t.message}</span>
            {t.action && (
              <button className="rounded-lg px-2 py-1 font-semibold underline underline-offset-4"
                onClick={() => { t.action!.run(); setToasts((x) => x.filter((y) => y.id !== t.id)); }}>
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
      {dialog && (
        <div className="animate-fade fixed inset-0 z-[70] flex items-end justify-center bg-black/40 p-4 pb-safe sm:items-center" role="alertdialog" aria-modal="true">
          <div className="animate-pop w-full max-w-sm rounded-3xl bg-white p-5 shadow-2xl dark:bg-zinc-900">
            <h2 className="text-lg font-semibold">{dialog.title}</h2>
            <div className="mt-2 text-[15px] leading-relaxed text-zinc-600 dark:text-zinc-300">{dialog.message}</div>
            <div className="mt-5 grid grid-cols-2 gap-3">
              <button className="btn-secondary" onClick={() => close(false)}>{dialog.cancelLabel ?? 'CANCEL'}</button>
              <button className={dialog.destructive ? 'btn-danger' : 'btn-primary'} onClick={() => close(true)} autoFocus>
                {dialog.confirmLabel ?? 'OK'}
              </button>
            </div>
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}

export function useUi() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useUi outside UiProvider');
  return v;
}
