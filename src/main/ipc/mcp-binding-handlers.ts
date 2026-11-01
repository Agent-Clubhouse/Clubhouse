/**
 * IPC handlers for MCP binding management.
 */

import { BrowserWindow, ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { isMcpEnabledForAny } from '../services/mcp-settings';
import { bindingManager, bridgeServer } from '../services/clubhouse-mcp';
import type { BindingTargetKind } from '../services/clubhouse-mcp';
import { registerAgentTools } from '../services/clubhouse-mcp/tools/agent-tools';
import { registerBrowserTools, registerWebview, unregisterWebview } from '../services/clubhouse-mcp/tools/browser-tools';
import { registerGroupProjectTools } from '../services/clubhouse-mcp/tools/group-project-tools';
import { registerNotifyTools } from '../services/clubhouse-mcp/tools/notify-tools';
import { registerHelperDisposeTools } from '../services/clubhouse-mcp/tools/helper-dispose-tools';
import { registerHelperQuestionTools } from '../services/clubhouse-mcp/tools/helper-question-tools';
import { findMainWindow } from './window-handlers';
import { registerHelperTools, watchHelperStartRequests } from '../services/clubhouse-mcp/tools/helper-tools';
import { registerModelTools } from '../services/clubhouse-mcp/tools/model-tools';
import { registerDispatcherTools } from '../services/clubhouse-mcp/tools/dispatcher-tools';
import { onDisposeRequestsChanged } from '../services/helper-dispose-requests';
import { registerConnectionTools } from '../services/clubhouse-mcp/tools/connection-tools';
import { agentRegistry } from '../services/agent-registry';
import { bootstrapGroupProjectAdmin } from '../services/group-project-admin-service';
import { appLog } from '../services/log-service';
import {
  registerPersistedBindingSource,
  rebuildPersistedBindings,
  markBindingRemovedByUser,
  clearBindingRemovedByUser,
  keepHeldBinding,
  listSoleOwnedPairs,
} from '../services/persisted-bindings';
import { canvasWireBindingSource } from '../services/canvas-wire-source';
import { MCP_UNBIND_CANVAS_CLEANUP } from '../../shared/mcp-unbind';
import { helperWireBindingSource, watchHelperWires } from '../services/helper-wire-source';
import { ORCHESTRATOR_CONNECTION_SOURCE_ID, orchestratorConnectionSource, watchOrchestratorConnections } from '../services/orchestrator-connections';
import { dispatcherWireBindingSource, watchDispatcherWires } from '../services/dispatcher-wire-source';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import { withValidatedArgs, stringArg, objectArg, arrayArg } from './validation';

/**
 * Target kinds the renderer may bind. 'plugin' is left out (#2082): plugins
 * share the main window's renderer, so any plugin could bind an agent to its
 * own or another plugin's tools. No app UI creates plugin bindings yet.
 */
const VALID_TARGET_KINDS = new Set<BindingTargetKind>([
  'browser', 'agent', 'terminal', 'group-project',
]);

/** Validate that a targetKind string is a known BindingTargetKind. */
function assertValidTargetKind(kind: string): asserts kind is BindingTargetKind {
  if (!VALID_TARGET_KINDS.has(kind as BindingTargetKind)) {
    throw new Error(`Invalid targetKind "${kind}". Must be one of: ${[...VALID_TARGET_KINDS].join(', ')}`);
  }
}

/**
 * Reject a renderer change to an existing plugin binding (#2082): unbind,
 * instructions and disabled tools go through the same shared renderer as bind.
 */
function assertNotPluginBinding(agentId: string, targetId: string): void {
  const binding = bindingManager.getBindingsForAgent(agentId).find((b) => b.targetId === targetId);
  if (binding?.targetKind === 'plugin') {
    appLog('core:mcp', 'warn', 'Rejected MCP binding request for a plugin target', { meta: { agentId, targetId } });
    throw new Error('MCP binding operation rejected — plugin bindings cannot be changed from the renderer');
  }
}

/**
 * Verify the IPC caller is an application window, not a webview or detached WebContents.
 * Prevents webview-hosted content (e.g. browser plugin pages) from calling binding APIs.
 */
function assertCallerIsAppWindow(event: Electron.IpcMainInvokeEvent): void {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) {
    appLog('core:mcp', 'warn', 'Rejected MCP binding request — caller is not an application window');
    throw new Error('MCP binding operation rejected — unauthorized caller');
  }
}

