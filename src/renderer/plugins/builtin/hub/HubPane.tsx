import React, { useCallback, useMemo, useState, useRef } from 'react';
import type { LeafPane } from './pane-tree';
import type { PluginAPI, AgentInfo, PluginAgentDetailedStatus, CompletedQuickAgentInfo } from '../../../../shared/plugin-types';

interface HubPaneProps {
  pane: LeafPane;
  api: PluginAPI;
  focused: boolean;
  canClose: boolean;
  onSplit: (paneId: string, direction: 'horizontal' | 'vertical', position: 'before' | 'after') => void;
  onClose: (paneId: string) => void;
  onSwap: (sourceId: string, targetId: string) => void;
  onAssign: (paneId: string, agentId: string | null, projectId?: string) => void;
  onFocus: (paneId: string) => void;
  onZoom?: (paneId: string) => void;
  isZoomed?: boolean;
  agents: AgentInfo[];
  detailedStatuses: Record<string, PluginAgentDetailedStatus | null>;
  completedAgents: CompletedQuickAgentInfo[];
  children?: React.ReactNode; // picker slot
}

type SplitEdge = 'top' | 'bottom' | 'left' | 'right';

const EDGE_THRESHOLD = 32;
const EDGE_ICONS: Record<SplitEdge, string> = { top: '\u2191', bottom: '\u2193', left: '\u2190', right: '\u2192' };
const EDGE_LABELS: Record<SplitEdge, string> = { top: 'Split Up', bottom: 'Split Down', left: 'Split Left', right: 'Split Right' };

export function HubPane({
  pane,
  api,
  focused,
  canClose,
  onSplit,
  onClose,
  onSwap,
  onAssign,
  onFocus,
  onZoom,
  isZoomed,
  agents,
  detailedStatuses,
  completedAgents,
  children,
}: HubPaneProps) {
  const [hoveredEdge, setHoveredEdge] = useState<SplitEdge | null>(null);
  const [paneHovered, setPaneHovered] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const paneRef = useRef<HTMLDivElement>(null);

  const agent = useMemo(
    () => agents.find((a) => a.id === pane.agentId) ?? null,
    [agents, pane.agentId],
  );

  const completed = useMemo(
    () => pane.agentId ? completedAgents.find((c) => c.id === pane.agentId) ?? null : null,
    [completedAgents, pane.agentId],
  );

  const detailedStatus = pane.agentId ? (detailedStatuses[pane.agentId] ?? null) : null;
  const isPermission = detailedStatus?.state === 'needs_permission';
  const isToolError = detailedStatus?.state === 'tool_error';

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData('text/x-pane-id', pane.id);
    e.dataTransfer.effectAllowed = 'move';
  }, [pane.id]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('text/x-pane-id')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setIsDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const sourceId = e.dataTransfer.getData('text/x-pane-id');
    if (sourceId && sourceId !== pane.id) {
      onSwap(sourceId, pane.id);
    }
  }, [pane.id, onSwap]);

  const handleClick = useCallback(() => {
    onFocus(pane.id);
  }, [pane.id, onFocus]);

  const handleKill = useCallback(async () => {
    if (pane.agentId) {
      await api.agents.kill(pane.agentId);
    }
  }, [pane.agentId, api]);

  const handleUnassign = useCallback(() => {
    onAssign(pane.id, null);
  }, [pane.id, onAssign]);

  const handleViewInAgents = useCallback(() => {
    if (pane.agentId) {
      api.navigation.focusAgent(pane.agentId);
    }
  }, [pane.agentId, api]);

  const handleEdgeSplit = useCallback((edge: SplitEdge) => {
    const dir: 'horizontal' | 'vertical' = (edge === 'left' || edge === 'right') ? 'horizontal' : 'vertical';
    const pos: 'before' | 'after' = (edge === 'left' || edge === 'top') ? 'before' : 'after';
    onSplit(pane.id, dir, pos);
  }, [pane.id, onSplit]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!paneRef.current) return;
    const rect = paneRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (y < EDGE_THRESHOLD) setHoveredEdge('top');
    else if (y > rect.height - EDGE_THRESHOLD) setHoveredEdge('bottom');
    else if (x < EDGE_THRESHOLD) setHoveredEdge('left');
    else if (x > rect.width - EDGE_THRESHOLD) setHoveredEdge('right');
    else setHoveredEdge(null);
  }, []);

  // Border color: permission (orange), tool error (yellow), focused (indigo), default (subtle)
  const borderColor = isPermission
    ? 'rgb(249,115,22)'
    : isToolError
      ? 'rgb(234,179,8)'
      : focused
        ? 'rgb(99,102,241)'
        : 'transparent';

  const borderWidth = (isPermission || isToolError || focused) ? 2 : 1;
  const borderFallback = (!isPermission && !isToolError && !focused) ? 'rgb(var(--ctp-surface2) / 1)' : undefined;

  const { AgentTerminal, SleepingAgent, AgentAvatar, QuickAgentGhost } = api.widgets;

  // Chip: compact tag when idle, stretches to near-trailing-edge on pane hover
  const expanded = paneHovered;

  return (
    <div
      ref={paneRef}
      className={`relative w-full h-full flex flex-col rounded-sm overflow-hidden ${isPermission ? 'animate-pulse' : ''}`}
      style={{
        boxShadow: `inset 0 0 0 ${borderWidth}px ${borderFallback || borderColor}`,
      }}
      onClick={handleClick}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onMouseEnter={() => setPaneHovered(true)}
      onMouseLeave={() => { setPaneHovered(false); setHoveredEdge(null); }}
      onMouseMove={handleMouseMove}
    >
      {/* Content area */}
      <div className="flex-1 min-h-0 overflow-hidden relative">
        {agent ? (
          agent.status === 'running' ? (
            <AgentTerminal agentId={agent.id} focused={focused} />
          ) : (
            <SleepingAgent agentId={agent.id} />
          )
        ) : completed ? (
          <QuickAgentGhost
            completed={completed}
            onDismiss={() => {
              api.agents.dismissCompleted(completed.projectId, completed.id);
              onAssign(pane.id, null);
            }}
          />
        ) : (
          <div className="relative w-full h-full">
            {canClose && (
              <button
                onClick={(e) => { e.stopPropagation(); onClose(pane.id); }}
                className="absolute top-2 right-2 z-10 w-6 h-6 flex items-center justify-center rounded
                  text-xs text-ctp-overlay0 bg-surface-1/60 hover:bg-red-500/20 hover:text-red-400 transition-colors"
                title="Close pane"
              >
                &times;
              </button>
            )}
            {children}
          </div>
        )}
      </div>

      {/* Floating name chip — inset tag, expands on pane hover */}
      {agent && (
        <div
          className={`
            absolute top-2 left-2 z-20 transition-all duration-150 ease-out
            ${expanded ? 'right-2' : ''}
          `}
          style={expanded ? undefined : { maxWidth: 'fit-content' }}
        >
          <div
            className={`
              flex items-center gap-1.5 rounded-lg backdrop-blur-md transition-all duration-150
              ${expanded
                ? 'bg-ctp-mantle/95 shadow-lg px-2.5 py-1.5'
                : 'bg-ctp-mantle/70 shadow px-2 py-1 cursor-grab'
              }
            `}
            draggable
            onDragStart={handleDragStart}
          >
            <AgentAvatar agentId={agent.id} size="sm" showStatusRing />
            <span className="text-[11px] font-medium text-ctp-text truncate">
              {agent.name}
            </span>
            {expanded && (
              <>
                <div className="flex-1" />
                <div className="flex items-center gap-1 ml-1 flex-shrink-0">
                  <button
                    onClick={(e) => { e.stopPropagation(); handleViewInAgents(); }}
                    className="text-[10px] px-1.5 py-0.5 rounded bg-surface-1 text-ctp-subtext0 hover:bg-surface-2 hover:text-ctp-text"
                    title="View in Agents"
                  >
                    View
                  </button>
                  {onZoom && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onZoom(pane.id); }}
                      className="text-[10px] px-1.5 py-0.5 rounded bg-surface-1 text-ctp-subtext0 hover:bg-surface-2 hover:text-ctp-text"
                      title={isZoomed ? 'Restore pane' : 'Zoom pane'}
                      data-testid="zoom-button"
                    >
                      {isZoomed ? 'Restore' : 'Zoom'}
                    </button>
                  )}
                  {agent.status === 'running' && (
                    <button
                      onClick={(e) => { e.stopPropagation(); handleKill(); }}
                      className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30"
                      title="Stop agent"
                    >
                      Stop
                    </button>
                  )}
                  <button
                    onClick={(e) => { e.stopPropagation(); handleUnassign(); }}
                    className="text-[10px] px-1 py-0.5 rounded bg-surface-1 text-ctp-subtext0 hover:bg-red-500/20 hover:text-red-400"
                    title="Remove from pane"
                  >
                    &times;
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Drag-over shadow overlay */}
      {isDragOver && (
        <div className="absolute inset-0 z-30 bg-indigo-500/10 border-2 border-dashed border-indigo-500/40 rounded-sm pointer-events-none" />
      )}

      {/* Edge split indicators */}
      {paneHovered && (
        <>
          <EdgeIndicator edge="top" active={hoveredEdge === 'top'} onSplit={handleEdgeSplit} />
          <EdgeIndicator edge="bottom" active={hoveredEdge === 'bottom'} onSplit={handleEdgeSplit} />
          <EdgeIndicator edge="left" active={hoveredEdge === 'left'} onSplit={handleEdgeSplit} />
          <EdgeIndicator edge="right" active={hoveredEdge === 'right'} onSplit={handleEdgeSplit} />
        </>
      )}
    </div>
  );
}

