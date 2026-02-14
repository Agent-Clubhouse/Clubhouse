import { useState, useCallback, DragEvent } from 'react';
import { AgentTerminal } from '../agents/AgentTerminal';
import { SleepingAgent } from '../agents/SleepingAgent';
import { CrossProjectAgentPicker } from './CrossProjectAgentPicker';
import { QuickAgentGhost } from '../hub/QuickAgentGhost';
import { useCrossHubStore } from '../../stores/crossHubStore';
import { useAgentStore } from '../../stores/agentStore';
import { useQuickAgentStore } from '../../stores/quickAgentStore';
import { useUIStore } from '../../stores/uiStore';
import { AgentAvatar } from '../agents/AgentAvatar';
import { Agent, CompletedQuickAgent } from '../../../shared/types';

const EMPTY_COMPLETED: CompletedQuickAgent[] = [];

const STATUS_RING_COLOR: Record<string, string> = {
  running: '#22c55e',
  sleeping: '#6c7086',
  error: '#f87171',
};

interface Props {
  paneId: string;
  agentId: string | null;
  projectId: string | null;
}

export function CrossHubPane({ paneId, agentId, projectId }: Props) {
  const [hovered, setHovered] = useState(false);
  const focusedPaneId = useCrossHubStore((s) => s.focusedPaneId);
  const setFocusedPane = useCrossHubStore((s) => s.setFocusedPane);
  const closePane = useCrossHubStore((s) => s.closePane);
  const agents = useAgentStore((s) => s.agents);
  const completedAgents = useQuickAgentStore((s) =>
    projectId ? s.getCompleted(projectId) : EMPTY_COMPLETED
  );
  const dismissCompleted = useQuickAgentStore((s) => s.dismissCompleted);

  const dragSourcePaneId = useCrossHubStore((s) => s.dragSourcePaneId);
  const dragOverPaneId = useCrossHubStore((s) => s.dragOverPaneId);
  const setDragOver = useCrossHubStore((s) => s.setDragOver);
  const swapPanes = useCrossHubStore((s) => s.swapPanes);

  const isFocused = focusedPaneId === paneId;
  const isDragSource = dragSourcePaneId === paneId;
  const isDragOver = dragOverPaneId === paneId;
  const agent = agentId ? agents[agentId] : null;
  const attentionClass = useAttentionBorder(agent);

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!dragSourcePaneId || dragSourcePaneId === paneId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOver(paneId);
  }, [dragSourcePaneId, paneId, setDragOver]);

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDragOver(null);
  }, [setDragOver]);

  const handleDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const sourcePaneId = e.dataTransfer.getData('text/x-cross-pane-id');
    if (sourcePaneId && sourcePaneId !== paneId) {
      swapPanes(sourcePaneId, paneId);
    }
  }, [paneId, swapPanes]);

  // Check if this pane's agent was a completed quick agent (agent removed from store)
  const completedRecord = agentId && !agent
    ? completedAgents.find((c) => c.id === agentId)
    : null;

  const handleClose = useCallback(() => {
    if (agentId && agent?.kind === 'quick' && (agent.status === 'sleeping' || agent.status === 'error')) {
      useAgentStore.getState().removeAgent(agentId);
    }
    closePane(paneId);
  }, [paneId, agentId, agent, closePane]);

  // Show ghost card for completed quick agents
  if (completedRecord) {
    return (
      <div
        className="h-full w-full relative overflow-hidden"
        onClick={() => setFocusedPane(paneId)}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <QuickAgentGhost
          completed={completedRecord}
          onDismiss={() => {
            useCrossHubStore.getState().removePanesByAgent(completedRecord.id);
          }}
          onDelete={() => {
            if (projectId) {
              dismissCompleted(projectId, completedRecord.id);
            }
            useCrossHubStore.getState().removePanesByAgent(completedRecord.id);
          }}
        />
        {isDragOver && (
          <div className="absolute inset-0 border-2 border-dashed border-indigo-400 bg-indigo-500/10 pointer-events-none z-[21]" />
        )}
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
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <CrossProjectAgentPicker paneId={paneId} />
        {isDragOver && (
          <div className="absolute inset-0 border-2 border-dashed border-indigo-400 bg-indigo-500/10 pointer-events-none z-[21]" />
        )}
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
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {agent.status === 'running' ? (
        <AgentTerminal agentId={agentId} focused={isFocused} />
      ) : (
        <SleepingAgent agent={agent} />
      )}

      {agent && <StatusChip agent={agent} expanded={hovered} onClose={handleClose} paneId={paneId} />}

      {hovered && (
        <>
          <SplitButton direction="up" paneId={paneId} className="absolute top-10 left-1/2 -translate-x-1/2 z-10" />
          <SplitButton direction="down" paneId={paneId} className="absolute bottom-1 left-1/2 -translate-x-1/2 z-10" />
          <SplitButton direction="left" paneId={paneId} className="absolute left-1 top-1/2 -translate-y-1/2 z-10" />
          <SplitButton direction="right" paneId={paneId} className="absolute right-1 top-1/2 -translate-y-1/2 z-10" />
        </>
      )}

      {attentionClass && (
        <div className={`absolute inset-0 pointer-events-none z-[19] ${attentionClass}`} />
      )}

      {isDragSource && (
        <div className="absolute inset-0 bg-black/40 pointer-events-none z-[21]" />
      )}

      {isDragOver && (
        <div className="absolute inset-0 border-2 border-dashed border-indigo-400 bg-indigo-500/10 pointer-events-none z-[21]" />
      )}

      {isFocused && (
        <div className="absolute inset-0 border border-indigo-500 pointer-events-none z-20" />
      )}
    </div>
  );
}

