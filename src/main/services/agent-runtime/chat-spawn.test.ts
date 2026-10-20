import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ChatDriver, ChatDriverSession, ChatDriverStartOptions, ChatEvent } from '../../../shared/chat';
import { CHAT_CONTRACT_VERSION } from '../../../shared/chat';
import { HOST_SESSION_ENV_FIXTURE, USER_CLAUDE_CONFIG_FIXTURE } from '../../util/__fixtures__/host-session-env';

const mode = vi.hoisted(() => ({ value: { mode: 'chat' } as { mode: 'chat' | 'terminal'; driver?: string } }));
vi.mock('../../util/shell', async (importActual) => ({
  ...await importActual<typeof import('../../util/shell')>(),
  getShellEnvironment: vi.fn(),
}));
vi.mock('../chat-runtime-settings', () => ({ resolveRuntimeMode: vi.fn(() => mode.value) }));
const transcript = vi.hoisted(() => ({ events: [] as ChatEvent[] }));
vi.mock('./chat-transcript', () => ({
  readChatTranscript: vi.fn(async () => transcript.events),
  listChatSessions: vi.fn(async () => {
    const sessions = new Map<string, { sessionId: string; nativeSessionId?: string; lastSeq: number }>();
    for (const e of transcript.events) {
      const entry = sessions.get(e.sessionId) ?? { sessionId: e.sessionId, lastSeq: 0 };
      entry.lastSeq = Math.max(entry.lastSeq, e.seq);
      if (e.type === 'session_started') entry.nativeSessionId = e.data.nativeSessionId;
      sessions.set(e.sessionId, entry);
    }
    return [...sessions.values()].reverse();
  }),
  appendChatEvent: vi.fn(async () => {}),
}));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
const registry = vi.hoisted(() => ({ setNonce: vi.fn(), setRuntime: vi.fn(), get: vi.fn(), setLaunchCap: vi.fn(), setUserLaunchAccess: vi.fn(), reportLaunchAccess: vi.fn() }));
vi.mock('../agent-registry', () => ({ agentRegistry: registry, untrackAgent: vi.fn() }));
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
vi.mock('../mcp-settings', () => ({ isMcpEnabled: vi.fn(() => true) }));
vi.mock('../materialization-service', () => ({ resolveProjectMcpServers: vi.fn(async () => ({})) }));
const agentConfig = vi.hoisted(() => ({ touchSessionEntry: vi.fn(async () => {}), updateDurableConfig: vi.fn(async () => {}) }));
vi.mock('../agent-config', () => agentConfig);
const exitBroadcast = vi.hoisted(() => ({ broadcastAgentExit: vi.fn() }));
vi.mock('../agent-exit-broadcast', () => exitBroadcast);
vi.mock('../../util/ipc-broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../pty-manager', () => ({ isRunning: () => false }));
vi.mock('../annex-permission-queue', () => ({ createPermission: vi.fn(), resolvePermission: vi.fn() }));
vi.mock('./chat-version-policy', async (importActual) => {
  const actual = await importActual<typeof import('./chat-version-policy')>();
  return { ...actual, evaluateCliVersion: vi.fn(actual.evaluateCliVersion) };
});

import { levelForFreeAgent, findChatSessionFor, tryStartChatAgent, isLoginRequiredError, cancelChatStart, hasChatStartInFlight, stopAllChatAgents, type ChatStartFacts } from './chat-spawn';
import { whenSessionCapturesSettled } from '../session-capture-barrier';
import { takeChatStartFailure } from './stale-session';
import { untrackAgent } from '../agent-registry';
import { appLog } from '../log-service';
import { registerChatDriver, clearChatDrivers } from './chat-drivers';
import { getAgentRuntime, clearChatRuntimes, isChatAgent } from './index';
import { FakeChatDriver } from './fake-chat-driver';
import type { ChatAgentRuntime } from './chat-runtime';
import type { DurableAgentConfig } from '../../../shared/types';
import { chatIdleTimeoutMs, clearAgentIdleSleep, setAgentIdleSleep } from '../chat-idle-settings';
import { clearDriverHealth, DRIVER_FAILURE_THRESHOLD } from './chat-driver-health';
import { evaluateCliVersion } from './chat-version-policy';
import { appendChatEvent, listChatSessions, readChatTranscript } from './chat-transcript';
import { broadcastToAllWindows } from '../../util/ipc-broadcast';
import { noteKillRequest } from './sleep-reason';
import { IPC } from '../../../shared/ipc-channels';
import { setProducingRuntime } from '../../telemetry/__test-utils__/producing-runtime';
import type { TelemetryRuntime } from '../../telemetry/types';
import type { OrchestratorProvider } from '../../orchestrators';
import { getShellEnvironment } from '../../util/shell';
import { injectClubhouseMcp, buildClubhouseMcpDef } from '../clubhouse-mcp/injection';
import { isMcpEnabled } from '../mcp-settings';
import { CodexChatDriver } from '../../orchestrators/adapters/codex-chat-driver';
import { ClaudeChatDriver } from '../../chat/claude/driver';
import { ClaudeSdkTransport, SDK_INIT_TIMEOUT_MS } from '../../chat/claude/sdk-transport';
import { ClaudeStartupTimeoutError } from '../../chat/claude/transport';
import * as codexFixture from '../../orchestrators/adapters/codex-protocol/__fixtures__/app-server-session';

const provider = {
  id: 'claude-code',
  conventions: { mcpConfigFile: '.mcp.json' },
  getBinaryPath: () => '/usr/local/bin/claude',
} as unknown as OrchestratorProvider;

const params = {
  agentId: 'agent-1', projectPath: '/p', cwd: '/p/wt', kind: 'durable' as const,
  permissionMode: 'auto' as const, mission: 'hello',
};

function ev(partial: Partial<ChatEvent> & Pick<ChatEvent, 'type' | 'data' | 'sessionId' | 'seq'>): ChatEvent {
  return { v: CHAT_CONTRACT_VERSION, agentId: 'agent-1', ts: 1, ...partial } as ChatEvent;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearChatDrivers();
  clearChatRuntimes();
  clearDriverHealth();
  mode.value = { mode: 'chat' };
  transcript.events = [];
  vi.mocked(getShellEnvironment).mockReturnValue({
    PATH: '/shell/bin', HOME: '/shell/home', SHELL_ONLY: 'preserved',
    CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli',
  });
});

