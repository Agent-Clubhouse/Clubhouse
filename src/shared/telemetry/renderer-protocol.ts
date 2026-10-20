/**
 * Wire format for renderer → main telemetry (spec §6.2). The renderer batches
 * items and sends them over `telemetry:emit`; main re-validates every item
 * against the attribute registry before anything reaches the SDK. The
 * renderer is never trusted to redact.
 *
 * No runtime dependencies beyond the registry, so both sides can import it.
 */
import {
  ERROR_TYPES,
  OUTCOMES,
  getAttributeSpec,
  isKnownEvent,
  isKnownMetric,
  isKnownSpan,
  type EventName,
  type MetricName,
  type Outcome,
  type SpanName,
  type TelAttr,
  type TelemetryLevel,
} from './attributes';

export const RENDERER_PROTOCOL_VERSION = 1;
/** Items per batch; the renderer flushes at 50, main drops anything past this. */
export const MAX_BATCH_ITEMS = 100;
export const MAX_ATTRS_PER_ITEM = 16;
/** Raw renderer stacks are capped here; main sanitizes them before export. */
export const MAX_RENDERER_STACK_CHARS = 8000;
/** A span longer than a day is a clock bug, not a measurement. */
export const MAX_SPAN_DURATION_MS = 24 * 60 * 60 * 1000;

export type ErrorTypeValue = (typeof ERROR_TYPES)[number];

export type RendererItem =
  | {
      t: 'span';
      name: SpanName;
      startMs: number;
      endMs: number;
      attrs: TelAttr[];
      outcome: Outcome;
      errorType?: ErrorTypeValue;
    }
  | { t: 'count'; name: MetricName; value: number; attrs: TelAttr[] }
  | { t: 'event'; name: EventName; attrs: TelAttr[] }
  | {
      t: 'exception';
      /** Constructor name only (`TypeError`); never the message. */
      errorType: string;
      stack?: string;
      origin: 'renderer' | 'plugin';
      handled: boolean;
      attrs: TelAttr[];
    };

export interface RendererBatch {
  v: typeof RENDERER_PROTOCOL_VERSION;
  items: RendererItem[];
}

/** What the renderer needs to know to decide whether to record anything. */
export interface TelemetryState {
  /** Send `tel.*` calls to main. */
  enabled: boolean;
  level: TelemetryLevel | null;
  /**
   * Run renderer producers (long-frame aggregation, perf observers). Follows
   * local recording only (spec §6.12 parity), so it can be false while
   * `enabled` is true for an exporter. Absent means the same as `enabled`.
   */
  producers?: boolean;
}

export const DISABLED_STATE: TelemetryState = { enabled: false, level: null };

/** Renderer-side startup marks sent with `telemetry:renderer-ready` (Date.now() values). */
export interface RendererReadyMarks {
  initStartMs?: number;
  settingsLoadedMs?: number;
  pluginsReadyMs?: number;
}

/** Keep only finite, ordered marks; anything else is dropped. */
export function parseRendererReadyMarks(raw: unknown): RendererReadyMarks {
  if (typeof raw !== 'object' || raw === null) return {};
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);
  const out: RendererReadyMarks = {};
  const init = num(r.initStartMs);
  const settings = num(r.settingsLoadedMs);
  const plugins = num(r.pluginsReadyMs);
  if (init !== undefined) out.initStartMs = init;
  if (settings !== undefined && (init === undefined || settings >= init)) out.settingsLoadedMs = settings;
  if (plugins !== undefined && (out.settingsLoadedMs === undefined || plugins >= out.settingsLoadedMs)) out.pluginsReadyMs = plugins;
  return out;
}

const ERROR_TYPE_SET = new Set<string>(ERROR_TYPES);
const OUTCOME_SET = new Set<string>(OUTCOMES);
const TYPE_NAME = /^[A-Za-z_$][\w$.]{0,63}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function finiteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Rebuild one attribute from untrusted input. Only registered keys survive,
 * and each value must match its registered kind. Enum values outside the set
 * are dropped (not coerced to `other`), so a malformed renderer can't inflate
 * the `other` bucket.
 */
