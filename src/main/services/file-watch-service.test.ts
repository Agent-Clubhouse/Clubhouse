import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Mocks ----------------------------------------------------------------

const mockWatcherClose = vi.fn();
let watchCallback: ((eventType: string, filename: string | null) => void) | null =
  null;

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  watch: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
}));

vi.mock('../../shared/ipc-channels', () => ({
  IPC: {
    FILE: {
      WATCH_EVENT: 'file:watch-event',
    },
  },
}));

import * as fs from 'fs';
import type { BrowserWindow } from 'electron';
import {
  startWatch,
  stopWatch,
  stopAllWatches,
  cleanupWatchesForWindow,
  extractBaseDir,
  _activeWatches,
} from './file-watch-service';

// --- Helpers ---------------------------------------------------------------

function makeSender(id = 1) {
  return {
    id,
    send: vi.fn(),
    isDestroyed: vi.fn().mockReturnValue(false),
  } as unknown as Electron.WebContents;
}

function makeWindow(webContentsId = 1) {
  return {
    webContents: { id: webContentsId },
  } as unknown as BrowserWindow;
}

// --- Tests -----------------------------------------------------------------

describe('file-watch-service', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.watch).mockImplementation((_path, _opts, cb) => {
      watchCallback = cb as (eventType: string, filename: string | null) => void;
      return { close: mockWatcherClose } as unknown as fs.FSWatcher;
    });
  });

  afterEach(() => {
    stopAllWatches();
    vi.useRealTimers();
    vi.clearAllMocks();
    watchCallback = null;
  });

  // ─── extractBaseDir ────────────────────────────────────────────────────────

  describe('extractBaseDir', () => {
    it('extracts directory before ** wildcard', () => {
      expect(extractBaseDir('/home/user/project/src/**/*.ts')).toBe(
        '/home/user/project/src',
      );
    });

    it('extracts directory before * wildcard', () => {
      expect(extractBaseDir('/tmp/logs/*.log')).toBe('/tmp/logs');
    });

    it('extracts directory before ? wildcard', () => {
      expect(extractBaseDir('/data/file?.txt')).toBe('/data');
    });

    it('extracts directory before brace expansion', () => {
      expect(extractBaseDir('/src/{a,b}/*.ts')).toBe('/src');
    });

    it('extracts directory before bracket expression', () => {
      expect(extractBaseDir('/src/[abc]/file.ts')).toBe('/src');
    });

    it('returns entire path when no glob characters', () => {
      expect(extractBaseDir('/home/user/project/src')).toBe(
        '/home/user/project/src',
      );
    });

    it('returns "." for glob-only pattern', () => {
      expect(extractBaseDir('**/*.ts')).toBe('.');
    });

    it('returns "." for wildcard-only pattern', () => {
      expect(extractBaseDir('*.ts')).toBe('.');
    });

    it('handles relative paths', () => {
      expect(extractBaseDir('src/components/**/*.tsx')).toBe('src/components');
    });

    it('normalizes Windows backslashes', () => {
      expect(extractBaseDir('C:\\Users\\project\\src\\**\\*.ts')).toBe(
        'C:/Users/project/src',
      );
    });

    it('handles mixed separators', () => {
      expect(extractBaseDir('C:\\Users/project\\src/**/*.ts')).toBe(
        'C:/Users/project/src',
      );
    });

    it('handles trailing slash before glob', () => {
      expect(extractBaseDir('/project/src/**')).toBe('/project/src');
    });
  });

  // ─── startWatch ────────────────────────────────────────────────────────────

  describe('startWatch', () => {
    it('creates a watcher and registers it', () => {
      const sender = makeSender();
      startWatch('w1', '/tmp/**/*.ts', sender);

      expect(fs.watch).toHaveBeenCalledWith(
        '/tmp',
        { recursive: true },
        expect.any(Function),
      );
      expect(_activeWatches.has('w1')).toBe(true);
    });

    it('throws when base directory does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const sender = makeSender();

      expect(() => startWatch('w1', '/nonexistent/**', sender)).toThrow(
        'Watch directory does not exist: /nonexistent',
      );
      expect(_activeWatches.has('w1')).toBe(false);
    });

    it('cleans up existing watch with same ID before creating new one', () => {
      const sender = makeSender();
      startWatch('w1', '/tmp/**/*.ts', sender);
      startWatch('w1', '/tmp/**/*.js', sender);

      expect(mockWatcherClose).toHaveBeenCalledTimes(1);
      expect(_activeWatches.size).toBe(1);
    });

    it('wraps fs.watch errors in descriptive message', () => {
      vi.mocked(fs.watch).mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });
      const sender = makeSender();

      expect(() => startWatch('w1', '/tmp/**', sender)).toThrow(
        'Failed to start file watcher: EACCES: permission denied',
      );
    });

    it('stores webContentsId from sender', () => {
      const sender = makeSender(42);
      startWatch('w1', '/tmp/**', sender);

      const entry = _activeWatches.get('w1');
      expect(entry!.webContentsId).toBe(42);
    });
  });

  // ─── event type mapping ────────────────────────────────────────────────────

  describe('event type mapping', () => {
    it('ignores events with null filename', () => {
      const sender = makeSender();
      startWatch('w1', '/tmp/**', sender);

      watchCallback!('change', null);
      vi.advanceTimersByTime(300);

      expect(sender.send).not.toHaveBeenCalled();
    });

    it('maps "change" event to "modified"', () => {
      const sender = makeSender();
      startWatch('w1', '/tmp/**', sender);

      watchCallback!('change', 'file.txt');
      vi.advanceTimersByTime(300);

      expect(sender.send).toHaveBeenCalledWith('file:watch-event', {
        watchId: 'w1',
        events: [{ type: 'modified', path: '/tmp/file.txt' }],
      });
    });

    it('maps "rename" to "created" when file exists', () => {
      const sender = makeSender();
      startWatch('w1', '/tmp/**', sender);

      // existsSync already returns true from beforeEach
      watchCallback!('rename', 'new.txt');
      vi.advanceTimersByTime(300);

      const payload = (sender.send as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(payload.events[0].type).toBe('created');
    });

    it('maps "rename" to "deleted" when file does not exist', () => {
      const sender = makeSender();
      startWatch('w1', '/tmp/**', sender);

      // For the rename check, file should not exist
      vi.mocked(fs.existsSync).mockReturnValue(false);
      watchCallback!('rename', 'gone.txt');
      vi.advanceTimersByTime(300);

      const payload = (sender.send as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(payload.events[0].type).toBe('deleted');
    });

    it('constructs full path by joining base dir and filename', () => {
      const sender = makeSender();
      startWatch('w1', '/project/src/**/*.ts', sender);

      watchCallback!('change', 'utils/helper.ts');
      vi.advanceTimersByTime(300);

      const payload = (sender.send as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(payload.events[0].path).toBe('/project/src/utils/helper.ts');
    });
  });

  // ─── debounce & batching ───────────────────────────────────────────────────

  describe('debounce and event batching', () => {
    it('batches multiple events within debounce window', () => {
      const sender = makeSender();
      startWatch('w1', '/tmp/**', sender);

      watchCallback!('change', 'a.txt');
      watchCallback!('change', 'b.txt');
      watchCallback!('change', 'c.txt');
      vi.advanceTimersByTime(300);

      expect(sender.send).toHaveBeenCalledTimes(1);
      const payload = (sender.send as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(payload.events).toHaveLength(3);
    });

    it('resets debounce timer on each new event', () => {
      const sender = makeSender();
      startWatch('w1', '/tmp/**', sender);

      watchCallback!('change', 'a.txt');
      vi.advanceTimersByTime(150);
      watchCallback!('change', 'b.txt'); // resets the 200ms timer
      vi.advanceTimersByTime(150); // 150ms since reset — not yet
      expect(sender.send).not.toHaveBeenCalled();

      vi.advanceTimersByTime(100); // 250ms since reset — fires
      expect(sender.send).toHaveBeenCalledTimes(1);
      const payload = (sender.send as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(payload.events).toHaveLength(2);
    });

    it('sends separate batches for events after debounce fires', () => {
      const sender = makeSender();
      startWatch('w1', '/tmp/**', sender);

      watchCallback!('change', 'a.txt');
      vi.advanceTimersByTime(300);
      expect(sender.send).toHaveBeenCalledTimes(1);

      watchCallback!('change', 'b.txt');
      vi.advanceTimersByTime(300);
      expect(sender.send).toHaveBeenCalledTimes(2);

      // Each batch should have exactly one event
      const batch1 = (sender.send as ReturnType<typeof vi.fn>).mock.calls[0][1];
      const batch2 = (sender.send as ReturnType<typeof vi.fn>).mock.calls[1][1];
      expect(batch1.events).toHaveLength(1);
      expect(batch2.events).toHaveLength(1);
    });

    it('does not send when no events are pending', () => {
      const sender = makeSender();
      startWatch('w1', '/tmp/**', sender);

      // Only null-filename events (ignored), no pending events
      watchCallback!('change', null);
      vi.advanceTimersByTime(300);

      expect(sender.send).not.toHaveBeenCalled();
    });
  });

  // ─── sender lifecycle ──────────────────────────────────────────────────────

  describe('sender lifecycle', () => {
    it('stops watch when sender is destroyed', () => {
      const sender = makeSender();
      startWatch('w1', '/tmp/**', sender);

      watchCallback!('change', 'a.txt');
      (sender.isDestroyed as ReturnType<typeof vi.fn>).mockReturnValue(true);
      vi.advanceTimersByTime(300);

      expect(sender.send).not.toHaveBeenCalled();
      expect(_activeWatches.has('w1')).toBe(false);
    });

    it('stops watch when sender.send throws', () => {
      const sender = makeSender();
      (sender.send as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('Object has been destroyed');
      });
      startWatch('w1', '/tmp/**', sender);

      watchCallback!('change', 'a.txt');
      vi.advanceTimersByTime(300);

      expect(_activeWatches.has('w1')).toBe(false);
    });
  });

  // ─── stopWatch ─────────────────────────────────────────────────────────────

  describe('stopWatch', () => {
    it('closes watcher and removes from active watches', () => {
      const sender = makeSender();
      startWatch('w1', '/tmp/**', sender);
      stopWatch('w1');

      expect(mockWatcherClose).toHaveBeenCalledTimes(1);
      expect(_activeWatches.has('w1')).toBe(false);
    });

    it('clears pending debounce timer so events are not sent', () => {
      const sender = makeSender();
      startWatch('w1', '/tmp/**', sender);

      watchCallback!('change', 'a.txt'); // starts debounce timer
      stopWatch('w1');
      vi.advanceTimersByTime(300);

      expect(sender.send).not.toHaveBeenCalled();
    });

    it('is a no-op for unknown watch ID', () => {
      expect(() => stopWatch('nonexistent')).not.toThrow();
    });

    it('handles watcher.close() throwing gracefully', () => {
      mockWatcherClose.mockImplementation(() => {
        throw new Error('Already closed');
      });
      const sender = makeSender();
      startWatch('w1', '/tmp/**', sender);

      expect(() => stopWatch('w1')).not.toThrow();
      expect(_activeWatches.has('w1')).toBe(false);
    });

    it('second stop on same ID is a no-op', () => {
      const sender = makeSender();
      startWatch('w1', '/tmp/**', sender);
      stopWatch('w1');
      expect(() => stopWatch('w1')).not.toThrow();
    });
  });

  // ─── stopAllWatches ────────────────────────────────────────────────────────

  describe('stopAllWatches', () => {
    it('stops all active watches', () => {
      const sender = makeSender();
      startWatch('w1', '/tmp/**', sender);
      startWatch('w2', '/tmp/**', sender);
      startWatch('w3', '/tmp/**', sender);

      stopAllWatches();

      expect(_activeWatches.size).toBe(0);
      expect(mockWatcherClose).toHaveBeenCalledTimes(3);
    });

    it('is safe to call when no watches exist', () => {
      expect(() => stopAllWatches()).not.toThrow();
    });
  });

  // ─── cleanupWatchesForWindow ───────────────────────────────────────────────

  describe('cleanupWatchesForWindow', () => {
    it('stops only watches belonging to the given window', () => {
      const sender1 = makeSender(10);
      const sender2 = makeSender(20);
      startWatch('w1', '/tmp/**', sender1);
      startWatch('w2', '/tmp/**', sender2);

      cleanupWatchesForWindow(makeWindow(10));

      expect(_activeWatches.has('w1')).toBe(false);
      expect(_activeWatches.has('w2')).toBe(true);
    });

    it('does not stop watches for other windows', () => {
      const sender = makeSender(10);
      startWatch('w1', '/tmp/**', sender);

      cleanupWatchesForWindow(makeWindow(99));

      expect(_activeWatches.has('w1')).toBe(true);
    });

    it('handles case with no active watches', () => {
      expect(() => cleanupWatchesForWindow(makeWindow(1))).not.toThrow();
    });

    it('handles multiple watches for the same window', () => {
      const sender = makeSender(10);
      startWatch('w1', '/tmp/**', sender);
      startWatch('w2', '/tmp/**', sender);
      startWatch('w3', '/tmp/**', makeSender(20));

      cleanupWatchesForWindow(makeWindow(10));

      expect(_activeWatches.has('w1')).toBe(false);
      expect(_activeWatches.has('w2')).toBe(false);
      expect(_activeWatches.has('w3')).toBe(true);
    });
  });
});
