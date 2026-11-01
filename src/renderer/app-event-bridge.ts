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
import { applyDurableCreationEvent } from './features/agents/durable-creation-events';
import { useUIStore } from './stores/uiStore';
import { useNotificationStore } from './stores/notificationStore';
import { useHelperDisposeRequestStore, describeHelperDispose } from './stores/helperDisposeRequestStore';
import { useHelperStartRequestStore } from './stores/helperStartRequestStore';
import { useToastStore } from './stores/toastStore';
import { useQuickAgentStore } from './stores/quickAgentStore';
import { useClubhouseModeStore } from './stores/clubhouseModeStore';
import { handleShortcutKeydown } from './shortcut-dispatch';
import { pluginEventBus } from './plugins/plugin-events';
import { useAppCanvasStore, getProjectCanvasStore, hasProjectCanvasStore, getKnownProjectIds } from './plugins/builtin/canvas/main';
import { applyCanvasMutation } from './plugins/builtin/canvas/canvas-sync';
import type { AgentHookEvent, AgentStatus, CanvasMutation, HelperDisposeRequest, SoundEvent, ResolvedProtocolAction } from '../shared/types';
import { summarizeHeadlessTranscript } from '../shared/headless-transcript';
import { fileState } from './plugins/builtin/files/state';
import { useSoundStore } from './stores/soundStore';
import { useSessionSettingsStore } from './stores/sessionSettingsStore';
import { initAnnexListener } from './stores/annexStore';
import { initAnnexClientListener } from './stores/annexClientStore';
import { useLockStore } from './stores/lockStore';
import { initMcpBindingListener, useMcpBindingStore } from './stores/mcpBindingStore';
import { initChatEventListener } from './stores/chatStore';
import { initToolActivityListener } from './plugins/builtin/canvas/useWireActivity';
import { usePendingPermissionStore } from './stores/pendingPermissionStore';
import { showStructuredModeRemovedNotice } from './services/structured-mode-removal-notice';
import { isDispatcherAgent, isDispatcherProjectId, useDispatcherStore } from './features/dispatcher/dispatcherStore';
import { DISPATCHER_PROJECT_ID } from '../shared/dispatcher-types';
import { closeDispatcher, openDispatcher } from './features/dispatcher/dispatcherNav';


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
      // The Dispatcher is in no project; it opens its own view (#2538).
      if (isDispatcherProjectId(projectId) || isDispatcherAgent({ id: agentId, projectId })) { openDispatcher(); return; }
      closeDispatcher();
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

  // Respond to canvas state requests from pop-out windows
  removers.push(
    window.clubhouse.window.onRequestCanvasState(
      (requestId: string, canvasId: string, scope: string, projectId?: string) => {
        const store = scope === 'global' ? useAppCanvasStore :
          (projectId && hasProjectCanvasStore(projectId)) ? getProjectCanvasStore(projectId) : null;
        if (!store) {
          window.clubhouse.window.respondCanvasState(requestId, null);
          return;
        }
        const state = store.getState();
        const canvas = state.canvases.find((c) => c.id === canvasId);
        if (canvas) {
          window.clubhouse.window.respondCanvasState(requestId, {
            canvasId: canvas.id,
            name: canvas.name,
            views: canvas.views,
            viewport: canvas.viewport,
            nextZIndex: canvas.nextZIndex,
            zoomedViewId: canvas.zoomedViewId,
          });
        } else {
          window.clubhouse.window.respondCanvasState(requestId, null);
        }
      },
    ),
  );

  // Apply canvas mutations forwarded from pop-out windows and annex controllers.
  // projectId and scope are passed through so that broadcastCanvasState includes
  // them in the IPC payload — the main process needs projectId to forward the
  // resulting state to annex controller clients.
  removers.push(
    window.clubhouse.window.onCanvasMutation(
      (canvasId: string, scope: string, mutation: unknown, projectId?: string) => {
        const store = scope === 'global' ? useAppCanvasStore : getProjectCanvasStore(projectId ?? null);
        applyCanvasMutation(store, canvasId, mutation as CanvasMutation, projectId, scope);
      },
    ),
  );

  // Navigate to agent when requested from a pop-out window
  removers.push(
    window.clubhouse.window.onNavigateToAgent((agentId: string) => {
      const agent = useAgentStore.getState().agents[agentId];
      if (agent && isDispatcherAgent(agent)) {
        openDispatcher();
      } else if (agent) {
        closeDispatcher();
        useProjectStore.getState().setActiveProject(agent.projectId);
        useUIStore.getState().setExplorerTab('agents', agent.projectId);
        useAgentStore.getState().setActiveAgent(agentId, agent.projectId);
      }
    }),
  );

  // Navigate to plugin settings when requested by the main process
  removers.push(
    window.clubhouse.window.onNavigateToPluginSettings((pluginId?: string) => {
      const uiStore = useUIStore.getState();
      uiStore.setExplorerTab('settings');
      uiStore.setSettingsContext('app');
      if (pluginId) {
        uiStore.openPluginSettings(pluginId);
      } else {
        uiStore.setSettingsSubPage('plugins');
      }
    }),
  );

  // Popout asks the main window to reload durable agents for a project
  // (e.g. after a popout-initiated createDurable, so the main window's
  // store catches up before its next broadcast overwrites the popout).
  removers.push(
    window.clubhouse.window.onRequestDurableReload((projectId: string) => {
      const project = useProjectStore.getState().projects.find((p) => p.id === projectId);
      if (project) {
        useAgentStore.getState().loadDurableAgents(projectId, project.path).catch(() => { /* best-effort */ });
      }
    }),
  );

  return removers;
}

