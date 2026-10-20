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

const emit = vi.fn();
const diagItems = () => emit.mock.calls.flatMap((c) => c[0].items).filter((i: { t: string }) => i.t === 'diag');

/** Main says: local logging on, telemetry signals off. */
async function connectTelemetry(): Promise<void> {
  _resetRendererTelemetryForTests();
  emit.mockClear();
  initRendererTelemetry({ emit, rendererReady: vi.fn(), getState: async () => ({ enabled: false, level: null, diag: true }), onStateChanged: () => () => {} });
  await Promise.resolve();
}

describe('renderer-logger', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    await connectTelemetry();
  });

  afterEach(() => {
    _resetRendererTelemetryForTests();
    vi.useRealTimers();
  });

  it('sends a diag line with the right fields', () => {
    rendererLog('app:plugins', 'info', 'Plugin loaded');
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);

    // No ts: the recorder in main stamps each line.
    expect(diagItems()).toEqual([{ t: 'diag', ns: 'app:plugins', level: 'info', msg: 'Plugin loaded' }]);
  });

  it('includes projectId and meta when provided', () => {
    rendererLog('plugin:terminal', 'warn', 'Shell exited', {
      projectId: 'proj-1',
      meta: { exitCode: 137 },
    });
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);

    expect(diagItems()[0].meta).toEqual({ projectId: 'proj-1', exitCode: 137 });
  });

  it('supports all log levels', () => {
    const levels = ['debug', 'info', 'warn', 'error', 'fatal'] as const;
    for (const level of levels) rendererLog('app:test', level, `msg-${level}`);
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
    expect(diagItems().map((i: { level: string }) => i.level)).toEqual([...levels]);
  });

  it('is fire-and-forget', () => {
    const result = rendererLog('app:test', 'info', 'test');
    expect(result).toBeUndefined();
  });
});

describe('renderer-logger diag tier (#2302)', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    await connectTelemetry();
  });

  afterEach(() => {
    _resetRendererTelemetryForTests();
    vi.useRealTimers();
  });

  it('sends a diag line with namespace and level', () => {
    rendererLog('app:plugins', 'warn', 'Plugin failed', { meta: { code: 7 } });
    expect(emit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
    expect(diagItems()).toEqual([{ t: 'diag', ns: 'app:plugins', level: 'warn', msg: 'Plugin failed', meta: { code: 7 } }]);
  });

  it('carries projectId in diag meta', () => {
    rendererLog('plugin:terminal', 'error', 'Shell exited', { projectId: 'proj-1', meta: { exitCode: 137 } });
    rendererLog('plugin:terminal', 'info', 'No meta', { projectId: 'proj-1' });
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
    expect(diagItems().map((i: { meta?: unknown }) => i.meta)).toEqual([{ exitCode: 137, projectId: 'proj-1' }, { projectId: 'proj-1' }]);
  });

  it('batches lines instead of one IPC each', () => {
    for (let i = 0; i < FLUSH_AT_ITEMS + 5; i++) rendererLog('app:test', 'debug', `m${i}`);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0].items).toHaveLength(FLUSH_AT_ITEMS);
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(diagItems()).toHaveLength(FLUSH_AT_ITEMS + 5);
  });

  it('sends no diag while local logging is off', () => {
    _setStateForTests({ enabled: false, level: null });
    rendererLog('app:test', 'error', 'x');
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
    expect(emit).not.toHaveBeenCalled();
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
  });

  it('plugin api.logging methods still return undefined', () => {
    const api = createLoggingAPI({ pluginId: 'p', pluginPath: '/p', scope: 'app' } as PluginContext);
    expect(api.info('x')).toBeUndefined();
  });
});

/** The deprecated log:write path to the session log. Delete with the writer (#2313). */
describe('renderer-logger legacy log:write (until #2313)', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    await connectTelemetry();
    (window as any).clubhouse.log.write = vi.fn();
  });

  afterEach(() => {
    _resetRendererTelemetryForTests();
    vi.useRealTimers();
  });

  it('writes the legacy entry with a timestamp, projectId and meta kept apart', () => {
    rendererLog('plugin:terminal', 'warn', 'Shell exited', { projectId: 'proj-1', meta: { exitCode: 137 } });
    const entry = (window as any).clubhouse.log.write.mock.calls[0][0];
    expect(entry).toMatchObject({ ns: 'plugin:terminal', level: 'warn', msg: 'Shell exited', projectId: 'proj-1', meta: { exitCode: 137 } });
    expect(new Date(entry.ts).toISOString()).toBe(entry.ts);
  });

  it('still writes the legacy log while diag is off', () => {
    _setStateForTests({ enabled: false, level: null });
    rendererLog('app:test', 'error', 'x');
    expect((window as any).clubhouse.log.write).toHaveBeenCalledTimes(1);
  });

  it('plugin api.logging keeps the legacy entry shape (plugin API contract)', () => {
    const api = createLoggingAPI({ pluginId: 'my-plugin', pluginPath: '/p', scope: 'project', projectId: 'proj-1' } as PluginContext);
    api.info('i', { n: 1 });
    const legacy = (window as any).clubhouse.log.write.mock.calls[0][0];
    expect(legacy).toMatchObject({ ns: 'plugin:my-plugin', level: 'info', msg: 'i', projectId: 'proj-1', meta: { n: 1 } });
  });
});
