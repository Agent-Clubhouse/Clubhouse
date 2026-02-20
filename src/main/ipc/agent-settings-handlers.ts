import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import * as agentSettings from '../services/agent-settings-service';
import { SettingsConventions } from '../services/agent-settings-service';
import { resolveOrchestrator } from '../services/agent-system';
import { getDurableConfig } from '../services/agent-config';
import { materializeAgent, previewMaterialization } from '../services/materialization-service';

/**
 * Resolve orchestrator conventions for a project path.
 * Returns undefined when no projectPath is provided (falls back to Claude Code defaults in service).
 */
function getConventions(projectPath?: string): SettingsConventions | undefined {
  if (!projectPath) return undefined;
  try {
    return resolveOrchestrator(projectPath).conventions;
  } catch {
    return undefined;
  }
}

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

  ipcMain.handle(IPC.AGENT.READ_MCP_CONFIG, (_event, worktreePath: string, projectPath?: string) => {
    return agentSettings.readMcpConfig(worktreePath, getConventions(projectPath));
  });

  ipcMain.handle(IPC.AGENT.LIST_SKILLS, (_event, worktreePath: string, projectPath?: string) => {
    return agentSettings.listSkills(worktreePath, getConventions(projectPath));
  });

  ipcMain.handle(IPC.AGENT.LIST_AGENT_TEMPLATES, (_event, worktreePath: string, projectPath?: string) => {
    return agentSettings.listAgentTemplates(worktreePath, getConventions(projectPath));
  });

  ipcMain.handle(IPC.AGENT.LIST_SOURCE_SKILLS, (_event, projectPath: string) => {
    return agentSettings.listSourceSkills(projectPath);
  });

  ipcMain.handle(IPC.AGENT.LIST_SOURCE_AGENT_TEMPLATES, (_event, projectPath: string) => {
    return agentSettings.listSourceAgentTemplates(projectPath);
  });

  ipcMain.handle(IPC.AGENT.CREATE_SKILL, (_event, basePath: string, name: string, isSource: boolean, projectPath?: string) => {
    return agentSettings.createSkillDir(basePath, name, isSource, getConventions(projectPath));
  });

  ipcMain.handle(IPC.AGENT.CREATE_AGENT_TEMPLATE, (_event, basePath: string, name: string, isSource: boolean, projectPath?: string) => {
    return agentSettings.createAgentTemplateDir(basePath, name, isSource, getConventions(projectPath));
  });

  ipcMain.handle(IPC.AGENT.READ_PERMISSIONS, (_event, worktreePath: string, projectPath?: string) => {
    return agentSettings.readPermissions(worktreePath, getConventions(projectPath));
  });

  ipcMain.handle(IPC.AGENT.SAVE_PERMISSIONS, (_event, worktreePath: string, permissions: { allow?: string[]; deny?: string[] }, projectPath?: string) => {
    agentSettings.writePermissions(worktreePath, permissions, getConventions(projectPath));
  });

  // --- Skill content CRUD ---

  ipcMain.handle(IPC.AGENT.READ_SKILL_CONTENT, (_event, worktreePath: string, skillName: string, projectPath?: string) => {
    return agentSettings.readSkillContent(worktreePath, skillName, getConventions(projectPath));
  });

  ipcMain.handle(IPC.AGENT.WRITE_SKILL_CONTENT, (_event, worktreePath: string, skillName: string, content: string, projectPath?: string) => {
    agentSettings.writeSkillContent(worktreePath, skillName, content, getConventions(projectPath));
  });

  ipcMain.handle(IPC.AGENT.DELETE_SKILL, (_event, worktreePath: string, skillName: string, projectPath?: string) => {
    agentSettings.deleteSkill(worktreePath, skillName, getConventions(projectPath));
  });

  // --- Agent template content CRUD ---

  ipcMain.handle(IPC.AGENT.READ_AGENT_TEMPLATE_CONTENT, (_event, worktreePath: string, agentName: string, projectPath?: string) => {
    return agentSettings.readAgentTemplateContent(worktreePath, agentName, getConventions(projectPath));
  });

  ipcMain.handle(IPC.AGENT.WRITE_AGENT_TEMPLATE_CONTENT, (_event, worktreePath: string, agentName: string, content: string, projectPath?: string) => {
    agentSettings.writeAgentTemplateContent(worktreePath, agentName, content, getConventions(projectPath));
  });

  ipcMain.handle(IPC.AGENT.DELETE_AGENT_TEMPLATE, (_event, worktreePath: string, agentName: string, projectPath?: string) => {
    agentSettings.deleteAgentTemplate(worktreePath, agentName, getConventions(projectPath));
  });

  ipcMain.handle(IPC.AGENT.LIST_AGENT_TEMPLATE_FILES, (_event, worktreePath: string, projectPath?: string) => {
    return agentSettings.listAgentTemplateFiles(worktreePath, getConventions(projectPath));
  });

  // --- MCP raw JSON ---

  ipcMain.handle(IPC.AGENT.READ_MCP_RAW_JSON, (_event, worktreePath: string, projectPath?: string) => {
    return agentSettings.readMcpRawJson(worktreePath, getConventions(projectPath));
  });

  ipcMain.handle(IPC.AGENT.WRITE_MCP_RAW_JSON, (_event, worktreePath: string, content: string, projectPath?: string) => {
    return agentSettings.writeMcpRawJson(worktreePath, content, getConventions(projectPath));
  });

  // --- Project-level agent defaults ---

  ipcMain.handle(IPC.AGENT.READ_PROJECT_AGENT_DEFAULTS, (_event, projectPath: string) => {
    return agentSettings.readProjectAgentDefaults(projectPath);
  });

  ipcMain.handle(IPC.AGENT.WRITE_PROJECT_AGENT_DEFAULTS, (_event, projectPath: string, defaults: any) => {
    agentSettings.writeProjectAgentDefaults(projectPath, defaults);
  });

  // --- Orchestrator conventions ---

  ipcMain.handle(IPC.AGENT.GET_CONVENTIONS, (_event, projectPath: string) => {
    try {
      const provider = resolveOrchestrator(projectPath);
      return provider.conventions;
    } catch {
      return null;
    }
  });

  // --- Materialization ---

  ipcMain.handle(IPC.AGENT.MATERIALIZE_AGENT, (_event, projectPath: string, agentId: string) => {
    const agent = getDurableConfig(projectPath, agentId);
    if (!agent) return;
    const provider = resolveOrchestrator(projectPath, agent.orchestrator);
    materializeAgent({ projectPath, agent, provider });
  });

  ipcMain.handle(IPC.AGENT.PREVIEW_MATERIALIZATION, (_event, projectPath: string, agentId: string) => {
    const agent = getDurableConfig(projectPath, agentId);
    if (!agent) return null;
    const provider = resolveOrchestrator(projectPath, agent.orchestrator);
    return previewMaterialization({ projectPath, agent, provider });
  });
}
