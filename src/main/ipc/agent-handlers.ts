import { contextWindowOptionsFor } from '../services/context-window';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { ipcMain, dialog, BrowserWindow } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { ICON_DATA_URL_MAX_LENGTH } from '../../shared/icon-limits';
import { SpawnAgentParams } from '../../shared/types';
import { isSessionCapable, type OrchestratorId, type TranscriptReadStats } from '../orchestrators';
import * as agentConfig from '../services/agent-config';
import * as agentSystem from '../services/agent-system';
import { agentRegistry } from '../services/agent-registry';
import * as headlessManager from '../services/headless-manager';
import { buildSummaryInstruction, readQuickSummary } from '../orchestrators/shared';
import { normalizeSessionEvents, buildSessionSummary, paginateEvents, SUMMARY_TRANSCRIPT_MAX_BYTES } from '../services/session-reader';
import { appLog } from '../services/log-service';
import { broadcastSnapshotRefresh } from '../services/annex-server';
import { bindingManager } from '../services/clubhouse-mcp/binding-manager';
import { refreshClubhouseModeReadme } from '../services/materialization-service';
import * as orchestrationPolicy from '../services/orchestration-policy';
import * as dispatcher from '../services/dispatcher/dispatcher-service';
import * as projectStore from '../services/project-store';
import { listHelpersEverywhere } from '../services/helper-index';
import * as clubhouseModeSettings from '../services/clubhouse-mode-settings';
import { onMcpEnablementChanged } from '../services/mcp-settings';
import * as permissionQueue from '../services/annex-permission-queue';
import { withValidatedArgs, stringArg, objectArg, arrayArg, numberArg, booleanArg } from './validation';
import { ATTR } from '../../shared/telemetry/attributes';
import type { DeleteResult, HelperDisposeChecks, HelperInProject, Project } from '../../shared/types';
import { disposeHelperForUser, reportDisposeDecision } from '../services/helper-dispose-decisions';
import { listStartRequests } from '../services/helper-start-requests';
import { approveHelperStart, declineHelperStart } from '../services/clubhouse-mcp/tools/helper-tools';
import { tel, tagError, withErrorType } from '../telemetry/facade';
import { orchestratorAttr } from '../telemetry/spawn-telemetry';
import { assertAgentGitName } from '../../shared/agent-name';
import { isDisposedAgent } from '../../shared/agent-helpers';
import type { DurableWorktreeOptions } from '../../shared/types';
import { cancelDurableCreation, injectPersona, onDurableCreationEvent, parseStartCreationParams, parseWorktreeOptions, personaInjection, startDurableCreation } from '../services/agent-creation';

export { parseStartCreationParams };
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import { applyFinishedQuickAgentChange, hydrateFinishedQuickAgents, onFinishedQuickAgentsChange } from '../services/finished-quick-agents-store';
import { parseFinishedQuickAgentOp } from '../../shared/finished-quick-agents';

type DeleteMode = Parameters<typeof ATTR.deleteMode>[0];

/** Transcript read stats for the timing log, with durations in whole ms. */
function roundStats(stats: TranscriptReadStats): TranscriptReadStats {
  return {
    ...stats,
    ...(stats.lookupMs !== undefined && { lookupMs: Math.round(stats.lookupMs) }),
    ...(stats.readMs !== undefined && { readMs: Math.round(stats.readMs) }),
  };
}

export { disposeHelperForUser, reportDisposeDecision };

/**
 * Wrap a durable-agent delete in the `clubhouse.agent.delete` flow. A thrown
 * error or a result with `ok: false` is `delete_failed`. (The save-patch
 * dialog's cancel returns before this, so it is not recorded.)
 */
function deleteFlow<T extends DeleteResult | void>(mode: DeleteMode, fn: () => Promise<T>): Promise<T> {
  return tel.flow('clubhouse.agent.delete', { attrs: [ATTR.deleteMode(mode)] }, () => withErrorType('delete_failed', fn), {
    classify: (r) => (!r || r.ok ? 'ok' : { error: 'delete_failed' }),
  });
}

type DurableConfigUpdates = Parameters<typeof agentConfig.updateDurableConfig>[2];


async function createDurableAgent(
  projectPath: string,
  name: string,
  color: string,
  model: string | undefined,
  useWorktree: boolean | undefined,
  orchestrator: string | undefined,
  freeAgentMode: boolean | undefined,
  mcpIds: string[] | undefined,
  mcpConfigs: Record<string, Record<string, string>> | undefined,
  persona: string | undefined,
  worktreeOptions: DurableWorktreeOptions | undefined,
) {
  // The name becomes a folder and a git branch; refuse a bad one up front (#2221).
  if (useWorktree !== false && worktreeOptions?.folderName === undefined) {
    try {
      assertAgentGitName(name, 'folder');
    } catch (err) {
      throw tagError(err, 'validation');
    }
  }

  let config: Awaited<ReturnType<typeof agentConfig.createDurable>>;
  try {
    config = await agentConfig.createDurable(projectPath, name, color, model, useWorktree, orchestrator as OrchestratorId | undefined, freeAgentMode, mcpIds, mcpConfigs, persona, worktreeOptions);
  } catch (err) {
    // worktree_failed and validation are tagged at their throw sites; anything else is a write failure.
    throw tagError(err, 'write_failed');
  }

  if (persona && config.worktreePath) {
    if (await injectPersona(projectPath, config.id, persona, name)) {
      config = (await agentConfig.getDurableConfig(projectPath, config.id)) ?? config;
    }
  }

  broadcastSnapshotRefresh();
  return config;
}

