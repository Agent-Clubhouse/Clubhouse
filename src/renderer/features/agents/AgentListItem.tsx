import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Agent } from '../../../shared/types';
import { useAgentStore } from '../../stores/agentStore';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { useRemoteProjectStore, isRemoteAgentId } from '../../stores/remoteProjectStore';
import { getOrchestratorColor, getModelColor, getOrchestratorLabel, formatModelLabel } from './orchestrator-colors';
import { AgentAvatar } from './AgentAvatar';
import { useAgentRowActions, AgentContextMenu, OverflowIcon } from './useAgentRowActions';

interface Props {
  agent: Agent;
  isActive: boolean;
  isThinking: boolean;
  onSelect: (agentId: string) => void;
  onSpawnQuickChild?: (agentId: string) => void;
  isNested?: boolean;
}

import { agentDot, STATUS_TONE, statusRingColor, statusText } from './agent-status';

// Button width: 12px icon + 2*4px padding + gap ≈ 26px each
const ACTION_BUTTON_WIDTH = 26;

// ── Main component ─────────────────────────────────────────────────

function AgentListItemInner({ agent, isActive, isThinking, onSelect, onSpawnQuickChild, isNested }: Props) {
  // Fine-grained selectors: subscribe only to the specific state/actions needed
  const isRemote = isRemoteAgentId(agent.id);

  const localDetailed = useAgentStore((s) => s.agentDetailedStatus[agent.id]);
  const remoteDetailed = useRemoteProjectStore((s) => s.remoteAgentDetailedStatus[agent.id]);
  const detailed = isRemote ? remoteDetailed : localDetailed;
  const localIconDataUrl = useAgentStore((s) => s.agentIcons[agent.id]);
  const remoteIconDataUrl = useRemoteProjectStore((s) => s.remoteAgentIcons[agent.id]);
  const iconDataUrl = isRemote ? remoteIconDataUrl : localIconDataUrl;
  const allOrchestrators = useOrchestratorStore((s) => s.allOrchestrators);

  const ringColor = statusRingColor(agent, detailed);

  // Without hook status, the list's own thinking signal still counts as working.
  const baseDot = agentDot(agent, detailed);
  const dot = baseDot === 'idle' && !detailed && isThinking ? 'working' : baseDot;
  const isWorking = dot === 'working' || dot === 'starting';
  const statusLabel = statusText(agent, detailed, dot);

  const actions = useAgentRowActions(agent, { onSpawnQuickChild });

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
        onClick={() => onSelect(agent.id)}
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
          <AgentAvatar agent={agent} size="md" showRing ringColor={ringColor} iconUrl={iconDataUrl} />
          {/* Free Agent Mode badge */}
          {agent.freeAgentMode && (
            <div
              className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full bg-ctp-error flex items-center justify-center ring-2 ring-ctp-base z-20"
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
                <span className="text-xs px-1.5 py-0.5 rounded truncate"
                  style={{ backgroundColor: c.bg, color: c.text }}>
                  {getOrchestratorLabel(orchId, allOrchestrators)}
                </span>
              );
            })()}
            {(() => {
              const modelLabel = formatModelLabel(agent.model);
              const c = agent.model && agent.model !== 'default'
                ? getModelColor(agent.model)
                : { bg: 'rgb(var(--ctp-overlay1) / 0.15)', text: 'rgb(var(--ctp-overlay1))' };
              return (
                <span className="text-xs px-1.5 py-0.5 rounded truncate font-mono"
                  style={{ backgroundColor: c.bg, color: c.text }}>
                  {modelLabel}
                </span>
              );
            })()}
            {agent.freeAgentMode && (
              <span className="text-xs px-1.5 py-0.5 rounded truncate"
                style={{ backgroundColor: 'rgb(var(--ctp-error) / 0.15)', color: 'rgb(var(--ctp-error))' }}>
                Free
              </span>
            )}
            {agent.mcpIds && agent.mcpIds.length > 0 && (
              <span className="text-xs px-1.5 py-0.5 rounded truncate"
                style={{ backgroundColor: 'rgb(var(--ctp-accent2) / 0.15)', color: 'rgb(var(--ctp-accent2))' }}
                title={agent.mcpIds.join(', ')}>
                {agent.mcpIds.length} MCP{agent.mcpIds.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          <span className={`text-xs truncate block mt-0.5 ${
            STATUS_TONE[dot]
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
        <AgentContextMenu
          actions={actions}
          position={contextMenu}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Overflow menu — only hidden actions */}
      {overflowMenu && (
        <AgentContextMenu
          actions={overflowActions}
          position={overflowMenu}
          onClose={() => setOverflowMenu(null)}
        />
      )}
    </>
  );
}

export const AgentListItem = memo(AgentListItemInner);
