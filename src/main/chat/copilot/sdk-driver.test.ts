import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import {
  CopilotSdkChatDriver,
  createCopilotSdkChatDriver,
  toSdkMcpServers,
  sdkUnsupportedReason,
  type SdkClientLike,
  type SdkModuleLike,
  type SdkSessionConfig,
  type SdkSessionLike,
} from './sdk-driver';
import { CopilotSdkEventMapper, toolKindFor } from './sdk-events';
import type { ChatEventDraft } from '../../../shared/chat/events';
import type { ChatDriver, ChatDriverSession, ChatDriverStartOptions } from '../../../shared/chat/runtime';

/** In-memory stand-in for the SDK: records calls and lets a test emit session events. */
function fakeSdk(opts: { startError?: Error; pingError?: () => Error | undefined } = {}) {
  const bus = new EventEmitter();
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let config: SdkSessionConfig | undefined;
  const session: SdkSessionLike = {
    sessionId: 'native-1',
    send: async (o) => { calls.push({ method: 'send', args: [o] }); return 'm1'; },
    on: (handler) => { bus.on('event', handler); return () => bus.off('event', handler); },
    abort: async () => { calls.push({ method: 'abort', args: [] }); },
    setModel: async (...args) => { calls.push({ method: 'setModel', args }); },
    disconnect: async () => { calls.push({ method: 'disconnect', args: [] }); },
    rpc: {
      mode: { set: async (p) => { calls.push({ method: 'mode.set', args: [p] }); } },
      permissions: { setMode: async (p) => { calls.push({ method: 'permissions.setMode', args: [p] }); } },
    },
  };
  const client: SdkClientLike = {
    start: async () => { if (opts.startError) throw opts.startError; },
    stop: async () => { calls.push({ method: 'stop', args: [] }); return []; },
    ping: async () => { const e = opts.pingError?.(); if (e) throw e; return {}; },
    getStatus: async () => ({ version: '1.0.98', protocolVersion: 3 }),
    createSession: async (c) => { config = c; calls.push({ method: 'createSession', args: [c] }); return session; },
    resumeSession: async (id, c) => { config = c; calls.push({ method: 'resumeSession', args: [id, c] }); return session; },
  };
  const connections: unknown[] = [];
  const sdk: SdkModuleLike = {
    CopilotClient: function FakeCopilotClient() { return client; } as unknown as SdkModuleLike['CopilotClient'],
    RuntimeConnection: { forStdio: (o) => { connections.push(o); return { kind: 'stdio', ...o }; } },
  };
  return {
    sdk,
    calls,
    connections,
    emit: (type: string, data: unknown = {}) => bus.emit('event', { type, data }),
    config: () => config!,
  };
}

const startOpts = (extra: Partial<ChatDriverStartOptions> = {}): ChatDriverStartOptions => ({
  agentId: 'a1', provider: 'copilot-cli', cwd: '/work', binaryPath: '/usr/local/bin/copilot', level: 'ask', ...extra,
});

async function next(session: ChatDriverSession, count: number): Promise<ChatEventDraft[]> {
  const out: ChatEventDraft[] = [];
  const it = session.events[Symbol.asyncIterator]();
  while (out.length < count) {
    const r = await it.next();
    if (r.done) break;
    out.push(r.value);
  }
  return out;
}

