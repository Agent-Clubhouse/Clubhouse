import { useCallback, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { Agent } from '../../../shared/types';
import { DISPATCHER_PROJECT_ID } from '../../../shared/dispatcher-types';
import { useAgentStore } from '../../stores/agentStore';
import { isDispatcherAgent, useLocalProject, visibleDispatcherAgentId } from '../dispatcher/dispatcherStore';
import { openDispatcherSettings, openDispatcherSetup } from '../dispatcher/dispatcherNav';
import { requestClearChat, requestStartFresh } from '../dispatcher/ClearChat';
import { useAnnexClientStore } from '../../stores/annexClientStore';
import { isRemoteAgentId, parseNamespacedId } from '../../stores/remoteProjectStore';
import { wakeDurableAgent, type WakeMode } from './wake-durable-agent';
import { useManagedStatus } from '../managed/managedApi';
import { requestManagedRestart } from '../managed/restart';
import { openAgentSettingsOn } from './agentSettingsPages';

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
  const sendAgentWake = useAnnexClientStore((s) => s.sendAgentWake);
  const sendAgentKill = useAnnexClientStore((s) => s.sendAgentKill);
  // The agent's own project: the new chrome's tree shows rows from every project.
  // The Dispatcher (#2538) runs in its own folder, in no project.
  const activeProject = useLocalProject(agent.projectId);
  const isDispatcher = isDispatcherAgent(agent);

  const isCreating = agent.status === 'creating';
  const isDurable = agent.kind === 'durable';

  // Clubhouse-managed agents (#2896): a running one can restart onto its current setup.
  const managedEligible = isDurable && !isRemote && agent.status === 'running' && !!activeProject;
  const { value: managedStatus } = useManagedStatus(managedEligible ? activeProject?.path : undefined, managedEligible ? agent.id : undefined);
  const canRestartManaged = managedEligible && !!managedStatus?.managed && managedStatus.running;

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
      // Only ask to resume what the satellite says it has; older satellites
      // don't say, so their default Wake starts fresh as it used to.
      await sendAgentWake(remoteParts.satelliteId, remoteParts.agentId, mode === 'resume' && agent.hasSession === true ? { resume: true } : undefined);
      return;
    }
    if (!activeProject) return;
    await wakeDurableAgent(activeProject.id, activeProject.path, agent.id, mode);
  }, [activeProject, agent.status, agent.id, agent.hasSession, isRemote, remoteParts, sendAgentWake]);
  const handleWake = useCallback(() => { void wake('resume'); }, [wake]);
  const handleWakeNewSession = useCallback(() => { void wake('new'); }, [wake]);

  const handleDelete = useCallback(() => {
    openDeleteDialog(agent.id);
  }, [agent.id, openDeleteDialog]);

  const handlePopOut = useCallback(async () => {
    // The Dispatcher pops out its chat (#3235), the same conversation, under its
    // synthetic project; the popout finds its folder through the Dispatcher's state.
    if (isDispatcher) {
      await window.clubhouse.window.createPopout({
        type: 'agent',
        agentId: visibleDispatcherAgentId() ?? agent.id,
        projectId: DISPATCHER_PROJECT_ID,
        title: agent.name,
      });
      return;
    }
    await window.clubhouse.window.createPopout({
      type: 'agent',
      agentId: agent.id,
      projectId: agent.projectId,
      title: `Agent — ${agent.name}`,
    });
  }, [agent.id, agent.projectId, agent.name, isDispatcher]);

  const handleSettings = useCallback(() => {
    // The Dispatcher's settings are a page of app Settings, not the agent settings view.
    if (isDispatcher) openDispatcherSettings();
    else openAgentSettings(agent.id);
  }, [agent.id, openAgentSettings, isDispatcher]);
  const handleChangeCli = useCallback(() => openAgentSettingsOn(agent.id, 'runtime'), [agent.id]);

  const handleClearChat = useCallback(() => requestClearChat(agent.name), [agent.name]);
  const handleStartFresh = useCallback(() => requestStartFresh(agent.name), [agent.name]);
  const handleSetUp = useCallback(() => openDispatcherSetup(), []);

  const restartManaged = useCallback((fresh: boolean) => {
    if (!activeProject) return;
    void requestManagedRestart({ projectPath: activeProject.path, agentId: agent.id, agentName: agent.name }, { fresh });
  }, [activeProject, agent.id, agent.name]);
  const handleRestart = useCallback(() => restartManaged(false), [restartManaged]);
  const handleRestartFresh = useCallback(() => restartManaged(true), [restartManaged]);

  const handleSpawnChild = useCallback(() => {
    if (onSpawnQuickChild) onSpawnQuickChild(agent.id);
  }, [agent.id, onSpawnQuickChild]);

  // ── Build ordered action list (highest priority first) ─────────

  const actions: ActionDef[] = useMemo(() => {
    const list: ActionDef[] = [];

    // No actions while agent is being created
    if (isCreating) return list;

    if (isDurable && agent.status === 'error' && !agent.creationFailed && !isRemote && !isDispatcher) {
      list.push({
        id: 'change-cli',
        label: 'Change CLI',
        icon: <span aria-hidden="true">{'\u21C4'}</span>,
        hoverColor: 'hover:text-ctp-accent',
        visible: true,
        handler: handleChangeCli,
      });
    }

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

    // Its setup (#3047): name, look, Behavior and personality, opened again in its view.
    if (isDispatcher && !isRemote) {
      list.push({
        id: 'dispatcher-setup',
        label: 'Set up…',
        icon: (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
          </svg>
        ),
        hoverColor: 'hover:text-ctp-accent',
        visible: true,
        handler: handleSetUp,
      });
    }

    // Priority 4: Clear chat (#3043). The Dispatcher's conversation starts over; its memory stays.
    if (isDispatcher && !isRemote) {
      list.push({
        id: 'clear-chat',
        label: 'Clear chat',
        icon: (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            <path d="M9 9l6 6" />
            <path d="M15 9l-6 6" />
          </svg>
        ),
        hoverColor: 'hover:text-ctp-accent',
        visible: true,
        handler: handleClearChat,
      });
      // Start fresh (#3240): its work conversation, or both, when the work keeps failing.
      list.push({
        id: 'start-fresh',
        label: 'Start fresh',
        icon: (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12a9 9 0 1 0 2.64-6.36" />
            <polyline points="3 3 3 9 9 9" />
          </svg>
        ),
        hoverColor: 'hover:text-ctp-accent',
        visible: true,
        handler: handleStartFresh,
      });
    }

    // Priority 4a: Restart a running managed agent, resuming its conversation or starting a new one.
    if (canRestartManaged) {
      const restartIcon = (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12a9 9 0 1 1-2.64-6.36" />
          <polyline points="21 3 21 9 15 9" />
        </svg>
      );
      list.push({
        id: 'restart',
        label: 'Restart',
        icon: restartIcon,
        hoverColor: 'hover:text-ctp-accent',
        visible: true,
        handler: handleRestart,
      });
      list.push({
        id: 'restart-fresh',
        label: 'Restart with a new conversation',
        icon: restartIcon,
        hoverColor: 'hover:text-ctp-accent',
        visible: true,
        handler: handleRestartFresh,
      });
    }

    // Priority 5: Delete / Remove (lowest — collapses first). The Dispatcher
    // can't be deleted; turning it off in Settings is how it goes away.
    if (isDurable && agent.status !== 'running' && !isDispatcher) {
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
  }, [agent.status, agent.kind, agent.creationFailed, isDurable, isRemote, isDispatcher, isCreating, onSpawnQuickChild, handleStopOrRemove, handleWake, handleWakeNewSession, handlePopOut, handleSpawnChild, handleSettings, handleChangeCli, handleClearChat, handleStartFresh, handleSetUp, canRestartManaged, handleRestart, handleRestartFresh, handleDelete]);

  return actions;
}
