/**
 * The local-only diagnostic tier (spec §6.12, #2299): `diag(ns, level, msg,
 * meta)` writes a `t:"diag"` line to the local telemetry file, for the text
 * that telemetry signals can't carry (error messages, paths, raw ids,
 * stderr).
 *
 * Local only, by construction: this module imports nothing from the facade,
 * the SDK runtime or an exporter, and its only sink is the local recorder
 * (local-control.ts installs it). No export path reads diag lines, whatever
 * EXPORT_WITHOUT_LOCAL_RECORDING says. A feedback report the reporter reviewed
 * is the one exception: it can carry the few fields feedback-diagnostics.ts
 * allowlists, taken through a tap and never the line itself (#2658).
 *
 * Gated by the logging settings: logging `enabled`,
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
 * Sees every diag call, whatever the logging settings, in memory only.
 * Feedback breadcrumbs don't use it: their producers record them directly
 * (#2303), so they don't depend on a log line. It gets the redacted line, like the file
 * does; still, a tap must take structured fields only and never forward
 * `msg` or `meta` wholesale.
 */
export type DiagTap = (record: Readonly<DiagRecord>) => void;
/** Which lines a tap wants, so redaction doesn't run on every line in the app for its sake. */
export type DiagTapFilter = (ns: string, level: DiagLevel) => boolean;

const MAX_SEEN_NAMESPACES = 500;

let redactor: DiagRedactor | null = null;
const taps = new Map<DiagTap, DiagTapFilter | undefined>();
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

/** The logging settings' filters. */
function allowed(ns: string, level: DiagLevel): boolean {
  const settings = logSettings.getSettings();
  if (!settings.enabled) return false;
  if (seenNamespaces.size < MAX_SEEN_NAMESPACES) seenNamespaces.add(ns);
  if (settings.namespaces?.[ns] === false) return false;
  return !(LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[settings.minLogLevel]);
}

function tapWants(wants: DiagTapFilter | undefined, entry: DiagEntry): boolean {
  try {
    return !wants || wants(entry.ns, entry.level);
  } catch {
    return false; // A tap must never break the caller.
  }
}

function record(entry: DiagEntry, window?: DiagRecord['window']): void {
  const target = getDiagSink();
  const write = !!target && allowed(entry.ns, entry.level);
  const tapping = [...taps].filter(([, wants]) => tapWants(wants, entry));
  // Redaction runs only when something will see the line.
  if (!write && tapping.length === 0) return;
  const r = getRedactor();
  const out: DiagRecord = { ns: entry.ns, level: entry.level, msg: r.text(String(entry.msg ?? '')) };
  if (entry.meta && typeof entry.meta === 'object') out.meta = r.meta(entry.meta);
  if (window) out.window = window;
  for (const [tap] of tapping) {
    try {
      tap(out);
    } catch {
      // A tap must never break the caller.
    }
  }
  if (write) target!.writeDiag(out);
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

/**
 * Redact text the way a diag line is redacted, for a caller that must cut it
 * afterwards (a tail of terminal output): cutting first could leave half a
 * secret the patterns no longer recognize.
 */
export function redactDiagText(text: string): string {
  try {
    return getRedactor().text(text);
  } catch {
    return '';
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
export function addDiagTap(tap: DiagTap, wants?: DiagTapFilter): () => void {
  taps.set(tap, wants);
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
