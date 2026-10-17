import type { ReactNode } from 'react';
import { titleBarPadding } from './platform';

/**
 * The bare title bar for popout windows in the new layout (spec §2): the
 * window's title, room for the platform's window controls, and the popout's
 * own actions on the right (#2018: Show in main window, Stop or Wake).
 */
export function PopoutTitleBar({ title, actions }: { title: ReactNode; actions?: ReactNode }) {
  return (
    <div
      data-testid="popout-title-bar"
      className={`h-[38px] flex-shrink-0 drag-region bg-ctp-mantle border-b border-surface-0 flex items-center gap-2 pr-1.5 ${titleBarPadding(window.clubhouse.platform)}`}
    >
      <span data-testid="popout-title" className="min-w-0 flex-1 text-xs font-medium text-ctp-text truncate select-none">{title}</span>
      {actions}
    </div>
  );
}