// ─── Agent Lifecycle Listeners ──────────────────────────────────────────────

/** A change made outside this window (an agent, the CLI, a hand edit) shows at once (#2597). */
function initDisplaySyncListeners(): (() => void)[] {
  return [
    window.clubhouse.agent.onConfigsChanged((projectPath: string) => {
      useAgentStore.getState().syncDurableDisplay(projectPath).catch(() => { /* best-effort: the next change or load catches up */ });
    }),
    window.clubhouse.project.onChanged(() => {
      useProjectStore.getState().syncProjectDisplay().catch(() => { /* best-effort: the next change or load catches up */ });
    }),
  ];
}

function initPtyExitListener(): () => void {
  const removeExitListener = window.clubhouse.pty.onExit(
    async (agentId: string, exitCode: number, lastOutput?: string) => {
      const agent = useAgentStore.getState().agents[agentId];
      // Read before removeAgent() drops it.
      const startedAt = useAgentStore.getState().agentSpawnedAt?.[agentId];
      useAgentStore.getState().updateAgentStatus(agentId, 'sleeping' as AgentStatus, exitCode, undefined, lastOutput);

      // Handle quick agent completion FIRST (before plugin events which could throw)
      if (agent?.kind === 'quick' && agent.mission) {
        let summary: string | null = null;
        let filesModified: string[] = [];
        let costUsd: number | undefined;
        let durationMs: number | undefined;
        let toolsUsed: string[] | undefined;
        let toolCalls: number | undefined;
        let inputTokens: number | undefined;
        let outputTokens: number | undefined;
        // Headless exits carry the stderr tail (or spawn error) as lastOutput.
        const stderrTail = agent.headless && lastOutput ? lastOutput : undefined;

        if (agent.headless) {
          // Headless agents: read enriched data from transcript
          try {
            const transcript = await window.clubhouse.agent.readTranscript(agentId);
            if (transcript) {
              const events = transcript.split('\n')
                .filter((line: string) => line.trim())
                .map((line: string) => {
                  try { return JSON.parse(line); } catch { return null; }
                })
                .filter(Boolean);

              const parsed = summarizeHeadlessTranscript(events);
              summary = parsed.summary;
              filesModified = parsed.filesModified;
              costUsd = parsed.costUsd;
              durationMs = parsed.durationMs;
              if (parsed.toolsUsed.length > 0) toolsUsed = parsed.toolsUsed;
              toolCalls = parsed.toolCalls;
              inputTokens = parsed.inputTokens;
              outputTokens = parsed.outputTokens;
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
          pluginMetadata: agent.pluginMetadata,
          stderrTail,
          cwd: agent.runCwd,
          baseSha: agent.runBaseSha,
          startedAt,
          freeAgentMode: agent.freeAgentMode,
          toolCalls,
          inputTokens,
          outputTokens,
        });

        // Keep the finished run on screen when it was the one being viewed,
        // instead of dropping to the start page (#2019).
        if (useAgentStore.getState().activeAgentId === agentId) {
          useQuickAgentStore.getState().selectCompleted(agentId);
        }

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
            } catch (err) {
              console.warn('[app-event-bridge] Failed to compute config diff for agent', agentId, err);
            }
          }
        }
      }
    },
  );
  return removeExitListener;
}