function broadcastBindingsChanged(): void {
  broadcastToAllWindows(IPC.MCP_BINDING.BINDINGS_CHANGED, bindingManager.getAllBindings());
}

let handlersRegistered = false;

export function registerMcpBindingHandlers(): void {
  if (handlersRegistered) return; // Already registered — idempotent
  if (!isMcpEnabledForAny()) {
    return; // Feature not enabled for any project — don't register handlers
  }

  handlersRegistered = true;

  // Register tool templates
  registerAgentTools();
  registerBrowserTools();
  registerGroupProjectTools();
  registerNotifyTools();
  registerHelperDisposeTools();
  registerHelperTools();
  registerModelTools();
  registerDispatcherTools();
  registerHelperQuestionTools();
  // Held helper starts (#2234) go to the main window only, for Needs you.
  watchHelperStartRequests((channel, payload) => {
    findMainWindow()?.webContents.send(channel, payload);
  });
  // A dispose request answered from a paired phone (#159) leaves Needs you too.
  onDisposeRequestsChanged((change) => {
    if (change.kind === 'closed' && !change.replaced) findMainWindow()?.webContents.send(IPC.AGENT.HELPER_DISPOSE_REQUEST_CLOSED, change.helperId);
  });
  registerConnectionTools();

  appLog('core:mcp', 'info', 'MCP binding handlers registered');

  // Subscribe to binding changes for renderer broadcast
  bindingManager.onChange(() => {
    broadcastBindingsChanged();
  });

  ipcMain.handle(IPC.MCP_BINDING.GET_BINDINGS, () => {
    return bindingManager.getAllBindings();
  });

  ipcMain.handle(IPC.MCP_BINDING.BIND, withValidatedArgs(
    [stringArg(), objectArg<{ targetId: string; targetKind: string; label: string; agentName?: string; targetName?: string; projectName?: string }>()],
    (event, agentId, target) => {
      assertCallerIsAppWindow(event);
      // Allow binding for sleeping (unregistered) durable agents — the binding
      // will be stored and used when the agent wakes up and connects to the MCP
      // bridge. This is essential for canvas wire creation: wires can be
      // created (e.g. from a blueprint) before agents are started.
      if (!agentRegistry.get(agentId as string)) {
        appLog('core:mcp', 'debug', 'Creating binding for sleeping agent', { meta: { agentId } });
      }
      assertValidTargetKind(target.targetKind);
      clearBindingRemovedByUser(agentId as string, target.targetId);
      const isNew = bindingManager.bind(agentId as string, target as { targetId: string; targetKind: BindingTargetKind; label: string; agentName?: string; targetName?: string; projectName?: string });
      // Bootstrap the project lead: the first agent to join a group project
      // becomes its admin (no-op once an admin exists). The registry change
      // invalidates the scoped tool cache so role gating applies immediately.
      if (target.targetKind === 'group-project') {
        void bootstrapGroupProjectAdmin(target.targetId, agentId as string);
      }
      if (!isNew) {
        // Duplicate binding — notifyChange was skipped by bind(), so the
        // renderer's mcpBindingStore won't receive a BINDINGS_CHANGED event.
        // Broadcast explicitly so the canvas wire reconciler can see the
        // binding and stop retrying.
        broadcastBindingsChanged();
      }
      appLog('core:mcp', isNew ? 'info' : 'debug', isNew ? 'Binding created' : 'Binding already present', {
        meta: {
          agentId,
          agentName: target.agentName,
          targetId: target.targetId,
          targetName: target.targetName,
          targetKind: target.targetKind,
        },
      });
    },
  ));

  ipcMain.handle(IPC.MCP_BINDING.UNBIND, withValidatedArgs(
    [stringArg(), stringArg(), stringArg({ optional: true })],
    (event, agentId, targetId, cause): { kept: boolean } => {
      assertCallerIsAppWindow(event);
      assertNotPluginBinding(agentId as string, targetId as string);
      // Canvas cleanup (a card or canvas tab closed, a zone member left) only
      // hides a wire the canvas displays. A helper wire (#2225) stays: closing
      // a card must not cut orchestration. Deleting the wire itself sends no
      // cause and unbinds as before.
      if (cause === MCP_UNBIND_CANVAS_CLEANUP && keepHeldBinding(agentId as string, targetId as string)) {
        appLog('core:mcp', 'info', 'Binding kept on canvas cleanup: a persisted source still lists it', {
          meta: { agentId, targetId },
        });
        return { kept: true };
      }
      // Allow unbinding for sleeping/exited agents to support cleanup of stale
      // wire definitions without requiring the agent to be running.
      bindingManager.unbind(agentId as string, targetId as string);
      // A restore re-run (MCP settings save, Clubhouse Mode toggle) must not
      // bring this back from a store whose save hasn't landed yet.
      markBindingRemovedByUser(agentId as string, targetId as string);
      appLog('core:mcp', 'info', 'Binding removed', { meta: { agentId, targetId } });
      return { kept: false };
    },
  ));

  ipcMain.handle(IPC.MCP_BINDING.GET_TOOL_CONNECTIONS, (event) => {
    assertCallerIsAppWindow(event);
    return listSoleOwnedPairs(ORCHESTRATOR_CONNECTION_SOURCE_ID);
  });

  ipcMain.handle(IPC.MCP_BINDING.SET_INSTRUCTIONS, withValidatedArgs(
    [stringArg(), stringArg(), objectArg<Record<string, string>>()],
    (event, agentId, targetId, instructions) => {
      assertCallerIsAppWindow(event);
      assertNotPluginBinding(agentId as string, targetId as string);
      // Allow setting instructions for sleeping (unregistered) durable agents.
      // Binding metadata is stored in memory and will be active when the agent
      // wakes up and connects to the MCP bridge. Blocking this for sleeping
      // agents causes race conditions during recovery when canvas wires are
      // restored before agents are spawned.
      if (!agentRegistry.get(agentId as string)) {
        appLog('core:mcp', 'debug', 'Setting instructions for sleeping agent binding', { meta: { agentId, targetId } });
      }
      bindingManager.setInstructions(agentId as string, targetId as string, instructions as Record<string, string>);
      appLog('core:mcp', 'info', 'Binding instructions updated', { meta: { agentId, targetId } });
    },
  ));

  ipcMain.handle(IPC.MCP_BINDING.SET_DISABLED_TOOLS, withValidatedArgs(
    [stringArg(), stringArg(), arrayArg(stringArg())],
    (event, agentId, targetId, disabledTools) => {
      assertCallerIsAppWindow(event);
      assertNotPluginBinding(agentId as string, targetId as string);
      // Allow modifying disabled tools for sleeping agents (same rationale as
      // SET_INSTRUCTIONS above — binding metadata is just stored, not executed).
      if (!agentRegistry.get(agentId as string)) {
        appLog('core:mcp', 'debug', 'Setting disabled tools for sleeping agent binding', { meta: { agentId, targetId } });
      }
      bindingManager.setDisabledTools(agentId as string, targetId as string, disabledTools as string[]);
      appLog('core:mcp', 'info', 'Binding disabled tools updated', { meta: { agentId, targetId, disabledTools } });
    },
  ));

  ipcMain.handle(IPC.MCP_BINDING.GET_AGENT_CONNECTION, withValidatedArgs(
    [stringArg()],
    (event, agentId) => {
      assertCallerIsAppWindow(event);
      return bridgeServer.getAgentConnection(agentId as string);
    },
  ));

  ipcMain.handle(IPC.MCP_BINDING.REGISTER_WEBVIEW, withValidatedArgs(
    [stringArg(), stringArg()],
    (_event, widgetId, webContentsId) => {
      registerWebview(widgetId as string, parseInt(webContentsId as string, 10));
    },
  ));

  ipcMain.handle(IPC.MCP_BINDING.UNREGISTER_WEBVIEW, withValidatedArgs(
    [stringArg()],
    (_event, widgetId) => {
      unregisterWebview(widgetId as string);
    },
  ));
}

