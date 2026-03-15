import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import * as agentSettings from '../services/agent-settings-service';
import { SettingsConventions } from '../services/agent-settings-service';
import { resolveOrchestrator } from '../services/agent-system';
import { getDurableConfig } from '../services/agent-config';
import { materializeAgent, previewMaterialization, resetProjectAgentDefaults } from '../services/materialization-service';
import { computeConfigDiff, propagateChanges } from '../services/config-diff-service';
import { appLog } from '../services/log-service';

/**
 * Resolve orchestrator conventions for a project path.
 * Returns undefined when no projectPath is provided (falls back to Claude Code defaults in service).
 */
async function getConventions(projectPath?: string): Promise<SettingsConventions | undefined> {
  if (!projectPath) return undefined;
  try {
    const provider = await resolveOrchestrator(projectPath);
    return provider.conventions;
  } catch (err) {
    appLog('core:agent-settings', 'warn', `Failed to resolve orchestrator conventions for ${projectPath}`, { meta: { error: err instanceof Error ? err.message : String(err) } });
    return undefined;
  }
}

export function registerAgentSettingsHandlers(): void {
  ipcMain.handle(IPC.AGENT.READ_INSTRUCTIONS, async (_event, worktreePath: string, projectPath?: string) => {
    if (projectPath) {
      const provider = await resolveOrchestrator(projectPath);
      return provider.readInstructions(worktreePath);
    }
    return agentSettings.readClaudeMd(worktreePath);
  });

  ipcMain.handle(IPC.AGENT.SAVE_INSTRUCTIONS, async (_event, worktreePath: string, content: string, projectPath?: string) => {
    if (projectPath) {
      const provider = await resolveOrchestrator(projectPath);
      provider.writeInstructions(worktreePath, content);
    } else {
      await agentSettings.writeClaudeMd(worktreePath, content);
    }
  });

  ipcMain.handle(IPC.AGENT.READ_MCP_CONFIG, async (_event, worktreePath: string, projectPath?: string) => {
    return agentSettings.readMcpConfig(worktreePath, await getConventions(projectPath));
  });

  ipcMain.handle(IPC.AGENT.LIST_SKILLS, async (_event, worktreePath: string, projectPath?: string) => {
    return agentSettings.listSkills(worktreePath, await getConventions(projectPath));
  });

  ipcMain.handle(IPC.AGENT.LIST_AGENT_TEMPLATES, async (_event, worktreePath: string, projectPath?: string) => {
    return agentSettings.listAgentTemplates(worktreePath, await getConventions(projectPath));
  });

  ipcMain.handle(IPC.AGENT.LIST_SOURCE_SKILLS, async (_event, projectPath: string) => {
    return agentSettings.listSourceSkills(projectPath);
  });

  ipcMain.handle(IPC.AGENT.LIST_SOURCE_AGENT_TEMPLATES, async (_event, projectPath: string) => {
    return agentSettings.listSourceAgentTemplates(projectPath);
  });

  ipcMain.handle(IPC.AGENT.CREATE_SKILL, async (_event, basePath: string, name: string, isSource: boolean, projectPath?: string) => {
    return agentSettings.createSkillDir(basePath, name, isSource, await getConventions(projectPath));
  });

  ipcMain.handle(IPC.AGENT.CREATE_AGENT_TEMPLATE, async (_event, basePath: string, name: string, isSource: boolean, projectPath?: string) => {
    return agentSettings.createAgentTemplateDir(basePath, name, isSource, await getConventions(projectPath));
  });

  ipcMain.handle(IPC.AGENT.READ_PERMISSIONS, async (_event, worktreePath: string, projectPath?: string) => {
    return agentSettings.readPermissions(worktreePath, await getConventions(projectPath));
  });

  ipcMain.handle(IPC.AGENT.SAVE_PERMISSIONS, async (_event, worktreePath: string, permissions: { allow?: string[]; deny?: string[] }, projectPath?: string) => {
    await agentSettings.writePermissions(worktreePath, permissions, await getConventions(projectPath));
  });

  // --- Skill content CRUD ---

  ipcMain.handle(IPC.AGENT.READ_SKILL_CONTENT, async (_event, worktreePath: string, skillName: string, projectPath?: string) => {
    return agentSettings.readSkillContent(worktreePath, skillName, await getConventions(projectPath));
  });

  ipcMain.handle(IPC.AGENT.WRITE_SKILL_CONTENT, async (_event, worktreePath: string, skillName: string, content: string, projectPath?: string) => {
    await agentSettings.writeSkillContent(worktreePath, skillName, content, await getConventions(projectPath));
  });

  ipcMain.handle(IPC.AGENT.DELETE_SKILL, async (_event, worktreePath: string, skillName: string, projectPath?: string) => {
    await agentSettings.deleteSkill(worktreePath, skillName, await getConventions(projectPath));
  });

  // --- Agent template content CRUD ---

  ipcMain.handle(IPC.AGENT.READ_AGENT_TEMPLATE_CONTENT, async (_event, worktreePath: string, agentName: string, projectPath?: string) => {
    return agentSettings.readAgentTemplateContent(worktreePath, agentName, await getConventions(projectPath));
  });

  ipcMain.handle(IPC.AGENT.WRITE_AGENT_TEMPLATE_CONTENT, async (_event, worktreePath: string, agentName: string, content: string, projectPath?: string) => {
    await agentSettings.writeAgentTemplateContent(worktreePath, agentName, content, await getConventions(projectPath));
  });

  ipcMain.handle(IPC.AGENT.DELETE_AGENT_TEMPLATE, async (_event, worktreePath: string, agentName: string, projectPath?: string) => {
    await agentSettings.deleteAgentTemplate(worktreePath, agentName, await getConventions(projectPath));
  });

  ipcMain.handle(IPC.AGENT.LIST_AGENT_TEMPLATE_FILES, async (_event, worktreePath: string, projectPath?: string) => {
    return agentSettings.listAgentTemplateFiles(worktreePath, await getConventions(projectPath));
  });

  // --- MCP raw JSON ---

  ipcMain.handle(IPC.AGENT.READ_MCP_RAW_JSON, async (_event, worktreePath: string, projectPath?: string) => {
    return agentSettings.readMcpRawJson(worktreePath, await getConventions(projectPath));
  });

  ipcMain.handle(IPC.AGENT.WRITE_MCP_RAW_JSON, async (_event, worktreePath: string, content: string, projectPath?: string) => {
    return agentSettings.writeMcpRawJson(worktreePath, content, await getConventions(projectPath));
  });

  // --- Project-level agent defaults ---

  ipcMain.handle(IPC.AGENT.READ_PROJECT_AGENT_DEFAULTS, async (_event, projectPath: string) => {
    return agentSettings.readProjectAgentDefaults(projectPath);
  });

  ipcMain.handle(IPC.AGENT.WRITE_PROJECT_AGENT_DEFAULTS, async (_event, projectPath: string, defaults: any) => {
    await agentSettings.writeProjectAgentDefaults(projectPath, defaults);
  });

  ipcMain.handle(IPC.AGENT.RESET_PROJECT_AGENT_DEFAULTS, async (_event, projectPath: string) => {
    await resetProjectAgentDefaults(projectPath);
  });

  // --- Orchestrator conventions ---

  ipcMain.handle(IPC.AGENT.GET_CONVENTIONS, async (_event, projectPath: string) => {
    try {
      const provider = await resolveOrchestrator(projectPath);
      return provider.conventions;
    } catch (err) {
      appLog('core:agent-settings', 'warn', `Failed to get conventions for ${projectPath}`, { meta: { error: err instanceof Error ? err.message : String(err) } });
      return null;
    }
  });

  // --- Source skill/template content CRUD ---

  ipcMain.handle(IPC.AGENT.READ_SOURCE_SKILL_CONTENT, async (_event, projectPath: string, skillName: string) => {
    return agentSettings.readSourceSkillContent(projectPath, skillName);
  });

  ipcMain.handle(IPC.AGENT.WRITE_SOURCE_SKILL_CONTENT, async (_event, projectPath: string, skillName: string, content: string) => {
    await agentSettings.writeSourceSkillContent(projectPath, skillName, content);
  });

  ipcMain.handle(IPC.AGENT.DELETE_SOURCE_SKILL, async (_event, projectPath: string, skillName: string) => {
    await agentSettings.deleteSourceSkill(projectPath, skillName);
  });

  ipcMain.handle(IPC.AGENT.READ_SOURCE_AGENT_TEMPLATE_CONTENT, async (_event, projectPath: string, agentName: string) => {
    return agentSettings.readSourceAgentTemplateContent(projectPath, agentName);
  });

  ipcMain.handle(IPC.AGENT.WRITE_SOURCE_AGENT_TEMPLATE_CONTENT, async (_event, projectPath: string, agentName: string, content: string) => {
    await agentSettings.writeSourceAgentTemplateContent(projectPath, agentName, content);
  });

  ipcMain.handle(IPC.AGENT.DELETE_SOURCE_AGENT_TEMPLATE, async (_event, projectPath: string, agentName: string) => {
    await agentSettings.deleteSourceAgentTemplate(projectPath, agentName);
  });

  // --- Materialization ---

  ipcMain.handle(IPC.AGENT.MATERIALIZE_AGENT, async (_event, projectPath: string, agentId: string) => {
    const agent = await getDurableConfig(projectPath, agentId);
    if (!agent) return;
    const provider = await resolveOrchestrator(projectPath, agent.orchestrator);
    await materializeAgent({ projectPath, agent, provider });
  });

  ipcMain.handle(IPC.AGENT.PREVIEW_MATERIALIZATION, async (_event, projectPath: string, agentId: string) => {
    const agent = await getDurableConfig(projectPath, agentId);
    if (!agent) return null;
    const provider = await resolveOrchestrator(projectPath, agent.orchestrator);
    return previewMaterialization({ projectPath, agent, provider });
  });

  // --- Config diff detection ---

  ipcMain.handle(IPC.AGENT.COMPUTE_CONFIG_DIFF, async (_event, projectPath: string, agentId: string) => {
    const agent = await getDurableConfig(projectPath, agentId);
    if (!agent) return { agentId, agentName: '', hasDiffs: false, items: [] };
    const provider = await resolveOrchestrator(projectPath, agent.orchestrator);
    return computeConfigDiff({ projectPath, agentId, provider });
  });

  ipcMain.handle(IPC.AGENT.PROPAGATE_CONFIG_CHANGES, async (_event, projectPath: string, agentId: string, selectedItemIds: string[]) => {
    const agent = await getDurableConfig(projectPath, agentId);
    if (!agent) return { ok: false, message: 'Agent not found', propagatedCount: 0 };
    const provider = await resolveOrchestrator(projectPath, agent.orchestrator);
    return propagateChanges({ projectPath, agentId, selectedItemIds, provider });
  });
}
