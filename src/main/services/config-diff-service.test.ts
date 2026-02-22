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
  rmSync: vi.fn(),
}));

vi.mock('./log-service', () => ({
  appLog: vi.fn(),
}));

vi.mock('./clubhouse-mode-settings', () => ({
  getSettings: vi.fn(() => ({ enabled: false })),
}));

vi.mock('./git-exclude-manager', () => ({
  addExclusions: vi.fn(),
  removeExclusions: vi.fn(),
}));

import * as fs from 'fs';
import { computeConfigDiff, propagateChanges } from './config-diff-service';
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

/**
 * Helper to configure fs.readFileSync mock responses based on file path patterns.
 * Each call to readFileSync returns data based on the path argument.
 * Patterns are sorted longest-first to avoid partial matches (e.g. settings.local.json before settings.json).
 * Also configures existsSync to return true for paths matching these patterns.
 */
function mockFileSystem(files: Record<string, string>): void {
  const sortedEntries = Object.entries(files).sort(
    ([a], [b]) => b.length - a.length,
  );
  vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
    const filePath = String(p);
    for (const [pattern, content] of sortedEntries) {
      if (filePath.includes(pattern)) return content;
    }
    throw new Error('ENOENT');
  });
  vi.mocked(fs.existsSync).mockImplementation((p: unknown) => {
    const filePath = String(p);
    for (const [pattern] of sortedEntries) {
      if (filePath.includes(pattern)) return true;
    }
    return false;
  });
}

function agentsJsonWith(agent: DurableAgentConfig): string {
  return JSON.stringify([agent]);
}

function settingsJsonWith(agentDefaults: Record<string, unknown>): string {
  return JSON.stringify({ defaults: {}, quickOverrides: {}, agentDefaults });
}

