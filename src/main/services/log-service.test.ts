import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./log-settings', () => ({
  getSettings: vi.fn(),
}));

import * as logSettings from './log-settings';
import { flush, appLog } from './log-service';
import { _resetDiagForTests, getDiagNamespaces, setDiagSink, type DiagRecord } from '../telemetry/diag';
import { _resetBreadcrumbsForTests, recentBreadcrumbs } from './breadcrumbs';
import { KNOWN_LOG_NAMESPACES, listLogNamespaces } from '../../shared/log-namespaces';

/** What Settings lists (app-handlers GET_LOG_NAMESPACES). */
const getNamespaces = () => listLogNamespaces(getDiagNamespaces());

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

describe('log-service', () => {
  let sink: ReturnType<typeof memorySink>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(logSettings.getSettings).mockReturnValue({
      enabled: true,
      namespaces: {},
      retention: 'medium',
      minLogLevel: 'info',
    });
    _resetDiagForTests();
    sink = memorySink();
    setDiagSink(sink);
  });

  afterEach(() => {
    _resetDiagForTests();
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
      appLog('ui:chat:switch', 'info', 'Runtime switch requested', { meta: { breadcrumb: { kind: 'event', code: 'runtime.switch.chat' } } });
      // A hang is recorded by crash-handlers, then logged: it counts once.
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
