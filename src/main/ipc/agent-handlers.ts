import * as fsp from 'fs/promises';
import * as path from 'path';
import { ipcMain, dialog, BrowserWindow } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { SpawnAgentParams } from '../../shared/types';
import { isSessionCapable, type OrchestratorId } from '../orchestrators';
import * as agentConfig from '../services/agent-config';
import * as agentSystem from '../services/agent-system';
import { agentRegistry } from '../services/agent-registry';
import * as headlessManager from '../services/headless-manager';
import { buildSummaryInstruction, readQuickSummary } from '../orchestrators/shared';
import { normalizeSessionEvents, buildSessionSummary, paginateEvents } from '../services/session-reader';
import { appLog } from '../services/log-service';
import { broadcastSnapshotRefresh } from '../services/annex-server';
import { bindingManager } from '../services/clubhouse-mcp/binding-manager';
import { refreshClubhouseModeReadme } from '../services/materialization-service';
import { applyPersonaToAgent } from '../services/persona-application';
import * as orchestrationPolicy from '../services/orchestration-policy';
import * as clubhouseModeSettings from '../services/clubhouse-mode-settings';
import * as permissionQueue from '../services/annex-permission-queue';
import { withValidatedArgs, stringArg, objectArg, arrayArg, numberArg, booleanArg } from './validation';
import { ATTR } from '../../shared/telemetry/attributes';
import type { DeleteResult, HelperDisposeChecks, HelperDisposeDecision, HelperDisposeResult } from '../../shared/types';
import { getAgentRuntime } from '../services/agent-runtime';
import { takeDisposeRequest } from '../services/helper-dispose-requests';
import { tel, tagError, withErrorType } from '../telemetry/facade';
import { orchestratorAttr } from '../telemetry/spawn-telemetry';
import { assertAgentGitName } from '../../shared/agent-name';
import { isDisposedAgent } from '../../shared/agent-helpers';
import type { DurableWorktreeOptions, StartDurableCreationParams } from '../../shared/types';
import { cancelDurableCreation, onDurableCreationEvent, startDurableCreation } from '../services/agent-creation';
import { broadcastToAllWindows } from '../util/ipc-broadcast';

type DeleteMode = Parameters<typeof ATTR.deleteMode>[0];

/** Work disposing would lose. A check that couldn't run is handled on its own: force never overrides it. */
function workAtRisk(checks: HelperDisposeChecks): boolean {
  return checks.dirty > 0 || checks.unpushed > 0;
}

/** More at risk now than the user saw: a failed check, or more dirty files or unpushed commits. */
function worseThan(now: HelperDisposeChecks, seen: HelperDisposeChecks): boolean {
  return (!!now.error && !seen.error) || now.dirty > seen.dirty || now.unpushed > seen.unpushed;
}

/**
 * Dispose a helper for the user (#2232), in the dispose_helper tool's order:
 * check; refuse a failed check, or work at risk without force, before
 * stopping anything; stop it if main has it running (never the renderer's
 * status, which can be stale) and wait for the exit; check again, and refuse
 * with `changed` when more is at risk than the user confirmed; then dispose.
 * Runs under the orchestrator's policy lock, as the tool and turn-off do.
 */
export async function disposeHelperForUser(
  projectPath: string,
  helperId: string,
  options: { force: boolean; seen?: HelperDisposeChecks },
): Promise<HelperDisposeResult> {
  const config = await agentConfig.getDurableConfig(projectPath, helperId);
  if (!config) return { ok: false, message: 'Agent not found' };
  const parentId = config.parentAgentId;
  if (!parentId) return { ok: false, message: `${config.name} isn't a helper` };
  return orchestrationPolicy.withAgentLock(projectPath, parentId, async () => {
    const checks = await agentConfig.getDisposeChecks(projectPath, helperId);
    if (checks.error) {
      return { ok: false, message: `${config.name} wasn't disposed (${checks.error})`, checks };
    }
    if (workAtRisk(checks) && !options.force) {
      return { ok: false, message: `${config.name} has work that disposing would lose`, checks };
    }
    const seen = options.seen ?? checks;
    if (worseThan(checks, seen)) {
      return { ok: false, changed: true, message: `${config.name} has more unsaved work than when you confirmed`, checks };
    }

    let stopped = false;
    if (agentSystem.isAgentRunning(helperId)) {
      // It holds its worktree open while it runs (EBUSY on Windows).
      await agentSystem.killAgent(helperId, projectPath, undefined, 'user', { waitForExit: true });
      stopped = true;
      const after = await agentConfig.getDisposeChecks(projectPath, helperId);
      if (after.error || worseThan(after, seen)) {
        return {
          ok: false,
          changed: true,
          stopped,
          message: after.error
            ? `${config.name} was stopped, then couldn't be checked (${after.error})`
            : `${config.name} saved more work before it stopped`,
          checks: after,
        };
      }
    }

    const result = await agentConfig.disposeHelper(projectPath, helperId, { force: options.force, expectedParentId: parentId });
    return { ok: result.ok, message: result.message, ...(result.checks ? { checks: result.checks } : {}), ...(stopped ? { stopped } : {}) };
  });
}

