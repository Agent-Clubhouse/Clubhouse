/**
 * Holder for the diag tier's one sink, the local recorder (#2299). Kept apart
 * from diag.ts so the facade can flush it at exit without importing the
 * logging settings. Nothing here can reach an exporter.
 */
import type { DiagLevel } from '../../shared/telemetry/diag';

/** A redacted diag line, ready to be written. */
export interface DiagRecord {
  ns: string;
  level: DiagLevel;
  msg: string;
  meta?: Record<string, unknown>;
  /** Set for renderer lines: the sending window's kind, decided by main. */
  window?: 'main' | 'popout';
}

/** Where diag lines go: the local recorder, never anything that exports. */
export interface DiagSink {
  writeDiag(record: DiagRecord): void;
  /** Count diag lines dropped before they reached the sink (renderer rate limit). */
  noteDiagDropped(n: number): void;
  flush(): Promise<void>;
  /** Write pending lines now, synchronously (an OS session end). */
  flushSync?(): void;
}

let sink: DiagSink | null = null;
const listeners = new Set<() => void>();

/** Install or remove the diag sink (local-control.ts). */
export function setDiagSink(next: DiagSink | null): void {
  if (next === sink) return;
  sink = next;
  for (const l of listeners) {
    try {
      l();
    } catch {
      // Listeners must not break the switch.
    }
  }
}

export function getDiagSink(): DiagSink | null {
  return sink;
}

/** Called whenever diag recording starts or stops. Returns an unsubscribe. */
export function onDiagSinkChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test-only reset. */
export function _resetDiagSinkForTests(): void {
  sink = null;
  listeners.clear();
}
