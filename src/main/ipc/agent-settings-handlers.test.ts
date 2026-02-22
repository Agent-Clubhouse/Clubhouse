import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}));

vi.mock('../services/agent-settings-service', () => ({
  readClaudeMd: vi.fn(() => '# Instructions'),
  writeClaudeMd: vi.fn(),
  readMcpConfig: vi.fn(() => []),
  listSkills: vi.fn(() => ['skill-a']),
  listAgentTemplates: vi.fn(() => ['template-a']),
  listSourceSkills: vi.fn(() => ['src-skill']),
  listSourceAgentTemplates: vi.fn(() => ['src-template']),
  createSkillDir: vi.fn(() => '/path/to/skill'),
  createAgentTemplateDir: vi.fn(() => '/path/to/template'),
  readPermissions: vi.fn(() => ({ allow: ['read'] })),
  writePermissions: vi.fn(),
  readSkillContent: vi.fn(() => 'skill content'),
  writeSkillContent: vi.fn(),
  deleteSkill: vi.fn(),
  readAgentTemplateContent: vi.fn(() => 'template content'),
  writeAgentTemplateContent: vi.fn(),
  deleteAgentTemplate: vi.fn(),
  listAgentTemplateFiles: vi.fn(() => ['file.md']),
  readMcpRawJson: vi.fn(() => '{"mcpServers": {}}'),
  writeMcpRawJson: vi.fn(),
  readProjectAgentDefaults: vi.fn(() => ({})),
  writeProjectAgentDefaults: vi.fn(),
  readSourceSkillContent: vi.fn(() => 'src skill content'),
  writeSourceSkillContent: vi.fn(),
  deleteSourceSkill: vi.fn(),
  readSourceAgentTemplateContent: vi.fn(() => 'src template content'),
  writeSourceAgentTemplateContent: vi.fn(),
  deleteSourceAgentTemplate: vi.fn(),
}));

vi.mock('../services/agent-system', () => ({
  resolveOrchestrator: vi.fn(() => ({
    conventions: { configDir: '.claude', localInstructionsFile: 'CLAUDE.md' },
    readInstructions: vi.fn(() => 'provider instructions'),
    writeInstructions: vi.fn(),
  })),
}));

vi.mock('../services/agent-config', () => ({
  getDurableConfig: vi.fn(() => ({ id: 'a1', orchestrator: 'claude-code' })),
}));

vi.mock('../services/materialization-service', () => ({
  materializeAgent: vi.fn(),
  previewMaterialization: vi.fn(() => ({ instructions: '', permissions: {}, mcpJson: null, skills: [], agentTemplates: [] })),
}));

vi.mock('../services/config-diff-service', () => ({
  computeConfigDiff: vi.fn(() => ({ agentId: 'a1', agentName: 'Bot', hasDiffs: false, items: [] })),
  propagateChanges: vi.fn(() => ({ ok: true, message: 'done', propagatedCount: 0 })),
}));

import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { registerAgentSettingsHandlers } from './agent-settings-handlers';
import * as agentSettings from '../services/agent-settings-service';
import * as agentSystem from '../services/agent-system';

