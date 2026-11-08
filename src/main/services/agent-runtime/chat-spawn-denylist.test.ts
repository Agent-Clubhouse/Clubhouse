import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The kill switch from the client's side, nothing faked between the manifest and
 * the verdict: a manifest the publish path wrote, the real list store logic, the
 * real version policy and the real chat start. Only the CLI itself is a fake, and
 * no prompt is ever sent.
 */

const stores = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../settings-store', () => ({
  createSettingsStore: (name: string, defaults: unknown) => ({
    get: () => stores.get(name) ?? defaults,
    save: async (value: unknown) => { stores.set(name, value); },
  }),
}));
vi.mock('../../util/shell', async (importActual) => ({
  ...await importActual<typeof import('../../util/shell')>(),
  getShellEnvironment: vi.fn(() => ({ PATH: '/shell/bin', HOME: '/shell/home' })),
}));
vi.mock('../chat-runtime-settings', () => ({ resolveRuntimeMode: vi.fn(() => ({ mode: 'chat' })) }));
vi.mock('./chat-transcript', () => ({
  readChatTranscript: vi.fn(async () => []),
  listChatSessions: vi.fn(async () => []),
  appendChatEvent: vi.fn(async () => {}),
}));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../agent-registry', () => ({
  agentRegistry: { setNonce: vi.fn(), setRuntime: vi.fn(), get: vi.fn(), setLaunchCap: vi.fn(), setUserLaunchAccess: vi.fn(), reportLaunchAccess: vi.fn() },
  untrackAgent: vi.fn(),
}));
vi.mock('../config-pipeline', () => ({ snapshotFile: vi.fn(), restoreForAgent: vi.fn() }));
vi.mock('../clubhouse-mcp/bridge-server', () => ({
  waitReady: vi.fn(async () => 4321),
  NONCE_HEADER: 'X-Clubhouse-Nonce',
  agentEndpointUrl: (port: number, agentId: string) => `http://127.0.0.1:${port}/mcp/${agentId}`,
}));
vi.mock('../clubhouse-mcp/injection', () => ({
  injectClubhouseMcp: vi.fn(async () => {}),
  buildClubhouseMcpDef: vi.fn(() => ({ type: 'http', url: 'http://127.0.0.1:4321/mcp' })),
  CLUBHOUSE_NONCE_ENV: 'CLUBHOUSE_HOOK_NONCE',
}));
vi.mock('../agent-mcp-servers', () => ({ resolveAgentMcpServers: vi.fn(async () => ({})) }));
vi.mock('../agent-config', () => ({ touchSessionEntry: vi.fn(async () => {}), updateDurableConfig: vi.fn(async () => {}) }));
vi.mock('../agent-exit-broadcast', () => ({ broadcastAgentExit: vi.fn() }));
vi.mock('../../util/ipc-broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../pty-manager', () => ({ isRunning: () => false }));
vi.mock('../annex-permission-queue', () => ({ createPermission: vi.fn(), resolvePermission: vi.fn() }));

import { setManifestList } from '../../../../scripts/ci/cli-denylist.mjs';
import { tryStartChatAgent } from './chat-spawn';
import { applyRemoteCliDenylist } from './chat-version-policy';
import { registerChatDriver, clearChatDrivers } from './chat-drivers';
import { clearChatRuntimes, getAgentRuntime } from './index';
import { clearDriverHealth } from './chat-driver-health';
import { FakeChatDriver } from './fake-chat-driver';
import { broadcastToAllWindows } from '../../util/ipc-broadcast';
import { IPC } from '../../../shared/ipc-channels';
import type { OrchestratorProvider } from '../../orchestrators';

const provider = {
  id: 'claude-code',
  conventions: { mcpConfigFile: '.mcp.json' },
  getBinaryPath: () => '/usr/local/bin/claude',
} as unknown as OrchestratorProvider;

const params = {
  agentId: 'agent-1', projectPath: '/p', cwd: '/p/wt', kind: 'durable' as const,
  permissionMode: 'auto' as const, mission: 'hello',
};

const BAD = '2.1.250';

