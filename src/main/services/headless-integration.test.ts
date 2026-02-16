import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
vi.mock('./headless-settings', () => ({
  getSettings: () => mockGetSettings(),
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
    mockBuildHeadlessCommand.mockResolvedValue({
      binary: '/usr/local/bin/claude',
      args: ['-p', 'Fix bug', '--output-format', 'stream-json'],
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
      mockGetSettings.mockReturnValue({ enabled: true });

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
      mockGetSettings.mockReturnValue({ enabled: true });

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
      mockGetSettings.mockReturnValue({ enabled: true });
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
      mockGetSettings.mockReturnValue({ enabled: true });

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
        })
      );
    });

    it('headless agents skip hook server setup', async () => {
      mockGetSettings.mockReturnValue({ enabled: true });

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
      mockGetSettings.mockReturnValue({ enabled: true });

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
          outputFormat: 'stream-json',
          permissionMode: 'auto',
          noSessionPersistence: true,
        })
      );
    });
  });

  describe('headless agent tracking', () => {
    it('isHeadlessAgent returns true for headless agents', async () => {
      mockGetSettings.mockReturnValue({ enabled: true });

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

  describe('killAgent routing', () => {
    it('kills headless agents via headless manager', async () => {
      mockGetSettings.mockReturnValue({ enabled: true });

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
});