export function parseAttr(raw: unknown): TelAttr | undefined {
  if (!isRecord(raw) || typeof raw.key !== 'string') return undefined;
  const spec = getAttributeSpec(raw.key);
  if (!spec) return undefined;
  const value = raw.value;
  switch (spec.kind) {
    case 'enum':
      return typeof value === 'string' && spec.values?.includes(value)
        ? { key: spec.key, kind: 'enum', value }
        : undefined;
    case 'int':
      return finiteNumber(value) ? { key: spec.key, kind: 'int', value: Math.trunc(value) } : undefined;
    case 'bool':
      return typeof value === 'boolean' ? { key: spec.key, kind: 'bool', value } : undefined;
    case 'hash':
      // The raw opaque id; main hashes it with the install salt.
      return typeof value === 'string' && value.length > 0 && value.length <= 128
        ? { key: spec.key, kind: 'hash', value }
        : undefined;
    case 'version':
      return typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,32})?$/.test(value)
        ? { key: spec.key, kind: 'version', value }
        : undefined;
    default:
      return undefined;
  }
}

function parseAttrs(raw: unknown): TelAttr[] {
  if (!Array.isArray(raw)) return [];
  const out: TelAttr[] = [];
  for (const a of raw.slice(0, MAX_ATTRS_PER_ITEM)) {
    const parsed = parseAttr(a);
    if (parsed) out.push(parsed);
  }
  return out;
}

export function parseRendererItem(raw: unknown): RendererItem | undefined {
  if (!isRecord(raw)) return undefined;
  const attrs = parseAttrs(raw.attrs);
  switch (raw.t) {
    case 'span': {
      if (typeof raw.name !== 'string' || !isKnownSpan(raw.name)) return undefined;
      if (!finiteNumber(raw.startMs) || !finiteNumber(raw.endMs)) return undefined;
      const duration = raw.endMs - raw.startMs;
      if (duration < 0 || duration > MAX_SPAN_DURATION_MS) return undefined;
      const outcome = typeof raw.outcome === 'string' && OUTCOME_SET.has(raw.outcome) ? (raw.outcome as Outcome) : 'ok';
      const errorType =
        typeof raw.errorType === 'string' && ERROR_TYPE_SET.has(raw.errorType)
          ? (raw.errorType as ErrorTypeValue)
          : undefined;
      return { t: 'span', name: raw.name, startMs: raw.startMs, endMs: raw.endMs, attrs, outcome, errorType };
    }
    case 'count': {
      if (typeof raw.name !== 'string' || !isKnownMetric(raw.name)) return undefined;
      if (!finiteNumber(raw.value) || raw.value < 0) return undefined;
      return { t: 'count', name: raw.name, value: raw.value, attrs };
    }
    case 'event': {
      if (typeof raw.name !== 'string' || !isKnownEvent(raw.name)) return undefined;
      // Exception records go through `t: 'exception'`, never as a raw event.
      if (raw.name === 'clubhouse.exception') return undefined;
      return { t: 'event', name: raw.name, attrs };
    }
    case 'exception': {
      const errorType = typeof raw.errorType === 'string' && TYPE_NAME.test(raw.errorType) ? raw.errorType : 'Error';
      const stack = typeof raw.stack === 'string' ? raw.stack.slice(0, MAX_RENDERER_STACK_CHARS) : undefined;
      const origin = raw.origin === 'plugin' ? 'plugin' : 'renderer';
      return { t: 'exception', errorType, stack, origin, handled: raw.handled === true, attrs };
    }
    default:
      return undefined;
  }
}

/** Parse a whole batch, dropping invalid items. Never throws. */
export function parseRendererBatch(raw: unknown): RendererItem[] {
  if (!isRecord(raw) || raw.v !== RENDERER_PROTOCOL_VERSION || !Array.isArray(raw.items)) return [];
  const out: RendererItem[] = [];
  for (const item of raw.items.slice(0, MAX_BATCH_ITEMS)) {
    const parsed = parseRendererItem(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

export function parseTelemetryState(raw: unknown): TelemetryState {
  if (!isRecord(raw) || raw.enabled !== true) return DISABLED_STATE;
  const level = raw.level === 'errors' || raw.level === 'standard' || raw.level === 'detailed' ? raw.level : null;
  if (!level) return DISABLED_STATE;
  return typeof raw.producers === 'boolean' ? { enabled: true, level, producers: raw.producers } : { enabled: true, level };
}
