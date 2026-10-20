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
/**
 * Diag bytes per hourly window. Under pressure debug lines go first (past
 * half the budget), then info (past 80 %); warn and above use the rest.
 * Settings → Logging quotes it.
 */
export const DIAG_WINDOW_BYTES = 2 * 1024 * 1024;

// `core:pty`, `ui:perf`, `canvas`, `plugin:<id>` (ids may carry dots, @ and /).
const NS_RE = /^[\w@][\w.@/-]*(?::[\w.@/-]+)*$/;

export function isDiagNamespace(ns: unknown): ns is string {
  return typeof ns === 'string' && ns.length > 0 && ns.length <= DIAG_MAX_NS_CHARS && NS_RE.test(ns);
}

export function isDiagLevel(level: unknown): level is DiagLevel {
  return typeof level === 'string' && (DIAG_LEVELS as readonly string[]).includes(level);
}

const PLUGIN_NS_PREFIX = 'plugin:';
/** `-` and 8 hex characters: the hash that keeps a cut plugin namespace unique. */
const PLUGIN_NS_HASH_CHARS = 9;

/** FNV-1a, 32 bits: no crypto, so the renderer and main get the same value. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * The diag namespace for a plugin's log lines, `plugin:<id>` (#2403). An id
 * too long for the namespace limit is cut and given a hash of the whole id,
 * so its lines are kept, not dropped, and two long ids stay apart.
 */
export function pluginDiagNamespace(pluginId: string): string {
  const ns = PLUGIN_NS_PREFIX + pluginId;
  if (isDiagNamespace(ns)) return ns;
  const safe = pluginId.replace(/[^\w.@/-]/g, '_');
  const keep = DIAG_MAX_NS_CHARS - PLUGIN_NS_PREFIX.length - PLUGIN_NS_HASH_CHARS;
  return `${PLUGIN_NS_PREFIX}${safe.slice(0, keep)}-${fnv1a(pluginId)}`;
}
