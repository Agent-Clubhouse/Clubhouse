import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const appEvents = vi.hoisted(() => new (require('node:events').EventEmitter)());
vi.mock('electron', () => ({ app: appEvents, ipcMain: { on: vi.fn(), handle: vi.fn() } }));
vi.mock('../util/ipc-broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

import { ATTR } from '../../shared/telemetry/attributes';
import { _resetCrashTelemetryForTests, installCrashTelemetry, reportMainProcessError } from './crash-handlers';
import { setRuntime } from './facade';
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
  setRuntime(rt);
  installCrashTelemetry();
});

afterEach(() => {
  setRuntime(null);
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
});
