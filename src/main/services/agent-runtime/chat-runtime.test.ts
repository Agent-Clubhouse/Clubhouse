import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import type { ChatEvent, ChatCapabilities } from '../../../shared/chat';
import { MINIMAL_CHAT_CAPABILITIES } from '../../../shared/chat';

const transcript: ChatEvent[] = [];
const mediaRoot = vi.hoisted(() => {
  const fs = require('fs') as typeof import('fs'); const os = require('os') as typeof import('os'); const path = require('path') as typeof import('path');
  return fs.mkdtempSync(path.join(os.tmpdir(), 'chat-runtime-media-'));
});
vi.mock('./chat-transcript', () => ({
  agentMediaDir: (agentId: string) => `${mediaRoot}/${agentId}/media`,
  appendChatEvent: vi.fn(async (e: ChatEvent) => { transcript.push(e); }),
  readChatTranscript: vi.fn(async (_agentId: string, opts: { sessionId?: string; afterSeq?: number; tail?: number } = {}) => {
    let events = opts.sessionId ? transcript.filter((e) => e.sessionId === opts.sessionId) : [...transcript];
    if (opts.afterSeq !== undefined) events = events.filter((e) => e.seq > opts.afterSeq!);
    return opts.tail ? events.slice(-opts.tail) : events;
  }),
}));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
const broadcasts = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('../../util/ipc-broadcast', () => ({ broadcastToAllWindows: (...args: unknown[]) => { broadcasts.calls.push(args); } }));

import { ChatAgentRuntime, ChatStartCancelledError } from './chat-runtime';
import { appendChatEvent } from './chat-transcript';
import { FakeChatDriver } from './fake-chat-driver';
import { registerConcealedTools } from './concealed-tools';
import { registerChatRuntime, clearChatRuntimes, isChatAgent } from './index';
import { onChatEvent, removeAllChatEventListeners } from './chat-event-bus';
import { _forgetSentPermissionsForTest, isIncompletePermission } from '../annex-chat-bounds';
import * as permissionQueue from '../annex-permission-queue';
import { agentRegistry } from '../agent-registry';
import { accessLevelOf } from '../../../shared/orchestration-policy';
import { appLog } from '../log-service';
import { closeAgentWork, hasAgentWorkInFlight, reopenLaunches } from '../launch-gate';
import { ActionsEngine, type EngineState } from '../actions/engine';
import { createStepRunner } from '../actions/steps';
import type { Action, ActionRun } from '../../../shared/actions';

/** Let queued microtasks and the runtime's emit chain settle. */
async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
}

function types(): string[] {
  return transcript.map((e) => e.type);
}

function makeRuntime(driver: FakeChatDriver, extra: Partial<ConstructorParameters<typeof ChatAgentRuntime>[0]> = {}) {
  let n = 0;
  const onEnded = vi.fn();
  const runtime = new ChatAgentRuntime({
    agentId: 'agent-1',
    provider: 'claude-code',
    driverId: driver.id,
    cwd: '/repo',
    level: 'ask',
    idleTimeoutMs: 0,
    startSession: (resumeId) => driver.start({
      agentId: 'agent-1', provider: 'claude-code', cwd: '/repo', binaryPath: '/bin/claude', level: 'ask', resumeNativeSessionId: resumeId,
    }),
    newId: () => `id-${++n}`,
    now: () => 1000,
    onEnded,
    ...extra,
  });
  return { runtime, onEnded };
}

const STEERLESS: ChatCapabilities = { ...MINIMAL_CHAT_CAPABILITIES, steer: false, queue: 'client', interrupt: true };

beforeEach(() => {
  broadcasts.calls.length = 0;
  transcript.length = 0;
  removeAllChatEventListeners();
  permissionQueue.reset();
});

afterEach(() => {
  reopenLaunches();
  vi.useRealTimers();
});

