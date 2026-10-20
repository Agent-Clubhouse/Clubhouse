/**
 * Main-process health (spec §4.15), all sampled once a minute while telemetry
 * is on:
 *
 * - Event-loop delay p99 and max from perf_hooks.monitorEventLoopDelay, as
 *   gauges (App Insights histograms carry no percentiles). Both are lateness
 *   past the sampling interval, so an idle loop reads about 0.
 * - A stall watchdog: one setTimeout whose lateness is the stall. When it
 *   fires 2 s late, or the histogram saw a stall that long since its last
 *   tick, it names the root flow that was running then.
 *   This is how the synchronous binary lookup (#1926) or a blocking git init
 *   would show up.
 * - Working-set memory and CPU summed per Electron process type.
 *
 * The sampler runs for every install with logging on, so its idle cost
 * matters (#2291). It has two modes:
 *
 * - `active` while a Clubhouse window is focused and the user has touched the
 *   machine in the last few minutes: the fine timing below, so a 200 ms
 *   main-thread stall shows up in the minute's max.
 * - `idle` otherwise (app in the background, user away, screen locked):
 *   coarse timing, about a quarter of the wakeups. Stalls of 1 s or more
 *   still show in the max and 2.5 s or more still raise the event; shorter
 *   ones only when they overlap a histogram tick.
 *
 * Focus, unlock and resume ramp up at once; backing off waits for the next
 * watchdog tick, so switching between two Clubhouse windows doesn't flap.
 * Nothing runs while telemetry is off.
 */
import { monitorEventLoopDelay, performance, type IntervalHistogram } from 'perf_hooks';
import { app, BrowserWindow, powerMonitor } from 'electron';
import { ATTR, blockedFlowAttr } from '../../shared/telemetry/attributes';
import { currentFlow, isTelemetryActive, onRuntimeChange, tel } from './facade';

export const SAMPLE_INTERVAL_MS = 60_000;
export const STALL_THRESHOLD_MS = 2000;
/** At most one stall event per window, so a wedged process can't flood. */
export const STALL_EVENT_MIN_GAP_MS = 60_000;
/** No input for this long counts as away, even with a window focused. */
export const IDLE_AFTER_MS = 5 * 60_000;

export type HealthMode = 'active' | 'idle';

/**
 * Per mode: the event-loop histogram's resolution and the watchdog's period.
 * Measured on Node 24 (#2291): active about 18.5 ms CPU/min, idle about 5.5;
 * before #2291 it was always about 20.
 */
export const MODE_TIMING: Record<HealthMode, { loopDelayResolutionMs: number; watchdogMs: number }> = {
  active: { loopDelayResolutionMs: 100, watchdogMs: 1000 },
  idle: { loopDelayResolutionMs: 500, watchdogMs: 2000 },
};

/** What the mode is decided from. */
export interface HealthSignals {
  /** A Clubhouse window has focus. */
  focused: boolean;
  /** powerMonitor.getSystemIdleState, IDLE_AFTER_MS in seconds; `unknown` when unavailable. */
  system: 'active' | 'idle' | 'locked' | 'unknown';
}

/**
 * The backoff rule. `unknown` (common on Linux/Wayland) counts as present, so
 * focus alone decides there. Exported for tests.
 */
export function nextMode(s: HealthSignals): HealthMode {
  return s.focused && (s.system === 'active' || s.system === 'unknown') ? 'active' : 'idle';
}

function readSignals(): HealthSignals {
  let focused = false;
  try {
    focused = BrowserWindow.getFocusedWindow() != null;
  } catch {
    // No windows API (tests, or before app ready).
  }
  // The idle query only matters with a window focused.
  if (!focused) return { focused, system: 'unknown' };
  let system: HealthSignals['system'] = 'unknown';
  try {
    system = powerMonitor.getSystemIdleState(IDLE_AFTER_MS / 1000);
  } catch {
    // powerMonitor is unavailable before app ready in some test setups.
  }
  return { focused, system };
}

let signalSource: () => HealthSignals = readSignals;

type ProcessType = Parameters<typeof ATTR.processType>[0];

let running = false;
let mode: HealthMode = 'idle';
let histogram: IntervalHistogram | null = null;
let histogramResolutionMs = 0;
/** The minute's p99 and max lateness (ns), across mode switches. */
let foldedP99 = 0;
let foldedMax = 0;
let folded = false;
/** Histogram max (ns) the watchdog has already looked at, and lateness (ms) it hasn't. */
let seenLoopMax = 0;
let unseenLoopLateMs = 0;
let sampleTimer: ReturnType<typeof setInterval> | null = null;
let watchdog: ReturnType<typeof setTimeout> | null = null;
/** When the watchdog is due; its lateness is the stall. */
let due = 0;
let lastStallEvent = Number.NEGATIVE_INFINITY;

