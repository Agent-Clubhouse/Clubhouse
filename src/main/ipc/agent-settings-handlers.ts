import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import * as agentSettings from '../services/agent-settings-service';

export function registerAgentSettingsHandlers(): void {
  ipcMain.handle(IPC.AGENT.READ_CLAUDE_MD, (_event, worktreePath: string) => {
    return agentSettings.readClaudeMd(worktreePath);
  });

  ipcMain.handle(IPC.AGENT.SAVE_CLAUDE_MD, (_event, worktreePath: string, content: string) => {
    agentSettings.writeClaudeMd(worktreePath, content);
  });

  ipcMain.handle(IPC.AGENT.READ_MCP_CONFIG, (_event, worktreePath: string) => {
    return agentSettings.readMcpConfig(worktreePath);
  });

  ipcMain.handle(IPC.AGENT.LIST_SKILLS, (_event, worktreePath: string) => {
    return agentSettings.listSkills(worktreePath);
  });

  ipcMain.handle(IPC.AGENT.LIST_AGENT_TEMPLATES, (_event, worktreePath: string) => {
    return agentSettings.listAgentTemplates(worktreePath);
  });

  ipcMain.handle(IPC.AGENT.LIST_SOURCE_SKILLS, (_event, projectPath: string) => {
    return agentSettings.listSourceSkills(projectPath);
  });

  ipcMain.handle(IPC.AGENT.LIST_SOURCE_AGENT_TEMPLATES, (_event, projectPath: string) => {
    return agentSettings.listSourceAgentTemplates(projectPath);
  });

  ipcMain.handle(IPC.AGENT.CREATE_SKILL, (_event, basePath: string, name: string, isSource: boolean) => {
    return agentSettings.createSkillDir(basePath, name, isSource);
  });

  ipcMain.handle(IPC.AGENT.CREATE_AGENT_TEMPLATE, (_event, basePath: string, name: string, isSource: boolean) => {
    return agentSettings.createAgentTemplateDir(basePath, name, isSource);
  });
}
