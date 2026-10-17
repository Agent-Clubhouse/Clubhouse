import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatEvent, ChatEventDataMap, ChatEventType } from '../../shared/chat';
import { MINIMAL_CHAT_CAPABILITIES } from '../../shared/chat';
import {
  createChatViewState,
  foldChatEvents,
  initChatEventListener,
  reduceChatEvent,
  useChatStore,
  type AgentMessageItem,
  type ChatViewState,
  type ThoughtItem,
  type ToolCallItem,
  type UserMessageItem,
} from './chatStore';

const AGENT = 'agent-1';

/** Builds events with an auto-incrementing seq per session. */
function makeEmitter(agentId = AGENT) {
  const seqs: Record<string, number> = {};
  return function ev<T extends ChatEventType>(
    type: T,
    data: ChatEventDataMap[T],
    opts: { sessionId?: string; turnId?: string; seq?: number } = {},
  ): ChatEvent {
    const sessionId = opts.sessionId ?? 's1';
    const seq = opts.seq ?? (seqs[sessionId] = (seqs[sessionId] ?? 0) + 1);
    return {
      v: 2, agentId, sessionId, seq, ts: 1000 + seq, type, data,
      ...(opts.turnId && { turnId: opts.turnId }),
    } as ChatEvent;
  };
}

function sessionStarted(ev: ReturnType<typeof makeEmitter>, sessionId = 's1', overrides: Partial<ChatEventDataMap['session_started']> = {}) {
  return ev('session_started', {
    driver: 'claude_agent_sdk',
    provider: 'claude-code',
    cwd: '/project',
    resumed: false,
    capabilities: MINIMAL_CHAT_CAPABILITIES,
    ...overrides,
  }, { sessionId });
}

function fold(events: ChatEvent[], initial?: ChatViewState): ChatViewState {
  return foldChatEvents(initial, AGENT, events);
}

function text(t: string) {
  return [{ type: 'text' as const, text: t }];
}

