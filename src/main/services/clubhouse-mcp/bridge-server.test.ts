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
vi.mock('../agent-registry', () => ({
  getAgentNonce: (id: string) => mockGetAgentNonce(id),
  agentRegistry: { get: (id: string) => mockAgentRegistryGet(id) },
}));

vi.mock('../log-service', () => ({
  appLog: vi.fn(),
}));

import * as bridgeServer from './bridge-server';
import { bindingManager } from './binding-manager';
import { registerToolTemplate, buildToolName, _resetForTesting as resetTools } from './tool-registry';
import type { McpBinding } from './types';

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

describe('BridgeServer', () => {
  let port: number;

  beforeEach(async () => {
    bindingManager._resetForTesting();
    resetTools();
    mockGetAgentNonce.mockReturnValue('test-nonce');
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

  it('returns 405 for DELETE requests', async () => {
    const { statusCode } = await makeRequest(port, 'DELETE', '/mcp/agent-1', {}, 'test-nonce');
    expect(statusCode).toBe(405);
  });

  it('handles notifications/initialized without error', async () => {
    const { statusCode } = await makeRequest(port, 'POST', '/mcp/agent-1', {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }, 'test-nonce');
    expect(statusCode).toBe(200);
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
