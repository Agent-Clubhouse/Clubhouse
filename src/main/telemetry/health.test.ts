import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getAppMetrics: () => [] } }));

import { ATTR, blockedFlowAttr } from '../../shared/telemetry/attributes';
import { setRuntime, tel } from './facade';
import { STALL_EVENT_MIN_GAP_MS, WATCHDOG_INTERVAL_MS, _resetHealthForTests, processTypeOf, sampleHealth, watchdogTick } from './health';
import type { TelemetryRuntime } from './types';

function fakeRuntime(): TelemetryRuntime {
  return {
    level: 'standard',
    flow: vi.fn((_n, _o, fn) => fn({ set: () => {} })),
    step: vi.fn(),
    count: vi.fn(),
    event: vi.fn(),
    exception: vi.fn(),
    replaySpan: vi.fn(),
    replayTree: vi.fn(),
    preview: () => [],
    forceFlush: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
  };
}

let rt: TelemetryRuntime;
beforeEach(() => {
  rt = fakeRuntime();
  setRuntime(rt);
  _resetHealthForTests(0);
});
afterEach(() => {
  _resetHealthForTests();
  setRuntime(null);
});

describe('process health', () => {
  it('maps Electron process types', () => {
    expect(processTypeOf('Browser')).toBe('browser');
    expect(processTypeOf('Tab')).toBe('renderer');
    expect(processTypeOf('GPU')).toBe('gpu');
    expect(processTypeOf('Utility')).toBe('utility');
    expect(processTypeOf('Pepper Plugin')).toBe('other');
  });

  it('sums memory (KB → bytes) and CPU per process type', () => {
    sampleHealth([
      { type: 'Tab', memory: { workingSetSize: 100 }, cpu: { percentCPUUsage: 5 } },
      { type: 'Tab', memory: { workingSetSize: 50 }, cpu: { percentCPUUsage: 2 } },
      { type: 'Browser', memory: { workingSetSize: 10 }, cpu: { percentCPUUsage: 1 } },
    ] as unknown as Electron.ProcessMetric[]);
    expect(rt.count).toHaveBeenCalledWith('clubhouse.process.memory', 150 * 1024, [ATTR.processType('renderer')]);
    expect(rt.count).toHaveBeenCalledWith('clubhouse.process.cpu', 7, [ATTR.processType('renderer')]);
    expect(rt.count).toHaveBeenCalledWith('clubhouse.process.memory', 10 * 1024, [ATTR.processType('browser')]);
  });

  it('names the running flow when the main thread stalls, at most once a minute', async () => {
    let release!: () => void;
    const pending = tel.flow('clubhouse.update.check', {}, () => new Promise<void>((r) => (release = r)));
    watchdogTick(WATCHDOG_INTERVAL_MS + 3000); // fired 3 s late
    expect(rt.event).toHaveBeenCalledWith('clubhouse.process.eventloop_blocked', [blockedFlowAttr('clubhouse.update.check')]);
    watchdogTick(WATCHDOG_INTERVAL_MS * 2 + 6500);
    expect(rt.event).toHaveBeenCalledTimes(1);
    release();
    await pending;
    watchdogTick(STALL_EVENT_MIN_GAP_MS * 3);
    expect(rt.event).toHaveBeenLastCalledWith('clubhouse.process.eventloop_blocked', [blockedFlowAttr('none')]);
  });

  it('does not report a stall across a sleep once resume resets the watchdog', async () => {
    const { resetWatchdog } = await import('./health');
    watchdogTick(1000);
    resetWatchdog(5_000_000); // woke up an hour+ later
    watchdogTick(5_000_000 + WATCHDOG_INTERVAL_MS);
    expect(rt.event).not.toHaveBeenCalled();
  });

  it('ignores normal timer jitter', () => {
    watchdogTick(WATCHDOG_INTERVAL_MS + 50);
    expect(rt.event).not.toHaveBeenCalled();
  });
});