describe('chat spawn', () => {
  it.each([undefined, { PATH: '/profile/bin', CODEX_HOME: '/profile/codex' }])(
    'uses the shell environment plus profile overrides for both probe and start (%j)', async (profile) => {
      const driver = new FakeChatDriver();
      const probe = vi.spyOn(driver as ChatDriver, 'probe');
      registerChatDriver(driver);
      expect(await tryStartChatAgent(params, provider, profile, undefined, null)).toBe('chat');
      const expected = { PATH: '/shell/bin', HOME: '/shell/home', SHELL_ONLY: 'preserved', ...profile };
      expect(probe.mock.calls[0][1]).toEqual(expected);
      expect(driver.last.startOptions?.env).toMatchObject({ ...expected, CLUBHOUSE_AGENT_ID: params.agentId });
      expect(driver.last.startOptions?.env).not.toHaveProperty('CLAUDECODE');
      expect(driver.last.startOptions?.env).not.toHaveProperty('CLAUDE_CODE_ENTRYPOINT');
      expect(getShellEnvironment()).toHaveProperty('CLAUDECODE', '1');
    },
  );

  it('strips inherited Claude Code host-session vars from probe and start env, keeping user Claude config', async () => {
    vi.mocked(getShellEnvironment).mockReturnValue({ PATH: '/shell/bin', HOME: '/shell/home', ...HOST_SESSION_ENV_FIXTURE });
    const driver = new FakeChatDriver();
    const probe = vi.spyOn(driver as ChatDriver, 'probe');
    registerChatDriver(driver);
    expect(await tryStartChatAgent(params, provider, { ...USER_CLAUDE_CONFIG_FIXTURE }, undefined, null)).toBe('chat');
    for (const env of [probe.mock.calls[0][1], driver.last.startOptions?.env]) {
      for (const key of Object.keys(HOST_SESSION_ENV_FIXTURE)) expect(env).not.toHaveProperty(key);
      expect(env).toMatchObject({ PATH: '/shell/bin', ...USER_CLAUDE_CONFIG_FIXTURE });
    }
  });

  it.skipIf(process.platform === 'win32')('launches an env-node Codex shim for probe and session with a minimal app PATH', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-launch-env-'));
    const bin = path.join(dir, 'bin');
    const report = path.join(dir, 'launches.jsonl');
    fs.mkdirSync(bin);
    fs.symlinkSync(process.execPath, path.join(bin, 'node'));
    const shim = path.join(bin, 'codex');
    fs.writeFileSync(shim, `#!/usr/bin/env node
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(report)}, JSON.stringify({ path: process.env.PATH, home: process.env.HOME, agent: process.env.CLUBHOUSE_AGENT_ID }) + '\\n');
const replies = ${JSON.stringify({ initialize: codexFixture.initializeResult, 'thread/start': codexFixture.threadStartResult })};
require('readline').createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined) process.stdout.write(JSON.stringify({ id: msg.id, result: replies[msg.method] || {} }) + '\\n');
});
`, { mode: 0o755 });
    vi.stubEnv('PATH', dir); // No node here: only the login shell PATH can launch the shim.
    vi.mocked(getShellEnvironment).mockReturnValue({ PATH: bin, HOME: dir });
    const codex = { ...provider, id: 'codex-cli', getBinaryPath: () => shim } as unknown as OrchestratorProvider;
    registerChatDriver(new CodexChatDriver());
    try {
      expect(await tryStartChatAgent({ ...params, cwd: dir, mission: undefined }, codex, undefined, undefined, null)).toBe('chat');
      const launches = fs.readFileSync(report, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(launches).toEqual([
        { path: bin, home: dir },
        { path: bin, home: dir, agent: params.agentId },
      ]);
    } finally {
      await getAgentRuntime(params.agentId)?.stop();
      vi.unstubAllEnvs();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retries a paused driver when its effective shell PATH changes', async () => {
    const driver = new FakeChatDriver();
    const probe = vi.spyOn(driver, 'probe').mockResolvedValue({ handshakeOk: false, capabilities: driver.capabilities, error: 'missing node' });
    registerChatDriver(driver);
    for (let i = 0; i <= DRIVER_FAILURE_THRESHOLD; i++) {
      expect(await tryStartChatAgent(params, provider, undefined, undefined, null)).toBe('terminal');
    }
    expect(probe).toHaveBeenCalledTimes(DRIVER_FAILURE_THRESHOLD);
    vi.mocked(getShellEnvironment).mockReturnValue({ PATH: '/fixed/bin' });
    probe.mockResolvedValue({ handshakeOk: true, capabilities: driver.capabilities });
    expect(await tryStartChatAgent(params, provider, undefined, undefined, null)).toBe('chat');
    expect(probe).toHaveBeenCalledTimes(DRIVER_FAILURE_THRESHOLD + 1);
  });

  it('maps Free Agent Mode onto the permission ladder', () => {
    expect(levelForFreeAgent(false, 'auto')).toBe('ask');
    expect(levelForFreeAgent(true, 'auto')).toBe('auto');
    expect(levelForFreeAgent(true, 'skip-all')).toBe('full_access');
  });

  it('finds the chat session that last ran a native session', async () => {
    transcript.events = [
      ev({ type: 'session_started', sessionId: 'c1', seq: 1, data: { driver: 'claude_agent_sdk', provider: 'claude-code', cwd: '/', resumed: false, nativeSessionId: 'n1', capabilities: {} as never } }),
      ev({ type: 'session_state', sessionId: 'c1', seq: 2, data: { state: 'idle' } }),
      ev({ type: 'session_started', sessionId: 'c2', seq: 1, data: { driver: 'claude_agent_sdk', provider: 'claude-code', cwd: '/', resumed: false, nativeSessionId: 'n2', capabilities: {} as never } }),
    ];
    expect(await findChatSessionFor('agent-1', 'n1')).toEqual({ sessionId: 'c1', lastSeq: 2 });
    expect(await findChatSessionFor('agent-1', 'unknown')).toBeUndefined();
    expect(listChatSessions).toHaveBeenCalledWith('agent-1');
    expect(readChatTranscript).not.toHaveBeenCalled();
  });

  it('falls back to the terminal when the mode is terminal, the agent is quick, or no driver exists', async () => {
    registerChatDriver(new FakeChatDriver());
    const onStarting = vi.fn();
    mode.value = { mode: 'terminal' };
    expect(await tryStartChatAgent(params, provider, undefined, undefined, null, onStarting)).toBe('terminal');
    mode.value = { mode: 'chat' };
    expect(await tryStartChatAgent({ ...params, kind: 'quick' }, provider, undefined, undefined, null, onStarting)).toBe('terminal');
    clearChatDrivers();
    expect(await tryStartChatAgent(params, provider, undefined, undefined, null, onStarting)).toBe('terminal');
    expect(registry.setRuntime).not.toHaveBeenCalled();
    // Never chat: no start began.
    expect(onStarting).not.toHaveBeenCalled();
  });

  it('falls back to the terminal when the CLI binary cannot be found', async () => {
    registerChatDriver(new FakeChatDriver());
    const missing = { ...provider, getBinaryPath: () => { throw new Error('claude not found'); } } as unknown as OrchestratorProvider;
    expect(await tryStartChatAgent(params, missing, undefined, undefined, null)).toBe('terminal');
    expect(registry.setRuntime).not.toHaveBeenCalled();
  });

  it('closes the chat CLI without an exit broadcast when the mission cannot be sent', async () => {
    const driver = new FakeChatDriver();
    const realStart = driver.start.bind(driver);
    driver.start = async (opts) => {
      const session = await realStart(opts);
      session.send = async () => { throw new Error('stdin closed'); };
      return session;
    };
    registerChatDriver(driver);
    const onStarting = vi.fn();
    expect(await tryStartChatAgent(params, provider, undefined, undefined, null, onStarting)).toBe('terminal');
    // A start that began and fell back.
    expect(onStarting).toHaveBeenCalledTimes(1);
    expect(driver.last.closed).toBe(true);
    expect(registry.setRuntime).toHaveBeenLastCalledWith('agent-1', 'pty');
    expect(getAgentRuntime('agent-1')).toBeUndefined();
    await new Promise((r) => setTimeout(r, 20));
    expect(exitBroadcast.broadcastAgentExit).not.toHaveBeenCalled();
  });

  it('starts a chat runtime with the user binary, the Clubhouse MCP bridge and agent env', async () => {
    const driver = new FakeChatDriver();
    registerChatDriver(driver);
    const started = await tryStartChatAgent({ ...params, freeAgentMode: true }, provider, { CLAUDE_CONFIG_DIR: '/cfg' }, undefined, null);

    expect(started).toBe('chat');
    expect(registry.setRuntime).toHaveBeenCalledWith('agent-1', 'chat');
    const opts = driver.last.startOptions!;
    expect(opts.binaryPath).toBe('/usr/local/bin/claude');
    expect(opts.level).toBe('auto');
    expect(opts.env).toMatchObject({ CLAUDE_CONFIG_DIR: '/cfg', CLUBHOUSE_AGENT_ID: 'agent-1', CLUBHOUSE_MCP_PORT: '4321' });
    expect(opts.mcpServers).toHaveProperty('clubhouse');
    expect(driver.last.sent[0].content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(getAgentRuntime('agent-1')?.kind).toBe('chat');
    expect(isChatAgent('agent-1')).toBe(true);
    // Into session history (the Sessions picker), not just lastSessionId.
    expect(agentConfig.touchSessionEntry).toHaveBeenCalledWith('/p', 'agent-1', 'native-1');
  });

  it.each([
    // [agent's mcpOverride, what project/global say, bridge expected]
    [false, true, false],
    [true, false, true],
    [undefined, true, true],
    [undefined, false, false],
  ] as const)('agent mcpOverride=%s with project/global=%s: Clubhouse MCP bridge %s (#2223)', async (override, inherited, expected) => {
    vi.mocked(isMcpEnabled).mockImplementation((_p?: string, agentOverride?: boolean) => agentOverride ?? inherited);
    try {
      const driver = new FakeChatDriver();
      registerChatDriver(driver);
      const config = { id: 'agent-1', name: 'a', color: 'red', createdAt: '', ...(override === undefined ? {} : { mcpOverride: override }) } as DurableAgentConfig;
      expect(await tryStartChatAgent(params, provider, undefined, undefined, config)).toBe('chat');

      expect(vi.mocked(isMcpEnabled)).toHaveBeenCalledWith('/p', override);
      expect(vi.mocked(injectClubhouseMcp)).toHaveBeenCalledWith('/p/wt', 'agent-1', 4321, provider.conventions, { projectPath: '/p', agentOverride: override });
      if (expected) expect(driver.last.startOptions!.mcpServers).toHaveProperty('clubhouse');
      else expect(driver.last.startOptions!.mcpServers ?? {}).not.toHaveProperty('clubhouse');
    } finally {
      vi.mocked(isMcpEnabled).mockImplementation(() => true);
    }
  });

  it.each([
    ['claude-code', 'claude_agent_sdk'],
    ['claude-code', 'claude_stream_json'],
    ['codex-cli', 'codex_app_server'],
    ['copilot-cli', 'copilot_acp'],
  ] as const)('%s (%s): the nonce reaches the driver only through the CLI env (#2222)', async (id, driverId) => {
    const driver = new FakeChatDriver(driverId, id);
    registerChatDriver(driver);
    const p = { ...provider, id } as unknown as OrchestratorProvider;
    expect(await tryStartChatAgent(params, p, undefined, undefined, null)).toBe('chat');

    const nonce = registry.setNonce.mock.calls[0][1] as string;
    expect(nonce).toMatch(/^[0-9a-f-]{36}$/);
    const opts = driver.last.startOptions!;
    expect(opts.env).toMatchObject({ CLUBHOUSE_HOOK_NONCE: nonce, CLUBHOUSE_AGENT_ID: 'agent-1', CLUBHOUSE_MCP_PORT: '4321' });
    // Neither the worktree config nor the session's MCP definitions get it.
    expect(vi.mocked(injectClubhouseMcp)).toHaveBeenCalledWith('/p/wt', 'agent-1', 4321, p.conventions, { projectPath: '/p', agentOverride: undefined });
    expect(vi.mocked(buildClubhouseMcpDef)).toHaveBeenCalledWith(4321, 'agent-1');
    expect(JSON.stringify(opts.mcpServers)).not.toContain(nonce);
    // The bridge's HTTP endpoint names the nonce's env var, not its value (#2240).
    expect(opts.mcpHttpEndpoints).toEqual({
      clubhouse: { url: 'http://127.0.0.1:4321/mcp/agent-1', headersFromEnv: { 'X-Clubhouse-Nonce': 'CLUBHOUSE_HOOK_NONCE' } },
    });
    expect(JSON.stringify(opts.mcpHttpEndpoints)).not.toContain(nonce);
  });

  it('reads the agent\'s own auto-sleep at start and re-arms when it changes, until the session ends (#2143)', async () => {
    clearAgentIdleSleep();
    const driver = new FakeChatDriver();
    registerChatDriver(driver);
    const config = { id: 'agent-1', idleSleep: 15 } as unknown as DurableAgentConfig;
    expect(await tryStartChatAgent(params, provider, undefined, undefined, config)).toBe('chat');
    expect(chatIdleTimeoutMs('agent-1')).toBe(15 * 60_000);

    const runtime = getAgentRuntime('agent-1') as ChatAgentRuntime;
    const changed = vi.spyOn(runtime, 'idleTimeoutChanged');
    setAgentIdleSleep('agent-1', 'never');
    expect(changed).toHaveBeenCalledTimes(1);
    expect(chatIdleTimeoutMs('agent-1')).toBe(0);

    await runtime.stop();
    await vi.waitFor(() => expect(isChatAgent('agent-1')).toBe(false));
    setAgentIdleSleep('agent-1', 60);
    expect(changed).toHaveBeenCalledTimes(1);
    clearAgentIdleSleep();
  });

  it('records the chat session in session history when it ends, as its last activity (#2157)', async () => {
    const driver = new FakeChatDriver();
    registerChatDriver(driver);
    expect(await tryStartChatAgent(params, provider, undefined, undefined, null)).toBe('chat');
    agentConfig.touchSessionEntry.mockClear();

    await getAgentRuntime('agent-1')?.stop();

    await vi.waitFor(() => expect(agentConfig.touchSessionEntry).toHaveBeenCalledWith('/p', 'agent-1', 'native-1'));
  });

  it('resumes the native session and continues the chat session sequence', async () => {
    const driver = new FakeChatDriver();
    registerChatDriver(driver);
    transcript.events = [
      ev({ type: 'session_started', sessionId: 'c9', seq: 1, data: { driver: 'claude_agent_sdk', provider: 'claude-code', cwd: '/', resumed: false, nativeSessionId: 'n9', capabilities: {} as never } }),
      ev({ type: 'session_state', sessionId: 'c9', seq: 5, data: { state: 'idle' } }),
    ];
    await tryStartChatAgent({ ...params, mission: undefined, resume: true, sessionId: 'n9' }, provider, undefined, undefined, null);
    expect(driver.last.startOptions?.resumeNativeSessionId).toBe('n9');
  });

  describe('telemetry (#2305)', () => {
    let event: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      event = vi.fn();
      setProducingRuntime({ level: 'standard', count: vi.fn(), replaySpan: vi.fn(), event } as unknown as TelemetryRuntime);
    });
    afterEach(() => setProducingRuntime(null));
    const recorded = (name: string) => event.mock.calls
      .filter(([n]) => n === name)
      .map(([, attrs]) => Object.fromEntries((attrs as Array<{ key: string; value: unknown }>).map((a) => [a.key, a.value])));

    it.each([
      [undefined, 'resumed'],
      ['not_found', 'fresh_not_found'],
      ['stalled', 'fresh_stalled'],
    ] as const)('a resume the driver answers with fallback %s is %s', async (fallback, result) => {
      const driver = new FakeChatDriver();
      driver.resumeFallback = fallback;
      registerChatDriver(driver);
      await tryStartChatAgent({ ...params, mission: undefined, resume: true, sessionId: 'n9' }, provider, undefined, undefined, null);
      expect(recorded('clubhouse.agent.resume_outcome')).toEqual([{
        'clubhouse.orchestrator': 'claude-code', 'clubhouse.agent.id_hash': 'agent-1',
        'clubhouse.agent.runtime': 'chat', 'clubhouse.session.resume.result': result,
      }]);
    });

    it('a chat resume whose start then fails records no chat outcome (the terminal records its own)', async () => {
      const driver = new FakeChatDriver();
      vi.spyOn(driver, 'start').mockImplementationOnce(async (opts) => {
        const session = await FakeChatDriver.prototype.start.call(driver, opts);
        vi.spyOn(session, 'send').mockRejectedValue(new Error('boom'));
        return session;
      });
      registerChatDriver(driver);
      expect(await tryStartChatAgent({ ...params, resume: true, sessionId: 'n9' }, provider, undefined, undefined, null)).toBe('terminal');
      expect(recorded('clubhouse.agent.resume_outcome')).toEqual([]);
    });

    it('a fresh start records no resume outcome; its end records the provider-reported capture', async () => {
      registerChatDriver(new FakeChatDriver());
      await tryStartChatAgent(params, provider, undefined, undefined, null);
      expect(recorded('clubhouse.agent.resume_outcome')).toEqual([]);
      // Ids noted while running aren't capture events; only the end is.
      expect(recorded('clubhouse.agent.session_capture')).toEqual([]);
      await getAgentRuntime('agent-1')?.stop();
      await vi.waitFor(() => expect(recorded('clubhouse.agent.session_capture')).toEqual([{
        'clubhouse.orchestrator': 'claude-code', 'clubhouse.agent.id_hash': 'agent-1', 'clubhouse.agent.runtime': 'chat',
        'clubhouse.session.capture.result': 'captured', 'clubhouse.session.capture.source': 'provider_reported', 'process.exit.code': 0,
      }]));
      expect(JSON.stringify(event.mock.calls)).not.toContain('native-1');
    });

    it('records persist_failed when the session entry can\'t be written at the end', async () => {
      registerChatDriver(new FakeChatDriver());
      await tryStartChatAgent(params, provider, undefined, undefined, null);
      agentConfig.touchSessionEntry.mockRejectedValueOnce(new Error('EACCES'));
      await getAgentRuntime('agent-1')?.stop();
      await vi.waitFor(() => expect(recorded('clubhouse.agent.session_capture')).toEqual([
        expect.objectContaining({ 'clubhouse.session.capture.result': 'persist_failed', 'clubhouse.session.capture.source': 'provider_reported' }),
      ]));
    });
  });

  it('recognizes login-required errors from each CLI', () => {
    expect(isLoginRequiredError('RPC error -32000: Authentication required')).toBe(true);
    expect(isLoginRequiredError('not logged in')).toBe(true);
    expect(isLoginRequiredError('401 Unauthorized')).toBe(true);
    expect(isLoginRequiredError('Please run /login')).toBe(true);
    expect(isLoginRequiredError('No conversation found with session ID: stale')).toBe(false);
    expect(isLoginRequiredError('SDK spawn failed')).toBe(false);
  });

  it('logs the request, each driver check and the start with a values-free env summary', async () => {
    registerChatDriver(new FakeChatDriver());
    await tryStartChatAgent({ ...params, resume: true, sessionId: 'n1' }, provider, { CLAUDE_CONFIG_DIR: '/cfg' }, undefined, null);
    const logs = vi.mocked(appLog).mock.calls.map(([, , msg, opts]) => ({ msg, meta: opts?.meta as Record<string, unknown> }));
    expect(logs.find((l) => l.msg === 'Chat start requested')?.meta).toMatchObject({ resumeSessionId: 'n1', profileEnvKeys: ['CLAUDE_CONFIG_DIR'] });
    expect(logs.find((l) => l.msg === 'Chat driver check')?.meta).toMatchObject({ ok: true, durationMs: expect.any(Number) });
    const start = logs.find((l) => l.msg === 'Starting chat agent')?.meta;
    expect(start).toMatchObject({ resumeSessionId: 'n1', mcpServers: ['clubhouse'], env: { keyCount: expect.any(Number), missing: expect.any(Array) } });
    expect(JSON.stringify(start)).not.toContain('/cfg');
  });

  describe('fallback', () => {
    const notices = () => vi.mocked(appendChatEvent).mock.calls
      .map((c) => c.find((a): a is ChatEvent => typeof a === 'object' && a !== null && 'type' in a))
      .filter((e): e is ChatEvent => e?.type === 'notice')
      .map((e) => (e.data as { code: string; message: string }));
    const toasts = () => vi.mocked(broadcastToAllWindows).mock.calls
      .filter((c) => c[0] === IPC.CHAT.RUNTIME_NOTICE)
      .map((c) => c[2] as { code: string; message: string });

    function drivers() {
      const sdk = new FakeChatDriver('claude_agent_sdk');
      const stream = new FakeChatDriver('claude_stream_json');
      registerChatDriver(sdk);
      registerChatDriver(stream);
      return { sdk, stream };
    }

    it('drops from the Agent SDK to stream-json when the SDK handshake fails, and says why', async () => {
      const { sdk, stream } = drivers();
      sdk.probe = async () => ({ handshakeOk: false, capabilities: sdk.capabilities, error: 'initialize timed out' });
      expect(await tryStartChatAgent(params, provider, undefined, undefined, null)).toBe('chat');
      expect(sdk.sessions).toHaveLength(0);
      expect(stream.sessions).toHaveLength(1);
      const expected = 'Using Claude Code (stream-json): Claude Code (Agent SDK) handshake failed: initialize timed out';
      expect(toasts()).toEqual([{ level: 'warn', code: 'fallback', message: expected }]);
      expect(notices()).toEqual([{ level: 'warn', code: 'fallback', message: expected }]);
    });

    it('drops to stream-json when the Agent SDK initialize never settles (#2274)', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        // A real SDK driver over a fake query whose initialize never answers.
        const close = vi.fn();
        const stalled = {
          [Symbol.asyncIterator]: () => ({
            next: () => new Promise<IteratorResult<never>>((r) => close.mockImplementation(() => r({ done: true, value: undefined }))),
          }),
          initializationResult: () => new Promise<never>(() => {}),
          close: (...a: unknown[]) => close(...a),
        };
        registerChatDriver(new ClaudeChatDriver('claude_agent_sdk', {
          createTransport: (_id, opts) => new ClaudeSdkTransport(opts, async () => ({ query: (() => stalled) as never })),
        }));
        const stream = new FakeChatDriver('claude_stream_json');
        registerChatDriver(stream);
        const started = tryStartChatAgent(params, provider, undefined, undefined, null);
        await vi.advanceTimersByTimeAsync(SDK_INIT_TIMEOUT_MS);
        expect(await started).toBe('chat');
        expect(close).toHaveBeenCalled();
        expect(stream.sessions).toHaveLength(1);
        expect(toasts()[0].message).toContain(`did not finish initializing within ${SDK_INIT_TIMEOUT_MS}ms`);
      } finally {
        vi.useRealTimers();
      }
      await getAgentRuntime('agent-1')?.stop();
    });

    it('opens in the terminal when every driver is unusable, with the reasons', async () => {
      const { sdk, stream } = drivers();
      sdk.probe = async () => ({ handshakeOk: true, cliVersion: '2.1.250', capabilities: sdk.capabilities });
      stream.probe = sdk.probe;
      vi.mocked(evaluateCliVersion).mockReturnValue({ status: 'known_bad', version: '2.1.250', message: 'Claude Code 2.1.250 is known to break chat: hangs' });
      expect(await tryStartChatAgent(params, provider, undefined, undefined, null)).toBe('terminal');
      expect(registry.setRuntime).not.toHaveBeenCalled();
      expect(toasts()).toEqual([{
        level: 'warn', code: 'fallback',
        message: 'Opened in the terminal: Claude Code 2.1.250 is known to break chat: hangs; Claude Code 2.1.250 is known to break chat: hangs',
      }]);
    });

    it('opens the terminal for a CLI that needs a login, without trying the other drivers', async () => {
      const { sdk, stream } = drivers();
      sdk.probe = async () => ({ handshakeOk: true, needsLogin: true, loginHint: 'run claude, then /login', capabilities: sdk.capabilities });
      expect(await tryStartChatAgent(params, provider, undefined, undefined, null)).toBe('terminal');
      expect(sdk.sessions).toHaveLength(0);
      expect(stream.sessions).toHaveLength(0);
      expect(toasts()).toEqual([{
        level: 'info', code: 'login_required',
        message: 'Claude Code needs you to log in. Opening the terminal so you can log in (run claude, then /login). Chat starts next time.',
      }]);
    });

    it('probes through the profile\'s command prefix', async () => {
      const { sdk } = drivers();
      const calls: unknown[][] = [];
      sdk.probe = async (...args: unknown[]) => { calls.push(args); return { handshakeOk: true, capabilities: sdk.capabilities }; };
      expect(await tryStartChatAgent(params, provider, { A: '1' }, 'wsl -e', null)).toBe('chat');
      expect(calls[0]).toEqual([expect.any(String), expect.objectContaining({ A: '1', PATH: '/shell/bin' }), { commandPrefix: 'wsl -e' }]);
      expect(sdk.last.startOptions?.commandPrefix).toBe('wsl -e');
    });

    it('keeps chat on a newer-than-tested CLI and notes it in the transcript only', async () => {
      const { sdk } = drivers();
      sdk.probe = async () => ({ handshakeOk: true, cliVersion: '2.1.900', capabilities: sdk.capabilities });
      expect(await tryStartChatAgent(params, provider, undefined, undefined, null)).toBe('chat');
      expect(sdk.sessions).toHaveLength(1);
      expect(toasts()).toEqual([]);
      expect(notices()).toEqual([{ level: 'info', code: 'untested_cli_version', message: 'Claude Code 2.1.900 is newer than the version chat was tested with (2.1.302).' }]);
    });

    it('tries the next driver when a session fails to start, and pauses a driver that keeps failing', async () => {
      const { sdk, stream } = drivers();
      let sdkProbes = 0;
      sdk.probe = async () => { sdkProbes++; return { handshakeOk: true, capabilities: sdk.capabilities }; };
      sdk.start = async () => { throw new Error('SDK spawn failed'); };
      for (let i = 0; i < DRIVER_FAILURE_THRESHOLD; i++) {
        expect(await tryStartChatAgent({ ...params, agentId: `a${i}` }, provider, undefined, undefined, null)).toBe('chat');
      }
      expect(stream.sessions).toHaveLength(DRIVER_FAILURE_THRESHOLD);
      expect(toasts()[0].message).toBe('Using Claude Code (stream-json): Claude Code (Agent SDK) failed to start: SDK spawn failed');
      // Paused now: the SDK isn't even probed.
      const before = sdkProbes;
      expect(await tryStartChatAgent({ ...params, agentId: 'a9' }, provider, undefined, undefined, null)).toBe('chat');
      expect(sdkProbes).toBe(before);
      expect(toasts().at(-1)?.message).toMatch(/^Using Claude Code \(stream-json\): Claude Code \(Agent SDK\) chat is paused after repeated failures/);
    });

    it('does not probe or report later drivers when the preferred one works', async () => {
      const { sdk, stream } = drivers();
      let streamProbes = 0;
      stream.probe = async () => { streamProbes++; return { handshakeOk: false, capabilities: stream.capabilities, error: 'broken' }; };
      for (let i = 0; i < 3; i++) {
        expect(await tryStartChatAgent({ ...params, agentId: `ok${i}` }, provider, undefined, undefined, null)).toBe('chat');
      }
      expect(sdk.sessions).toHaveLength(3);
      expect(streamProbes).toBe(0);
      expect(toasts()).toEqual([]);
      expect(notices()).toEqual([]);
    });

    it('never hands the mission to another driver once a session has started', async () => {
      const { sdk, stream } = drivers();
      let sdkStarts = 0;
      const realStart = sdk.start.bind(sdk);
      sdk.start = async (opts) => {
        sdkStarts++;
        const session = await realStart(opts);
        session.send = async () => { throw new Error('stdin closed'); };
        return session;
      };
      for (let i = 0; i <= DRIVER_FAILURE_THRESHOLD; i++) {
        expect(await tryStartChatAgent({ ...params, agentId: `m${i}` }, provider, undefined, undefined, null)).toBe('terminal');
      }
      expect(stream.sessions).toHaveLength(0);
      // A failure after the session started isn't counted against the driver.
      expect(sdkStarts).toBe(DRIVER_FAILURE_THRESHOLD + 1);
      expect(toasts().at(-1)?.message).toBe('Opened in the terminal: Claude Code (Agent SDK) failed after its session started: stdin closed');
    });

    it('does not pause a driver for failed resumes', async () => {
      const { sdk, stream } = drivers();
      let sdkStarts = 0;
      sdk.start = async () => { sdkStarts++; throw new Error('No conversation found with session ID: stale'); };
      stream.start = sdk.start;
      const resume = { ...params, mission: undefined, resume: true, sessionId: 'stale' };
      for (let i = 0; i <= DRIVER_FAILURE_THRESHOLD; i++) {
        expect(await tryStartChatAgent({ ...resume, agentId: `r${i}` }, provider, undefined, undefined, null)).toBe('terminal');
      }
      // Both drivers were tried on every attempt: none was paused.
      expect(sdkStarts).toBe(2 * (DRIVER_FAILURE_THRESHOLD + 1));
    });

    it('leaves the failure reason for the terminal fallback (#2086)', async () => {
      const { sdk, stream } = drivers();
      sdk.start = async () => { throw new Error('No conversation found with session ID: stale'); };
      stream.start = sdk.start;
      expect(await tryStartChatAgent({ ...params, agentId: 'rf', mission: undefined, resume: true, sessionId: 'stale' }, provider, undefined, undefined, null)).toBe('terminal');
      expect(takeChatStartFailure('rf')).toBe('No conversation found with session ID: stale');
      expect(takeChatStartFailure('rf')).toBeUndefined();
    });

    it('treats an auth error at session start as a login, not a broken driver', async () => {
      const { sdk, stream } = drivers();
      let sdkStarts = 0;
      sdk.start = async () => { sdkStarts++; throw new Error('RPC error -32000: Authentication required'); };
      for (let i = 0; i <= DRIVER_FAILURE_THRESHOLD; i++) {
        expect(await tryStartChatAgent({ ...params, agentId: `l${i}` }, provider, undefined, undefined, null)).toBe('terminal');
      }
      // Every driver shares the login: the next one isn't tried, and the SDK is never paused.
      expect(stream.sessions).toHaveLength(0);
      expect(sdkStarts).toBe(DRIVER_FAILURE_THRESHOLD + 1);
      expect(toasts().at(-1)).toMatchObject({ code: 'login_required' });
      expect(registry.setRuntime).toHaveBeenLastCalledWith(`l${DRIVER_FAILURE_THRESHOLD}`, 'pty');
    });

    it('falls back to the terminal and restores config when every start fails', async () => {
      const { sdk, stream } = drivers();
      sdk.start = async () => { throw new Error('a'); };
      stream.start = async () => { throw new Error('b'); };
      expect(await tryStartChatAgent(params, provider, undefined, undefined, null)).toBe('terminal');
      expect(registry.setRuntime).toHaveBeenLastCalledWith('agent-1', 'pty');
      expect(toasts().at(-1)?.message).toBe('Opened in the terminal: Claude Code (Agent SDK) failed to start: a; Claude Code (stream-json) failed to start: b');
      expect(getAgentRuntime('agent-1')).toBeUndefined();
    });
  });
});

