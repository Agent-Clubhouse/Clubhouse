/** See the block comment below the imports. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ANTIGRAVITY_PROVIDER_ID } from '../../../shared/providers/antigravity';

vi.mock('../../util/shell', async (importActual) => ({
  ...await importActual<typeof import('../../util/shell')>(),
  getShellEnvironment: vi.fn(() => ({ PATH: '/bin', HOME: '/home' })),
}));
// The registered default path: Chat on, no saved driver preference.
vi.mock('../chat-runtime-settings', () => ({ resolveRuntimeMode: vi.fn(() => ({ mode: 'chat' })) }));
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
  ANTIGRAVITY_BRIDGE_AUTH_DEADLINE_MS: 60_000,
  AntigravityMcpConfigError: class AntigravityMcpConfigError extends Error {},
  checkClubhouseCollisions: vi.fn(async () => mcpConfig.collision),
  awaitAuthenticatedBridge: vi.fn(async () => mcpConfig.fence),
  FENCE_REASONS: { timeout: 'The Clubhouse MCP bridge did not authenticate in time.', nonce_changed: 'restarted', aborted: 'cancelled' },
}));

import type { OrchestratorProvider } from '../../orchestrators';
import { tryStartChatAgent, type ChatStartFacts } from './chat-spawn';
import { clearChatDrivers, registerChatDriver } from './chat-drivers';
import { clearChatRuntimes, getAgentRuntime } from './index';
import { clearDriverHealth } from './chat-driver-health';
import { createAntigravityAcpDriver, ANTIGRAVITY_LOGIN_HINT } from '../../chat/antigravity';
import { createFakeAgy, type FakeAgy, type FakeAgyConfig } from '../../orchestrators/adapters/testing/fake-agy';

/**
 * End to end with the fake `agy` (#3797, registration): the real Antigravity
 * ACP driver, registered as startup registers it (not opt-in, no saved driver
 * preference), started over a real stdio child. A failed start ends as
 * `failed` with the reason and never opens the terminal; a good one is chat.
 */

const fakeMcp = {
  buildAntigravityAcpBridgeServer: () => ({ name: 'clubhouse', command: 'node', args: ['bridge.js'], env: [] }),
  planAntigravityAcpMcpServers: (input: { bridge: unknown }) => ({ ok: true as const, servers: [input.bridge], notices: [] }),
};

let fakes: FakeAgy[] = [];
let cwd: string;

async function setup(config: FakeAgyConfig) {
  const fake = await createFakeAgy(config);
  fakes.push(fake);
  const shim = await fake.shim();
  registerChatDriver(createAntigravityAcpDriver({ mcp: fakeMcp as never, logDir: cwd }));
  const provider = { id: ANTIGRAVITY_PROVIDER_ID, conventions: { mcpConfigFile: '.agents/mcp_config.json' }, getBinaryPath: () => shim } as unknown as OrchestratorProvider;
  const params = { agentId: 'agent-e2e', projectPath: cwd, cwd, kind: 'durable' as const, permissionMode: 'auto' as const, mission: 'hello' };
  return { fake, provider, params };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearChatDrivers();
  clearChatRuntimes();
  clearDriverHealth();
  servers.configured = {};
  mcpConfig.collision = { ok: true };
  mcpConfig.fence = { ok: true, connectedAt: Date.now() + 1 };
  cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-e2e-')));
});

afterEach(async () => {
  await getAgentRuntime('agent-e2e')?.stop();
  for (const f of fakes) await f.dispose();
  fakes = [];
  fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('Antigravity chat, registered, against the fake agy', () => {
  it('a start that needs a sign-in fails explicitly with the hint, and never opens the terminal', async () => {
    const { provider, params } = await setup({ acp: { auth: 'required' } });
    const facts: ChatStartFacts = { attempts: [] };
    const result = await tryStartChatAgent(params, provider, undefined, null, undefined, facts);
    expect(result).toBe('failed');
    expect(result).not.toBe('terminal');
    expect(facts.failure).toContain(ANTIGRAVITY_LOGIN_HINT);
    expect(pipeline.restoreForAgent).toHaveBeenCalledWith('agent-e2e');
  }, 30_000);

  it('a start that fails the bridge identity fence fails explicitly too', async () => {
    mcpConfig.fence = { ok: false, reason: 'timeout' };
    const { provider, params } = await setup({});
    const facts: ChatStartFacts = { attempts: [] };
    expect(await tryStartChatAgent(params, provider, undefined, null, undefined, facts)).toBe('failed');
    expect(facts.failure).toMatch(/did not authenticate/);
  }, 30_000);

  it('a good start opens chat on the registered driver with no saved preference', async () => {
    const { fake, provider, params } = await setup({});
    expect(await tryStartChatAgent(params, provider, undefined, null)).toBe('chat');
    const report = await fake.waitForReport((r) => (r.acp?.received ?? []).some((m: { method: string }) => m.method === 'session/new'), 'acp', 15_000);
    expect(report.acp?.received.some((m: { method: string }) => m.method === 'session/new')).toBe(true);
  }, 30_000);
});
