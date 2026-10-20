import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Agent } from '../../../shared/types';
import { useAgentStore } from '../../stores/agentStore';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { useRemoteProjectStore, isRemoteAgentId } from '../../stores/remoteProjectStore';
import { getOrchestratorColor, getModelColor, getOrchestratorLabel, formatModelLabel } from './orchestrator-colors';
import { AgentAvatar } from './AgentAvatar';
import { useAgentRowActions, AgentContextMenu, OverflowIcon } from './useAgentRowActions';
import { describeHelperDispose, useHelperDisposeRequestStore } from '../../stores/helperDisposeRequestStore';
import { describeHelperStarts, startRequestsFor, useHelperStartRequestStore } from '../../stores/helperStartRequestStore';
import { useAgentDetailsStore } from './details/detailsStore';

interface Props {
  agent: Agent;
  isActive: boolean;
  isThinking: boolean;
  onSelect: (agentId: string) => void;
  onSpawnQuickChild?: (agentId: string) => void;
  isNested?: boolean;
  /** Left padding in px, for rows nested deeper than one level (helpers and their quick agents). */
  indent?: number;
  /** A parent whose helpers are folded away: how many there are and how many need you or are working. */
  helperRollup?: { count: number; needs: number; working: number };
}

/**
 * The helper request waiting on the user for this agent, as the new chrome's
 * Needs you shows it: an orchestrator's held starts (#2234), or a helper's
 * dispose its orchestrator asked about (#2229).
 */
export function useHelperRequest(agentId: string, enabled: boolean): { kind: 'dispose' | 'start'; message: string } | null {
  const dispose = useHelperDisposeRequestStore((s) => (enabled ? s.requests[agentId] : undefined));
  const allStarts = useHelperStartRequestStore((s) => s.requests);
  const starts = useMemo(() => (enabled ? startRequestsFor(allStarts, agentId) : []), [allStarts, agentId, enabled]);
  if (dispose) return { kind: 'dispose', message: describeHelperDispose(dispose) };
  if (starts.length > 0) return { kind: 'start', message: describeHelperStarts(starts) };
  return null;
}

/** "2 helpers", with a dot only when one needs you or is working, as the new chrome's sidebar shows it. */
function HelperRollup({ id, count, needs, working }: { id: string; count: number; needs: number; working: number }) {
  const tone = needs > 0 ? 'bg-ctp-warning' : working > 0 ? 'bg-ctp-success' : null;
  return (
    <span id={id} data-testid="helper-rollup" className="flex-shrink-0 flex items-center gap-1 text-xs text-ctp-overlay1 whitespace-nowrap">
      {tone && <span data-testid="helper-rollup-dot" className={`w-1.5 h-1.5 rounded-full ${tone}`} aria-hidden="true" />}
      {count} helper{count === 1 ? '' : 's'}
      {needs > 0 && <span className="sr-only">, {needs} {needs === 1 ? 'needs' : 'need'} you</span>}
      {working > 0 && <span className="sr-only">, {working} working</span>}
    </span>
  );
}

import { agentDot, STATUS_TONE, statusRingColor, statusText } from './agent-status';
import { useAgentStatus } from './agent-status-store';

// Button width: 12px icon + 2*4px padding + gap ≈ 26px each
const ACTION_BUTTON_WIDTH = 26;

// ── Main component ─────────────────────────────────────────────────

function AgentListItemInner({ agent, isActive, isThinking, onSelect, onSpawnQuickChild, isNested, indent, helperRollup }: Props) {
  // Fine-grained selectors: subscribe only to the specific state/actions needed
  const isRemote = isRemoteAgentId(agent.id);

  const localDetailed = useAgentStatus(agent);
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
  // The legacy layout's Needs you: a waiting helper request takes the status line.
  const request = useHelperRequest(agent.id, !isRemote);
  const rollupId = useId();
  const reviewRequest = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onSelect(agent.id);
    if (request?.kind === 'dispose') useHelperDisposeRequestStore.getState().review(agent.id);
    else useAgentDetailsStore.getState().reveal({ agentId: agent.id, card: 'helpers' });
  }, [onSelect, agent.id, request?.kind]);

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
        aria-describedby={helperRollup ? rollupId : undefined}
        style={indent !== undefined ? { paddingLeft: indent } : undefined}
        className={`
          flex items-center gap-3 py-3.5 cursor-pointer transition-colors
          ${indent !== undefined ? 'pr-3' : isNested ? 'pl-7 pr-3' : 'px-3'}
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
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm text-ctp-text truncate font-medium block min-w-0" title={agent.name}>{agent.name}</span>
            {helperRollup && <HelperRollup id={rollupId} {...helperRollup} />}
          </div>
          <div className="flex items-center gap-1 mt-1 min-w-0">
            {(() => {
              const orchId = agent.orchestrator || 'claude-code';
              const c = getOrchestratorColor(orchId);
              return (
                <span className="text-xs px-1.5 py-0.5 rounded truncate min-w-0"
                  style={{ backgroundColor: c.bg, color: c.text }}
                  title={getOrchestratorLabel(orchId, allOrchestrators)}>
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
                <span className="text-xs px-1.5 py-0.5 rounded truncate min-w-0 font-mono"
                  style={{ backgroundColor: c.bg, color: c.text }}
                  title={modelLabel}>
                  {modelLabel}
                </span>
              );
            })()}
            {agent.freeAgentMode && (
              <span className="text-xs px-1.5 py-0.5 rounded truncate min-w-0"
                style={{ backgroundColor: 'rgb(var(--ctp-error) / 0.15)', color: 'rgb(var(--ctp-error))' }}>
                Free
              </span>
            )}
            {agent.mcpIds && agent.mcpIds.length > 0 && (
              <span className="text-xs px-1.5 py-0.5 rounded truncate min-w-0"
                style={{ backgroundColor: 'rgb(var(--ctp-accent2) / 0.15)', color: 'rgb(var(--ctp-accent2))' }}
                title={agent.mcpIds.join(', ')}>
                {agent.mcpIds.length} MCP{agent.mcpIds.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          {request ? (
            <button
              type="button"
              onClick={reviewRequest}
              title={request.message}
              className={`text-xs truncate block max-w-full mt-0.5 text-left hover:underline cursor-pointer ${STATUS_TONE.needs}`}
              data-testid="agent-helper-request"
            >
              {request.message}
            </button>
          ) : (
            <span className={`text-xs truncate block mt-0.5 ${STATUS_TONE[dot]}`} title={statusLabel}>
              {statusLabel}
            </span>
          )}
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
