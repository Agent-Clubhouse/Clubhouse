import { describe, expect, it } from 'vitest';
import type { ChatDriverId } from '../../../shared/chat/capabilities';
import type { ChatEventDraft } from '../../../shared/chat/events';
import type { ChatDriverSession, ChatDriverStartOptions } from '../../../shared/chat/runtime';
import { createAcpChatDriver, type AcpLaunchSpec } from './driver';
import type { InitializeResponse, SessionConfigOption } from './protocol';
import { ScriptedAcpAgent, type ScriptedAgentOptions } from './testing/scripted-agent';

// Not a registered driver id: this layer has no provider. The id is only a label here.
const TEST_DRIVER_ID = 'acp_neutral_test' as ChatDriverId;

const SPEC: AcpLaunchSpec = {
  id: TEST_DRIVER_ID,
  provider: 'acp-test',
  args: ({ extraArgs }) => ['acp', ...extraArgs],
};

const FULL_INIT: InitializeResponse = {
  protocolVersion: 1,
  agentInfo: { name: 'scripted', version: '0.0.1-test' },
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: true },
    sessionCapabilities: { close: {} },
  },
  authMethods: [],
};

const MODEL_OPTIONS: SessionConfigOption[] = [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'small', options: [{ value: 'small', name: 'Small' }, { value: 'large', name: 'Large' }] },
  { id: 'thinking', name: 'Thinking', category: 'thought_level', type: 'select', currentValue: 'low', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
];

const START: ChatDriverStartOptions = { agentId: 'a1', provider: 'acp-test', cwd: '/work', binaryPath: '/bin/agent', level: 'ask' };

class Drafts {
  readonly all: ChatEventDraft[] = [];
  private waiters: Array<() => void> = [];
  done = false;

  constructor(session: ChatDriverSession) {
    void (async () => {
      for await (const draft of session.events) {
        this.all.push(draft);
        for (const w of this.waiters.splice(0)) w();
      }
      this.done = true;
      for (const w of this.waiters.splice(0)) w();
    })();
  }

  of<T extends ChatEventDraft['type']>(type: T): Array<Extract<ChatEventDraft, { type: T }>> {
    return this.all.filter((d): d is Extract<ChatEventDraft, { type: T }> => d.type === type);
  }

  async until(pred: (all: ChatEventDraft[]) => boolean): Promise<void> {
    while (!pred(this.all)) {
      if (this.done) throw new Error(`stream ended first: ${JSON.stringify(this.all.map((d) => d.type))}`);
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  untilType(type: ChatEventDraft['type'], count = 1): Promise<void> {
    return this.until((all) => all.filter((d) => d.type === type).length >= count);
  }

  untilEnd(): Promise<void> {
    return this.until(() => this.done);
  }
}

async function open(agentOpts: ScriptedAgentOptions = {}, start: Partial<ChatDriverStartOptions> = {}, spec = SPEC) {
  const agent = new ScriptedAcpAgent({ initialize: FULL_INIT, ...agentOpts });
  const driver = createAcpChatDriver(spec, { connect: () => agent.connector, clientVersion: '9.9.9' });
  const session = await driver.start({ ...START, ...start });
  return { agent, driver, session, drafts: new Drafts(session) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
// ChatDriverSession.isClosed comes with the #3804 contract; read it structurally until then.
const closed = (session: ChatDriverSession) => (session as { isClosed?(): boolean }).isClosed?.();

describe('ACP driver: negotiation', () => {
  it('sends its own client identity and only the capabilities it serves', async () => {
    const { agent, session } = await open();
    const [init] = agent.sentRequests('initialize') as Array<Record<string, unknown>>;
    expect(init).toEqual({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } },
      clientInfo: { name: 'clubhouse', title: 'Clubhouse', version: '9.9.9' },
    });
    expect(session.nativeSessionId).toBe('session-1');
  });

  it('derives capabilities from initialize, not guesses', async () => {
    const { session } = await open();
    expect(session.capabilities).toMatchObject({
      steer: false, queue: 'client', interrupt: true, resume: 'replay', images: true,
      questions: false, usage: 'none', modelSwitch: 'none', effortSwitch: 'none', liveLevels: [], login: 'terminal', systemPrompt: false,
    });
  });

  it('turns on what the session reports, and claims only fill gaps ACP cannot express', async () => {
    const { session } = await open(
      { configOptions: MODEL_OPTIONS, initialize: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } }, authMethods: [{ id: 'login', name: 'Log in' }] } },
      {},
      { ...SPEC, claims: { questions: true, usageContext: true } },
    );
    expect(session.capabilities).toMatchObject({
      resume: 'native', images: false, questions: true, usage: 'context', modelSwitch: 'live', effortSwitch: 'live', login: 'terminal',
    });
  });

