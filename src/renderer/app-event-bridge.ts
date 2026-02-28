/**
 * App Event Bridge — non-rendering IPC & event listener registration.
 *
 * This module extracts all event handlers out of App.tsx so they no longer
 * create Zustand subscriptions inside the React render cycle.  Every store
 * access goes through `getState()` / `subscribe()` which means state changes
 * in these handlers never trigger re-renders of the root component.
 *
 * Call `initAppEventBridge()` once on mount and invoke the returned cleanup
 * function on unmount.
 */

import { useAgentStore, consumeCancelled } from './stores/agentStore';
import { useProjectStore } from './stores/projectStore';
import { useUIStore } from './stores/uiStore';
import { useNotificationStore } from './stores/notificationStore';
import { useQuickAgentStore } from './stores/quickAgentStore';
import { useClubhouseModeStore } from './stores/clubhouseModeStore';
import { useCommandPaletteStore } from './stores/commandPaletteStore';
import { useKeyboardShortcutsStore, eventToBinding } from './stores/keyboardShortcutsStore';
import { getCommandActions } from './features/command-palette/command-actions';
import { pluginHotkeyRegistry } from './plugins/plugin-hotkeys';
import { pluginEventBus } from './plugins/plugin-events';
import { getProjectHubStore, useAppHubStore } from './plugins/builtin/hub/main';
import { applyHubMutation } from './plugins/builtin/hub/hub-sync';
import type { AgentHookEvent, AgentStatus, HubMutation } from '../shared/types';

// ─── IPC Listener Setup ─────────────────────────────────────────────────────

function initWindowListeners(): (() => void)[] {
  const removers: (() => void)[] = [];

  // Open Settings from menu
  removers.push(
    window.clubhouse.app.onOpenSettings(() => {
      useUIStore.getState().toggleSettings();
    }),
  );

  // Open About from menu
  removers.push(
    window.clubhouse.app.onOpenAbout(() => {
      const state = useUIStore.getState();
      if (state.explorerTab !== 'settings') {
        state.openAbout();
      } else {
        state.setSettingsSubPage('about');
      }
    }),
  );

  // Navigate to agent when notification is clicked
  removers.push(
    window.clubhouse.app.onNotificationClicked((agentId: string, projectId: string) => {
      useProjectStore.getState().setActiveProject(projectId);
      useUIStore.getState().setExplorerTab('agents', projectId);
      useAgentStore.getState().setActiveAgent(agentId, projectId);
    }),
  );

  // Respond to agent state requests from pop-out windows
  removers.push(
    window.clubhouse.window.onRequestAgentState((requestId: string) => {
      const state = useAgentStore.getState();
      window.clubhouse.window.respondAgentState(requestId, {
        agents: state.agents,
        agentDetailedStatus: state.agentDetailedStatus,
        agentIcons: state.agentIcons,
      });
    }),
  );

  // Respond to hub state requests from pop-out windows
  removers.push(
    window.clubhouse.window.onRequestHubState(
      (requestId: string, hubId: string, scope: string, projectId?: string) => {
        const store = scope === 'global' ? useAppHubStore : getProjectHubStore(projectId ?? null);
        const state = store.getState();
        const hub = state.hubs.find((h) => h.id === hubId);
        if (hub) {
          window.clubhouse.window.respondHubState(requestId, {
            hubId: hub.id,
            paneTree: hub.paneTree,
            focusedPaneId: hub.focusedPaneId,
            zoomedPaneId: hub.zoomedPaneId,
          });
        } else {
          window.clubhouse.window.respondHubState(requestId, null);
        }
      },
    ),
  );

  // Apply hub mutations forwarded from pop-out windows
  removers.push(
    window.clubhouse.window.onHubMutation(
      (hubId: string, scope: string, mutation: unknown, projectId?: string) => {
        const store = scope === 'global' ? useAppHubStore : getProjectHubStore(projectId ?? null);
        applyHubMutation(store, hubId, mutation as HubMutation);
      },
    ),
  );

  // Navigate to agent when requested from a pop-out window
  removers.push(
    window.clubhouse.window.onNavigateToAgent((agentId: string) => {
      const agent = useAgentStore.getState().agents[agentId];
      if (agent) {
        useProjectStore.getState().setActiveProject(agent.projectId);
        useUIStore.getState().setExplorerTab('agents', agent.projectId);
        useAgentStore.getState().setActiveAgent(agentId, agent.projectId);
      }
    }),
  );

  return removers;
}

