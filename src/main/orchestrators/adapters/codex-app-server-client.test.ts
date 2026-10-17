import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// Mock child_process.spawn
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'child_process';
import {
  CodexAppServerClient,
  redactForLog,
  CODEX_RPC_INTERNAL_ERROR,
  CODEX_RPC_METHOD_NOT_FOUND,
  textInput,
  type CodexAppServerClientOpts,
} from './codex-app-server-client';
import { RpcError } from './acp-client';
import {
  commandApprovalDecisions,
  CODEX_APP_SERVER_SCHEMA_VERSION,
  FILE_CHANGE_APPROVAL_DECISIONS,
  isKnownNotificationMethod,
  isKnownServerRequestMethod,
  type ServerNotification,
} from './codex-protocol';
import * as fx from './codex-protocol/__fixtures__/app-server-session';

const mockSpawn = vi.mocked(spawn);

/** Simple EventEmitter-based mock streams for synchronous data delivery */
function createMockProcess() {
  const stdout = Object.assign(new EventEmitter(), {
    setEncoding: vi.fn(),
  });
  const stderr = Object.assign(new EventEmitter(), {
    setEncoding: vi.fn(),
  });
  const stdin = {
    writable: true,
    write: vi.fn((_chunk: unknown, _enc?: unknown, cb?: unknown) => {
      if (typeof cb === 'function') cb();
      if (typeof _enc === 'function') _enc();
      return true;
    }),
  };
  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin,
    kill: vi.fn(),
    exitCode: null as number | null,
    pid: 12345,
  });
  return proc;
}

type MockProcess = ReturnType<typeof createMockProcess>;

/** Helper: emit stdout data (triggers synchronous feed) */
function emitData(proc: MockProcess, data: string): void {
  proc.stdout.emit('data', data);
}

function emitMessage(proc: MockProcess, msg: unknown): void {
  emitData(proc, JSON.stringify(msg) + '\n');
}

/** Auto-respond to the init handshake request (always id 1). */
function autoRespondInit(proc: MockProcess): void {
  emitMessage(proc, { id: 1, result: fx.initializeResult });
}

/** Every message the client has written to stdin, parsed. */
function sentMessages(proc: MockProcess): Record<string, unknown>[] {
  return proc.stdin.write.mock.calls.map(([chunk]) => JSON.parse(String(chunk)));
}

function lastSent(proc: MockProcess): Record<string, unknown> {
  const all = sentMessages(proc);
  return all[all.length - 1];
}

