import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'http';

// Track what gets sent to BrowserWindow
const mockSend = vi.fn();
const mockGetAllWindows = vi.fn(() => [{
  isDestroyed: () => false,
  webContents: { send: mockSend },
}]);

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => `/tmp/clubhouse-test-${name}`,
  },
  BrowserWindow: {
    getAllWindows: () => mockGetAllWindows(),
  },
}));

// Mock agent-system functions
const mockGetAgentProjectPath = vi.fn<(id: string) => string | undefined>();
const mockGetAgentOrchestrator = vi.fn<(id: string) => string | undefined>();
const mockResolveOrchestrator = vi.fn();

vi.mock('./agent-system', () => ({
  getAgentProjectPath: (id: string) => mockGetAgentProjectPath(id),
  getAgentOrchestrator: (id: string) => mockGetAgentOrchestrator(id),
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

function postToServer(port: number, path: string, body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
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

    beforeEach(() => {
      mockGetAgentProjectPath.mockReturnValue('/my/project');
      mockGetAgentOrchestrator.mockReturnValue('claude-code');
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
      });

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
      await postToServer(port, '/hook/agent-1', { hook_event_name: 'Stop' });
      await new Promise(r => setTimeout(r, 50));

      expect(mockResolveOrchestrator).toHaveBeenCalledWith('/my/project', 'claude-code');
    });

    it('uses fallback verb when provider returns undefined', async () => {
      mockResolveOrchestrator.mockReturnValue({
        parseHookEvent: vi.fn(() => ({
          kind: 'pre_tool',
          toolName: 'CustomTool',
        })),
        toolVerb: vi.fn(() => undefined),
      });

      await postToServer(port, '/hook/agent-1', { hook_event_name: 'PreToolUse', tool_name: 'CustomTool' });
      await new Promise(r => setTimeout(r, 50));

      expect(mockSend).toHaveBeenCalledWith(
        'agent:hook-event',
        'agent-1',
        expect.objectContaining({
          toolVerb: 'Using CustomTool',
        })
      );
    });
  });

  describe('fallback for unknown agent', () => {
    beforeEach(() => {
      mockGetAgentProjectPath.mockReturnValue(undefined);
    });

    it('sends raw normalized event when agent not tracked', async () => {
      await postToServer(port, '/hook/unknown-agent', {
        hook_event_name: 'Stop',
        message: 'finished',
      });
      await new Promise(r => setTimeout(r, 50));

      expect(mockSend).toHaveBeenCalledWith(
        'agent:hook-event',
        'unknown-agent',
        expect.objectContaining({
          kind: 'stop',
          message: 'finished',
        })
      );
    });

    it('maps PreToolUse to pre_tool in fallback', async () => {
      await postToServer(port, '/hook/x', { hook_event_name: 'PreToolUse', tool_name: 'Read' });
      await new Promise(r => setTimeout(r, 50));

      expect(mockSend).toHaveBeenCalledWith(
        'agent:hook-event',
        'x',
        expect.objectContaining({ kind: 'pre_tool', toolName: 'Read' })
      );
    });

    it('maps PostToolUseFailure to tool_error in fallback', async () => {
      await postToServer(port, '/hook/x', { hook_event_name: 'PostToolUseFailure' });
      await new Promise(r => setTimeout(r, 50));

      expect(mockSend).toHaveBeenCalledWith(
        'agent:hook-event',
        'x',
        expect.objectContaining({ kind: 'tool_error' })
      );
    });

    it('defaults unknown event names to stop in fallback', async () => {
      await postToServer(port, '/hook/x', { hook_event_name: 'Unknown' });
      await new Promise(r => setTimeout(r, 50));

      expect(mockSend).toHaveBeenCalledWith(
        'agent:hook-event',
        'x',
        expect.objectContaining({ kind: 'stop' })
      );
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
