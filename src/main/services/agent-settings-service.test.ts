import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as path from 'path';

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  readdir: vi.fn(() => Promise.resolve([])),
  rm: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock('./fs-utils', () => ({
  pathExists: vi.fn(),
}));

vi.mock('./log-service', () => ({
  appLog: vi.fn(),
}));

import * as fsp from 'fs/promises';
import { pathExists } from './fs-utils';
import { appLog } from './log-service';
import {
  readClaudeMd, writeClaudeMd, readPermissions, writePermissions,
  readSkillContent, writeSkillContent, deleteSkill,
  readAgentTemplateContent, writeAgentTemplateContent, deleteAgentTemplate,
  listAgentTemplateFiles, listSkills, listAgentTemplates,
  readMcpRawJson, writeMcpRawJson, readMcpConfig,
  readProjectAgentDefaults, writeProjectAgentDefaults, applyAgentDefaults,
  SettingsConventions,
} from './agent-settings-service';

const WORKTREE = '/test/worktree';

describe('readClaudeMd', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads from CLAUDE.md at project root', async () => {
    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
      if (String(p) === path.join(WORKTREE, 'CLAUDE.md')) return '# Project content';
      throw new Error('not found');
    });

    const result = await readClaudeMd(WORKTREE);
    expect(result).toBe('# Project content');
    expect(vi.mocked(fsp.readFile)).toHaveBeenCalledWith(
      path.join(WORKTREE, 'CLAUDE.md'),
      'utf-8',
    );
  });

  it('does not read from .claude/CLAUDE.local.md', async () => {
    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
      if (String(p).includes('CLAUDE.local.md')) return '# Local content';
      throw new Error('not found');
    });

    const result = await readClaudeMd(WORKTREE);
    expect(result).toBe('');
  });

  it('returns empty string when file does not exist', async () => {
    vi.mocked(fsp.readFile).mockRejectedValue(new Error('not found'));

    const result = await readClaudeMd(WORKTREE);
    expect(result).toBe('');
  });
});

describe('writeClaudeMd', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes to CLAUDE.md at project root', async () => {
    await writeClaudeMd(WORKTREE, '# New content');
    expect(vi.mocked(fsp.writeFile)).toHaveBeenCalledWith(
      path.join(WORKTREE, 'CLAUDE.md'),
      '# New content',
      'utf-8',
    );
  });

  it('does not create .claude directory', async () => {
    await writeClaudeMd(WORKTREE, '# Content');
    expect(vi.mocked(fsp.mkdir)).not.toHaveBeenCalled();
  });
});

describe('readPermissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads allow and deny from settings.local.json', async () => {
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({
      permissions: {
        allow: ['Bash(git:*)', 'Read'],
        deny: ['WebFetch'],
      },
      hooks: { PreToolUse: [] },
    }));

    const result = await readPermissions(WORKTREE);
    expect(result.allow).toEqual(['Bash(git:*)', 'Read']);
    expect(result.deny).toEqual(['WebFetch']);
  });

  it('returns empty object when file does not exist', async () => {
    vi.mocked(fsp.readFile).mockRejectedValue(new Error('ENOENT'));

    const result = await readPermissions(WORKTREE);
    expect(result).toEqual({});
  });

  it('returns empty object when permissions key is missing', async () => {
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({
      hooks: { PreToolUse: [] },
    }));

    const result = await readPermissions(WORKTREE);
    expect(result).toEqual({});
  });

  it('handles missing allow or deny arrays', async () => {
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({
      permissions: { allow: ['Read'] },
    }));

    const result = await readPermissions(WORKTREE);
    expect(result.allow).toEqual(['Read']);
    expect(result.deny).toBeUndefined();
  });
});

