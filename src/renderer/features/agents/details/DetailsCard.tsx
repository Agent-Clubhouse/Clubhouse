import { useId, type ReactNode } from 'react';

/**
 * One Agent details card (#2032): a 30px header with a chevron, the card's
 * name and a one-line summary that already answers its question. Every card
 * starts collapsed; clicking the header opens it in place.
 */
export function DetailsCard({ id, title, summary, open, onToggle, right, action, children }: {
  id: string;
  title: string;
  /** The answer on one line, shown open or closed ("6 files +94 −51"). */
  summary?: ReactNode;
  open: boolean;
  onToggle: () => void;
  /** Small trailing content in the header, such as a meter. */
  right?: ReactNode;
  /**
   * A control at the end of the header, outside the toggle button so it can
   * be interactive itself (the Orchestration card's switch).
   */
  action?: ReactNode;
  children?: ReactNode;
}) {
  const bodyId = useId();
  const toggle = (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={bodyId}
      className={`${action ? 'flex-1 min-w-0' : 'w-[calc(100%-8px)] mx-1'} h-[30px] flex items-center gap-[7px] px-2.5 rounded-md text-left hover:bg-surface-0`}
      data-testid={`details-card-${id}-toggle`}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="flex-shrink-0 text-ctp-overlay0">
        <path d={open ? 'M6 9l6 6 6-6' : 'M9 6l6 6-6 6'} />
      </svg>
      <span className="text-[13px] font-semibold text-ctp-text whitespace-nowrap">{title}</span>
      {summary !== undefined && summary !== '' && (
        <span className="min-w-0 truncate text-xs text-ctp-overlay1" title={typeof summary === 'string' ? summary : undefined} data-testid={`details-card-${id}-summary`}>{summary}</span>
      )}
      {right && <span className="ml-auto flex-shrink-0 flex items-center gap-1">{right}</span>}
    </button>
  );
  return (
    <section
      className="flex-shrink-0 rounded-lg border border-surface-1 bg-ctp-mantle py-0.5 overflow-hidden"
      data-testid={`details-card-${id}`}
      data-open={open || undefined}
      aria-label={title}
    >
      {action ? (
        <div className="mx-1 flex items-center gap-1">
          {toggle}
          <span className="flex-shrink-0 flex items-center pr-2">{action}</span>
        </div>
      ) : toggle}
      {open && <div id={bodyId} className="pb-1.5">{children}</div>}
    </section>
  );
}

/** A plain note inside a card, for what a runtime can't report. */
export function CardNote({ children }: { children: ReactNode }) {
  return <p className="pr-3.5 pl-[33px] pt-0.5 pb-1.5 text-xs leading-normal text-ctp-overlay1">{children}</p>;
}

/** A key / value row (Session and Settings cards). */
export function CardRow({ label, children, labelWidth, testId, describedBy, locked }: {
  label: string;
  children: ReactNode;
  /** Room for longer labels ("Clubhouse mode") on one line. */
  labelWidth?: 'wide';
  testId?: string;
  /** The id of a note about this row, such as why it can't change now. */
  describedBy?: string;
  /** The row's value can't be changed now (Settings card). */
  locked?: boolean;
}) {
  return (
    <div
      className="min-h-[26px] flex items-baseline gap-2.5 py-[3px] pr-3.5 pl-[33px] text-xs"
      data-testid={testId}
      data-locked={locked || undefined}
      aria-describedby={describedBy}
    >
      <span className={`flex-shrink-0 ${labelWidth === 'wide' ? 'w-[96px]' : 'w-[72px]'} text-ctp-overlay1`}>{label}</span>
      <span className="min-w-0 text-ctp-text break-words">{children}</span>
    </div>
  );
}

/** +a −d in the diff colors, monospace. */
export function PlusMinus({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="font-mono text-[11.5px] whitespace-nowrap">
      <span className="text-ctp-success">+{added}</span> <span className="text-ctp-error">−{removed}</span>
    </span>
  );
}

/** A thin usage bar; red at 90% and over. */
export function UsageBar({ pct, className = 'w-full h-1.5' }: { pct: number; className?: string }) {
  return (
    <span className={`relative block flex-shrink-0 rounded-full bg-surface-0 overflow-hidden ${className}`} aria-hidden="true">
      <span className={`absolute inset-y-0 left-0 rounded-full ${pct >= 90 ? 'bg-ctp-error' : 'bg-ctp-info'}`} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
    </span>
  );
}
