import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockWatcherClose, mockExistsSync, mockWatch } = vi.hoisted(() => ({
  mockWatcherClose: vi.fn(),
  mockExistsSync: vi.fn().mockReturnValue(true),
  mockWatch: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...(actual as object),
    existsSync: mockExistsSync,
    watch: mockWatch,
  };
});

vi.mock('electron', () => ({
  BrowserWindow: class {},
}));

import { startWatch, stopWatch, stopAllWatches, cleanupWatchesForWindow } from './file-watch-service';

function createMockSender(id: number): Electron.WebContents {
  return { id, send: vi.fn() } as unknown as Electron.WebContents;
}

function createMockWindow(webContentsId: number) {
  return { webContents: { id: webContentsId } } as unknown as import('electron').BrowserWindow;
}

describe('file-watch-service', () => {
  beforeEach(() => {
    // Stop all watches to reset state between tests
    stopAllWatches();
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockWatch.mockReturnValue({ close: mockWatcherClose });
  });

  describe('cleanupWatchesForWindow', () => {
    it('stops watches belonging to the closed window', () => {
      const sender = createMockSender(1);
      startWatch('watch-1', '/tmp/dir/**', sender);
      startWatch('watch-2', '/tmp/dir/**', sender);

      const win = createMockWindow(1);
      cleanupWatchesForWindow(win);

      // Both watchers should have been closed
      expect(mockWatcherClose).toHaveBeenCalledTimes(2);
    });

    it('does not stop watches belonging to other windows', () => {
      const sender1 = createMockSender(1);
      const sender2 = createMockSender(2);
      startWatch('watch-1', '/tmp/dir/**', sender1);
      startWatch('watch-2', '/tmp/dir/**', sender2);

      const win = createMockWindow(1);
      cleanupWatchesForWindow(win);

      // Only the watcher for sender1 should have been closed
      expect(mockWatcherClose).toHaveBeenCalledTimes(1);
    });

    it('is a no-op when no watches exist for the window', () => {
      const sender = createMockSender(1);
      startWatch('watch-1', '/tmp/dir/**', sender);

      const win = createMockWindow(999);
      cleanupWatchesForWindow(win);

      // The existing watcher should not have been closed
      expect(mockWatcherClose).not.toHaveBeenCalled();
    });

    it('is a no-op when there are no active watches', () => {
      const win = createMockWindow(1);
      cleanupWatchesForWindow(win);

      expect(mockWatcherClose).not.toHaveBeenCalled();
    });
  });

  describe('stopWatch', () => {
    it('stops and removes a specific watch', () => {
      const sender = createMockSender(1);
      startWatch('watch-1', '/tmp/dir/**', sender);

      stopWatch('watch-1');

      expect(mockWatcherClose).toHaveBeenCalledTimes(1);
    });

    it('is a no-op for unknown watch IDs', () => {
      stopWatch('non-existent');

      expect(mockWatcherClose).not.toHaveBeenCalled();
    });
  });

  describe('stopAllWatches', () => {
    it('stops all active watches', () => {
      const sender1 = createMockSender(1);
      const sender2 = createMockSender(2);
      startWatch('watch-1', '/tmp/dir/**', sender1);
      startWatch('watch-2', '/tmp/dir/**', sender2);

      stopAllWatches();

      expect(mockWatcherClose).toHaveBeenCalledTimes(2);
    });
  });
});
