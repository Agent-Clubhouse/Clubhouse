import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import * as agentConfig from '../services/agent-config';

export function registerAgentHandlers(): void {
  ipcMain.handle(IPC.AGENT.LIST_DURABLE, (_event, projectPath: string) => {
    return agentConfig.listDurable(projectPath);
  });

  ipcMain.handle(
    IPC.AGENT.CREATE_DURABLE,
    (_event, projectPath: string, name: string, color: string, localOnly: boolean) => {
      return agentConfig.createDurable(projectPath, name, color, localOnly);
    }
  );

  ipcMain.handle(IPC.AGENT.DELETE_DURABLE, (_event, projectPath: string, agentId: string) => {
    agentConfig.deleteDurable(projectPath, agentId);
  });

  ipcMain.handle(IPC.AGENT.GET_SETTINGS, (_event, projectPath: string) => {
    return agentConfig.getSettings(projectPath);
  });

  ipcMain.handle(IPC.AGENT.SAVE_SETTINGS, (_event, projectPath: string, settings: any) => {
    agentConfig.saveSettings(projectPath, settings);
  });
}