function StatusChip({ agent, expanded, onClose, paneId }: { agent: Agent; expanded: boolean; onClose: () => void; paneId: string }) {
  const detailed = useAgentStore((s) => s.agentDetailedStatus[agent.id]);
  const killAgent = useAgentStore((s) => s.killAgent);
  const setDragSource = useCrossHubStore((s) => s.setDragSource);
  const setDragOver = useCrossHubStore((s) => s.setDragOver);
  const baseRingColor = STATUS_RING_COLOR[agent.status] || STATUS_RING_COLOR.sleeping;
  const ringColor = agent.status === 'running' && detailed?.state === 'needs_permission' ? '#f97316'
    : agent.status === 'running' && detailed?.state === 'tool_error' ? '#facc15'
    : baseRingColor;
  const isWorking = agent.status === 'running' && detailed?.state === 'working';

  const handleDragStart = useCallback((e: DragEvent) => {
    e.dataTransfer.setData('text/x-cross-pane-id', paneId);
    e.dataTransfer.effectAllowed = 'move';
    setDragSource(paneId);
  }, [paneId, setDragSource]);

  const handleDragEnd = useCallback(() => {
    setDragSource(null);
    setDragOver(null);
  }, [setDragSource, setDragOver]);

  return (
    <div
      draggable={expanded}
      onDragStart={expanded ? handleDragStart : undefined}
      onDragEnd={expanded ? handleDragEnd : undefined}
      className={`absolute top-1.5 left-1.5 z-10 flex items-center gap-1.5 px-1.5 py-0.5 rounded-md bg-ctp-mantle/80 backdrop-blur-sm border border-surface-0/50 select-none transition-all duration-150 ${
        expanded ? 'right-1.5 pointer-events-auto cursor-grab active:cursor-grabbing' : 'max-w-[45%] pointer-events-none'
      }`}
    >
      <div className={`relative flex-shrink-0 ${isWorking ? 'animate-pulse-ring' : ''}`}>
        <AgentAvatar agent={agent} size="sm" showRing ringColor={ringColor} />
      </div>
      <span className={`truncate leading-none flex-1 ${expanded ? 'text-xs text-ctp-text' : 'text-[10px] text-ctp-subtext1'}`}>{agent.name}</span>
      {expanded && (
        <>
          <button
            onClick={(e) => {
              e.stopPropagation();
              useUIStore.getState().setExplorerTab('agents');
              useAgentStore.getState().setActiveAgent(agent.id);
            }}
            title="View in Agents"
            className="w-5 h-5 flex items-center justify-center rounded hover:bg-surface-2 text-ctp-subtext0 hover:text-ctp-text cursor-pointer flex-shrink-0"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 18l6-6-6-6" />
            </svg>
          </button>
          {agent.status === 'running' && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                killAgent(agent.id);
              }}
              title="Sleep agent"
              className="w-5 h-5 flex items-center justify-center rounded hover:bg-surface-2 text-ctp-subtext0 hover:text-ctp-text cursor-pointer flex-shrink-0"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                <rect x="3" y="3" width="18" height="18" rx="2" />
              </svg>
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); onClose(); }}
            className="w-5 h-5 flex items-center justify-center rounded hover:bg-surface-2 text-ctp-subtext0 hover:text-ctp-text cursor-pointer flex-shrink-0"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </>
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
  const splitPane = useCrossHubStore((s) => s.splitPane);

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
