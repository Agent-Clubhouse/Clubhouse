import * as fsp from 'fs/promises';
import * as path from 'path';
import { ipcMain, dialog, BrowserWindow } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { SpawnAgentParams } from '../../shared/types';
import { StructuredSessionOpts } from '../orchestrators/types';
import { isSessionCapable, isStructuredCapable } from '../orchestrators';
import * as agentConfig from '../services/agent-config';
import * as agentSystem from '../services/agent-system';
import * as headlessManager from '../services/headless-manager';
import * as structuredManager from '../services/structured-manager';
import { buildSummaryInstruction, readQuickSummary } from '../orchestrators/shared';
import { normalizeSessionEvents, buildSessionSummary, paginateEvents } from '../services/session-reader';
import { appLog } from '../services/log-service';
import { broadcastSnapshotRefresh } from '../services/annex-server';
import { bindingManager } from '../services/clubhouse-mcp/binding-manager';
import { withValidatedArgs, stringArg, objectArg, arrayArg, numberArg, booleanArg } from './validation';

type DurableConfigUpdates = Parameters<typeof agentConfig.updateDurableConfig>[2];

export function registerAgentHandlers(): void {
  ipcMain.handle(IPC.AGENT.LIST_DURABLE, withValidatedArgs(
    [stringArg()],
    async (_event, projectPath) => {
      return agentConfig.listDurable(projectPath);
    },
  ));

  ipcMain.handle(
    IPC.AGENT.CREATE_DURABLE,
    withValidatedArgs(
      [stringArg(), stringArg(), stringArg(), stringArg({ optional: true }), booleanArg({ optional: true }), stringArg({ optional: true }), booleanArg({ optional: true }), arrayArg(stringArg(), { optional: true })],
      async (_event, projectPath, name, color, model, useWorktree, orchestrator, freeAgentMode, mcpIds) => {
        const config = await agentConfig.createDurable(projectPath, name, color, model, useWorktree, orchestrator, freeAgentMode, mcpIds);
        broadcastSnapshotRefresh();
        return config;
      },
    ),
  );

  ipcMain.handle(IPC.AGENT.DELETE_DURABLE, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, projectPath, agentId) => {
      const result = await agentConfig.deleteDurable(projectPath, agentId);
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
      [stringArg(), stringArg(), objectArg<{ name?: string; color?: string; icon?: string | null }>()],
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
    [stringArg(), stringArg(), stringArg()],
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
      const result = await agentConfig.deleteCommitAndPush(projectPath, agentId);
      if (result.ok) broadcastSnapshotRefresh();
      return result;
    },
  ));

  ipcMain.handle(IPC.AGENT.DELETE_CLEANUP_BRANCH, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, projectPath, agentId) => {
      const result = await agentConfig.deleteWithCleanupBranch(projectPath, agentId);
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

      const deleteResult = await agentConfig.deleteSaveAsPatch(projectPath, agentId, result.filePath);
      if (deleteResult.ok) broadcastSnapshotRefresh();
      return deleteResult;
    },
  ));

  ipcMain.handle(IPC.AGENT.DELETE_FORCE, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, projectPath, agentId) => {
      const result = await agentConfig.deleteForce(projectPath, agentId);
      if (result.ok) broadcastSnapshotRefresh();
      return result;
    },
  ));

  ipcMain.handle(IPC.AGENT.DELETE_UNREGISTER, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, projectPath, agentId) => {
      const result = await agentConfig.deleteUnregister(projectPath, agentId);
      if (result.ok) broadcastSnapshotRefresh();
      return result;
    },
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
    [stringArg(), stringArg()],
    async (_event, agentId, projectPath) => {
      await agentSystem.killAgent(agentId, projectPath);
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

  // --- Structured mode handlers ---

  ipcMain.handle(IPC.AGENT.START_STRUCTURED, withValidatedArgs(
    [stringArg(), objectArg<StructuredSessionOpts>()],
    async (_event, agentId, opts) => {
      try {
        const orchestratorId = agentSystem.getAgentOrchestrator(agentId);
        const projectPath = agentSystem.getAgentProjectPath(agentId);
        if (!projectPath) throw new Error(`No project path found for agent ${agentId}`);

        const provider = await agentSystem.resolveOrchestrator(projectPath, orchestratorId);
        if (!isStructuredCapable(provider)) {
          throw new Error(`${provider.displayName} does not support structured mode`);
        }

        const adapter = provider.createStructuredAdapter();
        await structuredManager.startStructuredSession(agentId, adapter, opts);
      } catch (err) {
        appLog('core:ipc', 'error', 'Structured session start failed', {
          meta: { agentId, error: err instanceof Error ? err.message : String(err) },
        });
        throw err;
      }
    },
  ));

  ipcMain.handle(IPC.AGENT.CANCEL_STRUCTURED, withValidatedArgs(
    [stringArg()],
    async (_event, agentId) => {
      await structuredManager.cancelSession(agentId);
    },
  ));

  ipcMain.handle(IPC.AGENT.SEND_STRUCTURED_MESSAGE, withValidatedArgs(
    [stringArg(), stringArg({ minLength: 0 })],
    async (_event, agentId, message) => {
      await structuredManager.sendMessage(agentId, message);
    },
  ));

  ipcMain.handle(
    IPC.AGENT.RESPOND_PERMISSION,
    withValidatedArgs(
      [stringArg(), stringArg(), booleanArg(), stringArg({ optional: true })],
      async (_event, agentId, requestId, approved, reason) => {
        await structuredManager.respondToPermission(agentId, requestId, approved, reason);
      },
    ),
  );
}
