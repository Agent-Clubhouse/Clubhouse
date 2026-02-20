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

import * as fs from 'fs';
import {
  buildWildcardContext,
  materializeAgent,
  previewMaterialization,
  ensureDefaultTemplates,
  enableExclusions,
  disableExclusions,
} from './materialization-service';
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
    headless: true, structuredOutput: true, hooks: true, sessionResume: true, permissions: true,
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
  });

  describe('materializeAgent', () => {
    it('writes instructions with wildcards replaced', () => {
      // Mock readProjectAgentDefaults via readSettings
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
      // First call: readProjectAgentDefaults returns empty
      // Second call: writeProjectAgentDefaults
      let callCount = 0;
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        callCount++;
        if (callCount <= 1) {
          return JSON.stringify({ defaults: {}, quickOverrides: {} });
        }
        // On subsequent reads, return what was written
        throw new Error('ENOENT');
      });
      vi.mocked(fs.existsSync).mockReturnValue(false);

      ensureDefaultTemplates('/project');

      // Should have written settings.json with agent defaults
      const settingsWriteCall = vi.mocked(fs.writeFileSync).mock.calls.find(
        (call) => (call[0] as string).includes('settings.json'),
      );
      expect(settingsWriteCall).toBeDefined();
      const written = JSON.parse(settingsWriteCall![1] as string);
      expect(written.agentDefaults.instructions).toContain('@@AgentName');
      expect(written.agentDefaults.permissions.allow).toContain('Read(@@Path**)');

      // Should have created mission skill
      const skillWriteCall = vi.mocked(fs.writeFileSync).mock.calls.find(
        (call) => (call[0] as string).includes('SKILL.md'),
      );
      expect(skillWriteCall).toBeDefined();
      expect(skillWriteCall![1]).toContain('Mission Skill');
    });

    it('no-ops when defaults already exist', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        defaults: {},
        quickOverrides: {},
        agentDefaults: { instructions: 'existing' },
      }));

      ensureDefaultTemplates('/project');

      // Should not write settings (defaults already exist)
      expect(vi.mocked(fs.writeFileSync).mock.calls.filter(
        (call) => (call[0] as string).includes('settings.json'),
      )).toHaveLength(0);
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
