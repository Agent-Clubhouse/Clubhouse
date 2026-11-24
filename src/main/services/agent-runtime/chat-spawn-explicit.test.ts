/**
 * A provider whose failed chat start never opens the terminal by itself
 * (#3785, Antigravity): what tryStartChatAgent does for it, with a fake
 * driver. The MCP collision check and the bridge identity fence are mocked at
 * their module edges; their own logic is tested with the mcp-config module.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatDriverId } from '../../../shared/chat';
import { ANTIGRAVITY_CHAT_DRIVER_ID, ANTIGRAVITY_PROVIDER_ID } from '../../../shared/providers/antigravity';

vi.mock('../../util/shell', async (importActual) => ({
  ...await importActual<typeof import('../../util/shell')>(),
  getShellEnvironment: vi.fn(() => ({ PATH: '/bin', HOME: '/home' })),
}));
vi.mock('../chat-runtime-settings', () => ({ resolveRuntimeMode: vi.fn(() => ({ mode: 'chat', driver: 'antigravity_acp' })) }));
vi.mock('./chat-transcript', () => ({ readChatTranscript: vi.fn(async () => []), listChatSessions: vi.fn(async () => []), appendChatEvent: vi.fn(async () => {}) }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
const registry = vi.hoisted(() => ({ setNonce: vi.fn(), setRuntime: vi.fn(), get: vi.fn(), setLaunchCap: vi.fn(), setUserLaunchAccess: vi.fn(), reportLaunchAccess: vi.fn(), onAuthChange: vi.fn(() => () => {}) }));
vi.mock('../agent-registry', () => ({ agentRegistry: registry, untrackAgent: vi.fn(), getAgentNonce: vi.fn(() => 'nonce') }));
const pipeline = vi.hoisted(() => ({ snapshotFile: vi.fn(), restoreForAgent: vi.fn() }));
vi.mock('../config-pipeline', () => pipeline);
vi.mock('../clubhouse-mcp/bridge-server', () => ({
  waitReady: vi.fn(async () => 4321),
  NONCE_HEADER: 'X-Clubhouse-Nonce',
  agentEndpointUrl: (port: number, agentId: string) => `http://127.0.0.1:${port}/mcp/${agentId}`,
  getCurrentAgentConnection: vi.fn(() => null),
}));
vi.mock('../clubhouse-mcp/connection-events', () => ({ onAgentMcpConnected: vi.fn(() => () => {}) }));
const injection = vi.hoisted(() => ({
  injectClubhouseMcp: vi.fn(async () => {}),
  buildClubhouseMcpDef: vi.fn(() => ({ command: 'node', args: ['bridge.js'] })),
  CLUBHOUSE_NONCE_ENV: 'CLUBHOUSE_HOOK_NONCE',
  isInjectedClubhouseBridge: vi.fn(() => false),
  isClubhouseMcpEntry: vi.fn((def: { bridge?: boolean }) => def?.bridge === true),
}));
vi.mock('../clubhouse-mcp/injection', () => injection);
const servers = vi.hoisted(() => ({ configured: {} as Record<string, unknown> }));
vi.mock('../agent-mcp-servers', () => ({ resolveAgentMcpServers: vi.fn(async () => servers.configured) }));
vi.mock('../agent-config', () => ({ touchSessionEntry: vi.fn(async () => {}), updateDurableConfig: vi.fn(async () => {}) }));
vi.mock('../agent-exit-broadcast', () => ({ broadcastAgentExit: vi.fn() }));
vi.mock('../../util/ipc-broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../pty-manager', () => ({ isRunning: () => false }));
vi.mock('../annex-permission-queue', () => ({ createPermission: vi.fn(), resolvePermission: vi.fn() }));
const mcpConfig = vi.hoisted(() => ({
  collision: { ok: true } as { ok: true } | { ok: false; code: string; reason: string },
  fence: { ok: true, connectedAt: Date.now() + 1 } as { ok: true; connectedAt: number } | { ok: false; reason: 'timeout' | 'nonce_changed' | 'aborted' },
}));
vi.mock('../../orchestrators/antigravity/mcp-config', () => ({
  checkClubhouseCollisions: vi.fn(async () => mcpConfig.collision),
  awaitAuthenticatedBridge: vi.fn(async () => mcpConfig.fence),
  FENCE_REASONS: { timeout: 'The Clubhouse MCP bridge did not authenticate in time.', nonce_changed: 'restarted', aborted: 'cancelled' },
}));

import type { OrchestratorProvider } from '../../orchestrators';
import { checkClubhouseCollisions, awaitAuthenticatedBridge } from '../../orchestrators/antigravity/mcp-config';
import { announceChatStartFailure, tryStartChatAgent, type ChatStartFacts } from './chat-spawn';
import { clearChatDrivers, registerChatDriver } from './chat-drivers';
import { clearChatRuntimes, getAgentRuntime } from './index';
import { clearDriverHealth } from './chat-driver-health';
import { FakeChatDriver } from './fake-chat-driver';
import { broadcastToAllWindows } from '../../util/ipc-broadcast';
import { IPC } from '../../../shared/ipc-channels';

const agy = {
  id: ANTIGRAVITY_PROVIDER_ID,
  conventions: { mcpConfigFile: '.agents/mcp_config.json' },
  getBinaryPath: () => '/home/me/.local/bin/agy',
} as unknown as OrchestratorProvider;
const params = { agentId: 'agent-1', projectPath: '/p', cwd: '/p/wt', kind: 'durable' as const, permissionMode: 'auto' as const, mission: 'hello' };

function driver() {
  const d = new FakeChatDriver(ANTIGRAVITY_CHAT_DRIVER_ID as ChatDriverId, ANTIGRAVITY_PROVIDER_ID);
  registerChatDriver(d);
  return d;
}

const notices = () => vi.mocked(broadcastToAllWindows).mock.calls.filter((c) => c[0] === IPC.CHAT.RUNTIME_NOTICE).map((c) => c[2] as { code: string; message: string });

beforeEach(() => {
  vi.clearAllMocks();
  clearChatDrivers();
  clearChatRuntimes();
  clearDriverHealth();
  servers.configured = {};
  mcpConfig.collision = { ok: true };
  mcpConfig.fence = { ok: true, connectedAt: Date.now() + 1 };
});

describe('explicit chat start failure (Antigravity)', () => {
  it('starts in chat once the bridge authenticated, with no workspace MCP file written', async () => {
    const d = driver();
    try {
      expect(await tryStartChatAgent(params, agy, undefined, null)).toBe('chat');
      expect(awaitAuthenticatedBridge).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent-1', expectedNonce: expect.any(String) }), expect.any(Object));
      expect(injection.injectClubhouseMcp).not.toHaveBeenCalled();
      expect(pipeline.snapshotFile).not.toHaveBeenCalled();
      expect(d.sessions).toHaveLength(1);
    } finally { await getAgentRuntime('agent-1')?.stop(); }
  });

  it('a fence failure closes the session before the mission is sent and returns failed, not terminal', async () => {
    const d = driver();
    mcpConfig.fence = { ok: false, reason: 'timeout' };
    const facts: ChatStartFacts = { attempts: [] };
    expect(await tryStartChatAgent(params, agy, undefined, null, undefined, facts)).toBe('failed');
    expect(d.last.closed).toBe(true);
    expect(d.last.sent).toEqual([]);
    expect(facts.failure).toMatch(/did not authenticate in time/);
    expect(getAgentRuntime('agent-1')).toBeUndefined();
    // No fallback notice: the caller announces the failure after the exit.
    expect(notices()).toEqual([]);
  });

  it('a configured server named clubhouse refuses the start before any driver session', async () => {
    const d = driver();
    servers.configured = { clubhouse: { command: 'impostor' }, docs: { command: 'docs' } };
    mcpConfig.collision = { ok: false, code: 'collision', reason: 'A server named "clubhouse" is configured.' };
    const facts: ChatStartFacts = { attempts: [] };
    expect(await tryStartChatAgent(params, agy, undefined, null, undefined, facts)).toBe('failed');
    expect(checkClubhouseCollisions).toHaveBeenCalledWith({ projectServers: { clubhouse: { command: 'impostor' }, docs: { command: 'docs' } } });
    expect(d.sessions).toEqual([]);
    expect(facts.failure).toMatch(/named "clubhouse"/);
  });

  it('Clubhouse\'s own bridge entry in the list is not a collision', async () => {
    driver();
    servers.configured = { clubhouse: { bridge: true }, docs: { command: 'docs' } };
    try {
      expect(await tryStartChatAgent(params, agy, undefined, null)).toBe('chat');
      expect(checkClubhouseCollisions).toHaveBeenCalledWith({ projectServers: { docs: { command: 'docs' } } });
    } finally { await getAgentRuntime('agent-1')?.stop(); }
  });

  it('a driver start error returns failed with the reason', async () => {
    const d = driver();
    vi.spyOn(d, 'start').mockRejectedValue(new Error('Authentication required: Run `agy` in a terminal to sign in'));
    const facts: ChatStartFacts = { attempts: [] };
    expect(await tryStartChatAgent(params, agy, undefined, null, undefined, facts)).toBe('failed');
    expect(facts.failure).toMatch(/Run `agy` in a terminal to sign in/);
    expect(pipeline.restoreForAgent).toHaveBeenCalledWith('agent-1');
  });

  it('no registered driver or no binary is a failure too, never the terminal', async () => {
    expect(await tryStartChatAgent(params, agy, undefined, null)).toBe('failed');
    driver();
    const missing = { ...agy, getBinaryPath: () => { throw new Error('not found'); } } as unknown as OrchestratorProvider;
    expect(await tryStartChatAgent(params, missing, undefined, null)).toBe('failed');
  });

  it('announces the failure as unsent, or as maybe sent after the session started', () => {
    announceChatStartFailure('agent-1', { attempts: [], failure: 'Antigravity CLI chat didn\'t start: x' }, params);
    announceChatStartFailure('agent-1', { attempts: [{ driver: 'antigravity_acp' as ChatDriverId, checkMs: 1, reason: 'failed_after_session_start' }], failure: 'y' }, params);
    expect(notices().map((n) => n.code)).toEqual(['chat_start_failed', 'chat_start_failed_after_start']);
  });
});