let bridgeState: 'idle' | 'starting' | 'started' = 'idle';

/** Conditionally start the MCP bridge server if MCP is enabled for any project. */
export function maybeStartMcpBridge(): void {
  if (bridgeState !== 'idle') return; // Already started or in progress
  if (!isMcpEnabledForAny()) {
    return;
  }

  bridgeState = 'starting';

  bridgeServer.start().then(() => {
    bridgeState = 'started';
  }).catch((err) => {
    bridgeState = 'idle'; // Allow retry on failure
    appLog('core:mcp', 'error', 'Failed to start MCP bridge server', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
  });
}

/**
 * Called when MCP or Clubhouse Mode settings change. If MCP becomes enabled
 * for any project, lazily start the bridge and register handlers without
 * requiring an app restart.
 */
export function onMcpSettingsChanged(): void {
  if (!isMcpEnabledForAny()) return;
  registerMcpBindingHandlers();
  maybeStartMcpBridge();
  restorePersistedBindings();
}

let persistedSourcesRegistered = false;
let stopWatchingHelperWires: (() => void) | null = null;
let stopWatchingOrchestratorConnections: (() => void) | null = null;
let stopWatchingDispatcherWires: (() => void) | null = null;

/**
 * Rebuild bindings from every persisted wire store (canvas wires, #1544,
 * orchestrator ↔ helper wires from the agent config, #2225, and connections
 * made with the orchestrator connection tools, #2230, and Dispatcher ↔
 * orchestrator wires from the orchestration policy, #2537) so tools and
 * group-project membership don't wait for a canvas to be opened. Runs only
 * once MCP is on, and again whenever a project's helper wires change.
 * Idempotent: bindings that already exist are left alone, so calling it again
 * (or the canvas binding the same wires later) creates nothing twice.
 */
export function restorePersistedBindings(): Promise<void> {
  if (!handlersRegistered) return Promise.resolve();
  if (!persistedSourcesRegistered) {
    persistedSourcesRegistered = true;
    registerPersistedBindingSource(canvasWireBindingSource);
    registerPersistedBindingSource(helperWireBindingSource);
    stopWatchingHelperWires = watchHelperWires(() => restorePersistedBindings());
    registerPersistedBindingSource(orchestratorConnectionSource);
    stopWatchingOrchestratorConnections = watchOrchestratorConnections(() => restorePersistedBindings());
    registerPersistedBindingSource(dispatcherWireBindingSource);
    stopWatchingDispatcherWires = watchDispatcherWires(() => restorePersistedBindings());
  }
  return rebuildPersistedBindings().then((): void => undefined, (err): void => {
    appLog('core:mcp', 'error', 'Persisted binding rebuild failed', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
  });
}

/** For testing only: reset the registration guard so handlers can be re-registered. */
export function _resetHandlersForTesting(): void {
  handlersRegistered = false;
  persistedSourcesRegistered = false;
  stopWatchingHelperWires?.();
  stopWatchingHelperWires = null;
  stopWatchingOrchestratorConnections?.();
  stopWatchingOrchestratorConnections = null;
  stopWatchingDispatcherWires?.();
  stopWatchingDispatcherWires = null;
  bridgeState = 'idle';
}