function initAgentWakingListener(): () => void {
  const removeWakingListener = window.clubhouse.agent.onAgentWaking((agentId: string) => {
    useAgentStore.getState().updateAgentStatus(agentId, 'waking');
  });
  const removeAwokeListener = window.clubhouse.agent.onAgentAwoke((agentId: string) => {
    useAgentStore.getState().updateAgentStatus(agentId, 'running');
  });
  const removeWakeFailedListener = window.clubhouse.agent.onAgentWakeFailed((agentId: string, errorMessage: string) => {
    useAgentStore.getState().updateAgentStatus(agentId, 'error', undefined, errorMessage);
  });
  const removeMaterializationFailedListener = window.clubhouse.agent.onAgentMaterializationFailed((agentId: string, errorMessage: string) => {
    useToastStore.getState().addToast(
      `Agent ${agentId} started without the latest Clubhouse Mode settings: ${errorMessage}`,
      'error',
    );
  });
  const removeSleepingListener = window.clubhouse.agent.onAgentSleeping((agentId: string) => {
    useAgentStore.getState().updateAgentStatus(agentId, 'sleeping');
  });
  const removeSleepReasonListener = window.clubhouse.agent.onAgentSleepReason((agentId, info) => {
    useAgentStore.getState().noteAgentSleep(agentId, info);
  });
  return () => {
    removeWakingListener();
    removeAwokeListener();
    removeWakeFailedListener();
    removeMaterializationFailedListener();
    removeSleepingListener();
    removeSleepReasonListener();
  };
}

/** Stages of an asynchronous agent creation (#2226); see applyDurableCreationEvent. */
function initCreationEventListener(): () => void {
  return window.clubhouse.agent.onDurableCreationEvent(applyDurableCreationEvent);
}

/**
 * An orchestrator asked to dispose a helper while its control level is
 * "ask-everything" (#2229). The helper shows under Needs you with the check
 * facts, and a desktop notification on the helper selects it when clicked.
 * Nothing is disposed or deleted from here. Selecting the Needs you entry
 * opens the dispose confirmation (#2232), which runs the checks again.
 */
export function handleHelperDisposeRequest(request: HelperDisposeRequest): void {
  const state = useAgentStore.getState();
  const helper = state.agents[request.helperId];
  if (!helper) return;
  const orchestratorName = state.agents[request.orchestratorId]?.name ?? 'An orchestrator';
  const pending = { request, orchestratorName, at: Date.now() };
  useHelperDisposeRequestStore.getState().add(request, orchestratorName, pending.at);
  useNotificationStore.getState().checkAndNotify(
    helper.name,
    'attention',
    undefined,
    request.helperId,
    helper.projectId,
    { title: `${orchestratorName} asked to dispose ${request.helperName}`, message: describeHelperDispose(pending) },
  );
}

function initHelperDisposeRequestListener(): () => void {
  // Main sends these to the main window only; a pop-out never subscribes.
  if (window.clubhouse.window.isPopout()) return () => {};
  const offRequest = window.clubhouse.agent.onHelperDisposeRequest(handleHelperDisposeRequest);
  // Answered from a paired phone (#159): drop it here too.
  const offClosed = window.clubhouse.agent.onHelperDisposeRequestClosed((helperId) => useHelperDisposeRequestStore.getState().dismiss(helperId));
  return () => { offRequest(); offClosed(); };
}

