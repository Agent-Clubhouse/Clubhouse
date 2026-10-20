import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const appEvents = vi.hoisted(() => new (require('node:events').EventEmitter)());
vi.mock('electron', () => ({ app: appEvents, ipcMain: { on: vi.fn(), handle: vi.fn() } }));
vi.mock('../util/ipc-broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../services/log-service', () => ({ appLog: vi.fn() }));

import { ATTR } from '../../shared/telemetry/attributes';
import { appLog } from '../services/log-service';
import { _resetBreadcrumbsForTests, recentBreadcrumbs } from '../services/breadcrumbs';
import { _resetCrashTelemetryForTests, installCrashTelemetry, reportMainProcessError } from './crash-handlers';
import { setProducingRuntime } from './__test-utils__/producing-runtime';
import type { TelemetryRuntime } from './types';

function fakeRuntime(): TelemetryRuntime {
  return {
    level: 'standard',
    flow: vi.fn(),
    step: vi.fn(),
    count: vi.fn(),
    event: vi.fn(),
    exception: vi.fn(),
    replaySpan: vi.fn(),
    preview: () => [],
    forceFlush: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
  };
}

let rt: TelemetryRuntime;

beforeEach(() => {
  rt = fakeRuntime();
  setProducingRuntime(rt);
  installCrashTelemetry();
});

afterEach(() => {
  setProducingRuntime(null);
  appEvents.removeAllListeners();
  _resetCrashTelemetryForTests();
});

describe('crash telemetry', () => {
  it('reports main uncaught errors and force-flushes', () => {
    reportMainProcessError(new RangeError('boom'), 'uncaught');
    expect(rt.exception).toHaveBeenCalledWith(expect.any(RangeError), { origin: 'main', handled: false });
    expect(rt.forceFlush).toHaveBeenCalled();
  });

  it('does not flush for unhandled rejections', () => {
    reportMainProcessError('just a string', 'unhandled-rejection');
    expect(rt.exception).toHaveBeenCalledTimes(1);
    expect(rt.forceFlush).not.toHaveBeenCalled();
  });

  it('records render-process-gone with the reason enum', () => {
    appEvents.emit('render-process-gone', {}, { id: 99 }, { reason: 'oom', exitCode: 5 });
    expect(rt.event).toHaveBeenCalledWith('clubhouse.renderer.gone', [
      ATTR.rendererGoneReason('oom'),
      ATTR.exitCode(5),
      ATTR.windowKind('popout'),
    ]);
  });

  it('records child-process-gone', () => {
    appEvents.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 1 });
    expect(rt.event).toHaveBeenCalledWith('clubhouse.child_process.gone', expect.arrayContaining([ATTR.childProcessType('GPU')]));
  });

  it('records one span per hang, from unresponsive to responsive', () => {
    const win = Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents: { id: 3 } });
    appEvents.emit('browser-window-created', {}, win);
    win.emit('responsive');
    expect(rt.replaySpan).not.toHaveBeenCalled();
    win.emit('unresponsive');
    win.emit('responsive');
    expect(rt.replaySpan).toHaveBeenCalledWith(expect.objectContaining({ name: 'clubhouse.renderer.unresponsive' }));
    expect(rt.count).toHaveBeenCalledWith('clubhouse.renderer.unresponsive_count', 1, [ATTR.windowKind('popout')]);
  });

  it('logs both ends of a hang locally under ui:perf, with the duration, even with telemetry off', () => {
    setProducingRuntime(null);
    vi.useFakeTimers();
    try {
      const win = Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents: { id: 3 } });
      appEvents.emit('browser-window-created', {}, win);
      win.emit('unresponsive');
      expect(appLog).toHaveBeenLastCalledWith('ui:perf', 'warn', 'Window unresponsive', { meta: { windowKind: 'popout' } });
      vi.advanceTimersByTime(2_500);
      win.emit('responsive');
      expect(appLog).toHaveBeenLastCalledWith('ui:perf', 'warn', 'Window responsive again', { meta: { windowKind: 'popout', durationMs: 2_500 } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('notes a hang as a feedback breadcrumb itself, not through the log line (#2303)', () => {
    // appLog is a mock that writes nothing: the legacy log path is gone.
    _resetBreadcrumbsForTests(() => 1_000);
    vi.useFakeTimers();
    try {
      const win = Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents: { id: 3 } });
      appEvents.emit('browser-window-created', {}, win);
      win.emit('unresponsive');
      vi.advanceTimersByTime(2_500);
      win.emit('responsive');
      expect(recentBreadcrumbs()).toEqual([{ kind: 'performance', atMs: 1_000, code: 'window.unresponsive', value: 2_500 }]);
    } finally {
      vi.useRealTimers();
    }
  });
});
