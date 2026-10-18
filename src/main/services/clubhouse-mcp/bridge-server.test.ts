import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'http';

vi.mock('electron', () => {
  const _os = require('os');
  const _path = require('path');
  return {
    app: {
      getPath: (name: string) => _path.join(_os.tmpdir(), `clubhouse-test-${name}`),
    },
    BrowserWindow: {
      getAllWindows: () => [],
    },
  };
});

const mockGetAgentNonce = vi.fn<(id: string) => string | undefined>();
const mockAgentRegistryGet = vi.fn<(id: string) => unknown>();
const authListeners = new Set<(agentId: string) => void>();
vi.mock('../agent-registry', () => ({
  getAgentNonce: (id: string) => mockGetAgentNonce(id),
  agentRegistry: {
    get: (id: string) => mockAgentRegistryGet(id),
    onAuthChange: (l: (agentId: string) => void) => { authListeners.add(l); return () => authListeners.delete(l); },
  },
}));
/** What agent-registry does on setNonce (changed) or untrack. */
const emitAuthChange = (agentId: string) => { for (const l of authListeners) l(agentId); };

vi.mock('../log-service', () => ({
  appLog: vi.fn(),
}));

const mockBroadcast = vi.fn();
vi.mock('../../util/ipc-broadcast', () => ({
  broadcastToAllWindows: (...args: unknown[]) => mockBroadcast(...args),
}));

import * as bridgeServer from './bridge-server';
import { bindingManager } from './binding-manager';
import { registerToolTemplate, buildToolName, _resetForTesting as resetTools } from './tool-registry';
import { IPC } from '../../../shared/ipc-channels';

function makeRequest(port: number, method: string, path: string, body?: unknown, nonce?: string, rawBody?: string): Promise<{ statusCode: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = rawBody ?? (body ? JSON.stringify(body) : undefined);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(nonce ? { 'X-Clubhouse-Nonce': nonce } : {}),
      },
    }, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(responseBody); } catch { parsed = responseBody; }
        resolve({ statusCode: res.statusCode || 0, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** POST a body in two separate socket writes, split at the given byte offset. */
function postSplitBody(port: number, path: string, data: Buffer, splitAt: number, nonce: string): Promise<{ statusCode: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, 'X-Clubhouse-Nonce': nonce },
    }, (res) => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode || 0, body: JSON.parse(responseBody) }));
    });
    req.on('error', reject);
    req.write(data.subarray(0, splitAt));
    setTimeout(() => req.end(data.subarray(splitAt)), 20);
  });
}

/** A raw request returning status, headers and body. */
function rawRequest(port: number, method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, path, method,
      headers: { ...headers, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ statusCode: res.statusCode || 0, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** Open a GET stream; resolves once headers arrive, collecting chunks into `chunks`. */
function openStream(port: number, path: string, headers: Record<string, string>): Promise<{ statusCode: number; chunks: string[]; ended: Promise<void>; close(): void }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      const chunks: string[] = [];
      const ended = new Promise<void>((done) => { res.on('end', () => done()); res.on('close', () => done()); });
      res.on('data', (c) => chunks.push(c.toString()));
      resolve({ statusCode: res.statusCode || 0, chunks, ended, close: () => res.destroy() });
    });
    req.on('error', (err) => { if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(err); });
    req.end();
  });
}

