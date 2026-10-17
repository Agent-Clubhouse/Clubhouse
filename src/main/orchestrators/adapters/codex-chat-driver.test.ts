import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'child_process';
import {
  appServerArgs,
  CODEX_CHAT_CAPABILITIES,
  CODEX_SLASH_COMMANDS,
  parseCodexSlashCommand,
  CodexChatDriver,
  codexLevelSettings,
  codexSandboxPolicy,
  parseCodexVersion,
} from './codex-chat-driver';
import { MINIMAL_CHAT_CAPABILITIES } from '../../../shared/chat/capabilities';
import type { ChatEventDraft } from '../../../shared/chat/events';
import type { ChatDriverStartOptions } from '../../../shared/chat/runtime';
import * as fx from './codex-protocol/__fixtures__/app-server-session';

const mockSpawn = vi.mocked(spawn);

type Handler = (params: unknown) => { result?: unknown; error?: { code: number; message: string } };

/**
 * A scripted `codex app-server`: answers requests from `handlers` as soon as
 * the client writes them, and lets tests push server messages.
 */
function createFakeServer(handlers: Record<string, Handler>) {
  const stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  const stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  const received: Record<string, unknown>[] = [];
  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    exitCode: null as number | null,
    pid: 1,
    kill: vi.fn(() => {
      proc.exitCode = 0;
      proc.emit('exit', null, 'SIGTERM');
    }),
    stdin: {
      writable: true,
      write: vi.fn((chunk: string) => {
        const msg = JSON.parse(chunk);
        received.push(msg);
        if (msg.id !== undefined && typeof msg.method === 'string') {
          const handler = handlers[msg.method];
          const reply = handler ? handler(msg.params) : { result: {} };
          server.send({ id: msg.id, ...reply });
        }
        return true;
      }),
    },
  });
  const server = {
    proc,
    received,
    send(msg: unknown) {
      stdout.emit('data', JSON.stringify(msg) + '\n');
    },
    requests(method: string) {
      return received.filter((m) => m.method === method && m.id !== undefined);
    },
    exit(code: number) {
      proc.exitCode = code;
      proc.emit('exit', code, null);
    },
  };
  return server;
}

const defaultHandlers: Record<string, Handler> = {
  'review/start': () => ({ result: { turn: fx.turnStartResult.turn, reviewThreadId: fx.THREAD_ID } }),
  'initialize': () => ({ result: fx.initializeResult }),
  'thread/start': () => ({ result: fx.threadStartResult }),
  'thread/resume': () => ({ result: fx.threadResumeResult }),
  'turn/start': () => ({ result: fx.turnStartResult }),
  'turn/steer': () => ({ result: fx.turnSteerResult }),
  'turn/interrupt': () => ({ result: {} }),
  'thread/compact/start': () => ({ result: {} }),
};

const baseOpts: ChatDriverStartOptions = {
  agentId: 'agent-1',
  provider: 'codex-cli',
  cwd: 'workspace',
  binaryPath: 'codex',
  level: 'auto_edit',
};

/** Consume the opening session_started and commands_available. */
async function skipStart(take: (n: number) => Promise<ChatEventDraft[]>): Promise<void> {
  const opening = await take(2);
  expect(opening.map((e) => e.type)).toEqual(['session_started', 'commands_available']);
}

