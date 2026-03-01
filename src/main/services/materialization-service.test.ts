import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test-app' },
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  copyFileSync: vi.fn(),
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

import * as fs from 'fs';
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
  writeHooksConfig: vi.fn(async () => {}),
  parseHookEvent: vi.fn(() => null),
  getModelOptions: vi.fn(async () => []),
  getDefaultPermissions: vi.fn(() => []),
  toolVerb: vi.fn(() => undefined),
  buildSummaryInstruction: vi.fn(() => ''),
  readQuickSummary: vi.fn(async () => null),
};

describe('materialization-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    it('returns project-level setting when set', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        defaults: {},
        quickOverrides: {},
        agentDefaults: { sourceControlProvider: 'azure-devops' },
      }));

      expect(resolveSourceControlProvider('/project')).toBe('azure-devops');
    });

    it('falls back to app-level clubhouse mode setting', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        defaults: {},
        quickOverrides: {},
        agentDefaults: {},
      }));
      vi.mocked(clubhouseModeSettings.getSettings).mockReturnValue({
        enabled: true,
        sourceControlProvider: 'azure-devops',
      });

      expect(resolveSourceControlProvider('/project')).toBe('azure-devops');
    });

    it('defaults to github when nothing is configured', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        defaults: {},
        quickOverrides: {},
      }));
      vi.mocked(clubhouseModeSettings.getSettings).mockReturnValue({ enabled: false });

      expect(resolveSourceControlProvider('/project')).toBe('github');
    });
  });

  describe('materializeAgent', () => {
    it('writes instructions with wildcards replaced', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        defaults: {},
        quickOverrides: {},
        agentDefaults: {
          instructions: 'Agent @@AgentName at @@Path',
        },
      }));

      materializeAgent({ projectPath: '/project', agent: testAgent, provider: mockProvider });

      expect(mockProvider.writeInstructions).toHaveBeenCalledWith(
        testAgent.worktreePath,
        'Agent bold-falcon at .clubhouse/agents/bold-falcon/',
      );
    });

    it('writes permissions with wildcards replaced', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        defaults: {},
        quickOverrides: {},
        agentDefaults: {
          permissions: {
            allow: ['Read(@@Path**)'],
            deny: ['Write(../**)'],
          },
        },
      }));

      materializeAgent({ projectPath: '/project', agent: testAgent, provider: mockProvider });

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('settings.local.json'),
        expect.stringContaining('.clubhouse/agents/bold-falcon/'),
        'utf-8',
      );
    });

    it('writes MCP JSON with wildcards replaced', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        defaults: {},
        quickOverrides: {},
        agentDefaults: {
          mcpJson: '{"mcpServers": {"test": {"command": "@@AgentName"}}}',
        },
      }));

      materializeAgent({ projectPath: '/project', agent: testAgent, provider: mockProvider });

      const writeCall = vi.mocked(fs.writeFileSync).mock.calls.find(
        (call) => (call[0] as string).includes('.mcp.json'),
      );
      expect(writeCall).toBeDefined();
      expect(writeCall![1]).toContain('bold-falcon');
    });

    it('no-ops when no defaults exist and no source dirs', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        defaults: {},
        quickOverrides: {},
      }));

      materializeAgent({ projectPath: '/project', agent: testAgent, provider: mockProvider });

      expect(mockProvider.writeInstructions).not.toHaveBeenCalled();
    });

    it('skips agent without worktreePath', () => {
      const agent = { ...testAgent, worktreePath: undefined };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        defaults: {},
        quickOverrides: {},
        agentDefaults: { instructions: 'test' },
      }));

      materializeAgent({ projectPath: '/project', agent, provider: mockProvider });

      expect(mockProvider.writeInstructions).not.toHaveBeenCalled();
    });

    it('skips MCP JSON write for TOML settings format', () => {
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

      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        defaults: {},
        quickOverrides: {},
        agentDefaults: {
          instructions: 'Agent @@AgentName',
          mcpJson: '{"mcpServers": {"test": {}}}',
          permissions: { allow: ['shell(git:*)'] },
        },
      }));

      materializeAgent({ projectPath: '/project', agent: testAgent, provider: tomlProvider });

      // Instructions should still be written via the provider
      expect(tomlProvider.writeInstructions).toHaveBeenCalled();

      // MCP JSON and permissions should NOT be written to filesystem
      const fileWrites = vi.mocked(fs.writeFileSync).mock.calls;
      const tomlWrites = fileWrites.filter((c) => String(c[0]).includes('config.toml'));
      expect(tomlWrites).toHaveLength(0);

      // No settings.local.json or config.toml permissions writes
      const permWrites = fileWrites.filter((c) =>
        String(c[0]).includes('settings.local.json') || String(c[0]).includes('config.toml'),
      );
      expect(permWrites).toHaveLength(0);
    });
  });

  describe('previewMaterialization', () => {
    it('returns resolved values without writing files', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        defaults: {},
        quickOverrides: {},
        agentDefaults: {
          instructions: 'Agent @@AgentName',
          permissions: { allow: ['Read(@@Path**)'] },
          mcpJson: '{"mcpServers": {}}',
        },
      }));

      const preview = previewMaterialization({
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

    it('returns empty values when no defaults', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        defaults: {},
        quickOverrides: {},
      }));

      const preview = previewMaterialization({
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
    it('writes default instructions and permissions when no defaults exist', () => {
      let callCount = 0;
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        callCount++;
        if (callCount <= 1) {
          return JSON.stringify({ defaults: {}, quickOverrides: {} });
        }
        throw new Error('ENOENT');
      });
      vi.mocked(fs.existsSync).mockReturnValue(false);

      ensureDefaultTemplates('/project');

      // Should have written settings.json with agent defaults
      const settingsWriteCall = vi.mocked(fs.writeFileSync).mock.calls.find(
        (call) => (call[0] as string).includes('settings.json') && !(call[0] as string).includes('SKILL'),
      );
      expect(settingsWriteCall).toBeDefined();
      const written = JSON.parse(settingsWriteCall![1] as string);
      expect(written.agentDefaults.instructions).toContain('@@AgentName');
      expect(written.agentDefaults.permissions.allow).toContain('Read(@@Path**)');
    });

    it('includes generic build tool permissions in defaults', () => {
      let callCount = 0;
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        callCount++;
        if (callCount <= 1) {
          return JSON.stringify({ defaults: {}, quickOverrides: {} });
        }
        throw new Error('ENOENT');
      });
      vi.mocked(fs.existsSync).mockReturnValue(false);

      ensureDefaultTemplates('/project');

      const settingsWriteCall = vi.mocked(fs.writeFileSync).mock.calls.find(
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

    it('includes az repos and az devops permissions in defaults', () => {
      let callCount = 0;
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        callCount++;
        if (callCount <= 1) {
          return JSON.stringify({ defaults: {}, quickOverrides: {} });
        }
        throw new Error('ENOENT');
      });
      vi.mocked(fs.existsSync).mockReturnValue(false);

      ensureDefaultTemplates('/project');

      const settingsWriteCall = vi.mocked(fs.writeFileSync).mock.calls.find(
        (call) => (call[0] as string).includes('settings.json') && !(call[0] as string).includes('SKILL'),
      );
      expect(settingsWriteCall).toBeDefined();
      const written = JSON.parse(settingsWriteCall![1] as string);
      expect(written.agentDefaults.permissions.allow).toContain('Bash(az repos:*)');
      expect(written.agentDefaults.permissions.allow).toContain('Bash(az devops:*)');
    });

    it('creates all default skills when no defaults exist', () => {
      let callCount = 0;
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        callCount++;
        if (callCount <= 1) {
          return JSON.stringify({ defaults: {}, quickOverrides: {} });
        }
        throw new Error('ENOENT');
      });
      vi.mocked(fs.existsSync).mockReturnValue(false);

      ensureDefaultTemplates('/project');

      const skillWrites = vi.mocked(fs.writeFileSync).mock.calls.filter(
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

    it('still creates skills even when defaults already exist', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        defaults: {},
        quickOverrides: {},
        agentDefaults: { instructions: 'existing' },
      }));
      vi.mocked(fs.existsSync).mockReturnValue(false);

      ensureDefaultTemplates('/project');

      // Should not write settings.json (defaults already exist)
      const settingsWriteCalls = vi.mocked(fs.writeFileSync).mock.calls.filter(
        (call) => (call[0] as string).endsWith('settings.json'),
      );
      // Only the skills settings.json write (for defaultSkillsPath), not agent defaults
      // Check that skills were still created
      const skillWrites = vi.mocked(fs.writeFileSync).mock.calls.filter(
        (call) => (call[0] as string).includes('SKILL.md'),
      );
      expect(skillWrites).toHaveLength(7);
    });

    it('no-ops when defaults already exist and skill files already exist', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        defaults: {},
        quickOverrides: {},
        agentDefaults: { instructions: 'existing' },
      }));
      vi.mocked(fs.existsSync).mockReturnValue(true);

      ensureDefaultTemplates('/project');

      // Should not write any SKILL.md files (they already exist)
      const skillWrites = vi.mocked(fs.writeFileSync).mock.calls.filter(
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
    it('overwrites existing defaults with built-in templates', () => {
      // Existing customized defaults
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        defaults: {},
        quickOverrides: {},
        agentDefaults: { instructions: 'custom instructions' },
      }));
      vi.mocked(fs.existsSync).mockReturnValue(false);

      resetProjectAgentDefaults('/project');

      const settingsWriteCall = vi.mocked(fs.writeFileSync).mock.calls.find(
        (call) => (call[0] as string).includes('settings.json') && !(call[0] as string).includes('SKILL'),
      );
      expect(settingsWriteCall).toBeDefined();
      const written = JSON.parse(settingsWriteCall![1] as string);
      expect(written.agentDefaults.instructions).toContain('@@AgentName');
      expect(written.agentDefaults.permissions.allow).toContain('Read(@@Path**)');
    });

    it('also ensures default skills exist', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        defaults: {},
        quickOverrides: {},
        agentDefaults: { instructions: 'custom' },
      }));
      vi.mocked(fs.existsSync).mockReturnValue(false);

      resetProjectAgentDefaults('/project');

      const skillWrites = vi.mocked(fs.writeFileSync).mock.calls.filter(
        (call) => (call[0] as string).includes('SKILL.md'),
      );
      expect(skillWrites).toHaveLength(7);
    });

    it('overwrites existing skill files with built-in defaults', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        defaults: {},
        quickOverrides: {},
        agentDefaults: { instructions: 'custom' },
      }));
      // All files already exist
      vi.mocked(fs.existsSync).mockReturnValue(true);

      resetProjectAgentDefaults('/project');

      // Skills should still be written even though files exist
      const skillWrites = vi.mocked(fs.writeFileSync).mock.calls.filter(
        (call) => (call[0] as string).includes('SKILL.md'),
      );
      expect(skillWrites).toHaveLength(7);
    });
  });

  describe('ensureDefaultSkills', () => {
    it('creates all seven skills when none exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });

      ensureDefaultSkills('/project');

      const skillWrites = vi.mocked(fs.writeFileSync).mock.calls.filter(
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

    it('skips existing skills', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ defaultSkillsPath: 'skills' }));

      ensureDefaultSkills('/project');

      const skillWrites = vi.mocked(fs.writeFileSync).mock.calls.filter(
        (call) => (call[0] as string).includes('SKILL.md'),
      );
      expect(skillWrites).toHaveLength(0);
    });
  });

  describe('resetDefaultSkills', () => {
    it('overwrites all skill files even when they already exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ defaultSkillsPath: 'skills' }));

      resetDefaultSkills('/project');

      const skillWrites = vi.mocked(fs.writeFileSync).mock.calls.filter(
        (call) => (call[0] as string).includes('SKILL.md'),
      );
      expect(skillWrites).toHaveLength(7);
    });

    it('writes latest built-in content when overwriting', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ defaultSkillsPath: 'skills' }));

      resetDefaultSkills('/project');

      const skillWrites = vi.mocked(fs.writeFileSync).mock.calls.filter(
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
