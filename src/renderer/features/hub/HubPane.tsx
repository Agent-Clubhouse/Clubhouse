import { useState, useCallback } from 'react';
import { AgentTerminal } from '../agents/AgentTerminal';
import { SleepingClaude } from '../agents/SleepingClaude';
import { AgentPicker } from './AgentPicker';
import { QuickAgentGhost } from './QuickAgentGhost';
import { useHubStore } from '../../stores/hubStore';
import { useAgentStore } from '../../stores/agentStore';
import { useQuickAgentStore } from '../../stores/quickAgentStore';
import { useProjectStore } from '../../stores/projectStore';
import { AgentAvatar } from '../agents/AgentAvatar';
import { Agent } from '../../../shared/types';

const STATUS_RING_COLOR: Record<string, string> = {
  running: '#22c55e',
  sleeping: '#6c7086',
  error: '#f87171',
};

interface Props {
  paneId: string;
  agentId: string | null;
  onCloseConfirm: (paneId: string, agentId: string) => void;
}

export function HubPane({ paneId, agentId, onCloseConfirm }: Props) {
  const [hovered, setHovered] = useState(false);
  const focusedPaneId = useHubStore((s) => s.focusedPaneId);
  const setFocusedPane = useHubStore((s) => s.setFocusedPane);
  const closePane = useHubStore((s) => s.closePane);
  const agents = useAgentStore((s) => s.agents);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const completedAgents = useQuickAgentStore((s) =>
    activeProjectId ? s.getCompleted(activeProjectId) : []
  );
  const dismissCompleted = useQuickAgentStore((s) => s.dismissCompleted);

  const isFocused = focusedPaneId === paneId;
  const agent = agentId ? agents[agentId] : null;
  const attentionClass = useAttentionBorder(agent);

  // Check if this pane's agent was a completed quick agent (agent removed from store)
  const completedRecord = agentId && !agent
    ? completedAgents.find((c) => c.id === agentId)
    : null;

  const handleClose = useCallback(() => {
    if (!agentId || !agent) {
      closePane(paneId);
      return;
    }

    // Sleeping/errored durable agents: just detach
    if (agent.kind === 'durable' && (agent.status === 'sleeping' || agent.status === 'error')) {
      closePane(paneId);
      return;
    }

    // Sleeping/errored quick agents: remove and close
    if (agent.kind === 'quick' && (agent.status === 'sleeping' || agent.status === 'error')) {
      useAgentStore.getState().removeAgent(agentId);
      closePane(paneId);
      return;
    }

    // Running agents need confirmation
    onCloseConfirm(paneId, agentId);
  }, [paneId, agentId, agent, closePane, onCloseConfirm]);

  // Show ghost card for completed quick agents
  if (completedRecord) {
    return (
      <div
        className="h-full w-full relative overflow-hidden"
        onClick={() => setFocusedPane(paneId)}
      >
        <QuickAgentGhost
          completed={completedRecord}
          onDismiss={() => {
            if (activeProjectId) {
              dismissCompleted(activeProjectId, completedRecord.id);
            }
            useHubStore.getState().removePanesByAgent(completedRecord.id);
          }}
        />
        {/* Focus ring overlay */}
        {isFocused && (
          <div className="absolute inset-0 border border-indigo-500 pointer-events-none z-20" />
        )}
      </div>
    );
  }

  if (!agentId || !agent) {
    return (
      <div
        className="h-full w-full relative overflow-hidden"
        onClick={() => setFocusedPane(paneId)}
      >
        <AgentPicker paneId={paneId} />
        {/* Focus ring overlay */}
        {isFocused && (
          <div className="absolute inset-0 border border-indigo-500 pointer-events-none z-20" />
        )}
      </div>
    );
  }

  return (
    <div
      className="h-full w-full relative overflow-hidden"
      onClick={() => setFocusedPane(paneId)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {agent.status === 'running' ? (
        <AgentTerminal agentId={agentId} focused={isFocused} />
      ) : (
        <SleepingClaude agent={agent} />
      )}

      {/* Status chip — expands to full width on hover */}
      {agent && <StatusChip agent={agent} expanded={hovered} onClose={handleClose} />}

      {/* Split buttons at edges (visible on hover) */}
      {hovered && (
        <>
          <SplitButton direction="up" paneId={paneId} className="absolute top-10 left-1/2 -translate-x-1/2 z-10" />
          <SplitButton direction="down" paneId={paneId} className="absolute bottom-1 left-1/2 -translate-x-1/2 z-10" />
          <SplitButton direction="left" paneId={paneId} className="absolute left-1 top-1/2 -translate-y-1/2 z-10" />
          <SplitButton direction="right" paneId={paneId} className="absolute right-1 top-1/2 -translate-y-1/2 z-10" />
        </>
      )}

      {/* Attention border — pulsing orange for needs_permission, static yellow for tool_error */}
      {attentionClass && (
        <div className={`absolute inset-0 pointer-events-none z-[19] ${attentionClass}`} />
      )}

      {/* Focus ring overlay — renders above hover bar */}
      {isFocused && (
        <div className="absolute inset-0 border border-indigo-500 pointer-events-none z-20" />
      )}
    </div>
  );
}

function StatusChip({ agent, expanded, onClose }: { agent: Agent; expanded: boolean; onClose: () => void }) {
  const detailed = useAgentStore((s) => s.agentDetailedStatus[agent.id]);
  const baseRingColor = STATUS_RING_COLOR[agent.status] || STATUS_RING_COLOR.sleeping;
  const ringColor = agent.status === 'running' && detailed?.state === 'needs_permission' ? '#f97316'
    : agent.status === 'running' && detailed?.state === 'tool_error' ? '#facc15'
    : baseRingColor;
  const isWorking = agent.status === 'running' && detailed?.state === 'working';

  return (
    <div
      className={`absolute top-1.5 left-1.5 z-10 flex items-center gap-1.5 px-1.5 py-0.5 rounded-md bg-ctp-mantle/80 backdrop-blur-sm border border-surface-0/50 select-none transition-all duration-150 ${
        expanded ? 'right-1.5 pointer-events-auto' : 'max-w-[45%] pointer-events-none'
      }`}
    >
      <div className={`relative flex-shrink-0 ${isWorking ? 'animate-pulse-ring' : ''}`}>
        <AgentAvatar agent={agent} size="sm" showRing ringColor={ringColor} />
      </div>
      <span className={`truncate leading-none flex-1 ${expanded ? 'text-xs text-ctp-text' : 'text-[10px] text-ctp-subtext1'}`}>{agent.name}</span>
      {expanded && (
        <button
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          className="w-5 h-5 flex items-center justify-center rounded hover:bg-surface-2 text-ctp-subtext0 hover:text-ctp-text cursor-pointer flex-shrink-0"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      )}
    </div>
  );
}

function useAttentionBorder(agent: Agent | null): string | null {
  const detailed = useAgentStore((s) =>
    agent ? s.agentDetailedStatus[agent.id] : undefined
  );
  if (!agent || agent.status !== 'running') return null;
  if (detailed?.state === 'needs_permission') return 'animate-attention-border attention-border-orange';
  if (detailed?.state === 'tool_error') return 'attention-border-yellow';
  return null;
}

function SplitButton({ direction, paneId, className }: { direction: 'up' | 'down' | 'left' | 'right'; paneId: string; className: string }) {
  const splitPane = useHubStore((s) => s.splitPane);

  const arrows: Record<string, string> = {
    up: 'M12 19V5M5 12l7-7 7 7',
    down: 'M12 5v14M19 12l-7 7-7-7',
    left: 'M19 12H5M12 5l-7 7 7 7',
    right: 'M5 12h14M12 5l7 7-7 7',
  };

  return (
    <button
      onClick={(e) => { e.stopPropagation(); splitPane(paneId, direction); }}
      className={`w-6 h-6 flex items-center justify-center rounded bg-ctp-mantle/80 border border-surface-0
        hover:bg-surface-2 text-ctp-subtext0 hover:text-ctp-text cursor-pointer ${className}`}
      title={`Split ${direction}`}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d={arrows[direction]} />
      </svg>
    </button>
  );
}