  it('reports the session model and choices', async () => {
    const { drafts } = await open({ configOptions: MODEL_OPTIONS });
    await drafts.untilType('session_info');
    expect(drafts.of('session_info')[0].data).toEqual({
      cliVersion: '0.0.1-test',
      model: 'small',
      models: [{ id: 'small', label: 'Small' }, { id: 'large', label: 'Large' }],
      efforts: ['low', 'high'],
    });
  });

  it('refuses a protocol version it does not speak', async () => {
    const agent = new ScriptedAcpAgent({ initialize: { protocolVersion: 2 } });
    const driver = createAcpChatDriver(SPEC, { connect: () => agent.connector });
    await expect(driver.start(START)).rejects.toThrow(/protocol version 2/);
  });

  it('passes a system prompt only when the agent advertises it', async () => {
    const withIt = await open({ initialize: { ...FULL_INIT, agentCapabilities: { sessionCapabilities: { systemPrompt: {} } } } }, { systemPrompt: 'Be brief.' });
    expect(withIt.agent.sentRequests('session/new')[0]).toMatchObject({ systemPrompt: { mode: 'append', content: [{ type: 'text', text: 'Be brief.' }] } });
    expect(withIt.session.capabilities.systemPrompt).toBe(true);
    const without = await open({}, { systemPrompt: 'Be brief.' });
    expect(without.agent.sentRequests('session/new')[0]).not.toHaveProperty('systemPrompt');
  });

  it('rejects the start with the agent\'s own auth error', async () => {
    const agent = new ScriptedAcpAgent({ newSessionError: { code: -32000, message: 'Authentication required' } });
    const driver = createAcpChatDriver(SPEC, { connect: () => agent.connector });
    await expect(driver.start(START)).rejects.toThrow(/-32000: Authentication required/);
  });

  it('probes with initialize only', async () => {
    const agent = new ScriptedAcpAgent({ initialize: FULL_INIT });
    const driver = createAcpChatDriver(SPEC, { connect: () => agent.connector });
    const probe = await driver.probe('/bin/agent');
    expect(probe).toMatchObject({ handshakeOk: true, cliVersion: '0.0.1-test' });
    expect(agent.received.map((r) => r.method)).toEqual(['initialize']);
  });

  it('reports a probe whose agent exits as process_exited', async () => {
    const agent = new ScriptedAcpAgent();
    const driver = createAcpChatDriver(SPEC, {
      connect: () => (handlers) => {
        const transport = agent.connector(handlers);
        agent.disconnect({ code: 3, signal: null });
        return transport;
      },
    });
    expect(await driver.probe('/bin/agent')).toMatchObject({ handshakeOk: false, errorCode: 'process_exited' });
  });
});

