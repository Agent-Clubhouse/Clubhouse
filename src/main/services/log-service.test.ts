import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';

vi.mock('fs', () => ({
  mkdirSync: vi.fn(),
  statSync: vi.fn(),
  appendFileSync: vi.fn(),
  readdirSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock('./log-settings', () => ({
  getSettings: vi.fn(),
}));

import * as fs from 'fs';
import * as logSettings from './log-settings';
import { init, log, flush, appLog, getLogPath, getNamespaces } from './log-service';

// The electron mock provides app.getPath('home') → path.join(os.tmpdir(), 'clubhouse-test-home')
const EXPECTED_LOG_DIR = path.join(os.tmpdir(), 'clubhouse-test-home', '.clubhouse', 'logs');

describe('log-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    // Flush any stale buffer from prior tests before resetting mocks
    flush();
    vi.clearAllMocks();

    // Default: logging enabled, no namespace filters, medium retention, info level
    vi.mocked(logSettings.getSettings).mockReturnValue({
      enabled: true,
      namespaces: {},
      retention: 'medium',
      minLogLevel: 'info',
    });

    // statSync throws by default (file doesn't exist yet)
    vi.mocked(fs.statSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });

    // readdirSync returns empty by default
    vi.mocked(fs.readdirSync).mockReturnValue([]);

    init();
    // Clear the init-related mock calls so each test starts with a clean count
    vi.mocked(fs.mkdirSync).mockClear();
    vi.mocked(fs.readdirSync).mockClear();
    vi.mocked(fs.appendFileSync).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('init', () => {
    it('creates the log directory', () => {
      vi.mocked(fs.mkdirSync).mockClear();
      init();
      expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalledWith(
        EXPECTED_LOG_DIR,
        { recursive: true },
      );
    });

    it('runs cleanup on startup (reads log dir)', () => {
      vi.mocked(fs.readdirSync).mockClear();
      init();
      expect(vi.mocked(fs.readdirSync)).toHaveBeenCalledWith(
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
    it('does not write when logging is disabled', () => {
      vi.mocked(logSettings.getSettings).mockReturnValue({
        enabled: false,
        namespaces: {},
        retention: 'medium',
        minLogLevel: 'info',
      });

      log({ ts: '2026-01-01T00:00:00Z', ns: 'app:test', level: 'info', msg: 'hello' });
      flush();

      expect(vi.mocked(fs.appendFileSync)).not.toHaveBeenCalled();
    });

    it('does not write when namespace is explicitly disabled', () => {
      vi.mocked(logSettings.getSettings).mockReturnValue({
        enabled: true,
        namespaces: { 'app:noisy': false },
        retention: 'medium',
        minLogLevel: 'info',
      });

      log({ ts: '2026-01-01T00:00:00Z', ns: 'app:noisy', level: 'info', msg: 'filtered' });
      flush();

      expect(vi.mocked(fs.appendFileSync)).not.toHaveBeenCalled();
    });

    it('writes when namespace is not in filter (default: all enabled)', () => {
      log({ ts: '2026-01-01T00:00:00Z', ns: 'app:test', level: 'info', msg: 'hello' });
      flush();

      expect(vi.mocked(fs.appendFileSync)).toHaveBeenCalledTimes(1);
    });

    it('writes when namespace is explicitly enabled', () => {
      vi.mocked(logSettings.getSettings).mockReturnValue({
        enabled: true,
        namespaces: { 'app:test': true },
        retention: 'medium',
        minLogLevel: 'info',
      });

      log({ ts: '2026-01-01T00:00:00Z', ns: 'app:test', level: 'info', msg: 'hello' });
      flush();

      expect(vi.mocked(fs.appendFileSync)).toHaveBeenCalledTimes(1);
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

    it('skips debug entries when minLogLevel is info', () => {
      log({ ts: '2026-01-01T00:00:00Z', ns: 'app:test', level: 'debug', msg: 'verbose' });
      flush();

      expect(vi.mocked(fs.appendFileSync)).not.toHaveBeenCalled();
    });

    it('passes warn entries when minLogLevel is info', () => {
      log({ ts: '2026-01-01T00:00:00Z', ns: 'app:test', level: 'warn', msg: 'warning' });
      flush();

      expect(vi.mocked(fs.appendFileSync)).toHaveBeenCalledTimes(1);
    });

    it('passes debug entries when minLogLevel is debug', () => {
      vi.mocked(logSettings.getSettings).mockReturnValue({
        enabled: true,
        namespaces: {},
        retention: 'medium',
        minLogLevel: 'debug',
      });

      log({ ts: '2026-01-01T00:00:00Z', ns: 'app:test', level: 'debug', msg: 'verbose' });
      flush();

      expect(vi.mocked(fs.appendFileSync)).toHaveBeenCalledTimes(1);
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
    it('writes buffered entries as JSON lines', () => {
      log({ ts: '2026-01-01T00:00:00Z', ns: 'app:test', level: 'info', msg: 'one' });
      log({ ts: '2026-01-01T00:00:01Z', ns: 'app:test', level: 'warn', msg: 'two' });
      flush();

      expect(vi.mocked(fs.appendFileSync)).toHaveBeenCalledTimes(1);
      const written = vi.mocked(fs.appendFileSync).mock.calls[0][1] as string;
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

    it('is a no-op when buffer is empty', () => {
      flush();
      expect(vi.mocked(fs.appendFileSync)).not.toHaveBeenCalled();
    });

    it('clears the buffer after writing', () => {
      log({ ts: '2026-01-01T00:00:00Z', ns: 'app:test', level: 'info', msg: 'hello' });
      flush();
      flush(); // second flush should be a no-op

      expect(vi.mocked(fs.appendFileSync)).toHaveBeenCalledTimes(1);
    });

    it('does not throw when appendFileSync fails', () => {
      vi.mocked(fs.appendFileSync).mockImplementation(() => {
        throw new Error('disk full');
      });

      log({ ts: '2026-01-01T00:00:00Z', ns: 'app:test', level: 'info', msg: 'hello' });
      expect(() => flush()).not.toThrow();
    });

    it('writes to a file with session- prefix', () => {
      log({ ts: '2026-01-01T00:00:00Z', ns: 'app:test', level: 'info', msg: 'hello' });
      flush();

      const filePath = vi.mocked(fs.appendFileSync).mock.calls[0][0] as string;
      expect(filePath).toMatch(/session-.*\.jsonl$/);
      expect(filePath).toContain(EXPECTED_LOG_DIR);
    });
  });

  describe('auto-flush', () => {
    it('flushes on timer interval', () => {
      log({ ts: '2026-01-01T00:00:00Z', ns: 'app:test', level: 'info', msg: 'hello' });

      // Advance timer by 1 second (flush interval)
      vi.advanceTimersByTime(1000);

      expect(vi.mocked(fs.appendFileSync)).toHaveBeenCalledTimes(1);
    });

    it('auto-flushes when buffer reaches 50 entries', () => {
      for (let i = 0; i < 50; i++) {
        log({ ts: '2026-01-01T00:00:00Z', ns: 'app:test', level: 'info', msg: `entry ${i}` });
      }

      // Should have flushed automatically at 50 entries
      expect(vi.mocked(fs.appendFileSync)).toHaveBeenCalledTimes(1);
      const written = vi.mocked(fs.appendFileSync).mock.calls[0][1] as string;
      const lines = written.trim().split('\n');
      expect(lines).toHaveLength(50);
    });
  });

  describe('file rotation', () => {
    it('rotates to a new chunk when file exceeds 2 MB', () => {
      // Mock statSync to return a file near the size limit
      vi.mocked(fs.statSync).mockReturnValue({ size: 0 } as fs.Stats);

      // Re-init to pick up the mock
      init();

      // Write a large entry that would push past 2 MB when combined with file size
      const bigMsg = 'x'.repeat(2 * 1024 * 1024 + 1);
      log({ ts: '2026-01-01T00:00:00Z', ns: 'app:test', level: 'info', msg: bigMsg });
      flush();

      // Second write should go to a new file
      log({ ts: '2026-01-01T00:00:01Z', ns: 'app:test', level: 'info', msg: 'after rotation' });
      flush();

      const calls = vi.mocked(fs.appendFileSync).mock.calls;
      expect(calls.length).toBe(2);
      const firstFile = calls[0][0] as string;
      const secondFile = calls[1][0] as string;
      expect(firstFile).not.toBe(secondFile);
      expect(secondFile).toMatch(/\.1\.jsonl$/);
    });
  });

  describe('cleanup', () => {
    it('deletes log files older than 7 days on init (medium tier)', () => {
      const now = Date.now();
      const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;

      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: 'session-old.jsonl', isFile: () => true } as unknown as fs.Dirent,
        { name: 'session-new.jsonl', isFile: () => true } as unknown as fs.Dirent,
        { name: 'not-a-log.txt', isFile: () => true } as unknown as fs.Dirent,
      ]);

      vi.mocked(fs.statSync).mockImplementation((filePath) => {
        const fp = filePath as string;
        if (fp.includes('session-old')) {
          return { size: 100, mtimeMs: eightDaysAgo } as fs.Stats;
        }
        if (fp.includes('session-new')) {
          return { size: 100, mtimeMs: now } as fs.Stats;
        }
        throw new Error('ENOENT');
      });

      init();

      expect(vi.mocked(fs.unlinkSync)).toHaveBeenCalledWith(
        expect.stringContaining('session-old.jsonl'),
      );
      expect(vi.mocked(fs.unlinkSync)).not.toHaveBeenCalledWith(
        expect.stringContaining('session-new.jsonl'),
      );
      // Should skip non-session files
      expect(vi.mocked(fs.unlinkSync)).not.toHaveBeenCalledWith(
        expect.stringContaining('not-a-log.txt'),
      );
    });

    it('deletes files older than 3 days with low retention', () => {
      const now = Date.now();
      const fourDaysAgo = now - 4 * 24 * 60 * 60 * 1000;

      vi.mocked(logSettings.getSettings).mockReturnValue({
        enabled: true,
        namespaces: {},
        retention: 'low',
        minLogLevel: 'info',
      });

      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: 'session-old.jsonl', isFile: () => true } as unknown as fs.Dirent,
        { name: 'session-new.jsonl', isFile: () => true } as unknown as fs.Dirent,
      ]);

      vi.mocked(fs.statSync).mockImplementation((filePath) => {
        const fp = filePath as string;
        if (fp.includes('session-old')) {
          return { size: 100, mtimeMs: fourDaysAgo } as fs.Stats;
        }
        if (fp.includes('session-new')) {
          return { size: 100, mtimeMs: now } as fs.Stats;
        }
        throw new Error('ENOENT');
      });

      init();

      expect(vi.mocked(fs.unlinkSync)).toHaveBeenCalledWith(
        expect.stringContaining('session-old.jsonl'),
      );
      expect(vi.mocked(fs.unlinkSync)).not.toHaveBeenCalledWith(
        expect.stringContaining('session-new.jsonl'),
      );
    });

    it('does not age-prune with unlimited retention', () => {
      const now = Date.now();
      const yearAgo = now - 365 * 24 * 60 * 60 * 1000;

      vi.mocked(logSettings.getSettings).mockReturnValue({
        enabled: true,
        namespaces: {},
        retention: 'unlimited',
        minLogLevel: 'info',
      });

      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: 'session-ancient.jsonl', isFile: () => true } as unknown as fs.Dirent,
      ]);

      vi.mocked(fs.statSync).mockImplementation((filePath) => {
        const fp = filePath as string;
        if (fp.includes('session-ancient')) {
          return { size: 100, mtimeMs: yearAgo } as fs.Stats;
        }
        throw new Error('ENOENT');
      });

      init();

      expect(vi.mocked(fs.unlinkSync)).not.toHaveBeenCalled();
    });

    it('size-prunes oldest files when total exceeds cap', () => {
      const now = Date.now();
      const MB = 1024 * 1024;

      vi.mocked(logSettings.getSettings).mockReturnValue({
        enabled: true,
        namespaces: {},
        retention: 'low', // 50 MB cap
      });

      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: 'session-a.jsonl', isFile: () => true } as unknown as fs.Dirent,
        { name: 'session-b.jsonl', isFile: () => true } as unknown as fs.Dirent,
        { name: 'session-c.jsonl', isFile: () => true } as unknown as fs.Dirent,
      ]);

      vi.mocked(fs.statSync).mockImplementation((filePath) => {
        const fp = filePath as string;
        if (fp.includes('session-a')) {
          return { size: 20 * MB, mtimeMs: now - 1000 } as fs.Stats; // oldest
        }
        if (fp.includes('session-b')) {
          return { size: 20 * MB, mtimeMs: now - 500 } as fs.Stats;
        }
        if (fp.includes('session-c')) {
          return { size: 20 * MB, mtimeMs: now } as fs.Stats; // newest
        }
        throw new Error('ENOENT');
      });

      init();

      // Total = 60 MB, cap = 50 MB → oldest file (session-a) should be deleted
      expect(vi.mocked(fs.unlinkSync)).toHaveBeenCalledWith(
        expect.stringContaining('session-a.jsonl'),
      );
      // After removing session-a, total = 40 MB < 50 MB cap, so b and c stay
      expect(vi.mocked(fs.unlinkSync)).not.toHaveBeenCalledWith(
        expect.stringContaining('session-b.jsonl'),
      );
      expect(vi.mocked(fs.unlinkSync)).not.toHaveBeenCalledWith(
        expect.stringContaining('session-c.jsonl'),
      );
    });

    it('ignores errors during cleanup', () => {
      vi.mocked(fs.readdirSync).mockImplementation(() => {
        throw new Error('permission denied');
      });

      expect(() => init()).not.toThrow();
    });
  });

  describe('appLog', () => {
    it('creates a properly structured log entry', () => {
      appLog('app:ipc', 'info', 'Connection established', {
        projectId: 'proj-1',
        meta: { sessionId: 's1' },
      });
      flush();

      expect(vi.mocked(fs.appendFileSync)).toHaveBeenCalledTimes(1);
      const written = vi.mocked(fs.appendFileSync).mock.calls[0][1] as string;
      const parsed = JSON.parse(written.trim());

      expect(parsed.ns).toBe('app:ipc');
      expect(parsed.level).toBe('info');
      expect(parsed.msg).toBe('Connection established');
      expect(parsed.projectId).toBe('proj-1');
      expect(parsed.meta).toEqual({ sessionId: 's1' });
      expect(parsed.ts).toBeDefined();
    });

    it('works without optional fields', () => {
      vi.mocked(logSettings.getSettings).mockReturnValue({
        enabled: true,
        namespaces: {},
        retention: 'medium',
        minLogLevel: 'debug',
      });

      appLog('app:test', 'debug', 'simple message');
      flush();

      const written = vi.mocked(fs.appendFileSync).mock.calls[0][1] as string;
      const parsed = JSON.parse(written.trim());

      expect(parsed.ns).toBe('app:test');
      expect(parsed.level).toBe('debug');
      expect(parsed.msg).toBe('simple message');
      expect(parsed.projectId).toBeUndefined();
      expect(parsed.meta).toBeUndefined();
    });

    it('supports all log levels', () => {
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
        flush();
        const written = vi.mocked(fs.appendFileSync).mock.calls[0][1] as string;
        expect(JSON.parse(written.trim()).level).toBe(level);
      }
    });
  });

  describe('JSON line format', () => {
    it('each entry is valid JSON', () => {
      log({
        ts: '2026-02-15T10:30:00.123Z',
        ns: 'plugin:terminal',
        level: 'info',
        msg: 'Shell spawned',
        projectId: 'abc123',
        meta: { sessionId: 's1' },
      });
      flush();

      const written = vi.mocked(fs.appendFileSync).mock.calls[0][1] as string;
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

    it('each line is exactly one JSON object (no pretty-printing)', () => {
      log({ ts: '2026-01-01T00:00:00Z', ns: 'app:a', level: 'info', msg: 'first' });
      log({ ts: '2026-01-01T00:00:01Z', ns: 'app:b', level: 'warn', msg: 'second' });
      flush();

      const written = vi.mocked(fs.appendFileSync).mock.calls[0][1] as string;
      const lines = written.trim().split('\n');
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });
  });
});
