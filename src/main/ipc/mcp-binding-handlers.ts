import { startFederatedRequests } from '../services/dispatcher-federation-runtime';
import { federationReceiver } from '../services/dispatcher-federation-receiver';
/**
 * IPC handlers for MCP binding management.
 */

import { parseAgentAddress } from '../../shared/agent-address';
import { federationBindingSource, learnFederationController, localFederationController, watchFederation } from '../services/dispatcher-federation';
import { learnLeadShare, leadShare, startDispatcherLead } from '../services/dispatcher-federation-lead';
import { getDispatcherPresence, onDispatcherPresenceChanged, watchDispatcherPresence } from '../services/dispatcher-presence';
import { watchPeerPages } from '../services/dispatcher/dispatcher-peer-pages';
import { startLeadOutbox } from '../services/dispatcher-lead-outbox';
import { forwardNewsToLead, newsDeliveryFailed, startFollowerNews } from '../services/dispatcher-follower-news';
import { setChatForwarder } from '../services/dispatcher/dispatcher-channel';
import { federationDirection } from '../services/dispatcher-federation-policy';
import { auditChanged } from '../services/settings-audit';
import { watchSessionQuota } from '../services/provider-quota';
import { BrowserWindow, ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { watchMcpCallers } from '../services/orchestration-policy';
import { bindingManager, bridgeServer } from '../services/clubhouse-mcp';
import type { BindingTargetKind } from '../services/clubhouse-mcp';
import { registerClubhouseMcpTools } from '../services/clubhouse-mcp/tools/register-all';
import { registerWebview, unregisterWebview } from '../services/clubhouse-mcp/tools/browser-tools';
import { findMainWindow } from './window-handlers';
import { watchHelperStartRequests } from '../services/clubhouse-mcp/tools/helper-tools';
import { onDisposeRequestsChanged } from '../services/helper-dispose-requests';
import { onGrantRequestsChanged } from '../services/grant-requests';
import { agentRegistry } from '../services/agent-registry';
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
import { setManagedGroupProjects } from '../services/managed-group-projects';
import { MCP_UNBIND_CANVAS_CLEANUP, type McpBindCause, type McpBindResult, type McpUnbindResult } from '../../shared/mcp-unbind';
import { watchGroupProjectDelivery } from '../services/group-project-delivery';
import { watchGroupProjectRoles } from '../services/group-project-roles';
import {
  excludeMember, isMembershipManaged, managedGroupProjectIds, membershipBindingSource, watchGroupProjectMembership,
} from '../services/group-project-membership';
import { groupProjectHost } from '../services/group-project-host';
import { bindToGroupProject } from '../services/group-project-bind';
import { helperWireBindingSource, watchHelperWires } from '../services/helper-wire-source';
import { ORCHESTRATOR_CONNECTION_SOURCE_ID, orchestratorConnectionSource, watchOrchestratorConnections } from '../services/orchestrator-connections';
import { dispatcherWireBindingSource, watchDispatcherWires } from '../services/dispatcher-wire-source';
import { watchAgentCards } from '../services/dispatcher/dispatcher-agent-cards-watch';
import { dispatcherConnectionSource, isRemovalUnsaved, listDispatcherLinksForUser, watchDispatcherConnections } from '../services/dispatcher-connections';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import { withValidatedArgs, stringArg, objectArg, arrayArg, booleanArg } from './validation';
import { listConnectionSources, removeConnectionSource } from '../services/connection-sources';
import type { ConnectionSourceKind } from '../../shared/connection-sources';
import { migrateDispatcherLinkTools } from '../services/dispatcher-controls';
import {
  applyConnectionTools, connectAcrossMachines, disconnectAcrossMachines, makeTwoWay, migrateAutomaticConnectionTools, removeSourceAcrossMachines, setLocalWake, setToolsAcrossMachines, startConnectionGrants,
} from '../services/connection-grants';
import { listConnectionDirectionsForInspection } from '../services/connection-grants-store';
import { syncDirectionsWith, startAgentCalls } from '../services/annex-agent-calls';
import { startHandoffs } from '../services/handoff-host';
import { addCardConnection, listConnectionPickerTargets, removeCardConnection, startCardConnections } from '../services/connection-card';
import type { AddCardConnection } from '../../shared/connection-picker';
import { authorizeQueuedAnnexCall, reportAnnexDeliveryFailure } from '../services/annex-agent-call-host';
import * as annexPeers from '../services/annex-peers';
import * as annexClient from '../services/annex-client';
import { runAgentToolForRemoteCaller } from '../services/clubhouse-mcp/tool-registry';
import { mcpCallerKind } from '../services/clubhouse-mcp/mcp-call-gate';
import * as projectStore from '../services/project-store';
import * as agentConfig from '../services/agent-config';
import { getConnectionGuidance, getConnectionGuidanceCatalog, previewConnectionGuidance, saveConnectionGuidance, startConnectionGuidance } from '../services/connection-guidance';
import type { SaveConnectionGuidance } from '../../shared/connection-guidance';
import { dispatcherDisplayName, getDispatcherChatConfig, getDispatcherState, isDispatcherAgentId, isDispatcherChatAgentId, isDispatcherEnabled } from '../services/dispatcher/dispatcher-service';

function federationEnd(id: string) {
  const parsed = parseAgentAddress(id);
  return { agentId: parsed.agentId, ...(parsed.machine && { machineId: parsed.machine }) };
}

/** An agent's name and project here, for another machine's view of a call or connection (#3064). */
async function describeAgentHere(agentId: string): Promise<{ name: string; projectName?: string } | undefined> {
  const dispatcher = getDispatcherState().config;
  if (dispatcher?.id === agentId) return { name: dispatcher.name };
  const chat = getDispatcherChatConfig();
  if (chat?.id === agentId) return { name: chat.name };
  if (mcpCallerKind(agentId) === 'quick' && agentRegistry.get(agentId)) return { name: agentId };
  for (const project of await projectStore.peekProjects()) {
    const agent = (await agentConfig.peekDurableConfigs(project.path)).find((a) => a.id === agentId);
    if (agent) return { name: agent.name, projectName: project.displayName || project.name };
  }
  return undefined;
}

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
  handlersRegistered = true;

  // Register every Clubhouse MCP tool
  registerClubhouseMcpTools();
  startConnectionGuidance();
  // Running chat sessions report plan limits between reads (#2671).
  watchSessionQuota();
  // Held helper starts (#2234) go to the main window only, for Needs you.
  watchHelperStartRequests((channel, payload) => {
    findMainWindow()?.webContents.send(channel, payload);
  });
  // Permission requests (#2970) go to the main window only, for Needs you.
  onGrantRequestsChanged((change) => {
    const win = findMainWindow();
    if (change.kind === 'added') win?.webContents.send(IPC.AGENT.GRANT_REQUEST, change.request);
    else win?.webContents.send(IPC.AGENT.GRANT_REQUESTS_CLOSED, change.requestIds);
  });
  // A dispose request answered from a paired phone (#159) leaves Needs you too.
  onDisposeRequestsChanged((change) => {
    if (change.kind === 'closed' && !change.replaced) findMainWindow()?.webContents.send(IPC.AGENT.HELPER_DISPOSE_REQUEST_CLOSED, change.helperId);
  });

  appLog('core:mcp', 'info', 'MCP binding handlers registered');

  // Subscribe to binding changes for renderer broadcast
  bindingManager.onChange(() => {
    broadcastBindingsChanged();
  });

  ipcMain.handle(IPC.MCP_BINDING.GET_BINDINGS, () => {
    return bindingManager.getAllBindings();
  });

  ipcMain.handle(IPC.MCP_BINDING.BIND, withValidatedArgs(
    [stringArg(), objectArg<{ targetId: string; targetKind: string; label: string; agentName?: string; targetName?: string; projectName?: string }>(), stringArg({ optional: true })],
    (event, agentId, target, cause): McpBindResult | Promise<McpBindResult> => {
      assertCallerIsAppWindow(event);
      const bindNow = (): void => {
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
      };
      if (target.targetKind !== 'group-project') { bindNow(); return undefined; }
      // Scope, exclusions and the membership record (#3355, #3357) decide; see group-project-bind.ts.
      // Joining makes no one lead: lead and admin are explicit grants (#3360).
      return bindToGroupProject(target.targetId, agentId as string, cause as McpBindCause | undefined, {
        bindNow,
        joined: () => {
          broadcastBindingsChanged();
        },
      });
    },
  ));

  ipcMain.handle(IPC.MCP_BINDING.UNBIND, withValidatedArgs(
    [stringArg(), stringArg(), stringArg({ optional: true })],
    (event, agentId, targetId, cause): McpUnbindResult | Promise<McpUnbindResult> => {
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
      if (federationDirection(federationEnd(agentId as string), federationEnd(targetId as string))) return { kept: true };
      // Deleting a wire to a group project whose members come from its record
      // excludes the agent there (#3357), so it stays out across restarts.
      const bound = bindingManager.getBindingsForAgent(agentId as string).find((b) => b.targetId === targetId);
      const excluding = cause !== MCP_UNBIND_CANVAS_CLEANUP && bound?.targetKind === 'group-project'
        ? isMembershipManaged(targetId as string).then(async (managed): Promise<void> => { if (managed) await excludeMember(targetId as string, agentId as string); })
        : Promise.resolve();
      // Allow unbinding for sleeping/exited agents to support cleanup of stale
      // wire definitions without requiring the agent to be running.
      bindingManager.unbind(agentId as string, targetId as string);
      // A restore re-run (an MCP settings save) must not
      // bring this back from a store whose save hasn't landed yet.
      markBindingRemovedByUser(agentId as string, targetId as string);
      appLog('core:mcp', 'info', 'Binding removed', { meta: { agentId, targetId } });
      return excluding.then(() => isRemovalUnsaved({ agentId: agentId as string, targetId: targetId as string }))
        .then((removalNotSaved) => ({ kept: false, ...(removalNotSaved && { removalNotSaved }) }));
    },
  ));

  ipcMain.handle(IPC.MCP_BINDING.LIST_CARD_TARGETS, withValidatedArgs([stringArg({ maxLength: 200 })], async (event, agentId) => {
    assertCallerIsAppWindow(event);
    return listConnectionPickerTargets(agentId as string);
  }));
  ipcMain.handle(IPC.MCP_BINDING.ADD_CARD_CONNECTION, withValidatedArgs([objectArg()], async (event, request) => {
    assertCallerIsAppWindow(event);
    await addCardConnection(request as AddCardConnection);
  }));
  ipcMain.handle(IPC.MCP_BINDING.REMOVE_CARD_CONNECTION, withValidatedArgs([stringArg({ maxLength: 400 }), stringArg({ maxLength: 400 })], async (event, from, to) => {
    assertCallerIsAppWindow(event);
    await removeCardConnection(from as string, to as string);
  }));
  ipcMain.handle(IPC.MCP_BINDING.REMOVE_REMOTE_SOURCE, withValidatedArgs([stringArg({ maxLength: 200 }), stringArg({ maxLength: 400 }), stringArg({ maxLength: 30 })], async (event, agentId, address, kind) => {
    assertCallerIsAppWindow(event);
    if (kind !== 'user_link' && kind !== 'card_link' && kind !== 'tool_link') throw new Error('That connection source cannot be removed here.');
    await removeSourceAcrossMachines(agentId as string, address as string, kind);
  }));

  ipcMain.handle(IPC.MCP_BINDING.GET_TOOL_CONNECTIONS, (event) => {
    assertCallerIsAppWindow(event);
    return listSoleOwnedPairs(ORCHESTRATOR_CONNECTION_SOURCE_ID);
  });

  ipcMain.handle(IPC.MCP_BINDING.GET_DISPATCHER_LINKS, (event) => {
    assertCallerIsAppWindow(event);
    return listDispatcherLinksForUser({ strict: true });
  });

  // Agents across machines (#3064): the user connects an agent here with one on another machine.
  ipcMain.handle(IPC.MCP_BINDING.CONNECT_ACROSS_MACHINES, withValidatedArgs(
    [stringArg({ maxLength: 200 }), stringArg({ maxLength: 400 }), objectArg({ optional: true })],
    async (event, agentId, address, options) => {
      assertCallerIsAppWindow(event);
      const o = (options ?? {}) as { twoWay?: unknown; name?: unknown };
      await connectAcrossMachines(agentId as string, address as string, {
        twoWay: o.twoWay === true,
        ...(typeof o.name === 'string' && o.name.length <= 200 && { name: o.name }),
      });
    },
  ));
  ipcMain.handle(IPC.MCP_BINDING.SET_TOOLS_ACROSS_MACHINES, withValidatedArgs(
    [stringArg({ maxLength: 200 }), stringArg({ maxLength: 400 }), booleanArg(), arrayArg(stringArg({ maxLength: 100 }), { maxLength: 50 })],
    async (event, agentId, address, outgoing, tools) => {
      assertCallerIsAppWindow(event);
      await setToolsAcrossMachines(agentId as string, address as string, outgoing as boolean, tools as string[]);
    },
  ));
  ipcMain.handle(IPC.MCP_BINDING.DISCONNECT_ACROSS_MACHINES, withValidatedArgs([stringArg({ maxLength: 200 }), stringArg({ maxLength: 400 })], async (event, agentId, address) => {
    assertCallerIsAppWindow(event);
    await disconnectAcrossMachines(agentId as string, address as string);
  }));

  // Connection permissions (D129, #2972): the user's own surface.
  ipcMain.handle(IPC.MCP_BINDING.GET_CONNECTION_GRANTS, withValidatedArgs([stringArg({ maxLength: 200 })], (event, agentId) => {
    assertCallerIsAppWindow(event);
    return listConnectionDirectionsForInspection(agentId as string);
  }));
  ipcMain.handle(IPC.MCP_BINDING.MAKE_TWO_WAY, withValidatedArgs([stringArg({ maxLength: 200 }), stringArg({ maxLength: 200 })], async (event, fromId, toId) => {
    assertCallerIsAppWindow(event);
    void auditChanged('agent', 'agent.mcp_binding.link', fromId as string);
    await makeTwoWay(fromId as string, toId as string);
  }));

  ipcMain.handle(IPC.MCP_BINDING.SET_LOCAL_WAKE, withValidatedArgs(
    [stringArg({ maxLength: 200 }), stringArg({ maxLength: 200 }), booleanArg()],
    async (event, fromId, toId, on) => {
      assertCallerIsAppWindow(event);
      void auditChanged('agent', 'agent.mcp_binding.disabled_tools', fromId as string);
      await setLocalWake(fromId as string, toId as string, on as boolean);
    },
  ));

  // Connection sources (#2744): the user's own surface.
  ipcMain.handle(IPC.MCP_BINDING.GET_CONNECTION_SOURCES, withValidatedArgs([stringArg({ maxLength: 200 })], (event, agentId) => {
    assertCallerIsAppWindow(event);
    return listConnectionSources(agentId as string);
  }));
  ipcMain.handle(IPC.MCP_BINDING.REMOVE_CONNECTION_SOURCE, withValidatedArgs(
    [stringArg({ maxLength: 200 }), stringArg({ maxLength: 200 }), stringArg({ maxLength: 40 })],
    (event, agentId, targetId, kind) => {
      assertCallerIsAppWindow(event);
      return removeConnectionSource(agentId as string, targetId as string, kind as ConnectionSourceKind);
    },
  ));

  ipcMain.handle(IPC.MCP_BINDING.SET_INSTRUCTIONS, withValidatedArgs(
    [stringArg(), stringArg(), objectArg<Record<string, string>>()],
    (event, agentId, targetId, instructions) => {
      assertCallerIsAppWindow(event);
      assertNotPluginBinding(agentId as string, targetId as string);
      void auditChanged('agent', 'agent.mcp_binding.instructions', agentId as string);
      // Allow setting instructions for sleeping (unregistered) durable agents.
      // Binding metadata is stored in memory and will be active when the agent
      // wakes up and connects to the MCP bridge. Blocking this for sleeping
      // agents causes race conditions during recovery when canvas wires are
      // restored before agents are spawned.
      if (!agentRegistry.get(agentId as string)) {
        appLog('core:mcp', 'debug', 'Setting instructions for sleeping agent binding', { meta: { agentId, targetId } });
      }
      // Canvas hydration cannot replace the shared editor's saved directional override.
      bindingManager.restoreInstructions(agentId as string, targetId as string, instructions as Record<string, string>);
      appLog('core:mcp', 'info', 'Binding instructions updated', { meta: { agentId, targetId } });
    },
  ));

  ipcMain.handle(IPC.MCP_BINDING.GET_CONNECTION_GUIDANCE, withValidatedArgs(
    [stringArg(), stringArg()],
    (event, agentId, targetId) => {
      assertCallerIsAppWindow(event);
      return getConnectionGuidance(agentId as string, targetId as string);
    },
  ));

  ipcMain.handle(IPC.MCP_BINDING.SAVE_CONNECTION_GUIDANCE, withValidatedArgs(
    [stringArg(), stringArg(), objectArg<SaveConnectionGuidance>()],
    (event, agentId, targetId, request) => {
      assertCallerIsAppWindow(event);
      assertNotPluginBinding(agentId as string, targetId as string);
      return saveConnectionGuidance(agentId as string, targetId as string, request as SaveConnectionGuidance);
    },
  ));

  ipcMain.handle(IPC.MCP_BINDING.PREVIEW_CONNECTION_GUIDANCE, withValidatedArgs(
    [stringArg(), stringArg(), objectArg<Record<string, string>>()],
    (event, agentId, targetId, instructions) => {
      assertCallerIsAppWindow(event);
      return previewConnectionGuidance(agentId as string, targetId as string, instructions as Record<string, string>);
    },
  ));

  ipcMain.handle(IPC.MCP_BINDING.GET_CONNECTION_TOOL_CATALOG, withValidatedArgs(
    [stringArg(), stringArg()],
    (event, agentId, targetId) => {
      assertCallerIsAppWindow(event);
      return getConnectionGuidanceCatalog(agentId as string, targetId as string);
    },
  ));

  ipcMain.handle(IPC.MCP_BINDING.SET_DISABLED_TOOLS, withValidatedArgs(
    [stringArg(), stringArg(), arrayArg(stringArg()), objectArg<{ restore?: boolean; start?: boolean }>({ optional: true })],
    (event, agentId, targetId, disabledTools, options) => {
      assertCallerIsAppWindow(event);
      assertNotPluginBinding(agentId as string, targetId as string);
      void auditChanged('agent', 'agent.mcp_binding.disabled_tools', agentId as string);
      // Allow modifying disabled tools for sleeping agents (same rationale as
      // SET_INSTRUCTIONS above — binding metadata is just stored, not executed).
      if (!agentRegistry.get(agentId as string)) {
        appLog('core:mcp', 'debug', 'Setting disabled tools for sleeping agent binding', { meta: { agentId, targetId } });
      }
      // An agent-to-agent direction's tools live in the connection store (D129); a canvas wire
      // bound again only fills a store that has none (`restore`); a wire just drawn starts with wake on (`start`).
      const opts = options as { restore?: boolean; start?: boolean } | undefined;
      return applyConnectionTools(agentId as string, targetId as string, disabledTools as string[], { restore: opts?.restore === true, start: opts?.start === true })
        .then(() => { appLog('core:mcp', 'info', 'Binding disabled tools updated', { meta: { agentId, targetId, disabledTools } }); });
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

/** Start the MCP bridge server. It always runs; a failed start is retried on the next call. */
export function startMcpBridge(): void {
  if (bridgeState !== 'idle') return; // Already started or in progress
  bridgeState = 'starting';

  bridgeServer.start().then(() => {
    bridgeState = 'started';
  }).catch((err) => {
    // Close the dead server and drop its subscriptions, so the retry starts clean.
    bridgeServer.stop();
    bridgeState = 'idle'; // Allow retry on failure
    appLog('core:mcp', 'error', 'Failed to start MCP bridge server', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
  });
}

/**
 * Make sure the bridge and its tools are up (ensureMcpBridge), for a spawn or
 * a helper start. startMcpBridge has the bridge's ready promise set when this
 * returns, so the caller can wait on it, and a bridge that failed to start at
 * app start is tried again. Bindings are restored only the first time: wires
 * don't change because an agent started.
 */
export function ensureMcpBridgeStarted(): void {
  const first = !handlersRegistered;
  registerMcpBindingHandlers();
  startMcpBridge();
  if (first) void restorePersistedBindings();
}

let persistedSourcesRegistered = false;
let stopWatchingHelperWires: (() => void) | null = null;
let stopWatchingOrchestratorConnections: (() => void) | null = null;
let stopWatchingDispatcherWires: (() => void) | null = null;
let stopWatchingAgentCards: (() => void) | null = null;
let stopWatchingDispatcherConnections: (() => void) | null = null;
let stopFederatedRequests: (() => void) | undefined;
let stopWatchingFederation: (() => void) | null = null;
let stopDispatcherLead: (() => void) | null = null;
let stopWatchingDispatcherPresence: (() => void) | null = null;
let stopWatchingPeerPages: (() => void) | null = null;
let stopLeadOutbox: (() => void) | null = null;
let stopFollowerNews: (() => void) | null = null;
let stopWatchingMcpCallers: (() => void) | null = null;

/**
 * Rebuild bindings from every persisted wire store (canvas wires, #1544,
 * orchestrator ↔ helper wires from the agent config, #2225, and connections
 * made with the orchestrator connection tools, #2230, and Dispatcher ↔
 * orchestrator wires from the orchestration policy, #2537) so tools and
 * group-project membership don't wait for a canvas to be opened. Runs once
 * the handlers are registered at app start, and again whenever a project's
 * helper wires change.
 * Idempotent: bindings that already exist are left alone, so calling it again
 * (or the canvas binding the same wires later) creates nothing twice.
 */
export function restorePersistedBindings(): Promise<void> {
  if (!handlersRegistered) return Promise.resolve();
  if (!persistedSourcesRegistered) {
    persistedSourcesRegistered = true;
    // A group project whose members come from its record (#3357) isn't held by canvas wires.
    setManagedGroupProjects(managedGroupProjectIds);
    registerPersistedBindingSource(canvasWireBindingSource);
    registerPersistedBindingSource(helperWireBindingSource);
    stopWatchingHelperWires = watchHelperWires(() => restorePersistedBindings());
    registerPersistedBindingSource(orchestratorConnectionSource);
    stopWatchingOrchestratorConnections = watchOrchestratorConnections(() => restorePersistedBindings());
    registerPersistedBindingSource(dispatcherWireBindingSource);
    stopWatchingDispatcherWires = watchDispatcherWires(() => restorePersistedBindings());
    // Cards are asked for on connect and on a setup change (#3041), once the agent has its wire.
    stopWatchingAgentCards = watchAgentCards();
    // After the canvas source, so a pair the user also drew stays the user's.
    registerPersistedBindingSource(dispatcherConnectionSource);
    stopWatchingDispatcherConnections = watchDispatcherConnections(() => restorePersistedBindings());
    // Group project members (#3357): the membership record, not canvas wires.
    registerPersistedBindingSource(membershipBindingSource);
    watchGroupProjectMembership();
    // Members hear about posts as notices (#3362).
    watchGroupProjectDelivery();
    // Lead and admin as grants; today's admins get them once (#3360).
    watchGroupProjectRoles();
    // Connection permissions (D129): the store sets each direction's tools, and the user's links are a source.
    startConnectionGrants({
      notify: (from, to, disabledTools) => broadcastToAllWindows(IPC.MCP_BINDING.CONNECTION_GRANTS_CHANGED, from, to, disabledTools),
    });
    stopWatchingMcpCallers = watchMcpCallers();
    stopWatchingCardConnections = startCardConnections();
    // Agents across machines (#3064): calls to and from other machines' agents, and the connections between them.
    registerPersistedBindingSource(federationBindingSource);
    stopWatchingFederation = watchFederation(() => {
      void restorePersistedBindings();
      for (const peer of annexPeers.listPeers()) {
        if (peer.role === 'member' && peer.kind !== 'phone') void syncDirectionsWith(peer.fingerprint.toLowerCase());
      }
    }, (machine) => annexClient.isMachineConnected(machine));
    // A lead change goes to every connected computer member at once (#3351).
    stopDispatcherLead = startDispatcherLead({
      push: () => {
        for (const peer of annexPeers.listPeers()) {
          if (peer.role === 'member' && peer.kind !== 'phone') void syncDirectionsWith(peer.fingerprint.toLowerCase());
        }
      },
      connected: (machine) => annexClient.isMachineConnected(machine),
    });
    startHandoffs();
    // Other computers' Dispatchers (#3349): one read-only snapshot, recomputed when its sources change.
    stopWatchingDispatcherPresence = watchDispatcherPresence((machine) => annexClient.isMachineConnected(machine), (machine) => annexClient.lastConfirmedConnectivity(machine));
    // And its memory pages for them, keyed by machine-qualified address.
    stopWatchingPeerPages = watchPeerPages({ remotes: () => getDispatcherPresence().remotes, enabled: isDispatcherEnabled, onChanged: onDispatcherPresenceChanged });
    // A follower's agent news goes to the lead's chat while it's reachable (#3352).
    stopFollowerNews = startFollowerNews({
      connected: (machine) => annexClient.isMachineConnected(machine),
      machineName: (machine) => annexClient.machineAlias(machine),
    });
    setChatForwarder(forwardNewsToLead);
    // Messages typed while the lead was offline go when it's back (#3353).
    stopLeadOutbox = startLeadOutbox({
      connected: (machine) => annexClient.isMachineConnected(machine),
      dispatcherAgentId: (machine) => annexClient.machineDispatcherAgentId(machine),
      chatSession: async (machine, agentId) => {
        const key = annexClient.satelliteKeyFor(machine);
        if (!key) return { sessionId: null, live: false };
        const page = await annexClient.requestChatPage(key, agentId, { limit: 1 }) as { sessionId?: unknown; readOnly?: unknown } | null;
        return { sessionId: typeof page?.sessionId === 'string' ? page.sessionId : null, live: page?.readOnly === false };
      },
      wake: (machine, agentId, message, commandId) => {
        const key = annexClient.satelliteKeyFor(machine);
        if (!key) return Promise.reject(new Error('Satellite not connected'));
        return annexClient.wakeChatAgentWithMessage(key, agentId, message, commandId);
      },
      send: (machine, command, commandId) => {
        const key = annexClient.satelliteKeyFor(machine);
        if (!key) return Promise.reject(new Error('Satellite not connected'));
        return annexClient.sendChatCommand(key, command, commandId);
      },
      // Its snapshot names the lead's Dispatcher, and comes just after the connection opens.
      onConnected: (listener) => {
        const offConnected = annexClient.onSatelliteConnected(listener);
        const offSnapshot = annexClient.onSatelliteSnapshot(listener);
        return () => { offConnected(); offSnapshot(); };
      },
    });
    startAgentCalls({
      remoteDispatcher: federationReceiver,
      federation: {
        local: localFederationController, learn: learnFederationController,
        // The network-wide lead (#3351) rides the same exchange.
        extra: { local: leadShare, learn: learnLeadShare },
      },
      transport: {
        connected: (machine) => annexClient.isMachineConnected(machine),
        post: (machine, urlPath, body) => annexClient.postToMachine(machine, urlPath, body),
        supportsDurableDelivery: async (machine) => {
          const response = await annexClient.postToMachine(machine, '/api/v1/network/agent-delivery-capabilities', {});
          if (response.status === 404) return false;
          if (response.status !== 200) throw new Error(`Durable delivery negotiation failed (${response.status}).`);
          return !!response.body && typeof response.body === 'object'
            && 'deliveryVersion' in response.body && response.body.deliveryVersion === 1
            && 'receiptBoundary' in response.body && response.body.receiptBoundary === 'runtime-accepted';
        },
        machineName: (machine) => annexClient.machineAlias(machine),
        onConnected: (listener) => annexClient.onSatelliteConnected(listener),
      },
      runTool: runAgentToolForRemoteCaller,
      describeLocalAgent: describeAgentHere,
      nameOfLocalSender: (id) => isDispatcherAgentId(id) ? dispatcherDisplayName('work')
        : isDispatcherChatAgentId(id) ? dispatcherDisplayName() : undefined,
      authorizeQueuedCall: authorizeQueuedAnnexCall,
      // News a follower queued for the lead and the lead didn't take shows here instead (#3352).
      onDeliveryFailure: async (notice) => (await newsDeliveryFailed(notice)) || reportAnnexDeliveryFailure(notice),
    });
    stopFederatedRequests = startFederatedRequests();
  }
  return rebuildPersistedBindings().then(async (): Promise<void> => {
    // Once, after a rebuild has read every source: Dispatcher links from before #3215 get the new defaults.
    await migrateDispatcherLinkTools().catch((err) => {
      // telemetry-exempt: logged; it runs again after the next rebuild until it's done
      appLog('core:mcp', 'warn', 'Could not give older Dispatcher links the new connection defaults', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
    });
    // Bound members of project-scoped group projects become explicit, once, so scope only decides new joins (#3355).
    await groupProjectHost.recordScopedWireMembers().catch((err) => {
      // telemetry-exempt: logged; it runs again after the next rebuild until each group project is marked
      appLog('core:group-project', 'warn', 'Could not record current group project members before scope checks', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
    });
    // And connections from before the 2026-11-09 defaults keep the tools they now start with (#3214).
    await migrateAutomaticConnectionTools(
      [helperWireBindingSource.id, dispatcherWireBindingSource.id, orchestratorConnectionSource.id],
      [canvasWireBindingSource.id],
    ).catch((err) => {
      // telemetry-exempt: logged; it runs again after the next rebuild until it's done
      appLog('core:mcp', 'warn', 'Could not save the starting tools of older helper and Dispatcher links', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
    });
  }, (err): void => {
    appLog('core:mcp', 'error', 'Persisted binding rebuild failed', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
  });
}

/** For testing only: reset the registration guard so handlers can be re-registered. */
let stopWatchingCardConnections: (() => void) | null = null;

export function _resetHandlersForTesting(): void {
  handlersRegistered = false;
  persistedSourcesRegistered = false;
  stopWatchingFederation?.();
  stopFederatedRequests?.();
  stopFederatedRequests = undefined;
  stopWatchingFederation = null;
  stopDispatcherLead?.();
  stopDispatcherLead = null;
  stopWatchingCardConnections?.();
  stopWatchingCardConnections = null;
  stopWatchingDispatcherPresence?.();
  stopWatchingDispatcherPresence = null;
  stopWatchingPeerPages?.();
  stopWatchingPeerPages = null;
  stopLeadOutbox?.();
  stopLeadOutbox = null;
  stopFollowerNews?.();
  stopFollowerNews = null;
  setChatForwarder(null);
  stopWatchingHelperWires?.();
  stopWatchingHelperWires = null;
  stopWatchingOrchestratorConnections?.();
  stopWatchingOrchestratorConnections = null;
  stopWatchingDispatcherWires?.();
  stopWatchingDispatcherWires = null;
  stopWatchingAgentCards?.();
  stopWatchingAgentCards = null;
  stopWatchingDispatcherConnections?.();
  stopWatchingDispatcherConnections = null;
  stopWatchingMcpCallers?.();
  stopWatchingMcpCallers = null;
  bridgeState = 'idle';
}
