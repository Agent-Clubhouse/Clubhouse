import { useEffect, useRef } from 'react';
import { useToastStore, type Toast } from '../stores/toastStore';

const AUTO_DISMISS_MS = 8000;

function ToastItem({ toast }: { toast: Toast }) {
  const removeToast = useToastStore((s) => s.removeToast);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    timerRef.current = setTimeout(() => removeToast(toast.id), AUTO_DISMISS_MS);
    return () => clearTimeout(timerRef.current);
  }, [toast.id, removeToast]);

  const borderClass = toast.type === 'error' ? 'border-ctp-red/30' : 'border-ctp-blue/30';
  const textClass = toast.type === 'error' ? 'text-ctp-red' : 'text-ctp-blue';

  return (
    <div
      role="alert"
      aria-live="assertive"
      data-testid="toast-message"
      className={`flex items-center gap-2 px-4 py-2 rounded shadow-lg bg-ctp-surface0 border ${borderClass} text-ctp-text text-sm max-w-sm`}
    >
      <span className={`${textClass} flex-shrink-0`}>●</span>
      <span className="flex-1 break-words">{toast.message}</span>
      <button
        aria-label="Dismiss notification"
        onClick={() => removeToast(toast.id)}
        className="text-ctp-subtext0 hover:text-ctp-text transition-colors cursor-pointer px-1"
        data-testid="toast-dismiss"
      >
        ✕
      </button>
    </div>
  );
}

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2" data-testid="toast-container">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}
