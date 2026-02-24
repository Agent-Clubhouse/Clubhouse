import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}));

vi.mock('../services/agent-settings-service', () => ({
  readClaudeMd: vi.fn(() => '# Instructions'),
  writeClaudeMd: vi.fn(),
  readMcpConfig: vi.fn(() => [{ name: 'server-1' }]),
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
  readProjectAgentDefaults: vi.fn(() => ({ model: 'default' })),
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
  getDurableConfig: vi.fn(() => ({ id: 'a1', name: 'Bot', orchestrator: 'claude-code' })),
}));

vi.mock('../services/materialization-service', () => ({
  materializeAgent: vi.fn(),
  previewMaterialization: vi.fn(() => ({ instructions: 'merged', permissions: {}, mcpJson: null, skills: [], agentTemplates: [] })),
  resetProjectAgentDefaults: vi.fn(),
}));

vi.mock('../services/config-diff-service', () => ({
  computeConfigDiff: vi.fn(() => ({ agentId: 'a1', agentName: 'Bot', hasDiffs: true, items: [{ id: 'i1' }] })),
  propagateChanges: vi.fn(() => ({ ok: true, message: 'done', propagatedCount: 2 })),
}));

import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { registerAgentSettingsHandlers } from './agent-settings-handlers';
import * as agentSettings from '../services/agent-settings-service';
import * as agentSystem from '../services/agent-system';
import * as agentConfig from '../services/agent-config';
import { materializeAgent, previewMaterialization, resetProjectAgentDefaults } from '../services/materialization-service';
import { computeConfigDiff, propagateChanges } from '../services/config-diff-service';

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
      IPC.AGENT.READ_PROJECT_AGENT_DEFAULTS, IPC.AGENT.WRITE_PROJECT_AGENT_DEFAULTS, IPC.AGENT.RESET_PROJECT_AGENT_DEFAULTS,
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

  // --- Instructions ---

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

  // --- MCP ---

  it('READ_MCP_CONFIG delegates to agentSettings.readMcpConfig', async () => {
    const handler = handlers.get(IPC.AGENT.READ_MCP_CONFIG)!;
    const result = await handler({}, '/worktree');
    expect(agentSettings.readMcpConfig).toHaveBeenCalled();
    expect(result).toEqual([{ name: 'server-1' }]);
  });

  it('READ_MCP_RAW_JSON delegates to agentSettings.readMcpRawJson', async () => {
    const handler = handlers.get(IPC.AGENT.READ_MCP_RAW_JSON)!;
    const result = await handler({}, '/worktree');
    expect(agentSettings.readMcpRawJson).toHaveBeenCalled();
    expect(result).toBe('{"mcpServers": {}}');
  });

  it('WRITE_MCP_RAW_JSON delegates to agentSettings.writeMcpRawJson', async () => {
    const handler = handlers.get(IPC.AGENT.WRITE_MCP_RAW_JSON)!;
    await handler({}, '/worktree', '{"mcpServers": {"new": {}}}');
    expect(agentSettings.writeMcpRawJson).toHaveBeenCalled();
  });

  // --- Skills ---

  it('LIST_SKILLS delegates to agentSettings.listSkills', async () => {
    const handler = handlers.get(IPC.AGENT.LIST_SKILLS)!;
    const result = await handler({}, '/worktree');
    expect(agentSettings.listSkills).toHaveBeenCalled();
    expect(result).toEqual(['skill-a']);
  });

  it('LIST_SOURCE_SKILLS delegates to agentSettings.listSourceSkills', async () => {
    const handler = handlers.get(IPC.AGENT.LIST_SOURCE_SKILLS)!;
    const result = await handler({}, '/project');
    expect(agentSettings.listSourceSkills).toHaveBeenCalledWith('/project');
    expect(result).toEqual(['src-skill']);
  });

  it('CREATE_SKILL delegates to agentSettings.createSkillDir', async () => {
    const handler = handlers.get(IPC.AGENT.CREATE_SKILL)!;
    const result = await handler({}, '/base', 'my-skill', false);
    expect(agentSettings.createSkillDir).toHaveBeenCalled();
    expect(result).toBe('/path/to/skill');
  });

  it('READ_SKILL_CONTENT delegates to agentSettings.readSkillContent', async () => {
    const handler = handlers.get(IPC.AGENT.READ_SKILL_CONTENT)!;
    const result = await handler({}, '/worktree', 'skill-a');
    expect(agentSettings.readSkillContent).toHaveBeenCalled();
    expect(result).toBe('skill content');
  });

  it('WRITE_SKILL_CONTENT delegates to agentSettings.writeSkillContent', async () => {
    const handler = handlers.get(IPC.AGENT.WRITE_SKILL_CONTENT)!;
    await handler({}, '/worktree', 'skill-a', 'updated content');
    expect(agentSettings.writeSkillContent).toHaveBeenCalled();
  });

  it('DELETE_SKILL delegates to agentSettings.deleteSkill', async () => {
    const handler = handlers.get(IPC.AGENT.DELETE_SKILL)!;
    await handler({}, '/worktree', 'skill-a');
    expect(agentSettings.deleteSkill).toHaveBeenCalled();
  });

  // --- Source skills ---

  it('READ_SOURCE_SKILL_CONTENT delegates to agentSettings.readSourceSkillContent', async () => {
    const handler = handlers.get(IPC.AGENT.READ_SOURCE_SKILL_CONTENT)!;
    const result = await handler({}, '/project', 'src-skill');
    expect(agentSettings.readSourceSkillContent).toHaveBeenCalledWith('/project', 'src-skill');
    expect(result).toBe('src skill content');
  });

  it('WRITE_SOURCE_SKILL_CONTENT delegates to agentSettings.writeSourceSkillContent', async () => {
    const handler = handlers.get(IPC.AGENT.WRITE_SOURCE_SKILL_CONTENT)!;
    await handler({}, '/project', 'src-skill', 'new content');
    expect(agentSettings.writeSourceSkillContent).toHaveBeenCalledWith('/project', 'src-skill', 'new content');
  });

  it('DELETE_SOURCE_SKILL delegates to agentSettings.deleteSourceSkill', async () => {
    const handler = handlers.get(IPC.AGENT.DELETE_SOURCE_SKILL)!;
    await handler({}, '/project', 'src-skill');
    expect(agentSettings.deleteSourceSkill).toHaveBeenCalledWith('/project', 'src-skill');
  });

  // --- Agent templates ---

  it('LIST_AGENT_TEMPLATES delegates to agentSettings.listAgentTemplates', async () => {
    const handler = handlers.get(IPC.AGENT.LIST_AGENT_TEMPLATES)!;
    const result = await handler({}, '/worktree');
    expect(agentSettings.listAgentTemplates).toHaveBeenCalled();
    expect(result).toEqual(['template-a']);
  });

  it('LIST_SOURCE_AGENT_TEMPLATES delegates to agentSettings.listSourceAgentTemplates', async () => {
    const handler = handlers.get(IPC.AGENT.LIST_SOURCE_AGENT_TEMPLATES)!;
    const result = await handler({}, '/project');
    expect(agentSettings.listSourceAgentTemplates).toHaveBeenCalledWith('/project');
    expect(result).toEqual(['src-template']);
  });

  it('CREATE_AGENT_TEMPLATE delegates to agentSettings.createAgentTemplateDir', async () => {
    const handler = handlers.get(IPC.AGENT.CREATE_AGENT_TEMPLATE)!;
    const result = await handler({}, '/base', 'my-template', true);
    expect(agentSettings.createAgentTemplateDir).toHaveBeenCalled();
    expect(result).toBe('/path/to/template');
  });

  it('READ_AGENT_TEMPLATE_CONTENT delegates to agentSettings', async () => {
    const handler = handlers.get(IPC.AGENT.READ_AGENT_TEMPLATE_CONTENT)!;
    const result = await handler({}, '/worktree', 'template-a');
    expect(agentSettings.readAgentTemplateContent).toHaveBeenCalled();
    expect(result).toBe('template content');
  });

  it('WRITE_AGENT_TEMPLATE_CONTENT delegates to agentSettings', async () => {
    const handler = handlers.get(IPC.AGENT.WRITE_AGENT_TEMPLATE_CONTENT)!;
    await handler({}, '/worktree', 'template-a', 'updated');
    expect(agentSettings.writeAgentTemplateContent).toHaveBeenCalled();
  });

  it('DELETE_AGENT_TEMPLATE delegates to agentSettings', async () => {
    const handler = handlers.get(IPC.AGENT.DELETE_AGENT_TEMPLATE)!;
    await handler({}, '/worktree', 'template-a');
    expect(agentSettings.deleteAgentTemplate).toHaveBeenCalled();
  });

  it('LIST_AGENT_TEMPLATE_FILES delegates to agentSettings', async () => {
    const handler = handlers.get(IPC.AGENT.LIST_AGENT_TEMPLATE_FILES)!;
    const result = await handler({}, '/worktree');
    expect(agentSettings.listAgentTemplateFiles).toHaveBeenCalled();
    expect(result).toEqual(['file.md']);
  });

  // --- Source agent templates ---

  it('READ_SOURCE_AGENT_TEMPLATE_CONTENT delegates to agentSettings', async () => {
    const handler = handlers.get(IPC.AGENT.READ_SOURCE_AGENT_TEMPLATE_CONTENT)!;
    const result = await handler({}, '/project', 'src-template');
    expect(agentSettings.readSourceAgentTemplateContent).toHaveBeenCalledWith('/project', 'src-template');
    expect(result).toBe('src template content');
  });

  it('WRITE_SOURCE_AGENT_TEMPLATE_CONTENT delegates to agentSettings', async () => {
    const handler = handlers.get(IPC.AGENT.WRITE_SOURCE_AGENT_TEMPLATE_CONTENT)!;
    await handler({}, '/project', 'src-template', 'new content');
    expect(agentSettings.writeSourceAgentTemplateContent).toHaveBeenCalledWith('/project', 'src-template', 'new content');
  });

  it('DELETE_SOURCE_AGENT_TEMPLATE delegates to agentSettings', async () => {
    const handler = handlers.get(IPC.AGENT.DELETE_SOURCE_AGENT_TEMPLATE)!;
    await handler({}, '/project', 'src-template');
    expect(agentSettings.deleteSourceAgentTemplate).toHaveBeenCalledWith('/project', 'src-template');
  });

  // --- Permissions ---

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

  // --- Project agent defaults ---

  it('READ_PROJECT_AGENT_DEFAULTS delegates to agentSettings', async () => {
    const handler = handlers.get(IPC.AGENT.READ_PROJECT_AGENT_DEFAULTS)!;
    const result = await handler({}, '/project');
    expect(agentSettings.readProjectAgentDefaults).toHaveBeenCalledWith('/project');
    expect(result).toEqual({ model: 'default' });
  });

  it('WRITE_PROJECT_AGENT_DEFAULTS delegates to agentSettings', async () => {
    const handler = handlers.get(IPC.AGENT.WRITE_PROJECT_AGENT_DEFAULTS)!;
    await handler({}, '/project', { model: 'opus' });
    expect(agentSettings.writeProjectAgentDefaults).toHaveBeenCalledWith('/project', { model: 'opus' });
  });

  it('RESET_PROJECT_AGENT_DEFAULTS delegates to resetProjectAgentDefaults', async () => {
    const handler = handlers.get(IPC.AGENT.RESET_PROJECT_AGENT_DEFAULTS)!;
    await handler({}, '/project');
    expect(resetProjectAgentDefaults).toHaveBeenCalledWith('/project');
  });

  // --- Conventions ---

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

  // --- Materialization ---

  it('MATERIALIZE_AGENT calls materializeAgent with agent config', async () => {
    const handler = handlers.get(IPC.AGENT.MATERIALIZE_AGENT)!;
    await handler({}, '/project', 'a1');
    expect(agentConfig.getDurableConfig).toHaveBeenCalledWith('/project', 'a1');
    expect(materializeAgent).toHaveBeenCalledWith(expect.objectContaining({
      projectPath: '/project',
      agent: expect.objectContaining({ id: 'a1' }),
    }));
  });

  it('MATERIALIZE_AGENT returns early when agent config is null', async () => {
    vi.mocked(agentConfig.getDurableConfig).mockReturnValueOnce(null as any);
    const handler = handlers.get(IPC.AGENT.MATERIALIZE_AGENT)!;
    await handler({}, '/project', 'missing');
    expect(materializeAgent).not.toHaveBeenCalled();
  });

  it('PREVIEW_MATERIALIZATION returns preview result', async () => {
    const handler = handlers.get(IPC.AGENT.PREVIEW_MATERIALIZATION)!;
    const result = await handler({}, '/project', 'a1');
    expect(agentConfig.getDurableConfig).toHaveBeenCalledWith('/project', 'a1');
    expect(previewMaterialization).toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ instructions: 'merged' }));
  });

  it('PREVIEW_MATERIALIZATION returns null when agent config is null', async () => {
    vi.mocked(agentConfig.getDurableConfig).mockReturnValueOnce(null as any);
    const handler = handlers.get(IPC.AGENT.PREVIEW_MATERIALIZATION)!;
    const result = await handler({}, '/project', 'missing');
    expect(result).toBeNull();
  });

  // --- Config diff ---

  it('COMPUTE_CONFIG_DIFF returns diff result', async () => {
    const handler = handlers.get(IPC.AGENT.COMPUTE_CONFIG_DIFF)!;
    const result = await handler({}, '/project', 'a1');
    expect(agentConfig.getDurableConfig).toHaveBeenCalledWith('/project', 'a1');
    expect(computeConfigDiff).toHaveBeenCalledWith(expect.objectContaining({
      projectPath: '/project',
      agentId: 'a1',
    }));
    expect(result).toEqual(expect.objectContaining({ hasDiffs: true }));
  });

  it('COMPUTE_CONFIG_DIFF returns empty result when agent not found', async () => {
    vi.mocked(agentConfig.getDurableConfig).mockReturnValueOnce(null as any);
    const handler = handlers.get(IPC.AGENT.COMPUTE_CONFIG_DIFF)!;
    const result = await handler({}, '/project', 'missing');
    expect(result).toEqual({ agentId: 'missing', agentName: '', hasDiffs: false, items: [] });
    expect(computeConfigDiff).not.toHaveBeenCalled();
  });

  it('PROPAGATE_CONFIG_CHANGES propagates selected items', async () => {
    const handler = handlers.get(IPC.AGENT.PROPAGATE_CONFIG_CHANGES)!;
    const result = await handler({}, '/project', 'a1', ['i1', 'i2']);
    expect(propagateChanges).toHaveBeenCalledWith(expect.objectContaining({
      projectPath: '/project',
      agentId: 'a1',
      selectedItemIds: ['i1', 'i2'],
    }));
    expect(result).toEqual({ ok: true, message: 'done', propagatedCount: 2 });
  });

  it('PROPAGATE_CONFIG_CHANGES returns error when agent not found', async () => {
    vi.mocked(agentConfig.getDurableConfig).mockReturnValueOnce(null as any);
    const handler = handlers.get(IPC.AGENT.PROPAGATE_CONFIG_CHANGES)!;
    const result = await handler({}, '/project', 'missing', ['i1']);
    expect(result).toEqual({ ok: false, message: 'Agent not found', propagatedCount: 0 });
    expect(propagateChanges).not.toHaveBeenCalled();
  });
});
