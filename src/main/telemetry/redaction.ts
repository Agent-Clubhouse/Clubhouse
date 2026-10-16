/**
 * Registry-driven redaction (spec §5.1). Pure functions only: the SDK
 * processors that apply them live in sdk.ts so this file stays out of the
 * lazy chunk's dependency graph and is cheap to unit-test.
 *
 * For every attribute bag it:
 *  1. drops any key not in the registry;
 *  2. re-validates enum, int, bool, hash and version formats;
 *  3. runs the path/URL/email scrubber over every string;
 *  4. caps string length at 128 (stack traces at 4096).
 */
import {
  getAttributeSpec,
  isKnownEvent,
  MAX_STACKTRACE_LENGTH,
  MAX_STRING_LENGTH,
  OTHER,
  SDK_ATTRIBUTE_KEYS,
} from '../../shared/telemetry/attributes';
import type { Scrubber } from './scrubber';

export type AttrValue = string | number | boolean;
export type AttrBag = Record<string, unknown>;

const HASH_RE = /^[0-9a-f]{16}$/;
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.]{1,32})?$/;
const EXCEPTION_TYPE_RE = /^[A-Za-z_$][\w$.]{0,63}$/;

function cap(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** Validate one attribute against the registry. Returns undefined to drop it. */
export function sanitizeAttribute(key: string, value: unknown, scrub: Scrubber): AttrValue | undefined {
  if (key === SDK_ATTRIBUTE_KEYS.exceptionType || key === SDK_ATTRIBUTE_KEYS.exceptionMessage) {
    return typeof value === 'string' && EXCEPTION_TYPE_RE.test(value) ? value : undefined;
  }
  if (key === SDK_ATTRIBUTE_KEYS.exceptionStacktrace) {
    return typeof value === 'string' ? cap(scrub(value), MAX_STACKTRACE_LENGTH) : undefined;
  }
  if (key === SDK_ATTRIBUTE_KEYS.sampleRate) {
    return typeof value === 'number' && value > 0 && value <= 100 ? value : undefined;
  }

  if (key === SDK_ATTRIBUTE_KEYS.customEventName) {
    return typeof value === 'string' && isKnownEvent(value) ? value : undefined;
  }

  const spec = getAttributeSpec(key);
  if (!spec) return undefined;

  switch (spec.kind) {
    case 'enum': {
      if (typeof value !== 'string') return undefined;
      return spec.values?.includes(value) ? value : OTHER;
    }
    case 'int':
      return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
    case 'bool':
      return typeof value === 'boolean' ? value : undefined;
    case 'hash':
      return typeof value === 'string' && HASH_RE.test(value) ? value : undefined;
    case 'version':
      return typeof value === 'string' && VERSION_RE.test(value) ? cap(scrub(value), MAX_STRING_LENGTH) : undefined;
    default:
      return undefined;
  }
}

export interface SanitizeResult {
  attributes: Record<string, AttrValue>;
  dropped: number;
}

export function sanitizeAttributes(attrs: AttrBag | undefined, scrub: Scrubber): SanitizeResult {
  const attributes: Record<string, AttrValue> = {};
  let dropped = 0;
  if (!attrs) return { attributes, dropped };
  for (const key of Object.keys(attrs)) {
    const clean = sanitizeAttribute(key, attrs[key], scrub);
    if (clean === undefined) {
      dropped++;
    } else {
      attributes[key] = clean;
    }
  }
  return { attributes, dropped };
}

/** Classify an exporter error into the `clubhouse.http.class` enum. */
export function classifyExportError(error: unknown): 'network' | 'timeout' | '3xx' | '4xx' | '5xx' {
  const e = error as { statusCode?: unknown; code?: unknown; name?: unknown } | undefined;
  const status = typeof e?.statusCode === 'number' ? e.statusCode : undefined;
  if (status !== undefined) {
    if (status >= 500) return '5xx';
    if (status >= 400) return '4xx';
    if (status >= 300) return '3xx';
  }
  if (e?.name === 'TimeoutError' || e?.code === 'ETIMEDOUT') return 'timeout';
  return 'network';
}
