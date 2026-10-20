import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => {
  const handlers: Record<string, () => void> = {};
  const on = (event: string, fn: () => void) => void (handlers[event] = fn);
  return {
    handlers,
    getFocusedWindow: vi.fn((): unknown => null),
    getSystemIdleState: vi.fn((_threshold: number) => 'active'),
    app: { getAppMetrics: () => [], on },
    powerMonitor: { on },
  };
});
vi.mock('electron', () => ({
  app: electron.app,
  powerMonitor: { ...electron.powerMonitor, getSystemIdleState: electron.getSystemIdleState },
  BrowserWindow: { getFocusedWindow: electron.getFocusedWindow },
}));
const eld = vi.hoisted(() => ({ resolutions: [] as number[], fake: null as unknown }));
vi.mock('perf_hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('perf_hooks')>();
  return {
    ...actual,
    monitorEventLoopDelay: (opts: { resolution: number }) => {
      eld.resolutions.push(opts.resolution);
      return eld.fake ?? actual.monitorEventLoopDelay(opts);
    },
  };
});

import { ATTR, blockedFlowAttr } from '../../shared/telemetry/attributes';
import { tel } from './facade';
import { setProducingRuntime } from './__test-utils__/producing-runtime';
import {
  IDLE_AFTER_MS,
  MODE_TIMING,
  STALL_EVENT_MIN_GAP_MS,
  _resetHealthForTests,
  _setHealthSignalsForTests,
  healthMode,
  installHealthTelemetry,
  nextMode,
  processTypeOf,
  resetWatchdog,
  sampleHealth,
  watchdogTick,
  type HealthSignals,
} from './health';
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

const IDLE_MS = MODE_TIMING.idle.watchdogMs;
const ACTIVE_MS = MODE_TIMING.active.watchdogMs;

let rt: TelemetryRuntime;
beforeEach(() => {
  eld.resolutions.length = 0;
  eld.fake = null;
  for (const k of Object.keys(electron.handlers)) delete electron.handlers[k];
  electron.getFocusedWindow.mockReset().mockReturnValue(null);
  electron.getSystemIdleState.mockReset().mockReturnValue('active');
  rt = fakeRuntime();
  setProducingRuntime(rt);
  _resetHealthForTests(0);
});
afterEach(() => {
  _resetHealthForTests();
  setProducingRuntime(null);
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
    watchdogTick(IDLE_MS + 3000); // fired 3 s late
    expect(rt.event).toHaveBeenCalledWith('clubhouse.process.eventloop_blocked', [blockedFlowAttr('clubhouse.update.check')]);
    resetWatchdog(IDLE_MS + 3000);
    watchdogTick(IDLE_MS * 2 + 6500);
    expect(rt.event).toHaveBeenCalledTimes(1);
    release();
    await pending;
    watchdogTick(STALL_EVENT_MIN_GAP_MS * 3);
    expect(rt.event).toHaveBeenLastCalledWith('clubhouse.process.eventloop_blocked', [blockedFlowAttr('none')]);
  });

  it('does not report a stall across a sleep once resume resets the watchdog', () => {
    watchdogTick(IDLE_MS);
    resetWatchdog(5_000_000); // woke up an hour+ later
    watchdogTick(5_000_000 + IDLE_MS);
    expect(rt.event).not.toHaveBeenCalled();
  });

  it('ignores normal timer jitter', () => {
    watchdogTick(IDLE_MS + 50);
    expect(rt.event).not.toHaveBeenCalled();
  });
});

const ACTIVE: HealthSignals = { focused: true, system: 'active' };
const AWAY: HealthSignals = { focused: false, system: 'unknown' };