describe('writePermissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes permissions to settings.local.json', async () => {
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({}));

    await writePermissions(WORKTREE, { allow: ['Read', 'Write'], deny: ['WebFetch'] });

    expect(fsp.writeFile).toHaveBeenCalledTimes(1);
    const written = JSON.parse(vi.mocked(fsp.writeFile).mock.calls[0][1] as string);
    expect(written.permissions.allow).toEqual(['Read', 'Write']);
    expect(written.permissions.deny).toEqual(['WebFetch']);
  });

  it('preserves existing hooks when writing permissions', async () => {
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo test' }] }] },
    }));
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);

    await writePermissions(WORKTREE, { allow: ['Bash(git:*)'] });

    const written = JSON.parse(vi.mocked(fsp.writeFile).mock.calls[0][1] as string);
    expect(written.permissions.allow).toEqual(['Bash(git:*)']);
    expect(written.hooks.PreToolUse).toHaveLength(1);
  });

  it('removes permissions key when both arrays are empty', async () => {
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({
      permissions: { allow: ['Read'] },
      hooks: {},
    }));
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);

    await writePermissions(WORKTREE, { allow: [], deny: [] });

    const written = JSON.parse(vi.mocked(fsp.writeFile).mock.calls[0][1] as string);
    expect(written.permissions).toBeUndefined();
    expect(written.hooks).toBeDefined();
  });

  it('creates settings parent directory if it does not exist', async () => {
    vi.mocked(fsp.readFile).mockRejectedValue(new Error('ENOENT'));

    await writePermissions(WORKTREE, { allow: ['Read'] });

    expect(fsp.mkdir).toHaveBeenCalledWith(
      path.dirname(path.join(WORKTREE, '.claude', 'settings.local.json')),
      { recursive: true },
    );
  });

  it('handles only allow without deny', async () => {
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({}));

    await writePermissions(WORKTREE, { allow: ['Bash(git:*)'] });

    const written = JSON.parse(vi.mocked(fsp.writeFile).mock.calls[0][1] as string);
    expect(written.permissions.allow).toEqual(['Bash(git:*)']);
    expect(written.permissions.deny).toBeUndefined();
  });

  it('handles only deny without allow', async () => {
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({}));

    await writePermissions(WORKTREE, { deny: ['WebFetch'] });

    const written = JSON.parse(vi.mocked(fsp.writeFile).mock.calls[0][1] as string);
    expect(written.permissions.deny).toEqual(['WebFetch']);
    expect(written.permissions.allow).toBeUndefined();
  });
});

// --- Skill content CRUD ---

describe('readSkillContent', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('reads SKILL.md from the skill directory', async () => {
    vi.mocked(fsp.readFile).mockResolvedValue('# My Skill');
    const result = await readSkillContent(WORKTREE, 'my-skill');
    expect(result).toBe('# My Skill');
    expect(fsp.readFile).toHaveBeenCalledWith(
      path.join(WORKTREE, '.claude', 'skills', 'my-skill', 'SKILL.md'),
      'utf-8',
    );
  });

  it('returns empty string when file does not exist', async () => {
    vi.mocked(fsp.readFile).mockRejectedValue(new Error('ENOENT'));
    expect(await readSkillContent(WORKTREE, 'missing')).toBe('');
  });
});

describe('writeSkillContent', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('creates directory and writes SKILL.md', async () => {
    await writeSkillContent(WORKTREE, 'new-skill', '# Content');
    expect(fsp.mkdir).toHaveBeenCalledWith(
      path.join(WORKTREE, '.claude', 'skills', 'new-skill'),
      { recursive: true },
    );
    expect(fsp.writeFile).toHaveBeenCalledWith(
      path.join(WORKTREE, '.claude', 'skills', 'new-skill', 'SKILL.md'),
      '# Content',
      'utf-8',
    );
  });
});

describe('deleteSkill', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('removes the skill directory recursively', async () => {
    await deleteSkill(WORKTREE, 'old-skill');
    expect(fsp.rm).toHaveBeenCalledWith(
      path.join(WORKTREE, '.claude', 'skills', 'old-skill'),
      { recursive: true, force: true },
    );
  });
});

// --- Agent template content CRUD ---

describe('readAgentTemplateContent', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('reads .md file first', async () => {
    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
      if (String(p).endsWith('my-agent.md')) return '# Agent';
      throw new Error('ENOENT');
    });
    expect(await readAgentTemplateContent(WORKTREE, 'my-agent')).toBe('# Agent');
  });

  it('falls back to directory README.md', async () => {
    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
      if (String(p).endsWith('README.md')) return '# Directory Agent';
      throw new Error('ENOENT');
    });
    expect(await readAgentTemplateContent(WORKTREE, 'my-agent')).toBe('# Directory Agent');
  });

  it('returns empty when neither exists', async () => {
    vi.mocked(fsp.readFile).mockRejectedValue(new Error('ENOENT'));
    expect(await readAgentTemplateContent(WORKTREE, 'missing')).toBe('');
  });
});