describe('held message diagnostics (#3297)', () => {
  const minute = 60_000;
  const runtimes: ChatAgentRuntime[] = [];
  const logs = (message: string) => vi.mocked(appLog).mock.calls
    .filter(([ns, , text]) => ns === 'core:chat' && text === message)
    .map(([, , , opts]) => opts?.meta);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(0);
    vi.mocked(appLog).mockClear();
    runtimes.length = 0;
  });

  afterEach(async () => {
    for (const runtime of runtimes) await runtime.stop();
  });

  async function running(extra: Partial<ConstructorParameters<typeof ChatAgentRuntime>[0]> = {}) {
    const driver = new FakeChatDriver('copilot_sdk', 'copilot-cli', STEERLESS);
    const { runtime } = makeRuntime(driver, { now: Date.now, ...extra });
    runtimes.push(runtime);
    await runtime.start();
    driver.last.emit({ type: 'turn_started', turnId: 'held-turn', data: {} });
    await flush();
    return { runtime, driver };
  }

  it('replaces only the same Action queue and keeps other Actions and user messages', async () => {
    const { runtime, driver } = await running();
    const first = vi.fn();
    const old = await runtime.sendMessage('old', { source: 'action', delivery: 'queued', actionQueue: { actionId: 'a', onSettled: first } });
    const user = await runtime.sendMessage('user', { source: 'user' });
    const other = await runtime.sendMessage('other', { source: 'action', delivery: 'queued', actionQueue: { actionId: 'b' } });
    const latest = await runtime.sendMessage('latest', { source: 'action', delivery: 'queued', actionQueue: { actionId: 'a', latestOnly: true } });
    expect(first).toHaveBeenCalledExactlyOnceWith('replaced');
    expect(runtime.getQueueState().queuedMessageIds).toEqual([user.messageId, other.messageId, latest.messageId]);
    expect(logs('Queued chat message dropped')).toMatchObject([{ messageId: old.messageId, reason: 'latest_only' }]);
    driver.last.emit({ type: 'turn_ended', data: { stopReason: 'end_turn' } });
    await flush();
    expect(driver.last.sent[0].content).toEqual([{ type: 'text', text: 'user' }]);
  });

  it('keeps the default Action delivery queued during the idle transition before the queue drains', async () => {
    const { runtime, driver } = await running();
    const replaced = vi.fn();
    await runtime.sendMessage('old', { source: 'action', actionQueue: { actionId: 'a', onSettled: replaced } });
    driver.last.emit({ type: 'session_state', data: { state: 'idle' } });
    await flush();
    const latest = await runtime.sendMessage('latest', { source: 'action', actionQueue: { actionId: 'a', latestOnly: true } });
    expect(latest.delivery).toBe('queued');
    expect(replaced).toHaveBeenCalledExactlyOnceWith('replaced');
    expect(driver.last.sent).toHaveLength(0);
    driver.last.emit({ type: 'turn_ended', data: { stopReason: 'end_turn' } });
    await flush();
    expect(driver.last.sent[0].content).toEqual([{ type: 'text', text: 'latest' }]);
  });

  it('expires at the exact deadline, logs the loss, and never dispatches expired text', async () => {
    const { runtime, driver } = await running();
    const settled = vi.fn();
    const item = await runtime.sendMessage('stale', { source: 'action', delivery: 'queued', actionQueue: { actionId: 'a', maxWaitMs: minute, onSettled: settled } });
    await runtime.sendMessage('still wanted', { source: 'action', delivery: 'queued', actionQueue: { actionId: 'b' } });
    await vi.advanceTimersByTimeAsync(minute - 1);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledExactlyOnceWith('expired');
    expect(runtime.getQueueState().queuedMessageIds).not.toContain(item.messageId);
    expect(logs('Queued chat message dropped')).toMatchObject([{ messageId: item.messageId, reason: 'expired', waitedMs: minute }]);
    driver.last.emit({ type: 'turn_ended', data: { stopReason: 'end_turn' } });
    await flush();
    expect(driver.last.sent[0].content).toEqual([{ type: 'text', text: 'still wanted' }]);
  });

  it('does not expire a message after dispatch and reports its delivery once', async () => {
    const { runtime, driver } = await running();
    const settled = vi.fn();
    await runtime.sendMessage('wanted', { source: 'action', delivery: 'queued', actionQueue: { actionId: 'a', maxWaitMs: minute, onSettled: settled } });
    driver.last.emit({ type: 'turn_ended', data: { stopReason: 'end_turn' } });
    await flush();
    await vi.advanceTimersByTimeAsync(2 * minute);
    expect(settled).toHaveBeenCalledExactlyOnceWith('delivered');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('can expire a pending pre-prompt dispatch and drain the next item without a turn boundary', async () => {
    let release!: () => void;
    const { runtime, driver } = await running({ beforePrompt: () => new Promise((resolve) => { release = resolve; }) });
    const settled = vi.fn();
    await runtime.sendMessage('stale', { source: 'action', delivery: 'queued', actionQueue: { actionId: 'a', maxWaitMs: minute, onSettled: settled } });
    await runtime.sendMessage('next', { source: 'user' });
    await vi.advanceTimersByTimeAsync(minute - 1);
    driver.last.emit({ type: 'turn_ended', data: { stopReason: 'end_turn' } });
    await flush();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledExactlyOnceWith('expired');
    release();
    await flush();
    release();
    await flush();
    expect(driver.last.sent.map((send) => send.content)).toEqual([[{ type: 'text', text: 'next' }]]);
  });

  it('retains the first system prompt when replacing an undelivered Action message', async () => {
    const { runtime, driver } = await running({ systemPrompt: 'system' });
    await runtime.sendMessage('old', { source: 'action', delivery: 'queued', actionQueue: { actionId: 'a' } });
    await runtime.sendMessage('new', { source: 'action', delivery: 'queued', actionQueue: { actionId: 'a', latestOnly: true } });
    driver.last.emit({ type: 'turn_ended', data: { stopReason: 'end_turn' } });
    await flush();
    expect(driver.last.sent[0].content).toEqual([{ type: 'text', text: 'system' }, { type: 'text', text: 'new' }]);
  });

  it('replaces a pending pre-prompt message and serializes concurrent latest-only arrivals', async () => {
    let release!: () => void;
    const { runtime, driver } = await running({ beforePrompt: () => new Promise((resolve) => { release = resolve; }) });
    const settled = vi.fn();
    await runtime.sendMessage('old', { source: 'action', delivery: 'queued', actionQueue: { actionId: 'a', onSettled: settled } });
    driver.last.emit({ type: 'turn_ended', data: { stopReason: 'end_turn' } });
    await flush();
    await Promise.all(['second', 'latest'].map((text) => runtime.sendMessage(text, { source: 'action', delivery: 'queued', actionQueue: { actionId: 'a', latestOnly: true } })));
    expect(settled).toHaveBeenCalledExactlyOnceWith('replaced');
    expect(runtime.getQueueState().queuedMessageIds).toHaveLength(1);
    release();
    await flush();
    release();
    await flush();
    expect(driver.last.sent.map((send) => send.content)).toEqual([[{ type: 'text', text: 'latest' }]]);
  });

  it('keeps policy-controlled messages in the removable client queue with a native-queue driver', async () => {
    const driver = new FakeChatDriver('copilot_sdk', 'copilot-cli', { ...STEERLESS, queue: 'native', steer: true });
    const { runtime } = makeRuntime(driver, { now: Date.now });
    runtimes.push(runtime);
    await runtime.start();
    driver.last.emit({ type: 'turn_started', data: {} });
    await flush();
    const queued = await runtime.sendMessage('wait', { source: 'action', delivery: 'queued', actionQueue: { actionId: 'a', maxWaitMs: minute } });
    expect(driver.last.sent).toHaveLength(0);
    await runtime.sendMessage('steer', { source: 'action', delivery: 'auto', actionQueue: { actionId: 'b' } });
    expect(driver.last.sent[0].delivery).toBe('steer');
    await vi.advanceTimersByTimeAsync(minute);
    expect(runtime.getQueueState().queuedMessageIds).not.toContain(queued.messageId);
  });

  it('records actual queue expiry and replacement in Action run history, even after the handoff run finished', async () => {
    const { runtime } = await running();
    registerChatRuntime(runtime);
    const history = new Map<string, ActionRun>();
    let actions: Action[] = [];
    let state: EngineState = { nextAt: {}, waits: [] };
    const engine = new ActionsEngine({
      clock: { now: Date.now, setTimeout, clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) },
      storage: { load: () => ({ actions, state }), saveActions: (value) => { actions = value; }, saveState: (value) => { state = value; } },
      history: { put: (run) => { history.set(run.id, structuredClone(run)); }, list: () => [...history.values()] },
      facts: { agentExists: () => true, isRunning: () => true, agentName: () => 'Target', agentProjectId: () => 'p', projectName: () => 'Project', projectIdForPath: () => 'p', repoOwner: () => ({}) },
      rights: { checkSource: () => null, checkStep: () => null, maxActions: () => null },
      steps: createStepRunner({
        agentExists: () => true, agentName: () => 'Target', agentWorktree: () => undefined, isRunning: () => true,
        project: () => undefined, wake: vi.fn(), sleep: vi.fn(), startQuick: vi.fn(), notify: () => ({ shown: true }),
      }),
    });
    try {
      engine.start();
      const action = engine.create({ trigger: { kind: 'event', event: 'app.started', source: { kind: 'app' } }, steps: [{ kind: 'message', agentId: runtime.agentId, text: 'Check', latestOnly: true, maxWaitMinutes: 1 }] }, { kind: 'user' });
      const first = engine.runNow(action.id);
      await flush();
      expect(history.get(first)).toMatchObject({ outcome: 'done', steps: [{ delivery: 'queued' }] });
      const second = engine.runNow(action.id);
      await flush();
      expect(history.get(first)).toMatchObject({ outcome: 'cancelled', steps: [{ delivery: 'replaced' }] });
      await vi.advanceTimersByTimeAsync(minute);
      expect(history.get(second)).toMatchObject({ outcome: 'expired', reason: 'Queued message expired before delivery', steps: [{ delivery: 'expired' }] });
      expect(runtime.getQueueState().queuedMessageIds).toEqual([]);
    } finally {
      engine.stop();
      clearChatRuntimes();
    }
  });

  it('logs each enqueue with source, depth and turn age, then the actual dispatch wait', async () => {
    const { runtime, driver } = await running();
    await vi.advanceTimersByTimeAsync(2 * minute);
    const action = await runtime.sendMessage('private action text', { source: 'action', delivery: 'queued' });
    await runtime.sendMessage('private user text', { source: 'user' });
    await runtime.sendMessage('private helper text', { source: 'mcp' });
    await runtime.sendMessage('another private helper text', { source: 'mcp' });
    expect(logs('Chat message queued')).toMatchObject([
      { agentId: 'agent-1', source: 'action', queueDepth: 1, turnAgeMs: 2 * minute, state: 'running', turnRunning: true },
      { source: 'user', queueDepth: 2 },
      { source: 'mcp', queueDepth: 3, messageCount: 1 },
      { source: 'mcp', queueDepth: 3, messageCount: 2 },
    ]);
    await vi.advanceTimersByTimeAsync(3 * minute);
    driver.last.emit({ type: 'turn_ended', data: { stopReason: 'end_turn' } });
    await flush();
    expect(logs('Queued chat message dispatched')).toEqual([expect.objectContaining({
      messageId: action.messageId, source: 'action', queueDepth: 2, waitedMs: 3 * minute, state: 'idle',
    })]);
    expect(driver.last.sent).toHaveLength(1);
    expect(JSON.stringify(vi.mocked(appLog).mock.calls)).not.toContain('private');
  });

  it.each(['clearContext', 'stop', 'process_exit', 'abandon'] as const)('logs losses and cancels held timers on %s', async (how) => {
    const { runtime, driver } = await running();
    await runtime.sendMessage('private scheduled prompt', { source: 'action', delivery: 'queued' });
    await runtime.sendMessage('private helper update', { source: 'mcp' });
    await vi.advanceTimersByTimeAsync(minute);
    await runtime.sendMessage('private merged helper update', { source: 'mcp' });
    if (how === 'process_exit') driver.last.exit();
    else await runtime[how]();
    await flush();
    expect(logs('Queued chat message dropped')).toMatchObject([
      { source: 'action', waitedMs: minute, reason: how === 'clearContext' ? 'clearContext' : 'session_close' },
      { source: 'mcp', waitedMs: minute, messageCount: 2, reason: how === 'clearContext' ? 'clearContext' : 'session_close' },
    ]);
    expect(logs('Chat session closed with held messages')).toEqual(how === 'clearContext' ? [] : [expect.objectContaining({
      turnRunning: true, turnId: 'held-turn', turnAgeMs: minute, state: 'running',
      queueDepth: 2, messageCount: 3, sources: ['action', 'mcp'], oldestAgeMs: minute,
      reason: how === 'stop' ? 'stopped' : how === 'abandon' ? 'fallback' : 'process_exit',
    })]);
    expect(vi.getTimerCount()).toBe(0);
    expect(JSON.stringify(vi.mocked(appLog).mock.calls)).not.toContain('private');
  });

  it('warns at the oldest-message threshold with only active tool ids and names, never titles or inputs', async () => {
    const { runtime, driver } = await running({ systemPrompt: 'private system prompt' });
    driver.last.emit({ type: 'tool_call', data: {
      toolCallId: 'shell-1', toolName: 'bash', kind: 'execute', status: 'in_progress',
      title: 'private command title', rawInput: { command: 'private command arguments' },
    } });
    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      driver.last.emit({ type: 'tool_call', data: { toolCallId: status, toolName: 'finished_tool', kind: 'other', status: 'pending', title: 'private title' } });
      driver.last.emit({ type: 'tool_call_update', data: { toolCallId: status, status } });
    }
    driver.last.emit({ type: 'tool_call', data: { toolCallId: 'unknown', kind: 'other', status: 'pending', title: 'private fallback title' } });
    driver.last.emit({ type: 'session_state', data: { state: 'waiting_input' } });
    await flush();
    await runtime.sendMessage('private message content', { source: 'action', delivery: 'queued' });
    await vi.advanceTimersByTimeAsync(10 * minute - 1);
    expect(logs('Chat messages still held')).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(logs('Chat messages still held')).toEqual([expect.objectContaining({
      queueDepth: 1, messageCount: 1, sources: ['action'], oldestAgeMs: 10 * minute,
      turnAgeMs: 10 * minute, state: 'waiting_input',
      inFlightTools: [{ toolCallId: 'shell-1', toolName: 'bash' }, { toolCallId: 'unknown' }],
    })]);
    expect(vi.mocked(appLog).mock.calls.find(([, , text]) => text === 'Chat messages still held')?.[1]).toBe('warn');
    driver.last.emit({ type: 'tool_call_update', data: { toolCallId: 'shell-1', status: 'completed' } });
    driver.last.emit({ type: 'tool_call_update', data: { toolCallId: 'unknown', status: 'cancelled' } });
    await flush();
    await vi.advanceTimersByTimeAsync(10 * minute);
    expect(logs('Chat messages still held').at(-1)).toMatchObject({ inFlightTools: [] });
    await runtime.stop();
    expect(JSON.stringify(vi.mocked(appLog).mock.calls)).not.toContain('private');
  });

  it('warns at the turn threshold even when the oldest item is younger, with no timer before enqueue', async () => {
    const { runtime } = await running();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(25 * minute);
    await runtime.sendMessage('private action text', { source: 'action', delivery: 'queued' });
    await vi.advanceTimersByTimeAsync(5 * minute - 1);
    expect(logs('Chat messages still held')).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(logs('Chat messages still held')).toMatchObject([{ turnAgeMs: 30 * minute, oldestAgeMs: 5 * minute }]);
  });

  it('rate limits across new enqueues and empty queues, and stops its timer after removal', async () => {
    const { runtime } = await running();
    await vi.advanceTimersByTimeAsync(31 * minute);
    await runtime.sendMessage('private first', { source: 'action', delivery: 'queued' });
    await vi.advanceTimersByTimeAsync(0);
    expect(logs('Chat messages still held')).toHaveLength(1);
    await runtime.removeQueued();
    expect(vi.getTimerCount()).toBe(0);
    expect(logs('Queued chat message dropped')).toMatchObject([{ reason: 'removed', waitedMs: 0 }]);
    await runtime.sendMessage('private second', { source: 'action', delivery: 'queued' });
    await vi.advanceTimersByTimeAsync(9 * minute);
    await runtime.sendMessage('private third', { source: 'user' });
    expect(logs('Chat messages still held')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(minute);
    expect(logs('Chat messages still held')).toHaveLength(2);
    await runtime.removeQueued();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60 * minute);
    expect(logs('Chat messages still held')).toHaveLength(2);
  });

  it('cancels the timer when the last queued item dispatches and forgets tools at turn end', async () => {
    const { runtime, driver } = await running();
    driver.last.emit({ type: 'tool_call', data: { toolCallId: 'old', toolName: 'bash', title: 'private', kind: 'execute', status: 'in_progress' } });
    await flush();
    await runtime.sendMessage('private first', { source: 'action', delivery: 'queued' });
    driver.last.emit({ type: 'turn_ended', data: { stopReason: 'end_turn' } });
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    driver.last.emit({ type: 'turn_started', data: {} });
    await flush();
    await runtime.sendMessage('private second', { source: 'user' });
    await vi.advanceTimersByTimeAsync(10 * minute);
    expect(logs('Chat messages still held')).toMatchObject([{ inFlightTools: [] }]);
  });

  it('logs a failed dispatch without leaking an error containing prompt content', async () => {
    const { runtime, driver } = await running();
    await runtime.sendMessage('private message', { source: 'action', delivery: 'queued' });
    vi.spyOn(driver.last, 'send').mockRejectedValueOnce(new Error('private prompt echoed by driver'));
    await vi.advanceTimersByTimeAsync(minute);
    driver.last.emit({ type: 'turn_ended', data: { stopReason: 'end_turn' } });
    await flush();
    expect(logs('Queued chat message dropped')).toMatchObject([{ source: 'action', waitedMs: minute, reason: 'send_failed' }]);
    expect(vi.getTimerCount()).toBe(0);
    expect(JSON.stringify(vi.mocked(appLog).mock.calls)).not.toContain('private');
  });

  it('logs a message discarded during the pre-prompt hook exactly once under its old session', async () => {
    let release!: () => void;
    const { runtime, driver } = await running({ beforePrompt: () => new Promise((resolve) => { release = resolve; }) });
    const sessionId = runtime.getSessionId();
    await runtime.sendMessage('private old prompt', { source: 'user' });
    driver.last.emit({ type: 'turn_ended', data: { stopReason: 'end_turn' } });
    await flush();
    await runtime.clearContext();
    release();
    await flush();
    expect(logs('Queued chat message dropped')).toEqual([expect.objectContaining({ sessionId, reason: 'clearContext' })]);
    expect(logs('Queued chat message dispatched')).toEqual([]);
    expect(driver.last.sent).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('ChatAgentRuntime concealed tools (#3036)', () => {
  it('never writes or publishes a concealed call or its updates, with no gaps in seq', async () => {
    const remove = registerConcealedTools((id) => (id === 'agent-1' ? new Set(['start_work']) : null));
    try {
      const driver = new FakeChatDriver();
      const published: ChatEvent[] = [];
      onChatEvent((e) => published.push(e));
      const { runtime } = makeRuntime(driver);
      await runtime.start();
      driver.last.emit({ type: 'tool_call', data: { toolCallId: 'h1', kind: 'other', title: 'start_work', status: 'pending', toolName: 'mcp__clubhouse__start_work' } });
      driver.last.emit({ type: 'tool_call_update', data: { toolCallId: 'h1', status: 'completed' } });
      driver.last.emit({ type: 'tool_call', data: { toolCallId: 'l1', kind: 'other', title: 'list_agents', status: 'pending', toolName: 'mcp__clubhouse__list_agents' } });
      driver.last.emit({ type: 'agent_message', data: { messageId: 'm1', text: 'On it.' } });
      await vi.waitFor(() => expect(transcript.some((e) => e.type === 'agent_message')).toBe(true));
      expect(JSON.stringify(transcript)).not.toContain('start_work');
      expect(JSON.stringify(published)).not.toContain('start_work');
      expect(transcript.some((e) => e.type === 'tool_call' && e.data.toolCallId === 'l1')).toBe(true);
      expect(transcript.map((e) => e.seq)).toEqual(transcript.map((_, i) => i + 1));
    } finally {
      remove();
    }
  });
});

describe('ChatAgentRuntime rich media', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 2, 8, 6, 0, 0, 0]).toString('base64');

  afterAll(async () => {
    (await import('fs')).rmSync(mediaRoot, { recursive: true, force: true });
  });

  async function run(richMedia: boolean): Promise<ChatEvent[]> {
    const fs = await import('fs');
    fs.mkdirSync(`${mediaRoot}/agent-1`, { recursive: true });
    const driver = new FakeChatDriver();
    const published: ChatEvent[] = [];
    onChatEvent((e) => published.push(e));
    const { runtime } = makeRuntime(driver, { richMedia: () => richMedia });
    await runtime.start();
    driver.last.emit({ type: 'tool_call', data: { toolCallId: 'r1', kind: 'read', title: 'Read a.png', status: 'pending', toolName: 'Read' } });
    driver.last.emit({ type: 'tool_call_update', data: { toolCallId: 'r1', status: 'completed', media: [{ type: 'image', mimeType: 'image/png', data: PNG }] } });
    driver.last.emit({ type: 'tool_call', data: { toolCallId: 'g1', kind: 'other', title: 'Generating image', status: 'in_progress', toolName: 'imageGeneration', mediaOnly: true } });
    driver.last.emit({ type: 'tool_call_update', data: { toolCallId: 'g1', status: 'completed', media: [{ type: 'image', mimeType: 'image/png', data: PNG }] } });
    driver.last.emit({ type: 'agent_message', data: { messageId: 'm1', text: 'Done.' } });
    // Storing images is real file work: wait for the last event rather than a fixed number of ticks.
    await vi.waitFor(() => expect(transcript.some((e) => e.type === 'agent_message')).toBe(true));
    expect(published).toEqual(transcript);
    return transcript.filter((e) => e.type !== 'session_started' && e.type !== 'session_state');
  }

  it('with the flag off, writes no images and no media-only calls, with no gaps in seq', async () => {
    const events = await run(false);
    expect(events.map((e) => [e.type, (e.data as { toolCallId?: string }).toolCallId])).toEqual([
      ['tool_call', 'r1'], ['tool_call_update', 'r1'], ['agent_message', undefined],
    ]);
    expect(events[1].data).toEqual({ toolCallId: 'r1', status: 'completed' });
    expect(transcript.map((e) => e.seq)).toEqual(transcript.map((_, i) => i + 1));
  });

  it('with the flag on, stores images by reference and never writes their bytes', async () => {
    const events = await run(true);
    expect(events.map((e) => [e.type, (e.data as { toolCallId?: string }).toolCallId])).toEqual([
      ['tool_call', 'r1'], ['tool_call_update', 'r1'], ['tool_call', 'g1'], ['tool_call_update', 'g1'], ['agent_message', undefined],
    ]);
    expect(events[1].data).toEqual({ toolCallId: 'r1', status: 'completed', media: [{ type: 'image', mimeType: 'image/png', mediaRef: expect.stringMatching(/^[0-9a-f]{64}\.png$/), width: 2, height: 2 }] });
    expect(JSON.stringify(transcript)).not.toContain(PNG);
  });
});

