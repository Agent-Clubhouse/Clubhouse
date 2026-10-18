import React from 'react';
import type { AgentInfo, PluginAgentDetailedStatus } from '../../../../shared/plugin-types';
import { Button, Toggle, useAnnexClientStore, parseNamespacedId, isRemoteAgentId, StatusDot } from './host';
import { ReviewAvatar, Svg, Icon } from './reviewUi';
import { agentCount, describeAgents, reviewDot, statusWord, type EmptyCause } from './reviewModel';

/**
 * Review's empty states (#2021). Each names why nothing is shown and offers
 * the fix: nothing is running, nobody needs you, or the filters hide everyone.
 */

const LIST_LIMIT = 3;

function AgentLine({ agent, detailed, right }: { agent: AgentInfo; detailed?: PluginAgentDetailedStatus | null; right?: React.ReactNode }) {
  const dot = reviewDot(agent, detailed);
  return (
    <div className="h-[30px] flex items-center gap-2 px-3 min-w-0">
      <StatusDot dot={dot} />
      <ReviewAvatar agentId={agent.id} />
      <span className={`text-[13px] truncate ${dot === 'sleeping' ? 'text-ctp-subtext0' : 'text-ctp-text'}`}>{agent.name}</span>
      <span className="ml-auto flex items-center gap-2 text-xs text-ctp-overlay1 flex-shrink-0">{right ?? statusWord(dot)}</span>
    </div>
  );
}

function List({ children }: { children: React.ReactNode }) {
  return <div className="mt-1 py-1 rounded-lg border border-surface-0">{children}</div>;
}

/** "on Mac mini" for one host, "on 2 hosts" for more. */
function useRemoteWhere(agents: AgentInfo[]): string {
  const satellites = useAnnexClientStore((s) => s.satellites);
  const hosts = new Set(agents.filter((a) => isRemoteAgentId(a.id)).map((a) => parseNamespacedId(a.id)?.satelliteId));
  if (hosts.size === 1) {
    const [id] = hosts;
    const alias = satellites.find((s) => s.id === id)?.alias;
    return alias ? `on ${alias}` : 'on another host';
  }
  return `on ${hosts.size} hosts`;
}

export function ReviewEmptyState({ cause, all, detailed, onShowSleeping, onShowEveryone, onToggleSleeping, onToggleRemote, onClearFilters, onWake, onNewAgent }: {
  cause: EmptyCause;
  all: AgentInfo[];
  detailed: Map<string, PluginAgentDetailedStatus | null>;
  onShowSleeping: () => void;
  onShowEveryone: () => void;
  onToggleSleeping: () => void;
  onToggleRemote: () => void;
  onClearFilters: () => void;
  onWake: (agentId: string) => void;
  /** Absent when there is no project to add an agent to, or in the classic layout. */
  onNewAgent?: () => void;
}) {
  const remoteWhere = useRemoteWhere(all);
  const newAgent = onNewAgent && (
    <Button kind="ghost" icon={<Svg>{Icon.plus}</Svg>} onClick={onNewAgent}>New agent</Button>
  );

  let body: React.ReactNode;
  if (cause.kind === 'no-agents') {
    body = (
      <>
        <Head title="No agents yet" sub="Agents you start show up here, one at a time." />
        {newAgent && <div className="mt-1.5 flex gap-2">{newAgent}</div>}
      </>
    );
  } else if (cause.kind === 'nothing-running') {
    const n = cause.sleepers.length;
    body = (
      <>
        <Head title="Nothing is running" sub={`${n === 1 ? '1 agent is' : `${n} agents are`} asleep. Turn on Sleeping to step through them, or wake one here.`} />
        <List>
          {cause.sleepers.slice(0, LIST_LIMIT).map((a) => (
            <AgentLine key={a.id} agent={a} right={
              a.kind === 'durable'
                ? <Button kind="quiet" onClick={() => onWake(a.id)}>Wake</Button>
                : undefined
            } />
          ))}
          <More n={n - LIST_LIMIT} />
        </List>
        <div className="mt-1.5 flex gap-2">
          <Button kind="primary" onClick={onShowSleeping} data-testid="review-empty-show-sleeping">Show sleeping</Button>
          {newAgent}
        </div>
      </>
    );
  } else if (cause.kind === 'nobody-needs-you') {
    const n = cause.others.length;
    body = (
      <>
        <Head title="Nobody needs you" sub={`${describeAgents(cause.others)}. One shows up here when it asks for permission or hits an error.`} />
        <List>
          {cause.others.slice(0, LIST_LIMIT).map((a) => {
            const d = detailed.get(a.id);
            return <AgentLine key={a.id} agent={a} detailed={d} right={d?.message ? <span className="truncate max-w-[180px]">{d.message}</span> : undefined} />;
          })}
          <More n={n - LIST_LIMIT} />
        </List>
        <div className="mt-1.5 flex gap-2">
          <Button kind="ghost" onClick={onShowEveryone} data-testid="review-empty-show-everyone">Show everyone</Button>
        </div>
      </>
    );
  } else {
    const rows: React.ReactNode[] = [];
    if (cause.hiddenByRemote > 0) rows.push(<FilterLine key="remote" label="Remote" detail={`${cause.hiddenByRemote} ${remoteWhere}`} onToggle={onToggleRemote} />);
    if (cause.hiddenBySleeping > 0) rows.push(<FilterLine key="sleeping" label="Sleeping" detail={`${cause.hiddenBySleeping} asleep`} onToggle={onToggleSleeping} />);
    body = (
      <>
        <Head
          title={cause.total === 1 ? 'Your filters hide the only agent' : `Your filters hide all ${agentCount(cause.total)}`}
          sub={rows.length ? 'Turn one of these on, or clear the filters.' : 'Clear the filters to see them.'}
        />
        {rows.length > 0 && (
          <List>
            {rows.map((row, i) => (
              <React.Fragment key={i}>
                {i > 0 && <div className="h-px mx-3 bg-surface-0" />}
                {row}
              </React.Fragment>
            ))}
          </List>
        )}
        <div className="mt-1.5 flex gap-2">
          <Button kind="ghost" onClick={onClearFilters} data-testid="review-empty-clear-filters">Clear filters</Button>
        </div>
      </>
    );
  }

  return (
    <div className="h-full w-full flex items-center justify-center p-4" data-testid="review-empty" data-cause={cause.kind}>
      <div className="w-full max-w-[400px] flex flex-col gap-2.5">{body}</div>
    </div>
  );
}

function Head({ title, sub }: { title: string; sub: string }) {
  return (
    <>
      <div className="text-sm font-semibold text-ctp-text">{title}</div>
      <div className="text-[12.5px] leading-normal text-ctp-overlay1">{sub}</div>
    </>
  );
}

function More({ n }: { n: number }) {
  if (n <= 0) return null;
  return <div className="h-[26px] flex items-center px-3 text-xs text-ctp-overlay1">and {n} more</div>;
}

function FilterLine({ label, detail, onToggle }: { label: string; detail: string; onToggle: () => void }) {
  return (
    <label className="h-9 flex items-center gap-2.5 px-3 cursor-pointer">
      <Toggle checked={false} onChange={onToggle} aria-label={label} />
      <span className="text-[13px] text-ctp-text">{label}</span>
      <span className="text-xs text-ctp-overlay1 truncate">{detail}</span>
    </label>
  );
}
