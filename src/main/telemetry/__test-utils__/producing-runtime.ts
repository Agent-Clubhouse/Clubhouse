/**
 * Test helper: install a fake SDK runtime the way producers now see it
 * (spec §6.12 parity). Producers follow local recording, so a pass-through
 * local sink at the runtime's level is installed with it; the runtime still
 * receives every call. `null` turns both off.
 */
import { setLocalSink, setRuntime } from '../facade';
import type { LocalTelemetrySink, TelemetryRuntime } from '../types';

export function passThroughSink(level: LocalTelemetrySink['level'] = 'standard'): LocalTelemetrySink {
  return {
    level,
    wrap: (_name, _opts, fn) => fn,
    count: () => {},
    event: () => {},
    exception: () => {},
    replaySpan: () => {},
    replayTree: () => {},
    activeTraceIds: () => undefined,
    flush: async () => {},
  };
}

export function setProducingRuntime(rt: TelemetryRuntime | null): void {
  if (rt) {
    setLocalSink(passThroughSink(rt.level));
    setRuntime(rt);
  } else {
    setRuntime(null);
    setLocalSink(null);
  }
}
