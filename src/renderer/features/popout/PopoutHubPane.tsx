/**
 * Leaf pane component for the pop-out hub.
 *
 * Mirrors HubPane rendering but uses direct imports instead of PluginAPI.
 * The "View" button focuses the main window; "Pop Out" is omitted since
 * we're already in a pop-out.
 */
import React, { useCallback, useMemo, useState, useRef } from 'react';
import { AgentTerminal } from '../agents/AgentTerminal';
import { SleepingAgent } from '../agents/SleepingAgent';
import { AgentAvatarWithRing } from '../agents/AgentAvatar';
import { QuickAgentGhost } from '../agents/QuickAgentGhost';
import { useAgentStore } from '../../stores/agentStore';
import type { LeafPane } from '../../plugins/builtin/hub/pane-tree';
import type { Agent, AgentDetailedStatus, CompletedQuickAgent } from '../../../shared/types';

type SplitEdge = 'top' | 'bottom' | 'left' | 'right';

const EDGE_THRESHOLD = 32;
const EDGE_ICONS: Record<SplitEdge, string> = { top: '\u2191', bottom: '\u2193', left: '\u2190', right: '\u2192' };
const EDGE_LABELS: Record<SplitEdge, string> = { top: 'Split Up', bottom: 'Split Down', left: 'Split Left', right: 'Split Right' };

interface PopoutHubPaneProps {
  pane: LeafPane;
  focused: boolean;
  canClose: boolean;
  isZoomed?: boolean;
  onSplit: (paneId: string, direction: 'horizontal' | 'vertical', position: 'before' | 'after') => void;
  onClose: (paneId: string) => void;
  onSwap: (sourceId: string, targetId: string) => void;
  onAssign: (paneId: string, agentId: string | null) => void;
  onFocus: (paneId: string) => void;
  onZoom: (paneId: string) => void;
  agents: Record<string, Agent>;
  detailedStatuses: Record<string, AgentDetailedStatus>;
  completedAgents: CompletedQuickAgent[];
  projectId?: string;
  dismissCompleted: (projectId: string, agentId: string) => void;
}