describe('writeAgentTemplateContent', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('creates directory and writes .md file', async () => {
    await writeAgentTemplateContent(WORKTREE, 'new-agent', '# Agent');
    expect(fsp.mkdir).toHaveBeenCalledWith(
      path.join(WORKTREE, '.claude', 'agents'),
      { recursive: true },
    );
    expect(fsp.writeFile).toHaveBeenCalledWith(
      path.join(WORKTREE, '.claude', 'agents', 'new-agent.md'),
      '# Agent',
      'utf-8',
    );
  });
});

describe('deleteAgentTemplate', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('removes both .md file and directory forms', async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    await deleteAgentTemplate(WORKTREE, 'old-agent');
    expect(fsp.unlink).toHaveBeenCalledWith(
      path.join(WORKTREE, '.claude', 'agents', 'old-agent.md'),
    );
    expect(fsp.rm).toHaveBeenCalledWith(
      path.join(WORKTREE, '.claude', 'agents', 'old-agent'),
      { recursive: true, force: true },
    );
  });
});

describe('listAgentTemplateFiles', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('lists .md files and directories', async () => {
    vi.mocked(fsp.readdir).mockResolvedValue([
      { name: 'reviewer.md', isFile: () => true, isDirectory: () => false },
      { name: 'builder', isFile: () => false, isDirectory: () => true },
    ] as any);
    vi.mocked(pathExists).mockResolvedValue(false);

    const result = await listAgentTemplateFiles(WORKTREE);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('reviewer');
    expect(result[1].name).toBe('builder');
  });

  it('returns empty array when directory does not exist', async () => {
    vi.mocked(fsp.readdir).mockRejectedValue(new Error('ENOENT'));
    expect(await listAgentTemplateFiles(WORKTREE)).toEqual([]);
  });
});

// --- MCP raw JSON ---

describe('readMcpRawJson', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('reads .mcp.json content', async () => {
    vi.mocked(fsp.readFile).mockResolvedValue('{"mcpServers": {"test": {}}}');
    expect(await readMcpRawJson(WORKTREE)).toBe('{"mcpServers": {"test": {}}}');
  });

  it('returns default JSON when file does not exist', async () => {
    vi.mocked(fsp.readFile).mockRejectedValue(new Error('ENOENT'));
    const result = await readMcpRawJson(WORKTREE);
    expect(JSON.parse(result)).toEqual({ mcpServers: {} });
  });
});

describe('writeMcpRawJson', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('writes valid JSON to .mcp.json', async () => {
    const content = '{"mcpServers": {"test": {"command": "npx"}}}';
    const result = await writeMcpRawJson(WORKTREE, content);
    expect(result.ok).toBe(true);
    expect(fsp.writeFile).toHaveBeenCalledWith(
      path.join(WORKTREE, '.mcp.json'),
      content,
      'utf-8',
    );
  });

  it('rejects invalid JSON without writing', async () => {
    const result = await writeMcpRawJson(WORKTREE, '{invalid');
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(fsp.writeFile).not.toHaveBeenCalled();
  });
});

// --- Project agent defaults ---

const PROJECT = '/test/project';

describe('readProjectAgentDefaults', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('reads agentDefaults from settings.json', async () => {
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({
      defaults: {},
      quickOverrides: {},
      agentDefaults: {
        instructions: '# Hello',
        freeAgentMode: true,
      },
    }));

    const result = await readProjectAgentDefaults(PROJECT);
    expect(result.instructions).toBe('# Hello');
    expect(result.freeAgentMode).toBe(true);
  });

  it('returns empty object when no defaults set', async () => {
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({
      defaults: {},
      quickOverrides: {},
    }));

    expect(await readProjectAgentDefaults(PROJECT)).toEqual({});
  });

  it('returns empty object when settings file missing', async () => {
    vi.mocked(fsp.readFile).mockRejectedValue(new Error('ENOENT'));
    expect(await readProjectAgentDefaults(PROJECT)).toEqual({});
  });
});

