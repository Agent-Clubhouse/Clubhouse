/**
 * Telemetry attribute registry: the single allowlist for every attribute key,
 * span name, metric name and event name Clubhouse may export.
 *
 * Instrumentation code sets attributes only through `ATTR.x(value)`. The
 * main-process redaction pipeline (src/main/telemetry/redaction.ts) re-checks
 * every exported item against this file and drops anything not declared here.
 * See docs/telemetry-otel-spec.md §5.
 *
 * This module has no runtime dependencies so the renderer can share it later.
 */

/** Bump on breaking attribute changes; exported as `clubhouse.telemetry.schema`. */
export const TELEMETRY_SCHEMA_VERSION = 1;

/** Maximum length of any exported string attribute (spec §5.1). */
export const MAX_STRING_LENGTH = 128;

/** Value used when an enum attribute receives something outside its set. */
export const OTHER = 'other';

export type TelemetryLevel = 'errors' | 'standard' | 'detailed';
export const TELEMETRY_LEVELS: readonly TelemetryLevel[] = ['errors', 'standard', 'detailed'];

/** True when an item tagged `itemLevel` should be emitted at the configured level. */
export function levelAllows(configured: TelemetryLevel, itemLevel: TelemetryLevel): boolean {
  return TELEMETRY_LEVELS.indexOf(itemLevel) <= TELEMETRY_LEVELS.indexOf(configured);
}

export type AttrKind = 'enum' | 'int' | 'bool' | 'hash' | 'version';

export interface AttrSpec {
  readonly key: string;
  readonly kind: AttrKind;
  readonly values?: readonly string[];
}

/**
 * One typed attribute, produced only by the `ATTR` helpers. `hash` attributes
 * carry the raw opaque id; the main-process facade replaces it with the
 * salted HMAC before anything reaches the SDK.
 */
export interface TelAttr {
  readonly key: string;
  readonly kind: AttrKind;
  readonly value: string | number | boolean;
}

const specs = new Map<string, AttrSpec>();

function register(spec: AttrSpec): void {
  if (specs.has(spec.key)) throw new Error(`Duplicate telemetry attribute key: ${spec.key}`);
  specs.set(spec.key, spec);
}

export function enumAttr<const V extends readonly string[]>(key: string, values: V) {
  register({ key, kind: 'enum', values });
  const allowed = new Set<string>(values);
  return (value: V[number]): TelAttr => ({
    key,
    kind: 'enum',
    value: allowed.has(value) ? value : OTHER,
  });
}

export function intAttr(key: string) {
  register({ key, kind: 'int' });
  return (value: number): TelAttr => ({ key, kind: 'int', value: Math.trunc(value) });
}

export function boolAttr(key: string) {
  register({ key, kind: 'bool' });
  return (value: boolean): TelAttr => ({ key, kind: 'bool', value: value === true });
}

/** An opaque internal id (agent id, project id, run id). Never a name or path. */
export function hashAttr(key: string) {
  register({ key, kind: 'hash' });
  return (rawId: string): TelAttr => ({ key, kind: 'hash', value: rawId });
}

/** A release version string such as `0.43.1` or `0.43.0-beta.2`. */
export function versionAttr(key: string) {
  register({ key, kind: 'version' });
  return (value: string): TelAttr => ({ key, kind: 'version', value });
}

// --- Closed enums -----------------------------------------------------------

/** Union of every flow's closed `error.type` enum (spec §4). Phase 1 subset. */
export const ERROR_TYPES = [
  'exporter_failed',
  'init_failed',
  'timeout',
  'unknown',
  // Startup (§4.1)
  'settings_load_failed',
  'plugin_system_failed',
  'window_load_failed',
  'ipc_register_failed',
  // Agents (§4.4)
  'binary_not_found',
  // Renderer and crash handling (§4.2, Phase 3)
  'render_error',
] as const;

export const OUTCOMES = ['ok', 'error', 'cancelled', 'timeout', 'skipped'] as const;
export type Outcome = (typeof OUTCOMES)[number];