describe('BridgeServer', () => {
  let port: number;

  beforeEach(async () => {
    bindingManager._resetForTesting();
    resetTools();
    mockGetAgentNonce.mockReturnValue('test-nonce');
    mockBroadcast.mockReset();
    port = await bridgeServer.start();
  });

  afterEach(() => {
    bridgeServer.stop();
  });

  it('starts and returns a port', () => {
    expect(port).toBeGreaterThan(0);
    expect(bridgeServer.getPort()).toBe(port);
  });

  it('handles MCP initialize', async () => {
    const { statusCode, body } = await makeRequest(port, 'POST', '/mcp/agent-1', {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    }, 'test-nonce');

    expect(statusCode).toBe(200);
    expect(body.result.protocolVersion).toBe('2024-11-05');
    expect(body.result.capabilities.tools.listChanged).toBe(true);
    expect(body.result.serverInfo.name).toBe('clubhouse');
  });

  it('decodes multi-byte UTF-8 characters split across request chunks', async () => {
    const data = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 'req-€-🎉', method: 'initialize', params: {} }));
    const splitAt = data.indexOf(Buffer.from('€')) + 1;
    const { statusCode, body } = await postSplitBody(port, '/mcp/agent-1', data, splitAt, 'test-nonce');

    expect(statusCode).toBe(200);
    expect(body.id).toBe('req-€-🎉');
  });

  it('handles tools/list with empty bindings', async () => {
    const { body } = await makeRequest(port, 'POST', '/mcp/agent-1', {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    }, 'test-nonce');

    expect(body.result.tools).toEqual([]);
  });

  it('handles tools/list with bindings', async () => {
    registerToolTemplate('agent', 'send_message', {
      description: 'Send a message',
      inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
    }, vi.fn());

    // Mark target as running so all tools appear in scoped list
    mockAgentRegistryGet.mockImplementation((id: string) =>
      id === 'agent-2' ? { runtime: 'pty', projectPath: '/test', orchestrator: 'claude-code' } : undefined,
    );

    bindingManager.bind('agent-1', {
      targetId: 'agent-2', targetKind: 'agent', label: 'Agent 2',
      targetName: 'scrappy-robin', projectName: 'myapp',
    });

    const { body } = await makeRequest(port, 'POST', '/mcp/agent-1', {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/list',
    }, 'test-nonce');

    expect(body.result.tools).toHaveLength(1);
    const expectedName = buildToolName(
      { agentId: 'agent-1', targetId: 'agent-2', targetKind: 'agent', label: 'Agent 2', targetName: 'scrappy-robin', projectName: 'myapp' },
      'send_message',
    );
    expect(body.result.tools[0].name).toBe(expectedName);
  });

  it('handles tools/call', async () => {
    const handler = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'sent' }],
    });
    registerToolTemplate('agent', 'send_message', {
      description: 'Send a message',
      inputSchema: { type: 'object' },
    }, handler);

    bindingManager.bind('agent-1', {
      targetId: 'agent-2', targetKind: 'agent', label: 'Agent 2',
      targetName: 'scrappy-robin', projectName: 'myapp',
    });

    const toolName = buildToolName(
      { agentId: 'agent-1', targetId: 'agent-2', targetKind: 'agent', label: 'Agent 2', targetName: 'scrappy-robin', projectName: 'myapp' },
      'send_message',
    );

    const { body } = await makeRequest(port, 'POST', '/mcp/agent-1', {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: toolName, arguments: { message: 'hi' } },
    }, 'test-nonce');

    expect(body.result.content[0].text).toBe('sent');
    expect(handler).toHaveBeenCalled();
  });

  it('rejects requests with invalid nonce', async () => {
    mockGetAgentNonce.mockReturnValue('correct-nonce');
    const { statusCode } = await makeRequest(port, 'POST', '/mcp/agent-1', {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/list',
    }, 'wrong-nonce');

    expect(statusCode).toBe(403);
  });

  it('rejects requests when agent has no registered nonce (nonce bypass fix)', async () => {
    mockGetAgentNonce.mockReturnValue(undefined); // Agent not in registry
    const { statusCode } = await makeRequest(port, 'POST', '/mcp/unknown-agent', {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/list',
    });
    // Without nonce header and without expected nonce — should still be 403
    expect(statusCode).toBe(403);
  });

  it('rejects requests with no nonce header even when agent has one', async () => {
    mockGetAgentNonce.mockReturnValue('valid-nonce');
    const { statusCode } = await makeRequest(port, 'POST', '/mcp/agent-1', {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/list',
    }); // No nonce header
    expect(statusCode).toBe(403);
  });

  it('accepts requests when nonce matches exactly', async () => {
    mockGetAgentNonce.mockReturnValue('exact-nonce');
    const { statusCode, body } = await makeRequest(port, 'POST', '/mcp/agent-1', {
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/list',
    }, 'exact-nonce');
    expect(statusCode).toBe(200);
    expect(body.result).toBeDefined();
  });

  it('returns 404 for unknown routes', async () => {
    const { statusCode } = await makeRequest(port, 'POST', '/unknown', {}, 'test-nonce');
    expect(statusCode).toBe(404);
  });

  it('returns error for unknown methods', async () => {
    const { body } = await makeRequest(port, 'POST', '/mcp/agent-1', {
      jsonrpc: '2.0',
      id: 6,
      method: 'unknown/method',
    }, 'test-nonce');

    expect(body.error.code).toBe(-32601);
  });

  it('returns error for invalid JSON', async () => {
    const { statusCode, body } = await makeRequest(port, 'POST', '/mcp/agent-1', undefined, 'test-nonce', 'not json{');
    expect(statusCode).toBe(200);
    expect(body.error.code).toBe(-32700);
  });

  it('waitReady resolves when already started', async () => {
    const readyPort = await bridgeServer.waitReady();
    expect(readyPort).toBe(port);
  });

  it('stop resets port', () => {
    bridgeServer.stop();
    expect(bridgeServer.getPort()).toBe(0);
  });

  it('returns 405 for non-POST non-GET requests', async () => {
    const { statusCode } = await makeRequest(port, 'PUT', '/mcp/agent-1', {}, 'test-nonce');
    expect(statusCode).toBe(405);
  });

  it('returns 400 for DELETE without a session id', async () => {
    const { statusCode } = await makeRequest(port, 'DELETE', '/mcp/agent-1', {}, 'test-nonce');
    expect(statusCode).toBe(400);
  });

  it('handles notifications/initialized without error', async () => {
    const { statusCode } = await makeRequest(port, 'POST', '/mcp/agent-1', {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }, 'test-nonce');
    // Streamable HTTP: a notification gets 202 Accepted, no body (#2240).
    expect(statusCode).toBe(202);
  });

  it('records when an agent finishes the handshake and how many tools it was given', async () => {
    expect(bridgeServer.getAgentConnection('agent-1')).toBeNull();
    const before = Date.now();
    await makeRequest(port, 'POST', '/mcp/agent-1', { jsonrpc: '2.0', method: 'notifications/initialized' }, 'test-nonce');
    const conn = bridgeServer.getAgentConnection('agent-1');
    expect(conn?.connectedAt).toBeGreaterThanOrEqual(before);
    expect(conn?.toolCount).toBeNull();
    expect(mockBroadcast).toHaveBeenLastCalledWith(IPC.MCP_BINDING.AGENT_CONNECTION_CHANGED, 'agent-1');
    mockBroadcast.mockClear();
    await makeRequest(port, 'POST', '/mcp/agent-1', { jsonrpc: '2.0', id: 2, method: 'tools/list' }, 'test-nonce');
    expect(bridgeServer.getAgentConnection('agent-1')).toEqual({ connectedAt: conn?.connectedAt, toolCount: 0 });
    expect(mockBroadcast).toHaveBeenCalledWith(IPC.MCP_BINDING.AGENT_CONNECTION_CHANGED, 'agent-1');
    mockBroadcast.mockClear();
    await makeRequest(port, 'POST', '/mcp/agent-1', { jsonrpc: '2.0', id: 3, method: 'tools/list' }, 'test-nonce');
    expect(mockBroadcast).not.toHaveBeenCalled();
    expect(bridgeServer.getAgentConnection('agent-2')).toBeNull();
    bridgeServer.stop();
    expect(bridgeServer.getAgentConnection('agent-1')).toBeNull();
    expect(mockBroadcast).toHaveBeenCalledWith(IPC.MCP_BINDING.AGENT_CONNECTION_CHANGED, 'agent-1');
  });

  it('announces a tools/list connection even without an initialized notification', async () => {
    await makeRequest(port, 'POST', '/mcp/agent-1', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'test-nonce');
    expect(bridgeServer.getAgentConnection('agent-1')).toEqual({ connectedAt: expect.any(Number), toolCount: 0 });
    expect(mockBroadcast).toHaveBeenCalledWith(IPC.MCP_BINDING.AGENT_CONNECTION_CHANGED, 'agent-1');
  });

  it('returns missing tool name error for tools/call without name', async () => {
    const { body } = await makeRequest(port, 'POST', '/mcp/agent-1', {
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: {},
    }, 'test-nonce');
    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toContain('Missing tool name');
  });

  it('handles tools/call with failing handler', async () => {
    registerToolTemplate('agent', 'fail_tool', {
      description: 'Fails',
      inputSchema: { type: 'object' },
    }, vi.fn().mockRejectedValue(new Error('handler exploded')));

    bindingManager.bind('agent-1', {
      targetId: 'agent-2', targetKind: 'agent', label: 'A2',
      targetName: 'robin', projectName: 'app',
    });

    const toolName = buildToolName(
      { agentId: 'agent-1', targetId: 'agent-2', targetKind: 'agent', label: 'A2', targetName: 'robin', projectName: 'app' },
      'fail_tool',
    );

    const { body } = await makeRequest(port, 'POST', '/mcp/agent-1', {
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/call',
      params: { name: toolName, arguments: {} },
    }, 'test-nonce');

    expect(body.error.code).toBe(-32000);
    expect(body.error.message).toContain('handler exploded');
  });

  it('returns 404 for /mcp/ with no agent ID', async () => {
    const { statusCode } = await makeRequest(port, 'POST', '/mcp/', {}, 'test-nonce');
    expect(statusCode).toBe(404);
  });

  it('waitReady rejects when server not started', async () => {
    bridgeServer.stop();
    await expect(bridgeServer.waitReady()).rejects.toThrow('not started');
  });

  describe('TOOL_ACTIVITY broadcast', () => {
    it('broadcasts activity for agent tool calls', async () => {
      const handler = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
      });
      registerToolTemplate('agent', 'send_message', {
        description: 'Send',
        inputSchema: { type: 'object' },
      }, handler);

      bindingManager.bind('agent-1', {
        targetId: 'agent-2', targetKind: 'agent', label: 'A2',
        targetName: 'robin', projectName: 'app',
      });

      const toolName = buildToolName(
        { agentId: 'agent-1', targetId: 'agent-2', targetKind: 'agent', label: 'A2', targetName: 'robin', projectName: 'app' },
        'send_message',
      );

      await makeRequest(port, 'POST', '/mcp/agent-1', {
        jsonrpc: '2.0', id: 30, method: 'tools/call',
        params: { name: toolName, arguments: {} },
      }, 'test-nonce');

      const activityCall = mockBroadcast.mock.calls.find(
        (c: unknown[]) => c[0] === IPC.MCP_BINDING.TOOL_ACTIVITY,
      );
      expect(activityCall).toBeDefined();
      expect(activityCall![1]).toMatchObject({
        sourceAgentId: 'agent-1',
        targetId: 'agent-2',
        direction: 'forward',
        toolSuffix: 'send_message',
      });
    });

    it('broadcasts activity for group-project tool calls', async () => {
      const handler = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
      });
      registerToolTemplate('group-project', 'post_bulletin', {
        description: 'Post',
        inputSchema: { type: 'object' },
      }, handler);

      bindingManager.bind('agent-1', {
        targetId: 'gp-1', targetKind: 'group-project', label: 'My Group',
        targetName: 'mygroup',
      });

      const toolName = buildToolName(
        { agentId: 'agent-1', targetId: 'gp-1', targetKind: 'group-project', label: 'My Group', targetName: 'mygroup' },
        'post_bulletin',
      );

      await makeRequest(port, 'POST', '/mcp/agent-1', {
        jsonrpc: '2.0', id: 31, method: 'tools/call',
        params: { name: toolName, arguments: {} },
      }, 'test-nonce');

      const activityCall = mockBroadcast.mock.calls.find(
        (c: unknown[]) => c[0] === IPC.MCP_BINDING.TOOL_ACTIVITY,
      );
      expect(activityCall).toBeDefined();
      expect(activityCall![1]).toMatchObject({
        sourceAgentId: 'agent-1',
        targetId: 'gp-1',
        direction: 'forward',
        toolSuffix: 'post_bulletin',
      });
    });

    it('broadcasts reverse direction for read_output tool calls', async () => {
      const handler = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'data' }],
      });
      registerToolTemplate('agent', 'read_output', {
        description: 'Read output',
        inputSchema: { type: 'object' },
      }, handler);

      bindingManager.bind('agent-1', {
        targetId: 'agent-2', targetKind: 'agent', label: 'A2',
        targetName: 'robin', projectName: 'app',
      });

      const toolName = buildToolName(
        { agentId: 'agent-1', targetId: 'agent-2', targetKind: 'agent', label: 'A2', targetName: 'robin', projectName: 'app' },
        'read_output',
      );

      await makeRequest(port, 'POST', '/mcp/agent-1', {
        jsonrpc: '2.0', id: 33, method: 'tools/call',
        params: { name: toolName, arguments: {} },
      }, 'test-nonce');

      const activityCall = mockBroadcast.mock.calls.find(
        (c: unknown[]) => c[0] === IPC.MCP_BINDING.TOOL_ACTIVITY,
      );
      expect(activityCall).toBeDefined();
      expect(activityCall![1]).toMatchObject({
        direction: 'reverse',
        toolSuffix: 'read_output',
      });
    });
  });

  describe('Streamable HTTP sessions (#2240)', () => {
    const NONCE = { 'X-Clubhouse-Nonce': 'test-nonce' };
    const SSE = { ...NONCE, Accept: 'text/event-stream' };
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} };

    async function initialize(agent = 'agent-1'): Promise<string> {
      const res = await rawRequest(port, 'POST', `/mcp/${agent}`, NONCE, init);
      expect(res.statusCode).toBe(200);
      const sid = res.headers['mcp-session-id'];
      expect(typeof sid).toBe('string');
      return sid as string;
    }

    it('issues a session id on initialize and accepts it on later requests', async () => {
      const sid = await initialize();
      const list = await rawRequest(port, 'POST', '/mcp/agent-1', { ...NONCE, 'Mcp-Session-Id': sid }, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
      expect(list.statusCode).toBe(200);
      expect(JSON.parse(list.body).result.tools).toEqual([]);
      // Requests without one still work (the stdio bridge script never sends it).
      expect((await rawRequest(port, 'POST', '/mcp/agent-1', NONCE, { jsonrpc: '2.0', id: 3, method: 'tools/list' })).statusCode).toBe(200);
    });

    it('rejects an unknown session id, or one issued to another agent, with 404', async () => {
      const sid = await initialize('agent-2');
      expect((await rawRequest(port, 'POST', '/mcp/agent-1', { ...NONCE, 'Mcp-Session-Id': 'nope' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).statusCode).toBe(404);
      expect((await rawRequest(port, 'POST', '/mcp/agent-1', { ...NONCE, 'Mcp-Session-Id': sid }, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).statusCode).toBe(404);
    });

    it('never lets a session id stand in for the nonce', async () => {
      const sid = await initialize();
      expect((await rawRequest(port, 'POST', '/mcp/agent-1', { 'Mcp-Session-Id': sid }, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).statusCode).toBe(403);
      expect((await rawRequest(port, 'GET', '/mcp/agent-1', { 'Mcp-Session-Id': sid, Accept: 'text/event-stream' })).statusCode).toBe(403);
      expect((await rawRequest(port, 'DELETE', '/mcp/agent-1', { 'X-Clubhouse-Nonce': 'wrong', 'Mcp-Session-Id': sid })).statusCode).toBe(403);
    });

    it('requires a session id for the GET stream', async () => {
      expect((await rawRequest(port, 'GET', '/mcp/agent-1', SSE)).statusCode).toBe(400);
      const sid = await initialize();
      expect((await rawRequest(port, 'GET', '/mcp/agent-1', { ...NONCE, 'Mcp-Session-Id': sid, Accept: 'application/json' })).statusCode).toBe(406);
    });

    it('sends tools/list_changed on the session GET stream after a binding change', async () => {
      const sid = await initialize();
      const stream = await openStream(port, '/mcp/agent-1', { ...SSE, 'Mcp-Session-Id': sid });
      expect(stream.statusCode).toBe(200);
      await new Promise((r) => setTimeout(r, 30));
      bindingManager.bind('agent-1', { targetId: 'agent-2', targetKind: 'agent', label: 'A2' });
      await vi.waitFor(() => expect(stream.chunks.join('')).toContain('notifications/tools/list_changed'), { timeout: 2000 });
      // Every data line is a JSON-RPC message (the ping is a comment).
      const dataLines = stream.chunks.join('').split('\n').filter((l) => l.startsWith('data: '));
      expect(dataLines.map((l) => JSON.parse(l.slice(6)).method)).toEqual(['notifications/tools/list_changed']);
      stream.close();
    });

    it('DELETE ends the session and closes its stream', async () => {
      const sid = await initialize();
      const stream = await openStream(port, '/mcp/agent-1', { ...SSE, 'Mcp-Session-Id': sid });
      const del = await rawRequest(port, 'DELETE', '/mcp/agent-1', { ...NONCE, 'Mcp-Session-Id': sid });
      expect(del.statusCode).toBe(200);
      await stream.ended;
      // The session is gone: it is now unknown.
      expect((await rawRequest(port, 'POST', '/mcp/agent-1', { ...NONCE, 'Mcp-Session-Id': sid }, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).statusCode).toBe(404);
      expect((await rawRequest(port, 'DELETE', '/mcp/agent-1', { ...NONCE, 'Mcp-Session-Id': sid })).statusCode).toBe(404);
    });

    it('DELETE then an immediate binding change writes nothing after end', async () => {
      const proto = http.ServerResponse.prototype;
      const realWrite = proto.write;
      const realWriteHead = proto.writeHead;
      const writesAfterEnd: string[] = [];
      const writeSpy = vi.spyOn(proto, 'write').mockImplementation(function (this: http.ServerResponse, ...args: unknown[]) {
        if (this.writableEnded) writesAfterEnd.push(String(args[0]));
        return (realWrite as (...a: unknown[]) => boolean).apply(this, args);
      });
      // Change a binding in the same tick the DELETE is answered, i.e. right after endSession.
      const headSpy = vi.spyOn(proto, 'writeHead').mockImplementation(function (this: http.ServerResponse, ...args: unknown[]) {
        const result = (realWriteHead as (...a: unknown[]) => http.ServerResponse).apply(this, args);
        if (this.req?.method === 'DELETE' && args[0] === 200) {
          bindingManager.bind('agent-1', { targetId: 'agent-2', targetKind: 'agent', label: 'A2' });
        }
        return result;
      });
      try {
        const sid = await initialize();
        const stream = await openStream(port, '/mcp/agent-1', { ...SSE, 'Mcp-Session-Id': sid });
        await new Promise((r) => setTimeout(r, 20));
        expect((await rawRequest(port, 'DELETE', '/mcp/agent-1', { ...NONCE, 'Mcp-Session-Id': sid })).statusCode).toBe(200);
        await stream.ended;
        // Same for sessions ended by a nonce change: end, then a change in the same tick.
        const sid2 = await initialize();
        const stream2 = await openStream(port, '/mcp/agent-1', { ...SSE, 'Mcp-Session-Id': sid2 });
        await new Promise((r) => setTimeout(r, 20));
        emitAuthChange('agent-1');
        bindingManager.bind('agent-1', { targetId: 'agent-3', targetKind: 'agent', label: 'A3' });
        await stream2.ended;
        expect(writesAfterEnd).toEqual([]);
        expect(stream.chunks.join('') + stream2.chunks.join('')).not.toContain('list_changed');
      } finally {
        writeSpy.mockRestore();
        headSpy.mockRestore();
      }
    });

    it('ends an agent\'s sessions and streams when its nonce changes or it is untracked', async () => {
      const sid = await initialize();
      const stream = await openStream(port, '/mcp/agent-1', { ...SSE, 'Mcp-Session-Id': sid });
      await initialize('agent-2');
      expect(bridgeServer._sessionCountForTesting('agent-1')).toBe(1);
      emitAuthChange('agent-1');
      await stream.ended;
      expect(bridgeServer._sessionCountForTesting('agent-1')).toBe(0);
      expect(bridgeServer._sessionCountForTesting('agent-2')).toBe(1);
      expect((await rawRequest(port, 'POST', '/mcp/agent-1', { ...NONCE, 'Mcp-Session-Id': sid }, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).statusCode).toBe(404);
    });

    it('treats a session issued under an earlier nonce as unknown', async () => {
      const sid = await initialize();
      mockGetAgentNonce.mockReturnValue('new-nonce');
      const res = await rawRequest(port, 'POST', '/mcp/agent-1', { 'X-Clubhouse-Nonce': 'new-nonce', 'Mcp-Session-Id': sid }, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
      expect(res.statusCode).toBe(404);
      expect(bridgeServer._sessionCountForTesting('agent-1')).toBe(0);
    });

    it(`keeps at most ${bridgeServer.MAX_SESSIONS_PER_AGENT} sessions per agent, evicting the oldest with its stream`, async () => {
      const first = await initialize();
      const firstStream = await openStream(port, '/mcp/agent-1', { ...SSE, 'Mcp-Session-Id': first });
      const ids = [first];
      for (let i = 0; i < bridgeServer.MAX_SESSIONS_PER_AGENT; i++) ids.push(await initialize());
      expect(bridgeServer._sessionCountForTesting('agent-1')).toBe(bridgeServer.MAX_SESSIONS_PER_AGENT);
      await firstStream.ended;
      const list = (sid: string) => rawRequest(port, 'POST', '/mcp/agent-1', { ...NONCE, 'Mcp-Session-Id': sid }, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
      expect((await list(ids[0])).statusCode).toBe(404);
      expect((await list(ids[1])).statusCode).toBe(200);
      expect((await list(ids.at(-1)!)).statusCode).toBe(200);
    });

    it('answers a batch (array) body with a JSON-RPC error, not 202', async () => {
      const res = await rawRequest(port, 'POST', '/mcp/agent-1', NONCE, [{ jsonrpc: '2.0', method: 'notifications/initialized' }]);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32600 } });
    });

    it('keeps /events working for the stdio bridge, with its ping event', async () => {
      const stream = await openStream(port, '/mcp/agent-1/events', NONCE);
      expect(stream.statusCode).toBe(200);
      await vi.waitFor(() => expect(stream.chunks.join('')).toContain('event: ping'));
      stream.close();
    });

    it('rejects a nonce of a different length or content', async () => {
      for (const nonce of ['test-nonc', 'test-nonce-x', 'TEST-NONCE']) {
        expect((await rawRequest(port, 'POST', '/mcp/agent-1', { 'X-Clubhouse-Nonce': nonce }, init)).statusCode).toBe(403);
      }
    });
  });

  describe('SSE events', () => {
    it('sends tools/list_changed notification on binding change', async () => {
      // Register a tool so tools/list has something to return
      registerToolTemplate('agent', 'test', {
        description: 'Test',
        inputSchema: { type: 'object' },
      }, vi.fn());

      // Connect SSE
      const events: string[] = [];
      const ssePromise = new Promise<void>((resolve) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port,
          path: '/mcp/agent-1/events',
          method: 'GET',
          headers: { 'X-Clubhouse-Nonce': 'test-nonce' },
        }, (res) => {
          res.on('data', (chunk) => {
            const data = chunk.toString();
            events.push(data);
            // After receiving the notification, resolve
            if (data.includes('list_changed')) {
              res.destroy();
              resolve();
            }
          });
        });
        req.on('error', () => {}); // Ignore close errors
        req.end();
      });

      // Wait a tick for SSE to connect
      await new Promise((r) => setTimeout(r, 50));

      // Trigger binding change
      bindingManager.bind('agent-1', { targetId: 'agent-2', targetKind: 'agent', label: 'A2' });

      await Promise.race([
        ssePromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('SSE timeout')), 2000)),
      ]);

      const hasNotification = events.some(e => e.includes('list_changed'));
      expect(hasNotification).toBe(true);
    });
  });
});