/** Both Claude drivers, on a CLI that reports `version`. */
function drivers(version = BAD) {
  const sdk = new FakeChatDriver('claude_agent_sdk');
  const stream = new FakeChatDriver('claude_stream_json');
  for (const driver of [sdk, stream]) {
    driver.probe = async () => ({ handshakeOk: true, cliVersion: version, capabilities: driver.capabilities });
    registerChatDriver(driver);
  }
  return { sdk, stream };
}

/** What an update check does with a manifest the publish path wrote. */
async function receiveManifestWith(list: unknown[]) {
  const { text } = setManifestList('{\n  "version": "0.42.0"\n}\n', list);
  await applyRemoteCliDenylist(JSON.parse(text).chatCliDenylist);
}

const start = () => tryStartChatAgent(params, provider, undefined, null);
const toasts = () => vi.mocked(broadcastToAllWindows).mock.calls
  .filter((c) => c[0] === IPC.CHAT.RUNTIME_NOTICE)
  .map((c) => c[2] as { code: string; message: string });

beforeEach(() => {
  vi.clearAllMocks();
  stores.clear();
  clearChatDrivers();
  clearChatRuntimes();
  clearDriverHealth();
});

afterEach(async () => {
  await getAgentRuntime(params.agentId)?.stop();
});

describe('a manifest entry at the next chat start', () => {
  it('stays in chat with no entry', async () => {
    const { sdk } = drivers();
    expect(await start()).toBe('chat');
    expect(sdk.sessions).toHaveLength(1);
  });

  it('a provider entry sends the matching CLI to the terminal, and says why', async () => {
    const { sdk, stream } = drivers();
    await receiveManifestWith([{ provider: 'claude-code', versions: [BAD], reason: 'hangs on start' }]);
    expect(await start()).toBe('terminal');
    expect(sdk.sessions).toHaveLength(0);
    expect(stream.sessions).toHaveLength(0);
    expect(toasts()[0]).toMatchObject({ code: 'fallback' });
    expect(toasts()[0].message).toContain(`Claude Code ${BAD} is known to break chat: hangs on start`);
  });

  it('a driver entry drops one mode, to the next driver of the same CLI', async () => {
    const { sdk, stream } = drivers();
    await receiveManifestWith([{ driver: 'claude_agent_sdk', versions: [BAD], reason: 'SDK only' }]);
    expect(await start()).toBe('chat');
    expect(sdk.sessions).toHaveLength(0);
    expect(stream.sessions).toHaveLength(1);
  });

  it('a range entry matches inside the range', async () => {
    drivers();
    await receiveManifestWith([{ provider: 'claude-code', range: { from: '2.1.200', to: '2.1.300' }, reason: 'hangs' }]);
    expect(await start()).toBe('terminal');
  });

  it.each([
    ['another version', { provider: 'claude-code', versions: ['2.1.251'], reason: 'hangs' }],
    ['another provider', { provider: 'codex-cli', versions: [BAD], reason: 'hangs' }],
    ['a range that stops short', { provider: 'claude-code', range: { to: '2.1.249' }, reason: 'hangs' }],
  ])('%s leaves chat on', async (_label, entry) => {
    const { sdk } = drivers();
    await receiveManifestWith([entry]);
    expect(await start()).toBe('chat');
    expect(sdk.sessions).toHaveLength(1);
  });

  it('does not stop an agent that is already running', async () => {
    const { sdk } = drivers();
    expect(await start()).toBe('chat');
    await receiveManifestWith([{ provider: 'claude-code', versions: [BAD], reason: 'hangs' }]);
    expect(getAgentRuntime(params.agentId)).toBeDefined();
    expect(sdk.last.closed).toBe(false);
  });

  it('a later manifest without the field keeps the block, and [] lifts it', async () => {
    drivers();
    await receiveManifestWith([{ provider: 'claude-code', versions: [BAD], reason: 'hangs' }]);

    await applyRemoteCliDenylist(JSON.parse('{ "version": "0.42.1" }').chatCliDenylist);
    expect(await start()).toBe('terminal');

    await receiveManifestWith([]);
    expect(await start()).toBe('chat');
  });
});