export function processTypeOf(electronType: string): ProcessType {
  switch (electronType) {
    case 'Browser':
      return 'browser';
    case 'Tab':
      return 'renderer';
    case 'GPU':
      return 'gpu';
    case 'Utility':
      return 'utility';
    default:
      return 'other';
  }
}

/**
 * Fold the histogram's window into the minute's numbers and reset it. Node
 * records each whole timer interval, so an idle loop reads as the resolution
 * itself; subtracting it leaves the lateness, which reads the same in either
 * mode.
 */
function foldHistogram(): void {
  if (!histogram) return;
  noteLoopLateness();
  seenLoopMax = 0;
  // Values are nanoseconds; skip an empty window.
  if (histogram.count > 0) {
    const resolution = histogramResolutionMs * 1e6;
    // The p99 across a mode switch is the larger segment's p99: an upper bound.
    foldedP99 = Math.max(foldedP99, histogram.percentile(99) - resolution);
    foldedMax = Math.max(foldedMax, histogram.max - resolution);
    folded = true;
  }
  histogram.reset();
}

/**
 * Pick up a new histogram max for the watchdog before anything resets it.
 * Only a new max counts, so a stall shorter than one already seen this
 * minute is left to the watchdog's own lateness.
 */
function noteLoopLateness(): void {
  if (!histogram || histogram.count === 0 || histogram.max <= seenLoopMax) return;
  seenLoopMax = histogram.max;
  unseenLoopLateMs = Math.max(unseenLoopLateMs, (histogram.max - histogramResolutionMs * 1e6) / 1e6);
}

function openHistogram(): void {
  histogramResolutionMs = MODE_TIMING[mode].loopDelayResolutionMs;
  try {
    histogram = monitorEventLoopDelay({ resolution: histogramResolutionMs });
    histogram.enable();
  } catch {
    histogram = null;
  }
}

function closeHistogram(): void {
  foldHistogram();
  histogram?.disable();
  histogram = null;
}

/** One sampling pass. Exported for tests. */
export function sampleHealth(metrics: Electron.ProcessMetric[] = app.getAppMetrics()): void {
  foldHistogram();
  if (folded) {
    tel.count('clubhouse.process.eventloop.delay.p99', Math.max(0, foldedP99) / 1e9);
    tel.count('clubhouse.process.eventloop.delay.max', Math.max(0, foldedMax) / 1e9);
  }
  foldedP99 = 0;
  foldedMax = 0;
  folded = false;
  const memory = new Map<ProcessType, number>();
  const cpu = new Map<ProcessType, number>();
  for (const m of metrics) {
    const type = processTypeOf(m.type);
    memory.set(type, (memory.get(type) ?? 0) + (m.memory?.workingSetSize ?? 0) * 1024);
    cpu.set(type, (cpu.get(type) ?? 0) + (m.cpu?.percentCPUUsage ?? 0));
  }
  for (const [type, bytes] of memory) tel.count('clubhouse.process.memory', bytes, [ATTR.processType(type)]);
  for (const [type, pct] of cpu) tel.count('clubhouse.process.cpu', pct, [ATTR.processType(type)]);
}

/**
 * Watchdog check: how late the timer fired is how long the main thread was
 * blocked. In idle mode the timer is slow, so a stall that ended before it
 * was due is taken from the histogram instead, which ticks more often: a
 * 2.5 s stall is caught either way. Uses a monotonic clock so wall-clock
 * jumps don't look like stalls; resetWatchdog() is also called on system
 * resume, since some platforms' monotonic clocks keep counting through sleep.
 * Exported for tests.
 */
export function watchdogTick(now = performance.now()): void {
  noteLoopLateness();
  const late = Math.max(now - due, unseenLoopLateMs);
  unseenLoopLateMs = 0;
  if (late < STALL_THRESHOLD_MS || now - lastStallEvent < STALL_EVENT_MIN_GAP_MS) return;
  lastStallEvent = now;
  tel.event('clubhouse.process.eventloop_blocked', [blockedFlowAttr(currentFlow() ?? 'none')]);
}

/**
 * Forget the last due time and any lateness already in the histogram, e.g.
 * after the machine slept.
 */
