import { titleBarPadding } from './platform';

/**
 * The bare title bar for popout windows in the new layout (spec §2): the
 * window's title and room for the platform's window controls, nothing else.
 */
export function PopoutTitleBar({ title }: { title: string }) {
  return (
    <div
      data-testid="popout-title-bar"
      className={`h-[38px] flex-shrink-0 drag-region bg-ctp-mantle border-b border-surface-0 flex items-center pr-3 ${titleBarPadding(window.clubhouse.platform)}`}
    >
      <span data-testid="popout-title" className="text-xs font-medium text-ctp-text truncate select-none">{title}</span>
    </div>
  );
}