describe('reduceChatEvent', () => {
  let ev: ReturnType<typeof makeEmitter>;
  beforeEach(() => { ev = makeEmitter(); });

  it('records session metadata from session_started', () => {
    const s = fold([sessionStarted(ev, 's1', { nativeSessionId: 'native-1', model: 'opus', level: 'ask' })]);
    expect(s.sessionId).toBe('s1');
    expect(s.driver).toBe('claude_agent_sdk');
    expect(s.provider).toBe('claude-code');
    expect(s.nativeSessionId).toBe('native-1');
    expect(s.model).toBe('opus');
    expect(s.level).toBe('ask');
    expect(s.capabilities).toEqual(MINIMAL_CHAT_CAPABILITIES);
    expect(s.state).toBe('idle');
    expect(s.lastSeq).toEqual({ s1: 1 });
    // No divider for the first session.
    expect(s.items).toEqual([]);
  });

  it('accumulates agent_message_chunk by messageId and replaces with agent_message', () => {
    let s = fold([
      sessionStarted(ev),
      ev('agent_message_chunk', { messageId: 'm1', text: 'Hel' }, { turnId: 't1' }),
      ev('agent_message_chunk', { messageId: 'm1', text: 'lo' }, { turnId: 't1' }),
    ]);
    expect(s.items).toHaveLength(1);
    let msg = s.items[0] as AgentMessageItem;
    expect(msg.kind).toBe('agent_message');
    expect(msg.text).toBe('Hello');
    expect(msg.streaming).toBe(true);
    expect(msg.turnId).toBe('t1');

    s = fold([ev('agent_message', { messageId: 'm1', text: 'Hello, world' }, { turnId: 't1' })], s);
    expect(s.items).toHaveLength(1);
    msg = s.items[0] as AgentMessageItem;
    expect(msg.text).toBe('Hello, world');
    expect(msg.streaming).toBe(false);
  });

  it('keeps separate messages for separate messageIds', () => {
    const s = fold([
      sessionStarted(ev),
      ev('agent_message_chunk', { messageId: 'm1', text: 'a' }),
      ev('agent_message_chunk', { messageId: 'm2', text: 'b' }),
      ev('agent_message_chunk', { messageId: 'm1', text: 'c' }),
    ]);
    expect(s.items.map((i) => (i as AgentMessageItem).text)).toEqual(['ac', 'b']);
  });

  it('keeps subagentId on agent messages and thoughts', () => {
    const s = fold([
      sessionStarted(ev),
      ev('agent_message_chunk', { messageId: 'm1', text: 'x', subagentId: 'sub1' }),
      ev('agent_thought', { messageId: 'th1', text: 'y', subagentId: 'sub1' }),
    ]);
    expect((s.items[0] as AgentMessageItem).subagentId).toBe('sub1');
    expect((s.items[1] as ThoughtItem).subagentId).toBe('sub1');
  });

  it('merges session_info into the session record', () => {
    let s = fold([sessionStarted(ev, 's1', { cliVersion: '2.0.0' })]);
    expect(s.cliVersion).toBe('2.0.0');
    expect(s.nativeSessionId).toBeNull();
    s = fold([
      ev('session_info', { nativeSessionId: 'native-9', model: 'opus', capabilities: { steer: true, questions: true } }),
    ], s);
    expect(s.nativeSessionId).toBe('native-9');
    expect(s.model).toBe('opus');
    expect(s.capabilities?.steer).toBe(true);
    expect(s.capabilities?.questions).toBe(true);
    // Untouched capability fields keep their session_started values.
    expect(s.capabilities?.queue).toBe(MINIMAL_CHAT_CAPABILITIES.queue);
    expect(s.cliVersion).toBe('2.0.0');
  });

  it('accumulates thoughts the same way and keeps durationMs', () => {
    const s = fold([
      sessionStarted(ev),
      ev('agent_thought_chunk', { messageId: 'th1', text: 'think' }),
      ev('agent_thought_chunk', { messageId: 'th1', text: 'ing' }),
    ]);
    expect((s.items[0] as ThoughtItem).text).toBe('thinking');
    const done = fold([ev('agent_thought', { messageId: 'th1', text: 'thought', durationMs: 1200 })], s);
    const thought = done.items[0] as ThoughtItem;
    expect(thought.kind).toBe('thought');
    expect(thought.text).toBe('thought');
    expect(thought.streaming).toBe(false);
    expect(thought.durationMs).toBe(1200);
  });

  it('stops streaming items when the turn ends', () => {
    const s = fold([
      sessionStarted(ev),
      ev('turn_started', { trigger: 'prompt' }, { turnId: 't1' }),
      ev('agent_message_chunk', { messageId: 'm1', text: 'partial' }, { turnId: 't1' }),
      ev('turn_ended', { stopReason: 'cancelled' }, { turnId: 't1' }),
    ]);
    expect((s.items[0] as AgentMessageItem).streaming).toBe(false);
    expect(s.turnId).toBeNull();
    expect(s.state).toBe('idle');
  });

  describe('tool calls', () => {
    function withTool() {
      return fold([
        sessionStarted(ev),
        ev('tool_call', {
          toolCallId: 'tc1', kind: 'execute', title: 'Run tests', status: 'pending', toolName: 'Bash',
          content: [{ type: 'terminal', output: 'line1\n' }], subagentId: 'sub1',
        }),
      ]);
    }

    it('creates a tool call item and keeps subagentId', () => {
      const tool = withTool().items[0] as ToolCallItem;
      expect(tool.kind).toBe('tool_call');
      expect(tool.toolKind).toBe('execute');
      expect(tool.toolName).toBe('Bash');
      expect(tool.subagentId).toBe('sub1');
      expect(tool.content).toHaveLength(1);
    });

    it('appends content when contentMode is append', () => {
      const base = withTool();
      const s = fold([
        ev('tool_call_update', {
          toolCallId: 'tc1', status: 'in_progress', contentMode: 'append',
          content: [{ type: 'terminal', output: 'line2\n' }],
        }),
      ], base);
      const tool = s.items[0] as ToolCallItem;
      expect(tool.status).toBe('in_progress');
      expect(tool.content).toEqual([
        { type: 'terminal', output: 'line1\n' },
        { type: 'terminal', output: 'line2\n' },
      ]);
      expect(tool.subagentId).toBe('sub1');
    });

    it('replaces content by default and merges status/title/error/duration', () => {
      const base = withTool();
      const s = fold([
        ev('tool_call_update', {
          toolCallId: 'tc1', status: 'failed', title: 'Run tests (failed)', error: 'exit 1', durationMs: 50,
          content: [{ type: 'text', text: 'boom' }],
        }),
      ], base);
      const tool = s.items[0] as ToolCallItem;
      expect(tool.status).toBe('failed');
      expect(tool.title).toBe('Run tests (failed)');
      expect(tool.error).toBe('exit 1');
      expect(tool.durationMs).toBe(50);
      expect(tool.content).toEqual([{ type: 'text', text: 'boom' }]);
    });

    it('leaves content alone when an update carries none', () => {
      const base = withTool();
      const s = fold([ev('tool_call_update', { toolCallId: 'tc1', status: 'completed' })], base);
      const tool = s.items[0] as ToolCallItem;
      expect(tool.status).toBe('completed');
      expect(tool.content).toHaveLength(1);
    });

    it('creates a placeholder for an update to an unseen tool call', () => {
      const s = fold([sessionStarted(ev), ev('tool_call_update', { toolCallId: 'tcX', status: 'completed' })]);
      const tool = s.items[0] as ToolCallItem;
      expect(tool.toolCallId).toBe('tcX');
      expect(tool.toolKind).toBe('other');
      expect(tool.status).toBe('completed');
    });
  });

  it('tracks the permission lifecycle', () => {
    let s = fold([
      sessionStarted(ev),
      ev('permission_request', {
        requestId: 'p1', title: 'Run npm install?', toolCallId: 'tc1',
        options: [{ optionId: 'a', kind: 'allow_once', label: 'Allow' }, { optionId: 'r', kind: 'reject_once', label: 'Deny' }],
      }, { turnId: 't1' }),
      ev('permission_request', { requestId: 'p2', title: 'Edit file?', options: [] }, { turnId: 't1' }),
    ]);
    expect(s.pendingPermissions.map((p) => p.requestId)).toEqual(['p1', 'p2']);
    expect(s.pendingPermissions[0].turnId).toBe('t1');
    expect(s.pendingPermissions[0].options).toHaveLength(2);

    s = fold([ev('permission_resolved', { requestId: 'p1', optionId: 'a', decision: 'allow', by: 'user' })], s);
    expect(s.pendingPermissions.map((p) => p.requestId)).toEqual(['p2']);
  });

  it('tracks pending questions', () => {
    let s = fold([
      sessionStarted(ev),
      ev('question', {
        requestId: 'q1',
        toolCallId: 'tc1',
        questions: [
          { id: 'db', prompt: 'Which DB?', allowFreeText: true, options: [{ id: 'pg', label: 'Postgres' }] },
          { id: 'extras', prompt: 'Extras?', allowFreeText: false, multiSelect: true, options: [{ id: 'redis', label: 'Redis' }] },
        ],
      }, { turnId: 't1' }),
    ]);
    expect(s.pendingQuestions).toHaveLength(1);
    expect(s.pendingQuestions[0].questions.map((q) => q.id)).toEqual(['db', 'extras']);
    expect(s.pendingQuestions[0].turnId).toBe('t1');
    s = fold([ev('question_resolved', { requestId: 'q1', answers: { db: 'pg', extras: ['redis'] } })], s);
    expect(s.pendingQuestions).toEqual([]);
  });

  it('ignores events with seq at or below the last seen seq for that session', () => {
    const e1 = sessionStarted(ev);
    const e2 = ev('agent_message_chunk', { messageId: 'm1', text: 'a' });
    const s1 = fold([e1, e2]);
    const s2 = reduceChatEvent(s1, e2);
    expect(s2).toBe(s1);
    const s3 = reduceChatEvent(s1, { ...e2, seq: 1 } as ChatEvent);
    expect(s3).toBe(s1);
    expect((s1.items[0] as AgentMessageItem).text).toBe('a');
  });

  it('appends a session divider on a new session id without wiping history', () => {
    let s = fold([
      sessionStarted(ev, 's1'),
      ev('user_message', { messageId: 'u1', content: text('hi'), source: 'user', delivery: 'prompt' }, { sessionId: 's1' }),
      ev('plan', { entries: [{ content: 'step', status: 'pending' }] }, { sessionId: 's1' }),
      ev('permission_request', { requestId: 'p1', title: 'x', options: [] }, { sessionId: 's1' }),
    ]);
    s = fold([
      ev('notice', { level: 'info', code: 'context_cleared', message: 'Started a new conversation.' }, { sessionId: 's2' }),
      sessionStarted(ev, 's2'),
    ], s);
    expect(s.sessionId).toBe('s2');
    expect(s.items.map((i) => i.kind)).toEqual(['user_message', 'session_divider', 'notice']);
    const divider = s.items[1];
    expect(divider.kind === 'session_divider' && divider.previousSessionId).toBe('s1');
    // Session-scoped state is reset for the new conversation.
    expect(s.plan).toEqual([]);
    expect(s.pendingPermissions).toEqual([]);
    expect(s.lastSeq).toEqual({ s1: 4, s2: 2 });
    // Only one divider even though two s2 events arrived.
    expect(s.items.filter((i) => i.kind === 'session_divider')).toHaveLength(1);
  });

  it('does not add a divider when session_started repeats the same session id (resume)', () => {
    const s = fold([
      sessionStarted(ev, 's1'),
      ev('session_ended', { reason: 'idle_timeout' }),
      sessionStarted(ev, 's1', { resumed: true }),
    ]);
    expect(s.items.filter((i) => i.kind === 'session_divider')).toHaveLength(0);
    expect(s.state).toBe('idle');
  });

  describe('queued messages', () => {
    it('holds queued messages out of the timeline and delivers the oldest on turn_started', () => {
      let s = fold([
        sessionStarted(ev),
        ev('turn_started', { trigger: 'prompt' }, { turnId: 't1' }),
        ev('user_message', { messageId: 'q1', content: text('first'), source: 'user', delivery: 'queued' }, { turnId: 't1' }),
        ev('user_message', { messageId: 'q2', content: text('second'), source: 'mcp', delivery: 'queued' }, { turnId: 't1' }),
      ]);
      expect(s.queued.map((q) => q.text)).toEqual(['first', 'second']);
      expect(s.items.filter((i) => i.kind === 'user_message')).toHaveLength(0);

      s = fold([
        ev('turn_ended', { stopReason: 'end_turn' }, { turnId: 't1' }),
        ev('turn_started', { trigger: 'queued' }, { turnId: 't2' }),
      ], s);
      expect(s.queued.map((q) => q.text)).toEqual(['second']);
      const delivered = s.items.filter((i): i is UserMessageItem => i.kind === 'user_message');
      expect(delivered).toHaveLength(1);
      expect(delivered[0].text).toBe('first');
      expect(delivered[0].delivery).toBe('queued');
      expect(delivered[0].turnId).toBe('t2');
    });

    it('clears a queued entry when the same text is later delivered', () => {
      const s = fold([
        sessionStarted(ev),
        ev('user_message', { messageId: 'q1', content: text('do it'), source: 'user', delivery: 'queued' }),
        ev('user_message', { messageId: 'u2', content: text('do it'), source: 'user', delivery: 'prompt' }),
      ]);
      expect(s.queued).toEqual([]);
      const users = s.items.filter((i): i is UserMessageItem => i.kind === 'user_message');
      expect(users).toHaveLength(1);
      expect(users[0].delivery).toBe('prompt');
    });

    it('records user message source and delivery', () => {
      const s = fold([
        sessionStarted(ev),
        ev('user_message', { messageId: 'u1', content: text('from peer'), source: 'shoulder_tap', delivery: 'steer' }),
      ]);
      const msg = s.items[0] as UserMessageItem;
      expect(msg.source).toBe('shoulder_tap');
      expect(msg.delivery).toBe('steer');
      expect(msg.text).toBe('from peer');
    });
  });

  it('tracks usage per turn and session, with limits and context', () => {
    let s = fold([
      sessionStarted(ev),
      ev('usage', { scope: 'turn', tokens: { input: 10, output: 5 }, costUsd: 0.01, costIsEstimate: true }),
      ev('usage', { scope: 'session', tokens: { total: 100 }, costUsd: 0.5, context: { used: 2000, size: 200000 } }),
      ev('usage', { scope: 'session', limits: [{ window: '5h', utilization: 0.4 }, { window: 'week', status: 'warning' }] }),
    ]);
    expect(s.usage.turn).toEqual({ tokens: { input: 10, output: 5 }, costUsd: 0.01, costIsEstimate: true });
    expect(s.usage.session).toEqual({ tokens: { total: 100 }, costUsd: 0.5 });
    expect(s.usage.context).toEqual({ used: 2000, size: 200000 });
    expect(s.usage.limits).toEqual([{ window: '5h', utilization: 0.4 }, { window: 'week', status: 'warning' }]);

    s = fold([ev('turn_ended', { stopReason: 'end_turn', usage: { output: 42 }, costUsd: 0.02 })], s);
    expect(s.usage.turn).toEqual({ tokens: { output: 42 }, costUsd: 0.02 });

    // Limits are account-wide and survive a new session; context does not.
    s = fold([sessionStarted(ev, 's2')], s);
    expect(s.usage.limits).toHaveLength(2);
    expect(s.usage.context).toBeNull();
    expect(s.usage.session).toBeNull();
  });

  it('tracks plan, plan documents, subagents, commands, level and model', () => {
    let s = fold([
      sessionStarted(ev),
      ev('plan', { entries: [{ content: 'a', status: 'pending' }, { content: 'b', status: 'pending' }] }),
      ev('plan', { entries: [{ content: 'a', status: 'completed' }] }),
      ev('plan_document', { planId: 'pl1', markdown: '# Plan', status: 'streaming' }),
      ev('plan_document', { planId: 'pl1', markdown: '# Plan\n- step', status: 'ready', toolCallId: 'tc9' }),
      ev('subagent', { subagentId: 'sub1', name: 'explorer', status: 'running' }),
      ev('subagent', { subagentId: 'sub1', name: 'explorer', status: 'completed', toolCount: 3 }),
      ev('commands_available', { commands: [{ name: 'compact' }] }),
      ev('mode_changed', { level: 'auto_edit' }),
      ev('model_changed', { modelId: 'sonnet', effort: 'high' }),
    ]);
    expect(s.plan).toEqual([{ content: 'a', status: 'completed' }]);
    const docs = s.items.filter((i) => i.kind === 'plan_document');
    expect(docs).toHaveLength(1);
    expect(docs[0].kind === 'plan_document' && docs[0].status).toBe('ready');
    expect(docs[0].kind === 'plan_document' && docs[0].toolCallId).toBe('tc9');
    expect(s.subagents.sub1.status).toBe('completed');
    expect(s.subagents.sub1.toolCount).toBe(3);
    expect(s.commands).toEqual([{ name: 'compact' }]);
    expect(s.level).toBe('auto_edit');
    expect(s.model).toBe('sonnet');
    expect(s.effort).toBe('high');

    s = fold([ev('model_changed', { modelId: 'opus' })], s);
    expect(s.effort).toBeNull();
  });

  it('adds notice and error items and follows session_state', () => {
    const s = fold([
      sessionStarted(ev),
      ev('session_state', { state: 'waiting_permission' }),
      ev('notice', { level: 'warn', code: 'untested_cli_version', message: 'Untested CLI' }),
      ev('error', { code: 'rate_limited', message: 'slow down', fatal: false, willRetry: true }),
    ]);
    expect(s.state).toBe('waiting_permission');
    expect(s.items.map((i) => i.kind)).toEqual(['notice', 'error']);
    const err = s.items[1];
    expect(err.kind === 'error' && err.willRetry).toBe(true);
  });

  it('ignores unknown event types but advances seq', () => {
    const s1 = fold([sessionStarted(ev)]);
    const unknown = { v: 2, agentId: AGENT, sessionId: 's1', seq: 2, ts: 1, type: 'future_thing', data: {} } as unknown as ChatEvent;
    const s2 = reduceChatEvent(s1, unknown);
    expect(s2.items).toEqual(s1.items);
    expect(s2.lastSeq.s1).toBe(2);
  });

  it('creates state for an unseen agent', () => {
    const s = reduceChatEvent(undefined, sessionStarted(ev));
    expect(s.agentId).toBe(AGENT);
    expect(createChatViewState('x').items).toEqual([]);
  });
});

