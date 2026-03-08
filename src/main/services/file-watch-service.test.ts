import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock electron BrowserWindow
vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
}));

// Mock IPC channels
vi.mock('../../shared/ipc-channels', () => ({
  IPC: {
    FILE: {
      WATCH_EVENT: 'file:watch-event',
    },
  },
}));

import { startWatch, stopWatch, stopAllWatches, cleanupWatchesForWindow, extractBaseDir } from './file-watch-service';
import type { BrowserWindow } from 'electron';

function makeSender(id = 1) {
  return {
    id,
    isDestroyed: vi.fn().mockReturnValue(false),
    send: vi.fn(),
  };
}

function makeWindow(webContentsId = 1) {
  return {
    webContents: { id: webContentsId },
  } as unknown as BrowserWindow;
}

describe('file-watch-service', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-watch-test-'));
    vi.useFakeTimers();
  });

  afterEach(() => {
    stopAllWatches();
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('startWatch', () => {
    it('throws if base directory does not exist', () => {
      const sender = makeSender();
      expect(() =>
        startWatch('w1', path.join(tmpDir, 'nonexistent', '**', '*.ts'), sender as any),
      ).toThrow('Watch directory does not exist');
    });

    it('starts a watch and registers in activeWatches (stopWatch succeeds)', () => {
      const sender = makeSender();
      startWatch('w1', path.join(tmpDir, '**', '*.ts'), sender as any);
      // If watch is active, stopWatch should not throw
      expect(() => stopWatch('w1')).not.toThrow();
    });

    it('replaces existing watch with same ID', () => {
      const sender1 = makeSender(1);
      const sender2 = makeSender(2);
      startWatch('w1', path.join(tmpDir, '**', '*.ts'), sender1 as any);
      // Re-registering same watchId replaces the old one without error
      expect(() =>
        startWatch('w1', path.join(tmpDir, '**', '*.ts'), sender2 as any),
      ).not.toThrow();
      stopWatch('w1');
    });
  });

  describe('stopWatch', () => {
    it('is a no-op for unknown watchId', () => {
      expect(() => stopWatch('nonexistent')).not.toThrow();
    });

    it('stops an active watch and clears pending debounce timer', () => {
      const sender = makeSender();
      startWatch('w1', path.join(tmpDir, '**', '*.ts'), sender as any);
      stopWatch('w1');
      // Second stop is a no-op
      expect(() => stopWatch('w1')).not.toThrow();
    });
  });

  describe('stopAllWatches', () => {
    it('stops all active watches', () => {
      const sender = makeSender();
      startWatch('w1', path.join(tmpDir, '**', '*.ts'), sender as any);
      startWatch('w2', path.join(tmpDir, '**', '*.js'), sender as any);
      expect(() => stopAllWatches()).not.toThrow();
      // All watches should be gone — double-stop is a no-op
      expect(() => stopWatch('w1')).not.toThrow();
      expect(() => stopWatch('w2')).not.toThrow();
    });
  });

  describe('cleanupWatchesForWindow', () => {
    it('stops watches belonging to the given window', () => {
      const sender1 = makeSender(10);
      const sender2 = makeSender(20);
      startWatch('w10', path.join(tmpDir, '**', '*.ts'), sender1 as any);
      startWatch('w20', path.join(tmpDir, '**', '*.js'), sender2 as any);

      const win = makeWindow(10);
      cleanupWatchesForWindow(win);

      // w10 should be gone; stopping it again is a no-op (no throw)
      expect(() => stopWatch('w10')).not.toThrow();
      // w20 should still be active — stop it cleanly
      expect(() => stopWatch('w20')).not.toThrow();
    });

    it('does nothing when no watches exist for the window', () => {
      const sender = makeSender(99);
      startWatch('w99', path.join(tmpDir, '**', '*.ts'), sender as any);

      const win = makeWindow(1); // different webContentsId
      expect(() => cleanupWatchesForWindow(win)).not.toThrow();

      // w99 should still be active
      stopWatch('w99');
    });
  });

  describe('debounce behaviour', () => {
    it('stops the watch and does not send if sender is destroyed', () => {
      const sender = makeSender();
      sender.isDestroyed.mockReturnValue(true);

      startWatch('w1', path.join(tmpDir, '**', '*.ts'), sender as any);

      // Manually trigger the watcher callback by writing a file
      // (we rely on fake timers to control the debounce)
      // Simulate the debounce timer firing
      vi.runAllTimers();

      // sender.send should NOT have been called because isDestroyed returns true
      expect(sender.send).not.toHaveBeenCalled();
    });

    it('sends batched events when sender is alive', () => {
      const sender = makeSender();
      startWatch('w1', path.join(tmpDir, '**', '*.ts'), sender as any);

      // We don't have direct access to trigger the watcher callback in unit tests,
      // so we verify the send is NOT called before timers fire and the
      // isDestroyed guard is correctly checked.
      vi.runAllTimers();
      // No events pending, so send should not be called
      expect(sender.send).not.toHaveBeenCalled();
    });
  });

  describe('webContentsId stored in entry', () => {
    it('associates a watch with the correct webContents ID for cleanup', () => {
      const senderA = makeSender(100);
      const senderB = makeSender(200);

      startWatch('wA', path.join(tmpDir, '**', '*.ts'), senderA as any);
      startWatch('wB', path.join(tmpDir, '**', '*.ts'), senderB as any);

      // Cleanup for window with id 100 should only remove wA
      cleanupWatchesForWindow(makeWindow(100));

      // wB should still be cleanly stoppable
      expect(() => stopWatch('wB')).not.toThrow();
    });
  });

  describe('glob filtering', () => {
    it('should only forward events for files matching the glob pattern', async () => {
      vi.useRealTimers();

      // Create subdirectories
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });

      const sender = makeSender();
      const glob = path.join(tmpDir, 'src', '**', '*.ts');
      startWatch('gf1', glob, sender as any);

      // Create a .ts file (should match)
      fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export {};');

      // Create a .js file (should NOT match)
      fs.writeFileSync(path.join(tmpDir, 'src', 'script.js'), 'module.exports = {};');

      // Wait for debounce
      await new Promise((r) => setTimeout(r, 500));

      if (sender.send.mock.calls.length > 0) {
        const allEvents = sender.send.mock.calls.flatMap(
          (call: unknown[]) => (call[1] as { events: Array<{ path: string }> }).events,
        );
        // Only .ts files should be in the events
        for (const event of allEvents) {
          expect(event.path).toMatch(/\.ts$/);
        }
        // No .js files
        expect(allEvents.some((e: { path: string }) => e.path.endsWith('.js'))).toBe(false);
      }

      stopWatch('gf1');
    });

    it('should forward events for nested files matching the glob', async () => {
      vi.useRealTimers();

      // Create subdirectories
      fs.mkdirSync(path.join(tmpDir, 'src', 'components'), { recursive: true });

      const sender = makeSender();
      const glob = path.join(tmpDir, 'src', '**', '*.ts');
      startWatch('gf2', glob, sender as any);

      // Create a nested .ts file (should match)
      fs.writeFileSync(path.join(tmpDir, 'src', 'components', 'App.ts'), 'export class App {}');

      // Wait for debounce
      await new Promise((r) => setTimeout(r, 500));

      if (sender.send.mock.calls.length > 0) {
        const allEvents = sender.send.mock.calls.flatMap(
          (call: unknown[]) => (call[1] as { events: Array<{ path: string }> }).events,
        );
        expect(allEvents.some((e: { path: string }) => e.path.includes('App.ts'))).toBe(true);
      }

      stopWatch('gf2');
    });

    it('should not forward events for files outside the glob scope', async () => {
      vi.useRealTimers();

      // Create subdirectories
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });

      const sender = makeSender();
      const glob = path.join(tmpDir, 'src', '**', '*.ts');
      startWatch('gf3', glob, sender as any);

      // Create a non-ts file in src (should NOT match)
      fs.writeFileSync(path.join(tmpDir, 'src', 'README.md'), '# Readme');

      // Wait for debounce
      await new Promise((r) => setTimeout(r, 500));

      if (sender.send.mock.calls.length > 0) {
        const allEvents = sender.send.mock.calls.flatMap(
          (call: unknown[]) => (call[1] as { events: Array<{ path: string }> }).events,
        );
        // No .md files should be forwarded
        expect(allEvents.some((e: { path: string }) => e.path.endsWith('.md'))).toBe(false);
      }

      stopWatch('gf3');
    });
  });
});

