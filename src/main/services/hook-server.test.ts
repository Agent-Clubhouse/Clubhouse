import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'http';

// Track what gets sent to BrowserWindow
const mockSend = vi.fn();
const mockGetAllWindows = vi.fn(() => [{
  isDestroyed: () => false,
  webContents: { send: mockSend },
}]);

vi.mock('electron', () => {
  const _os = require('os');
  const _path = require('path');
  return {
    app: {
      getPath: (name: string) => _path.join(_os.tmpdir(), `clubhouse-test-${name}`),
    },
    BrowserWindow: {
      getAllWindows: () => mockGetAllWindows(),
    },
  };
});

// Mock agent-registry functions (hook-server imports from agent-registry, not agent-system)
const mockGetAgentProjectPath = vi.fn<(id: string) => string | undefined>();
const mockGetAgentOrchestrator = vi.fn<(id: string) => string | undefined>();
const mockGetAgentNonce = vi.fn<(id: string) => string | undefined>();
const mockResolveOrchestrator = vi.fn();

vi.mock('./agent-registry', () => ({
  getAgentProjectPath: (id: string) => mockGetAgentProjectPath(id),
  getAgentOrchestrator: (id: string) => mockGetAgentOrchestrator(id),
  getAgentNonce: (id: string) => mockGetAgentNonce(id),
  resolveOrchestrator: (...args: unknown[]) => mockResolveOrchestrator(...args),
}));

vi.mock('../orchestrators', () => ({
  isHookCapable: vi.fn((provider: any) => typeof provider.parseHookEvent === 'function'),
}));

vi.mock('../../shared/ipc-channels', () => ({
  IPC: {
    AGENT: {
      HOOK_EVENT: 'agent:hook-event',
    },
  },
}));

const mockAppLog = vi.fn();
vi.mock('./log-service', () => ({
  appLog: (...args: unknown[]) => mockAppLog(...args),
}));

const mockCreatePermission = vi.fn();
vi.mock('./annex-permission-queue', () => ({
  createPermission: (...args: unknown[]) => mockCreatePermission(...args),
}));

const mockEmitHookEvent = vi.fn();
vi.mock('./annex-event-bus', () => ({
  emitHookEvent: (...args: unknown[]) => mockEmitHookEvent(...args),
}));

import { start, stop, getPort, waitReady } from './hook-server';

