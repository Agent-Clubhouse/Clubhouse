/**
 * Where the Framebriar telemetry destination gets its URL, token and session
 * (spec §6.11). The Feedback service registers a source when it starts, so
 * telemetry never imports Feedback: with Feedback off there is no source and
 * the destination reports itself unconfigured. Tokens never leave main and
 * are fetched at export time.
 */
import type { TelemetrySignal } from './types';

export interface FramebriarTelemetryExport {
  /** The Framebriar endpoint's host, for consent. */
  host: string;
  /** Per-signal OTLP URL plus an async header factory carrying the current enrolled token. */
  options: (signal: TelemetrySignal) => { url: string; headers: () => Promise<Record<string, string>> };
  /** Feedback's session id: set as `session.id` so reports and telemetry correlate. */
  sessionId: string;
}

/** Returns the export config while Feedback is connected, else null. */
export type FramebriarTelemetrySource = () => FramebriarTelemetryExport | null;

let source: FramebriarTelemetrySource | null = null;
const listeners = new Set<() => void>();

export function setFramebriarTelemetrySource(next: FramebriarTelemetrySource | null): void {
  source = next;
}

export function getFramebriarTelemetrySource(): FramebriarTelemetrySource | null {
  return source;
}

/** Feedback's connection changed: telemetry re-checks the Framebriar destination. */
export function notifyFramebriarConnectionChanged(): void {
  for (const fn of listeners) {
    try { fn(); } catch { /* telemetry-exempt: a listener can't affect Feedback */ }
  }
}

export function onFramebriarConnectionChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
