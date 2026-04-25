import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { OrchestratorConventions } from '../orchestrators';

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

// Mock headless-manager
const mockHeadlessSpawn = vi.fn();
const mockHeadlessKill = vi.fn();
const mockIsHeadless = vi.fn(() => false);
vi.mock('./headless-manager', () => ({
  spawnHeadless: (...args: unknown[]) => mockHeadlessSpawn(...args),
  kill: (...args: unknown[]) => mockHeadlessKill(...args),
  isHeadless: (...args: unknown[]) => mockIsHeadless(...args),
}));

// Mock structured-manager
const mockStartStructured = vi.fn();
const mockCancelSession = vi.fn();
const mockIsStructuredSession = vi.fn(() => false);
vi.mock('./structured-manager', () => ({
  startStructuredSession: (...args: unknown[]) => mockStartStructured(...args),
  cancelSession: (...args: unknown[]) => mockCancelSession(...args),
  isStructuredSession: (...args: unknown[]) => mockIsStructuredSession(...args),
}));

// Mock headless-settings
const mockGetSpawnMode = vi.fn(() => 'interactive' as const);
vi.mock('./headless-settings', () => ({
  getSpawnMode: (...args: unknown[]) => mockGetSpawnMode(...args),
}));

// Mock hook-server
vi.mock('./hook-server', () => ({
  waitReady: vi.fn(() => Promise.resolve(12345)),
}));

// Mock clubhouse-mode-settings
const mockIsClubhouseModeEnabled = vi.fn(() => false);
vi.mock('./clubhouse-mode-settings', () => ({
  isClubhouseModeEnabled: (...args: unknown[]) => mockIsClubhouseModeEnabled(...args),
}));

// Mock agent-config
const mockGetDurableConfig = vi.fn(() => null);
const mockAddSessionEntry = vi.fn();
vi.mock('./agent-config', () => ({
  getDurableConfig: (...args: unknown[]) => mockGetDurableConfig(...args),
  addSessionEntry: (...args: unknown[]) => mockAddSessionEntry(...args),
}));

// Mock materialization-service
const mockMaterializeAgent = vi.fn();
const mockCleanupStaleJsonInTomlConfigs = vi.fn();
vi.mock('./materialization-service', () => ({
  materializeAgent: (...args: unknown[]) => mockMaterializeAgent(...args),
  cleanupStaleJsonInTomlConfigs: (...args: unknown[]) => mockCleanupStaleJsonInTomlConfigs(...args),
}));

// Mock profile-settings
vi.mock('./profile-settings', () => ({
  getProfile: vi.fn(() => null),
  resolveProfileEnv: vi.fn(() => undefined),
}));

// Mock agent-settings-service
const mockReadProjectAgentDefaults = vi.fn(() => ({}));
const mockReadLaunchWrapper = vi.fn(() => undefined);
const mockReadDefaultMcps = vi.fn(() => []);
vi.mock('./agent-settings-service', () => ({
  readProjectAgentDefaults: (...args: unknown[]) => mockReadProjectAgentDefaults(...args),
  readLaunchWrapper: (...args: unknown[]) => mockReadLaunchWrapper(...args),
  readDefaultMcps: (...args: unknown[]) => mockReadDefaultMcps(...args),
}));

// Mock log-service
vi.mock('./log-service', () => ({
  appLog: vi.fn(),
}));

// Mock fs/promises for readProjectOrchestrator
const mockReadFile = vi.fn(() => Promise.reject(new Error('ENOENT')));
vi.mock('fs/promises', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
}));

// Mock the orchestrator registry
const mockClaudeConventions: OrchestratorConventions = {
  configDir: '.claude',
  localInstructionsFile: 'CLAUDE.md',
  legacyInstructionsFile: 'CLAUDE.md',
  mcpConfigFile: '.mcp.json',
  skillsDir: 'skills',
  agentTemplatesDir: 'agents',
  localSettingsFile: 'settings.local.json',
};

const mockProvider = {
  id: 'claude-code',
  displayName: 'Claude Code',
  shortName: 'CC',
  checkAvailability: vi.fn(() => Promise.resolve({ available: true })),
  buildSpawnCommand: vi.fn(() => Promise.resolve({ binary: '/usr/local/bin/claude', args: ['--model', 'opus'] })),
  getExitCommand: vi.fn(() => '/exit\r'),
  writeHooksConfig: vi.fn(() => Promise.resolve()),
  parseHookEvent: vi.fn(),
  readInstructions: vi.fn(() => ''),
  writeInstructions: vi.fn(),
  conventions: mockClaudeConventions,
  getModelOptions: vi.fn(() => []),
  getDefaultPermissions: vi.fn((kind: string) => kind === 'quick' ? ['Read', 'Write'] : []),
  toolVerb: vi.fn(),
  getProfileEnvKeys: vi.fn(() => ['CLAUDE_CONFIG_DIR']),
  getCapabilities: vi.fn(() => ({
    headless: true, structuredOutput: true, hooks: true,
    sessionResume: true, permissions: true, structuredMode: false,
  })),
};

const mockCodexConventions: OrchestratorConventions = {
  configDir: '.codex',
  localInstructionsFile: 'AGENTS.md',
  legacyInstructionsFile: 'AGENTS.md',
  mcpConfigFile: '.codex/config.toml',
  skillsDir: 'skills',
  agentTemplatesDir: 'agents',
  localSettingsFile: 'config.toml',
  settingsFormat: 'toml',
};

const mockCodexProvider = {
  ...mockProvider,
  id: 'codex-cli',
  displayName: 'Codex CLI',
  shortName: 'CX',
  getExitCommand: vi.fn(() => '/quit\r'),
  conventions: mockCodexConventions,
  getCapabilities: vi.fn(() => ({
    headless: true, structuredOutput: false, hooks: false,
    sessionResume: true, permissions: true, structuredMode: false,
  })),
  getProfileEnvKeys: vi.fn(() => ['OPENAI_API_KEY']),
};

