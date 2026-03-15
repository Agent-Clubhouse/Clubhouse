import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';

vi.mock('fs/promises', () => ({
  mkdir: vi.fn(),
  stat: vi.fn(),
  appendFile: vi.fn(),
  readdir: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock('./log-settings', () => ({
  getSettings: vi.fn(),
}));

import * as fsp from 'fs/promises';
import * as logSettings from './log-settings';
import { init, log, flush, appLog, getLogPath, getNamespaces } from './log-service';

// The electron mock provides app.getPath('home') → path.join(os.tmpdir(), 'clubhouse-test-home')
const EXPECTED_LOG_DIR = path.join(os.tmpdir(), 'clubhouse-test-home', '.clubhouse', 'logs');

describe('log-service', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    // Flush any stale buffer from prior tests before resetting mocks
    await flush();
    vi.clearAllMocks();

    // Default: logging enabled, no namespace filters, medium retention, info level
    vi.mocked(logSettings.getSettings).mockReturnValue({
      enabled: true,
      namespaces: {},
      retention: 'medium',
      minLogLevel: 'info',
    });

    // stat rejects by default (file doesn't exist yet)
    vi.mocked(fsp.stat).mockRejectedValue(new Error('ENOENT'));

    // readdir returns empty by default
    vi.mocked(fsp.readdir).mockResolvedValue([]);

    await init();
    // Clear the init-related mock calls so each test starts with a clean count
    vi.mocked(fsp.mkdir).mockClear();
    vi.mocked(fsp.readdir).mockClear();
    vi.mocked(fsp.appendFile).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('init', () => {
    it('creates the log directory', async () => {
      vi.mocked(fsp.mkdir).mockClear();
      await init();
      expect(vi.mocked(fsp.mkdir)).toHaveBeenCalledWith(
        EXPECTED_LOG_DIR,
        { recursive: true },
      );
    });

    it('runs cleanup on startup (reads log dir)', async () => {
      vi.mocked(fsp.readdir).mockClear();
      await init();
      expect(vi.mocked(fsp.readdir)).toHaveBeenCalledWith(
        EXPECTED_LOG_DIR,
        { withFileTypes: true },
      );
    });
  });

  describe('getLogPath', () => {
    it('returns the log directory path', () => {
      expect(getLogPath()).toBe(EXPECTED_LOG_DIR);
    });
  });

  describe('getNamespaces', () => {
    it('returns empty array initially', () => {
      expect(getNamespaces()).toEqual([]);
    });

    it('returns discovered namespaces after logging', () => {
      log({ ts: '2026-01-01T00:00:00Z', ns: 'app:ipc', level: 'info', msg: 'test' });
      log({ ts: '2026-01-01T00:00:00Z', ns: 'plugin:terminal', level: 'info', msg: 'test' });
      log({ ts: '2026-01-01T00:00:00Z', ns: 'app:ipc', level: 'debug', msg: 'dup' });

      const namespaces = getNamespaces();
      expect(namespaces).toContain('app:ipc');
      expect(namespaces).toContain('plugin:terminal');
      expect(namespaces).toHaveLength(2);
    });

    it('returns namespaces in sorted order', () => {
      log({ ts: '2026-01-01T00:00:00Z', ns: 'plugin:z', level: 'info', msg: 'z' });
      log({ ts: '2026-01-01T00:00:00Z', ns: 'app:a', level: 'info', msg: 'a' });
      log({ ts: '2026-01-01T00:00:00Z', ns: 'app:m', level: 'info', msg: 'm' });

      const ns = getNamespaces();
      expect(ns).toContain('app:a');
      expect(ns).toContain('app:m');
      expect(ns).toContain('plugin:z');
      // Verify sorted
      const sorted = [...ns].sort();
      expect(ns).toEqual(sorted);
    });
  });

  describe('log', () => {
    it('does not write when logging is disabled', async () => {
      vi.mocked(logSettings.getSettings).mockReturnValue({
        enabled: false,
        namespaces: {},
        retention: 'medium',
        minLogLevel: 'info',
      });

      log({ ts: '2026-01-01T00:00:00Z', ns: 'app:test', level: 'info', msg: 'hello' });
      await flush();

      expect(vi.mocked(fsp.appendFile)).not.toHaveBeenCalled();
    });

    it('does not write when namespace is explicitly disabled', async () => {
      vi.mocked(logSettings.getSettings).mockReturnValue({
        enabled: true,
        namespaces: { 'app:noisy': false },
        retention: 'medium',
        minLogLevel: 'info',
      });

      log({ ts: '2026-01-01T00:00:00Z', ns: 'app:noisy', level: 'info', msg: 'filtered' });
      await flush();

      expect(vi.mocked(fsp.appendFile)).not.toHaveBeenCalled();
    });

    it('writes when namespace is not in filter (default: all enabled)', async () => {
      log({ ts: '2026-01-01T00:00:00Z', ns: 'app:test', level: 'info', msg: 'hello' });
      await flush();

      expect(vi.mocked(fsp.appendFile)).toHaveBeenCalledTimes(1);
    });

    it('writes when namespace is explicitly enabled', async () => {
      vi.mocked(logSettings.getSettings).mockReturnValue({
        enabled: true,
        namespaces: { 'app:test': true },
        retention: 'medium',
        minLogLevel: 'info',
      });

      log({ ts: '2026-01-01T00:00:00Z', ns: 'app:test', level: 'info', msg: 'hello' });
      await flush();

      expect(vi.mocked(fsp.appendFile)).toHaveBeenCalledTimes(1);
    });

    it('still records namespace even when disabled', () => {
      vi.mocked(logSettings.getSettings).mockReturnValue({
        enabled: true,
        namespaces: { 'app:hidden': false },
        retention: 'medium',
        minLogLevel: 'info',
      });

      log({ ts: '2026-01-01T00:00:00Z', ns: 'app:hidden', level: 'info', msg: 'filtered' });

      expect(getNamespaces()).toContain('app:hidden');
    });

    it('skips debug entries when minLogLevel is info', async () => {
      log({ ts: '2026-01-01T00:00:00Z', ns: 'app:test', level: 'debug', msg: 'verbose' });
      await flush();

      expect(vi.mocked(fsp.appendFile)).not.toHaveBeenCalled();
    });

    it('passes warn entries when minLogLevel is info', async () => {
      log({ ts: '2026-01-01T00:00:00Z', ns: 'app:test', level: 'warn', msg: 'warning' });
      await flush();

      expect(vi.mocked(fsp.appendFile)).toHaveBeenCalledTimes(1);
    });

    it('passes debug entries when minLogLevel is debug', async () => {
      vi.mocked(logSettings.getSettings).mockReturnValue({
        enabled: true,
        namespaces: {},
        retention: 'medium',
        minLogLevel: 'debug',
      });

      log({ ts: '2026-01-01T00:00:00Z', ns: 'app:test', level: 'debug', msg: 'verbose' });
      await flush();

      expect(vi.mocked(fsp.appendFile)).toHaveBeenCalledTimes(1);
    });

    it('does not record namespace when logging globally disabled', () => {
      vi.mocked(logSettings.getSettings).mockReturnValue({
        enabled: false,
        namespaces: {},
        retention: 'medium',
        minLogLevel: 'info',
      });

      // We need a fresh namespace that wasn't logged before
      log({ ts: '2026-01-01T00:00:00Z', ns: 'app:never-seen', level: 'info', msg: 'hi' });

      // Namespace is NOT recorded when globally disabled
      expect(getNamespaces()).not.toContain('app:never-seen');
    });
  });

  describe('flush', () => {
    it('writes buffered entries as JSON lines', async () => {
      log({ ts: '2026-01-01T00:00:00Z', ns: 'app:test', level: 'info', msg: 'one' });
      log({ ts: '2026-01-01T00:00:01Z', ns: 'app:test', level: 'warn', msg: 'two' });
      await flush();

      expect(vi.mocked(fsp.appendFile)).toHaveBeenCalledTimes(1);
      const written = vi.mocked(fsp.appendFile).mock.calls[0][1] as string;
      const lines = written.trim().split('\n');
      expect(lines).toHaveLength(2);

      const parsed0 = JSON.parse(lines[0]);
      expect(parsed0.ns).toBe('app:test');
      expect(parsed0.level).toBe('info');
      expect(parsed0.msg).toBe('one');

      const parsed1 = JSON.parse(lines[1]);
      expect(parsed1.level).toBe('warn');
      expect(parsed1.msg).toBe('two');
    });

    it('is a no-op when buffer is empty', async () => {
      await flush();
      expect(vi.mocked(fsp.appendFile)).not.toHaveBeenCalled();
    });

    it('clears the buffer after writing', async () => {
      log({ ts: '2026-01-01T00:00:00Z', ns: 'app:test', level: 'info', msg: 'hello' });
      await flush();
      await flush(); // second flush should be a no-op

      expect(vi.mocked(fsp.appendFile)).toHaveBeenCalledTimes(1);
    });

    it('does not throw when appendFile fails', async () => {
      vi.mocked(fsp.appendFile).mockRejectedValue(new Error('disk full'));

      log({ ts: '2026-01-01T00:00:00Z', ns: 'app:test', level: 'info', msg: 'hello' });
      await expect(flush()).resolves.not.toThrow();
    });

    it('writes to a file with session- prefix', async () => {
      log({ ts: '2026-01-01T00:00:00Z', ns: 'app:test', level: 'info', msg: 'hello' });
      await flush();

      const filePath = vi.mocked(fsp.appendFile).mock.calls[0][0] as string;
      expect(filePath).toMatch(/session-.*\.jsonl$/);
      expect(filePath).toContain(EXPECTED_LOG_DIR);
    });
  });

  describe('auto-flush', () => {
    it('flushes on timer interval', async () => {
      log({ ts: '2026-01-01T00:00:00Z', ns: 'app:test', level: 'info', msg: 'hello' });

      // Advance timer by 1 second (flush interval)
      await vi.advanceTimersByTimeAsync(1000);

      expect(vi.mocked(fsp.appendFile)).toHaveBeenCalledTimes(1);
    });

    it('auto-flushes when buffer reaches 50 entries', async () => {
      for (let i = 0; i < 50; i++) {
        log({ ts: '2026-01-01T00:00:00Z', ns: 'app:test', level: 'info', msg: `entry ${i}` });
      }

      // flush is async now, need to await the pending promise
      await vi.advanceTimersByTimeAsync(0);

      // Should have flushed automatically at 50 entries
      expect(vi.mocked(fsp.appendFile)).toHaveBeenCalledTimes(1);
      const written = vi.mocked(fsp.appendFile).mock.calls[0][1] as string;
      const lines = written.trim().split('\n');
      expect(lines).toHaveLength(50);
    });
  });

  describe('file rotation', () => {
    it('rotates to a new chunk when file exceeds 2 MB', async () => {
      // Mock stat to return a file near the size limit
      vi.mocked(fsp.stat).mockResolvedValue({ size: 0 } as any);

      // Re-init to pick up the mock
      await init();

      // Write a large entry that would push past 2 MB when combined with file size
      const bigMsg = 'x'.repeat(2 * 1024 * 1024 + 1);
      log({ ts: '2026-01-01T00:00:00Z', ns: 'app:test', level: 'info', msg: bigMsg });
      await flush();

      // Second write should go to a new file
      log({ ts: '2026-01-01T00:00:01Z', ns: 'app:test', level: 'info', msg: 'after rotation' });
      await flush();

      const calls = vi.mocked(fsp.appendFile).mock.calls;
      expect(calls.length).toBe(2);
      const firstFile = calls[0][0] as string;
      const secondFile = calls[1][0] as string;
      expect(firstFile).not.toBe(secondFile);
      expect(secondFile).toMatch(/\.1\.jsonl$/);
    });
  });

  describe('cleanup', () => {
    it('deletes log files older than 7 days on init (medium tier)', async () => {
      const now = Date.now();
      const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;

      vi.mocked(fsp.readdir).mockResolvedValue([
        { name: 'session-old.jsonl', isFile: () => true } as unknown as any,
        { name: 'session-new.jsonl', isFile: () => true } as unknown as any,
        { name: 'not-a-log.txt', isFile: () => true } as unknown as any,
      ]);

      vi.mocked(fsp.stat).mockImplementation(async (filePath) => {
        const fp = filePath as string;
        if (fp.includes('session-old')) {
          return { size: 100, mtimeMs: eightDaysAgo } as any;
        }
        if (fp.includes('session-new')) {
          return { size: 100, mtimeMs: now } as any;
        }
        throw new Error('ENOENT');
      });

      await init();

      expect(vi.mocked(fsp.unlink)).toHaveBeenCalledWith(
        expect.stringContaining('session-old.jsonl'),
      );
      expect(vi.mocked(fsp.unlink)).not.toHaveBeenCalledWith(
        expect.stringContaining('session-new.jsonl'),
      );
      // Should skip non-session files
      expect(vi.mocked(fsp.unlink)).not.toHaveBeenCalledWith(
        expect.stringContaining('not-a-log.txt'),
      );
    });

    it('deletes files older than 3 days with low retention', async () => {
      const now = Date.now();
      const fourDaysAgo = now - 4 * 24 * 60 * 60 * 1000;

      vi.mocked(logSettings.getSettings).mockReturnValue({
        enabled: true,
        namespaces: {},
        retention: 'low',
        minLogLevel: 'info',
      });

      vi.mocked(fsp.readdir).mockResolvedValue([
        { name: 'session-old.jsonl', isFile: () => true } as unknown as any,
        { name: 'session-new.jsonl', isFile: () => true } as unknown as any,
      ]);

      vi.mocked(fsp.stat).mockImplementation(async (filePath) => {
        const fp = filePath as string;
        if (fp.includes('session-old')) {
          return { size: 100, mtimeMs: fourDaysAgo } as any;
        }
        if (fp.includes('session-new')) {
          return { size: 100, mtimeMs: now } as any;
        }
        throw new Error('ENOENT');
      });

      await init();

      expect(vi.mocked(fsp.unlink)).toHaveBeenCalledWith(
        expect.stringContaining('session-old.jsonl'),
      );
      expect(vi.mocked(fsp.unlink)).not.toHaveBeenCalledWith(
        expect.stringContaining('session-new.jsonl'),
      );
    });

    it('does not age-prune with unlimited retention', async () => {
      const now = Date.now();
      const yearAgo = now - 365 * 24 * 60 * 60 * 1000;

      vi.mocked(logSettings.getSettings).mockReturnValue({
        enabled: true,
        namespaces: {},
        retention: 'unlimited',
        minLogLevel: 'info',
      });

      vi.mocked(fsp.readdir).mockResolvedValue([
        { name: 'session-ancient.jsonl', isFile: () => true } as unknown as any,
      ]);

      vi.mocked(fsp.stat).mockImplementation(async (filePath) => {
        const fp = filePath as string;
        if (fp.includes('session-ancient')) {
          return { size: 100, mtimeMs: yearAgo } as any;
        }
        throw new Error('ENOENT');
      });

      await init();

      expect(vi.mocked(fsp.unlink)).not.toHaveBeenCalled();
    });

    it('size-prunes oldest files when total exceeds cap', async () => {
      const now = Date.now();
      const MB = 1024 * 1024;

      vi.mocked(logSettings.getSettings).mockReturnValue({
        enabled: true,
        namespaces: {},
        retention: 'low', // 50 MB cap
      });

      vi.mocked(fsp.readdir).mockResolvedValue([
        { name: 'session-a.jsonl', isFile: () => true } as unknown as any,
        { name: 'session-b.jsonl', isFile: () => true } as unknown as any,
        { name: 'session-c.jsonl', isFile: () => true } as unknown as any,
      ]);

      vi.mocked(fsp.stat).mockImplementation(async (filePath) => {
        const fp = filePath as string;
        if (fp.includes('session-a')) {
          return { size: 20 * MB, mtimeMs: now - 1000 } as any; // oldest
        }
        if (fp.includes('session-b')) {
          return { size: 20 * MB, mtimeMs: now - 500 } as any;
        }
        if (fp.includes('session-c')) {
          return { size: 20 * MB, mtimeMs: now } as any; // newest
        }
        throw new Error('ENOENT');
      });

      await init();

      // Total = 60 MB, cap = 50 MB → oldest file (session-a) should be deleted
      expect(vi.mocked(fsp.unlink)).toHaveBeenCalledWith(
        expect.stringContaining('session-a.jsonl'),
      );
      // After removing session-a, total = 40 MB < 50 MB cap, so b and c stay
      expect(vi.mocked(fsp.unlink)).not.toHaveBeenCalledWith(
        expect.stringContaining('session-b.jsonl'),
      );
      expect(vi.mocked(fsp.unlink)).not.toHaveBeenCalledWith(
        expect.stringContaining('session-c.jsonl'),
      );
    });

    it('ignores errors during cleanup', async () => {
      vi.mocked(fsp.readdir).mockRejectedValue(new Error('permission denied'));

      await expect(init()).resolves.not.toThrow();
    });
  });

  describe('appLog', () => {
    it('creates a properly structured log entry', async () => {
      appLog('app:ipc', 'info', 'Connection established', {
        projectId: 'proj-1',
        meta: { sessionId: 's1' },
      });
      await flush();

      expect(vi.mocked(fsp.appendFile)).toHaveBeenCalledTimes(1);
      const written = vi.mocked(fsp.appendFile).mock.calls[0][1] as string;
      const parsed = JSON.parse(written.trim());

      expect(parsed.ns).toBe('app:ipc');
      expect(parsed.level).toBe('info');
      expect(parsed.msg).toBe('Connection established');
      expect(parsed.projectId).toBe('proj-1');
      expect(parsed.meta).toEqual({ sessionId: 's1' });
      expect(parsed.ts).toBeDefined();
    });

    it('works without optional fields', async () => {
      vi.mocked(logSettings.getSettings).mockReturnValue({
        enabled: true,
        namespaces: {},
        retention: 'medium',
        minLogLevel: 'debug',
      });

      appLog('app:test', 'debug', 'simple message');
      await flush();

      const written = vi.mocked(fsp.appendFile).mock.calls[0][1] as string;
      const parsed = JSON.parse(written.trim());

      expect(parsed.ns).toBe('app:test');
      expect(parsed.level).toBe('debug');
      expect(parsed.msg).toBe('simple message');
      expect(parsed.projectId).toBeUndefined();
      expect(parsed.meta).toBeUndefined();
    });

    it('supports all log levels', async () => {
      vi.mocked(logSettings.getSettings).mockReturnValue({
        enabled: true,
        namespaces: {},
        retention: 'medium',
        minLogLevel: 'debug',
      });

      const levels = ['debug', 'info', 'warn', 'error', 'fatal'] as const;
      for (const level of levels) {
        vi.clearAllMocks();
        appLog('app:test', level, `msg-${level}`);
        await flush();
        const written = vi.mocked(fsp.appendFile).mock.calls[0][1] as string;
        expect(JSON.parse(written.trim()).level).toBe(level);
      }
    });
  });

  describe('JSON line format', () => {
    it('each entry is valid JSON', async () => {
      log({
        ts: '2026-02-15T10:30:00.123Z',
        ns: 'plugin:terminal',
        level: 'info',
        msg: 'Shell spawned',
        projectId: 'abc123',
        meta: { sessionId: 's1' },
      });
      await flush();

      const written = vi.mocked(fsp.appendFile).mock.calls[0][1] as string;
      const parsed = JSON.parse(written.trim());
      expect(parsed).toEqual({
        ts: '2026-02-15T10:30:00.123Z',
        ns: 'plugin:terminal',
        level: 'info',
        msg: 'Shell spawned',
        projectId: 'abc123',
        meta: { sessionId: 's1' },
      });
    });

    it('each line is exactly one JSON object (no pretty-printing)', async () => {
      log({ ts: '2026-01-01T00:00:00Z', ns: 'app:a', level: 'info', msg: 'first' });
      log({ ts: '2026-01-01T00:00:01Z', ns: 'app:b', level: 'warn', msg: 'second' });
      await flush();

      const written = vi.mocked(fsp.appendFile).mock.calls[0][1] as string;
      const lines = written.trim().split('\n');
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });
  });
});