export function resetWatchdog(now = performance.now()): void {
  due = now + MODE_TIMING[mode].watchdogMs;
  unseenLoopLateMs = 0;
  if (histogram && histogram.count > 0) seenLoopMax = Math.max(seenLoopMax, histogram.max);
}

function armWatchdog(): void {
  if (watchdog) clearTimeout(watchdog);
  due = performance.now() + MODE_TIMING[mode].watchdogMs;
  watchdog = setTimeout(onWatchdog, MODE_TIMING[mode].watchdogMs);
  watchdog.unref?.();
}

function onWatchdog(): void {
  watchdog = null;
  try {
    watchdogTick();
  } catch {
    // The watchdog must never throw into the timer.
  }
  try {
    setMode(nextMode(signalSource()), false);
  } catch {
    // Nor the mode check.
  }
  if (running && !watchdog) armWatchdog();
}

/**
 * Switch timing. A switch retires the histogram (its window is folded into
 * the minute's numbers) and re-arms the watchdog at the new period, unless
 * `rearm` is false because the caller is about to.
 */
function setMode(next: HealthMode, rearm = true): void {
  if (!running || next === mode) return;
  closeHistogram();
  mode = next;
  openHistogram();
  if (rearm) armWatchdog();
}

/**
 * Ramp up now if the signals say so (focus, unlock, resume). The switch
 * cancels the pending watchdog and retires the histogram, so first take what
 * they would have seen: a focus event can run right after a stall, before
 * the overdue timers do (a click on a hung window).
 */
function rampUp(): void {
  if (!running || mode === 'active' || nextMode(signalSource()) !== 'active') return;
  const now = performance.now();
  const late = now - due;
  if (late > 0) {
    foldedMax = Math.max(foldedMax, late * 1e6);
    folded = true;
  }
  watchdogTick(now);
  setMode('active');
}

/**
 * After sleep: forget the watchdog's due time and start a fresh histogram.
 * Where the monotonic clock counts through sleep, the histogram's next tick
 * would record the whole gap; a new histogram has no previous tick to measure
 * from. The minute's samples before the sleep are dropped with it.
 */
function awake(): void {
  resetWatchdog();
  if (running) {
    histogram?.disable();
    seenLoopMax = 0;
    openHistogram();
  }
  rampUp();
}

/** Current mode, for tests. */
export function healthMode(): HealthMode {
  return mode;
}

function start(): void {
  if (running) return;
  running = true;
  mode = nextMode(signalSource());
  openHistogram();
  sampleTimer = setInterval(() => {
    try {
      sampleHealth();
    } catch {
      // Sampling must never throw into the timer.
    }
  }, SAMPLE_INTERVAL_MS);
  sampleTimer.unref?.();
  armWatchdog();
}

function stop(): void {
  running = false;
  if (sampleTimer) clearInterval(sampleTimer);
  if (watchdog) clearTimeout(watchdog);
  histogram?.disable();
  sampleTimer = null;
  watchdog = null;
  histogram = null;
  foldedP99 = 0;
  foldedMax = 0;
  folded = false;
  seenLoopMax = 0;
  unseenLoopLateMs = 0;
}

let installed = false;
let unsubscribeRuntime: (() => void) | null = null;

/**
 * Sample while telemetry is active, which is local recording (spec §6.12):
 * export on or off never starts or stops it, and never changes the mode.
 */
export function installHealthTelemetry(): void {
  if (installed) return;
  installed = true;
  const sync = (): void => (isTelemetryActive() ? start() : stop());
  unsubscribeRuntime = onRuntimeChange(sync);
  sync();
  try {
    // A sleeping laptop isn't a stalled main thread.
    powerMonitor.on('resume', awake);
    powerMonitor.on('unlock-screen', awake);
  } catch {
    // powerMonitor is unavailable before app ready in some test setups.
  }
  try {
    app.on('browser-window-focus', rampUp);
  } catch {
    // No app events in some test setups.
  }
}

/** Test-only: replace where the mode signals come from (null restores Electron). */
export function _setHealthSignalsForTests(source: (() => HealthSignals) | null): void {
  signalSource = source ?? readSignals;
}

/** Test-only reset. */
export function _resetHealthForTests(now = performance.now()): void {
  stop();
  unsubscribeRuntime?.();
  unsubscribeRuntime = null;
  installed = false;
  mode = 'idle';
  signalSource = readSignals;
  due = now + MODE_TIMING[mode].watchdogMs;
  lastStallEvent = Number.NEGATIVE_INFINITY;
}