describe('chat start facts for telemetry (#2304)', () => {
  const facts = (): ChatStartFacts => ({ attempts: [] });
  /** Attempts without their timings, which vary run to run. */
  const tried = (f: ChatStartFacts) => f.attempts.map(({ checkMs, sessionStartMs, ...rest }) => {
    expect(checkMs).toBeGreaterThanOrEqual(0);
    if (sessionStartMs !== undefined) expect(sessionStartMs).toBeGreaterThanOrEqual(0);
    return { ...rest, ...(sessionStartMs !== undefined && { started: true }) };
  });
  function drivers() {
    const sdk = new FakeChatDriver('claude_agent_sdk');
    const stream = new FakeChatDriver('claude_stream_json');
    registerChatDriver(sdk);
    registerChatDriver(stream);
    return { sdk, stream };
  }
  afterEach(async () => { await getAgentRuntime('agent-1')?.stop(); });

  it('records nothing for an agent that was never chat', async () => {
    registerChatDriver(new FakeChatDriver());
    const f = facts();
    mode.value = { mode: 'terminal' };
    expect(await tryStartChatAgent(params, provider, undefined, undefined, null, undefined, f)).toBe('terminal');
    expect(f).toEqual({ attempts: [] });
  });

  it('records no driver and a missing binary as reasons, with no attempts', async () => {
    const none = facts();
    expect(await tryStartChatAgent(params, provider, undefined, undefined, null, undefined, none)).toBe('terminal');
    expect(none).toEqual({ attempts: [], reason: 'no_driver' });

    registerChatDriver(new FakeChatDriver('claude_agent_sdk'));
    const missing = { ...provider, getBinaryPath: () => { throw new Error('claude not found at /secret/path'); } } as unknown as OrchestratorProvider;
    const f = facts();
    expect(await tryStartChatAgent(params, missing, undefined, undefined, null, undefined, f)).toBe('terminal');
    expect(f).toEqual({ attempts: [], reason: 'binary_missing', preferredDriver: 'claude_agent_sdk' });

    const noLookup = facts();
    const { getBinaryPath: _unused, ...rest } = provider as unknown as Record<string, unknown>;
    expect(await tryStartChatAgent(params, rest as unknown as OrchestratorProvider, undefined, undefined, null, undefined, noLookup)).toBe('terminal');
    expect(noLookup.reason).toBe('binary_missing');
  });

  it('records a start on the first driver with its version verdict and no reason', async () => {
    const { sdk } = drivers();
    sdk.probe = async () => ({ handshakeOk: true, cliVersion: '2.1.0', capabilities: sdk.capabilities });
    vi.mocked(evaluateCliVersion).mockReturnValue({ status: 'untested', version: '2.1.0', message: 'newer than tested' });
    const f = facts();
    expect(await tryStartChatAgent(params, provider, undefined, undefined, null, undefined, f)).toBe('chat');
    expect(tried(f)).toEqual([{ driver: 'claude_agent_sdk', versionStatus: 'untested', started: true }]);
    expect(f.reason).toBeUndefined();
  });

  it('records a handshake failure with its probe error code, then the driver that worked', async () => {
    const { sdk } = drivers();
    sdk.probe = async () => ({ handshakeOk: false, capabilities: sdk.capabilities, error: 'probe did not finish within 30000ms', errorCode: 'rpc_timeout' });
    const f = facts();
    expect(await tryStartChatAgent(params, provider, undefined, undefined, null, undefined, f)).toBe('chat');
    expect(tried(f)).toEqual([
      { driver: 'claude_agent_sdk', reason: 'handshake_failed', errorCode: 'rpc_timeout' },
      { driver: 'claude_stream_json', versionStatus: 'unknown', started: true },
    ]);
    expect(JSON.stringify(f)).not.toContain('30000ms');
  });

  it('records the Claude init deadline at session start as rpc_timeout (#2283)', async () => {
    const { sdk } = drivers();
    sdk.start = async () => { throw new ClaudeStartupTimeoutError(SDK_INIT_TIMEOUT_MS); };
    const f = facts();
    expect(await tryStartChatAgent(params, provider, undefined, undefined, null, undefined, f)).toBe('chat');
    expect(tried(f)[0]).toEqual({ driver: 'claude_agent_sdk', versionStatus: 'unknown', reason: 'start_failed', errorCode: 'rpc_timeout', started: true });
  });

  it('records a version the probe could not read as lookup_failed (#2275), and a version below the minimum', async () => {
    const { sdk, stream } = drivers();
    sdk.probe = async () => ({ handshakeOk: true, capabilities: sdk.capabilities, versionTransient: true });
    stream.probe = async () => ({ handshakeOk: true, cliVersion: '0.1.0', capabilities: stream.capabilities });
    vi.mocked(evaluateCliVersion)
      .mockReturnValueOnce({ status: 'unknown' })
      .mockReturnValueOnce({ status: 'below_min', version: '0.1.0', message: 'too old' });
    sdk.start = async () => { throw new Error('boom'); };
    const f = facts();
    expect(await tryStartChatAgent(params, provider, undefined, undefined, null, undefined, f)).toBe('terminal');
    expect(tried(f)).toEqual([
      { driver: 'claude_agent_sdk', versionStatus: 'lookup_failed', reason: 'start_failed', started: true },
      { driver: 'claude_stream_json', versionStatus: 'below_min', reason: 'version_below_min' },
    ]);
    expect(f.reason).toBe('version_below_min');
  });

  it('records a login at the probe or at session start as login_required, and a failure after the session started', async () => {
    const { sdk } = drivers();
    sdk.probe = async () => ({ handshakeOk: true, needsLogin: true, loginHint: 'run claude /login', capabilities: sdk.capabilities });
    const probeLogin = facts();
    expect(await tryStartChatAgent(params, provider, undefined, undefined, null, undefined, probeLogin)).toBe('terminal');
    expect(tried(probeLogin)).toEqual([{ driver: 'claude_agent_sdk', reason: 'login_required' }]);
    expect(probeLogin.reason).toBe('login_required');

    sdk.probe = async () => ({ handshakeOk: true, capabilities: sdk.capabilities });
    sdk.start = async () => { throw new Error('RPC error -32000: Authentication required'); };
    const startLogin = facts();
    expect(await tryStartChatAgent({ ...params, agentId: 'l2' }, provider, undefined, undefined, null, undefined, startLogin)).toBe('terminal');
    expect(tried(startLogin)).toEqual([{ driver: 'claude_agent_sdk', versionStatus: 'unknown', reason: 'login_required', errorCode: 'auth_required', started: true }]);

    const realStart = FakeChatDriver.prototype.start;
    sdk.start = async (opts) => {
      const session = await realStart.call(sdk, opts);
      session.send = async () => { throw new Error('stdin closed'); };
      return session;
    };
    const after = facts();
    expect(await tryStartChatAgent({ ...params, agentId: 'm2' }, provider, undefined, undefined, null, undefined, after)).toBe('terminal');
    expect(after.reason).toBe('failed_after_session_start');
    expect(after.attempts).toHaveLength(1);
  });

  it('records a paused driver as paused', async () => {
    const { sdk } = drivers();
    sdk.start = async () => { throw new Error('SDK spawn failed'); };
    for (let i = 0; i < DRIVER_FAILURE_THRESHOLD; i++) await tryStartChatAgent({ ...params, agentId: `p${i}` }, provider, undefined, undefined, null);
    const f = facts();
    expect(await tryStartChatAgent({ ...params, agentId: 'p9' }, provider, undefined, undefined, null, undefined, f)).toBe('chat');
    expect(tried(f)[0]).toEqual({ driver: 'claude_agent_sdk', reason: 'paused' });
    await getAgentRuntime('p9')?.stop();
  });

  it('records whether a requested resume was honored, and the driver\'s load timings', async () => {
    const driver = new FakeChatDriver('copilot_acp', 'claude-code');
    const realStart = driver.start.bind(driver);
    // Like the ACP driver after a stalled session/load: a fresh session, with the load's timings.
    driver.start = async (opts) => Object.assign(await realStart({ ...opts, resumeNativeSessionId: undefined }), { resumeTiming: { loadMs: 20_000 } });
    registerChatDriver(driver);
    const f = facts();
    expect(await tryStartChatAgent({ ...params, mission: undefined, resume: true, sessionId: 'n9' }, provider, undefined, undefined, null, undefined, f)).toBe('chat');
    expect(f).toMatchObject({ resumeHonored: false, resumeTiming: { loadMs: 20_000 } });
    await getAgentRuntime('agent-1')?.stop();

    driver.start = realStart;
    const honored = facts();
    await tryStartChatAgent({ ...params, mission: undefined, resume: true, sessionId: 'n9' }, provider, undefined, undefined, null, undefined, honored);
    expect(honored.resumeHonored).toBe(true);
    expect(honored.resumeTiming).toBeUndefined();
    await getAgentRuntime('agent-1')?.stop();

    const fresh = facts();
    await tryStartChatAgent(params, provider, undefined, undefined, null, undefined, fresh);
    expect(fresh).not.toHaveProperty('resumeHonored');
  });

  it('records a kill as killed and a newer start as superseded', async () => {
    const driver = new FakeChatDriver();
    const finish: Array<() => void> = [];
    vi.spyOn(driver, 'probe').mockImplementation(() => new Promise((resolve) => {
      finish.push(() => resolve({ handshakeOk: true, capabilities: driver.capabilities }));
    }));
    registerChatDriver(driver);

    const killedFacts = facts();
    const killed = tryStartChatAgent(params, provider, undefined, undefined, null, undefined, killedFacts);
    await vi.waitFor(() => expect(finish).toHaveLength(1));
    await cancelChatStart('agent-1');
    finish[0]();
    expect(await killed).toBe('cancelled');
    expect(killedFacts.reason).toBe('killed');

    const firstFacts = facts();
    const first = tryStartChatAgent(params, provider, undefined, undefined, null, undefined, firstFacts);
    await vi.waitFor(() => expect(finish).toHaveLength(2));
    // The newer start cancels it right away; both wait on the same probe.
    const second = tryStartChatAgent(params, provider, undefined, undefined, null);
    for (const done of finish.slice(1)) done();
    expect(await first).toBe('cancelled');
    expect(firstFacts.reason).toBe('superseded');
    expect(await second).toBe('chat');
  });

  it('records a start that threw as error', async () => {
    registerChatDriver(new FakeChatDriver());
    vi.mocked(getShellEnvironment).mockImplementationOnce(() => { throw new Error('shell env blew up'); });
    const f = facts();
    await expect(tryStartChatAgent(params, provider, undefined, undefined, null, undefined, f)).rejects.toThrow('shell env blew up');
    expect(f.reason).toBe('error');
  });
});