describe('useChatStore', () => {
  let ev: ReturnType<typeof makeEmitter>;

  beforeEach(() => {
    ev = makeEmitter();
    useChatStore.setState({ agents: {}, loading: {} });
    window.clubhouse.chat.readTranscript = vi.fn().mockResolvedValue([]);
  });

  it('applyEvent folds live events per agent', () => {
    useChatStore.getState().applyEvent(sessionStarted(ev));
    useChatStore.getState().applyEvent(ev('agent_message_chunk', { messageId: 'm1', text: 'hi' }));
    const other = makeEmitter('agent-2');
    useChatStore.getState().applyEvent(sessionStarted(other));
    const { agents } = useChatStore.getState();
    expect(agents[AGENT].items).toHaveLength(1);
    expect(agents['agent-2'].items).toHaveLength(0);
  });

  it('loadTranscript folds the transcript and merges live events that arrive mid-load', async () => {
    const e1 = sessionStarted(ev);
    const e2 = ev('agent_message_chunk', { messageId: 'm1', text: 'Hel' });
    const e3 = ev('agent_message_chunk', { messageId: 'm1', text: 'lo' });
    const e4 = ev('agent_message', { messageId: 'm1', text: 'Hello!' });

    let resolveTranscript!: (events: ChatEvent[]) => void;
    window.clubhouse.chat.readTranscript = vi.fn(
      () => new Promise<ChatEvent[]>((resolve) => { resolveTranscript = resolve; }),
    );

    const loading = useChatStore.getState().loadTranscript(AGENT, 500);
    expect(window.clubhouse.chat.readTranscript).toHaveBeenCalledWith(AGENT, 500);
    expect(useChatStore.getState().loading[AGENT]).toBe(true);

    // Live events overlap the transcript (e3) and extend it (e4).
    useChatStore.getState().applyEvent(e3);
    useChatStore.getState().applyEvent(e4);
    resolveTranscript([e1, e2, e3]);
    await loading;

    const state = useChatStore.getState().agents[AGENT];
    expect(useChatStore.getState().loading[AGENT]).toBeUndefined();
    expect(state.items).toHaveLength(1);
    const msg = state.items[0] as AgentMessageItem;
    expect(msg.text).toBe('Hello!');
    expect(msg.streaming).toBe(false);
    expect(state.lastSeq.s1).toBe(4);

    // After load, a replayed event is ignored.
    useChatStore.getState().applyEvent(e2);
    expect(useChatStore.getState().agents[AGENT]).toBe(state);
  });

  it('loadTranscript treats a failed read as empty', async () => {
    window.clubhouse.chat.readTranscript = vi.fn().mockRejectedValue(new Error('nope'));
    await useChatStore.getState().loadTranscript(AGENT);
    expect(useChatStore.getState().agents[AGENT].items).toEqual([]);
  });

  it('reset drops an agent', () => {
    useChatStore.getState().applyEvent(sessionStarted(ev));
    useChatStore.getState().reset(AGENT);
    expect(useChatStore.getState().agents[AGENT]).toBeUndefined();
  });

  it('action wrappers call the chat bridge', async () => {
    const chat = window.clubhouse.chat;
    chat.sendMessage = vi.fn().mockResolvedValue({ delivery: 'queued', messageId: 'm' });
    chat.interrupt = vi.fn().mockResolvedValue(undefined);
    chat.respondPermission = vi.fn().mockResolvedValue(undefined);
    chat.answerQuestion = vi.fn().mockResolvedValue(undefined);
    chat.setLevel = vi.fn().mockResolvedValue(undefined);
    chat.setModel = vi.fn().mockResolvedValue(undefined);

    const store = useChatStore.getState();
    await expect(store.send(AGENT, 'hi', 'auto')).resolves.toEqual({ delivery: 'queued', messageId: 'm' });
    await store.interrupt(AGENT);
    await store.respondPermission(AGENT, 'p1', 'a', { message: 'go ahead' });
    await store.answerQuestion(AGENT, 'q1', { db: 'pg' });
    await store.setLevel(AGENT, 'plan');
    await store.setModel(AGENT, 'opus', 'high');

    expect(chat.sendMessage).toHaveBeenCalledWith(AGENT, 'hi', 'auto');
    expect(chat.interrupt).toHaveBeenCalledWith(AGENT);
    expect(chat.respondPermission).toHaveBeenCalledWith(AGENT, 'p1', 'a', { message: 'go ahead' });
    expect(chat.answerQuestion).toHaveBeenCalledWith(AGENT, 'q1', { db: 'pg' });
    expect(chat.setLevel).toHaveBeenCalledWith(AGENT, 'plan');
    expect(chat.setModel).toHaveBeenCalledWith(AGENT, 'opus', 'high');
  });

  it('initChatEventListener applies bridged events and returns the unsubscribe', () => {
    let listener: ((e: ChatEvent) => void) | undefined;
    const unsubscribe = vi.fn();
    window.clubhouse.chat.onEvent = vi.fn((cb: (e: ChatEvent) => void) => { listener = cb; return unsubscribe; });

    const stop = initChatEventListener();
    listener!(sessionStarted(ev));
    expect(useChatStore.getState().agents[AGENT].sessionId).toBe('s1');
    stop();
    expect(unsubscribe).toHaveBeenCalled();
  });
});

