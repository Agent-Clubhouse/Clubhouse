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
import { _resetDiagForTests, setDiagSink, type DiagRecord } from '../telemetry/diag';
import { _resetBreadcrumbsForTests, recentBreadcrumbs } from './breadcrumbs';
import { KNOWN_LOG_NAMESPACES } from '../../shared/log-namespaces';

/** A recorder stand-in that keeps the diag lines it is given. */
function memorySink() {
  const lines: DiagRecord[] = [];
  return {
    lines,
    writeDiag: (r: DiagRecord) => lines.push(r),
    noteDiagDropped: vi.fn(),
    flush: vi.fn(async () => {}),
    flushSync: vi.fn(),
  };
}

// The electron mock provides app.getPath('home') → path.join(os.tmpdir(), 'clubhouse-test-home')
const EXPECTED_LOG_DIR = path.join(os.tmpdir(), 'clubhouse-test-home', '.clubhouse', 'logs');

describe('log-service', () => {
  let sink: ReturnType<typeof memorySink>;

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

    _resetDiagForTests();
    sink = memorySink();
    setDiagSink(sink);

    await init();
    // Clear the init-related mock calls so each test starts with a clean count
    vi.mocked(fsp.mkdir).mockClear();
    vi.mocked(fsp.readdir).mockClear();
    vi.mocked(fsp.appendFile).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetDiagForTests();
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
  });

  describe('getLogPath', () => {
    it('returns the log directory path', () => {
      expect(getLogPath()).toBe(EXPECTED_LOG_DIR);
    });
  });

  describe('getNamespaces', () => {
    it('lists the known namespaces before anything is logged (#2312)', () => {
      expect(getNamespaces()).toEqual([...KNOWN_LOG_NAMESPACES].sort());
    });

    it('returns discovered namespaces after logging', () => {
      appLog('app:ipc', 'info', 'test');
      appLog('plugin:terminal', 'info', 'test');
      appLog('app:ipc', 'debug', 'dup');

      const namespaces = getNamespaces();
      expect(namespaces).toContain('app:ipc');
      expect(namespaces).toContain('plugin:terminal');
      expect(namespaces.filter((ns) => ns === 'app:ipc')).toHaveLength(1);
    });

    it('returns namespaces in sorted order', () => {
      appLog('plugin:z', 'info', 'z');
      appLog('app:a', 'info', 'a');
      appLog('app:m', 'info', 'm');

      const ns = getNamespaces();
      expect(ns).toContain('app:a');
      expect(ns).toContain('app:m');
      expect(ns).toContain('plugin:z');
      // Verify sorted
      const sorted = [...ns].sort();
      expect(ns).toEqual(sorted);
    });
  });

  describe('feedback breadcrumbs', () => {
    beforeEach(() => { _resetBreadcrumbsForTests(() => 1_000); });

    it('are not taken from log lines; producers record them directly (#2303)', () => {
      log({ ts: 't', ns: 'ui:perf', level: 'warn', msg: 'Long frames: 640ms in agent', meta: { kind: 'long_frame', maxMs: 640, count: 2 } });
      log({ ts: 't', ns: 'ui:chat:switch', level: 'info', msg: 'Runtime switch requested', meta: { breadcrumb: { kind: 'event', code: 'runtime.switch.chat' } } });
      // appLog too, so a hang (recorded by crash-handlers, then logged) counts once.
      appLog('ui:perf', 'warn', 'Window responsive again', { meta: { windowKind: 'main', durationMs: 2_500 } });
      expect(recentBreadcrumbs()).toEqual([]);
    });
  });

  describe('appLog gating (diag)', () => {
    const settings = (over: Record<string, unknown>) => ({ enabled: true, namespaces: {}, retention: 'medium', minLogLevel: 'info', ...over });

    it('does not write when logging is disabled', () => {
      vi.mocked(logSettings.getSettings).mockReturnValue(settings({ enabled: false }));
      appLog('app:test', 'info', 'hello');
      expect(sink.lines).toEqual([]);
    });

    it('does not write when namespace is explicitly disabled', () => {
      vi.mocked(logSettings.getSettings).mockReturnValue(settings({ namespaces: { 'app:noisy': false } }));
      appLog('app:noisy', 'info', 'filtered');
      expect(sink.lines).toEqual([]);
    });

    it('writes when namespace is not in filter (default: all enabled)', () => {
      appLog('app:test', 'info', 'hello');
      expect(sink.lines).toHaveLength(1);
    });

    it('writes when namespace is explicitly enabled', () => {
      vi.mocked(logSettings.getSettings).mockReturnValue(settings({ namespaces: { 'app:test': true } }));
      appLog('app:test', 'info', 'hello');
      expect(sink.lines).toHaveLength(1);
    });

    it('still records namespace even when disabled', () => {
      vi.mocked(logSettings.getSettings).mockReturnValue(settings({ namespaces: { 'app:hidden': false } }));
      appLog('app:hidden', 'info', 'filtered');
      expect(getNamespaces()).toContain('app:hidden');
    });

    it('skips debug entries when minLogLevel is info', () => {
      appLog('app:test', 'debug', 'verbose');
      expect(sink.lines).toEqual([]);
    });

    it('passes warn entries when minLogLevel is info', () => {
      appLog('app:test', 'warn', 'warning');
      expect(sink.lines).toHaveLength(1);
    });

    it('passes debug entries when minLogLevel is debug', () => {
      vi.mocked(logSettings.getSettings).mockReturnValue(settings({ minLogLevel: 'debug' }));
      appLog('app:test', 'debug', 'verbose');
      expect(sink.lines).toHaveLength(1);
    });

    it('does not record namespace when logging globally disabled', () => {
      vi.mocked(logSettings.getSettings).mockReturnValue(settings({ enabled: false }));
      appLog('app:never-seen', 'info', 'hi');
      expect(getNamespaces()).not.toContain('app:never-seen');
    });
  });

  describe('appLog', () => {
    it('creates a properly structured diag line', () => {
      appLog('app:ipc', 'info', 'Connection established', {
        projectId: 'proj-1',
        meta: { sessionId: 's1' },
      });

      // ts is stamped by the recorder; projectId travels in meta.
      expect(sink.lines).toEqual([{ ns: 'app:ipc', level: 'info', msg: 'Connection established', meta: { projectId: 'proj-1', sessionId: 's1' } }]);
    });

    it('works without optional fields', () => {
      vi.mocked(logSettings.getSettings).mockReturnValue({
        enabled: true,
        namespaces: {},
        retention: 'medium',
        minLogLevel: 'debug',
      });

      appLog('app:test', 'debug', 'simple message');

      expect(sink.lines).toEqual([{ ns: 'app:test', level: 'debug', msg: 'simple message' }]);
    });

    it('supports all log levels', () => {
      vi.mocked(logSettings.getSettings).mockReturnValue({
        enabled: true,
        namespaces: {},
        retention: 'medium',
        minLogLevel: 'debug',
      });

      const levels = ['debug', 'info', 'warn', 'error', 'fatal'] as const;
      for (const level of levels) appLog('app:test', level, `msg-${level}`);
      expect(sink.lines.map((l) => l.level)).toEqual([...levels]);
    });

    it('flushes the recorder', async () => {
      await flush();
      expect(sink.flush).toHaveBeenCalled();
    });
  });
});