/** Busy-wait: an injected synchronous main-thread block. */
function block(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // spin
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The minute's reported max event-loop delay, in ms. */
function reportedMaxMs(): number | undefined {
  vi.mocked(rt.count).mockClear();
  sampleHealth([]);
  const max = gauge('clubhouse.process.eventloop.delay.max');
  return max === undefined ? undefined : max * 1000;
}

describe('backoff state machine', () => {
  let signals: HealthSignals;
  let reads: number;
  beforeEach(() => {
    vi.useFakeTimers();
    signals = AWAY;
    reads = 0;
    _setHealthSignalsForTests(() => {
      reads++;
      return signals;
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is active only with a window focused and the user present', () => {
    expect(nextMode({ focused: true, system: 'active' })).toBe('active');
    expect(nextMode({ focused: true, system: 'unknown' })).toBe('active');
    expect(nextMode({ focused: true, system: 'idle' })).toBe('idle');
    expect(nextMode({ focused: true, system: 'locked' })).toBe('idle');
    expect(nextMode({ focused: false, system: 'active' })).toBe('idle');
    expect(nextMode({ focused: false, system: 'unknown' })).toBe('idle');
  });

  it('starts idle with no focused window: coarse histogram and a slow watchdog', async () => {
    installHealthTelemetry();
    expect(healthMode()).toBe('idle');
    expect(eld.resolutions).toEqual([MODE_TIMING.idle.loopDelayResolutionMs]);
    reads = 0;
    await vi.advanceTimersByTimeAsync(IDLE_MS * 5);
    expect(reads).toBe(5); // one watchdog tick per idle period
  });

  it('starts active when a window is focused and the user is present', () => {
    signals = ACTIVE;
    installHealthTelemetry();
    expect(healthMode()).toBe('active');
    expect(eld.resolutions).toEqual([MODE_TIMING.active.loopDelayResolutionMs]);
  });

  it('ramps up at once on window focus, then ticks at the active period', async () => {
    installHealthTelemetry();
    signals = ACTIVE;
    electron.handlers['browser-window-focus']();
    expect(healthMode()).toBe('active');
    expect(eld.resolutions).toEqual([MODE_TIMING.idle.loopDelayResolutionMs, MODE_TIMING.active.loopDelayResolutionMs]);
    reads = 0;
    await vi.advanceTimersByTimeAsync(ACTIVE_MS * 4);
    expect(reads).toBe(4);
  });

  it('ramps up on unlock and on resume', () => {
    installHealthTelemetry();
    signals = ACTIVE;
    electron.handlers['unlock-screen']();
    expect(healthMode()).toBe('active');

    signals = AWAY;
    _resetHealthForTests();
    _setHealthSignalsForTests(() => signals);
    installHealthTelemetry();
    signals = ACTIVE;
    electron.handlers['resume']();
    expect(healthMode()).toBe('active');
  });

  it('ignores a focus event that leaves the user away', () => {
    installHealthTelemetry();
    signals = { focused: true, system: 'locked' };
    electron.handlers['browser-window-focus']();
    expect(healthMode()).toBe('idle');
    expect(eld.resolutions).toHaveLength(1);
  });

  it('backs off on the next watchdog tick, not on blur, so window switches do not flap', async () => {
    signals = ACTIVE;
    installHealthTelemetry();
    signals = AWAY; // blurred
    await vi.advanceTimersByTimeAsync(ACTIVE_MS - 1);
    expect(healthMode()).toBe('active');
    signals = ACTIVE; // focus moved to another Clubhouse window in between
    await vi.advanceTimersByTimeAsync(1);
    expect(healthMode()).toBe('active');
    expect(eld.resolutions).toHaveLength(1);

    signals = { focused: true, system: 'idle' }; // user walked away
    await vi.advanceTimersByTimeAsync(ACTIVE_MS);
    expect(healthMode()).toBe('idle');
    expect(eld.resolutions).toEqual([MODE_TIMING.active.loopDelayResolutionMs, MODE_TIMING.idle.loopDelayResolutionMs]);
    reads = 0;
    await vi.advanceTimersByTimeAsync(IDLE_MS * 3);
    expect(reads).toBe(3);
  });

  it('keeps sampling once a minute in either mode', async () => {
    const metrics = vi.spyOn(electron.app, 'getAppMetrics');
    installHealthTelemetry();
    await vi.advanceTimersByTimeAsync(60_000 * 2);
    signals = ACTIVE;
    electron.handlers['browser-window-focus']();
    await vi.advanceTimersByTimeAsync(60_000 * 2);
    expect(metrics).toHaveBeenCalledTimes(4);
  });

  it('stops every timer when telemetry turns off, and focus does not restart it', async () => {
    installHealthTelemetry();
    setProducingRuntime(null);
    reads = 0;
    signals = ACTIVE;
    electron.handlers['browser-window-focus']();
    await vi.advanceTimersByTimeAsync(IDLE_MS * 5);
    expect(reads).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps its mode and timers when export turns on or off (parity)', async () => {
    signals = ACTIVE;
    installHealthTelemetry();
    const { setRuntime } = await import('./facade');
    setRuntime(null); // export off, local recording still on
    expect(healthMode()).toBe('active');
    setRuntime(rt);
    expect(healthMode()).toBe('active');
    expect(eld.resolutions).toHaveLength(1);
    reads = 0;
    await vi.advanceTimersByTimeAsync(ACTIVE_MS * 4);
    expect(reads).toBe(4);
  });

  it('reads focus and the system idle state from Electron by default', () => {
    _setHealthSignalsForTests(null);
    installHealthTelemetry();
    expect(healthMode()).toBe('idle');
    expect(electron.getSystemIdleState).not.toHaveBeenCalled(); // not needed without focus

    electron.getFocusedWindow.mockReturnValue({});
    electron.handlers['browser-window-focus']();
    expect(electron.getSystemIdleState).toHaveBeenCalledWith(IDLE_AFTER_MS / 1000);
    expect(healthMode()).toBe('active');
  });
});

function gauge(name: string): number | undefined {
  return vi.mocked(rt.count).mock.calls.find(([n]) => n === name)?.[1] as number | undefined;
}

describe('event-loop delay gauges', () => {
  it('report lateness past the resolution, so an idle loop reads 0 in either mode', () => {
    const ms = 1e6;
    let p99 = 0;
    let max = 0;
    eld.fake = {
      enable: vi.fn(),
      disable: vi.fn(),
      reset: vi.fn(),
      get count() {
        return 5;
      },
      percentile: () => p99,
      get max() {
        return max;
      },
    };
    _setHealthSignalsForTests(() => ACTIVE);
    installHealthTelemetry();
    [p99, max] = [100.4 * ms, 101 * ms]; // an idle loop at 100 ms resolution
    sampleHealth([]);
    expect(gauge('clubhouse.process.eventloop.delay.p99')).toBeCloseTo(0.0004, 6);
    expect(gauge('clubhouse.process.eventloop.delay.max')).toBeCloseTo(0.001, 6);

    [p99, max] = [120 * ms, 400 * ms];
    vi.mocked(rt.count).mockClear();
    sampleHealth([]);
    expect(gauge('clubhouse.process.eventloop.delay.p99')).toBeCloseTo(0.02, 6);
    expect(gauge('clubhouse.process.eventloop.delay.max')).toBeCloseTo(0.3, 6);
  });

  it('report nothing for a minute with no histogram samples', () => {
    eld.fake = { enable: vi.fn(), disable: vi.fn(), reset: vi.fn(), count: 0, percentile: () => 0, max: 0 };
    installHealthTelemetry();
    sampleHealth([]);
    expect(gauge('clubhouse.process.eventloop.delay.max')).toBeUndefined();
  });
});

describe('stall event from the histogram', () => {
  function fakeHistogram() {
    const h = { count: 0, max: 0, enable: vi.fn(), disable: vi.fn(), reset: vi.fn(), percentile: () => h.max };
    eld.fake = h;
    return h;
  }
  const IDLE_RES_NS = MODE_TIMING.idle.loopDelayResolutionMs * 1e6;

  it('flags a stall that ended before the slow idle watchdog was due', () => {
    const h = fakeHistogram();
    _setHealthSignalsForTests(() => AWAY);
    installHealthTelemetry();
    resetWatchdog(0);
    Object.assign(h, { count: 4, max: IDLE_RES_NS + 2500e6 }); // a histogram tick fired 2.5 s late
    watchdogTick(IDLE_MS + 10); // the watchdog itself was on time
    expect(rt.event).toHaveBeenCalledWith('clubhouse.process.eventloop_blocked', [blockedFlowAttr('none')]);
  });

  it('counts each histogram max once', () => {
    const h = fakeHistogram();
    _setHealthSignalsForTests(() => AWAY);
    installHealthTelemetry();
    resetWatchdog(0);
    Object.assign(h, { count: 4, max: IDLE_RES_NS + 2500e6 });
    watchdogTick(IDLE_MS);
    resetWatchdog(STALL_EVENT_MIN_GAP_MS * 2);
    watchdogTick(STALL_EVENT_MIN_GAP_MS * 2 + IDLE_MS);
    expect(rt.event).toHaveBeenCalledTimes(1);
  });

  it('ignores lateness the histogram recorded across a sleep', () => {
    const h = fakeHistogram();
    _setHealthSignalsForTests(() => AWAY);
    installHealthTelemetry();
    Object.assign(h, { count: 4, max: IDLE_RES_NS + 3_600_000e6 }); // the laptop slept an hour
    resetWatchdog(0); // resume
    watchdogTick(IDLE_MS);
    expect(rt.event).not.toHaveBeenCalled();
  });

  it('ignores a histogram below the threshold', () => {
    const h = fakeHistogram();
    _setHealthSignalsForTests(() => AWAY);
    installHealthTelemetry();
    resetWatchdog(0);
    Object.assign(h, { count: 4, max: IDLE_RES_NS + 1500e6 });
    watchdogTick(IDLE_MS);
    expect(rt.event).not.toHaveBeenCalled();
  });
});

describe('stall detection on a real event loop', () => {
  it('reports an injected 250 ms main-thread block while active', async () => {
    _setHealthSignalsForTests(() => ACTIVE);
    installHealthTelemetry();
    await sleep(250); // Node skips the first histogram interval after a reset
    block(250);
    await sleep(250);
    // A block of B ms always spans a histogram tick at this resolution, which
    // then fires at least B minus the resolution late.
    expect(reportedMaxMs()).toBeGreaterThanOrEqual(250 - MODE_TIMING.active.loopDelayResolutionMs);
  });

  it('reports a block at least as long as the idle resolution while idle', async () => {
    _setHealthSignalsForTests(() => AWAY);
    installHealthTelemetry();
    expect(healthMode()).toBe('idle');
    await sleep(MODE_TIMING.idle.loopDelayResolutionMs * 2 + 100); // past the skipped first interval
    block(800);
    await sleep(MODE_TIMING.idle.loopDelayResolutionMs + 100);
    expect(reportedMaxMs()).toBeGreaterThanOrEqual(800 - MODE_TIMING.idle.loopDelayResolutionMs);
  });

  it('keeps a stall measured before a mode switch in the minute', async () => {
    let signals = ACTIVE;
    _setHealthSignalsForTests(() => signals);
    installHealthTelemetry();
    await sleep(250);
    block(250);
    await sleep(150);
    signals = AWAY;
    await sleep(MODE_TIMING.active.watchdogMs + 100); // the watchdog backs off
    expect(healthMode()).toBe('idle');
    expect(reportedMaxMs()).toBeGreaterThanOrEqual(150);
  });

  it('flags a 2.5 s block while idle, whatever the watchdog phase', { timeout: 15_000 }, async () => {
    _setHealthSignalsForTests(() => AWAY);
    installHealthTelemetry();
    await sleep(MODE_TIMING.idle.loopDelayResolutionMs * 2 + 100);
    block(2500);
    await sleep(MODE_TIMING.idle.watchdogMs * 2);
    expect(rt.event).toHaveBeenCalledWith('clubhouse.process.eventloop_blocked', [blockedFlowAttr('none')]);
  });

  it('keeps a stall when a click on the hung window focuses it before the timers run', { timeout: 15_000 }, async () => {
    let signals = AWAY;
    _setHealthSignalsForTests(() => signals);
    installHealthTelemetry();
    await sleep(IDLE_MS - 200);
    block(2600);
    signals = ACTIVE;
    electron.handlers['browser-window-focus'](); // runs before the overdue watchdog and histogram ticks
    expect(healthMode()).toBe('active');
    expect(rt.event).toHaveBeenCalledWith('clubhouse.process.eventloop_blocked', [blockedFlowAttr('none')]);
    expect(reportedMaxMs()).toBeGreaterThanOrEqual(2000);
  });
});

describe('resume', () => {
  it('opens a fresh histogram so the sleep gap is never measured', () => {
    installHealthTelemetry();
    electron.handlers['resume']();
    expect(eld.resolutions).toEqual([MODE_TIMING.idle.loopDelayResolutionMs, MODE_TIMING.idle.loopDelayResolutionMs]);
    expect(healthMode()).toBe('idle');
  });
});
