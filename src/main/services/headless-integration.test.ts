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

// Mock headless-manager
const mockHeadlessSpawn = vi.fn();
const mockHeadlessKill = vi.fn();
const mockHeadlessIsHeadless = vi.fn(() => false);
const mockReadTranscript = vi.fn(() => null);
vi.mock('./headless-manager', () => ({
  spawnHeadless: (...args: unknown[]) => mockHeadlessSpawn(...args),
  kill: (...args: unknown[]) => mockHeadlessKill(...args),
  isHeadless: (...args: unknown[]) => mockHeadlessIsHeadless(...args),
  readTranscript: (...args: unknown[]) => mockReadTranscript(...args),
  getTranscriptSummary: vi.fn(() => null),
}));

// Mock headless-settings
const mockGetSettings = vi.fn(() => ({ enabled: false }));
const mockGetSpawnMode = vi.fn(() => 'interactive' as const);
vi.mock('./headless-settings', () => ({
  getSettings: () => mockGetSettings(),
  getSpawnMode: (...args: unknown[]) => mockGetSpawnMode(...args),
  saveSettings: vi.fn(),
}));

// Mock fs
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

// Mock the orchestrator registry with a provider that supports headless
const mockBuildHeadlessCommand = vi.fn();
const mockProvider = {
  id: 'claude-code',
  displayName: 'Claude Code',
  checkAvailability: vi.fn(() => Promise.resolve({ available: true })),
  buildSpawnCommand: vi.fn(() => Promise.resolve({ binary: '/usr/local/bin/claude', args: ['test'] })),
  buildHeadlessCommand: mockBuildHeadlessCommand,
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

vi.mock('../orchestrators', () => ({
  getProvider: vi.fn(() => mockProvider),
  getAllProviders: vi.fn(() => [mockProvider]),
}));

import {
  spawnAgent,
  killAgent,
  isHeadlessAgent,
  untrackAgent,
} from './agent-system';

describe('Headless integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSettings.mockReturnValue({ enabled: false });
    mockGetSpawnMode.mockReturnValue('interactive');
    mockBuildHeadlessCommand.mockResolvedValue({
      binary: '/usr/local/bin/claude',
      args: ['-p', 'Fix bug', '--output-format', 'stream-json'],
      outputKind: 'stream-json',
    });
  });

  afterEach(() => {
    untrackAgent('test-agent');
  });

  describe('headless spawn routing', () => {
    it('uses PTY when headless is disabled', async () => {
      mockGetSettings.mockReturnValue({ enabled: false });

      await spawnAgent({
        agentId: 'test-agent',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        mission: 'Fix bug',
      });

      expect(mockPtySpawn).toHaveBeenCalled();
      expect(mockHeadlessSpawn).not.toHaveBeenCalled();
    });

    it('uses headless when enabled and kind is quick', async () => {
      mockGetSpawnMode.mockReturnValue('headless');

      await spawnAgent({
        agentId: 'test-agent',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        mission: 'Fix bug',
      });

      expect(mockHeadlessSpawn).toHaveBeenCalled();
      expect(mockPtySpawn).not.toHaveBeenCalled();
    });

    it('uses PTY for durable agents even when headless is enabled', async () => {
      mockGetSpawnMode.mockReturnValue('headless');

      await spawnAgent({
        agentId: 'test-agent',
        projectPath: '/project',
        cwd: '/project',
        kind: 'durable',
      });

      expect(mockPtySpawn).toHaveBeenCalled();
      expect(mockHeadlessSpawn).not.toHaveBeenCalled();
    });

    it('falls back to PTY when buildHeadlessCommand returns null', async () => {
      mockGetSpawnMode.mockReturnValue('headless');
      mockBuildHeadlessCommand.mockResolvedValue(null);

      await spawnAgent({
        agentId: 'test-agent',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        mission: 'Fix bug',
      });

      expect(mockPtySpawn).toHaveBeenCalled();
      expect(mockHeadlessSpawn).not.toHaveBeenCalled();
    });

    it('passes correct args to headless spawn', async () => {
      mockGetSpawnMode.mockReturnValue('headless');

      await spawnAgent({
        agentId: 'test-agent',
        projectPath: '/project',
        cwd: '/project/worktree',
        kind: 'quick',
        mission: 'Fix bug',
      });

      expect(mockHeadlessSpawn).toHaveBeenCalledWith(
        'test-agent',
        '/project/worktree',
        '/usr/local/bin/claude',
        ['-p', 'Fix bug', '--output-format', 'stream-json'],
        expect.objectContaining({
          CLUBHOUSE_AGENT_ID: 'test-agent',
        }),
        'stream-json',
        expect.any(Function),
      );
    });

    it('headless agents skip hook server setup', async () => {
      mockGetSpawnMode.mockReturnValue('headless');

      await spawnAgent({
        agentId: 'test-agent',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        mission: 'Fix bug',
      });

      // writeHooksConfig should NOT be called for headless
      expect(mockProvider.writeHooksConfig).not.toHaveBeenCalled();
    });

    it('headless provider receives correct opts', async () => {
      mockGetSpawnMode.mockReturnValue('headless');

      await spawnAgent({
        agentId: 'test-agent',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        mission: 'Fix bug',
        model: 'sonnet',
        systemPrompt: 'Be thorough',
        allowedTools: ['Read'],
      });

      expect(mockBuildHeadlessCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: '/project',
          mission: 'Fix bug',
          model: 'sonnet',
          systemPrompt: 'Be thorough',
          allowedTools: ['Read'],
          noSessionPersistence: true,
        })
      );
    });
  });

  describe('headless agent tracking', () => {
    it('isHeadlessAgent returns true for headless agents', async () => {
      mockGetSpawnMode.mockReturnValue('headless');

      await spawnAgent({
        agentId: 'test-agent',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        mission: 'Fix bug',
      });

      expect(isHeadlessAgent('test-agent')).toBe(true);
    });

    it('isHeadlessAgent returns false for PTY agents', async () => {
      mockGetSettings.mockReturnValue({ enabled: false });

      await spawnAgent({
        agentId: 'test-agent',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        mission: 'Fix bug',
      });

      expect(isHeadlessAgent('test-agent')).toBe(false);
    });
  });

  describe('per-project spawn mode routing', () => {
    it('getSpawnMode is called with projectPath', async () => {
      mockGetSpawnMode.mockReturnValue('headless');

      await spawnAgent({
        agentId: 'test-agent',
        projectPath: '/my/specific/project',
        cwd: '/my/specific/project',
        kind: 'quick',
        mission: 'Fix bug',
      });

      expect(mockGetSpawnMode).toHaveBeenCalledWith('/my/specific/project');
    });

    it('project set to headless spawns headless even if global is interactive', async () => {
      // Simulate per-project override returning headless
      mockGetSpawnMode.mockReturnValue('headless');

      await spawnAgent({
        agentId: 'test-agent',
        projectPath: '/headless-project',
        cwd: '/headless-project',
        kind: 'quick',
        mission: 'Fix bug',
      });

      expect(mockHeadlessSpawn).toHaveBeenCalled();
      expect(mockPtySpawn).not.toHaveBeenCalled();
    });

    it('project set to interactive spawns PTY even if global is headless', async () => {
      // Simulate per-project override returning interactive
      mockGetSpawnMode.mockReturnValue('interactive');

      await spawnAgent({
        agentId: 'test-agent',
        projectPath: '/interactive-project',
        cwd: '/interactive-project',
        kind: 'quick',
        mission: 'Fix bug',
      });

      expect(mockPtySpawn).toHaveBeenCalled();
      expect(mockHeadlessSpawn).not.toHaveBeenCalled();
    });
  });

  describe('outputKind passthrough', () => {
    it('passes stream-json outputKind to headless manager', async () => {
      mockGetSpawnMode.mockReturnValue('headless');
      mockBuildHeadlessCommand.mockResolvedValue({
        binary: '/usr/local/bin/claude',
        args: ['-p', 'test'],
        outputKind: 'stream-json',
      });

      await spawnAgent({
        agentId: 'test-agent',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        mission: 'test',
      });

      expect(mockHeadlessSpawn).toHaveBeenCalledWith(
        'test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test'],
        expect.any(Object),
        'stream-json',
        expect.any(Function),
      );
    });

    it('passes text outputKind to headless manager', async () => {
      mockGetSpawnMode.mockReturnValue('headless');
      mockBuildHeadlessCommand.mockResolvedValue({
        binary: '/usr/local/bin/copilot',
        args: ['-p', 'test', '--allow-all'],
        outputKind: 'text',
      });

      await spawnAgent({
        agentId: 'test-agent',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        mission: 'test',
      });

      expect(mockHeadlessSpawn).toHaveBeenCalledWith(
        'test-agent', '/project', '/usr/local/bin/copilot', ['-p', 'test', '--allow-all'],
        expect.any(Object),
        'text',
        expect.any(Function),
      );
    });

    it('defaults to stream-json when provider does not set outputKind', async () => {
      mockGetSpawnMode.mockReturnValue('headless');
      mockBuildHeadlessCommand.mockResolvedValue({
        binary: '/usr/local/bin/claude',
        args: ['-p', 'test'],
        // No outputKind property
      });

      await spawnAgent({
        agentId: 'test-agent',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        mission: 'test',
      });

      expect(mockHeadlessSpawn).toHaveBeenCalledWith(
        'test-agent', '/project', '/usr/local/bin/claude', ['-p', 'test'],
        expect.any(Object),
        'stream-json',
        expect.any(Function),
      );
    });
  });

  describe('does not pass outputFormat or permissionMode to provider', () => {
    it('omits outputFormat and permissionMode from headless opts', async () => {
      mockGetSpawnMode.mockReturnValue('headless');

      await spawnAgent({
        agentId: 'test-agent',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        mission: 'Fix bug',
      });

      const callArgs = mockBuildHeadlessCommand.mock.calls[0][0];
      expect(callArgs.outputFormat).toBeUndefined();
      expect(callArgs.permissionMode).toBeUndefined();
    });
  });

  describe('killAgent routing', () => {
    it('kills headless agents via headless manager', async () => {
      mockGetSpawnMode.mockReturnValue('headless');

      await spawnAgent({
        agentId: 'test-agent',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        mission: 'Fix bug',
      });

      await killAgent('test-agent', '/project');

      expect(mockHeadlessKill).toHaveBeenCalledWith('test-agent');
      expect(mockPtyGracefulKill).not.toHaveBeenCalled();
    });

    it('kills PTY agents via pty manager', async () => {
      mockGetSettings.mockReturnValue({ enabled: false });

      await spawnAgent({
        agentId: 'test-agent',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        mission: 'Fix bug',
      });

      await killAgent('test-agent', '/project');

      expect(mockPtyGracefulKill).toHaveBeenCalledWith('test-agent', '/exit\r');
      expect(mockHeadlessKill).not.toHaveBeenCalled();
    });
  });

  describe('config pipeline integration (headless)', () => {
    it('headless spawn does NOT call snapshotFile (no hooks for headless)', async () => {
      mockGetSpawnMode.mockReturnValue('headless');

      await spawnAgent({
        agentId: 'test-agent',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        mission: 'Fix bug',
      });

      expect(mockSnapshotFile).not.toHaveBeenCalled();
    });

    it('headless spawn passes onExit callback that calls restoreForAgent', async () => {
      mockGetSpawnMode.mockReturnValue('headless');

      await spawnAgent({
        agentId: 'test-agent',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        mission: 'Fix bug',
      });

      // headless spawn should have received an onExit callback as the 7th arg (index 6)
      expect(mockHeadlessSpawn).toHaveBeenCalled();
      const onExitCallback = mockHeadlessSpawn.mock.calls[0][6];
      expect(typeof onExitCallback).toBe('function');

      // Simulate agent exit
      onExitCallback('test-agent', 0);
      expect(mockRestoreForAgent).toHaveBeenCalledWith('test-agent');
    });
  });
});
