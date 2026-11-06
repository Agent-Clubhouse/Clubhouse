import { auditChanged, projectAuditTarget } from '../services/settings-audit';
import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import * as agentSettings from '../services/agent-settings-service';
import { SettingsConventions } from '../services/agent-settings-service';
import { resolveOrchestrator } from '../services/agent-system';
import * as path from 'path';
import { withAgentTransition } from '../services/agent-transition';
import { isClubhouseModeEnabled } from '../services/clubhouse-mode-settings';
import { peekDurableConfigs, getDurableConfig } from '../services/agent-config';
import { extractAgentPersona, getAgentWildcards, listAvailablePersonas, materializeAgent, previewMaterialization, readPersonaForEdit, resetProjectAgentDefaults } from '../services/materialization-service';
import { applyPersonaToAgent } from '../services/persona-application';
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

/** Agent MCP edits must resolve the same provider and folder as the next start. */
async function getMcpContext(worktreePath: string, projectPath?: string, agentId?: string) {
  if (!projectPath) {
    if (agentId) throw new Error('A project is required for agent MCP settings.');
    return { conventions: undefined, managed: false, agentId: undefined as string | undefined, target: undefined as string | undefined };
  }
  const agents = await peekDurableConfigs(projectPath);
  const matches = agents.filter((a) => path.resolve(a.worktreePath || projectPath) === path.resolve(worktreePath));
  const agent = agentId ? agents.find((a) => a.id === agentId) : matches.length === 1 ? matches[0] : undefined;
  if (agentId && (!agent || !matches.includes(agent))) throw new Error('Agent MCP settings do not match this project and worktree.');
  if (!agentId && matches.length > 1) throw new Error('This folder is shared by agents. Select an agent for MCP settings.');
  if (!agent && path.resolve(worktreePath) !== path.resolve(projectPath)) throw new Error('No agent in this project owns this MCP settings folder.');
  const provider = await resolveOrchestrator(projectPath, agent?.orchestrator);
  const managed = !!agent && isClubhouseModeEnabled(projectPath) && !agent.clubhouseModeOverride;
  return { conventions: provider.conventions, managed, agentId: agent?.id,
    target: JSON.stringify([agent?.id, path.resolve(agent?.worktreePath || projectPath), provider.id, provider.conventions, managed]) };
}

async function saveAgentMcp(worktreePath: string, content: string, projectPath?: string, agentId?: string) {
  const save = async (expected?: Awaited<ReturnType<typeof getMcpContext>>) => {
    const context = await getMcpContext(worktreePath, projectPath, agentId);
    if (expected && expected.target !== context.target) throw new Error('Agent MCP target changed. Reload before saving.');
    if (context.managed) return { ok: false, error: 'Clubhouse Mode manages MCP from project defaults. Turn on Local overrides in General before saving agent MCP settings.' };
    return agentSettings.writeMcpRawJson(worktreePath, content, context.conventions, async () => {
      const current = await getMcpContext(worktreePath, projectPath, context.agentId);
      if (current.target !== context.target) throw new Error('Agent MCP target changed. Reload before saving.');
    });
  };
  // Reserve before the first await when identity is supplied. Legacy callers
  // infer a unique identity first, then revalidate inside the same reservation.
  if (agentId) return withAgentTransition(agentId, () => save());
  const context = await getMcpContext(worktreePath, projectPath);
  return context.agentId ? withAgentTransition(context.agentId, () => save(context)) : save(context);
}