describe('overlapping chat starts (#2087)', () => {
  /** A driver whose starts hang until the test settles them, like a session/load that never answers. */
  class HangingDriver extends FakeChatDriver {
    readonly starts: Array<{ opts: ChatDriverStartOptions; resolve: () => void; reject: (err: Error) => void }> = [];
    override start(opts: ChatDriverStartOptions): Promise<ChatDriverSession> {
      return new Promise((resolve, reject) => {
        this.starts.push({
          opts,
          resolve: () => { void super.start(opts).then(resolve); },
          reject,
        });
      });
    }
  }
  const timeout = () => new Error("RPC request 'session/load' timed out after 30000ms");
  const resumeParams = { ...params, resume: true, sessionId: '88618d97' };
  const fallbackNotices = () => vi.mocked(broadcastToAllWindows).mock.calls
    .filter(([channel, , notice]) => channel === IPC.CHAT.RUNTIME_NOTICE && (notice as { code: string }).code === 'fallback');
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('a runtime switch (kill, then respawn) during a start cancels it; its later timeout opens nothing', async () => {
    const driver = new HangingDriver();
    registerChatDriver(driver);
    const first = tryStartChatAgent(resumeParams, provider, undefined, undefined, null);
    await vi.waitFor(() => expect(driver.starts).toHaveLength(1));

    // The switch: kill (waits for the exit), then spawn again.
    expect(await cancelChatStart('agent-1')).toBe(true);
    expect(exitBroadcast.broadcastAgentExit).toHaveBeenCalledTimes(1);
    expect(driver.starts[0].opts.signal?.aborted).toBe(true);
    const second = tryStartChatAgent(resumeParams, provider, undefined, undefined, null);
    await vi.waitFor(() => expect(driver.starts).toHaveLength(2));

    driver.starts[0].reject(timeout());
    expect(await first).toBe('cancelled');
    driver.starts[1].resolve();
    expect(await second).toBe('chat');

    expect(fallbackNotices()).toEqual([]);
    expect(registry.setRuntime).not.toHaveBeenCalledWith('agent-1', 'pty');
    expect(isChatAgent('agent-1')).toBe(true);
    expect(exitBroadcast.broadcastAgentExit).toHaveBeenCalledTimes(1);
    await getAgentRuntime('agent-1')?.stop();
  });

  it('three overlapping starts end in one chat and no terminal fallback', async () => {
    const driver = new HangingDriver();
    registerChatDriver(driver);
    const starts = [];
    for (let i = 0; i < 3; i++) {
      starts.push(tryStartChatAgent(resumeParams, provider, undefined, undefined, null));
      await vi.waitFor(() => expect(driver.starts).toHaveLength(i + 1));
    }
    // A newer start replaces the older ones without an exit broadcast: it owns the agent id.
    expect(driver.starts.slice(0, 2).every((s) => s.opts.signal?.aborted)).toBe(true);
    expect(exitBroadcast.broadcastAgentExit).not.toHaveBeenCalled();

    driver.starts[0].reject(timeout());
    driver.starts[1].reject(timeout());
    driver.starts[2].resolve();
    expect(await Promise.all(starts)).toEqual(['cancelled', 'cancelled', 'chat']);
    expect(fallbackNotices()).toEqual([]);
    expect(registry.setRuntime).not.toHaveBeenCalledWith('agent-1', 'pty');
    await getAgentRuntime('agent-1')?.stop();
  });

  it('a newer start restores the MCP config the replaced start had injected', async () => {
    const configPipeline = await import('../config-pipeline');
    const driver = new HangingDriver();
    registerChatDriver(driver);
    const first = tryStartChatAgent(params, provider, undefined, undefined, null);
    await vi.waitFor(() => expect(driver.starts).toHaveLength(1));
    expect(configPipeline.restoreForAgent).not.toHaveBeenCalled();

    const second = tryStartChatAgent(params, provider, undefined, undefined, null);
    await vi.waitFor(() => expect(driver.starts).toHaveLength(2));
    expect(configPipeline.restoreForAgent).toHaveBeenCalledTimes(1);
    expect(configPipeline.restoreForAgent).toHaveBeenCalledWith('agent-1');

    driver.starts[0].reject(timeout());
    driver.starts[1].resolve();
    expect(await first).toBe('cancelled');
    expect(await second).toBe('chat');
    // The replaced start restores nothing more of its own.
    expect(configPipeline.restoreForAgent).toHaveBeenCalledTimes(1);
    await getAgentRuntime('agent-1')?.stop();
  });

  it('a cancelled start that times out does not try the next driver or count a failure', async () => {
    const hanging = new HangingDriver();
    const next = new FakeChatDriver('claude_agent_sdk');
    const nextStart = vi.spyOn(next, 'start');
    registerChatDriver(hanging);
    registerChatDriver(next);
    const started = tryStartChatAgent(params, provider, undefined, undefined, null);
    await vi.waitFor(() => expect(hanging.starts).toHaveLength(1));

    await cancelChatStart('agent-1');
    hanging.starts[0].reject(timeout());
    expect(await started).toBe('cancelled');
    expect(nextStart).not.toHaveBeenCalled();
    expect(fallbackNotices()).toEqual([]);
    expect(hasChatStartInFlight('agent-1')).toBe(false);

    // Not paused: the next start uses the same driver again.
    const again = tryStartChatAgent(params, provider, undefined, undefined, null);
    await vi.waitFor(() => expect(hanging.starts).toHaveLength(2));
    hanging.starts[1].resolve();
    expect(await again).toBe('chat');
    await getAgentRuntime('agent-1')?.stop();
  });

  it('a kill during the driver probe untracks the agent and starts nothing', async () => {
    const driver = new FakeChatDriver();
    let finishProbe!: () => void;
    vi.spyOn(driver, 'probe').mockImplementation(() => new Promise((resolve) => {
      finishProbe = () => resolve({ handshakeOk: true, capabilities: driver.capabilities });
    }));
    const start = vi.spyOn(driver, 'start');
    registerChatDriver(driver);
    const started = tryStartChatAgent(params, provider, undefined, undefined, null);
    await vi.waitFor(() => expect(finishProbe).toBeDefined());

    noteKillRequest('agent-1', { trigger: 'user' });
    expect(await cancelChatStart('agent-1')).toBe(true);
    expect(untrackAgent).toHaveBeenCalledWith('agent-1');
    expect(exitBroadcast.broadcastAgentExit).toHaveBeenCalledWith('agent-1', 0);
    // The reason goes out before the exit, so the renderer shows Sleeping, not "couldn't start" (#2127).
    const reasonAt = vi.mocked(broadcastToAllWindows).mock.invocationCallOrder[
      vi.mocked(broadcastToAllWindows).mock.calls.findIndex((c) => c[0] === IPC.AGENT.AGENT_SLEEP_REASON)];
    expect(vi.mocked(broadcastToAllWindows)).toHaveBeenCalledWith(IPC.AGENT.AGENT_SLEEP_REASON, 'agent-1', expect.objectContaining({ reason: 'user' }));
    expect(reasonAt).toBeLessThan(exitBroadcast.broadcastAgentExit.mock.invocationCallOrder.at(-1)!);
    finishProbe();
    expect(await started).toBe('cancelled');
    expect(start).not.toHaveBeenCalled();
    expect(fallbackNotices()).toEqual([]);
  });

  it('closes a session that arrives after the start was cancelled', async () => {
    const driver = new HangingDriver();
    registerChatDriver(driver);
    const started = tryStartChatAgent(params, provider, undefined, undefined, null);
    await vi.waitFor(() => expect(driver.starts).toHaveLength(1));

    await cancelChatStart('agent-1');
    driver.starts[0].resolve();
    expect(await started).toBe('cancelled');
    await settle();
    expect(driver.last.closed).toBe(true);
    expect(getAgentRuntime('agent-1')).toBeUndefined();
  });

  it('reports no start in flight when there is nothing to cancel', async () => {
    expect(await cancelChatStart('agent-1')).toBe(false);
    expect(exitBroadcast.broadcastAgentExit).not.toHaveBeenCalled();
  });
});

