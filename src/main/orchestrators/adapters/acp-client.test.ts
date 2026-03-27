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

describe('AcpClient', () => {
  let mockProc: ReturnType<typeof createMockProcess>;

  beforeEach(() => {
    mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc as unknown as ReturnType<typeof spawn>);
  });

  it('spawns process with correct options', () => {
    const client = new AcpClient({
      binary: '/usr/bin/copilot',
      args: ['--acp', '--stdio'],
      cwd: '/tmp/project',
      env: { PATH: '/usr/bin' },
    });
    client.start();

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

  it('sends JSON-RPC request and resolves on response', async () => {
    const client = new AcpClient({ binary: 'copilot', args: [] });
    client.start();

    const promise = client.request('session/start', { model: 'gpt-4' });

    // Verify the request was written to stdin
    expect(mockProc.stdin.write).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(
      (mockProc.stdin.write.mock.calls[0][0] as string).replace('\n', ''),
    );
    expect(sent).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/start',
      params: { model: 'gpt-4' },
    });

    // Simulate response from stdout
    emitData(
      mockProc,
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { sessionId: 'abc' },
      }) + '\n',
    );

    const result = await promise;
    expect(result).toEqual({ sessionId: 'abc' });
  });

  it('rejects request on JSON-RPC error response', async () => {
    const client = new AcpClient({ binary: 'copilot', args: [] });
    client.start();

    const promise = client.request('session/start', {});

    emitData(
      mockProc,
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32600, message: 'Invalid request' },
      }) + '\n',
    );

    await expect(promise).rejects.toThrow('RPC error -32600: Invalid request');
  });

  it('forwards notifications to callback', () => {
    const onNotification = vi.fn();
    const client = new AcpClient({
      binary: 'copilot',
      args: [],
      onNotification,
    });
    client.start();

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

  it('forwards server-initiated requests to callback', () => {
    const onServerRequest = vi.fn();
    const client = new AcpClient({
      binary: 'copilot',
      args: [],
      onServerRequest,
    });
    client.start();

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

  it('sends JSON-RPC response for server requests', () => {
    const client = new AcpClient({ binary: 'copilot', args: [] });
    client.start();

    // Reset the write mock after start
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

  it('handles chunked NDJSON across multiple data events', () => {
    const onNotification = vi.fn();
    const client = new AcpClient({
      binary: 'copilot',
      args: [],
      onNotification,
    });
    client.start();

    // Send partial JSON across two chunks
    emitData(mockProc, '{"jsonrpc":"2.0","method":"agent_');
    expect(onNotification).not.toHaveBeenCalled();

    emitData(mockProc, 'message_chunk","params":{"text":"hi"}}\n');
    expect(onNotification).toHaveBeenCalledWith('agent_message_chunk', {
      text: 'hi',
    });
  });

  it('handles multiple messages in a single chunk', () => {
    const onNotification = vi.fn();
    const client = new AcpClient({
      binary: 'copilot',
      args: [],
      onNotification,
    });
    client.start();

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
    const client = new AcpClient({ binary: 'copilot', args: [] });
    client.start();

    const p1 = client.request('method1', {});
    const p2 = client.request('method2', {});

    mockProc.emit('exit', 1, null);

    await expect(p1).rejects.toThrow('Process exited');
    await expect(p2).rejects.toThrow('Process exited');
  });

  it('calls onExit when process exits', () => {
    const onExit = vi.fn();
    const client = new AcpClient({
      binary: 'copilot',
      args: [],
      onExit,
    });
    client.start();

    mockProc.emit('exit', 0, null);

    expect(onExit).toHaveBeenCalledWith(0, null);
  });

  it('kills the process', () => {
    const client = new AcpClient({ binary: 'copilot', args: [] });
    client.start();

    client.kill();
    expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('kill() is idempotent', () => {
    const client = new AcpClient({ binary: 'copilot', args: [] });
    client.start();

    client.kill();
    client.kill();
    expect(mockProc.kill).toHaveBeenCalledTimes(1);
  });

  it('skips malformed JSON lines', () => {
    const onNotification = vi.fn();
    const client = new AcpClient({
      binary: 'copilot',
      args: [],
      onNotification,
    });
    client.start();

    emitData(
      mockProc,
      'not json\n{"jsonrpc":"2.0","method":"ok","params":{}}\n',
    );

    expect(onNotification).toHaveBeenCalledTimes(1);
    expect(onNotification).toHaveBeenCalledWith('ok', {});
  });

  it('reports alive status correctly', () => {
    const client = new AcpClient({ binary: 'copilot', args: [] });
    client.start();

    expect(client.alive).toBe(true);

    client.kill();
    expect(client.alive).toBe(false);
  });

  it('increments request IDs', async () => {
    const client = new AcpClient({ binary: 'copilot', args: [] });
    client.start();

    const p1 = client.request('method1', {});
    const p2 = client.request('method2', {});

    // Respond to both
    emitData(
      mockProc,
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'r1' }) +
        '\n' +
        JSON.stringify({ jsonrpc: '2.0', id: 2, result: 'r2' }) +
        '\n',
    );

    expect(await p1).toBe('r1');
    expect(await p2).toBe('r2');

    // First two write calls are the requests
    const ids = mockProc.stdin.write.mock.calls.map(
      (call) => JSON.parse((call[0] as string).replace('\n', '')).id,
    );
    expect(ids).toEqual([1, 2]);
  });

  // ── RpcError tests ────────────────────────────────────────────────────────

  it('rejects with RpcError preserving code and data', async () => {
    const client = new AcpClient({ binary: 'copilot', args: [] });
    client.start();

    const promise = client.request('session/start', {});

    emitData(
      mockProc,
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
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

  // ── onLog callback tests ──────────────────────────────────────────────────

  it('calls onLog for spawn', () => {
    const onLog = vi.fn();
    const client = new AcpClient({
      binary: '/usr/bin/copilot',
      args: ['--acp'],
      onLog,
    });
    client.start();

    expect(onLog).toHaveBeenCalledWith(
      'info',
      'Spawning ACP process',
      expect.objectContaining({
        binary: '/usr/bin/copilot',
        args: ['--acp'],
      }),
    );
  });

  it('calls onLog for RPC requests', () => {
    const onLog = vi.fn();
    const client = new AcpClient({ binary: 'copilot', args: [], onLog });
    client.start();

    client.request('session/start', { model: 'gpt-5' });

    expect(onLog).toHaveBeenCalledWith(
      'info',
      'RPC request → session/start',
      expect.objectContaining({
        method: 'session/start',
      }),
    );
  });

  it('calls onLog for RPC errors', async () => {
    const onLog = vi.fn();
    const client = new AcpClient({ binary: 'copilot', args: [], onLog });
    client.start();

    const promise = client.request('bad/method', {});

    emitData(
      mockProc,
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32601, message: 'Method not found' },
      }) + '\n',
    );

    await expect(promise).rejects.toThrow();

    expect(onLog).toHaveBeenCalledWith(
      'error',
      'RPC error ← id=1',
      expect.objectContaining({
        code: -32601,
        message: 'Method not found',
      }),
    );
  });

  // ── stderr capture tests ──────────────────────────────────────────────────

  it('captures stderr output and makes it accessible via getStderr', () => {
    const onLog = vi.fn();
    const client = new AcpClient({ binary: 'copilot', args: [], onLog });
    client.start();

    mockProc.stderr.emit('data', 'Warning: something\n');
    mockProc.stderr.emit('data', 'Error: broken\n');

    expect(client.getStderr()).toBe('Warning: something\nError: broken\n');
    expect(onLog).toHaveBeenCalledWith(
      'warn',
      'ACP process stderr',
      expect.objectContaining({ text: 'Warning: something' }),
    );
  });

  it('logs process exit with stderr and pending count', () => {
    const onLog = vi.fn();
    const client = new AcpClient({ binary: 'copilot', args: [], onLog });
    client.start();

    mockProc.stderr.emit('data', 'fatal error\n');
    client.request('session/start', {});

    mockProc.emit('exit', 1, null);

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

  it('logs malformed JSON lines', () => {
    const onLog = vi.fn();
    const client = new AcpClient({ binary: 'copilot', args: [], onLog });
    client.start();

    emitData(mockProc, 'this is not json\n');

    expect(onLog).toHaveBeenCalledWith(
      'warn',
      'Malformed JSON line from ACP stdout',
      expect.objectContaining({ line: 'this is not json' }),
    );
  });
});
