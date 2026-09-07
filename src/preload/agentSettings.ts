import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';
import type { AgentWildcardSettings } from '../shared/types';

export const agentSettings = {
  agentSettings: {
  readInstructions: (worktreePath: string, projectPath?: string) =>
    ipcRenderer.invoke(IPC.AGENT.READ_INSTRUCTIONS, worktreePath, projectPath),
  saveInstructions: (worktreePath: string, content: string, projectPath?: string) =>
    ipcRenderer.invoke(IPC.AGENT.SAVE_INSTRUCTIONS, worktreePath, content, projectPath),
  readMcpConfig: (worktreePath: string, projectPath?: string) =>
    ipcRenderer.invoke(IPC.AGENT.READ_MCP_CONFIG, worktreePath, projectPath),
  listSkills: (worktreePath: string, projectPath?: string) =>
    ipcRenderer.invoke(IPC.AGENT.LIST_SKILLS, worktreePath, projectPath),
  listAgentTemplates: (worktreePath: string, projectPath?: string) =>
    ipcRenderer.invoke(IPC.AGENT.LIST_AGENT_TEMPLATES, worktreePath, projectPath),
  listSourceSkills: (projectPath: string) =>
    ipcRenderer.invoke(IPC.AGENT.LIST_SOURCE_SKILLS, projectPath),
  listSourceAgentTemplates: (projectPath: string) =>
    ipcRenderer.invoke(IPC.AGENT.LIST_SOURCE_AGENT_TEMPLATES, projectPath),
  readSourceSkillContent: (projectPath: string, skillName: string): Promise<string> =>
    ipcRenderer.invoke(IPC.AGENT.READ_SOURCE_SKILL_CONTENT, projectPath, skillName),
  writeSourceSkillContent: (projectPath: string, skillName: string, content: string) =>
    ipcRenderer.invoke(IPC.AGENT.WRITE_SOURCE_SKILL_CONTENT, projectPath, skillName, content),
  deleteSourceSkill: (projectPath: string, skillName: string) =>
    ipcRenderer.invoke(IPC.AGENT.DELETE_SOURCE_SKILL, projectPath, skillName),
  readSourceAgentTemplateContent: (projectPath: string, agentName: string): Promise<string> =>
    ipcRenderer.invoke(IPC.AGENT.READ_SOURCE_AGENT_TEMPLATE_CONTENT, projectPath, agentName),
  writeSourceAgentTemplateContent: (projectPath: string, agentName: string, content: string) =>
    ipcRenderer.invoke(IPC.AGENT.WRITE_SOURCE_AGENT_TEMPLATE_CONTENT, projectPath, agentName, content),
  deleteSourceAgentTemplate: (projectPath: string, agentName: string) =>
    ipcRenderer.invoke(IPC.AGENT.DELETE_SOURCE_AGENT_TEMPLATE, projectPath, agentName),
  // Clubhouse-mode wildcard library (missions + personas) + per-agent actuals
  getAgentWildcards: (projectPath: string, agentId: string): Promise<AgentWildcardSettings | null> =>
    ipcRenderer.invoke(IPC.AGENT.GET_AGENT_WILDCARDS, projectPath, agentId),
  listSourceMissions: (projectPath: string): Promise<Array<{ id: string; path: string }>> =>
    ipcRenderer.invoke(IPC.AGENT.LIST_SOURCE_MISSIONS, projectPath),
  readSourceMissionContent: (projectPath: string, missionId: string): Promise<string> =>
    ipcRenderer.invoke(IPC.AGENT.READ_SOURCE_MISSION_CONTENT, projectPath, missionId),
  writeSourceMissionContent: (projectPath: string, missionId: string, content: string): Promise<void> =>
    ipcRenderer.invoke(IPC.AGENT.WRITE_SOURCE_MISSION_CONTENT, projectPath, missionId, content),
  deleteSourceMission: (projectPath: string, missionId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.AGENT.DELETE_SOURCE_MISSION, projectPath, missionId),
  listSourcePersonas: (projectPath: string): Promise<Array<{ id: string; name: string; source: 'builtin' | 'user' | 'project' }>> =>
    ipcRenderer.invoke(IPC.AGENT.LIST_SOURCE_PERSONAS, projectPath),
  readSourcePersonaContent: (projectPath: string, personaId: string): Promise<string> =>
    ipcRenderer.invoke(IPC.AGENT.READ_SOURCE_PERSONA_CONTENT, projectPath, personaId),
  writeSourcePersonaContent: (projectPath: string, personaId: string, content: string, scope?: 'project' | 'user'): Promise<void> =>
    ipcRenderer.invoke(IPC.AGENT.WRITE_SOURCE_PERSONA_CONTENT, projectPath, personaId, content, scope),
  deleteSourcePersona: (projectPath: string, personaId: string, scope?: 'project' | 'user'): Promise<void> =>
    ipcRenderer.invoke(IPC.AGENT.DELETE_SOURCE_PERSONA, projectPath, personaId, scope),
  applyPersonaToAgent: (projectPath: string, agentId: string, personaId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.AGENT.APPLY_PERSONA_TO_AGENT, projectPath, agentId, personaId),
  extractAgentPersona: (projectPath: string, agentId: string): Promise<{ content: string; settings: import('../shared/persona-pattern').PatternSettings } | null> =>
    ipcRenderer.invoke(IPC.AGENT.EXTRACT_AGENT_PERSONA, projectPath, agentId),
  createSkill: (basePath: string, name: string, isSource: boolean, projectPath?: string) =>
    ipcRenderer.invoke(IPC.AGENT.CREATE_SKILL, basePath, name, isSource, projectPath),
  createAgentTemplate: (basePath: string, name: string, isSource: boolean, projectPath?: string) =>
    ipcRenderer.invoke(IPC.AGENT.CREATE_AGENT_TEMPLATE, basePath, name, isSource, projectPath),
  readPermissions: (worktreePath: string, projectPath?: string): Promise<{ allow?: string[]; deny?: string[] }> =>
    ipcRenderer.invoke(IPC.AGENT.READ_PERMISSIONS, worktreePath, projectPath),
  savePermissions: (worktreePath: string, permissions: { allow?: string[]; deny?: string[] }, projectPath?: string) =>
    ipcRenderer.invoke(IPC.AGENT.SAVE_PERMISSIONS, worktreePath, permissions, projectPath),
  readSkillContent: (worktreePath: string, skillName: string, projectPath?: string): Promise<string> =>
    ipcRenderer.invoke(IPC.AGENT.READ_SKILL_CONTENT, worktreePath, skillName, projectPath),
  writeSkillContent: (worktreePath: string, skillName: string, content: string, projectPath?: string) =>
    ipcRenderer.invoke(IPC.AGENT.WRITE_SKILL_CONTENT, worktreePath, skillName, content, projectPath),
  deleteSkill: (worktreePath: string, skillName: string, projectPath?: string) =>
    ipcRenderer.invoke(IPC.AGENT.DELETE_SKILL, worktreePath, skillName, projectPath),
  readAgentTemplateContent: (worktreePath: string, agentName: string, projectPath?: string): Promise<string> =>
    ipcRenderer.invoke(IPC.AGENT.READ_AGENT_TEMPLATE_CONTENT, worktreePath, agentName, projectPath),
  writeAgentTemplateContent: (worktreePath: string, agentName: string, content: string, projectPath?: string) =>
    ipcRenderer.invoke(IPC.AGENT.WRITE_AGENT_TEMPLATE_CONTENT, worktreePath, agentName, content, projectPath),
  deleteAgentTemplate: (worktreePath: string, agentName: string, projectPath?: string) =>
    ipcRenderer.invoke(IPC.AGENT.DELETE_AGENT_TEMPLATE, worktreePath, agentName, projectPath),
  listAgentTemplateFiles: (worktreePath: string, projectPath?: string) =>
    ipcRenderer.invoke(IPC.AGENT.LIST_AGENT_TEMPLATE_FILES, worktreePath, projectPath),
  readMcpRawJson: (worktreePath: string, projectPath?: string): Promise<string> =>
    ipcRenderer.invoke(IPC.AGENT.READ_MCP_RAW_JSON, worktreePath, projectPath),
  writeMcpRawJson: (worktreePath: string, content: string, projectPath?: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.AGENT.WRITE_MCP_RAW_JSON, worktreePath, content, projectPath),
  readProjectAgentDefaults: (projectPath: string): Promise<{
    instructions?: string;
    permissions?: { allow?: string[]; deny?: string[] };
    mcpJson?: string;
    freeAgentMode?: boolean;
    sourceControlProvider?: 'github' | 'azure-devops';
    buildCommand?: string;
    testCommand?: string;
    lintCommand?: string;
    mission?: string;
    persona?: string;
    profileId?: string;
    commandPrefix?: string;
  }> =>
    ipcRenderer.invoke(IPC.AGENT.READ_PROJECT_AGENT_DEFAULTS, projectPath),
  writeProjectAgentDefaults: (projectPath: string, defaults: {
    instructions?: string;
    permissions?: { allow?: string[]; deny?: string[] };
    mcpJson?: string;
    freeAgentMode?: boolean;
    sourceControlProvider?: 'github' | 'azure-devops';
    buildCommand?: string;
    testCommand?: string;
    lintCommand?: string;
    mission?: string;
    persona?: string;
    profileId?: string;
    commandPrefix?: string;
  }) =>
    ipcRenderer.invoke(IPC.AGENT.WRITE_PROJECT_AGENT_DEFAULTS, projectPath, defaults),
  resetProjectAgentDefaults: (projectPath: string): Promise<void> =>
    ipcRenderer.invoke(IPC.AGENT.RESET_PROJECT_AGENT_DEFAULTS, projectPath),
  getProjectConfigBreakdown: (projectPath: string, knownPluginIds: string[]) =>
    ipcRenderer.invoke(IPC.AGENT.GET_PROJECT_CONFIG_BREAKDOWN, projectPath, knownPluginIds),
  removePluginInjectionItem: (projectPath: string, itemId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.AGENT.REMOVE_PLUGIN_INJECTION_ITEM, projectPath, itemId),
  getConventions: (projectPath: string): Promise<{
    configDir: string;
    localInstructionsFile: string;
    legacyInstructionsFile: string;
    mcpConfigFile: string;
    skillsDir: string;
    agentTemplatesDir: string;
    localSettingsFile: string;
  } | null> =>
    ipcRenderer.invoke(IPC.AGENT.GET_CONVENTIONS, projectPath),
  materializeAgent: (projectPath: string, agentId: string) =>
    ipcRenderer.invoke(IPC.AGENT.MATERIALIZE_AGENT, projectPath, agentId),
  previewMaterialization: (projectPath: string, agentId: string): Promise<{
    instructions: string;
    permissions: { allow?: string[]; deny?: string[] };
    mcpJson: string | null;
    skills: string[];
    agentTemplates: string[];
  } | null> =>
    ipcRenderer.invoke(IPC.AGENT.PREVIEW_MATERIALIZATION, projectPath, agentId),
  computeConfigDiff: (projectPath: string, agentId: string): Promise<{
    agentId: string;
    agentName: string;
    hasDiffs: boolean;
    items: Array<{
      id: string;
      category: string;
      action: string;
      label: string;
      agentValue?: string;
      defaultValue?: string;
      rawAgentValue?: string;
    }>;
  }> =>
    ipcRenderer.invoke(IPC.AGENT.COMPUTE_CONFIG_DIFF, projectPath, agentId),
  propagateConfigChanges: (projectPath: string, agentId: string, selectedItemIds: string[]): Promise<{
    ok: boolean;
    message: string;
    propagatedCount: number;
  }> =>
    ipcRenderer.invoke(IPC.AGENT.PROPAGATE_CONFIG_CHANGES, projectPath, agentId, selectedItemIds),

  },
};