describe('ChatAgentRuntime', () => {
  it('blocks new prompts during a remote restart and tracks delivery already in flight', async () => {
    const driver = new FakeChatDriver();
    let release!: () => void;
    const { runtime } = makeRuntime(driver, { beforePrompt: () => new Promise((resolve) => { release = resolve; }) });
    await runtime.start();
    const sending = runtime.sendMessage('already admitted', { source: 'user' });
    expect(hasAgentWorkInFlight('agent-1')).toBe(true);
    closeAgentWork();
    await expect(runtime.sendMessage('too late', { source: 'user' })).rejects.toThrow('not accepting new agent work');
    expect(driver.last.sent).toEqual([]);
    release();
    await sending;
    expect(driver.last.sent).toHaveLength(1);
    expect(hasAgentWorkInFlight('agent-1')).toBe(false);
    await runtime.stop();
  });

  it('holds queued turns during a remote restart and resumes them if restart is cancelled', async () => {
    const driver = new FakeChatDriver('claude_stream_json', 'claude-code', STEERLESS);
    const { runtime } = makeRuntime(driver);
    await runtime.start();
    driver.last.emit({ type: 'turn_started', data: {} });
    await flush();
    await runtime.sendMessage('queued work', { source: 'user', delivery: 'queued' });
    closeAgentWork();
    driver.last.emit({ type: 'turn_ended', data: { outcome: 'success' } });
    await flush();
    expect(driver.last.sent).toEqual([]);
    expect(runtime.getQueueState().queuedMessageIds).toHaveLength(1);
    reopenLaunches();
    await flush();
    expect(driver.last.sent).toHaveLength(1);
    expect(runtime.getQueueState().queuedMessageIds).toEqual([]);
    await runtime.stop();
  });

  it('keeps native queued turns working across the idle gap before the driver starts them', async () => {
    const driver = new FakeChatDriver('claude_stream_json', 'claude-code', { ...STEERLESS, queue: 'native' });
    const { runtime } = makeRuntime(driver);
    await runtime.start();
    await runtime.sendMessage('first turn', { source: 'user' });
    await runtime.sendMessage('next turn', { source: 'user', delivery: 'queued' });
    expect(runtime.hasPendingWork()).toBe(true);
    driver.last.emit({ type: 'turn_started', data: {} });
    driver.last.emit({ type: 'turn_ended', data: { outcome: 'success' } });
    await flush();
    expect(runtime.getState()).toBe('idle');
    expect(runtime.hasPendingWork()).toBe(true);
    driver.last.emit({ type: 'turn_started', data: {} });
    driver.last.emit({ type: 'turn_ended', data: { outcome: 'success' } });
    await flush();
    expect(runtime.hasPendingWork()).toBe(false);
    await runtime.stop();
  });

  it('joins a pending strict stop instead of ending a still-closing session on retry', async () => {
    const driver = new FakeChatDriver();
    const { runtime, onEnded } = makeRuntime(driver);
    await runtime.start();
    const session = driver.last;
    let finishClose!: () => void;
    const close = vi.spyOn(session, 'close').mockImplementation(() => new Promise((resolve) => { finishClose = resolve; }));
    const first = runtime.stop({ throwOnFailure: true });
    const second = runtime.stop({ throwOnFailure: true });
    const completed = vi.fn();
    void second.then(completed);
    await flush();
    expect(close).toHaveBeenCalledOnce();
    expect(runtime.isRunning()).toBe(true);
    expect(completed).not.toHaveBeenCalled();
    expect(onEnded).not.toHaveBeenCalled();
    finishClose();
    await Promise.all([first, second]);
    expect(onEnded).toHaveBeenCalledOnce();
    expect(runtime.isRunning()).toBe(false);
  });

  it('does not log driver close error content', async () => {
    vi.mocked(appLog).mockClear();
    const driver = new FakeChatDriver();
    const { runtime } = makeRuntime(driver);
    await runtime.start();
    vi.spyOn(driver.last, 'close').mockRejectedValue(new Error('private prompt /private/chat/path'));
    await expect(runtime.stop({ throwOnFailure: true })).rejects.toThrow('private prompt');
    expect(JSON.stringify(vi.mocked(appLog).mock.calls)).not.toContain('private prompt');
    expect(JSON.stringify(vi.mocked(appLog).mock.calls)).not.toContain('/private/chat/path');
  });

  it('reports driver close failure to callers that must not delete the worktree', async () => {
    const driver = new FakeChatDriver();
    const { runtime } = makeRuntime(driver);
    await runtime.start();
    const close = vi.spyOn(driver.sessions[0], 'close').mockRejectedValue(new Error('driver close failed'));
    await expect(runtime.stop({ throwOnFailure: true })).rejects.toThrow('driver close failed');
    expect(runtime.isRunning()).toBe(true);
    close.mockRestore();
    await runtime.stop({ throwOnFailure: true });
    expect(runtime.isRunning()).toBe(false);
  });

  it('preserves best-effort stop for existing callers', async () => {
    const driver = new FakeChatDriver();
    const { runtime } = makeRuntime(driver);
    await runtime.start();
    vi.spyOn(driver.sessions[0], 'close').mockRejectedValue(new Error('driver close failed'));
    await expect(runtime.stop()).resolves.toBeUndefined();
  });

  it.each(['prompt', 'steer', 'queued'] as const)('correlates mobile %s sends with authoritative message IDs before receipt delivery', async (delivery) => {
    const driver = new FakeChatDriver();
    const { runtime } = makeRuntime(driver);
    await runtime.start();
    const seen: ChatEvent[] = []; runtime.onEvent((event) => seen.push(event));
    const result = await runtime.sendMessage('hello', { source: 'annex', delivery, clientCommandId: 'mobile-command-1' });
    const message = seen.find((event) => event.type === 'user_message');
    expect(message?.data).toMatchObject({ messageId: result.messageId, clientCommandId: 'mobile-command-1', delivery: result.delivery });
    expect(result.messageId).toBeTruthy();
    await runtime.stop();
  });
  it('starts a session, stamps envelopes in order and sends the mission as a prompt', async () => {
    const driver = new FakeChatDriver();
    const published: ChatEvent[] = [];
    onChatEvent((e) => published.push(e));
    const { runtime } = makeRuntime(driver);

    await runtime.start('Fix the flaky test');
    await flush();

    expect(types()).toEqual(['session_started', 'session_state', 'user_message']);
    expect(transcript.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(published).toEqual(transcript);
    const started = transcript[0];
    expect(started.type === 'session_started' && started.data.capabilities.steer).toBe(true);
    expect(driver.last.sent).toEqual([{ content: [{ type: 'text', text: 'Fix the flaky test' }], delivery: 'prompt' }]);
    expect(runtime.getState()).toBe('idle');
    expect(runtime.isRunning()).toBe(true);
  });

  it('keeps the session alive after a turn ends and tags turn events with the turn id', async () => {
    const driver = new FakeChatDriver();
    const { runtime, onEnded } = makeRuntime(driver);
    await runtime.start();
    driver.last.emit({ type: 'turn_started', turnId: 'turn-A', data: { trigger: 'prompt' } });
    driver.last.emit({ type: 'agent_message', data: { messageId: 'm1', text: 'Done.' } });
    driver.last.emit({ type: 'turn_ended', data: { stopReason: 'end_turn' } });
    await flush();

    const message = transcript.find((e) => e.type === 'agent_message');
    expect(message?.turnId).toBe('turn-A');
    expect(runtime.getState()).toBe('idle');
    expect(runtime.isRunning()).toBe(true);
    expect(onEnded).not.toHaveBeenCalled();
    expect(types()).not.toContain('session_ended');
  });

  it('steers into a running turn when the driver can steer', async () => {
    const driver = new FakeChatDriver();
    const { runtime } = makeRuntime(driver);
    await runtime.start();
    driver.last.emit({ type: 'turn_started', data: { trigger: 'prompt' } });
    await flush();

    const result = await runtime.sendMessage('also check Windows', { source: 'user' });
    expect(result.delivery).toBe('steer');
    expect(driver.last.sent.at(-1)?.delivery).toBe('steer');
  });

  it('queues client-side when the driver cannot steer, and sends the queue at turn end', async () => {
    const driver = new FakeChatDriver('copilot_sdk', 'copilot-cli', STEERLESS);
    const { runtime } = makeRuntime(driver);
    await runtime.start();
    driver.last.emit({ type: 'turn_started', data: { trigger: 'prompt' } });
    await flush();

    const result = await runtime.sendMessage('next: open a PR', { source: 'user' });
    expect(result.delivery).toBe('queued');
    expect(driver.last.sent).toHaveLength(0);
    const queued = transcript.find((e) => e.type === 'user_message');
    expect(queued?.type === 'user_message' && queued.data.delivery).toBe('queued');

    driver.last.emit({ type: 'turn_ended', data: { stopReason: 'end_turn' } });
    await flush();
    expect(driver.last.sent).toEqual([{ content: [{ type: 'text', text: 'next: open a PR' }], delivery: 'prompt' }]);
  });

  describe('queue editing (#2413)', () => {
    async function queuedRuntime() {
      const driver = new FakeChatDriver('copilot_sdk', 'copilot-cli', STEERLESS);
      const { runtime } = makeRuntime(driver);
      await runtime.start();
      driver.last.emit({ type: 'turn_started', data: { trigger: 'prompt' } });
      await flush();
      const ids: string[] = [];
      for (const text of ['one', 'two', 'three']) ids.push((await runtime.sendMessage(text, { source: 'user', delivery: 'queued' })).messageId!);
      return { driver, runtime, ids };
    }
    const sentTexts = (driver: FakeChatDriver) => driver.last.sent.map((s) => (s.content[0] as { text: string }).text);

    it('publishes exact queue IDs, removal, and dispatch/delivery without guessing from turns', async () => {
      const { driver, runtime, ids } = await queuedRuntime();
      expect(runtime.getQueueState()).toMatchObject({ queuedMessageIds: ids, queueRemovalSupported: true });
      await runtime.removeQueued([ids[1]]);
      expect(transcript.at(-1)).toMatchObject({ type: 'queue_state', data: {
        queuedMessageIds: [ids[0], ids[2]], transition: { messageIds: [ids[1]], status: 'removed' },
      } });
      let release!: () => void;
      vi.spyOn(driver.last, 'send').mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve('prompt'); }));
      driver.last.emit({ type: 'turn_ended', data: { stopReason: 'end_turn' } });
      await flush();
      expect(runtime.getQueueState()).toEqual({ queuedMessageIds: [ids[2]], queueRemovalSupported: true, queueStateSeq: transcript.at(-1)!.seq });
      expect(transcript.at(-1)).toMatchObject({ type: 'queue_state', data: { transition: { messageIds: [ids[0]], status: 'dispatching' } } });
      expect(await runtime.removeQueued([ids[0]])).toEqual([]);
      release();
      await flush();
      expect(transcript.at(-1)).toMatchObject({ type: 'queue_state', data: {
        queuedMessageIds: [ids[2]], transition: { messageIds: [ids[0]], status: 'delivered' },
      } });
    });

    it('writes a queued message and the event saying the runtime holds it next to each other', async () => {
      const { ids } = await queuedRuntime();
      const types = transcript.filter((e) => e.type === 'user_message' || e.type === 'queue_state').map((e) => e.seq);
      expect(types).toEqual(types.map((_, i) => types[0] + i));
      expect(transcript.filter((e) => e.type === 'queue_state').map((e) => e.data)).toMatchObject(ids.map((id, i) => ({
        queuedMessageIds: ids.slice(0, i + 1), transition: { messageIds: [id], status: 'queued' },
      })));
    });

    it('records failed queue dispatch without claiming delivery or requeueing', async () => {
      const { driver, runtime, ids } = await queuedRuntime();
      vi.spyOn(driver.last, 'send').mockRejectedValueOnce(new Error('send failed'));
      driver.last.emit({ type: 'turn_ended', data: { stopReason: 'end_turn' } });
      await flush();
      expect(transcript.find((e) => e.type === 'queue_state' && (e.data as { transition?: { status: string } }).transition?.status === 'failed')).toMatchObject({ data: {
        queuedMessageIds: ids.slice(1), transition: { messageIds: [ids[0]], status: 'failed' },
      } });
      // The failed one isn't put back; the session stays, so the rest can still be removed (#3103).
      expect(runtime.getQueueState().queuedMessageIds).not.toContain(ids[0]);
      expect(runtime.getQueueState().queueRemovalSupported).toBe(true);
    });

    it('keeps the session when a queued message fails to send, and sends the next one (#3103)', async () => {
      const { driver, runtime, ids } = await queuedRuntime();
      vi.spyOn(driver.last, 'send').mockRejectedValueOnce(new Error('send failed'));
      driver.last.emit({ type: 'turn_ended', data: { stopReason: 'end_turn' } });
      await flush();
      expect(transcript.some((e) => e.type === 'session_ended')).toBe(false);
      expect(transcript.some((e) => e.type === 'error' && (e.data as { fatal?: boolean }).fatal)).toBe(false);
      expect(transcript.find((e) => e.type === 'notice' && (e.data as { code: string }).code === 'queued_send_failed')).toBeDefined();
      // The next queued message goes out in place of the failed one.
      expect(sentTexts(driver)).toEqual(['two']);
      expect(runtime.getQueueState().queuedMessageIds).toEqual([ids[2]]);
    });

    it('a message queued as a turn ends waits behind the queue, not ahead of it (#3102)', async () => {
      const { driver, runtime, ids } = await queuedRuntime();
      driver.last.emit({ type: 'turn_ended', data: { stopReason: 'end_turn' } });
      // Before the drain runs: the state may already read idle, but the queue still holds items.
      const late = await runtime.sendMessage('late', { source: 'user', delivery: 'queued' });
      await flush();
      expect(late.delivery).toBe('queued');
      expect(sentTexts(driver)).toEqual(['one']);
      expect(runtime.getQueueState().queuedMessageIds).toEqual([ids[1], ids[2], late.messageId]);
    });

    it('sends a message asked to queue as a prompt when nothing is running (#3102)', async () => {
      const driver = new FakeChatDriver('copilot_sdk', 'copilot-cli', STEERLESS);
      const { runtime } = makeRuntime(driver);
      await runtime.start();
      driver.last.emit({ type: 'turn_started', data: { trigger: 'prompt' } });
      driver.last.emit({ type: 'turn_ended', data: { stopReason: 'end_turn' } });
      await flush();
      const result = await runtime.sendMessage('late', { source: 'user', delivery: 'queued' });
      expect(result.delivery).toBe('prompt');
      expect(sentTexts(driver)).toEqual(['late']);
      expect(runtime.getQueueState().queuedMessageIds).toEqual([]);
    });

    it('does not claim native provider queued messages are locally removable', async () => {
      const driver = new FakeChatDriver('copilot_sdk', 'copilot-cli', { ...STEERLESS, queue: 'native' });
      const { runtime } = makeRuntime(driver);
      await runtime.start();
      const result = await runtime.sendMessage('provider-owned', { source: 'annex', delivery: 'queued' });
      expect(result.delivery).toBe('queued');
      expect(runtime.getQueueState()).toEqual({ queuedMessageIds: [], queueStateSeq: 0, queueRemovalSupported: false });
      expect(await runtime.removeQueued([result.messageId!])).toEqual([]);
      expect(transcript.some((e) => e.type === 'queue_state')).toBe(false);
    });

    it('removes a queued message by id, records it, and never delivers it', async () => {
      const { driver, runtime, ids } = await queuedRuntime();
      expect(await runtime.removeQueued([ids[1]])).toEqual([ids[1]]);
      expect(transcript.filter((e) => e.type === 'queue_removed').at(-1)).toMatchObject({ type: 'queue_removed', data: { messageIds: [ids[1]] } });

      driver.last.emit({ type: 'turn_ended', data: { stopReason: 'end_turn' } });
      await flush();
      driver.last.emit({ type: 'turn_started', data: { trigger: 'queued' } });
      driver.last.emit({ type: 'turn_ended', data: { stopReason: 'end_turn' } });
      await flush();
      driver.last.emit({ type: 'turn_started', data: { trigger: 'queued' } });
      driver.last.emit({ type: 'turn_ended', data: { stopReason: 'end_turn' } });
      await flush();
      expect(sentTexts(driver)).toEqual(['one', 'three']);
    });

    it('clears the whole queue with no ids, and ignores ids it does not hold', async () => {
      const { driver, runtime, ids } = await queuedRuntime();
      expect(await runtime.removeQueued(['not-queued'])).toEqual([]);
      expect(types().filter((t) => t === 'queue_removed')).toHaveLength(0);
      expect(await runtime.removeQueued()).toEqual(ids);
      expect(await runtime.removeQueued()).toEqual([]);
      driver.last.emit({ type: 'turn_ended', data: { stopReason: 'end_turn' } });
      await flush();
      expect(driver.last.sent).toHaveLength(0);
    });

    it('can no longer remove a message the turn end already sent', async () => {
      const { driver, runtime, ids } = await queuedRuntime();
      driver.last.emit({ type: 'turn_ended', data: { stopReason: 'end_turn' } });
      await flush();
      expect(await runtime.removeQueued([ids[0]])).toEqual([]);
      expect(sentTexts(driver)).toEqual(['one']);
    });
  });

  it.each([true, false])('sends /compact through mid-turn delivery and records it (steer=%s)', async (steer) => {
    const driver = new FakeChatDriver('copilot_sdk', 'copilot-cli', { ...STEERLESS, steer });
    const { runtime } = makeRuntime(driver);
    await runtime.start();
    driver.last.emit({ type: 'turn_started', data: { trigger: 'prompt' } });
    await flush();
    const result = await runtime.sendMessage('/compact', { source: 'user' });
    expect(result.delivery).toBe(steer ? 'steer' : 'queued');
    expect(driver.last.compactions).toBe(0);
    expect(transcript).toContainEqual(expect.objectContaining({ type: 'user_message', data: expect.objectContaining({
      content: [{ type: 'text', text: '/compact' }], delivery: steer ? 'steer' : 'queued',
    }) }));
    if (!steer) {
      expect(driver.last.sent).toHaveLength(0);
      driver.last.emit({ type: 'turn_ended', data: { stopReason: 'end_turn' } });
      await flush();
    }
    expect(driver.last.sent.at(-1)).toEqual({ content: [{ type: 'text', text: '/compact' }], delivery: steer ? 'steer' : 'prompt' });
  });

  it('mirrors permission requests into the shared queue and applies a queue decision', async () => {
    const driver = new FakeChatDriver();
    const { runtime } = makeRuntime(driver);
    await runtime.start();
    driver.last.emit({ type: 'turn_started', data: { trigger: 'prompt' } });
    driver.last.emit({
      type: 'permission_request',
      data: {
        requestId: 'perm-1', title: 'Run npm install', toolName: 'Bash',
        options: [
          { optionId: 'yes', kind: 'allow_once', label: 'Allow once' },
          { optionId: 'no', kind: 'reject_once', label: 'Deny' },
        ],
      },
    });
    await flush();
    expect(runtime.getState()).toBe('waiting_permission');

    const [pending] = permissionQueue.listPendingForAgent('agent-1');
    expect(pending.toolName).toBe('Bash');
    expect(permissionQueue.resolvePermission(pending.requestId, 'allow', { expectedAgentId: 'agent-1' })).toBe(true);
    await flush();

    expect(driver.last.responses).toEqual([{ requestId: 'perm-1', optionId: 'yes' }]);
    const resolved = transcript.find((e) => e.type === 'permission_resolved');
    expect(resolved?.type === 'permission_resolved' && resolved.data).toMatchObject({ decision: 'allow', by: 'annex' });
    expect(runtime.getState()).toBe('running');
  });

  it('exposes only unsettled approval options while an answer is in flight', async () => {
    const driver = new FakeChatDriver(); const { runtime } = makeRuntime(driver);
    await runtime.start();
    const options = [{ optionId: 'once', kind: 'allow_once' as const, label: 'Allow once' }];
    driver.last.emit({ type: 'permission_request', data: { requestId: 'pending', title: 'Run tool', options } });
    await flush(); expect(runtime.getPendingPermissionOptions('pending')).toEqual(options);
    let finish!: () => void;
    driver.last.respondPermission = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const answering = runtime.respondPermission('pending', 'once');
    expect(runtime.getPendingPermissionOptions('pending')).toBeUndefined();
    finish(); await answering;
    expect(runtime.getPendingPermissionOptions('pending')).toBeUndefined();
    await runtime.stop();
  });

  it('stamps events in milliseconds on the clock the approve check compares them with', async () => {
    // No clock passed: the runtime's own default, as in the app.
    const driver = new FakeChatDriver(); const { runtime } = makeRuntime(driver, { now: undefined });
    await runtime.start();
    const published: ChatEvent[] = [];
    onChatEvent((e) => published.push(e));
    _forgetSentPermissionsForTest(Date.now());
    const before = Date.now();
    // Over the floor and under the cap, so only the event's time decides.
    driver.last.emit({ type: 'permission_request', data: { requestId: 'timed', title: 'Write', options: [], rawInput: { content: 'c'.repeat(16 * 1024) } } });
    await flush();
    const after = Date.now();

    const event = published.find((e) => e.type === 'permission_request') as Extract<ChatEvent, { type: 'permission_request' }>;
    expect(event.ts).toBeGreaterThanOrEqual(before);
    expect(event.ts).toBeLessThanOrEqual(after);
    expect(isIncompletePermission(event)).toBe(false);
    // As if the desktop restarted with this still pending.
    _forgetSentPermissionsForTest(after + 1);
    expect(isIncompletePermission(event)).toBe(true);
    await runtime.stop();
  });

  it('answers a permission directly and drops the mirrored queue entry', async () => {
    const driver = new FakeChatDriver();
    const { runtime } = makeRuntime(driver);
    await runtime.start();
    driver.last.emit({
      type: 'permission_request',
      data: { requestId: 'perm-2', title: 'Edit file', options: [{ optionId: 'always', kind: 'allow_always', label: 'Always allow', scope: 'Edit:*' }] },
    });
    await flush();

    await runtime.respondPermission('perm-2', 'always');
    await flush();
    expect(driver.last.responses).toEqual([{ requestId: 'perm-2', optionId: 'always' }]);
    expect(permissionQueue.listPendingForAgent('agent-1')).toEqual([]);
    const resolved = transcript.filter((e) => e.type === 'permission_resolved');
    expect(resolved).toHaveLength(1);
  });

  it('writes one permission_resolved per answer, in the turn, when the driver echoes its own (live test)', async () => {
    const driver = new FakeChatDriver();
    const { runtime } = makeRuntime(driver);
    await runtime.start();
    const session = driver.last;
    // Like the Claude and Codex drivers: answering also reports the resolution from the driver side.
    const respond = session.respondPermission.bind(session);
    session.respondPermission = async (requestId, optionId, extras) => {
      await respond(requestId, optionId, extras);
      session.emit({ type: 'permission_resolved', data: { requestId, optionId, decision: 'allow', by: 'user' } });
    };
    const answer = session.answerQuestion.bind(session);
    session.answerQuestion = async (requestId, answers) => {
      await answer(requestId, answers);
      session.emit({ type: 'question_resolved', data: { requestId, answers } });
    };
    session.emit({ type: 'turn_started', turnId: 'turn-1', data: { trigger: 'prompt' } });
    session.emit({ type: 'permission_request', data: { requestId: 'dc7bd13e', title: 'Run ls', options: [{ optionId: 'allow', kind: 'allow_once', label: 'Allow' }] } });
    session.emit({ type: 'question', data: { requestId: 'q1', questions: [{ id: 'a', prompt: 'Which?', multiSelect: false, allowFreeText: true }] } });
    await flush();

    await runtime.respondPermission('dc7bd13e', 'allow');
    await runtime.answerQuestion('q1', { a: 'x' });
    await flush();

    const resolved = transcript.filter((e) => e.type === 'permission_resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0].turnId).toBe('turn-1');
    const answered = transcript.filter((e) => e.type === 'question_resolved');
    expect(answered).toHaveLength(1);
    expect(answered[0].turnId).toBe('turn-1');
  });

  it('writes one permission_resolved for Codex "Deny and stop the turn", which both sides call cancelled (#2202 review)', async () => {
    const driver = new FakeChatDriver();
    const { runtime } = makeRuntime(driver);
    await runtime.start();
    const session = driver.last;
    const respond = session.respondPermission.bind(session);
    // Codex maps cancel_turn to decision 'cancelled' and reports its own resolution.
    session.respondPermission = async (requestId, optionId, extras) => {
      await respond(requestId, optionId, extras);
      session.emit({ type: 'permission_resolved', data: { requestId, optionId, decision: 'cancelled', by: 'user' } });
    };
    session.emit({ type: 'turn_started', turnId: 'turn-1', data: { trigger: 'prompt' } });
    session.emit({
      type: 'permission_request',
      data: { requestId: 'cx1', title: 'Run rm', options: [{ optionId: 'allow', kind: 'allow_once', label: 'Allow' }, { optionId: 'stop', kind: 'cancel_turn', label: 'Deny and stop the turn' }] },
    });
    await flush();

    await runtime.respondPermission('cx1', 'stop');
    await flush();

    const resolved = transcript.filter((e) => e.type === 'permission_resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0].type === 'permission_resolved' && resolved[0].data).toMatchObject({ requestId: 'cx1', decision: 'cancelled' });
    expect(resolved[0].turnId).toBe('turn-1');

    // The key cleared with the echo: a later driver cancellation of the same id isn't swallowed.
    session.emit({ type: 'permission_resolved', data: { requestId: 'cx1', decision: 'cancelled', by: 'agent' } });
    await flush();
    expect(transcript.filter((e) => e.type === 'permission_resolved')).toHaveLength(2);
  });

  it('still records a driver\'s own cancellation of a request', async () => {
    const driver = new FakeChatDriver();
    const { runtime } = makeRuntime(driver);
    await runtime.start();
    driver.last.emit({ type: 'permission_request', data: { requestId: 'p9', title: 'Run ls', options: [{ optionId: 'allow', kind: 'allow_once', label: 'Allow' }] } });
    await flush();
    driver.last.emit({ type: 'permission_resolved', data: { requestId: 'p9', decision: 'cancelled', by: 'agent' } });
    await flush();
    const resolved = transcript.filter((e) => e.type === 'permission_resolved');
    expect(resolved.map((e) => e.type === 'permission_resolved' && e.data.decision)).toEqual(['cancelled']);
  });

  it('interrupts the turn when supported, and stops when not', async () => {
    const steering = new FakeChatDriver();
    const a = makeRuntime(steering);
    await a.runtime.start();
    await a.runtime.interrupt();
    expect(steering.last.interrupts).toBe(1);
    expect(a.runtime.isRunning()).toBe(true);

    transcript.length = 0;
    const plain = new FakeChatDriver('copilot_sdk', 'copilot-cli', { ...STEERLESS, interrupt: false });
    const b = makeRuntime(plain);
    await b.runtime.start();
    await b.runtime.interrupt();
    await flush();
    expect(plain.last.closed).toBe(true);
    expect(b.onEnded).toHaveBeenCalledWith('stopped', 0);
  });

  it('ends with process_exit when the CLI exits on its own', async () => {
    const driver = new FakeChatDriver();
    const { runtime, onEnded } = makeRuntime(driver);
    await runtime.start();
    driver.last.exit();
    await flush();

    const ended = transcript.find((e) => e.type === 'session_ended');
    expect(ended?.type === 'session_ended' && ended.data.reason).toBe('process_exit');
    expect(onEnded).toHaveBeenCalledWith('process_exit', 0);
    expect(runtime.isRunning()).toBe(false);
    expect(runtime.getState()).toBe('sleeping');
  });

  it('sleeps after the idle timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const driver = new FakeChatDriver();
    const { runtime, onEnded } = makeRuntime(driver, { idleTimeoutMs: 60_000 });
    await runtime.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();

    expect(driver.last.closed).toBe(true);
    expect(onEnded).toHaveBeenCalledWith('idle_timeout', 0);
  });

  it('notes the idle sleep in the transcript before the session ends (#2104)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const driver = new FakeChatDriver();
    const { runtime } = makeRuntime(driver, { idleTimeoutMs: 30 * 60_000 });
    const events: Array<{ type: string; data: unknown }> = [];
    runtime.onEvent((e) => events.push({ type: e.type, data: e.data }));
    await runtime.start();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await flush();
    const notice = events.findIndex((e) => e.type === 'notice');
    expect(events[notice].data).toEqual({ level: 'info', code: 'idle_sleep', message: 'Slept after 30 min idle.' });
    expect(notice).toBeLessThan(events.findIndex((e) => e.type === 'session_ended'));
    expect(runtime.idleSleptAfterMs).toBe(30 * 60_000);
  });

  it('reads the idle timeout each time it arms, and never sleeps at 0 (#2104)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let timeout = 0;
    const driver = new FakeChatDriver();
    const { runtime, onEnded } = makeRuntime(driver, { idleTimeoutMs: () => timeout });
    await runtime.start();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    await flush();
    expect(onEnded).not.toHaveBeenCalled();

    // The new value applies from the next idle period (after a turn).
    timeout = 60_000;
    await runtime.sendMessage('hi', { source: 'user' });
    driver.last.emit({ type: 'turn_started', data: { trigger: 'prompt' } });
    driver.last.emit({ type: 'turn_ended', data: { stopReason: 'end_turn' } });
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(onEnded).toHaveBeenCalledWith('idle_timeout', 0);
  });

  it('a Never or a longer timeout chosen while the timer runs applies to that idle period (#2104)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let timeout = 30 * 60_000;
    const driver = new FakeChatDriver();
    const { runtime, onEnded } = makeRuntime(driver, { idleTimeoutMs: () => timeout });
    await runtime.start();
    // Five minutes in, the user picks 1 h: no sleep at 30 min, sleep at 60.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    timeout = 60 * 60_000;
    await vi.advanceTimersByTimeAsync(25 * 60_000);
    await flush();
    expect(onEnded).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await flush();
    expect(onEnded).toHaveBeenCalledWith('idle_timeout', 0);
    expect(runtime.idleSleptAfterMs).toBe(60 * 60_000);

    const second = new FakeChatDriver();
    const { runtime: other, onEnded: otherEnded } = makeRuntime(second, { idleTimeoutMs: () => timeout });
    timeout = 30 * 60_000;
    await other.start();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    timeout = 0; // Never
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    await flush();
    expect(otherEnded).not.toHaveBeenCalled();
    expect(second.last.closed).toBe(false);
  });

  it('re-arms when the agent\'s auto-sleep changes, counting from the change (#2143)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let timeout = 60 * 60_000;
    const driver = new FakeChatDriver();
    const { runtime, onEnded } = makeRuntime(driver, { idleTimeoutMs: () => timeout });
    await runtime.start();
    // Twenty minutes idle, then the agent is set to 15 min: it doesn't sleep
    // at once, but 15 min after the change.
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    timeout = 15 * 60_000;
    runtime.idleTimeoutChanged();
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    await flush();
    expect(onEnded).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(onEnded).toHaveBeenCalledWith('idle_timeout', 0);
    expect(runtime.idleSleptAfterMs).toBe(15 * 60_000);
  });

  it('ignores an auto-sleep change mid-turn; the turn end arms with the new value (#2143)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let timeout = 60 * 60_000;
    const driver = new FakeChatDriver();
    const { runtime, onEnded } = makeRuntime(driver, { idleTimeoutMs: () => timeout });
    await runtime.start();
    await runtime.sendMessage('hi', { source: 'user' });
    driver.last.emit({ type: 'turn_started', data: { trigger: 'prompt' } });
    await flush();
    timeout = 60_000;
    runtime.idleTimeoutChanged();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await flush();
    expect(onEnded).not.toHaveBeenCalled();
    driver.last.emit({ type: 'turn_ended', data: { stopReason: 'end_turn' } });
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(onEnded).toHaveBeenCalledWith('idle_timeout', 0);
  });

  it('stays awake when shouldIdleSleep says no, and checks again next period (#2104)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let polling = true;
    const driver = new FakeChatDriver();
    const { runtime, onEnded } = makeRuntime(driver, { idleTimeoutMs: 60_000, shouldIdleSleep: () => !polling });
    await runtime.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(onEnded).not.toHaveBeenCalled();
    expect(driver.last.closed).toBe(false);

    polling = false;
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(onEnded).toHaveBeenCalledWith('idle_timeout', 0);
  });

  it('clearContext starts a new conversation with a fresh sequence', async () => {
    const driver = new FakeChatDriver();
    const { runtime } = makeRuntime(driver);
    await runtime.start();
    const firstSession = runtime.getSessionId();
    await runtime.clearContext();
    await flush();

    expect(driver.sessions).toHaveLength(2);
    expect(driver.sessions[0].closed).toBe(true);
    expect(runtime.getSessionId()).not.toBe(firstSession);
    const newSessionEvents = transcript.filter((e) => e.sessionId === runtime.getSessionId());
    expect(newSessionEvents[0].seq).toBe(1);
    expect((await runtime.readTranscript()).events).toEqual(newSessionEvents);
    expect((await runtime.readTranscript({ tail: 1 })).events).toEqual(newSessionEvents.slice(-1));
    expect(runtime.isRunning()).toBe(true);
  });

  it('counts as a chat agent for the whole clearContext swap (#2218)', async () => {
    const driver = new FakeChatDriver();
    let releaseStart!: () => void;
    let starts = 0;
    const { runtime } = makeRuntime(driver, {
      startSession: async (resumeId) => {
        // The second start (the clear) waits, like a real CLI handshake.
        if (++starts === 2) await new Promise<void>((resolve) => { releaseStart = resolve; });
        return driver.start({ agentId: 'agent-1', provider: 'claude-code', cwd: '/repo', binaryPath: '/bin/claude', level: 'ask', resumeNativeSessionId: resumeId });
      },
    });
    await runtime.start();
    registerChatRuntime(runtime);
    try {
      expect(runtime.isSwappingSession()).toBe(false);
      const clearing = runtime.clearContext();
      await flush();
      // The renderer already sees the new session id; the old session is closed and the new one isn't open.
      expect(transcript.some((e) => e.sessionId === runtime.getSessionId() && e.type === 'notice')).toBe(true);
      expect(runtime.isRunning()).toBe(false);
      expect(runtime.isSwappingSession()).toBe(true);
      expect(isChatAgent('agent-1')).toBe(true);
      releaseStart();
      await clearing;
      expect(runtime.isRunning()).toBe(true);
      expect(runtime.isSwappingSession()).toBe(false);
      expect(isChatAgent('agent-1')).toBe(true);
    } finally {
      clearChatRuntimes();
    }
  });

  it('stops counting as a chat agent when stopped mid-clear (#2218)', async () => {
    const driver = new FakeChatDriver();
    let starts = 0;
    const { runtime } = makeRuntime(driver, {
      startSession: async (resumeId, signal) => {
        if (++starts === 2) await new Promise<void>((_resolve, reject) => { signal?.addEventListener('abort', () => reject(new Error('aborted'))); });
        return driver.start({ agentId: 'agent-1', provider: 'claude-code', cwd: '/repo', binaryPath: '/bin/claude', level: 'ask', resumeNativeSessionId: resumeId });
      },
    });
    await runtime.start();
    registerChatRuntime(runtime);
    try {
      const clearing = runtime.clearContext().catch((err: unknown) => err);
      await flush();
      expect(isChatAgent('agent-1')).toBe(true);
      await runtime.stop();
      expect(await clearing).toBeInstanceOf(ChatStartCancelledError);
      expect(runtime.isSwappingSession()).toBe(false);
      expect(isChatAgent('agent-1')).toBe(false);
    } finally {
      clearChatRuntimes();
    }
  });

  it('finishes pending old-session writes before clearing context', async () => {
    const driver = new FakeChatDriver();
    const { runtime } = makeRuntime(driver);
    await runtime.start();
    const oldId = runtime.getSessionId();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(appendChatEvent).mockImplementationOnce(async (event) => {
      await pending;
      transcript.push(event);
    });
    driver.last.emit({ type: 'agent_message', data: { messageId: 'late', text: 'Old reply' } });
    await flush(1);
    const clearing = runtime.clearContext();
    await flush(1);
    expect(runtime.getSessionId()).toBe(oldId);
    release();
    await clearing;
    await flush();
    const oldReply = transcript.find((e) => e.type === 'agent_message');
    expect(oldReply?.sessionId).toBe(oldId);
    expect((await runtime.readTranscript()).events?.every((e) => e.sessionId === runtime.getSessionId())).toBe(true);
    expect((await runtime.readTranscript()).events?.[0].seq).toBe(1);
  });

  it('continues an earlier session sequence on resume and reports the native id', async () => {
    const driver = new FakeChatDriver();
    const onNativeSessionId = vi.fn();
    const { runtime } = makeRuntime(driver, {
      sessionId: 'chat-session-7', lastSeq: 41, resumeNativeSessionId: 'native-xyz', onNativeSessionId,
    });
    await runtime.start();
    await flush();

    expect(transcript[0]).toMatchObject({ sessionId: 'chat-session-7', seq: 42 });
    const started = transcript.find((e) => e.type === 'session_started');
    expect(started?.type === 'session_started' && started.data).toMatchObject({ resumed: true, nativeSessionId: 'native-xyz' });
    expect(onNativeSessionId).toHaveBeenCalledWith('native-xyz');
    expect(driver.last.startOptions?.resumeNativeSessionId).toBe('native-xyz');
  });

  it('reports the fresh native id when the driver could not resume, so the next wake resumes that (#2296)', async () => {
    const driver = new FakeChatDriver();
    const onNativeSessionId = vi.fn();
    const { runtime } = makeRuntime(driver, {
      resumeNativeSessionId: 'native-stale',
      onNativeSessionId,
      // A driver that fell back to a new session (the old one was missing or stalled).
      startSession: async (resumeId) => {
        await driver.start({ agentId: 'agent-1', provider: 'claude-code', cwd: '/repo', binaryPath: '/bin/claude', level: 'ask', resumeNativeSessionId: resumeId });
        driver.last.nativeSessionId = 'native-fresh';
        return driver.last;
      },
    });
    await runtime.start();
    await flush();

    expect(driver.last.startOptions?.resumeNativeSessionId).toBe('native-stale');
    expect(runtime.getNativeSessionId()).toBe('native-fresh');
    expect(onNativeSessionId).toHaveBeenCalledWith('native-fresh');
    expect(onNativeSessionId).not.toHaveBeenCalledWith('native-stale');
  });

  it('reads its transcript incrementally', async () => {
    const driver = new FakeChatDriver();
    const { runtime } = makeRuntime(driver);
    await runtime.start();
    await flush();
    const all = await runtime.readTranscript();
    expect(all.kind).toBe('chat');
    const later = await runtime.readTranscript({ afterSeq: 2 });
    expect(later.events?.every((e) => e.seq > 2)).toBe(true);
  });

  it('applies late session facts from session_info', async () => {
    const driver = new FakeChatDriver('claude_stream_json', 'claude-code', STEERLESS);
    const onNativeSessionId = vi.fn();
    const { runtime } = makeRuntime(driver, { onNativeSessionId });
    await runtime.start();
    driver.last.emit({ type: 'session_info', data: { nativeSessionId: 'late-id', capabilities: { steer: true } } });
    await flush();

    expect(runtime.getNativeSessionId()).toBe('late-id');
    expect(onNativeSessionId).toHaveBeenLastCalledWith('late-id');
    expect(runtime.getCapabilities()?.steer).toBe(true);
    driver.last.emit({ type: 'turn_started', data: { trigger: 'prompt' } });
    await flush();
    expect((await runtime.sendMessage('steer me', { source: 'user' })).delivery).toBe('steer');
  });

  it('keeps the provider report for the current native session only, merging a partial report (#2855)', async () => {
    const driver = new FakeChatDriver('copilot_sdk', 'copilot-cli', STEERLESS);
    const { runtime } = makeRuntime(driver);
    await runtime.start();
    const inventory = (nativeSessionId: string, extra: Record<string, unknown>) =>
      ({ provider: 'copilot' as const, driver: 'copilot_sdk' as const, source: 'session.skills_loaded' as const, nativeSessionId, ...extra });
    driver.last.emit({ type: 'session_info', data: { nativeSessionId: 'n1', mcpServers: [{ name: 'tickets', status: 'connected' }],
      providerInventory: inventory('n1', { skills: ['review'], mcpTools: ['mcp__tickets__a'] }) } });
    driver.last.emit({ type: 'session_info', data: { providerInventory: inventory('n1', { skills: ['review', 'deploy'] }) } });
    await flush();
    expect(runtime.getProviderReport()).toEqual({ driver: 'copilot_sdk', nativeSessionId: 'n1',
      inventory: inventory('n1', { skills: ['review', 'deploy'], mcpTools: ['mcp__tickets__a'] }), mcpHandshakes: [{ name: 'tickets', status: 'connected' }] });
    // Another session's report never speaks for this one.
    driver.last.emit({ type: 'session_info', data: { providerInventory: inventory('other', { skills: ['x'] }) } });
    await flush();
    expect(runtime.getProviderReport().inventory).toBeUndefined();
  });

  it('pushes state changes, events and exit to listeners', async () => {
    const driver = new FakeChatDriver();
    const { runtime } = makeRuntime(driver);
    const states: string[] = [];
    const events: string[] = [];
    const exits: unknown[] = [];
    runtime.onStateChange((s) => states.push(s));
    runtime.onEvent((e) => events.push(e.type));
    const unsubscribe = runtime.onExit((info) => exits.push(info));
    await runtime.start();
    driver.last.emit({ type: 'turn_started', data: { trigger: 'prompt' } });
    driver.last.emit({ type: 'turn_ended', data: { stopReason: 'end_turn' } });
    await flush();
    await runtime.stop();
    await flush();

    expect(states).toEqual(['idle', 'running', 'idle', 'sleeping']);
    expect(events).toContain('turn_ended');
    expect(exits).toEqual([{ reason: 'stopped', exitCode: 0 }]);
    unsubscribe();
  });

  it('passes permission extras and multi-question answers to the driver', async () => {
    const driver = new FakeChatDriver();
    const { runtime } = makeRuntime(driver);
    await runtime.start();
    driver.last.emit({ type: 'permission_request', data: { requestId: 'plan', title: 'Approve plan', toolName: 'ExitPlanMode', options: [{ optionId: 'no', kind: 'reject_once', label: 'Keep planning' }] } });
    driver.last.emit({ type: 'question', data: { requestId: 'q', questions: [{ id: 'a', prompt: 'Areas?', multiSelect: true, allowFreeText: false }] } });
    await flush();

    await runtime.respondPermission('plan', 'no', { message: 'Split step 2 in two' });
    await runtime.answerQuestion('q', { a: ['ui', 'api'] });
    await flush();

    expect(driver.last.responses).toEqual([{ requestId: 'plan', optionId: 'no', extras: { message: 'Split step 2 in two' } }]);
    expect(driver.last.answers).toEqual([{ requestId: 'q', answers: { a: ['ui', 'api'] } }]);
    const resolved = transcript.find((e) => e.type === 'question_resolved');
    expect(resolved?.type === 'question_resolved' && resolved.data.answers).toEqual({ a: ['ui', 'api'] });
  });

  it('passes long question ids to the driver and the transcript exactly as given (#2676)', async () => {
    const driver = new FakeChatDriver();
    const { runtime } = makeRuntime(driver);
    await runtime.start();
    const id = ` ${'q'.repeat(65534)} `;
    driver.last.emit({ type: 'question', data: { requestId: 'q', questions: [{ id, prompt: id }] } });
    await flush();

    await runtime.answerQuestion('q', { [id]: 'a' });
    await flush();

    expect(driver.last.answers).toEqual([{ requestId: 'q', answers: { [id]: 'a' } }]);
    const resolved = transcript.find((e) => e.type === 'question_resolved');
    expect(resolved?.type === 'question_resolved' && resolved.data.answers).toEqual({ [id]: 'a' });
  });

  it('ignores a second or late answer to the same request instead of failing', async () => {
    const driver = new FakeChatDriver();
    const { runtime } = makeRuntime(driver);
    await runtime.start();
    driver.last.emit({ type: 'permission_request', data: { requestId: 'p1', title: 'Run tests', toolName: 'Bash', options: [{ optionId: 'ok', kind: 'allow_once', label: 'Allow' }] } });
    driver.last.emit({ type: 'question', data: { requestId: 'q1', questions: [{ id: 'a', prompt: 'Which?', multiSelect: false, allowFreeText: true }] } });
    await flush();

    // Two views answer at once, then one answers again after it resolved.
    await Promise.all([runtime.respondPermission('p1', 'ok'), runtime.respondPermission('p1', 'ok')]);
    await runtime.respondPermission('p1', 'ok');
    await Promise.all([runtime.answerQuestion('q1', { a: 'x' }), runtime.answerQuestion('q1', { a: 'y' })]);
    await runtime.answerQuestion('q1', { a: 'z' });
    // Never asked.
    await runtime.respondPermission('nope', 'ok');
    await runtime.answerQuestion('nope', { a: 'x' });
    await flush();

    expect(driver.last.responses).toEqual([{ requestId: 'p1', optionId: 'ok' }]);
    expect(driver.last.answers).toEqual([{ requestId: 'q1', answers: { a: 'x' } }]);
    expect(transcript.filter((e) => e.type === 'permission_resolved')).toHaveLength(1);
    expect(transcript.filter((e) => e.type === 'question_resolved')).toHaveLength(1);
  });

  it('lets an answer be retried after the driver failed to send it', async () => {
    const driver = new FakeChatDriver();
    const { runtime } = makeRuntime(driver);
    await runtime.start();
    driver.last.emit({ type: 'permission_request', data: { requestId: 'p2', title: 'Edit', toolName: 'Edit', options: [{ optionId: 'ok', kind: 'allow_once', label: 'Allow' }] } });
    await flush();
    const real = driver.last.respondPermission.bind(driver.last);
    driver.last.respondPermission = vi.fn().mockRejectedValueOnce(new Error('stdin closed')).mockImplementation(real);
    await expect(runtime.respondPermission('p2', 'ok')).rejects.toThrow('stdin closed');
    await runtime.respondPermission('p2', 'ok');
    expect(driver.last.responses).toEqual([{ requestId: 'p2', optionId: 'ok' }]);
  });

  it('prepends the system prompt once when the driver cannot pass it', async () => {
    const driver = new FakeChatDriver('copilot_sdk', 'copilot-cli', { ...STEERLESS, systemPrompt: false });
    const { runtime } = makeRuntime(driver, { systemPrompt: 'You are the release agent.' });
    await runtime.start('Cut 0.43');
    await runtime.sendMessage('and tag it', { source: 'user' });
    expect(driver.last.sent[0].content).toEqual([
      { type: 'text', text: 'You are the release agent.' },
      { type: 'text', text: 'Cut 0.43' },
    ]);
    expect(driver.last.sent[1].content).toEqual([{ type: 'text', text: 'and tag it' }]);
  });

  it('leaves the system prompt to drivers that pass it natively', async () => {
    const driver = new FakeChatDriver('claude_agent_sdk', 'claude-code', { ...MINIMAL_CHAT_CAPABILITIES, systemPrompt: true });
    const { runtime } = makeRuntime(driver, { systemPrompt: 'Native.' });
    await runtime.start('hi');
    expect(driver.last.sent[0].content).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('broadcasts pending and settled so the desktop prompt shows chat requests', async () => {
    const driver = new FakeChatDriver();
    const { runtime } = makeRuntime(driver);
    await runtime.start();
    driver.last.emit({ type: 'permission_request', data: { requestId: 'p9', title: 'Run tests', toolName: 'Bash', options: [{ optionId: 'ok', kind: 'allow_once', label: 'Allow' }] } });
    await flush();
    const pendingCall = broadcasts.calls.find((c) => c[0] === 'agent:permission-pending');
    expect(pendingCall?.[1]).toBe('agent-1');
    expect(pendingCall?.[2]).toMatchObject({ toolName: 'Bash', message: 'Run tests' });

    await runtime.respondPermission('p9', 'ok');
    const settled = broadcasts.calls.find((c) => c[0] === 'agent:permission-settled');
    expect(settled?.[2]).toMatchObject({ decision: 'allow' });
    expect(permissionQueue.listPendingForAgent('agent-1')).toEqual([]);
  });

  it('closes the CLI when handling turn_ended throws', async () => {
    const driver = new FakeChatDriver('copilot_sdk', 'copilot-cli', STEERLESS);
    const { runtime, onEnded } = makeRuntime(driver);
    await runtime.start();
    driver.last.emit({ type: 'turn_started', data: { trigger: 'prompt' } });
    await flush();
    // A failed queued send no longer ends the session (#3103), so something else in the handler throws.
    vi.spyOn(runtime as unknown as { drainQueue: () => Promise<void> }, 'drainQueue').mockRejectedValueOnce(new Error('pipe broke'));
    driver.last.emit({ type: 'turn_ended', data: { stopReason: 'end_turn' } });
    await flush();
    expect(driver.last.closed).toBe(true);
    expect(onEnded).toHaveBeenCalledWith('process_exit', 0);
    expect(transcript.some((e) => e.type === 'error' && e.data.code === 'driver_stream_failed')).toBe(true);
  });

  it('abandons after a failed start without firing onEnded, ending the session as a fallback', async () => {
    const driver = new FakeChatDriver();
    const { runtime, onEnded } = makeRuntime(driver);
    await runtime.start();
    await runtime.abandon();
    await runtime.abandon();
    await flush();
    expect(driver.last.closed).toBe(true);
    expect(onEnded).not.toHaveBeenCalled();
    const ended = transcript.filter((e) => e.type === 'session_ended');
    expect(ended).toHaveLength(1);
    expect(ended[0].data).toMatchObject({ reason: 'fallback' });
  });

  it('runs the pre-prompt hook before new prompts but not before steering', async () => {
    const driver = new FakeChatDriver();
    const order: string[] = [];
    const beforePrompt = vi.fn(async () => { order.push('checkpoint'); });
    const { runtime } = makeRuntime(driver, { beforePrompt });
    await runtime.start();
    const realSend = driver.last.send.bind(driver.last);
    driver.last.send = async (content, delivery) => { order.push(`send:${delivery}`); return realSend(content, delivery); };

    await runtime.sendMessage('first', { source: 'user' });
    driver.last.emit({ type: 'turn_started', data: { trigger: 'prompt' } });
    await flush();
    await runtime.sendMessage('steer this', { source: 'user' });
    expect(order).toEqual(['checkpoint', 'send:prompt', 'send:steer']);
  });

  it('sends the prompt anyway when the pre-prompt hook runs past its 5 s bound', async () => {
    const driver = new FakeChatDriver();
    const beforePrompt = vi.fn(() => new Promise<void>(() => {}));
    const { runtime } = makeRuntime(driver, { beforePrompt });
    await runtime.start();
    const sent: string[] = [];
    const realSend = driver.last.send.bind(driver.last);
    driver.last.send = async (content, delivery) => { sent.push(delivery); return realSend(content, delivery); };

    vi.useFakeTimers();
    try {
      const sending = runtime.sendMessage('first', { source: 'user' });
      await vi.advanceTimersByTimeAsync(4999);
      expect(sent).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await sending;
      expect(sent).toEqual(['prompt']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects actions once ended', async () => {
    const driver = new FakeChatDriver();
    const { runtime } = makeRuntime(driver);
    await runtime.start();
    await runtime.stop();
    await expect(runtime.sendMessage('hello', { source: 'user' })).rejects.toThrow(/not running/);
  });
});

describe('ChatAgentRuntime stop during start (#2087)', () => {
  function hangingStart(driver: FakeChatDriver) {
    const pending: { signal?: AbortSignal; resolve?: () => void; reject?: (err: Error) => void } = {};
    const { runtime, onEnded } = makeRuntime(driver, {
      startSession: (resumeId, signal) => new Promise((resolve, reject) => {
        pending.signal = signal;
        pending.resolve = () => void driver.start({
          agentId: 'agent-1', provider: 'claude-code', cwd: '/repo', binaryPath: '/bin/claude', level: 'ask', resumeNativeSessionId: resumeId,
        }).then(resolve);
        pending.reject = reject;
      }),
    });
    return { runtime, onEnded, pending };
  }

  it('rejects the start at once, aborts the driver start and ends once', async () => {
    const driver = new FakeChatDriver();
    const { runtime, onEnded, pending } = hangingStart(driver);
    const started = runtime.start('mission');
    await flush();

    await runtime.stop();
    await expect(started).rejects.toBeInstanceOf(ChatStartCancelledError);
    expect(pending.signal?.aborted).toBe(true);
    expect(runtime.wasStopped).toBe(true);
    expect(onEnded).toHaveBeenCalledTimes(1);

    // The driver gives up later: nothing more happens.
    pending.reject?.(new Error("RPC request 'session/load' timed out after 30000ms"));
    await flush();
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(types().filter((t) => t === 'session_ended')).toHaveLength(1);
  });

  it('closes a session that opens after the stop instead of adopting it', async () => {
    const driver = new FakeChatDriver();
    const { runtime, pending } = hangingStart(driver);
    const started = runtime.start();
    await flush();

    await runtime.stop();
    pending.resolve?.();
    await expect(started).rejects.toBeInstanceOf(ChatStartCancelledError);
    await flush();
    expect(driver.last.closed).toBe(true);
    expect(driver.last.sent).toEqual([]);
    expect(runtime.isRunning()).toBe(false);
  });

  it('abandon() also cancels a pending start', async () => {
    const driver = new FakeChatDriver();
    const { runtime, onEnded, pending } = hangingStart(driver);
    const started = runtime.start();
    await flush();

    await runtime.abandon();
    await expect(started).rejects.toBeInstanceOf(ChatStartCancelledError);
    expect(pending.signal?.aborted).toBe(true);
    expect(onEnded).not.toHaveBeenCalled();
  });

  describe('live launch access for the helper ceiling (#2228)', () => {
    beforeEach(() => {
      agentRegistry.register('agent-1', { projectPath: '/repo', orchestrator: 'claude-code', runtime: 'chat' });
      agentRegistry.setLaunchCap('agent-1', { freeAgentMode: true, permissionMode: 'skip-all' });
    });
    afterEach(() => agentRegistry.untrack('agent-1'));

    it('records the level the driver reports', async () => {
      const driver = new FakeChatDriver();
      const { runtime } = makeRuntime(driver);
      await runtime.start();
      driver.last.emit({ type: 'mode_changed', data: { level: 'auto' } });
      await flush();
      expect(agentRegistry.get('agent-1')?.launchAccess).toMatchObject({ freeAgentMode: true, permissionMode: 'auto' });
      driver.last.emit({ type: 'mode_changed', data: { level: 'plan' } });
      await flush();
      expect(agentRegistry.get('agent-1')?.launchAccess?.freeAgentMode).toBe(false);
    });

    it('takes a lowered level before the driver answers, and a raise only after', async () => {
      const driver = new FakeChatDriver();
      const { runtime } = makeRuntime(driver);
      await runtime.start();
      let seen: unknown;
      const real = driver.last.setLevel.bind(driver.last);
      driver.last.setLevel = async (level) => { seen = agentRegistry.get('agent-1')?.launchAccess; await real(level); };
      await runtime.setLevel('ask');
      expect(seen).toMatchObject({ freeAgentMode: false, permissionMode: 'auto' });
      expect(agentRegistry.get('agent-1')?.launchAccess?.freeAgentMode).toBe(false);

      await runtime.setLevel('full_access');
      expect(seen).toMatchObject({ freeAgentMode: false, permissionMode: 'auto' });
      expect(agentRegistry.get('agent-1')?.launchAccess).toMatchObject({ freeAgentMode: true, permissionMode: 'skip-all' });
    });

    it('records the spawn level when a session opens, and again after /clear', async () => {
      const driver = new FakeChatDriver();
      const { runtime } = makeRuntime(driver);
      // Registered from spawn as bypass, but this runtime opens at ask.
      await runtime.start();
      expect(agentRegistry.get('agent-1')?.launchAccess?.freeAgentMode).toBe(false);
      await runtime.setLevel('full_access');
      expect(agentRegistry.get('agent-1')?.launchAccess).toMatchObject({ freeAgentMode: true, permissionMode: 'skip-all' });
      // The new session starts at the spawn level (ask), not full access.
      await runtime.clearContext();
      expect(agentRegistry.get('agent-1')?.launchAccess).toMatchObject({ freeAgentMode: false, permissionMode: 'auto' });
    });

    it('clamps a driver mode_changed above the user-set level', async () => {
      // Spawned at ask (standard).
      agentRegistry.register('agent-1', { projectPath: '/repo', orchestrator: 'claude-code', runtime: 'chat' });
      agentRegistry.setLaunchCap('agent-1', { freeAgentMode: false, permissionMode: 'auto' });
      const driver = new FakeChatDriver();
      const { runtime } = makeRuntime(driver);
      await runtime.start();
      const level = () => accessLevelOf(agentRegistry.get('agent-1')?.launchAccess);

      // The agent switches its own mode (ExitPlanMode, a native switch): no raise.
      driver.last.emit({ type: 'mode_changed', data: { level: 'full_access' } });
      await flush();
      expect(level()).toBe('standard');

      // The user raises to auto; a reported full access is held to auto.
      await runtime.setLevel('auto');
      expect(level()).toBe('auto');
      driver.last.emit({ type: 'mode_changed', data: { level: 'full_access' } });
      await flush();
      expect(level()).toBe('auto');

      // Only the user may go higher.
      await runtime.setLevel('full_access');
      expect(level()).toBe('bypass');

      // /clear forgets the user's level: back to the spawn cap.
      await runtime.clearContext();
      driver.last.emit({ type: 'mode_changed', data: { level: 'auto' } });
      await flush();
      expect(level()).toBe('standard');
    });

    it('keeps the old level when a raise fails', async () => {
      const driver = new FakeChatDriver();
      const { runtime } = makeRuntime(driver);
      await runtime.start();
      await runtime.setLevel('ask');
      driver.last.setLevel = async () => { throw new Error('refused'); };
      await expect(runtime.setLevel('full_access')).rejects.toThrow('refused');
      expect(agentRegistry.get('agent-1')?.launchAccess?.freeAgentMode).toBe(false);
    });
  });
});

describe('ChatAgentRuntime helper questions (#2366)', () => {
  const QUESTION = { requestId: 'q1', questions: [{ id: 'a', prompt: 'Which branch?', multiSelect: false, allowFreeText: true }] };

  it('keeps a question routed to the parent out of waiting_input and records where it went', async () => {
    const driver = new FakeChatDriver();
    const routeQuestion = vi.fn(async () => ({ agentId: 'orch', name: 'Orch' }));
    const { runtime } = makeRuntime(driver, { routeQuestion });
    await runtime.start();
    driver.last.emit({ type: 'turn_started', data: { trigger: 'prompt' } });
    driver.last.emit({ type: 'question', data: { ...QUESTION } });
    await flush();

    expect(routeQuestion).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'q1' }));
    const asked = transcript.find((e) => e.type === 'question');
    expect(asked?.type === 'question' && asked.data.routedTo).toEqual({ agentId: 'orch', name: 'Orch' });
    expect(runtime.getState()).toBe('running');
    expect(runtime.hasPendingQuestion('q1')).toBe(true);

    // The parent's answer goes through the usual path.
    await runtime.answerQuestion('q1', { a: 'main' });
    await flush();
    expect(driver.last.answers).toEqual([{ requestId: 'q1', answers: { a: 'main' } }]);
    expect(runtime.hasPendingQuestion('q1')).toBe(false);
  });

  it('asks the user when the question is not routed, or routing fails', async () => {
    for (const routeQuestion of [vi.fn(async () => null), vi.fn(async () => { throw new Error('boom'); })]) {
      transcript.length = 0;
      const driver = new FakeChatDriver();
      const { runtime } = makeRuntime(driver, { routeQuestion });
      await runtime.start();
      driver.last.emit({ type: 'turn_started', data: { trigger: 'prompt' } });
      driver.last.emit({ type: 'question', data: { ...QUESTION } });
      await flush();

      const asked = transcript.find((e) => e.type === 'question');
      expect(asked?.type === 'question' && asked.data.routedTo).toBeUndefined();
      expect(runtime.getState()).toBe('waiting_input');
    }
  });

  it('escalates a routed question to the user: a notice, the question again without routedTo, waiting_input', async () => {
    const driver = new FakeChatDriver();
    const { runtime } = makeRuntime(driver, { routeQuestion: async () => ({ agentId: 'orch', name: 'Orch' }) });
    await runtime.start();
    driver.last.emit({ type: 'turn_started', data: { trigger: 'prompt' } });
    driver.last.emit({ type: 'question', data: { ...QUESTION } });
    await flush();

    expect(await runtime.escalateQuestion('q1', 'Orch passed this question to you.')).toBe(true);
    await flush();
    expect(runtime.getState()).toBe('waiting_input');
    const notice = transcript.find((e) => e.type === 'notice');
    expect(notice?.type === 'notice' && notice.data.message).toBe('Orch passed this question to you.');
    const asked = transcript.filter((e) => e.type === 'question');
    expect(asked).toHaveLength(2);
    expect(asked[1].type === 'question' && asked[1].data.routedTo).toBeUndefined();
    expect(asked[1].turnId).toBe(asked[0].turnId);

    // Once it is the user's, it can't be escalated again; an unknown request never could.
    expect(await runtime.escalateQuestion('q1', 'Orch')).toBe(false);
    expect(await runtime.escalateQuestion('nope', 'Orch')).toBe(false);
  });

  it('stays out of waiting_input when the parent answers while the question is being routed', async () => {
    const driver = new FakeChatDriver();
    let runtimeRef!: ChatAgentRuntime;
    const routeQuestion = vi.fn(async () => {
      await runtimeRef.answerQuestion('q1', { a: 'main' });
      return { agentId: 'orch', name: 'Orch' };
    });
    const { runtime } = makeRuntime(driver, { routeQuestion });
    runtimeRef = runtime;
    await runtime.start();
    driver.last.emit({ type: 'turn_started', data: { trigger: 'prompt' } });
    driver.last.emit({ type: 'question', data: { ...QUESTION } });
    await flush();

    expect(driver.last.answers).toEqual([{ requestId: 'q1', answers: { a: 'main' } }]);
    expect(runtime.hasPendingQuestion('q1')).toBe(false);
    expect(runtime.getState()).toBe('running');
    expect(await runtime.escalateQuestion('q1', 'x')).toBe(false);
  });

  it('does not re-ask a question the user answered while it was being escalated', async () => {
    const driver = new FakeChatDriver();
    const { runtime } = makeRuntime(driver, { routeQuestion: async () => ({ agentId: 'orch', name: 'Orch' }) });
    await runtime.start();
    driver.last.emit({ type: 'turn_started', data: { trigger: 'prompt' } });
    driver.last.emit({ type: 'question', data: { ...QUESTION } });
    await flush();

    const escalating = runtime.escalateQuestion('q1', 'Orch passed this question to you.');
    await runtime.answerQuestion('q1', { a: 'main' });
    await escalating;
    await flush();
    expect(transcript.filter((e) => e.type === 'question')).toHaveLength(1);
    expect(runtime.getState()).not.toBe('waiting_input');
  });

  it('does not escalate a question the user already answered', async () => {
    const driver = new FakeChatDriver();
    const { runtime } = makeRuntime(driver, { routeQuestion: async () => ({ agentId: 'orch', name: 'Orch' }) });
    await runtime.start();
    driver.last.emit({ type: 'question', data: { ...QUESTION } });
    await flush();
    await runtime.answerQuestion('q1', { a: 'main' });

    expect(await runtime.escalateQuestion('q1', 'Orch')).toBe(false);
  });
});

