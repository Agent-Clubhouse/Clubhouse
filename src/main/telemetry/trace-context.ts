/** Fixed-size Annex wire context. No baggage, identities, exporter or SDK dependencies. */
import type { TraceIds } from './types';

export function parseWireTraceparent(value: unknown): TraceIds | undefined {
  if (typeof value !== 'string' || value.length !== 55) return undefined;
  const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(value);
  if (!m || /^0+$/.test(m[1]) || /^0+$/.test(m[2]) || !(parseInt(m[3], 16) & 1)) return undefined;
  return { traceId: m[1], spanId: m[2] };
}

export function wireTraceparent(ids: TraceIds): string {
  return `00-${ids.traceId}-${ids.spanId}-01`;
}

export function validatedTraceparent(value: unknown): string | undefined {
  const ids = parseWireTraceparent(value);
  return ids && wireTraceparent(ids);
}

/** Close a request scope on success, rejection or synchronous throw. Preserve fn's return value. */
export function scoped<T>(fn: () => T, close: () => void): T {
  try {
    const result = fn();
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      void Promise.resolve(result).then(close, close);
    } else close();
    return result;
  } catch (error) { close(); throw error; }
}
