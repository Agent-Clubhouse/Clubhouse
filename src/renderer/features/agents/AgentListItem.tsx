import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Agent } from '../../../shared/types';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { AGENT_COLORS } from '../../../shared/name-generator';
import { getOrchestratorColor, getModelColor, getOrchestratorLabel, formatModelLabel } from './orchestrator-colors';

interface Props {
  agent: Agent;
  isActive: boolean;
  isThinking: boolean;
  onSelect: () => void;
  onSpawnQuickChild?: () => void;
  isNested?: boolean;
}

const STATUS_CONFIG: Record<string, { label: string }> = {
  running: { label: 'Running' },
  sleeping: { label: 'Sleeping' },
  creating: { label: 'Setting up worktree…' },
  error: { label: 'Error' },
};

const STATUS_RING_COLOR: Record<string, string> = {
  running: '#22c55e',
  sleeping: '#6c7086',
  creating: '#818cf8',
  error: '#f87171',
};

// ── Action definitions ─────────────────────────────────────────────

interface ActionDef {
  id: string;
  label: string;
  icon: React.ReactNode;
  hoverColor: string;
  visible: boolean;
  handler: (e?: React.MouseEvent) => void;
}

// Button width: 12px icon + 2*4px padding + gap ≈ 26px each
const ACTION_BUTTON_WIDTH = 26;

// ── Pop-out icon (external-link style) ─────────────────────────────

function PopOutIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

// ── Overflow icon (three dots) ─────────────────────────────────────

function OverflowIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="5" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="12" cy="19" r="2" />
    </svg>
  );
}

// ── Context menu component ─────────────────────────────────────────

