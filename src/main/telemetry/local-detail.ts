/**
 * The local record's event detail (#2920): what an audit event keeps that
 * the export schema can't, such as a setting's key and its old and new
 * values. Held to the settings audit's rule: a value is kept only as a
 * boolean, a whole number, null, or a short word or id. Anything else is
 * left out, so names, paths, commands and free text never reach the file.
 * Written to the local record only; the facade never hands it to the SDK.
 */

import type { LocalDetail, LocalDetailValue } from './types';

/** A short word or id: what the settings audit has always kept. */
export const LOCAL_DETAIL_TOKEN = /^[\w.:[\]-]{1,64}$/;
const KEY = /^[A-Za-z][\w.-]{0,63}$/;
const MAX_KEYS = 32;
const MAX_LIST = 8;

function value(v: unknown): LocalDetailValue | undefined {
  if (v === null) return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isSafeInteger(v) ? v : undefined;
  if (typeof v === 'string') return LOCAL_DETAIL_TOKEN.test(v) ? v : undefined;
  if (Array.isArray(v)) {
    const kept = v.slice(0, MAX_LIST).filter((x): x is string => typeof x === 'string' && LOCAL_DETAIL_TOKEN.test(x));
    return kept.length === v.length || v.length > MAX_LIST ? kept : undefined;
  }
  return undefined;
}

function flat(o: unknown): Record<string, LocalDetailValue> | undefined {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined;
  const out: Record<string, LocalDetailValue> = {};
  for (const [k, v] of Object.entries(o).slice(0, MAX_KEYS)) {
    const kept = KEY.test(k) ? value(v) : undefined;
    if (kept !== undefined) out[k] = kept;
  }
  return out;
}

/** The detail as it may be written: unknown shapes and values that aren't keepable are dropped. Never throws. */
export function sanitizeLocalDetail(detail: unknown): Record<string, unknown> | undefined {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail as LocalDetail).slice(0, MAX_KEYS)) {
    if (!KEY.test(k)) continue;
    const kept = v && typeof v === 'object' && !Array.isArray(v) ? flat(v) : value(v);
    if (kept !== undefined) out[k] = kept;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
