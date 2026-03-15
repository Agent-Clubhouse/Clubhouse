import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test-app' },
}));

vi.mock('fs', () => {
  const readFileSyncFn = vi.fn(() => { throw new Error('ENOENT'); });
  const readdirSyncFn = vi.fn(() => []);
  return {
    existsSync: vi.fn(() => false),
    readFileSync: readFileSyncFn,
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: readdirSyncFn,
    copyFileSync: vi.fn(),
    promises: {
      readFile: vi.fn(async (...args: unknown[]) => readFileSyncFn(...args)),
      writeFile: vi.fn(async () => undefined),
      mkdir: vi.fn(async () => undefined),
      readdir: vi.fn(async (...args: unknown[]) => readdirSyncFn(...args)),
      rm: vi.fn(async () => undefined),
      unlink: vi.fn(async () => undefined),
      access: vi.fn(async () => { throw new Error('ENOENT'); }),
    },
  };
});

// materialization-service itself now uses fs/promises
vi.mock('fs/promises', () => ({
  readFile: vi.fn(() => Promise.reject(new Error('ENOENT'))),
  writeFile: vi.fn(() => Promise.resolve(undefined)),
  mkdir: vi.fn(() => Promise.resolve(undefined)),
  readdir: vi.fn(() => Promise.resolve([])),
  copyFile: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock('./fs-utils', () => ({
  pathExists: vi.fn(() => Promise.resolve(false)),
}));

vi.mock('./log-service', () => ({
  appLog: vi.fn(),
}));

vi.mock('./git-exclude-manager', () => ({
  addExclusions: vi.fn(),
  removeExclusions: vi.fn(),
}));

vi.mock('./clubhouse-mode-settings', () => ({
  getSettings: vi.fn(() => ({ enabled: false })),
  saveSettings: vi.fn(),
  isClubhouseModeEnabled: vi.fn(() => false),
}));

import * as fsp from 'fs/promises';
import { pathExists } from './fs-utils';
import {
  buildWildcardContext,
  materializeAgent,
  previewMaterialization,
  ensureDefaultTemplates,
  ensureDefaultSkills,
  resetDefaultSkills,
  resetProjectAgentDefaults,
  getDefaultAgentTemplates,
  resolveSourceControlProvider,
  enableExclusions,
  disableExclusions,
  MISSION_SKILL_CONTENT,
  CREATE_PR_SKILL_CONTENT,
  GO_STANDBY_SKILL_CONTENT,
  BUILD_SKILL_CONTENT,
  TEST_SKILL_CONTENT,
  LINT_SKILL_CONTENT,
  VALIDATE_CHANGES_SKILL_CONTENT,
} from './materialization-service';
import * as clubhouseModeSettings from './clubhouse-mode-settings';
import * as gitExcludeManager from './git-exclude-manager';
import type { DurableAgentConfig } from '../../shared/types';
import type { OrchestratorProvider, OrchestratorConventions } from '../orchestrators/types';

// --- Fixtures ---

const testAgent: DurableAgentConfig = {
  id: 'test_001',
  name: 'bold-falcon',
  color: 'blue',
  branch: 'bold-falcon/standby',
  worktreePath: '/project/.clubhouse/agents/bold-falcon',
  createdAt: '2024-01-01',
};

const testConventions: OrchestratorConventions = {
  configDir: '.claude',
  localInstructionsFile: 'CLAUDE.local.md',
  legacyInstructionsFile: 'CLAUDE.md',
  mcpConfigFile: '.mcp.json',
  skillsDir: 'skills',
  agentTemplatesDir: 'agents',
  localSettingsFile: 'settings.local.json',
};

const mockProvider: OrchestratorProvider = {
  id: 'claude-code',
  displayName: 'Claude Code',
  shortName: 'CC',
  conventions: testConventions,
  writeInstructions: vi.fn(),
  readInstructions: vi.fn(() => ''),
  getCapabilities: vi.fn(() => ({
    headless: true, structuredOutput: true, hooks: true, sessionResume: true, permissions: true, structuredMode: false,
  })),
  checkAvailability: vi.fn(async () => ({ available: true })),
  buildSpawnCommand: vi.fn(async () => ({ binary: 'claude', args: [], env: {} })),
  getExitCommand: vi.fn(() => '/exit'),
  getModelOptions: vi.fn(async () => []),
  getDefaultPermissions: vi.fn(() => []),
  toolVerb: vi.fn(() => undefined),
};

/**
 * Helper to mock fsp.readFile to return settings JSON for settings.json paths.
 */
function mockSettingsFile(settingsJson: string): void {
  vi.mocked(fsp.readFile).mockImplementation(async (p: unknown) => {
    const filePath = String(p);
    if (filePath.includes('settings.json')) return settingsJson;
    throw new Error('ENOENT');
  });
}

describe('materialization-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
    vi.mocked(fsp.readFile).mockRejectedValue(new Error('ENOENT'));
    vi.mocked(fsp.readdir).mockResolvedValue([]);
    vi.mocked(fsp.copyFile).mockResolvedValue(undefined);
    vi.mocked(pathExists).mockResolvedValue(false);
  });

  describe('buildWildcardContext', () => {
    it('builds context from agent config', () => {
      const ctx = buildWildcardContext(testAgent, '/project');
      expect(ctx.agentName).toBe('bold-falcon');
      expect(ctx.standbyBranch).toBe('bold-falcon/standby');
      expect(ctx.agentPath).toBe('.clubhouse/agents/bold-falcon/');
    });

    it('falls back to name-based path when no worktreePath', () => {
      const agent = { ...testAgent, worktreePath: undefined };
      const ctx = buildWildcardContext(agent, '/project');
      expect(ctx.agentPath).toBe('.clubhouse/agents/bold-falcon/');
    });

    it('falls back to name-based standby branch when no branch set', () => {
      const agent = { ...testAgent, branch: undefined };
      const ctx = buildWildcardContext(agent, '/project');
      expect(ctx.standbyBranch).toBe('bold-falcon/standby');
    });

    it('includes sourceControlProvider when provided', () => {
      const ctx = buildWildcardContext(testAgent, '/project', 'github');
      expect(ctx.sourceControlProvider).toBe('github');
    });

    it('includes sourceControlProvider as azure-devops', () => {
      const ctx = buildWildcardContext(testAgent, '/project', 'azure-devops');
      expect(ctx.sourceControlProvider).toBe('azure-devops');
    });

    it('omits sourceControlProvider when not provided', () => {
      const ctx = buildWildcardContext(testAgent, '/project');
      expect(ctx.sourceControlProvider).toBeUndefined();
    });

    it('includes command wildcards when provided', () => {
      const ctx = buildWildcardContext(testAgent, '/project', undefined, {
        buildCommand: 'cargo build',
        testCommand: 'cargo test',
        lintCommand: 'cargo clippy',
      });
      expect(ctx.buildCommand).toBe('cargo build');
      expect(ctx.testCommand).toBe('cargo test');
      expect(ctx.lintCommand).toBe('cargo clippy');
    });

    it('omits command wildcards when not provided', () => {
      const ctx = buildWildcardContext(testAgent, '/project');
      expect(ctx.buildCommand).toBeUndefined();
      expect(ctx.testCommand).toBeUndefined();
      expect(ctx.lintCommand).toBeUndefined();
    });
  });

  describe('resolveSourceControlProvider', () => {
    it('returns project-level setting when set', async () => {
      mockSettingsFile(JSON.stringify({
        defaults: {},
        quickOverrides: {},
        agentDefaults: { sourceControlProvider: 'azure-devops' },
      }));

      expect(await resolveSourceControlProvider('/project')).toBe('azure-devops');
    });

    it('falls back to app-level clubhouse mode setting', async () => {
      mockSettingsFile(JSON.stringify({
        defaults: {},
        quickOverrides: {},
        agentDefaults: {},
      }));
      vi.mocked(clubhouseModeSettings.getSettings).mockReturnValue({
        enabled: true,
        sourceControlProvider: 'azure-devops',
      });

      expect(await resolveSourceControlProvider('/project')).toBe('azure-devops');
    });

    it('defaults to github when nothing is configured', async () => {
      mockSettingsFile(JSON.stringify({
        defaults: {},
        quickOverrides: {},
      }));
      vi.mocked(clubhouseModeSettings.getSettings).mockReturnValue({ enabled: false });

      expect(await resolveSourceControlProvider('/project')).toBe('github');
    });
  });

  describe('materializeAgent', () => {
    it('writes instructions with wildcards replaced', async () => {
      mockSettingsFile(JSON.stringify({
        defaults: {},
        quickOverrides: {},
        agentDefaults: {
          instructions: 'Agent @@AgentName at @@Path',
        },
      }));

      await materializeAgent({ projectPath: '/project', agent: testAgent, provider: mockProvider });

      expect(mockProvider.writeInstructions).toHaveBeenCalledWith(
        testAgent.worktreePath,
        'Agent bold-falcon at .clubhouse/agents/bold-falcon/',
      );
    });

    it('writes permissions with wildcards replaced', async () => {
      mockSettingsFile(JSON.stringify({
        defaults: {},
        quickOverrides: {},
        agentDefaults: {
          permissions: {
            allow: ['Read(@@Path**)'],
            deny: ['Write(../**)'],
          },
        },
      }));

      await materializeAgent({ projectPath: '/project', agent: testAgent, provider: mockProvider });

      expect(fsp.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('settings.local.json'),
        expect.stringContaining('.clubhouse/agents/bold-falcon/'),
        'utf-8',
      );
    });

    it('writes MCP JSON with wildcards replaced', async () => {
      mockSettingsFile(JSON.stringify({
        defaults: {},
        quickOverrides: {},
        agentDefaults: {
          mcpJson: '{"mcpServers": {"test": {"command": "@@AgentName"}}}',
        },
      }));

      await materializeAgent({ projectPath: '/project', agent: testAgent, provider: mockProvider });

      // MCP JSON write now goes through fsp.writeFile
      const writeCall = vi.mocked(fsp.writeFile).mock.calls.find(
        (call) => (call[0] as string).includes('.mcp.json'),
      );
      expect(writeCall).toBeDefined();
      expect(writeCall![1]).toContain('bold-falcon');
    });

    it('no-ops when no defaults exist and no source dirs', async () => {
      mockSettingsFile(JSON.stringify({
        defaults: {},
        quickOverrides: {},
      }));

      await materializeAgent({ projectPath: '/project', agent: testAgent, provider: mockProvider });

      expect(mockProvider.writeInstructions).not.toHaveBeenCalled();
    });

    it('skips agent without worktreePath', async () => {
      const agent = { ...testAgent, worktreePath: undefined };
      mockSettingsFile(JSON.stringify({
        defaults: {},
        quickOverrides: {},
        agentDefaults: { instructions: 'test' },
      }));

      await materializeAgent({ projectPath: '/project', agent, provider: mockProvider });

      expect(mockProvider.writeInstructions).not.toHaveBeenCalled();
    });

    it('skips MCP JSON write for TOML settings format', async () => {
      const tomlConventions: OrchestratorConventions = {
        ...testConventions,
        mcpConfigFile: '.codex/config.toml',
        localSettingsFile: 'config.toml',
        settingsFormat: 'toml',
      };
      const tomlProvider: OrchestratorProvider = {
        ...mockProvider,
        conventions: tomlConventions,
        writeInstructions: vi.fn(),
      };

      mockSettingsFile(JSON.stringify({
        defaults: {},
        quickOverrides: {},
        agentDefaults: {
          instructions: 'Agent @@AgentName',
          mcpJson: '{"mcpServers": {"test": {}}}',
          permissions: { allow: ['shell(git:*)'] },
        },
      }));

      await materializeAgent({ projectPath: '/project', agent: testAgent, provider: tomlProvider });

      // Instructions should still be written via the provider
      expect(tomlProvider.writeInstructions).toHaveBeenCalled();

      // MCP JSON should NOT be written to filesystem (via fsp.writeFile)
      const fspWrites = vi.mocked(fsp.writeFile).mock.calls;
      const tomlFspWrites = fspWrites.filter((c) => String(c[0]).includes('config.toml'));
      expect(tomlFspWrites).toHaveLength(0);
    });
  });

  describe('previewMaterialization', () => {
    it('returns resolved values without writing files', async () => {
      mockSettingsFile(JSON.stringify({
        defaults: {},
        quickOverrides: {},
        agentDefaults: {
          instructions: 'Agent @@AgentName',
          permissions: { allow: ['Read(@@Path**)'] },
          mcpJson: '{"mcpServers": {}}',
        },
      }));

      const preview = await previewMaterialization({
        projectPath: '/project',
        agent: testAgent,
        provider: mockProvider,
      });

      expect(preview.instructions).toBe('Agent bold-falcon');
      expect(preview.permissions.allow).toEqual(['Read(.clubhouse/agents/bold-falcon/**)']);
      expect(preview.mcpJson).toBe('{"mcpServers": {}}');
      // Should not have written any files
      expect(mockProvider.writeInstructions).not.toHaveBeenCalled();
    });

    it('returns empty values when no defaults', async () => {
      mockSettingsFile(JSON.stringify({
        defaults: {},
        quickOverrides: {},
      }));

      const preview = await previewMaterialization({
        projectPath: '/project',
        agent: testAgent,
        provider: mockProvider,
      });

      expect(preview.instructions).toBe('');
      expect(preview.permissions).toEqual({});
      expect(preview.mcpJson).toBeNull();
    });
  });

  describe('ensureDefaultTemplates', () => {
    it('writes default instructions and permissions when no defaults exist', async () => {
      mockSettingsFile(JSON.stringify({ defaults: {}, quickOverrides: {} }));

      await ensureDefaultTemplates('/project');

      // Should have written settings.json via fsp.writeFile with agent defaults
      const settingsWriteCall = vi.mocked(fsp.writeFile).mock.calls.find(
        (call) => (call[0] as string).includes('settings.json') && !(call[0] as string).includes('SKILL'),
      );
      expect(settingsWriteCall).toBeDefined();
      const written = JSON.parse(settingsWriteCall![1] as string);
      expect(written.agentDefaults.instructions).toContain('@@AgentName');
      expect(written.agentDefaults.permissions.allow).toContain('Read(@@Path**)');
    });

    it('includes generic build tool permissions in defaults', async () => {
      mockSettingsFile(JSON.stringify({ defaults: {}, quickOverrides: {} }));

      await ensureDefaultTemplates('/project');

      const settingsWriteCall = vi.mocked(fsp.writeFile).mock.calls.find(
        (call) => (call[0] as string).includes('settings.json') && !(call[0] as string).includes('SKILL'),
      );
      expect(settingsWriteCall).toBeDefined();
      const written = JSON.parse(settingsWriteCall![1] as string);
      const allow = written.agentDefaults.permissions.allow;
      expect(allow).toContain('Bash(git:*)');
      expect(allow).toContain('Bash(npm:*)');
      expect(allow).toContain('Bash(yarn:*)');
      expect(allow).toContain('Bash(pnpm:*)');
      expect(allow).toContain('Bash(cargo:*)');
      expect(allow).toContain('Bash(make:*)');
      expect(allow).toContain('Bash(go:*)');
      expect(allow).toContain('WebSearch');
    });

    it('includes az repos and az devops permissions in defaults', async () => {
      mockSettingsFile(JSON.stringify({ defaults: {}, quickOverrides: {} }));

      await ensureDefaultTemplates('/project');

      const settingsWriteCall = vi.mocked(fsp.writeFile).mock.calls.find(
        (call) => (call[0] as string).includes('settings.json') && !(call[0] as string).includes('SKILL'),
      );
      expect(settingsWriteCall).toBeDefined();
      const written = JSON.parse(settingsWriteCall![1] as string);
      expect(written.agentDefaults.permissions.allow).toContain('Bash(az repos:*)');
      expect(written.agentDefaults.permissions.allow).toContain('Bash(az devops:*)');
    });

    it('creates all default skills when no defaults exist', async () => {
      mockSettingsFile(JSON.stringify({ defaults: {}, quickOverrides: {} }));

      await ensureDefaultTemplates('/project');

      // Skill writes now go through fsp.writeFile
      const skillWrites = vi.mocked(fsp.writeFile).mock.calls.filter(
        (call) => (call[0] as string).includes('SKILL.md'),
      );
      expect(skillWrites).toHaveLength(7);

      const paths = skillWrites.map((call) => (call[0] as string).replace(/\\/g, '/'));
      expect(paths.some((p) => p.includes('/mission/'))).toBe(true);
      expect(paths.some((p) => p.includes('/create-pr/'))).toBe(true);
      expect(paths.some((p) => p.includes('/go-standby/'))).toBe(true);
      expect(paths.some((p) => p.includes('/build/'))).toBe(true);
      expect(paths.some((p) => p.includes('/test/'))).toBe(true);
      expect(paths.some((p) => p.includes('/lint/'))).toBe(true);
      expect(paths.some((p) => p.includes('/validate-changes/'))).toBe(true);
    });

    it('still creates skills even when defaults already exist', async () => {
      mockSettingsFile(JSON.stringify({
        defaults: {},
        quickOverrides: {},
        agentDefaults: { instructions: 'existing' },
      }));

      await ensureDefaultTemplates('/project');

      // Check that skills were still created (via fsp.writeFile)
      const skillWrites = vi.mocked(fsp.writeFile).mock.calls.filter(
        (call) => (call[0] as string).includes('SKILL.md'),
      );
      expect(skillWrites).toHaveLength(7);
    });

    it('no-ops when defaults already exist and skill files already exist', async () => {
      mockSettingsFile(JSON.stringify({
        defaults: {},
        quickOverrides: {},
        agentDefaults: { instructions: 'existing' },
      }));
      vi.mocked(pathExists).mockResolvedValue(true);

      await ensureDefaultTemplates('/project');

      // Should not write any SKILL.md files (they already exist)
      const skillWrites = vi.mocked(fsp.writeFile).mock.calls.filter(
        (call) => (call[0] as string).includes('SKILL.md'),
      );
      expect(skillWrites).toHaveLength(0);
    });
  });

  describe('getDefaultAgentTemplates', () => {
    it('returns instructions containing wildcards', () => {
      const templates = getDefaultAgentTemplates();
      expect(templates.instructions).toContain('@@AgentName');
      expect(templates.instructions).toContain('@@StandbyBranch');
      expect(templates.instructions).toContain('@@Path');
    });

    it('returns permissions with allow and deny lists', () => {
      const templates = getDefaultAgentTemplates();
      expect(templates.permissions?.allow).toContain('Read(@@Path**)');
      expect(templates.permissions?.deny).toContain('Read(../**)');
    });
  });

  describe('resetProjectAgentDefaults', () => {
    it('overwrites existing defaults with built-in templates', async () => {
      // Existing customized defaults
      mockSettingsFile(JSON.stringify({
        defaults: {},
        quickOverrides: {},
        agentDefaults: { instructions: 'custom instructions' },
      }));

      await resetProjectAgentDefaults('/project');

      const settingsWriteCall = vi.mocked(fsp.writeFile).mock.calls.find(
        (call) => (call[0] as string).includes('settings.json') && !(call[0] as string).includes('SKILL'),
      );
      expect(settingsWriteCall).toBeDefined();
      const written = JSON.parse(settingsWriteCall![1] as string);
      expect(written.agentDefaults.instructions).toContain('@@AgentName');
      expect(written.agentDefaults.permissions.allow).toContain('Read(@@Path**)');
    });

    it('also ensures default skills exist', async () => {
      mockSettingsFile(JSON.stringify({
        defaults: {},
        quickOverrides: {},
        agentDefaults: { instructions: 'custom' },
      }));

      await resetProjectAgentDefaults('/project');

      // Skill writes now go through fsp.writeFile
      const skillWrites = vi.mocked(fsp.writeFile).mock.calls.filter(
        (call) => (call[0] as string).includes('SKILL.md'),
      );
      expect(skillWrites).toHaveLength(7);
    });

    it('overwrites existing skill files with built-in defaults', async () => {
      mockSettingsFile(JSON.stringify({
        defaults: {},
        quickOverrides: {},
        agentDefaults: { instructions: 'custom' },
      }));
      // All files already exist
      vi.mocked(pathExists).mockResolvedValue(true);

      await resetProjectAgentDefaults('/project');

      // Skills should still be written even though files exist (force=true)
      const skillWrites = vi.mocked(fsp.writeFile).mock.calls.filter(
        (call) => (call[0] as string).includes('SKILL.md'),
      );
      expect(skillWrites).toHaveLength(7);
    });
  });

  describe('ensureDefaultSkills', () => {
    it('creates all seven skills when none exist', async () => {
      vi.mocked(fsp.readFile).mockRejectedValue(new Error('ENOENT'));

      await ensureDefaultSkills('/project');

      // Skill writes now go through fsp.writeFile
      const skillWrites = vi.mocked(fsp.writeFile).mock.calls.filter(
        (call) => (call[0] as string).includes('SKILL.md'),
      );
      expect(skillWrites).toHaveLength(7);

      const normalize = (call: unknown[]) => (call[0] as string).replace(/\\/g, '/');
      const missionWrite = skillWrites.find((call) => normalize(call).includes('/mission/'));
      expect(missionWrite![1]).toContain('Mission Skill');
      expect(missionWrite![1]).toContain('/create-pr');

      const createPrWrite = skillWrites.find((call) => normalize(call).includes('/create-pr/'));
      expect(createPrWrite![1]).toContain('Create Pull Request');
      expect(createPrWrite![1]).toContain('@@If(github)');
      expect(createPrWrite![1]).toContain('@@If(azure-devops)');

      const goStandbyWrite = skillWrites.find((call) => normalize(call).includes('/go-standby/'));
      expect(goStandbyWrite![1]).toContain('Go Standby');
      expect(goStandbyWrite![1]).toContain('@@StandbyBranch');

      const buildWrite = skillWrites.find((call) => normalize(call).endsWith('/build/SKILL.md'));
      expect(buildWrite![1]).toContain('@@BuildCommand');

      const testWrite = skillWrites.find((call) => normalize(call).endsWith('/test/SKILL.md'));
      expect(testWrite![1]).toContain('@@TestCommand');

      const lintWrite = skillWrites.find((call) => normalize(call).endsWith('/lint/SKILL.md'));
      expect(lintWrite![1]).toContain('@@LintCommand');

      const validateWrite = skillWrites.find((call) => normalize(call).includes('/validate-changes/'));
      expect(validateWrite![1]).toContain('@@BuildCommand');
      expect(validateWrite![1]).toContain('@@TestCommand');
      expect(validateWrite![1]).toContain('@@LintCommand');
    });

    it('skips existing skills', async () => {
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({ defaultSkillsPath: 'skills' }));

      await ensureDefaultSkills('/project');

      const skillWrites = vi.mocked(fsp.writeFile).mock.calls.filter(
        (call) => (call[0] as string).includes('SKILL.md'),
      );
      expect(skillWrites).toHaveLength(0);
    });
  });

  describe('resetDefaultSkills', () => {
    it('overwrites all skill files even when they already exist', async () => {
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({ defaultSkillsPath: 'skills' }));

      await resetDefaultSkills('/project');

      const skillWrites = vi.mocked(fsp.writeFile).mock.calls.filter(
        (call) => (call[0] as string).includes('SKILL.md'),
      );
      expect(skillWrites).toHaveLength(7);
    });

    it('writes latest built-in content when overwriting', async () => {
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({ defaultSkillsPath: 'skills' }));

      await resetDefaultSkills('/project');

      const skillWrites = vi.mocked(fsp.writeFile).mock.calls.filter(
        (call) => (call[0] as string).includes('SKILL.md'),
      );
      const normalize = (call: unknown[]) => (call[0] as string).replace(/\\/g, '/');
      const missionWrite = skillWrites.find((call) => normalize(call).includes('/mission/'));
      expect(missionWrite![1]).toContain('Mission Skill');
      expect(missionWrite![1]).toContain('/validate-changes');
    });
  });

  describe('skill content constants', () => {
    it('MISSION_SKILL_CONTENT references /validate-changes, /create-pr, and /go-standby', () => {
      expect(MISSION_SKILL_CONTENT).toContain('/validate-changes');
      expect(MISSION_SKILL_CONTENT).toContain('/create-pr');
      expect(MISSION_SKILL_CONTENT).toContain('/go-standby');
    });

    it('MISSION_SKILL_CONTENT does not contain hardcoded npm commands', () => {
      expect(MISSION_SKILL_CONTENT).not.toContain('npm run validate');
      expect(MISSION_SKILL_CONTENT).not.toContain('npm test');
    });

    it('CREATE_PR_SKILL_CONTENT has both provider conditional blocks', () => {
      expect(CREATE_PR_SKILL_CONTENT).toContain('@@If(github)');
      expect(CREATE_PR_SKILL_CONTENT).toContain('@@If(azure-devops)');
      expect(CREATE_PR_SKILL_CONTENT).toContain('gh pr create');
      expect(CREATE_PR_SKILL_CONTENT).toContain('az repos pr create');
    });

    it('GO_STANDBY_SKILL_CONTENT uses @@StandbyBranch', () => {
      expect(GO_STANDBY_SKILL_CONTENT).toContain('@@StandbyBranch');
    });

    it('BUILD_SKILL_CONTENT uses @@BuildCommand', () => {
      expect(BUILD_SKILL_CONTENT).toContain('@@BuildCommand');
    });

    it('TEST_SKILL_CONTENT uses @@TestCommand', () => {
      expect(TEST_SKILL_CONTENT).toContain('@@TestCommand');
    });

    it('LINT_SKILL_CONTENT uses @@LintCommand', () => {
      expect(LINT_SKILL_CONTENT).toContain('@@LintCommand');
    });

    it('VALIDATE_CHANGES_SKILL_CONTENT uses all three command wildcards', () => {
      expect(VALIDATE_CHANGES_SKILL_CONTENT).toContain('@@BuildCommand');
      expect(VALIDATE_CHANGES_SKILL_CONTENT).toContain('@@TestCommand');
      expect(VALIDATE_CHANGES_SKILL_CONTENT).toContain('@@LintCommand');
    });
  });

  describe('enableExclusions / disableExclusions', () => {
    it('adds convention-derived patterns', () => {
      enableExclusions('/project', mockProvider);

      expect(gitExcludeManager.addExclusions).toHaveBeenCalledWith(
        '/project',
        'clubhouse-mode',
        expect.arrayContaining([
          'CLAUDE.md',
          '.claude/settings.local.json',
          '.mcp.json',
          '.claude/skills/',
          '.claude/agents/',
        ]),
      );
    });

    it('removes all clubhouse-mode entries', () => {
      disableExclusions('/project');

      expect(gitExcludeManager.removeExclusions).toHaveBeenCalledWith(
        '/project',
        'clubhouse-mode',
      );
    });
  });
});
