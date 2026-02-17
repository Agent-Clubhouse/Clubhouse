import { ipcMain, dialog, BrowserWindow } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { SpawnAgentParams } from '../../shared/types';
import * as agentConfig from '../services/agent-config';
import * as agentSystem from '../services/agent-system';
import { buildSummaryInstruction, readQuickSummary } from '../orchestrators/shared';

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

  // --- Orchestrator-based handlers ---

  ipcMain.handle(IPC.AGENT.SPAWN_AGENT, async (_event, params: SpawnAgentParams) => {
    await agentSystem.spawnAgent(params);
  });

  ipcMain.handle(IPC.AGENT.KILL_AGENT, async (_event, agentId: string, projectPath: string, orchestrator?: string) => {
    await agentSystem.killAgent(agentId, projectPath, orchestrator);
  });

  ipcMain.handle(IPC.AGENT.READ_QUICK_SUMMARY, async (_event, agentId: string) => {
    return readQuickSummary(agentId);
  });

  ipcMain.handle(IPC.AGENT.GET_MODEL_OPTIONS, async (_event, projectPath: string, orchestrator?: string) => {
    const provider = agentSystem.resolveOrchestrator(projectPath, orchestrator);
    return provider.getModelOptions();
  });

  ipcMain.handle(IPC.AGENT.CHECK_ORCHESTRATOR, async (_event, projectPath?: string, orchestrator?: string) => {
    return agentSystem.checkAvailability(projectPath, orchestrator);
  });

  ipcMain.handle(IPC.AGENT.GET_ORCHESTRATORS, () => {
    return agentSystem.getAvailableOrchestrators();
  });

  ipcMain.handle(IPC.AGENT.GET_TOOL_VERB, (_event, toolName: string, projectPath: string, orchestrator?: string) => {
    const provider = agentSystem.resolveOrchestrator(projectPath, orchestrator);
    return provider.toolVerb(toolName) || `Using ${toolName}`;
  });

  ipcMain.handle(IPC.AGENT.GET_SUMMARY_INSTRUCTION, (_event, agentId: string) => {
    return buildSummaryInstruction(agentId);
  });
}
