import { useCallback, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { Agent } from '../../../shared/types';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { useAnnexClientStore } from '../../stores/annexClientStore';
import { isRemoteAgentId, parseNamespacedId } from '../../stores/remoteProjectStore';
import { wakeDurableAgent, type WakeMode } from './wake-durable-agent';

/**
 * The agent row's actions, shared by the legacy list row and the new chrome's
 * 30px row (docs/chrome-redesign-spec.md §4.3), so both offer the same
 * right-click menu with the same `ctx-<id>` / `action-<id>` test ids.
 */

// ── Action definitions ─────────────────────────────────────────────

export interface ActionDef {
  id: string;
  label: string;
  icon: React.ReactNode;
  hoverColor: string;
  visible: boolean;
  handler: (e?: React.MouseEvent) => void;
}

// ── Pop-out icon (external-link style) ─────────────────────────────

export function PopOutIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

// ── Overflow icon (three dots) ─────────────────────────────────────

export function OverflowIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="5" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="12" cy="19" r="2" />
    </svg>
  );
}

// ── Context menu component ─────────────────────────────────────────

export function AgentContextMenu({ actions, position, onClose }: {
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

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-dropdown min-w-[160px] py-1 rounded-lg shadow-xl border border-surface-1 bg-ctp-mantle"
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
    </div>,
    document.body,
  );
}

// ── Hook ───────────────────────────────────────────────────────────

export function useAgentRowActions(agent: Agent, { onSpawnQuickChild }: { onSpawnQuickChild?: (agentId: string) => void } = {}): ActionDef[] {
  const isRemote = isRemoteAgentId(agent.id);
  const remoteParts = useMemo(() => isRemote ? parseNamespacedId(agent.id) : null, [agent.id, isRemote]);

  const killAgent = useAgentStore((s) => s.killAgent);
  const removeAgent = useAgentStore((s) => s.removeAgent);
  const openAgentSettings = useAgentStore((s) => s.openAgentSettings);
  const openDeleteDialog = useAgentStore((s) => s.openDeleteDialog);
  const openApplyPersonaDialog = useAgentStore((s) => s.openApplyPersonaDialog);
  const openExtractPersonaDialog = useAgentStore((s) => s.openExtractPersonaDialog);
  const sendAgentWake = useAnnexClientStore((s) => s.sendAgentWake);
  const sendAgentKill = useAnnexClientStore((s) => s.sendAgentKill);
  // The agent's own project: the new chrome's tree shows rows from every project.
  const activeProject = useProjectStore((s) => s.projects.find((p) => p.id === agent.projectId));

  const isCreating = agent.status === 'creating';
  const isDurable = agent.kind === 'durable';

  // ── Action handlers ────────────────────────────────────────────

  const handleStopOrRemove = useCallback(async () => {
    if (agent.status === 'running') {
      if (isRemote && remoteParts) {
        await sendAgentKill(remoteParts.satelliteId, remoteParts.agentId);
      } else {
        await killAgent(agent.id);
      }
    } else if (agent.kind === 'quick') {
      removeAgent(agent.id);
    }
  }, [agent.status, agent.kind, agent.id, killAgent, removeAgent, isRemote, remoteParts, sendAgentKill]);

  const wake = useCallback(async (mode: WakeMode) => {
    if (agent.status === 'running') return;
    if (isRemote && remoteParts) {
      await sendAgentWake(remoteParts.satelliteId, remoteParts.agentId, mode === 'resume' ? { resume: true } : undefined);
      return;
    }
    if (!activeProject) return;
    await wakeDurableAgent(activeProject.id, activeProject.path, agent.id, mode);
  }, [activeProject, agent.status, agent.id, isRemote, remoteParts, sendAgentWake]);
  const handleWake = useCallback(() => { void wake('resume'); }, [wake]);
  const handleWakeNewSession = useCallback(() => { void wake('new'); }, [wake]);

  const handleDelete = useCallback(() => {
    openDeleteDialog(agent.id);
  }, [agent.id, openDeleteDialog]);

  const handleApplyPersona = useCallback(() => {
    openApplyPersonaDialog(agent.id);
  }, [agent.id, openApplyPersonaDialog]);

  const handleExtractPersona = useCallback(() => {
    openExtractPersonaDialog(agent.id);
  }, [agent.id, openExtractPersonaDialog]);

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
    if (onSpawnQuickChild) onSpawnQuickChild(agent.id);
  }, [agent.id, onSpawnQuickChild]);

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
        hoverColor: 'hover:text-status-warning',
        visible: true,
        handler: handleStopOrRemove,
      });
    } else if (isDurable && agent.status === 'sleeping') {
      list.push({
        id: 'wake',
        label: 'Wake & Resume',
        icon: <span>{'\u25B6'}</span>,
        hoverColor: 'hover:text-ctp-success',
        visible: true,
        handler: handleWake,
      });
      list.push({
        id: 'wake-new',
        label: 'Start New Session',
        icon: (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14" />
            <path d="M5 12h14" />
          </svg>
        ),
        hoverColor: 'hover:text-ctp-success',
        visible: true,
        handler: handleWakeNewSession,
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
        hoverColor: 'hover:text-status-warning',
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
        hoverColor: 'hover:text-ctp-accent',
        visible: true,
        handler: handleSettings,
      });
    }

    // Priority 4b: Apply persona / Extract pattern (local durable agents)
    if (isDurable && !isRemote) {
      list.push({
        id: 'apply-persona',
        label: 'Apply persona…',
        icon: (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <line x1="19" y1="8" x2="19" y2="14" />
            <line x1="22" y1="11" x2="16" y2="11" />
          </svg>
        ),
        hoverColor: 'hover:text-ctp-accent',
        visible: true,
        handler: handleApplyPersona,
      });
      list.push({
        id: 'extract-persona',
        label: 'Extract persona…',
        icon: (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        ),
        hoverColor: 'hover:text-ctp-accent',
        visible: true,
        handler: handleExtractPersona,
      });
    }

    // Priority 5: Delete / Remove (lowest — collapses first)
    if (isDurable && agent.status !== 'running') {
      list.push({
        id: 'delete',
        label: 'Delete',
        icon: <span>{'\u2715'}</span>,
        hoverColor: 'hover:text-ctp-error',
        visible: true,
        handler: handleDelete,
      });
    } else if (!isDurable && agent.status !== 'running') {
      list.push({
        id: 'remove',
        label: 'Remove',
        icon: <span>{'\u2715'}</span>,
        hoverColor: 'hover:text-ctp-error',
        visible: true,
        handler: handleStopOrRemove,
      });
    }

    return list;
  }, [agent.status, agent.kind, isDurable, isRemote, isCreating, onSpawnQuickChild, handleStopOrRemove, handleWake, handleWakeNewSession, handlePopOut, handleSpawnChild, handleSettings, handleDelete, handleApplyPersona, handleExtractPersona]);

  return actions;
}
