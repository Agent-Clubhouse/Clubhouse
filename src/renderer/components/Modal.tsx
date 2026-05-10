import { ReactNode, useEffect } from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
  /** When provided, renders a header row with title and close (×) button. */
  title?: string;
  /** Max-width class — defaults to w-[360px]. */
  width?: string;
  /** Darker backdrop for image/media dialogs. */
  backdrop?: 'default' | 'heavy';
  children: ReactNode;
}

export function Modal({ open, onClose, title, width = 'w-[360px]', backdrop = 'default', children }: Props) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className={`fixed inset-0 z-modal flex items-center justify-center ${backdrop === 'heavy' ? 'bg-black/70' : 'bg-black/50'}`}
      onClick={onClose}
    >
      <div
        className={`bg-ctp-mantle border border-surface-0 rounded-xl shadow-2xl ${width}`}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <div className="flex items-center justify-between px-5 pt-5 pb-0">
            <h2 className="text-base font-semibold text-ctp-text">{title}</h2>
            <button
              onClick={onClose}
              className="w-6 h-6 flex items-center justify-center rounded text-ctp-subtext0 hover:text-ctp-text hover:bg-surface-0 transition-colors"
              aria-label="Close"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        )}
        <div className="p-5">
          {children}
        </div>
      </div>
    </div>
  );
}
