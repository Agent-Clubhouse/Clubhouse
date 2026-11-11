import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import type { OrchestratorConventions } from '../orchestrators';
import { ATTR } from '../../shared/telemetry/attributes';
import { IPC } from '../../shared/ipc-channels';
import { setProducingRuntime } from '../telemetry/__test-utils__/producing-runtime';
import type { TelemetryRuntime } from '../telemetry/types';
import type { FreeAgentPermissionMode } from '../../shared/types';
import { mcpCallAccess } from './clubhouse-mcp/mcp-call-gate';
import { launchAccessFor, providerAccessLevel, resolveHelperAccess, type AgentLaunchAccess } from '../../shared/orchestration-policy';

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
const mockStopCreatedProcess = vi.fn(() => false);
const mockPtyIsRunning = vi.fn(() => false);
vi.mock('./pty-manager', () => ({
  spawn: (...args: unknown[]) => mockPtySpawn(...args),
  gracefulKill: (...args: unknown[]) => mockPtyGracefulKill(...args),
  stopCreatedProcessIfCurrent: (...args: unknown[]) => mockStopCreatedProcess(...args),
  isRunning: (...args: unknown[]) => mockPtyIsRunning(...args),
}));

// Mock headless-manager
const mockHeadlessSpawn = vi.fn();
const mockHeadlessKill = vi.fn();
const mockIsHeadless = vi.fn(() => false);
vi.mock('./headless-manager', () => ({
  spawnHeadless: (...args: unknown[]) => mockHeadlessSpawn(...args),
  kill: (...args: unknown[]) => mockHeadlessKill(...args),
  isHeadless: (...args: unknown[]) => mockIsHeadless(...args),
  hasPid: () => true,
}));

// Mock headless-settings
const mockGetSpawnMode = vi.fn(() => 'interactive' as const);
vi.mock('./headless-settings', () => ({
  getSpawnMode: (...args: unknown[]) => mockGetSpawnMode(...args),
}));

// Mock hook-server
vi.mock('./hook-server', () => ({
  portEnv: vi.fn(() => ({ CLUBHOUSE_HOOK_PORT: '9999' })),
  waitReady: vi.fn(() => Promise.resolve(12345)),
}));

// The Clubhouse MCP always runs: every spawn asks for the bridge.
const mockEnsureMcpBridge = vi.fn();
vi.mock('./mcp-bridge-starter', () => ({
  ensureMcpBridge: (...args: unknown[]) => mockEnsureMcpBridge(...args),
}));

// The real gate, watched, so a test can see what it held when a nonce was set.
const { mockSetMcpCaller } = vi.hoisted(() => ({ mockSetMcpCaller: vi.fn() }));
vi.mock('./clubhouse-mcp/mcp-call-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./clubhouse-mcp/mcp-call-gate')>();
  return {
    ...actual,
    setMcpCaller: (...args: Parameters<typeof actual.setMcpCaller>) => { mockSetMcpCaller('config', ...args); actual.setMcpCaller(...args); },
    setMcpCallerQuick: (...args: Parameters<typeof actual.setMcpCallerQuick>) => { mockSetMcpCaller('quick', ...args); actual.setMcpCallerQuick(...args); },
    setMcpCallerUnreadable: (...args: Parameters<typeof actual.setMcpCallerUnreadable>) => { mockSetMcpCaller('unreadable', ...args); actual.setMcpCallerUnreadable(...args); },
  };
});

// Mock agent-config
const mockGetDurableConfig = vi.fn(() => null);
const mockAddSessionEntry = vi.fn();
const mockUpdateSessionId = vi.fn(async () => {});
const mockGetSessionHistory = vi.fn(async (): Promise<Array<{ sessionId: string; startedAt: string; lastActiveAt: string }>> => []);
const mockRemoveSessionEntries = vi.fn(async () => {});
const mockContextWindowForLaunch = vi.fn();
vi.mock('./context-window', () => ({
  contextWindowForLaunch: (...args: unknown[]) => mockContextWindowForLaunch(...args),
}));

// Saved provider profiles' old state folders (#2749): none unless a test says so.
const mockRemovedProfileStateDirs = vi.fn(async (_providerId: string): Promise<string[]> => []);
vi.mock('./provider-profiles-removed', () => ({ removedProfileStateDirs: (id: string) => mockRemovedProfileStateDirs(id) }));

vi.mock('./agent-config', () => ({
  getSessionHistory: (...args: unknown[]) => mockGetSessionHistory(...(args as [])),
  removeSessionEntries: (...args: unknown[]) => mockRemoveSessionEntries(...(args as [])),
  getDurableConfig: (...args: unknown[]) => mockGetDurableConfig(...args),
  addSessionEntry: (...args: unknown[]) => mockAddSessionEntry(...args),
  updateSessionId: (...args: unknown[]) => mockUpdateSessionId(...args),
  updateDurableConfig: (...args: unknown[]) => mockUpdateDurableConfig(...args),
}));
const mockUpdateDurableConfig = vi.fn(async () => {});

// One folder stands for the Dispatcher's (#3185).
vi.mock('./dispatcher/dispatcher-paths', async (importOriginal) => ({
  ...await importOriginal<typeof import('./dispatcher/dispatcher-paths')>(),
  isDispatcherPath: (p: string | undefined | null) => p === '/dispatcher-folder',
}));

// Chat start runs for real unless a test stands in for it (to fail a chat resume).
const { mockTryStartChatAgent } = vi.hoisted(() => ({ mockTryStartChatAgent: vi.fn() }));
vi.mock('./agent-runtime/chat-spawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agent-runtime/chat-spawn')>();
  mockTryStartChatAgent.mockImplementation(actual.tryStartChatAgent);
  return { ...actual, tryStartChatAgent: (...args: Parameters<typeof actual.tryStartChatAgent>) => mockTryStartChatAgent(...args) };
});

const mockCleanupStaleJsonInTomlConfigs = vi.fn();
const mockDeliverForSpawn = vi.fn(async () => {});
const mockQuickLaunchFor = vi.fn();
vi.mock('./managed-agents', () => ({
  deliverForSpawn: (...args: unknown[]) => mockDeliverForSpawn(...(args as [])),
  quickLaunchFor: (...args: unknown[]) => mockQuickLaunchFor(...args),
}));
// The automatic switch to managed (D59): null starts the agent as it is. auto-migrate.test covers the switch.
const mockMigrateAtSpawn = vi.fn(async (..._args: unknown[]): Promise<unknown> => null);
vi.mock('./managed-agents/auto-migrate', () => ({
  migrateAtSpawn: (...args: unknown[]) => mockMigrateAtSpawn(...args),
}));

vi.mock('./agent-mcp-servers', () => ({
  resolveProjectMcpServers: vi.fn(async () => ({})),
}));
vi.mock('./toml-config-cleanup', () => ({
  cleanupStaleJsonInTomlConfigs: (...args: unknown[]) => mockCleanupStaleJsonInTomlConfigs(...args),
}));

// Mock agent-settings-service
const mockReadProjectAgentDefaults = vi.fn(() => ({}));
const mockReadLaunchWrapper = vi.fn(() => undefined);
const mockReadDefaultMcps = vi.fn(() => []);
const mockReadMcpConfigs = vi.fn(() => ({}));
vi.mock('./agent-settings-service', () => ({
  UnsupportedPermissionRulesError: class UnsupportedPermissionRulesError extends Error {},
  readProjectAgentDefaults: (...args: unknown[]) => mockReadProjectAgentDefaults(...args),
  readLaunchWrapper: (...args: unknown[]) => mockReadLaunchWrapper(...args),
  readDefaultMcps: (...args: unknown[]) => mockReadDefaultMcps(...args),
  readMcpConfigs: (...args: unknown[]) => mockReadMcpConfigs(...args),
}));

// Mock log-service
const mockAppLog = vi.fn();
vi.mock('./log-service', () => ({
  appLog: (...args: unknown[]) => mockAppLog(...args),
}));

// Mock orchestrators/shared so we can control wrapper validation outcomes
const mockApplyLaunchWrapper = vi.fn(
  (_cfg: unknown, _id: string, binary: string, args: string[], _mcpIds?: string[], _mcpConfigs?: unknown) => ({ binary: '/wrapped/bin', args: ['--wrap', ...args] }),
);
const mockValidateWrapperConfig = vi.fn(() => ({ ok: true as const }));
vi.mock('../orchestrators/shared', () => ({
  applyLaunchWrapper: (...args: unknown[]) => mockApplyLaunchWrapper(...args),
  validateWrapperConfig: (...args: unknown[]) => mockValidateWrapperConfig(...(args as [unknown, string, { isPluginEnabled: (id: string) => boolean }])),
}));

// Mock ipc-broadcast — track AGENT_AWOKE/AGENT_WAKING/etc. broadcasts so tests
// can verify the renderer signal path that flips agent cards from sleeping to
// running.  Without this signal the MCP wake path leaves cards stuck in the
// sleeping mascot view even though the PTY started in main.
const mockBroadcastToAllWindows = vi.fn();
vi.mock('../util/ipc-broadcast', () => ({
  broadcastToAllWindows: (...args: unknown[]) => mockBroadcastToAllWindows(...args),
  setChannelPolicy: vi.fn(),
  clearChannelPolicy: vi.fn(),
  clearAllPolicies: vi.fn(),
  flushAllPending: vi.fn(),
  pendingCount: vi.fn(() => 0),
}));

// Mock fs/promises for readProjectOrchestrator
const mockReadFile = vi.fn(() => Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })));
const mockWriteFile = vi.fn(async (_file: unknown, _content: unknown, _encoding?: unknown) => {});
vi.mock('fs/promises', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
  writeFile: (...args: Parameters<typeof mockWriteFile>) => mockWriteFile(...args),
}));

// The project list, where "Agents run on" is saved (#2975).
const mockPeekProjects = vi.fn(async (): Promise<Array<{ path: string; orchestrator?: string }>> => []);
vi.mock('./project-store', () => ({
  peekProjects: () => mockPeekProjects(),
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
  getCapabilities: vi.fn(() => ({
    headless: true, structuredOutput: true, hooks: true,
    sessionResume: true, permissions: true,
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
    sessionResume: true, permissions: true,
  })),
  // Codex passes its mission as a bare trailing positional argument, so
  // buildSpawnCommand puts it in trailingArgs (see SpawnCommandResult) and
  // buildMcpArgs must be spliced in ahead of it, never appended after.
  buildMcpArgs: vi.fn(() => ['-c', 'mcp_servers.clubhouse.command=node']),
};

const mockCopilotProvider = {
  ...mockProvider,
  id: 'copilot-cli',
  displayName: 'GitHub Copilot CLI',
  shortName: 'GH',
  getCapabilities: vi.fn(() => ({
    headless: false, structuredOutput: false, hooks: false,
    sessionResume: false, permissions: true,
  })),
};

// Mocks for the MCP bridge/injection path exercised when mcpPort > 0.
// Default to the real module's "not started" rejection so existing tests
// (which don't care about MCP injection) keep seeing mcpPort stay 0.
const mockMcpWaitReady = vi.fn(() => Promise.reject(new Error('MCP bridge server not started')));
vi.mock('./clubhouse-mcp/bridge-server', () => ({
  waitReady: (...args: unknown[]) => mockMcpWaitReady(...args),
  NONCE_HEADER: 'X-Clubhouse-Nonce',
  agentEndpointUrl: (port: number, agentId: string) => `http://127.0.0.1:${port}/mcp/${agentId}`,
}));

const mockInjectClubhouseMcp = vi.fn(() => Promise.resolve());
const mockBuildClubhouseMcpDef = vi.fn((port: number) => ({
  command: 'node',
  args: ['bridge.js'],
  env: { CLUBHOUSE_MCP_PORT: String(port) },
}));
vi.mock('./clubhouse-mcp/injection', () => ({
  injectClubhouseMcp: (...args: unknown[]) => mockInjectClubhouseMcp(...args),
  buildClubhouseMcpDef: (...args: unknown[]) => mockBuildClubhouseMcpDef(...args),
  CLUBHOUSE_NONCE_ENV: 'CLUBHOUSE_HOOK_NONCE',
}));

vi.mock('../orchestrators', () => ({
  getProvider: vi.fn((id: string) => {
    if (id === 'claude-code') return mockProvider;
    if (id === 'codex-cli') return mockCodexProvider;
    if (id === 'copilot-cli') return mockCopilotProvider;
    return undefined;
  }),
  getAllProviders: vi.fn(() => [mockProvider, mockCodexProvider]),
  isHookCapable: vi.fn((p: any) => p.getCapabilities().hooks && typeof p.writeHooksConfig === 'function'),
  isHeadlessCapable: vi.fn((p: any) => p.getCapabilities().headless && typeof p.buildHeadlessCommand === 'function'),
  isSessionCapable: vi.fn((p: any) => p.getCapabilities().sessionResume && typeof p.listSessions === 'function'),
  isAgentFileCapable: vi.fn((p: any) => typeof p.buildAgentFileArgs === 'function'),
}));

// Per-orchestrator hook server gating. Defaults to enabled so existing
// injection assertions hold; individual tests override it to exercise the gate.
const mockIsHookServerEnabled = vi.fn(() => true);
vi.mock('./orchestrator-settings', () => ({
  isHookServerEnabled: (...args: unknown[]) => mockIsHookServerEnabled(...(args as [])),
}));

// The project's free-agent permission mode: skip-all, the shipped default.
const mockGetPermissionMode = vi.fn((): FreeAgentPermissionMode => 'skip-all');
vi.mock('./free-agent-settings', () => ({
  getPermissionMode: (...args: unknown[]) => mockGetPermissionMode(...(args as [])),
}));

// A helper's ceiling: the real ranking against `orchestratorLive` (undefined
// when the orchestrator isn't running), as resolveHelperLaunchSettings does.
let orchestratorLive: AgentLaunchAccess | undefined;
const mockResolveHelperLaunchSettings = vi.fn(
  async (_projectPath: string, _orchestratorId: string, options: { helperProvider?: string } = {}) =>
    resolveHelperAccess(orchestratorLive, 'same', options.helperProvider),
);
// A helper's parent, in parentProjectPath when set (#2513), else the helper's project.
const mockFindParent = vi.fn(
  async (helperPath: string, helper: { parentAgentId?: string; parentProjectPath?: string }) =>
    helper.parentAgentId ? { projectPath: helper.parentProjectPath || helperPath, config: { id: helper.parentAgentId } } : null,
);
vi.mock('./helper-index', () => ({
  findParent: (...args: Parameters<typeof mockFindParent>) => mockFindParent(...args),
}));
vi.mock('./orchestration-policy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./orchestration-policy')>()),
  resolveHelperLaunchSettings: (...args: Parameters<typeof mockResolveHelperLaunchSettings>) => mockResolveHelperLaunchSettings(...args),
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
  isAgentRunning,
  getRunningAgentIds,
  expandHome,
  listSessions,
  RESUME_BLOCKED_NOTICE,
  spawnAccess,
  withDispatcherStartModel,
} from './agent-system';
import * as os from 'os';
import { broadcastAgentExit } from './agent-exit-broadcast';
import { agentRegistry } from './agent-registry';
import { resolveProjectMcpServers } from './agent-mcp-servers';

/** Give a mock provider the SessionCapable surface, with the real CLIs' "resume <uuid>" pattern. */
function sessionCapable(provider: Record<string, unknown>): void {
  provider.listSessions = vi.fn(async () => []);
  provider.readSessionTranscript = vi.fn(async () => null);
  provider.extractSessionId = vi.fn((buffer: string) => buffer.match(/resume[:\s]+([0-9a-f-]{36})/i)?.[1] ?? null);
}

function notSessionCapable(provider: Record<string, unknown>): void {
  delete provider.listSessions;
  delete provider.readSessionTranscript;
  delete provider.extractSessionId;
  delete provider.findRunSession;
  delete provider.hasSession;
  delete provider.hasSessionForCwd;
  delete provider.hasSessionInStore;
}

