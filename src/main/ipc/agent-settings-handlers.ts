import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import * as agentSettings from '../services/agent-settings-service';
import { SettingsConventions } from '../services/agent-settings-service';
import { resolveOrchestrator } from '../services/agent-system';
import { getDurableConfig } from '../services/agent-config';
import { materializeAgent, previewMaterialization, resetProjectAgentDefaults } from '../services/materialization-service';
import { computeConfigDiff, propagateChanges } from '../services/config-diff-service';
import { getProjectConfigBreakdown, removePluginInjectionItem } from '../services/config-provenance-service';
import { appLog } from '../services/log-service';
import { withValidatedArgs, stringArg, objectArg, arrayArg, booleanArg } from './validation';

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
  ipcMain.handle(IPC.AGENT.READ_INSTRUCTIONS, withValidatedArgs(
    [stringArg(), stringArg({ optional: true })],
    async (_event, worktreePath, projectPath) => {
      if (projectPath) {
        const provider = await resolveOrchestrator(projectPath);
        return provider.readInstructions(worktreePath);
      }
      return agentSettings.readClaudeMd(worktreePath);
    },
  ));

  ipcMain.handle(IPC.AGENT.SAVE_INSTRUCTIONS, withValidatedArgs(
    [stringArg(), stringArg({ minLength: 0 }), stringArg({ optional: true })],
    async (_event, worktreePath, content, projectPath) => {
      if (projectPath) {
        const provider = await resolveOrchestrator(projectPath);
        provider.writeInstructions(worktreePath, content);
      } else {
        await agentSettings.writeClaudeMd(worktreePath, content);
      }
    },
  ));

  ipcMain.handle(IPC.AGENT.READ_MCP_CONFIG, withValidatedArgs(
    [stringArg(), stringArg({ optional: true })],
    async (_event, worktreePath, projectPath) => {
      return agentSettings.readMcpConfig(worktreePath, await getConventions(projectPath));
    },
  ));

  ipcMain.handle(IPC.AGENT.LIST_SKILLS, withValidatedArgs(
    [stringArg(), stringArg({ optional: true })],
    async (_event, worktreePath, projectPath) => {
      return agentSettings.listSkills(worktreePath, await getConventions(projectPath));
    },
  ));

  ipcMain.handle(IPC.AGENT.LIST_AGENT_TEMPLATES, withValidatedArgs(
    [stringArg(), stringArg({ optional: true })],
    async (_event, worktreePath, projectPath) => {
      return agentSettings.listAgentTemplates(worktreePath, await getConventions(projectPath));
    },
  ));

  ipcMain.handle(IPC.AGENT.LIST_SOURCE_SKILLS, withValidatedArgs(
    [stringArg()],
    async (_event, projectPath) => {
      return agentSettings.listSourceSkills(projectPath);
    },
  ));

  ipcMain.handle(IPC.AGENT.LIST_SOURCE_AGENT_TEMPLATES, withValidatedArgs(
    [stringArg()],
    async (_event, projectPath) => {
      return agentSettings.listSourceAgentTemplates(projectPath);
    },
  ));

  ipcMain.handle(IPC.AGENT.CREATE_SKILL, withValidatedArgs(
    [stringArg(), stringArg(), booleanArg(), stringArg({ optional: true })],
    async (_event, basePath, name, isSource, projectPath) => {
      return agentSettings.createSkillDir(basePath, name, isSource, await getConventions(projectPath));
    },
  ));

  ipcMain.handle(IPC.AGENT.CREATE_AGENT_TEMPLATE, withValidatedArgs(
    [stringArg(), stringArg(), booleanArg(), stringArg({ optional: true })],
    async (_event, basePath, name, isSource, projectPath) => {
      return agentSettings.createAgentTemplateDir(basePath, name, isSource, await getConventions(projectPath));
    },
  ));

  ipcMain.handle(IPC.AGENT.READ_PERMISSIONS, withValidatedArgs(
    [stringArg(), stringArg({ optional: true })],
    async (_event, worktreePath, projectPath) => {
      return agentSettings.readPermissions(worktreePath, await getConventions(projectPath));
    },
  ));

  ipcMain.handle(IPC.AGENT.SAVE_PERMISSIONS, withValidatedArgs(
    [stringArg(), objectArg<{ allow?: string[]; deny?: string[] }>(), stringArg({ optional: true })],
    async (_event, worktreePath, permissions, projectPath) => {
      await agentSettings.writePermissions(worktreePath, permissions, await getConventions(projectPath));
    },
  ));

  // --- Skill content CRUD ---

  ipcMain.handle(IPC.AGENT.READ_SKILL_CONTENT, withValidatedArgs(
    [stringArg(), stringArg(), stringArg({ optional: true })],
    async (_event, worktreePath, skillName, projectPath) => {
      return agentSettings.readSkillContent(worktreePath, skillName, await getConventions(projectPath));
    },
  ));

  ipcMain.handle(IPC.AGENT.WRITE_SKILL_CONTENT, withValidatedArgs(
    [stringArg(), stringArg(), stringArg({ minLength: 0 }), stringArg({ optional: true })],
    async (_event, worktreePath, skillName, content, projectPath) => {
      await agentSettings.writeSkillContent(worktreePath, skillName, content, await getConventions(projectPath));
    },
  ));

  ipcMain.handle(IPC.AGENT.DELETE_SKILL, withValidatedArgs(
    [stringArg(), stringArg(), stringArg({ optional: true })],
    async (_event, worktreePath, skillName, projectPath) => {
      await agentSettings.deleteSkill(worktreePath, skillName, await getConventions(projectPath));
    },
  ));

  // --- Agent template content CRUD ---

  ipcMain.handle(IPC.AGENT.READ_AGENT_TEMPLATE_CONTENT, withValidatedArgs(
    [stringArg(), stringArg(), stringArg({ optional: true })],
    async (_event, worktreePath, agentName, projectPath) => {
      return agentSettings.readAgentTemplateContent(worktreePath, agentName, await getConventions(projectPath));
    },
  ));

  ipcMain.handle(IPC.AGENT.WRITE_AGENT_TEMPLATE_CONTENT, withValidatedArgs(
    [stringArg(), stringArg(), stringArg({ minLength: 0 }), stringArg({ optional: true })],
    async (_event, worktreePath, agentName, content, projectPath) => {
      await agentSettings.writeAgentTemplateContent(worktreePath, agentName, content, await getConventions(projectPath));
    },
  ));

  ipcMain.handle(IPC.AGENT.DELETE_AGENT_TEMPLATE, withValidatedArgs(
    [stringArg(), stringArg(), stringArg({ optional: true })],
    async (_event, worktreePath, agentName, projectPath) => {
      await agentSettings.deleteAgentTemplate(worktreePath, agentName, await getConventions(projectPath));
    },
  ));

  ipcMain.handle(IPC.AGENT.LIST_AGENT_TEMPLATE_FILES, withValidatedArgs(
    [stringArg(), stringArg({ optional: true })],
    async (_event, worktreePath, projectPath) => {
      return agentSettings.listAgentTemplateFiles(worktreePath, await getConventions(projectPath));
    },
  ));

  // --- MCP raw JSON ---

  ipcMain.handle(IPC.AGENT.READ_MCP_RAW_JSON, withValidatedArgs(
    [stringArg(), stringArg({ optional: true })],
    async (_event, worktreePath, projectPath) => {
      return agentSettings.readMcpRawJson(worktreePath, await getConventions(projectPath));
    },
  ));

  ipcMain.handle(IPC.AGENT.WRITE_MCP_RAW_JSON, withValidatedArgs(
    [stringArg(), stringArg({ minLength: 0 }), stringArg({ optional: true })],
    async (_event, worktreePath, content, projectPath) => {
      return agentSettings.writeMcpRawJson(worktreePath, content, await getConventions(projectPath));
    },
  ));

  // --- Project-level agent defaults ---

  ipcMain.handle(IPC.AGENT.READ_PROJECT_AGENT_DEFAULTS, withValidatedArgs(
    [stringArg()],
    async (_event, projectPath) => {
      return agentSettings.readProjectAgentDefaults(projectPath);
    },
  ));

  ipcMain.handle(IPC.AGENT.WRITE_PROJECT_AGENT_DEFAULTS, withValidatedArgs(
    [stringArg(), objectArg()],
    async (_event, projectPath, defaults) => {
      await agentSettings.writeProjectAgentDefaults(projectPath, defaults);
    },
  ));

  ipcMain.handle(IPC.AGENT.RESET_PROJECT_AGENT_DEFAULTS, withValidatedArgs(
    [stringArg()],
    async (_event, projectPath) => {
      await resetProjectAgentDefaults(projectPath);
    },
  ));

  // --- Orchestrator conventions ---

  ipcMain.handle(IPC.AGENT.GET_CONVENTIONS, withValidatedArgs(
    [stringArg()],
    async (_event, projectPath) => {
      try {
        const provider = await resolveOrchestrator(projectPath);
        return provider.conventions;
      } catch (err) {
        appLog('core:agent-settings', 'warn', `Failed to get conventions for ${projectPath}`, { meta: { error: err instanceof Error ? err.message : String(err) } });
        return null;
      }
    },
  ));

  // --- Source skill/template content CRUD ---

  ipcMain.handle(IPC.AGENT.READ_SOURCE_SKILL_CONTENT, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, projectPath, skillName) => {
      return agentSettings.readSourceSkillContent(projectPath, skillName);
    },
  ));

  ipcMain.handle(IPC.AGENT.WRITE_SOURCE_SKILL_CONTENT, withValidatedArgs(
    [stringArg(), stringArg(), stringArg({ minLength: 0 })],
    async (_event, projectPath, skillName, content) => {
      await agentSettings.writeSourceSkillContent(projectPath, skillName, content);
    },
  ));

  ipcMain.handle(IPC.AGENT.DELETE_SOURCE_SKILL, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, projectPath, skillName) => {
      await agentSettings.deleteSourceSkill(projectPath, skillName);
    },
  ));

  ipcMain.handle(IPC.AGENT.READ_SOURCE_AGENT_TEMPLATE_CONTENT, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, projectPath, agentName) => {
      return agentSettings.readSourceAgentTemplateContent(projectPath, agentName);
    },
  ));

  ipcMain.handle(IPC.AGENT.WRITE_SOURCE_AGENT_TEMPLATE_CONTENT, withValidatedArgs(
    [stringArg(), stringArg(), stringArg({ minLength: 0 })],
    async (_event, projectPath, agentName, content) => {
      await agentSettings.writeSourceAgentTemplateContent(projectPath, agentName, content);
    },
  ));

  ipcMain.handle(IPC.AGENT.DELETE_SOURCE_AGENT_TEMPLATE, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, projectPath, agentName) => {
      await agentSettings.deleteSourceAgentTemplate(projectPath, agentName);
    },
  ));

  // --- Project config breakdown with provenance ---

  ipcMain.handle(IPC.AGENT.GET_PROJECT_CONFIG_BREAKDOWN, withValidatedArgs(
    [stringArg(), arrayArg(stringArg())],
    async (_event, projectPath: string, knownPluginIds: string[]) => {
      return getProjectConfigBreakdown(projectPath, knownPluginIds);
    },
  ));

  ipcMain.handle(IPC.AGENT.REMOVE_PLUGIN_INJECTION_ITEM, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, projectPath: string, itemId: string) => {
      return removePluginInjectionItem(projectPath, itemId);
    },
  ));

  // --- Materialization ---

  ipcMain.handle(IPC.AGENT.MATERIALIZE_AGENT, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, projectPath, agentId) => {
      const agent = await getDurableConfig(projectPath, agentId);
      if (!agent) return;
      const provider = await resolveOrchestrator(projectPath, agent.orchestrator);
      await materializeAgent({ projectPath, agent, provider });
    },
  ));

  ipcMain.handle(IPC.AGENT.PREVIEW_MATERIALIZATION, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, projectPath, agentId) => {
      const agent = await getDurableConfig(projectPath, agentId);
      if (!agent) return null;
      const provider = await resolveOrchestrator(projectPath, agent.orchestrator);
      return previewMaterialization({ projectPath, agent, provider });
    },
  ));

  // --- Config diff detection ---

  ipcMain.handle(IPC.AGENT.COMPUTE_CONFIG_DIFF, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, projectPath, agentId) => {
      const agent = await getDurableConfig(projectPath, agentId);
      if (!agent) return { agentId, agentName: '', hasDiffs: false, items: [] };
      const provider = await resolveOrchestrator(projectPath, agent.orchestrator);
      return computeConfigDiff({ projectPath, agentId, provider });
    },
  ));

  ipcMain.handle(IPC.AGENT.PROPAGATE_CONFIG_CHANGES, withValidatedArgs(
    [stringArg(), stringArg(), arrayArg(stringArg())],
    async (_event, projectPath, agentId, selectedItemIds) => {
      const agent = await getDurableConfig(projectPath, agentId);
      if (!agent) return { ok: false, message: 'Agent not found', propagatedCount: 0 };
      const provider = await resolveOrchestrator(projectPath, agent.orchestrator);
      return propagateChanges({ projectPath, agentId, selectedItemIds, provider });
    },
  ));
}