export function PopoutHubPane({
  pane,
  focused,
  canClose,
  isZoomed,
  onSplit,
  onClose,
  onSwap,
  onAssign,
  onFocus,
  onZoom,
  agents,
  detailedStatuses,
  completedAgents,
  projectId,
  dismissCompleted,
}: PopoutHubPaneProps) {
  const agent = pane.agentId ? agents[pane.agentId] ?? null : null;
  const killAgent = useAgentStore((s) => s.killAgent);
  const [hoveredEdge, setHoveredEdge] = useState<SplitEdge | null>(null);
  const [paneHovered, setPaneHovered] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const paneRef = useRef<HTMLDivElement>(null);

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

  const handleDragLeave = useCallback(() => setIsDragOver(false), []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const sourceId = e.dataTransfer.getData('text/x-pane-id');
    if (sourceId && sourceId !== pane.id) {
      onSwap(sourceId, pane.id);
    }
  }, [pane.id, onSwap]);

  const handleClick = useCallback(() => onFocus(pane.id), [pane.id, onFocus]);

  const handleKill = useCallback(async () => {
    if (pane.agentId) await killAgent(pane.agentId);
  }, [pane.agentId, killAgent]);

  const handleUnassign = useCallback(() => onAssign(pane.id, null), [pane.id, onAssign]);

  const handleViewInApp = useCallback(() => {
    if (pane.agentId) window.clubhouse.window.focusMain(pane.agentId);
  }, [pane.agentId]);

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

  const borderColor = isPermission
    ? 'rgb(249,115,22)'
    : isToolError
      ? 'rgb(234,179,8)'
      : focused
        ? 'rgb(99,102,241)'
        : 'transparent';
  const borderWidth = (isPermission || isToolError || focused) ? 2 : 1;
  const borderFallback = (!isPermission && !isToolError && !focused) ? 'rgb(var(--ctp-surface2) / 1)' : undefined;

  const expanded = paneHovered;

  return (
    <div
      ref={paneRef}
      className={`relative w-full h-full flex flex-col rounded-sm overflow-hidden ${isPermission ? 'animate-pulse' : ''}`}
      style={{ boxShadow: `inset 0 0 0 ${borderWidth}px ${borderFallback || borderColor}` }}
      onClick={handleClick}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onMouseEnter={() => setPaneHovered(true)}
      onMouseLeave={() => { setPaneHovered(false); setHoveredEdge(null); }}
      onMouseMove={handleMouseMove}
    >
      {/* Content */}
      <div className="flex-1 min-h-0 overflow-hidden relative">
        {agent ? (
          agent.status === 'running' ? (
            <AgentTerminal agentId={agent.id} focused={focused} />
          ) : (
            <SleepingAgent agent={agent} />
          )
        ) : completed ? (
          <QuickAgentGhost
            completed={completed}
            onDismiss={() => {
              if (projectId) dismissCompleted(projectId, completed.id);
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
            <PopoutAgentPicker agents={agents} onPick={(agentId) => onAssign(pane.id, agentId)} />
          </div>
        )}
      </div>

      {/* Floating name chip */}
      {agent && (
        <div
          className={`absolute top-2 left-2 z-20 transition-all duration-150 ease-out ${expanded ? 'right-2' : ''}`}
          style={expanded ? undefined : { maxWidth: 'fit-content' }}
        >
          <div
            className={`flex items-center gap-1.5 rounded-lg backdrop-blur-md transition-all duration-150
              ${expanded ? 'bg-ctp-mantle/95 shadow-lg px-2.5 py-1.5' : 'bg-ctp-mantle/70 shadow px-2 py-1 cursor-grab'}`}
            draggable
            onDragStart={handleDragStart}
          >
            <AgentAvatarWithRing agent={agent} />
            <span className="text-[11px] font-medium text-ctp-text truncate">{agent.name}</span>
            {expanded && (
              <>
                <div className="flex-1" />
                <div className="flex items-center gap-1 ml-1 flex-shrink-0">
                  <button
                    onClick={(e) => { e.stopPropagation(); handleViewInApp(); }}
                    className="text-[10px] px-1.5 py-0.5 rounded bg-surface-1 text-ctp-subtext0 hover:bg-surface-2 hover:text-ctp-text"
                    title="View in main window"
                  >
                    View
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); onZoom(pane.id); }}
                    className="text-[10px] px-1.5 py-0.5 rounded bg-surface-1 text-ctp-subtext0 hover:bg-surface-2 hover:text-ctp-text"
                    title={isZoomed ? 'Restore pane' : 'Zoom pane'}
                    data-testid="zoom-button"
                  >
                    {isZoomed ? 'Restore' : 'Zoom'}
                  </button>
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

      {/* Drag-over overlay */}
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

// ── Agent picker for empty panes ──────────────────────────────────────

function PopoutAgentPicker({ agents, onPick }: {
  agents: Record<string, Agent>;
  onPick: (agentId: string) => void;
}) {
  const agentList = useMemo(() => Object.values(agents), [agents]);
  const durableAgents = useMemo(() => agentList.filter((a) => a.kind === 'durable'), [agentList]);
  const quickAgents = useMemo(() => agentList.filter((a) => a.kind === 'quick' && a.status === 'running'), [agentList]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="flex flex-col items-center justify-center min-h-full p-4 text-ctp-subtext0">
        <div className="w-full max-w-xs space-y-3">
          <div className="text-xs font-medium text-ctp-subtext1 uppercase tracking-wider mb-2">
            Assign an agent
          </div>
          {durableAgents.length > 0 && (
            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-wider text-ctp-overlay0 mb-1">Durable</div>
              {durableAgents.map((a) => (
                <button
                  key={a.id}
                  onClick={(e) => { e.stopPropagation(); onPick(a.id); }}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-0 hover:bg-surface-1 text-left transition-colors"
                >
                  <AgentAvatarWithRing agent={a} />
                  <span className="text-xs text-ctp-text truncate flex-1">{a.name}</span>
                  <span className={`text-[10px] ${a.status === 'running' ? 'text-green-400' : a.status === 'error' ? 'text-red-400' : 'text-ctp-overlay0'}`}>
                    {a.status}
                  </span>
                </button>
              ))}
            </div>
          )}
          {quickAgents.length > 0 && (
            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-wider text-ctp-overlay0 mb-1">Quick</div>
              {quickAgents.map((a) => (
                <button
                  key={a.id}
                  onClick={(e) => { e.stopPropagation(); onPick(a.id); }}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-0 hover:bg-surface-1 text-left transition-colors"
                >
                  <AgentAvatarWithRing agent={a} />
                  <span className="text-xs text-ctp-text truncate flex-1">{a.name}</span>
                  <span className="text-[10px] text-green-400">running</span>
                </button>
              ))}
            </div>
          )}
          {durableAgents.length === 0 && quickAgents.length === 0 && (
            <div className="text-xs text-ctp-overlay0 text-center py-4">No agents available</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Edge split indicator ──────────────────────────────────────────────

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
