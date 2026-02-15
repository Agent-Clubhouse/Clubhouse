/**
 * Frozen API snapshot for plugin API v0.4.
 *
 * DO NOT MODIFY these interfaces — they are the compile-time contract for
 * plugins targeting engine.api: 0.4.
 *
 * v0.4 runtime API surface is identical to v0.2.
 * The change is manifest-level: `contributes.help` is mandatory for v0.4+.
 */

import type { PluginAPI } from '../plugin-types';
import type { PluginAPI_V0_2 } from './v0.2';

// v0.4 runtime API is identical to v0.2
export type PluginAPI_V0_4 = PluginAPI_V0_2;

// ── Compile-time backward-compat guard ────────────────────────────────
// Fails to compile if the current PluginAPI drops or changes any v0.4 member.
type _V0_4_BackCompat = PluginAPI extends PluginAPI_V0_4 ? true : never;
const _v0_4_check: _V0_4_BackCompat = true;
void _v0_4_check;