describe('stopAllChatAgents (#2053)', () => {
  /** Starts hang until settled, like a CLI still doing its handshake at quit. */
  class HangingDriver extends FakeChatDriver {
    readonly pending: ChatDriverStartOptions[] = [];
    override start(opts: ChatDriverStartOptions): Promise<ChatDriverSession> {
      if (opts.agentId === 'agent-1') return super.start(opts);
      this.pending.push(opts);
      return new Promise(() => undefined);
    }
  }

  it('stops running sessions and cancels starts, and the session-id writes join the barrier', async () => {
    const driver = new HangingDriver();
    registerChatDriver(driver);
    expect(await tryStartChatAgent(params, provider, undefined, undefined, null)).toBe('chat');
    const starting = tryStartChatAgent({ ...params, agentId: 'agent-2' }, provider, undefined, undefined, null);
    await vi.waitFor(() => expect(driver.pending).toHaveLength(1));

    // The native-id write on session end lands late.
    const written: string[] = [];
    agentConfig.touchSessionEntry.mockImplementation(async (_p: string, agentId: string, id: string) => {
      await new Promise((r) => setTimeout(r, 20));
      written.push(`${agentId}:${id}`);
    });

    await stopAllChatAgents();
    expect(driver.sessions[0].closed).toBe(true);
    expect(getAgentRuntime('agent-1')).toBeUndefined();
    expect(driver.pending[0].signal?.aborted).toBe(true);
    expect(await starting).toBe('cancelled');
    expect(exitBroadcast.broadcastAgentExit).toHaveBeenCalledWith('agent-2', 0);

    await whenSessionCapturesSettled();
    expect(written).toContain('agent-1:native-1');
  });

  it('settles even when a driver close fails', async () => {
    const driver = new FakeChatDriver();
    registerChatDriver(driver);
    expect(await tryStartChatAgent(params, provider, undefined, undefined, null)).toBe('chat');
    vi.spyOn(driver.last, 'close').mockRejectedValue(new Error('EPIPE'));
    await expect(stopAllChatAgents()).resolves.toBeUndefined();
    expect(getAgentRuntime('agent-1')).toBeUndefined();
  });
});