// --- The registry -----------------------------------------------------------

export const ATTR = {
  // Cross-cutting (§3.2)
  outcome: enumAttr('clubhouse.outcome', OUTCOMES),
  errorType: enumAttr('error.type', ERROR_TYPES),
  process: enumAttr('clubhouse.process', ['main', 'renderer']),

  // App lifecycle (§4.1)
  startupKind: enumAttr('clubhouse.startup.kind', ['cold', 'after_update', 'safe_mode']),

  // Telemetry self-observation (§4.15)
  telemetrySignal: enumAttr('clubhouse.telemetry.signal', ['traces', 'metrics', 'logs']),
  httpClass: enumAttr('clubhouse.http.class', ['2xx', '3xx', '4xx', '5xx', 'network', 'timeout']),
  telemetryDestination: enumAttr('clubhouse.telemetry.destination', ['azure', 'otlp']),

  // Agents (§5.1 examples; instrumented from Phase 3)
  agentKind: enumAttr('clubhouse.agent.kind', ['durable', 'quick', 'companion']),
  orchestrator: enumAttr('clubhouse.orchestrator', ['claude-code', 'codex-cli', 'copilot-cli', 'other']),
  agentRuntime: enumAttr('clubhouse.agent.runtime', ['pty', 'headless']),
  exitCode: intAttr('process.exit.code'),
  agentIdHash: hashAttr('clubhouse.agent.id_hash'),
  sizeBucket: enumAttr('clubhouse.size_bucket', ['0', '<1KB', '<100KB', '<1MB', '<10MB', '<100MB', '>=100MB']),

  // Exceptions (§4.2): the error class name only, never the message.
  exceptionHandled: boolAttr('clubhouse.exception.handled'),
  exceptionOrigin: enumAttr('clubhouse.exception.origin', ['main', 'renderer', 'plugin']),

  // Versions (§4.3)
  updateFromVersion: versionAttr('clubhouse.update.from_version'),

  // Renderer foundation and crash handling (§4.2, §4.15; Phase 3)
  windowKind: enumAttr('clubhouse.window.kind', ['main', 'popout']),
  /**
   * The active main view (spec §4.15), a coarse bounded enum. The chrome
   * refresh sets it from the active tab and pane (spec §9.1; chrome spec §8);
   * finer placement goes in a separate attribute, not here.
   */
  view: enumAttr('clubhouse.view', ['agent', 'terminal', 'canvas', 'files', 'git', 'settings', 'plugin', 'other']),
  errorBoundary: enumAttr('clubhouse.error.boundary', ['app', 'plugin']),
  /** Electron `RenderProcessGoneDetails.reason`. */
  rendererGoneReason: enumAttr('clubhouse.renderer.gone_reason', [
    'clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure', 'memory-eviction',
  ]),
  /** Electron `Details.type` for `child-process-gone`. */
  childProcessType: enumAttr('clubhouse.child_process.type', [
    'Utility', 'Zygote', 'Sandbox helper', 'GPU', 'Pepper Plugin', 'Pepper Plugin Broker', 'Unknown',
  ]),
  childProcessGoneReason: enumAttr('clubhouse.child_process.gone_reason', [
    'clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure', 'memory-eviction',
  ]),
} as const;

/**
 * Keys the SDK itself writes that the redaction pipeline must keep. They are
 * set by our own code paths (exception events, sampler), never by callers.
 */
export const SDK_ATTRIBUTE_KEYS = {
  exceptionType: 'exception.type',
  exceptionStacktrace: 'exception.stacktrace',
  /** Always set to the exception type: App Insights requires a message, we never send the real one. */
  exceptionMessage: 'exception.message',
  sampleRate: 'microsoft.sample_rate',
  /** Routes an event log record to the App Insights `customEvents` table. */
  customEventName: 'microsoft.custom_event.name',
} as const;