describe('writeProjectAgentDefaults', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('writes agentDefaults to settings.json', async () => {
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({
      defaults: {},
      quickOverrides: {},
    }));
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);

    await writeProjectAgentDefaults(PROJECT, {
      instructions: '# Template',
      permissions: { allow: ['Read'] },
    });

    const written = JSON.parse(vi.mocked(fsp.writeFile).mock.calls[0][1] as string);
    expect(written.agentDefaults.instructions).toBe('# Template');
    expect(written.agentDefaults.permissions.allow).toEqual(['Read']);
  });
});

describe('applyAgentDefaults', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('writes instructions to CLAUDE.md', async () => {
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({
      defaults: {},
      quickOverrides: {},
      agentDefaults: { instructions: '# Agent Template' },
    }));
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);

    await applyAgentDefaults(WORKTREE, PROJECT);

    const writeCalls = vi.mocked(fsp.writeFile).mock.calls;
    const claudeMdCall = writeCalls.find((c) => String(c[0]).endsWith('CLAUDE.md'));
    expect(claudeMdCall).toBeDefined();
    expect(claudeMdCall![1]).toBe('# Agent Template');
  });

  it('writes permissions to settings.local.json', async () => {
    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
      if (String(p).includes('settings.json') && !String(p).includes('settings.local')) {
        return Promise.resolve(JSON.stringify({
          defaults: {},
          quickOverrides: {},
          agentDefaults: { permissions: { allow: ['Read'], deny: ['WebFetch'] } },
        }));
      }
      return Promise.resolve('{}');
    });
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);

    await applyAgentDefaults(WORKTREE, PROJECT);

    const writeCalls = vi.mocked(fsp.writeFile).mock.calls;
    const permCall = writeCalls.find((c) => String(c[0]).includes('settings.local.json'));
    expect(permCall).toBeDefined();
    const written = JSON.parse(permCall![1] as string);
    expect(written.permissions.allow).toEqual(['Read']);
    expect(written.permissions.deny).toEqual(['WebFetch']);
  });

  it('writes mcp.json when default is set', async () => {
    const mcpContent = '{"mcpServers": {"test": {"command": "npx"}}}';
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({
      defaults: {},
      quickOverrides: {},
      agentDefaults: { mcpJson: mcpContent },
    }));
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);

    await applyAgentDefaults(WORKTREE, PROJECT);

    const writeCalls = vi.mocked(fsp.writeFile).mock.calls;
    const mcpCall = writeCalls.find((c) => String(c[0]).endsWith('.mcp.json'));
    expect(mcpCall).toBeDefined();
    expect(mcpCall![1]).toBe(mcpContent);
  });

  it('does nothing when no defaults are set', async () => {
    vi.mocked(fsp.readFile).mockRejectedValue(new Error('ENOENT'));

    await applyAgentDefaults(WORKTREE, PROJECT);

    // Only the readFile call, no writes
    expect(fsp.writeFile).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Architectural guard: all settings functions must respect orchestrator conventions
// =============================================================================
// These tests use non-default conventions (mimicking a non-Claude-Code orchestrator)
// to ensure no function is hardcoded to Claude Code-specific paths.
// If a test fails here, it means a function ignores the conv parameter.

const COPILOT_CONVENTIONS: SettingsConventions = {
  configDir: '.github',
  skillsDir: 'skills',
  agentTemplatesDir: 'agents',
  mcpConfigFile: '.github/mcp.json',
  localSettingsFile: 'hooks/hooks.json',
};

describe('orchestrator convention routing', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('listSkills uses convention configDir/skillsDir', async () => {
    vi.mocked(fsp.readdir).mockResolvedValue([
      { name: 'my-skill', isDirectory: () => true, isFile: () => false },
    ] as any);
    vi.mocked(pathExists).mockResolvedValue(false);

    const result = await listSkills(WORKTREE, COPILOT_CONVENTIONS);
    expect(fsp.readdir).toHaveBeenCalledWith(
      path.join(WORKTREE, '.github', 'skills'),
      { withFileTypes: true },
    );
    expect(result[0].path).toContain('.github');
  });

  it('listAgentTemplates uses convention configDir/agentTemplatesDir', async () => {
    vi.mocked(fsp.readdir).mockResolvedValue([
      { name: 'builder', isDirectory: () => true, isFile: () => false },
    ] as any);
    vi.mocked(pathExists).mockResolvedValue(false);

    const result = await listAgentTemplates(WORKTREE, COPILOT_CONVENTIONS);
    expect(fsp.readdir).toHaveBeenCalledWith(
      path.join(WORKTREE, '.github', 'agents'),
      { withFileTypes: true },
    );
    expect(result[0].path).toContain('.github');
  });

  it('readSkillContent uses convention paths', async () => {
    vi.mocked(fsp.readFile).mockResolvedValue('# Skill');
    await readSkillContent(WORKTREE, 'test-skill', COPILOT_CONVENTIONS);
    expect(fsp.readFile).toHaveBeenCalledWith(
      path.join(WORKTREE, '.github', 'skills', 'test-skill', 'SKILL.md'),
      'utf-8',
    );
  });

  it('writeSkillContent uses convention paths', async () => {
    await writeSkillContent(WORKTREE, 'test-skill', '# Content', COPILOT_CONVENTIONS);
    expect(fsp.mkdir).toHaveBeenCalledWith(
      path.join(WORKTREE, '.github', 'skills', 'test-skill'),
      { recursive: true },
    );
    expect(fsp.writeFile).toHaveBeenCalledWith(
      path.join(WORKTREE, '.github', 'skills', 'test-skill', 'SKILL.md'),
      '# Content',
      'utf-8',
    );
  });

  it('deleteSkill uses convention paths', async () => {
    await deleteSkill(WORKTREE, 'test-skill', COPILOT_CONVENTIONS);
    expect(fsp.rm).toHaveBeenCalledWith(
      path.join(WORKTREE, '.github', 'skills', 'test-skill'),
      { recursive: true, force: true },
    );
  });

  it('readAgentTemplateContent uses convention paths', async () => {
    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
      if (String(p).endsWith('my-agent.md')) return '# Agent';
      throw new Error('ENOENT');
    });
    await readAgentTemplateContent(WORKTREE, 'my-agent', COPILOT_CONVENTIONS);
    expect(fsp.readFile).toHaveBeenCalledWith(
      path.join(WORKTREE, '.github', 'agents', 'my-agent.md'),
      'utf-8',
    );
  });

  it('writeAgentTemplateContent uses convention paths', async () => {
    await writeAgentTemplateContent(WORKTREE, 'my-agent', '# Agent', COPILOT_CONVENTIONS);
    expect(fsp.mkdir).toHaveBeenCalledWith(
      path.join(WORKTREE, '.github', 'agents'),
      { recursive: true },
    );
    expect(fsp.writeFile).toHaveBeenCalledWith(
      path.join(WORKTREE, '.github', 'agents', 'my-agent.md'),
      '# Agent',
      'utf-8',
    );
  });

  it('deleteAgentTemplate uses convention paths', async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    await deleteAgentTemplate(WORKTREE, 'my-agent', COPILOT_CONVENTIONS);
    expect(fsp.unlink).toHaveBeenCalledWith(
      path.join(WORKTREE, '.github', 'agents', 'my-agent.md'),
    );
    expect(fsp.rm).toHaveBeenCalledWith(
      path.join(WORKTREE, '.github', 'agents', 'my-agent'),
      { recursive: true, force: true },
    );
  });

  it('listAgentTemplateFiles uses convention paths', async () => {
    vi.mocked(fsp.readdir).mockResolvedValue([
      { name: 'reviewer.md', isFile: () => true, isDirectory: () => false },
    ] as any);
    vi.mocked(pathExists).mockResolvedValue(false);

    await listAgentTemplateFiles(WORKTREE, COPILOT_CONVENTIONS);
    expect(fsp.readdir).toHaveBeenCalledWith(
      path.join(WORKTREE, '.github', 'agents'),
      { withFileTypes: true },
    );
  });

  it('readMcpRawJson uses convention mcpConfigFile', async () => {
    vi.mocked(fsp.readFile).mockResolvedValue('{"mcpServers": {}}');
    await readMcpRawJson(WORKTREE, COPILOT_CONVENTIONS);
    expect(fsp.readFile).toHaveBeenCalledWith(
      path.join(WORKTREE, '.github', 'mcp.json'),
      'utf-8',
    );
  });

  it('writeMcpRawJson uses convention mcpConfigFile', async () => {
    const content = '{"mcpServers": {}}';
    await writeMcpRawJson(WORKTREE, content, COPILOT_CONVENTIONS);
    expect(fsp.writeFile).toHaveBeenCalledWith(
      path.join(WORKTREE, '.github', 'mcp.json'),
      content,
      'utf-8',
    );
  });

  it('readMcpConfig uses convention mcpConfigFile for project servers', async () => {
    vi.mocked(fsp.readFile).mockResolvedValue('{"mcpServers": {"test": {"command": "npx"}}}');
    await readMcpConfig(WORKTREE, COPILOT_CONVENTIONS);
    // First readFile call should use convention path
    expect(vi.mocked(fsp.readFile).mock.calls[0][0]).toBe(
      path.join(WORKTREE, '.github', 'mcp.json'),
    );
  });

  it('readPermissions uses convention configDir/localSettingsFile', async () => {
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({
      permissions: { allow: ['Read'] },
    }));
    await readPermissions(WORKTREE, COPILOT_CONVENTIONS);
    expect(fsp.readFile).toHaveBeenCalledWith(
      path.join(WORKTREE, '.github', 'hooks', 'hooks.json'),
      'utf-8',
    );
  });

  it('writePermissions uses convention configDir/localSettingsFile', async () => {
    vi.mocked(fsp.readFile).mockResolvedValue('{}');
    await writePermissions(WORKTREE, { allow: ['Read'] }, COPILOT_CONVENTIONS);
    expect(fsp.writeFile).toHaveBeenCalledWith(
      path.join(WORKTREE, '.github', 'hooks', 'hooks.json'),
      expect.any(String),
      'utf-8',
    );
  });

  it('writePermissions creates parent directory of settings file if missing', async () => {
    vi.mocked(fsp.readFile).mockRejectedValue(new Error('ENOENT'));
    await writePermissions(WORKTREE, { allow: ['Read'] }, COPILOT_CONVENTIONS);
    // Should create the parent dir of hooks/hooks.json, which is .github/hooks
    expect(fsp.mkdir).toHaveBeenCalledWith(
      path.dirname(path.join(WORKTREE, '.github', 'hooks', 'hooks.json')),
      { recursive: true },
    );
  });

  it('applyAgentDefaults uses convention for MCP and permissions', async () => {
    const mcpContent = '{"mcpServers": {"test": {}}}';
    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
      const s = String(p);
      if (s.includes('settings.json') && !s.includes('settings.local') && !s.includes('hooks')) {
        return Promise.resolve(JSON.stringify({
          defaults: {},
          quickOverrides: {},
          agentDefaults: {
            mcpJson: mcpContent,
            permissions: { allow: ['Read'] },
          },
        }));
      }
      return Promise.resolve('{}');
    });
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);

    const writeInstructions = vi.fn();
    await applyAgentDefaults(WORKTREE, PROJECT, writeInstructions, COPILOT_CONVENTIONS);

    // MCP should be written to convention path
    const mcpWriteCall = vi.mocked(fsp.writeFile).mock.calls.find(
      (c) => String(c[0]).includes('mcp.json'),
    );
    expect(mcpWriteCall).toBeDefined();
    expect(String(mcpWriteCall![0])).toBe(path.join(WORKTREE, '.github', 'mcp.json'));

    // Permissions should use convention path
    const permWriteCall = vi.mocked(fsp.writeFile).mock.calls.find(
      (c) => String(c[0]).includes('hooks.json'),
    );
    expect(permWriteCall).toBeDefined();
  });
});