describe('reduceChatEvent: turn footers and diagnostics', () => {
  let ev: ReturnType<typeof makeEmitter>;
  beforeEach(() => { ev = makeEmitter(); });

  it('closes each turn with a turn_end item and times it from turn_started', () => {
    const s = fold([
      sessionStarted(ev),
      ev('turn_started', { trigger: 'prompt' }, { turnId: 't1' }),
      ev('turn_ended', { stopReason: 'end_turn', usage: { input: 10, output: 5 }, costUsd: 0.01 }, { turnId: 't1', seq: 10 }),
    ]);
    const end = s.items[s.items.length - 1];
    expect(end).toMatchObject({ kind: 'turn_end', stopReason: 'end_turn', usage: { input: 10, output: 5 }, costUsd: 0.01, turnId: 't1' });
    // ts is 1000 + seq: turn_started at seq 2, turn_ended at seq 10.
    expect(end.kind === 'turn_end' && end.durationMs).toBe(8);
    expect(s.turnStartedAt).toBeNull();
  });

  it('prefers the reported duration and falls back to the turn usage event', () => {
    const s = fold([
      sessionStarted(ev),
      ev('turn_started', { trigger: 'prompt' }, { turnId: 't1' }),
      ev('usage', { scope: 'turn', tokens: { input: 7 }, costUsd: 0.2, costIsEstimate: true }, { turnId: 't1' }),
      ev('turn_ended', { stopReason: 'error', durationMs: 1234 }, { turnId: 't1' }),
    ]);
    expect(s.items[s.items.length - 1]).toMatchObject({ kind: 'turn_end', stopReason: 'error', durationMs: 1234, usage: { input: 7 }, costUsd: 0.2, costIsEstimate: true });
  });

  it('does not carry the previous turn usage into the next turn', () => {
    const s = fold([
      sessionStarted(ev),
      ev('turn_started', { trigger: 'prompt' }, { turnId: 't1' }),
      ev('usage', { scope: 'turn', tokens: { input: 7 } }, { turnId: 't1' }),
      ev('turn_ended', { stopReason: 'end_turn' }, { turnId: 't1' }),
      ev('turn_started', { trigger: 'prompt' }, { turnId: 't2' }),
      ev('turn_ended', { stopReason: 'end_turn' }, { turnId: 't2' }),
    ]);
    const ends = s.items.filter((i) => i.kind === 'turn_end');
    expect(ends).toHaveLength(2);
    expect(ends[1]).not.toHaveProperty('usage');
  });

  it('records turnStartedAt while a turn runs', () => {
    const s = fold([sessionStarted(ev), ev('turn_started', { trigger: 'prompt' }, { turnId: 't1' })]);
    expect(s.turnStartedAt).toBe(1002);
  });

  it('counts protocol_unknown events by kind and name', () => {
    const s = fold([
      sessionStarted(ev),
      ev('protocol_unknown', { driver: 'codex_app_server', kind: 'notification', name: 'item/new' }),
      ev('protocol_unknown', { driver: 'codex_app_server', kind: 'notification', name: 'item/new' }),
      ev('protocol_unknown', { driver: 'codex_app_server', kind: 'field', name: 'usage.x' }),
    ]);
    expect(s.protocolUnknown).toEqual({ 'notification:item/new': 2, 'field:usage.x': 1 });
    expect(s.items).toEqual([]);
  });
});
