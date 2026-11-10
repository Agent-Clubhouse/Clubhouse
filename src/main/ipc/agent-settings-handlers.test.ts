import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { isPackaged: false, getPath: () => 'clubhouse-test-home' },
}));

vi.mock('../services/agent-settings-service', () => ({
  readClaudeMd: vi.fn(async () => '# Instructions'),
  writeClaudeMd: vi.fn(async () => undefined),
  readMcpConfig: vi.fn(async () => [{ name: 'server-1' }]),
  listSkills: vi.fn(async () => ['skill-a']),
  listAgentTemplates: vi.fn(async () => ['template-a']),
  listSourceSkills: vi.fn(async () => ['src-skill']),
  listSourceAgentTemplates: vi.fn(async () => ['src-template']),
  createSkillDir: vi.fn(async () => '/path/to/skill'),
  createAgentTemplateDir: vi.fn(async () => '/path/to/template'),
  readPermissions: vi.fn(async () => ({ allow: ['read'] })),
  writePermissions: vi.fn(async () => undefined),
  readSkillContent: vi.fn(async () => 'skill content'),
  writeSkillContent: vi.fn(async () => undefined),
  deleteSkill: vi.fn(async () => undefined),
  readAgentTemplateContent: vi.fn(async () => 'template content'),
  writeAgentTemplateContent: vi.fn(async () => undefined),
  deleteAgentTemplate: vi.fn(async () => undefined),
  listAgentTemplateFiles: vi.fn(async () => ['file.md']),
  readMcpRawJson: vi.fn(async () => '{"mcpServers": {}}'),
  writeMcpRawJson: vi.fn(async () => undefined),
  readProjectAgentDefaults: vi.fn(async () => ({ model: 'default' })),
  writeProjectAgentDefaults: vi.fn(async () => undefined),
  updateProjectAgentDefaults: vi.fn(async () => ({})),
  readSourceSkillContent: vi.fn(async () => 'src skill content'),
  writeSourceSkillContent: vi.fn(async () => undefined),
  deleteSourceSkill: vi.fn(async () => undefined),
  readSourceAgentTemplateContent: vi.fn(async () => 'src template content'),
  writeSourceAgentTemplateContent: vi.fn(async () => undefined),
  deleteSourceAgentTemplate: vi.fn(async () => undefined),
}));

vi.mock('../services/agent-system', () => ({
  resolveOrchestrator: vi.fn(async () => ({
    conventions: { configDir: '.claude', localInstructionsFile: 'CLAUDE.md' },
    readInstructions: vi.fn(() => 'provider instructions'),
    writeInstructions: vi.fn(),
  })),
}));

vi.mock('../services/agent-config', () => ({
  getDurableConfig: vi.fn(() => ({ id: 'a1', name: 'Bot', orchestrator: 'claude-code' })),
  updateDurableConfig: vi.fn(async () => undefined),
}));

vi.mock('../services/log-service', () => ({
  appLog: vi.fn(),
}));

