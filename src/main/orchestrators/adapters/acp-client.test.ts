import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// Mock child_process.spawn
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'child_process';
import { AcpClient, RpcError } from './acp-client';

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

/**
 * Helper: auto-respond to the initialize handshake so start() resolves.
 * Listens for the first stdin.write call (the initialize request) and
 * immediately emits a success response + lets the initialized notification pass.
 */
function autoHandshake(proc: ReturnType<typeof createMockProcess>): void {
  // Intercept the first write (which will be the initialize request) and reply
  const originalWrite = proc.stdin.write;
  let handshakeDone = false;
  proc.stdin.write = vi.fn((...args: unknown[]) => {
    const result = (originalWrite as (...a: unknown[]) => boolean)(...args);
    if (!handshakeDone) {
      const line = args[0] as string;
      try {
        const msg = JSON.parse(line.replace('\n', ''));
        if (msg.method === 'initialize') {
          handshakeDone = true;
          // Schedule the response for the next microtask so the
          // pending map is populated before we dispatch
          queueMicrotask(() => {
            emitData(
              proc,
              JSON.stringify({
                jsonrpc: '2.0',
                id: msg.id,
                result: {
                  protocolVersion: 1,
                  agentCapabilities: {},
                  agentInfo: { name: 'Test', version: '1.0.0' },
                },
              }) + '\n',
            );
          });
        }
      } catch {
        // not JSON yet, ignore
      }
    }
    return result;
  });
}

