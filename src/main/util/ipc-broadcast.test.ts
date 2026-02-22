import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetAllWindows } = vi.hoisted(() => ({
  mockGetAllWindows: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: mockGetAllWindows,
  },
}));

import { broadcastToAllWindows } from './ipc-broadcast';

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
  });

  it('sends to all open windows', () => {
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
});
