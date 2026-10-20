import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  appOn: vi.fn(),
  powerOn: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { on: electron.appOn, whenReady: () => Promise.resolve() },
  powerMonitor: { on: electron.powerOn },
}));

const calls = vi.hoisted(() => [] as string[]);
vi.mock('./services/log-service', () => ({
  appLog: vi.fn(() => calls.push('appLog')),
  flush: vi.fn(async () => {
    calls.push('flush');
  }),
  flushSync: vi.fn(() => calls.push('flushSync')),
}));
vi.mock('./telemetry/facade', () => ({
  flushForOsSessionEnd: vi.fn(() => calls.push('flushForOsSessionEnd')),
  forceFlushTelemetry: vi.fn(async () => {
    calls.push('forceFlushTelemetry');
  }),
}));
vi.mock('./telemetry/lifecycle', () => ({
  markOsShutdown: vi.fn(() => calls.push('markOsShutdown')),
}));

import { _resetOsSessionEndForTests, installOsSessionEndFlush } from './os-session-end';

/** A window as `browser-window-created` hands it over. */
function createWindow(): EventEmitter {
  const win = new EventEmitter();
  const created = electron.appOn.mock.calls.find((c) => c[0] === 'browser-window-created')![1];
  created({}, win);
  return win;
}

async function powerMonitorShutdown(): Promise<() => void> {
  await Promise.resolve();
  return electron.powerOn.mock.calls.find((c) => c[0] === 'shutdown')![1];
}

beforeEach(() => {
  calls.length = 0;
  vi.clearAllMocks();
  installOsSessionEndFlush();
});

afterEach(() => {
  _resetOsSessionEndForTests();
});

describe('OS session end (#2335)', () => {
  it('Windows session-end logs, marks the exit, then flushes everything synchronously', () => {
    createWindow().emit('session-end');
    // Synchronous: all of it happened before emit() returned.
    expect(calls).toEqual(['appLog', 'markOsShutdown', 'flushForOsSessionEnd', 'flushSync']);
  });

  it('runs once, however many windows report it', () => {
    const a = createWindow();
    const b = createWindow();
    a.emit('session-end');
    b.emit('session-end');
    expect(calls.filter((c) => c === 'flushSync')).toHaveLength(1);
  });

  it('starts the async flushes when Windows asks whether the session may end', () => {
    createWindow().emit('query-session-end');
    expect(calls).toEqual(['appLog', 'flush', 'forceFlushTelemetry']);
  });

  it('flushes on powerMonitor shutdown (macOS, Linux)', async () => {
    (await powerMonitorShutdown())();
    expect(calls).toEqual(['appLog', 'markOsShutdown', 'flushForOsSessionEnd', 'flushSync']);
  });

  it('still marks and flushes when a step throws', async () => {
    const logService = await import('./services/log-service');
    vi.mocked(logService.appLog).mockImplementationOnce(() => {
      throw new Error('boom');
    });
    expect(() => createWindow().emit('session-end')).not.toThrow();
    expect(calls).toEqual(['markOsShutdown', 'flushForOsSessionEnd', 'flushSync']);
  });

  it('starts one head start per query, however many windows get it', () => {
    const a = createWindow();
    const b = createWindow();
    a.emit('query-session-end');
    b.emit('query-session-end');
    expect(calls.filter((c) => c === 'forceFlushTelemetry')).toHaveLength(1);
  });

  it('still flushes synchronously on session-end after a query', () => {
    const win = createWindow();
    win.emit('query-session-end');
    calls.length = 0;
    win.emit('session-end');
    expect(calls).toEqual(['appLog', 'markOsShutdown', 'flushForOsSessionEnd', 'flushSync']);
  });

  it('ignores a query once the session has ended', () => {
    const win = createWindow();
    win.emit('session-end');
    calls.length = 0;
    win.emit('query-session-end');
    expect(calls).toEqual([]);
  });
});