describe('ACP driver: prompt turns', () => {
  it('streams updates and ends the turn with the reported stop reason', async () => {
    const { agent, session, drafts } = await open();
    expect(await session.send([{ type: 'text', text: 'hi' }], 'prompt')).toBe('prompt');
    const prompt = await agent.nextPrompt();
    expect(prompt.prompt).toEqual([{ type: 'text', text: 'hi' }]);
    agent.update(prompt.sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } });
    agent.update(prompt.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hel' } });
    agent.update(prompt.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'lo' } });
    agent.update(prompt.sessionId, {
      sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Edit a.ts', kind: 'edit', status: 'in_progress',
      content: [{ type: 'diff', path: '/work/a.ts', oldText: 'a', newText: 'b' }], locations: [{ path: '/work/a.ts', line: 3 }],
    });
    agent.update(prompt.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
    agent.update(prompt.sessionId, { sessionUpdate: 'plan', entries: [{ content: 'Do it', priority: 'high', status: 'completed' }] });
    agent.update(prompt.sessionId, { sessionUpdate: 'usage_update', used: 10, size: 100, cost: { amount: 0.5, currency: 'USD' } });
    prompt.end('end_turn');
    await drafts.untilType('turn_ended');

    const types = drafts.all.map((d) => d.type).filter((t) => t !== 'session_info');
    expect(types).toEqual(['turn_started', 'agent_thought_chunk', 'agent_message_chunk', 'agent_message_chunk', 'tool_call', 'tool_call_update', 'plan', 'usage', 'turn_ended']);
    const [a, b] = drafts.of('agent_message_chunk');
    expect(a.data.messageId).toBe(b.data.messageId);
    expect(drafts.of('tool_call')[0].data).toMatchObject({ kind: 'edit', status: 'in_progress', content: [{ type: 'diff', path: '/work/a.ts', oldText: 'a', newText: 'b' }], locations: [{ path: '/work/a.ts', line: 3 }] });
    expect(drafts.of('usage')[0].data).toEqual({ scope: 'session', context: { used: 10, size: 100 }, costUsd: 0.5 });
    expect(drafts.of('turn_ended')[0].data.stopReason).toBe('end_turn');
    // usage_update arriving is observed truth.
    expect(drafts.of('session_info').some((d) => d.data.capabilities?.usage === 'context')).toBe(true);
  });

  it('maps every pinned stop reason', async () => {
    const { agent, session, drafts } = await open();
    const reasons = ['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'];
    for (const [i, reason] of reasons.entries()) {
      await session.send([{ type: 'text', text: reason }], 'prompt');
      (await agent.nextPrompt()).end(reason);
      await drafts.untilType('turn_ended', i + 1);
    }
    expect(drafts.of('turn_ended').map((d) => d.data.stopReason)).toEqual(['end_turn', 'max_tokens', 'max_turns', 'refusal', 'cancelled']);
  });

  it('refuses to steer: ACP v1 has one prompt per turn, so the runtime queues', async () => {
    const { agent, session } = await open();
    await session.send([{ type: 'text', text: 'one' }], 'prompt');
    await agent.nextPrompt();
    await expect(session.send([{ type: 'text', text: 'two' }], 'steer')).rejects.toThrow(/queue it/);
    await settle();
    expect(agent.sentRequests('session/prompt')).toHaveLength(1);
  });

  it('reports a prompt the agent answered with an error as a failed turn', async () => {
    const { agent, session, drafts } = await open();
    await session.send([{ type: 'text', text: 'x' }], 'prompt');
    (await agent.nextPrompt()).fail(-32603, 'boom');
    await drafts.untilType('turn_ended');
    expect(drafts.of('error')[0].data).toMatchObject({ code: 'unknown', fatal: false, message: expect.stringContaining('boom') });
    expect(drafts.of('turn_ended')[0].data.stopReason).toBe('error');
    // Never retried: the agent may have acted on it.
    await settle();
    expect(agent.sentRequests('session/prompt')).toHaveLength(1);
  });

  it('rejects a send it cannot express before starting a turn', async () => {
    const { agent, session, drafts } = await open({ initialize: { protocolVersion: 1 } });
    await expect(session.send([{ type: 'image', mimeType: 'image/png', data: 'AAAA' }], 'prompt')).rejects.toThrow(/can't take images/);
    await settle();
    expect(agent.sentRequests('session/prompt')).toEqual([]);
    expect(drafts.of('turn_started')).toEqual([]);
    // Nothing is left looking like a running turn.
    await session.send([{ type: 'text', text: 'next' }], 'prompt');
    expect(agent.sentRequests('session/prompt')).toHaveLength(1);
  });

  it('fails the send, with no turn, when the transport refuses the prompt write', async () => {
    const { agent, session, drafts } = await open();
    agent.refuseNextPromptWrite();
    await expect(session.send([{ type: 'text', text: 'x' }], 'prompt')).rejects.toThrow(/refused the write/);
    await settle();
    expect(agent.promptsWritten).toBe(0);
    expect(drafts.of('turn_started')).toEqual([]);
    expect(closed(session)).toBe(false);
    await session.send([{ type: 'text', text: 'next' }], 'prompt');
    expect(agent.promptsWritten).toBe(1);
  });

  it('delivers an answer written just before the agent exits', async () => {
    const { agent, session, drafts } = await open();
    await session.send([{ type: 'text', text: 'x' }], 'prompt');
    (await agent.nextPrompt()).end('end_turn');
    agent.disconnect({ code: 0, signal: null });
    await drafts.untilEnd();
    expect(drafts.all.map((d) => d.type).filter((t) => t === 'turn_ended' || t === 'error')).toEqual(['turn_ended', 'error']);
    expect(drafts.of('error')[0].data.message).not.toContain('unknown');
  });

  it('flags a stop reason the pinned schema does not define', async () => {
    const { agent, session, drafts } = await open();
    await session.send([{ type: 'text', text: 'x' }], 'prompt');
    (await agent.nextPrompt()).end('paused');
    await drafts.untilType('turn_ended');
    expect(drafts.of('protocol_unknown')[0].data).toEqual({ driver: TEST_DRIVER_ID, kind: 'field', name: 'stopReason:paused' });
  });

  it('sends images only when promptCapabilities allows, else a file link', async () => {
    const withImages = await open();
    await withImages.session.send([{ type: 'image', mimeType: 'image/png', data: 'AAAA', path: '/tmp/a.png' }], 'prompt');
    expect((await withImages.agent.nextPrompt()).prompt).toEqual([{ type: 'image', data: 'AAAA', mimeType: 'image/png' }]);
    const without = await open({ initialize: { protocolVersion: 1 } });
    await without.session.send([{ type: 'image', mimeType: 'image/png', data: 'AAAA', path: '/tmp/a.png' }], 'prompt');
    expect((await without.agent.nextPrompt()).prompt).toEqual([{ type: 'resource_link', uri: 'file:///tmp/a.png', name: 'a.png', mimeType: 'image/png' }]);
  });
});

