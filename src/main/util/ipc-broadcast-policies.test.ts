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
  clearAllPolicies,
  flushAllPending,
} from './ipc-broadcast';
import { registerDefaultBroadcastPolicies } from './ipc-broadcast-policies';

function createMockWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: {
      send: vi.fn(),
    },
  };
}

describe('registerDefaultBroadcastPolicies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    clearAllPolicies();
    flushAllPending();
    registerDefaultBroadcastPolicies();
  });

  afterEach(() => {
    clearAllPolicies();
    flushAllPending();
    vi.useRealTimers();
  });

  it('throttles pty:data with merge (concatenates chunks)', () => {
    const win = createMockWindow();
    mockGetAllWindows.mockReturnValue([win]);

    broadcastToAllWindows('pty:data', 'agent-1', 'hello ');
    broadcastToAllWindows('pty:data', 'agent-1', 'world');

    // Not sent yet
    expect(win.webContents.send).not.toHaveBeenCalled();

    vi.advanceTimersByTime(16);

    expect(win.webContents.send).toHaveBeenCalledTimes(1);
    expect(win.webContents.send).toHaveBeenCalledWith('pty:data', 'agent-1', 'hello world');
  });

  it('throttles agent:hook-event with queue (preserves all events)', () => {
    const win = createMockWindow();
    mockGetAllWindows.mockReturnValue([win]);

    const ev1 = { kind: 'pre_tool', toolName: 'Read', timestamp: 1 };
    const ev2 = { kind: 'post_tool', toolName: 'Read', timestamp: 2 };

    broadcastToAllWindows('agent:hook-event', 'agent-1', ev1);
    broadcastToAllWindows('agent:hook-event', 'agent-1', ev2);

    expect(win.webContents.send).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);

    expect(win.webContents.send).toHaveBeenCalledTimes(2);
    expect(win.webContents.send).toHaveBeenNthCalledWith(1, 'agent:hook-event', 'agent-1', ev1);
    expect(win.webContents.send).toHaveBeenNthCalledWith(2, 'agent:hook-event', 'agent-1', ev2);
  });

  it('does not throttle unregistered channels', () => {
    const win = createMockWindow();
    mockGetAllWindows.mockReturnValue([win]);

    broadcastToAllWindows('annex:status-changed', { connected: true });

    expect(win.webContents.send).toHaveBeenCalledTimes(1);
    expect(win.webContents.send).toHaveBeenCalledWith('annex:status-changed', { connected: true });
  });
});