// ─── Agent Lifecycle Listeners ──────────────────────────────────────────────

function initPtyExitListener(): () => void {
  const removeExitListener = window.clubhouse.pty.onExit(
    async (agentId: string, exitCode: number, lastOutput?: string) => {
      const agent = useAgentStore.getState().agents[agentId];
      useAgentStore.getState().updateAgentStatus(agentId, 'sleeping' as AgentStatus, exitCode, undefined, lastOutput);

      // Handle quick agent completion FIRST (before plugin events which could throw)
      if (agent?.kind === 'quick' && agent.mission) {
        let summary: string | null = null;
        let filesModified: string[] = [];
        let costUsd: number | undefined;
        let durationMs: number | undefined;
        let toolsUsed: string[] | undefined;

        if (agent.headless) {
          // Headless agents: read enriched data from transcript
          try {
            const transcript = await window.clubhouse.agent.readTranscript(agentId);
            if (transcript) {
              // Parse transcript events to extract summary data
              const events = transcript.split('\n')
                .filter((line: string) => line.trim())
                .map((line: string) => {
                  try { return JSON.parse(line); } catch { return null; }
                })
                .filter(Boolean);

              // Extract data from transcript events (--verbose format)
              let lastAssistantText = '';
              const tools = new Set<string>();

              for (const evt of events) {
                // Result event: summary, cost, duration
                if (evt.type === 'result') {
                  if (typeof evt.result === 'string' && evt.result) {
                    summary = evt.result;
                  }
                  if (evt.total_cost_usd != null) costUsd = evt.total_cost_usd;
                  else if (evt.cost_usd != null) costUsd = evt.cost_usd;
                  if (evt.duration_ms != null) durationMs = evt.duration_ms;
                }

                // --verbose: assistant messages contain text and tool_use blocks
                if (evt.type === 'assistant' && evt.message?.content) {
                  for (const block of evt.message.content) {
                    if (block.type === 'text' && block.text) {
                      lastAssistantText = block.text;
                    }
                    if (block.type === 'tool_use' && block.name) {
                      tools.add(block.name);
                    }
                  }
                }

                // Legacy streaming format fallback
                if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use' && evt.content_block?.name) {
                  tools.add(evt.content_block.name);
                }
              }

              // Fall back to last assistant text if result was empty
              if (!summary && lastAssistantText.trim()) {
                const text = lastAssistantText.trim();
                summary = text.length > 500 ? text.slice(0, 497) + '...' : text;
              }

              if (tools.size > 0) toolsUsed = Array.from(tools);
            }
          } catch {
            // Transcript not available
          }
        } else {
          // PTY agents: read /tmp summary file
          try {
            const result = await window.clubhouse.agent.readQuickSummary(agentId);
            if (result) {
              summary = result.summary;
              filesModified = result.filesModified;
            }
          } catch {
            // Summary not available
          }
        }

        // If the summary was found, treat as success regardless of exit code
        // (we often force-kill quick agents after they finish, giving >128 codes)
        const cancelled = consumeCancelled(agentId);
        const effectiveExitCode = summary ? 0 : exitCode;

        useQuickAgentStore.getState().addCompleted({
          id: agentId,
          projectId: agent.projectId,
          name: agent.name,
          mission: agent.mission,
          summary,
          filesModified,
          exitCode: effectiveExitCode,
          completedAt: Date.now(),
          parentAgentId: agent.parentAgentId,
          headless: agent.headless,
          costUsd,
          durationMs,
          toolsUsed,
          orchestrator: agent.orchestrator || 'claude-code',
          model: agent.model,
          cancelled,
        });

        useAgentStore.getState().removeAgent(agentId);
      }

      // Emit plugin event after completion logic (wrapped to prevent silent failures)
      try {
        pluginEventBus.emit('agent:completed', { agentId, exitCode, name: agent?.name });
      } catch {
        // Plugin listener error — don't break the app
      }

      // Config changes detection for durable agents in clubhouse mode
      if (agent?.kind === 'durable' && agent.worktreePath) {
        const project = useProjectStore.getState().projects.find((p) => p.id === agent.projectId);
        if (project) {
          const cmEnabled = useClubhouseModeStore.getState().isEnabledForProject(project.path);
          if (cmEnabled) {
            try {
              const diff = await window.clubhouse.agentSettings.computeConfigDiff(project.path, agentId);
              if (diff.hasDiffs) {
                useAgentStore.getState().openConfigChangesDialog(agentId, project.path);
              }
            } catch { /* silent */ }
          }
        }
      }
    },
  );
  return removeExitListener;
}

