import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChatEvent, ChatCapabilities } from '../../../shared/chat';
import { MINIMAL_CHAT_CAPABILITIES } from '../../../shared/chat';

const transcript: ChatEvent[] = [];
vi.mock('./chat-transcript', () => ({
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

import { ChatAgentRuntime } from './chat-runtime';
import { FakeChatDriver } from './fake-chat-driver';
import { onChatEvent, removeAllChatEventListeners } from './chat-event-bus';
import * as permissionQueue from '../annex-permission-queue';

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
  vi.useRealTimers();
});

describe('ChatAgentRuntime', () => {
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
    const driver = new FakeChatDriver('copilot_acp', 'copilot-cli', STEERLESS);
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

  it('interrupts the turn when supported, and stops when not', async () => {
    const steering = new FakeChatDriver();
    const a = makeRuntime(steering);
    await a.runtime.start();
    await a.runtime.interrupt();
    expect(steering.last.interrupts).toBe(1);
    expect(a.runtime.isRunning()).toBe(true);

    transcript.length = 0;
    const plain = new FakeChatDriver('copilot_acp', 'copilot-cli', { ...STEERLESS, interrupt: false });
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
    expect(runtime.isRunning()).toBe(true);
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

  it('prepends the system prompt once when the driver cannot pass it', async () => {
    const driver = new FakeChatDriver('copilot_acp', 'copilot-cli', { ...STEERLESS, systemPrompt: false });
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

  it('closes the CLI when handling an event throws', async () => {
    const driver = new FakeChatDriver('copilot_acp', 'copilot-cli', STEERLESS);
    const { runtime, onEnded } = makeRuntime(driver);
    await runtime.start();
    driver.last.emit({ type: 'turn_started', data: { trigger: 'prompt' } });
    await flush();
    await runtime.sendMessage('queued one', { source: 'user' });
    driver.last.send = async () => { throw new Error('pipe broke'); };
    driver.last.emit({ type: 'turn_ended', data: { stopReason: 'end_turn' } });
    await flush();
    expect(driver.last.closed).toBe(true);
    expect(onEnded).toHaveBeenCalledWith('process_exit', 0);
    expect(transcript.some((e) => e.type === 'error' && e.data.code === 'driver_stream_failed')).toBe(true);
  });

  it('abandons silently after a failed start', async () => {
    const driver = new FakeChatDriver();
    const { runtime, onEnded } = makeRuntime(driver);
    await runtime.start();
    await runtime.abandon();
    await flush();
    expect(driver.last.closed).toBe(true);
    expect(onEnded).not.toHaveBeenCalled();
    expect(types()).not.toContain('session_ended');
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
