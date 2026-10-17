/**
 * Main-process health (spec §4.15), all sampled once a minute while telemetry
 * is on:
 *
 * - Event-loop delay p99 and max from perf_hooks.monitorEventLoopDelay, as
 *   gauges (App Insights histograms carry no percentiles).
 * - A stall watchdog: a 500 ms interval that notices when it fired more than
 *   2 s late, and names the root flow that was running then. This is how the
 *   synchronous binary lookup (#1926) or a blocking git init would show up.
 * - Working-set memory and CPU summed per Electron process type.
 *
 * Nothing runs while telemetry is off.
 */
import { monitorEventLoopDelay, type IntervalHistogram } from 'perf_hooks';
import { app } from 'electron';
import { ATTR, blockedFlowAttr } from '../../shared/telemetry/attributes';
import { currentFlow, isTelemetryActive, onRuntimeChange, tel } from './facade';

export const SAMPLE_INTERVAL_MS = 60_000;
export const WATCHDOG_INTERVAL_MS = 500;
export const STALL_THRESHOLD_MS = 2000;
/** At most one stall event per window, so a wedged process can't flood. */
export const STALL_EVENT_MIN_GAP_MS = 60_000;

type ProcessType = Parameters<typeof ATTR.processType>[0];

let histogram: IntervalHistogram | null = null;
let sampleTimer: ReturnType<typeof setInterval> | null = null;
let watchdog: ReturnType<typeof setInterval> | null = null;
let lastTick = 0;
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

/** One sampling pass. Exported for tests. */
export function sampleHealth(metrics: Electron.ProcessMetric[] = app.getAppMetrics()): void {
  if (histogram) {
    // Values are nanoseconds; skip an empty window.
    if (histogram.count > 0) {
      tel.count('clubhouse.process.eventloop.delay.p99', histogram.percentile(99) / 1e9);
      tel.count('clubhouse.process.eventloop.delay.max', histogram.max / 1e9);
    }
    histogram.reset();
  }
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

/** Watchdog tick. Exported for tests. */
export function watchdogTick(now = Date.now()): void {
  const late = now - lastTick - WATCHDOG_INTERVAL_MS;
  lastTick = now;
  if (late < STALL_THRESHOLD_MS || now - lastStallEvent < STALL_EVENT_MIN_GAP_MS) return;
  lastStallEvent = now;
  tel.event('clubhouse.process.eventloop_blocked', [blockedFlowAttr(currentFlow() ?? 'none')]);
}

function start(): void {
  if (sampleTimer) return;
  try {
    histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();
  } catch {
    histogram = null;
  }
  sampleTimer = setInterval(() => {
    try {
      sampleHealth();
    } catch {
      // Sampling must never throw into the timer.
    }
  }, SAMPLE_INTERVAL_MS);
  sampleTimer.unref?.();
  lastTick = Date.now();
  watchdog = setInterval(() => watchdogTick(), WATCHDOG_INTERVAL_MS);
  watchdog.unref?.();
}

function stop(): void {
  if (sampleTimer) clearInterval(sampleTimer);
  if (watchdog) clearInterval(watchdog);
  histogram?.disable();
  sampleTimer = null;
  watchdog = null;
  histogram = null;
}

let installed = false;

/** Start sampling whenever telemetry is on, stop when it turns off. */
export function installHealthTelemetry(): void {
  if (installed) return;
  installed = true;
  const sync = (): void => (isTelemetryActive() ? start() : stop());
  onRuntimeChange(sync);
  sync();
}

/** Test-only reset. */
export function _resetHealthForTests(now = Date.now()): void {
  stop();
  installed = false;
  lastTick = now;
  lastStallEvent = Number.NEGATIVE_INFINITY;
}
