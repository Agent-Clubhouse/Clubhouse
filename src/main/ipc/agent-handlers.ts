import { ipcMain, dialog, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { IPC } from '../../shared/ipc-channels';
import { ConfigItemKey, ConfigLayer } from '../../shared/types';
import * as agentConfig from '../services/agent-config';
import { writeHooksConfig } from '../services/agent-hooks';
import { resolveQuickConfig } from '../services/config-resolver';

export function registerAgentHandlers(): void {
  ipcMain.handle(IPC.AGENT.LIST_DURABLE, (_event, projectPath: string) => {
    return agentConfig.listDurable(projectPath);
  });

  ipcMain.handle(
    IPC.AGENT.CREATE_DURABLE,
    (_event, projectPath: string, name: string, color: string, localOnly: boolean, model?: string) => {
      return agentConfig.createDurable(projectPath, name, color, localOnly, model);
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

  ipcMain.handle(IPC.AGENT.GET_SETTINGS, (_event, projectPath: string) => {
    return agentConfig.getSettings(projectPath);
  });

  ipcMain.handle(IPC.AGENT.SAVE_SETTINGS, (_event, projectPath: string, settings: any) => {
    agentConfig.saveSettings(projectPath, settings);
  });

  ipcMain.handle(IPC.AGENT.SETUP_HOOKS, async (_event, worktreePath: string, agentId: string, options?: { allowedTools?: string[] }) => {
    await writeHooksConfig(worktreePath, agentId, options);
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

  ipcMain.handle(IPC.AGENT.READ_QUICK_SUMMARY, (_event, agentId: string) => {
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

  ipcMain.handle(IPC.AGENT.GET_LOCAL_SETTINGS, (_event, projectPath: string) => {
    return agentConfig.getLocalSettings(projectPath);
  });

  ipcMain.handle(IPC.AGENT.SAVE_LOCAL_SETTINGS, (_event, projectPath: string, localConfig: ConfigLayer) => {
    agentConfig.saveLocalSettings(projectPath, localConfig);
  });

  ipcMain.handle(IPC.AGENT.TOGGLE_OVERRIDE, (_event, projectPath: string, agentId: string, key: ConfigItemKey, enable: boolean) => {
    return agentConfig.toggleOverride(projectPath, agentId, key, enable);
  });

  ipcMain.handle(IPC.AGENT.PREPARE_SPAWN, async (_event, projectPath: string, agentId: string, worktreePath: string) => {
    agentConfig.prepareSpawn(projectPath, agentId);
    await writeHooksConfig(worktreePath, agentId);
  });

  ipcMain.handle(IPC.AGENT.RESOLVE_QUICK_CONFIG, (_event, projectPath: string, parentAgentId?: string) => {
    return resolveQuickConfig(projectPath, parentAgentId);
  });
}