describe('ACP driver: permissions and questions', () => {
  it('relays a permission request and answers with the chosen option', async () => {
    const { agent, session, drafts } = await open();
    await session.send([{ type: 'text', text: 'x' }], 'prompt');
    const prompt = await agent.nextPrompt();
    const asked = agent.requestPermission(prompt.sessionId, { toolCallId: 't1', title: 'Run ls', rawInput: { cmd: 'ls' } });
    await drafts.untilType('permission_request');
    const request = drafts.of('permission_request')[0].data;
    expect(request).toMatchObject({
      title: 'Run ls', toolCallId: 't1', rawInput: { cmd: 'ls' },
      options: [{ optionId: 'allow', kind: 'allow_once', label: 'Allow' }, { optionId: 'reject', kind: 'reject_once', label: 'Reject' }],
    });
    await expect(session.respondPermission(request.requestId, 'nope')).rejects.toThrow(/no option/);
    await session.respondPermission(request.requestId, 'allow');
    expect((await asked.response).result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
    await expect(session.respondPermission(request.requestId, 'allow')).rejects.toThrow(/No open permission/);
    // The runtime writes permission_resolved for its own answer.
    expect(drafts.of('permission_resolved')).toEqual([]);
  });

  it('reports a request the agent withdrew as cancelled by the agent', async () => {
    const { agent, session, drafts } = await open();
    await session.send([{ type: 'text', text: 'x' }], 'prompt');
    const prompt = await agent.nextPrompt();
    const asked = agent.requestPermission(prompt.sessionId, { toolCallId: 't1', title: 'Run ls' });
    await drafts.untilType('permission_request');
    agent.withdraw(asked.id);
    expect((await asked.response).error?.code).toBe(-32800);
    await drafts.untilType('permission_resolved');
    const { requestId } = drafts.of('permission_request')[0].data;
    expect(drafts.of('permission_resolved')[0].data).toEqual({ requestId, decision: 'cancelled', by: 'agent' });
    await expect(session.respondPermission(requestId, 'allow')).rejects.toThrow(/No open permission/);
  });

  it('cancels a permission request for another session without asking', async () => {
    const { agent, drafts } = await open();
    const asked = agent.requestPermission('session-stale', { toolCallId: 't1', title: 'Run ls' });
    expect((await asked.response).result).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(drafts.of('permission_request')).toEqual([]);
  });

  it('asks a form elicitation as questions and answers with typed content', async () => {
    const { agent, session, drafts } = await open({}, {}, { ...SPEC, claims: { questions: true } });
    expect(session.capabilities.questions).toBe(true);
    const asked = agent.elicit({
      mode: 'form', sessionId: 'session-1', message: 'Settings?',
      requestedSchema: { type: 'object', properties: {
        name: { type: 'string', title: 'Name' },
        color: { type: 'string', title: 'Color', oneOf: [{ const: 'r', title: 'Red' }, { const: 'g', title: 'Green' }] },
        ok: { type: 'boolean', title: 'OK?' },
        count: { type: 'integer', title: 'Count' },
        tags: { type: 'array', title: 'Tags', items: { enum: ['a', 'b'] } },
      } },
    });
    await drafts.untilType('question');
    const q = drafts.of('question')[0].data;
    expect(q.questions.map((x) => [x.id, x.prompt, x.allowFreeText, x.multiSelect ?? false, x.options?.map((o) => o.id)])).toEqual([
      ['name', 'Name', true, false, undefined],
      ['color', 'Color', false, false, ['r', 'g']],
      ['ok', 'OK?', false, false, ['true', 'false']],
      ['count', 'Count', true, false, undefined],
      ['tags', 'Tags', false, true, ['a', 'b']],
    ]);
    await expect(session.answerQuestion(q.requestId, { count: '2.5' })).rejects.toThrow(/don't fit/);
    await session.answerQuestion(q.requestId, { name: 'x', color: 'g', ok: 'true', count: '3', tags: ['a', 'b'] });
    expect((await asked.response).result).toEqual({ action: 'accept', content: { name: 'x', color: 'g', ok: true, count: 3, tags: ['a', 'b'] } });
  });

  it('declines a form chat cannot show, and says so', async () => {
    const { agent, drafts } = await open();
    const asked = agent.elicit({ mode: 'form', sessionId: 'session-1', message: 'Pick', requestedSchema: { properties: { x: { type: 'object' } as never } } });
    expect((await asked.response).result).toEqual({ action: 'decline' });
    expect(drafts.of('question')).toEqual([]);
    expect(drafts.of('notice')[0].data.code).toBe('question_unsupported');
  });

  it('declines URL elicitation, which it never advertised', async () => {
    const { agent } = await open();
    const asked = agent.elicit({ mode: 'url', sessionId: 'session-1', message: 'Open' });
    expect((await asked.response).result).toEqual({ action: 'decline' });
  });

  it('answers client methods it did not advertise with method-not-found', async () => {
    const { agent, drafts } = await open();
    expect((await agent.requestClient('fs/read_text_file', { sessionId: 'session-1', path: '/etc/hosts' }).response).error?.code).toBe(-32601);
    expect((await agent.requestClient('x/custom', {}).response).error?.code).toBe(-32601);
    expect(drafts.of('protocol_unknown').map((d) => d.data)).toEqual([{ driver: TEST_DRIVER_ID, kind: 'request', name: 'x/custom' }]);
  });
});

describe('ACP driver: cancel', () => {
  it('closes open requests as cancelled, sends session/cancel, and ends the turn only when the agent reports it', async () => {
    const { agent, session, drafts } = await open({}, {}, { ...SPEC, claims: { questions: true } });
    await session.send([{ type: 'text', text: 'x' }], 'prompt');
    const prompt = await agent.nextPrompt();
    const perm = agent.requestPermission(prompt.sessionId, { toolCallId: 't1', title: 'Run' });
    const question = agent.elicit({ mode: 'form', sessionId: prompt.sessionId, message: 'Sure?', requestedSchema: { properties: {} } });
    await drafts.untilType('question');
    const cancelled = agent.cancelled();
    await session.interrupt();
    await cancelled;
    expect((await perm.response).result).toEqual({ outcome: { outcome: 'cancelled' } });
    expect((await question.response).result).toEqual({ action: 'cancel' });
    // The driver's own cancellation, not an answer from the user (QA A-2).
    expect(drafts.of('permission_resolved')[0].data).toMatchObject({ decision: 'cancelled', by: 'agent' });
    expect(drafts.of('question_resolved')[0].data).toMatchObject({ cancelled: true });
    // Cancel sent is not the turn ending.
    await settle();
    expect(drafts.of('turn_ended')).toEqual([]);
    prompt.end('cancelled');
    await drafts.untilType('turn_ended');
    expect(drafts.of('turn_ended')[0].data.stopReason).toBe('cancelled');
  });

  it('does not assume a cancelled ending when the agent is lost after the cancel', async () => {
    const { agent, session, drafts } = await open();
    await session.send([{ type: 'text', text: 'x' }], 'prompt');
    await agent.nextPrompt();
    const cancelled = agent.cancelled();
    await session.interrupt();
    await cancelled;
    agent.disconnect({ code: null, signal: 'SIGKILL' });
    await drafts.untilEnd();
    expect(drafts.of('turn_ended')).toEqual([]);
    expect(drafts.of('error')[0].data).toMatchObject({ code: 'process_exited', message: expect.stringContaining('unknown') });
  });

  it('does nothing between turns', async () => {
    const { agent, session } = await open();
    await session.interrupt();
    await settle();
    expect(agent.sentRequests('session/cancel')).toEqual([]);
  });
});

describe('ACP driver: disconnect', () => {
  it('reports the exit and leaves the running turn and open requests unresolved', async () => {
    const { agent, session, drafts } = await open();
    expect(closed(session)).toBe(false);
    await session.send([{ type: 'text', text: 'x' }], 'prompt');
    const prompt = await agent.nextPrompt();
    agent.requestPermission(prompt.sessionId, { toolCallId: 't1', title: 'Run' });
    await drafts.untilType('permission_request');
    agent.disconnect({ code: 137, signal: null });
    await drafts.untilEnd();
    expect(drafts.of('error')[0].data).toMatchObject({ code: 'process_exited', fatal: true, message: expect.stringContaining('unknown') });
    expect(drafts.of('turn_ended')).toEqual([]);
    expect(drafts.of('permission_resolved')).toEqual([]);
    expect(closed(session)).toBe(true);
    await expect(session.send([{ type: 'text', text: 'again' }], 'prompt')).rejects.toThrow(/not open/);
  });

  it('close sends session/close when advertised and reports no error', async () => {
    const { agent, session, drafts } = await open();
    await session.close();
    await drafts.untilEnd();
    expect(agent.sentRequests('session/close')).toEqual([{ sessionId: 'session-1' }]);
    expect(drafts.of('error')).toEqual([]);
  });

  it('close skips session/close when not advertised', async () => {
    const { agent, session } = await open({ initialize: { protocolVersion: 1 } });
    await session.close();
    expect(agent.sentRequests('session/close')).toEqual([]);
  });
});

describe('ACP driver: history and resume', () => {
  const history = [
    { sessionUpdate: 'user_message_chunk' as const, content: { type: 'text' as const, text: 'old question' } },
    { sessionUpdate: 'agent_message_chunk' as const, content: { type: 'text' as const, text: 'old answer' } },
    { sessionUpdate: 'available_commands_update' as const, availableCommands: [{ name: 'review', description: 'Review' }] },
  ];

  it('loads with session/load and swallows the replay, keeping its session state', async () => {
    const { agent, session, drafts } = await open({ sessions: { 'old-1': history } }, { resumeNativeSessionId: 'old-1' });
    expect(agent.sentRequests('session/load')).toEqual([{ sessionId: 'old-1', cwd: '/work', mcpServers: [] }]);
    expect(session.nativeSessionId).toBe('old-1');
    expect(session.resumeTiming).toMatchObject({ loadMs: expect.any(Number), firstReplyMs: expect.any(Number) });
    expect(session.capabilities.slashCommands).toBe(true);
    await settle();
    expect(drafts.all.map((d) => d.type)).toEqual(['session_info']);
  });

  it('prefers session/resume when advertised', async () => {
    const { agent, session } = await open(
      { sessions: { 'old-1': history }, initialize: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } } },
      { resumeNativeSessionId: 'old-1' },
    );
    expect(agent.sentRequests('session/resume')).toEqual([{ sessionId: 'old-1', cwd: '/work', mcpServers: [] }]);
    expect(agent.sentRequests('session/load')).toEqual([]);
    expect(session.resumeTiming).toBeUndefined();
  });

  it('starts fresh, with a notice, when the agent no longer has the session', async () => {
    const { agent, session, drafts } = await open({}, { resumeNativeSessionId: 'gone' });
    expect(agent.sentRequests('session/new')).toHaveLength(1);
    expect(session.resumeFallback).toBe('not_found');
    expect(drafts.of('notice')[0].data.code).toBe('resume_unavailable');
  });

  it('starts fresh, with a notice, when the agent cannot reopen sessions at all', async () => {
    const { agent, session } = await open({ initialize: { protocolVersion: 1 } }, { resumeNativeSessionId: 'old-1' });
    expect(agent.sentRequests('session/load')).toEqual([]);
    expect(session.resumeFallback).toBe('not_found');
  });

  it('ignores updates for another session', async () => {
    const { agent, drafts } = await open();
    agent.update('session-other', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'stale' } });
    agent.update('session-1', { sessionUpdate: 'session_info_update', title: 'Mine' });
    await drafts.until((all) => all.some((d) => d.type === 'session_info' && d.data.title === 'Mine'));
    expect(drafts.of('agent_message_chunk')).toEqual([]);
  });
});