/**
 * Helper starts waiting on the user (#2234). Main sends each new request and
 * the ids of closed ones to the main window; the list is loaded once so a
 * reloaded window still shows what is waiting. Main already raised the
 * desktop notice for the request.
 */
export function initHelperStartRequestListener(): () => void {
  if (window.clubhouse.window.isPopout()) return () => {};
  const store = useHelperStartRequestStore.getState();
  // Subscribed before the load, so nothing sent meanwhile is missed; the load only adds.
  const offAdded = window.clubhouse.agent.onHelperStartRequest((request) => store.add(request));
  const offClosed = window.clubhouse.agent.onHelperStartRequestsClosed((ids) => store.remove(ids));
  Promise.resolve().then(() => window.clubhouse.agent.listHelperStartRequests()).then(
    (list) => { for (const request of list ?? []) useHelperStartRequestStore.getState().add(request); },
    // telemetry-exempt: requests sent from now on still arrive.
    () => {},
  );
  return () => { offAdded(); offClosed(); };
}

/** Notices that explain a start that didn't go as asked; a launch error card shows them. */
const LAUNCH_FAILURE_CODES = new Set(['fallback', 'login_required']);
const CLI_FALLBACK_PREFIX = 'Opened in the CLI view: ';

/** The reason inside a chat fallback notice, without the "Opened in the CLI view" lead-in. */
export function launchFailureReason(message: string): string {
  return message.startsWith(CLI_FALLBACK_PREFIX) ? message.slice(CLI_FALLBACK_PREFIX.length) : message;
}

/**
 * Toast when an agent falls back from chat (to another driver or the
 * terminal), with the reason, and keep the reason for the launch error card
 * in case the terminal then exits right away (#2088).
 */
function initChatRuntimeNoticeListener(): () => void {
  return window.clubhouse.chat.onRuntimeNotice((agentId, notice) => {
    const store = useAgentStore.getState();
    const name = store.agents[agentId]?.name ?? agentId;
    useToastStore.getState().addToast(`${name}: ${notice.message}`, 'info');
    if (LAUNCH_FAILURE_CODES.has(notice.code)) store.noteLaunchFailure(agentId, launchFailureReason(notice.message));
  });
}

/**
 * Keep the durable-agent permission queue mirrored in the renderer so the
 * approve/deny prompt can be shown. Seeded from the main process so a window
 * reload doesn't lose prompts that are already waiting.
 */
function initPermissionQueueListener(): () => void {
  const store = usePendingPermissionStore.getState();

  window.clubhouse.agent.listPendingPermissions()
    .then((pending) => store.hydrate(pending))
    .catch(() => { /* queue unavailable — prompts arrive via events instead */ });

  const removePendingListener = window.clubhouse.agent.onPermissionPending((_agentId, permission) => {
    usePendingPermissionStore.getState().addPending(permission);
  });
  const removeSettledListener = window.clubhouse.agent.onPermissionSettled((_agentId, settled) => {
    usePendingPermissionStore.getState().removePending(settled.requestId);
  });

  return () => {
    removePendingListener();
    removeSettledListener();
  };
}

