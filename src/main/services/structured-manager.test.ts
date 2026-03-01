import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { StructuredEvent } from '../../shared/structured-events';
import type { StructuredAdapter, StructuredSessionOpts } from '../orchestrators/types';

// ── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test-app' },
}));

const mockWriteStream = {
  write: vi.fn(),
  end: vi.fn(),
};

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  createWriteStream: vi.fn(() => mockWriteStream),
}));

const mockBroadcastToAllWindows = vi.fn();
vi.mock('../util/ipc-broadcast', () => ({
  broadcastToAllWindows: (...args: unknown[]) => mockBroadcastToAllWindows(...args),
}));

const mockEmitHookEvent = vi.fn();
vi.mock('./annex-event-bus', () => ({
  emitHookEvent: (...args: unknown[]) => mockEmitHookEvent(...args),
}));

vi.mock('./log-service', () => ({
  appLog: vi.fn(),
}));

import {
  startStructuredSession,
  cancelSession,
  sendMessage,
  respondToPermission,
  isStructuredSession,
  activeSessionCount,
} from './structured-manager';

// ── Helpers ─────────────────────────────────────────────────────────────────

function createMockAdapter(events: StructuredEvent[]): StructuredAdapter {
  let cancelled = false;

  return {
    start: async function* (_opts: StructuredSessionOpts) {
      for (const event of events) {
        if (cancelled) return;
        yield event;
      }
    },
    sendMessage: vi.fn(async () => {}),
    respondToPermission: vi.fn(async () => {}),
    cancel: vi.fn(async () => { cancelled = true; }),
    dispose: vi.fn(),
  };
}

function makeEvent(type: StructuredEvent['type'], data: StructuredEvent['data']): StructuredEvent {
  return { type, timestamp: Date.now(), data };
}

const baseOpts: StructuredSessionOpts = {
  mission: 'Test mission',
  cwd: '/test/project',
};

// ── Tests ───────────────────────────────────────────────────────────────────

