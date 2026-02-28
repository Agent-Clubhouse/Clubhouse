import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as path from 'path';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  rmSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock('./log-service', () => ({
  appLog: vi.fn(),
}));

import * as fs from 'fs';
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

  it('reads from CLAUDE.md at project root', () => {
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p) === path.join(WORKTREE, 'CLAUDE.md')) return '# Project content';
      throw new Error('not found');
    });

    const result = readClaudeMd(WORKTREE);
    expect(result).toBe('# Project content');
    expect(vi.mocked(fs.readFileSync)).toHaveBeenCalledWith(
      path.join(WORKTREE, 'CLAUDE.md'),
      'utf-8',
    );
  });

  it('does not read from .claude/CLAUDE.local.md', () => {
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p).includes('CLAUDE.local.md')) return '# Local content';
      throw new Error('not found');
    });

    const result = readClaudeMd(WORKTREE);
    expect(result).toBe('');
  });

  it('returns empty string when file does not exist', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('not found');
    });

    const result = readClaudeMd(WORKTREE);
    expect(result).toBe('');
  });
});

describe('writeClaudeMd', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes to CLAUDE.md at project root', () => {
    writeClaudeMd(WORKTREE, '# New content');
    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
      path.join(WORKTREE, 'CLAUDE.md'),
      '# New content',
      'utf-8',
    );
  });

  it('does not create .claude directory', () => {
    writeClaudeMd(WORKTREE, '# Content');
    expect(vi.mocked(fs.mkdirSync)).not.toHaveBeenCalled();
  });
});

describe('readPermissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads allow and deny from settings.local.json', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      permissions: {
        allow: ['Bash(git:*)', 'Read'],
        deny: ['WebFetch'],
      },
      hooks: { PreToolUse: [] },
    }));

    const result = readPermissions(WORKTREE);
    expect(result.allow).toEqual(['Bash(git:*)', 'Read']);
    expect(result.deny).toEqual(['WebFetch']);
  });

  it('returns empty object when file does not exist', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });

    const result = readPermissions(WORKTREE);
    expect(result).toEqual({});
  });

  it('returns empty object when permissions key is missing', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      hooks: { PreToolUse: [] },
    }));

    const result = readPermissions(WORKTREE);
    expect(result).toEqual({});
  });

  it('handles missing allow or deny arrays', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      permissions: { allow: ['Read'] },
    }));

    const result = readPermissions(WORKTREE);
    expect(result.allow).toEqual(['Read']);
    expect(result.deny).toBeUndefined();
  });
});

describe('writePermissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes permissions to settings.local.json', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}));

    writePermissions(WORKTREE, { allow: ['Read', 'Write'], deny: ['WebFetch'] });

    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
    expect(written.permissions.allow).toEqual(['Read', 'Write']);
    expect(written.permissions.deny).toEqual(['WebFetch']);
  });

  it('preserves existing hooks when writing permissions', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo test' }] }] },
    }));

    writePermissions(WORKTREE, { allow: ['Bash(git:*)'] });

    const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
    expect(written.permissions.allow).toEqual(['Bash(git:*)']);
    expect(written.hooks.PreToolUse).toHaveLength(1);
  });

  it('removes permissions key when both arrays are empty', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      permissions: { allow: ['Read'] },
      hooks: {},
    }));

    writePermissions(WORKTREE, { allow: [], deny: [] });

    const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
    expect(written.permissions).toBeUndefined();
    expect(written.hooks).toBeDefined();
  });

  it('creates settings parent directory if it does not exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });

    writePermissions(WORKTREE, { allow: ['Read'] });

    expect(fs.mkdirSync).toHaveBeenCalledWith(
      path.dirname(path.join(WORKTREE, '.claude', 'settings.local.json')),
      { recursive: true },
    );
  });

  it('handles only allow without deny', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}));

    writePermissions(WORKTREE, { allow: ['Bash(git:*)'] });

    const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
    expect(written.permissions.allow).toEqual(['Bash(git:*)']);
    expect(written.permissions.deny).toBeUndefined();
  });

  it('handles only deny without allow', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}));

    writePermissions(WORKTREE, { deny: ['WebFetch'] });

    const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
    expect(written.permissions.deny).toEqual(['WebFetch']);
    expect(written.permissions.allow).toBeUndefined();
  });
});

// --- Skill content CRUD ---