/** Stack traces get a larger cap than other strings; frames are pre-sanitized. */
export const MAX_STACKTRACE_LENGTH = 4096;

export function getAttributeSpec(key: string): AttrSpec | undefined {
  return specs.get(key);
}

export function allAttributeKeys(): string[] {
  return [...specs.keys()].sort();
}

// --- Names ------------------------------------------------------------------

export interface SpanDef {
  readonly level: TelemetryLevel;
  /** Root user-flow spans export as SERVER so they land in App Insights `requests`. */
  readonly root: boolean;
}

export const SPANS = {
  'clubhouse.telemetry.test': { level: 'errors', root: true },
  /** A window that stopped responding, from `unresponsive` to `responsive` (§4.2). */
  'clubhouse.renderer.unresponsive': { level: 'errors', root: true },
} as const satisfies Record<string, SpanDef>;
export type SpanName = keyof typeof SPANS;

export interface MetricDef {
  readonly kind: 'counter' | 'histogram' | 'gauge';
  readonly unit?: string;
  readonly level: TelemetryLevel;
  readonly description: string;
  /** Attribute keys allowed as dimensions. Hash attributes are never allowed. */
  readonly attributes: readonly string[];
}

export const METRICS = {
  'clubhouse.app.sessions': {
    kind: 'counter',
    unit: '{session}',
    level: 'errors',
    description: 'App sessions started',
    attributes: ['clubhouse.startup.kind'],
  },
  'clubhouse.telemetry.dropped': {
    kind: 'counter',
    unit: '{item}',
    level: 'errors',
    description: 'Telemetry items dropped by the per-session cap or the redaction pipeline',
    attributes: ['clubhouse.telemetry.signal'],
  },
  'clubhouse.renderer.long_frames': {
    kind: 'counter',
    unit: '{frame}',
    level: 'standard',
    description: 'Long animation frames (>= 50 ms) in a renderer, aggregated per minute',
    attributes: ['clubhouse.view', 'clubhouse.window.kind'],
  },
  'clubhouse.renderer.long_frame.duration': {
    kind: 'histogram',
    unit: 's',
    level: 'standard',
    description: 'Duration of sampled long animation frames',
    attributes: ['clubhouse.view', 'clubhouse.window.kind'],
  },
  'clubhouse.renderer.unresponsive_count': {
    kind: 'counter',
    unit: '{event}',
    level: 'errors',
    description: 'Windows that stopped responding',
    attributes: ['clubhouse.window.kind'],
  },
  'clubhouse.telemetry.export.failures': {
    kind: 'counter',
    unit: '{export}',
    level: 'errors',
    description: 'Failed exporter batches',
    attributes: ['clubhouse.telemetry.signal', 'clubhouse.http.class'],
  },
} as const satisfies Record<string, MetricDef>;
export type MetricName = keyof typeof METRICS;

export interface EventDef {
  readonly level: TelemetryLevel;
}

export const EVENTS = {
  'clubhouse.telemetry.test': { level: 'errors' },
  'clubhouse.telemetry.enabled': { level: 'errors' },
  'clubhouse.telemetry.disabled': { level: 'errors' },
  /** Exception records (§4.2). Body is always this name; never the message. */
  'clubhouse.exception': { level: 'errors' },
  /** A renderer process exited (`render-process-gone`). */
  'clubhouse.renderer.gone': { level: 'errors' },
  /** A GPU or utility process exited (`child-process-gone`). */
  'clubhouse.child_process.gone': { level: 'errors' },
} as const satisfies Record<string, EventDef>;
export type EventName = keyof typeof EVENTS;

export function isKnownSpan(name: string): name is SpanName {
  return Object.prototype.hasOwnProperty.call(SPANS, name);
}

export function isKnownMetric(name: string): name is MetricName {
  return Object.prototype.hasOwnProperty.call(METRICS, name);
}

export function isKnownEvent(name: string): name is EventName {
  return Object.prototype.hasOwnProperty.call(EVENTS, name);
}