function initHookEventListener(): () => void {
  const removeHookListener = window.clubhouse.agent.onHookEvent(
    (agentId: string, event: { kind: string; toolName?: string; toolInput?: Record<string, unknown>; message?: string; toolVerb?: string; timestamp: number }) => {
      useAgentStore.getState().handleHookEvent(agentId, event as AgentHookEvent);
      const agent = useAgentStore.getState().agents[agentId];
      if (!agent) return;
      const name = agent.name;
      useNotificationStore.getState().checkAndNotify(name, event.kind, event.toolName, agentId, agent.projectId);

      // Play sound when a permission decision is sent back to the agent
      if (event.kind === 'permission_resolved') {
        const soundEvent = event.message === 'allow' ? 'permission-granted' : 'permission-denied';
        useSoundStore.getState().playSound(soundEvent as SoundEvent, agent.projectId);
      }

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
        // Re-fetch project inside the callback to avoid stale closure capture.
        const projectId = agent.projectId;
        setTimeout(async () => {
          const currentAgent = useAgentStore.getState().agents[agentId];
          if (currentAgent?.status !== 'running') return; // already exited
          // A quick agent in chat was started to talk to (from a phone): the end
          // of a turn is the agent waiting for its person, not the end of the run.
          const runtime = await window.clubhouse.chat.getAgentRuntime(agentId).catch((): null => null);
          if (runtime?.chat) return;
          const project = useProjectStore.getState().projects.find((p) => p.id === projectId);
          if (project) {
            window.clubhouse.agent.killAgent(agentId, project.path).catch(() => {});
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

/** A phone changed a durable agent's settings (#2452): show its name, colour, icon and runtime here too. */
function initAnnexAgentUpdateListener(): () => void {
  return window.clubhouse.annex.onAgentUpdated((update) => {
    useAgentStore.setState((s) => {
      const existing = s.agents[update.agentId];
      if (!existing) return s;
      return {
        agents: {
          ...s.agents,
          [update.agentId]: {
            ...existing,
            name: update.name,
            color: update.color,
            emoji: update.emoji ?? undefined,
            // Emoji and image icon are mutually exclusive, as updateDurable saves them.
            icon: update.emoji ? undefined : existing.icon,
            model: update.model ?? undefined,
            orchestrator: update.orchestrator ?? undefined,
            freeAgentMode: update.freeAgentMode || undefined,
          },
        },
      };
    });
  });
}

// ─── Agent State Broadcasting (popout sync) ─────────────────────────────────

function initAgentStateBroadcast(): () => void {
  // Skip in popout windows — only the main renderer broadcasts.
  if (window.clubhouse.window.isPopout()) return () => {};

  // Throttle broadcasts to ~10/sec and only trigger on actual data changes.
  let throttleTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingState: { agents: Record<string, unknown>; agentDetailedStatus: Record<string, unknown>; agentIcons: Record<string, string> } | null = null;
  let prevAgents: Record<string, unknown> | undefined = undefined;
  let prevDetailedStatus: Record<string, unknown> | undefined = undefined;
  let prevIcons: Record<string, string> | undefined = undefined;

  const unsub = useAgentStore.subscribe((state) => {
    // Skip if the fields we broadcast haven't changed (reference equality)
    if (state.agents === prevAgents && state.agentDetailedStatus === prevDetailedStatus && state.agentIcons === prevIcons) {
      return;
    }
    prevAgents = state.agents;
    prevDetailedStatus = state.agentDetailedStatus;
    prevIcons = state.agentIcons;

    pendingState = {
      agents: state.agents,
      agentDetailedStatus: state.agentDetailedStatus,
      agentIcons: state.agentIcons,
    };
    if (!throttleTimer) {
      throttleTimer = setTimeout(() => {
        throttleTimer = null;
        if (pendingState) {
          window.clubhouse.window.broadcastAgentState(pendingState);
          pendingState = null;
        }
      }, 100);
    }
  });
  return () => {
    unsub();
    if (throttleTimer) clearTimeout(throttleTimer);
  };
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

        // Play wake/sleep sounds on status transitions
        if (agent.status === 'running' && prevStatuses[id] === 'sleeping') {
          useSoundStore.getState().playSound('agent-wake', agent.projectId);
        } else if (agent.status === 'sleeping' && prevStatuses[id] === 'running') {
          useSoundStore.getState().playSound('agent-sleep', agent.projectId);

          // Prompt for session name if the setting is enabled for this project
          if (agent.kind === 'durable') {
            const project = useProjectStore.getState().projects.find((p) => p.id === agent.projectId);
            if (project && useSessionSettingsStore.getState().shouldPrompt(project.path)) {
              useAgentStore.getState().setSessionNamePrompt(id);
            }
          }
        }
      }
    }
    prevStatuses = next;
  });
  return unsub;
}

// ─── Active Agent Sound Effects ───────────────────────────────────────────────

function initActiveAgentSound(): () => void {
  let prevActiveAgentId = useAgentStore.getState().activeAgentId;
  const unsub = useAgentStore.subscribe((state) => {
    const nextActiveAgentId = state.activeAgentId;
    if (nextActiveAgentId && nextActiveAgentId !== prevActiveAgentId) {
      const agent = state.agents[nextActiveAgentId];
      useSoundStore.getState().playSound('agent-focus', agent?.projectId);
    }
    prevActiveAgentId = nextActiveAgentId;
  });
  return unsub;
}

// ─── Agent Attention (notify_user tool) ─────────────────────────────────────

function initAgentAttentionListener(): () => void {
  // An agent deliberately asked for the user's attention via the notify_user
  // MCP tool. Route it through the shared notification gating so it surfaces as
  // a native desktop notification (click-to-navigate + auto-dismiss), gated by
  // the agentRequestedAttention setting and suppressed when the agent is visible.
  return window.clubhouse.app.onAgentAttention((agentId, payload) => {
    const agent = useAgentStore.getState().agents[agentId];
    const name = agent?.name ?? 'Agent';
    useNotificationStore.getState().checkAndNotify(
      name,
      'attention',
      undefined,
      agentId,
      agent?.projectId,
      payload,
    );
  });
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
    const { explorerTab, dispatcherOpen } = useUIStore.getState();
    const dispatcherAgentId = useDispatcherStore.getState().state?.agentId;
    const key = `${activeAgentId}|${activeProjectId}|${explorerTab}|${dispatcherOpen}|${dispatcherAgentId}`;
    if (key !== prevKey) {
      prevKey = key;
      // The Dispatcher's view hides the active agent behind it (#2556).
      if (dispatcherOpen) {
        if (dispatcherAgentId) useNotificationStore.getState().clearNotification(dispatcherAgentId, DISPATCHER_PROJECT_ID);
      } else if (activeAgentId && activeProjectId && explorerTab === 'agents') {
        useNotificationStore.getState().clearNotification(activeAgentId, activeProjectId);
      }
    }
  };

  unsubs.push(useAgentStore.subscribe(check));
  unsubs.push(useProjectStore.subscribe(check));
  unsubs.push(useUIStore.subscribe(check));
  unsubs.push(useDispatcherStore.subscribe(check));

  return () => unsubs.forEach((u) => u());
}

// ─── Stale Status Cleanup ───────────────────────────────────────────────────

function initStaleStatusCleanup(): () => void {
  const id = setInterval(() => useAgentStore.getState().clearStaleStatuses(), 10_000);
  return () => clearInterval(id);
}

// ─── Keyboard Shortcut Dispatcher ───────────────────────────────────────────

function initKeyboardShortcuts(): () => void {
  window.addEventListener('keydown', handleShortcutKeydown);
  return () => window.removeEventListener('keydown', handleShortcutKeydown);
}

// ─── Annex Lock State Listener ──────────────────────────────────────────────

function initAnnexLockStateListener(): () => void {
  return window.clubhouse.annex.onLockStateChanged((state: { locked: boolean; controllerAlias?: string; controllerIcon?: string; controllerColor?: string; controllerFingerprint?: string; remainingMs: number }) => {
    if (state.locked) {
      useLockStore.getState().lock({
        controllerAlias: state.controllerAlias || 'Unknown',
        controllerIcon: state.controllerIcon || '',
        controllerColor: state.controllerColor || 'indigo',
        controllerFingerprint: state.controllerFingerprint || '',
      });
    } else {
      useLockStore.getState().unlock();
    }
  });
}

// ─── Public API ─────────────────────────────────────────────────────────────

// Track previous cleanup for idempotent re-initialization (HMR safety)
let previousCleanup: (() => void) | null = null;

/**
 * Initialize all IPC listeners and event handlers.
 * Returns a single cleanup function that tears everything down.
 * Safe to call multiple times — previous subscriptions are torn down first.
 */
// ─── Custom Protocol (clubhouse://) ─────────────────────────────────────────

/**
 * Apply a resolved protocol activation dispatched from the main process:
 *   - open-file: focus the owning project, switch to the file browser, and
 *     open the file. The openTab is deferred so the files panel finishes
 *     (re)mounting — and any previous panel finishes deactivating, which
 *     resets fileState — before we set the active tab. With a line, it goes
 *     to that line (and column).
 *   - open-folder: add the folder as a new project (which activates it) and
 *     switch to its file browser.
 *   - open-file-not-found: surface an error toast.
 */
export function handleProtocolAction(action: ResolvedProtocolAction): void {
  switch (action.kind) {
    case 'open-file': {
      // The Dispatcher's folder has no project or Files tab to open it in (#2538).
      if (isDispatcherProjectId(action.projectId)) {
        useToastStore.getState().addToast(`${action.relativePath} is in the Dispatcher’s folder, which doesn’t open in Files.`, 'error');
        break;
      }
      useProjectStore.getState().setActiveProject(action.projectId);
      useUIStore.getState().setExplorerTab('plugin:files', action.projectId);
      const { relativePath, line, column } = action;
      setTimeout(() => {
        if (line !== undefined) fileState.navigateToMatch(relativePath, line, column);
        else fileState.openTab(relativePath, { preview: false });
      }, 0);
      break;
    }
    case 'open-folder': {
      useProjectStore.getState().addProject(action.folderPath)
        .then((project) => {
          useUIStore.getState().setExplorerTab('plugin:files', project.id);
        })
        .catch(() => {
          useToastStore.getState().addToast('Failed to open folder as a project', 'error');
        });
      break;
    }
    case 'open-file-not-found': {
      useToastStore.getState().addToast(
        `No open project contains ${action.filePath}`,
        'error',
      );
      break;
    }
  }
}

function initProtocolActionListener(): () => void {
  // Warm path: links activated while the app is running are pushed here.
  const removeListener = window.clubhouse.app.onProtocolAction(handleProtocolAction);

  // Cold start: a link may have launched the app before this listener existed.
  // Pull any queued action and apply it.
  window.clubhouse.app.getPendingProtocolAction()
    .then((action) => {
      if (action) handleProtocolAction(action);
    })
    .catch(() => { /* best-effort */ });

  return removeListener;
}

export function initAppEventBridge(): () => void {
  // Tear down previous subscriptions to prevent accumulation on re-init
  previousCleanup?.();
  previousCleanup = null;

  const cleanups: (() => void)[] = [];

  cleanups.push(...initWindowListeners());
  cleanups.push(...initDisplaySyncListeners());
  cleanups.push(initPtyExitListener());
  cleanups.push(initAgentWakingListener());
  cleanups.push(initCreationEventListener());
  cleanups.push(initHelperDisposeRequestListener());
  cleanups.push(initHelperStartRequestListener());
  cleanups.push(initChatRuntimeNoticeListener());
  cleanups.push(initHookEventListener());
  cleanups.push(initPermissionQueueListener());
  cleanups.push(initAnnexSpawnListener());
  cleanups.push(initAnnexAgentUpdateListener());
  cleanups.push(initAgentStateBroadcast());
  cleanups.push(initAgentStatusEmitter());
  cleanups.push(initActiveAgentSound());
  cleanups.push(initNotificationClearing());
  cleanups.push(initAgentAttentionListener());
  cleanups.push(initStaleStatusCleanup());

  showStructuredModeRemovedNotice().catch(() => { /* best-effort one-time notice */ });
  cleanups.push(initKeyboardShortcuts());
  cleanups.push(initAnnexListener());
  cleanups.push(initAnnexClientListener());
  cleanups.push(initAnnexLockStateListener());

  // MCP binding listener — load initial bindings and subscribe to changes
  useMcpBindingStore.getState().loadBindings();
  cleanups.push(initMcpBindingListener((agentId, targetId, projectName) => {
    // Propagate refreshed projectName to wire definitions in all canvas stores
    useAppCanvasStore.getState().updateWireDefinition(agentId, targetId, { projectName });
    for (const projectId of getKnownProjectIds()) {
      getProjectCanvasStore(projectId).getState().updateWireDefinition(agentId, targetId, { projectName });
    }
  }));
  cleanups.push(initToolActivityListener());
  cleanups.push(initProtocolActionListener());
  cleanups.push(initChatEventListener());

  const teardown = () => {
    for (const cleanup of cleanups) {
      cleanup();
    }
    previousCleanup = null;
  };
  previousCleanup = teardown;
  return teardown;
}
