import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock config-pipeline
const mockSnapshotFile = vi.fn();
const mockRestoreForAgent = vi.fn();
const mockGetHooksConfigPath = vi.fn(() => '/project/.claude/settings.local.json');
vi.mock('./config-pipeline', () => ({
  snapshotFile: (...args: unknown[]) => mockSnapshotFile(...args),
  restoreForAgent: (...args: unknown[]) => mockRestoreForAgent(...args),
  getHooksConfigPath: (...args: unknown[]) => mockGetHooksConfigPath(...args),
  restoreAll: vi.fn(),
}));

// Mock pty-manager
const mockPtySpawn = vi.fn();
const mockPtyGracefulKill = vi.fn();
vi.mock('./pty-manager', () => ({
  spawn: (...args: unknown[]) => mockPtySpawn(...args),
  gracefulKill: (...args: unknown[]) => mockPtyGracefulKill(...args),
}));

// Mock hook-server
vi.mock('./hook-server', () => ({
  waitReady: vi.fn(() => Promise.resolve(12345)),
}));

// Mock fs for readProjectOrchestrator
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

// Mock the orchestrator registry
const mockProvider = {
  id: 'claude-code',
  displayName: 'Claude Code',
  checkAvailability: vi.fn(() => Promise.resolve({ available: true })),
  buildSpawnCommand: vi.fn(() => Promise.resolve({ binary: '/usr/local/bin/claude', args: ['--model', 'opus'] })),
  getExitCommand: vi.fn(() => '/exit\r'),
  writeHooksConfig: vi.fn(() => Promise.resolve()),
  parseHookEvent: vi.fn(),
  readInstructions: vi.fn(() => ''),
  writeInstructions: vi.fn(),
  conventions: {} as any,
  getModelOptions: vi.fn(() => []),
  getDefaultPermissions: vi.fn((kind: string) => kind === 'quick' ? ['Read', 'Write'] : []),
  toolVerb: vi.fn(),
  buildSummaryInstruction: vi.fn(() => ''),
  readQuickSummary: vi.fn(() => Promise.resolve(null)),
  getCapabilities: vi.fn(() => ({
    headless: true, structuredOutput: true, hooks: true,
    sessionResume: true, permissions: true,
  })),
};

const mockAltProvider = {
  ...mockProvider,
  id: 'opencode',
  displayName: 'OpenCode',
  getExitCommand: vi.fn(() => '/quit\r'),
};

vi.mock('../orchestrators', () => ({
  getProvider: vi.fn((id: string) => {
    if (id === 'claude-code') return mockProvider;
    if (id === 'opencode') return mockAltProvider;
    return undefined;
  }),
  getAllProviders: vi.fn(() => [mockProvider, mockAltProvider]),
}));

import {
  resolveOrchestrator,
  spawnAgent,
  killAgent,
  checkAvailability,
  getAvailableOrchestrators,
  getAgentProjectPath,
  getAgentOrchestrator,
  getAgentNonce,
  untrackAgent,
} from './agent-system';
import * as fs from 'fs';

