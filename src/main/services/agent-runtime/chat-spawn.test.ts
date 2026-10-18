import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ChatDriver, ChatEvent } from '../../../shared/chat';
import { CHAT_CONTRACT_VERSION } from '../../../shared/chat';

const mode = vi.hoisted(() => ({ value: { mode: 'chat' } as { mode: 'chat' | 'terminal'; driver?: string } }));
vi.mock('../../util/shell', async (importActual) => ({
  ...await importActual<typeof import('../../util/shell')>(),
  getShellEnvironment: vi.fn(),
}));
vi.mock('../chat-runtime-settings', () => ({ resolveRuntimeMode: vi.fn(() => mode.value) }));
const transcript = vi.hoisted(() => ({ events: [] as ChatEvent[] }));
vi.mock('./chat-transcript', () => ({
  readChatTranscript: vi.fn(async () => transcript.events),
  appendChatEvent: vi.fn(async () => {}),
}));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
const registry = vi.hoisted(() => ({ setNonce: vi.fn(), setRuntime: vi.fn(), get: vi.fn() }));
vi.mock('../agent-registry', () => ({ agentRegistry: registry, untrackAgent: vi.fn() }));
vi.mock('../config-pipeline', () => ({ snapshotFile: vi.fn(), restoreForAgent: vi.fn() }));
vi.mock('../clubhouse-mcp/bridge-server', () => ({ waitReady: vi.fn(async () => 4321) }));
vi.mock('../clubhouse-mcp/injection', () => ({
  injectClubhouseMcp: vi.fn(async () => {}),
  buildClubhouseMcpDef: vi.fn(() => ({ type: 'http', url: 'http://127.0.0.1:4321/mcp' })),
}));
vi.mock('../mcp-settings', () => ({ isMcpEnabled: vi.fn(() => false) }));
vi.mock('../materialization-service', () => ({ resolveProjectMcpServers: vi.fn(async () => ({})) }));
const agentConfig = vi.hoisted(() => ({ updateSessionId: vi.fn(async () => {}) }));
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

import { levelForFreeAgent, findChatSessionFor, tryStartChatAgent, isLoginRequiredError } from './chat-spawn';
import { takeChatStartFailure } from './stale-session';
import { appLog } from '../log-service';
import { registerChatDriver, clearChatDrivers } from './chat-drivers';
import { getAgentRuntime, clearChatRuntimes, isChatAgent } from './index';
import { FakeChatDriver } from './fake-chat-driver';
import { clearDriverHealth, DRIVER_FAILURE_THRESHOLD } from './chat-driver-health';
import { evaluateCliVersion } from './chat-version-policy';
import { appendChatEvent } from './chat-transcript';
import { broadcastToAllWindows } from '../../util/ipc-broadcast';
import { IPC } from '../../../shared/ipc-channels';
import type { OrchestratorProvider } from '../../orchestrators';
import { getShellEnvironment } from '../../util/shell';
import { CodexChatDriver } from '../../orchestrators/adapters/codex-chat-driver';
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
    expect(agentConfig.updateSessionId).toHaveBeenCalledWith('/p', 'agent-1', 'native-1');
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
      expect(notices()).toEqual([{ level: 'info', code: 'untested_cli_version', message: 'Claude Code 2.1.900 is newer than the version chat was tested with (2.1.301).' }]);
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
      expect(await tryStartChatAgent({ ...params, agentId: 'rf', mission: undefined, resume: true, sessionId: 'stale' }, provider, undefined, undefined, null)).toBe(false);
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
