import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatEvent, ChatEventDataMap, ChatEventType } from '../../shared/chat';
import { COMPACTION_STARTED, MINIMAL_CHAT_CAPABILITIES } from '../../shared/chat';
import {
  createChatViewState,
  foldChatEvents,
  initChatEventListener,
  reduceChatEvent,
  settleDeadSession,
  liveChatAgent,
  totalOf,
  useChatStore,
  type AgentMessageItem,
  type ChatViewState,
  type QuestionItem,
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

  describe('questions nobody can answer any more (#2183 review)', () => {
    const asked = (requestId: string, turnId: string, sessionId = 's1') => ev('question', {
      requestId,
      toolCallId: `tc-${requestId}`,
      questions: [{ id: 'db', prompt: 'Which DB?', allowFreeText: true }],
    }, { turnId, sessionId });
    const questionItem = (s: ChatViewState, requestId: string) =>
      s.items.find((i): i is QuestionItem => i.kind === 'question' && i.requestId === requestId);

    it('expire when their turn ends unanswered', () => {
      const s = fold([
        sessionStarted(ev),
        ev('turn_started', { trigger: 'prompt' }, { turnId: 't1' }),
        asked('q1', 't1'),
        ev('turn_ended', { stopReason: 'cancelled' }, { turnId: 't1' }),
      ]);
      expect(questionItem(s, 'q1')?.expired).toBe(true);
      expect(s.pendingQuestions).toEqual([]);
    });

    it('stay answered, and an answer arriving late still lands', () => {
      let s = fold([
        sessionStarted(ev),
        ev('turn_started', { trigger: 'prompt' }, { turnId: 't1' }),
        asked('q1', 't1'),
        ev('question_resolved', { requestId: 'q1', answers: { db: 'pg' } }, { turnId: 't1' }),
        ev('turn_ended', { stopReason: 'end_turn' }, { turnId: 't1' }),
      ]);
      expect(questionItem(s, 'q1')?.expired).toBeUndefined();
      s = fold([sessionStarted(ev), ev('turn_started', { trigger: 'prompt' }, { turnId: 't2' }), asked('q2', 't2'), ev('session_ended', { reason: 'stopped' })], createChatViewState(AGENT));
      expect(questionItem(s, 'q2')?.expired).toBe(true);
      s = fold([ev('question_resolved', { requestId: 'q2', answers: { db: 'pg' } })], s);
      expect(questionItem(s, 'q2')).toMatchObject({ answers: { db: 'pg' } });
      expect(questionItem(s, 'q2')?.expired).toBeUndefined();
    });

    it.each(['s1', 's2'])('settles a new run of %s after the app quit mid-turn (no session_ended)', (sessionId) => {
      const s = fold([
        sessionStarted(ev),
        ev('turn_started', { trigger: 'prompt' }, { turnId: 't1' }),
        asked('q1', 't1'),
        sessionStarted(ev, sessionId),
      ]);
      if (sessionId === 's1') expect(questionItem(s, 'q1')?.expired).toBe(true);
      else expect(questionItem(s, 'q1')).toBeUndefined();
      expect(s.pendingQuestions).toEqual([]);
    });

    it('settleDeadSession expires what a dead session left open', () => {
      const s = fold([
        sessionStarted(ev),
        ev('turn_started', { trigger: 'prompt' }, { turnId: 't1' }),
        asked('q1', 't1'),
        ev('permission_request', { requestId: 'p1', title: 'Run ls', options: [] }, { turnId: 't1' }),
      ]);
      expect(questionItem(s, 'q1')?.expired).toBeUndefined();
      const settled = settleDeadSession(s);
      expect(questionItem(settled, 'q1')?.expired).toBe(true);
      expect(settled.pendingQuestions).toEqual([]);
      expect(settled.pendingPermissions).toEqual([]);
      expect(settleDeadSession(settled)).toBe(settled);
    });

    it('settleDeadSession leaves the session sleeping, not idle or running (#2208)', () => {
      const s = fold([sessionStarted(ev), ev('turn_started', { trigger: 'prompt' }, { turnId: 't1' })]);
      expect(s.state).toBe('running');
      const settled = settleDeadSession(s);
      expect(settled).toMatchObject({ state: 'sleeping', turnId: null, turnStartedAt: null });
      expect(settleDeadSession(settled)).toBe(settled);
      expect(settleDeadSession(fold([sessionStarted(ev)])).state).toBe('sleeping');
    });
  });

  describe('a new run after the app quit mid-turn (#2183)', () => {
    it('closes the dead turn: nothing streams, no turn runs', () => {
      const s = fold([
        sessionStarted(ev),
        ev('turn_started', { trigger: 'prompt' }, { turnId: 't1' }),
        ev('agent_thought_chunk', { messageId: 'th1', text: 'Thinking' }, { turnId: 't1' }),
        ev('agent_message_chunk', { messageId: 'm1', text: 'Hal' }, { turnId: 't1' }),
        sessionStarted(ev, 's2'),
      ]);
      expect(s.turnId).toBeNull();
      expect(s.turnStartedAt).toBeNull();
      expect(s.state).toBe('idle');
      expect(s.items.filter((i) => (i.kind === 'thought' || i.kind === 'agent_message') && i.streaming)).toEqual([]);
    });

    it('counts unrecognized messages per run, not over the whole history', () => {
      let s = fold([
        sessionStarted(ev),
        ev('protocol_unknown', { driver: 'claude_agent_sdk', kind: 'message', name: 'system/thinking_tokens' }),
      ]);
      expect(s.protocolUnknown).toEqual({ 'message:system/thinking_tokens': 1 });
      s = fold([sessionStarted(ev, 's2')], s);
      expect(s.protocolUnknown).toEqual({});
      s = fold([ev('protocol_unknown', { driver: 'claude_agent_sdk', kind: 'field', name: 'x' }, { sessionId: 's2' })], s);
      expect(s.protocolUnknown).toEqual({ 'field:x': 1 });
    });

    it('waits for model_changed before treating the effort as known', () => {
      let s = fold([sessionStarted(ev), ev('session_info', { efforts: ['low', 'high'] })]);
      expect(s.effortReported).toBe(false);
      s = fold([ev('model_changed', { modelId: 'opus', effort: 'high', effortIsDefault: true })], s);
      expect(s.effortReported).toBe(true);
      s = fold([sessionStarted(ev, 's2')], s);
      expect(s.effortReported).toBe(false);
    });
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

  it('starts an empty conversation on a new session id', () => {
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
    expect(s.items.map((i) => i.kind)).toEqual(['notice']);
    // Session-scoped state is reset for the new conversation.
    expect(s.plan).toEqual([]);
    expect(s.pendingPermissions).toEqual([]);
    expect(s.lastSeq).toEqual({ s1: 4, s2: 2 });
    // Old messages stay in their own session transcript.
  });

  it('ignores late events from an older session but allows a later explicit resume', () => {
    const oldStart = { ...sessionStarted(ev, 'old'), ts: 100 };
    const newStart = { ...sessionStarted(ev, 'new'), ts: 200 };
    const reply = { ...ev('agent_message', { messageId: 'new-reply', text: 'Live conversation' }, { sessionId: 'new' }), ts: 210 };
    const state = fold([oldStart, newStart, reply]);
    const lateEnd = { ...ev('session_ended', { reason: 'stopped' }, { sessionId: 'old' }), ts: 300 };
    const lateReply = { ...ev('agent_message', { messageId: 'late', text: 'Obsolete reply' }, { sessionId: 'old' }), ts: 310 };
    expect(fold([lateEnd, lateReply], state)).toBe(state);
    expect(fold([{ ...sessionStarted(ev, 'unseen-old'), ts: 50 }], state)).toBe(state);
    const resumed = fold([{ ...sessionStarted(ev, 'old', { resumed: true }), ts: 400 }], state);
    expect(resumed.sessionId).toBe('old');
    expect(resumed.items).toEqual([]);
  });

  it('ignores an unknown old session ending after a current-only transcript load', () => {
    const state = fold([{ ...sessionStarted(ev, 'current'), ts: 200 }]);
    expect(fold([{ ...ev('session_ended', { reason: 'stopped' }, { sessionId: 'old' }), ts: 300 }], state)).toBe(state);
  });

  it('does not add a divider when session_started repeats the same session id (resume)', () => {
    const s = fold([
      sessionStarted(ev, 's1'),
      ev('session_ended', { reason: 'idle_timeout' }),
      sessionStarted(ev, 's1', { resumed: true }),
    ]);
    expect(s.items.map((i) => i.kind)).not.toContain('session_divider');
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

    it('drops removed queued messages by id, so a later turn delivers the next one kept (#2413)', () => {
      let s = fold([
        sessionStarted(ev),
        ev('turn_started', { trigger: 'prompt' }, { turnId: 't1' }),
        ev('user_message', { messageId: 'q1', content: text('first'), source: 'user', delivery: 'queued' }, { turnId: 't1' }),
        ev('user_message', { messageId: 'q2', content: text('second'), source: 'mcp', delivery: 'queued' }, { turnId: 't1' }),
        ev('user_message', { messageId: 'q3', content: text('third'), source: 'mcp', delivery: 'queued' }, { turnId: 't1' }),
        ev('queue_removed', { messageIds: ['q1', 'q3'] }),
      ]);
      expect(s.queued.map((q) => q.messageId)).toEqual(['q2']);
      s = fold([
        ev('turn_ended', { stopReason: 'end_turn' }, { turnId: 't1' }),
        ev('turn_started', { trigger: 'queued' }, { turnId: 't2' }),
      ], s);
      expect(s.queued).toEqual([]);
      expect(s.items.filter((i): i is UserMessageItem => i.kind === 'user_message').map((i) => i.text)).toEqual(['second']);
    });

    it('clears the queued entry with the delivered id before one with the same text', () => {
      const s = fold([
        sessionStarted(ev),
        ev('user_message', { messageId: 'q1', content: text('continue'), source: 'mcp', delivery: 'queued' }),
        ev('user_message', { messageId: 'q2', content: text('continue'), source: 'mcp', delivery: 'queued' }),
        ev('user_message', { messageId: 'q2', content: text('continue'), source: 'mcp', delivery: 'steer' }),
      ]);
      expect(s.queued.map((q) => q.messageId)).toEqual(['q1']);
    });

    it('keeps who sent each message of a merged queue item, parsing old ones (#2599)', () => {
      const routed = [{ sender: { agentId: 'b1', name: 'b' }, text: 'two' }];
      let s = fold([
        sessionStarted(ev),
        ev('turn_started', { trigger: 'prompt' }, { turnId: 't1' }),
        ev('user_message', { messageId: 'm1', content: text('[FROM HELPER:a (a1)] one'), source: 'mcp', delivery: 'queued' }),
        ev('user_message', { messageId: 'm2', content: text('[FROM HELPER:b (b1)] two'), source: 'mcp', delivery: 'queued', queuedWith: 'm1', routed }),
      ]);
      const parts = [{ sender: { agentId: 'a1', name: 'a' }, text: 'one' }, ...routed];
      expect(s.queued[0].routed).toEqual(parts);
      s = fold([
        ev('turn_ended', { stopReason: 'end_turn' }, { turnId: 't1' }),
        ev('turn_started', { trigger: 'queued' }, { turnId: 't2' }),
      ], s);
      expect((s.items.find((i) => i.kind === 'user_message') as UserMessageItem).routed).toEqual(parts);
    });

    it('keeps who sent a delivered message', () => {
      const routed = [{ sender: { agentId: 'a1', name: 'a' }, text: 'one' }];
      const s = fold([
        sessionStarted(ev),
        ev('user_message', { messageId: 'm1', content: text('[FROM:a] one'), source: 'mcp', delivery: 'prompt', routed }),
      ]);
      expect((s.items.find((i) => i.kind === 'user_message') as UserMessageItem).routed).toEqual(routed);
    });

    it('shows MCP messages merged into one queued item as one row, delivered as one (#2414)', () => {
      let s = fold([
        sessionStarted(ev),
        ev('turn_started', { trigger: 'prompt' }, { turnId: 't1' }),
        ev('user_message', { messageId: 'u1', content: text('mine'), source: 'user', delivery: 'queued' }),
        ev('user_message', { messageId: 'm1', content: text('[FROM HELPER:a (a)] one'), source: 'mcp', delivery: 'queued' }),
        ev('user_message', { messageId: 'm2', content: text('[FROM HELPER:b (b)] two'), source: 'mcp', delivery: 'queued', queuedWith: 'm1' }),
        ev('user_message', { messageId: 'm3', content: text('[Clubhouse] three'), source: 'mcp', delivery: 'queued', queuedWith: 'm1' }),
      ]);
      expect(s.queued.map((q) => q.messageId)).toEqual(['u1', 'm1']);
      expect(s.queued[1].text).toBe(
        '3 updates, oldest first:\n\n--- 1 of 3 ---\n[FROM HELPER:a (a)] one\n\n' +
        '--- 2 of 3 ---\n[FROM HELPER:b (b)] two\n\n--- 3 of 3 ---\n[Clubhouse] three',
      );
      expect(s.queued[0].text).toBe('mine');

      s = fold([
        ev('turn_ended', { stopReason: 'end_turn' }, { turnId: 't1' }),
        ev('turn_started', { trigger: 'queued' }, { turnId: 't2' }),
        ev('turn_ended', { stopReason: 'end_turn' }, { turnId: 't2' }),
        ev('turn_started', { trigger: 'queued' }, { turnId: 't3' }),
      ], s);
      expect(s.queued).toEqual([]);
      const delivered = s.items.filter((i): i is UserMessageItem => i.kind === 'user_message');
      expect(delivered.map((d) => d.messageId)).toEqual(['u1', 'm1']);
      expect(delivered[1].text).toContain('[Clubhouse] three');
    });

    it('drops a merged row whole on queue_removed for its item id', () => {
      const s = fold([
        sessionStarted(ev),
        ev('user_message', { messageId: 'm1', content: text('one'), source: 'mcp', delivery: 'queued' }),
        ev('user_message', { messageId: 'm2', content: text('two'), source: 'mcp', delivery: 'queued', queuedWith: 'm1' }),
        ev('queue_removed', { messageIds: ['m1'] }),
      ]);
      expect(s.queued).toEqual([]);
    });

    it('rebuilds a merged item whose first message was cut off as one row under its id', () => {
      const s = fold([
        sessionStarted(ev),
        ev('user_message', { messageId: 'm2', content: text('two'), source: 'mcp', delivery: 'queued', queuedWith: 'cut' }),
        ev('user_message', { messageId: 'm3', content: text('three'), source: 'mcp', delivery: 'queued', queuedWith: 'cut' }),
      ]);
      expect(s.queued.map((q) => q.messageId)).toEqual(['cut']);
      expect(s.queued[0].text).toBe('2 updates, oldest first:\n\n--- 1 of 2 ---\ntwo\n\n--- 2 of 2 ---\nthree');
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
    // A status-only update for a window keeps the utilization it already had.
    s = fold([ev('usage', { scope: 'session', limits: [{ window: '5h', status: 'ok' }] })], s);
    expect(s.usage.limits).toEqual([{ window: '5h', utilization: 0.4, status: 'ok' }, { window: 'week', status: 'warning' }]);

    s = fold([ev('turn_ended', { stopReason: 'end_turn', usage: { output: 42 }, costUsd: 0.02 })], s);
    expect(s.usage.turn).toEqual({ tokens: { output: 42 }, costUsd: 0.02 });

    // Limits are account-wide and survive a new session; context does not.
    s = fold([sessionStarted(ev, 's2')], s);
    expect(s.usage.limits).toHaveLength(2);
    expect(s.usage.context).toBeNull();
    expect(s.usage.session).toBeNull();
  });

  it('merges limits by window, so a one-window update keeps the others', () => {
    const s = fold([
      sessionStarted(ev),
      ev('usage', { scope: 'session', limits: [{ window: '5h', utilization: 0.4 }, { window: 'week', utilization: 0.6 }] }),
      ev('usage', { scope: 'session', limits: [{ window: 'week', utilization: 0.71, status: 'warning' }] }),
      ev('usage', { scope: 'session', limits: [{ window: 'overage', status: 'ok' }] }),
    ]);
    expect(s.usage.limits).toEqual([
      { window: '5h', utilization: 0.4 },
      { window: 'week', utilization: 0.71, status: 'warning' },
      { window: 'overage', status: 'ok' },
    ]);
  });

  it('sums each turn\'s tokens once, for drivers without a session total, and resets per session', () => {
    let s = fold([
      sessionStarted(ev),
      ev('turn_started', { trigger: 'prompt' }, { turnId: 't1' }),
      ev('usage', { scope: 'turn', tokens: { input: 100, output: 20 } }, { turnId: 't1' }),
      ev('turn_ended', { stopReason: 'end_turn', usage: { input: 100, output: 20 } }, { turnId: 't1' }),
      ev('turn_started', { trigger: 'prompt' }, { turnId: 't2' }),
      ev('usage', { scope: 'turn', tokens: { input: 50, output: 5, total: 60 } }, { turnId: 't2' }),
      ev('turn_ended', { stopReason: 'end_turn' }, { turnId: 't2' }),
      // ACP's usage_update carries context only: no session tokens.
      ev('usage', { scope: 'session', context: { used: 1000, size: 128000 } }),
    ]);
    expect(s.usage.session).toBeNull();
    expect(s.usage.turnTotal).toEqual({ input: 150, output: 25, total: 180 });
    s = fold([sessionStarted(ev, 's2')], s);
    expect(s.usage.turnTotal).toBeNull();
  });

  it('totals a usage without a total as input + output: cache is already part of input (#2170)', () => {
    expect(totalOf({ input: 110, cachedInput: 100, cacheWrite: 5, output: 5 })).toBe(115);
    expect(totalOf({ input: 10, output: 5, total: 99 })).toBe(99);
    expect(totalOf({})).toBe(0);
    const s = fold([
      sessionStarted(ev),
      ev('turn_started', { trigger: 'prompt' }, { turnId: 't1' }),
      ev('turn_ended', { stopReason: 'end_turn', usage: { input: 110, cachedInput: 100, cacheWrite: 5, output: 5 } }, { turnId: 't1' }),
    ]);
    expect(s.usage.turnTotal).toEqual({ input: 110, cachedInput: 100, cacheWrite: 5, output: 5, total: 115 });
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
      ev('notice', { level: 'warn', code: 'mcp_servers_skipped', message: 'Left out MCP servers' }),
      ev('error', { code: 'rate_limited', message: 'slow down', fatal: false, willRetry: true }),
    ]);
    expect(s.state).toBe('waiting_permission');
    expect(s.items.map((i) => i.kind)).toEqual(['notice', 'error']);
    const err = s.items[1];
    expect(err.kind === 'error' && err.willRetry).toBe(true);
  });

  it('keeps the untested CLI version note out of the transcript', () => {
    const s = fold([
      sessionStarted(ev),
      ev('notice', { level: 'info', code: 'untested_cli_version', message: 'Claude Code 2.1.302 is newer than the version chat was tested with (2.1.301).' }),
    ]);
    expect(s.items).toEqual([]);
    expect(s.untestedCliNote).toBe('Claude Code 2.1.302 is newer than the version chat was tested with (2.1.301).');
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
    useChatStore.setState({ agents: {}, loading: {}, loaded: {}, live: {} });
    window.clubhouse.chat.readTranscript = vi.fn().mockResolvedValue([]);
  });

  it('tracks whether a chat runtime runs the agent (#2208)', async () => {
    const getAgentRuntime = window.clubhouse.chat.getAgentRuntime;
    window.clubhouse.chat.getAgentRuntime = vi.fn(async () => ({ chat: false, chatAvailable: true }));
    try {
      window.clubhouse.chat.readTranscript = vi.fn().mockResolvedValue([sessionStarted(ev), ev('turn_started', { trigger: 'prompt' }, { turnId: 't1' })]);
      await useChatStore.getState().loadTranscript(AGENT);
      expect(useChatStore.getState().live[AGENT]).toBe(false);
      expect(useChatStore.getState().agents[AGENT].state).toBe('sleeping');
      expect(liveChatAgent(useChatStore.getState(), AGENT)).toBeUndefined();

      useChatStore.getState().applyEvent(sessionStarted(ev, 's2'));
      expect(useChatStore.getState().live[AGENT]).toBe(true);
      expect(liveChatAgent(useChatStore.getState(), AGENT)?.state).toBe('idle');

      useChatStore.getState().applyEvent(ev('session_ended', { reason: 'stopped' }));
      expect(useChatStore.getState().live[AGENT]).toBe(false);

      useChatStore.getState().reset(AGENT);
      expect(useChatStore.getState().live[AGENT]).toBeUndefined();
    } finally {
      window.clubhouse.chat.getAgentRuntime = getAgentRuntime;
    }
  });

  it('reads live from `live`, not from an agent only starting into chat (#2206)', async () => {
    const getAgentRuntime = window.clubhouse.chat.getAgentRuntime;
    window.clubhouse.chat.getAgentRuntime = vi.fn(async () => ({ chat: true, live: false, chatAvailable: true }));
    try {
      window.clubhouse.chat.readTranscript = vi.fn().mockResolvedValue([sessionStarted(ev)]);
      await useChatStore.getState().loadTranscript(AGENT);
      expect(useChatStore.getState().live[AGENT]).toBe(false);
    } finally {
      window.clubhouse.chat.getAgentRuntime = getAgentRuntime;
    }
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

  it.each([[false, true], [true, undefined]] as const)('loadTranscript settles a transcript nobody runs any more (runtime live: %s)', async (live, expired) => {
    const getAgentRuntime = window.clubhouse.chat.getAgentRuntime;
    window.clubhouse.chat.getAgentRuntime = vi.fn(async () => ({ chat: live, chatAvailable: true }));
    try {
      window.clubhouse.chat.readTranscript = vi.fn().mockResolvedValue([
        sessionStarted(ev),
        ev('turn_started', { trigger: 'prompt' }, { turnId: 't1' }),
        ev('question', { requestId: 'q1', questions: [{ id: 'a', prompt: 'A?', allowFreeText: true }] }, { turnId: 't1' }),
      ]);
      await useChatStore.getState().loadTranscript(AGENT);
      const s = useChatStore.getState().agents[AGENT];
      const q = s.items.find((i): i is QuestionItem => i.kind === 'question');
      expect(q?.expired).toBe(expired);
      expect(s.pendingQuestions).toHaveLength(live ? 1 : 0);
    } finally {
      window.clubhouse.chat.getAgentRuntime = getAgentRuntime;
    }
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

  it('loads history for an agent whose state so far came only from live events (#2150)', async () => {
    // A running agent in a freshly opened window: live events arrive before any view loads its history.
    const e1 = sessionStarted(ev);
    const e2 = ev('user_message', { messageId: 'u1', content: text('Fix the bug'), source: 'user', delivery: 'prompt' });
    const e3 = ev('agent_message', { messageId: 'm1', text: 'On it.' });
    const e4 = ev('agent_message', { messageId: 'm2', text: 'Done.' });
    const e5 = ev('agent_message', { messageId: 'm3', text: 'Anything else?' });
    useChatStore.getState().applyEvent(e4);
    expect(useChatStore.getState().agents[AGENT]).toBeDefined();
    expect(useChatStore.getState().loaded[AGENT]).toBeUndefined();

    let resolveTranscript!: (events: ChatEvent[]) => void;
    window.clubhouse.chat.readTranscript = vi.fn(() => new Promise<ChatEvent[]>((resolve) => { resolveTranscript = resolve; }));
    const loading = useChatStore.getState().loadTranscript(AGENT);
    // One live event that the transcript also holds (e4), one that's newer (e5).
    useChatStore.getState().applyEvent(e4);
    useChatStore.getState().applyEvent(e5);
    resolveTranscript([e1, e2, e3, e4]);
    await loading;

    const state = useChatStore.getState().agents[AGENT];
    expect(useChatStore.getState().loaded[AGENT]).toBe(true);
    expect(state.items.map((i) => i.seq)).toEqual([2, 3, 4, 5]);
    expect(state.items.map((i) => i.kind)).toEqual(['user_message', 'agent_message', 'agent_message', 'agent_message']);
    expect(state.items.slice(1).map((i) => (i as AgentMessageItem).text)).toEqual(['On it.', 'Done.', 'Anything else?']);
  });

  it('clears the live view and its Show earlier flag when a new session starts', async () => {
    const old = [sessionStarted(ev), ev('agent_message', { messageId: 'm1', text: 'Old context' })];
    window.clubhouse.chat.readTranscript = vi.fn().mockResolvedValue(old);
    await useChatStore.getState().loadTranscript(AGENT, 2);
    expect(useChatStore.getState().partial[AGENT]).toBe(true);
    useChatStore.getState().applyEvent(sessionStarted(ev, 'fresh'));
    expect(useChatStore.getState().agents[AGENT].items).toEqual([]);
    expect(useChatStore.getState().partial[AGENT]).toBe(false);
  });

  it('loads the matching history when resuming a different session', async () => {
    const older = [sessionStarted(ev), ev('agent_message', { messageId: 'm1', text: 'Remembered task' })];
    useChatStore.getState().applyEvent(sessionStarted(ev, 'fresh'));
    const resumed = sessionStarted(ev, 's1', { resumed: true });
    window.clubhouse.chat.readTranscript = vi.fn().mockResolvedValue([...older, resumed]);
    useChatStore.getState().applyEvent(resumed);
    await vi.waitFor(() => expect(useChatStore.getState().loading[AGENT]).toBeUndefined());
    expect(useChatStore.getState().agents[AGENT].sessionId).toBe('s1');
    expect(useChatStore.getState().agents[AGENT].items.map((i) => i.kind)).toEqual(['agent_message']);
    expect((useChatStore.getState().agents[AGENT].items[0] as AgentMessageItem).text).toBe('Remembered task');
  });

  it('does not restore old messages when a clear arrives during Show earlier', async () => {
    const old = [sessionStarted(ev), ev('agent_message', { messageId: 'm1', text: 'Old context' })];
    let resolve!: (events: ChatEvent[]) => void;
    window.clubhouse.chat.readTranscript = vi.fn(() => new Promise<ChatEvent[]>((r) => { resolve = r; }));
    const loading = useChatStore.getState().loadTranscript(AGENT, 2);
    useChatStore.getState().applyEvent(sessionStarted(ev, 'fresh'));
    resolve(old);
    await loading;
    expect(useChatStore.getState().agents[AGENT].sessionId).toBe('fresh');
    expect(useChatStore.getState().agents[AGENT].items).toEqual([]);
    expect(useChatStore.getState().partial[AGENT]).toBe(false);
  });

  it('ignores a read completing after the agent store was reset', async () => {
    let resolve!: (events: ChatEvent[]) => void;
    window.clubhouse.chat.readTranscript = vi.fn(() => new Promise<ChatEvent[]>((r) => { resolve = r; }));
    const loading = useChatStore.getState().loadTranscript(AGENT);
    useChatStore.getState().reset(AGENT);
    resolve([sessionStarted(ev)]);
    await loading;
    expect(useChatStore.getState().agents[AGENT]).toBeUndefined();
  });

  it('reset forgets that history was loaded', async () => {
    await useChatStore.getState().loadTranscript(AGENT);
    expect(useChatStore.getState().loaded[AGENT]).toBe(true);
    useChatStore.getState().reset(AGENT);
    expect(useChatStore.getState().loaded[AGENT]).toBeUndefined();
  });

  it('on a failed read keeps the live state, applies what arrived meanwhile, and leaves it unloaded so a later view retries', async () => {
    useChatStore.getState().applyEvent(sessionStarted(ev));
    useChatStore.getState().applyEvent(ev('agent_message', { messageId: 'm1', text: 'Seen live.' }));
    let fail!: (err: Error) => void;
    window.clubhouse.chat.readTranscript = vi.fn(() => new Promise<ChatEvent[]>((_resolve, reject) => { fail = reject; }));
    const loading = useChatStore.getState().loadTranscript(AGENT);
    useChatStore.getState().applyEvent(ev('agent_message', { messageId: 'm2', text: 'Arrived mid-load.' }));
    fail(new Error('EBUSY'));
    await loading;

    const s = useChatStore.getState();
    expect(s.agents[AGENT].items.map((i) => (i as AgentMessageItem).text)).toEqual(['Seen live.', 'Arrived mid-load.']);
    expect(s.loaded[AGENT]).toBeUndefined();
    expect(s.loading[AGENT]).toBeUndefined();
    expect(s.partial[AGENT]).toBeUndefined();
  });

  it('a failed read with no state yet leaves an empty, unloaded view', async () => {
    window.clubhouse.chat.readTranscript = vi.fn().mockRejectedValue(new Error('nope'));
    await useChatStore.getState().loadTranscript(AGENT);
    expect(useChatStore.getState().agents[AGENT].items).toEqual([]);
    expect(useChatStore.getState().loaded[AGENT]).toBeUndefined();
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
    chat.removeQueued = vi.fn().mockResolvedValue(['q1']);

    const store = useChatStore.getState();
    await expect(store.send(AGENT, 'hi', 'auto')).resolves.toEqual({ delivery: 'queued', messageId: 'm' });
    await store.interrupt(AGENT);
    await store.respondPermission(AGENT, 'p1', 'a', { message: 'go ahead' });
    await store.answerQuestion(AGENT, 'q1', { db: 'pg' });
    await store.setLevel(AGENT, 'plan');
    await store.setModel(AGENT, 'opus', 'high');

    expect(chat.sendMessage).toHaveBeenCalledWith(AGENT, 'hi', 'auto');
    await store.send(AGENT, '', 'auto', ['staged-1']);
    expect(chat.sendMessage).toHaveBeenLastCalledWith(AGENT, '', 'auto', ['staged-1']);
    expect(chat.interrupt).toHaveBeenCalledWith(AGENT);
    expect(chat.respondPermission).toHaveBeenCalledWith(AGENT, 'p1', 'a', { message: 'go ahead' });
    expect(chat.answerQuestion).toHaveBeenCalledWith(AGENT, 'q1', { db: 'pg' });
    expect(chat.setLevel).toHaveBeenCalledWith(AGENT, 'plan');
    expect(chat.setModel).toHaveBeenCalledWith(AGENT, 'opus', 'high');
    await expect(store.removeQueued(AGENT, ['q1'])).resolves.toEqual(['q1']);
    expect(chat.removeQueued).toHaveBeenLastCalledWith(AGENT, ['q1']);
    await store.removeQueued(AGENT);
    expect(chat.removeQueued).toHaveBeenLastCalledWith(AGENT);
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

  it('bumps the workspace revision on workspace_changed, without a transcript item (#2109)', () => {
    const s = fold([
      sessionStarted(ev),
      ev('workspace_changed', { reason: 'vcs', vcsKind: 'commit' }),
      ev('workspace_changed', { reason: 'vcs', vcsKind: 'push', branch: 'main' }),
    ]);
    expect(s.workspaceRevision).toBe(2);
    expect(s.items).toEqual([]);
  });
});

describe('picker lists on session_info', () => {
  it('replaces models, efforts and level names when present, keeps them when absent, clears on empty', () => {
    const ev = makeEmitter();
    let state = fold([
      sessionStarted(ev),
      ev('session_info', { models: [{ id: 'a', label: 'A', costHint: '1x' }], efforts: ['low', 'high'], levelNames: { ask: 'Agent' } }),
      ev('session_info', { cliVersion: '1.0.98' }),
    ]);
    expect(state.models).toEqual([{ id: 'a', label: 'A', costHint: '1x' }]);
    expect(state.efforts).toEqual(['low', 'high']);
    expect(state.levelNames).toEqual({ ask: 'Agent' });
    state = fold([ev('session_info', { models: [], efforts: [] })], state);
    expect(state.models).toEqual([]);
    expect(state.efforts).toEqual([]);
    expect(state.levelNames).toEqual({ ask: 'Agent' });
  });

  it('clears the previous session\'s picker lists on session_started', () => {
    const ev = makeEmitter();
    const state = fold([
      sessionStarted(ev),
      ev('session_info', { models: [{ id: 'a', label: 'A' }], efforts: ['low'], levelNames: { ask: 'Agent' } }),
      sessionStarted(ev),
    ]);
    expect(state.models).toEqual([]);
    expect(state.efforts).toEqual([]);
    expect(state.levelNames).toEqual({});
  });
});

describe('model before the session resolves it (#2293)', () => {
  it('a null model clears the last run\'s and reads as unknown until model_changed names it', () => {
    const ev = makeEmitter();
    let state = fold([sessionStarted(ev), ev('session_info', { model: 'gpt-5.6-sol' })]);
    expect(state).toMatchObject({ model: 'gpt-5.6-sol', modelUnknown: false });
    // A wake that continues the same chat session in a new native one.
    state = fold([sessionStarted(ev, 's1', { resumed: true }), ev('session_info', { model: null })], state);
    expect(state).toMatchObject({ model: null, modelUnknown: true });
    // Absent leaves it unknown.
    state = fold([ev('session_info', { cliVersion: '1.0.98' })], state);
    expect(state).toMatchObject({ model: null, modelUnknown: true });
    state = fold([ev('model_changed', { modelId: 'gpt-5.6-sol', effort: 'medium', effortIsDefault: true })], state);
    expect(state).toMatchObject({ model: 'gpt-5.6-sol', modelUnknown: false });
  });

  it('a new run starts without the unknown mark', () => {
    const ev = makeEmitter();
    const state = fold([sessionStarted(ev), ev('session_info', { model: null }), sessionStarted(ev, 's1', { resumed: true })]);
    expect(state.modelUnknown).toBe(false);
  });

  it('a reported model ends the unknown state', () => {
    const ev = makeEmitter();
    const state = fold([sessionStarted(ev), ev('session_info', { model: null }), ev('session_info', { model: 'opus' })]);
    expect(state).toMatchObject({ model: 'opus', modelUnknown: false });
  });
});

describe('MCP servers on session_info', () => {
  it('is unknown until reported, replaced when present, and cleared by a new session', () => {
    const ev = makeEmitter();
    let state = fold([sessionStarted(ev)]);
    expect(state.mcpServers).toBeNull();
    state = fold([
      ev('session_info', { mcpServers: [{ name: 'clubhouse', status: 'connected' }] }),
      ev('session_info', { cliVersion: '2.1.302' }),
    ], state);
    expect(state.mcpServers).toEqual([{ name: 'clubhouse', status: 'connected' }]);
    state = fold([sessionStarted(ev)], state);
    expect(state.mcpServers).toBeNull();
  });
});

describe('reduceChatEvent: context compaction', () => {
  let ev: ReturnType<typeof makeEmitter>;
  beforeEach(() => { ev = makeEmitter(); });
  const started = () => ev('notice', { level: 'info', code: COMPACTION_STARTED, message: 'Compacting context…' }, { turnId: 't1' });
  const notices = (s: ChatViewState) => s.items.flatMap((i) => (i.kind === 'notice' ? [[i.code, i.message, i.running ?? false]] : []));

  it('shows one running row while compaction runs, then settles it in place', () => {
    const running = fold([
      sessionStarted(ev),
      ev('turn_started', { trigger: 'prompt' }, { turnId: 't1' }),
      started(),
      // Providers can repeat the start (ACP compaction_update, a repeated status frame).
      started(),
    ]);
    expect(notices(running)).toEqual([[COMPACTION_STARTED, 'Compacting context…', true]]);
    expect(running.compactionItemId).toBe(running.items[0].id);

    const done = fold([
      ev('agent_message', { messageId: 'm1', text: 'later' }, { turnId: 't1' }),
      // Codex sends its completed notice without a turn id.
      ev('notice', { level: 'info', code: 'context_compacted', message: 'Context compacted' }),
    ], running);
    expect(notices(done)).toEqual([['context_compacted', 'Context compacted', false]]);
    // Same row, same place: before the message that came while it ran.
    expect(done.items.map((i) => i.kind)).toEqual(['notice', 'agent_message']);
    expect(done.items[0].id).toBe(running.items[0].id);
    expect(done.compactionItemId).toBeNull();
  });

  it('settles into whichever code finished it (Claude, ACP, failures)', () => {
    for (const code of ['compacted', 'compaction_completed', 'compaction_failed', 'compaction_cancelled']) {
      ev = makeEmitter();
      const s = fold([sessionStarted(ev), started(), ev('notice', { level: 'warn', code, message: code })]);
      expect(notices(s)).toEqual([[code, code, false]]);
    }
  });

  it('appends a completed notice as before when no start was seen', () => {
    const s = fold([sessionStarted(ev), ev('notice', { level: 'info', code: 'context_compacted', message: 'Context compacted' })]);
    expect(notices(s)).toEqual([['context_compacted', 'Context compacted', false]]);
  });

  it('drops the running row when the turn ends, is cancelled or the session ends without a result', () => {
    const turnEnd = fold([
      sessionStarted(ev),
      ev('turn_started', { trigger: 'prompt' }, { turnId: 't1' }),
      started(),
      ev('turn_ended', { stopReason: 'cancelled' }, { turnId: 't1' }),
    ]);
    expect(notices(turnEnd)).toEqual([]);
    expect(turnEnd.compactionItemId).toBeNull();
    // A later completed notice is an ordinary row again.
    const after = fold([ev('notice', { level: 'info', code: 'compacted', message: 'Context compacted' })], turnEnd);
    expect(notices(after)).toEqual([['compacted', 'Context compacted', false]]);

    ev = makeEmitter();
    const ended = fold([sessionStarted(ev), started(), ev('session_ended', { reason: 'process_exit' })]);
    expect(notices(ended)).toEqual([]);

    ev = makeEmitter();
    const failed = fold([sessionStarted(ev), started(), ev('error', { code: 'process_exited', message: 'gone', fatal: true })]);
    expect(notices(failed)).toEqual([]);
    expect(failed.compactionItemId).toBeNull();

    ev = makeEmitter();
    const retrying = fold([sessionStarted(ev), started(), ev('error', { code: 'rate_limited', message: 'slow down', fatal: false, willRetry: true })]);
    expect(notices(retrying)).toEqual([[COMPACTION_STARTED, 'Compacting context…', true]]);
  });

  it('drops a running row when a new session starts', () => {
    const s = fold([sessionStarted(ev, 's1'), started(), sessionStarted(ev, 's2')]);
    expect(notices(s)).toEqual([]);
    expect(s.compactionItemId).toBeNull();
  });
});
