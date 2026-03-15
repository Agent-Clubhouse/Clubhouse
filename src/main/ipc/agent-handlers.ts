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

type DurableConfigUpdates = Parameters<typeof agentConfig.updateDurableConfig>[2];

export function registerAgentHandlers(): void {
  ipcMain.handle(IPC.AGENT.LIST_DURABLE, async (_event, projectPath: string) => {
    return agentConfig.listDurable(projectPath);
  });

  ipcMain.handle(
    IPC.AGENT.CREATE_DURABLE,
    async (_event, projectPath: string, name: string, color: string, model?: string, useWorktree?: boolean, orchestrator?: string, freeAgentMode?: boolean, mcpIds?: string[]) => {
      return agentConfig.createDurable(projectPath, name, color, model, useWorktree, orchestrator, freeAgentMode, mcpIds);
    }
  );

  ipcMain.handle(IPC.AGENT.DELETE_DURABLE, async (_event, projectPath: string, agentId: string) => {
    return agentConfig.deleteDurable(projectPath, agentId);
  });

  ipcMain.handle(IPC.AGENT.RENAME_DURABLE, async (_event, projectPath: string, agentId: string, newName: string) => {
    return agentConfig.renameDurable(projectPath, agentId, newName);
  });

  ipcMain.handle(
    IPC.AGENT.UPDATE_DURABLE,
    async (_event, projectPath: string, agentId: string, updates: { name?: string; color?: string; icon?: string | null }) => {
      return agentConfig.updateDurable(projectPath, agentId, updates);
    }
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

  ipcMain.handle(IPC.AGENT.SAVE_ICON, async (_event, projectPath: string, agentId: string, dataUrl: string) => {
    return agentConfig.saveAgentIcon(projectPath, agentId, dataUrl);
  });

  ipcMain.handle(IPC.AGENT.READ_ICON, async (_event, filename: string) => {
    return agentConfig.readAgentIconData(filename);
  });

  ipcMain.handle(IPC.AGENT.REMOVE_ICON, async (_event, projectPath: string, agentId: string) => {
    return agentConfig.removeAgentIcon(projectPath, agentId);
  });

  ipcMain.handle(IPC.AGENT.GET_DURABLE_CONFIG, async (_event, projectPath: string, agentId: string) => {
    return agentConfig.getDurableConfig(projectPath, agentId);
  });

  ipcMain.handle(IPC.AGENT.UPDATE_DURABLE_CONFIG, async (_event, projectPath: string, agentId: string, updates: DurableConfigUpdates) => {
    return agentConfig.updateDurableConfig(projectPath, agentId, updates);
  });

  ipcMain.handle(IPC.AGENT.REORDER_DURABLE, async (_event, projectPath: string, orderedIds: string[]) => {
    return agentConfig.reorderDurable(projectPath, orderedIds);
  });

  ipcMain.handle(IPC.AGENT.GET_WORKTREE_STATUS, async (_event, projectPath: string, agentId: string) => {
    return agentConfig.getWorktreeStatus(projectPath, agentId);
  });

  ipcMain.handle(IPC.AGENT.DELETE_COMMIT_PUSH, async (_event, projectPath: string, agentId: string) => {
    return agentConfig.deleteCommitAndPush(projectPath, agentId);
  });

  ipcMain.handle(IPC.AGENT.DELETE_CLEANUP_BRANCH, async (_event, projectPath: string, agentId: string) => {
    return agentConfig.deleteWithCleanupBranch(projectPath, agentId);
  });

  ipcMain.handle(IPC.AGENT.DELETE_SAVE_PATCH, async (_event, projectPath: string, agentId: string) => {
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

    return agentConfig.deleteSaveAsPatch(projectPath, agentId, result.filePath);
  });

  ipcMain.handle(IPC.AGENT.DELETE_FORCE, async (_event, projectPath: string, agentId: string) => {
    return agentConfig.deleteForce(projectPath, agentId);
  });

  ipcMain.handle(IPC.AGENT.DELETE_UNREGISTER, async (_event, projectPath: string, agentId: string) => {
    return agentConfig.deleteUnregister(projectPath, agentId);
  });

  // --- Orchestrator-based handlers ---

  ipcMain.handle(IPC.AGENT.SPAWN_AGENT, async (_event, params: SpawnAgentParams) => {
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
  });

  ipcMain.handle(IPC.AGENT.KILL_AGENT, async (_event, agentId: string, projectPath: string) => {
    await agentSystem.killAgent(agentId, projectPath);
  });

  ipcMain.handle(IPC.AGENT.READ_QUICK_SUMMARY, async (_event, agentId: string) => {
    return readQuickSummary(agentId);
  });

  ipcMain.handle(IPC.AGENT.GET_MODEL_OPTIONS, async (_event, projectPath: string, orchestrator?: string) => {
    const provider = await agentSystem.resolveOrchestrator(projectPath, orchestrator);
    return provider.getModelOptions();
  });

  ipcMain.handle(IPC.AGENT.CHECK_ORCHESTRATOR, async (_event, projectPath?: string, orchestrator?: string) => {
    return agentSystem.checkAvailability(projectPath, orchestrator);
  });

  ipcMain.handle(IPC.AGENT.GET_ORCHESTRATORS, async () => {
    return agentSystem.getAvailableOrchestrators();
  });

  ipcMain.handle(IPC.AGENT.GET_TOOL_VERB, async (_event, toolName: string, projectPath: string, orchestrator?: string) => {
    const provider = await agentSystem.resolveOrchestrator(projectPath, orchestrator);
    return provider.toolVerb(toolName) || `Using ${toolName}`;
  });

  ipcMain.handle(IPC.AGENT.GET_SUMMARY_INSTRUCTION, async (_event, agentId: string) => {
    return buildSummaryInstruction(agentId);
  });

  ipcMain.handle(IPC.AGENT.READ_TRANSCRIPT, async (_event, agentId: string) => {
    return headlessManager.readTranscript(agentId);
  });

  ipcMain.handle(IPC.AGENT.GET_TRANSCRIPT_INFO, async (_event, agentId: string) => {
    return headlessManager.getTranscriptInfo(agentId);
  });

  ipcMain.handle(IPC.AGENT.READ_TRANSCRIPT_PAGE, async (_event, agentId: string, offset: number, limit: number) => {
    return headlessManager.readTranscriptPage(agentId, offset, limit);
  });

  ipcMain.handle(IPC.AGENT.IS_HEADLESS_AGENT, async (_event, agentId: string) => {
    return agentSystem.isHeadlessAgent(agentId);
  });

  // --- Session management handlers ---

  ipcMain.handle(
    IPC.AGENT.LIST_SESSIONS,
    async (_event, projectPath: string, agentId: string, orchestrator?: string) => {
      return agentSystem.listSessions(projectPath, agentId, orchestrator);
    }
  );

  ipcMain.handle(
    IPC.AGENT.UPDATE_SESSION_NAME,
    async (_event, projectPath: string, agentId: string, sessionId: string, friendlyName: string | null) => {
      return agentConfig.updateSessionName(projectPath, agentId, sessionId, friendlyName);
    }
  );

  // --- Session transcript handlers ---

  ipcMain.handle(
    IPC.AGENT.READ_SESSION_TRANSCRIPT,
    async (_event, projectPath: string, agentId: string, sessionId: string, offset: number, limit: number, orchestrator?: string) => {
      try {
        const provider = await agentSystem.resolveOrchestrator(projectPath, orchestrator);
        if (!isSessionCapable(provider)) return null;
        const config = await agentConfig.getDurableConfig(projectPath, agentId);
        const cwd = config?.worktreePath || projectPath;
        const rawEvents = await provider.readSessionTranscript(sessionId, cwd);
        if (!rawEvents) return null;
        const events = normalizeSessionEvents(rawEvents);
        return paginateEvents(events, offset, limit);
      } catch (err) {
        appLog('core:ipc', 'warn', 'Failed to read session transcript', {
          meta: { agentId, sessionId, error: err instanceof Error ? err.message : String(err) },
        });
        return null;
      }
    }
  );

  ipcMain.handle(
    IPC.AGENT.GET_SESSION_SUMMARY,
    async (_event, projectPath: string, agentId: string, sessionId: string, orchestrator?: string) => {
      try {
        const provider = await agentSystem.resolveOrchestrator(projectPath, orchestrator);
        if (!isSessionCapable(provider)) return null;
        const config = await agentConfig.getDurableConfig(projectPath, agentId);
        const cwd = config?.worktreePath || projectPath;
        const rawEvents = await provider.readSessionTranscript(sessionId, cwd);
        if (!rawEvents) return null;
        const events = normalizeSessionEvents(rawEvents);
        return buildSessionSummary(events, provider.id);
      } catch (err) {
        appLog('core:ipc', 'warn', 'Failed to get session summary', {
          meta: { agentId, sessionId, error: err instanceof Error ? err.message : String(err) },
        });
        return null;
      }
    }
  );

  // --- Structured mode handlers ---

  ipcMain.handle(IPC.AGENT.START_STRUCTURED, async (_event, agentId: string, opts: StructuredSessionOpts) => {
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
  });

  ipcMain.handle(IPC.AGENT.CANCEL_STRUCTURED, async (_event, agentId: string) => {
    await structuredManager.cancelSession(agentId);
  });

  ipcMain.handle(IPC.AGENT.SEND_STRUCTURED_MESSAGE, async (_event, agentId: string, message: string) => {
    await structuredManager.sendMessage(agentId, message);
  });

  ipcMain.handle(
    IPC.AGENT.RESPOND_PERMISSION,
    async (_event, agentId: string, requestId: string, approved: boolean, reason?: string) => {
      await structuredManager.respondToPermission(agentId, requestId, approved, reason);
    }
  );
}