describe('ChatAgentRuntime coalesced helper updates (#2414)', () => {
  async function midTurn(caps: ChatCapabilities, extra: Partial<ConstructorParameters<typeof ChatAgentRuntime>[0]> = {}) {
    const driver = new FakeChatDriver('copilot_sdk', 'copilot-cli', caps);
    const { runtime } = makeRuntime(driver, extra);
    await runtime.start();
    driver.last.emit({ type: 'turn_started', data: { trigger: 'prompt' } });
    await flush();
    return { driver, runtime };
  }

  function sentText(driver: FakeChatDriver): string[] {
    return driver.last.sent.map((s) => s.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n'));
  }

  it('keeps who sent a message on the event and off what the agent receives (#2599)', async () => {
    const { driver, runtime } = await midTurn(STEERLESS);
    const first = [{ sender: { agentId: 'a1', name: 'a' }, text: 'one' }];
    const second = [{ sender: { agentId: 'b1', name: 'b' }, text: 'two' }];
    await runtime.sendMessage('[FROM HELPER:a (a1)] one', { source: 'mcp', routed: first });
    await runtime.sendMessage('[FROM HELPER:b (b1)] two', { source: 'mcp', routed: second });

    const queued = transcript.filter((e) => e.type === 'user_message');
    expect(queued.map((e) => e.type === 'user_message' && e.data.routed)).toEqual([first, second]);

    driver.last.emit({ type: 'turn_ended', data: { stopReason: 'end_turn' } });
    await flush();
    expect(sentText(driver)).toEqual(['2 updates, oldest first:\n\n--- 1 of 2 ---\n[FROM HELPER:a (a1)] one\n\n--- 2 of 2 ---\n[FROM HELPER:b (b1)] two']);
    expect(driver.last.sent[0].content).toEqual([{ type: 'text', text: sentText(driver)[0] }]);
  });

  it('merges ten MCP messages queued mid-turn into one item, sent as one turn in order', async () => {
    const { driver, runtime } = await midTurn(STEERLESS);
    const results = [];
    for (let i = 1; i <= 10; i++) results.push(await runtime.sendMessage(`[FROM HELPER:h${i} (id-h${i})] update ${i}`, { source: 'mcp' }));

    const itemId = results[0].messageId;
    expect(results.every((r) => r.delivery === 'queued' && r.messageId === itemId)).toBe(true);
    const queued = transcript.filter((e) => e.type === 'user_message');
    expect(queued).toHaveLength(10);
    expect(queued.map((e) => e.type === 'user_message' && e.data.queuedWith)).toEqual([undefined, ...Array(9).fill(itemId)]);
    expect(new Set(queued.map((e) => e.type === 'user_message' && e.data.messageId)).size).toBe(10);

    driver.last.emit({ type: 'turn_ended', data: { stopReason: 'end_turn' } });
    await flush();
    expect(driver.last.sent).toHaveLength(1);
    const [text] = sentText(driver);
    expect(text.startsWith('10 updates, oldest first:')).toBe(true);
    const positions = Array.from({ length: 10 }, (_, i) => text.indexOf(`[FROM HELPER:h${i + 1} (id-h${i + 1})] update ${i + 1}`));
    expect(positions.every((p) => p > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);

    driver.last.emit({ type: 'turn_started', data: { trigger: 'prompt' } });
    driver.last.emit({ type: 'turn_ended', data: { stopReason: 'end_turn' } });
    await flush();
    expect(driver.last.sent).toHaveLength(1);
  });

  it('never merges a user message with MCP messages, and keeps the order', async () => {
    const { driver, runtime } = await midTurn(STEERLESS);
    await runtime.sendMessage('[Clubhouse] Helper "a" is ready.', { source: 'mcp' });
    await runtime.sendMessage('[FROM HELPER:a (a1)] started', { source: 'mcp' });
    await runtime.sendMessage('please also fix lint', { source: 'user' });
    await runtime.sendMessage('[FROM HELPER:b (b1)] done', { source: 'mcp' });
    await runtime.sendMessage('one more thing', { source: 'user' });

    for (let i = 0; i < 4; i++) {
      driver.last.emit({ type: 'turn_ended', data: { stopReason: 'end_turn' } });
      await flush();
      driver.last.emit({ type: 'turn_started', data: { trigger: 'prompt' } });
      await flush();
    }
    expect(sentText(driver)).toEqual([
      '2 updates, oldest first:\n\n--- 1 of 2 ---\n[Clubhouse] Helper "a" is ready.\n\n--- 2 of 2 ---\n[FROM HELPER:a (a1)] started',
      'please also fix lint',
      '[FROM HELPER:b (b1)] done',
      'one more thing',
    ]);
  });

  it('does not merge an MCP message into a queued user message', async () => {
    const { driver, runtime } = await midTurn(STEERLESS);
    const user = await runtime.sendMessage('user first', { source: 'user' });
    const mcp = await runtime.sendMessage('[FROM HELPER:a (a1)] hi', { source: 'mcp' });
    expect(mcp.messageId).not.toBe(user.messageId);
    expect(transcript.filter((e) => e.type === 'user_message' && e.data.queuedWith)).toHaveLength(0);
    driver.last.emit({ type: 'turn_ended', data: { stopReason: 'end_turn' } });
    await flush();
    expect(sentText(driver)).toEqual(['user first']);
  });

  it('sends the system prompt once, ahead of a merged first item', async () => {
    const { driver, runtime } = await midTurn({ ...STEERLESS, systemPrompt: false }, { systemPrompt: 'You are the PM.' });
    await runtime.sendMessage('[FROM HELPER:a (a1)] one', { source: 'mcp' });
    await runtime.sendMessage('[FROM HELPER:b (b1)] two', { source: 'mcp' });
    driver.last.emit({ type: 'turn_ended', data: { stopReason: 'end_turn' } });
    await flush();
    expect(driver.last.sent[0].content[0]).toEqual({ type: 'text', text: 'You are the PM.' });
    expect(driver.last.sent[0].content).toHaveLength(2);
    const userMessages = transcript.filter((e) => e.type === 'user_message');
    expect(JSON.stringify(userMessages)).not.toContain('You are the PM.');
  });

  it.each([
    ['Claude (steer, native queue)', { ...MINIMAL_CHAT_CAPABILITIES, steer: true, queue: 'native' as const }, 'steer'],
    ['Codex (steer)', { ...MINIMAL_CHAT_CAPABILITIES, steer: true }, 'steer'],
    ['native queue without steer', { ...MINIMAL_CHAT_CAPABILITIES, steer: false, queue: 'native' as const }, 'queued'],
  ])('%s: hands each MCP message to the driver, leaving batching to the delivery window', async (_name, caps, delivery) => {
    const { driver, runtime } = await midTurn(caps);
    await runtime.sendMessage('[FROM HELPER:a (a1)] one', { source: 'mcp' });
    await runtime.sendMessage('[FROM HELPER:b (b1)] two', { source: 'mcp' });
    expect(driver.last.sent.map((s) => s.delivery)).toEqual([delivery, delivery]);
    expect(transcript.filter((e) => e.type === 'user_message' && e.data.queuedWith)).toHaveLength(0);
  });

  it('queues a message sent while the queue drains, instead of racing the drained prompt', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { driver, runtime } = await midTurn(STEERLESS, { beforePrompt: () => gate });
    await runtime.sendMessage('typed by the user', { source: 'user' });
    driver.last.emit({ type: 'turn_ended', data: { stopReason: 'end_turn' } });
    await flush();
    expect(runtime.getState()).toBe('idle');
    const late = await runtime.sendMessage('[FROM HELPER:a (a1)] late', { source: 'mcp' });
    expect(late.delivery).toBe('queued');
    release();
    await flush();
    expect(sentText(driver)).toEqual(['typed by the user']);
    driver.last.emit({ type: 'turn_started', data: { trigger: 'prompt' } });
    driver.last.emit({ type: 'turn_ended', data: { stopReason: 'end_turn' } });
    await flush();
    expect(sentText(driver)).toEqual(['typed by the user', '[FROM HELPER:a (a1)] late']);
  });

  it('removes a merged item whole by its id, and later MCP messages start a new item (#2413)', async () => {
    const { driver, runtime } = await midTurn(STEERLESS);
    const first = await runtime.sendMessage('[FROM HELPER:a (a1)] one', { source: 'mcp' });
    await runtime.sendMessage('[FROM HELPER:b (b1)] two', { source: 'mcp' });
    await expect(runtime.removeQueued([first.messageId])).resolves.toEqual([first.messageId]);
    expect(transcript.filter((e) => e.type === 'queue_removed').at(-1)).toMatchObject({ type: 'queue_removed', data: { messageIds: [first.messageId] } });
    const next = await runtime.sendMessage('[FROM HELPER:c (c1)] three', { source: 'mcp' });
    expect(next.messageId).not.toBe(first.messageId);
    driver.last.emit({ type: 'turn_ended', data: { stopReason: 'end_turn' } });
    await flush();
    expect(sentText(driver)).toEqual(['[FROM HELPER:c (c1)] three']);
  });

  it('forgets a merged item when the context is cleared', async () => {
    const { driver, runtime } = await midTurn(STEERLESS);
    await runtime.sendMessage('[FROM HELPER:a (a1)] one', { source: 'mcp' });
    await runtime.clearContext();
    await flush();
    expect(runtime.getQueueState()).toEqual({ queuedMessageIds: [], queueStateSeq: 0, queueRemovalSupported: true });
    driver.last.emit({ type: 'turn_ended', data: { stopReason: 'end_turn' } });
    await flush();
    expect(driver.last.sent).toHaveLength(0);
  });

  it('does not deliver an old queued item into a replacement session during a prompt hook', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { driver, runtime } = await midTurn(STEERLESS, { beforePrompt: () => gate });
    await runtime.sendMessage('old session only', { source: 'user' });
    driver.last.emit({ type: 'turn_ended', data: { stopReason: 'end_turn' } });
    await flush();
    const oldSessionId = runtime.getSessionId();
    await runtime.clearContext();
    release();
    await flush();
    expect(runtime.getSessionId()).not.toBe(oldSessionId);
    expect(runtime.getQueueState()).toEqual({ queuedMessageIds: [], queueStateSeq: 0, queueRemovalSupported: true });
    expect(driver.last.sent).toHaveLength(0);
    expect(transcript.some((e) => e.sessionId === runtime.getSessionId() && e.type === 'queue_state')).toBe(false);
  });
});

