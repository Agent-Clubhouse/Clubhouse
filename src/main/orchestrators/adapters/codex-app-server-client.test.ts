import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// Mock child_process.spawn
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'child_process';
import { CodexAppServerClient } from './codex-app-server-client';

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

/** Helper: emit stdout data (triggers synchronous feed) */
function emitData(
  proc: ReturnType<typeof createMockProcess>,
  data: string,
): void {
  proc.stdout.emit('data', data);
}

/** Auto-respond to the init handshake request */
function autoRespondInit(proc: ReturnType<typeof createMockProcess>): void {
  // The first request sent will be `initialize` with id 1
  // Auto-respond with a success result
  emitData(proc, JSON.stringify({ id: 1, result: { platformInfo: {} } }) + '\n');
}

describe('CodexAppServerClient', () => {
  let mockProc: ReturnType<typeof createMockProcess>;

  beforeEach(() => {
    mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc as unknown as ReturnType<typeof spawn>);
  });

  it('spawns process with correct options', async () => {
    const client = new CodexAppServerClient({
      binary: '/usr/bin/codex',
      args: ['app-server', '--listen', 'stdio://'],
      cwd: '/tmp/project',
      env: { PATH: '/usr/bin' },
    });

    // Auto-respond to init handshake
    setTimeout(() => autoRespondInit(mockProc), 0);
    await client.start();

    expect(mockSpawn).toHaveBeenCalledWith(
      '/usr/bin/codex',
      ['app-server', '--listen', 'stdio://'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: '/tmp/project',
        env: { PATH: '/usr/bin' },
      },
    );
  });

  it('performs initialization handshake on start', async () => {
    const client = new CodexAppServerClient({
      binary: 'codex',
      args: [],
    });

    setTimeout(() => autoRespondInit(mockProc), 0);
    await client.start();

    // First write should be the initialize request
    const initCall = mockProc.stdin.write.mock.calls[0];
    const initMsg = JSON.parse((initCall[0] as string).replace('\n', ''));
    expect(initMsg).toMatchObject({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'clubhouse', title: 'Clubhouse', version: '1.0.0' },
        capabilities: {},
      },
    });
    // Should NOT include jsonrpc field
    expect(initMsg).not.toHaveProperty('jsonrpc');

    // Second write should be the initialized notification
    const initNotify = mockProc.stdin.write.mock.calls[1];
    const notifyMsg = JSON.parse((initNotify[0] as string).replace('\n', ''));
    expect(notifyMsg).toEqual({ method: 'initialized' });
    expect(notifyMsg).not.toHaveProperty('jsonrpc');
    expect(notifyMsg).not.toHaveProperty('id');
  });

  it('uses custom clientInfo when provided', async () => {
    const client = new CodexAppServerClient({
      binary: 'codex',
      args: [],
      clientInfo: { name: 'my-app', title: 'My App', version: '2.0.0' },
    });

    setTimeout(() => autoRespondInit(mockProc), 0);
    await client.start();

    const initMsg = JSON.parse((mockProc.stdin.write.mock.calls[0][0] as string).replace('\n', ''));
    expect(initMsg.params.clientInfo).toEqual({
      name: 'my-app',
      title: 'My App',
      version: '2.0.0',
    });
  });

  it('sends requests without jsonrpc field', async () => {
    const client = new CodexAppServerClient({ binary: 'codex', args: [] });

    setTimeout(() => autoRespondInit(mockProc), 0);
    await client.start();

    mockProc.stdin.write.mockClear();

    const promise = client.request('thread/start', { model: 'gpt-5' });

    const sent = JSON.parse(
      (mockProc.stdin.write.mock.calls[0][0] as string).replace('\n', ''),
    );
    expect(sent).toMatchObject({
      id: 2, // id 1 was used by initialize
      method: 'thread/start',
      params: { model: 'gpt-5' },
    });
    expect(sent).not.toHaveProperty('jsonrpc');

    // Respond
    emitData(mockProc, JSON.stringify({ id: 2, result: { thread: { id: 't1' } } }) + '\n');
    const result = await promise;
    expect(result).toEqual({ thread: { id: 't1' } });
  });

  it('sends notifications without id or jsonrpc', async () => {
    const client = new CodexAppServerClient({ binary: 'codex', args: [] });

    setTimeout(() => autoRespondInit(mockProc), 0);
    await client.start();

    mockProc.stdin.write.mockClear();

    client.notify('some/event', { data: 'test' });

    const sent = JSON.parse(
      (mockProc.stdin.write.mock.calls[0][0] as string).replace('\n', ''),
    );
    expect(sent).toEqual({ method: 'some/event', params: { data: 'test' } });
    expect(sent).not.toHaveProperty('jsonrpc');
    expect(sent).not.toHaveProperty('id');
  });

  it('sends notification without params when none provided', async () => {
    const client = new CodexAppServerClient({ binary: 'codex', args: [] });

    setTimeout(() => autoRespondInit(mockProc), 0);
    await client.start();

    mockProc.stdin.write.mockClear();

    client.notify('ping');

    const sent = JSON.parse(
      (mockProc.stdin.write.mock.calls[0][0] as string).replace('\n', ''),
    );
    expect(sent).toEqual({ method: 'ping' });
  });

  it('rejects request on JSON-RPC error response', async () => {
    const client = new CodexAppServerClient({ binary: 'codex', args: [] });

    setTimeout(() => autoRespondInit(mockProc), 0);
    await client.start();

    const promise = client.request('bad/method', {});

    emitData(
      mockProc,
      JSON.stringify({ id: 2, error: { code: -32600, message: 'Invalid request' } }) + '\n',
    );

    await expect(promise).rejects.toThrow('RPC error -32600: Invalid request');
  });

  it('forwards notifications to callback', async () => {
    const onNotification = vi.fn();
    const client = new CodexAppServerClient({
      binary: 'codex',
      args: [],
      onNotification,
    });

    setTimeout(() => autoRespondInit(mockProc), 0);
    await client.start();

    emitData(
      mockProc,
      JSON.stringify({
        method: 'item/agentMessage/delta',
        params: { delta: { text: 'hello' } },
      }) + '\n',
    );

    expect(onNotification).toHaveBeenCalledWith('item/agentMessage/delta', {
      delta: { text: 'hello' },
    });
  });

  it('forwards server-initiated requests to callback', async () => {
    const onServerRequest = vi.fn();
    const client = new CodexAppServerClient({
      binary: 'codex',
      args: [],
      onServerRequest,
    });

    setTimeout(() => autoRespondInit(mockProc), 0);
    await client.start();

    emitData(
      mockProc,
      JSON.stringify({
        id: 'srv-1',
        method: 'item/commandExecution/requestApproval',
        params: { itemId: 'item-1', command: 'rm -rf /' },
      }) + '\n',
    );

    expect(onServerRequest).toHaveBeenCalledWith(
      'srv-1',
      'item/commandExecution/requestApproval',
      { itemId: 'item-1', command: 'rm -rf /' },
    );
  });

  it('sends response back to server for approval', async () => {
    const client = new CodexAppServerClient({ binary: 'codex', args: [] });

    setTimeout(() => autoRespondInit(mockProc), 0);
    await client.start();

    mockProc.stdin.write.mockClear();

    client.respond('srv-1', { decision: 'accept' });

    const sent = JSON.parse(
      (mockProc.stdin.write.mock.calls[0][0] as string).replace('\n', ''),
    );
    expect(sent).toEqual({ id: 'srv-1', result: { decision: 'accept' } });
    expect(sent).not.toHaveProperty('jsonrpc');
  });

  it('handles chunked NDJSON across multiple data events', async () => {
    const onNotification = vi.fn();
    const client = new CodexAppServerClient({
      binary: 'codex',
      args: [],
      onNotification,
    });

    setTimeout(() => autoRespondInit(mockProc), 0);
    await client.start();

    // Send partial JSON across two chunks
    emitData(mockProc, '{"method":"item/agent');
    expect(onNotification).not.toHaveBeenCalled();

    emitData(mockProc, 'Message/delta","params":{"delta":{"text":"hi"}}}\n');
    expect(onNotification).toHaveBeenCalledWith('item/agentMessage/delta', {
      delta: { text: 'hi' },
    });
  });

  it('handles multiple messages in a single chunk', async () => {
    const onNotification = vi.fn();
    const client = new CodexAppServerClient({
      binary: 'codex',
      args: [],
      onNotification,
    });

    setTimeout(() => autoRespondInit(mockProc), 0);
    await client.start();

    emitData(
      mockProc,
      '{"method":"a","params":{}}\n{"method":"b","params":{}}\n',
    );

    expect(onNotification).toHaveBeenCalledTimes(2);
    expect(onNotification).toHaveBeenCalledWith('a', {});
    expect(onNotification).toHaveBeenCalledWith('b', {});
  });

  it('rejects all pending requests on process exit', async () => {
    const client = new CodexAppServerClient({ binary: 'codex', args: [] });

    setTimeout(() => autoRespondInit(mockProc), 0);
    await client.start();

    const p1 = client.request('method1', {});
    const p2 = client.request('method2', {});

    mockProc.emit('exit', 1, null);

    await expect(p1).rejects.toThrow('Process exited');
    await expect(p2).rejects.toThrow('Process exited');
  });

  it('calls onExit when process exits', async () => {
    const onExit = vi.fn();
    const client = new CodexAppServerClient({
      binary: 'codex',
      args: [],
      onExit,
    });

    setTimeout(() => autoRespondInit(mockProc), 0);
    await client.start();

    mockProc.emit('exit', 0, null);
    expect(onExit).toHaveBeenCalledWith(0, null);
  });

  it('kills the process', async () => {
    const client = new CodexAppServerClient({ binary: 'codex', args: [] });

    setTimeout(() => autoRespondInit(mockProc), 0);
    await client.start();

    client.kill();
    expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('kill() is idempotent', async () => {
    const client = new CodexAppServerClient({ binary: 'codex', args: [] });

    setTimeout(() => autoRespondInit(mockProc), 0);
    await client.start();

    client.kill();
    client.kill();
    expect(mockProc.kill).toHaveBeenCalledTimes(1);
  });

  it('skips malformed JSON lines', async () => {
    const onNotification = vi.fn();
    const client = new CodexAppServerClient({
      binary: 'codex',
      args: [],
      onNotification,
    });

    setTimeout(() => autoRespondInit(mockProc), 0);
    await client.start();

    emitData(
      mockProc,
      'not json\n{"method":"ok","params":{}}\n',
    );

    expect(onNotification).toHaveBeenCalledTimes(1);
    expect(onNotification).toHaveBeenCalledWith('ok', {});
  });

  it('reports alive status correctly', async () => {
    const client = new CodexAppServerClient({ binary: 'codex', args: [] });

    setTimeout(() => autoRespondInit(mockProc), 0);
    await client.start();

    expect(client.alive).toBe(true);

    client.kill();
    expect(client.alive).toBe(false);
  });

  it('increments request IDs (starting at 2 after init)', async () => {
    const client = new CodexAppServerClient({ binary: 'codex', args: [] });

    setTimeout(() => autoRespondInit(mockProc), 0);
    await client.start();

    const p1 = client.request('method1', {});
    const p2 = client.request('method2', {});

    // Respond to both (IDs 2 and 3 since init used 1)
    emitData(
      mockProc,
      JSON.stringify({ id: 2, result: 'r1' }) +
        '\n' +
        JSON.stringify({ id: 3, result: 'r2' }) +
        '\n',
    );

    expect(await p1).toBe('r1');
    expect(await p2).toBe('r2');
  });

  it('rejects start() if init handshake fails', async () => {
    const client = new CodexAppServerClient({ binary: 'codex', args: [] });

    // Respond to init with an error
    setTimeout(() => {
      emitData(mockProc, JSON.stringify({
        id: 1,
        error: { code: -32603, message: 'Internal error' },
      }) + '\n');
    }, 0);

    await expect(client.start()).rejects.toThrow('RPC error -32603: Internal error');
  });

  // ── onLog callback tests ──────────────────────────────────────────────────

  it('calls onLog for spawn', async () => {
    const onLog = vi.fn();
    const client = new CodexAppServerClient({
      binary: '/usr/bin/codex',
      args: ['app-server'],
      onLog,
    });

    setTimeout(() => autoRespondInit(mockProc), 0);
    await client.start();

    expect(onLog).toHaveBeenCalledWith(
      'info',
      'Spawning Codex app-server process',
      expect.objectContaining({
        binary: '/usr/bin/codex',
        args: ['app-server'],
      }),
    );
  });

  it('calls onLog for RPC requests', async () => {
    const onLog = vi.fn();
    const client = new CodexAppServerClient({ binary: 'codex', args: [], onLog });

    setTimeout(() => autoRespondInit(mockProc), 0);
    await client.start();

    client.request('thread/start', { model: 'gpt-5' });

    expect(onLog).toHaveBeenCalledWith(
      'info',
      'RPC request → thread/start',
      expect.objectContaining({
        method: 'thread/start',
      }),
    );
  });

  it('calls onLog for RPC errors', async () => {
    const onLog = vi.fn();
    const client = new CodexAppServerClient({ binary: 'codex', args: [], onLog });

    setTimeout(() => autoRespondInit(mockProc), 0);
    await client.start();

    const promise = client.request('bad/method', {});

    emitData(
      mockProc,
      JSON.stringify({ id: 2, error: { code: -32601, message: 'Method not found' } }) + '\n',
    );

    await expect(promise).rejects.toThrow();

    expect(onLog).toHaveBeenCalledWith(
      'error',
      'RPC error ← id=2',
      expect.objectContaining({
        code: -32601,
        message: 'Method not found',
      }),
    );
  });

  // ── stderr capture tests ──────────────────────────────────────────────────

  it('captures stderr and makes it accessible via getStderr', async () => {
    const onLog = vi.fn();
    const client = new CodexAppServerClient({ binary: 'codex', args: [], onLog });

    setTimeout(() => autoRespondInit(mockProc), 0);
    await client.start();

    mockProc.stderr.emit('data', 'Warning: something\n');

    expect(client.getStderr()).toBe('Warning: something\n');
    expect(onLog).toHaveBeenCalledWith(
      'warn',
      'Codex app-server stderr',
      expect.objectContaining({ text: 'Warning: something' }),
    );
  });

  it('logs process exit with stderr and pending count', async () => {
    const onLog = vi.fn();
    const client = new CodexAppServerClient({ binary: 'codex', args: [], onLog });

    setTimeout(() => autoRespondInit(mockProc), 0);
    await client.start();

    mockProc.stderr.emit('data', 'fatal error\n');
    const pendingRequest = client.request('thread/start', {});

    mockProc.emit('exit', 1, null);

    // Consume the rejection to avoid unhandled promise rejection
    await expect(pendingRequest).rejects.toThrow('Process exited');

    expect(onLog).toHaveBeenCalledWith(
      'error',
      'Codex app-server process exited',
      expect.objectContaining({
        code: 1,
        pendingRequests: 1,
        stderr: 'fatal error',
      }),
    );
  });

  it('logs malformed JSON lines', async () => {
    const onLog = vi.fn();
    const client = new CodexAppServerClient({ binary: 'codex', args: [], onLog });

    setTimeout(() => autoRespondInit(mockProc), 0);
    await client.start();

    emitData(mockProc, 'garbage data\n');

    expect(onLog).toHaveBeenCalledWith(
      'warn',
      'Malformed JSON line from Codex stdout',
      expect.objectContaining({ line: 'garbage data' }),
    );
  });

  it('logs init handshake completion', async () => {
    const onLog = vi.fn();
    const client = new CodexAppServerClient({ binary: 'codex', args: [], onLog });

    setTimeout(() => autoRespondInit(mockProc), 0);
    await client.start();

    expect(onLog).toHaveBeenCalledWith('info', 'Codex init handshake complete', undefined);
  });

  // ── Dispatch fix: no spurious warnings ──────────────────────────────────

  it('does not log warning for valid notifications', async () => {
    const onLog = vi.fn();
    const onNotification = vi.fn();
    const client = new CodexAppServerClient({
      binary: 'codex',
      args: [],
      onLog,
      onNotification,
    });

    setTimeout(() => autoRespondInit(mockProc), 0);
    await client.start();
    onLog.mockClear();

    // Send a valid notification (has method, no id)
    emitData(
      mockProc,
      JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: { text: 'hi' } } }) + '\n',
    );

    // Should NOT have logged the spurious "neither id nor method" warning
    const warningCalls = onLog.mock.calls.filter(
      ([, msg]) => typeof msg === 'string' && msg.includes('neither id nor method'),
    );
    expect(warningCalls).toHaveLength(0);
    expect(onNotification).toHaveBeenCalledTimes(1);
  });

  it('logs info for messages with neither id nor method', async () => {
    const onLog = vi.fn();
    const client = new CodexAppServerClient({
      binary: 'codex',
      args: [],
      onLog,
    });

    setTimeout(() => autoRespondInit(mockProc), 0);
    await client.start();
    onLog.mockClear();

    // Send a message with neither id nor method
    emitData(mockProc, JSON.stringify({ data: 'orphan' }) + '\n');

    expect(onLog).toHaveBeenCalledWith(
      'info',
      'Codex message with neither id nor method (ignored)',
      expect.objectContaining({ keys: ['data'] }),
    );
  });

  // ── RPC timeout tests ────────────────────────────────────────────────────

  it('rejects request after timeout', async () => {
    const onLog = vi.fn();
    const client = new CodexAppServerClient({
      binary: 'codex',
      args: [],
      onLog,
      rpcTimeoutMs: 100,
    });

    // Start with real timers so init handshake completes
    setTimeout(() => autoRespondInit(mockProc), 0);
    await client.start();

    // Now switch to fake timers for the timeout test
    vi.useFakeTimers();

    const promise = client.request('thread/start', { model: 'gpt-5' });

    // Advance past the timeout
    vi.advanceTimersByTime(200);

    await expect(promise).rejects.toThrow("RPC request 'thread/start' timed out after 100ms");
    expect(onLog).toHaveBeenCalledWith(
      'error',
      'RPC timeout → thread/start',
      expect.objectContaining({ timeoutMs: 100 }),
    );

    vi.useRealTimers();
  });

  it('clears timeout when response arrives before deadline', async () => {
    const client = new CodexAppServerClient({
      binary: 'codex',
      args: [],
      rpcTimeoutMs: 5000,
    });

    setTimeout(() => autoRespondInit(mockProc), 0);
    await client.start();

    vi.useFakeTimers();

    const promise = client.request('thread/start', {});

    // Respond before timeout
    emitData(mockProc, JSON.stringify({ id: 2, result: { thread: { id: 't1' } } }) + '\n');

    const result = await promise;
    expect(result).toEqual({ thread: { id: 't1' } });

    // Advance past original deadline — should NOT reject
    vi.advanceTimersByTime(10000);

    vi.useRealTimers();
  });
});
