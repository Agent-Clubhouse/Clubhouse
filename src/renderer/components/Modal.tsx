import { ReactNode, RefObject, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

/**
 * The app's dialog (#2014): chrome tokens, a 44px title row with a close
 * button, the body, and footer actions on the right. `role="dialog"` with
 * `aria-modal`, focus moves in on open (to `initialFocusRef`, an autofocused
 * field, or the first focusable control), Tab stays inside, Esc closes the
 * topmost open modal, and focus returns to where it was on close.
 */

interface Props {
  open: boolean;
  onClose: () => void;
  /** When provided, renders the 44px title row with the title and a close button. */
  title?: ReactNode;
  /** Accessible name when there's no title row. */
  ariaLabel?: string;
  /** Width class; defaults to w-[360px]. */
  width?: string;
  /** Darker backdrop for image/media dialogs. */
  backdrop?: 'default' | 'heavy';
  /** Optional data-testid for the backdrop overlay div. */
  backdropTestId?: string;
  /** Optional data-testid for the dialog panel. */
  testId?: string;
  /** Footer actions (usually `Button`s), right-aligned in a bar below the body. */
  footer?: ReactNode;
  /** `none` drops the body padding, for content that runs edge to edge. */
  padding?: 'default' | 'none';
  /** The element to focus on open. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** Open modals, innermost last, so Esc and the focus trap only act on the top one. */
const stack: symbol[] = [];

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest('[inert]'));
}

export function Modal({
  open, onClose, title, ariaLabel, width = 'w-[360px]', backdrop = 'default', backdropTestId, testId,
  footer, padding = 'default', initialFocusRef, children,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const token = Symbol('modal');
    stack.push(token);
    const isTop = () => stack[stack.length - 1] === token;
    const previous = document.activeElement as HTMLElement | null;

    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) {
      const target = initialFocusRef?.current ?? focusables(panel).find((el) => el.dataset.modalClose === undefined) ?? focusables(panel)[0] ?? panel;
      target.focus();
    }

    const onKey = (e: KeyboardEvent) => {
      if (!isTop()) return;
      if (e.key === 'Escape') { onCloseRef.current(); return; }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const all = focusables(panelRef.current);
      if (all.length === 0) { e.preventDefault(); panelRef.current.focus(); return; }
      const first = all[0];
      const last = all[all.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !panelRef.current.contains(active))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (active === last || !panelRef.current.contains(active))) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      stack.splice(stack.indexOf(token), 1);
      if (previous && previous.isConnected && typeof previous.focus === 'function') previous.focus();
    };
    // initialFocusRef is read once, on open.
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className={`fixed inset-0 z-modal flex items-center justify-center ${backdrop === 'heavy' ? 'bg-ctp-crust/80' : 'bg-ctp-crust/55'}`}
      onClick={onClose}
      data-testid={backdropTestId}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : ariaLabel}
        tabIndex={-1}
        data-testid={testId}
        className={`flex flex-col max-h-[calc(100vh-48px)] bg-ctp-base border border-surface-1 rounded-[10px] shadow-2xl overflow-hidden outline-none ${width}`}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <div className="flex-shrink-0 flex items-center gap-2 h-11 pl-4 pr-2.5 border-b border-surface-0">
            <h2 id={titleId} className="min-w-0 truncate text-[13.5px] font-semibold text-ctp-text">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              data-modal-close=""
              className="ml-auto flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-md text-ctp-overlay1 hover:text-ctp-text hover:bg-surface-0 transition-colors"
              aria-label="Close"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        )}
        <div className={`min-h-0 overflow-auto ${padding === 'none' ? '' : 'p-4'}`}>
          {children}
        </div>
        {footer && (
          <div className="flex-shrink-0 flex items-center justify-end gap-2 px-4 py-2.5 border-t border-surface-0 bg-ctp-mantle">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
