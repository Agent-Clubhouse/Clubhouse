import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';

export const agentSettings = {
  agentSettings: {
  readInstructions: (worktreePath: string, projectPath?: string) =>
    ipcRenderer.invoke(IPC.AGENT.READ_INSTRUCTIONS, worktreePath, projectPath),
  saveInstructions: (worktreePath: string, content: string, projectPath?: string) =>
    ipcRenderer.invoke(IPC.AGENT.SAVE_INSTRUCTIONS, worktreePath, content, projectPath),
  readMcpConfig: (worktreePath: string, projectPath?: string, agentId?: string) =>
    ipcRenderer.invoke(IPC.AGENT.READ_MCP_CONFIG, worktreePath, projectPath, agentId),
  listSkills: (worktreePath: string, projectPath?: string, agentId?: string) =>
    ipcRenderer.invoke(IPC.AGENT.LIST_SKILLS, worktreePath, projectPath, agentId),
  listAgentTemplates: (worktreePath: string, projectPath?: string) =>
    ipcRenderer.invoke(IPC.AGENT.LIST_AGENT_TEMPLATES, worktreePath, projectPath),
  // Project source skills and agent templates: only the plugin agentConfig API's inject and remove (#2901).
  writeSourceSkillContent: (projectPath: string, skillName: string, content: string) =>
    ipcRenderer.invoke(IPC.AGENT.WRITE_SOURCE_SKILL_CONTENT, projectPath, skillName, content),
  deleteSourceSkill: (projectPath: string, skillName: string) =>
    ipcRenderer.invoke(IPC.AGENT.DELETE_SOURCE_SKILL, projectPath, skillName),
  writeSourceAgentTemplateContent: (projectPath: string, agentName: string, content: string) =>
    ipcRenderer.invoke(IPC.AGENT.WRITE_SOURCE_AGENT_TEMPLATE_CONTENT, projectPath, agentName, content),
  deleteSourceAgentTemplate: (projectPath: string, agentName: string) =>
    ipcRenderer.invoke(IPC.AGENT.DELETE_SOURCE_AGENT_TEMPLATE, projectPath, agentName),
  createSkill: (basePath: string, name: string, isSource: boolean, projectPath?: string) =>
    ipcRenderer.invoke(IPC.AGENT.CREATE_SKILL, basePath, name, isSource, projectPath),
  createAgentTemplate: (basePath: string, name: string, isSource: boolean, projectPath?: string) =>
    ipcRenderer.invoke(IPC.AGENT.CREATE_AGENT_TEMPLATE, basePath, name, isSource, projectPath),
  readPermissions: (worktreePath: string, projectPath?: string): Promise<{ allow?: string[]; deny?: string[] }> =>
    ipcRenderer.invoke(IPC.AGENT.READ_PERMISSIONS, worktreePath, projectPath),
  savePermissions: (worktreePath: string, permissions: { allow?: string[]; deny?: string[] }, projectPath?: string) =>
    ipcRenderer.invoke(IPC.AGENT.SAVE_PERMISSIONS, worktreePath, permissions, projectPath),
  readSkillContent: (worktreePath: string, skillName: string, projectPath?: string, agentId?: string): Promise<string> =>
    ipcRenderer.invoke(IPC.AGENT.READ_SKILL_CONTENT, worktreePath, skillName, projectPath, agentId),
  writeSkillContent: (worktreePath: string, skillName: string, content: string, projectPath?: string, agentId?: string) =>
    ipcRenderer.invoke(IPC.AGENT.WRITE_SKILL_CONTENT, worktreePath, skillName, content, projectPath, agentId),
  deleteSkill: (worktreePath: string, skillName: string, projectPath?: string, agentId?: string) =>
    ipcRenderer.invoke(IPC.AGENT.DELETE_SKILL, worktreePath, skillName, projectPath, agentId),
  readAgentTemplateContent: (worktreePath: string, agentName: string, projectPath?: string): Promise<string> =>
    ipcRenderer.invoke(IPC.AGENT.READ_AGENT_TEMPLATE_CONTENT, worktreePath, agentName, projectPath),
  writeAgentTemplateContent: (worktreePath: string, agentName: string, content: string, projectPath?: string) =>
    ipcRenderer.invoke(IPC.AGENT.WRITE_AGENT_TEMPLATE_CONTENT, worktreePath, agentName, content, projectPath),
  deleteAgentTemplate: (worktreePath: string, agentName: string, projectPath?: string) =>
    ipcRenderer.invoke(IPC.AGENT.DELETE_AGENT_TEMPLATE, worktreePath, agentName, projectPath),
  listAgentTemplateFiles: (worktreePath: string, projectPath?: string) =>
    ipcRenderer.invoke(IPC.AGENT.LIST_AGENT_TEMPLATE_FILES, worktreePath, projectPath),
  readMcpRawJson: (worktreePath: string, projectPath?: string, agentId?: string): Promise<string> =>
    ipcRenderer.invoke(IPC.AGENT.READ_MCP_RAW_JSON, worktreePath, projectPath, agentId),
  getMcpShadowWarning: (worktreePath: string, projectPath?: string, agentId?: string): Promise<string | undefined> =>
    ipcRenderer.invoke(IPC.AGENT.GET_MCP_SHADOW_WARNING, worktreePath, projectPath, agentId),
  writeMcpRawJson: (worktreePath: string, content: string, projectPath?: string, agentId?: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.AGENT.WRITE_MCP_RAW_JSON, worktreePath, content, projectPath, agentId),
  readProjectAgentDefaults: (projectPath: string): Promise<{
    helperAuto?: 'off';
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
    helperAuto?: 'off';
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
  },
};
