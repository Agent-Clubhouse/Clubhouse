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
  rm: vi.fn(() => Promise.resolve(undefined)),
  unlink: vi.fn(() => Promise.resolve(undefined)),
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
  cleanupStaleJsonInTomlConfigs,
  materializeAgent,
  previewMaterialization,
  ensureDefaultTemplates,
  ensureDefaultSkills,
  writeClubhouseModeReadme,
  refreshClubhouseModeReadme,
  _resetReadmeRefreshTracking,
  resetDefaultSkills,
  resetProjectAgentDefaults,
  resolveMissionId,
  resolvePersonaId,
  resolvePersonaContent,
  resolveAgentCommands,
  listAvailablePersonas,
  getAgentWildcards,
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
  CLUBHOUSE_MODE_README_CONTENT,
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
    vi.mocked(fsp.rm).mockResolvedValue(undefined);
    vi.mocked(fsp.unlink).mockResolvedValue(undefined);
    vi.mocked(pathExists).mockResolvedValue(false);

    // The readme refresh tracker is module-level state — clear it so each test
    // starts with no projects refreshed, regardless of prior test interactions.
    _resetReadmeRefreshTracking();
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

    it('passes through mission content when provided', () => {
      const ctx = buildWildcardContext(testAgent, '/project', undefined, undefined, '# Mission body');
      expect(ctx.mission).toBe('# Mission body');
    });

    it('omits mission when not provided', () => {
      const ctx = buildWildcardContext(testAgent, '/project');
      expect(ctx.mission).toBeUndefined();
    });
  });

  describe('resolveMissionId', () => {
    it('returns per-agent mission when set', () => {
      const agent = { ...testAgent, mission: 'per-agent' };
      expect(resolveMissionId(agent, { mission: 'project-default' })).toBe('per-agent');
    });

    it('falls back to project default when agent mission unset', () => {
      expect(resolveMissionId(testAgent, { mission: 'project-default' })).toBe('project-default');
    });

    it('returns undefined when neither is set', () => {
      expect(resolveMissionId(testAgent, {})).toBeUndefined();
    });

    it('treats empty-string per-agent mission as a deliberate clear (not unset)', () => {
      // agent.mission === '' is unusual but should not fall through to defaults
      // (?? only falls through on null/undefined)
      const agent = { ...testAgent, mission: '' };
      expect(resolveMissionId(agent, { mission: 'project-default' })).toBe('');
    });
  });

  describe('resolvePersonaId', () => {
    it('returns per-agent persona when set', () => {
      const agent = { ...testAgent, persona: 'qa' };
      expect(resolvePersonaId(agent, { persona: 'project-manager' })).toBe('qa');
    });

    it('falls back to project default when agent persona unset', () => {
      expect(resolvePersonaId(testAgent, { persona: 'project-manager' })).toBe('project-manager');
    });

    it('returns undefined when neither is set', () => {
      expect(resolvePersonaId(testAgent, {})).toBeUndefined();
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

    it('honors a per-agent override over project/app settings', async () => {
      mockSettingsFile(JSON.stringify({
        defaults: {},
        quickOverrides: {},
        agentDefaults: { sourceControlProvider: 'github' },
      }));
      const agent = { ...testAgent, sourceControlProvider: 'azure-devops' as const };
      expect(await resolveSourceControlProvider('/project', agent)).toBe('azure-devops');
    });
  });

  describe('resolveAgentCommands', () => {
    it('uses per-agent overrides when set', () => {
      const agent = { ...testAgent, buildCommand: 'make build', testCommand: 'make test', lintCommand: 'make lint' };
      expect(resolveAgentCommands(agent, { buildCommand: 'npm run build' })).toEqual({
        buildCommand: 'make build', testCommand: 'make test', lintCommand: 'make lint',
      });
    });

    it('falls back to project defaults when agent override unset', () => {
      expect(resolveAgentCommands(testAgent, { buildCommand: 'npm run build', testCommand: 'npm test' })).toEqual({
        buildCommand: 'npm run build', testCommand: 'npm test', lintCommand: undefined,
      });
    });
  });

  describe('resolvePersonaContent', () => {
    it('returns undefined for an empty persona id', async () => {
      expect(await resolvePersonaContent('/project', undefined)).toBeUndefined();
    });

    it('prefers the project on-disk persona file when present', async () => {
      vi.mocked(fsp.readFile).mockImplementation(async (p: unknown) => {
        const fp = String(p).replace(/\\/g, '/');
        if (fp.startsWith('/project') && fp.endsWith('.clubhouse/personas/qa.md')) return 'PROJECT QA PERSONA';
        throw new Error('ENOENT');
      });
      expect(await resolvePersonaContent('/project', 'qa')).toBe('PROJECT QA PERSONA');
    });

    it('falls back to the user-global persona when no project file exists', async () => {
      vi.mocked(fsp.readFile).mockImplementation(async (p: unknown) => {
        const fp = String(p).replace(/\\/g, '/');
        // Project layer (under /project) misses; user-global layer (under home) hits.
        if (!fp.startsWith('/project') && fp.endsWith('.clubhouse/personas/qa.md')) return 'USER QA PERSONA';
        throw new Error('ENOENT');
      });
      expect(await resolvePersonaContent('/project', 'qa')).toBe('USER QA PERSONA');
    });

    it('project layer wins over user-global layer for the same id', async () => {
      vi.mocked(fsp.readFile).mockImplementation(async (p: unknown) => {
        const fp = String(p).replace(/\\/g, '/');
        if (!fp.endsWith('.clubhouse/personas/qa.md')) throw new Error('ENOENT');
        return fp.startsWith('/project') ? 'PROJECT QA PERSONA' : 'USER QA PERSONA';
      });
      expect(await resolvePersonaContent('/project', 'qa')).toBe('PROJECT QA PERSONA');
    });

    it('falls back to the built-in template when no disk file exists', async () => {
      vi.mocked(fsp.readFile).mockRejectedValue(new Error('ENOENT'));
      const content = await resolvePersonaContent('/project', 'qa');
      expect(content).toContain('Quality Assurance');
    });

    it('returns undefined for an unknown persona with no disk file', async () => {
      vi.mocked(fsp.readFile).mockRejectedValue(new Error('ENOENT'));
      expect(await resolvePersonaContent('/project', 'nonexistent')).toBeUndefined();
    });
  });

  describe('listAvailablePersonas', () => {
    it('returns the built-in templates when no disk personas exist', async () => {
      vi.mocked(fsp.readdir).mockResolvedValue([]);
      const personas = await listAvailablePersonas('/project');
      expect(personas.length).toBeGreaterThan(0);
      expect(personas.every((p) => p.source === 'builtin')).toBe(true);
      expect(personas.map((p) => p.id)).toContain('qa');
    });

    it('tags a user-global persona and lets a project persona shadow it', async () => {
      vi.mocked(fsp.readdir).mockImplementation(async (p: unknown) => {
        const fp = String(p).replace(/\\/g, '/');
        if (!fp.endsWith('.clubhouse/personas')) return [] as any;
        if (fp.startsWith('/project')) {
          // Project layer defines only "qa" (shadows built-in + user)
          return [{ name: 'qa.md', isFile: () => true, isDirectory: () => false }] as any;
        }
        // User-global layer defines "qa" and a brand-new "my-reviewer"
        return [
          { name: 'qa.md', isFile: () => true, isDirectory: () => false },
          { name: 'my-reviewer.md', isFile: () => true, isDirectory: () => false },
        ] as any;
      });
      const personas = await listAvailablePersonas('/project');
      const qa = personas.filter((p) => p.id === 'qa');
      expect(qa).toHaveLength(1);
      expect(qa[0].source).toBe('project'); // project layer wins the source tag
      const reviewer = personas.find((p) => p.id === 'my-reviewer');
      expect(reviewer?.source).toBe('user'); // only in user-global layer
    });
  });

  describe('getAgentWildcards', () => {
    it('builds resolved actuals, overrides, and library lists for an agent', async () => {
      mockSettingsFile(JSON.stringify({
        defaults: {},
        quickOverrides: {},
        agentDefaults: { buildCommand: 'npm run build', mission: 'project-mission', persona: 'qa' },
      }));
      const agent = { ...testAgent, testCommand: 'make test', mission: 'agent-mission' };

      const w = await getAgentWildcards('/project', agent);

      // Identity actuals
      expect(w.agentName).toBe('bold-falcon');
      expect(w.standbyBranch).toBe('bold-falcon/standby');
      expect(w.agentPath).toBe('.clubhouse/agents/bold-falcon/');
      // Commands: override wins, else project default, else built-in fallback
      expect(w.buildCommand).toEqual({ override: null, resolved: 'npm run build' });
      expect(w.testCommand).toEqual({ override: 'make test', resolved: 'make test' });
      expect(w.lintCommand).toEqual({ override: null, resolved: 'npm run lint' });
      // Mission: per-agent override wins for resolved; project default surfaced
      expect(w.mission).toEqual({ override: 'agent-mission', projectDefault: 'project-mission', resolved: 'agent-mission' });
      // Persona: inherits project default
      expect(w.persona).toEqual({ override: null, projectDefault: 'qa', resolved: 'qa' });
      // Library lists present
      expect(Array.isArray(w.missions)).toBe(true);
      expect(w.personas.map((p) => p.id)).toContain('qa');
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

    it('refreshes the self-edit guide even when no other materialization work runs', async () => {
      // No defaults, no persona, no mission, no source dirs — early-out path.
      mockSettingsFile(JSON.stringify({
        defaults: {},
        quickOverrides: {},
      }));

      await materializeAgent({ projectPath: '/project', agent: testAgent, provider: mockProvider });

      // The readme write should still happen because the refresh runs before the early-out.
      const readmeWrites = vi.mocked(fsp.writeFile).mock.calls.filter(
        (call) => (call[0] as string).endsWith('clubhouse-mode.md'),
      );
      expect(readmeWrites).toHaveLength(1);
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

    it('prunes stale skills from worktree that are not in source', async () => {
      // readdir needs to distinguish between:
      // 1. Source skills dir (.clubhouse/skills) — lists source skill dirs
      // 2. Inside a source skill dir — lists files (for copyDirRecursive)
      // 3. Worktree skills dir (.claude/skills) — lists worktree skill dirs (for pruning)
      vi.mocked(fsp.readdir).mockImplementation(async (p: unknown, _opts?: unknown) => {
        const dirPath = String(p).replace(/\\/g, '/');
        // Source skills listing
        if (dirPath.endsWith('.clubhouse/skills')) {
          return [{ name: 'mission', isDirectory: () => true }] as any;
        }
        // Inside the source 'mission' skill dir — return a file
        if (dirPath.includes('.clubhouse/skills/mission')) {
          return [{ name: 'SKILL.md', isDirectory: () => false }] as any;
        }
        // Worktree skills listing (for pruning)
        if (dirPath.endsWith('.claude/skills')) {
          return [
            { name: 'mission', isDirectory: () => true },
            { name: 'stale-skill', isDirectory: () => true },
          ] as any;
        }
        return [];
      });
      vi.mocked(fsp.readFile).mockImplementation(async (p: unknown) => {
        const filePath = String(p);
        if (filePath.includes('settings.json')) {
          return JSON.stringify({
            defaults: {},
            quickOverrides: {},
            agentDefaults: { instructions: 'test' },
            defaultSkillsPath: 'skills',
          });
        }
        if (filePath.includes('SKILL.md')) return '# Mission';
        throw new Error('ENOENT');
      });

      await materializeAgent({ projectPath: '/project', agent: testAgent, provider: mockProvider });

      // Should have removed the stale skill directory
      const rmCalls = vi.mocked(fsp.rm).mock.calls;
      const staleRm = rmCalls.find((call) =>
        (call[0] as string).includes('stale-skill'),
      );
      expect(staleRm).toBeDefined();
    });

    it('does not prune skills that exist in source', async () => {
      vi.mocked(fsp.readdir).mockImplementation(async (p: unknown, _opts?: unknown) => {
        const dirPath = String(p).replace(/\\/g, '/');
        if (dirPath.endsWith('.clubhouse/skills')) {
          return [{ name: 'mission', isDirectory: () => true }] as any;
        }
        if (dirPath.includes('.clubhouse/skills/mission')) {
          return [{ name: 'SKILL.md', isDirectory: () => false }] as any;
        }
        if (dirPath.endsWith('.claude/skills')) {
          return [{ name: 'mission', isDirectory: () => true }] as any;
        }
        return [];
      });
      vi.mocked(fsp.readFile).mockImplementation(async (p: unknown) => {
        const filePath = String(p);
        if (filePath.includes('settings.json')) {
          return JSON.stringify({
            defaults: {},
            quickOverrides: {},
            agentDefaults: { instructions: 'test' },
            defaultSkillsPath: 'skills',
          });
        }
        if (filePath.includes('SKILL.md')) return '# Mission';
        throw new Error('ENOENT');
      });

      await materializeAgent({ projectPath: '/project', agent: testAgent, provider: mockProvider });

      // Should NOT have removed any skill directories (only copied)
      const rmCalls = vi.mocked(fsp.rm).mock.calls;
      const skillRm = rmCalls.find((call) =>
        (call[0] as string).includes('skills/mission'),
      );
      expect(skillRm).toBeUndefined();
    });

    it('writes TOML MCP config for TOML settings format', async () => {
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
          mcpJson: '{"mcpServers": {"test": {"command": "node", "args": ["/test.js"]}}}',
          permissions: { allow: ['shell(git:*)'] },
        },
      }));

      await materializeAgent({ projectPath: '/project', agent: testAgent, provider: tomlProvider });

      // Instructions should still be written via the provider
      expect(tomlProvider.writeInstructions).toHaveBeenCalled();

      // MCP config should be written as TOML to config.toml
      const fspWrites = vi.mocked(fsp.writeFile).mock.calls;
      const tomlFspWrites = fspWrites.filter((c) => String(c[0]).includes('config.toml'));
      expect(tomlFspWrites.length).toBeGreaterThan(0);
      const tomlContent = String(tomlFspWrites[0][1]);
      expect(tomlContent).toContain('[mcp_servers.test]');
      expect(tomlContent).toContain('command = "node"');
    });
    it('appends persona instructions after project defaults', async () => {
      const agentWithPersona = { ...testAgent, persona: 'qa' };
      mockSettingsFile(JSON.stringify({
        defaults: {},
        quickOverrides: {},
        agentDefaults: {
          instructions: 'Agent @@AgentName at @@Path',
        },
      }));

      await materializeAgent({ projectPath: '/project', agent: agentWithPersona, provider: mockProvider });

      expect(mockProvider.writeInstructions).toHaveBeenCalledTimes(1);
      const written = vi.mocked(mockProvider.writeInstructions).mock.calls[0][1] as string;
      // Should contain both project defaults (with wildcards resolved) and persona content
      expect(written).toContain('Agent bold-falcon at .clubhouse/agents/bold-falcon/');
      expect(written).toContain('Quality Assurance');
    });

    it('writes only persona instructions when no project defaults exist', async () => {
      const agentWithPersona = { ...testAgent, persona: 'project-manager' };
      mockSettingsFile(JSON.stringify({
        defaults: {},
        quickOverrides: {},
      }));

      await materializeAgent({ projectPath: '/project', agent: agentWithPersona, provider: mockProvider });

      expect(mockProvider.writeInstructions).toHaveBeenCalledTimes(1);
      const written = vi.mocked(mockProvider.writeInstructions).mock.calls[0][1] as string;
      expect(written).toContain('Project Manager');
      expect(written).toContain('delegator');
    });

    it('skips persona injection for unknown persona ID', async () => {
      const agentWithBadPersona = { ...testAgent, persona: 'nonexistent' };
      mockSettingsFile(JSON.stringify({
        defaults: {},
        quickOverrides: {},
        agentDefaults: {
          instructions: 'Agent @@AgentName',
        },
      }));

      await materializeAgent({ projectPath: '/project', agent: agentWithBadPersona, provider: mockProvider });

      // Should still write project defaults, just without persona content
      expect(mockProvider.writeInstructions).toHaveBeenCalledTimes(1);
      const written = vi.mocked(mockProvider.writeInstructions).mock.calls[0][1] as string;
      expect(written).toContain('Agent bold-falcon');
      expect(written).not.toContain('Quality Assurance');
    });

    it('does not write persona instructions when agent has no persona', async () => {
      mockSettingsFile(JSON.stringify({
        defaults: {},
        quickOverrides: {},
      }));

      await materializeAgent({ projectPath: '/project', agent: testAgent, provider: mockProvider });

      expect(mockProvider.writeInstructions).not.toHaveBeenCalled();
    });

    it('substitutes @@Persona inline and skips the auto-append (no double-injection)', async () => {
      const agentWithPersona = { ...testAgent, persona: 'qa' };
      mockSettingsFile(JSON.stringify({
        defaults: {},
        quickOverrides: {},
        agentDefaults: {
          instructions: 'Agent @@AgentName\n\n## Role\n@@Persona\n\n## Done',
        },
      }));

      await materializeAgent({ projectPath: '/project', agent: agentWithPersona, provider: mockProvider });

      expect(mockProvider.writeInstructions).toHaveBeenCalledTimes(1);
      const written = vi.mocked(mockProvider.writeInstructions).mock.calls[0][1] as string;
      // Persona content appears after the ## Role section header (inline substitution)...
      const personaMarker = written.indexOf('Quality Assurance');
      const roleMarker = written.indexOf('## Role');
      const doneMarker = written.lastIndexOf('## Done');
      expect(personaMarker).toBeGreaterThan(roleMarker);
      // ...and before the ## Done section, proving no auto-append happens after it.
      expect(personaMarker).toBeLessThan(doneMarker);
      // The trailing ## Done section is preserved at the end.
      expect(written.endsWith('## Done')).toBe(true);
      // Persona body should appear exactly once — no double injection.
      expect(written.match(/Quality Assurance/g)?.length).toBe(1);
    });

    it('still auto-appends persona when @@Persona is NOT in the template (backwards compat)', async () => {
      const agentWithPersona = { ...testAgent, persona: 'qa' };
      mockSettingsFile(JSON.stringify({
        defaults: {},
        quickOverrides: {},
        agentDefaults: {
          // No @@Persona token — preserve the pre-feature behavior.
          instructions: 'Agent @@AgentName at @@Path',
        },
      }));

      await materializeAgent({ projectPath: '/project', agent: agentWithPersona, provider: mockProvider });

      const written = vi.mocked(mockProvider.writeInstructions).mock.calls[0][1] as string;
      expect(written.startsWith('Agent bold-falcon at .clubhouse/agents/bold-falcon/')).toBe(true);
      expect(written).toContain('Quality Assurance'); // appended at the end
    });

    it('applies project-default persona when the agent has none of its own', async () => {
      // Agent with NO persona; project default sets qa.
      mockSettingsFile(JSON.stringify({
        defaults: {},
        quickOverrides: {},
        agentDefaults: {
          instructions: 'Agent @@AgentName',
          persona: 'qa',
        },
      }));

      await materializeAgent({ projectPath: '/project', agent: testAgent, provider: mockProvider });

      const written = vi.mocked(mockProvider.writeInstructions).mock.calls[0][1] as string;
      expect(written).toContain('Agent bold-falcon');
      expect(written).toContain('Quality Assurance');
    });

    it('per-agent persona overrides project-default persona', async () => {
      const agentWithPersona = { ...testAgent, persona: 'project-manager' };
      mockSettingsFile(JSON.stringify({
        defaults: {},
        quickOverrides: {},
        agentDefaults: {
          instructions: 'Agent @@AgentName',
          persona: 'qa', // project default — should be overridden
        },
      }));

      await materializeAgent({ projectPath: '/project', agent: agentWithPersona, provider: mockProvider });

      const written = vi.mocked(mockProvider.writeInstructions).mock.calls[0][1] as string;
      expect(written).toContain('Project Manager');
      expect(written).not.toContain('Quality Assurance');
    });

    it('substitutes @@Mission with project default mission file content', async () => {
      vi.mocked(fsp.readFile).mockImplementation(async (p: unknown) => {
        const fp = String(p).replace(/\\/g, '/');
        if (fp.includes('settings.json')) {
          return JSON.stringify({
            defaults: {},
            quickOverrides: {},
            agentDefaults: {
              instructions: 'Agent @@AgentName\n\n@@Mission',
              mission: 'do-the-thing',
            },
          });
        }
        if (fp.endsWith('missions/do-the-thing.md')) return '# Mission body content';
        throw new Error('ENOENT');
      });

      await materializeAgent({ projectPath: '/project', agent: testAgent, provider: mockProvider });

      const written = vi.mocked(mockProvider.writeInstructions).mock.calls[0][1] as string;
      expect(written).toContain('Agent bold-falcon');
      expect(written).toContain('# Mission body content');
    });

    it('per-agent mission overrides project default mission', async () => {
      const agentWithMission = { ...testAgent, mission: 'agent-override' };
      vi.mocked(fsp.readFile).mockImplementation(async (p: unknown) => {
        const fp = String(p).replace(/\\/g, '/');
        if (fp.includes('settings.json')) {
          return JSON.stringify({
            defaults: {},
            quickOverrides: {},
            agentDefaults: {
              instructions: '@@Mission',
              mission: 'project-default',
            },
          });
        }
        if (fp.endsWith('missions/agent-override.md')) return 'AGENT BODY';
        if (fp.endsWith('missions/project-default.md')) return 'PROJECT BODY';
        throw new Error('ENOENT');
      });

      await materializeAgent({ projectPath: '/project', agent: agentWithMission, provider: mockProvider });

      const written = vi.mocked(mockProvider.writeInstructions).mock.calls[0][1] as string;
      expect(written).toBe('AGENT BODY');
    });

    it('resolves @@Mission to empty when mission file is missing', async () => {
      vi.mocked(fsp.readFile).mockImplementation(async (p: unknown) => {
        const fp = String(p).replace(/\\/g, '/');
        if (fp.includes('settings.json')) {
          return JSON.stringify({
            defaults: {},
            quickOverrides: {},
            agentDefaults: {
              instructions: 'Mission:\n@@Mission\nEnd.',
              mission: 'missing-file',
            },
          });
        }
        throw new Error('ENOENT'); // mission file does not exist
      });

      await materializeAgent({ projectPath: '/project', agent: testAgent, provider: mockProvider });

      const written = vi.mocked(mockProvider.writeInstructions).mock.calls[0][1] as string;
      expect(written).toBe('Mission:\n\nEnd.');
    });

    it('does not attempt to read mission file when neither agent nor defaults set mission', async () => {
      mockSettingsFile(JSON.stringify({
        defaults: {},
        quickOverrides: {},
        agentDefaults: { instructions: 'No mission here' },
      }));

      await materializeAgent({ projectPath: '/project', agent: testAgent, provider: mockProvider });

      // No fsp.readFile calls should target .clubhouse/missions/
      const missionReads = vi.mocked(fsp.readFile).mock.calls.filter(
        (call) => String(call[0]).replace(/\\/g, '/').includes('/missions/'),
      );
      expect(missionReads).toHaveLength(0);
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

    it('includes persona instructions in preview', async () => {
      const agentWithPersona = { ...testAgent, persona: 'quality-auditor' };
      mockSettingsFile(JSON.stringify({
        defaults: {},
        quickOverrides: {},
        agentDefaults: {
          instructions: 'Agent @@AgentName',
        },
      }));

      const preview = await previewMaterialization({
        projectPath: '/project',
        agent: agentWithPersona,
        provider: mockProvider,
      });

      expect(preview.instructions).toContain('Agent bold-falcon');
      expect(preview.instructions).toContain('Quality Auditor');
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

    it('writes clubhouse-mode.md self-edit guide when missing', async () => {
      mockSettingsFile(JSON.stringify({ defaults: {}, quickOverrides: {} }));

      await ensureDefaultTemplates('/project');

      const readmeWrite = vi.mocked(fsp.writeFile).mock.calls.find(
        (call) => (call[0] as string).endsWith('clubhouse-mode.md'),
      );
      expect(readmeWrite).toBeDefined();
      expect(readmeWrite![1]).toBe(CLUBHOUSE_MODE_README_CONTENT);
    });
  });

  describe('CLUBHOUSE_MODE_README_CONTENT', () => {
    it('documents the personas surface and per-agent command/provider overrides', () => {
      expect(CLUBHOUSE_MODE_README_CONTENT).toContain('.clubhouse/personas/');
      expect(CLUBHOUSE_MODE_README_CONTENT).toContain('@@Persona');
      expect(CLUBHOUSE_MODE_README_CONTENT).toContain('buildCommand');
      expect(CLUBHOUSE_MODE_README_CONTENT).toContain('testCommand');
      expect(CLUBHOUSE_MODE_README_CONTENT).toContain('lintCommand');
      expect(CLUBHOUSE_MODE_README_CONTENT).toContain('sourceControlProvider');
    });

    it('documents the user-global persona library and precedence', () => {
      expect(CLUBHOUSE_MODE_README_CONTENT).toContain('~/.clubhouse/personas/');
      expect(CLUBHOUSE_MODE_README_CONTENT).toContain('user-global → built-in');
    });
  });

  describe('writeClubhouseModeReadme', () => {
    it('writes the readme at .clubhouse/clubhouse-mode.md', async () => {
      await writeClubhouseModeReadme('/project');

      const readmeWrite = vi.mocked(fsp.writeFile).mock.calls.find(
        (call) => (call[0] as string).endsWith('clubhouse-mode.md'),
      );
      expect(readmeWrite).toBeDefined();
      expect((readmeWrite![0] as string).replace(/\\/g, '/')).toBe('/project/.clubhouse/clubhouse-mode.md');
      expect(readmeWrite![1]).toBe(CLUBHOUSE_MODE_README_CONTENT);
    });

    it('overwrites unconditionally (does not check existence)', async () => {
      // Even when pathExists returns true (file present), the write should still happen.
      vi.mocked(pathExists).mockResolvedValue(true);

      await writeClubhouseModeReadme('/project');

      const readmeWrites = vi.mocked(fsp.writeFile).mock.calls.filter(
        (call) => (call[0] as string).endsWith('clubhouse-mode.md'),
      );
      expect(readmeWrites).toHaveLength(1);
    });
  });

  describe('refreshClubhouseModeReadme', () => {
    beforeEach(() => {
      _resetReadmeRefreshTracking();
    });

    it('writes on first call for a project', async () => {
      await refreshClubhouseModeReadme('/project');

      const readmeWrites = vi.mocked(fsp.writeFile).mock.calls.filter(
        (call) => (call[0] as string).endsWith('clubhouse-mode.md'),
      );
      expect(readmeWrites).toHaveLength(1);
    });

    it('deduplicates within a session — second call is a no-op', async () => {
      await refreshClubhouseModeReadme('/project');
      await refreshClubhouseModeReadme('/project');
      await refreshClubhouseModeReadme('/project');

      const readmeWrites = vi.mocked(fsp.writeFile).mock.calls.filter(
        (call) => (call[0] as string).endsWith('clubhouse-mode.md'),
      );
      expect(readmeWrites).toHaveLength(1);
    });

    it('tracks projects independently', async () => {
      await refreshClubhouseModeReadme('/project-a');
      await refreshClubhouseModeReadme('/project-b');
      await refreshClubhouseModeReadme('/project-a'); // already refreshed
      await refreshClubhouseModeReadme('/project-b'); // already refreshed

      const writePaths = vi.mocked(fsp.writeFile).mock.calls
        .map((call) => (call[0] as string).replace(/\\/g, '/'))
        .filter((p) => p.endsWith('clubhouse-mode.md'))
        .sort();
      expect(writePaths).toEqual([
        '/project-a/.clubhouse/clubhouse-mode.md',
        '/project-b/.clubhouse/clubhouse-mode.md',
      ]);
    });

    it('_resetReadmeRefreshTracking allows re-refresh of a previously refreshed project', async () => {
      await refreshClubhouseModeReadme('/project');
      _resetReadmeRefreshTracking();
      await refreshClubhouseModeReadme('/project');

      const readmeWrites = vi.mocked(fsp.writeFile).mock.calls.filter(
        (call) => (call[0] as string).endsWith('clubhouse-mode.md'),
      );
      expect(readmeWrites).toHaveLength(2);
    });

    it('readme content documents all settings layers', () => {
      // Sanity check: the guide actually mentions the load-bearing files
      expect(CLUBHOUSE_MODE_README_CONTENT).toContain('.clubhouse/settings.json');
      expect(CLUBHOUSE_MODE_README_CONTENT).toContain('.clubhouse/agents.json');
      expect(CLUBHOUSE_MODE_README_CONTENT).toContain('clubhouse-mode-settings.json');
      expect(CLUBHOUSE_MODE_README_CONTENT).toContain('.clubhouse/skills/');
      expect(CLUBHOUSE_MODE_README_CONTENT).toContain('.clubhouse/missions/');
      expect(CLUBHOUSE_MODE_README_CONTENT).toContain('@@Mission');
      expect(CLUBHOUSE_MODE_README_CONTENT).toContain('clubhouseModeOverride');
    });
  });

  describe('getDefaultAgentTemplates', () => {
    it('returns instructions containing wildcards', () => {
      const templates = getDefaultAgentTemplates();
      expect(templates.instructions).toContain('@@AgentName');
      expect(templates.instructions).toContain('@@StandbyBranch');
      expect(templates.instructions).toContain('@@Path');
    });

    it('does NOT include @@Mission or @@Persona in the default body (opt-in tokens)', () => {
      const templates = getDefaultAgentTemplates();
      expect(templates.instructions).not.toContain('@@Mission');
      expect(templates.instructions).not.toContain('@@Persona');
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

  describe('cleanupStaleJsonInTomlConfigs', () => {
    const tomlConventions = {
      configDir: '.codex',
      mcpConfigFile: '.codex/config.toml',
      localSettingsFile: 'config.toml',
      settingsFormat: 'toml' as const,
      skillsDir: 'skills',
      agentTemplatesDir: 'agents',
    };

    beforeEach(() => {
      vi.mocked(fsp.readFile).mockReset();
      vi.mocked(fsp.unlink).mockReset();
      vi.mocked(fsp.unlink).mockResolvedValue(undefined);
    });

    it('removes file that starts with { (JSON object)', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('{"mcpServers": {}}');

      await cleanupStaleJsonInTomlConfigs('/worktree', tomlConventions);

      expect(fsp.unlink).toHaveBeenCalled();
    });

    it('does not remove file that starts with [ (could be TOML section header)', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('[{"test": true}]');

      await cleanupStaleJsonInTomlConfigs('/worktree', tomlConventions);

      // '[' could be a TOML section header like [mcpServers], so we don't remove it
      expect(fsp.unlink).not.toHaveBeenCalled();
    });

    it('removes file with leading whitespace before JSON', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('  \n  {"mcpServers": {}}');

      await cleanupStaleJsonInTomlConfigs('/worktree', tomlConventions);

      expect(fsp.unlink).toHaveBeenCalled();
    });

    it('does not remove valid TOML content', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('[mcpServers]\nfoo = "bar"');

      await cleanupStaleJsonInTomlConfigs('/worktree', tomlConventions);

      expect(fsp.unlink).not.toHaveBeenCalled();
    });

    it('does nothing when file does not exist', async () => {
      vi.mocked(fsp.readFile).mockRejectedValue(new Error('ENOENT'));

      await cleanupStaleJsonInTomlConfigs('/worktree', tomlConventions);

      expect(fsp.unlink).not.toHaveBeenCalled();
    });

    it('deduplicates paths when mcpConfigFile and configDir/localSettingsFile resolve to same path', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('{"stale": true}');

      await cleanupStaleJsonInTomlConfigs('/worktree', tomlConventions);

      // .codex/config.toml and .codex/config.toml are the same — should only unlink once
      expect(fsp.unlink).toHaveBeenCalledTimes(1);
    });
  });
});
