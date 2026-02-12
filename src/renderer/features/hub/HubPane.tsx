import { useState, useCallback } from 'react';
import { AgentTerminal } from '../agents/AgentTerminal';
import { AgentPicker } from './AgentPicker';
import { QuickAgentGhost } from './QuickAgentGhost';
import { useHubStore } from '../../stores/hubStore';
import { useAgentStore } from '../../stores/agentStore';
import { useQuickAgentStore } from '../../stores/quickAgentStore';
import { useProjectStore } from '../../stores/projectStore';

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
      </div>
    );
  }

  return (
    <div
      className={`h-full w-full relative overflow-hidden ${isFocused ? 'ring-1 ring-indigo-500 ring-inset' : ''}`}
      onClick={() => setFocusedPane(paneId)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <AgentTerminal agentId={agentId} focused={isFocused} />

      {/* Hover overlay */}
      {hovered && (
        <>
          {/* Top bar: agent name + close */}
          <div className="absolute top-0 left-0 right-0 h-8 bg-ctp-mantle/90 border-b border-surface-0 flex items-center px-2 gap-2 z-10">
            {agent && (
              <>
                <span
                  className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{ backgroundColor: agent.color }}
                />
                <span className="text-xs text-ctp-text truncate flex-1">{agent.name}</span>
              </>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); handleClose(); }}
              className="w-5 h-5 flex items-center justify-center rounded hover:bg-surface-2 text-ctp-subtext0 hover:text-ctp-text cursor-pointer flex-shrink-0"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          {/* Split buttons at edges */}
          <SplitButton direction="up" paneId={paneId} className="absolute top-10 left-1/2 -translate-x-1/2 z-10" />
          <SplitButton direction="down" paneId={paneId} className="absolute bottom-1 left-1/2 -translate-x-1/2 z-10" />
          <SplitButton direction="left" paneId={paneId} className="absolute left-1 top-1/2 -translate-y-1/2 z-10" />
          <SplitButton direction="right" paneId={paneId} className="absolute right-1 top-1/2 -translate-y-1/2 z-10" />
        </>
      )}
    </div>
  );
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