import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { registerAgentSettingsHandlers } from './agent-settings-handlers';
import * as agentSettings from '../services/agent-settings-service';
import * as agentSystem from '../services/agent-system';
import * as agentConfig from '../services/agent-config';

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

  it('uses the explicit agent provider for the existing skill list and content operations', async () => {
    vi.mocked(agentConfig.getDurableConfig).mockResolvedValueOnce({ id: 'copilot', worktreePath: '/worktree', orchestrator: 'copilot-cli' } as never);
    const conventions = { configDir: '.github', skillsDir: 'skills' };
    vi.mocked(agentSystem.resolveOrchestrator).mockResolvedValueOnce({ conventions } as never);
    await handlers.get(IPC.AGENT.LIST_SKILLS)!({}, '/worktree', '/project', 'copilot');
    expect(agentSystem.resolveOrchestrator).toHaveBeenCalledWith('/project', 'copilot-cli');
    expect(agentSettings.listSkills).toHaveBeenCalledWith('/worktree', conventions);
    for (const [channel, args, method] of [
      [IPC.AGENT.READ_SKILL_CONTENT, ['/worktree', 'review', '/project', 'copilot'], agentSettings.readSkillContent],
      [IPC.AGENT.WRITE_SKILL_CONTENT, ['/worktree', 'review', 'body', '/project', 'copilot'], agentSettings.writeSkillContent],
      [IPC.AGENT.DELETE_SKILL, ['/worktree', 'review', '/project', 'copilot'], agentSettings.deleteSkill],
    ] as const) {
      vi.mocked(agentConfig.getDurableConfig).mockResolvedValueOnce({ id: 'copilot', worktreePath: '/worktree', orchestrator: 'copilot-cli' } as never);
      vi.mocked(agentSystem.resolveOrchestrator).mockResolvedValueOnce({ conventions } as never);
      await handlers.get(channel)!({}, ...args);
      expect(method).toHaveBeenLastCalledWith(...args.slice(0, -2), conventions);
    }
  });

  it('lists and edits the effective-provider file while preserving supporting bundle bytes and mode', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const actual = await vi.importActual<typeof import('../services/agent-settings-service')>('../services/agent-settings-service');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-provider-'));
    const worktree = path.join(root, 'agent');
    const skill = path.join(worktree, '.github/skills/review');
    const other = path.join(worktree, '.claude/skills/review');
    try {
      await fs.mkdir(path.join(skill, 'scripts'), { recursive: true });
      await fs.mkdir(other, { recursive: true });
      await fs.writeFile(path.join(skill, 'SKILL.md'), 'Copilot instructions');
      await fs.writeFile(path.join(skill, 'scripts/check.sh'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
      await fs.writeFile(path.join(other, 'SKILL.md'), 'Untouched Claude instructions');
      const scriptBefore = await fs.readFile(path.join(skill, 'scripts/check.sh'));
      const modeBefore = (await fs.stat(path.join(skill, 'scripts/check.sh'))).mode;
      const bind = () => {
        vi.mocked(agentConfig.getDurableConfig).mockResolvedValueOnce({ id: 'c', worktreePath: worktree, orchestrator: 'copilot-cli' } as never);
        vi.mocked(agentSystem.resolveOrchestrator).mockResolvedValueOnce({ conventions: { configDir: '.github', skillsDir: 'skills' } } as never);
      };
      bind(); vi.mocked(agentSettings.listSkills).mockImplementationOnce(actual.listSkills);
      expect(await handlers.get(IPC.AGENT.LIST_SKILLS)!({}, worktree, root, 'c')).toEqual([expect.objectContaining({ name: 'review', path: skill })]);
      bind(); vi.mocked(agentSettings.readSkillContent).mockImplementationOnce(actual.readSkillContent);
      expect(await handlers.get(IPC.AGENT.READ_SKILL_CONTENT)!({}, worktree, 'review', root, 'c')).toBe('Copilot instructions');
      bind(); vi.mocked(agentSettings.writeSkillContent).mockImplementationOnce(actual.writeSkillContent);
      await handlers.get(IPC.AGENT.WRITE_SKILL_CONTENT)!({}, worktree, 'review', 'Edited Copilot instructions', root, 'c');
      expect(await fs.readFile(path.join(skill, 'SKILL.md'), 'utf8')).toBe('Edited Copilot instructions');
      expect(await fs.readFile(path.join(other, 'SKILL.md'), 'utf8')).toBe('Untouched Claude instructions');
      expect(await fs.readFile(path.join(skill, 'scripts/check.sh'))).toEqual(scriptBefore);
      expect((await fs.stat(path.join(skill, 'scripts/check.sh'))).mode).toBe(modeBefore);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('refuses an explicit skill target whose current folder no longer matches', async () => {
    vi.mocked(agentConfig.getDurableConfig).mockResolvedValueOnce({ id: 'a1', worktreePath: '/different', orchestrator: 'claude-code' } as never);
    await expect(handlers.get(IPC.AGENT.WRITE_SKILL_CONTENT)!({}, '/worktree', 'review', 'body', '/project', 'a1')).rejects.toThrow('target changed');
    expect(agentSettings.writeSkillContent).not.toHaveBeenCalled();
  });

  it('registers all agent-settings IPC handlers', () => {
    const expectedChannels = [
      IPC.AGENT.READ_INSTRUCTIONS, IPC.AGENT.SAVE_INSTRUCTIONS,
      IPC.AGENT.READ_MCP_CONFIG, IPC.AGENT.LIST_SKILLS, IPC.AGENT.LIST_AGENT_TEMPLATES,
      IPC.AGENT.CREATE_SKILL, IPC.AGENT.CREATE_AGENT_TEMPLATE,
      IPC.AGENT.READ_PERMISSIONS, IPC.AGENT.SAVE_PERMISSIONS,
      IPC.AGENT.READ_SKILL_CONTENT, IPC.AGENT.WRITE_SKILL_CONTENT, IPC.AGENT.DELETE_SKILL,
      IPC.AGENT.READ_AGENT_TEMPLATE_CONTENT, IPC.AGENT.WRITE_AGENT_TEMPLATE_CONTENT, IPC.AGENT.DELETE_AGENT_TEMPLATE,
      IPC.AGENT.LIST_AGENT_TEMPLATE_FILES,
      IPC.AGENT.READ_MCP_RAW_JSON, IPC.AGENT.WRITE_MCP_RAW_JSON,
      IPC.AGENT.READ_PROJECT_AGENT_DEFAULTS, IPC.AGENT.SAVE_PROJECT_USER_DEFAULTS, IPC.AGENT.UPDATE_PLUGIN_AGENT_DEFAULTS,
      IPC.AGENT.GET_CONVENTIONS,
      IPC.AGENT.WRITE_SOURCE_SKILL_CONTENT, IPC.AGENT.DELETE_SOURCE_SKILL,
      IPC.AGENT.WRITE_SOURCE_AGENT_TEMPLATE_CONTENT, IPC.AGENT.DELETE_SOURCE_AGENT_TEMPLATE,
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

  it('registers no whole-object defaults write (#3262)', () => {
    expect(handlers.has('agent:write-project-agent-defaults')).toBe(false);
  });

  it('UPDATE_PLUGIN_AGENT_DEFAULTS changes only that plugin\'s parts, in the defaults queue (#3262)', async () => {
    const handler = handlers.get(IPC.AGENT.UPDATE_PLUGIN_AGENT_DEFAULTS)!;
    await handler({}, '/project', 'foo', { allow: ['Bash(x)'] });
    const update = vi.mocked(agentSettings.updateProjectAgentDefaults).mock.calls.at(-1)![1];
    expect(update({ permissions: { allow: ['Read(**)'] }, buildCommand: 'make' })).toEqual({
      permissions: { allow: ['Read(**)', 'Bash(x) /* plugin:foo */'] },
      buildCommand: 'make',
    });
    await expect(handler({}, '/project', 'foo', { buildCommand: 'evil' })).rejects.toThrow('Unknown plugin agent default');
    for (const bad of ['Foo', 'a b', 'x */ y', '../x']) {
      await expect(handler({}, '/project', bad, { allow: null })).rejects.toThrow('Not a plugin id');
    }
    expect(agentSettings.writeProjectAgentDefaults).not.toHaveBeenCalled();
  });

  it('SAVE_PROJECT_USER_DEFAULTS updates the saved defaults in place (#3244)', async () => {
    const handler = handlers.get(IPC.AGENT.SAVE_PROJECT_USER_DEFAULTS)!;
    await handler({}, '/project', { buildCommand: 'make' });
    expect(agentSettings.updateProjectAgentDefaults).toHaveBeenCalledWith('/project', expect.any(Function));
    expect(agentSettings.writeProjectAgentDefaults).not.toHaveBeenCalled();
  });

  // --- Conventions ---

  it('GET_CONVENTIONS returns provider conventions', async () => {
    const handler = handlers.get(IPC.AGENT.GET_CONVENTIONS)!;
    const result = await handler({}, '/project');
    expect(result).toEqual({ configDir: '.claude', localInstructionsFile: 'CLAUDE.md' });
  });

  it('GET_CONVENTIONS returns null when resolveOrchestrator throws', async () => {
    vi.mocked(agentSystem.resolveOrchestrator).mockRejectedValueOnce(new Error('not found'));
    const handler = handlers.get(IPC.AGENT.GET_CONVENTIONS)!;
    const result = await handler({}, '/project');
    expect(result).toBeNull();
  });

  // --- Input validation ---

  it('rejects non-string worktreePath for READ_INSTRUCTIONS', () => {
    const handler = handlers.get(IPC.AGENT.READ_INSTRUCTIONS)!;
    expect(() => handler({}, 123)).toThrow('must be a string');
  });

  it('rejects non-string content for SAVE_INSTRUCTIONS', () => {
    const handler = handlers.get(IPC.AGENT.SAVE_INSTRUCTIONS)!;
    expect(() => handler({}, '/worktree', null)).toThrow('must be a string');
  });

  it('rejects non-boolean isSource for CREATE_SKILL', () => {
    const handler = handlers.get(IPC.AGENT.CREATE_SKILL)!;
    expect(() => handler({}, '/base', 'skill', 'not-bool')).toThrow('must be a boolean');
  });

  it('rejects non-object permissions for SAVE_PERMISSIONS', () => {
    const handler = handlers.get(IPC.AGENT.SAVE_PERMISSIONS)!;
    expect(() => handler({}, '/worktree', 'not-an-object')).toThrow('must be an object');
  });

  it('rejects non-object defaults for SAVE_PROJECT_USER_DEFAULTS', () => {
    const handler = handlers.get(IPC.AGENT.SAVE_PROJECT_USER_DEFAULTS)!;
    expect(() => handler({}, '/project', 'not-an-object')).toThrow('must be an object');
  });

  it('registers no Clubhouse Mode channels: Clubhouse Mode was retired (#2901)', () => {
    for (const name of [
      'agent:list-source-skills', 'agent:list-source-agent-templates', 'agent:read-source-skill-content', 'agent:read-source-agent-template-content',
      'agent:get-agent-wildcards', 'agent:list-source-missions', 'agent:read-source-mission-content', 'agent:write-source-mission-content', 'agent:delete-source-mission',
      'agent:materialize-agent', 'agent:preview-materialization', 'agent:compute-config-diff', 'agent:propagate-config-changes', 'agent:reset-project-agent-defaults',
    ]) {
      expect(handlers.has(name)).toBe(false);
    }
  });

  it('registers no persona channels: personas were retired (#2901)', () => {
    for (const name of ['agent:list-source-personas', 'agent:apply-persona-to-agent', 'agent:extract-agent-persona']) {
      expect(handlers.has(name)).toBe(false);
    }
  });
});
