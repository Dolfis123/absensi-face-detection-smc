import { createContext, ReactNode, useCallback, useContext, useRef, useState } from 'react';
import { Icon } from './icons';

type ToastKind = 'success' | 'error' | 'info';
interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
}
interface ConfirmOptions {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
}

interface FeedbackApi {
  toast: (text: string, kind?: ToastKind) => void;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
}

const FeedbackContext = createContext<FeedbackApi | null>(null);

const TOAST_STYLE: Record<ToastKind, { icon: 'check' | 'alert' | 'info'; cls: string }> = {
  success: { icon: 'check', cls: 'bg-emerald-100 text-emerald-700' },
  error: { icon: 'alert', cls: 'bg-rose-100 text-rose-700' },
  info: { icon: 'info', cls: 'bg-sky-100 text-sky-700' },
};

/** Notifikasi toast + dialog konfirmasi, pengganti alert()/confirm() bawaan browser. */
export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dialog, setDialog] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((v: boolean) => void) | null>(null);

  const toast = useCallback((text: string, kind: ToastKind = 'success') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);

  const confirm = useCallback((opts: ConfirmOptions) => {
    setDialog(opts);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const close = (value: boolean) => {
    resolver.current?.(value);
    resolver.current = null;
    setDialog(null);
  };

  return (
    <FeedbackContext.Provider value={{ toast, confirm }}>
      {children}

      <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4 sm:bottom-6 sm:items-end">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto flex w-full max-w-sm animate-slide-in items-start gap-3 rounded-xl bg-white p-3 pr-4 shadow-pop ring-1 ring-slate-200"
          >
            <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${TOAST_STYLE[t.kind].cls}`}>
              <Icon name={TOAST_STYLE[t.kind].icon} className="h-4 w-4" />
            </span>
            <p className="pt-1 text-sm text-slate-700">{t.text}</p>
          </div>
        ))}
      </div>

      {dialog && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-[2px]" onClick={() => close(false)}>
          <div className="w-full max-w-sm animate-slide-in rounded-2xl bg-white p-6 shadow-pop" onClick={(e) => e.stopPropagation()}>
            <div
              className={`mb-4 flex h-11 w-11 items-center justify-center rounded-full ${
                dialog.danger ? 'bg-rose-100 text-rose-600' : 'bg-brand-100 text-brand-600'
              }`}
            >
              <Icon name={dialog.danger ? 'alert' : 'info'} />
            </div>
            <h2 className="text-lg font-semibold text-slate-900">{dialog.title}</h2>
            <div className="mt-1 text-sm text-slate-600">{dialog.message}</div>
            <div className="mt-6 flex justify-end gap-2">
              <button onClick={() => close(false)} className="rounded-lg px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100">
                Batal
              </button>
              <button
                onClick={() => close(true)}
                className={`rounded-lg px-4 py-2 text-sm font-semibold text-white ${
                  dialog.danger ? 'bg-rose-600 hover:bg-rose-700' : 'bg-brand-600 hover:bg-brand-700'
                }`}
              >
                {dialog.confirmLabel ?? 'Ya, lanjutkan'}
              </button>
            </div>
          </div>
        </div>
      )}
    </FeedbackContext.Provider>
  );
}

export function useFeedback() {
  const ctx = useContext(FeedbackContext);
  if (!ctx) throw new Error('useFeedback harus di dalam FeedbackProvider');
  return ctx;
}
