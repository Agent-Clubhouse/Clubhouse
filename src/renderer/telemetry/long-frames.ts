/**
 * Long-frame telemetry aggregate (spec §4.15). The always-on observer lives in
 * ui-perf.ts (#2126) and hands every long frame to recordLongFrame, which
 * aggregates per active view only while telemetry is on and sends one counter
 * per view per minute plus a sample of durations. Never one IPC per frame.
 *
 * The active view comes from setTelemetryView(). The chrome refresh owns the
 * view values (spec §9.1); until it calls this, everything counts as `other`.
 */
import { ATTR } from '../../shared/telemetry/attributes';
import { isTelemetryEnabled, onTelemetryEnabledChange, tel } from './facade';

export type TelemetryView = Parameters<typeof ATTR.view>[0];
/** Where in the new chrome the user is (`clubhouse.ui.surface`); null in the legacy shell. */
export type TelemetrySurface = Parameters<typeof ATTR.uiSurface>[0];

export const AGGREGATE_INTERVAL_MS = 60_000;
/** Durations sampled per view per interval; the counter still counts every frame. */
export const MAX_DURATION_SAMPLES = 20;

interface Bucket {
  count: number;
  samples: number[];
}

let currentView: TelemetryView = 'other';
let currentSurface: TelemetrySurface | null = null;
/** Keyed by view and surface; at most 8 views x 10 surfaces, well under the 200-set cap. */
const buckets = new Map<string, Bucket & { view: TelemetryView; surface: TelemetrySurface | null }>();
let interval: ReturnType<typeof setInterval> | null = null;

export function setTelemetryView(view: TelemetryView): void {
  currentView = view;
}

export function getTelemetryView(): TelemetryView {
  return currentView;
}

/** Set by the new chrome (docs/chrome-redesign-spec.md §8); the legacy shell leaves it null. */
export function setTelemetrySurface(surface: TelemetrySurface | null): void {
  currentSurface = surface;
}

export function getTelemetrySurface(): TelemetrySurface | null {
  return currentSurface;
}

/** The surface as attributes for signals that carry it beside `clubhouse.view`. */
export function surfaceAttrs(surface: TelemetrySurface | null = currentSurface) {
  return surface ? [ATTR.uiSurface(surface)] : [];
}

/** Record one long frame. Exported for tests. */
export function recordLongFrame(durationMs: number, view: TelemetryView = currentView, surface: TelemetrySurface | null = currentSurface): void {
  if (!isTelemetryEnabled()) return;
  const key = `${view}|${surface ?? ''}`;
  let b = buckets.get(key);
  if (!b) {
    b = { count: 0, samples: [], view, surface };
    buckets.set(key, b);
  }
  b.count++;
  if (b.samples.length < MAX_DURATION_SAMPLES) b.samples.push(durationMs);
}

/** Send and reset the aggregates. Exported for tests. */
export function flushLongFrames(): void {
  for (const b of buckets.values()) {
    if (b.count === 0) continue;
    const attrs = [ATTR.view(b.view), ...surfaceAttrs(b.surface)];
    tel.count('clubhouse.renderer.long_frames', b.count, attrs);
    for (const ms of b.samples) tel.count('clubhouse.renderer.long_frame.duration', ms / 1000, attrs);
  }
  buckets.clear();
}

function startAggregation(): void {
  if (!interval) interval = setInterval(flushLongFrames, AGGREGATE_INTERVAL_MS);
}

function stopAggregation(): void {
  if (interval) clearInterval(interval);
  interval = null;
  buckets.clear();
}

let subscribed: (() => void) | null = null;

/**
 * Aggregate long frames for telemetry only while it's on: the per-minute
 * timer starts on the enabled transition and stops on disable. The observer
 * itself runs regardless, for the local hang log (ui-perf.ts).
 */
export function startLongFrameCollection(): void {
  if (subscribed) return;
  subscribed = onTelemetryEnabledChange((enabled) => (enabled ? startAggregation() : stopAggregation()));
  if (isTelemetryEnabled()) startAggregation();
}

/** True while the per-minute aggregate is running. Exported for tests. */
export function isAggregatingLongFrames(): boolean {
  return interval !== null;
}

/** Test-only reset. */
export function _resetLongFramesForTests(): void {
  stopAggregation();
  subscribed?.();
  subscribed = null;
  currentView = 'other';
  currentSurface = null;
}