// =============================================================================
// TOML settings format guard: non-JSON settings files must not be written as JSON
// =============================================================================

const CODEX_CONVENTIONS: SettingsConventions = {
  configDir: '.codex',
  skillsDir: 'skills',
  agentTemplatesDir: 'agents',
  mcpConfigFile: '.codex/config.toml',
  localSettingsFile: 'config.toml',
  settingsFormat: 'toml',
};

describe('TOML settingsFormat guard', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('readPermissions returns empty for TOML conventions without reading file', async () => {
    const result = await readPermissions(WORKTREE, CODEX_CONVENTIONS);
    expect(result).toEqual({});
    expect(fsp.readFile).not.toHaveBeenCalled();
  });

  it('writePermissions is a no-op for TOML conventions', async () => {
    await writePermissions(WORKTREE, { allow: ['Read', 'Write'], deny: ['WebFetch'] }, CODEX_CONVENTIONS);
    expect(fsp.writeFile).not.toHaveBeenCalled();
    expect(fsp.mkdir).not.toHaveBeenCalled();
  });

  it('readMcpRawJson returns empty default for TOML conventions without reading file', async () => {
    const result = await readMcpRawJson(WORKTREE, CODEX_CONVENTIONS);
    expect(JSON.parse(result)).toEqual({ mcpServers: {} });
    expect(fsp.readFile).not.toHaveBeenCalled();
  });

  it('writeMcpRawJson returns error for TOML conventions without writing file', async () => {
    const result = await writeMcpRawJson(WORKTREE, '{"mcpServers": {}}', CODEX_CONVENTIONS);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not supported/i);
    expect(fsp.writeFile).not.toHaveBeenCalled();
  });

  it('applyAgentDefaults skips permissions but writes TOML MCP for TOML conventions', async () => {
    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
      const s = String(p);
      if (s.includes('settings.json') && !s.includes('config.toml')) {
        return Promise.resolve(JSON.stringify({
          defaults: {},
          quickOverrides: {},
          agentDefaults: {
            instructions: '# Codex Agent',
            mcpJson: '{"mcpServers": {"test": {"command": "node"}}}',
            permissions: { allow: ['shell(git:*)'] },
          },
        }));
      }
      return Promise.reject(new Error('ENOENT'));
    });

    const writeInstructions = vi.fn();
    await applyAgentDefaults(WORKTREE, PROJECT, writeInstructions, CODEX_CONVENTIONS);

    // Instructions should still be written via the custom writer
    expect(writeInstructions).toHaveBeenCalledWith(WORKTREE, '# Codex Agent');

    // MCP config should be written as TOML (permissions still skipped)
    const writes = vi.mocked(fsp.writeFile).mock.calls;
    const tomlWrites = writes.filter(c => String(c[0]).includes('config.toml'));
    expect(tomlWrites.length).toBeGreaterThan(0);
    const content = String(tomlWrites[0][1]);
    expect(content).toContain('[mcp_servers.test]');
    // No permissions file should be written
    const permWrites = writes.filter(c => String(c[0]).includes('settings.local.json'));
    expect(permWrites).toHaveLength(0);
  });
});