describe('readSkillContent', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('reads SKILL.md from the skill directory', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('# My Skill');
    const result = readSkillContent(WORKTREE, 'my-skill');
    expect(result).toBe('# My Skill');
    expect(fs.readFileSync).toHaveBeenCalledWith(
      path.join(WORKTREE, '.claude', 'skills', 'my-skill', 'SKILL.md'),
      'utf-8',
    );
  });

  it('returns empty string when file does not exist', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
    expect(readSkillContent(WORKTREE, 'missing')).toBe('');
  });
});

describe('writeSkillContent', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('creates directory and writes SKILL.md', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    writeSkillContent(WORKTREE, 'new-skill', '# Content');
    expect(fs.mkdirSync).toHaveBeenCalledWith(
      path.join(WORKTREE, '.claude', 'skills', 'new-skill'),
      { recursive: true },
    );
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      path.join(WORKTREE, '.claude', 'skills', 'new-skill', 'SKILL.md'),
      '# Content',
      'utf-8',
    );
  });
});

describe('deleteSkill', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('removes the skill directory recursively', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    deleteSkill(WORKTREE, 'old-skill');
    expect(fs.rmSync).toHaveBeenCalledWith(
      path.join(WORKTREE, '.claude', 'skills', 'old-skill'),
      { recursive: true, force: true },
    );
  });

  it('does nothing when directory does not exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    deleteSkill(WORKTREE, 'missing');
    expect(fs.rmSync).not.toHaveBeenCalled();
  });
});

// --- Agent template content CRUD ---

describe('readAgentTemplateContent', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('reads .md file first', () => {
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p).endsWith('my-agent.md')) return '# Agent';
      throw new Error('ENOENT');
    });
    expect(readAgentTemplateContent(WORKTREE, 'my-agent')).toBe('# Agent');
  });

  it('falls back to directory README.md', () => {
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p).endsWith('README.md')) return '# Directory Agent';
      throw new Error('ENOENT');
    });
    expect(readAgentTemplateContent(WORKTREE, 'my-agent')).toBe('# Directory Agent');
  });

  it('returns empty when neither exists', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
    expect(readAgentTemplateContent(WORKTREE, 'missing')).toBe('');
  });
});

describe('writeAgentTemplateContent', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('creates directory and writes .md file', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    writeAgentTemplateContent(WORKTREE, 'new-agent', '# Agent');
    expect(fs.mkdirSync).toHaveBeenCalledWith(
      path.join(WORKTREE, '.claude', 'agents'),
      { recursive: true },
    );
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      path.join(WORKTREE, '.claude', 'agents', 'new-agent.md'),
      '# Agent',
      'utf-8',
    );
  });
});

describe('deleteAgentTemplate', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('removes both .md file and directory forms', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    deleteAgentTemplate(WORKTREE, 'old-agent');
    expect(fs.unlinkSync).toHaveBeenCalledWith(
      path.join(WORKTREE, '.claude', 'agents', 'old-agent.md'),
    );
    expect(fs.rmSync).toHaveBeenCalledWith(
      path.join(WORKTREE, '.claude', 'agents', 'old-agent'),
      { recursive: true, force: true },
    );
  });
});

describe('listAgentTemplateFiles', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('lists .md files and directories', () => {
    vi.mocked(fs.readdirSync).mockReturnValue([
      { name: 'reviewer.md', isFile: () => true, isDirectory: () => false },
      { name: 'builder', isFile: () => false, isDirectory: () => true },
    ] as any);
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const result = listAgentTemplateFiles(WORKTREE);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('reviewer');
    expect(result[1].name).toBe('builder');
  });

  it('returns empty array when directory does not exist', () => {
    vi.mocked(fs.readdirSync).mockImplementation(() => { throw new Error('ENOENT'); });
    expect(listAgentTemplateFiles(WORKTREE)).toEqual([]);
  });
});

// --- MCP raw JSON ---

describe('readMcpRawJson', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('reads .mcp.json content', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('{"mcpServers": {"test": {}}}');
    expect(readMcpRawJson(WORKTREE)).toBe('{"mcpServers": {"test": {}}}');
  });

  it('returns default JSON when file does not exist', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
    const result = readMcpRawJson(WORKTREE);
    expect(JSON.parse(result)).toEqual({ mcpServers: {} });
  });
});

describe('writeMcpRawJson', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('writes valid JSON to .mcp.json', () => {
    const content = '{"mcpServers": {"test": {"command": "npx"}}}';
    const result = writeMcpRawJson(WORKTREE, content);
    expect(result.ok).toBe(true);
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      path.join(WORKTREE, '.mcp.json'),
      content,
      'utf-8',
    );
  });

  it('rejects invalid JSON without writing', () => {
    const result = writeMcpRawJson(WORKTREE, '{invalid');
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });
});