describe('copilot_sdk driver', () => {
  it("runs the user's copilot through forStdio and reports the session", async () => {
    const fake = fakeSdk();
    const driver = new CopilotSdkChatDriver({ loadSdk: async () => fake.sdk, heartbeatMs: 0 });
    const session = await driver.start(startOpts({
      model: 'gpt-5-mini',
      effort: 'low',
      extraArgs: ['--agent', 'x'],
      systemPrompt: 'You are a Clubhouse agent.',
      mcpServers: { clubhouse: { type: 'stdio', command: 'node', args: ['bridge.js'], env: { CLUBHOUSE_MCP_PORT: '1' } } },
    }));

    expect(fake.connections).toEqual([{ path: '/usr/local/bin/copilot', args: ['--agent', 'x'], env: undefined }]);
    expect(fake.config()).toMatchObject({
      workingDirectory: '/work',
      streaming: true,
      model: 'gpt-5-mini',
      reasoningEffort: 'low',
      systemMessage: { mode: 'append', content: 'You are a Clubhouse agent.' },
      mcpServers: { clubhouse: { type: 'stdio', command: 'node', args: ['bridge.js'], env: { CLUBHOUSE_MCP_PORT: '1' } } },
    });
    // The start level (ask) is applied: manual approvals, interactive mode.
    expect(fake.calls.filter((c) => c.method.includes('.')).map((c) => [c.method, c.args[0]])).toEqual([
      ['permissions.setMode', { mode: 'manual' }],
      ['mode.set', { mode: 'interactive' }],
    ]);
    expect(session.nativeSessionId).toBe('native-1');
    expect(session.capabilities).toMatchObject({
      steer: true, queue: 'native', resume: 'native', systemPrompt: true, liveLevels: ['plan', 'ask', 'full_access'],
      permissionExtras: { denyMessage: true, updatedInput: false },
    });
    expect(await next(session, 1)).toEqual([{
      type: 'session_info',
      data: { nativeSessionId: 'native-1', cliVersion: '1.0.98', levelNames: { plan: 'Plan', ask: 'Interactive', full_access: 'Interactive, allow all' } },
    }]);
  });

  it('runs a turn from send to session.idle, steering and queueing in between', async () => {
    const fake = fakeSdk();
    const session = await new CopilotSdkChatDriver({ loadSdk: async () => fake.sdk, heartbeatMs: 0 }).start(startOpts());
    await next(session, 1);

    expect(await session.send([{ type: 'text', text: 'hi' }], 'prompt')).toBe('prompt');
    expect(await session.send([{ type: 'text', text: 'also this' }], 'steer')).toBe('steer');
    expect(await session.send([{ type: 'text', text: 'later' }], 'queued')).toBe('queued');
    expect(fake.calls.filter((c) => c.method === 'send').map((c) => c.args[0])).toEqual([
      { prompt: 'hi' },
      { prompt: 'also this', mode: 'immediate' },
      { prompt: 'later', mode: 'enqueue' },
    ]);

    fake.emit('assistant.message_delta', { messageId: 'm', deltaContent: 'Hel' });
    fake.emit('tool.execution_start', { toolCallId: 't1', toolName: 'view', arguments: { path: 'a.ts' } });
    fake.emit('tool.execution_complete', { toolCallId: 't1', success: true, result: { content: 'x' } });
    fake.emit('assistant.usage', { model: 'gpt-5-mini', inputTokens: 10, outputTokens: 2, cacheReadTokens: 4 });
    fake.emit('session.idle', {});
    const drafts = await next(session, 6);
    expect(drafts.map((d) => d.type)).toEqual(['turn_started', 'agent_message_chunk', 'tool_call', 'tool_call_update', 'usage', 'turn_ended']);
    expect(drafts[2]).toMatchObject({ data: { toolCallId: 't1', kind: 'read', status: 'in_progress', rawInput: { path: 'a.ts' } } });
    expect(drafts[4]).toEqual({ type: 'usage', data: { scope: 'turn', tokens: { input: 10, cachedInput: 4, output: 2 } } });
    expect(drafts[5]).toMatchObject({ type: 'turn_ended', data: { stopReason: 'end_turn' } });
  });

  it('round-trips permissions, carrying a deny message', async () => {
    const fake = fakeSdk();
    const session = await new CopilotSdkChatDriver({ loadSdk: async () => fake.sdk, heartbeatMs: 0 }).start(startOpts());
    await next(session, 1);

    const decision = fake.config().onPermissionRequest({ kind: 'shell', fullCommandText: 'rm -rf build', toolCallId: 't9' });
    const [request] = await next(session, 1);
    expect(request).toMatchObject({
      type: 'permission_request',
      data: { title: 'shell: rm -rf build', toolCallId: 't9', options: [{ optionId: 'approve-once', kind: 'allow_once' }, { optionId: 'reject', kind: 'reject_once' }] },
    });
    const requestId = request.type === 'permission_request' ? request.data.requestId : '';
    await session.respondPermission(requestId, 'reject', { message: 'use git clean instead' });
    await expect(decision).resolves.toEqual({ kind: 'reject', feedback: 'use git clean instead' });
    await expect(session.respondPermission(requestId, 'approve-once')).rejects.toThrow(/No pending/);
  });

  it('interrupt aborts the turn and releases pending permissions', async () => {
    const fake = fakeSdk();
    const session = await new CopilotSdkChatDriver({ loadSdk: async () => fake.sdk, heartbeatMs: 0 }).start(startOpts());
    await next(session, 1);
    await session.send([{ type: 'text', text: 'go' }], 'prompt');
    const decision = fake.config().onPermissionRequest({ kind: 'write', fileName: 'a.ts' });
    await session.interrupt();
    await expect(decision).resolves.toEqual({ kind: 'user-not-available' });
    fake.emit('session.idle', { aborted: true });
    const drafts = await next(session, 3);
    expect(drafts[drafts.length - 1]).toMatchObject({ type: 'turn_ended', data: { stopReason: 'cancelled' } });
    expect(fake.calls.some((c) => c.method === 'abort')).toBe(true);
  });

  it('ends the stream with a fatal error when copilot stops answering pings', async () => {
    let dead = false;
    const fake = fakeSdk({ pingError: () => (dead ? new Error('connection closed') : undefined) });
    const session = await new CopilotSdkChatDriver({ loadSdk: async () => fake.sdk, heartbeatMs: 5 }).start(startOpts());
    await session.send([{ type: 'text', text: 'go' }], 'prompt');
    dead = true;
    const drafts: ChatEventDraft[] = [];
    for await (const d of session.events) drafts.push(d);
    expect(drafts.slice(-2)).toEqual([
      { type: 'error', data: { code: 'process_exited', message: 'Copilot stopped responding: connection closed', fatal: true } },
      expect.objectContaining({ type: 'turn_ended', data: expect.objectContaining({ stopReason: 'error' }) }),
    ]);
  });

  it('switches levels through the session and permission modes', async () => {
    const fake = fakeSdk();
    const session = await new CopilotSdkChatDriver({ loadSdk: async () => fake.sdk, heartbeatMs: 0 }).start(startOpts({ level: 'auto' }));
    // auto isn't offered, so start keeps Copilot's default instead of guessing.
    expect(fake.calls.some((c) => c.method.includes('.'))).toBe(false);
    await session.setLevel('full_access');
    await session.setLevel('plan');
    expect(fake.calls.filter((c) => c.method.includes('.')).map((c) => [c.method, c.args[0]])).toEqual([
      ['permissions.setMode', { mode: 'allow-all' }], ['mode.set', { mode: 'interactive' }],
      ['permissions.setMode', { mode: 'manual' }], ['mode.set', { mode: 'plan' }],
    ]);
    await expect(session.setLevel('auto_edit')).rejects.toThrow(/no auto_edit level/);
  });

  it('maps Clubhouse MCP definitions to the SDK config', () => {
    expect(toSdkMcpServers({
      local: { command: 'node', args: ['x.js'] },
      remote: { type: 'streamable-http', url: 'https://example.test/mcp', headers: { A: 'b' } },
      events: { type: 'sse', url: 'https://example.test/sse' },
      broken: { transport: 'ws' },
    })).toEqual({
      local: { type: 'stdio', command: 'node', args: ['x.js'] },
      remote: { type: 'http', url: 'https://example.test/mcp', headers: { A: 'b' } },
      events: { type: 'sse', url: 'https://example.test/sse' },
    });
  });

  it('resumes natively', async () => {
    const fake = fakeSdk();
    await new CopilotSdkChatDriver({ loadSdk: async () => fake.sdk, heartbeatMs: 0 }).start(startOpts({ resumeNativeSessionId: 'old' }));
    expect(fake.calls.find((c) => c.method === 'resumeSession')?.args[0]).toBe('old');
  });

  describe('fallback to copilot_acp', () => {
    const fallbackDriver = () => {
      const session = {
        nativeSessionId: 'acp-1',
        capabilities: { steer: false },
        events: (async function* () { yield { type: 'session_info', data: { nativeSessionId: 'acp-1' } } as ChatEventDraft; })(),
        close: vi.fn(async () => undefined),
      } as unknown as ChatDriverSession;
      const driver = { id: 'copilot_acp', provider: 'copilot-cli', start: vi.fn(async () => session), probe: vi.fn() } as unknown as ChatDriver;
      return { driver, session };
    };

    it.each([
      ['a Windows batch shim', { binaryPath: 'C:\\Users\\me\\AppData\\Roaming\\npm\\copilot.cmd' }, /batch shim/],
      ['a command prefix', { commandPrefix: 'source ~/.envrc' }, /command prefix/],
    ])('falls back for %s without loading the SDK', async (_label, extra, reason) => {
      const loadSdk = vi.fn();
      const { driver: fallback } = fallbackDriver();
      const session = await new CopilotSdkChatDriver({ loadSdk, fallback }).start(startOpts(extra));
      expect(loadSdk).not.toHaveBeenCalled();
      const drafts = await next(session, 2);
      expect(drafts[0]).toMatchObject({ type: 'notice', data: { code: 'fallback', message: expect.stringMatching(reason) } });
      expect(drafts[1]).toMatchObject({ type: 'session_info', data: { nativeSessionId: 'acp-1' } });
      expect(session.nativeSessionId).toBe('acp-1');
    });

    it('falls back when the handshake fails (e.g. protocol version mismatch)', async () => {
      const fake = fakeSdk({ startError: new Error('SDK protocol version mismatch: SDK supports versions 2-3, but server reports version 4') });
      const { driver: fallback } = fallbackDriver();
      const session = await new CopilotSdkChatDriver({ loadSdk: async () => fake.sdk, fallback }).start(startOpts());
      const [notice] = await next(session, 1);
      expect(notice).toMatchObject({ type: 'notice', data: { code: 'fallback', message: expect.stringContaining('protocol version mismatch') } });
    });

    it('fails clearly without a fallback', async () => {
      await expect(new CopilotSdkChatDriver({ loadSdk: vi.fn() }).start(startOpts({ commandPrefix: 'x' }))).rejects.toThrow(/cannot start/);
    });
  });

  it('production factory falls back to copilot_acp', () => {
    const driver = createCopilotSdkChatDriver();
    expect(driver.id).toBe('copilot_sdk');
    expect(driver.provider).toBe('copilot-cli');
  });

  it('probes with a handshake only', async () => {
    const fake = fakeSdk();
    const probe = await new CopilotSdkChatDriver({ loadSdk: async () => fake.sdk }).probe('/usr/local/bin/copilot');
    expect(probe).toMatchObject({ handshakeOk: true, cliVersion: '1.0.98' });
    expect(fake.calls.map((c) => c.method)).toEqual(['stop']);
  });
});

