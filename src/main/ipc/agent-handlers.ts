import { ipcMain, dialog, BrowserWindow } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { SpawnAgentParams } from '../../shared/types';
import * as agentConfig from '../services/agent-config';
import * as agentSystem from '../services/agent-system';
import * as headlessManager from '../services/headless-manager';
import { buildSummaryInstruction, readQuickSummary } from '../orchestrators/shared';
import { appLog } from '../services/log-service';

export function registerAgentHandlers(): void {
  ipcMain.handle(IPC.AGENT.LIST_DURABLE, (_event, projectPath: string) => {
    return agentConfig.listDurable(projectPath);
  });

  ipcMain.handle(
    IPC.AGENT.CREATE_DURABLE,
    (_event, projectPath: string, name: string, color: string, model?: string, useWorktree?: boolean, orchestrator?: string, freeAgentMode?: boolean) => {
      return agentConfig.createDurable(projectPath, name, color, model, useWorktree, orchestrator, freeAgentMode);
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
    (_event, projectPath: string, agentId: string, updates: { name?: string; color?: string; icon?: string | null }) => {
      agentConfig.updateDurable(projectPath, agentId, updates);
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
    const fs = require('fs');
    const path = require('path');
    const filePath = result.filePaths[0];
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    };
    const mime = mimeMap[ext] || 'image/png';
    const data = fs.readFileSync(filePath);
    return `data:${mime};base64,${data.toString('base64')}`;
  });

  ipcMain.handle(IPC.AGENT.SAVE_ICON, (_event, projectPath: string, agentId: string, dataUrl: string) => {
    return agentConfig.saveAgentIcon(projectPath, agentId, dataUrl);
  });

  ipcMain.handle(IPC.AGENT.READ_ICON, (_event, filename: string) => {
    return agentConfig.readAgentIconData(filename);
  });

  ipcMain.handle(IPC.AGENT.REMOVE_ICON, (_event, projectPath: string, agentId: string) => {
    agentConfig.removeAgentIcon(projectPath, agentId);
  });

  ipcMain.handle(IPC.AGENT.GET_DURABLE_CONFIG, (_event, projectPath: string, agentId: string) => {
    return agentConfig.getDurableConfig(projectPath, agentId);
  });

  ipcMain.handle(IPC.AGENT.UPDATE_DURABLE_CONFIG, (_event, projectPath: string, agentId: string, updates: any) => {
    agentConfig.updateDurableConfig(projectPath, agentId, updates);
  });

  ipcMain.handle(IPC.AGENT.REORDER_DURABLE, (_event, projectPath: string, orderedIds: string[]) => {
    return agentConfig.reorderDurable(projectPath, orderedIds);
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

  ipcMain.handle(IPC.AGENT.READ_TRANSCRIPT, (_event, agentId: string) => {
    return headlessManager.readTranscript(agentId);
  });

  ipcMain.handle(IPC.AGENT.IS_HEADLESS_AGENT, (_event, agentId: string) => {
    return agentSystem.isHeadlessAgent(agentId);
  });
}
