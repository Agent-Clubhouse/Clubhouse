import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatEvent } from '../../../shared/chat';
import { CHAT_CONTRACT_VERSION } from '../../../shared/chat';

const mode = vi.hoisted(() => ({ value: { mode: 'chat' } as { mode: 'chat' | 'terminal'; driver?: string } }));
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

import { levelForFreeAgent, findChatSessionFor, tryStartChatAgent } from './chat-spawn';
import { registerChatDriver, clearChatDrivers } from './chat-drivers';
import { getAgentRuntime, clearChatRuntimes, isChatAgent } from './index';
import { FakeChatDriver } from './fake-chat-driver';
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

function ev(partial: Partial<ChatEvent> & Pick<ChatEvent, 'type' | 'data' | 'sessionId' | 'seq'>): ChatEvent {
  return { v: CHAT_CONTRACT_VERSION, agentId: 'agent-1', ts: 1, ...partial } as ChatEvent;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearChatDrivers();
  clearChatRuntimes();
  mode.value = { mode: 'chat' };
  transcript.events = [];
});

describe('chat spawn', () => {
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
    mode.value = { mode: 'terminal' };
    expect(await tryStartChatAgent(params, provider, undefined, undefined, null)).toBe(false);
    mode.value = { mode: 'chat' };
    expect(await tryStartChatAgent({ ...params, kind: 'quick' }, provider, undefined, undefined, null)).toBe(false);
    clearChatDrivers();
    expect(await tryStartChatAgent(params, provider, undefined, undefined, null)).toBe(false);
    expect(registry.setRuntime).not.toHaveBeenCalled();
  });

  it('falls back to the terminal when the CLI binary cannot be found', async () => {
    registerChatDriver(new FakeChatDriver());
    const missing = { ...provider, getBinaryPath: () => { throw new Error('claude not found'); } } as unknown as OrchestratorProvider;
    expect(await tryStartChatAgent(params, missing, undefined, undefined, null)).toBe(false);
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
    expect(await tryStartChatAgent(params, provider, undefined, undefined, null)).toBe(false);
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

    expect(started).toBe(true);
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
});