describe('agent-system', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Clean up tracked agents
    untrackAgent('test-agent');
    untrackAgent('agent-1');
  });

  describe('resolveOrchestrator', () => {
    it('uses agent-level override when provided', () => {
      const provider = resolveOrchestrator('/project', 'opencode');
      expect(provider.id).toBe('opencode');
    });

    it('falls back to project-level setting', () => {
      vi.mocked(fs.readFileSync).mockReturnValueOnce(
        JSON.stringify({ orchestrator: 'opencode' })
      );
      const provider = resolveOrchestrator('/project');
      expect(provider.id).toBe('opencode');
    });

    it('falls back to default (claude-code)', () => {
      const provider = resolveOrchestrator('/project');
      expect(provider.id).toBe('claude-code');
    });

    it('throws for unknown orchestrator', () => {
      expect(() => resolveOrchestrator('/project', 'nonexistent'))
        .toThrowError('Unknown orchestrator: nonexistent');
    });

    it('agent override takes priority over project setting', () => {
      vi.mocked(fs.readFileSync).mockReturnValueOnce(
        JSON.stringify({ orchestrator: 'opencode' })
      );
      const provider = resolveOrchestrator('/project', 'claude-code');
      expect(provider.id).toBe('claude-code');
    });
  });

  describe('spawnAgent', () => {
    it('tracks agent project path', async () => {
      await spawnAgent({
        agentId: 'agent-1',
        projectPath: '/my/project',
        cwd: '/my/project',
        kind: 'durable',
      });
      expect(getAgentProjectPath('agent-1')).toBe('/my/project');
    });

    it('tracks agent orchestrator when specified', async () => {
      await spawnAgent({
        agentId: 'agent-1',
        projectPath: '/my/project',
        cwd: '/my/project',
        kind: 'durable',
        orchestrator: 'opencode',
      });
      expect(getAgentOrchestrator('agent-1')).toBe('opencode');
    });

    it('does not track orchestrator when not specified', async () => {
      await spawnAgent({
        agentId: 'agent-1',
        projectPath: '/my/project',
        cwd: '/my/project',
        kind: 'durable',
      });
      expect(getAgentOrchestrator('agent-1')).toBeUndefined();
    });

    it('writes hooks config with base URL (no agentId)', async () => {
      await spawnAgent({
        agentId: 'agent-1',
        projectPath: '/project',
        cwd: '/project',
        kind: 'durable',
      });
      expect(mockProvider.writeHooksConfig).toHaveBeenCalledWith(
        '/project',
        'http://127.0.0.1:12345/hook'
      );
    });

    it('generates and tracks a nonce per spawn', async () => {
      await spawnAgent({
        agentId: 'agent-1',
        projectPath: '/project',
        cwd: '/project',
        kind: 'durable',
      });
      const nonce = getAgentNonce('agent-1');
      expect(nonce).toBeDefined();
      expect(typeof nonce).toBe('string');
      expect(nonce!.length).toBeGreaterThan(0);
    });

    it('passes CLUBHOUSE_AGENT_ID and CLUBHOUSE_HOOK_NONCE env vars to pty', async () => {
      await spawnAgent({
        agentId: 'agent-1',
        projectPath: '/project',
        cwd: '/project/worktree',
        kind: 'durable',
      });
      const nonce = getAgentNonce('agent-1');
      expect(mockPtySpawn).toHaveBeenCalledWith(
        'agent-1',
        '/project/worktree',
        '/usr/local/bin/claude',
        ['--model', 'opus'],
        expect.objectContaining({
          CLUBHOUSE_AGENT_ID: 'agent-1',
          CLUBHOUSE_HOOK_NONCE: nonce,
        }),
        expect.any(Function),
      );
    });

    it('uses quick default permissions when kind is quick and no allowedTools', async () => {
      await spawnAgent({
        agentId: 'agent-1',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
      });
      expect(mockProvider.getDefaultPermissions).toHaveBeenCalledWith('quick');
    });

    it('uses provided allowedTools over defaults', async () => {
      await spawnAgent({
        agentId: 'agent-1',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        allowedTools: ['Bash(git:*)'],
      });
      expect(mockProvider.buildSpawnCommand).toHaveBeenCalledWith(
        expect.objectContaining({ allowedTools: ['Bash(git:*)'] })
      );
    });
  });

  describe('killAgent', () => {
    it('calls gracefulKill with provider exit command', async () => {
      await killAgent('agent-1', '/project');
      expect(mockPtyGracefulKill).toHaveBeenCalledWith('agent-1', '/exit\r');
    });

    it('uses orchestrator-specific exit command', async () => {
      await killAgent('agent-1', '/project', 'opencode');
      expect(mockPtyGracefulKill).toHaveBeenCalledWith('agent-1', '/quit\r');
    });
  });

  describe('untrackAgent', () => {
    it('removes agent from all maps including nonce', async () => {
      await spawnAgent({
        agentId: 'agent-1',
        projectPath: '/project',
        cwd: '/project',
        kind: 'durable',
        orchestrator: 'opencode',
      });
      expect(getAgentProjectPath('agent-1')).toBe('/project');
      expect(getAgentOrchestrator('agent-1')).toBe('opencode');
      expect(getAgentNonce('agent-1')).toBeDefined();

      untrackAgent('agent-1');
      expect(getAgentProjectPath('agent-1')).toBeUndefined();
      expect(getAgentOrchestrator('agent-1')).toBeUndefined();
      expect(getAgentNonce('agent-1')).toBeUndefined();
    });
  });

  describe('checkAvailability', () => {
    it('defaults to claude-code when no params', async () => {
      const result = await checkAvailability();
      expect(result.available).toBe(true);
      expect(mockProvider.checkAvailability).toHaveBeenCalled();
    });

    it('checks specific orchestrator', async () => {
      const result = await checkAvailability(undefined, 'opencode');
      expect(result.available).toBe(true);
    });

    it('returns error for unknown orchestrator', async () => {
      const result = await checkAvailability(undefined, 'nonexistent');
      expect(result.available).toBe(false);
      expect(result.error).toContain('Unknown orchestrator');
    });

    it('reads project-level orchestrator setting', async () => {
      vi.mocked(fs.readFileSync).mockReturnValueOnce(
        JSON.stringify({ orchestrator: 'opencode' })
      );
      await checkAvailability('/project');
      expect(mockAltProvider.checkAvailability).toHaveBeenCalled();
    });
  });

  describe('getAvailableOrchestrators', () => {
    it('returns all registered providers with capabilities', () => {
      const result = getAvailableOrchestrators();
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('claude-code');
      expect(result[0].displayName).toBe('Claude Code');
      expect(result[0].capabilities).toBeDefined();
      expect(result[0].capabilities.headless).toBe(true);
      expect(result[1].id).toBe('opencode');
      expect(result[1].displayName).toBe('OpenCode');
      expect(result[1].capabilities).toBeDefined();
    });
  });

  describe('config pipeline integration', () => {
    it('calls snapshotFile before writeHooksConfig', async () => {
      const callOrder: string[] = [];
      mockSnapshotFile.mockImplementation(() => { callOrder.push('snapshot'); });
      mockProvider.writeHooksConfig.mockImplementation(() => {
        callOrder.push('writeHooks');
        return Promise.resolve();
      });

      await spawnAgent({
        agentId: 'agent-1',
        projectPath: '/project',
        cwd: '/project',
        kind: 'durable',
      });

      expect(mockSnapshotFile).toHaveBeenCalledWith('agent-1', '/project/.claude/settings.local.json');
      expect(callOrder).toEqual(['snapshot', 'writeHooks']);
    });

    it('passes onExit callback to pty spawn that calls restoreForAgent', async () => {
      await spawnAgent({
        agentId: 'agent-1',
        projectPath: '/project',
        cwd: '/project',
        kind: 'durable',
      });

      // pty spawn should have received an onExit callback as the 6th arg
      expect(mockPtySpawn).toHaveBeenCalled();
      const onExitCallback = mockPtySpawn.mock.calls[0][5];
      expect(typeof onExitCallback).toBe('function');

      // Simulate agent exit
      onExitCallback('agent-1', 0);
      expect(mockRestoreForAgent).toHaveBeenCalledWith('agent-1');
    });

    it('skips snapshot when provider does not support hooks', async () => {
      mockGetHooksConfigPath.mockReturnValueOnce(null);

      await spawnAgent({
        agentId: 'agent-1',
        projectPath: '/project',
        cwd: '/project',
        kind: 'durable',
      });

      expect(mockSnapshotFile).not.toHaveBeenCalled();
    });
  });
});