export function registerAgentSettingsHandlers(): void {
  ipcMain.handle(IPC.AGENT.READ_INSTRUCTIONS, withValidatedArgs(
    [stringArg(), stringArg({ optional: true })],
    async (_event, worktreePath, projectPath) => {
      if (projectPath) {
        const provider = await resolveOrchestrator(projectPath);
        return await provider.readInstructions(worktreePath);
      }
      return agentSettings.readClaudeMd(worktreePath);
    },
  ));

  ipcMain.handle(IPC.AGENT.SAVE_INSTRUCTIONS, withValidatedArgs(
    [stringArg(), stringArg({ minLength: 0 }), stringArg({ optional: true })],
    async (_event, worktreePath, content, projectPath) => {
      await auditChanged('agent', 'agent.instructions', projectAuditTarget(worktreePath));
      if (projectPath) {
        const provider = await resolveOrchestrator(projectPath);
        await provider.writeInstructions(worktreePath, content);
      } else {
        await agentSettings.writeClaudeMd(worktreePath, content);
      }
    },
  ));

  ipcMain.handle(IPC.AGENT.READ_MCP_CONFIG, withValidatedArgs(
    [stringArg(), stringArg({ optional: true }), stringArg({ optional: true })],
    async (_event, worktreePath, projectPath, agentId) => {
      return agentSettings.readMcpConfig(worktreePath, (await getMcpContext(worktreePath, projectPath, agentId)).conventions);
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
      await auditChanged('agent', 'agent.permissions', projectAuditTarget(worktreePath));
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
    [stringArg(), stringArg({ optional: true }), stringArg({ optional: true })],
    async (_event, worktreePath, projectPath, agentId) => {
      return agentSettings.readMcpRawJson(worktreePath, (await getMcpContext(worktreePath, projectPath, agentId)).conventions);
    },
  ));

  ipcMain.handle(IPC.AGENT.GET_MCP_SHADOW_WARNING, withValidatedArgs(
    [stringArg(), stringArg({ optional: true }), stringArg({ optional: true })],
    async (_event, worktreePath, projectPath, agentId) => {
      return agentSettings.getMcpShadowWarning(worktreePath, (await getMcpContext(worktreePath, projectPath, agentId)).conventions);
    },
  ));

  ipcMain.handle(IPC.AGENT.WRITE_MCP_RAW_JSON, withValidatedArgs(
    [stringArg(), stringArg({ minLength: 0 }), stringArg({ optional: true }), stringArg({ optional: true })],
    async (_event, worktreePath, content, projectPath, agentId) => {
      return saveAgentMcp(worktreePath, content, projectPath, agentId);
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

  // --- Clubhouse-mode wildcard library (missions + personas) + per-agent actuals ---

  ipcMain.handle(IPC.AGENT.GET_AGENT_WILDCARDS, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, projectPath, agentId) => {
      const agent = await getDurableConfig(projectPath, agentId);
      if (!agent) return null;
      return getAgentWildcards(projectPath, agent);
    },
  ));

  ipcMain.handle(IPC.AGENT.LIST_SOURCE_MISSIONS, withValidatedArgs(
    [stringArg()],
    async (_event, projectPath) => {
      return agentSettings.listSourceMissions(projectPath);
    },
  ));

  ipcMain.handle(IPC.AGENT.READ_SOURCE_MISSION_CONTENT, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, projectPath, missionId) => {
      return agentSettings.readSourceMissionContent(projectPath, missionId);
    },
  ));

  ipcMain.handle(IPC.AGENT.WRITE_SOURCE_MISSION_CONTENT, withValidatedArgs(
    [stringArg(), stringArg(), stringArg({ minLength: 0 })],
    async (_event, projectPath, missionId, content) => {
      await agentSettings.writeSourceMissionContent(projectPath, missionId, content);
    },
  ));

  ipcMain.handle(IPC.AGENT.DELETE_SOURCE_MISSION, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, projectPath, missionId) => {
      await agentSettings.deleteSourceMission(projectPath, missionId);
    },
  ));

  ipcMain.handle(IPC.AGENT.LIST_SOURCE_PERSONAS, withValidatedArgs(
    [stringArg()],
    async (_event, projectPath) => {
      return listAvailablePersonas(projectPath);
    },
  ));

  ipcMain.handle(IPC.AGENT.READ_SOURCE_PERSONA_CONTENT, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, projectPath, personaId) => {
      return readPersonaForEdit(projectPath, personaId);
    },
  ));

  ipcMain.handle(IPC.AGENT.WRITE_SOURCE_PERSONA_CONTENT, withValidatedArgs(
    [stringArg(), stringArg(), stringArg({ minLength: 0 }), stringArg({ optional: true })],
    async (_event, projectPath, personaId, content, scope) => {
      await agentSettings.writeSourcePersonaContent(projectPath, personaId, content, scope === 'user' ? 'user' : 'project');
    },
  ));

  ipcMain.handle(IPC.AGENT.DELETE_SOURCE_PERSONA, withValidatedArgs(
    [stringArg(), stringArg(), stringArg({ optional: true })],
    async (_event, projectPath, personaId, scope) => {
      await agentSettings.deleteSourcePersona(projectPath, personaId, scope === 'user' ? 'user' : 'project');
    },
  ));

  // Apply a persona (content + any front-matter settings) to an existing agent.
  ipcMain.handle(IPC.AGENT.APPLY_PERSONA_TO_AGENT, withValidatedArgs(
    [stringArg(), stringArg(), stringArg()],
    async (_event, projectPath, agentId, personaId) => {
      await applyPersonaToAgent(projectPath, agentId, personaId);
    },
  ));

  // Extract an agent's instructions + settings into a reusable persona payload.
  ipcMain.handle(IPC.AGENT.EXTRACT_AGENT_PERSONA, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, projectPath, agentId) => {
      const agent = await getDurableConfig(projectPath, agentId);
      if (!agent) return null;
      const provider = await resolveOrchestrator(projectPath, agent.orchestrator);
      return extractAgentPersona({ projectPath, agent, provider });
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