describe('agent-settings-handlers', () => {
  let handlers: Map<string, (...args: any[]) => any>;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = new Map();
    vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: any) => {
      handlers.set(channel, handler);
    });
    registerAgentSettingsHandlers();
  });

  it('registers all agent-settings IPC handlers', () => {
    const expectedChannels = [
      IPC.AGENT.READ_INSTRUCTIONS, IPC.AGENT.SAVE_INSTRUCTIONS,
      IPC.AGENT.READ_MCP_CONFIG, IPC.AGENT.LIST_SKILLS, IPC.AGENT.LIST_AGENT_TEMPLATES,
      IPC.AGENT.LIST_SOURCE_SKILLS, IPC.AGENT.LIST_SOURCE_AGENT_TEMPLATES,
      IPC.AGENT.CREATE_SKILL, IPC.AGENT.CREATE_AGENT_TEMPLATE,
      IPC.AGENT.READ_PERMISSIONS, IPC.AGENT.SAVE_PERMISSIONS,
      IPC.AGENT.READ_SKILL_CONTENT, IPC.AGENT.WRITE_SKILL_CONTENT, IPC.AGENT.DELETE_SKILL,
      IPC.AGENT.READ_AGENT_TEMPLATE_CONTENT, IPC.AGENT.WRITE_AGENT_TEMPLATE_CONTENT, IPC.AGENT.DELETE_AGENT_TEMPLATE,
      IPC.AGENT.LIST_AGENT_TEMPLATE_FILES,
      IPC.AGENT.READ_MCP_RAW_JSON, IPC.AGENT.WRITE_MCP_RAW_JSON,
      IPC.AGENT.READ_PROJECT_AGENT_DEFAULTS, IPC.AGENT.WRITE_PROJECT_AGENT_DEFAULTS,
      IPC.AGENT.GET_CONVENTIONS,
      IPC.AGENT.READ_SOURCE_SKILL_CONTENT, IPC.AGENT.WRITE_SOURCE_SKILL_CONTENT, IPC.AGENT.DELETE_SOURCE_SKILL,
      IPC.AGENT.READ_SOURCE_AGENT_TEMPLATE_CONTENT, IPC.AGENT.WRITE_SOURCE_AGENT_TEMPLATE_CONTENT,
      IPC.AGENT.DELETE_SOURCE_AGENT_TEMPLATE,
      IPC.AGENT.MATERIALIZE_AGENT, IPC.AGENT.PREVIEW_MATERIALIZATION,
      IPC.AGENT.COMPUTE_CONFIG_DIFF, IPC.AGENT.PROPAGATE_CONFIG_CHANGES,
    ];
    for (const channel of expectedChannels) {
      expect(handlers.has(channel)).toBe(true);
    }
  });

  it('READ_INSTRUCTIONS uses provider when projectPath is given', async () => {
    const handler = handlers.get(IPC.AGENT.READ_INSTRUCTIONS)!;
    await handler({}, '/worktree', '/project');
    expect(agentSystem.resolveOrchestrator).toHaveBeenCalledWith('/project');
  });

  it('READ_INSTRUCTIONS falls back to readClaudeMd without projectPath', async () => {
    const handler = handlers.get(IPC.AGENT.READ_INSTRUCTIONS)!;
    const result = await handler({}, '/worktree');
    expect(agentSettings.readClaudeMd).toHaveBeenCalledWith('/worktree');
    expect(result).toBe('# Instructions');
  });

  it('SAVE_INSTRUCTIONS uses provider when projectPath given', async () => {
    const handler = handlers.get(IPC.AGENT.SAVE_INSTRUCTIONS)!;
    await handler({}, '/worktree', 'new content', '/project');
    expect(agentSystem.resolveOrchestrator).toHaveBeenCalledWith('/project');
  });

  it('SAVE_INSTRUCTIONS falls back to writeClaudeMd without projectPath', async () => {
    const handler = handlers.get(IPC.AGENT.SAVE_INSTRUCTIONS)!;
    await handler({}, '/worktree', 'new content');
    expect(agentSettings.writeClaudeMd).toHaveBeenCalledWith('/worktree', 'new content');
  });

  it('LIST_SKILLS delegates to agentSettings.listSkills', async () => {
    const handler = handlers.get(IPC.AGENT.LIST_SKILLS)!;
    const result = await handler({}, '/worktree');
    expect(agentSettings.listSkills).toHaveBeenCalled();
    expect(result).toEqual(['skill-a']);
  });

  it('READ_PERMISSIONS delegates to agentSettings.readPermissions', async () => {
    const handler = handlers.get(IPC.AGENT.READ_PERMISSIONS)!;
    const result = await handler({}, '/worktree');
    expect(agentSettings.readPermissions).toHaveBeenCalled();
    expect(result).toEqual({ allow: ['read'] });
  });

  it('SAVE_PERMISSIONS delegates to agentSettings.writePermissions', async () => {
    const handler = handlers.get(IPC.AGENT.SAVE_PERMISSIONS)!;
    await handler({}, '/worktree', { allow: ['read', 'edit'] });
    expect(agentSettings.writePermissions).toHaveBeenCalled();
  });

  it('GET_CONVENTIONS returns provider conventions', async () => {
    const handler = handlers.get(IPC.AGENT.GET_CONVENTIONS)!;
    const result = await handler({}, '/project');
    expect(result).toEqual({ configDir: '.claude', localInstructionsFile: 'CLAUDE.md' });
  });

  it('GET_CONVENTIONS returns null when resolveOrchestrator throws', async () => {
    vi.mocked(agentSystem.resolveOrchestrator).mockImplementationOnce(() => {
      throw new Error('not found');
    });
    const handler = handlers.get(IPC.AGENT.GET_CONVENTIONS)!;
    const result = await handler({}, '/project');
    expect(result).toBeNull();
  });

  it('READ_PROJECT_AGENT_DEFAULTS delegates to agentSettings', async () => {
    const handler = handlers.get(IPC.AGENT.READ_PROJECT_AGENT_DEFAULTS)!;
    const result = await handler({}, '/project');
    expect(agentSettings.readProjectAgentDefaults).toHaveBeenCalledWith('/project');
    expect(result).toEqual({});
  });
});
