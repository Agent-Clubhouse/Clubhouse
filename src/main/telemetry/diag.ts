/**
 * The local-only diagnostic tier (spec §6.12, #2299): `diag(ns, level, msg,
 * meta)` writes a `t:"diag"` line to the local telemetry file, for the text
 * that telemetry signals can't carry (error messages, paths, raw ids,
 * stderr).
 *
 * Local only, by construction: this module imports nothing from the facade,
 * the SDK runtime or an exporter, and its only sink is the local recorder
 * (local-control.ts installs it). No export path reads diag lines, whatever
 * EXPORT_WITHOUT_LOCAL_RECORDING says, and they are never added to feedback
 * reports.
 *
 * Gated exactly like the legacy log (log-service.ts): logging `enabled`,
 * then `namespaces[ns] !== false`, then `minLogLevel`. Independent of
 * `telemetryRecording`, which gates the signal lines only. Every line is
 * redacted (diag-redaction.ts) before it is queued.
 */
import * as os from 'os';
import * as logSettings from '../services/log-settings';
import { LOG_LEVEL_PRIORITY } from '../../shared/types';
import { DIAG_MAX_NS_CHARS, isDiagLevel, type DiagLevel } from '../../shared/telemetry/diag';
import { createDiagRedactor, type DiagRedactor } from './diag-redaction';
import { getDiagSink, _resetDiagSinkForTests, type DiagRecord } from './diag-sink';

export { getDiagSink, onDiagSinkChange, setDiagSink, type DiagRecord, type DiagSink } from './diag-sink';

/** A diag call as made, before gating and redaction. */
export interface DiagEntry {
  ns: string;
  level: DiagLevel;
  msg: string;
  meta?: Record<string, unknown>;
}

/**
 * Sees every diag call, whatever the logging settings, in memory only (the
 * feedback breadcrumb ring, #2303). A tap must take structured fields only
 * and never keep or forward `msg` or `meta` wholesale: they are not redacted.
 */
export type DiagTap = (entry: DiagEntry) => void;

const MAX_SEEN_NAMESPACES = 500;

let redactor: DiagRedactor | null = null;
const taps = new Set<DiagTap>();
const seenNamespaces = new Set<string>();

function getRedactor(): DiagRedactor {
  if (!redactor) {
    let homeDir: string | undefined;
    try {
      homeDir = os.homedir();
    } catch {
      homeDir = undefined;
    }
    redactor = createDiagRedactor({ homeDir });
  }
  return redactor;
}

/** Main-process namespaces are trusted constants; anything odd is made safe rather than dropped. */
function cleanNamespace(ns: unknown): string {
  const s = typeof ns === 'string' ? ns.replace(/[^\w.@/:-]/g, '_').slice(0, DIAG_MAX_NS_CHARS) : '';
  return s || 'unknown';
}

/** The logging settings' filters, exactly as log-service applies them. */
function allowed(ns: string, level: DiagLevel): boolean {
  const settings = logSettings.getSettings();
  if (!settings.enabled) return false;
  if (seenNamespaces.size < MAX_SEEN_NAMESPACES) seenNamespaces.add(ns);
  if (settings.namespaces?.[ns] === false) return false;
  return !(LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[settings.minLogLevel]);
}

function record(entry: DiagEntry, window?: DiagRecord['window']): void {
  for (const tap of taps) {
    try {
      tap(entry);
    } catch {
      // A tap must never break the caller.
    }
  }
  const target = getDiagSink();
  if (!target || !allowed(entry.ns, entry.level)) return;
  const r = getRedactor();
  const out: DiagRecord = { ns: entry.ns, level: entry.level, msg: r.text(String(entry.msg ?? '')) };
  if (entry.meta && typeof entry.meta === 'object') out.meta = r.meta(entry.meta);
  if (window) out.window = window;
  target.writeDiag(out);
}

/**
 * Write a local-only diagnostic line. Never throws, never exported. `msg`
 * and `meta` may carry paths, error text and raw ids; prompts, tool and RPC
 * arguments, env values and secrets are redacted.
 */
export function diag(ns: string, level: DiagLevel, msg: string, meta?: Record<string, unknown>): void {
  try {
    record({ ns: cleanNamespace(ns), level: isDiagLevel(level) ? level : 'info', msg, meta });
  } catch {
    // A logger must never throw.
  }
}

/** A renderer diag item, already validated by renderer-protocol.ts. */
export function diagFromRenderer(entry: DiagEntry, window: 'main' | 'popout'): void {
  try {
    record(entry, window);
  } catch {
    // Never break the IPC handler.
  }
}

/** True while diag lines are recorded (logging on and the recorder running). */
export function isDiagActive(): boolean {
  return getDiagSink() !== null;
}

export function noteDiagDropped(n: number): void {
  try {
    if (n > 0) getDiagSink()?.noteDiagDropped(n);
  } catch {
    // Best effort.
  }
}

/** See DiagTap. Returns an unsubscribe. */
export function addDiagTap(tap: DiagTap): () => void {
  taps.add(tap);
  return () => taps.delete(tap);
}

/** Namespaces diag has seen this run while logging was on, for the settings list. */
export function getDiagNamespaces(): string[] {
  return [...seenNamespaces].sort();
}

/** Test-only reset. */
export function _resetDiagForTests(homeDir?: string): void {
  _resetDiagSinkForTests();
  redactor = homeDir === undefined ? null : createDiagRedactor({ homeDir });
  taps.clear();
  seenNamespaces.clear();
}