vi.mock('../orchestrators', () => ({
  getProvider: vi.fn((id: string) => {
    if (id === 'claude-code') return mockProvider;
    if (id === 'codex-cli') return mockCodexProvider;
    return undefined;
  }),
  getAllProviders: vi.fn(() => [mockProvider, mockCodexProvider]),
  isHookCapable: vi.fn((p: any) => p.getCapabilities().hooks && typeof p.writeHooksConfig === 'function'),
  isHeadlessCapable: vi.fn((p: any) => p.getCapabilities().headless && typeof p.buildHeadlessCommand === 'function'),
  isSessionCapable: vi.fn((p: any) => p.getCapabilities().sessionResume && typeof p.listSessions === 'function'),
  isStructuredCapable: vi.fn((p: any) => p.getCapabilities().structuredMode && typeof p.createStructuredAdapter === 'function'),
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
  isHeadlessAgent,
  isStructuredAgent,
} from './agent-system';

describe('agent-system', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHeadlessSpawn.mockImplementation((agentId: string) => {
      mockIsHeadless.mockImplementation((trackedAgentId: string) => trackedAgentId === agentId);
    });
    mockHeadlessKill.mockImplementation((agentId: string) => {
      mockIsHeadless.mockImplementation((trackedAgentId: string) => trackedAgentId !== agentId);
    });
    mockStartStructured.mockImplementation(async (agentId: string) => {
      mockIsStructuredSession.mockImplementation((trackedAgentId: string) => trackedAgentId === agentId);
    });
    mockCancelSession.mockImplementation(async (agentId: string) => {
      mockIsStructuredSession.mockImplementation((trackedAgentId: string) => trackedAgentId !== agentId);
    });
  });

  afterEach(() => {
    // Clean up tracked agents
    untrackAgent('test-agent');
    untrackAgent('agent-1');
    untrackAgent('test-headless');
    untrackAgent('test-structured');
    mockIsHeadless.mockReturnValue(false);
    mockIsStructuredSession.mockReturnValue(false);
  });

  describe('resolveOrchestrator', () => {
    it('uses agent-level override when provided', async () => {
      const provider = await resolveOrchestrator('/project', 'codex-cli');
      expect(provider.id).toBe('codex-cli');
    });

    it('falls back to project-level setting', async () => {
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({ orchestrator: 'codex-cli' })
      );
      const provider = await resolveOrchestrator('/project');
      expect(provider.id).toBe('codex-cli');
    });

    it('falls back to default (claude-code)', async () => {
      const provider = await resolveOrchestrator('/project');
      expect(provider.id).toBe('claude-code');
    });

    it('throws for unknown orchestrator', async () => {
      await expect(resolveOrchestrator('/project', 'nonexistent'))
        .rejects.toThrowError('Unknown orchestrator: nonexistent');
    });

    it('agent override takes priority over project setting', async () => {
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({ orchestrator: 'codex-cli' })
      );
      const provider = await resolveOrchestrator('/project', 'claude-code');
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
        orchestrator: 'codex-cli',
      });
      expect(getAgentOrchestrator('agent-1')).toBe('codex-cli');
    });

    it('tracks resolved orchestrator even when not explicitly specified', async () => {
      await spawnAgent({
        agentId: 'agent-1',
        projectPath: '/my/project',
        cwd: '/my/project',
        kind: 'durable',
      });
      expect(getAgentOrchestrator('agent-1')).toBe('claude-code');
    });

    it('tracks project-level orchestrator from settings.json', async () => {
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({ orchestrator: 'codex-cli' })
      );
      await spawnAgent({
        agentId: 'agent-1',
        projectPath: '/my/project',
        cwd: '/my/project',
        kind: 'durable',
      });
      expect(getAgentOrchestrator('agent-1')).toBe('codex-cli');
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
        undefined, // commandPrefix
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

    it('throws with descriptive error when pre-flight check fails', async () => {
      mockProvider.checkAvailability.mockResolvedValueOnce({
        available: false,
        error: 'OPENAI_API_KEY is not set',
      });

      await expect(
        spawnAgent({
          agentId: 'agent-1',
          projectPath: '/project',
          cwd: '/project',
          kind: 'durable',
        })
      ).rejects.toThrowError('OPENAI_API_KEY is not set');
    });

    it('passes commandPrefix from project settings to ptyManager.spawn', async () => {
      mockReadProjectAgentDefaults.mockReturnValue({ commandPrefix: '. ./init.sh' });

      await spawnAgent({
        agentId: 'agent-1',
        projectPath: '/project',
        cwd: '/project',
        kind: 'durable',
      });

      // The 7th argument to ptyManager.spawn should be the command prefix
      expect(mockPtySpawn).toHaveBeenCalledWith(
        'agent-1',
        '/project',
        expect.any(String),
        expect.any(Array),
        expect.any(Object),
        expect.any(Function),
        '. ./init.sh',
      );
    });

    it('passes undefined commandPrefix when not configured', async () => {
      await spawnAgent({
        agentId: 'agent-1',
        projectPath: '/project',
        cwd: '/project',
        kind: 'durable',
      });

      // The 7th argument should be undefined
      expect(mockPtySpawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.any(Array),
        expect.any(Object),
        expect.any(Function),
        undefined,
      );
    });

    it('does not spawn PTY when pre-flight check fails', async () => {
      mockProvider.checkAvailability.mockResolvedValueOnce({
        available: false,
        error: 'CLI not found',
      });

      await expect(
        spawnAgent({
          agentId: 'agent-1',
          projectPath: '/project',
          cwd: '/project',
          kind: 'durable',
        })
      ).rejects.toThrow();

      expect(mockPtySpawn).not.toHaveBeenCalled();
    });

    it('cleans up tracking maps when PTY spawn fails', async () => {
      mockProvider.buildSpawnCommand.mockRejectedValueOnce(new Error('spawn failed'));

      await expect(
        spawnAgent({
          agentId: 'agent-1',
          projectPath: '/project',
          cwd: '/project',
          kind: 'durable',
        })
      ).rejects.toThrow('spawn failed');

      expect(getAgentProjectPath('agent-1')).toBeUndefined();
      expect(getAgentOrchestrator('agent-1')).toBeUndefined();
      expect(getAgentNonce('agent-1')).toBeUndefined();
    });

    it('cleans up tracking maps when structured spawn fails', async () => {
      mockGetSpawnMode.mockReturnValue('structured');
      const mockAdapter = { start: vi.fn(), sendMessage: vi.fn(), respondToPermission: vi.fn(), cancel: vi.fn(), dispose: vi.fn() };
      mockProvider.createStructuredAdapter = vi.fn(() => mockAdapter);
      mockProvider.getCapabilities.mockReturnValue({
        headless: true, structuredOutput: true, hooks: true,
        sessionResume: true, permissions: true, structuredMode: true,
      });
      mockStartStructured.mockRejectedValueOnce(new Error('structured spawn failed'));

      await expect(
        spawnAgent({
          agentId: 'test-structured',
          projectPath: '/project',
          cwd: '/project',
          kind: 'quick',
          mission: 'test',
        })
      ).rejects.toThrow('structured spawn failed');

      expect(getAgentProjectPath('test-structured')).toBeUndefined();
      expect(getAgentOrchestrator('test-structured')).toBeUndefined();
      expect(isStructuredAgent('test-structured')).toBe(false);

      delete (mockProvider as any).createStructuredAdapter;
    });

    it('cleans up tracking maps when headless spawn fails', async () => {
      mockGetSpawnMode.mockReturnValue('headless');
      mockProvider.buildHeadlessCommand = vi.fn(() =>
        Promise.resolve({
          binary: '/usr/bin/claude',
          args: ['--headless'],
          env: {},
          outputKind: 'stream-json' as const,
        }),
      );
      mockHeadlessSpawn.mockImplementationOnce(() => { throw new Error('headless spawn failed'); });

      await expect(
        spawnAgent({
          agentId: 'test-headless',
          projectPath: '/project',
          cwd: '/project',
          kind: 'quick',
          mission: 'test',
        })
      ).rejects.toThrow('headless spawn failed');

      expect(getAgentProjectPath('test-headless')).toBeUndefined();
      expect(getAgentOrchestrator('test-headless')).toBeUndefined();
      expect(isHeadlessAgent('test-headless')).toBe(false);

      delete (mockProvider as any).buildHeadlessCommand;
    });

    it('propagates the original error after cleanup on spawn failure', async () => {
      const originalError = new Error('specific spawn error');
      mockProvider.buildSpawnCommand.mockRejectedValueOnce(originalError);

      await expect(
        spawnAgent({
          agentId: 'agent-1',
          projectPath: '/project',
          cwd: '/project',
          kind: 'durable',
        })
      ).rejects.toThrow(originalError);
    });
  });

  describe('killAgent', () => {
    it('calls gracefulKill with provider exit command', async () => {
      await killAgent('agent-1', '/project');
      expect(mockPtyGracefulKill).toHaveBeenCalledWith('agent-1', '/exit\r');
    });

    it('uses orchestrator from agentOrchestratorMap set at spawn time', async () => {
      await spawnAgent({
        agentId: 'agent-orch',
        projectPath: '/project',
        cwd: '/project',
        kind: 'durable',
        orchestrator: 'codex-cli',
      });
      await killAgent('agent-orch', '/project');
      expect(mockPtyGracefulKill).toHaveBeenCalledWith('agent-orch', '/quit\r');
    });

    it('uses tracked orchestrator from spawn rather than caller-provided', async () => {
      // Spawn with codex-cli orchestrator
      await spawnAgent({
        agentId: 'agent-1',
        projectPath: '/project',
        cwd: '/project',
        kind: 'durable',
        orchestrator: 'codex-cli',
      });

      // Kill without specifying orchestrator — should use the tracked one (codex-cli)
      await killAgent('agent-1', '/project');
      expect(mockPtyGracefulKill).toHaveBeenCalledWith('agent-1', '/quit\r');
    });

    it('uses tracked project-level orchestrator when spawned from settings', async () => {
      // Spawn with orchestrator resolved from project settings (codex-cli)
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({ orchestrator: 'codex-cli' })
      );
      await spawnAgent({
        agentId: 'agent-1',
        projectPath: '/project',
        cwd: '/project',
        kind: 'durable',
      });

      // Kill without specifying orchestrator — should use the tracked one (codex-cli)
      await killAgent('agent-1', '/project');
      expect(mockPtyGracefulKill).toHaveBeenCalledWith('agent-1', '/quit\r');
    });

    it('uses tracked headless runtime even if the manager lookup is stale', async () => {
      mockGetSpawnMode.mockReturnValue('headless');
      mockProvider.buildHeadlessCommand = vi.fn(() =>
        Promise.resolve({
          binary: '/usr/bin/claude',
          args: ['--headless'],
          env: {},
          outputKind: 'stream-json' as const,
        }),
      );

      await spawnAgent({
        agentId: 'test-headless',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        mission: 'test',
      });

      mockIsHeadless.mockReturnValue(false);

      await killAgent('test-headless', '/project');

      expect(mockHeadlessKill).toHaveBeenCalledWith('test-headless');
      expect(mockPtyGracefulKill).not.toHaveBeenCalled();

      delete (mockProvider as any).buildHeadlessCommand;
    });

    it('uses tracked structured runtime even if the manager lookup is stale', async () => {
      mockGetSpawnMode.mockReturnValue('structured');
      const mockAdapter = { start: vi.fn(), sendMessage: vi.fn(), respondToPermission: vi.fn(), cancel: vi.fn(), dispose: vi.fn() };
      mockProvider.createStructuredAdapter = vi.fn(() => mockAdapter);
      mockProvider.getCapabilities.mockReturnValue({
        headless: true, structuredOutput: true, hooks: true,
        sessionResume: true, permissions: true, structuredMode: true,
      });

      await spawnAgent({
        agentId: 'test-structured',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        mission: 'test',
      });

      mockIsStructuredSession.mockReturnValue(false);

      await killAgent('test-structured', '/project');

      expect(mockCancelSession).toHaveBeenCalledWith('test-structured');
      expect(mockPtyGracefulKill).not.toHaveBeenCalled();
      expect(mockHeadlessKill).not.toHaveBeenCalled();

      delete (mockProvider as any).createStructuredAdapter;
    });

    it('does not reject when gracefulKill throws (process already dead)', async () => {
      mockPtyGracefulKill.mockImplementationOnce(() => { throw new Error('process already dead'); });
      await expect(killAgent('agent-1', '/project')).resolves.toBeUndefined();
    });

    it('does not reject for unknown orchestrator', async () => {
      await expect(killAgent('agent-1', '/project', 'nonexistent' as any)).resolves.toBeUndefined();
    });
  });

  describe('untrackAgent', () => {
    it('removes agent from all maps including nonce', async () => {
      await spawnAgent({
        agentId: 'agent-1',
        projectPath: '/project',
        cwd: '/project',
        kind: 'durable',
        orchestrator: 'codex-cli',
      });
      expect(getAgentProjectPath('agent-1')).toBe('/project');
      expect(getAgentOrchestrator('agent-1')).toBe('codex-cli');
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
      const result = await checkAvailability(undefined, 'codex-cli');
      expect(result.available).toBe(true);
    });

    it('returns error for unknown orchestrator', async () => {
      const result = await checkAvailability(undefined, 'nonexistent');
      expect(result.available).toBe(false);
      expect(result.error).toContain('Unknown orchestrator');
    });

    it('reads project-level orchestrator setting', async () => {
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({ orchestrator: 'codex-cli' })
      );
      await checkAvailability('/project');
      expect(mockCodexProvider.checkAvailability).toHaveBeenCalled();
    });
  });

  describe('getAvailableOrchestrators', () => {
    it('returns all registered providers with capabilities and runtime metadata', () => {
      const result = getAvailableOrchestrators();
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        id: 'claude-code',
        displayName: 'Claude Code',
        shortName: 'CC',
        capabilities: expect.objectContaining({ headless: true }),
        conventions: mockClaudeConventions,
      });
      expect(result[1]).toMatchObject({
        id: 'codex-cli',
        displayName: 'Codex CLI',
        shortName: 'CX',
        capabilities: expect.objectContaining({ hooks: false }),
        conventions: expect.objectContaining({ configDir: '.codex' }),
      });
    });

    it('uses provider fixtures with the expected profile env keys', () => {
      expect(mockProvider.getProfileEnvKeys()).toEqual(['CLAUDE_CONFIG_DIR']);
      expect(mockCodexProvider.getProfileEnvKeys()).toEqual(['OPENAI_API_KEY']);
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

    it('PTY onExit callback calls untrackAgent to clean up tracking state', async () => {
      await spawnAgent({
        agentId: 'agent-1',
        projectPath: '/project',
        cwd: '/project',
        kind: 'durable',
        orchestrator: 'codex-cli',
      });

      // Verify agent is tracked before exit
      expect(getAgentProjectPath('agent-1')).toBe('/project');
      expect(getAgentOrchestrator('agent-1')).toBe('codex-cli');
      expect(getAgentNonce('agent-1')).toBeDefined();

      // Simulate natural agent exit via PTY onExit callback
      const onExitCallback = mockPtySpawn.mock.calls[0][5];
      onExitCallback('agent-1', 0);

      // Verify agent tracking state is fully cleaned up
      expect(getAgentProjectPath('agent-1')).toBeUndefined();
      expect(getAgentOrchestrator('agent-1')).toBeUndefined();
      expect(getAgentNonce('agent-1')).toBeUndefined();
    });

    it('PTY onExit records session entry for durable agents even without SessionCapable (Bug 2 fix)', async () => {
      await spawnAgent({
        agentId: 'agent-1',
        projectPath: '/project',
        cwd: '/project',
        kind: 'durable',
      });

      const onExitCallback = mockPtySpawn.mock.calls[0][5];
      onExitCallback('agent-1', 0);

      // addSessionEntry should be called even for non-session-capable providers
      // with a generated UUID when extractSessionId isn't available
      await vi.waitFor(() => {
        expect(mockAddSessionEntry).toHaveBeenCalledWith(
          '/project',
          'agent-1',
          expect.objectContaining({
            sessionId: expect.any(String),
            startedAt: expect.any(String),
            lastActiveAt: expect.any(String),
          }),
        );
      });
    });

    it('PTY onExit uses provider extractSessionId when available', async () => {
      // Make provider session-capable
      mockProvider.extractSessionId = vi.fn(() => 'provider-session-123');
      mockProvider.listSessions = vi.fn(async () => []);
      mockProvider.readSessionTranscript = vi.fn(async () => null);
      mockProvider.getCapabilities.mockReturnValue({
        headless: true, structuredOutput: false, hooks: true,
        sessionResume: true, permissions: false, structuredMode: false,
      });

      await spawnAgent({
        agentId: 'agent-1',
        projectPath: '/project',
        cwd: '/project',
        kind: 'durable',
      });

      const onExitCallback = mockPtySpawn.mock.calls[0][5];
      // Pass buffer so extractSessionId can be called
      onExitCallback('agent-1', 0, 'Session ID: provider-session-123');

      await vi.waitFor(() => {
        expect(mockAddSessionEntry).toHaveBeenCalledWith(
          '/project',
          'agent-1',
          expect.objectContaining({
            sessionId: 'provider-session-123',
          }),
        );
      });
    });

    it('PTY onExit does NOT record session entry for quick agents', async () => {
      await spawnAgent({
        agentId: 'agent-quick',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
      });

      const onExitCallback = mockPtySpawn.mock.calls[0][5];
      onExitCallback('agent-quick', 0);

      // Give time for any async operations
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(mockAddSessionEntry).not.toHaveBeenCalled();
    });

    it('headless onExit callback calls untrackAgent to clean up tracking state', async () => {
      mockGetSpawnMode.mockReturnValue('headless');
      mockProvider.buildHeadlessCommand = vi.fn(() =>
        Promise.resolve({
          binary: '/usr/bin/claude',
          args: ['--headless'],
          env: {},
          outputKind: 'stream-json' as const,
        }),
      );

      await spawnAgent({
        agentId: 'test-headless',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        mission: 'test mission',
      });

      // Verify agent is tracked before exit
      expect(getAgentProjectPath('test-headless')).toBe('/project');

      // Extract and invoke the onExit callback (7th argument, index 6)
      const onExitCallback = mockHeadlessSpawn.mock.calls[0][6];
      onExitCallback('test-headless', 0);

      // Verify agent tracking state is fully cleaned up
      expect(getAgentProjectPath('test-headless')).toBeUndefined();
      expect(getAgentOrchestrator('test-headless')).toBeUndefined();
      expect(getAgentNonce('test-headless')).toBeUndefined();
      expect(mockRestoreForAgent).toHaveBeenCalledWith('test-headless');
    });

    it('structured onExit callback calls untrackAgent to clean up tracking state', async () => {
      mockGetSpawnMode.mockReturnValue('structured');
      const mockAdapter = { start: vi.fn(), sendMessage: vi.fn(), respondToPermission: vi.fn(), cancel: vi.fn(), dispose: vi.fn() };
      mockProvider.createStructuredAdapter = vi.fn(() => mockAdapter);
      mockProvider.getCapabilities.mockReturnValue({
        headless: true, structuredOutput: true, hooks: true,
        sessionResume: true, permissions: true, structuredMode: true,
      });

      await spawnAgent({
        agentId: 'test-structured',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        mission: 'test mission',
      });

      // Verify agent is tracked before exit
      expect(getAgentProjectPath('test-structured')).toBe('/project');

      // Extract and invoke the onExit callback (4th argument, index 3)
      const onExitCallback = mockStartStructured.mock.calls[0][3];
      onExitCallback('test-structured');

      // Verify agent tracking state is fully cleaned up
      expect(getAgentProjectPath('test-structured')).toBeUndefined();
      expect(getAgentOrchestrator('test-structured')).toBeUndefined();
      expect(getAgentNonce('test-structured')).toBeUndefined();
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

  describe('headless spawn path', () => {
    beforeEach(() => {
      mockGetSpawnMode.mockReturnValue('headless');
      mockProvider.buildHeadlessCommand = vi.fn(() =>
        Promise.resolve({
          binary: '/usr/bin/claude',
          args: ['-p', 'test mission', '--output-format', 'stream-json'],
          env: { CUSTOM_VAR: 'val' },
          outputKind: 'stream-json' as const,
        }),
      );
    });

    afterEach(() => {
      delete (mockProvider as any).buildHeadlessCommand;
    });

    it('spawns via headless-manager when mode is headless and kind is quick', async () => {
      await spawnAgent({
        agentId: 'test-headless',
        projectPath: '/project',
        cwd: '/project/worktree',
        kind: 'quick',
        mission: 'test mission',
      });

      expect(mockHeadlessSpawn).toHaveBeenCalledWith(
        'test-headless',
        '/project/worktree',
        '/usr/bin/claude',
        ['-p', 'test mission', '--output-format', 'stream-json'],
        expect.objectContaining({
          CUSTOM_VAR: 'val',
          CLUBHOUSE_AGENT_ID: 'test-headless',
        }),
        'stream-json',
        expect.any(Function),
        undefined, // commandPrefix
      );
      expect(mockPtySpawn).not.toHaveBeenCalled();
    });

    it('does not spawn headless for durable agents', async () => {
      await spawnAgent({
        agentId: 'test-headless',
        projectPath: '/project',
        cwd: '/project',
        kind: 'durable',
      });

      expect(mockHeadlessSpawn).not.toHaveBeenCalled();
      expect(mockPtySpawn).toHaveBeenCalled();
    });

    it('falls back to PTY when buildHeadlessCommand returns null', async () => {
      (mockProvider.buildHeadlessCommand as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

      await spawnAgent({
        agentId: 'test-headless',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        mission: 'test mission',
      });

      expect(mockHeadlessSpawn).not.toHaveBeenCalled();
      expect(mockPtySpawn).toHaveBeenCalled();
    });

    it('falls back to PTY when provider lacks buildHeadlessCommand', async () => {
      delete (mockProvider as any).buildHeadlessCommand;

      await spawnAgent({
        agentId: 'test-headless',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        mission: 'test mission',
      });

      expect(mockHeadlessSpawn).not.toHaveBeenCalled();
      expect(mockPtySpawn).toHaveBeenCalled();
    });

    it('passes mission and systemPrompt to buildHeadlessCommand', async () => {
      await spawnAgent({
        agentId: 'test-headless',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        mission: 'do stuff',
        systemPrompt: 'be concise',
        model: 'opus',
      });

      expect(mockProvider.buildHeadlessCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          mission: 'do stuff',
          systemPrompt: 'be concise',
          model: 'opus',
          agentId: 'test-headless',
          noSessionPersistence: true,
        }),
      );
    });

    it('passes allowedTools from quick defaults to buildHeadlessCommand', async () => {
      await spawnAgent({
        agentId: 'test-headless',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        mission: 'test',
      });

      expect(mockProvider.buildHeadlessCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          allowedTools: ['Read', 'Write'],
        }),
      );
    });

    it('passes explicit allowedTools over defaults to buildHeadlessCommand', async () => {
      await spawnAgent({
        agentId: 'test-headless',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        mission: 'test',
        allowedTools: ['Bash(git:*)'],
      });

      expect(mockProvider.buildHeadlessCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          allowedTools: ['Bash(git:*)'],
        }),
      );
    });

    it('tracks headless agent and marks it as headless', async () => {
      await spawnAgent({
        agentId: 'test-headless',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        mission: 'test',
      });

      expect(isHeadlessAgent('test-headless')).toBe(true);
      expect(isStructuredAgent('test-headless')).toBe(false);
      expect(getAgentProjectPath('test-headless')).toBe('/project');
      expect(getAgentOrchestrator('test-headless')).toBe('claude-code');
    });

    it('passes commandPrefix to headless spawn', async () => {
      mockReadProjectAgentDefaults.mockReturnValue({ commandPrefix: '. ./init.sh' });

      await spawnAgent({
        agentId: 'test-headless',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        mission: 'test',
      });

      // commandPrefix is the 8th argument (index 7) to spawnHeadless
      expect(mockHeadlessSpawn).toHaveBeenCalledWith(
        'test-headless',
        '/project',
        expect.any(String),
        expect.any(Array),
        expect.any(Object),
        expect.any(String),
        expect.any(Function),
        '. ./init.sh',
      );
    });

    it('headless onExit calls restoreForAgent and untrackAgent', async () => {
      await spawnAgent({
        agentId: 'test-headless',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        mission: 'test',
      });

      expect(getAgentProjectPath('test-headless')).toBe('/project');

      // Extract and invoke the onExit callback (7th argument, index 6)
      const onExitCallback = mockHeadlessSpawn.mock.calls[0][6];
      onExitCallback('test-headless', 0);

      expect(mockRestoreForAgent).toHaveBeenCalledWith('test-headless');
      expect(getAgentProjectPath('test-headless')).toBeUndefined();
      expect(getAgentOrchestrator('test-headless')).toBeUndefined();
    });

    it('passes freeAgentMode to buildHeadlessCommand', async () => {
      await spawnAgent({
        agentId: 'test-headless',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        mission: 'test',
        freeAgentMode: true,
      });

      expect(mockProvider.buildHeadlessCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          freeAgentMode: true,
        }),
      );
    });
  });

  describe('structured spawn path', () => {
    const mockAdapter = {
      start: vi.fn(),
      sendMessage: vi.fn(),
      respondToPermission: vi.fn(),
      cancel: vi.fn(),
      dispose: vi.fn(),
    };

    beforeEach(() => {
      mockGetSpawnMode.mockReturnValue('structured');
      mockProvider.createStructuredAdapter = vi.fn(() => mockAdapter);
      mockProvider.getCapabilities.mockReturnValue({
        headless: true, structuredOutput: true, hooks: true,
        sessionResume: true, permissions: true, structuredMode: true,
      });
    });

    afterEach(() => {
      delete (mockProvider as any).createStructuredAdapter;
      mockProvider.getCapabilities.mockReturnValue({
        headless: true, structuredOutput: true, hooks: true,
        sessionResume: true, permissions: true, structuredMode: false,
      });
    });

    it('spawns via structured-manager when mode is structured and kind is quick', async () => {
      await spawnAgent({
        agentId: 'test-structured',
        projectPath: '/project',
        cwd: '/project/worktree',
        kind: 'quick',
        mission: 'test mission',
        model: 'opus',
        systemPrompt: 'be concise',
      });

      expect(mockProvider.createStructuredAdapter).toHaveBeenCalled();
      expect(mockStartStructured).toHaveBeenCalledWith(
        'test-structured',
        mockAdapter,
        expect.objectContaining({
          mission: 'test mission',
          systemPrompt: 'be concise',
          model: 'opus',
          cwd: '/project/worktree',
        }),
        expect.any(Function),
      );
      expect(mockPtySpawn).not.toHaveBeenCalled();
      expect(mockHeadlessSpawn).not.toHaveBeenCalled();
    });

    it('does not spawn structured for durable agents without structuredMode flag', async () => {
      await spawnAgent({
        agentId: 'test-structured',
        projectPath: '/project',
        cwd: '/project',
        kind: 'durable',
      });

      expect(mockStartStructured).not.toHaveBeenCalled();
      expect(mockPtySpawn).toHaveBeenCalled();
    });

    it('spawns structured for durable agents with structuredMode: true', async () => {
      await spawnAgent({
        agentId: 'test-durable-structured',
        projectPath: '/project',
        cwd: '/project/worktree',
        kind: 'durable',
        mission: 'build feature',
        structuredMode: true,
      });

      expect(mockProvider.createStructuredAdapter).toHaveBeenCalled();
      expect(mockStartStructured).toHaveBeenCalledWith(
        'test-durable-structured',
        mockAdapter,
        expect.objectContaining({
          mission: 'build feature',
          cwd: '/project/worktree',
        }),
        expect.any(Function),
      );
      expect(mockPtySpawn).not.toHaveBeenCalled();
    });

    it('does not spawn structured for durable agents with structuredMode: false', async () => {
      await spawnAgent({
        agentId: 'test-no-structured',
        projectPath: '/project',
        cwd: '/project',
        kind: 'durable',
        structuredMode: false,
      });

      expect(mockStartStructured).not.toHaveBeenCalled();
      expect(mockPtySpawn).toHaveBeenCalled();
    });

    it('falls back to PTY when provider lacks createStructuredAdapter', async () => {
      delete (mockProvider as any).createStructuredAdapter;

      await spawnAgent({
        agentId: 'test-structured',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        mission: 'test',
      });

      expect(mockStartStructured).not.toHaveBeenCalled();
      expect(mockPtySpawn).toHaveBeenCalled();
    });

    it('falls back to PTY when mission is empty string in structured mode', async () => {
      await spawnAgent({
        agentId: 'test-structured',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        mission: '',
      });

      expect(mockStartStructured).not.toHaveBeenCalled();
      expect(mockPtySpawn).toHaveBeenCalled();
    });

    it('falls back to PTY when mission is undefined in structured mode', async () => {
      await spawnAgent({
        agentId: 'test-structured',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
      });

      expect(mockStartStructured).not.toHaveBeenCalled();
      expect(mockPtySpawn).toHaveBeenCalled();
    });

    it('falls back to PTY when mission is whitespace-only in structured mode', async () => {
      await spawnAgent({
        agentId: 'test-structured',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        mission: '   ',
      });

      expect(mockStartStructured).not.toHaveBeenCalled();
      expect(mockPtySpawn).toHaveBeenCalled();
    });

    it('tracks structured agent and marks it as structured', async () => {
      await spawnAgent({
        agentId: 'test-structured',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        mission: 'test',
      });

      expect(isStructuredAgent('test-structured')).toBe(true);
      expect(isHeadlessAgent('test-structured')).toBe(false);
      expect(getAgentProjectPath('test-structured')).toBe('/project');
    });

    it('passes allowedTools from quick defaults to structured session', async () => {
      await spawnAgent({
        agentId: 'test-structured',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        mission: 'test',
      });

      expect(mockStartStructured).toHaveBeenCalledWith(
        'test-structured',
        mockAdapter,
        expect.objectContaining({
          allowedTools: ['Read', 'Write'],
        }),
        expect.any(Function),
      );
    });

    it('passes explicit allowedTools over defaults to structured session', async () => {
      await spawnAgent({
        agentId: 'test-structured',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        mission: 'test',
        allowedTools: ['Bash(npm:*)'],
      });

      expect(mockStartStructured).toHaveBeenCalledWith(
        'test-structured',
        mockAdapter,
        expect.objectContaining({
          allowedTools: ['Bash(npm:*)'],
        }),
        expect.any(Function),
      );
    });

    it('passes freeAgentMode to structured session opts', async () => {
      await spawnAgent({
        agentId: 'test-structured',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        mission: 'test',
        freeAgentMode: true,
      });

      expect(mockStartStructured).toHaveBeenCalledWith(
        'test-structured',
        mockAdapter,
        expect.objectContaining({
          freeAgentMode: true,
        }),
        expect.any(Function),
      );
    });

    it('passes commandPrefix to structured session opts', async () => {
      mockReadProjectAgentDefaults.mockReturnValue({ commandPrefix: '. ./init.sh' });

      await spawnAgent({
        agentId: 'test-structured',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        mission: 'test',
      });

      expect(mockStartStructured).toHaveBeenCalledWith(
        'test-structured',
        mockAdapter,
        expect.objectContaining({
          commandPrefix: '. ./init.sh',
        }),
        expect.any(Function),
      );
    });

    it('structured onExit callback calls untrackAgent', async () => {
      await spawnAgent({
        agentId: 'test-structured',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        mission: 'test',
      });

      expect(getAgentProjectPath('test-structured')).toBe('/project');

      // Extract and invoke the onExit callback (4th argument, index 3)
      const onExitCallback = mockStartStructured.mock.calls[0][3];
      onExitCallback('test-structured');

      expect(getAgentProjectPath('test-structured')).toBeUndefined();
      expect(getAgentOrchestrator('test-structured')).toBeUndefined();
    });
  });

  describe('clubhouse mode materialization', () => {
    it('calls materializeAgent for durable agents when clubhouse mode is enabled', async () => {
      mockIsClubhouseModeEnabled.mockReturnValue(true);
      mockGetDurableConfig.mockReturnValue({
        id: 'agent-1',
        name: 'agent-1',
        worktreePath: '/project/.clubhouse/agents/agent-1',
      });

      await spawnAgent({
        agentId: 'agent-1',
        projectPath: '/project',
        cwd: '/project',
        kind: 'durable',
      });

      expect(mockMaterializeAgent).toHaveBeenCalledWith({
        projectPath: '/project',
        agent: expect.objectContaining({
          id: 'agent-1',
          worktreePath: '/project/.clubhouse/agents/agent-1',
        }),
        provider: expect.objectContaining({ id: 'claude-code' }),
      });
    });

    it('skips materialization when clubhouse mode is disabled', async () => {
      mockIsClubhouseModeEnabled.mockReturnValue(false);

      await spawnAgent({
        agentId: 'agent-1',
        projectPath: '/project',
        cwd: '/project',
        kind: 'durable',
      });

      expect(mockMaterializeAgent).not.toHaveBeenCalled();
    });

    it('skips materialization for quick agents', async () => {
      mockIsClubhouseModeEnabled.mockReturnValue(true);

      await spawnAgent({
        agentId: 'agent-1',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
      });

      expect(mockMaterializeAgent).not.toHaveBeenCalled();
    });

    it('skips materialization when getDurableConfig returns null', async () => {
      mockIsClubhouseModeEnabled.mockReturnValue(true);
      mockGetDurableConfig.mockReturnValue(null);

      await spawnAgent({
        agentId: 'agent-1',
        projectPath: '/project',
        cwd: '/project',
        kind: 'durable',
      });

      expect(mockMaterializeAgent).not.toHaveBeenCalled();
    });

    it('skips materialization when clubhouseModeOverride is true', async () => {
      mockIsClubhouseModeEnabled.mockReturnValue(true);
      mockGetDurableConfig.mockReturnValue({
        id: 'agent-1',
        name: 'agent-1',
        worktreePath: '/project/.clubhouse/agents/agent-1',
        clubhouseModeOverride: true,
      });

      await spawnAgent({
        agentId: 'agent-1',
        projectPath: '/project',
        cwd: '/project',
        kind: 'durable',
      });

      expect(mockMaterializeAgent).not.toHaveBeenCalled();
    });

    it('skips materialization when config has no worktreePath', async () => {
      mockIsClubhouseModeEnabled.mockReturnValue(true);
      mockGetDurableConfig.mockReturnValue({
        id: 'agent-1',
        name: 'agent-1',
      });

      await spawnAgent({
        agentId: 'agent-1',
        projectPath: '/project',
        cwd: '/project',
        kind: 'durable',
      });

      expect(mockMaterializeAgent).not.toHaveBeenCalled();
    });

    it('continues spawn when materialization throws', async () => {
      mockIsClubhouseModeEnabled.mockReturnValue(true);
      mockGetDurableConfig.mockReturnValue({
        id: 'agent-1',
        name: 'agent-1',
        worktreePath: '/project/.clubhouse/agents/agent-1',
      });
      mockMaterializeAgent.mockImplementation(() => {
        throw new Error('materialization failed');
      });

      // Should not throw — materialization errors are caught
      await spawnAgent({
        agentId: 'agent-1',
        projectPath: '/project',
        cwd: '/project',
        kind: 'durable',
      });

      expect(mockMaterializeAgent).toHaveBeenCalled();
      expect(mockPtySpawn).toHaveBeenCalled();
    });
  });

  describe('killAgent spawn path routing', () => {
    it('kills headless agent via headless-manager', async () => {
      // Spawn a headless agent
      mockGetSpawnMode.mockReturnValue('headless');
      mockProvider.buildHeadlessCommand = vi.fn(() =>
        Promise.resolve({
          binary: '/usr/bin/claude',
          args: ['--headless'],
          env: {},
          outputKind: 'stream-json' as const,
        }),
      );

      await spawnAgent({
        agentId: 'test-headless',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        mission: 'test',
      });

      await killAgent('test-headless', '/project');

      expect(mockHeadlessKill).toHaveBeenCalledWith('test-headless');
      expect(mockPtyGracefulKill).not.toHaveBeenCalled();
      expect(mockCancelSession).not.toHaveBeenCalled();

      // Clean up
      delete (mockProvider as any).buildHeadlessCommand;
    });

    it('kills structured agent via structured-manager', async () => {
      // Spawn a structured agent
      mockGetSpawnMode.mockReturnValue('structured');
      const mockAdapter = { start: vi.fn(), sendMessage: vi.fn(), respondToPermission: vi.fn(), cancel: vi.fn(), dispose: vi.fn() };
      mockProvider.createStructuredAdapter = vi.fn(() => mockAdapter);
      mockProvider.getCapabilities.mockReturnValue({
        headless: true, structuredOutput: true, hooks: true,
        sessionResume: true, permissions: true, structuredMode: true,
      });

      await spawnAgent({
        agentId: 'test-structured',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        mission: 'test',
      });

      await killAgent('test-structured', '/project');

      expect(mockCancelSession).toHaveBeenCalledWith('test-structured');
      expect(mockHeadlessKill).not.toHaveBeenCalled();
      expect(mockPtyGracefulKill).not.toHaveBeenCalled();

      // Clean up
      delete (mockProvider as any).createStructuredAdapter;
    });

    it('kills headless agent detected by headless-manager.isHeadless', async () => {
      mockIsHeadless.mockReturnValue(true);

      await killAgent('ext-headless', '/project');

      expect(mockHeadlessKill).toHaveBeenCalledWith('ext-headless');
      expect(mockPtyGracefulKill).not.toHaveBeenCalled();
    });

    it('kills structured agent detected by structured-manager.isStructuredSession', async () => {
      mockIsStructuredSession.mockReturnValue(true);

      await killAgent('ext-structured', '/project');

      expect(mockCancelSession).toHaveBeenCalledWith('ext-structured');
      expect(mockHeadlessKill).not.toHaveBeenCalled();
      expect(mockPtyGracefulKill).not.toHaveBeenCalled();
    });

    it('untrackAgent is called after killing headless agent', async () => {
      mockGetSpawnMode.mockReturnValue('headless');
      mockProvider.buildHeadlessCommand = vi.fn(() =>
        Promise.resolve({
          binary: '/usr/bin/claude',
          args: ['--headless'],
          env: {},
          outputKind: 'stream-json' as const,
        }),
      );

      await spawnAgent({
        agentId: 'test-headless',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        mission: 'test',
      });

      expect(getAgentProjectPath('test-headless')).toBe('/project');

      await killAgent('test-headless', '/project');

      expect(getAgentProjectPath('test-headless')).toBeUndefined();
      expect(getAgentOrchestrator('test-headless')).toBeUndefined();

      // Clean up
      delete (mockProvider as any).buildHeadlessCommand;
    });

    it('untrackAgent is called after killing structured agent', async () => {
      mockGetSpawnMode.mockReturnValue('structured');
      const mockAdapter = { start: vi.fn(), sendMessage: vi.fn(), respondToPermission: vi.fn(), cancel: vi.fn(), dispose: vi.fn() };
      mockProvider.createStructuredAdapter = vi.fn(() => mockAdapter);
      mockProvider.getCapabilities.mockReturnValue({
        headless: true, structuredOutput: true, hooks: true,
        sessionResume: true, permissions: true, structuredMode: true,
      });

      await spawnAgent({
        agentId: 'test-structured',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        mission: 'test',
      });

      expect(getAgentProjectPath('test-structured')).toBe('/project');

      await killAgent('test-structured', '/project');

      expect(getAgentProjectPath('test-structured')).toBeUndefined();
      expect(getAgentOrchestrator('test-structured')).toBeUndefined();

      // Clean up
      delete (mockProvider as any).createStructuredAdapter;
    });

    it('does not reject when headless kill throws', async () => {
      mockIsHeadless.mockReturnValue(true);
      mockHeadlessKill.mockImplementation(() => { throw new Error('kill failed'); });

      await expect(killAgent('ext-headless', '/project')).resolves.toBeUndefined();
    });

    it('does not reject when structured cancelSession rejects', async () => {
      mockIsStructuredSession.mockReturnValue(true);
      mockCancelSession.mockRejectedValue(new Error('cancel failed'));

      await expect(killAgent('ext-structured', '/project')).resolves.toBeUndefined();
    });

    it('untrackAgent is called even when headless kill throws', async () => {
      mockGetSpawnMode.mockReturnValue('headless');
      mockProvider.buildHeadlessCommand = vi.fn(() =>
        Promise.resolve({
          binary: '/usr/bin/claude',
          args: ['--headless'],
          env: {},
          outputKind: 'stream-json' as const,
        }),
      );

      await spawnAgent({
        agentId: 'test-headless',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        mission: 'test',
      });

      expect(getAgentProjectPath('test-headless')).toBe('/project');

      mockHeadlessKill.mockImplementation(() => { throw new Error('kill failed'); });
      await killAgent('test-headless', '/project');

      // Agent should still be untracked despite kill failure
      expect(getAgentProjectPath('test-headless')).toBeUndefined();
      expect(getAgentOrchestrator('test-headless')).toBeUndefined();

      // Clean up
      delete (mockProvider as any).buildHeadlessCommand;
    });

    it('untrackAgent is called even when structured cancelSession rejects', async () => {
      mockGetSpawnMode.mockReturnValue('structured');
      const mockAdapter = { start: vi.fn(), sendMessage: vi.fn(), respondToPermission: vi.fn(), cancel: vi.fn(), dispose: vi.fn() };
      mockProvider.createStructuredAdapter = vi.fn(() => mockAdapter);
      // Enable structuredMode so isStructuredCapable returns true for spawn
      const origCaps = mockProvider.getCapabilities;
      mockProvider.getCapabilities = vi.fn(() => ({
        headless: true, structuredOutput: true, hooks: true,
        sessionResume: true, permissions: true, structuredMode: true,
      }));

      await spawnAgent({
        agentId: 'test-structured',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        mission: 'test',
      });

      expect(getAgentProjectPath('test-structured')).toBe('/project');

      mockCancelSession.mockRejectedValue(new Error('cancel failed'));
      await killAgent('test-structured', '/project');

      // Agent should still be untracked despite cancel failure
      expect(getAgentProjectPath('test-structured')).toBeUndefined();
      expect(getAgentOrchestrator('test-structured')).toBeUndefined();

      // Clean up
      delete (mockProvider as any).createStructuredAdapter;
      mockProvider.getCapabilities = origCaps;
    });

    it('structured branch takes priority over headless when both match', async () => {
      mockIsStructuredSession.mockReturnValue(true);
      mockIsHeadless.mockReturnValue(true);

      await killAgent('dual-agent', '/project');

      // Structured branch checked first — only cancelSession called
      expect(mockCancelSession).toHaveBeenCalledWith('dual-agent');
      expect(mockHeadlessKill).not.toHaveBeenCalled();
      expect(mockPtyGracefulKill).not.toHaveBeenCalled();
    });
  });

  describe('TOML config cleanup', () => {
    it('calls cleanupStaleJsonInTomlConfigs for TOML-format providers before spawn', async () => {
      await spawnAgent({
        agentId: 'codex-agent-1',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        orchestrator: 'codex-cli',
      });

      expect(mockCleanupStaleJsonInTomlConfigs).toHaveBeenCalledWith(
        '/project',
        mockCodexConventions,
      );
    });

    it('does not call cleanupStaleJsonInTomlConfigs for JSON-format providers', async () => {
      await spawnAgent({
        agentId: 'claude-agent-1',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
      });

      expect(mockCleanupStaleJsonInTomlConfigs).not.toHaveBeenCalled();
    });

    it('continues spawn even if cleanup fails', async () => {
      mockCleanupStaleJsonInTomlConfigs.mockRejectedValueOnce(new Error('cleanup failed'));

      await spawnAgent({
        agentId: 'codex-agent-2',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        orchestrator: 'codex-cli',
      });

      // Spawn should still proceed
      expect(mockPtySpawn).toHaveBeenCalled();
    });
  });

  describe('durable config fallback for agentFile / agentSource', () => {
    it('threads agentFile and agentSource from durable config to buildSpawnCommand', async () => {
      mockGetDurableConfig.mockReturnValue({
        id: 'agent-1',
        name: 'agent-1',
        agentFile: 'k8s-assistant',
        agentSource: '/home/user/.copilot/agents',
      });

      await spawnAgent({
        agentId: 'agent-1',
        projectPath: '/project',
        cwd: '/project',
        kind: 'durable',
      });

      expect(mockProvider.buildSpawnCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          agentFile: 'k8s-assistant',
          agentSource: '/home/user/.copilot/agents',
        }),
      );
    });

    it('does not override caller-provided agentFile with durable config', async () => {
      mockGetDurableConfig.mockReturnValue({
        id: 'agent-1',
        name: 'agent-1',
        agentFile: 'stored-agent',
        agentSource: '/stored/path',
      });

      await spawnAgent({
        agentId: 'agent-1',
        projectPath: '/project',
        cwd: '/project',
        kind: 'durable',
        agentFile: 'caller-agent',
      });

      expect(mockProvider.buildSpawnCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          agentFile: 'caller-agent',
        }),
      );
    });

    it('does not set agentFile/agentSource when durable config has none', async () => {
      mockGetDurableConfig.mockReturnValue({
        id: 'agent-1',
        name: 'agent-1',
      });

      await spawnAgent({
        agentId: 'agent-1',
        projectPath: '/project',
        cwd: '/project',
        kind: 'durable',
      });

      const callArgs = mockProvider.buildSpawnCommand.mock.calls[0][0];
      expect(callArgs.agentFile).toBeUndefined();
      expect(callArgs.agentSource).toBeUndefined();
    });
  });
});
