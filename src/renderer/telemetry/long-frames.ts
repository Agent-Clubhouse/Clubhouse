/**
 * Long-frame collection (spec §4.15). Uses the Chromium
 * `long-animation-frame` entry type (falls back to `longtask`), aggregates per
 * active view, and sends one counter per view per minute plus a sample of
 * durations. Never one IPC per frame.
 *
 * The active view comes from setTelemetryView(). The chrome refresh owns the
 * view values (spec §9.1); until it calls this, everything counts as `other`.
 */
import { ATTR } from '../../shared/telemetry/attributes';
import { isTelemetryEnabled, tel } from './facade';

export type TelemetryView = Parameters<typeof ATTR.view>[0];

export const AGGREGATE_INTERVAL_MS = 60_000;
/** Durations sampled per view per interval; the counter still counts every frame. */
export const MAX_DURATION_SAMPLES = 20;

interface Bucket {
  count: number;
  samples: number[];
}

let currentView: TelemetryView = 'other';
const buckets = new Map<TelemetryView, Bucket>();
let observer: PerformanceObserver | null = null;
let interval: ReturnType<typeof setInterval> | null = null;

export function setTelemetryView(view: TelemetryView): void {
  currentView = view;
}

export function getTelemetryView(): TelemetryView {
  return currentView;
}

/** Record one long frame. Exported for tests. */
export function recordLongFrame(durationMs: number, view: TelemetryView = currentView): void {
  if (!isTelemetryEnabled()) return;
  let b = buckets.get(view);
  if (!b) {
    b = { count: 0, samples: [] };
    buckets.set(view, b);
  }
  b.count++;
  if (b.samples.length < MAX_DURATION_SAMPLES) b.samples.push(durationMs);
}

/** Send and reset the aggregates. Exported for tests. */
export function flushLongFrames(): void {
  for (const [view, b] of buckets) {
    if (b.count === 0) continue;
    tel.count('clubhouse.renderer.long_frames', b.count, [ATTR.view(view)]);
    for (const ms of b.samples) tel.count('clubhouse.renderer.long_frame.duration', ms / 1000, [ATTR.view(view)]);
  }
  buckets.clear();
}

export function startLongFrameCollection(): void {
  if (observer || typeof PerformanceObserver === 'undefined') return;
  const supported = PerformanceObserver.supportedEntryTypes ?? [];
  const type = supported.includes('long-animation-frame') ? 'long-animation-frame' : supported.includes('longtask') ? 'longtask' : null;
  if (!type) return;
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) recordLongFrame(entry.duration);
    });
    observer.observe({ type, buffered: false });
    interval = setInterval(flushLongFrames, AGGREGATE_INTERVAL_MS);
  } catch {
    observer = null;
  }
}

/** Test-only reset. */
export function _resetLongFramesForTests(): void {
  observer?.disconnect();
  observer = null;
  if (interval) clearInterval(interval);
  interval = null;
  buckets.clear();
  currentView = 'other';
}