describe('CodexChatDriver', () => {
  let server: ReturnType<typeof createFakeServer>;

  function useServer(overrides: Record<string, Handler> = {}) {
    server = createFakeServer({ ...defaultHandlers, ...overrides });
    mockSpawn.mockReturnValue(server.proc as unknown as ReturnType<typeof spawn>);
  }

  beforeEach(() => useServer());

  async function startSession(opts: Partial<ChatDriverStartOptions> = {}) {
    const session = await new CodexChatDriver().start({ ...baseOpts, ...opts });
    const iterator = session.events[Symbol.asyncIterator]();
    const next = async (): Promise<ChatEventDraft> => {
      const r = await iterator.next();
      if (r.done) throw new Error('event stream ended');
      return r.value;
    };
    const take = async (n: number) => {
      const out: ChatEventDraft[] = [];
      for (let i = 0; i < n; i++) out.push(await next());
      return out;
    };
    const rest = async () => {
      const out: ChatEventDraft[] = [];
      for (let r = await iterator.next(); !r.done; r = await iterator.next()) out.push(r.value);
      return out;
    };
    return { session, next, take, rest };
  }

  // ── Start and resume ─────────────────────────────────────────────────────

  it('handshakes, starts a thread and reports session_started first', async () => {
    const { session, next } = await startSession({
      model: 'gpt-5-codex',
      systemPrompt: 'Be brief',
      mcpServers: { clubhouse: { url: 'http://127.0.0.1:1/mcp' } },
    });

    expect(mockSpawn).toHaveBeenCalledWith('codex', ['app-server'], expect.objectContaining({ cwd: 'workspace' }));
    expect(server.received.map((m) => m.method)).toEqual(['initialize', 'initialized', 'thread/start']);
    expect(server.requests('thread/start')[0].params).toEqual({
      cwd: 'workspace',
      model: 'gpt-5-codex',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      developerInstructions: 'Be brief',
      config: { mcp_servers: { clubhouse: { url: 'http://127.0.0.1:1/mcp' } } },
    });
    expect(session.nativeSessionId).toBe(fx.THREAD_ID);
    expect(await next()).toEqual({
      type: 'session_started',
      data: {
        driver: 'codex_app_server',
        provider: 'codex-cli',
        cwd: 'workspace',
        resumed: false,
        nativeSessionId: fx.THREAD_ID,
        cliVersion: '0.153.4',
        model: 'gpt-5-codex',
        level: 'auto_edit',
        capabilities: CODEX_CHAT_CAPABILITIES,
      },
    });
  });

  it('resumes a native thread', async () => {
    const { next } = await startSession({ resumeNativeSessionId: fx.THREAD_ID });

    expect(server.requests('thread/resume')[0].params).toMatchObject({ threadId: fx.THREAD_ID, excludeTurns: true, cwd: 'workspace' });
    expect(server.requests('thread/start')).toHaveLength(0);
    expect(await next()).toMatchObject({ type: 'session_started', data: { resumed: true, nativeSessionId: fx.THREAD_ID } });
  });

  it('notes a CLI version other than the one the bindings came from', async () => {
    useServer({ initialize: () => ({ result: { ...fx.initializeResult, userAgent: 'codex_cli_rs/0.163.0 (x)' } }) });
    const { take } = await startSession();

    const [, , notice] = await take(3);
    expect(notice).toMatchObject({ type: 'notice', data: { level: 'info', code: 'untested_cli_version' } });
  });

  it('holds events that arrive during start until after session_started', async () => {
    useServer({
      'thread/start': () => {
        server.send({ method: 'thread/status/changed', params: { threadId: fx.THREAD_ID, status: { type: 'idle' } } });
        return { result: fx.threadStartResult };
      },
    });
    const { take } = await startSession();

    expect((await take(3)).map((e) => e.type)).toEqual(['session_started', 'commands_available', 'session_state']);
  });

  it('rejects and kills the process when the thread cannot start', async () => {
    useServer({ 'thread/start': () => ({ error: { code: -32000, message: 'not logged in' } }) });

    await expect(new CodexChatDriver().start(baseOpts)).rejects.toThrow('not logged in');
    expect(server.proc.kill).toHaveBeenCalled();
  });

  // ── Turns ────────────────────────────────────────────────────────────────

  it('send starts a turn with the opening effort, once', async () => {
    const { session } = await startSession({ effort: 'high' });

    expect(await session.send([{ type: 'text', text: 'hi' }], 'prompt')).toBe('prompt');
    await session.send([{ type: 'text', text: 'again' }], 'prompt');

    const [first, second] = server.requests('turn/start').map((m) => m.params);
    expect(first).toEqual({ threadId: fx.THREAD_ID, input: [{ type: 'text', text: 'hi', text_elements: [] }], effort: 'high' });
    expect(second).toEqual({ threadId: fx.THREAD_ID, input: [{ type: 'text', text: 'again', text_elements: [] }] });
  });

  it('steers the running turn, and starts one when idle', async () => {
    const { session } = await startSession();

    expect(await session.send([{ type: 'text', text: 'idle steer' }], 'steer')).toBe('prompt');
    server.send(fx.completedTurnNotifications[1]); // turn/started
    expect(await session.send([{ type: 'text', text: 'live steer' }], 'steer')).toBe('steer');

    expect(server.requests('turn/steer')[0].params).toEqual({
      threadId: fx.THREAD_ID,
      input: [{ type: 'text', text: 'live steer', text_elements: [] }],
      expectedTurnId: fx.TURN_ID,
    });
  });

  it('a steer that loses the race with turn completion starts a new turn', async () => {
    useServer({
      'turn/steer': () => {
        // The turn finishes before Codex sees the steer.
        server.send(fx.interruptedTurnCompleted);
        return { error: { code: -32600, message: 'expected turn mismatch' } };
      },
    });
    const { session } = await startSession();
    server.send(fx.completedTurnNotifications[1]); // turn/started

    expect(await session.send([{ type: 'text', text: 'late' }], 'steer')).toBe('prompt');
    expect(server.requests('turn/start')[0].params).toMatchObject({ input: [{ type: 'text', text: 'late', text_elements: [] }] });
  });

  it('a steer rejected while the turn is still running is surfaced', async () => {
    useServer({ 'turn/steer': () => ({ error: { code: -32600, message: 'activeTurnNotSteerable' } }) });
    const { session } = await startSession();
    server.send(fx.completedTurnNotifications[1]);

    await expect(session.send([{ type: 'text', text: 'x' }], 'steer')).rejects.toThrow('activeTurnNotSteerable');
    expect(server.requests('turn/start')).toHaveLength(0);
  });

  it('setLevel keeps the sandbox Codex resolved for the thread', async () => {
    const userSandbox = {
      type: 'workspaceWrite' as const, writableRoots: ['workspace', 'shared-cache'], networkAccess: true,
      excludeTmpdirEnvVar: false, excludeSlashTmp: true,
    };
    useServer({ 'thread/start': () => ({ result: { ...fx.threadStartResult, sandbox: userSandbox } }) });
    const { session } = await startSession({ level: 'ask' });

    await session.setLevel('auto');
    await session.send([{ type: 'text', text: 'go' }], 'prompt');

    expect(server.requests('turn/start')[0].params).toMatchObject({ approvalPolicy: 'never', sandboxPolicy: userSandbox });
  });

  it('passes app-server options through extraArgs and drops terminal flags', async () => {
    const onLog = vi.fn();
    const session = await new CodexChatDriver({ onLog }).start({
      ...baseOpts,
      extraArgs: ['-c', 'model_verbosity="low"', '--enable=web_search', '--full-auto', '--model', 'o3', '--strict-config'],
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      'codex',
      ['app-server', '-c', 'model_verbosity="low"', '--enable=web_search', '--strict-config'],
      expect.anything(),
    );
    expect(onLog).toHaveBeenCalledWith('warn', 'Ignoring extraArgs that codex app-server does not accept', { dropped: ['--full-auto', '--model', 'o3'] });
    await session.close();
  });

  it('round-trips an additional-permissions request', async () => {
    const { session, take } = await startSession();
    await skipStart(take);

    server.send({
      method: 'item/permissions/requestApproval',
      id: 12,
      params: {
        threadId: fx.THREAD_ID, turnId: fx.TURN_ID, itemId: 'p', environmentId: null, startedAtMs: 1, cwd: 'workspace', reason: null,
        permissions: { network: { enabled: true }, fileSystem: null },
      },
    });
    expect(await take(1)).toMatchObject([{ type: 'permission_request', data: { requestId: '12' } }]);

    await session.respondPermission('12', 'grantForSession');

    expect(server.received[server.received.length - 1]).toEqual({
      id: 12,
      result: { permissions: { network: { enabled: true } }, scope: 'session' },
    });
  });

  it('attributes subagent-thread messages to the subagent and drops its lifecycle', async () => {
    const { take } = await startSession();
    await skipStart(take);

    const sub = { threadId: 'subagent-thread', turnId: 'sub-turn' };
    server.send({ method: 'turn/started', params: { threadId: sub.threadId, turn: { ...fx.turnStartResult.turn, id: 'sub-turn' } } });
    server.send({ method: 'item/agentMessage/delta', params: { ...sub, itemId: 'x', delta: 'from sub' } });
    server.send(fx.completedTurnNotifications[6]); // agent delta on our thread
    server.send({ method: 'account/rateLimits/updated', params: { rateLimits: fx.rateLimitsResult.rateLimits } });

    const [subChunk, chunk, usage] = await take(3);
    expect(subChunk).toEqual({ type: 'agent_message_chunk', data: { messageId: 'x', text: 'from sub', subagentId: 'subagent-thread' } });
    expect(chunk).toEqual({ type: 'agent_message_chunk', data: { messageId: 'item-agent-1', text: 'Running ' } });
    expect(usage).toMatchObject({ type: 'usage', data: { scope: 'session' } });
  });

  it('tags a subagent approval with its subagent id', async () => {
    const { take } = await startSession();
    await skipStart(take);

    server.send({ ...fx.commandApprovalRequest, id: 9, params: { ...fx.commandApprovalRequest.params, threadId: 'subagent-thread' } });

    const [request] = await take(1);
    expect(request).toMatchObject({ type: 'permission_request', data: { requestId: '9', subagentId: 'subagent-thread' } });
  });

  it('interrupt is a no-op when idle and targets the active turn otherwise', async () => {
    const { session } = await startSession();

    await session.interrupt();
    expect(server.requests('turn/interrupt')).toHaveLength(0);

    server.send(fx.completedTurnNotifications[1]);
    await session.interrupt();
    expect(server.requests('turn/interrupt')[0].params).toEqual({ threadId: fx.THREAD_ID, turnId: fx.TURN_ID });
  });

  it('lists its slash commands right after session_started', async () => {
    const { take } = await startSession();

    const [, commands] = await take(2);
    expect(commands).toEqual({ type: 'commands_available', data: { commands: [...CODEX_SLASH_COMMANDS] } });
  });

  it.each([
    ['/review', { type: 'uncommittedChanges' }],
    ['/review branch main', { type: 'baseBranch', branch: 'main' }],
    ['/review commit 3f2a9c1', { type: 'commit', sha: '3f2a9c1', title: null }],
    ['/review focus on error handling', { type: 'custom', instructions: 'focus on error handling' }],
  ])('%s starts an inline review', async (text, target) => {
    const { session } = await startSession();

    expect(await session.send([{ type: 'text', text }], 'prompt')).toBe('prompt');

    expect(server.requests('review/start')[0].params).toEqual({ threadId: fx.THREAD_ID, target, delivery: 'inline' });
    expect(server.requests('turn/start')).toHaveLength(0);
  });

  it('/compact compacts the thread instead of sending a prompt', async () => {
    const { session } = await startSession();

    await session.send([{ type: 'text', text: '/compact' }], 'prompt');

    expect(server.requests('thread/compact/start')[0].params).toEqual({ threadId: fx.THREAD_ID });
    expect(server.requests('turn/start')).toHaveLength(0);
  });

  it('refuses a slash command while a turn is running', async () => {
    const { session } = await startSession();
    server.send(fx.completedTurnNotifications[1]); // turn/started

    await expect(session.send([{ type: 'text', text: '/review' }], 'steer')).rejects.toThrow('Finish or stop the current turn before running /review');
    expect(server.requests('review/start')).toHaveLength(0);
  });

  it('rejects a malformed command without calling Codex', async () => {
    const { session } = await startSession();

    await expect(session.send([{ type: 'text', text: '/review branch --upload-pack=x' }], 'prompt')).rejects.toThrow('Usage: /review branch <name>');
    expect(server.requests('review/start')).toHaveLength(0);
    expect(server.requests('turn/start')).toHaveLength(0);
  });

  it('refuses /compact while a turn is running', async () => {
    const { session } = await startSession();
    server.send(fx.completedTurnNotifications[1]); // turn/started

    await expect(session.send([{ type: 'text', text: '/compact' }], 'prompt')).rejects.toThrow('before running /compact');
    expect(server.requests('thread/compact/start')).toHaveLength(0);
  });

  it('a second command sent before the review turn has started is refused, until that turn ends', async () => {
    const { session } = await startSession();

    await session.send([{ type: 'text', text: '/review' }], 'prompt');
    // review/start answered, but turn/started hasn't arrived yet.
    await expect(session.send([{ type: 'text', text: '/review' }], 'prompt')).rejects.toThrow('before running /review');

    server.send({ method: 'turn/completed', params: { threadId: fx.THREAD_ID, turn: { ...fx.turnStartResult.turn, status: 'completed' } } });
    await session.send([{ type: 'text', text: '/review' }], 'prompt');
    expect(server.requests('review/start')).toHaveLength(2);
  });

  it('a review turn that ends before review/start answers does not block later commands', async () => {
    useServer({
      'review/start': () => {
        server.send({ method: 'turn/completed', params: { threadId: fx.THREAD_ID, turn: { ...fx.turnStartResult.turn, status: 'completed' } } });
        return { result: { turn: fx.turnStartResult.turn, reviewThreadId: fx.THREAD_ID } };
      },
    });
    const { session } = await startSession();

    await session.send([{ type: 'text', text: '/review' }], 'prompt');
    await session.send([{ type: 'text', text: '/compact' }], 'prompt');

    expect(server.requests('thread/compact/start')).toHaveLength(1);
  });

  it('a failed review/start does not block later commands', async () => {
    let fail = true;
    useServer({ 'review/start': () => (fail ? { error: { code: -32600, message: 'not a git repository' } } : { result: { turn: fx.turnStartResult.turn, reviewThreadId: fx.THREAD_ID } }) });
    const { session } = await startSession();

    await expect(session.send([{ type: 'text', text: '/review' }], 'prompt')).rejects.toThrow('not a git repository');
    fail = false;
    await session.send([{ type: 'text', text: '/review' }], 'prompt');
    expect(server.requests('review/start')).toHaveLength(2);
  });

  it('a command refused mid-turn runs once that turn ends (queued, then drained)', async () => {
    const { session } = await startSession();
    server.send(fx.completedTurnNotifications[1]); // turn/started
    await expect(session.send([{ type: 'text', text: '/review' }], 'prompt')).rejects.toThrow();

    server.send(fx.interruptedTurnCompleted); // the running turn ends
    await session.send([{ type: 'text', text: '/review' }], 'prompt');

    expect(server.requests('review/start')).toHaveLength(1);
  });

  it('review/start does not consume pending model or level overrides', async () => {
    const { session } = await startSession();
    await session.setModel('gpt-5');

    await session.send([{ type: 'text', text: '/review' }], 'prompt');
    expect(server.requests('review/start')[0].params).not.toHaveProperty('model');
    server.send({ method: 'turn/completed', params: { threadId: fx.THREAD_ID, turn: { ...fx.turnStartResult.turn, status: 'completed' } } });

    await session.send([{ type: 'text', text: 'next' }], 'prompt');
    expect(server.requests('turn/start')[0].params).toMatchObject({ model: 'gpt-5' });
  });

  it('sends an unknown /word to the model as an ordinary prompt', async () => {
    const { session } = await startSession();

    await session.send([{ type: 'text', text: '/explain this' }], 'prompt');

    expect(server.requests('turn/start')[0].params).toMatchObject({ input: [{ type: 'text', text: '/explain this' }] });
  });

  it('compact starts thread compaction', async () => {
    const { session } = await startSession();
    await session.compact();
    expect(server.requests('thread/compact/start')[0].params).toEqual({ threadId: fx.THREAD_ID });
  });

  // ── Level and model ──────────────────────────────────────────────────────

  it('setLevel applies approval and sandbox from the next turn', async () => {
    const { session, take } = await startSession();
    await skipStart(take);

    await session.setLevel('full_access');
    expect(await take(1)).toEqual([{ type: 'mode_changed', data: { level: 'full_access', nativeMode: 'never/danger-full-access' } }]);

    await session.send([{ type: 'text', text: 'go' }], 'prompt');
    expect(server.requests('turn/start')[0].params).toMatchObject({
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    });
  });

  it('setModel applies the model and effort from the next turn', async () => {
    const { session, take } = await startSession();
    await skipStart(take);

    await session.setModel('gpt-5', 'low');
    expect(await take(1)).toEqual([{ type: 'model_changed', data: { modelId: 'gpt-5', effort: 'low' } }]);

    await session.send([{ type: 'text', text: 'go' }], 'prompt');
    expect(server.requests('turn/start')[0].params).toMatchObject({ model: 'gpt-5', effort: 'low' });
  });

  it('keeps pending overrides when turn/start fails', async () => {
    let fail = true;
    useServer({ 'turn/start': () => (fail ? { error: { code: -1, message: 'busy' } } : { result: fx.turnStartResult }) });
    const { session } = await startSession();
    await session.setModel('gpt-5');

    await expect(session.send([{ type: 'text', text: 'x' }], 'prompt')).rejects.toThrow('busy');
    fail = false;
    await session.send([{ type: 'text', text: 'x' }], 'prompt');

    expect(server.requests('turn/start')[1].params).toMatchObject({ model: 'gpt-5' });
  });

  // ── Permissions ──────────────────────────────────────────────────────────

  it('round-trips a command approval', async () => {
    const { session, take } = await startSession();
    await skipStart(take);

    server.send(fx.commandApprovalRequest);
    const [request] = await take(1);
    expect(request).toMatchObject({ type: 'permission_request', data: { requestId: '0' } });

    await session.respondPermission('0', 'execpolicy');

    expect(server.received[server.received.length - 1]).toEqual({
      id: 0,
      result: { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['npm', 'install'] } } },
    });
    expect(await take(1)).toEqual([
      { type: 'permission_resolved', data: { requestId: '0', optionId: 'execpolicy', decision: 'allow', by: 'user' } },
    ]);
    await expect(session.respondPermission('0', 'accept')).rejects.toThrow('No open Codex permission request 0');
  });

  it('round-trips a file-change approval', async () => {
    const { session, take } = await startSession();
    await skipStart(take);

    server.send(fx.fileChangeApprovalRequest);
    await take(1);
    await session.respondPermission('1', 'decline');

    expect(server.received[server.received.length - 1]).toEqual({ id: 1, result: { decision: 'decline' } });
  });

  it('declines server requests the contract cannot express', async () => {
    const { take } = await startSession();
    await skipStart(take);

    server.send({
      method: 'item/tool/call',
      id: 7,
      params: { threadId: fx.THREAD_ID, turnId: fx.TURN_ID, callId: 'c', namespace: null, tool: 't', arguments: {} },
    });

    expect(server.received[server.received.length - 1]).toMatchObject({ id: 7, error: { code: -32601 } });
    expect(await take(1)).toEqual([
      { type: 'protocol_unknown', data: { driver: 'codex_app_server', kind: 'request', name: 'item/tool/call' } },
    ]);
  });

  it('surfaces unknown notifications as protocol_unknown', async () => {
    const { take } = await startSession();
    await skipStart(take);

    server.send({ method: 'thread/brandNew', params: {} });

    expect(await take(1)).toEqual([
      { type: 'protocol_unknown', data: { driver: 'codex_app_server', kind: 'notification', name: 'thread/brandNew' } },
    ]);
  });

  it('round-trips a question', async () => {
    const { session, take } = await startSession();
    await skipStart(take);

    server.send({
      method: 'item/tool/requestUserInput',
      id: 8,
      params: {
        threadId: fx.THREAD_ID, turnId: fx.TURN_ID, itemId: 'q', isBlocking: true, autoResolutionMs: null,
        questions: [{ id: 'q1', header: '', question: 'Which?', isOther: true, isSecret: false, options: null }],
      },
    });
    expect(await take(1)).toMatchObject([{ type: 'question', data: { requestId: '8' } }]);

    await session.answerQuestion('8', { q1: 'the app' });

    expect(server.received[server.received.length - 1]).toEqual({ id: 8, result: { answers: { q1: { answers: ['the app'] } } } });
    expect(await take(1)).toEqual([{ type: 'question_resolved', data: { requestId: '8', answers: { q1: 'the app' } } }]);
    await expect(session.answerQuestion('8', {})).rejects.toThrow('No open Codex question 8');
  });

  // ── Ending ───────────────────────────────────────────────────────────────

  it('close stops the process and ends the stream as stopped', async () => {
    const { session, take, rest } = await startSession();
    await skipStart(take);

    await session.close();

    expect(server.proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(await rest()).toEqual([{ type: 'session_ended', data: { reason: 'stopped' } }]);
    await session.close(); // idempotent
    expect(server.proc.kill).toHaveBeenCalledTimes(1);
  });

  it('a crash ends the stream with the exit code', async () => {
    const { take, rest } = await startSession();
    await skipStart(take);

    server.exit(1);

    expect(await rest()).toEqual([{ type: 'session_ended', data: { reason: 'error', exitCode: 1 } }]);
  });

  // ── Probe ────────────────────────────────────────────────────────────────

  it('probe completes the handshake only and reports the CLI version', async () => {
    const probe = await new CodexChatDriver().probe('codex');

    expect(probe).toEqual({ handshakeOk: true, cliVersion: '0.153.4', capabilities: CODEX_CHAT_CAPABILITIES });
    expect(server.received.map((m) => m.method)).toEqual(['initialize', 'initialized']);
    expect(server.proc.kill).toHaveBeenCalled();
  });

  it('probe reports a failed handshake', async () => {
    useServer({ initialize: () => ({ error: { code: -32603, message: 'boom' } }) });

    const probe = await new CodexChatDriver().probe('codex');

    expect(probe).toMatchObject({ handshakeOk: false, capabilities: MINIMAL_CHAT_CAPABILITIES });
    expect(probe.error).toContain('boom');
  });
});

