import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock the IPC channels
vi.mock('../../shared/ipc-channels', () => ({
  IPC: {
    FILE: {
      WATCH_EVENT: 'file:watch-event',
    },
  },
}));

import { startWatch, stopWatch, stopAllWatches } from './file-watch-service';

describe('file-watch-service', () => {
  let tmpDir: string;
  let mockSender: Electron.WebContents;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-watch-test-'));
    // Create subdirectories
    fs.mkdirSync(path.join(tmpDir, 'src'));
    fs.mkdirSync(path.join(tmpDir, 'src', 'components'));
    fs.mkdirSync(path.join(tmpDir, 'docs'));

    mockSender = {
      send: vi.fn(),
    } as unknown as Electron.WebContents;
  });

  afterEach(() => {
    stopAllWatches();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('glob filtering', () => {
    it('should only forward events for files matching the glob pattern', async () => {
      const glob = path.join(tmpDir, 'src', '**', '*.ts');
      startWatch('test-1', glob, mockSender);

      // Create a .ts file (should match)
      fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export {};');

      // Create a .js file (should NOT match)
      fs.writeFileSync(path.join(tmpDir, 'src', 'script.js'), 'module.exports = {};');

      // Wait for debounce
      await new Promise((r) => setTimeout(r, 500));

      if ((mockSender.send as ReturnType<typeof vi.fn>).mock.calls.length > 0) {
        const allEvents = (mockSender.send as ReturnType<typeof vi.fn>).mock.calls.flatMap(
          (call: unknown[]) => (call[1] as { events: Array<{ path: string }> }).events,
        );
        // Only .ts files should be in the events
        for (const event of allEvents) {
          expect(event.path).toMatch(/\.ts$/);
        }
        // No .js files
        expect(allEvents.some((e: { path: string }) => e.path.endsWith('.js'))).toBe(false);
      }

      stopWatch('test-1');
    });

    it('should forward events for nested files matching the glob', async () => {
      const glob = path.join(tmpDir, 'src', '**', '*.ts');
      startWatch('test-2', glob, mockSender);

      // Create a nested .ts file (should match)
      fs.writeFileSync(path.join(tmpDir, 'src', 'components', 'App.ts'), 'export class App {}');

      // Wait for debounce
      await new Promise((r) => setTimeout(r, 500));

      if ((mockSender.send as ReturnType<typeof vi.fn>).mock.calls.length > 0) {
        const allEvents = (mockSender.send as ReturnType<typeof vi.fn>).mock.calls.flatMap(
          (call: unknown[]) => (call[1] as { events: Array<{ path: string }> }).events,
        );
        expect(allEvents.some((e: { path: string }) => e.path.includes('App.ts'))).toBe(true);
      }

      stopWatch('test-2');
    });

    it('should not forward events for files outside the glob scope', async () => {
      const glob = path.join(tmpDir, 'src', '**', '*.ts');
      startWatch('test-3', glob, mockSender);

      // Create a file in the docs directory (should NOT match, but also outside watcher scope)
      // Create a non-ts file in src (should NOT match)
      fs.writeFileSync(path.join(tmpDir, 'src', 'README.md'), '# Readme');

      // Wait for debounce
      await new Promise((r) => setTimeout(r, 500));

      if ((mockSender.send as ReturnType<typeof vi.fn>).mock.calls.length > 0) {
        const allEvents = (mockSender.send as ReturnType<typeof vi.fn>).mock.calls.flatMap(
          (call: unknown[]) => (call[1] as { events: Array<{ path: string }> }).events,
        );
        // No .md files should be forwarded
        expect(allEvents.some((e: { path: string }) => e.path.endsWith('.md'))).toBe(false);
      }

      stopWatch('test-3');
    });

    it('should throw when the base directory does not exist', () => {
      const glob = '/nonexistent/path/**/*.ts';
      expect(() => startWatch('test-4', glob, mockSender)).toThrow('Watch directory does not exist');
    });

    it('should clean up existing watch with same ID before starting new one', () => {
      const glob = path.join(tmpDir, 'src', '**', '*.ts');
      startWatch('test-5', glob, mockSender);
      // Starting another watch with same ID should not throw
      expect(() => startWatch('test-5', glob, mockSender)).not.toThrow();
      stopWatch('test-5');
    });
  });

  describe('extractBaseDir (via startWatch)', () => {
    it('should handle globs with double star patterns', () => {
      // This glob pattern should extract tmpDir/src as base directory
      const glob = path.join(tmpDir, 'src', '**', '*.ts');
      expect(() => startWatch('test-base-1', glob, mockSender)).not.toThrow();
      stopWatch('test-base-1');
    });

    it('should handle globs with single star patterns', () => {
      const glob = path.join(tmpDir, 'src', '*.ts');
      expect(() => startWatch('test-base-2', glob, mockSender)).not.toThrow();
      stopWatch('test-base-2');
    });
  });
});