function ContextMenu({ actions, position, onClose }: {
  actions: ActionDef[];
  position: { x: number; y: number };
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  // Adjust position to stay within viewport
  const style = useMemo(() => {
    const menuWidth = 160;
    const menuHeight = actions.length * 32 + 8;
    const x = Math.min(position.x, window.innerWidth - menuWidth - 8);
    const y = Math.min(position.y, window.innerHeight - menuHeight - 8);
    return { left: x, top: y };
  }, [position, actions.length]);

  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[160px] py-1 rounded-lg shadow-xl border border-surface-1 bg-ctp-mantle"
      style={style}
      data-testid="agent-context-menu"
    >
      {actions.map((action) => (
        <button
          key={action.id}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-ctp-subtext0 hover:bg-surface-1 hover:text-ctp-text transition-colors cursor-pointer"
          onClick={(e) => { e.stopPropagation(); action.handler(e); onClose(); }}
          data-testid={`ctx-${action.id}`}
        >
          <span className="flex-shrink-0">{action.icon}</span>
          <span>{action.label}</span>
        </button>
      ))}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────

export function AgentListItem({ agent, isActive, isThinking, onSelect, onSpawnQuickChild, isNested }: Props) {
  const { killAgent, removeAgent, spawnDurableAgent, openAgentSettings, openDeleteDialog, agentDetailedStatus, agentIcons } = useAgentStore();
  const iconDataUrl = agentIcons[agent.id];
  const { projects, activeProjectId } = useProjectStore();
  const activeProject = projects.find((p) => p.id === activeProjectId);
  const allOrchestrators = useOrchestratorStore((s) => s.allOrchestrators);

  const colorInfo = AGENT_COLORS.find((c) => c.id === agent.color);
  const statusInfo = STATUS_CONFIG[agent.status] || STATUS_CONFIG.sleeping;
  const detailed = agentDetailedStatus[agent.id];
  const baseRingColor = STATUS_RING_COLOR[agent.status] || STATUS_RING_COLOR.sleeping;
  const ringColor = agent.status === 'running' && detailed?.state === 'needs_permission' ? '#f97316'
    : agent.status === 'running' && detailed?.state === 'tool_error' ? '#facc15'
    : baseRingColor;

  const isCreating = agent.status === 'creating';
  const hasDetailed = agent.status === 'running' && detailed;
  const isWorking = isCreating || (hasDetailed ? detailed.state === 'working' : isThinking);
  const statusLabel = hasDetailed ? detailed.message : (isThinking ? 'Thinking...' : statusInfo.label);

  const isDurable = agent.kind === 'durable';

  // ── Action handlers ────────────────────────────────────────────

  const handleStopOrRemove = useCallback(async () => {
    if (agent.status === 'running') {
      await killAgent(agent.id);
    } else if (agent.kind === 'quick') {
      removeAgent(agent.id);
    }
  }, [agent.status, agent.kind, agent.id, killAgent, removeAgent]);

  const handleWake = useCallback(async () => {
    if (!activeProject || agent.status === 'running') return;
    const configs = await window.clubhouse.agent.listDurable(activeProject.path);
    const config = configs.find((c: any) => c.id === agent.id);
    if (config) {
      await spawnDurableAgent(activeProject.id, activeProject.path, config, true);
    }
  }, [activeProject, agent.status, agent.id, spawnDurableAgent]);

  const handleDelete = useCallback(() => {
    openDeleteDialog(agent.id);
  }, [agent.id, openDeleteDialog]);

  const handlePopOut = useCallback(async () => {
    await window.clubhouse.window.createPopout({
      type: 'agent',
      agentId: agent.id,
      projectId: agent.projectId,
      title: `Agent — ${agent.name}`,
    });
  }, [agent.id, agent.projectId, agent.name]);

  const handleSettings = useCallback(() => {
    openAgentSettings(agent.id);
  }, [agent.id, openAgentSettings]);

  const handleSpawnChild = useCallback(() => {
    if (onSpawnQuickChild) onSpawnQuickChild();
  }, [onSpawnQuickChild]);

  // ── Build ordered action list (highest priority first) ─────────

  const actions: ActionDef[] = useMemo(() => {
    const list: ActionDef[] = [];

    // No actions while agent is being created
    if (isCreating) return list;

    // Priority 1: Start/Stop (highest — collapses last)
    if (agent.status === 'running') {
      list.push({
        id: 'stop',
        label: 'Stop',
        icon: <span>{'\u25A0'}</span>,
        hoverColor: 'hover:text-yellow-400',
        visible: true,
        handler: handleStopOrRemove,
      });
    } else if (isDurable && agent.status === 'sleeping') {
      list.push({
        id: 'wake',
        label: 'Wake',
        icon: <span>{'\u25B6'}</span>,
        hoverColor: 'hover:text-green-400',
        visible: true,
        handler: handleWake,
      });
    }

    // Priority 2: Pop Out
    list.push({
      id: 'popout',
      label: 'Pop Out',
      icon: <PopOutIcon />,
      hoverColor: 'hover:text-ctp-text',
      visible: true,
      handler: handlePopOut,
    });

    // Priority 3: Quick Agent
    if (isDurable && onSpawnQuickChild) {
      list.push({
        id: 'spawn',
        label: 'Quick Agent',
        icon: (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
          </svg>
        ),
        hoverColor: 'hover:text-yellow-400',
        visible: true,
        handler: handleSpawnChild,
      });
    }

    // Priority 4: Settings
    if (isDurable) {
      list.push({
        id: 'settings',
        label: 'Settings',
        icon: (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        ),
        hoverColor: 'hover:text-ctp-blue',
        visible: true,
        handler: handleSettings,
      });
    }

    // Priority 5: Delete / Remove (lowest — collapses first)
    if (isDurable && agent.status !== 'running') {
      list.push({
        id: 'delete',
        label: 'Delete',
        icon: <span>{'\u2715'}</span>,
        hoverColor: 'hover:text-red-400',
        visible: true,
        handler: handleDelete,
      });
    } else if (!isDurable && agent.status !== 'running') {
      list.push({
        id: 'remove',
        label: 'Remove',
        icon: <span>{'\u2715'}</span>,
        hoverColor: 'hover:text-red-400',
        visible: true,
        handler: handleStopOrRemove,
      });
    }

    return list;
  }, [agent.status, agent.kind, isDurable, isCreating, onSpawnQuickChild, handleStopOrRemove, handleWake, handlePopOut, handleSpawnChild, handleSettings, handleDelete]);

  // ── Responsive action collapse ─────────────────────────────────

  const actionsRef = useRef<HTMLDivElement>(null);
  const [maxVisible, setMaxVisible] = useState(actions.length);

  useEffect(() => {
    const el = actionsRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.contentRect.width;
        const fitCount = Math.floor(width / ACTION_BUTTON_WIDTH);
        setMaxVisible(fitCount);
      }
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const visibleActions = actions.slice(0, maxVisible >= actions.length ? actions.length : Math.max(0, maxVisible - 1));
  const overflowActions = actions.slice(visibleActions.length);
  const hasOverflow = overflowActions.length > 0;

  // ── Context menu state ─────────────────────────────────────────

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [overflowMenu, setOverflowMenu] = useState<{ x: number; y: number } | null>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const handleOverflowClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setOverflowMenu({ x: rect.right, y: rect.top });
  }, []);

  return (
    <>
      <div
        onClick={onSelect}
        onContextMenu={handleContextMenu}
        data-testid={`agent-item-${agent.id}`}
        data-agent-name={agent.name}
        data-active={isActive}
        className={`
          flex items-center gap-3 py-3.5 cursor-pointer transition-colors
          ${isNested ? 'pl-7 pr-3' : 'px-3'}
          ${isActive ? 'bg-surface-1' : 'hover:bg-surface-0'}
        `}
      >
        {/* Avatar with status ring */}
        <div className={`relative flex-shrink-0 ${isWorking ? 'animate-pulse-ring' : ''}`}>
          <div
            className="w-9 h-9 rounded-full flex items-center justify-center"
            style={{ border: `2px solid ${ringColor}` }}
          >
            {isDurable ? (
              agent.icon && iconDataUrl ? (
                <div className="w-7 h-7 rounded-full overflow-hidden flex-shrink-0">
                  <img src={iconDataUrl} alt={agent.name} className="w-full h-full object-cover" />
                </div>
              ) : (
                <div
                  className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold text-white"
                  style={{ backgroundColor: colorInfo?.hex || '#6366f1' }}
                >
                  {agent.name.split('-').map((w) => w[0]).join('').toUpperCase().slice(0, 2)}
                </div>
              )
            ) : (
              <div className="w-7 h-7 rounded-full flex items-center justify-center bg-surface-2 text-ctp-subtext0">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                </svg>
              </div>
            )}
          </div>
          {/* Free Agent Mode badge */}
          {agent.freeAgentMode && (
            <div
              className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full bg-red-500 flex items-center justify-center ring-2 ring-ctp-base z-20"
              title="Free Agent Mode — all permissions bypassed"
            >
              <span className="text-[9px] font-bold text-white leading-none">!</span>
            </div>
          )}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <span className="text-sm text-ctp-text truncate font-medium block">{agent.name}</span>
          <div className="flex items-center gap-1 mt-1">
            {(() => {
              const orchId = agent.orchestrator || 'claude-code';
              const c = getOrchestratorColor(orchId);
              return (
                <span className="text-[10px] px-1.5 py-0.5 rounded truncate"
                  style={{ backgroundColor: c.bg, color: c.text }}>
                  {getOrchestratorLabel(orchId, allOrchestrators)}
                </span>
              );
            })()}
            {(() => {
              const modelLabel = formatModelLabel(agent.model);
              const c = agent.model && agent.model !== 'default'
                ? getModelColor(agent.model)
                : { bg: 'rgba(148,163,184,0.15)', text: '#94a3b8' };
              return (
                <span className="text-[10px] px-1.5 py-0.5 rounded truncate font-mono"
                  style={{ backgroundColor: c.bg, color: c.text }}>
                  {modelLabel}
                </span>
              );
            })()}
            {agent.freeAgentMode && (
              <span className="text-[10px] px-1.5 py-0.5 rounded truncate"
                style={{ backgroundColor: 'rgba(239,68,68,0.15)', color: '#f87171' }}>
                Free
              </span>
            )}
          </div>
          <span className={`text-xs truncate block mt-0.5 ${
            hasDetailed && detailed.state === 'needs_permission' ? 'text-orange-400' :
            hasDetailed && detailed.state === 'tool_error' ? 'text-red-400' :
            'text-ctp-subtext0'
          }`}>
            {statusLabel}
          </span>
        </div>

        {/* Actions — responsive */}
        <div ref={actionsRef} className="flex items-center gap-1 flex-shrink-0" data-testid="agent-actions">
          {visibleActions.map((action) => (
            <button
              key={action.id}
              onClick={(e) => { e.stopPropagation(); action.handler(e); }}
              title={action.label}
              className={`text-xs text-ctp-subtext0 ${action.hoverColor} transition-colors px-1 cursor-pointer`}
              data-testid={`action-${action.id}`}
            >
              {action.icon}
            </button>
          ))}
          {hasOverflow && (
            <button
              onClick={handleOverflowClick}
              title="More actions"
              className="text-xs text-ctp-subtext0 hover:text-ctp-text transition-colors px-1 cursor-pointer"
              data-testid="action-overflow"
            >
              <OverflowIcon />
            </button>
          )}
        </div>
      </div>

      {/* Right-click context menu — all actions */}
      {contextMenu && (
        <ContextMenu
          actions={actions}
          position={contextMenu}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Overflow menu — only hidden actions */}
      {overflowMenu && (
        <ContextMenu
          actions={overflowActions}
          position={overflowMenu}
          onClose={() => setOverflowMenu(null)}
        />
      )}
    </>
  );
}