describe('codex driver helpers', () => {
  it.each([
    ['plan', 'on-request', 'read-only'],
    ['ask', 'untrusted', 'workspace-write'],
    ['auto_edit', 'on-request', 'workspace-write'],
    ['auto', 'never', 'workspace-write'],
    ['full_access', 'never', 'danger-full-access'],
  ] as const)('level %s → %s / %s', (level, approvalPolicy, sandbox) => {
    expect(codexLevelSettings(level)).toEqual({ approvalPolicy, sandbox });
  });

  it('parseCodexSlashCommand recognises only whole known commands', () => {
    const t = (text: string) => parseCodexSlashCommand([{ type: 'text', text }]);
    expect(t('/compact')).toEqual({ name: 'compact' });
    expect(t('  /review  ')).toEqual({ name: 'review', target: { type: 'uncommittedChanges' } });
    expect(t('/reviewer')).toBeUndefined();
    expect(t('please /review')).toBeUndefined();
    // Malformed arguments to a known command are errors, not instructions.
    expect(t('/compact now')).toEqual({ name: 'invalid', error: '/compact takes no arguments' });
    expect(t('/review branch')).toEqual({ name: 'invalid', error: 'Usage: /review branch <name>' });
    expect(t('/review branch a b')).toEqual({ name: 'invalid', error: 'Usage: /review branch <name>' });
    expect(t('/review branch -c')).toEqual({ name: 'invalid', error: 'Usage: /review branch <name>' });
    expect(t('/review commit not-a-sha')).toEqual({ name: 'invalid', error: 'Usage: /review commit <sha>' });
    expect(t('/review commit')).toEqual({ name: 'invalid', error: 'Usage: /review commit <sha>' });
    expect(t('/review the branch handling')).toEqual({ name: 'review', target: { type: 'custom', instructions: 'the branch handling' } });
    expect(parseCodexSlashCommand([{ type: 'text', text: '/review' }, { type: 'file', path: 'a.ts' }])).toBeUndefined();
  });

  it('appServerArgs keeps config overrides and feature toggles only', () => {
    expect(appServerArgs(['--config', 'a=1', '-c=b=2', '--disable', 'x', 'prompt text', '-c'])).toEqual({
      args: ['--config', 'a=1', '-c=b=2', '--disable', 'x'],
      dropped: ['prompt text', '-c'],
    });
  });

  it('reuses the thread sandbox only when its type matches the level', () => {
    const readOnly = { type: 'readOnly' as const, networkAccess: true };
    expect(codexSandboxPolicy('read-only', 'repo', readOnly)).toBe(readOnly);
    expect(codexSandboxPolicy('workspace-write', 'repo', readOnly)).toMatchObject({ type: 'workspaceWrite', writableRoots: ['repo'] });
    expect(codexSandboxPolicy('danger-full-access', 'repo', readOnly)).toEqual({ type: 'dangerFullAccess' });
  });

  it('builds sandbox policies scoped to the cwd', () => {
    expect(codexSandboxPolicy('workspace-write', 'repo')).toEqual({
      type: 'workspaceWrite', writableRoots: ['repo'], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false,
    });
    expect(codexSandboxPolicy('read-only', 'repo')).toEqual({ type: 'readOnly', networkAccess: false });
  });

  it('parses the CLI version from the user agent', () => {
    expect(parseCodexVersion('codex_cli_rs/0.153.4 (Mac OS 15.5; arm64) vscode/1')).toBe('0.153.4');
    expect(parseCodexVersion('codex_cli_rs/0.164.0-alpha.2 (x)')).toBe('0.164.0-alpha.2');
    expect(parseCodexVersion(undefined)).toBeUndefined();
  });

  it('capabilities extend the minimal baseline', () => {
    expect(CODEX_CHAT_CAPABILITIES).toEqual({
      ...MINIMAL_CHAT_CAPABILITIES,
      steer: true,
      interrupt: true,
      resume: 'native',
      subagents: 'ids_only',
      usage: 'tokens',
      limits: true,
      images: true,
      modelSwitch: 'per_turn',
      effortSwitch: 'per_turn',
      liveLevels: ['plan', 'ask', 'auto_edit', 'auto', 'full_access'],
      login: 'terminal',
      systemPrompt: true,
      slashCommands: true,
    });
  });
});
