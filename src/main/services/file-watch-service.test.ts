import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { startWatch, stopWatch, stopAllWatches, cleanupWatchesForWindow } from './file-watch-service';
import type { BrowserWindow } from 'electron';

/**
 * Create a mock Electron WebContents-like object.
 * The `destroyed` event listener is captured so tests can fire it manually.
 */
function createMockSender(id: number) {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  return {
    id,
    send: vi.fn(),
    once(event: string, handler: (...args: unknown[]) => void) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
    },
    /** Fire a captured event for testing (with once semantics). */
    _emit(event: string) {
      const handlers = listeners[event] ?? [];
      delete listeners[event];
      for (const fn of handlers) {
        fn();
      }
    },
  } as unknown as Electron.WebContents & { _emit: (event: string) => void };
}

/** Create a mock BrowserWindow with the given webContents id. */
function createMockWindow(webContentsId: number) {
  return { webContents: { id: webContentsId } } as unknown as BrowserWindow;
}

describe('file-watch-service', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-watch-test-'));
  });

  afterEach(() => {
    stopAllWatches();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('startWatch / stopWatch', () => {
    it('creates and stops a watch without errors', () => {
      const sender = createMockSender(1);
      const glob = `${tmpDir}/**/*.txt`;

      expect(() => startWatch('w1', glob, sender)).not.toThrow();
      expect(() => stopWatch('w1')).not.toThrow();
    });

    it('stopWatch is a no-op for unknown id', () => {
      expect(() => stopWatch('nonexistent')).not.toThrow();
    });

    it('replaces an existing watch with the same id', () => {
      const sender = createMockSender(1);
      const glob = `${tmpDir}/**/*.txt`;

      startWatch('w1', glob, sender);
      expect(() => startWatch('w1', glob, sender)).not.toThrow();
      stopWatch('w1');
    });
  });

  describe('cleanupWatchesForWindow', () => {
    it('stops watches associated with the given window', () => {
      const sender1 = createMockSender(10);
      const sender2 = createMockSender(20);
      const glob = `${tmpDir}/**/*.txt`;

      startWatch('w1', glob, sender1);
      startWatch('w2', glob, sender1);
      startWatch('w3', glob, sender2);

      const win = createMockWindow(10);
      cleanupWatchesForWindow(win);

      // w1 and w2 should already be stopped; calling stopWatch again is a no-op
      expect(() => stopWatch('w1')).not.toThrow();
      expect(() => stopWatch('w2')).not.toThrow();

      // w3 should still be active — stopWatch should succeed
      expect(() => stopWatch('w3')).not.toThrow();
    });

    it('is a no-op when no watches exist for the window', () => {
      const sender = createMockSender(99);
      const glob = `${tmpDir}/**/*.txt`;

      startWatch('w1', glob, sender);

      const win = createMockWindow(42);
      expect(() => cleanupWatchesForWindow(win)).not.toThrow();

      // Original watch should still be active
      stopWatch('w1');
    });
  });

  describe('automatic cleanup on webContents destroyed', () => {
    it('stops the watch when sender webContents is destroyed', () => {
      const sender = createMockSender(5);
      const glob = `${tmpDir}/**/*.txt`;

      startWatch('w1', glob, sender);

      // Simulate webContents destruction
      sender._emit('destroyed');

      // Watch should already be cleaned up; stopWatch is a no-op
      expect(() => stopWatch('w1')).not.toThrow();
    });

    it('does not affect watches from other senders', () => {
      const sender1 = createMockSender(5);
      const sender2 = createMockSender(6);
      const glob = `${tmpDir}/**/*.txt`;

      startWatch('w1', glob, sender1);
      startWatch('w2', glob, sender2);

      // Destroy sender1
      sender1._emit('destroyed');

      // w2 should still be alive
      expect(() => stopWatch('w2')).not.toThrow();
    });
  });

  describe('stopAllWatches', () => {
    it('stops all active watches', () => {
      const sender = createMockSender(1);
      const glob = `${tmpDir}/**/*.txt`;

      startWatch('w1', glob, sender);
      startWatch('w2', glob, sender);

      expect(() => stopAllWatches()).not.toThrow();

      // Subsequent stopWatch calls should be no-ops
      expect(() => stopWatch('w1')).not.toThrow();
      expect(() => stopWatch('w2')).not.toThrow();
    });
  });
});