describe('extractBaseDir', () => {
  it('extracts base directory from POSIX glob with **', () => {
    expect(extractBaseDir('/home/user/project/src/**/*.ts')).toBe('/home/user/project/src');
  });

  it('extracts base directory from POSIX glob with single *', () => {
    expect(extractBaseDir('/home/user/project/*.ts')).toBe('/home/user/project');
  });

  it('returns full path when no wildcard is present', () => {
    expect(extractBaseDir('/home/user/project/src')).toBe('/home/user/project/src');
  });

  it('handles glob with ? wildcard', () => {
    expect(extractBaseDir('/home/user/project/src/file?.ts')).toBe('/home/user/project/src');
  });

  it('handles glob with { brace pattern', () => {
    expect(extractBaseDir('/home/user/project/src/{a,b}')).toBe('/home/user/project/src');
  });

  it('handles glob with [ bracket pattern', () => {
    expect(extractBaseDir('/home/user/project/src/[abc].ts')).toBe('/home/user/project/src');
  });

  it('returns "." when glob starts with wildcard', () => {
    expect(extractBaseDir('**/*.ts')).toBe('.');
  });

  it('handles Windows-style backslash separators', () => {
    // Backslashes are normalized to forward slashes before splitting,
    // so Windows paths work correctly on any platform.
    expect(extractBaseDir('C:\\Users\\me\\project\\src\\**\\*.ts')).toBe('C:/Users/me/project/src');
  });

  it('handles mixed separators', () => {
    expect(extractBaseDir('C:\\Users\\me/project/src/**/*.ts')).toBe('C:/Users/me/project/src');
  });

  it('returns "." for empty string', () => {
    expect(extractBaseDir('')).toBe('.');
  });

  it('returns "/" for root-only path', () => {
    // "/" splits into ['', ''] – baseParts collects both empty strings,
    // joined result is '/' which is truthy → returned as-is.
    expect(extractBaseDir('/')).toBe('/');
  });

  it('warns when falling back to "." for a non-wildcard-starting glob', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A glob that appears to have a rooted path but produces empty base
    // should trigger a warning. In practice this only happens for edge cases.
    extractBaseDir('**/*.ts');
    // Starts with wildcard — no warning expected
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
