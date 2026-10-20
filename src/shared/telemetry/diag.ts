/**
 * The local-only diagnostic tier (spec §6.12, #2299): `t:"diag"` lines in
 * the local telemetry file. Shared limits and checks, so the renderer and
 * main agree on what a diag call may carry. No runtime dependencies.
 */
import type { LogLevel } from '../types';

export type DiagLevel = LogLevel;

export const DIAG_LEVELS: readonly DiagLevel[] = ['debug', 'info', 'warn', 'error', 'fatal'];
/** `msg` and every string in `meta` are cut to this many characters. */
export const DIAG_MAX_STRING_CHARS = 2000;
/** A line's whole `meta`, as JSON, is cut to this many bytes. */
export const DIAG_MAX_META_BYTES = 8 * 1024;
export const DIAG_MAX_NS_CHARS = 128;

// `core:pty`, `ui:perf`, `canvas`, `plugin:<id>` (ids may carry dots, @ and /).
const NS_RE = /^[\w@][\w.@/-]*(?::[\w.@/-]+)*$/;

export function isDiagNamespace(ns: unknown): ns is string {
  return typeof ns === 'string' && ns.length > 0 && ns.length <= DIAG_MAX_NS_CHARS && NS_RE.test(ns);
}

export function isDiagLevel(level: unknown): level is DiagLevel {
  return typeof level === 'string' && (DIAG_LEVELS as readonly string[]).includes(level);
}
