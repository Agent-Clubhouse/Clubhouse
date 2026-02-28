import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockGetAllWindows } = vi.hoisted(() => ({
  mockGetAllWindows: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: mockGetAllWindows,
  },
}));

import {
  broadcastToAllWindows,
  setChannelPolicy,
  clearChannelPolicy,
  clearAllPolicies,
  flushAllPending,
  pendingCount,
} from './ipc-broadcast';

function createMockWindow(destroyed = false) {
  return {
    isDestroyed: vi.fn(() => destroyed),
    webContents: {
      send: vi.fn(),
    },
  };
}

describe('broadcastToAllWindows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Provide a safe default so flushAllPending can iterate windows
    mockGetAllWindows.mockReturnValue([]);
    clearAllPolicies();
    flushAllPending();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // Immediate passthrough (no policy)
  // -----------------------------------------------------------------------

  it('sends to all open windows immediately when no policy is set', () => {
    const win1 = createMockWindow();
    const win2 = createMockWindow();
    mockGetAllWindows.mockReturnValue([win1, win2]);

    broadcastToAllWindows('test-channel', 'arg1', 'arg2');

    expect(win1.webContents.send).toHaveBeenCalledWith('test-channel', 'arg1', 'arg2');
    expect(win2.webContents.send).toHaveBeenCalledWith('test-channel', 'arg1', 'arg2');
  });

  it('skips destroyed windows', () => {
    const active = createMockWindow(false);
    const destroyed = createMockWindow(true);
    mockGetAllWindows.mockReturnValue([active, destroyed]);

    broadcastToAllWindows('test-channel', 'data');

    expect(active.webContents.send).toHaveBeenCalledWith('test-channel', 'data');
    expect(destroyed.webContents.send).not.toHaveBeenCalled();
  });

  it('handles empty window list', () => {
    mockGetAllWindows.mockReturnValue([]);

    expect(() => broadcastToAllWindows('test-channel')).not.toThrow();
  });

  it('passes no extra args when called with channel only', () => {
    const win = createMockWindow();
    mockGetAllWindows.mockReturnValue([win]);

    broadcastToAllWindows('test-channel');

    expect(win.webContents.send).toHaveBeenCalledWith('test-channel');
  });

  // -----------------------------------------------------------------------
  // Merge-mode throttling (PTY data pattern)
  // -----------------------------------------------------------------------

  describe('merge-mode throttling', () => {
    const CHANNEL = 'pty:data';

    beforeEach(() => {
      setChannelPolicy(CHANNEL, {
        intervalMs: 16,
        merge: true,
        keyFn: (agentId) => String(agentId),
        mergeFn: (existing, incoming) => [
          existing[0],
          (existing[1] as string) + (incoming[1] as string),
        ],
      });
    });

    it('does not send immediately — buffers until interval', () => {
      const win = createMockWindow();
      mockGetAllWindows.mockReturnValue([win]);

      broadcastToAllWindows(CHANNEL, 'agent-1', 'chunk1');

      expect(win.webContents.send).not.toHaveBeenCalled();
      expect(pendingCount()).toBe(1);
    });

    it('flushes merged data after interval', () => {
      const win = createMockWindow();
      mockGetAllWindows.mockReturnValue([win]);

      broadcastToAllWindows(CHANNEL, 'agent-1', 'aaa');
      broadcastToAllWindows(CHANNEL, 'agent-1', 'bbb');
      broadcastToAllWindows(CHANNEL, 'agent-1', 'ccc');

      expect(win.webContents.send).not.toHaveBeenCalled();

      vi.advanceTimersByTime(16);

      expect(win.webContents.send).toHaveBeenCalledTimes(1);
      expect(win.webContents.send).toHaveBeenCalledWith(CHANNEL, 'agent-1', 'aaabbbccc');
      expect(pendingCount()).toBe(0);
    });

    it('batches per agent independently', () => {
      const win = createMockWindow();
      mockGetAllWindows.mockReturnValue([win]);

      broadcastToAllWindows(CHANNEL, 'agent-1', 'A');
      broadcastToAllWindows(CHANNEL, 'agent-2', 'X');
      broadcastToAllWindows(CHANNEL, 'agent-1', 'B');
      broadcastToAllWindows(CHANNEL, 'agent-2', 'Y');

      vi.advanceTimersByTime(16);

      expect(win.webContents.send).toHaveBeenCalledTimes(2);
      expect(win.webContents.send).toHaveBeenCalledWith(CHANNEL, 'agent-1', 'AB');
      expect(win.webContents.send).toHaveBeenCalledWith(CHANNEL, 'agent-2', 'XY');
    });

    it('starts a new batch after flushing', () => {
      const win = createMockWindow();
      mockGetAllWindows.mockReturnValue([win]);

      broadcastToAllWindows(CHANNEL, 'agent-1', 'first');
      vi.advanceTimersByTime(16);
      expect(win.webContents.send).toHaveBeenCalledTimes(1);

      broadcastToAllWindows(CHANNEL, 'agent-1', 'second');
      vi.advanceTimersByTime(16);
      expect(win.webContents.send).toHaveBeenCalledTimes(2);
      expect(win.webContents.send).toHaveBeenLastCalledWith(CHANNEL, 'agent-1', 'second');
    });
  });

  // -----------------------------------------------------------------------
  // Queue-mode throttling (hook event pattern)
  // -----------------------------------------------------------------------

  describe('queue-mode throttling', () => {
    const CHANNEL = 'agent:hook-event';

    beforeEach(() => {
      setChannelPolicy(CHANNEL, {
        intervalMs: 50,
        merge: false,
        keyFn: (agentId) => String(agentId),
      });
    });

    it('does not send immediately — queues until interval', () => {
      const win = createMockWindow();
      mockGetAllWindows.mockReturnValue([win]);

      broadcastToAllWindows(CHANNEL, 'agent-1', { kind: 'pre_tool' });

      expect(win.webContents.send).not.toHaveBeenCalled();
      expect(pendingCount()).toBe(1);
    });

    it('flushes all queued events individually on interval', () => {
      const win = createMockWindow();
      mockGetAllWindows.mockReturnValue([win]);

      const event1 = { kind: 'pre_tool', toolName: 'Read' };
      const event2 = { kind: 'post_tool', toolName: 'Read' };
      const event3 = { kind: 'pre_tool', toolName: 'Write' };

      broadcastToAllWindows(CHANNEL, 'agent-1', event1);
      broadcastToAllWindows(CHANNEL, 'agent-1', event2);
      broadcastToAllWindows(CHANNEL, 'agent-1', event3);

      vi.advanceTimersByTime(50);

      expect(win.webContents.send).toHaveBeenCalledTimes(3);
      expect(win.webContents.send).toHaveBeenNthCalledWith(1, CHANNEL, 'agent-1', event1);
      expect(win.webContents.send).toHaveBeenNthCalledWith(2, CHANNEL, 'agent-1', event2);
      expect(win.webContents.send).toHaveBeenNthCalledWith(3, CHANNEL, 'agent-1', event3);
    });

    it('queues per agent independently', () => {
      const win = createMockWindow();
      mockGetAllWindows.mockReturnValue([win]);

      broadcastToAllWindows(CHANNEL, 'agent-1', { kind: 'pre_tool' });
      broadcastToAllWindows(CHANNEL, 'agent-2', { kind: 'stop' });

      vi.advanceTimersByTime(50);

      expect(win.webContents.send).toHaveBeenCalledTimes(2);
      expect(win.webContents.send).toHaveBeenCalledWith(CHANNEL, 'agent-1', { kind: 'pre_tool' });
      expect(win.webContents.send).toHaveBeenCalledWith(CHANNEL, 'agent-2', { kind: 'stop' });
    });
  });

  // -----------------------------------------------------------------------
  // flushAllPending
  // -----------------------------------------------------------------------

  describe('flushAllPending', () => {
    it('immediately flushes all pending merged batches', () => {
      const win = createMockWindow();
      mockGetAllWindows.mockReturnValue([win]);

      setChannelPolicy('ch-a', { intervalMs: 100, merge: true });
      broadcastToAllWindows('ch-a', 'data');

      expect(win.webContents.send).not.toHaveBeenCalled();

      flushAllPending();

      expect(win.webContents.send).toHaveBeenCalledWith('ch-a', 'data');
      expect(pendingCount()).toBe(0);
    });

    it('immediately flushes all pending queued events', () => {
      const win = createMockWindow();
      mockGetAllWindows.mockReturnValue([win]);

      setChannelPolicy('ch-b', { intervalMs: 100, merge: false });
      broadcastToAllWindows('ch-b', 'e1');
      broadcastToAllWindows('ch-b', 'e2');

      flushAllPending();

      expect(win.webContents.send).toHaveBeenCalledTimes(2);
      expect(pendingCount()).toBe(0);
    });

    it('does nothing when no pending events exist', () => {
      const win = createMockWindow();
      mockGetAllWindows.mockReturnValue([win]);

      expect(() => flushAllPending()).not.toThrow();
      expect(win.webContents.send).not.toHaveBeenCalled();
    });

    it('cancels pending timers so they do not fire again', () => {
      const win = createMockWindow();
      mockGetAllWindows.mockReturnValue([win]);

      setChannelPolicy('ch-c', { intervalMs: 50, merge: true });
      broadcastToAllWindows('ch-c', 'x');

      flushAllPending();
      expect(win.webContents.send).toHaveBeenCalledTimes(1);

      // Timer should not fire again
      vi.advanceTimersByTime(100);
      expect(win.webContents.send).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // Policy management
  // -----------------------------------------------------------------------

  describe('policy management', () => {
    it('clearChannelPolicy removes throttling for a channel', () => {
      const win = createMockWindow();
      mockGetAllWindows.mockReturnValue([win]);

      setChannelPolicy('ch', { intervalMs: 100, merge: true });
      clearChannelPolicy('ch');

      broadcastToAllWindows('ch', 'data');

      // Should send immediately since policy was cleared
      expect(win.webContents.send).toHaveBeenCalledWith('ch', 'data');
    });

    it('clearAllPolicies removes all policies', () => {
      const win = createMockWindow();
      mockGetAllWindows.mockReturnValue([win]);

      setChannelPolicy('ch-1', { intervalMs: 100, merge: true });
      setChannelPolicy('ch-2', { intervalMs: 100, merge: false });
      clearAllPolicies();

      broadcastToAllWindows('ch-1', 'a');
      broadcastToAllWindows('ch-2', 'b');

      expect(win.webContents.send).toHaveBeenCalledTimes(2);
    });

    it('policy with intervalMs=0 sends immediately', () => {
      const win = createMockWindow();
      mockGetAllWindows.mockReturnValue([win]);

      setChannelPolicy('ch', { intervalMs: 0, merge: true });
      broadcastToAllWindows('ch', 'data');

      expect(win.webContents.send).toHaveBeenCalledWith('ch', 'data');
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe('edge cases', () => {
    it('merge without mergeFn replaces with latest args', () => {
      const win = createMockWindow();
      mockGetAllWindows.mockReturnValue([win]);

      setChannelPolicy('ch', { intervalMs: 16, merge: true });

      broadcastToAllWindows('ch', 'first');
      broadcastToAllWindows('ch', 'second');

      vi.advanceTimersByTime(16);

      expect(win.webContents.send).toHaveBeenCalledTimes(1);
      expect(win.webContents.send).toHaveBeenCalledWith('ch', 'second');
    });

    it('broadcasts to multiple windows on flush', () => {
      const win1 = createMockWindow();
      const win2 = createMockWindow();
      mockGetAllWindows.mockReturnValue([win1, win2]);

      setChannelPolicy('ch', { intervalMs: 16, merge: true });

      broadcastToAllWindows('ch', 'data');
      vi.advanceTimersByTime(16);

      expect(win1.webContents.send).toHaveBeenCalledWith('ch', 'data');
      expect(win2.webContents.send).toHaveBeenCalledWith('ch', 'data');
    });

    it('skips destroyed windows during throttled flush', () => {
      const active = createMockWindow(false);
      const destroyed = createMockWindow(true);
      mockGetAllWindows.mockReturnValue([active, destroyed]);

      setChannelPolicy('ch', { intervalMs: 16, merge: true });

      broadcastToAllWindows('ch', 'data');
      vi.advanceTimersByTime(16);

      expect(active.webContents.send).toHaveBeenCalledWith('ch', 'data');
      expect(destroyed.webContents.send).not.toHaveBeenCalled();
    });
  });
});