describe('AcpClient', () => {
  let mockProc: ReturnType<typeof createMockProcess>;

  beforeEach(() => {
    mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc as unknown as ReturnType<typeof spawn>);
  });

  it('spawns process with correct options', async () => {
    autoHandshake(mockProc);
    const client = new AcpClient({
      binary: '/usr/bin/copilot',
      args: ['--acp', '--stdio'],
      cwd: '/tmp/project',
      env: { PATH: '/usr/bin' },
    });
    await client.start();

    expect(mockSpawn).toHaveBeenCalledWith(
      '/usr/bin/copilot',
      ['--acp', '--stdio'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: '/tmp/project',
        env: { PATH: '/usr/bin' },
      },
    );
  });

  it('performs initialize handshake during start()', async () => {
    autoHandshake(mockProc);
    const client = new AcpClient({
      binary: 'copilot',
      args: [],
      clientInfo: { name: 'test-client', version: '2.0.0' },
    });
    await client.start();

    // First write should be the initialize request
    const firstWrite = JSON.parse(
      (mockProc.stdin.write.mock.calls[0][0] as string).replace('\n', ''),
    );
    expect(firstWrite).toMatchObject({
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientInfo: { name: 'test-client', version: '2.0.0' },
        capabilities: {},
      },
    });

    // Second write should be the initialized notification
    const secondWrite = JSON.parse(
      (mockProc.stdin.write.mock.calls[1][0] as string).replace('\n', ''),
    );
    expect(secondWrite).toMatchObject({
      jsonrpc: '2.0',
      method: 'initialized',
    });
    // Notifications should not have an id
    expect(secondWrite.id).toBeUndefined();
  });

  it('uses default clientInfo when not provided', async () => {
    autoHandshake(mockProc);
    const client = new AcpClient({ binary: 'copilot', args: [] });
    await client.start();

    const firstWrite = JSON.parse(
      (mockProc.stdin.write.mock.calls[0][0] as string).replace('\n', ''),
    );
    expect(firstWrite.params.clientInfo).toEqual({
      name: 'clubhouse',
      version: '1.0.0',
    });
  });

  it('sends JSON-RPC request and resolves on response', async () => {
    autoHandshake(mockProc);
    const client = new AcpClient({ binary: 'copilot', args: [] });
    await client.start();

    const promise = client.request('session/new', { cwd: '/tmp' });

    // Simulate response from stdout
    emitData(
      mockProc,
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2, // id=1 was the initialize request
        result: { sessionId: 'abc' },
      }) + '\n',
    );

    const result = await promise;
    expect(result).toEqual({ sessionId: 'abc' });
  });

  it('rejects request on JSON-RPC error response', async () => {
    autoHandshake(mockProc);
    const client = new AcpClient({ binary: 'copilot', args: [] });
    await client.start();

    const promise = client.request('session/new', {});

    emitData(
      mockProc,
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        error: { code: -32600, message: 'Invalid request' },
      }) + '\n',
    );

    await expect(promise).rejects.toThrow('RPC error -32600: Invalid request');
  });

  it('forwards notifications to callback', async () => {
    autoHandshake(mockProc);
    const onNotification = vi.fn();
    const client = new AcpClient({
      binary: 'copilot',
      args: [],
      onNotification,
    });
    await client.start();

    emitData(
      mockProc,
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'agent_message_chunk',
        params: { text: 'hello' },
      }) + '\n',
    );

    expect(onNotification).toHaveBeenCalledWith('agent_message_chunk', {
      text: 'hello',
    });
  });

  it('forwards server-initiated requests to callback', async () => {
    autoHandshake(mockProc);
    const onServerRequest = vi.fn();
    const client = new AcpClient({
      binary: 'copilot',
      args: [],
      onServerRequest,
    });
    await client.start();

    emitData(
      mockProc,
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'perm-1',
        method: 'session/request_permission',
        params: { tool: 'shell', args: { command: 'rm -rf /' } },
      }) + '\n',
    );

    expect(onServerRequest).toHaveBeenCalledWith(
      'perm-1',
      'session/request_permission',
      { tool: 'shell', args: { command: 'rm -rf /' } },
    );
  });

  it('sends JSON-RPC response for server requests', async () => {
    autoHandshake(mockProc);
    const client = new AcpClient({ binary: 'copilot', args: [] });
    await client.start();

    // Reset the write mock after start handshake
    mockProc.stdin.write.mockClear();

    client.respond('perm-1', { approved: true });

    expect(mockProc.stdin.write).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(
      (mockProc.stdin.write.mock.calls[0][0] as string).replace('\n', ''),
    );
    expect(sent).toEqual({
      jsonrpc: '2.0',
      id: 'perm-1',
      result: { approved: true },
    });
  });

  it('sends JSON-RPC notification without id', async () => {
    autoHandshake(mockProc);
    const client = new AcpClient({ binary: 'copilot', args: [] });
    await client.start();

    mockProc.stdin.write.mockClear();
    client.notify('custom/event', { data: 'test' });

    const sent = JSON.parse(
      (mockProc.stdin.write.mock.calls[0][0] as string).replace('\n', ''),
    );
    expect(sent).toMatchObject({
      jsonrpc: '2.0',
      method: 'custom/event',
      params: { data: 'test' },
    });
    expect(sent.id).toBeUndefined();
  });

  it('handles chunked NDJSON across multiple data events', async () => {
    autoHandshake(mockProc);
    const onNotification = vi.fn();
    const client = new AcpClient({
      binary: 'copilot',
      args: [],
      onNotification,
    });
    await client.start();
    onNotification.mockClear();

    // Send partial JSON across two chunks
    emitData(mockProc, '{"jsonrpc":"2.0","method":"agent_');
    expect(onNotification).not.toHaveBeenCalled();

    emitData(mockProc, 'message_chunk","params":{"text":"hi"}}\n');
    expect(onNotification).toHaveBeenCalledWith('agent_message_chunk', {
      text: 'hi',
    });
  });

  it('handles multiple messages in a single chunk', async () => {
    autoHandshake(mockProc);
    const onNotification = vi.fn();
    const client = new AcpClient({
      binary: 'copilot',
      args: [],
      onNotification,
    });
    await client.start();
    onNotification.mockClear();

    emitData(
      mockProc,
      '{"jsonrpc":"2.0","method":"a","params":{}}\n' +
        '{"jsonrpc":"2.0","method":"b","params":{}}\n',
    );

    expect(onNotification).toHaveBeenCalledTimes(2);
    expect(onNotification).toHaveBeenCalledWith('a', {});
    expect(onNotification).toHaveBeenCalledWith('b', {});
  });

  it('rejects all pending requests on process exit', async () => {
    autoHandshake(mockProc);
    const client = new AcpClient({ binary: 'copilot', args: [] });
    await client.start();

    const p1 = client.request('method1', {});
    const p2 = client.request('method2', {});

    mockProc.emit('exit', 1, null);

    await expect(p1).rejects.toThrow('Process exited');
    await expect(p2).rejects.toThrow('Process exited');
  });

  it('calls onExit when process exits', async () => {
    autoHandshake(mockProc);
    const onExit = vi.fn();
    const client = new AcpClient({
      binary: 'copilot',
      args: [],
      onExit,
    });
    await client.start();

    mockProc.emit('exit', 0, null);

    expect(onExit).toHaveBeenCalledWith(0, null);
  });

  it('kills the process', async () => {
    autoHandshake(mockProc);
    const client = new AcpClient({ binary: 'copilot', args: [] });
    await client.start();

    client.kill();
    expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('kill() is idempotent', async () => {
    autoHandshake(mockProc);
    const client = new AcpClient({ binary: 'copilot', args: [] });
    await client.start();

    client.kill();
    client.kill();
    expect(mockProc.kill).toHaveBeenCalledTimes(1);
  });

  it('skips malformed JSON lines', async () => {
    autoHandshake(mockProc);
    const onNotification = vi.fn();
    const client = new AcpClient({
      binary: 'copilot',
      args: [],
      onNotification,
    });
    await client.start();
    onNotification.mockClear();

    emitData(
      mockProc,
      'not json\n{"jsonrpc":"2.0","method":"ok","params":{}}\n',
    );

    expect(onNotification).toHaveBeenCalledTimes(1);
    expect(onNotification).toHaveBeenCalledWith('ok', {});
  });

  it('reports alive status correctly', async () => {
    autoHandshake(mockProc);
    const client = new AcpClient({ binary: 'copilot', args: [] });
    await client.start();

    expect(client.alive).toBe(true);

    client.kill();
    expect(client.alive).toBe(false);
  });

  it('increments request IDs (continuing from init handshake)', async () => {
    autoHandshake(mockProc);
    const client = new AcpClient({ binary: 'copilot', args: [] });
    await client.start();

    // After start(), id=1 was used for initialize. Next requests get id=2, id=3.
    const p1 = client.request('method1', {});
    const p2 = client.request('method2', {});

    // Respond to both
    emitData(
      mockProc,
      JSON.stringify({ jsonrpc: '2.0', id: 2, result: 'r1' }) +
        '\n' +
        JSON.stringify({ jsonrpc: '2.0', id: 3, result: 'r2' }) +
        '\n',
    );

    expect(await p1).toBe('r1');
    expect(await p2).toBe('r2');
  });

  // ── RpcError tests ────────────────────────────────────────────────────────

  it('rejects with RpcError preserving code and data', async () => {
    autoHandshake(mockProc);
    const client = new AcpClient({ binary: 'copilot', args: [] });
    await client.start();

    const promise = client.request('session/new', {});

    emitData(
      mockProc,
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        error: { code: -32601, message: 'Method not found', data: { detail: 'no such method' } },
      }) + '\n',
    );

    await expect(promise).rejects.toThrow(RpcError);
    try {
      await promise;
    } catch (err) {
      const rpcErr = err as RpcError;
      expect(rpcErr.code).toBe(-32601);
      expect(rpcErr.data).toEqual({ detail: 'no such method' });
      expect(rpcErr.message).toContain('Method not found');
    }
  });

  // ── start() failure tests ──────────────────────────────────────────────────

  it('start() rejects if initialize handshake fails', async () => {
    // Override the mock to reject initialize
    const originalWrite = mockProc.stdin.write;
    mockProc.stdin.write = vi.fn((...args: unknown[]) => {
      const result = (originalWrite as (...a: unknown[]) => boolean)(...args);
      const line = args[0] as string;
      try {
        const msg = JSON.parse(line.replace('\n', ''));
        if (msg.method === 'initialize') {
          queueMicrotask(() => {
            emitData(
              mockProc,
              JSON.stringify({
                jsonrpc: '2.0',
                id: msg.id,
                error: { code: -32603, message: 'Internal error' },
              }) + '\n',
            );
          });
        }
      } catch {
        // ignore
      }
      return result;
    });

    const client = new AcpClient({ binary: 'copilot', args: [] });
    await expect(client.start()).rejects.toThrow('RPC error -32603');
  });

  // ── onLog callback tests ──────────────────────────────────────────────────

  it('calls onLog for spawn', async () => {
    autoHandshake(mockProc);
    const onLog = vi.fn();
    const client = new AcpClient({
      binary: '/usr/bin/copilot',
      args: ['--acp'],
      onLog,
    });
    await client.start();

    expect(onLog).toHaveBeenCalledWith(
      'info',
      'Spawning ACP process',
      expect.objectContaining({
        binary: '/usr/bin/copilot',
        args: ['--acp'],
      }),
    );
  });

  it('calls onLog for init handshake', async () => {
    autoHandshake(mockProc);
    const onLog = vi.fn();
    const client = new AcpClient({ binary: 'copilot', args: [], onLog });
    await client.start();

    expect(onLog).toHaveBeenCalledWith('info', 'Starting ACP init handshake', undefined);
    expect(onLog).toHaveBeenCalledWith('info', 'ACP init handshake complete', undefined);
  });

  it('calls onLog for RPC requests', async () => {
    autoHandshake(mockProc);
    const onLog = vi.fn();
    const client = new AcpClient({ binary: 'copilot', args: [], onLog });
    await client.start();

    client.request('session/new', { cwd: '/tmp' });

    expect(onLog).toHaveBeenCalledWith(
      'info',
      'RPC request → session/new',
      expect.objectContaining({
        method: 'session/new',
      }),
    );
  });

  it('calls onLog for RPC errors', async () => {
    autoHandshake(mockProc);
    const onLog = vi.fn();
    const client = new AcpClient({ binary: 'copilot', args: [], onLog });
    await client.start();

    const promise = client.request('bad/method', {});

    emitData(
      mockProc,
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        error: { code: -32601, message: 'Method not found' },
      }) + '\n',
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

  it('captures stderr output and makes it accessible via getStderr', async () => {
    autoHandshake(mockProc);
    const onLog = vi.fn();
    const client = new AcpClient({ binary: 'copilot', args: [], onLog });
    await client.start();

    mockProc.stderr.emit('data', 'Warning: something\n');
    mockProc.stderr.emit('data', 'Error: broken\n');

    expect(client.getStderr()).toBe('Warning: something\nError: broken\n');
    expect(onLog).toHaveBeenCalledWith(
      'warn',
      'ACP process stderr',
      expect.objectContaining({ text: 'Warning: something' }),
    );
  });

  it('logs process exit with stderr and pending count', async () => {
    autoHandshake(mockProc);
    const onLog = vi.fn();
    const client = new AcpClient({ binary: 'copilot', args: [], onLog });
    await client.start();

    mockProc.stderr.emit('data', 'fatal error\n');
    const pendingRequest = client.request('session/new', {});

    mockProc.emit('exit', 1, null);

    // Consume the rejection to avoid unhandled promise rejection
    await expect(pendingRequest).rejects.toThrow('Process exited');

    expect(onLog).toHaveBeenCalledWith(
      'error',
      'ACP process exited',
      expect.objectContaining({
        code: 1,
        pendingRequests: 1,
        stderr: 'fatal error',
      }),
    );
  });

  it('logs malformed JSON lines', async () => {
    autoHandshake(mockProc);
    const onLog = vi.fn();
    const client = new AcpClient({ binary: 'copilot', args: [], onLog });
    await client.start();

    emitData(mockProc, 'this is not json\n');

    expect(onLog).toHaveBeenCalledWith(
      'warn',
      'Malformed JSON line from ACP stdout',
      expect.objectContaining({ line: 'this is not json' }),
    );
  });

  // ── RPC timeout tests ────────────────────────────────────────────────────

  it('rejects request after timeout', async () => {
    vi.useFakeTimers();
    autoHandshake(mockProc);
    const onLog = vi.fn();
    const client = new AcpClient({
      binary: 'copilot',
      args: [],
      onLog,
      rpcTimeoutMs: 500,
    });
    await client.start();

    const promise = client.request('session/new', { cwd: '/tmp' });

    // Advance past the timeout
    vi.advanceTimersByTime(600);

    await expect(promise).rejects.toThrow("RPC request 'session/new' timed out after 500ms");
    expect(onLog).toHaveBeenCalledWith(
      'error',
      'RPC timeout → session/new',
      expect.objectContaining({ timeoutMs: 500 }),
    );

    vi.useRealTimers();
  });

  it('clears timeout when response arrives before deadline', async () => {
    vi.useFakeTimers();
    autoHandshake(mockProc);
    const client = new AcpClient({
      binary: 'copilot',
      args: [],
      rpcTimeoutMs: 5000,
    });
    await client.start();

    const promise = client.request('session/new', {});

    // Respond before timeout
    emitData(
      mockProc,
      JSON.stringify({ jsonrpc: '2.0', id: 2, result: { sessionId: 'ok' } }) + '\n',
    );

    const result = await promise;
    expect(result).toEqual({ sessionId: 'ok' });

    // Advance timer past original deadline — should NOT reject
    vi.advanceTimersByTime(10000);

    vi.useRealTimers();
  });

  it('uses default 30s timeout when rpcTimeoutMs not specified', async () => {
    vi.useFakeTimers();
    autoHandshake(mockProc);
    const onLog = vi.fn();
    const client = new AcpClient({ binary: 'copilot', args: [], onLog });
    await client.start();

    const promise = client.request('session/new', {});

    // Advance just under 30s — should NOT timeout yet
    vi.advanceTimersByTime(29_000);

    // Advance past 30s — should timeout
    vi.advanceTimersByTime(2_000);

    await expect(promise).rejects.toThrow('timed out after 30000ms');

    vi.useRealTimers();
  });
});
