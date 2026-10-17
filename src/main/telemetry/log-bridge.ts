/**
 * The opt-in appLog bridge (spec §6.6). Only appLog calls that pass a
 * `telemetry` field are exported, as the declared event and attributes. The
 * log message and its `meta` never leave the machine: existing meta carries
 * paths, names and error text, so it is never bridged wholesale.
 */
import type { EventName, TelAttr } from '../../shared/telemetry/attributes';
import type { LogLevel } from '../../shared/types';
import { currentTraceIds, tel } from './facade';
import type { EventSeverity } from './types';

export interface LogTelemetry {
  /** A registered event name; it becomes the exported record's body. */
  event: EventName;
  attrs?: TelAttr[];
}

/** spec §6.6 table. `debug` is never exported, even when opted in. */
export const LOG_LEVEL_SEVERITY: Record<LogLevel, EventSeverity | null> = {
  debug: null,
  info: 'info',
  warn: 'warn',
  error: 'error',
  fatal: 'fatal',
};

export function bridgeLog(level: LogLevel, telemetry: LogTelemetry): void {
  const severity = LOG_LEVEL_SEVERITY[level];
  if (!severity) return;
  tel.event(telemetry.event, telemetry.attrs, { severity });
}

/**
 * `traceId` / `spanId` for the local JSONL line while telemetry is on, so a
 * local log line can be matched to a remote trace. Nothing extra is sent.
 */
export function traceFieldsForLog(): { traceId?: string; spanId?: string } {
  const ids = currentTraceIds();
  return ids ? { traceId: ids.traceId, spanId: ids.spanId } : {};
}
