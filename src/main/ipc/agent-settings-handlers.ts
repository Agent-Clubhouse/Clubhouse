import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import * as agentSettings from '../services/agent-settings-service';
import { resolveOrchestrator } from '../services/agent-system';

export function registerAgentSettingsHandlers(): void {
  ipcMain.handle(IPC.AGENT.READ_INSTRUCTIONS, (_event, worktreePath: string, projectPath?: string) => {
    if (projectPath) {
      const provider = resolveOrchestrator(projectPath);
      return provider.readInstructions(worktreePath);
    }
    return agentSettings.readClaudeMd(worktreePath);
  });

  ipcMain.handle(IPC.AGENT.SAVE_INSTRUCTIONS, (_event, worktreePath: string, content: string, projectPath?: string) => {
    if (projectPath) {
      const provider = resolveOrchestrator(projectPath);
      provider.writeInstructions(worktreePath, content);
    } else {
      agentSettings.writeClaudeMd(worktreePath, content);
    }
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

  ipcMain.handle(IPC.AGENT.READ_PERMISSIONS, (_event, worktreePath: string) => {
    return agentSettings.readPermissions(worktreePath);
  });

  ipcMain.handle(IPC.AGENT.SAVE_PERMISSIONS, (_event, worktreePath: string, permissions: { allow?: string[]; deny?: string[] }) => {
    agentSettings.writePermissions(worktreePath, permissions);
  });

  // --- Skill content CRUD ---

  ipcMain.handle(IPC.AGENT.READ_SKILL_CONTENT, (_event, worktreePath: string, skillName: string) => {
    return agentSettings.readSkillContent(worktreePath, skillName);
  });

  ipcMain.handle(IPC.AGENT.WRITE_SKILL_CONTENT, (_event, worktreePath: string, skillName: string, content: string) => {
    agentSettings.writeSkillContent(worktreePath, skillName, content);
  });

  ipcMain.handle(IPC.AGENT.DELETE_SKILL, (_event, worktreePath: string, skillName: string) => {
    agentSettings.deleteSkill(worktreePath, skillName);
  });

  // --- Agent template content CRUD ---

  ipcMain.handle(IPC.AGENT.READ_AGENT_TEMPLATE_CONTENT, (_event, worktreePath: string, agentName: string) => {
    return agentSettings.readAgentTemplateContent(worktreePath, agentName);
  });

  ipcMain.handle(IPC.AGENT.WRITE_AGENT_TEMPLATE_CONTENT, (_event, worktreePath: string, agentName: string, content: string) => {
    agentSettings.writeAgentTemplateContent(worktreePath, agentName, content);
  });

  ipcMain.handle(IPC.AGENT.DELETE_AGENT_TEMPLATE, (_event, worktreePath: string, agentName: string) => {
    agentSettings.deleteAgentTemplate(worktreePath, agentName);
  });

  ipcMain.handle(IPC.AGENT.LIST_AGENT_TEMPLATE_FILES, (_event, worktreePath: string) => {
    return agentSettings.listAgentTemplateFiles(worktreePath);
  });

  // --- MCP raw JSON ---

  ipcMain.handle(IPC.AGENT.READ_MCP_RAW_JSON, (_event, worktreePath: string) => {
    return agentSettings.readMcpRawJson(worktreePath);
  });

  ipcMain.handle(IPC.AGENT.WRITE_MCP_RAW_JSON, (_event, worktreePath: string, content: string) => {
    return agentSettings.writeMcpRawJson(worktreePath, content);
  });
}