function EdgeIndicator({ edge, active, onSplit }: {
  edge: SplitEdge;
  active: boolean;
  onSplit: (edge: SplitEdge) => void;
}) {
  const positionClass = {
    top:    'top-1 left-1/2 -translate-x-1/2',
    bottom: 'bottom-1 left-1/2 -translate-x-1/2',
    left:   'left-1 top-1/2 -translate-y-1/2',
    right:  'right-1 top-1/2 -translate-y-1/2',
  }[edge];

  const stripClass = {
    top:    'top-0 left-3 right-3 h-0.5',
    bottom: 'bottom-0 left-3 right-3 h-0.5',
    left:   'left-0 top-3 bottom-3 w-0.5',
    right:  'right-0 top-3 bottom-3 w-0.5',
  }[edge];

  return (
    <>
      {active && (
        <div className={`absolute ${stripClass} bg-ctp-accent/50 pointer-events-none z-10 rounded`} />
      )}
      <button
        className={`
          absolute ${positionClass} z-20 flex items-center justify-center w-5 h-5 rounded-full
          text-[10px] font-bold transition-all duration-100 cursor-pointer
          ${active
            ? 'bg-ctp-accent text-white shadow-md scale-110'
            : 'bg-surface-1/60 text-ctp-overlay0 hover:bg-surface-1 hover:text-ctp-subtext0'
          }
        `}
        title={EDGE_LABELS[edge]}
        onClick={(e) => { e.stopPropagation(); onSplit(edge); }}
      >
        {EDGE_ICONS[edge]}
      </button>
    </>
  );
}
