/**
 * Frozen API snapshot for plugin API v0.4.
 *
 * DO NOT MODIFY these interfaces — they are the compile-time contract for
 * plugins targeting engine.api: 0.4.
 *
 * v0.4 is a superset of v0.2, adding:
 *   - `logging` sub-API (debug/info/warn/error/fatal)
 *   - Manifest-level: `contributes.help` is mandatory for v0.4+
 */

import type { PluginAPI } from '../plugin-types';
import type { PluginAPI_V0_2 } from './v0.2';

// ── v0.4 scoped types ─────────────────────────────────────────────────

export interface LoggingAPI_V0_4 {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  fatal(msg: string, meta?: Record<string, unknown>): void;
}

// ── Composite v0.4 API ────────────────────────────────────────────────

export interface PluginAPI_V0_4 extends PluginAPI_V0_2 {
  logging: LoggingAPI_V0_4;
}

// ── Compile-time backward-compat guard ────────────────────────────────
// Fails to compile if the current PluginAPI drops or changes any v0.4 member.
type _V0_4_BackCompat = PluginAPI extends PluginAPI_V0_4 ? true : never;
const _v0_4_check: _V0_4_BackCompat = true;
void _v0_4_check;
