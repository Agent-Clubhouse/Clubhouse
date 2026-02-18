import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

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

// Mock agent-system functions
const mockGetAgentProjectPath = vi.fn<(id: string) => string | undefined>();
const mockGetAgentOrchestrator = vi.fn<(id: string) => string | undefined>();
const mockGetAgentNonce = vi.fn<(id: string) => string | undefined>();
const mockResolveOrchestrator = vi.fn();

vi.mock('./agent-system', () => ({
  getAgentProjectPath: (id: string) => mockGetAgentProjectPath(id),
  getAgentOrchestrator: (id: string) => mockGetAgentOrchestrator(id),
  getAgentNonce: (id: string) => mockGetAgentNonce(id),
  resolveOrchestrator: (...args: unknown[]) => mockResolveOrchestrator(...args),
}));

vi.mock('../../shared/ipc-channels', () => ({
  IPC: {
    AGENT: {
      HOOK_EVENT: 'agent:hook-event',
    },
  },
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
      mockResolveOrchestrator.mockReturnValue({
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
      mockResolveOrchestrator.mockReturnValue({
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
      mockResolveOrchestrator.mockReturnValue({
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
      mockResolveOrchestrator.mockReturnValue({
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
  });
});
