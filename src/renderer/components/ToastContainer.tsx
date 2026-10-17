import { useEffect, useRef } from 'react';
import { useToastStore, type Toast } from '../stores/toastStore';
import { Button } from './Button';

const AUTO_DISMISS_MS = 8000;

function ToastItem({ toast }: { toast: Toast }) {
  const removeToast = useToastStore((s) => s.removeToast);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    timerRef.current = setTimeout(() => removeToast(toast.id), AUTO_DISMISS_MS);
    return () => clearTimeout(timerRef.current);
  }, [toast.id, removeToast]);

  return (
    <div
      role="alert"
      aria-live="assertive"
      data-testid="toast-message"
      data-type={toast.type}
      className="flex items-center gap-2.5 min-h-10 w-80 max-w-[calc(100vw-32px)] py-1.5 pl-3 pr-1.5 rounded-lg border border-surface-1 bg-ctp-mantle shadow-xl text-[13px] text-ctp-text"
    >
      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${toast.type === 'error' ? 'bg-ctp-error' : 'bg-ctp-info'}`} aria-hidden="true" />
      <span className="flex-1 min-w-0 break-words">{toast.message}</span>
      <Button
        kind="quiet"
        aria-label="Dismiss notification"
        onClick={() => removeToast(toast.id)}
        data-testid="toast-dismiss"
        icon={
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        }
      />
    </div>
  );
}

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-toast flex flex-col gap-2" data-testid="toast-container">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}