function initHookEventListener(): () => void {
  const removeHookListener = window.clubhouse.agent.onHookEvent(
    (agentId: string, event: { kind: string; toolName?: string; toolInput?: Record<string, unknown>; message?: string; toolVerb?: string; timestamp: number }) => {
      useAgentStore.getState().handleHookEvent(agentId, event as AgentHookEvent);
      const agent = useAgentStore.getState().agents[agentId];
      if (!agent) return;
      const name = agent.name;
      useNotificationStore.getState().checkAndNotify(name, event.kind, event.toolName, agentId, agent.projectId);

      // Emit plugin events for agent lifecycle
      if (event.kind === 'stop') {
        pluginEventBus.emit('agent:completed', { agentId, name });
      } else {
        pluginEventBus.emit('agent:spawned', { agentId, name, kind: event.kind });
      }

      // Emit agent:hook for all hook events
      pluginEventBus.emit('agent:hook', {
        agentId,
        kind: event.kind,
        toolName: event.toolName,
        timestamp: event.timestamp,
      });

      // Auto-exit quick agents when the agent finishes (stop event).
      // Headless agents exit on their own — skip the kill timer.
      if (event.kind === 'stop' && agent.kind === 'quick' && !agent.headless) {
        // Delay gives the agent time to write the summary file before we send /exit.
        const project = useProjectStore.getState().projects.find((p) => p.id === agent.projectId);
        setTimeout(() => {
          const currentAgent = useAgentStore.getState().agents[agentId];
          if (currentAgent?.status !== 'running') return; // already exited
          if (project) {
            window.clubhouse.agent.killAgent(agentId, project.path);
          } else {
            window.clubhouse.pty.kill(agentId);
          }
        }, 2000);
      }
    },
  );
  return removeHookListener;
}

function initAnnexSpawnListener(): () => void {
  const removeAnnexSpawnListener = window.clubhouse.annex.onAgentSpawned((agent) => {
    const existing = useAgentStore.getState().agents[agent.id];
    if (existing) return; // Already known

    useAgentStore.setState((s) => ({
      agents: {
        ...s.agents,
        [agent.id]: {
          id: agent.id,
          projectId: agent.projectId,
          name: agent.name,
          kind: agent.kind,
          status: agent.status as AgentStatus,
          color: 'gray',
          mission: agent.prompt,
          model: agent.model || undefined,
          parentAgentId: agent.parentAgentId || undefined,
          orchestrator: agent.orchestrator || undefined,
          headless: agent.headless || undefined,
          freeAgentMode: agent.freeAgentMode || undefined,
        },
      },
      agentSpawnedAt: { ...s.agentSpawnedAt, [agent.id]: Date.now() },
    }));
  });
  return removeAnnexSpawnListener;
}

// ─── Agent Status Change Emitter (plugin events) ───────────────────────────

