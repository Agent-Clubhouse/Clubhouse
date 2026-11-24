/**
 * Antigravity launch hunks in agent-system (#3793): a refused MCP config or a
 * configured `clubhouse` collision launches nothing; other injection errors
 * keep today's behaviour; a bridge that never authenticates for this launch
 * stops the run with the reason. The mock preamble is copied from
 * agent-system.test.ts so that file stays untouched.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { mkdirSync } from 'fs';
import { app } from 'electron';
import type { OrchestratorConventions } from '../orchestrators';
import { IPC } from '../../shared/ipc-channels';
import type { FreeAgentPermissionMode } from '../../shared/types';
import { resolveHelperAccess, type AgentLaunchAccess } from '../../shared/orchestration-policy';

// Mock config-pipeline
const mockSnapshotFile = vi.fn();
const mockRestoreForAgent = vi.fn();
const mockGetHooksConfigPath = vi.fn((..._args: unknown[]) => '/project/.claude/settings.local.json');
const mockStripClubhouseHooksFromFile = vi.fn(async (..._args: unknown[]) => false);
const mockPreserveUnchangedSnapshot = vi.fn(async (..._args: unknown[]) => {});
vi.mock('./config-pipeline', () => ({
  preserveUnchangedSnapshot: (...args: unknown[]) => mockPreserveUnchangedSnapshot(...(args as [])),
  stripClubhouseHooksFromFile: (...args: unknown[]) => mockStripClubhouseHooksFromFile(...args),
  snapshotFile: (...args: unknown[]) => mockSnapshotFile(...args),
  restoreForAgent: (...args: unknown[]) => mockRestoreForAgent(...args),
  getHooksConfigPath: (...args: unknown[]) => mockGetHooksConfigPath(...args),
  restoreAll: vi.fn(),
}));

// Mock pty-manager
const mockPtySpawn = vi.fn();
const mockPtyGracefulKill = vi.fn();
const mockStopCreatedProcess = vi.fn((..._args: unknown[]) => false);
const mockPtyIsRunning = vi.fn((..._args: unknown[]) => false);
const mockPtyProcessIdentity = vi.fn((..._args: unknown[]): string | undefined => undefined);
const mockPtyKill = vi.fn();
vi.mock('./pty-manager', () => ({
  spawn: (...args: unknown[]) => mockPtySpawn(...args),
  kill: (...args: unknown[]) => mockPtyKill(...args),
  gracefulKill: (...args: unknown[]) => mockPtyGracefulKill(...args),
  stopCreatedProcessIfCurrent: (...args: unknown[]) => mockStopCreatedProcess(...args),
  isRunning: (...args: unknown[]) => mockPtyIsRunning(...args),
  processIdentity: (...args: unknown[]) => mockPtyProcessIdentity(...args),
}));

// Mock headless-manager
const mockHeadlessSpawn = vi.fn();
const mockHeadlessKill = vi.fn();
const mockIsHeadless = vi.fn((..._args: unknown[]) => false);
vi.mock('./headless-manager', () => ({
  spawnHeadless: (...args: unknown[]) => mockHeadlessSpawn(...args),
  kill: (...args: unknown[]) => mockHeadlessKill(...args),
  isHeadless: (...args: unknown[]) => mockIsHeadless(...args),
  hasPid: () => true,
}));

// Mock headless-settings
const mockGetSpawnMode = vi.fn((..._args: unknown[]) => 'interactive' as const);
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
const mockGetDurableConfig = vi.fn((..._args: unknown[]) => null);
const mockAddSessionEntry = vi.fn();
const mockUpdateSessionId = vi.fn(async (..._args: unknown[]) => {});
const mockGetSessionHistory = vi.fn(async (): Promise<Array<{ sessionId: string; startedAt: string; lastActiveAt: string }>> => []);
const mockRemoveSessionEntries = vi.fn(async (..._args: unknown[]) => {});
const mockContextWindowForLaunch = vi.fn();
vi.mock('./context-window', () => ({
  contextWindowForLaunch: (...args: unknown[]) => mockContextWindowForLaunch(...args),
}));

// Saved provider profiles' old state folders (#2749): none unless a test says so.
const mockRemovedProfileStateDirs = vi.fn(async (_providerId: string): Promise<string[]> => []);
vi.mock('./provider-profiles-removed', () => ({ removedProfileStateDirs: (id: string) => mockRemovedProfileStateDirs(id) }));

vi.mock('./agent-config', () => ({
  initializeDurableProject: vi.fn(async () => {}),
  getSessionHistory: (...args: unknown[]) => mockGetSessionHistory(...(args as [])),
  removeSessionEntries: (...args: unknown[]) => mockRemoveSessionEntries(...(args as [])),
  getDurableConfig: (...args: unknown[]) => mockGetDurableConfig(...args),
  peekCachedDurableConfig: () => mockGetDurableConfig(),
  addSessionEntry: (...args: unknown[]) => mockAddSessionEntry(...args),
  updateSessionId: (...args: unknown[]) => mockUpdateSessionId(...args),
  updateDurableConfig: (...args: unknown[]) => mockUpdateDurableConfig(...args),
}));
const mockUpdateDurableConfig = vi.fn(async (..._args: unknown[]) => {});

// One folder stands for the Dispatcher's (#3185), another for its chat's (#3578).
vi.mock('./dispatcher/dispatcher-paths', async (importOriginal) => ({
  ...await importOriginal<typeof import('./dispatcher/dispatcher-paths')>(),
  isDispatcherPath: (p: string | undefined | null) => p === '/dispatcher-folder' || p === '/dispatcher-chat-folder',
  isDispatcherChatPath: (p: string | undefined | null) => p === '/dispatcher-chat-folder',
}));
// 'dispatcher-chat-id' is the chat's agent id (#3578); the gate asks the service.
vi.mock('./dispatcher/dispatcher-service', async (importOriginal) => ({
  ...await importOriginal<typeof import('./dispatcher/dispatcher-service')>(),
  isDispatcherChatAgentId: (id: string | undefined | null) => id === 'dispatcher-chat-id',
}));
// The Dispatcher is off as saved unless a test turns it on, so its durable starts are refused.
const dispatcherOn = vi.hoisted(() => ({ value: false }));
vi.mock('./dispatcher/dispatcher-settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./dispatcher/dispatcher-settings')>();
  return { ...actual, dispatcherEnablement: () => (dispatcherOn.value ? { ...actual.dispatcherEnablement(), enabled: true } : actual.dispatcherEnablement()) };
});

// Chat start runs for real unless a test stands in for it (to fail a chat resume).
const { mockTryStartChatAgent, mockCancelChatStart } = vi.hoisted(() => ({ mockTryStartChatAgent: vi.fn(), mockCancelChatStart: vi.fn() }));
vi.mock('./agent-runtime/chat-spawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agent-runtime/chat-spawn')>();
  mockTryStartChatAgent.mockImplementation(actual.tryStartChatAgent);
  mockCancelChatStart.mockImplementation(actual.cancelChatStart);
  return {
    ...actual,
    tryStartChatAgent: (...args: Parameters<typeof actual.tryStartChatAgent>) => mockTryStartChatAgent(...args),
    cancelChatStart: (...args: Parameters<typeof actual.cancelChatStart>) => mockCancelChatStart(...args),
  };
});

const mockCleanupStaleJsonInTomlConfigs = vi.fn();
const mockStripLegacyClubhouseBridgeToml = vi.fn(async (..._args: unknown[]) => false);
const mockDeliverForSpawn = vi.fn(async (..._args: unknown[]) => {});
const mockManagedProviderStartGuard = vi.hoisted(() => vi.fn(async () => () => {}));
vi.mock('./managed-provider-transition', () => ({ managedProviderStartGuard: mockManagedProviderStartGuard }));
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
  stripLegacyClubhouseBridgeToml: (...args: unknown[]) => mockStripLegacyClubhouseBridgeToml(...args),
}));

// Mock agent-settings-service
const mockReadProjectAgentDefaults = vi.fn((..._args: unknown[]) => ({}));
const mockReadLaunchWrapper = vi.fn((..._args: unknown[]) => undefined);
const mockReadDefaultMcps = vi.fn((..._args: unknown[]) => []);
const mockReadMcpConfigs = vi.fn((..._args: unknown[]) => ({}));
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
const mockValidateWrapperConfig = vi.fn((..._args: unknown[]) => ({ ok: true as const }));
vi.mock('../orchestrators/shared', () => ({
  applyLaunchWrapper: (...args: Parameters<typeof mockApplyLaunchWrapper>) => mockApplyLaunchWrapper(...args),
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
const mockReadFile = vi.fn((..._args: unknown[]): Promise<string> => Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })));
const mockWriteFile = vi.fn(async (_file: unknown, _content: unknown, _encoding?: unknown) => {});
const mockRename = vi.fn(async (_from: unknown, _to: unknown) => {});
vi.mock('fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs/promises')>()),
  readFile: (...args: unknown[]) => mockReadFile(...args),
  writeFile: (...args: Parameters<typeof mockWriteFile>) => mockWriteFile(...args),
  rename: (...args: Parameters<typeof mockRename>) => mockRename(...args),
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

const mockAntigravityProvider = {
  ...mockProvider,
  id: 'antigravity-cli',
  displayName: 'Antigravity CLI',
  shortName: 'AG',
  conventions: { ...mockClaudeConventions, configDir: '.agents', localInstructionsFile: 'AGENTS.md', mcpConfigFile: '.agents/mcp_config.json' },
  getCapabilities: vi.fn(() => ({
    headless: false, structuredOutput: false, hooks: false,
    sessionResume: false, permissions: true,
  })),
};

// A short fence deadline so the refusal path runs within the test.
vi.mock('../orchestrators/antigravity/mcp-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../orchestrators/antigravity/mcp-config')>()),
  ANTIGRAVITY_BRIDGE_AUTH_DEADLINE_MS: 30,
}));

// Mocks for the MCP bridge/injection path exercised when mcpPort > 0.
// Default to the real module's "not started" rejection so existing tests
// (which don't care about MCP injection) keep seeing mcpPort stay 0.
const mockMcpWaitReady = vi.fn((..._args: unknown[]): Promise<number> => Promise.reject(new Error('MCP bridge server not started')));
const mockGetCurrentAgentConnection = vi.fn((_agentId: string): { connectedAt: number } | null => null);
vi.mock('./clubhouse-mcp/bridge-server', () => ({
  waitReady: (...args: unknown[]) => mockMcpWaitReady(...args),
  getCurrentAgentConnection: (agentId: string) => mockGetCurrentAgentConnection(agentId),
  NONCE_HEADER: 'X-Clubhouse-Nonce',
  agentEndpointUrl: (port: number, agentId: string) => `http://127.0.0.1:${port}/mcp/${agentId}`,
}));

const mockInjectClubhouseMcp = vi.fn((..._args: unknown[]) => Promise.resolve());
const mockBuildClubhouseMcpDef = vi.fn((port: number) => ({
  command: 'node',
  args: ['bridge.js'],
  env: { CLUBHOUSE_MCP_PORT: String(port) },
}));
vi.mock('./clubhouse-mcp/injection', () => ({
  injectClubhouseMcp: (...args: unknown[]) => mockInjectClubhouseMcp(...args),
  buildClubhouseMcpDef: (...args: Parameters<typeof mockBuildClubhouseMcpDef>) => mockBuildClubhouseMcpDef(...args),
  CLUBHOUSE_NONCE_ENV: 'CLUBHOUSE_HOOK_NONCE',
}));

type MockProviderShape = Record<string, unknown> & { getCapabilities(): Record<string, boolean> };
vi.mock('../orchestrators', () => ({
  getProvider: vi.fn((id: string) => {
    if (id === 'claude-code') return mockProvider;
    if (id === 'codex-cli') return mockCodexProvider;
    if (id === 'copilot-cli') return mockCopilotProvider;
    if (id === 'antigravity-cli') return mockAntigravityProvider;
    return undefined;
  }),
  getAllProviders: vi.fn(() => [mockProvider, mockCodexProvider]),
  isHookCapable: vi.fn((p: MockProviderShape) => p.getCapabilities().hooks && typeof p.writeHooksConfig === 'function'),
  isHeadlessCapable: vi.fn((p: MockProviderShape) => p.getCapabilities().headless && typeof p.buildHeadlessCommand === 'function'),
  isSessionCapable: vi.fn((p: MockProviderShape) => p.getCapabilities().sessionResume && typeof p.listSessions === 'function'),
  isAgentFileCapable: vi.fn((p: MockProviderShape) => typeof p.buildAgentFileArgs === 'function'),
}));

// Per-orchestrator hook server gating. Defaults to enabled so existing
// injection assertions hold; individual tests override it to exercise the gate.
const mockIsHookServerEnabled = vi.fn((..._args: unknown[]) => true);
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
  spawnAgent,
  untrackAgent,
} from './agent-system';
import * as os from 'os';
import { resolveProjectMcpServers } from './agent-mcp-servers';


import * as fsp from 'fs';
import { AntigravityMcpConfigError, FENCE_REASONS } from '../orchestrators/antigravity/mcp-config';
import { emitAgentMcpConnected } from './clubhouse-mcp/connection-events';

describe('Antigravity launch: MCP config refusals and the identity fence', () => {
  let home: string;
  const savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const spawnAntigravity = () => spawnAgent({ agentId: 'agent-1', projectPath: '/project', cwd: '/project/worktree', kind: 'durable', orchestrator: 'antigravity-cli' });

  beforeAll(() => { mkdirSync(app.getPath('userData'), { recursive: true }); });
  beforeEach(() => {
    vi.clearAllMocks();
    mockManagedProviderStartGuard.mockReset().mockResolvedValue(() => {});
    home = fsp.mkdtempSync(path.join(os.tmpdir(), 'agy-launch-home-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    vi.mocked(resolveProjectMcpServers).mockResolvedValue({});
    // The temp HOME's real files; everything else keeps the shared preamble's ENOENT.
    mockReadFile.mockImplementation(async (...args: unknown[]) => {
      if (String(args[0]).startsWith(home)) return (await vi.importActual<typeof import('fs/promises')>('fs/promises')).readFile(args[0] as string, 'utf-8');
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockGetCurrentAgentConnection.mockReturnValue(null);
  });
  afterEach(() => {
    process.env.HOME = savedEnv.HOME;
    process.env.USERPROFILE = savedEnv.USERPROFILE;
    fsp.rmSync(home, { recursive: true, force: true });
    untrackAgent('agent-1');
  });

  it('a project server named clubhouse refuses before anything is written or spawned', async () => {
    vi.mocked(resolveProjectMcpServers).mockResolvedValueOnce({ clubhouse: { command: 'evil' } });
    mockMcpWaitReady.mockResolvedValueOnce(23456);
    await expect(spawnAntigravity()).rejects.toMatchObject({ code: 'collision' });
    expect(mockInjectClubhouseMcp).not.toHaveBeenCalled();
    expect(mockSnapshotFile).not.toHaveBeenCalledWith('agent-1', expect.stringContaining('mcp_config'));
    // The hooks snapshot taken earlier is released without a cleanup write.
    expect(mockPreserveUnchangedSnapshot).toHaveBeenCalled();
    expect(mockRestoreForAgent).toHaveBeenCalledWith('agent-1');
    expect(mockPtySpawn).not.toHaveBeenCalled();
  });

  it('a global clubhouse server in temp HOME refuses, and the global bytes are unchanged', async () => {
    const globalFile = path.join(home, '.gemini', 'config', 'mcp_config.json');
    mkdirSync(path.dirname(globalFile), { recursive: true });
    fsp.writeFileSync(globalFile, '{"mcpServers": {"clubhouse": {"command": "x"}}}');
    mockMcpWaitReady.mockResolvedValueOnce(23456);
    await expect(spawnAntigravity()).rejects.toBeInstanceOf(AntigravityMcpConfigError);
    expect(mockPtySpawn).not.toHaveBeenCalled();
    expect(fsp.readFileSync(globalFile, 'utf-8')).toBe('{"mcpServers": {"clubhouse": {"command": "x"}}}');
  });

  it('an unparsable global config refuses', async () => {
    const globalFile = path.join(home, '.gemini', 'config', 'mcp_config.json');
    mkdirSync(path.dirname(globalFile), { recursive: true });
    fsp.writeFileSync(globalFile, '{');
    await expect(spawnAntigravity()).rejects.toMatchObject({ code: 'unparsable' });
    expect(mockPtySpawn).not.toHaveBeenCalled();
  });

  it('a refused workspace merge launches nothing', async () => {
    mockMcpWaitReady.mockResolvedValueOnce(23456);
    mockInjectClubhouseMcp.mockRejectedValueOnce(new AntigravityMcpConfigError('ambiguous_ownership', 'refused'));
    await expect(spawnAntigravity()).rejects.toBeInstanceOf(AntigravityMcpConfigError);
    expect(mockPtySpawn).not.toHaveBeenCalled();
  });

  it('other injection errors keep today\'s behaviour: logged, and the run starts', async () => {
    mockMcpWaitReady.mockResolvedValueOnce(23456);
    mockInjectClubhouseMcp.mockRejectedValueOnce(new Error('disk hiccup'));
    await spawnAntigravity();
    expect(mockPtySpawn).toHaveBeenCalledTimes(1);
    expect(mockAppLog).toHaveBeenCalledWith('core:mcp', 'warn', 'MCP bridge injection skipped', expect.anything());
  });

  it('Claude Code is unaffected by the Antigravity checks', async () => {
    mockMcpWaitReady.mockResolvedValueOnce(23456);
    vi.mocked(resolveProjectMcpServers).mockResolvedValue({ clubhouse: { command: 'x' } });
    await spawnAgent({ agentId: 'agent-1', projectPath: '/project', cwd: '/project/worktree', kind: 'durable' });
    expect(mockPtySpawn).toHaveBeenCalledTimes(1);
  });

  it('a bridge that never authenticates for this launch stops the run with the reason', async () => {
    mockMcpWaitReady.mockResolvedValueOnce(23456);
    await spawnAntigravity();
    expect(mockPtySpawn).toHaveBeenCalledTimes(1);
    // An impostor answering as `clubhouse` produces at most an event, never a verified connection.
    emitAgentMcpConnected('agent-1');
    await vi.waitFor(() => expect(mockPtyKill).toHaveBeenCalledWith('agent-1'));
    expect(mockBroadcastToAllWindows).toHaveBeenCalledWith(IPC.AGENT.AGENT_MATERIALIZATION_FAILED, 'agent-1', FENCE_REASONS.timeout);
  });

  it('an authenticated bridge for this launch keeps the run', async () => {
    mockMcpWaitReady.mockResolvedValueOnce(23456);
    await spawnAntigravity();
    mockGetCurrentAgentConnection.mockReturnValue({ connectedAt: Date.now() });
    emitAgentMcpConnected('agent-1');
    await new Promise((r) => setTimeout(r, 80));
    expect(mockPtyKill).not.toHaveBeenCalled();
  });
});