describe('Copilot SDK event mapping', () => {
  it('maps final messages and reasoning, title and model changes, and errors', () => {
    const m = new CopilotSdkEventMapper();
    expect(m.map({ type: 'assistant.message', data: { messageId: 'm', content: 'Done' } })).toEqual([{ type: 'agent_message', data: { messageId: 'm', text: 'Done' } }]);
    expect(m.map({ type: 'assistant.reasoning_delta', data: { reasoningId: 'r', deltaContent: 'hmm', parentToolCallId: 'task-1' } }))
      .toEqual([{ type: 'agent_thought_chunk', data: { messageId: 'r', text: 'hmm', subagentId: 'task-1' } }]);
    expect(m.map({ type: 'session.title_changed', data: { title: 'Fix the parser' } })).toEqual([{ type: 'session_info', data: { title: 'Fix the parser' } }]);
    expect(m.map({ type: 'session.model_change', data: { newModel: 'claude-sonnet-5.5', reasoningEffort: 'high' } }))
      .toEqual([{ type: 'model_changed', data: { modelId: 'claude-sonnet-5.5', effort: 'high' } }]);
    expect(m.map({ type: 'session.error', data: { errorType: 'rate_limit', message: 'Slow down' } }))
      .toEqual([{ type: 'error', data: { code: 'rate_limited', message: 'Slow down', fatal: false } }]);
    expect(m.map({ type: 'tool.execution_complete', data: { toolCallId: 't', success: false, error: { message: 'boom' } } }))
      .toEqual([{ type: 'tool_call_update', data: { toolCallId: 't', status: 'failed', error: 'boom' } }]);
  });

  it('ignores known events and reports each unknown type once', () => {
    const m = new CopilotSdkEventMapper();
    expect(m.map({ type: 'assistant.turn_start', data: {} })).toEqual([]);
    expect(m.map({ type: 'session.fusion_resolved', data: {} })).toEqual([{ type: 'protocol_unknown', data: { driver: 'copilot_sdk', kind: 'field', name: 'event:session.fusion_resolved' } }]);
    expect(m.map({ type: 'session.fusion_resolved', data: {} })).toEqual([]);
  });

  it('classifies tool names into kinds', () => {
    expect(['view', 'edit', 'bash', 'grep', 'web_fetch', 'task'].map(toolKindFor)).toEqual(['read', 'edit', 'execute', 'search', 'fetch', 'other']);
  });

  it('says why a launch is unsupported', () => {
    expect(sdkUnsupportedReason({ binaryPath: '/usr/local/bin/copilot' })).toBeNull();
    expect(sdkUnsupportedReason({ binaryPath: 'copilot.CMD' })).toMatch(/batch shim/);
  });
});