function initAgentStatusEmitter(): () => void {
  let prevStatuses: Record<string, string> = {};
  const unsub = useAgentStore.subscribe((state) => {
    const next: Record<string, string> = {};
    for (const [id, agent] of Object.entries(state.agents)) {
      next[id] = agent.status;
      if (prevStatuses[id] && prevStatuses[id] !== agent.status) {
        pluginEventBus.emit('agent:status-changed', {
          agentId: id,
          status: agent.status,
          prevStatus: prevStatuses[id],
          name: agent.name,
        });
      }
    }
    prevStatuses = next;
  });
  return unsub;
}

// ─── Notification Clearing ──────────────────────────────────────────────────

function initNotificationClearing(): () => void {
  // Clear any active OS notification when the user navigates to the agent's view.
  // Subscribes to the relevant stores outside the render cycle.
  let prevKey = '';
  const unsubs: (() => void)[] = [];

  const check = () => {
    const activeAgentId = useAgentStore.getState().activeAgentId;
    const activeProjectId = useProjectStore.getState().activeProjectId;
    const explorerTab = useUIStore.getState().explorerTab;
    const key = `${activeAgentId}|${activeProjectId}|${explorerTab}`;
    if (key !== prevKey) {
      prevKey = key;
      if (activeAgentId && activeProjectId && explorerTab === 'agents') {
        useNotificationStore.getState().clearNotification(activeAgentId, activeProjectId);
      }
    }
  };

  unsubs.push(useAgentStore.subscribe(check));
  unsubs.push(useProjectStore.subscribe(check));
  unsubs.push(useUIStore.subscribe(check));

  return () => unsubs.forEach((u) => u());
}

// ─── Stale Status Cleanup ───────────────────────────────────────────────────

function initStaleStatusCleanup(): () => void {
  const id = setInterval(() => useAgentStore.getState().clearStaleStatuses(), 10_000);
  return () => clearInterval(id);
}

// ─── Keyboard Shortcut Dispatcher ───────────────────────────────────────────

function initKeyboardShortcuts(): () => void {
  const handler = (e: KeyboardEvent) => {
    // Skip if recording a new binding in settings
    if (useKeyboardShortcutsStore.getState().editingId) return;

    const binding = eventToBinding(e);
    if (!binding) return;

    const target = e.target as HTMLElement | null;
    const isTextInput = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' ||
      target?.isContentEditable || target?.closest?.('[contenteditable]') != null;

    // Find matching system shortcut
    const { shortcuts } = useKeyboardShortcutsStore.getState();
    const matched = Object.values(shortcuts).find((s) => s.currentBinding === binding);

    if (matched) {
      const actions = getCommandActions();
      const action = actions.find((a) => a.id === matched.id);
      if (!action) return;

      // Guard: skip non-global shortcuts when focus is in a text input
      if (isTextInput && !action.global) return;
      // Guard: skip non-palette shortcuts when palette is open
      if (useCommandPaletteStore.getState().isOpen && matched.id !== 'command-palette') return;

      e.preventDefault();
      action.execute();
      return;
    }

    // Check plugin hotkeys (system shortcuts take priority — first claimer wins)
    const pluginShortcut = pluginHotkeyRegistry.findByBinding(binding);
    if (pluginShortcut) {
      if (isTextInput && !pluginShortcut.global) return;
      if (useCommandPaletteStore.getState().isOpen) return;

      e.preventDefault();
      pluginShortcut.handler();
    }
  };
  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Initialize all IPC listeners and event handlers.
 * Returns a single cleanup function that tears everything down.
 */
export function initAppEventBridge(): () => void {
  const cleanups: (() => void)[] = [];

  cleanups.push(...initWindowListeners());
  cleanups.push(initPtyExitListener());
  cleanups.push(initHookEventListener());
  cleanups.push(initAnnexSpawnListener());
  cleanups.push(initAgentStatusEmitter());
  cleanups.push(initNotificationClearing());
  cleanups.push(initStaleStatusCleanup());
  cleanups.push(initKeyboardShortcuts());

  return () => {
    for (const cleanup of cleanups) {
      cleanup();
    }
  };
}