// =============================================================================
// Error logging: catch blocks log warnings instead of silently swallowing
// =============================================================================

describe('error logging in catch blocks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('readClaudeMd logs warning on read failure', async () => {
    vi.mocked(fsp.readFile).mockRejectedValue(new Error('ENOENT'));
    const result = await readClaudeMd(WORKTREE);
    expect(result).toBe('');
    expect(appLog).toHaveBeenCalledWith(
      'core:agent-settings', 'warn',
      expect.stringContaining('Failed to read CLAUDE.md'),
      expect.objectContaining({ meta: { error: 'ENOENT' } }),
    );
  });

  it('readMcpConfig logs warning on corrupt JSON', async () => {
    vi.mocked(fsp.readFile).mockResolvedValue('not valid json');
    const result = await readMcpConfig(WORKTREE);
    expect(result).toEqual([]);
    expect(appLog).toHaveBeenCalledWith(
      'core:agent-settings', 'warn',
      expect.stringContaining('Failed to parse MCP config'),
      expect.objectContaining({ meta: expect.objectContaining({ error: expect.any(String) }) }),
    );
  });

  it('listSkills logs warning on directory read failure', async () => {
    vi.mocked(fsp.readdir).mockRejectedValue(new Error('EACCES'));
    const result = await listSkills(WORKTREE);
    expect(result).toEqual([]);
    expect(appLog).toHaveBeenCalledWith(
      'core:agent-settings', 'warn',
      expect.stringContaining('Failed to list skills'),
      expect.objectContaining({ meta: { error: 'EACCES' } }),
    );
  });

  it('listAgentTemplates logs warning on directory read failure', async () => {
    vi.mocked(fsp.readdir).mockRejectedValue(new Error('EACCES'));
    const result = await listAgentTemplates(WORKTREE);
    expect(result).toEqual([]);
    expect(appLog).toHaveBeenCalledWith(
      'core:agent-settings', 'warn',
      expect.stringContaining('Failed to list agent templates'),
      expect.objectContaining({ meta: { error: 'EACCES' } }),
    );
  });

  it('readPermissions logs warning on parse failure', async () => {
    vi.mocked(fsp.readFile).mockResolvedValue('corrupt json');
    const result = await readPermissions(WORKTREE);
    expect(result).toEqual({});
    expect(appLog).toHaveBeenCalledWith(
      'core:agent-settings', 'warn',
      expect.stringContaining('Failed to read permissions'),
      expect.objectContaining({ meta: expect.objectContaining({ error: expect.any(String) }) }),
    );
  });

  it('readSkillContent logs warning on read failure', async () => {
    vi.mocked(fsp.readFile).mockRejectedValue(new Error('ENOENT'));
    const result = await readSkillContent(WORKTREE, 'test-skill');
    expect(result).toBe('');
    expect(appLog).toHaveBeenCalledWith(
      'core:agent-settings', 'warn',
      expect.stringContaining('Failed to read skill content'),
      expect.objectContaining({ meta: { error: 'ENOENT' } }),
    );
  });

  it('readAgentTemplateContent logs warning when both forms fail', async () => {
    vi.mocked(fsp.readFile).mockRejectedValue(new Error('ENOENT'));
    const result = await readAgentTemplateContent(WORKTREE, 'missing');
    expect(result).toBe('');
    expect(appLog).toHaveBeenCalledWith(
      'core:agent-settings', 'warn',
      expect.stringContaining('Failed to read agent template "missing"'),
      expect.objectContaining({ meta: { error: 'ENOENT' } }),
    );
  });

  it('readMcpRawJson logs warning on read failure', async () => {
    vi.mocked(fsp.readFile).mockRejectedValue(new Error('ENOENT'));
    const result = await readMcpRawJson(WORKTREE);
    expect(JSON.parse(result)).toEqual({ mcpServers: {} });
    expect(appLog).toHaveBeenCalledWith(
      'core:agent-settings', 'warn',
      expect.stringContaining('Failed to read MCP config'),
      expect.objectContaining({ meta: { error: 'ENOENT' } }),
    );
  });

  it('listAgentTemplateFiles logs warning on directory read failure', async () => {
    vi.mocked(fsp.readdir).mockRejectedValue(new Error('EACCES'));
    const result = await listAgentTemplateFiles(WORKTREE);
    expect(result).toEqual([]);
    expect(appLog).toHaveBeenCalledWith(
      'core:agent-settings', 'warn',
      expect.stringContaining('Failed to list agent template files'),
      expect.objectContaining({ meta: { error: 'EACCES' } }),
    );
  });

  it('applyAgentDefaults logs warning on invalid MCP JSON', async () => {
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({
      defaults: {},
      quickOverrides: {},
      agentDefaults: { mcpJson: 'not valid json' },
    }));

    await applyAgentDefaults(WORKTREE, PROJECT);

    expect(appLog).toHaveBeenCalledWith(
      'core:agent-settings', 'warn',
      expect.stringContaining('Skipped invalid MCP config'),
      expect.objectContaining({ meta: expect.objectContaining({ error: expect.any(String) }) }),
    );
  });

  it('writePermissions logs warning when existing settings are corrupt', async () => {
    vi.mocked(fsp.readFile).mockResolvedValue('not json');

    await writePermissions(WORKTREE, { allow: ['Read'] });

    expect(appLog).toHaveBeenCalledWith(
      'core:agent-settings', 'warn',
      expect.stringContaining('Failed to read existing settings'),
      expect.objectContaining({ meta: expect.objectContaining({ error: expect.any(String) }) }),
    );
    // Should still write permissions despite corrupt existing file
    expect(fsp.writeFile).toHaveBeenCalled();
  });
});
