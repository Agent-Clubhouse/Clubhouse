/**
 * For tests: turn telemetry on with a fake runtime that keeps every event it
 * is handed (and the local sink producers follow), so a test can read back
 * what was emitted. `stop()` turns telemetry off again.
 */
import { vi } from 'vitest';
import type { TelemetryLevel } from '../../../shared/telemetry/attributes';
import type { TelemetryRuntime } from '../types';
import { setProducingRuntime } from './producing-runtime';

export interface CapturedEvent {
  name: string;
  attrs: Record<string, string | number | boolean>;
  kinds: Record<string, string>;
}

export interface EventCapture {
  events: CapturedEvent[];
  named(name: string): CapturedEvent[];
  stop(): void;
}

export function captureEvents(level: TelemetryLevel = 'standard'): EventCapture {
  const events: CapturedEvent[] = [];
  const runtime = {
    level,
    event: (name: string, attrs: Array<{ key: string; kind: string; value: string | number | boolean }> = []) =>
      events.push({
        name,
        attrs: Object.fromEntries(attrs.map((a) => [a.key, a.value])),
        kinds: Object.fromEntries(attrs.map((a) => [a.key, a.kind])),
      }),
    flow: vi.fn(), step: vi.fn(), count: vi.fn(), exception: vi.fn(), replaySpan: vi.fn(), replayTree: vi.fn(),
    preview: (): unknown[] => [], recentExports: (): unknown[] => [], forceFlush: async () => {}, shutdown: async () => {},
  } as unknown as TelemetryRuntime;
  setProducingRuntime(runtime);
  return {
    events,
    named: (name) => events.filter((e) => e.name === name),
    stop: () => setProducingRuntime(null),
  };
}
