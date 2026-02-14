import { ipcMain, dialog, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { IPC } from '../../shared/ipc-channels';
import { SpawnAgentParams } from '../../shared/types';
import * as agentConfig from '../services/agent-config';
import * as agentSystem from '../services/agent-system';

export function registerAgentHandlers(): void {
  ipcMain.handle(IPC.AGENT.LIST_DURABLE, (_event, projectPath: string) => {
    return agentConfig.listDurable(projectPath);
  });

  ipcMain.handle(
    IPC.AGENT.CREATE_DURABLE,
    (_event, projectPath: string, name: string, color: string, model?: string, useWorktree?: boolean, orchestrator?: string) => {
      return agentConfig.createDurable(projectPath, name, color, model, useWorktree, orchestrator);
    }
  );

  ipcMain.handle(IPC.AGENT.DELETE_DURABLE, (_event, projectPath: string, agentId: string) => {
    agentConfig.deleteDurable(projectPath, agentId);
  });

  ipcMain.handle(IPC.AGENT.RENAME_DURABLE, (_event, projectPath: string, agentId: string, newName: string) => {
    agentConfig.renameDurable(projectPath, agentId, newName);
  });

  ipcMain.handle(
    IPC.AGENT.UPDATE_DURABLE,
    (_event, projectPath: string, agentId: string, updates: { name?: string; color?: string; emoji?: string | null }) => {
      agentConfig.updateDurable(projectPath, agentId, updates);
    }
  );

  // Legacy: keep setup-hooks for backwards compat, but SPAWN_AGENT handles this internally now
  ipcMain.handle(IPC.AGENT.SETUP_HOOKS, async (_event, worktreePath: string, agentId: string, options?: { allowedTools?: string[] }) => {
    // No-op: hooks are now set up inside spawnAgent(). Kept for backwards compatibility during migration.
  });

  ipcMain.handle(IPC.AGENT.GET_DURABLE_CONFIG, (_event, projectPath: string, agentId: string) => {
    return agentConfig.getDurableConfig(projectPath, agentId);
  });

  ipcMain.handle(IPC.AGENT.UPDATE_DURABLE_CONFIG, (_event, projectPath: string, agentId: string, updates: any) => {
    agentConfig.updateDurableConfig(projectPath, agentId, updates);
  });

  ipcMain.handle(IPC.AGENT.GET_WORKTREE_STATUS, (_event, projectPath: string, agentId: string) => {
    return agentConfig.getWorktreeStatus(projectPath, agentId);
  });

  ipcMain.handle(IPC.AGENT.DELETE_COMMIT_PUSH, (_event, projectPath: string, agentId: string) => {
    return agentConfig.deleteCommitAndPush(projectPath, agentId);
  });

  ipcMain.handle(IPC.AGENT.DELETE_CLEANUP_BRANCH, (_event, projectPath: string, agentId: string) => {
    return agentConfig.deleteWithCleanupBranch(projectPath, agentId);
  });

  ipcMain.handle(IPC.AGENT.DELETE_SAVE_PATCH, async (_event, projectPath: string, agentId: string) => {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showSaveDialog(win!, {
      title: 'Save patch file',
      defaultPath: `agent-${agentId}.patch`,
      filters: [{ name: 'Patch files', extensions: ['patch'] }],
    });

    if (result.canceled || !result.filePath) {
      return { ok: false, message: 'cancelled' };
    }

    return agentConfig.deleteSaveAsPatch(projectPath, agentId, result.filePath);
  });

  ipcMain.handle(IPC.AGENT.DELETE_FORCE, (_event, projectPath: string, agentId: string) => {
    return agentConfig.deleteForce(projectPath, agentId);
  });

  ipcMain.handle(IPC.AGENT.DELETE_UNREGISTER, (_event, projectPath: string, agentId: string) => {
    return agentConfig.deleteUnregister(projectPath, agentId);
  });

  // --- New orchestrator-based handlers ---

  ipcMain.handle(IPC.AGENT.SPAWN_AGENT, async (_event, params: SpawnAgentParams) => {
    await agentSystem.spawnAgent(params);
  });

  ipcMain.handle(IPC.AGENT.KILL_AGENT, async (_event, agentId: string, projectPath: string, orchestrator?: string) => {
    await agentSystem.killAgent(agentId, projectPath, orchestrator);
  });

  ipcMain.handle(IPC.AGENT.READ_QUICK_SUMMARY, async (_event, agentId: string, projectPath?: string) => {
    // If projectPath provided, use the new orchestrator-based path
    if (projectPath) {
      return agentSystem.readQuickSummary(agentId, projectPath);
    }
    // Fallback: try agent tracking, then raw file read
    const trackedPath = agentSystem.getAgentProjectPath(agentId);
    if (trackedPath) {
      return agentSystem.readQuickSummary(agentId, trackedPath);
    }
    // Legacy fallback
    const filePath = path.join('/tmp', `clubhouse-summary-${agentId}.json`);
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw);
      fs.unlinkSync(filePath);
      return {
        summary: typeof data.summary === 'string' ? data.summary : null,
        filesModified: Array.isArray(data.filesModified) ? data.filesModified : [],
      };
    } catch {
      return null;
    }
  });

  ipcMain.handle(IPC.AGENT.GET_MODEL_OPTIONS, (_event, projectPath: string, orchestrator?: string) => {
    return agentSystem.getModelOptions(projectPath, orchestrator);
  });

  ipcMain.handle(IPC.AGENT.CHECK_ORCHESTRATOR, async (_event, projectPath?: string, orchestrator?: string) => {
    return agentSystem.checkAvailability(projectPath, orchestrator);
  });

  ipcMain.handle(IPC.AGENT.GET_ORCHESTRATORS, () => {
    return agentSystem.getAvailableOrchestrators();
  });

  ipcMain.handle(IPC.AGENT.GET_TOOL_VERB, (_event, toolName: string, projectPath: string, orchestrator?: string) => {
    return agentSystem.getToolVerb(toolName, projectPath, orchestrator);
  });

  ipcMain.handle(IPC.AGENT.GET_SUMMARY_INSTRUCTION, (_event, agentId: string, projectPath: string, orchestrator?: string) => {
    return agentSystem.buildSummaryInstruction(agentId, projectPath, orchestrator);
  });
}