describe('ACP driver: config and unknowns', () => {
  it('switches model and effort through session/set_config_option', async () => {
    const { agent, session, drafts } = await open({ configOptions: MODEL_OPTIONS });
    await session.setModel('large', 'high');
    expect(agent.sentRequests('session/set_config_option')).toEqual([
      { sessionId: 'session-1', configId: 'model', value: 'large' },
      { sessionId: 'session-1', configId: 'thinking', value: 'high' },
    ]);
    expect(drafts.of('model_changed').map((d) => d.data)).toEqual([{ modelId: 'large', effort: 'low' }, { modelId: 'large', effort: 'high' }]);
    await expect(session.setModel('large', null)).rejects.toThrow(/default/);
  });

  it('applies the requested model at start, and says when it cannot', async () => {
    const applied = await open({ configOptions: MODEL_OPTIONS }, { model: 'large' });
    expect(applied.agent.sentRequests('session/set_config_option')).toEqual([{ sessionId: 'session-1', configId: 'model', value: 'large' }]);
    const none = await open({}, { model: 'large' });
    expect(none.drafts.of('notice')[0].data.code).toBe('model_not_applied');
  });

  it('has no live levels or compaction', async () => {
    const { session } = await open();
    await expect(session.setLevel('auto')).rejects.toThrow(/no live permission levels/);
    await expect(session.compact()).rejects.toThrow(/no compaction/);
  });

  it('reports unknown and unmapped update kinds and notifications, but not user echoes', async () => {
    const { agent, drafts } = await open();
    agent.update('session-1', { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'echo' } });
    agent.update('session-1', { sessionUpdate: 'hologram' });
    agent.update('session-1', { sessionUpdate: 'current_mode_update', currentModeId: 'x' });
    agent.notify('x/ping', {});
    await drafts.untilType('protocol_unknown', 3);
    expect(drafts.of('protocol_unknown').map((d) => d.data)).toEqual([
      { driver: TEST_DRIVER_ID, kind: 'field', name: 'session/update:hologram' },
      { driver: TEST_DRIVER_ID, kind: 'field', name: 'session/update:current_mode_update' },
      { driver: TEST_DRIVER_ID, kind: 'notification', name: 'x/ping' },
    ]);
  });

  it('passes MCP servers: stdio as baseline, HTTP only when advertised, secrets from env by name', async () => {
    const mcp = { mcpServers: { clubhouse: { command: '/bin/bridge', args: ['--x'], env: { A: '1' } }, web: { type: 'http', url: 'https://x' } }, mcpHttpEndpoints: { clubhouse: { url: 'http://127.0.0.1:1/mcp', headersFromEnv: { 'X-Nonce': 'NONCE' } } }, env: { NONCE: 'n1' } };
    const stdioOnly = await open({}, mcp);
    expect(stdioOnly.agent.sentRequests('session/new')[0]).toMatchObject({ mcpServers: [{ name: 'clubhouse', command: '/bin/bridge', args: ['--x'], env: [{ name: 'A', value: '1' }] }] });
    expect(stdioOnly.drafts.of('notice')[0].data).toMatchObject({ code: 'mcp_servers_unsupported', message: expect.stringContaining('web') });
    const http = await open({ initialize: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } } } }, mcp);
    expect(http.agent.sentRequests('session/new')[0]).toMatchObject({ mcpServers: [
      { type: 'http', name: 'clubhouse', url: 'http://127.0.0.1:1/mcp', headers: [{ name: 'X-Nonce', value: 'n1' }] },
      { type: 'http', name: 'web', url: 'https://x', headers: [] },
    ] });
  });

  it('cancels a start in progress: no session is opened and the transport is closed', async () => {
    const agent = new ScriptedAcpAgent({ initialize: FULL_INIT });
    const driver = createAcpChatDriver(SPEC, { connect: () => agent.connector });
    const controller = new AbortController();
    const started = driver.start({ ...START, signal: controller.signal });
    controller.abort();
    await expect(started).rejects.toThrow(/cancelled/);
    await settle();
    expect(agent.isOpen).toBe(false);
    expect(agent.sentRequests('session/new')).toEqual([]);
    expect(agent.sentRequests('session/close')).toEqual([]);
  });

  it('applies updates sent before session/new answered in order, so the requested model wins', async () => {
    const stale = { sessionUpdate: 'config_option_update' as const, configOptions: MODEL_OPTIONS };
    const { agent, session, drafts } = await open({ configOptions: MODEL_OPTIONS, beforeNewReply: [stale, { sessionUpdate: 'session_info_update', title: 'Early' }] }, { model: 'large' });
    expect(agent.sentRequests('session/set_config_option')).toEqual([{ sessionId: 'session-1', configId: 'model', value: 'large' }]);
    await drafts.until((all) => all.some((d) => d.type === 'session_info' && d.data.title === 'Early'));
    expect(drafts.of('session_info')[0].data.model).toBe('large');
    expect(drafts.of('model_changed')).toEqual([]);
    await session.setModel('large', 'high');
    expect(agent.sentRequests('session/set_config_option')).toHaveLength(2);
  });

  it('changes effort alone when the caller passes the current model (the UI and Annex do)', async () => {
    const { agent, session } = await open({ configOptions: MODEL_OPTIONS });
    await session.setModel('small', 'high');
    expect(agent.sentRequests('session/set_config_option')).toEqual([{ sessionId: 'session-1', configId: 'thinking', value: 'high' }]);
  });

  it('rejects a model it cannot apply instead of ignoring it (QA A-3)', async () => {
    const effortOnly = await open({ configOptions: [MODEL_OPTIONS[1]] });
    expect(effortOnly.session.capabilities).toMatchObject({ modelSwitch: 'none', effortSwitch: 'live' });
    await expect(effortOnly.session.setModel('whatever', 'high')).rejects.toThrow(/no model choice/);
    await expect(effortOnly.session.setModel('whatever')).rejects.toThrow(/no model choice/);
    const offered = await open({ configOptions: MODEL_OPTIONS });
    await expect(offered.session.setModel('huge', 'high')).rejects.toThrow(/doesn't offer model "huge"/);
    expect([...effortOnly.agent.sentRequests('session/set_config_option'), ...offered.agent.sentRequests('session/set_config_option')]).toEqual([]);
  });
});
