import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rendererLog } from './renderer-logger';
import { createLoggingAPI } from './plugin-api-logging';
import type { PluginContext } from '../../shared/plugin-types';
import {
  FLUSH_AT_ITEMS,
  FLUSH_INTERVAL_MS,
  _resetRendererTelemetryForTests,
  _setStateForTests,
  initRendererTelemetry,
} from '../telemetry/facade';

// Uses the centralized window.clubhouse mock from test/setup-renderer.ts.
// Override log.write with a spy for assertion.

describe('renderer-logger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Replace the noop with a spy so we can assert calls
    (window as any).clubhouse.log.write = vi.fn();
  });

  it('sends a log entry over IPC with correct fields', () => {
    rendererLog('app:plugins', 'info', 'Plugin loaded');

    const mockWrite = (window as any).clubhouse.log.write;
    expect(mockWrite).toHaveBeenCalledTimes(1);
    const entry = mockWrite.mock.calls[0][0];
    expect(entry.ns).toBe('app:plugins');
    expect(entry.level).toBe('info');
    expect(entry.msg).toBe('Plugin loaded');
    expect(entry.ts).toBeDefined();
    expect(entry.projectId).toBeUndefined();
    expect(entry.meta).toBeUndefined();
  });

  it('includes projectId and meta when provided', () => {
    rendererLog('plugin:terminal', 'warn', 'Shell exited', {
      projectId: 'proj-1',
      meta: { exitCode: 137 },
    });

    const entry = (window as any).clubhouse.log.write.mock.calls[0][0];
    expect(entry.projectId).toBe('proj-1');
    expect(entry.meta).toEqual({ exitCode: 137 });
  });

  it('generates an ISO timestamp', () => {
    rendererLog('app:test', 'debug', 'test');

    const entry = (window as any).clubhouse.log.write.mock.calls[0][0];
    // Should be a valid ISO string
    expect(new Date(entry.ts).toISOString()).toBe(entry.ts);
  });

  it('supports all log levels', () => {
    const levels = ['debug', 'info', 'warn', 'error', 'fatal'] as const;
    for (const level of levels) {
      vi.clearAllMocks();
      (window as any).clubhouse.log.write = vi.fn();
      rendererLog('app:test', level, `msg-${level}`);
      expect((window as any).clubhouse.log.write.mock.calls[0][0].level).toBe(level);
    }
  });

  it('is fire-and-forget (uses send, not invoke)', () => {
    // The mock is a simple function call — no Promise returned
    const result = rendererLog('app:test', 'info', 'test');
    expect(result).toBeUndefined();
  });
});

describe('renderer-logger diag tier (#2302)', () => {
  const emit = vi.fn();
  const diagItems = () => emit.mock.calls.flatMap((c) => c[0].items).filter((i: { t: string }) => i.t === 'diag');

  beforeEach(async () => {
    vi.useFakeTimers();
    emit.mockClear();
    (window as any).clubhouse.log.write = vi.fn();
    // Main says: local logging on, telemetry signals off.
    initRendererTelemetry({ emit, rendererReady: vi.fn(), getState: async () => ({ enabled: false, level: null, diag: true }), onStateChanged: () => () => {} });
    await Promise.resolve();
  });

  afterEach(() => {
    _resetRendererTelemetryForTests();
    vi.useRealTimers();
  });

  it('sends a diag line with namespace and level, and still writes the legacy log', () => {
    rendererLog('app:plugins', 'warn', 'Plugin failed', { meta: { code: 7 } });
    expect(emit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
    expect(diagItems()).toEqual([{ t: 'diag', ns: 'app:plugins', level: 'warn', msg: 'Plugin failed', meta: { code: 7 } }]);
    expect((window as any).clubhouse.log.write).toHaveBeenCalledTimes(1);
  });

  it('carries projectId in diag meta without changing the legacy entry', () => {
    rendererLog('plugin:terminal', 'error', 'Shell exited', { projectId: 'proj-1', meta: { exitCode: 137 } });
    rendererLog('plugin:terminal', 'info', 'No meta', { projectId: 'proj-1' });
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
    expect(diagItems().map((i: { meta?: unknown }) => i.meta)).toEqual([{ exitCode: 137, projectId: 'proj-1' }, { projectId: 'proj-1' }]);
    const entry = (window as any).clubhouse.log.write.mock.calls[0][0];
    expect(entry.meta).toEqual({ exitCode: 137 });
    expect(entry.projectId).toBe('proj-1');
  });

  it('batches lines instead of one IPC each', () => {
    for (let i = 0; i < FLUSH_AT_ITEMS + 5; i++) rendererLog('app:test', 'debug', `m${i}`);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0].items).toHaveLength(FLUSH_AT_ITEMS);
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(diagItems()).toHaveLength(FLUSH_AT_ITEMS + 5);
  });

  it('sends no diag while local logging is off, and keeps the legacy write', () => {
    _setStateForTests({ enabled: false, level: null });
    rendererLog('app:test', 'error', 'x');
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
    expect(emit).not.toHaveBeenCalled();
    expect((window as any).clubhouse.log.write).toHaveBeenCalledTimes(1);
  });

  it('never throws, even without the preload bridge', () => {
    const saved = (window as any).clubhouse;
    try {
      (window as any).clubhouse = undefined;
      expect(() => rendererLog('app:test', 'info', 'x')).not.toThrow();
      (window as any).clubhouse = { log: { write: () => { throw new Error('ipc gone'); } } };
      expect(() => rendererLog('app:test', 'info', 'x')).not.toThrow();
    } finally {
      (window as any).clubhouse = saved;
    }
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
    expect(diagItems()).toHaveLength(2);
  });

  it('plugin api.logging writes plugin:<id> diag lines at every level', () => {
    const api = createLoggingAPI({ pluginId: 'my-plugin', pluginPath: '/p', scope: 'project', projectId: 'proj-1' } as PluginContext);
    api.debug('d');
    api.info('i', { n: 1 });
    api.warn('w');
    api.error('e');
    api.fatal('f');
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
    expect(diagItems().map((i: { ns: string; level: string; msg: string }) => [i.ns, i.level, i.msg])).toEqual([
      ['plugin:my-plugin', 'debug', 'd'],
      ['plugin:my-plugin', 'info', 'i'],
      ['plugin:my-plugin', 'warn', 'w'],
      ['plugin:my-plugin', 'error', 'e'],
      ['plugin:my-plugin', 'fatal', 'f'],
    ]);
    expect(diagItems()[1].meta).toEqual({ n: 1, projectId: 'proj-1' });
    // The legacy entry keeps its shape (plugin API contract).
    const legacy = (window as any).clubhouse.log.write.mock.calls[1][0];
    expect(legacy).toMatchObject({ ns: 'plugin:my-plugin', level: 'info', msg: 'i', projectId: 'proj-1', meta: { n: 1 } });
  });

  it('plugin api.logging methods still return undefined', () => {
    const api = createLoggingAPI({ pluginId: 'p', pluginPath: '/p', scope: 'app' } as PluginContext);
    expect(api.info('x')).toBeUndefined();
  });
});