let creationEventsForwarded = false;

/** Send every creation stage to the windows, and refresh remote snapshots when one ends (#2226). */
function forwardCreationEvents(): void {
  if (creationEventsForwarded) return;
  creationEventsForwarded = true;
  onDurableCreationEvent((event) => {
    broadcastToAllWindows(IPC.AGENT.DURABLE_CREATION_EVENT, event);
    if (event.stage === 'config_created' || event.stage === 'ready' || event.stage === 'failed' || event.stage === 'cancelled') {
      broadcastSnapshotRefresh();
    }
  });
}

/** How long config changes for one project are gathered into one renderer event. */
export const CONFIG_CHANGE_DEBOUNCE_MS = 150;
let configChangesForwarded = false;

const lastDisplay = new Map<string, string>();

/**
 * Phones draw avatars from the Annex snapshot, so a new name, color, emoji or
 * image anywhere (Settings, update_agent, the CLI, agents.json) refreshes it.
 * Most config writes change none of these and rebuilding it is not cheap.
 */
async function refreshSnapshotOnDisplayChange(projectPath: string): Promise<void> {
  try {
    const agents = await agentConfig.listDurable(projectPath);
    const display = JSON.stringify(agents.map((a) => [a.id, a.name, a.color, a.emoji, a.icon]));
    if (lastDisplay.get(projectPath) === display) return;
    lastDisplay.set(projectPath, display);
    broadcastSnapshotRefresh();
  } catch (err) {
    // telemetry-exempt: logged; phones catch up at the next snapshot
    appLog('core:annex', 'warn', 'Snapshot refresh after an agent config change failed', {
      meta: { projectPath, error: err instanceof Error ? err.message : String(err) },
    });
  }
}

/**
 * Tell the windows when a project's agent configs change (any in-app write,
 * or an external edit to agents.json), so views built on them, such as the
 * Helpers card, re-read. Bursts of writes become one event per project.
 */
function forwardConfigChanges(): void {
  if (configChangesForwarded) return;
  configChangesForwarded = true;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  agentConfig.onAgentConfigChanged((projectPath) => {
    if (timers.has(projectPath)) return;
    timers.set(projectPath, setTimeout(() => {
      timers.delete(projectPath);
      broadcastToAllWindows(IPC.AGENT.CONFIGS_CHANGED, projectPath);
      void refreshSnapshotOnDisplayChange(projectPath);
    }, CONFIG_CHANGE_DEBOUNCE_MS));
  });
  onMcpEnablementChanged(() => broadcastToAllWindows(IPC.AGENT.MCP_ENABLEMENT_CHANGED));
}

// --- Dispatcher singleton guards (#2535) ---

function isDispatcherAgent(projectPath: string, agentId: string): boolean {
  return dispatcher.isDispatcherPath(projectPath) || dispatcher.isDispatcherAgentId(agentId);
}

/** The Dispatcher can't be deleted or given orchestration settings. */
function assertNotDispatcher(projectPath: string, agentId: string, what: string): void {
  if (isDispatcherAgent(projectPath, agentId)) {
    throw tagError(new Error(`The Dispatcher can't be ${what}.`), 'validation');
  }
}

/**
 * Nothing is created in the Dispatcher's folder (no duplicates). The persona
 * rules (no other agent gets the dispatcher persona, and the Dispatcher keeps
 * it) live in agentConfig.assertPersonaAllowed, which every create and config
 * update runs (#2551).
 */
function assertCreatable(projectPath: string): void {
  if (dispatcher.isDispatcherPath(projectPath)) {
    throw tagError(new Error("The Dispatcher can't be duplicated."), 'validation');
  }
}