// --- Project agent defaults ---

const PROJECT = '/test/project';

describe('readProjectAgentDefaults', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('reads agentDefaults from settings.json', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      defaults: {},
      quickOverrides: {},
      agentDefaults: {
        instructions: '# Hello',
        freeAgentMode: true,
      },
    }));

    const result = readProjectAgentDefaults(PROJECT);
    expect(result.instructions).toBe('# Hello');
    expect(result.freeAgentMode).toBe(true);
  });

  it('returns empty object when no defaults set', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      defaults: {},
      quickOverrides: {},
    }));

    expect(readProjectAgentDefaults(PROJECT)).toEqual({});
  });

  it('returns empty object when settings file missing', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
    expect(readProjectAgentDefaults(PROJECT)).toEqual({});
  });
});

describe('writeProjectAgentDefaults', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('writes agentDefaults to settings.json', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      defaults: {},
      quickOverrides: {},
    }));

    writeProjectAgentDefaults(PROJECT, {
      instructions: '# Template',
      permissions: { allow: ['Read'] },
    });

    const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
    expect(written.agentDefaults.instructions).toBe('# Template');
    expect(written.agentDefaults.permissions.allow).toEqual(['Read']);
  });
});

describe('applyAgentDefaults', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('writes instructions to CLAUDE.md', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      defaults: {},
      quickOverrides: {},
      agentDefaults: { instructions: '# Agent Template' },
    }));

    applyAgentDefaults(WORKTREE, PROJECT);

    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const claudeMdCall = writeCalls.find((c) => String(c[0]).endsWith('CLAUDE.md'));
    expect(claudeMdCall).toBeDefined();
    expect(claudeMdCall![1]).toBe('# Agent Template');
  });

  it('writes permissions to settings.local.json', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p).includes('settings.json') && !String(p).includes('settings.local')) {
        return JSON.stringify({
          defaults: {},
          quickOverrides: {},
          agentDefaults: { permissions: { allow: ['Read'], deny: ['WebFetch'] } },
        });
      }
      return '{}';
    });

    applyAgentDefaults(WORKTREE, PROJECT);

    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const permCall = writeCalls.find((c) => String(c[0]).includes('settings.local.json'));
    expect(permCall).toBeDefined();
    const written = JSON.parse(permCall![1] as string);
    expect(written.permissions.allow).toEqual(['Read']);
    expect(written.permissions.deny).toEqual(['WebFetch']);
  });

  it('writes mcp.json when default is set', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const mcpContent = '{"mcpServers": {"test": {"command": "npx"}}}';
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      defaults: {},
      quickOverrides: {},
      agentDefaults: { mcpJson: mcpContent },
    }));

    applyAgentDefaults(WORKTREE, PROJECT);

    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const mcpCall = writeCalls.find((c) => String(c[0]).endsWith('.mcp.json'));
    expect(mcpCall).toBeDefined();
    expect(mcpCall![1]).toBe(mcpContent);
  });

  it('does nothing when no defaults are set', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });

    applyAgentDefaults(WORKTREE, PROJECT);

    // Only the readFileSync call, no writes
    expect(fs.writeFileSync).not.toHaveBeenCalled();
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

  it('listSkills uses convention configDir/skillsDir', () => {
    vi.mocked(fs.readdirSync).mockReturnValue([
      { name: 'my-skill', isDirectory: () => true, isFile: () => false },
    ] as any);
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const result = listSkills(WORKTREE, COPILOT_CONVENTIONS);
    expect(fs.readdirSync).toHaveBeenCalledWith(
      path.join(WORKTREE, '.github', 'skills'),
      { withFileTypes: true },
    );
    expect(result[0].path).toContain('.github');
  });

  it('listAgentTemplates uses convention configDir/agentTemplatesDir', () => {
    vi.mocked(fs.readdirSync).mockReturnValue([
      { name: 'builder', isDirectory: () => true, isFile: () => false },
    ] as any);
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const result = listAgentTemplates(WORKTREE, COPILOT_CONVENTIONS);
    expect(fs.readdirSync).toHaveBeenCalledWith(
      path.join(WORKTREE, '.github', 'agents'),
      { withFileTypes: true },
    );
    expect(result[0].path).toContain('.github');
  });

  it('readSkillContent uses convention paths', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('# Skill');
    readSkillContent(WORKTREE, 'test-skill', COPILOT_CONVENTIONS);
    expect(fs.readFileSync).toHaveBeenCalledWith(
      path.join(WORKTREE, '.github', 'skills', 'test-skill', 'SKILL.md'),
      'utf-8',
    );
  });

  it('writeSkillContent uses convention paths', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    writeSkillContent(WORKTREE, 'test-skill', '# Content', COPILOT_CONVENTIONS);
    expect(fs.mkdirSync).toHaveBeenCalledWith(
      path.join(WORKTREE, '.github', 'skills', 'test-skill'),
      { recursive: true },
    );
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      path.join(WORKTREE, '.github', 'skills', 'test-skill', 'SKILL.md'),
      '# Content',
      'utf-8',
    );
  });

  it('deleteSkill uses convention paths', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    deleteSkill(WORKTREE, 'test-skill', COPILOT_CONVENTIONS);
    expect(fs.rmSync).toHaveBeenCalledWith(
      path.join(WORKTREE, '.github', 'skills', 'test-skill'),
      { recursive: true, force: true },
    );
  });

  it('readAgentTemplateContent uses convention paths', () => {
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p).endsWith('my-agent.md')) return '# Agent';
      throw new Error('ENOENT');
    });
    readAgentTemplateContent(WORKTREE, 'my-agent', COPILOT_CONVENTIONS);
    expect(fs.readFileSync).toHaveBeenCalledWith(
      path.join(WORKTREE, '.github', 'agents', 'my-agent.md'),
      'utf-8',
    );
  });

  it('writeAgentTemplateContent uses convention paths', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    writeAgentTemplateContent(WORKTREE, 'my-agent', '# Agent', COPILOT_CONVENTIONS);
    expect(fs.mkdirSync).toHaveBeenCalledWith(
      path.join(WORKTREE, '.github', 'agents'),
      { recursive: true },
    );
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      path.join(WORKTREE, '.github', 'agents', 'my-agent.md'),
      '# Agent',
      'utf-8',
    );
  });

  it('deleteAgentTemplate uses convention paths', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    deleteAgentTemplate(WORKTREE, 'my-agent', COPILOT_CONVENTIONS);
    expect(fs.unlinkSync).toHaveBeenCalledWith(
      path.join(WORKTREE, '.github', 'agents', 'my-agent.md'),
    );
    expect(fs.rmSync).toHaveBeenCalledWith(
      path.join(WORKTREE, '.github', 'agents', 'my-agent'),
      { recursive: true, force: true },
    );
  });

  it('listAgentTemplateFiles uses convention paths', () => {
    vi.mocked(fs.readdirSync).mockReturnValue([
      { name: 'reviewer.md', isFile: () => true, isDirectory: () => false },
    ] as any);
    vi.mocked(fs.existsSync).mockReturnValue(false);

    listAgentTemplateFiles(WORKTREE, COPILOT_CONVENTIONS);
    expect(fs.readdirSync).toHaveBeenCalledWith(
      path.join(WORKTREE, '.github', 'agents'),
      { withFileTypes: true },
    );
  });

  it('readMcpRawJson uses convention mcpConfigFile', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('{"mcpServers": {}}');
    readMcpRawJson(WORKTREE, COPILOT_CONVENTIONS);
    expect(fs.readFileSync).toHaveBeenCalledWith(
      path.join(WORKTREE, '.github', 'mcp.json'),
      'utf-8',
    );
  });

  it('writeMcpRawJson uses convention mcpConfigFile', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const content = '{"mcpServers": {}}';
    writeMcpRawJson(WORKTREE, content, COPILOT_CONVENTIONS);
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      path.join(WORKTREE, '.github', 'mcp.json'),
      content,
      'utf-8',
    );
  });

  it('readMcpConfig uses convention mcpConfigFile for project servers', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('{"mcpServers": {"test": {"command": "npx"}}}');
    readMcpConfig(WORKTREE, COPILOT_CONVENTIONS);
    // First readFileSync call should use convention path
    expect(vi.mocked(fs.readFileSync).mock.calls[0][0]).toBe(
      path.join(WORKTREE, '.github', 'mcp.json'),
    );
  });

  it('readPermissions uses convention configDir/localSettingsFile', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      permissions: { allow: ['Read'] },
    }));
    readPermissions(WORKTREE, COPILOT_CONVENTIONS);
    expect(fs.readFileSync).toHaveBeenCalledWith(
      path.join(WORKTREE, '.github', 'hooks', 'hooks.json'),
      'utf-8',
    );
  });

  it('writePermissions uses convention configDir/localSettingsFile', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('{}');
    writePermissions(WORKTREE, { allow: ['Read'] }, COPILOT_CONVENTIONS);
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      path.join(WORKTREE, '.github', 'hooks', 'hooks.json'),
      expect.any(String),
      'utf-8',
    );
  });

  it('writePermissions creates parent directory of settings file if missing', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
    writePermissions(WORKTREE, { allow: ['Read'] }, COPILOT_CONVENTIONS);
    // Should create the parent dir of hooks/hooks.json, which is .github/hooks
    expect(fs.mkdirSync).toHaveBeenCalledWith(
      path.dirname(path.join(WORKTREE, '.github', 'hooks', 'hooks.json')),
      { recursive: true },
    );
  });

  it('applyAgentDefaults uses convention for MCP and permissions', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const mcpContent = '{"mcpServers": {"test": {}}}';
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      const s = String(p);
      if (s.includes('settings.json') && !s.includes('settings.local') && !s.includes('hooks')) {
        return JSON.stringify({
          defaults: {},
          quickOverrides: {},
          agentDefaults: {
            mcpJson: mcpContent,
            permissions: { allow: ['Read'] },
          },
        });
      }
      return '{}';
    });

    const writeInstructions = vi.fn();
    applyAgentDefaults(WORKTREE, PROJECT, writeInstructions, COPILOT_CONVENTIONS);

    // MCP should be written to convention path
    const mcpWriteCall = vi.mocked(fs.writeFileSync).mock.calls.find(
      (c) => String(c[0]).includes('mcp.json'),
    );
    expect(mcpWriteCall).toBeDefined();
    expect(String(mcpWriteCall![0])).toBe(path.join(WORKTREE, '.github', 'mcp.json'));

    // Permissions should use convention path
    const permWriteCall = vi.mocked(fs.writeFileSync).mock.calls.find(
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

  it('readPermissions returns empty for TOML conventions without reading file', () => {
    const result = readPermissions(WORKTREE, CODEX_CONVENTIONS);
    expect(result).toEqual({});
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  it('writePermissions is a no-op for TOML conventions', () => {
    writePermissions(WORKTREE, { allow: ['Read', 'Write'], deny: ['WebFetch'] }, CODEX_CONVENTIONS);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(fs.mkdirSync).not.toHaveBeenCalled();
  });

  it('readMcpRawJson returns empty default for TOML conventions without reading file', () => {
    const result = readMcpRawJson(WORKTREE, CODEX_CONVENTIONS);
    expect(JSON.parse(result)).toEqual({ mcpServers: {} });
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  it('writeMcpRawJson returns error for TOML conventions without writing file', () => {
    const result = writeMcpRawJson(WORKTREE, '{"mcpServers": {}}', CODEX_CONVENTIONS);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not supported/i);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('applyAgentDefaults skips permissions and MCP JSON for TOML conventions', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      const s = String(p);
      if (s.includes('settings.json') && !s.includes('config.toml')) {
        return JSON.stringify({
          defaults: {},
          quickOverrides: {},
          agentDefaults: {
            instructions: '# Codex Agent',
            mcpJson: '{"mcpServers": {"test": {}}}',
            permissions: { allow: ['shell(git:*)'] },
          },
        });
      }
      throw new Error('ENOENT');
    });

    const writeInstructions = vi.fn();
    applyAgentDefaults(WORKTREE, PROJECT, writeInstructions, CODEX_CONVENTIONS);

    // Instructions should still be written via the custom writer
    expect(writeInstructions).toHaveBeenCalledWith(WORKTREE, '# Codex Agent');

    // No files should be written (permissions and MCP JSON both skipped)
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Error logging: catch blocks log warnings instead of silently swallowing
// =============================================================================

describe('error logging in catch blocks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('readClaudeMd logs warning on read failure', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
    const result = readClaudeMd(WORKTREE);
    expect(result).toBe('');
    expect(appLog).toHaveBeenCalledWith(
      'core:agent-settings', 'warn',
      expect.stringContaining('Failed to read CLAUDE.md'),
      expect.objectContaining({ meta: { error: 'ENOENT' } }),
    );
  });

  it('readMcpConfig logs warning on corrupt JSON', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('not valid json');
    const result = readMcpConfig(WORKTREE);
    expect(result).toEqual([]);
    expect(appLog).toHaveBeenCalledWith(
      'core:agent-settings', 'warn',
      expect.stringContaining('Failed to parse MCP config'),
      expect.objectContaining({ meta: expect.objectContaining({ error: expect.any(String) }) }),
    );
  });

  it('listSkills logs warning on directory read failure', () => {
    vi.mocked(fs.readdirSync).mockImplementation(() => { throw new Error('EACCES'); });
    const result = listSkills(WORKTREE);
    expect(result).toEqual([]);
    expect(appLog).toHaveBeenCalledWith(
      'core:agent-settings', 'warn',
      expect.stringContaining('Failed to list skills'),
      expect.objectContaining({ meta: { error: 'EACCES' } }),
    );
  });

  it('listAgentTemplates logs warning on directory read failure', () => {
    vi.mocked(fs.readdirSync).mockImplementation(() => { throw new Error('EACCES'); });
    const result = listAgentTemplates(WORKTREE);
    expect(result).toEqual([]);
    expect(appLog).toHaveBeenCalledWith(
      'core:agent-settings', 'warn',
      expect.stringContaining('Failed to list agent templates'),
      expect.objectContaining({ meta: { error: 'EACCES' } }),
    );
  });

  it('readPermissions logs warning on parse failure', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('corrupt json');
    const result = readPermissions(WORKTREE);
    expect(result).toEqual({});
    expect(appLog).toHaveBeenCalledWith(
      'core:agent-settings', 'warn',
      expect.stringContaining('Failed to read permissions'),
      expect.objectContaining({ meta: expect.objectContaining({ error: expect.any(String) }) }),
    );
  });

  it('readSkillContent logs warning on read failure', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
    const result = readSkillContent(WORKTREE, 'test-skill');
    expect(result).toBe('');
    expect(appLog).toHaveBeenCalledWith(
      'core:agent-settings', 'warn',
      expect.stringContaining('Failed to read skill content'),
      expect.objectContaining({ meta: { error: 'ENOENT' } }),
    );
  });

  it('readAgentTemplateContent logs warning when both forms fail', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
    const result = readAgentTemplateContent(WORKTREE, 'missing');
    expect(result).toBe('');
    expect(appLog).toHaveBeenCalledWith(
      'core:agent-settings', 'warn',
      expect.stringContaining('Failed to read agent template "missing"'),
      expect.objectContaining({ meta: { error: 'ENOENT' } }),
    );
  });

  it('readMcpRawJson logs warning on read failure', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
    const result = readMcpRawJson(WORKTREE);
    expect(JSON.parse(result)).toEqual({ mcpServers: {} });
    expect(appLog).toHaveBeenCalledWith(
      'core:agent-settings', 'warn',
      expect.stringContaining('Failed to read MCP config'),
      expect.objectContaining({ meta: { error: 'ENOENT' } }),
    );
  });

  it('listAgentTemplateFiles logs warning on directory read failure', () => {
    vi.mocked(fs.readdirSync).mockImplementation(() => { throw new Error('EACCES'); });
    const result = listAgentTemplateFiles(WORKTREE);
    expect(result).toEqual([]);
    expect(appLog).toHaveBeenCalledWith(
      'core:agent-settings', 'warn',
      expect.stringContaining('Failed to list agent template files'),
      expect.objectContaining({ meta: { error: 'EACCES' } }),
    );
  });

  it('applyAgentDefaults logs warning on invalid MCP JSON', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      defaults: {},
      quickOverrides: {},
      agentDefaults: { mcpJson: 'not valid json' },
    }));

    applyAgentDefaults(WORKTREE, PROJECT);

    expect(appLog).toHaveBeenCalledWith(
      'core:agent-settings', 'warn',
      expect.stringContaining('Skipped invalid MCP JSON'),
      expect.objectContaining({ meta: expect.objectContaining({ error: expect.any(String) }) }),
    );
  });

  it('writePermissions logs warning when existing settings are corrupt', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('not json');

    writePermissions(WORKTREE, { allow: ['Read'] });

    expect(appLog).toHaveBeenCalledWith(
      'core:agent-settings', 'warn',
      expect.stringContaining('Failed to read existing settings'),
      expect.objectContaining({ meta: expect.objectContaining({ error: expect.any(String) }) }),
    );
    // Should still write permissions despite corrupt existing file
    expect(fs.writeFileSync).toHaveBeenCalled();
  });
});