describe('Annex request to asynchronous chat trace', () => {
  it('retains a queued request context without storing it in the transcript or leaking to the next turn', async () => {
    const { createLocalRecorder } = await import('../../telemetry/local-recorder');
    const { createScrubber } = await import('../../telemetry/scrubber');
    const { setLocalSink, tel, withRemoteParent } = await import('../../telemetry/facade');
    const { chatEventTraceparent } = await import('../../telemetry/chat-trace-context');
    const rec = createLocalRecorder({ dir: '/unused', fileBase: 'trace', level: 'standard', hashSalt: Buffer.alloc(32),
      scrub: createScrubber({}), session: { appVersion: '1.0.0', platform: 'linux', arch: 'x64' },
      mkdir: async () => {}, appendFile: async () => {} });
    setLocalSink(rec);
    const driver = new FakeChatDriver('claude_stream_json', 'claude-code', STEERLESS);
    const { runtime } = makeRuntime(driver);
    const tc = '00-abcdef0123456789abcdef0123456789-abcdef0123456789-01';
    const seen: Array<{ type: string; tc?: string }> = [];
    onChatEvent((e) => seen.push({ type: e.type, tc: chatEventTraceparent(e) }));
    try {
      await runtime.start();
      driver.last.emit({ type: 'turn_started', data: { trigger: 'prompt' } }); await flush();
      await withRemoteParent(tc, () => tel.flow('clubhouse.annex.rest', {}, () =>
        runtime.sendMessage('private prompt', { source: 'annex', delivery: 'queued' })), true);
      driver.last.emit({ type: 'turn_ended', data: { stopReason: 'end_turn' } }); await flush();
      driver.last.emit({ type: 'turn_started', data: { trigger: 'queued' } });
      driver.last.emit({ type: 'agent_message', data: { messageId: 'm1', text: 'private answer' } });
      driver.last.emit({ type: 'turn_ended', data: { stopReason: 'end_turn' } }); await flush();
      expect(seen.find((e) => e.type === 'agent_message')?.tc?.slice(3, 35)).toBe(tc.slice(3, 35));
      expect(JSON.stringify(transcript)).not.toContain(tc.slice(3, 35));
      driver.last.emit({ type: 'turn_started', data: { trigger: 'system' } });
      driver.last.emit({ type: 'agent_message', data: { messageId: 'm2', text: 'later' } }); await flush();
      expect(seen.filter((e) => e.type === 'agent_message').at(-1)?.tc).toBeUndefined();
    } finally { await runtime.stop(); setLocalSink(null); await rec.stop(); }
  });
});