describe('config-diff-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readdirSync).mockReturnValue([]);
  });

  describe('computeConfigDiff', () => {
    it('returns empty diff when agent matches defaults', () => {
      mockFileSystem({
        'agents.json': agentsJsonWith(testAgent),
        'settings.json': settingsJsonWith({
          instructions: 'Agent @@AgentName at @@Path',
          permissions: { allow: ['Read(@@Path**)'] },
        }),
        'settings.local.json': JSON.stringify({
          permissions: { allow: ['Read(.clubhouse/agents/bold-falcon/**)'] },
        }),
      });
      vi.mocked(mockProvider.readInstructions).mockReturnValue(
        'Agent bold-falcon at .clubhouse/agents/bold-falcon/',
      );

      const result = computeConfigDiff({ projectPath: '/project', agentId: 'test_001', provider: mockProvider });

      expect(result.hasDiffs).toBe(false);
      expect(result.items).toHaveLength(0);
    });

    it('detects added permission rules (allow)', () => {
      mockFileSystem({
        'agents.json': agentsJsonWith(testAgent),
        'settings.json': settingsJsonWith({
          permissions: { allow: ['Read(@@Path**)'] },
        }),
        'settings.local.json': JSON.stringify({
          permissions: { allow: ['Read(.clubhouse/agents/bold-falcon/**)', 'Bash(npm test:*)'] },
        }),
      });
      vi.mocked(mockProvider.readInstructions).mockReturnValue('');

      const result = computeConfigDiff({ projectPath: '/project', agentId: 'test_001', provider: mockProvider });

      expect(result.hasDiffs).toBe(true);
      const addedAllow = result.items.filter(
        (i) => i.category === 'permissions-allow' && i.action === 'added',
      );
      expect(addedAllow).toHaveLength(1);
      expect(addedAllow[0].label).toBe('Bash(npm test:*)');
    });

    it('detects removed permission rules (allow)', () => {
      mockFileSystem({
        'agents.json': agentsJsonWith(testAgent),
        'settings.json': settingsJsonWith({
          permissions: { allow: ['Read(@@Path**)', 'Edit(@@Path**)'] },
        }),
        'settings.local.json': JSON.stringify({
          permissions: { allow: ['Read(.clubhouse/agents/bold-falcon/**)'] },
        }),
      });
      vi.mocked(mockProvider.readInstructions).mockReturnValue('');

      const result = computeConfigDiff({ projectPath: '/project', agentId: 'test_001', provider: mockProvider });

      expect(result.hasDiffs).toBe(true);
      const removed = result.items.filter(
        (i) => i.category === 'permissions-allow' && i.action === 'removed',
      );
      expect(removed).toHaveLength(1);
      expect(removed[0].label).toContain('Edit');
    });

    it('detects added and removed deny rules', () => {
      mockFileSystem({
        'agents.json': agentsJsonWith(testAgent),
        'settings.json': settingsJsonWith({
          permissions: { deny: ['Write(../**)'] },
        }),
        'settings.local.json': JSON.stringify({
          permissions: { deny: ['Read(../**)'] },
        }),
      });
      vi.mocked(mockProvider.readInstructions).mockReturnValue('');

      const result = computeConfigDiff({ projectPath: '/project', agentId: 'test_001', provider: mockProvider });

      expect(result.hasDiffs).toBe(true);
      const addedDeny = result.items.filter(
        (i) => i.category === 'permissions-deny' && i.action === 'added',
      );
      const removedDeny = result.items.filter(
        (i) => i.category === 'permissions-deny' && i.action === 'removed',
      );
      expect(addedDeny).toHaveLength(1);
      expect(removedDeny).toHaveLength(1);
    });

    it('detects modified instructions', () => {
      mockFileSystem({
        'agents.json': agentsJsonWith(testAgent),
        'settings.json': settingsJsonWith({
          instructions: 'Original instructions for @@AgentName',
        }),
      });
      vi.mocked(mockProvider.readInstructions).mockReturnValue(
        'Modified instructions for bold-falcon with extra content',
      );

      const result = computeConfigDiff({ projectPath: '/project', agentId: 'test_001', provider: mockProvider });

      expect(result.hasDiffs).toBe(true);
      const instrItem = result.items.find((i) => i.category === 'instructions');
      expect(instrItem).toBeDefined();
      expect(instrItem!.action).toBe('modified');
      expect(instrItem!.agentValue).toContain('Modified');
      expect(instrItem!.defaultValue).toContain('Original');
    });

    it('detects added MCP servers', () => {
      mockFileSystem({
        'agents.json': agentsJsonWith(testAgent),
        'settings.json': settingsJsonWith({
          mcpJson: '{"mcpServers": {"existing": {"command": "test"}}}',
        }),
        '.mcp.json': JSON.stringify({
          mcpServers: {
            existing: { command: 'test' },
            newServer: { command: 'new-cmd' },
          },
        }),
      });
      vi.mocked(mockProvider.readInstructions).mockReturnValue('');

      const result = computeConfigDiff({ projectPath: '/project', agentId: 'test_001', provider: mockProvider });

      expect(result.hasDiffs).toBe(true);
      const added = result.items.filter((i) => i.category === 'mcp' && i.action === 'added');
      expect(added).toHaveLength(1);
      expect(added[0].label).toContain('newServer');
    });

    it('detects removed MCP servers', () => {
      mockFileSystem({
        'agents.json': agentsJsonWith(testAgent),
        'settings.json': settingsJsonWith({
          mcpJson: '{"mcpServers": {"server1": {"command": "a"}, "server2": {"command": "b"}}}',
        }),
        '.mcp.json': JSON.stringify({
          mcpServers: { server1: { command: 'a' } },
        }),
      });
      vi.mocked(mockProvider.readInstructions).mockReturnValue('');

      const result = computeConfigDiff({ projectPath: '/project', agentId: 'test_001', provider: mockProvider });

      expect(result.hasDiffs).toBe(true);
      const removed = result.items.filter((i) => i.category === 'mcp' && i.action === 'removed');
      expect(removed).toHaveLength(1);
      expect(removed[0].label).toContain('server2');
    });

    it('detects modified MCP servers', () => {
      mockFileSystem({
        'agents.json': agentsJsonWith(testAgent),
        'settings.json': settingsJsonWith({
          mcpJson: '{"mcpServers": {"server1": {"command": "old"}}}',
        }),
        '.mcp.json': JSON.stringify({
          mcpServers: { server1: { command: 'new' } },
        }),
      });
      vi.mocked(mockProvider.readInstructions).mockReturnValue('');

      const result = computeConfigDiff({ projectPath: '/project', agentId: 'test_001', provider: mockProvider });

      expect(result.hasDiffs).toBe(true);
      const modified = result.items.filter((i) => i.category === 'mcp' && i.action === 'modified');
      expect(modified).toHaveLength(1);
    });

    it('skips diff when clubhouseModeOverride is true', () => {
      const overrideAgent = { ...testAgent, clubhouseModeOverride: true };
      mockFileSystem({
        'agents.json': agentsJsonWith(overrideAgent),
        'settings.json': settingsJsonWith({ instructions: 'Different' }),
      });
      vi.mocked(mockProvider.readInstructions).mockReturnValue('Completely different');

      const result = computeConfigDiff({ projectPath: '/project', agentId: 'test_001', provider: mockProvider });

      expect(result.hasDiffs).toBe(false);
      expect(result.items).toHaveLength(0);
    });

    it('returns empty result when no project defaults exist', () => {
      mockFileSystem({
        'agents.json': agentsJsonWith(testAgent),
        'settings.json': JSON.stringify({ defaults: {}, quickOverrides: {} }),
      });
      vi.mocked(mockProvider.readInstructions).mockReturnValue('');

      const result = computeConfigDiff({ projectPath: '/project', agentId: 'test_001', provider: mockProvider });

      expect(result.hasDiffs).toBe(false);
    });

    it('detects added skills', () => {
      mockFileSystem({
        'agents.json': agentsJsonWith(testAgent),
        'settings.json': JSON.stringify({ defaults: {}, quickOverrides: {} }),
      });
      vi.mocked(mockProvider.readInstructions).mockReturnValue('');

      // Override existsSync to handle agents.json + SKILL.md checks
      vi.mocked(fs.existsSync).mockImplementation((p: unknown) => {
        const filePath = String(p);
        return filePath.includes('agents.json') || filePath.includes('README.md');
      });

      // Agent has a skill in its worktree, project has none
      vi.mocked(fs.readdirSync).mockImplementation((p: unknown) => {
        const dirPath = String(p);
        if (dirPath.includes('bold-falcon') && dirPath.includes('skills')) {
          return [{ name: 'custom-skill', isDirectory: () => true, isFile: () => false }] as any;
        }
        return [];
      });

      const result = computeConfigDiff({ projectPath: '/project', agentId: 'test_001', provider: mockProvider });

      const addedSkills = result.items.filter((i) => i.category === 'skills' && i.action === 'added');
      expect(addedSkills).toHaveLength(1);
      expect(addedSkills[0].label).toContain('custom-skill');
    });
  });

  describe('propagateChanges', () => {
    it('correctly merges permission additions', () => {
      mockFileSystem({
        'agents.json': agentsJsonWith(testAgent),
        'settings.json': settingsJsonWith({
          permissions: { allow: ['Read(@@Path**)'] },
        }),
        'settings.local.json': JSON.stringify({
          permissions: { allow: ['Read(.clubhouse/agents/bold-falcon/**)', 'Bash(npm test:*)'] },
        }),
      });
      vi.mocked(mockProvider.readInstructions).mockReturnValue('');

      const result = propagateChanges({
        projectPath: '/project',
        agentId: 'test_001',
        selectedItemIds: ['permissions-allow:added:Bash(npm test:*)'],
        provider: mockProvider,
      });

      expect(result.ok).toBe(true);
      expect(result.propagatedCount).toBe(1);

      // Verify writeFileSync was called with updated settings
      const writeCall = vi.mocked(fs.writeFileSync).mock.calls.find(
        (call) => String(call[0]).includes('settings.json'),
      );
      expect(writeCall).toBeDefined();
      const written = JSON.parse(writeCall![1] as string);
      expect(written.agentDefaults.permissions.allow).toContain('Bash(npm test:*)');
    });

    it('correctly merges permission removals', () => {
      mockFileSystem({
        'agents.json': agentsJsonWith(testAgent),
        'settings.json': settingsJsonWith({
          permissions: { allow: ['Read(@@Path**)', 'Edit(@@Path**)'] },
        }),
        'settings.local.json': JSON.stringify({
          permissions: { allow: ['Read(.clubhouse/agents/bold-falcon/**)'] },
        }),
      });
      vi.mocked(mockProvider.readInstructions).mockReturnValue('');

      const result = propagateChanges({
        projectPath: '/project',
        agentId: 'test_001',
        selectedItemIds: ['permissions-allow:removed:Edit(.clubhouse/agents/bold-falcon/**)'],
        provider: mockProvider,
      });

      expect(result.ok).toBe(true);
      expect(result.propagatedCount).toBe(1);

      const writeCall = vi.mocked(fs.writeFileSync).mock.calls.find(
        (call) => String(call[0]).includes('settings.json'),
      );
      expect(writeCall).toBeDefined();
      const written = JSON.parse(writeCall![1] as string);
      expect(written.agentDefaults.permissions.allow).not.toContain('Edit(@@Path**)');
    });

    it('correctly updates instructions with unreplace', () => {
      mockFileSystem({
        'agents.json': agentsJsonWith(testAgent),
        'settings.json': settingsJsonWith({
          instructions: 'Original @@AgentName',
        }),
      });
      vi.mocked(mockProvider.readInstructions).mockReturnValue(
        'Updated bold-falcon instructions at .clubhouse/agents/bold-falcon/',
      );

      const result = propagateChanges({
        projectPath: '/project',
        agentId: 'test_001',
        selectedItemIds: ['instructions:modified'],
        provider: mockProvider,
      });

      expect(result.ok).toBe(true);
      expect(result.propagatedCount).toBe(1);

      const writeCall = vi.mocked(fs.writeFileSync).mock.calls.find(
        (call) => String(call[0]).includes('settings.json'),
      );
      expect(writeCall).toBeDefined();
      const written = JSON.parse(writeCall![1] as string);
      // Should have unreplaced agent values back to wildcards
      expect(written.agentDefaults.instructions).toContain('@@AgentName');
      expect(written.agentDefaults.instructions).toContain('@@Path');
      expect(written.agentDefaults.instructions).not.toContain('bold-falcon');
    });

    it('returns error when agent not found', () => {
      mockFileSystem({
        'agents.json': JSON.stringify([]),
      });

      const result = propagateChanges({
        projectPath: '/project',
        agentId: 'nonexistent',
        selectedItemIds: [],
        provider: mockProvider,
      });

      expect(result.ok).toBe(false);
      expect(result.message).toContain('not found');
    });
  });
});