describe('structured-manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteStream.write.mockClear();
    mockWriteStream.end.mockClear();
  });

  afterEach(async () => {
    // Ensure sessions are cleaned up between tests
    // This is best-effort — some tests may have already cleaned up
  });

  describe('startStructuredSession', () => {
    it('creates a session and broadcasts events', async () => {
      const events: StructuredEvent[] = [
        makeEvent('text_delta', { text: 'hello' }),
        makeEvent('end', { reason: 'complete', summary: 'Done' }),
      ];

      const adapter = createMockAdapter(events);
      await startStructuredSession('agent-1', adapter, baseOpts);

      // Wait for async iteration to complete
      await vi.waitFor(() => {
        expect(mockBroadcastToAllWindows).toHaveBeenCalledWith(
          'agent:structured-event',
          'agent-1',
          expect.objectContaining({ type: 'text_delta' }),
        );
      });

      await vi.waitFor(() => {
        expect(mockBroadcastToAllWindows).toHaveBeenCalledWith(
          'agent:structured-event',
          'agent-1',
          expect.objectContaining({ type: 'end' }),
        );
      });
    });

    it('persists events to disk via log stream', async () => {
      const events: StructuredEvent[] = [
        makeEvent('tool_start', { id: 't1', name: 'Read', displayVerb: 'Reading', input: {} }),
      ];

      const adapter = createMockAdapter(events);
      await startStructuredSession('agent-2', adapter, baseOpts);

      await vi.waitFor(() => {
        expect(mockWriteStream.write).toHaveBeenCalled();
      });

      const firstWrite = mockWriteStream.write.mock.calls[0][0] as string;
      expect(firstWrite).toContain('"tool_start"');
      expect(firstWrite.endsWith('\n')).toBe(true);
    });

    it('forwards tool_start events to annex as pre_tool hook events', async () => {
      const events: StructuredEvent[] = [
        makeEvent('tool_start', { id: 't1', name: 'Edit', displayVerb: 'Editing', input: { file_path: '/a.ts' } }),
      ];

      const adapter = createMockAdapter(events);
      await startStructuredSession('agent-3', adapter, baseOpts);

      await vi.waitFor(() => {
        expect(mockEmitHookEvent).toHaveBeenCalledWith(
          'agent-3',
          expect.objectContaining({ kind: 'pre_tool', toolName: 'Edit' }),
        );
      });
    });

    it('forwards tool_end events to annex as post_tool hook events', async () => {
      const events: StructuredEvent[] = [
        makeEvent('tool_end', { id: 't1', name: 'Edit', result: 'ok', durationMs: 50, status: 'success' }),
      ];

      const adapter = createMockAdapter(events);
      await startStructuredSession('agent-4', adapter, baseOpts);

      await vi.waitFor(() => {
        expect(mockEmitHookEvent).toHaveBeenCalledWith(
          'agent-4',
          expect.objectContaining({ kind: 'post_tool', toolName: 'Edit' }),
        );
      });
    });

    it('forwards end events to annex as stop hook events', async () => {
      const events: StructuredEvent[] = [
        makeEvent('end', { reason: 'complete', summary: 'All done' }),
      ];

      const adapter = createMockAdapter(events);
      await startStructuredSession('agent-5', adapter, baseOpts);

      await vi.waitFor(() => {
        expect(mockEmitHookEvent).toHaveBeenCalledWith(
          'agent-5',
          expect.objectContaining({ kind: 'stop', message: 'All done' }),
        );
      });
    });

    it('does not forward text_delta to annex (no hook equivalent)', async () => {
      const events: StructuredEvent[] = [
        makeEvent('text_delta', { text: 'hi' }),
        makeEvent('end', { reason: 'complete' }),
      ];

      const adapter = createMockAdapter(events);
      await startStructuredSession('agent-6', adapter, baseOpts);

      await vi.waitFor(() => {
        expect(mockBroadcastToAllWindows).toHaveBeenCalledTimes(2);
      });

      // text_delta should not trigger an annex event
      const hookCalls = mockEmitHookEvent.mock.calls;
      const textDeltaHook = hookCalls.find(
        (call: unknown[]) => (call[1] as { kind: string })?.kind === 'pre_tool' || (call[1] as { kind: string })?.kind === 'text_delta',
      );
      // Only the 'stop' event should have triggered an annex emit
      expect(hookCalls.length).toBe(1);
      expect(textDeltaHook).toBeUndefined();
    });
  });

  describe('isStructuredSession', () => {
    it('returns true for active sessions', async () => {
      // Create a never-ending adapter
      const adapter: StructuredAdapter = {
        start: async function* () {
          // Yield one event then hang (simulating long-running session)
          yield makeEvent('text_delta', { text: 'working...' });
          await new Promise(() => {}); // hang forever
        },
        sendMessage: vi.fn(async () => {}),
        respondToPermission: vi.fn(async () => {}),
        cancel: vi.fn(async () => {}),
        dispose: vi.fn(),
      };

      await startStructuredSession('agent-7', adapter, baseOpts);

      // Session should be active immediately after start
      expect(isStructuredSession('agent-7')).toBe(true);
      expect(isStructuredSession('nonexistent')).toBe(false);

      // Cleanup
      await cancelSession('agent-7');
    });
  });

  describe('activeSessionCount', () => {
    it('tracks active session count', async () => {
      const initialCount = activeSessionCount();

      const adapter: StructuredAdapter = {
        start: async function* () {
          yield makeEvent('text_delta', { text: 'hi' });
          await new Promise(() => {});
        },
        sendMessage: vi.fn(async () => {}),
        respondToPermission: vi.fn(async () => {}),
        cancel: vi.fn(async () => {}),
        dispose: vi.fn(),
      };

      await startStructuredSession('count-agent', adapter, baseOpts);
      expect(activeSessionCount()).toBe(initialCount + 1);

      await cancelSession('count-agent');
      expect(activeSessionCount()).toBe(initialCount);
    });
  });

  describe('sendMessage', () => {
    it('delegates to adapter sendMessage', async () => {
      const adapter: StructuredAdapter = {
        start: async function* () {
          yield makeEvent('text_delta', { text: 'hi' });
          await new Promise(() => {});
        },
        sendMessage: vi.fn(async () => {}),
        respondToPermission: vi.fn(async () => {}),
        cancel: vi.fn(async () => {}),
        dispose: vi.fn(),
      };

      await startStructuredSession('msg-agent', adapter, baseOpts);
      await sendMessage('msg-agent', 'follow up message');

      expect(adapter.sendMessage).toHaveBeenCalledWith('follow up message');

      await cancelSession('msg-agent');
    });

    it('throws when session does not exist', async () => {
      await expect(sendMessage('nonexistent', 'hello')).rejects.toThrow(
        'No structured session found for agent nonexistent',
      );
    });
  });

  describe('respondToPermission', () => {
    it('delegates to adapter respondToPermission', async () => {
      const adapter: StructuredAdapter = {
        start: async function* () {
          yield makeEvent('permission_request', {
            id: 'perm-1',
            toolName: 'Bash',
            toolInput: { command: 'ls' },
            description: 'Run ls',
          });
          await new Promise(() => {});
        },
        sendMessage: vi.fn(async () => {}),
        respondToPermission: vi.fn(async () => {}),
        cancel: vi.fn(async () => {}),
        dispose: vi.fn(),
      };

      await startStructuredSession('perm-agent', adapter, baseOpts);

      await vi.waitFor(() => {
        expect(mockBroadcastToAllWindows).toHaveBeenCalled();
      });

      await respondToPermission('perm-agent', 'perm-1', true, 'user approved');
      expect(adapter.respondToPermission).toHaveBeenCalledWith('perm-1', true, 'user approved');

      await cancelSession('perm-agent');
    });

    it('throws when session does not exist', async () => {
      await expect(respondToPermission('nonexistent', 'p1', true)).rejects.toThrow(
        'No structured session found for agent nonexistent',
      );
    });
  });

  describe('cancelSession', () => {
    it('aborts adapter and cleans up session', async () => {
      const adapter: StructuredAdapter = {
        start: async function* () {
          yield makeEvent('text_delta', { text: 'working' });
          await new Promise(() => {});
        },
        sendMessage: vi.fn(async () => {}),
        respondToPermission: vi.fn(async () => {}),
        cancel: vi.fn(async () => {}),
        dispose: vi.fn(),
      };

      await startStructuredSession('cancel-agent', adapter, baseOpts);
      expect(isStructuredSession('cancel-agent')).toBe(true);

      await cancelSession('cancel-agent');
      expect(isStructuredSession('cancel-agent')).toBe(false);
      expect(adapter.cancel).toHaveBeenCalled();
      expect(adapter.dispose).toHaveBeenCalled();
    });

    it('is idempotent for non-existent sessions', async () => {
      // Should not throw
      await cancelSession('nonexistent');
    });
  });

  describe('error handling in event stream', () => {
    it('forwards permission_request to annex as permission_request hook', async () => {
      const events: StructuredEvent[] = [
        makeEvent('permission_request', {
          id: 'p1',
          toolName: 'Bash',
          toolInput: { command: 'rm -rf /' },
          description: 'Dangerous command',
        }),
      ];

      const adapter = createMockAdapter(events);
      await startStructuredSession('hook-perm-agent', adapter, baseOpts);

      await vi.waitFor(() => {
        expect(mockEmitHookEvent).toHaveBeenCalledWith(
          'hook-perm-agent',
          expect.objectContaining({
            kind: 'permission_request',
            toolName: 'Bash',
            message: 'Dangerous command',
          }),
        );
      });
    });

    it('forwards error events to annex as tool_error hooks', async () => {
      const events: StructuredEvent[] = [
        makeEvent('error', { code: 'CRASH', message: 'Something broke', toolId: 't1' }),
      ];

      const adapter = createMockAdapter(events);
      await startStructuredSession('error-agent', adapter, baseOpts);

      await vi.waitFor(() => {
        expect(mockEmitHookEvent).toHaveBeenCalledWith(
          'error-agent',
          expect.objectContaining({ kind: 'tool_error', message: 'Something broke' }),
        );
      });
    });
  });
});