/**
 * Tell an orchestrator what the user decided about the dispose it asked for
 * (#2229 ask-everything), through its runtime as the helper tools do. Main
 * picks the orchestrator (the helper's parent) and the text; the renderer
 * only names the helper and the decision. Refused unless main sent that
 * parent's request for this helper, and each request is answered once.
 */
export async function reportDisposeDecision(
  projectPath: string,
  helperId: string,
  decision: HelperDisposeDecision,
): Promise<{ ok: boolean; delivered: boolean; message: string }> {
  const config = await agentConfig.getDurableConfig(projectPath, helperId);
  if (!config) return { ok: false, delivered: false, message: 'Agent not found' };
  const parentId = config.parentAgentId;
  if (!parentId) return { ok: false, delivered: false, message: `${config.name} isn't a helper` };
  if (!takeDisposeRequest(projectPath, helperId, parentId)) {
    return { ok: false, delivered: false, message: `No dispose request for ${config.name} is waiting on the user` };
  }
  const runtime = getAgentRuntime(parentId);
  if (!runtime) return { ok: true, delivered: false, message: 'The orchestrator isn\'t running' };
  const text = decision === 'disposed'
    ? `[Clubhouse] The user approved your request and disposed of ${config.name}.`
    : `[Clubhouse] The user declined your request to dispose of ${config.name}. Nothing was changed.`;
  try {
    await runtime.sendMessage(text, { source: 'mcp', taskId: `dispose_${Date.now().toString(36)}` });
    return { ok: true, delivered: true, message: 'Reported' };
  } catch (err) {
    // telemetry-exempt: logged; the user's decision already stands
    const message = err instanceof Error ? err.message : String(err);
    appLog('core:orchestration', 'warn', 'Dispose decision not delivered', { meta: { orchestratorId: parentId, error: message } });
    return { ok: true, delivered: false, message };
  }
}

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


/**
 * Apply the persona (layered project > user > built-in lookup, plus any
 * front-matter settings) the same way "Apply persona" does, keeping the
 * project-default instructions the worktree was just seeded with. Failures are
 * logged, not thrown. Returns true when the persona was applied.
 */
async function injectPersona(projectPath: string, agentId: string, persona: string, agentName: string): Promise<boolean> {
  try {
    await tel.step('clubhouse.agent.persona_inject', () =>
      applyPersonaToAgent(projectPath, agentId, persona, { appendToExisting: true }));
    return true;
  } catch (err) {
    appLog('agents', 'warn', 'Failed to inject persona instructions on create', {
      meta: { agentName, persona, error: err instanceof Error ? err.message : String(err) },
    });
    return false;
  }
}

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

function optionalString(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`params.${key} must be a string`);
  return value;
}

function optionalBoolean(raw: Record<string, unknown>, key: string): boolean | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`params.${key} must be a boolean`);
  return value;
}

/** Validate the fields of a START_DURABLE_CREATION request; the folder and branch fields are checked again by agent-config (#2221). */
function parseWorktreeOptions(raw: Record<string, unknown>): DurableWorktreeOptions {
  const folderName = optionalString(raw, 'folderName');
  const branchName = optionalString(raw, 'branchName');
  const branchFrom = optionalString(raw, 'branchFrom');
  return {
    ...(folderName !== undefined ? { folderName } : {}),
    ...(branchName !== undefined ? { branchName } : {}),
    ...(branchFrom !== undefined ? { branchFrom } : {}),
  };
}