describe('agent-system', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPeekProjects.mockReset().mockResolvedValue([]);
    mockHeadlessSpawn.mockImplementation((agentId: string) => {
      mockIsHeadless.mockImplementation((trackedAgentId: string) => trackedAgentId === agentId);
    });
    mockHeadlessKill.mockImplementation((agentId: string) => {
      mockIsHeadless.mockImplementation((trackedAgentId: string) => trackedAgentId !== agentId);
    });
  });

  afterEach(() => {
    notSessionCapable(mockProvider);
    notSessionCapable(mockCodexProvider);
    // Clean up tracked agents
    untrackAgent('test-agent');
    untrackAgent('agent-1');
    untrackAgent('test-headless');
    mockIsHeadless.mockReturnValue(false);
  });

  describe('resolveOrchestrator', () => {
    it('uses agent-level override when provided', async () => {
      const provider = await resolveOrchestrator('/project', 'codex-cli');
      expect(provider.id).toBe('codex-cli');
    });

    it('falls back to project-level setting', async () => {
      mockPeekProjects.mockResolvedValueOnce([{ path: '/project', orchestrator: 'codex-cli' }]);
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
    it('refuses to launch while the app shuts down (#2053)', async () => {
      const { closeLaunches, reopenLaunches, LaunchesClosedError } = await import('./launch-gate');
      closeLaunches('quitting');
      try {
        await expect(spawnAgent({ agentId: 'agent-1', projectPath: '/my/project', cwd: '/my/project', kind: 'durable' }))
          .rejects.toBeInstanceOf(LaunchesClosedError);
        expect(mockPtySpawn).not.toHaveBeenCalled();
        expect(getAgentProjectPath('agent-1')).toBeUndefined();
      } finally {
        reopenLaunches();
      }
    });

    it('a spawn already past the entry check doesn\'t start its terminal once shutdown closed launches', async () => {
      const { closeLaunches, reopenLaunches, LaunchesClosedError } = await import('./launch-gate');
      const { whenSpawnsSettled } = await import('./agent-system');
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      // Quit lands while the spawn reads the agent's config.
      mockGetDurableConfig.mockImplementationOnce((async () => { await gate; return null; }) as never);
      const spawn = spawnAgent({ agentId: 'agent-1', projectPath: '/my/project', cwd: '/my/project', kind: 'durable' });
      let settled = false;
      const drained = whenSpawnsSettled().then(() => { settled = true; });
      try {
        closeLaunches('quitting');
        await new Promise((r) => setTimeout(r, 0));
        expect(settled).toBe(false);
        release();
        await expect(spawn).rejects.toBeInstanceOf(LaunchesClosedError);
        await drained;
        expect(mockPtySpawn).not.toHaveBeenCalled();
      } finally {
        reopenLaunches();
      }
    });

    it('never starts a disposed helper (#2224)', async () => {
      mockGetDurableConfig.mockImplementation((async () => ({
        id: 'agent-1', name: 'gone', color: 'blue', createdAt: 'x', disposedAt: '2026-10-18T00:00:00.000Z',
      })) as never);
      await expect(spawnAgent({ agentId: 'agent-1', projectPath: '/my/project', cwd: '/my/project', kind: 'durable' }))
        .rejects.toThrow(/disposed/);
      expect(mockPtySpawn).not.toHaveBeenCalled();
      expect(getAgentProjectPath('agent-1')).toBeUndefined();
      mockGetDurableConfig.mockReset();
    });

    it('tracks agent project path', async () => {
      await spawnAgent({
        agentId: 'agent-1',
        projectPath: '/my/project',
        cwd: '/my/project',
        kind: 'durable',
      });
      expect(getAgentProjectPath('agent-1')).toBe('/my/project');
    });

    describe('a saved context choice in a terminal (#2660)', () => {
      const notices = () => mockBroadcastToAllWindows.mock.calls.filter((c) => c[0] === IPC.CHAT.RUNTIME_NOTICE);
      const spawnWith = async () => {
        mockBroadcastToAllWindows.mockClear();
        mockGetDurableConfig.mockResolvedValue({ id: 'agent-1', orchestrator: 'claude-code', contextWindow: '500000' });
        await spawnAgent({ agentId: 'agent-1', projectPath: '/my/project', cwd: '/my/project', kind: 'durable' });
      };
      afterEach(() => { mockContextWindowForLaunch.mockReset(); mockGetDurableConfig.mockReset(); });

      it.each([
        ['refused', 'Started without the saved context choice, and cleared it. Not offered.'],
        ['unknown', 'Started without the saved context choice. No catalog.'],
      ])('says so when the choice is %s, and passes no flag', async (_state, message) => {
        const notice = { level: 'warn', code: 'context_window_not_applied', message };
        mockContextWindowForLaunch.mockResolvedValue({ notice });
        await spawnWith();
        expect(notices()).toEqual([[IPC.CHAT.RUNTIME_NOTICE, 'agent-1', notice]]);
        expect(mockPtySpawn).toHaveBeenCalled();
      });

      it('says nothing when the choice applies', async () => {
        mockContextWindowForLaunch.mockResolvedValue({ value: '500000' });
        await spawnWith();
        expect(notices()).toEqual([]);
      });
    });

    describe('a saved effort next to a saved context choice (#2671)', () => {
      const spawnWith = async () => {
        mockGetDurableConfig.mockResolvedValue({ id: 'agent-1', orchestrator: 'claude-code', effort: 'high', contextWindow: '500000' });
        await spawnAgent({ agentId: 'agent-1', projectPath: '/my/project', cwd: '/my/project', kind: 'durable' });
      };
      afterEach(() => { mockContextWindowForLaunch.mockReset(); mockGetDurableConfig.mockReset(); });

      it('passes both when the choice applies', async () => {
        mockContextWindowForLaunch.mockResolvedValue({ value: '500000' });
        await spawnWith();
        expect(mockProvider.buildSpawnCommand).toHaveBeenLastCalledWith(expect.objectContaining({ effort: 'high', contextWindow: '500000' }));
      });

      it('still passes the effort when the launch doesn\'t use the choice', async () => {
        mockContextWindowForLaunch.mockResolvedValue({ notice: { level: 'warn', code: 'context_window_not_applied', message: 'Not offered.' } });
        await spawnWith();
        const opts = (mockProvider.buildSpawnCommand as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
        expect(opts.effort).toBe('high');
        expect(opts.contextWindow).toBeUndefined();
      });
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

    it('tracks the project-level orchestrator from the project list', async () => {
      mockPeekProjects.mockResolvedValue([{ path: '/my/project', orchestrator: 'codex-cli' }]);
      await spawnAgent({
        agentId: 'agent-1',
        projectPath: '/my/project',
        cwd: '/my/project',
        kind: 'durable',
      });
      expect(getAgentOrchestrator('agent-1')).toBe('codex-cli');
    });

    it.each([false, true])('repairs version-only Copilot hooks before terminal launch with hook server %s', async (enabled) => {
      mockIsHookServerEnabled.mockReturnValue(enabled);
      const cwd = path.resolve('copilot-project');
      const file = path.join(cwd, '.github', 'hooks', 'hooks.json');
      let contents = '{"version":1}';
      mockReadFile.mockImplementation(async (target: unknown) => {
        if (target === file) return contents;
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      mockWriteFile.mockImplementation(async (target, value) => {
        expect(target).toBe(file);
        contents = String(value);
      });
      try {
        await spawnAgent({ agentId: 'agent-1', projectPath: cwd, cwd, kind: 'durable', orchestrator: 'copilot-cli' });
        expect(JSON.parse(contents)).toEqual({ version: 1, hooks: {} });
        expect(mockWriteFile).toHaveBeenCalledTimes(1);
        expect(mockPtySpawn).toHaveBeenCalled();
      } finally {
        mockReadFile.mockReset().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        mockWriteFile.mockReset();
      }
    });

    it.each([false, true])('refuses an ambiguous Copilot hook document before launch with hook server %s', async (enabled) => {
      mockIsHookServerEnabled.mockReturnValue(enabled);
      const hookFile = path.join('/project', '.github', 'hooks', 'hooks.json');
      mockReadFile.mockImplementation(async (file: unknown) => {
        // Permissions beside other content still needs review; permissions alone is moved aside (#2866).
        if (file === hookFile) return JSON.stringify({ version: 1, hooks: {}, permissions: { allow: ['Read'] } });
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      try {
        await expect(spawnAgent({ agentId: 'agent-1', projectPath: '/project', cwd: '/project', kind: 'durable', orchestrator: 'copilot-cli' }))
          .rejects.toThrow(/repair.*restart/i);
        expect(mockReadFile).toHaveBeenCalledWith(hookFile, 'utf-8');
        expect(mockPtySpawn).not.toHaveBeenCalled();
        expect(mockTryStartChatAgent).not.toHaveBeenCalled();
      } finally {
        mockReadFile.mockReset().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      }
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

    it('does NOT write hooks config when the orchestrator hook server is disabled', async () => {
      mockIsHookServerEnabled.mockReturnValueOnce(false);
      await spawnAgent({
        agentId: 'agent-1',
        projectPath: '/project',
        cwd: '/project',
        kind: 'durable',
      });
      expect(mockProvider.writeHooksConfig).not.toHaveBeenCalled();
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

    it('starts on the provider\'s own environment when old settings still name a profile (#2749)', async () => {
      mockReadProjectAgentDefaults.mockReturnValue({ profileId: 'work' } as never);
      try {
        await spawnAgent({ agentId: 'agent-1', projectPath: '/project', cwd: '/project/worktree', kind: 'durable' });
        expect(mockProvider.checkAvailability).toHaveBeenCalledWith();
        const env = mockPtySpawn.mock.calls.at(-1)![4] as Record<string, string>;
        expect(env).toMatchObject({ CLUBHOUSE_AGENT_ID: 'agent-1' });
        expect(env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
      } finally {
        mockReadProjectAgentDefaults.mockReturnValue({});
      }
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

    it('pre-allows only reading tools for a quick agent below Auto-accept edits (#3007)', async () => {
      const toolsFor = async (extra: Record<string, unknown>) => {
        await spawnAgent({ agentId: 'agent-q', projectPath: '/project', cwd: '/project', kind: 'quick', ...extra });
        const opts = mockProvider.buildSpawnCommand.mock.calls.at(-1)![0] as { allowedTools?: string[] };
        untrackAgent('agent-q');
        return opts.allowedTools;
      };
      expect(await toolsFor({})).toEqual(['Read']);
      expect(await toolsFor({ access: 'auto_edit' })).toEqual(['Read', 'Write']);
      expect(await toolsFor({ access: 'full_access' })).toEqual(['Read', 'Write']);
      // Tools passed explicitly stay as given.
      expect(await toolsFor({ allowedTools: ['Bash(make:*)'] })).toEqual(['Bash(make:*)']);
      // Copilot runs a terminal quick agent one-shot and can't ask: it keeps its defaults.
      const provider = mockProvider as { id: string };
      provider.id = 'copilot-cli';
      try {
        expect(await toolsFor({})).toEqual(['Read', 'Write']);
      } finally {
        provider.id = 'claude-code';
      }
    });

    describe('a saved effort (#2671)', () => {
      afterEach(() => {
        mockGetDurableConfig.mockReset();
        mockGetDurableConfig.mockImplementation(() => null);
      });
      const spawnWith = (config: Record<string, unknown> | null, extra: Record<string, unknown> = {}) => {
        mockGetDurableConfig.mockImplementation((async () => (config && { id: 'agent-1', ...config })) as never);
        return spawnAgent({ agentId: 'agent-1', projectPath: '/project', cwd: '/project', kind: 'durable', ...extra });
      };

      it('reaches the provider on a start and on a resume', async () => {
        await spawnWith({ effort: 'high' });
        expect(mockProvider.buildSpawnCommand).toHaveBeenLastCalledWith(expect.objectContaining({ effort: 'high' }));
        await spawnWith({ effort: 'high', lastSessionId: 's1' }, { resume: true, sessionId: 's1' });
        expect(mockProvider.buildSpawnCommand).toHaveBeenLastCalledWith(expect.objectContaining({ effort: 'high', resume: true }));
      });

      it('passes none without one', async () => {
        await spawnWith({});
        expect(mockProvider.buildSpawnCommand).toHaveBeenLastCalledWith(expect.objectContaining({ effort: undefined }));
      });

      it('never passes a hand-edited value that can\'t be a level', async () => {
        await spawnWith({ effort: 'high; rm -rf /' });
        expect(mockProvider.buildSpawnCommand).toHaveBeenLastCalledWith(expect.objectContaining({ effort: undefined }));
      });
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

    it.each([['durable', true], ['quick', false]] as const)('asks the provider for an interactive session only for %s agents', async (kind, interactive) => {
      await spawnAgent({ agentId: 'agent-1', projectPath: '/project', cwd: '/project', kind, mission: 'Go' });
      expect(mockProvider.buildSpawnCommand).toHaveBeenCalledWith(expect.objectContaining({ mission: 'Go', interactive }));
    });

    it('asks for an interactive session for a quick agent someone follows (#3002)', async () => {
      await spawnAgent({ agentId: 'agent-1', projectPath: '/project', cwd: '/project', kind: 'quick', mission: 'Go', interactive: true });
      expect(mockProvider.buildSpawnCommand).toHaveBeenCalledWith(expect.objectContaining({ mission: 'Go', interactive: true }));
    });

    it('starts the Dispatcher without the CLI\'s desktop control, in chat and the terminal (#3185)', async () => {
      const off = vi.fn(() => ['--disable', 'plugins']);
      Object.assign(mockProvider, { desktopControlOffArgs: off });
      try {
        await spawnAgent({ agentId: 'agent-1', projectPath: '/project', cwd: '/project', kind: 'quick', mission: 'Go' });
        expect(mockTryStartChatAgent.mock.calls.at(-1)![0]).not.toHaveProperty('extraArgs');
        expect(mockProvider.buildSpawnCommand.mock.calls.at(-1)![0]).not.toHaveProperty('noDesktopControl');
        await spawnAgent({ agentId: 'agent-2', projectPath: '/dispatcher-folder', cwd: '/dispatcher-folder', kind: 'quick', mission: 'Go' });
        expect(mockTryStartChatAgent.mock.calls.at(-1)![0]).toMatchObject({ extraArgs: ['--disable', 'plugins'] });
        expect(mockProvider.buildSpawnCommand).toHaveBeenLastCalledWith(expect.objectContaining({ noDesktopControl: true }));
      } finally {
        delete (mockProvider as { desktopControlOffArgs?: unknown }).desktopControlOffArgs;
      }
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

    it('counts a failed pre-flight as a spawn with error.type preflight_failed', async () => {
      const count = vi.fn();
      setProducingRuntime({
        level: 'standard',
        flow: (_n: string, _o: unknown, fn: (s: unknown) => unknown) => fn({ set: () => {} }),
        step: (_n: string, fn: (s: unknown) => unknown) => fn({ set: () => {} }),
        count,
      } as unknown as TelemetryRuntime);
      try {
        mockProvider.checkAvailability.mockResolvedValueOnce({ available: false, error: 'not installed' });
        await expect(spawnAgent({ agentId: 'agent-1', projectPath: '/project', cwd: '/project', kind: 'quick' })).rejects.toThrow();
        expect(count).toHaveBeenCalledWith('clubhouse.agent.spawns', 1, [
          // No runtime yet: the spawn failed before choosing one.
          ATTR.agentKind('quick'), ATTR.orchestrator('claude-code'),
          ATTR.outcome('error'), ATTR.errorType('preflight_failed'),
        ]);
      } finally {
        setProducingRuntime(null);
      }
    });

    it('records a cancelled chat start as a cancelled chat.start span, and opens nothing (#2304)', async () => {
      const replaySpan = vi.fn();
      const event = vi.fn();
      setProducingRuntime({
        level: 'standard',
        flow: (_n: string, _o: unknown, fn: (s: unknown) => unknown) => fn({ set: () => {} }),
        step: (_n: string, fn: (s: unknown) => unknown) => fn({ set: () => {} }),
        count: vi.fn(),
        replaySpan,
        event,
      } as unknown as TelemetryRuntime);
      const realStart = mockTryStartChatAgent.getMockImplementation()!;
      mockTryStartChatAgent.mockImplementationOnce(async (...args: unknown[]) => {
        (args[4] as () => void)();
        Object.assign(args[5] as object, { attempts: [{ driver: 'claude_agent_sdk', checkMs: 5 }], reason: 'killed' });
        return 'cancelled';
      });
      try {
        await spawnAgent({ agentId: 'agent-1', projectPath: '/project', cwd: '/project', kind: 'durable' });
        expect(mockPtySpawn).not.toHaveBeenCalled();
        const span = replaySpan.mock.calls.map((c) => c[0]).find((sp: { name: string }) => sp.name === 'clubhouse.chat.start');
        expect(span).toMatchObject({ outcome: 'cancelled' });
        expect(span.attrs).toEqual(expect.arrayContaining([
          ATTR.chatStartResult('cancelled'), ATTR.chatStartReason('killed'), ATTR.orchestrator('claude-code'), ATTR.agentResume(false),
        ]));
        expect(event.mock.calls.map((c) => c[0])).not.toContain('clubhouse.chat.fallback');
      } finally {
        mockTryStartChatAgent.mockImplementation(realStart);
        setProducingRuntime(null);
      }
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

    it.each([
      [undefined, 'auto'],
      ['ask', 'auto'],
      ['full_access', 'skip-all'],
    ] as const)('a headless quick agent at %s runs with mode %s, never skipping prompts below Full access (#2761)', async (access, mode) => {
      mockGetSpawnMode.mockReturnValue('headless');
      mockGetPermissionMode.mockReturnValue('skip-all');
      mockProvider.buildHeadlessCommand = vi.fn(() => Promise.resolve(null)) as never;
      await spawnAgent({ agentId: 'hq', projectPath: '/project', cwd: '/project', kind: 'quick', mission: 'm', ...(access && { access }) }).catch(() => {});
      expect(mockProvider.buildHeadlessCommand).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: mode }));
      delete (mockProvider as any).buildHeadlessCommand;
      untrackAgent('hq');
    });

    it('runs an unattended quick agent headless even when the project starts quick agents in a terminal (#3033)', async () => {
      mockGetSpawnMode.mockReturnValue('interactive');
      mockProvider.buildHeadlessCommand = vi.fn(() =>
        Promise.resolve({ binary: '/usr/bin/claude', args: ['-p'], env: {}, outputKind: 'stream-json' as const }),
      ) as never;
      await spawnAgent({ agentId: 'unattended', projectPath: '/project', cwd: '/project', kind: 'quick', mission: 'm', access: 'full_access', headless: true });
      expect(mockProvider.buildHeadlessCommand).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'skip-all' }));
      expect(mockHeadlessSpawn).toHaveBeenCalled();
      expect(mockPtySpawn).not.toHaveBeenCalled();
      delete (mockProvider as any).buildHeadlessCommand;
      untrackAgent('unattended');
    });

    it('fails an unattended quick agent rather than open a terminal when it has no headless run (#3033)', async () => {
      mockGetSpawnMode.mockReturnValue('interactive');
      mockProvider.buildHeadlessCommand = vi.fn(() => Promise.resolve(null)) as never;
      await expect(
        spawnAgent({ agentId: 'unattended', projectPath: '/project', cwd: '/project', kind: 'quick', mission: 'm', access: 'full_access', headless: true }),
      ).rejects.toThrow('Claude Code can’t run without a window, so this quick agent can’t start unattended.');
      expect(mockPtySpawn).not.toHaveBeenCalled();
      expect(getAgentProjectPath('unattended')).toBeUndefined();
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

    // Regression guard for Wave 10 #10: the MCP wake_agent path used to leave
    // agent cards stuck in the sleeping mascot view because nothing flipped
    // status from 'waking' → 'running'.  The renderer now subscribes to
    // AGENT_AWOKE; spawnAgent must broadcast it on every successful path so
    // any caller (renderer IPC, MCP tool, plugin) converges on the same state.
    it('broadcasts AGENT_AWOKE after a successful PTY spawn', async () => {
      mockBroadcastToAllWindows.mockClear();
      await spawnAgent({
        agentId: 'agent-1',
        projectPath: '/project',
        cwd: '/project',
        kind: 'durable',
      });
      expect(mockBroadcastToAllWindows).toHaveBeenCalledWith('agent:agent-awoke', 'agent-1');
    });

    it('does not broadcast AGENT_AWOKE when spawn fails', async () => {
      mockBroadcastToAllWindows.mockClear();
      mockProvider.buildSpawnCommand.mockRejectedValueOnce(new Error('boom'));
      await expect(
        spawnAgent({
          agentId: 'agent-1',
          projectPath: '/project',
          cwd: '/project',
          kind: 'durable',
        })
      ).rejects.toThrow('boom');
      expect(mockBroadcastToAllWindows).not.toHaveBeenCalledWith('agent:agent-awoke', 'agent-1');
    });

    it('broadcasts AGENT_AWOKE after a successful headless spawn', async () => {
      mockBroadcastToAllWindows.mockClear();
      mockGetSpawnMode.mockReturnValueOnce('headless');
      const mockBuildHeadlessCommand = vi.fn(() => Promise.resolve({
        binary: '/usr/local/bin/claude',
        args: ['-p', 'mission'],
        env: {},
        outputKind: 'stream-json' as const,
      }));
      (mockProvider as any).buildHeadlessCommand = mockBuildHeadlessCommand;
      try {
        await spawnAgent({
          agentId: 'agent-1',
          projectPath: '/project',
          cwd: '/project',
          kind: 'quick',
          mission: 'do thing',
        });
        expect(mockBroadcastToAllWindows).toHaveBeenCalledWith('agent:agent-awoke', 'agent-1');
      } finally {
        delete (mockProvider as any).buildHeadlessCommand;
      }
    });
  });

  describe('MCP nonce stays in the CLI env (#2222)', () => {
    it('headless quick agent gets its own nonce and identity in its spawn env', async () => {
      mockGetSpawnMode.mockReturnValueOnce('headless');
      mockMcpWaitReady.mockResolvedValueOnce(23456);
      const headlessProvider = mockProvider as unknown as { buildHeadlessCommand?: unknown };
      headlessProvider.buildHeadlessCommand = vi.fn(() => Promise.resolve({
        binary: '/usr/local/bin/claude', args: ['-p', 'mission'], env: {}, outputKind: 'stream-json' as const,
      }));
      try {
        await spawnAgent({ agentId: 'quick-1', projectPath: '/project', cwd: '/project/parent-wt', kind: 'quick', mission: 'do thing' });
        const nonce = getAgentNonce('quick-1');
        expect(nonce).toMatch(/^[0-9a-f-]{36}$/);
        const env = mockHeadlessSpawn.mock.calls.at(-1)![4] as Record<string, string>;
        expect(env).toMatchObject({ CLUBHOUSE_AGENT_ID: 'quick-1', CLUBHOUSE_HOOK_NONCE: nonce, CLUBHOUSE_MCP_PORT: '23456' });
      } finally {
        delete headlessProvider.buildHeadlessCommand;
      }
    });

    it.each([
      ['claude-code', undefined],
      ['codex-cli', 'codex-cli'],
    ] as const)('%s PTY: the nonce is in the spawn env, not in the config or argv', async (_label, orchestrator) => {
      mockMcpWaitReady.mockResolvedValueOnce(23456);
      await spawnAgent({
        agentId: 'agent-1',
        projectPath: '/project',
        cwd: '/project/worktree',
        kind: 'durable',
        ...(orchestrator ? { orchestrator } : {}),
      });
      const nonce = getAgentNonce('agent-1')!;
      expect(nonce).toBeTruthy();
      const [, , , args, env] = mockPtySpawn.mock.calls[0] as unknown as [string, string, string, string[], Record<string, string>];
      expect(env).toMatchObject({ CLUBHOUSE_AGENT_ID: 'agent-1', CLUBHOUSE_HOOK_NONCE: nonce, CLUBHOUSE_MCP_PORT: '23456' });
      expect(args.join(' ')).not.toContain(nonce);
      // injectClubhouseMcp(cwd, agentId, port, conventions): no nonce argument.
      expect(mockInjectClubhouseMcp).toHaveBeenCalledTimes(1);
      const injectArgs = (mockInjectClubhouseMcp.mock.calls[0] as unknown[]);
      expect(injectArgs.slice(0, 3)).toEqual(['/project/worktree', 'agent-1', 23456]);
      // Nothing decides whether it's injected: every agent gets the bridge.
      expect(injectArgs).toHaveLength(4);
      expect(JSON.stringify(injectArgs)).not.toContain(nonce);
      // Codex takes MCP servers as `-c` launch flags built from this definition.
      if (orchestrator === 'codex-cli') expect(mockBuildClubhouseMcpDef).toHaveBeenCalled();
      for (const call of mockBuildClubhouseMcpDef.mock.calls as unknown[][]) {
        expect(call).toEqual([23456, 'agent-1']);
      }
    });
  });

  describe('CLUBHOUSE_MCP_PORT follows this bridge, not the base env (#2620)', () => {
    const spawnHeadless = async () => {
      mockGetSpawnMode.mockReturnValueOnce('headless');
      const headlessProvider = mockProvider as unknown as { buildHeadlessCommand?: unknown };
      headlessProvider.buildHeadlessCommand = vi.fn(() => Promise.resolve({
        binary: '/usr/local/bin/claude', args: ['-p', 'mission'], env: { CLUBHOUSE_MCP_PORT: '40001' }, outputKind: 'stream-json' as const,
      }));
      try {
        await spawnAgent({ agentId: 'quick-1', projectPath: '/project', cwd: '/project/wt', kind: 'quick', mission: 'do thing' });
      } finally {
        delete headlessProvider.buildHeadlessCommand;
      }
      return mockHeadlessSpawn.mock.calls.at(-1)![4] as Record<string, string>;
    };
    const spawnPty = async () => {
      (mockProvider.buildSpawnCommand as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        binary: '/usr/local/bin/claude', args: [], env: { CLUBHOUSE_MCP_PORT: '40001' },
      });
      await spawnAgent({ agentId: 'agent-1', projectPath: '/project', cwd: '/project/wt', kind: 'durable' });
      return mockPtySpawn.mock.calls.at(-1)![4] as unknown as Record<string, string>;
    };

    it.each([['headless', spawnHeadless], ['PTY', spawnPty]] as const)('%s: removed when there is no bridge', async (_label, spawn) => {
      const env = await spawn();
      expect(env).not.toHaveProperty('CLUBHOUSE_MCP_PORT');
      expect(env.CLUBHOUSE_HOOK_NONCE).toBeTruthy();
    });

    it.each([['headless', spawnHeadless], ['PTY', spawnPty]] as const)('%s: the bridge\'s port wins when there is one', async (_label, spawn) => {
      mockMcpWaitReady.mockResolvedValueOnce(23456);
      expect((await spawn()).CLUBHOUSE_MCP_PORT).toBe('23456');
    });
  });

  describe('MCP arg injection ordering (spawnPtyAgent)', () => {
    it('inserts buildMcpArgs output before trailingArgs so a positional mission stays last', async () => {
      mockMcpWaitReady.mockResolvedValueOnce(23456);
      (mockCodexProvider.buildSpawnCommand as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        binary: '/usr/local/bin/codex',
        args: ['--full-auto'],
        trailingArgs: ['Fix the bug'],
      });

      await spawnAgent({
        agentId: 'agent-1',
        projectPath: '/project',
        cwd: '/project',
        kind: 'durable',
        orchestrator: 'codex-cli',
        mission: 'Fix the bug',
      });

      expect(mockPtySpawn).toHaveBeenCalledWith(
        'agent-1',
        '/project',
        '/usr/local/bin/codex',
        ['--full-auto', '-c', 'mcp_servers.clubhouse.command=node', 'Fix the bug'],
        expect.anything(),
        expect.any(Function),
        undefined,
      );
    });

    it('appends nothing extra when the provider has no trailingArgs', async () => {
      mockMcpWaitReady.mockResolvedValueOnce(23456);
      (mockCodexProvider.buildSpawnCommand as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        binary: '/usr/local/bin/codex',
        args: ['--full-auto'],
      });

      await spawnAgent({
        agentId: 'agent-1',
        projectPath: '/project',
        cwd: '/project',
        kind: 'durable',
        orchestrator: 'codex-cli',
      });

      expect(mockPtySpawn).toHaveBeenCalledWith(
        'agent-1',
        '/project',
        '/usr/local/bin/codex',
        ['--full-auto', '-c', 'mcp_servers.clubhouse.command=node'],
        expect.anything(),
        expect.any(Function),
        undefined,
      );
    });
  });

  describe('the Clubhouse MCP for every agent (#2610)', () => {
    const spawn = () => spawnAgent({ agentId: 'agent-1', projectPath: '/project', cwd: '/project', kind: 'durable', orchestrator: 'codex-cli' });
    const withConfig = (config: Record<string, unknown>) =>
      mockGetDurableConfig.mockImplementation((async () => ({ id: 'agent-1', ...config })) as never);
    const flagsFromBuild = () => (mockCodexProvider.buildMcpArgs as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined;

    beforeEach(() => {
      mockEnsureMcpBridge.mockClear();
      (mockCodexProvider.buildMcpArgs as ReturnType<typeof vi.fn>).mockClear();
      mockInjectClubhouseMcp.mockClear();
      mockPtySpawn.mockClear();
      mockMcpWaitReady.mockResolvedValue(23456);
      (mockCodexProvider.buildSpawnCommand as ReturnType<typeof vi.fn>).mockResolvedValue({ binary: '/usr/local/bin/codex', args: ['--full-auto'] });
      vi.mocked(resolveProjectMcpServers).mockResolvedValue({ github: { command: 'gh' } } as never);
    });

    afterEach(() => {
      mockGetDurableConfig.mockReset();
      mockGetDurableConfig.mockImplementation(() => null);
      mockMcpWaitReady.mockReset();
      mockMcpWaitReady.mockImplementation(() => Promise.reject(new Error('MCP bridge server not started')));
      vi.mocked(resolveProjectMcpServers).mockReset();
      vi.mocked(resolveProjectMcpServers).mockResolvedValue({});
      (mockCodexProvider.buildSpawnCommand as ReturnType<typeof vi.fn>).mockReset();
      untrackAgent('agent-1');
    });

    it.each([
      ['a plain agent', {}],
      ['a helper', { parentAgentId: 'orch-1' }],
      ['an agent with a saved mcpOverride false from before', { mcpOverride: false }],
    ])('gives %s the bridge and its project servers', async (_label, own) => {
      withConfig(own);
      await spawn();
      expect(mockEnsureMcpBridge).toHaveBeenCalled();
      expect(mockInjectClubhouseMcp).toHaveBeenCalledTimes(1);
      expect(Object.keys(flagsFromBuild()!).sort()).toEqual(['clubhouse', 'github']);
    });

    it('tells the person through the setup notice when project MCP servers were left out (D10)', async () => {
      withConfig({});
      vi.mocked(resolveProjectMcpServers).mockImplementation((async (_p: string, _a: unknown, onNotice?: (m: string) => void) => {
        onNotice?.('left out');
        return {};
      }) as never);
      mockBroadcastToAllWindows.mockClear();
      await spawn();
      expect(mockBroadcastToAllWindows).toHaveBeenCalledWith(IPC.AGENT.AGENT_MATERIALIZATION_FAILED, 'agent-1', 'left out');
    });

    it('tells the person through the setup notice when Codex launch flags left MCP env variables out (#2932)', async () => {
      withConfig({});
      const build = mockCodexProvider.buildMcpArgs as ReturnType<typeof vi.fn>;
      build.mockImplementationOnce((_servers: unknown, onNotice?: (m: string) => void) => {
        onNotice?.('env left out');
        return [];
      });
      mockBroadcastToAllWindows.mockClear();
      await spawn();
      expect(mockBroadcastToAllWindows).toHaveBeenCalledWith(IPC.AGENT.AGENT_MATERIALIZATION_FAILED, 'agent-1', 'env left out');
    });

    it('gives a managed agent its own MCP servers and the bridge, a saved mcpOverride from before ignored (#2896)', async () => {
      withConfig({ mcpOverride: false, worktreePath: '/project/wt', managed: { version: 1, blocks: [], skills: [], mcps: ['part-github'] } });
      await spawn();
      expect(Object.keys(flagsFromBuild()!).sort()).toEqual(['clubhouse', 'github']);
    });

    describe('a quick agent started from a template (D25)', () => {
      const PROJECT = path.join(path.sep, 'work', 'project');
      const launch = (over: Record<string, unknown> = {}) => ({
        templateId: 'tpl', instructions: 'You are swift-otter.', servers: { workiq: { command: 'workiq' } }, skippedSkills: 0, missing: 0, ...over,
      });
      const quick = (extra: Record<string, unknown> = {}) => spawnAgent({
        agentId: 'quick-1', projectPath: PROJECT, cwd: PROJECT, kind: 'quick', orchestrator: 'codex-cli',
        mission: 'Fix it', systemPrompt: 'Write a summary.', managedTemplate: { id: 'tpl', agentName: 'swift-otter' }, ...extra,
      });
      beforeEach(() => {
        mockQuickLaunchFor.mockReset().mockResolvedValue(launch());
        (mockCodexProvider.buildSpawnCommand as ReturnType<typeof vi.fn>).mockClear();
      });
      afterEach(() => {
        untrackAgent('quick-1');
      });

      it('puts the template\'s instructions first in the system prompt and its servers in the launch flags, in place of the project\'s', async () => {
        await quick();
        expect(mockQuickLaunchFor).toHaveBeenCalledWith(PROJECT, PROJECT, 'quick-1', { id: 'tpl', agentName: 'swift-otter' }, expect.objectContaining({ id: 'codex-cli' }));
        expect((mockCodexProvider.buildSpawnCommand as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0].systemPrompt).toBe('You are swift-otter.\n\nWrite a summary.');
        expect(Object.keys(flagsFromBuild()!).sort()).toEqual(['clubhouse', 'workiq']);
        expect(resolveProjectMcpServers).not.toHaveBeenCalled();
      });

      it('always gets the bridge, which its hooks share the nonce with', async () => {
        await quick();
        expect(mockInjectClubhouseMcp).toHaveBeenCalled();
        expect(Object.keys(flagsFromBuild()!).sort()).toEqual(['clubhouse', 'workiq']);
        const env = mockPtySpawn.mock.calls.at(-1)![4] as Record<string, string>;
        expect(env.CLUBHOUSE_HOOK_NONCE).toBe(agentRegistry.get('quick-1')?.nonce);
      });

      it('fails the start when the template can\'t be read', async () => {
        mockQuickLaunchFor.mockRejectedValue(new Error('not_found'));
        await expect(quick()).rejects.toThrow('not_found');
        expect(mockPtySpawn).not.toHaveBeenCalled();
      });

      it('passes the template\'s servers to a headless run too, after its own flags', async () => {
        mockGetSpawnMode.mockReturnValueOnce('headless');
        const codex = mockCodexProvider as unknown as { buildHeadlessCommand?: unknown };
        codex.buildHeadlessCommand = vi.fn(() => Promise.resolve({ binary: 'codex', args: ['exec', 'prompt', '--json'], outputKind: 'stream-json' as const }));
        (mockCodexProvider.buildMcpArgs as ReturnType<typeof vi.fn>).mockClear();
        try {
          await quick();
        } finally {
          delete codex.buildHeadlessCommand;
        }
        expect(Object.keys(flagsFromBuild()!).sort()).toEqual(['clubhouse', 'workiq']);
        expect(flagsFromBuild()!.workiq).toEqual({ command: 'workiq' });
        expect(mockHeadlessSpawn.mock.calls.at(-1)![3]).toEqual(['exec', 'prompt', '--json', '-c', 'mcp_servers.clubhouse.command=node']);
      });

      it('leaves a quick agent without a template as it was', async () => {
        await quick({ managedTemplate: undefined });
        expect(mockQuickLaunchFor).not.toHaveBeenCalled();
        expect((mockCodexProvider.buildSpawnCommand as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0].systemPrompt).toBe('Write a summary.');
      });
    });

    it('does not start a helper the bridge cannot serve, and says why', async () => {
      withConfig({ parentAgentId: 'orch-1' });
      mockMcpWaitReady.mockReset();
      mockMcpWaitReady.mockImplementation(() => Promise.reject(new Error('port in use')));
      await expect(spawn()).rejects.toThrow(/needs Clubhouse MCP to report to its orchestrator.*port in use/);
      expect(mockPtySpawn).not.toHaveBeenCalled();
    });

    it('does not start a helper whose MCP config could not be written', async () => {
      withConfig({ parentAgentId: 'orch-1' });
      mockInjectClubhouseMcp.mockRejectedValueOnce(new Error('EACCES'));
      await expect(spawn()).rejects.toThrow(/needs Clubhouse MCP.*EACCES/);
      expect(mockPtySpawn).not.toHaveBeenCalled();
    });

    it('still starts a plain agent whose bridge couldn\'t start, without the bridge', async () => {
      withConfig({});
      mockMcpWaitReady.mockReset();
      mockMcpWaitReady.mockImplementation(() => Promise.reject(new Error('MCP bridge server not started')));
      await spawn();
      expect(mockEnsureMcpBridge).toHaveBeenCalled();
      expect(mockPtySpawn).toHaveBeenCalled();
      expect(Object.keys(flagsFromBuild()!)).toEqual(['github']);
    });
  });

  describe('headless quick agents get the bridge too (D69)', () => {
    type HeadlessMock = { buildHeadlessCommand?: unknown; buildMcpArgs?: unknown; getCapabilities: ReturnType<typeof vi.fn> };
    const withHeadless = async (provider: HeadlessMock, orchestrator: string | undefined, binary: string) => {
      mockGetSpawnMode.mockReturnValueOnce('headless');
      mockMcpWaitReady.mockResolvedValueOnce(23456);
      const caps = provider.getCapabilities;
      const hadMcpArgs = 'buildMcpArgs' in provider;
      const mcpArgs = vi.fn(() => ['--mcp-flag']);
      provider.getCapabilities = vi.fn(() => ({ ...caps(), headless: true }));
      provider.buildHeadlessCommand = vi.fn(() => Promise.resolve({ binary, args: ['-p', 'mission'], env: {}, outputKind: 'stream-json' as const }));
      if (orchestrator) provider.buildMcpArgs = mcpArgs;
      try {
        await spawnAgent({ agentId: 'quick-1', projectPath: '/project', cwd: '/project/parent-wt', kind: 'quick', mission: 'do thing', ...(orchestrator ? { orchestrator } : {}) } as never);
      } finally {
        provider.getCapabilities = caps;
        delete provider.buildHeadlessCommand;
        if (!hadMcpArgs) delete provider.buildMcpArgs;
        untrackAgent('quick-1');
      }
      return mcpArgs;
    };

    beforeEach(() => {
      mockInjectClubhouseMcp.mockClear();
      mockSnapshotFile.mockClear();
      mockBuildClubhouseMcpDef.mockClear();
      mockEnsureMcpBridge.mockClear();
    });

    it('Claude: the bridge goes in the folder\'s MCP config, snapshotted first and restored on exit', async () => {
      await withHeadless(mockProvider as unknown as HeadlessMock, undefined, '/usr/local/bin/claude');
      expect(mockSnapshotFile).toHaveBeenCalledWith('quick-1', path.join('/project/parent-wt', '.mcp.json'));
      expect(mockInjectClubhouseMcp).toHaveBeenCalledWith('/project/parent-wt', 'quick-1', 23456, mockClaudeConventions);
      expect(mockSnapshotFile.mock.invocationCallOrder[0]).toBeLessThan(mockInjectClubhouseMcp.mock.invocationCallOrder[0]);
      expect(mockHeadlessSpawn.mock.calls.at(-1)![3]).toEqual(['-p', 'mission']);
      const onExit = mockHeadlessSpawn.mock.calls.at(-1)![6] as (id: string) => void;
      mockRestoreForAgent.mockClear();
      onExit('quick-1');
      expect(mockRestoreForAgent).toHaveBeenCalledWith('quick-1');
    });

    it.each([
      ['Codex', mockCodexProvider, 'codex-cli', '/usr/local/bin/codex'],
      ['Copilot', mockCopilotProvider, 'copilot-cli', '/usr/local/bin/copilot'],
    ] as const)('%s: the bridge is in the launch flags, after the command\'s own', async (_label, provider, orchestrator, binary) => {
      const mcpArgs = await withHeadless(provider as unknown as HeadlessMock, orchestrator, binary);
      expect(mcpArgs).toHaveBeenCalledTimes(1);
      expect(Object.keys((mcpArgs.mock.calls[0] as unknown[])[0] as Record<string, unknown>)).toEqual(['clubhouse']);
      expect(mockBuildClubhouseMcpDef).toHaveBeenCalledWith(23456, 'quick-1');
      expect(mockHeadlessSpawn.mock.calls.at(-1)![3]).toEqual(['-p', 'mission', '--mcp-flag']);
      expect(mockInjectClubhouseMcp).toHaveBeenCalledWith('/project/parent-wt', 'quick-1', 23456, provider.conventions);
    });

    it('starts without the bridge when it isn\'t up, after asking for it again', async () => {
      mockGetSpawnMode.mockReturnValueOnce('headless');
      const codex = mockCodexProvider as unknown as HeadlessMock;
      codex.buildHeadlessCommand = vi.fn(() => Promise.resolve({ binary: 'codex', args: ['exec'], env: {}, outputKind: 'stream-json' as const }));
      (mockCodexProvider.buildMcpArgs as ReturnType<typeof vi.fn>).mockClear();
      try {
        await spawnAgent({ agentId: 'quick-1', projectPath: '/project', cwd: '/project', kind: 'quick', orchestrator: 'codex-cli', mission: 'x' });
      } finally {
        delete codex.buildHeadlessCommand;
        untrackAgent('quick-1');
      }
      expect(mockEnsureMcpBridge).toHaveBeenCalled();
      expect(mockInjectClubhouseMcp).not.toHaveBeenCalled();
      expect(mockCodexProvider.buildMcpArgs).not.toHaveBeenCalled();
      expect(mockHeadlessSpawn.mock.calls.at(-1)![3]).toEqual(['exec']);
    });
  });

  describe('a bridge that failed at app start is retried for every spawn', () => {
    beforeEach(() => mockEnsureMcpBridge.mockClear());

    it.each([
      ['a quick agent', 'quick'],
      ['a durable agent', 'durable'],
    ] as const)('%s asks for the bridge again', async (_label, kind) => {
      await spawnAgent({ agentId: 'agent-1', projectPath: '/project', cwd: '/project', kind, mission: 'x' });
      expect(mockEnsureMcpBridge).toHaveBeenCalledTimes(1);
    });

    it('a quick agent doesn\'t wait for or fail on a bridge that is still down', async () => {
      mockMcpWaitReady.mockImplementation(() => Promise.reject(new Error('port in use')));
      try {
        await spawnAgent({ agentId: 'agent-1', projectPath: '/project', cwd: '/project', kind: 'quick', mission: 'x' });
      } finally {
        mockMcpWaitReady.mockImplementation(() => Promise.reject(new Error('MCP bridge server not started')));
      }
      expect(mockEnsureMcpBridge).toHaveBeenCalled();
      expect(mockPtySpawn).toHaveBeenCalled();
    });
  });

  describe('killAgent', () => {
    it('calls gracefulKill with provider exit command', async () => {
      await killAgent('agent-1', '/project');
      expect(mockPtyGracefulKill).toHaveBeenCalledWith('agent-1', '/exit\r');
    });

    describe('waitForExit (restart with resume)', () => {
      async function spawnDurable() {
        await spawnAgent({ agentId: 'agent-1', projectPath: '/project', cwd: '/project', kind: 'durable', resume: true, sessionId: 'sess-1' });
        return mockPtySpawn.mock.calls[0][5] as (id: string, code: number, buffer?: string, killed?: boolean) => void;
      }

      it('resolves only after the PTY exited and its session id was persisted', async () => {
        const onExit = await spawnDurable();
        let persist!: () => void;
        mockAddSessionEntry.mockReturnValueOnce(new Promise<void>((r) => { persist = r; }));
        mockPtyIsRunning.mockReturnValueOnce(true);

        let settled = false;
        const killed = killAgent('agent-1', '/project', undefined, 'user', { waitForExit: true }).then(() => { settled = true; });
        await vi.waitFor(() => expect(mockPtyGracefulKill).toHaveBeenCalled());
        expect(settled).toBe(false);

        // pty-manager order on a normal exit: exit callback, then broadcast.
        onExit('agent-1', 0);
        broadcastAgentExit('agent-1', 0);
        await Promise.resolve();
        expect(settled).toBe(false); // session entry not written yet

        persist();
        await killed;
        expect(mockAddSessionEntry).toHaveBeenCalledWith('/project', 'agent-1', expect.objectContaining({ sessionId: 'sess-1' }));
      });

      it('also waits for the capture when the exit callback runs after the broadcast (SIGKILL path)', async () => {
        sessionCapable(mockProvider);
        const onExit = await spawnDurable();
        let persist!: () => void;
        mockAddSessionEntry.mockReturnValueOnce(new Promise<void>((r) => { persist = r; }));
        mockPtyIsRunning.mockReturnValueOnce(true);

        let settled = false;
        const killed = killAgent('agent-1', '/project', undefined, 'user', { waitForExit: true }).then(() => { settled = true; });
        await vi.waitFor(() => expect(mockPtyGracefulKill).toHaveBeenCalled());

        broadcastAgentExit('agent-1', 1, '');
        onExit('agent-1', 1, 'To continue this session, run claude --resume 11111111-2222-3333-4444-555555555555', true);
        await Promise.resolve();
        await Promise.resolve();
        expect(settled).toBe(false);

        persist();
        await killed;
      });

      it('ignores exits of other agents', async () => {
        await spawnDurable();
        mockPtyIsRunning.mockReturnValueOnce(true);
        let settled = false;
        const killed = killAgent('agent-1', '/project', undefined, 'user', { waitForExit: true }).then(() => { settled = true; });
        await vi.waitFor(() => expect(mockPtyGracefulKill).toHaveBeenCalled());

        broadcastAgentExit('someone-else', 0);
        await Promise.resolve();
        expect(settled).toBe(false);

        broadcastAgentExit('agent-1', 0);
        await killed;
      });

      it('gives up after the timeout so a lost exit cannot wedge the switch', async () => {
        await spawnDurable();
        mockPtyIsRunning.mockReturnValueOnce(true);
        vi.useFakeTimers();
        try {
          const killed = killAgent('agent-1', '/project', undefined, 'user', { waitForExit: true });
          await vi.advanceTimersByTimeAsync(12_000);
          await killed;
        } finally {
          vi.useRealTimers();
        }
      });

      it('returns at once when no PTY is running', async () => {
        mockPtyIsRunning.mockReturnValueOnce(false);
        await killAgent('agent-1', '/project', undefined, 'user', { waitForExit: true });
        expect(mockPtyGracefulKill).toHaveBeenCalledWith('agent-1', '/exit\r');
      });

      it('rejects an unconfirmed exit when the caller must not delete or acknowledge', async () => {
        await spawnDurable();
        mockPtyIsRunning.mockReturnValueOnce(true);
        vi.useFakeTimers();
        try {
          const killed = killAgent('agent-1', '/project', undefined, 'user', { waitForExit: true, throwOnFailure: true });
          const rejected = expect(killed).rejects.toThrow('Timed out waiting for agent exit');
          await vi.advanceTimersByTimeAsync(12_000);
          await rejected;
        } finally { vi.useRealTimers(); }
      });
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
      mockPeekProjects.mockResolvedValue([{ path: '/project', orchestrator: 'codex-cli' }]);
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

    it('does not reject when gracefulKill throws (process already dead)', async () => {
      mockPtyGracefulKill.mockImplementationOnce(() => { throw new Error('process already dead'); });
      await expect(killAgent('agent-1', '/project')).resolves.toBeUndefined();
    });

    it('reports a failed PTY stop to strict callers', async () => {
      mockPtyGracefulKill.mockImplementationOnce(() => { throw new Error('stop failed'); });
      await expect(killAgent('agent-1', '/project', undefined, 'user', { throwOnFailure: true })).rejects.toThrow('stop failed');
    });

    it('uses a known shell exit command and waits for its confirmed exit', async () => {
      mockPtyIsRunning.mockReturnValue(true);
      let settled = false;
      const killed = killAgent('plain-shell', '/shell-cwd', undefined, 'user', {
        waitForExit: true, throwOnFailure: true, exitCommand: 'exit\r',
      }).then(() => { settled = true; });
      await vi.waitFor(() => expect(mockPtyGracefulKill).toHaveBeenCalledWith('plain-shell', 'exit\r'));
      expect(settled).toBe(false);
      broadcastAgentExit('plain-shell', 0);
      await killed;
      expect(settled).toBe(true);
    });

    it('awaits the chat runtime stop instead of falling through to PTY shutdown', async () => {
      const { registerChatRuntime, clearChatRuntimes } = await import('./agent-runtime');
      let finish!: () => void;
      const stop = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
      registerChatRuntime({ agentId: 'chat-stop', kind: 'chat', isRunning: () => true, stop } as never);
      try {
        let settled = false;
        const killed = killAgent('chat-stop', '/project', undefined, 'user', { waitForExit: true, throwOnFailure: true })
          .then(() => { settled = true; });
        await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
        expect(stop).toHaveBeenCalledWith({ throwOnFailure: true });
        expect(settled).toBe(false);
        expect(mockPtyGracefulKill).not.toHaveBeenCalled();
        finish();
        await killed;
      } finally { clearChatRuntimes(); }
    });

    it('waits for a headless exit before confirming a strict stop', async () => {
      mockIsHeadless.mockReturnValue(true);
      let settled = false;
      const killed = killAgent('headless-stop', '/project', undefined, 'user', { waitForExit: true, throwOnFailure: true })
        .then(() => { settled = true; });
      await vi.waitFor(() => expect(mockHeadlessKill).toHaveBeenCalledWith('headless-stop'));
      expect(settled).toBe(false);
      broadcastAgentExit('headless-stop', 0);
      await killed;
      expect(mockPtyGracefulKill).not.toHaveBeenCalled();
    });

    it('retains a headless registration when strict shutdown cannot confirm exit', async () => {
      vi.useFakeTimers();
      agentRegistry.register('headless-timeout', { projectPath: '/project', orchestrator: 'claude-code', runtime: 'headless' });
      mockIsHeadless.mockReturnValue(true);
      try {
        const stopped = expect(killAgent('headless-timeout', '/project', undefined, 'user', {
          waitForExit: true, throwOnFailure: true,
        })).rejects.toThrow('Timed out waiting for agent exit');
        await vi.advanceTimersByTimeAsync(12_000);
        await stopped;
        expect(agentRegistry.get('headless-timeout')?.projectPath).toBe('/project');
      } finally {
        untrackAgent('headless-timeout');
        vi.useRealTimers();
      }
    });

    it('does not reject for unknown orchestrator', async () => {
      await expect(killAgent('agent-1', '/project', 'nonexistent' as any)).resolves.toBeUndefined();
    });
  });

  describe('session capture on PTY exit (#2086)', () => {
    const DEAD = 'dead0000-0000-4000-8000-000000000000';
    const REAL = 'a1b2c3d4-0000-4000-8000-000000000001';
    type OnExit = (id: string, code: number, buffer?: string, killed?: boolean) => void;

    // What each CLI's terminal prints when told to resume a session it doesn't have.
    const providers = [
      { id: 'claude-code', provider: mockProvider, notFound: `No conversation found with session ID: ${DEAD}\r\n` },
      { id: 'codex-cli', provider: mockCodexProvider, notFound: `\x1b[31mError:\x1b[0m No saved session found with ID ${DEAD}. Run \`codex resume\` without an ID.\r\n` },
    ] as const;

    let config: { lastSessionId?: string };
    beforeEach(() => {
      config = { lastSessionId: DEAD };
      mockGetDurableConfig.mockImplementation(async () => ({ id: 'agent-1', runtimeMode: 'terminal', ...config }));
      mockUpdateSessionId.mockImplementation(async (_p: string, _a: string, id: string | null) => {
        if (id) config.lastSessionId = id; else delete config.lastSessionId;
      });
      mockAddSessionEntry.mockImplementation(async (_p: string, _a: string, entry: { sessionId: string }) => {
        config.lastSessionId = entry.sessionId;
      });
    });
    afterEach(() => {
      mockGetDurableConfig.mockReset();
      mockGetDurableConfig.mockReturnValue(null);
      mockAddSessionEntry.mockReset();
    });

    /** Wake the agent the way the renderer does: resume when it has a last session id. */
    async function wake(orchestrator: string): Promise<{ onExit: OnExit; resumedWith?: string }> {
      const resumedWith = config.lastSessionId;
      mockPtySpawn.mockClear();
      await spawnAgent({
        agentId: 'agent-1', projectPath: '/project', cwd: '/project', kind: 'durable',
        orchestrator: orchestrator as 'claude-code',
        resume: !!resumedWith, sessionId: resumedWith,
      });
      return { onExit: mockPtySpawn.mock.calls[0][5] as OnExit, resumedWith };
    }

    /** Let the exit handler's config writes finish. */
    const settle = () => vi.waitFor(() => expect(mockAppLog).toHaveBeenCalledWith('core:agent', expect.any(String), expect.stringMatching(/Captured|Cleared|No session ID|Resume failed/), expect.anything()));

    for (const { id, provider, notFound } of providers) {
      describe(id, () => {
        beforeEach(() => sessionCapable(provider));

        it('a failed resume followed by a retry does not loop on made-up ids', async () => {
          const first = await wake(id);
          expect(first.resumedWith).toBe(DEAD);
          first.onExit('agent-1', 1, notFound);
          await vi.waitFor(() => expect(mockUpdateSessionId).toHaveBeenCalledWith('/project', 'agent-1', null));
          expect(mockAddSessionEntry).not.toHaveBeenCalled();
          expect(config.lastSessionId).toBeUndefined();
          expect(mockBroadcastToAllWindows).toHaveBeenCalledWith(
            IPC.CHAT.RUNTIME_NOTICE, 'agent-1', expect.objectContaining({ code: 'resume_session_missing' }),
          );

          // The retry starts fresh and its real id is the one saved.
          const second = await wake(id);
          expect(second.resumedWith).toBeUndefined();
          second.onExit('agent-1', 0, `To continue this session, run ${id === 'codex-cli' ? 'codex' : 'claude --'}resume ${REAL}\r\n`);
          await vi.waitFor(() => expect(config.lastSessionId).toBe(REAL));
          expect(mockAddSessionEntry).toHaveBeenCalledTimes(1);
          expect(mockAddSessionEntry).toHaveBeenCalledWith('/project', 'agent-1', expect.objectContaining({ sessionId: REAL }));
        });

        it('a resume that exits non-zero at once without a message saves nothing and clears the id', async () => {
          const { onExit } = await wake(id);
          onExit('agent-1', 1, '\x1b[?25h\x1b[?2026l');
          await vi.waitFor(() => expect(mockUpdateSessionId).toHaveBeenCalledWith('/project', 'agent-1', null));
          expect(mockAddSessionEntry).not.toHaveBeenCalled();
          expect(mockBroadcastToAllWindows).toHaveBeenCalledWith(
            IPC.CHAT.RUNTIME_NOTICE, 'agent-1', expect.objectContaining({ code: 'resume_failed' }),
          );
        });

        it('a successful run saves the id the CLI printed', async () => {
          config = {};
          const { onExit } = await wake(id);
          onExit('agent-1', 0, `resume ${REAL}`);
          await vi.waitFor(() => expect(mockAddSessionEntry).toHaveBeenCalledWith('/project', 'agent-1', expect.objectContaining({ sessionId: REAL })));
          expect(mockUpdateSessionId).not.toHaveBeenCalled();
        });
      });
    }

    describe('a session another CLI made (#2593)', () => {
      const history = (orchestrator: string) => [{ sessionId: DEAD, startedAt: 'x', lastActiveAt: 'x', orchestrator }];

      it('starts fresh instead of asking the new CLI, even one with no store to check', async () => {
        sessionCapable(mockProvider);
        expect((mockProvider as Record<string, unknown>).hasSession).toBeUndefined();
        mockGetDurableConfig.mockImplementation(async () => ({ id: 'agent-1', runtimeMode: 'terminal', sessionHistory: history('codex-cli'), ...config }));
        await wake('claude-code');
        const spawnArgs = mockProvider.buildSpawnCommand.mock.calls.at(-1)![0] as { resume?: boolean; sessionId?: string };
        expect(spawnArgs.resume).toBe(false);
        expect(spawnArgs.sessionId).toBeUndefined();
        expect(mockUpdateSessionId).toHaveBeenCalledWith('/project', 'agent-1', null);
      });

      it('still resumes its own', async () => {
        sessionCapable(mockProvider);
        mockGetDurableConfig.mockImplementation(async () => ({ id: 'agent-1', runtimeMode: 'terminal', sessionHistory: history('claude-code'), ...config }));
        await wake('claude-code');
        const spawnArgs = mockProvider.buildSpawnCommand.mock.calls.at(-1)![0] as { resume?: boolean; sessionId?: string };
        expect(spawnArgs.resume).toBe(true);
        expect(spawnArgs.sessionId).toBe(DEAD);
        expect(mockUpdateSessionId).not.toHaveBeenCalled();
      });
    });

    it('a resumed run that exits cleanly without printing an id keeps the resumed id', async () => {
      const { onExit } = await wake('claude-code');
      onExit('agent-1', 0, 'bye');
      await vi.waitFor(() => expect(mockAddSessionEntry).toHaveBeenCalledWith('/project', 'agent-1', expect.objectContaining({ sessionId: DEAD })));
      expect(mockUpdateSessionId).not.toHaveBeenCalled();
    });

    it('a killed resume keeps its id even when it exits non-zero right away', async () => {
      const { onExit } = await wake('claude-code');
      onExit('agent-1', 1, '', true);
      await settle();
      expect(mockUpdateSessionId).not.toHaveBeenCalled();
      expect(mockAddSessionEntry).not.toHaveBeenCalled();
      expect(config.lastSessionId).toBe(DEAD);
    });

    it('a resume that ran for a while before exiting non-zero keeps its id', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const { onExit } = await wake('claude-code');
        vi.setSystemTime(Date.now() + 60_000);
        onExit('agent-1', 1, 'some crash');
        await settle();
        expect(mockUpdateSessionId).not.toHaveBeenCalled();
        expect(config.lastSessionId).toBe(DEAD);
      } finally {
        vi.useRealTimers();
      }
    });

    it('ignores a "not found" message far back in a long session that exited cleanly', async () => {
      sessionCapable(mockProvider);
      const { onExit } = await wake('claude-code');
      onExit('agent-1', 0, `No conversation found with session ID: x\n${'.'.repeat(5000)}\nresume ${REAL}`);
      await vi.waitFor(() => expect(mockAddSessionEntry).toHaveBeenCalledWith('/project', 'agent-1', expect.objectContaining({ sessionId: REAL })));
      expect(mockUpdateSessionId).not.toHaveBeenCalled();
    });

    it('opens the terminal fresh when chat could not resume because the session is gone', async () => {
      const { noteChatStartFailure } = await import('./agent-runtime/stale-session');
      const realStart = mockTryStartChatAgent.getMockImplementation()!;
      mockTryStartChatAgent.mockImplementationOnce(async (params: { agentId: string }) => {
        noteChatStartFailure(params.agentId, `RPC error: no rollout found for thread id ${DEAD}`);
        return 'terminal';
      });
      try {
        await wake('codex-cli');
        expect(mockUpdateSessionId).toHaveBeenCalledWith('/project', 'agent-1', null);
        const spawnArgs = mockCodexProvider.buildSpawnCommand.mock.calls.at(-1)![0] as { resume?: boolean; sessionId?: string };
        expect(spawnArgs.resume).toBe(false);
        expect(spawnArgs.sessionId).toBeUndefined();
      } finally {
        mockTryStartChatAgent.mockImplementation(realStart);
      }
    });

    it('keeps resuming in the terminal when chat failed for another reason', async () => {
      const { noteChatStartFailure } = await import('./agent-runtime/stale-session');
      mockTryStartChatAgent.mockImplementationOnce(async (params: { agentId: string }) => {
        noteChatStartFailure(params.agentId, "RPC request 'session/new' timed out after 30000ms");
        return 'terminal';
      });
      await wake('codex-cli');
      expect(mockUpdateSessionId).not.toHaveBeenCalled();
      const spawnArgs = mockCodexProvider.buildSpawnCommand.mock.calls.at(-1)![0] as { resume?: boolean; sessionId?: string };
      expect(spawnArgs).toMatchObject({ resume: true, sessionId: DEAD });
    });

    it('never resumes a quarantined session, whichever wake asked, and says so (#3240)', async () => {
      config.quarantinedSessionIds = [DEAD];
      mockBroadcastToAllWindows.mockClear();
      const { resumedWith } = await wake('codex-cli');
      expect(resumedWith).toBe(DEAD);
      const spawnArgs = mockCodexProvider.buildSpawnCommand.mock.calls.at(-1)![0] as { resume?: boolean; sessionId?: string };
      expect(spawnArgs.resume).toBe(false);
      expect(spawnArgs.sessionId).toBeUndefined();
      // A terminal start says it where other runtime notices go, once.
      const blocked = mockBroadcastToAllWindows.mock.calls.filter((c) => c[0] === IPC.CHAT.RUNTIME_NOTICE && (c[2] as { code?: string }).code === 'resume_blocked');
      expect(blocked).toEqual([[IPC.CHAT.RUNTIME_NOTICE, 'agent-1', { level: 'warn', code: 'resume_blocked', message: RESUME_BLOCKED_NOTICE }]]);
      const { takeNextStartNotices } = await import('./agent-runtime/stale-session');
      expect(takeNextStartNotices('agent-1')).toEqual([]);
    });

    describe('Codex runs that print no id (#2132)', () => {
      beforeEach(() => sessionCapable(mockCodexProvider));

      it('saves the session the CLI recorded for this run', async () => {
        config = {};
        const findRunSession = vi.fn(async () => REAL);
        (mockCodexProvider as Record<string, unknown>).findRunSession = findRunSession;
        const { onExit } = await wake('codex-cli');
        onExit('agent-1', 0, '\x1b[?25h\x1b[?2026l');
        await vi.waitFor(() => expect(mockAddSessionEntry).toHaveBeenCalledWith('/project', 'agent-1', expect.objectContaining({ sessionId: REAL })));
        const [run] = findRunSession.mock.calls[0] as unknown as [{ cwd: string; startedAt: number; endedAt: number; resumedId?: string }];
        expect(run.cwd).toBe('/project');
        expect(run.endedAt).toBeGreaterThanOrEqual(run.startedAt);
        expect(run.resumedId).toBeUndefined();
      });

      it('passes the resumed id, and skips the lookup when the resume failed', async () => {
        const findRunSession = vi.fn(async () => DEAD);
        (mockCodexProvider as Record<string, unknown>).findRunSession = findRunSession;
        const first = await wake('codex-cli');
        first.onExit('agent-1', 0, 'bye');
        await vi.waitFor(() => expect(mockAddSessionEntry).toHaveBeenCalled());
        expect(findRunSession.mock.calls[0]).toEqual([expect.objectContaining({ resumedId: DEAD })]);

        vi.useFakeTimers({ toFake: ['Date'] });
        try {
          findRunSession.mockClear();
          const second = await wake('codex-cli');
          vi.setSystemTime(Date.now() + 60_000);
          second.onExit('agent-1', 1, 'crash');
          await settle();
          expect(findRunSession).not.toHaveBeenCalled();
        } finally {
          vi.useRealTimers();
        }
      });

      it('saves nothing when the store has no session for the run', async () => {
        config = {};
        (mockCodexProvider as Record<string, unknown>).findRunSession = vi.fn(async () => null);
        const { onExit } = await wake('codex-cli');
        onExit('agent-1', 0, 'bye');
        await settle();
        expect(mockAddSessionEntry).not.toHaveBeenCalled();
      });

      it('starts fresh when the saved id has no rollout, and clears it', async () => {
        (mockCodexProvider as Record<string, unknown>).hasSession = vi.fn(async () => false);
        const { resumedWith } = await wake('codex-cli');
        expect(resumedWith).toBe(DEAD);
        expect(mockUpdateSessionId).toHaveBeenCalledWith('/project', 'agent-1', null);
        expect(mockBroadcastToAllWindows).toHaveBeenCalledWith(
          IPC.CHAT.RUNTIME_NOTICE, 'agent-1', expect.objectContaining({ code: 'resume_session_missing' }),
        );
        const spawnArgs = mockCodexProvider.buildSpawnCommand.mock.calls.at(-1)![0] as { resume?: boolean; sessionId?: string };
        expect(spawnArgs.resume).toBe(false);
        expect(spawnArgs.sessionId).toBeUndefined();
        expect(mockTryStartChatAgent.mock.calls.at(-1)![0]).toMatchObject({ resume: false, sessionId: undefined });
      });

      it('keeps resuming when the rollout exists or the store can\'t be read', async () => {
        for (const answer of [true, undefined]) {
          mockUpdateSessionId.mockClear();
          (mockCodexProvider as Record<string, unknown>).hasSession = vi.fn(async () => answer);
          await wake('codex-cli');
          expect(mockUpdateSessionId).not.toHaveBeenCalled();
          const spawnArgs = mockCodexProvider.buildSpawnCommand.mock.calls.at(-1)![0] as { resume?: boolean; sessionId?: string };
          expect(spawnArgs).toMatchObject({ resume: true, sessionId: DEAD });
        }
      });
    });

    describe('never saving an id the CLI store lacks (#2156)', () => {
      beforeEach(() => sessionCapable(mockCodexProvider));

      it('drops a scraped id the store does not have and uses the run\'s real session', async () => {
        config = {};
        const SCRAPED = 'a27ef93a-2030-45fd-943e-6e07ac0a811c';
        (mockCodexProvider as Record<string, unknown>).hasSession = vi.fn(async (id: string) => id !== SCRAPED);
        (mockCodexProvider.extractSessionId as ReturnType<typeof vi.fn>).mockReturnValueOnce(SCRAPED);
        (mockCodexProvider as Record<string, unknown>).findRunSession = vi.fn(async () => REAL);
        const { onExit } = await wake('codex-cli');
        onExit('agent-1', 0, `session: ${SCRAPED}`);
        await vi.waitFor(() => expect(mockAddSessionEntry).toHaveBeenCalledWith('/project', 'agent-1', expect.objectContaining({ sessionId: REAL })));
        expect(mockAddSessionEntry).not.toHaveBeenCalledWith('/project', 'agent-1', expect.objectContaining({ sessionId: SCRAPED }));
      });

      it('does not save the resumed id on a clean exit when the store does not have it', async () => {
        // Present when the wake checked it, gone by the time the run ended
        const hasSession = vi.fn(async () => true).mockResolvedValueOnce(true).mockResolvedValue(false);
        (mockCodexProvider as Record<string, unknown>).hasSession = hasSession;
        (mockCodexProvider as Record<string, unknown>).findRunSession = vi.fn(async () => null);
        const { onExit, resumedWith } = await wake('codex-cli');
        expect(resumedWith).toBe(DEAD);
        onExit('agent-1', 0, 'bye');
        await settle();
        expect(mockAddSessionEntry).not.toHaveBeenCalled();
      });

      it('drops a scraped id that is a real session from another cwd (#2172)', async () => {
        config = {};
        const OTHER = 'b0b0b0b0-0000-4000-8000-000000000002';
        (mockCodexProvider as Record<string, unknown>).hasSession = vi.fn(async () => true);
        const hasSessionForCwd = vi.fn(async (id: string) => id !== OTHER);
        (mockCodexProvider as Record<string, unknown>).hasSessionForCwd = hasSessionForCwd;
        (mockCodexProvider.extractSessionId as ReturnType<typeof vi.fn>).mockReturnValueOnce(OTHER);
        (mockCodexProvider as Record<string, unknown>).findRunSession = vi.fn(async () => REAL);
        const { onExit } = await wake('codex-cli');
        onExit('agent-1', 0, `session: ${OTHER}`);
        await vi.waitFor(() => expect(mockAddSessionEntry).toHaveBeenCalledWith('/project', 'agent-1', expect.objectContaining({ sessionId: REAL })));
        expect(hasSessionForCwd).toHaveBeenCalledWith(OTHER, '/project');
        expect(mockAddSessionEntry).not.toHaveBeenCalledWith('/project', 'agent-1', expect.objectContaining({ sessionId: OTHER }));
      });

      it('keeps a scraped id when the cwd check can\'t tell', async () => {
        config = {};
        (mockCodexProvider as Record<string, unknown>).hasSessionForCwd = vi.fn(async () => undefined);
        (mockCodexProvider.extractSessionId as ReturnType<typeof vi.fn>).mockReturnValueOnce(REAL);
        const { onExit } = await wake('codex-cli');
        onExit('agent-1', 0, `session: ${REAL}`);
        await vi.waitFor(() => expect(mockAddSessionEntry).toHaveBeenCalledWith('/project', 'agent-1', expect.objectContaining({ sessionId: REAL })));
      });

      it('saves the id the provider assigned a fresh session without searching for it', async () => {
        config = {};
        mockCodexProvider.buildSpawnCommand.mockResolvedValueOnce({ binary: 'copilot', args: ['--session-id', REAL], sessionId: REAL } as never);
        (mockCodexProvider as Record<string, unknown>).hasSession = vi.fn(async () => undefined);
        const findRunSession = vi.fn(async () => DEAD);
        (mockCodexProvider as Record<string, unknown>).findRunSession = findRunSession;
        const { onExit } = await wake('codex-cli');
        onExit('agent-1', 0, 'bye');
        await vi.waitFor(() => expect(mockAddSessionEntry).toHaveBeenCalledWith('/project', 'agent-1', expect.objectContaining({ sessionId: REAL })));
        expect(findRunSession).not.toHaveBeenCalled();
        expect(mockCodexProvider.extractSessionId).not.toHaveBeenCalled();
      });

      it('falls back to the store when the assigned id was never created', async () => {
        config = {};
        const ASSIGNED = 'c0c0c0c0-0000-4000-8000-000000000003';
        mockCodexProvider.buildSpawnCommand.mockResolvedValueOnce({ binary: 'copilot', args: ['--session-id', ASSIGNED], sessionId: ASSIGNED } as never);
        (mockCodexProvider as Record<string, unknown>).hasSession = vi.fn(async (id: string) => id !== ASSIGNED);
        (mockCodexProvider as Record<string, unknown>).findRunSession = vi.fn(async () => REAL);
        const { onExit } = await wake('codex-cli');
        onExit('agent-1', 0, 'bye');
        await vi.waitFor(() => expect(mockAddSessionEntry).toHaveBeenCalledWith('/project', 'agent-1', expect.objectContaining({ sessionId: REAL })));
        expect(mockAddSessionEntry).not.toHaveBeenCalledWith('/project', 'agent-1', expect.objectContaining({ sessionId: ASSIGNED }));
      });

      it('keeps a scraped id when the store can\'t tell', async () => {
        config = {};
        (mockCodexProvider as Record<string, unknown>).hasSession = vi.fn(async () => undefined);
        (mockCodexProvider.extractSessionId as ReturnType<typeof vi.fn>).mockReturnValueOnce(REAL);
        const { onExit } = await wake('codex-cli');
        onExit('agent-1', 0, `session: ${REAL}`);
        await vi.waitFor(() => expect(mockAddSessionEntry).toHaveBeenCalledWith('/project', 'agent-1', expect.objectContaining({ sessionId: REAL })));
      });
    });

    it('does not clear an id that a newer run has replaced', async () => {
      const { onExit } = await wake('claude-code');
      config.lastSessionId = REAL;
      onExit('agent-1', 1, `No conversation found with session ID: ${DEAD}`);
      await settle();
      await Promise.resolve();
      expect(mockUpdateSessionId).not.toHaveBeenCalled();
      expect(config.lastSessionId).toBe(REAL);
    });

    describe('telemetry (#2305)', () => {
      let event: ReturnType<typeof vi.fn>;
      beforeEach(() => {
        event = vi.fn();
        setProducingRuntime({ level: 'standard', flow: (_n: string, _o: unknown, fn: (s: unknown) => unknown) => fn({ set: () => {} }),
          step: (_n: string, fn: (s: unknown) => unknown) => fn({ set: () => {} }), count: vi.fn(), replaySpan: vi.fn(), event } as unknown as TelemetryRuntime);
      });
      afterEach(() => setProducingRuntime(null));

      /** Each recorded event of `name`, as key → value. */
      const recorded = (name: string) => event.mock.calls
        .filter(([n]) => n === name)
        .map(([, attrs]) => Object.fromEntries((attrs as Array<{ key: string; value: unknown }>).map((a) => [a.key, a.value])));
      const capture = (name = 'clubhouse.agent.session_capture') => vi.waitFor(() => {
        expect(recorded(name)).toHaveLength(1);
        return recorded(name)[0];
      });
      /** No exported value is a session id: only enums, the exit code and the (hashed) agent id. */
      const expectNoSessionIds = () => {
        for (const [, attrs] of event.mock.calls) {
          for (const a of attrs as Array<{ value: unknown }>) expect([DEAD, REAL]).not.toContain(a.value);
        }
      };

      it('a fresh run that printed its id: captured from the output, no resume outcome', async () => {
        sessionCapable(mockProvider);
        config = {};
        const { onExit } = await wake('claude-code');
        onExit('agent-1', 0, `resume ${REAL}`);
        expect(await capture()).toEqual({
          'clubhouse.orchestrator': 'claude-code', 'clubhouse.agent.id_hash': 'agent-1', 'clubhouse.agent.runtime': 'pty',
          'clubhouse.session.capture.result': 'captured', 'clubhouse.session.capture.source': 'output_scrape', 'process.exit.code': 0,
        });
        expect(recorded('clubhouse.agent.resume_outcome')).toEqual([]);
        expectNoSessionIds();
      });

      it('a resume the CLI has no session for: resume_failed_no_session, cleared exit_not_found, failed_not_found', async () => {
        sessionCapable(mockProvider);
        const { onExit } = await wake('claude-code');
        onExit('agent-1', 1, `No conversation found with session ID: ${DEAD}\r\n`);
        expect(await capture()).toMatchObject({ 'clubhouse.session.capture.result': 'resume_failed_no_session', 'clubhouse.session.capture.source': 'none', 'process.exit.code': 1 });
        expect(await capture('clubhouse.agent.session_stale_cleared')).toEqual({
          'clubhouse.orchestrator': 'claude-code', 'clubhouse.agent.id_hash': 'agent-1', 'clubhouse.session.stale.reason': 'exit_not_found',
        });
        expect(await capture('clubhouse.agent.resume_outcome')).toMatchObject({ 'clubhouse.agent.runtime': 'pty', 'clubhouse.session.resume.result': 'failed_not_found' });
        expectNoSessionIds();
      });

      it('a resume that quits at once: resume_failed_early_exit, cleared exit_early, failed_early_exit', async () => {
        sessionCapable(mockProvider);
        const { onExit } = await wake('claude-code');
        onExit('agent-1', 1, '\x1b[?25h');
        expect(await capture()).toMatchObject({ 'clubhouse.session.capture.result': 'resume_failed_early_exit' });
        expect(await capture('clubhouse.agent.session_stale_cleared')).toMatchObject({ 'clubhouse.session.stale.reason': 'exit_early' });
        expect(await capture('clubhouse.agent.resume_outcome')).toMatchObject({ 'clubhouse.session.resume.result': 'failed_early_exit' });
      });

      it('no stale-clear event when a newer run already replaced the id', async () => {
        sessionCapable(mockProvider);
        const { onExit } = await wake('claude-code');
        config.lastSessionId = REAL;
        onExit('agent-1', 1, `No conversation found with session ID: ${DEAD}`);
        await capture('clubhouse.agent.resume_outcome');
        expect(recorded('clubhouse.agent.session_stale_cleared')).toEqual([]);
      });

      it('a killed resume: kept_previous, and the resume counts as resumed', async () => {
        sessionCapable(mockProvider);
        const { onExit } = await wake('claude-code');
        onExit('agent-1', 1, '', true);
        expect(await capture()).toMatchObject({ 'clubhouse.session.capture.result': 'kept_previous', 'clubhouse.session.capture.source': 'none' });
        expect(await capture('clubhouse.agent.resume_outcome')).toMatchObject({ 'clubhouse.session.resume.result': 'resumed' });
      });

      it('a clean resumed exit with no printed id: captured from the resumed id', async () => {
        sessionCapable(mockProvider);
        const { onExit } = await wake('claude-code');
        onExit('agent-1', 0, 'bye');
        expect(await capture()).toMatchObject({ 'clubhouse.session.capture.result': 'captured', 'clubhouse.session.capture.source': 'resumed_id' });
      });

      describe('Codex and assigned ids', () => {
        beforeEach(() => sessionCapable(mockCodexProvider));

        it('captured from the CLI\'s run files', async () => {
          config = {};
          (mockCodexProvider as Record<string, unknown>).findRunSession = vi.fn(async () => REAL);
          const { onExit } = await wake('codex-cli');
          onExit('agent-1', 0, 'bye');
          expect(await capture()).toMatchObject({ 'clubhouse.orchestrator': 'codex-cli', 'clubhouse.session.capture.result': 'captured', 'clubhouse.session.capture.source': 'run_store' });
        });

        it('captured from the id Clubhouse assigned the run', async () => {
          config = {};
          mockCodexProvider.buildSpawnCommand.mockResolvedValueOnce({ binary: 'copilot', args: ['--session-id', REAL], sessionId: REAL } as never);
          (mockCodexProvider as Record<string, unknown>).hasSession = vi.fn(async () => true);
          const { onExit } = await wake('codex-cli');
          onExit('agent-1', 0, 'bye');
          expect(await capture()).toMatchObject({ 'clubhouse.session.capture.result': 'captured', 'clubhouse.session.capture.source': 'assigned' });
        });

        it('an assigned id the CLI never created is not a rejected id', async () => {
          config = {};
          mockCodexProvider.buildSpawnCommand.mockResolvedValueOnce({ binary: 'copilot', args: ['--session-id', REAL], sessionId: REAL } as never);
          (mockCodexProvider as Record<string, unknown>).hasSession = vi.fn(async () => false);
          (mockCodexProvider as Record<string, unknown>).findRunSession = vi.fn(async () => null);
          const { onExit } = await wake('codex-cli');
          onExit('agent-1', 0, 'bye');
          expect(await capture()).toMatchObject({ 'clubhouse.session.capture.result': 'kept_previous', 'clubhouse.session.capture.source': 'none' });
        });

        it('a made-up scraped id and nothing else: ignored_not_in_store (#2086)', async () => {
          config = {};
          (mockCodexProvider as Record<string, unknown>).hasSession = vi.fn(async () => false);
          (mockCodexProvider.extractSessionId as ReturnType<typeof vi.fn>).mockReturnValueOnce(DEAD);
          (mockCodexProvider as Record<string, unknown>).findRunSession = vi.fn(async () => null);
          const { onExit } = await wake('codex-cli');
          onExit('agent-1', 0, `session: ${DEAD}`);
          expect(await capture()).toMatchObject({ 'clubhouse.session.capture.result': 'ignored_not_in_store', 'clubhouse.session.capture.source': 'none' });
          expectNoSessionIds();
        });

        it('a scraped id from another cwd and nothing else: ignored_foreign', async () => {
          config = {};
          (mockCodexProvider as Record<string, unknown>).hasSessionForCwd = vi.fn(async () => false);
          (mockCodexProvider.extractSessionId as ReturnType<typeof vi.fn>).mockReturnValueOnce(REAL);
          (mockCodexProvider as Record<string, unknown>).findRunSession = vi.fn(async () => null);
          const { onExit } = await wake('codex-cli');
          onExit('agent-1', 0, `session: ${REAL}`);
          expect(await capture()).toMatchObject({ 'clubhouse.session.capture.result': 'ignored_foreign' });
        });

        it('a rejected id followed by a real one is still captured', async () => {
          config = {};
          (mockCodexProvider as Record<string, unknown>).hasSession = vi.fn(async (id: string) => id !== DEAD);
          (mockCodexProvider.extractSessionId as ReturnType<typeof vi.fn>).mockReturnValueOnce(DEAD);
          (mockCodexProvider as Record<string, unknown>).findRunSession = vi.fn(async () => REAL);
          const { onExit } = await wake('codex-cli');
          onExit('agent-1', 0, `session: ${DEAD}`);
          expect(await capture()).toMatchObject({ 'clubhouse.session.capture.result': 'captured', 'clubhouse.session.capture.source': 'run_store' });
        });

        it('persist_failed when the session entry can\'t be written', async () => {
          config = {};
          (mockCodexProvider as Record<string, unknown>).findRunSession = vi.fn(async () => REAL);
          mockAddSessionEntry.mockRejectedValueOnce(new Error('EACCES'));
          const { onExit } = await wake('codex-cli');
          onExit('agent-1', 0, 'bye');
          expect(await capture()).toMatchObject({ 'clubhouse.session.capture.result': 'persist_failed', 'clubhouse.session.capture.source': 'run_store' });
        });

        it('capture_failed when the lookup throws', async () => {
          config = {};
          (mockCodexProvider as Record<string, unknown>).findRunSession = vi.fn(async () => { throw new Error('boom'); });
          const { onExit } = await wake('codex-cli');
          onExit('agent-1', 0, 'bye');
          expect(await capture()).toMatchObject({ 'clubhouse.session.capture.result': 'capture_failed' });
        });

        it('a saved id only a removed provider profile\'s store has: fresh, kept, nothing cleared (#2749)', async () => {
          (mockCodexProvider as Record<string, unknown>).hasSession = vi.fn(async () => false);
          const inStore = vi.fn(async () => true);
          (mockCodexProvider as Record<string, unknown>).hasSessionInStore = inStore;
          mockRemovedProfileStateDirs.mockResolvedValueOnce(['/old/codex-home']);
          mockCodexProvider.buildSpawnCommand.mockClear();
          const { resumedWith } = await wake('codex-cli');
          expect(resumedWith).toBeTruthy();
          expect(inStore).toHaveBeenCalledWith(resumedWith, '/old/codex-home');
          expect(mockCodexProvider.buildSpawnCommand.mock.calls.at(-1)![0]).toMatchObject({ resume: false });
          expect(recorded('clubhouse.agent.session_stale_cleared')).toEqual([]);
          expect(recorded('clubhouse.agent.resume_outcome')).toEqual([
            { 'clubhouse.orchestrator': 'codex-cli', 'clubhouse.agent.id_hash': 'agent-1', 'clubhouse.session.resume.result': 'fresh_not_found' },
          ]);
          expect(config.lastSessionId).toBe(resumedWith);
        });

        it('a saved id the store lacks at wake: cleared store_missing, fresh_not_found', async () => {
          (mockCodexProvider as Record<string, unknown>).hasSession = vi.fn(async () => false);
          await wake('codex-cli');
          expect(recorded('clubhouse.agent.session_stale_cleared')).toEqual([
            { 'clubhouse.orchestrator': 'codex-cli', 'clubhouse.agent.id_hash': 'agent-1', 'clubhouse.session.stale.reason': 'store_missing' },
          ]);
          expect(recorded('clubhouse.agent.resume_outcome')).toEqual([
            { 'clubhouse.orchestrator': 'codex-cli', 'clubhouse.agent.id_hash': 'agent-1', 'clubhouse.session.resume.result': 'fresh_not_found' },
          ]);
        });
      });

      it('guided resume refuses a missing native session without falling back fresh', async () => {
        sessionCapable(mockCodexProvider);
        config.sessionHistory = [{ sessionId: DEAD, orchestrator: 'codex-cli' }];
        (mockCodexProvider as Record<string, unknown>).hasSession = vi.fn(async () => false);
        mockPtySpawn.mockClear();
        await expect(spawnAgent({ agentId: 'agent-1', projectPath: '/project', cwd: '/project', kind: 'durable', orchestrator: 'codex-cli', resume: true, strictResume: true, sessionId: DEAD })).rejects.toThrow('resume_unverified');
        expect(mockPtySpawn).not.toHaveBeenCalled();
        expect(config.lastSessionId).toBe(DEAD);
      });

      it('chat could not resume a gone session: cleared chat_not_found, fresh_not_found in the terminal', async () => {
        const { noteChatStartFailure } = await import('./agent-runtime/stale-session');
        const realStart = mockTryStartChatAgent.getMockImplementation()!;
        mockTryStartChatAgent.mockImplementationOnce(async (params: { agentId: string }) => {
          noteChatStartFailure(params.agentId, `RPC error: no rollout found for thread id ${DEAD}`);
          return 'terminal';
        });
        try {
          await wake('codex-cli');
          expect(recorded('clubhouse.agent.session_stale_cleared')).toEqual([expect.objectContaining({ 'clubhouse.session.stale.reason': 'chat_not_found' })]);
          expect(recorded('clubhouse.agent.resume_outcome')).toEqual([
            expect.objectContaining({ 'clubhouse.agent.runtime': 'pty', 'clubhouse.session.resume.result': 'fresh_not_found' }),
          ]);
        } finally {
          mockTryStartChatAgent.mockImplementation(realStart);
        }
      });

      it('chat could not resume a gone session: retries a fresh chat before the terminal', async () => {
        const { noteChatStartFailure } = await import('./agent-runtime/stale-session');
        const realStart = mockTryStartChatAgent.getMockImplementation()!;
        const resumes: Array<boolean | undefined> = [];
        mockTryStartChatAgent.mockImplementationOnce(async (params: { agentId: string; resume?: boolean }) => {
          resumes.push(params.resume);
          noteChatStartFailure(params.agentId, `RPC error: no rollout found for thread id ${DEAD}`);
          return 'terminal';
        }).mockImplementationOnce(async (params: { resume?: boolean }) => {
          resumes.push(params.resume);
          return 'chat';
        });
        try {
          mockPtySpawn.mockClear();
          await spawnAgent({
            agentId: 'agent-1', projectPath: '/project', cwd: '/project', kind: 'durable',
            orchestrator: 'codex-cli', resume: true, sessionId: DEAD,
          });
          expect(resumes).toEqual([true, false]);
          expect(mockPtySpawn).not.toHaveBeenCalled();
          expect(recorded('clubhouse.agent.session_stale_cleared')).toEqual([expect.objectContaining({ 'clubhouse.session.stale.reason': 'chat_not_found' })]);
          expect(recorded('clubhouse.agent.resume_outcome')).toEqual([
            expect.objectContaining({ 'clubhouse.agent.runtime': 'chat', 'clubhouse.session.resume.result': 'fresh_not_found' }),
          ]);
        } finally {
          mockTryStartChatAgent.mockImplementation(realStart);
        }
      });

      it('a wake the user started fresh although a session exists: fresh_user', async () => {
        await spawnAgent({ agentId: 'agent-1', projectPath: '/project', cwd: '/project', kind: 'durable', orchestrator: 'claude-code', resume: false });
        expect(recorded('clubhouse.agent.resume_outcome')).toEqual([
          { 'clubhouse.orchestrator': 'claude-code', 'clubhouse.agent.id_hash': 'agent-1', 'clubhouse.session.resume.result': 'fresh_user' },
        ]);
      });

      it('records nothing with telemetry off', async () => {
        setProducingRuntime(null);
        sessionCapable(mockProvider);
        const { onExit } = await wake('claude-code');
        onExit('agent-1', 1, `No conversation found with session ID: ${DEAD}`);
        await vi.waitFor(() => expect(mockUpdateSessionId).toHaveBeenCalledWith('/project', 'agent-1', null));
        expect(event).not.toHaveBeenCalled();
      });
    });
  });

  describe('unfinished creation (#2226)', () => {
    afterEach(() => mockGetDurableConfig.mockImplementation(() => null));

    it('refuses to start an agent that is still being created', async () => {
      mockGetDurableConfig.mockImplementation((async () => ({ id: 'agent-1', creation: { state: 'creating', startedAt: '2026-10-18T00:00:00.000Z' } })) as never);
      await expect(spawnAgent({ agentId: 'agent-1', projectPath: '/project', cwd: '/project', kind: 'durable' })).rejects.toThrow(/still being created/);
      expect(mockPtySpawn).not.toHaveBeenCalled();
    });

    it('refuses to start an agent whose creation failed, with the reason', async () => {
      mockGetDurableConfig.mockImplementation((async () => ({ id: 'agent-1', creation: { state: 'failed', startedAt: '2026-10-18T00:00:00.000Z', reason: 'git said no.' } })) as never);
      await expect(spawnAgent({ agentId: 'agent-1', projectPath: '/project', cwd: '/project', kind: 'durable' })).rejects.toThrow(/could not be created: git said no\./);
      expect(mockPtySpawn).not.toHaveBeenCalled();
    });
  });

  describe('sleep reason on PTY exit (#2104)', () => {
    it("drops the last sleep's reason when the agent wakes again", async () => {
      const slept = { id: 'agent-1', lastSleep: { reason: 'agent', at: '2026-10-17T00:00:00.000Z', by: 'PM' } };
      // The first read is the unfinished-creation check (#2226), the second the config the spawn uses.
      mockGetDurableConfig.mockResolvedValueOnce(slept as never).mockResolvedValueOnce(slept as never);
      await spawnAgent({ agentId: 'agent-1', projectPath: '/project', cwd: '/project', kind: 'durable' });
      expect(mockUpdateDurableConfig).toHaveBeenCalledWith('/project', 'agent-1', { lastSleep: null });
      mockUpdateDurableConfig.mockClear();
      await spawnAgent({ agentId: 'agent-1', projectPath: '/project', cwd: '/project', kind: 'durable' });
      expect(mockUpdateDurableConfig).not.toHaveBeenCalled();
    });

    async function spawnDurable(): Promise<(id: string, code: number, buffer?: string, killed?: boolean) => void> {
      await spawnAgent({ agentId: 'agent-1', projectPath: '/project', cwd: '/project', kind: 'durable' });
      return mockPtySpawn.mock.calls.at(-1)![5];
    }
    const saved = () => mockUpdateDurableConfig.mock.calls.map((c) => (c[2] as { lastSleep?: { reason: string; by?: string; exitCode?: number } }).lastSleep);

    it('records a Stop as the user, and sleep_agent with the caller', async () => {
      let onExit = await spawnDurable();
      await killAgent('agent-1', '/project');
      onExit('agent-1', 0, '', true);
      onExit = await spawnDurable();
      await killAgent('agent-1', '/project', undefined, 'agent_tool', { by: 'Clubhouse-PM' });
      onExit('agent-1', 0, '', true);
      await vi.waitFor(() => expect(saved()).toHaveLength(2));
      expect(saved()).toMatchObject([{ reason: 'user' }, { reason: 'agent', by: 'Clubhouse-PM' }]);
      expect(mockBroadcastToAllWindows).toHaveBeenCalledWith(IPC.AGENT.AGENT_SLEEP_REASON, 'agent-1', expect.objectContaining({ reason: 'agent' }));
    });

    it('records a CLI that exited on its own, by exit code', async () => {
      let onExit = await spawnDurable();
      onExit('agent-1', 2, 'boom');
      onExit = await spawnDurable();
      onExit('agent-1', 0, 'bye');
      await vi.waitFor(() => expect(saved()).toHaveLength(2));
      expect(saved()).toMatchObject([{ reason: 'crashed', exitCode: 2 }, { reason: 'exited' }]);
    });

    it("records nothing for Clubhouse's own kill (quitting), and forgets a kill that found nothing running", async () => {
      const onExit = await spawnDurable();
      onExit('agent-1', 1, '', true);
      // A Stop for an agent that wasn't running leaves a request; the next run must not inherit it.
      await killAgent('agent-1', '/project');
      const next = await spawnDurable();
      next('agent-1', 3, 'crash');
      await vi.waitFor(() => expect(saved()).toHaveLength(1));
      expect(saved()).toMatchObject([{ reason: 'crashed', exitCode: 3 }]);
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
  });

  describe('config pipeline integration', () => {
    it('calls snapshotFile before writeHooksConfig', async () => {
      const callOrder: string[] = [];
      mockSnapshotFile.mockImplementation((_agentId: string, file: string) => { callOrder.push(file.endsWith('settings.local.json') ? 'snapshot' : 'snapshot-mcp'); });
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
      expect(callOrder.filter((c) => c !== 'snapshot-mcp')).toEqual(['snapshot', 'writeHooks']);
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

    it('PTY onExit never invents a session id when the CLI reported none (#2086)', async () => {
      await spawnAgent({
        agentId: 'agent-1',
        projectPath: '/project',
        cwd: '/project',
        kind: 'durable',
      });

      const onExitCallback = mockPtySpawn.mock.calls[0][5];
      onExitCallback('agent-1', 0);
      await Promise.resolve();

      expect(mockAddSessionEntry).not.toHaveBeenCalled();
      expect(mockUpdateSessionId).not.toHaveBeenCalled();
    });

    it('PTY onExit uses provider extractSessionId when available', async () => {
      // Make provider session-capable
      mockProvider.extractSessionId = vi.fn(() => 'provider-session-123');
      mockProvider.listSessions = vi.fn(async () => []);
      mockProvider.readSessionTranscript = vi.fn(async () => null);
      mockProvider.getCapabilities.mockReturnValue({
        headless: true, structuredOutput: false, hooks: true,
        sessionResume: true, permissions: false,
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

    it('skips the hooks snapshot when provider does not support hooks, and still snapshots the MCP file', async () => {
      mockGetHooksConfigPath.mockReturnValueOnce(null);

      await spawnAgent({
        agentId: 'agent-1',
        projectPath: '/project',
        cwd: '/project',
        kind: 'durable',
      });

      // The Clubhouse MCP always runs, so only the MCP file is snapshotted.
      expect(mockSnapshotFile.mock.calls.map(([, file]) => path.basename(file as string))).toEqual(['.mcp.json']);
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
        undefined, // createEventNormalizer
      );
      expect(mockPtySpawn).not.toHaveBeenCalled();
    });

    it('does not spawn headless for an interactive quick agent (started from a phone)', async () => {
      await spawnAgent({
        agentId: 'test-interactive',
        projectPath: '/project',
        cwd: '/project/worktree',
        kind: 'quick',
        mission: 'test mission',
        interactive: true,
      });

      expect(mockHeadlessSpawn).not.toHaveBeenCalled();
      expect(mockTryStartChatAgent.mock.calls.at(-1)?.[0]).toMatchObject({ agentId: 'test-interactive', kind: 'quick', interactive: true });
      expect(mockPtySpawn).toHaveBeenCalled();
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
          // The defaults follow the level (#3007): Ask first pre-allows only reading tools.
          allowedTools: ['Read'],
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
        undefined, // createEventNormalizer
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

  describe('managed agent delivery (#2896)', () => {
    it('delivers a managed setup before the start', async () => {
      mockDeliverForSpawn.mockClear();
      const config = {
        id: 'agent-1', name: 'agent-1', worktreePath: '/project/.clubhouse/agents/agent-1',
        managed: { version: 1, blocks: ['builtin-block-identity'], skills: [], mcps: [] },
      };
      mockGetDurableConfig.mockReturnValue(config);
      await spawnAgent({ agentId: 'agent-1', projectPath: '/project', cwd: '/project', kind: 'durable' });
      expect(mockDeliverForSpawn).toHaveBeenCalledWith('/project', expect.objectContaining({ id: 'agent-1' }), expect.objectContaining({ id: 'claude-code' }));
    });

    it('keeps starting when delivery fails, and says why', async () => {
      mockDeliverForSpawn.mockRejectedValueOnce(new Error('disk full'));
      mockGetDurableConfig.mockReturnValue({
        id: 'agent-1', name: 'agent-1', worktreePath: '/project/.clubhouse/agents/agent-1',
        managed: { version: 1, blocks: [], skills: [], mcps: [] },
      });
      await spawnAgent({ agentId: 'agent-1', projectPath: '/project', cwd: '/project', kind: 'durable' });
      expect(mockBroadcastToAllWindows).toHaveBeenCalledWith(IPC.AGENT.AGENT_MATERIALIZATION_FAILED, 'agent-1', 'disk full');
    });

    it('delivers to an agent from the start after it switches to managed (#2901)', async () => {
      mockDeliverForSpawn.mockClear();
      const legacy = { id: 'agent-1', name: 'agent-1', worktreePath: '/project/.clubhouse/agents/agent-1', persona: 'qa' };
      mockGetDurableConfig.mockReturnValue(legacy);
      await spawnAgent({ agentId: 'agent-1', projectPath: '/project', cwd: '/project', kind: 'durable' });
      expect(mockDeliverForSpawn).not.toHaveBeenCalled();

      // Switch to managed saves a setup on the config and leaves the rest as it was.
      mockGetDurableConfig.mockReturnValue({ ...legacy, managed: { version: 1, blocks: ['agent-1-notes'], skills: [], mcps: [] } });
      await spawnAgent({ agentId: 'agent-1', projectPath: '/project', cwd: '/project', kind: 'durable' });
      expect(mockDeliverForSpawn).toHaveBeenCalledTimes(1);
    });

    it('switches a legacy-configured agent to managed before anything is written, and starts it as managed (D59)', async () => {
      mockDeliverForSpawn.mockClear();
      mockMigrateAtSpawn.mockClear();
      const legacy = { id: 'agent-1', name: 'agent-1', worktreePath: '/project/.clubhouse/agents/agent-1' };
      const managedConfig = { ...legacy, managed: { version: 1, blocks: ['agent-1-notes'], skills: [], mcps: [] } };
      mockGetDurableConfig.mockReturnValue(legacy);
      mockMigrateAtSpawn.mockImplementationOnce(async () => {
        // Nothing has been written into its folder yet.
        expect(mockDeliverForSpawn).not.toHaveBeenCalled();
        mockGetDurableConfig.mockReturnValue(managedConfig);
        return managedConfig;
      });
      await spawnAgent({ agentId: 'agent-1', projectPath: '/project', cwd: '/project', kind: 'durable' });
      expect(mockMigrateAtSpawn).toHaveBeenCalledWith('/project', expect.objectContaining({ id: 'agent-1' }));
      expect(mockDeliverForSpawn).toHaveBeenCalledWith('/project', managedConfig, expect.objectContaining({ id: 'claude-code' }));

      // The next start is an ordinary managed one: no switch.
      mockMigrateAtSpawn.mockClear();
      mockDeliverForSpawn.mockClear();
      await spawnAgent({ agentId: 'agent-1', projectPath: '/project', cwd: '/project', kind: 'durable' });
      expect(mockMigrateAtSpawn).not.toHaveBeenCalled();
      expect(mockDeliverForSpawn).toHaveBeenCalledTimes(1);
    });

    it('starts the agent on the files in its folder when the switch fails or does not apply (D59, #2901)', async () => {
      mockDeliverForSpawn.mockClear();
      mockMigrateAtSpawn.mockClear();
      mockGetDurableConfig.mockReturnValue({ id: 'agent-1', name: 'agent-1', worktreePath: '/project/.clubhouse/agents/agent-1' });
      await spawnAgent({ agentId: 'agent-1', projectPath: '/project', cwd: '/project', kind: 'durable' });
      expect(mockMigrateAtSpawn).toHaveBeenCalledTimes(1);
      expect(mockDeliverForSpawn).not.toHaveBeenCalled();
      expect(mockPtySpawn).toHaveBeenCalled();
    });

    it('never asks to switch a quick agent', async () => {
      mockMigrateAtSpawn.mockClear();
      await spawnAgent({ agentId: 'agent-1', projectPath: '/project', cwd: '/project', kind: 'quick' });
      expect(mockMigrateAtSpawn).not.toHaveBeenCalled();
    });

    it('does nothing for an agent that is not managed', async () => {
      mockDeliverForSpawn.mockClear();
      mockGetDurableConfig.mockReturnValue({ id: 'agent-1', name: 'agent-1', worktreePath: '/project/.clubhouse/agents/agent-1' });
      await spawnAgent({ agentId: 'agent-1', projectPath: '/project', cwd: '/project', kind: 'durable' });
      expect(mockDeliverForSpawn).not.toHaveBeenCalled();
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

      // Clean up
      delete (mockProvider as any).buildHeadlessCommand;
    });

    it('kills headless agent detected by headless-manager.isHeadless', async () => {
      mockIsHeadless.mockReturnValue(true);

      await killAgent('ext-headless', '/project');

      expect(mockHeadlessKill).toHaveBeenCalledWith('ext-headless');
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

    it('does not reject when headless kill throws', async () => {
      mockIsHeadless.mockReturnValue(true);
      mockHeadlessKill.mockImplementation(() => { throw new Error('kill failed'); });

      await expect(killAgent('ext-headless', '/project')).resolves.toBeUndefined();
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

    it('expands tilde in agentSource before passing to buildSpawnCommand (PTY path)', async () => {
      mockGetDurableConfig.mockReturnValue({
        id: 'agent-1',
        name: 'agent-1',
        agentFile: 'k8s-assistant',
        agentSource: '~/.copilot/agents',
      });

      await spawnAgent({
        agentId: 'agent-1',
        projectPath: '/project',
        cwd: '/project',
        kind: 'durable',
      });

      const callArgs = mockProvider.buildSpawnCommand.mock.calls[0][0];
      // agentFile is a name, never expanded
      expect(callArgs.agentFile).toBe('k8s-assistant');
      // agentSource must be tilde-expanded — must NOT contain a leading ~
      expect(callArgs.agentSource).toBe(path.join(os.homedir(), '.copilot/agents'));
      expect(callArgs.agentSource.startsWith('~')).toBe(false);
    });

    it('does not apply agentFile/agentSource fallback for kind: "quick"', async () => {
      // Even if a durable config exists with these fields, quick agents must not
      // receive them (the durable-config fallback block is gated on kind === "durable").
      mockGetDurableConfig.mockReturnValue({
        id: 'quick-1',
        name: 'quick-1',
        agentFile: 'should-not-leak',
        agentSource: '/should/not/leak',
      });

      await spawnAgent({
        agentId: 'quick-1',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        mission: 'do a thing',
      });

      const callArgs = mockProvider.buildSpawnCommand.mock.calls[0][0];
      expect(callArgs.agentFile).toBeUndefined();
      expect(callArgs.agentSource).toBeUndefined();
    });
  });

  describe('expandHome', () => {
    const home = os.homedir();

    it('returns home dir for `~` alone', () => {
      expect(expandHome('~')).toBe(home);
    });

    it('expands `~/foo` to <home>/foo', () => {
      expect(expandHome('~/foo')).toBe(path.join(home, 'foo'));
    });

    it('expands `~\\foo` to <home>/foo (Windows-style)', () => {
      expect(expandHome('~\\foo')).toBe(path.join(home, 'foo'));
    });

    it('preserves absolute paths unchanged', () => {
      expect(expandHome('/abs/path')).toBe('/abs/path');
    });

    it('preserves relative paths unchanged', () => {
      expect(expandHome('relative/path')).toBe('relative/path');
    });

    it('does NOT expand a tilde that is not at the start', () => {
      expect(expandHome('foo~bar')).toBe('foo~bar');
      expect(expandHome('/foo/~/bar')).toBe('/foo/~/bar');
    });

    it('preserves an empty string', () => {
      expect(expandHome('')).toBe('');
    });
  });

  describe('launch wrapper validation', () => {
    const wrapperCfg = {
      binary: 'node',
      separator: '--',
      orchestratorMap: { 'claude-code': { subcommand: 'claude' } },
      env: { WRAPPER_ENV_VAR: 'on' },
    };

    beforeEach(() => {
      mockReadLaunchWrapper.mockReturnValue(wrapperCfg);
      mockValidateWrapperConfig.mockReturnValue({ ok: true });
      mockApplyLaunchWrapper.mockImplementation(
        (_cfg: unknown, _id: string, binary: string, args: string[]) => ({ binary: '/wrapped/bin', args: ['--wrap', ...args] }),
      );
    });

    afterEach(() => {
      mockReadLaunchWrapper.mockReturnValue(undefined);
    });

    it('applies wrapper and merges wrapperConfig.env when validation passes (PTY)', async () => {
      await spawnAgent({
        agentId: 'agent-wrap-ok',
        projectPath: '/project',
        cwd: '/project',
        kind: 'durable',
      });

      expect(mockValidateWrapperConfig).toHaveBeenCalled();
      expect(mockApplyLaunchWrapper).toHaveBeenCalled();
      expect(mockPtySpawn).toHaveBeenCalledWith(
        'agent-wrap-ok',
        '/project',
        '/wrapped/bin',
        expect.arrayContaining(['--wrap']),
        expect.objectContaining({ WRAPPER_ENV_VAR: 'on' }),
        expect.any(Function),
        undefined,
      );
    });

    it('skips wrapping and omits wrapper env when validation fails (PTY)', async () => {
      mockValidateWrapperConfig.mockReturnValue({ ok: false, reason: 'wrapper binary is not available on PATH' });

      await spawnAgent({
        agentId: 'agent-wrap-skip',
        projectPath: '/project',
        cwd: '/project',
        kind: 'durable',
      });

      // applyLaunchWrapper must NOT have been called
      expect(mockApplyLaunchWrapper).not.toHaveBeenCalled();

      // PTY spawn used the original binary, not the wrapped one
      const spawnCall = mockPtySpawn.mock.calls.find((c) => c[0] === 'agent-wrap-skip');
      expect(spawnCall).toBeDefined();
      expect(spawnCall![2]).toBe('/usr/local/bin/claude');
      // wrapperConfig.env must NOT leak through when validation failed
      expect(spawnCall![4]).not.toHaveProperty('WRAPPER_ENV_VAR');

      // Warning logged with the validation reason
      const warnCall = mockAppLog.mock.calls.find(
        (c) => c[1] === 'warn' && typeof c[2] === 'string' && c[2].includes('Skipping wrapper'),
      );
      expect(warnCall).toBeDefined();
      expect(warnCall![2]).toContain('not available on PATH');
      expect(warnCall![3]).toMatchObject({ meta: { agentId: 'agent-wrap-skip' } });
    });

    it('skips wrapping and omits wrapper env when validation fails (headless)', async () => {
      mockGetSpawnMode.mockReturnValue('headless');
      mockProvider.buildHeadlessCommand = vi.fn(() =>
        Promise.resolve({
          binary: '/usr/bin/claude',
          args: ['-p', 'mission'],
          env: {},
          outputKind: 'stream-json' as const,
        }),
      );
      mockValidateWrapperConfig.mockReturnValue({ ok: false, reason: 'wrapper plugin foo is not enabled' });

      await spawnAgent({
        agentId: 'headless-wrap-skip',
        projectPath: '/project',
        cwd: '/project',
        kind: 'quick',
        mission: 'mission',
      });

      expect(mockApplyLaunchWrapper).not.toHaveBeenCalled();

      const spawnCall = mockHeadlessSpawn.mock.calls.find((c) => c[0] === 'headless-wrap-skip');
      expect(spawnCall).toBeDefined();
      expect(spawnCall![2]).toBe('/usr/bin/claude');
      expect(spawnCall![4]).not.toHaveProperty('WRAPPER_ENV_VAR');

      const warnCall = mockAppLog.mock.calls.find(
        (c) => c[1] === 'warn' && typeof c[2] === 'string' && c[2].includes('Skipping wrapper'),
      );
      expect(warnCall).toBeDefined();
      expect(warnCall![2]).toContain('not enabled');

      delete (mockProvider as any).buildHeadlessCommand;
    });

    it('passes mcpConfigs to applyLaunchWrapper (PTY)', async () => {
      const testConfigs = { 'my-mcp': { port: '3000', verbose: 'true' } };
      mockReadMcpConfigs.mockReturnValue(testConfigs);
      mockReadDefaultMcps.mockReturnValue(['my-mcp']);

      await spawnAgent({
        agentId: 'agent-mcp-configs',
        projectPath: '/project',
        cwd: '/project',
        kind: 'durable',
      });

      expect(mockApplyLaunchWrapper).toHaveBeenCalledWith(
        wrapperCfg,
        'claude-code',
        expect.any(String),
        expect.any(Array),
        ['my-mcp'],
        testConfigs,
      );
    });
  });

  describe('isAgentRunning / getRunningAgentIds', () => {
    it('reports running when a PTY session is live', () => {
      mockPtyIsRunning.mockImplementation((id: string) => id === 'pty_agent');
      expect(isAgentRunning('pty_agent')).toBe(true);
      expect(isAgentRunning('other')).toBe(false);
    });

    it('reports running for headless sessions', () => {
      mockIsHeadless.mockImplementation((id: string) => id === 'headless_agent');
      expect(isAgentRunning('headless_agent')).toBe(true);
    });

    it('reports not running when no manager has a session', () => {
      expect(isAgentRunning('idle_agent')).toBe(false);
    });

    it('filters a candidate list to only the live agents', () => {
      mockPtyIsRunning.mockImplementation((id: string) => id === 'a');
      mockIsHeadless.mockImplementation((id: string) => id === 'b');
      expect(getRunningAgentIds(['a', 'b', 'c'])).toEqual(['a', 'b']);
    });

    it('returns an empty array when none are running', () => {
      expect(getRunningAgentIds(['x', 'y'])).toEqual([]);
    });
  });
});

describe('listSessions: saved ids the CLI store lacks (#2156)', () => {
  const entry = (id: string) => ({ sessionId: id, startedAt: '2026-10-17T00:00:00Z', lastActiveAt: '2026-10-17T01:00:00Z' });

  afterEach(() => notSessionCapable(mockCodexProvider));

  it('lists a quarantined session marked blocked (#3240)', async () => {
    mockGetDurableConfig.mockResolvedValue({ id: 'durable_cp', orchestrator: 'codex-cli', quarantinedSessionIds: ['bad-1'] });
    mockGetSessionHistory.mockResolvedValue([entry('bad-1'), entry('good-1')]);
    const sessions = await listSessions('/project', 'durable_cp', 'codex-cli');
    expect(sessions.find((s) => s.sessionId === 'bad-1')).toMatchObject({ blocked: true });
    expect(sessions.find((s) => s.sessionId === 'good-1')).not.toHaveProperty('blocked');
  });

  it('hides history entries the store does not have and prunes them; keeps ones it has or can\'t check', async () => {
    sessionCapable(mockCodexProvider);
    mockGetDurableConfig.mockResolvedValue({ id: 'durable_cp', orchestrator: 'codex-cli', worktreePath: '/wt' });
    mockGetSessionHistory.mockResolvedValue([entry('dead-1'), entry('real-1'), entry('unknown-1')]);
    (mockCodexProvider as Record<string, unknown>).hasSession = vi.fn(async (id: string) => (id === 'dead-1' ? false : id === 'real-1' ? true : undefined));

    const sessions = await listSessions('/project', 'durable_cp', 'codex-cli');

    expect(sessions.map((s) => s.sessionId).sort()).toEqual(['real-1', 'unknown-1']);
    expect(mockRemoveSessionEntries).toHaveBeenCalledWith('/project', 'durable_cp', ['dead-1']);
  });

  it('prunes nothing when the store can\'t tell (no store where it looked)', async () => {
    sessionCapable(mockCodexProvider);
    mockRemoveSessionEntries.mockClear();
    mockGetDurableConfig.mockResolvedValue({ id: 'durable_cp', orchestrator: 'codex-cli' });
    mockGetSessionHistory.mockResolvedValue([entry('a-1'), entry('b-1')]);
    (mockCodexProvider as Record<string, unknown>).hasSession = vi.fn(async () => undefined);
    const sessions = await listSessions('/project', 'durable_cp', 'codex-cli');
    expect(sessions.map((s) => s.sessionId).sort()).toEqual(['a-1', 'b-1']);
    expect(mockRemoveSessionEntries).not.toHaveBeenCalled();
  });

  it('leaves another CLI\'s sessions out without pruning them, whether or not this CLI has a store (#2593)', async () => {
    sessionCapable(mockCodexProvider);
    mockRemoveSessionEntries.mockClear();
    mockGetDurableConfig.mockResolvedValue({ id: 'durable_cp', orchestrator: 'codex-cli' });
    mockGetSessionHistory.mockResolvedValue([{ ...entry('claude-1'), orchestrator: 'claude-code' }, { ...entry('codex-1'), orchestrator: 'codex-cli' }]);
    (mockCodexProvider as Record<string, unknown>).hasSession = vi.fn(async (id: string) => id === 'codex-1');

    const sessions = await listSessions('/project', 'durable_cp', 'codex-cli');

    expect(sessions.map((s) => s.sessionId)).toEqual(['codex-1']);
    expect(mockRemoveSessionEntries).not.toHaveBeenCalled();
  });

  it('never prunes an entry a removed provider profile\'s store has; still prunes a truly missing one (#2749)', async () => {
    sessionCapable(mockCodexProvider);
    mockRemoveSessionEntries.mockClear();
    mockGetDurableConfig.mockResolvedValue({ id: 'durable_cp', orchestrator: 'codex-cli' });
    mockGetSessionHistory.mockResolvedValue([entry('old-profile-1'), entry('dead-1'), entry('real-1')]);
    (mockCodexProvider as Record<string, unknown>).hasSession = vi.fn(async (id: string) => id === 'real-1');
    const inStore = vi.fn(async (id: string, dir: string) => dir === '/old/codex-home' && id === 'old-profile-1');
    (mockCodexProvider as Record<string, unknown>).hasSessionInStore = inStore;
    mockRemovedProfileStateDirs.mockResolvedValue(['/old/codex-home']);
    try {
      const sessions = await listSessions('/project', 'durable_cp', 'codex-cli');
      expect(sessions.map((s) => s.sessionId)).toEqual(['real-1']);
      expect(mockRemoveSessionEntries).toHaveBeenCalledWith('/project', 'durable_cp', ['dead-1']);
      expect(mockRemovedProfileStateDirs).toHaveBeenCalledWith('codex-cli');
    } finally {
      mockRemovedProfileStateDirs.mockResolvedValue([]);
    }
  });

  it('keeps an entry when a removed profile\'s store can\'t be read (#2749)', async () => {
    sessionCapable(mockCodexProvider);
    mockRemoveSessionEntries.mockClear();
    mockGetDurableConfig.mockResolvedValue({ id: 'durable_cp', orchestrator: 'codex-cli' });
    mockGetSessionHistory.mockResolvedValue([entry('old-profile-1')]);
    (mockCodexProvider as Record<string, unknown>).hasSession = vi.fn(async () => false);
    (mockCodexProvider as Record<string, unknown>).hasSessionInStore = vi.fn(async () => undefined);
    mockRemovedProfileStateDirs.mockResolvedValue(['/old/codex-home']);
    try {
      await listSessions('/project', 'durable_cp', 'codex-cli');
      expect(mockRemoveSessionEntries).not.toHaveBeenCalled();
    } finally {
      mockRemovedProfileStateDirs.mockResolvedValue([]);
    }
  });

  it('prunes nothing when every entry exists', async () => {
    sessionCapable(mockCodexProvider);
    mockRemoveSessionEntries.mockClear();
    mockGetDurableConfig.mockResolvedValue({ id: 'durable_cp', orchestrator: 'codex-cli' });
    mockGetSessionHistory.mockResolvedValue([entry('real-1')]);
    (mockCodexProvider as Record<string, unknown>).hasSession = vi.fn(async () => true);
    await listSessions('/project', 'durable_cp', 'codex-cli');
    expect(mockRemoveSessionEntries).not.toHaveBeenCalled();
  });
});

describe('spawnAccess (#2761)', () => {
  it('an explicit level wins', () => {
    expect(spawnAccess({ access: 'auto_edit', freeAgentMode: true }, { access: 'plan' }, 'skip-all')).toBe('auto_edit');
  });
  it('a durable agent starts at its saved level, migrating one saved before #2761', () => {
    expect(spawnAccess({}, { access: 'plan' }, 'skip-all')).toBe('plan');
    expect(spawnAccess({}, { freeAgentMode: true }, 'auto')).toBe('auto');
    expect(spawnAccess({}, { freeAgentMode: true }, 'skip-all')).toBe('full_access');
  });
  it('a legacy on/off that agrees with the saved level keeps it', () => {
    expect(spawnAccess({ freeAgentMode: false }, { access: 'auto_edit' }, 'skip-all')).toBe('auto_edit');
    expect(spawnAccess({ freeAgentMode: true }, { access: 'auto', freeAgentMode: true }, 'skip-all')).toBe('auto');
  });
  it('a restart entry\'s mode wins for an on level', () => {
    expect(spawnAccess({ freeAgentMode: true, permissionMode: 'skip-all' }, { access: 'auto', freeAgentMode: true }, 'auto')).toBe('full_access');
  });
  it('a quick agent starts at Ask first unless asked otherwise', () => {
    expect(spawnAccess({}, undefined, 'skip-all')).toBe('ask');
    expect(spawnAccess({ freeAgentMode: true }, undefined, 'auto')).toBe('auto');
  });
});

describe('helper launch ceiling on the normal spawn path', () => {
  const getAgentLaunchAccess = (id: string) => agentRegistry.get(id)?.launchAccess;
  const projectPath = path.join(path.sep, 'project');
  const helper = (extra: Record<string, unknown> = {}) => ({
    id: 'helper-1',
    name: 'helper',
    parentAgentId: 'orch-1',
    freeAgentMode: true,
    ...extra,
  });
  const lastBuild = () => (mockProvider.buildSpawnCommand.mock.calls.at(-1) as unknown as [{ freeAgentMode?: boolean; permissionMode?: string }])[0];
  const wake = (extra: Record<string, unknown> = {}) =>
    spawnAgent({ agentId: 'helper-1', projectPath, cwd: projectPath, kind: 'durable', ...extra });

  beforeEach(() => {
    vi.clearAllMocks();
    mockMcpWaitReady.mockResolvedValue(23456);
    mockGetPermissionMode.mockReturnValue('skip-all');
    orchestratorLive = launchAccessFor('auto');
  });

  afterEach(() => {
    untrackAgent('helper-1');
    mockGetDurableConfig.mockReset();
    mockGetDurableConfig.mockImplementation(() => null);
  });

  it('a helper woken with no mode gets its Auto orchestrator\'s level, not the project\'s skip-all', async () => {
    mockGetDurableConfig.mockImplementation((async () => helper()) as never);
    await wake();
    expect(mockResolveHelperLaunchSettings).toHaveBeenCalledWith(projectPath, 'orch-1', { helperProvider: 'claude-code' });
    expect(lastBuild()).toMatchObject({ freeAgentMode: true, permissionMode: 'auto' });
    expect(getAgentLaunchAccess('helper-1')).toMatchObject({ freeAgentMode: true, permissionMode: 'auto' });
  });

  it('a helper saved at Auto-accept edits starts at Ask first under a standard ceiling (#2761)', async () => {
    orchestratorLive = undefined;
    mockGetDurableConfig.mockImplementation((async () => helper({ freeAgentMode: undefined, access: 'auto_edit' })) as never);
    await wake();
    expect(lastBuild()).toMatchObject({ freeAgentMode: false, access: 'ask' });
  });

  it('a durable agent starts at its saved level, with the legacy pair derived and the mode at auto (#2761)', async () => {
    mockGetDurableConfig.mockImplementation((async () => ({ id: 'helper-1', name: 'plain', access: 'plan' })) as never);
    await wake({ freeAgentMode: false });
    expect(lastBuild()).toMatchObject({ freeAgentMode: false, permissionMode: 'auto', access: 'plan' });
  });

  it('an agent saved before #2761 starts exactly as before, with the old mode below Free Agent Mode', async () => {
    mockGetDurableConfig.mockImplementation((async () => ({ id: 'helper-1', name: 'old' })) as never);
    await wake();
    expect(lastBuild()).toMatchObject({ freeAgentMode: false, permissionMode: 'skip-all', access: 'ask' });
  });

  it('a helper of an orchestrator at Plan starts at Plan, whatever it was saved at (#3000)', async () => {
    orchestratorLive = { ...launchAccessFor('standard'), access: 'plan' } as AgentLaunchAccess;
    mockGetDurableConfig.mockImplementation((async () => helper({ freeAgentMode: undefined, access: 'auto_edit' })) as never);
    await wake();
    expect(lastBuild()).toMatchObject({ freeAgentMode: false, access: 'plan' });
  });

  it('a helper saved at Plan stays at Plan when its ceiling lowers the legacy pair', async () => {
    orchestratorLive = undefined;
    mockGetDurableConfig.mockImplementation((async () => helper({ freeAgentMode: undefined, access: 'plan' })) as never);
    await wake();
    expect(lastBuild()).toMatchObject({ freeAgentMode: false, access: 'plan' });
  });

  it('a helper whose orchestrator is in another project gets the orchestrator\'s ceiling from there', async () => {
    const orchestratorProject = path.join(path.sep, 'orchestrator-project');
    mockGetDurableConfig.mockImplementation((async () => helper({ parentProjectPath: orchestratorProject })) as never);
    await wake();
    expect(mockFindParent).toHaveBeenCalledWith(projectPath, expect.objectContaining({ parentAgentId: 'orch-1', parentProjectPath: orchestratorProject }));
    expect(mockResolveHelperLaunchSettings).toHaveBeenCalledWith(orchestratorProject, 'orch-1', { helperProvider: 'claude-code' });
    expect(lastBuild()).toMatchObject({ freeAgentMode: true, permissionMode: 'auto' });
    expect(getAgentLaunchAccess('helper-1')).toMatchObject({ freeAgentMode: true, permissionMode: 'auto' });
  });

  it('starts at standard when the orchestrator can\'t be found in any project', async () => {
    mockFindParent.mockResolvedValueOnce(null);
    mockGetDurableConfig.mockImplementation((async () => helper({ parentProjectPath: path.join(path.sep, 'gone') })) as never);
    await wake();
    expect(mockResolveHelperLaunchSettings).not.toHaveBeenCalled();
    expect(lastBuild()).toMatchObject({ freeAgentMode: false, permissionMode: 'auto' });
  });

  it('also lowers an explicit skip-all a caller passes', async () => {
    mockGetDurableConfig.mockImplementation((async () => helper()) as never);
    await wake({ freeAgentMode: true, permissionMode: 'skip-all' });
    expect(lastBuild()).toMatchObject({ freeAgentMode: true, permissionMode: 'auto' });
  });

  it('starts at standard when the orchestrator isn\'t running', async () => {
    orchestratorLive = undefined;
    mockGetDurableConfig.mockImplementation((async () => helper()) as never);
    await wake();
    expect(lastBuild()).toMatchObject({ freeAgentMode: false, permissionMode: 'auto' });
    expect(getAgentLaunchAccess('helper-1')).toMatchObject({ freeAgentMode: false, permissionMode: 'auto' });
  });

  it('starts at standard when the orchestrator can\'t be read', async () => {
    mockResolveHelperLaunchSettings.mockRejectedValueOnce(new Error('Orchestrator not found'));
    mockGetDurableConfig.mockImplementation((async () => helper()) as never);
    await wake();
    expect(lastBuild()).toMatchObject({ freeAgentMode: false, permissionMode: 'auto' });
  });

  it('holds the helper to the lower access start_helper asked for', async () => {
    orchestratorLive = launchAccessFor('bypass');
    mockGetDurableConfig.mockImplementation((async () => helper({ requestedAccess: 'auto' })) as never);
    await wake();
    expect(lastBuild()).toMatchObject({ freeAgentMode: true, permissionMode: 'auto' });
  });

  it('keeps a lower level the caller passed', async () => {
    orchestratorLive = launchAccessFor('bypass');
    mockGetDurableConfig.mockImplementation((async () => helper({ freeAgentMode: false })) as never);
    await wake();
    expect(lastBuild()).toMatchObject({ freeAgentMode: false, permissionMode: 'skip-all' });
  });

  it('a Copilot helper under an Auto orchestrator never gets --yolo', async () => {
    mockGetDurableConfig.mockImplementation((async () => helper({ orchestrator: 'copilot-cli' })) as never);
    await wake({ orchestrator: 'copilot-cli' });
    expect(mockResolveHelperLaunchSettings).toHaveBeenCalledWith(projectPath, 'orch-1', { helperProvider: 'copilot-cli' });
    // Any Free Agent Mode adds --yolo on Copilot, and Auto launch settings
    // carry it, so the ranking drops to standard: no --yolo, no --allow-all-tools.
    const launch = lastBuild();
    expect(launch).toMatchObject({ freeAgentMode: false, permissionMode: 'auto' });
    expect(providerAccessLevel('copilot-cli', launch as AgentLaunchAccess)).toBe('standard');
    expect(getAgentLaunchAccess('helper-1')).toMatchObject({ freeAgentMode: false, permissionMode: 'auto' });
  });

  it('a Copilot helper with its orchestrator asleep starts at standard', async () => {
    orchestratorLive = undefined;
    mockGetDurableConfig.mockImplementation((async () => helper({ orchestrator: 'copilot-cli' })) as never);
    await wake({ orchestrator: 'copilot-cli' });
    expect(lastBuild()).toMatchObject({ freeAgentMode: false, permissionMode: 'auto' });
  });

  it('starts at standard when the agent\'s config can\'t be read, whatever the caller passed', async () => {
    mockGetDurableConfig.mockImplementation((async () => { throw new Error('agents.json is corrupt'); }) as never);
    await wake({ freeAgentMode: true, permissionMode: 'skip-all' });
    expect(lastBuild()).toMatchObject({ freeAgentMode: false, permissionMode: 'auto' });
    expect(getAgentLaunchAccess('helper-1')).toMatchObject({ freeAgentMode: false, permissionMode: 'auto' });
  });

  it('hands the chat runtime the capped values', async () => {
    mockGetDurableConfig.mockImplementation((async () => helper()) as never);
    await wake({ freeAgentMode: true, permissionMode: 'skip-all' });
    expect(mockTryStartChatAgent).toHaveBeenCalled();
    expect(mockTryStartChatAgent.mock.calls.at(-1)![0]).toMatchObject({ freeAgentMode: true, permissionMode: 'auto' });
  });

  it('leaves a durable agent that isn\'t a helper at the project setting', async () => {
    mockGetDurableConfig.mockImplementation((async () => ({ id: 'helper-1', name: 'plain', freeAgentMode: true })) as never);
    await wake();
    expect(mockResolveHelperLaunchSettings).not.toHaveBeenCalled();
    expect(lastBuild()).toMatchObject({ freeAgentMode: true, permissionMode: 'skip-all' });
    expect(getAgentLaunchAccess('helper-1')).toMatchObject({ freeAgentMode: true, permissionMode: 'skip-all' });
  });

  it('leaves quick agents alone', async () => {
    await spawnAgent({ agentId: 'helper-1', projectPath, cwd: projectPath, kind: 'quick', freeAgentMode: true });
    expect(mockResolveHelperLaunchSettings).not.toHaveBeenCalled();
    expect(lastBuild()).toMatchObject({ freeAgentMode: true, permissionMode: 'skip-all' });
  });
});

describe('the MCP call gate is set before anything can call a tool', () => {
  const projectPath = path.join(path.sep, 'project');
  const id = 'gate-order';
  const start = (extra: Record<string, unknown> = {}) => spawnAgent({ agentId: id, projectPath, cwd: projectPath, kind: 'durable', ...extra });
  /** What the gate said at the moment the nonce arrived: the bridge refuses everything before that. */
  let atNonce: string[];
  let setNonce: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    atNonce = [];
    mockMcpWaitReady.mockResolvedValue(23456);
    const real = agentRegistry.setNonce.bind(agentRegistry);
    setNonce = vi.spyOn(agentRegistry, 'setNonce').mockImplementation((agentId: string, nonce: string) => {
      atNonce.push(mcpCallAccess(agentId, agentRegistry.get(agentId)?.projectPath));
      real(agentId, nonce);
    });
  });

  afterEach(() => {
    setNonce.mockRestore();
    untrackAgent(id);
    mockGetDurableConfig.mockReset();
    mockGetDurableConfig.mockImplementation(() => null);
  });

  it('an agent reads open when its nonce arrives, a helper and a saved mcpOverride false from before included', async () => {
    for (const config of [{ id, name: 'plain' }, { id, name: 'helper', parentAgentId: 'lead' }, { id, name: 'old', mcpOverride: false }]) {
      atNonce = [];
      mockGetDurableConfig.mockImplementation((async () => config) as never);
      await start();
      untrackAgent(id);
      expect(atNonce.length).toBeGreaterThan(0);
      expect(atNonce.every((access) => access === 'open')).toBe(true);
    }
  });

  it('goes before the chat runtime, which sets its nonce inside', async () => {
    mockGetDurableConfig.mockImplementation((async () => { throw new Error('unreadable'); }) as never);
    const atChat: string[] = [];
    // Stands in for the runtime, and goes on to the terminal as the real one can.
    mockTryStartChatAgent.mockImplementationOnce(async () => {
      atChat.push(mcpCallAccess(id, agentRegistry.get(id)?.projectPath));
      return 'terminal';
    });
    await start();
    expect(atChat).toEqual(['closed']);
  });

  it('goes before a headless agent\'s nonce, with no config for a quick agent', async () => {
    mockGetSpawnMode.mockReturnValueOnce('headless');
    mockMcpWaitReady.mockResolvedValueOnce(23456);
    const headless = mockProvider as unknown as { buildHeadlessCommand?: unknown };
    headless.buildHeadlessCommand = vi.fn(async () => ({ binary: '/usr/bin/claude', args: [], env: {} }));
    try {
      await start({ kind: 'quick', mission: 'do thing' });
      expect(mockHeadlessSpawn).toHaveBeenCalled();
    } finally {
      delete headless.buildHeadlessCommand;
    }
    expect(mockSetMcpCaller).toHaveBeenCalledWith('quick', id, projectPath);
    expect(setNonce.mock.invocationCallOrder[0]).toBeGreaterThan(mockSetMcpCaller.mock.invocationCallOrder[0]);
  });

  it('a config it couldn\'t read is closed from the start, and the spawn goes on', async () => {
    mockGetDurableConfig.mockImplementation((async () => { throw new Error('unreadable'); }) as never);
    await start();
    expect(mockSetMcpCaller).toHaveBeenCalledWith('unreadable', id, projectPath);
    expect(atNonce.length).toBeGreaterThan(0);
    expect(atNonce.every((access) => access === 'closed')).toBe(true);
    expect(mockPtySpawn).toHaveBeenCalled();
  });

  it('a missing row isn\'t unreadable: no config, and it is open', async () => {
    mockGetDurableConfig.mockImplementation((async () => null) as never);
    await start();
    expect(mockSetMcpCaller).toHaveBeenCalledWith('config', id, projectPath, null);
    expect(atNonce.every((access) => access === 'open')).toBe(true);
  });
});


import * as managedActivation from './managed-activation';
import type { ManagedLaunchLease } from './managed-activation/service';
import { ProcessStartedReceiptError } from './managed-activation/types';
import { withAgentActivity } from './agent-transition';

describe('managed instructions in the real terminal launch seam', () => {
  let lease: ManagedLaunchLease;
  beforeEach(() => {
    mockPtyIsRunning.mockReturnValue(false);
    mockGetDurableConfig.mockResolvedValue({ id: 'managed-launch', name: 'managed', worktreePath: '/workspace', orchestrator: 'claude-code', model: 'opus', runtimeMode: 'terminal' } as never);
    lease = { attemptId: 'attempt-fixture', instructionFile: '/private/generation/instructions.txt', pluginDir: '/private/generation/plugin', binary: '/usr/local/bin/claude',
      assertCanCreate: vi.fn(), beforeStart: vi.fn(async () => undefined), started: vi.fn(async () => undefined), notCreated: vi.fn(async () => undefined), cleanup: vi.fn(async () => undefined), exited: vi.fn(async () => undefined) };
    vi.spyOn(managedActivation, 'withManagedActivationLaunch').mockImplementation((params, _isRunning, run) => withAgentActivity(params.agentId, () => run(lease)));
    mockPtySpawn.mockImplementation(async (...args: unknown[]) => {
      (args[7] as { onCreated(id: string): void }).onCreated('pty:fixture:123');
    });
  });
  afterEach(() => { untrackAgent('managed-launch'); });
  const start = () => spawnAgent({ agentId: 'managed-launch', projectPath: '/project', cwd: '/workspace', kind: 'durable', orchestrator: 'claude-code' });
  it('passes only private file paths, preserves launch settings and skips legacy writes/restoration/chat', async () => {
    await start();
    expect(mockPtySpawn).toHaveBeenCalledWith('managed-launch', '/workspace', '/usr/local/bin/claude',
      ['--model', 'opus', '--append-system-prompt-file', lease.instructionFile, '--plugin-dir', lease.pluginDir], expect.any(Object), expect.any(Function), undefined, expect.any(Object));
    expect(lease.beforeStart).toHaveBeenCalledWith('/usr/local/bin/claude');
    expect(lease.started).toHaveBeenCalledWith('pty:fixture:123');
    expect(mockSnapshotFile).not.toHaveBeenCalled();
    expect(mockProvider.writeHooksConfig).not.toHaveBeenCalled(); expect(mockTryStartChatAgent).not.toHaveBeenCalled();
    const args = mockPtySpawn.mock.calls[0];
    args[7].onObservedExit(); args[5]('managed-launch', 0, '', false);
    expect(lease.exited).toHaveBeenCalled(); expect(mockRestoreForAgent).not.toHaveBeenCalled();
  });
  it('refuses before runtime when final capability/file validation fails', async () => {
    vi.mocked(lease.beforeStart).mockRejectedValue(new Error('stale capability'));
    await expect(start()).rejects.toThrow('stale capability');
    expect(mockPtySpawn).not.toHaveBeenCalled(); expect(agentRegistry.get('managed-launch')).toBeUndefined();
  });
  it('keeps live registry through the legacy catches when receipt fails and cleanup refuses another identity', async () => {
    const error = new ProcessStartedReceiptError('attempt-fixture', 'pty:fixture:123');
    vi.mocked(lease.started).mockRejectedValue(error); mockStopCreatedProcess.mockReturnValue(false);
    await expect(start()).rejects.toBe(error);
    expect(error).toMatchObject({ cleanupRequested: false, cleanupConfirmed: false, cleanupFailure: 'identity_changed' });
    expect(agentRegistry.get('managed-launch')?.runtime).toBe('pty');
    expect(mockStopCreatedProcess).toHaveBeenCalledWith('managed-launch', 'pty:fixture:123');
  });
  it('keeps the identity-bearing error and registry when requesting cleanup throws', async () => {
    const error = new ProcessStartedReceiptError('attempt-fixture', 'pty:fixture:123');
    vi.mocked(lease.started).mockRejectedValue(error); mockStopCreatedProcess.mockImplementation(() => { throw new Error('signal dispatch failed'); });
    await expect(start()).rejects.toBe(error);
    expect(error.cleanupFailure).toBe('request_failed'); expect(agentRegistry.get('managed-launch')).toBeDefined();
  });
  it('marks no process created after a pre-creation spawn error and retains materialized snapshot ownership', async () => {
    mockPtySpawn.mockRejectedValue(new Error('spawn failed'));
    await expect(start()).rejects.toThrow('spawn failed');
    expect(lease.notCreated).toHaveBeenCalled(); expect(lease.started).not.toHaveBeenCalled();
  });
  it.each([false, true])('records known shutdown rejection after intent, preserving original error when notCreated fails=%s', async (failReceipt) => {
    const { closeLaunches, reopenLaunches } = await import('./launch-gate');
    vi.mocked(lease.beforeStart).mockImplementation(async () => { closeLaunches('quitting'); });
    if (failReceipt) vi.mocked(lease.notCreated).mockRejectedValue(new Error('secondary receipt failure'));
    try {
      await expect(start()).rejects.toMatchObject({ name: 'LaunchesClosedError' });
      expect(lease.notCreated).toHaveBeenCalledOnce(); expect(mockPtySpawn).not.toHaveBeenCalled();
      expect(agentRegistry.get('managed-launch')).toBeUndefined();
    } finally { reopenLaunches(); }
  });

});

describe('withDispatcherStartModel (#3045, #3191)', () => {
  const base = { agentId: 'd', projectPath: '/dispatcher-folder', cwd: '/dispatcher-folder', kind: 'durable' as const, model: 'old', orchestrator: 'claude-code' as const, resume: true, sessionId: 's1' };

  it('leaves a start alone with no model, and takes Behavior\'s model over the caller\'s', () => {
    expect(withDispatcherStartModel(base, null)).toBe(base);
    expect(withDispatcherStartModel(base, { model: 'sonnet' })).toEqual({ ...base, model: 'sonnet' });
  });

  it('starts a pick on its own provider, dropping a session the caller saw on another CLI', () => {
    expect(withDispatcherStartModel(base, { model: 'opus', orchestrator: 'claude-code' })).toEqual({ ...base, model: 'opus' });
    expect(withDispatcherStartModel(base, { model: 'terra', orchestrator: 'codex-cli' }))
      .toEqual({ ...base, model: 'terra', orchestrator: 'codex-cli', resume: false, sessionId: undefined });
    // A caller that named no CLI keeps its session, unless the record itself just moved to another CLI (QA L7).
    expect(withDispatcherStartModel({ ...base, orchestrator: undefined }, { model: 'terra', orchestrator: 'codex-cli' }))
      .toEqual({ ...base, model: 'terra', orchestrator: 'codex-cli' });
    expect(withDispatcherStartModel({ ...base, orchestrator: undefined }, { model: 'terra', orchestrator: 'codex-cli', providerChanged: true }))
      .toEqual({ ...base, model: 'terra', orchestrator: 'codex-cli', resume: false, sessionId: undefined });
    expect(withDispatcherStartModel({ ...base, orchestrator: 'codex-cli' }, { model: 'terra', orchestrator: 'codex-cli', providerChanged: true }))
      .toEqual({ ...base, model: 'terra', orchestrator: 'codex-cli', resume: false, sessionId: undefined });
  });
});
