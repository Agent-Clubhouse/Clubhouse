/** Presentational action fields only. Local containers own hooks and management. */
import type { ReactNode } from 'react';
import type { RemoteActionRow } from '../../../shared/agent-action-groups';
import { OutcomeDot, formatWhen, outcomeWords } from './ActionOutcome';

export function ActionLineContent({ name, enabled, description, lastRun }: { name: string; enabled: boolean; description: string; lastRun?: RemoteActionRow['lastRun'] }) {
  return <>
    <div className="flex items-center gap-2">
      {lastRun && <OutcomeDot outcome={lastRun.outcome} />}
      <span className="text-[13px] text-ctp-text truncate group-hover:underline">{name}</span>
      {!enabled && <span className="text-xs text-ctp-overlay1">Off</span>}
    </div>
    <div className="text-xs text-ctp-overlay1 truncate">{description}</div>
    {lastRun && <div className="text-xs text-ctp-overlay1">Last recorded: {outcomeWords(lastRun.outcome)}{lastRun.startedAt === undefined ? ' · run time not shared' : ` · ${formatWhen(lastRun.startedAt)}`}</div>}
  </>;
}
export function ActionGroupFrame({ title, empty, note, hasItems, children }: { title: string; empty: string; note?: string; hasItems: boolean; children: ReactNode }) {
  return <section className="mt-5" aria-label={title}>
    <h3 className="text-[13px] font-semibold text-ctp-text">{title}</h3>
    {note && hasItems && <div className="text-xs text-ctp-overlay1 pl-4">{note}</div>}
    {hasItems ? <ul className="mt-1 pl-4">{children}</ul> : <div className="text-xs text-ctp-overlay1 mt-1 pl-4">{empty}</div>}
  </section>;
}
