import React from 'react';
import type { Agent } from '../../../shared/types';
import { AgentAvatar } from '../../features/agents/AgentAvatar';
import type { AgentDot } from './treeModel';

/**
 * Tree roles (role=tree / treeitem with arrow-key navigation) arrive with the
 * keyboard pass in Phase 4 (spec §4.8); until then rows are plain buttons.
 *
 * One 30px agent row (docs/chrome-redesign-spec.md §2): status dot, 18px
 * avatar, name, then a short right-aligned note. Chips move to the hover card
 * in Phase 4. Keeps the legacy `agent-item-<id>` test id (§9).
 */

const DOT_CLASS: Record<AgentDot, string> = {
  working: 'bg-ctp-success',
  idle: 'bg-ctp-info',
  needs: 'bg-ctp-warning',
  error: 'bg-ctp-error',
  sleeping: 'border border-ctp-overlay0',
  starting: 'border border-ctp-info',
};

const DOT_LABEL: Record<AgentDot, string> = {
  working: 'Working',
  idle: 'Idle',
  needs: 'Needs you',
  error: 'Error',
  sleeping: 'Sleeping',
  starting: 'Starting',
};

export function StatusDot({ dot }: { dot: AgentDot }) {
  return (
    <span
      className={`w-2 h-2 rounded-full flex-shrink-0 ${DOT_CLASS[dot]}`}
      role="img"
      aria-label={DOT_LABEL[dot]}
      title={DOT_LABEL[dot]}
    />
  );
}

interface AgentRowProps {
  agent: Agent;
  dot: AgentDot;
  active: boolean;
  indent: number;
  onSelect: (agent: Agent) => void;
}

export const AgentRow = React.memo(function AgentRow({ agent, dot, active, indent, onSelect }: AgentRowProps) {
  const note = dot === 'needs' ? 'needs you' : dot === 'error' ? 'error' : agent.kind === 'quick' ? 'quick' : '';
  return (
    <button
      type="button"
      aria-current={active ? 'true' : undefined}
      data-testid={`agent-item-${agent.id}`}
      data-agent-id={agent.id}
      data-agent-name={agent.name}
      data-active={active}
      onClick={() => onSelect(agent)}
      style={{ paddingLeft: indent }}
      className={`w-full h-[30px] flex-shrink-0 pr-2 rounded-md flex items-center gap-2 text-[13px] text-left cursor-pointer transition-colors duration-100 ${
        active ? 'bg-surface-0 text-ctp-text' : 'text-ctp-subtext1 hover:bg-surface-0/60 hover:text-ctp-text'
      }`}
    >
      <StatusDot dot={dot} />
      <span className="relative flex-shrink-0">
        <AgentAvatar agent={agent} size="2xs" />
        {agent.freeAgentMode && (
          <span
            role="img"
            aria-label="Free Agent Mode: all permissions bypassed"
            className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-ctp-error ring-1 ring-ctp-mantle"
            title="Free Agent Mode: all permissions bypassed"
          />
        )}
      </span>
      <span className={`truncate ${dot === 'sleeping' ? '' : 'font-medium'}`}>{agent.name}</span>
      {note && (
        <span className={`ml-auto flex-shrink-0 text-xs ${dot === 'needs' ? 'text-ctp-warning' : dot === 'error' ? 'text-ctp-error' : 'text-ctp-overlay1'}`}>
          {note}
        </span>
      )}
    </button>
  );
});
