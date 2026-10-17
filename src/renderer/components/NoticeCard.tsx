import type { ReactNode } from 'react';

/**
 * An app-wide notice as a card (#2014): the new chrome shows update ready,
 * resume sessions, plugin updates and permission violations above the
 * sidebar footer instead of as full-width bars. An 8px dot and a title,
 * optional meta in overlay1, a 12px description, then actions.
 */

export type NoticeTone = 'success' | 'warning' | 'error' | 'info' | 'neutral';

export const NOTICE_DOT: Record<NoticeTone, string> = {
  success: 'bg-ctp-success',
  warning: 'bg-ctp-warning',
  error: 'bg-ctp-error',
  info: 'bg-ctp-info',
  neutral: 'border border-ctp-overlay0',
};

export function NoticeCard({ tone, title, meta, children, actions, testId }: {
  tone: NoticeTone;
  title: ReactNode;
  meta?: ReactNode;
  /** The description, or rows under the title. */
  children?: ReactNode;
  /** Usually `Button`s: one primary and a quiet "Later" or "Dismiss". */
  actions?: ReactNode;
  testId?: string;
}) {
  return (
    <section
      role="status"
      data-testid={testId}
      className="flex flex-col gap-2 px-3 py-2.5 rounded-lg border border-surface-1 bg-ctp-base"
    >
      <div className="flex items-center gap-2 min-w-0 text-[13px]">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${NOTICE_DOT[tone]}`} aria-hidden="true" />
        <span className="font-semibold text-ctp-text truncate">{title}</span>
        {meta && <span className="ml-auto flex-shrink-0 text-xs text-ctp-overlay1">{meta}</span>}
      </div>
      {children && <div className="text-xs text-ctp-overlay1 break-words">{children}</div>}
      {actions && <div className="flex flex-wrap gap-1.5">{actions}</div>}
    </section>
  );
}