describe('CodexAppServerClient', () => {
  let mockProc: MockProcess;

  beforeEach(() => {
    mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc as unknown as ReturnType<typeof spawn>);
  });

  /** Start a client with the handshake answered from the fixture. */
  async function startClient(opts: Partial<CodexAppServerClientOpts> = {}) {
    const client = new CodexAppServerClient({ binary: 'codex', args: ['app-server'], ...opts });
    setTimeout(() => autoRespondInit(mockProc), 0);
    await client.start();
    mockProc.stdin.write.mockClear();
    return client;
  }

  // ── Transport ────────────────────────────────────────────────────────────

  describe('transport', () => {
    it('spawns process with correct options', async () => {
      const client = new CodexAppServerClient({
        binary: 'codex-bin',
        args: ['app-server', '--listen', 'stdio://'],
        cwd: 'project',
        env: { PATH: 'bin' },
      });

      setTimeout(() => autoRespondInit(mockProc), 0);
      await client.start();

      expect(mockSpawn).toHaveBeenCalledWith(
        'codex-bin',
        ['app-server', '--listen', 'stdio://'],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: 'project',
          env: { PATH: 'bin' },
        },
      );
    });

    it('sends requests without jsonrpc field', async () => {
      const client = await startClient();

      const promise = client.threadStart({ model: 'gpt-5' });

      const sent = lastSent(mockProc);
      expect(sent).toEqual({ id: 2, method: 'thread/start', params: { model: 'gpt-5' } });
      expect(sent).not.toHaveProperty('jsonrpc');

      emitMessage(mockProc, { id: 2, result: fx.threadStartResult });
      expect(await promise).toEqual(fx.threadStartResult);
    });

    it('sends notifications without id or jsonrpc', async () => {
      const client = await startClient();

      client.notify('some/event', { data: 'test' });
      expect(lastSent(mockProc)).toEqual({ method: 'some/event', params: { data: 'test' } });

      client.notify('ping');
      expect(lastSent(mockProc)).toEqual({ method: 'ping' });
    });

    it('rejects with RpcError on JSON-RPC error response', async () => {
      const client = await startClient();

      const promise = client.requestRaw('bad/method', {});
      emitMessage(mockProc, { id: 2, error: { code: -32600, message: 'Invalid request', data: { x: 1 } } });

      await expect(promise).rejects.toThrow('RPC error -32600: Invalid request');
      await promise.catch((err) => {
        expect(err).toBeInstanceOf(RpcError);
        expect(err).toMatchObject({ code: -32600, data: { x: 1 } });
      });
    });

    it('handles chunked NDJSON across multiple data events', async () => {
      const onCodexNotification = vi.fn();
      await startClient({ onCodexNotification });

      const full = JSON.stringify(fx.completedTurnNotifications[1]) + '\n';
      emitData(mockProc, full.slice(0, 20));
      emitData(mockProc, full.slice(20));

      expect(onCodexNotification).toHaveBeenCalledWith(fx.completedTurnNotifications[1]);
    });

    it('handles multiple messages in a single chunk', async () => {
      const onCodexNotification = vi.fn();
      await startClient({ onCodexNotification });

      emitData(mockProc, fx.completedTurnNotifications.slice(0, 3).map((n) => JSON.stringify(n) + '\n').join(''));

      expect(onCodexNotification).toHaveBeenCalledTimes(3);
    });

    it('increments request IDs (starting at 2 after init)', async () => {
      const client = await startClient();

      const p1 = client.requestRaw('method1', {});
      const p2 = client.requestRaw('method2', {});
      emitData(mockProc, JSON.stringify({ id: 2, result: 'r1' }) + '\n' + JSON.stringify({ id: 3, result: 'r2' }) + '\n');

      expect(await p1).toBe('r1');
      expect(await p2).toBe('r2');
    });

    it('rejects all pending requests on process exit and calls onExit', async () => {
      const onExit = vi.fn();
      const client = await startClient({ onExit });

      const promise = client.threadList();
      mockProc.emit('exit', 1, null);

      await expect(promise).rejects.toThrow('Process exited');
      expect(onExit).toHaveBeenCalledWith(1, null);
    });

    it('kill() terminates once and reports not alive', async () => {
      const client = await startClient();
      expect(client.alive).toBe(true);

      client.kill();
      client.kill();

      expect(mockProc.kill).toHaveBeenCalledTimes(1);
      expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(client.alive).toBe(false);
    });

    it('skips and logs malformed JSON lines', async () => {
      const onLog = vi.fn();
      const onCodexNotification = vi.fn();
      await startClient({ onLog, onCodexNotification });

      emitData(mockProc, 'garbage data\n');
      emitMessage(mockProc, fx.completedTurnNotifications[1]);

      expect(onLog).toHaveBeenCalledWith('warn', 'Malformed JSON line from Codex stdout', expect.objectContaining({ line: 'garbage data' }));
      expect(onCodexNotification).toHaveBeenCalledTimes(1);
    });

    it('captures stderr and logs process exit with pending count', async () => {
      const onLog = vi.fn();
      const client = await startClient({ onLog });

      mockProc.stderr.emit('data', 'fatal error\n');
      const pending = client.threadList();
      mockProc.emit('exit', 1, null);
      await expect(pending).rejects.toThrow('Process exited');

      expect(client.getStderr()).toBe('fatal error\n');
      expect(onLog).toHaveBeenCalledWith('error', 'Codex app-server process exited', expect.objectContaining({ code: 1, pendingRequests: 1, stderr: 'fatal error' }));
    });

    it('rejects a request after the configured timeout', async () => {
      const onLog = vi.fn();
      const client = await startClient({ onLog, rpcTimeoutMs: 100 });
      vi.useFakeTimers();
      try {
        const promise = client.threadList();
        vi.advanceTimersByTime(200);

        await expect(promise).rejects.toThrow("RPC request 'thread/list' timed out after 100ms");
        expect(onLog).toHaveBeenCalledWith('error', 'RPC timeout → thread/list', expect.objectContaining({ timeoutMs: 100 }));
      } finally {
        vi.useRealTimers();
      }
    });

    it('clears the timeout when the response arrives first', async () => {
      const client = await startClient({ rpcTimeoutMs: 5000 });
      vi.useFakeTimers();
      try {
        const promise = client.threadList();
        emitMessage(mockProc, { id: 2, result: fx.threadListResult });
        expect(await promise).toEqual(fx.threadListResult);
        vi.advanceTimersByTime(10_000);
      } finally {
        vi.useRealTimers();
      }
    });

    it('honours a per-request timeout of null (no timeout)', async () => {
      const client = await startClient({ rpcTimeoutMs: 100 });
      vi.useFakeTimers();
      try {
        const promise = client.requestRaw('review/start', {}, { timeoutMs: null });
        vi.advanceTimersByTime(60_000);
        emitMessage(mockProc, { id: 2, result: { ok: true } });
        expect(await promise).toEqual({ ok: true });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── Handshake ────────────────────────────────────────────────────────────

  describe('initialize handshake', () => {
    it('sends initialize with v2 capabilities, then initialized', async () => {
      const client = new CodexAppServerClient({ binary: 'codex', args: [] });
      setTimeout(() => autoRespondInit(mockProc), 0);
      const result = await client.start();

      const [init, initialized] = sentMessages(mockProc);
      expect(init).toEqual({
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: { name: 'clubhouse', title: 'Clubhouse', version: '1.0.0' },
          capabilities: { experimentalApi: false, requestAttestation: false },
        },
      });
      expect(initialized).toEqual({ method: 'initialized' });
      expect(result).toEqual(fx.initializeResult);
      expect(client.serverInfo).toEqual(fx.initializeResult);
    });

    it('passes clientInfo, experimentalApi and notification opt-outs through', async () => {
      const client = new CodexAppServerClient({
        binary: 'codex',
        args: [],
        clientInfo: { name: 'my-app', title: null, version: '2.0.0' },
        experimentalApi: true,
        optOutNotificationMethods: ['thread/started'],
      });
      setTimeout(() => autoRespondInit(mockProc), 0);
      await client.start();

      expect(sentMessages(mockProc)[0].params).toEqual({
        clientInfo: { name: 'my-app', title: null, version: '2.0.0' },
        capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: ['thread/started'] },
      });
    });

    it('rejects start() if the handshake fails', async () => {
      const client = new CodexAppServerClient({ binary: 'codex', args: [] });
      setTimeout(() => emitMessage(mockProc, { id: 1, error: { code: -32603, message: 'Internal error' } }), 0);

      await expect(client.start()).rejects.toThrow('RPC error -32603: Internal error');
      expect(client.serverInfo).toBeNull();
    });

    it('logs spawn and handshake completion', async () => {
      const onLog = vi.fn();
      await startClient({ onLog });

      expect(onLog).toHaveBeenCalledWith('info', 'Spawning Codex app-server process', expect.objectContaining({ binary: 'codex' }));
      expect(onLog).toHaveBeenCalledWith('info', 'Codex init handshake complete', { userAgent: fx.initializeResult.userAgent, platformOs: 'macos' });
    });

    it('records the schema version the bindings were generated from', () => {
      expect(CODEX_APP_SERVER_SCHEMA_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    });
  });

  // ── Threads and turns ────────────────────────────────────────────────────

  describe('thread and turn requests', () => {
    it.each([
      ['threadStart', 'thread/start', { cwd: 'workspace', approvalPolicy: 'on-request', sandbox: 'workspace-write' }, fx.threadStartResult],
      ['threadResume', 'thread/resume', { threadId: fx.THREAD_ID, excludeTurns: true }, fx.threadResumeResult],
      ['threadList', 'thread/list', { limit: 20, cwd: 'workspace' }, fx.threadListResult],
      ['threadRead', 'thread/read', { threadId: fx.THREAD_ID }, { thread: fx.thread }],
      ['turnStart', 'turn/start', { threadId: fx.THREAD_ID, input: [textInput('hi')] }, fx.turnStartResult],
    ] as const)('%s sends %s and resolves its result', async (fn, method, params, result) => {
      const client = await startClient();

      const promise = (client[fn] as (p: unknown) => Promise<unknown>)(params);
      expect(lastSent(mockProc)).toEqual({ id: 2, method, params });

      emitMessage(mockProc, { id: 2, result });
      expect(await promise).toEqual(result);
    });

    it('never logs the MCP config (headers, env, token variables)', async () => {
      const onLog = vi.fn();
      const client = await startClient({ onLog });

      void client.threadStart({
        cwd: 'workspace',
        config: {
          mcp_servers: {
            remote: { url: 'https://mcp.example.test/mcp', http_headers: { Authorization: 'Bearer s3cr3t-token' }, bearer_token_env_var: 'MY_TOKEN_VAR' },
            local: { command: 'node', env: { API_KEY: 'k3y-value' } },
          },
        },
      });

      const logged = JSON.stringify(onLog.mock.calls);
      expect(logged).not.toContain('s3cr3t-token');
      expect(logged).not.toContain('MY_TOKEN_VAR');
      expect(logged).not.toContain('k3y-value');
      expect(onLog).toHaveBeenCalledWith('info', 'RPC request → thread/start', expect.objectContaining({
        params: { cwd: 'workspace', config: { redacted: ['mcp_servers'] } },
      }));
      // The request itself still carries the config.
      expect(lastSent(mockProc)).toMatchObject({ params: { config: { mcp_servers: { remote: { http_headers: { Authorization: 'Bearer s3cr3t-token' } } } } } });
    });

    it('redactForLog leaves params without config untouched', () => {
      const params = { threadId: 't', input: [] };
      expect(redactForLog(params)).toBe(params);
      expect(redactForLog(undefined)).toBeUndefined();
    });

    it('threadList defaults to empty params', async () => {
      const client = await startClient();
      void client.threadList();
      expect(lastSent(mockProc)).toEqual({ id: 2, method: 'thread/list', params: {} });
    });

    it('textInput builds a v2 text UserInput', () => {
      expect(textInput('hello')).toEqual({ type: 'text', text: 'hello', text_elements: [] });
    });

    it('tracks the active turn from turn/started and turn/completed', async () => {
      const client = await startClient();
      expect(client.getActiveTurnId(fx.THREAD_ID)).toBeUndefined();

      emitMessage(mockProc, fx.completedTurnNotifications[1]); // turn/started
      expect(client.getActiveTurnId(fx.THREAD_ID)).toBe(fx.TURN_ID);

      emitMessage(mockProc, fx.completedTurnNotifications.find((n) => n.method === 'turn/completed'));
      expect(client.getActiveTurnId(fx.THREAD_ID)).toBeUndefined();
    });

    it('turnStart records the active turn from its reply, before turn/started', async () => {
      const client = await startClient();

      const started = client.turnStart({ threadId: fx.THREAD_ID, input: [textInput('hi')] });
      emitMessage(mockProc, { id: 2, result: fx.turnStartResult });
      await started;
      expect(client.getActiveTurnId(fx.THREAD_ID)).toBe(fx.TURN_ID);

      const steer = client.turnSteer(fx.THREAD_ID, [textInput('more')]);
      expect(lastSent(mockProc)).toMatchObject({ method: 'turn/steer', params: { expectedTurnId: fx.TURN_ID } });
      emitMessage(mockProc, { id: 3, result: fx.turnSteerResult });
      await steer;
    });

    it('a turnStart reply arriving after turn/completed does not revive the turn', async () => {
      const client = await startClient();

      const started = client.turnStart({ threadId: fx.THREAD_ID, input: [textInput('hi')] });
      emitMessage(mockProc, fx.interruptedTurnCompleted); // completes TURN_ID first
      emitMessage(mockProc, { id: 2, result: fx.turnStartResult });
      await started;

      expect(client.getActiveTurnId(fx.THREAD_ID)).toBeUndefined();
    });

    it('a turnStart reply for a finished turn does not mark it active', async () => {
      const client = await startClient();

      const started = client.turnStart({ threadId: fx.THREAD_ID, input: [textInput('hi')] });
      emitMessage(mockProc, { id: 2, result: { turn: { ...fx.turnStartResult.turn, status: 'completed' } } });
      await started;

      expect(client.getActiveTurnId(fx.THREAD_ID)).toBeUndefined();
    });

    it('clears tracked turns after flushing buffered output on exit', async () => {
      const client = await startClient();

      // A final line with no newline is only dispatched by the exit flush.
      emitData(mockProc, JSON.stringify(fx.completedTurnNotifications[1]));
      mockProc.emit('exit', 0, null);

      expect(client.getActiveTurnId(fx.THREAD_ID)).toBeUndefined();
    });

    it('a late turn/completed for an older turn keeps the newer active turn', async () => {
      const client = await startClient();

      emitMessage(mockProc, fx.secondTurnStarted);
      emitMessage(mockProc, fx.interruptedTurnCompleted); // completes TURN_ID, not the second

      expect(client.getActiveTurnId(fx.THREAD_ID)).toBe(fx.SECOND_TURN_ID);
    });

    it('turnSteer defaults expectedTurnId to the active turn', async () => {
      const client = await startClient();
      emitMessage(mockProc, fx.completedTurnNotifications[1]);

      const promise = client.turnSteer(fx.THREAD_ID, [textInput('also check lint')]);
      expect(lastSent(mockProc)).toEqual({
        id: 2,
        method: 'turn/steer',
        params: { threadId: fx.THREAD_ID, input: [textInput('also check lint')], expectedTurnId: fx.TURN_ID },
      });
      emitMessage(mockProc, { id: 2, result: fx.turnSteerResult });
      expect(await promise).toEqual(fx.turnSteerResult);
    });

    it('turnSteer surfaces the server rejecting a stale expectedTurnId', async () => {
      const client = await startClient();

      const promise = client.turnSteer(fx.THREAD_ID, [textInput('x')], 'stale-turn');
      emitMessage(mockProc, { id: 2, error: { code: -32600, message: 'expected turn mismatch' } });

      await expect(promise).rejects.toMatchObject({ code: -32600 });
    });

    it('turnSteer and turnInterrupt reject without sending when no turn is active', async () => {
      const client = await startClient();

      await expect(client.turnSteer(fx.THREAD_ID, [textInput('x')])).rejects.toThrow('No active Codex turn to steer');
      await expect(client.turnInterrupt(fx.THREAD_ID)).rejects.toThrow('No active Codex turn to interrupt');
      expect(mockProc.stdin.write).not.toHaveBeenCalled();
    });

    it('turnInterrupt targets the active turn', async () => {
      const client = await startClient();
      emitMessage(mockProc, fx.completedTurnNotifications[1]);

      const promise = client.turnInterrupt(fx.THREAD_ID);
      expect(lastSent(mockProc)).toEqual({ id: 2, method: 'turn/interrupt', params: { threadId: fx.THREAD_ID, turnId: fx.TURN_ID } });
      emitMessage(mockProc, { id: 2, result: {} });
      expect(await promise).toEqual({});
    });

    it('readRateLimits returns the snapshot', async () => {
      const client = await startClient();

      const promise = client.readRateLimits();
      expect(lastSent(mockProc)).toEqual({ id: 2, method: 'account/rateLimits/read' });
      emitMessage(mockProc, { id: 2, result: fx.rateLimitsResult });

      expect(await promise).toEqual(fx.rateLimitsResult.rateLimits);
    });

    it('forgets active turns when the process exits', async () => {
      const client = await startClient();
      emitMessage(mockProc, fx.completedTurnNotifications[1]);

      mockProc.emit('exit', 0, null);

      expect(client.getActiveTurnId(fx.THREAD_ID)).toBeUndefined();
    });
  });

  // ── Notifications ────────────────────────────────────────────────────────

  describe('notifications', () => {
    it('delivers a full turn stream in order, all recognised', async () => {
      const onCodexNotification = vi.fn();
      const onUnrecognizedMessage = vi.fn();
      const onLog = vi.fn();
      await startClient({ onCodexNotification, onUnrecognizedMessage, onLog });

      for (const n of fx.completedTurnNotifications) emitMessage(mockProc, n);

      expect(onCodexNotification.mock.calls.map(([n]) => n)).toEqual(fx.completedTurnNotifications);
      expect(onUnrecognizedMessage).not.toHaveBeenCalled();
      expect(onLog.mock.calls.filter(([level]) => level !== 'info')).toEqual([]);
    });

    it('covers deltas, item lifecycle, plan, usage, rate limits, errors and completion', () => {
      const methods = new Set(fx.completedTurnNotifications.map((n) => n.method));
      for (const method of [
        'turn/started',
        'item/started',
        'item/completed',
        'item/agentMessage/delta',
        'item/reasoning/summaryTextDelta',
        'item/commandExecution/outputDelta',
        'item/fileChange/patchUpdated',
        'turn/diff/updated',
        'turn/plan/updated',
        'thread/tokenUsage/updated',
        'account/rateLimits/updated',
        'error',
        'turn/completed',
      ] as const) {
        expect(methods.has(method)).toBe(true);
        expect(isKnownNotificationMethod(method)).toBe(true);
      }
    });

    it.each([
      ['completed', fx.completedTurnNotifications.find((n) => n.method === 'turn/completed')],
      ['interrupted', fx.interruptedTurnCompleted],
      ['failed', fx.failedTurnCompleted],
    ])('passes a %s turn/completed through with its status and error', async (status, notification) => {
      const onCodexNotification = vi.fn();
      await startClient({ onCodexNotification });

      emitMessage(mockProc, notification);

      const delivered = onCodexNotification.mock.calls[0][0] as Extract<ServerNotification, { method: 'turn/completed' }>;
      expect(delivered.params.turn.status).toBe(status);
      if (status === 'failed') {
        expect(delivered.params.turn.error).toMatchObject({ codexErrorInfo: 'usageLimitExceeded' });
      } else {
        expect(delivered.params.turn.error).toBeNull();
      }
    });

    it('surfaces an unknown notification without crashing or dropping later messages', async () => {
      const onCodexNotification = vi.fn();
      const onUnrecognizedMessage = vi.fn();
      const onLog = vi.fn();
      await startClient({ onCodexNotification, onUnrecognizedMessage, onLog });

      emitMessage(mockProc, { method: 'thread/somethingNew', params: { threadId: fx.THREAD_ID } });
      emitMessage(mockProc, fx.completedTurnNotifications[1]);

      expect(onUnrecognizedMessage).toHaveBeenCalledWith({ kind: 'notification', method: 'thread/somethingNew', params: { threadId: fx.THREAD_ID } });
      expect(onLog).toHaveBeenCalledWith('warn', 'Unrecognized Codex notification', { method: 'thread/somethingNew' });
      expect(onCodexNotification).toHaveBeenCalledTimes(1);
    });

    it('surfaces a message with neither id nor method', async () => {
      const onUnrecognizedMessage = vi.fn();
      const onLog = vi.fn();
      await startClient({ onUnrecognizedMessage, onLog });

      emitMessage(mockProc, { data: 'orphan' });

      expect(onUnrecognizedMessage).toHaveBeenCalledWith({ kind: 'other', message: { data: 'orphan' } });
      expect(onLog).toHaveBeenCalledWith('warn', 'Codex message with neither id nor method', { keys: ['data'] });
    });

    it('a throwing notification handler is logged and does not stop the stream', async () => {
      const onLog = vi.fn();
      const onCodexNotification = vi.fn().mockImplementationOnce(() => { throw new Error('boom'); });
      await startClient({ onLog, onCodexNotification });

      emitMessage(mockProc, fx.completedTurnNotifications[0]);
      emitMessage(mockProc, fx.completedTurnNotifications[1]);

      expect(onCodexNotification).toHaveBeenCalledTimes(2);
      expect(onLog).toHaveBeenCalledWith('error', 'Codex onCodexNotification handler threw', { error: 'boom' });
    });

    it('logs a response for an unknown request id', async () => {
      const onLog = vi.fn();
      await startClient({ onLog });

      emitMessage(mockProc, { id: 99, result: {} });

      expect(onLog).toHaveBeenCalledWith('warn', 'RPC response for unknown request', { id: 99 });
    });
  });

  // ── Server requests (approvals) ──────────────────────────────────────────

  describe('server requests', () => {
    it('delivers a command approval request typed, and tracks it as open', async () => {
      const onCodexServerRequest = vi.fn();
      const client = await startClient({ onCodexServerRequest });

      emitMessage(mockProc, fx.commandApprovalRequest);

      expect(onCodexServerRequest).toHaveBeenCalledWith(fx.commandApprovalRequest);
      expect(client.getOpenServerRequests().get(0)).toBe('item/commandExecution/requestApproval');
      expect(mockProc.stdin.write).not.toHaveBeenCalled();
    });

    it('lists every command decision the request allows', () => {
      expect(commandApprovalDecisions(fx.commandApprovalRequest.params)).toEqual([
        'accept',
        'acceptForSession',
        { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['npm', 'install'] } },
        { applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'registry.npmjs.org', action: 'allow' } } },
        'decline',
        'cancel',
      ]);
    });

    it('omits amendment decisions when nothing was proposed', () => {
      const params = { ...fx.commandApprovalRequest.params, proposedExecpolicyAmendment: null, proposedNetworkPolicyAmendments: null };
      expect(commandApprovalDecisions(params)).toEqual(['accept', 'acceptForSession', 'decline', 'cancel']);
    });

    it.each(commandApprovalDecisions(fx.commandApprovalRequest.params).map((d) => [JSON.stringify(d), d]))(
      'answers a command approval with %s',
      async (_label, decision) => {
        const client = await startClient({ onCodexServerRequest: vi.fn() });
        emitMessage(mockProc, fx.commandApprovalRequest);

        client.respondToCommandApproval(fx.commandApprovalRequest.id, decision);

        expect(lastSent(mockProc)).toEqual({ id: 0, result: { decision } });
        expect(client.getOpenServerRequests().size).toBe(0);
      },
    );

    it.each(FILE_CHANGE_APPROVAL_DECISIONS.map((d) => [d]))('answers a file-change approval with %s', async (decision) => {
      const onCodexServerRequest = vi.fn();
      const client = await startClient({ onCodexServerRequest });
      emitMessage(mockProc, fx.fileChangeApprovalRequest);
      expect(onCodexServerRequest).toHaveBeenCalledWith(fx.fileChangeApprovalRequest);

      client.respondToFileChangeApproval(fx.fileChangeApprovalRequest.id, decision);

      expect(lastSent(mockProc)).toEqual({ id: 1, result: { decision } });
    });

    it('drops a request Codex resolved itself (serverRequest/resolved)', async () => {
      const client = await startClient({ onCodexServerRequest: vi.fn() });
      emitMessage(mockProc, fx.fileChangeApprovalRequest);

      emitMessage(mockProc, fx.serverRequestResolved);

      expect(client.getOpenServerRequests().size).toBe(0);
    });

    it('answers with method-not-found when nothing handles server requests', async () => {
      const client = await startClient();

      emitMessage(mockProc, fx.commandApprovalRequest);

      expect(lastSent(mockProc)).toEqual({
        id: 0,
        error: { code: CODEX_RPC_METHOD_NOT_FOUND, message: "No handler for 'item/commandExecution/requestApproval'" },
      });
      expect(client.getOpenServerRequests().size).toBe(0);
    });

    it('answers with an internal error when the handler throws', async () => {
      const onLog = vi.fn();
      await startClient({ onLog, onCodexServerRequest: () => { throw new Error('ui gone'); } });

      emitMessage(mockProc, fx.commandApprovalRequest);

      expect(lastSent(mockProc)).toEqual({
        id: 0,
        error: { code: CODEX_RPC_INTERNAL_ERROR, message: "Clubhouse failed to handle 'item/commandExecution/requestApproval'" },
      });
      expect(onLog).toHaveBeenCalledWith('error', 'Codex onCodexServerRequest handler threw', { error: 'ui gone' });
    });

    it('answers with an internal error when an async handler rejects', async () => {
      const onLog = vi.fn();
      const client = await startClient({ onLog, onCodexServerRequest: async () => { throw new Error('async gone'); } });

      emitMessage(mockProc, fx.commandApprovalRequest);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(lastSent(mockProc)).toEqual({
        id: 0,
        error: { code: CODEX_RPC_INTERNAL_ERROR, message: "Clubhouse failed to handle 'item/commandExecution/requestApproval'" },
      });
      expect(onLog).toHaveBeenCalledWith('error', 'Codex onCodexServerRequest handler rejected', { error: 'async gone' });
      expect(client.getOpenServerRequests().size).toBe(0);
    });

    it('an async handler that answers then rejects is not answered twice', async () => {
      const client: CodexAppServerClient = await startClient({
        onCodexServerRequest: async (req) => {
          client.respondToCommandApproval(req.id, 'accept');
          throw new Error('after answering');
        },
      });

      emitMessage(mockProc, fx.commandApprovalRequest);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(sentMessages(mockProc)).toEqual([{ id: 0, result: { decision: 'accept' } }]);
    });

    it('an async handler that resolves later leaves the request open until answered', async () => {
      let answer: () => void = () => {};
      const client: CodexAppServerClient = await startClient({
        onCodexServerRequest: (req) => new Promise<void>((resolve) => {
          answer = () => { client.respondToCommandApproval(req.id, 'decline'); resolve(); };
        }),
      });

      emitMessage(mockProc, fx.commandApprovalRequest);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(client.getOpenServerRequests().size).toBe(1);

      answer();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(sentMessages(mockProc)).toEqual([{ id: 0, result: { decision: 'decline' } }]);
    });

    it('does not double-answer when the handler answered before throwing', async () => {
      const client: CodexAppServerClient = await startClient({
        onCodexServerRequest: (req) => {
          client.respondToCommandApproval(req.id, 'decline');
          throw new Error('after answering');
        },
      });

      emitMessage(mockProc, fx.commandApprovalRequest);

      expect(sentMessages(mockProc)).toEqual([{ id: 0, result: { decision: 'decline' } }]);
    });

    it('answers an unknown server request with method-not-found and surfaces it', async () => {
      const onCodexServerRequest = vi.fn();
      const onUnrecognizedMessage = vi.fn();
      await startClient({ onCodexServerRequest, onUnrecognizedMessage });

      emitMessage(mockProc, { id: 'srv-9', method: 'item/somethingNew/requestApproval', params: { a: 1 } });

      expect(onCodexServerRequest).not.toHaveBeenCalled();
      expect(lastSent(mockProc)).toEqual({
        id: 'srv-9',
        error: { code: CODEX_RPC_METHOD_NOT_FOUND, message: "Clubhouse does not support 'item/somethingNew/requestApproval'" },
      });
      expect(onUnrecognizedMessage).toHaveBeenCalledWith({ kind: 'request', id: 'srv-9', method: 'item/somethingNew/requestApproval', params: { a: 1 } });
    });

    it('knows every server request method in the pinned schema', () => {
      expect(isKnownServerRequestMethod('item/commandExecution/requestApproval')).toBe(true);
      expect(isKnownServerRequestMethod('item/fileChange/requestApproval')).toBe(true);
      expect(isKnownServerRequestMethod('nope')).toBe(false);
    });

    it('warns when answering a request that is not open', async () => {
      const onLog = vi.fn();
      const client = await startClient({ onLog });

      client.respond('srv-1', { decision: 'accept' });

      expect(lastSent(mockProc)).toEqual({ id: 'srv-1', result: { decision: 'accept' } });
      expect(onLog).toHaveBeenCalledWith('warn', 'Answering a Codex server request that is not open', { id: 'srv-1' });
    });
  });
});