describe('ambiguous provider turn attribution', () => {
  it.each(['native-queue', 'overlap'])('does not guess the causal request for %s dispatch', async (mode) => {
    const { createLocalRecorder } = await import('../../telemetry/local-recorder');
    const { createScrubber } = await import('../../telemetry/scrubber');
    const { setLocalSink, tel, withRemoteParent } = await import('../../telemetry/facade');
    const { chatEventTraceparent } = await import('../../telemetry/chat-trace-context');
    const rec = createLocalRecorder({ dir: '/unused', fileBase: 'ambiguous', level: 'standard', hashSalt: Buffer.alloc(32),
      scrub: createScrubber({}), session: { appVersion: '1.0.0', platform: 'linux', arch: 'x64' },
      mkdir: async () => {}, appendFile: async () => {} });
    setLocalSink(rec);
    const driver = new FakeChatDriver();
    const { runtime } = makeRuntime(driver);
    const contexts: Array<string | undefined> = [];
    onChatEvent((event) => { if (event.type === 'agent_message') contexts.push(chatEventTraceparent(event)); });
    try {
      await runtime.start();
      if (mode === 'native-queue') driver.last.send = async () => 'queued';
      const send = (parent: string) => withRemoteParent(parent, () => tel.flow('clubhouse.annex.rest', {}, () =>
        runtime.sendMessage('private prompt', { source: 'annex', delivery: 'prompt' })), true);
      await send('00-0123456789abcdef0123456789abcdef-0123456789abcdef-01');
      if (mode === 'overlap') await send('00-abcdef0123456789abcdef0123456789-abcdef0123456789-01');
      driver.last.emit({ type: 'turn_started', data: { trigger: mode === 'native-queue' ? 'queued' : 'prompt' } });
      driver.last.emit({ type: 'agent_message', data: { messageId: 'm', text: 'result' } });
      await flush();
      expect(contexts).toEqual([undefined]);
    } finally { await runtime.stop(); setLocalSink(null); await rec.stop(); }
  });
});