export function parseStartCreationParams(raw: Record<string, unknown>): StartDurableCreationParams {
  const name = raw.name;
  const color = raw.color;
  if (typeof name !== 'string' || name.length === 0) throw new Error('params.name must be a non-empty string');
  if (typeof color !== 'string' || color.length === 0) throw new Error('params.color must be a non-empty string');
  const mcpIds = raw.mcpIds;
  if (mcpIds !== undefined && (!Array.isArray(mcpIds) || mcpIds.some((id) => typeof id !== 'string'))) {
    throw new Error('params.mcpIds must be an array of strings');
  }
  const mcpConfigs = raw.mcpConfigs;
  if (mcpConfigs !== undefined && (typeof mcpConfigs !== 'object' || mcpConfigs === null || Array.isArray(mcpConfigs))) {
    throw new Error('params.mcpConfigs must be an object');
  }
  const model = optionalString(raw, 'model');
  return {
    name,
    color,
    ...(model !== undefined && model !== 'default' ? { model } : {}),
    useWorktree: optionalBoolean(raw, 'useWorktree'),
    orchestrator: optionalString(raw, 'orchestrator') as OrchestratorId | undefined,
    freeAgentMode: optionalBoolean(raw, 'freeAgentMode'),
    mcpIds: mcpIds as string[] | undefined,
    mcpConfigs: mcpConfigs as Record<string, Record<string, string>> | undefined,
    persona: optionalString(raw, 'persona'),
    parentAgentId: optionalString(raw, 'parentAgentId'),
    disposable: optionalBoolean(raw, 'disposable'),
    ...parseWorktreeOptions(raw),
  };
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

export function registerAgentHandlers(): void {
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
        () => createDurableAgent(
          projectPath, name, color, model, useWorktree, orchestrator, freeAgentMode, mcpIds,
          mcpConfigs as Record<string, Record<string, string>> | undefined, persona,
          worktreeOptions ? parseWorktreeOptions(worktreeOptions) : undefined,
        ),
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
      const { persona, name } = params;
      const { agentId, config } = await startDurableCreation(projectPath, params, {
        inject: persona
          ? async (created) => { if (created.worktreePath) await injectPersona(projectPath, created.id, persona, name); }
          : undefined,
      });
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
    [stringArg(), stringArg(), stringArg({ maxLength: 5 * 1024 * 1024 })],
    async (_event, projectPath, agentId, dataUrl) => {
      return agentConfig.saveAgentIcon(projectPath, agentId, dataUrl);
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
      const result = await deleteFlow('commit_push', () => agentConfig.deleteCommitAndPush(projectPath, agentId));
      if (result.ok) broadcastSnapshotRefresh();
      return result;
    },
  ));

  ipcMain.handle(IPC.AGENT.DELETE_CLEANUP_BRANCH, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, projectPath, agentId) => {
      const result = await deleteFlow('cleanup_branch', () => agentConfig.deleteWithCleanupBranch(projectPath, agentId));
      if (result.ok) broadcastSnapshotRefresh();
      return result;
    },
  ));

  ipcMain.handle(IPC.AGENT.DELETE_SAVE_PATCH, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, projectPath, agentId) => {
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
      const result = await deleteFlow('force', () => agentConfig.deleteForce(projectPath, agentId));
      if (result.ok) broadcastSnapshotRefresh();
      return result;
    },
  ));

  ipcMain.handle(IPC.AGENT.DELETE_UNREGISTER, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, projectPath, agentId) => {
      const result = await deleteFlow('unregister', () => agentConfig.deleteUnregister(projectPath, agentId));
      if (result.ok) broadcastSnapshotRefresh();
      return result;
    },
  ));

  // --- Helpers (#2224) ---

  ipcMain.handle(IPC.AGENT.LIST_HELPERS, withValidatedArgs(
    [stringArg(), stringArg(), booleanArg({ optional: true })],
    async (_event, projectPath, agentId, recursive) => agentConfig.listHelpers(projectPath, agentId, { recursive }),
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
      const result = await orchestrationPolicy.setOrchestrationPolicy(projectPath, agentId, patch);
      if (result.ok) broadcastSnapshotRefresh();
      return result;
    },
  ));

  ipcMain.handle(IPC.AGENT.TURN_OFF_ORCHESTRATION, withValidatedArgs(
    [stringArg(), stringArg(), stringArg(), booleanArg({ optional: true })],
    async (_event, projectPath, agentId, choice, force) => {
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

  ipcMain.handle(IPC.AGENT.GET_MODEL_OPTIONS, withValidatedArgs(
    [stringArg(), stringArg({ optional: true })],
    async (_event, projectPath, orchestrator) => {
      const provider = await agentSystem.resolveOrchestrator(projectPath, orchestrator);
      return provider.getModelOptions();
    },
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
          return buildSessionSummary(events, provider.id);
        } catch (err) {
          appLog('core:ipc', 'warn', 'Failed to get session summary', {
            meta: { agentId, sessionId, error: err instanceof Error ? err.message : String(err) },
          });
          return null;
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