export function registerAgentHandlers(): void {
  forwardConfigChanges();
  ipcMain.handle(IPC.AGENT.LIST_DURABLE, withValidatedArgs(
    [stringArg()],
    async (_event, projectPath) => {
      // Refresh the CH-mode self-edit guide once per project per session.
      // LIST_DURABLE fires when the user opens / activates a project in the UI,
      // so this is a low-overhead place to pick up updated readme content even
      // when no agent is woken.
      if (clubhouseModeSettings.isClubhouseModeEnabled(projectPath)) {
        refreshClubhouseModeReadme(projectPath).catch((err) => {
          appLog('core:materialization', 'warn', 'Failed to refresh clubhouse-mode.md from LIST_DURABLE', {
            meta: { projectPath, error: err instanceof Error ? err.message : String(err) },
          });
        });
      }
      return agentConfig.listDurable(projectPath);
    },
  ));

  // Returns the subset of the given agent IDs that currently have a live
  // session (PTY / headless) in the main process. The renderer
  // calls this after (re)loading durable agents to reconcile status, so a
  // reopened window shows running agents as 'running' immediately instead of
  // waiting for the next poll tick or hook event.
  ipcMain.handle(IPC.AGENT.GET_RUNNING_STATUSES, withValidatedArgs(
    [arrayArg(stringArg())],
    async (_event, agentIds) => {
      return agentSystem.getRunningAgentIds(agentIds);
    },
  ));

  ipcMain.handle(
    IPC.AGENT.CREATE_DURABLE,
    withValidatedArgs(
      [stringArg(), stringArg(), stringArg(), stringArg({ optional: true }), booleanArg({ optional: true }), stringArg({ optional: true }), booleanArg({ optional: true }), arrayArg(stringArg(), { optional: true }), objectArg({ optional: true }), stringArg({ optional: true }), objectArg<Record<string, unknown>>({ optional: true })],
      async (_event, projectPath, name, color, model, useWorktree, orchestrator, freeAgentMode, mcpIds, mcpConfigs, persona, worktreeOptions) => tel.flow(
        'clubhouse.agent.create',
        { attrs: [ATTR.usesWorktree(useWorktree !== false), ATTR.orchestrator(orchestratorAttr(orchestrator))] },
        () => {
          assertCreatable(projectPath);
          return createDurableAgent(
            projectPath, name, color, model, useWorktree, orchestrator, freeAgentMode, mcpIds,
            mcpConfigs as Record<string, Record<string, string>> | undefined, persona,
            worktreeOptions ? parseWorktreeOptions(worktreeOptions) : undefined,
          );
        },
      ),
    ),
  );

  // Asynchronous create (#2226): the id comes back at once, in the 'creating'
  // state; stages, including ready or failed, arrive on DURABLE_CREATION_EVENT.
  forwardCreationEvents();
  ipcMain.handle(IPC.AGENT.START_DURABLE_CREATION, withValidatedArgs(
    [stringArg(), objectArg<Record<string, unknown>>()],
    async (_event, projectPath, rawParams) => {
      const params = parseStartCreationParams(rawParams);
      assertCreatable(projectPath);
      const { agentId, config } = await startDurableCreation(projectPath, params, personaInjection(projectPath, params));
      return { agentId, config };
    },
  ));

  ipcMain.handle(IPC.AGENT.CANCEL_DURABLE_CREATION, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, projectPath, agentId) => cancelDurableCreation(projectPath, agentId),
  ));

  ipcMain.handle(IPC.AGENT.DELETE_DURABLE, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, projectPath, agentId) => {
      assertNotDispatcher(projectPath, agentId, 'deleted');
      const result = await deleteFlow('standard', () => agentConfig.deleteDurable(projectPath, agentId));
      bindingManager.unbindAgent(agentId);
      bindingManager.unbindTarget(agentId);
      broadcastSnapshotRefresh();
      return result;
    },
  ));

  ipcMain.handle(IPC.AGENT.RENAME_DURABLE, withValidatedArgs(
    [stringArg(), stringArg(), stringArg()],
    async (_event, projectPath, agentId, newName) => {
      return agentConfig.renameDurable(projectPath, agentId, newName);
    },
  ));

  ipcMain.handle(
    IPC.AGENT.UPDATE_DURABLE,
    withValidatedArgs(
      [stringArg(), stringArg(), objectArg<{ name?: string; color?: string; icon?: string | null; emoji?: string | null }>()],
      async (_event, projectPath, agentId, updates) => {
        return agentConfig.updateDurable(projectPath, agentId, updates);
      },
    ),
  );

  ipcMain.handle(IPC.AGENT.PICK_ICON, async () => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      title: 'Choose Agent Icon',
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    // Read the file and return as data URL for crop preview
    const filePath = result.filePaths[0];
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    };
    const mime = mimeMap[ext] || 'image/png';
    const data = await fsp.readFile(filePath);
    return `data:${mime};base64,${data.toString('base64')}`;
  });

  ipcMain.handle(IPC.AGENT.SAVE_ICON, withValidatedArgs(
    [stringArg(), stringArg(), stringArg({ maxLength: ICON_DATA_URL_MAX_LENGTH })],
    async (_event, projectPath, agentId, dataUrl) => {
      const filename = await agentConfig.saveAgentIcon(projectPath, agentId, dataUrl);
      // The same file name as the image it replaces, so the display check can't see it.
      broadcastSnapshotRefresh();
      return filename;
    },
  ));

  ipcMain.handle(IPC.AGENT.READ_ICON, withValidatedArgs(
    [stringArg()],
    async (_event, filename) => {
      return agentConfig.readAgentIconData(filename);
    },
  ));

  ipcMain.handle(IPC.AGENT.REMOVE_ICON, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, projectPath, agentId) => {
      return agentConfig.removeAgentIcon(projectPath, agentId);
    },
  ));

  ipcMain.handle(IPC.AGENT.GET_DURABLE_CONFIG, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, projectPath, agentId) => {
      return agentConfig.getDurableConfig(projectPath, agentId);
    },
  ));

  ipcMain.handle(IPC.AGENT.UPDATE_DURABLE_CONFIG, withValidatedArgs(
    [stringArg(), stringArg(), objectArg<DurableConfigUpdates>()],
    async (_event, projectPath, agentId, updates) => {
      return agentConfig.updateDurableConfig(projectPath, agentId, updates);
    },
  ));

  ipcMain.handle(IPC.AGENT.REORDER_DURABLE, withValidatedArgs(
    [stringArg(), arrayArg(stringArg())],
    async (_event, projectPath, orderedIds) => {
      const result = await agentConfig.reorderDurable(projectPath, orderedIds);
      broadcastSnapshotRefresh();
      return result;
    },
  ));

  ipcMain.handle(IPC.AGENT.GET_WORKTREE_STATUS, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, projectPath, agentId) => {
      return agentConfig.getWorktreeStatus(projectPath, agentId);
    },
  ));

  ipcMain.handle(IPC.AGENT.DELETE_COMMIT_PUSH, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, projectPath, agentId) => {
      assertNotDispatcher(projectPath, agentId, 'deleted');
      const result = await deleteFlow('commit_push', () => agentConfig.deleteCommitAndPush(projectPath, agentId));
      if (result.ok) broadcastSnapshotRefresh();
      return result;
    },
  ));

  ipcMain.handle(IPC.AGENT.DELETE_CLEANUP_BRANCH, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, projectPath, agentId) => {
      assertNotDispatcher(projectPath, agentId, 'deleted');
      const result = await deleteFlow('cleanup_branch', () => agentConfig.deleteWithCleanupBranch(projectPath, agentId));
      if (result.ok) broadcastSnapshotRefresh();
      return result;
    },
  ));

  ipcMain.handle(IPC.AGENT.DELETE_SAVE_PATCH, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, projectPath, agentId) => {
      assertNotDispatcher(projectPath, agentId, 'deleted');
      const win = BrowserWindow.getFocusedWindow();
      if (!win) return { ok: false, message: 'cancelled' };
      const result = await dialog.showSaveDialog(win, {
        title: 'Save patch file',
        defaultPath: `agent-${agentId}.patch`,
        filters: [{ name: 'Patch files', extensions: ['patch'] }],
      });

      if (result.canceled || !result.filePath) {
        return { ok: false, message: 'cancelled' };
      }

      const filePath = result.filePath;
      const deleteResult = await deleteFlow('save_patch', () => agentConfig.deleteSaveAsPatch(projectPath, agentId, filePath));
      if (deleteResult.ok) broadcastSnapshotRefresh();
      return deleteResult;
    },
  ));

  ipcMain.handle(IPC.AGENT.DELETE_FORCE, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, projectPath, agentId) => {
      assertNotDispatcher(projectPath, agentId, 'deleted');
      const result = await deleteFlow('force', () => agentConfig.deleteForce(projectPath, agentId));
      if (result.ok) broadcastSnapshotRefresh();
      return result;
    },
  ));

  ipcMain.handle(IPC.AGENT.DELETE_UNREGISTER, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, projectPath, agentId) => {
      assertNotDispatcher(projectPath, agentId, 'deleted');
      const result = await deleteFlow('unregister', () => agentConfig.deleteUnregister(projectPath, agentId));
      if (result.ok) broadcastSnapshotRefresh();
      return result;
    },
  ));

  // --- Helpers (#2224) ---

  // Helpers in every registered project (#2514), each with the project its row is in.
  ipcMain.handle(IPC.AGENT.LIST_HELPERS, withValidatedArgs(
    [stringArg(), stringArg(), booleanArg({ optional: true }), booleanArg({ optional: true })],
    async (_event, projectPath, agentId, recursive, includeDisposed): Promise<HelperInProject[]> => {
      const entries = await listHelpersEverywhere(projectPath, agentId, { recursive, includeDisposed });
      if (entries.length === 0) return [];
      // telemetry-exempt: without the project list the rows carry their paths only.
      const projects = await projectStore.list().catch((): Project[] => []);
      const key = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
      const ids = new Map(projects.map((p) => [key(p.path), p.id] as const));
      return entries.map((e) => ({ projectId: ids.get(key(e.projectPath)), projectPath: e.projectPath, config: e.config }));
    },
  ));

  ipcMain.handle(IPC.AGENT.RESOLVE_HELPERS_FOR_DELETE, withValidatedArgs(
    [stringArg(), stringArg(), stringArg(), booleanArg({ optional: true })],
    async (_event, projectPath, agentId, choice, dryRun) => {
      if (choice !== 'dispose' && choice !== 'keep') {
        throw new Error(`Unknown helper choice: ${choice}`);
      }
      const result = await agentConfig.resolveHelpersForDelete(projectPath, agentId, choice, { dryRun });
      if (!dryRun && result.ok && (result.helperIds?.length ?? 0) > 0) broadcastSnapshotRefresh();
      return result;
    },
  ));

  // --- Disposing helpers from the UI (#2232) ---

  ipcMain.handle(IPC.AGENT.GET_DISPOSE_CHECKS, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, projectPath, agentId) => agentConfig.getDisposeChecks(projectPath, agentId),
  ));

  ipcMain.handle(IPC.AGENT.DISPOSE_HELPER, withValidatedArgs(
    [stringArg(), stringArg(), booleanArg({ optional: true }), objectArg<HelperDisposeChecks>({
      optional: true,
      validate: (v, name) => {
        if (!Number.isInteger(v.dirty) || !Number.isInteger(v.unpushed)) throw new Error(`${name} must have whole-number dirty and unpushed counts`);
      },
    })],
    async (_event, projectPath, agentId, force, seen) => {
      const result = await disposeHelperForUser(projectPath, agentId, { force: force === true, seen });
      if (result.ok) broadcastSnapshotRefresh();
      return result;
    },
  ));

  ipcMain.handle(IPC.AGENT.REPORT_DISPOSE_DECISION, withValidatedArgs(
    [stringArg(), stringArg(), stringArg()],
    async (_event, projectPath, helperId, decision) => {
      if (decision !== 'disposed' && decision !== 'declined') throw new Error(`Unknown decision: ${decision}`);
      return reportDisposeDecision(projectPath, helperId, decision);
    },
  ));

  // --- Helper starts waiting on the user (#2234) ---

  ipcMain.handle(IPC.AGENT.LIST_HELPER_START_REQUESTS, () => listStartRequests());

  // Main looks the request up by id within the project and uses it up once;
  // nothing but the two ids comes from the renderer.
  ipcMain.handle(IPC.AGENT.APPROVE_HELPER_START, withValidatedArgs(
    [stringArg({ maxLength: 4096 }), stringArg({ maxLength: 200 })],
    async (_event, projectPath, requestId) => {
      const result = await approveHelperStart(projectPath, requestId);
      if (result.ok) broadcastSnapshotRefresh();
      return result;
    },
  ));

  ipcMain.handle(IPC.AGENT.DECLINE_HELPER_START, withValidatedArgs(
    [stringArg({ maxLength: 4096 }), stringArg({ maxLength: 200 })],
    async (_event, projectPath, requestId) => declineHelperStart(projectPath, requestId),
  ));


  ipcMain.handle(IPC.AGENT.REMOVE_DISPOSED, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, projectPath, agentId) => {
      const config = await agentConfig.getDurableConfig(projectPath, agentId);
      if (!config) return { ok: true, message: 'Already removed' };
      if (!isDisposedAgent(config)) return { ok: false, message: `${config.name} isn't disposed` };
      const result = await agentConfig.deleteUnregister(projectPath, agentId);
      if (result.ok) broadcastSnapshotRefresh();
      return result;
    },
  ));

  // --- Orchestration policy (#2228) ---

  ipcMain.handle(IPC.AGENT.GET_ORCHESTRATION_POLICY, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, projectPath, agentId) => orchestrationPolicy.getOrchestrationPolicy(projectPath, agentId),
  ));

  ipcMain.handle(IPC.AGENT.SET_ORCHESTRATION_POLICY, withValidatedArgs(
    [stringArg(), stringArg(), objectArg<Record<string, unknown>>()],
    async (_event, projectPath, agentId, patch) => {
      assertNotDispatcher(projectPath, agentId, 'given orchestration settings');
      const result = await orchestrationPolicy.setOrchestrationPolicy(projectPath, agentId, patch);
      if (result.ok) broadcastSnapshotRefresh();
      return result;
    },
  ));

  ipcMain.handle(IPC.AGENT.TURN_OFF_ORCHESTRATION, withValidatedArgs(
    [stringArg(), stringArg(), stringArg(), booleanArg({ optional: true })],
    async (_event, projectPath, agentId, choice, force) => {
      assertNotDispatcher(projectPath, agentId, 'given orchestration settings');
      if (choice !== 'keep' && choice !== 'dispose' && choice !== 'cancel') {
        throw new Error(`Unknown choice: ${choice}`);
      }
      const result = await orchestrationPolicy.turnOffOrchestration(projectPath, agentId, choice, { force });
      if (result.ok && !result.cancelled) broadcastSnapshotRefresh();
      return result;
    },
  ));

  ipcMain.handle(IPC.AGENT.GET_HELPER_SUMMARY, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, projectPath, agentId) => orchestrationPolicy.getHelperSummary(projectPath, agentId),
  ));

  ipcMain.handle(IPC.AGENT.RESOLVE_HELPER_ACCESS, withValidatedArgs(
    [stringArg(), stringArg(), stringArg({ optional: true })],
    async (_event, projectPath, agentId, helperProvider) =>
      orchestrationPolicy.resolveHelperLaunchSettings(projectPath, agentId, { helperProvider }),
  ));

  ipcMain.handle(IPC.AGENT.CHECK_HELPER_LIMIT, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, projectPath, agentId) => orchestrationPolicy.checkHelperLimitFor(projectPath, agentId),
  ));

  // --- Orchestrator-based handlers ---

  ipcMain.handle(IPC.AGENT.SPAWN_AGENT, withValidatedArgs(
    [objectArg<SpawnAgentParams>({
      validate: (v, name) => {
        if (typeof v.agentId !== 'string' || !v.agentId) throw new Error(`${name}.agentId must be a non-empty string`);
        if (typeof v.projectPath !== 'string' || !v.projectPath) throw new Error(`${name}.projectPath must be a non-empty string`);
        if (typeof v.cwd !== 'string' || !v.cwd) throw new Error(`${name}.cwd must be a non-empty string`);
        if (typeof v.kind !== 'string' || !v.kind) throw new Error(`${name}.kind must be a non-empty string`);
      },
    })],
    async (_event, params) => {
      try {
        await agentSystem.spawnAgent(params);
      } catch (err) {
        appLog('core:ipc', 'error', 'Agent spawn failed', {
          meta: {
            agentId: params.agentId,
            kind: params.kind,
            orchestrator: params.orchestrator,
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          },
        });
        throw err;
      }
    },
  ));

  ipcMain.handle(IPC.AGENT.KILL_AGENT, withValidatedArgs(
    [stringArg(), stringArg(), booleanArg({ optional: true })],
    async (_event, agentId, projectPath, waitForExit) => {
      await agentSystem.killAgent(agentId, projectPath, undefined, 'user', { waitForExit });
    },
  ));

  ipcMain.handle(IPC.AGENT.READ_QUICK_SUMMARY, withValidatedArgs(
    [stringArg()],
    async (_event, agentId) => {
      return readQuickSummary(agentId);
    },
  ));

  // Finished quick agents (#2467). Every window, and Annex, hears each change.
  onFinishedQuickAgentsChange((change) => broadcastToAllWindows(IPC.AGENT.FINISHED_QUICK_CHANGED, change));

  ipcMain.handle(IPC.AGENT.FINISHED_QUICK_HYDRATE, withValidatedArgs([objectArg()], (_event, legacy: unknown) =>
    hydrateFinishedQuickAgents(legacy),
  ));

  ipcMain.handle(IPC.AGENT.FINISHED_QUICK_APPLY, withValidatedArgs(
    [stringArg({ maxLength: 128 }), numberArg({ integer: true, min: 1 }), objectArg()],
    (_event, clientId: string, seq: number, rawOp: unknown) => {
      const op = parseFinishedQuickAgentOp(rawOp);
      if (!op) throw new Error('Invalid finished quick agent op');
      applyFinishedQuickAgentChange(op, { clientId, seq });
    },
  ));

  ipcMain.handle(IPC.AGENT.GET_MODEL_OPTIONS, withValidatedArgs(
    [stringArg(), stringArg({ optional: true })],
    async (_event, projectPath, orchestrator) => {
      const provider = await agentSystem.resolveOrchestrator(projectPath, orchestrator);
      // A profile can change the CLI's login, and so the models it lists (#2569).
      const env = await agentSystem.resolveProfileEnv(projectPath, provider.id);
      return provider.getModelOptions(env ? { env } : undefined);
    },
  ));

  ipcMain.handle(IPC.AGENT.GET_CONTEXT_WINDOW_OPTIONS, withValidatedArgs(
    [stringArg(), stringArg({ optional: true }), stringArg({ optional: true })],
    async (_event, projectPath, orchestrator, model) => contextWindowOptionsFor(projectPath, orchestrator, model),
  ));

  ipcMain.handle(IPC.AGENT.CHECK_ORCHESTRATOR, withValidatedArgs(
    [stringArg({ optional: true }), stringArg({ optional: true })],
    async (_event, projectPath, orchestrator) => {
      return agentSystem.checkAvailability(projectPath, orchestrator);
    },
  ));

  ipcMain.handle(IPC.AGENT.GET_ORCHESTRATORS, async () => {
    return agentSystem.getAvailableOrchestrators();
  });

  ipcMain.handle(IPC.AGENT.GET_TOOL_VERB, withValidatedArgs(
    [stringArg(), stringArg(), stringArg({ optional: true })],
    async (_event, toolName, projectPath, orchestrator) => {
      const provider = await agentSystem.resolveOrchestrator(projectPath, orchestrator);
      return provider.toolVerb(toolName) || `Using ${toolName}`;
    },
  ));

  ipcMain.handle(IPC.AGENT.GET_SUMMARY_INSTRUCTION, withValidatedArgs(
    [stringArg()],
    async (_event, agentId) => {
      return buildSummaryInstruction(agentId);
    },
  ));

  ipcMain.handle(IPC.AGENT.READ_TRANSCRIPT, withValidatedArgs(
    [stringArg()],
    async (_event, agentId) => {
      return headlessManager.readTranscript(agentId);
    },
  ));

  ipcMain.handle(IPC.AGENT.GET_TRANSCRIPT_INFO, withValidatedArgs(
    [stringArg()],
    async (_event, agentId) => {
      return headlessManager.getTranscriptInfo(agentId);
    },
  ));

  ipcMain.handle(IPC.AGENT.READ_TRANSCRIPT_PAGE, withValidatedArgs(
    [stringArg(), numberArg({ integer: true, min: 0 }), numberArg({ integer: true, min: 1 })],
    async (_event, agentId, offset, limit) => {
      return headlessManager.readTranscriptPage(agentId, offset, limit);
    },
  ));

  ipcMain.handle(IPC.AGENT.READ_TRANSCRIPT_FROM, withValidatedArgs(
    [stringArg(), numberArg({ integer: true, min: 0 })],
    async (_event, agentId, cursor) => {
      return headlessManager.readTranscriptFrom(agentId, cursor);
    },
  ));

  ipcMain.handle(IPC.AGENT.IS_HEADLESS_AGENT, withValidatedArgs(
    [stringArg()],
    async (_event, agentId) => {
      return agentSystem.isHeadlessAgent(agentId);
    },
  ));

  // --- Session management handlers ---

  ipcMain.handle(
    IPC.AGENT.LIST_SESSIONS,
    withValidatedArgs(
      [stringArg(), stringArg(), stringArg({ optional: true })],
      async (_event, projectPath, agentId, orchestrator) => {
        return agentSystem.listSessions(projectPath, agentId, orchestrator);
      },
    ),
  );

  ipcMain.handle(
    IPC.AGENT.UPDATE_SESSION_NAME,
    withValidatedArgs(
      [stringArg(), stringArg(), stringArg(), stringArg({ optional: true })],
      async (_event, projectPath, agentId, sessionId, friendlyName) => {
        return agentConfig.updateSessionName(projectPath, agentId, sessionId, friendlyName ?? null);
      },
    ),
  );

  // --- Session transcript handlers ---

  ipcMain.handle(
    IPC.AGENT.READ_SESSION_TRANSCRIPT,
    withValidatedArgs(
      [stringArg(), stringArg(), stringArg(), numberArg({ integer: true, min: 0 }), numberArg({ integer: true, min: 1 }), stringArg({ optional: true })],
      async (_event, projectPath, agentId, sessionId, offset, limit, orchestrator) => {
        try {
          const config = await agentConfig.getDurableConfig(projectPath, agentId);
          const provider = await agentSystem.resolveOrchestrator(projectPath, orchestrator || config?.orchestrator);
          if (!isSessionCapable(provider)) return null;
          const cwd = config?.worktreePath || projectPath;
          // Pass profileEnv so the provider resolves the correct config directory
          const profileEnv = await agentSystem.resolveProfileEnv(projectPath, provider.id);
          const rawEvents = await provider.readSessionTranscript(sessionId, cwd, profileEnv);
          if (!rawEvents) return null;
          const events = normalizeSessionEvents(rawEvents);
          return paginateEvents(events, offset, limit);
        } catch (err) {
          appLog('core:ipc', 'warn', 'Failed to read session transcript', {
            meta: { agentId, sessionId, error: err instanceof Error ? err.message : String(err) },
          });
          return null;
        }
      },
    ),
  );

  ipcMain.handle(
    IPC.AGENT.GET_SESSION_SUMMARY,
    withValidatedArgs(
      [stringArg(), stringArg(), stringArg(), stringArg({ optional: true })],
      async (_event, projectPath, agentId, sessionId, orchestrator) => {
        // Local per-stage timing (#2277): counts and durations only, never content or paths
        const timing: Record<string, unknown> = {};
        const start = performance.now();
        let mark = start;
        const lap = () => { const now = performance.now(); const ms = Math.round(now - mark); mark = now; return ms; };
        try {
          const config = await agentConfig.getDurableConfig(projectPath, agentId);
          const provider = await agentSystem.resolveOrchestrator(projectPath, orchestrator || config?.orchestrator);
          timing.provider = provider?.id;
          if (!isSessionCapable(provider)) return null;
          const cwd = config?.worktreePath || projectPath;
          // Pass profileEnv so the provider resolves the correct config directory
          const profileEnv = await agentSystem.resolveProfileEnv(projectPath, provider.id);
          timing.resolveMs = lap();
          const stats: TranscriptReadStats = {};
          const rawEvents = await provider.readSessionTranscript(sessionId, cwd, profileEnv, { maxBytes: SUMMARY_TRANSCRIPT_MAX_BYTES, stats });
          timing.transcriptMs = lap();
          Object.assign(timing, roundStats(stats));
          if (!rawEvents) return null;
          timing.rawEvents = rawEvents.length;
          const events = normalizeSessionEvents(rawEvents);
          const summary = buildSessionSummary(events, provider.id);
          timing.summarizeMs = lap();
          return summary;
        } catch (err) {
          timing.failed = true;
          appLog('core:ipc', 'warn', 'Failed to get session summary', {
            meta: { agentId, sessionId, error: err instanceof Error ? err.message : String(err) },
          });
          return null;
        } finally {
          timing.totalMs = Math.round(performance.now() - start);
          appLog('core:ipc', 'debug', 'Session summary timing', { meta: timing });
        }
      },
    ),
  );

  // ── Durable (PTY) agent permission queue ───────────────────────────
  // Desktop-local approve/deny for hook-driven permission requests. Before
  // this existed the queue could only be resolved by a connected Annex/iOS
  // client, so durable agents stalled for the full queue timeout and then
  // re-prompted forever (issue #1553).

  ipcMain.handle(IPC.AGENT.LIST_PENDING_PERMISSIONS, withValidatedArgs(
    [stringArg({ optional: true })],
    async (_event, agentId) => (
      agentId === undefined
        ? permissionQueue.listPending()
        : permissionQueue.listPendingForAgent(agentId)
    ),
  ));

  ipcMain.handle(IPC.AGENT.RESOLVE_PENDING_PERMISSION, withValidatedArgs(
    [stringArg(), stringArg(), stringArg()],
    async (_event, agentId, requestId, decision) => {
      // `decision` is validated as a non-empty string by withValidatedArgs;
      // narrow it to the two legal values before it reaches the queue.
      if (decision !== 'allow' && decision !== 'deny') {
        appLog('core:ipc', 'warn', 'Rejected permission decision (invalid value)', {
          meta: { agentId, requestId, decision },
        });
        return { status: 'rejected' as const, reason: 'invalid_decision' as const };
      }

      // The agent must still be registered with a live hook session. A
      // requestId for an agent this app no longer owns is not resolvable.
      if (!agentRegistry.get(agentId)) {
        appLog('core:ipc', 'warn', 'Rejected permission decision (unknown agent)', {
          meta: { agentId, requestId, decision },
        });
        return { status: 'rejected' as const, reason: 'unknown_agent' as const };
      }

      // expectedAgentId binds the requestId to the claimed agent, so a stray
      // or guessed requestId can't approve a different agent's tool call.
      return permissionQueue.resolvePermissionDetailed(requestId, decision, {
        expectedAgentId: agentId,
        source: 'desktop',
      });
    },
  ));

  // ── Backup & recovery ──────────────────────────────────────────────

  ipcMain.handle(IPC.AGENT.GET_BACKUP_INFO, withValidatedArgs(
    [stringArg()],
    async (_event, projectPath) => {
      return agentConfig.getBackupInfo(projectPath);
    },
  ));

  ipcMain.handle(IPC.AGENT.RESTORE_FROM_BACKUP, withValidatedArgs(
    [stringArg()],
    async (_event, projectPath) => {
      const result = await agentConfig.restoreFromBackup(projectPath);
      if (result.restoredCount > 0) broadcastSnapshotRefresh();
      return result;
    },
  ));

  // ── Companion agent handlers (v0.9+) ───────────────────────────────

  // Track companion agents by plugin ID (singleton enforcement)
  const companionAgents = new Map<string, string>();

  ipcMain.handle(IPC.AGENT.SPAWN_COMPANION, withValidatedArgs(
    [stringArg(), objectArg({ optional: true })],
    async (_event, pluginId, options?: { model?: string; systemPrompt?: string }) => {
      const companionWs = await import('../services/companion-workspace');
      const wsPath = await companionWs.ensureCompanionWorkspace(pluginId);

      // Check if a companion agent already exists for this plugin
      const existingId = companionAgents.get(pluginId);
      if (existingId && agentRegistry.get(existingId)) {
        appLog('core:companion', 'info', `Companion agent already exists for ${pluginId}: ${existingId}`);
        return existingId;
      }

      // Create new companion agent
      const agentId = `companion-${pluginId}-${Date.now()}`;
      await agentSystem.spawnAgent({
        agentId,
        projectPath: wsPath,
        cwd: wsPath,
        kind: 'companion',
        model: options?.model,
        systemPrompt: options?.systemPrompt,
        pluginOwner: pluginId,
        companionWorkspace: wsPath,
      });

      companionAgents.set(pluginId, agentId);
      return agentId;
    },
  ));

  ipcMain.handle(IPC.AGENT.GET_COMPANION_STATUS, withValidatedArgs(
    [stringArg()],
    async (_event, pluginId) => {
      const existingId = companionAgents.get(pluginId);
      if (!existingId) return 'none';
      const reg = agentRegistry.get(existingId);
      return reg ? 'active' : 'sleeping';
    },
  ));

  ipcMain.handle(IPC.AGENT.GET_COMPANION_WORKSPACE, withValidatedArgs(
    [stringArg()],
    async (_event, pluginId) => {
      const companionWs = await import('../services/companion-workspace');
      return companionWs.getCompanionWorkspacePath(pluginId);
    },
  ));
}