function postToServer(port: number, path: string, body: unknown, extraHeaders?: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...extraHeaders },
    }, (res) => {
      res.resume();
      resolve(res.statusCode || 0);
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function postToServerWithBody(port: number, urlPath: string, body: unknown, extraHeaders?: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...extraHeaders },
    }, (res) => {
      let responseBody = '';
      res.on('data', (chunk: Buffer) => { responseBody += chunk; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: responseBody }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function getFromServer(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'GET',
    }, (res) => {
      res.resume();
      resolve(res.statusCode || 0);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('hook-server', () => {
  let port: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    port = await start();
  });

  afterEach(() => {
    stop();
  });

  describe('start/stop/getPort', () => {
    it('starts on a random port', () => {
      expect(port).toBeGreaterThan(0);
      expect(getPort()).toBe(port);
    });

    it('waitReady resolves with port after start', async () => {
      const p = await waitReady();
      expect(p).toBe(port);
    });

    it('resets port after stop', () => {
      stop();
      expect(getPort()).toBe(0);
    });
  });

  describe('request routing', () => {
    it('returns 404 for non-POST requests', async () => {
      const status = await getFromServer(port, '/hook/agent-1');
      expect(status).toBe(404);
    });

    it('returns 404 for non-hook paths', async () => {
      const status = await postToServer(port, '/other', {});
      expect(status).toBe(404);
    });

    it('returns 400 for empty agentId', async () => {
      const status = await postToServer(port, '/hook/', {});
      expect(status).toBe(400);
    });

    it('returns 200 for valid hook POST', async () => {
      mockGetAgentProjectPath.mockReturnValue(undefined);
      const status = await postToServer(port, '/hook/agent-1', { hook_event_name: 'Stop' });
      expect(status).toBe(200);
    });
  });

  describe('event normalization with known agent', () => {
    const mockNormalized = {
      kind: 'pre_tool' as const,
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      message: undefined,
    };
    const VALID_NONCE = 'test-nonce-abc';

    beforeEach(() => {
      mockGetAgentProjectPath.mockReturnValue('/my/project');
      mockGetAgentOrchestrator.mockReturnValue('claude-code');
      mockGetAgentNonce.mockReturnValue(VALID_NONCE);
      mockResolveOrchestrator.mockResolvedValue({
        parseHookEvent: vi.fn(() => mockNormalized),
        toolVerb: vi.fn((name: string) => name === 'Bash' ? 'Running command' : undefined),
      });
    });

    it('normalizes event via provider and sends to renderer', async () => {
      await postToServer(port, '/hook/agent-1', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      }, { 'X-Clubhouse-Nonce': VALID_NONCE });

      // Give the event handler a tick to process
      await new Promise(r => setTimeout(r, 50));

      expect(mockSend).toHaveBeenCalledWith(
        'agent:hook-event',
        'agent-1',
        expect.objectContaining({
          kind: 'pre_tool',
          toolName: 'Bash',
          toolVerb: 'Running command',
          timestamp: expect.any(Number),
        })
      );
    });

    it('resolves orchestrator with correct project path', async () => {
      await postToServer(port, '/hook/agent-1', { hook_event_name: 'Stop' }, { 'X-Clubhouse-Nonce': VALID_NONCE });
      await new Promise(r => setTimeout(r, 50));

      expect(mockResolveOrchestrator).toHaveBeenCalledWith('/my/project', 'claude-code');
    });

    it('injects event hint from URL path when hook_event_name is missing (GHCP format)', async () => {
      const parseHookEvent = vi.fn((raw: Record<string, unknown>) => ({
        kind: 'pre_tool' as const,
        toolName: raw.toolName as string,
        toolInput: undefined,
        message: undefined,
      }));
      mockResolveOrchestrator.mockResolvedValue({
        parseHookEvent,
        toolVerb: vi.fn(() => 'Running command'),
      });

      // POST to /hook/{agentId}/{eventHint} — simulates GHCP hook that doesn't include hook_event_name
      await postToServer(port, '/hook/agent-1/preToolUse', {
        toolName: 'shell',
        toolArgs: '{"command": "ls"}',
      }, { 'X-Clubhouse-Nonce': VALID_NONCE });

      await new Promise(r => setTimeout(r, 50));

      // parseHookEvent should receive the injected hook_event_name
      expect(parseHookEvent).toHaveBeenCalledWith(
        expect.objectContaining({ hook_event_name: 'preToolUse', toolName: 'shell' })
      );
      expect(mockSend).toHaveBeenCalledWith(
        'agent:hook-event',
        'agent-1',
        expect.objectContaining({ kind: 'pre_tool', toolName: 'shell' })
      );
    });

    it('does not override existing hook_event_name with URL hint', async () => {
      const parseHookEvent = vi.fn(() => mockNormalized);
      mockResolveOrchestrator.mockResolvedValue({
        parseHookEvent,
        toolVerb: vi.fn(() => 'Running command'),
      });

      // URL says postToolUse, but payload says PreToolUse — payload wins
      await postToServer(port, '/hook/agent-1/postToolUse', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
      }, { 'X-Clubhouse-Nonce': VALID_NONCE });

      await new Promise(r => setTimeout(r, 50));

      expect(parseHookEvent).toHaveBeenCalledWith(
        expect.objectContaining({ hook_event_name: 'PreToolUse' })
      );
    });

    it('uses fallback verb when provider returns undefined', async () => {
      mockResolveOrchestrator.mockResolvedValue({
        parseHookEvent: vi.fn(() => ({
          kind: 'pre_tool',
          toolName: 'CustomTool',
        })),
        toolVerb: vi.fn(() => undefined),
      });

      await postToServer(port, '/hook/agent-1', { hook_event_name: 'PreToolUse', tool_name: 'CustomTool' }, { 'X-Clubhouse-Nonce': VALID_NONCE });
      await new Promise(r => setTimeout(r, 50));

      expect(mockSend).toHaveBeenCalledWith(
        'agent:hook-event',
        'agent-1',
        expect.objectContaining({
          toolVerb: 'Using CustomTool',
        })
      );
    });

    it('rejects events with wrong nonce', async () => {
      const status = await postToServer(port, '/hook/agent-1', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
      }, { 'X-Clubhouse-Nonce': 'wrong-nonce' });
      await new Promise(r => setTimeout(r, 50));

      expect(status).toBe(200);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('rejects events with missing nonce', async () => {
      const status = await postToServer(port, '/hook/agent-1', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
      });
      await new Promise(r => setTimeout(r, 50));

      expect(status).toBe(200);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('unknown agent events are discarded', () => {
    beforeEach(() => {
      mockGetAgentProjectPath.mockReturnValue(undefined);
    });

    it('returns 200 but does not forward event to renderer', async () => {
      const status = await postToServer(port, '/hook/unknown-agent', {
        hook_event_name: 'Stop',
        message: 'finished',
      });
      await new Promise(r => setTimeout(r, 50));

      expect(status).toBe(200);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('silently discards pre_tool events from untracked agents', async () => {
      const status = await postToServer(port, '/hook/x', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
      });
      await new Promise(r => setTimeout(r, 50));

      expect(status).toBe(200);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('body size limit', () => {
    it('returns 413 for requests exceeding 1MB', async () => {
      const status = await new Promise<number>((resolve, _reject) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port,
          path: '/hook/agent-1',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }, (res) => {
          res.resume();
          resolve(res.statusCode || 0);
        });
        req.on('error', () => {
          // Connection may be destroyed before we get a response
          resolve(413);
        });
        // Send just over 1MB of data
        const chunk = Buffer.alloc(64 * 1024, 'x');
        for (let i = 0; i < 17; i++) {
          req.write(chunk);
        }
        req.end();
      });

      expect(status).toBe(413);
    });

    it('accepts requests under 1MB', async () => {
      mockGetAgentProjectPath.mockReturnValue(undefined);
      const status = await postToServer(port, '/hook/agent-1', { hook_event_name: 'Stop' });
      expect(status).toBe(200);
    });
  });

  describe('error handling', () => {
    it('ignores malformed JSON without crashing', async () => {
      // Send raw string that's not JSON
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port,
          path: '/hook/agent-1',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }, (res) => {
          res.resume();
          resolve(res.statusCode || 0);
        });
        req.on('error', reject);
        req.write('not json at all');
        req.end();
      });

      expect(status).toBe(200); // Still returns 200
      await new Promise(r => setTimeout(r, 50));
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('handles no BrowserWindow gracefully', async () => {
      mockGetAgentProjectPath.mockReturnValue(undefined);
      mockGetAllWindows.mockReturnValue([]);

      const status = await postToServer(port, '/hook/agent-1', { hook_event_name: 'Stop' });
      expect(status).toBe(200);
      await new Promise(r => setTimeout(r, 50));
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('handles parseHookEvent throwing an error', async () => {
      mockGetAgentProjectPath.mockReturnValue('/my/project');
      mockGetAgentOrchestrator.mockReturnValue('claude-code');
      mockGetAgentNonce.mockReturnValue(undefined);
      mockResolveOrchestrator.mockResolvedValue({
        parseHookEvent: vi.fn(() => { throw new Error('Parse error'); }),
        toolVerb: vi.fn(),
      });

      const status = await postToServer(port, '/hook/agent-1', { hook_event_name: 'PreToolUse' });
      expect(status).toBe(200);
      await new Promise(r => setTimeout(r, 50));
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('permission request handling', () => {
    const VALID_NONCE = 'perm-nonce';

    beforeEach(() => {
      mockGetAgentProjectPath.mockReturnValue('/my/project');
      mockGetAgentOrchestrator.mockReturnValue('claude-code');
      mockGetAgentNonce.mockReturnValue(VALID_NONCE);
    });

    it('holds response for permission_request until decision is resolved with allow', async () => {
      let resolveDecision!: (value: string) => void;
      const decisionPromise = new Promise<string>((resolve) => { resolveDecision = resolve; });

      mockCreatePermission.mockReturnValue({
        requestId: 'req-1',
        decision: decisionPromise,
      });
      mockResolveOrchestrator.mockResolvedValue({
        parseHookEvent: vi.fn(() => ({
          kind: 'permission_request',
          toolName: 'Bash',
          toolInput: { command: 'rm -rf /' },
          message: 'Allow dangerous command?',
        })),
        toolVerb: vi.fn(() => 'Running command'),
      });

      // Start the request — it should block until we resolve
      const responsePromise = postToServerWithBody(port, '/hook/agent-1', {
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
      }, { 'X-Clubhouse-Nonce': VALID_NONCE });

      // Give server time to process
      await new Promise(r => setTimeout(r, 50));

      // Verify createPermission was called
      expect(mockCreatePermission).toHaveBeenCalledWith(
        'agent-1',
        'Bash',
        { command: 'rm -rf /' },
        'Allow dangerous command?',
        120_000,
      );

      // Resolve the decision
      resolveDecision('allow');
      const response = await responsePromise;

      expect(response.status).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.hookSpecificOutput.permissionDecision).toBe('allow');
    });

    it('returns deny decision when permission is denied', async () => {
      mockCreatePermission.mockReturnValue({
        requestId: 'req-2',
        decision: Promise.resolve('deny'),
      });
      mockResolveOrchestrator.mockResolvedValue({
        parseHookEvent: vi.fn(() => ({
          kind: 'permission_request',
          toolName: 'Bash',
          toolInput: undefined,
          message: undefined,
        })),
        toolVerb: vi.fn(() => 'Running command'),
      });

      const response = await postToServerWithBody(port, '/hook/agent-1', {
        hook_event_name: 'PermissionRequest',
      }, { 'X-Clubhouse-Nonce': VALID_NONCE });

      const body = JSON.parse(response.body);
      expect(body.hookSpecificOutput.permissionDecision).toBe('deny');
    });

    it('returns "ask" fallback when permission times out', async () => {
      mockCreatePermission.mockReturnValue({
        requestId: 'req-3',
        decision: Promise.resolve('timeout'),
      });
      mockResolveOrchestrator.mockResolvedValue({
        parseHookEvent: vi.fn(() => ({
          kind: 'permission_request',
          toolName: 'Write',
          toolInput: { path: '/tmp/test' },
          message: undefined,
        })),
        toolVerb: vi.fn(() => 'Writing file'),
      });

      const response = await postToServerWithBody(port, '/hook/agent-1', {
        hook_event_name: 'PermissionRequest',
      }, { 'X-Clubhouse-Nonce': VALID_NONCE });

      const body = JSON.parse(response.body);
      expect(body.hookSpecificOutput.permissionDecision).toBe('ask');
    });

    it('uses "unknown" as tool name when normalized event has no toolName', async () => {
      mockCreatePermission.mockReturnValue({
        requestId: 'req-4',
        decision: Promise.resolve('allow'),
      });
      mockResolveOrchestrator.mockResolvedValue({
        parseHookEvent: vi.fn(() => ({
          kind: 'permission_request',
          toolName: undefined,
          toolInput: undefined,
          message: undefined,
        })),
        toolVerb: vi.fn(() => undefined),
      });

      await postToServerWithBody(port, '/hook/agent-1', {
        hook_event_name: 'PermissionRequest',
      }, { 'X-Clubhouse-Nonce': VALID_NONCE });

      expect(mockCreatePermission).toHaveBeenCalledWith(
        'agent-1',
        'unknown',
        undefined,
        undefined,
        120_000,
      );
    });

    it('broadcasts hook event to renderer before holding for permission', async () => {
      mockCreatePermission.mockReturnValue({
        requestId: 'req-5',
        decision: Promise.resolve('allow'),
      });
      mockResolveOrchestrator.mockResolvedValue({
        parseHookEvent: vi.fn(() => ({
          kind: 'permission_request',
          toolName: 'Bash',
          toolInput: undefined,
          message: undefined,
        })),
        toolVerb: vi.fn(() => 'Running command'),
      });

      await postToServerWithBody(port, '/hook/agent-1', {
        hook_event_name: 'PermissionRequest',
      }, { 'X-Clubhouse-Nonce': VALID_NONCE });

      // Should broadcast the event before holding for permission
      expect(mockSend).toHaveBeenCalledWith(
        'agent:hook-event',
        'agent-1',
        expect.objectContaining({ kind: 'permission_request', toolName: 'Bash' }),
      );
    });

    it('catches rejected decision promise without crashing', async () => {
      let rejectDecision!: (err: Error) => void;
      const decisionPromise = new Promise<string>((_resolve, reject) => { rejectDecision = reject; });

      mockCreatePermission.mockReturnValue({
        requestId: 'req-err',
        decision: decisionPromise,
      });
      mockResolveOrchestrator.mockResolvedValue({
        parseHookEvent: vi.fn(() => ({
          kind: 'permission_request',
          toolName: 'Bash',
          toolInput: undefined,
          message: undefined,
        })),
        toolVerb: vi.fn(() => 'Running command'),
      });

      // Fire the request but don't wait for a full response — the rejected
      // decision means the server may close the connection unexpectedly.
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/hook/agent-1',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Clubhouse-Nonce': VALID_NONCE,
        },
      });
      req.on('error', () => { /* expected — connection may reset */ });
      req.on('response', (res) => { res.resume(); });
      const data = JSON.stringify({ hook_event_name: 'PermissionRequest' });
      req.write(data);
      req.end();

      // Give server time to set up the .catch() handler before rejecting
      await new Promise(r => setTimeout(r, 50));
      rejectDecision(new Error('connection closed'));
      await new Promise(r => setTimeout(r, 50));

      expect(mockAppLog).toHaveBeenCalledWith(
        'core:hook-server', 'error', 'Failed to send permission response',
        expect.objectContaining({
          meta: expect.objectContaining({ agentId: 'agent-1', error: 'connection closed' }),
        }),
      );
    });
  });

  describe('parseHookEvent returning null', () => {
    const VALID_NONCE = 'null-nonce';

    beforeEach(() => {
      mockGetAgentProjectPath.mockReturnValue('/my/project');
      mockGetAgentOrchestrator.mockReturnValue('claude-code');
      mockGetAgentNonce.mockReturnValue(VALID_NONCE);
    });

    it('returns 200 but does not broadcast when parseHookEvent returns null', async () => {
      mockResolveOrchestrator.mockResolvedValue({
        parseHookEvent: vi.fn(() => null),
        toolVerb: vi.fn(),
      });

      const status = await postToServer(port, '/hook/agent-1', {
        hook_event_name: 'UnknownEvent',
      }, { 'X-Clubhouse-Nonce': VALID_NONCE });

      await new Promise(r => setTimeout(r, 50));
      expect(status).toBe(200);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('does not call toolVerb when parseHookEvent returns null', async () => {
      const mockToolVerb = vi.fn();
      mockResolveOrchestrator.mockResolvedValue({
        parseHookEvent: vi.fn(() => null),
        toolVerb: mockToolVerb,
      });

      await postToServer(port, '/hook/agent-1', {
        hook_event_name: 'SomeEvent',
      }, { 'X-Clubhouse-Nonce': VALID_NONCE });

      await new Promise(r => setTimeout(r, 50));
      expect(mockToolVerb).not.toHaveBeenCalled();
    });
  });

  describe('waitReady edge cases', () => {
    it('rejects when server has not been started', async () => {
      stop(); // Make sure server is stopped
      // Need to re-import to get a fresh module state — but since we share
      // module state, just verify the rejection
      // The server was stopped in this test, so waitReady should reject
      // after stop() sets readyPromise to null
      await expect(waitReady()).rejects.toThrow('Hook server not started');
    });
  });

  describe('annex event bus integration', () => {
    const VALID_NONCE = 'bus-nonce';

    beforeEach(() => {
      mockGetAgentProjectPath.mockReturnValue('/my/project');
      mockGetAgentOrchestrator.mockReturnValue('claude-code');
      mockGetAgentNonce.mockReturnValue(VALID_NONCE);
    });

    it('emits hook event to annex event bus', async () => {
      mockResolveOrchestrator.mockResolvedValue({
        parseHookEvent: vi.fn(() => ({
          kind: 'pre_tool',
          toolName: 'Read',
          toolInput: { path: '/tmp/file' },
          message: undefined,
        })),
        toolVerb: vi.fn(() => 'Reading file'),
      });

      await postToServer(port, '/hook/agent-1', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
      }, { 'X-Clubhouse-Nonce': VALID_NONCE });

      await new Promise(r => setTimeout(r, 50));

      expect(mockEmitHookEvent).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({
          kind: 'pre_tool',
          toolName: 'Read',
          toolVerb: 'Reading file',
        }),
      );
    });
  });
});
