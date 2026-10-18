import { forwardRef } from 'react';
import { createPortal } from 'react-dom';
import type { Agent, AgentDetailedStatus } from '../../../shared/types';
import { useAgentStore } from '../../stores/agentStore';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { getOrchestratorLabel, formatModelLabel } from '../../features/agents/orchestrator-colors';
import type { ActionDef } from '../../features/agents/useAgentRowActions';
import { relativeTo } from '../scope';
import { DOT_LABEL, StatusDot } from '../../features/agents/agent-status';
import type { AgentDot } from './treeModel';
import { Tooltip } from '../../components/Tooltip';
import { describeSleep, formatAgo } from '../../features/agents/states/format';

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The agent hover card (docs/chrome-redesign-spec.md §2, §4.2): the details the
 * old row showed as chips, plus the three most used actions. Opens after a
 * short hover or keyboard focus on a row and closes on Esc or leaving.
 */


export function formatDuration(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'under a minute';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h}h ${min % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-ctp-overlay1">{label}</dt>
      <dd className="min-w-0 truncate text-ctp-subtext1">{children}</dd>
    </>
  );
}

export const AgentHoverCard = forwardRef<HTMLDivElement, {
  agent: Agent;
  dot: AgentDot;
  detailed: AgentDetailedStatus | undefined;
  projectPath: string | undefined;
  /** The row's rectangle; the card opens beside it. */
  anchor: DOMRect;
  actions: ActionDef[];
  onOpenTerminal?: () => void;
  onAction: (action: ActionDef) => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onFocus: () => void;
  onBlur: (e: React.FocusEvent) => void;
}>(function AgentHoverCard({ agent, dot, detailed, projectPath, anchor, actions, onOpenTerminal, onAction, onMouseEnter, onMouseLeave, onFocus, onBlur }, ref) {
  const spawnedAt = useAgentStore((s) => s.agentSpawnedAt[agent.id]);
  const allOrchestrators = useOrchestratorStore((s) => s.allOrchestrators);
  const running = agent.status === 'running' && spawnedAt;
  const worktree = agent.worktreePath && projectPath ? relativeTo(projectPath, agent.worktreePath) : agent.worktreePath;
  const quick = actions.filter((a) => a.id === 'stop' || a.id === 'wake' || a.id === 'settings');

  const width = 280;
  const left = Math.min(anchor.right + 8, window.innerWidth - width - 8);
  const top = Math.max(8, Math.min(anchor.top - 8, window.innerHeight - 240));

  return createPortal(
    <div
      ref={ref}
      onFocus={onFocus}
      onBlur={onBlur}
      role="dialog"
      aria-label={`${agent.name} details`}
      data-testid="agent-hover-card"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{ left, top, width }}
      className="fixed z-dropdown rounded-lg border border-surface-1 bg-ctp-mantle shadow-xl p-3 flex flex-col gap-2 text-xs"
    >
      <div className="flex items-center gap-2 min-w-0">
        <StatusDot dot={dot} />
        <span className="text-[13px] font-medium text-ctp-text truncate">{agent.name}</span>
        <span className="ml-auto flex-shrink-0 text-ctp-overlay1">
          {DOT_LABEL[dot]}{running && dot !== 'idle' ? ` for ${formatDuration(Date.now() - spawnedAt)}` : ''}
        </span>
      </div>
      {!detailed?.message && !agent.errorMessage && agent.status === 'sleeping' && agent.lastSleep && (
        <p className="leading-snug text-ctp-subtext0" data-testid="agent-sleep-reason">
          {capitalize(describeSleep(agent.lastSleep))}, {formatAgo(Date.parse(agent.lastSleep.at))}.
        </p>
      )}
      {(detailed?.message || agent.errorMessage) && (
        <p className={`leading-snug ${dot === 'needs' ? 'text-ctp-warning' : dot === 'error' ? 'text-ctp-error' : 'text-ctp-subtext0'}`}>
          {detailed?.message || agent.errorMessage}
        </p>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <Row label="Runs on">
          {getOrchestratorLabel(agent.orchestrator || 'claude-code', allOrchestrators)}, {formatModelLabel(agent.model)}
        </Row>
        {agent.branch && <Row label="Branch"><span className="font-mono">{agent.branch}</span></Row>}
        {worktree && <Row label="Worktree"><Tooltip content={agent.worktreePath} disabled={worktree === agent.worktreePath}><span className="font-mono">{worktree}</span></Tooltip></Row>}
        {agent.mcpIds && agent.mcpIds.length > 0 && <Row label="MCP">{agent.mcpIds.join(', ')}</Row>}
        {agent.freeAgentMode && <Row label="Permissions"><span className="text-ctp-error">Free Agent Mode, all bypassed</span></Row>}
      </dl>
      {(onOpenTerminal || quick.length > 0) && (
        <div className="flex items-center gap-3 pt-1 border-t border-surface-0">
          {onOpenTerminal && (
            <button type="button" onClick={onOpenTerminal} className="text-ctp-subtext0 hover:text-ctp-text cursor-pointer">Open terminal</button>
          )}
          {quick.map((action) => (
            <button key={action.id} type="button" data-testid={`hover-${action.id}`} onClick={() => onAction(action)} className="text-ctp-subtext0 hover:text-ctp-text cursor-pointer">
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
});
