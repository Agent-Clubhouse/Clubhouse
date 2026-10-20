/**
 * The instrumentation API feature code calls (spec §6.5). Always loaded;
 * never imports OpenTelemetry.
 *
 * While telemetry is disabled every `tel.*` call is one property read and a
 * branch: flows run `fn` directly. While the SDK chunk is loading at startup,
 * calls are buffered (max 500) and replayed once the runtime is ready.
 *
 * The local recorder (spec §6.12) is a second, independent consumer: when it
 * is installed every call also goes to it, with or without an SDK runtime.
 *
 * Signal parity (spec §6.12): what is produced follows local recording
 * alone. Producers gate on isTelemetryActive() and telemetryLevel(), which
 * never look at export, so turning export on or off starts or stops nothing.
 */
import {
  EVENTS,
  METRICS,
  SPANS,
  levelAllows,
  type EventName,
  type MetricName,
  type SpanName,
  type TelAttr,
  type TelemetryLevel,
} from '../../shared/telemetry/attributes';
import {
  NOOP_SPAN,
  errorTypeOf,
  tagError,
  type Classification,
  type ErrorType,
  type ExceptionOptions,
  type FlowExtras,
  type FlowOptions,
  type ReplaySpan,
  type ReplayTree,
  type SpanHandle,
  type TelemetryRuntime,
  type EventOptions,
  type LocalTelemetrySink,
  type TraceIds,
} from './types';

export const PENDING_BUFFER_CAP = 500;
export const DEFAULT_FLUSH_TIMEOUT_MS = 3000;

type Pending = (rt: TelemetryRuntime) => void;

let runtime: TelemetryRuntime | null = null;
let pending: Pending[] | null = null;
let local: LocalTelemetrySink | null = null;

/**
 * The parity policy's one switch. false (maintainer ruling on #2289): local
 * recording is the sole gate, and export only uploads what local recording
 * produces, at its level. true: with local recording off, feature `tel.*`
 * calls still reach a running exporter (producers stay off either way).
 */
export const EXPORT_WITHOUT_LOCAL_RECORDING = false;

let exportWithoutLocal = EXPORT_WITHOUT_LOCAL_RECORDING;

/** The parity policy in effect (EXPORT_WITHOUT_LOCAL_RECORDING outside tests). */
export function exportsWithoutLocalRecording(): boolean {
  return exportWithoutLocal;
}

/**
 * Whether an item at `itemLevel` goes to export: only what local recording
 * produces, so never above its level (an exporter's own level only filters
 * down). Spans use the SDK's rule that Errors still records flows.
 */
function exported(itemLevel: TelemetryLevel, span = false): boolean {
  if (!local) return exportWithoutLocal;
  const level = span && local.level === 'errors' ? 'standard' : local.level;
  return levelAllows(level, itemLevel);
}

/** The runtime an item at `itemLevel` is sent to under the parity policy, if any. */
function exportRuntime(itemLevel: TelemetryLevel, span = false): TelemetryRuntime | null {
  return runtime && exported(itemLevel, span) ? runtime : null;
}

/** True while startup buffering applies to an item at `itemLevel`. */
function exportPending(itemLevel: TelemetryLevel, span = false): boolean {
  return pending !== null && exported(itemLevel, span);
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return !!value && typeof (value as { then?: unknown }).then === 'function';
}

function buffer(item: Pending): void {
  if (pending && pending.length < PENDING_BUFFER_CAP) pending.push(item);
}

function bufferedSpan<T>(name: SpanName, opts: FlowOptions, fn: (s: SpanHandle) => T, extras?: FlowExtras<T>): T {
  if (!pending || pending.length >= PENDING_BUFFER_CAP) return fn(NOOP_SPAN);
  const startMs = Date.now();
  const attrs: TelAttr[] = [...(opts.attrs ?? [])];
  const handle: SpanHandle = { set: (...a) => attrs.push(...a) };
  const record = (c: Classification): void => {
    const span: ReplaySpan = { name, startMs, endMs: Date.now(), attrs, outcome: 'ok' };
    if (opts.signal?.aborted) span.outcome = 'cancelled';
    else if (c === 'ok') span.outcome = 'ok';
    else if ('error' in c) {
      span.outcome = 'error';
      span.errorType = c.error;
    } else span.outcome = c.outcome;
    buffer((rt) => rt.replaySpan(span));
  };
  const classify = (r: Awaited<T>): Classification => {
    try {
      return extras?.classify ? extras.classify(r) : 'ok';
    } catch {
      return 'ok';
    }
  };
  let result: T;
  try {
    result = fn(handle);
  } catch (err) {
    record({ error: errorTypeOf(err) });
    buffer((rt) => rt.exception(err, { origin: 'main', handled: false }));
    throw err;
  }
  if (isPromiseLike<Awaited<T>>(result)) {
    Promise.resolve(result).then(
      (r) => record(classify(r)),
      (err) => {
        record({ error: errorTypeOf(err) });
        buffer((rt) => rt.exception(err, { origin: 'main', handled: false }));
      },
    );
    return result;
  }
  record(classify(result as Awaited<T>));
  return result;
}

// --- Active flow tracking (§4.15 blocked-flow attribution) -----------------

/** Root flows currently in progress, most recent last. Only tracked while telemetry is on. */
const activeFlows: SpanName[] = [];

function trackFlow<T>(name: SpanName, fn: (span: SpanHandle) => T): (span: SpanHandle) => T {
  return (span) => {
    activeFlows.push(name);
    const done = (): void => {
      const i = activeFlows.lastIndexOf(name);
      if (i >= 0) activeFlows.splice(i, 1);
    };
    let result: T;
    try {
      result = fn(span);
    } catch (err) {
      done();
      throw err;
    }
    if (isPromiseLike(result)) Promise.resolve(result).then(done, done);
    else done();
    return result;
  };
}

/**
 * The active span's trace and span ids: the exported trace's while the SDK
 * is running, else the local recording's.
 */
export function currentTraceIds(): TraceIds | undefined {
  // Called from appLog on every line; a logger must never throw, and runtimes
  // built before activeTraceIds existed (test fakes) may not have it.
  try {
    return runtime?.activeTraceIds?.() ?? local?.activeTraceIds();
  } catch {
    return undefined;
  }
}

/** The most recently started root flow still running, if any. */
export function currentFlow(): SpanName | null {
  return activeFlows.length > 0 ? activeFlows[activeFlows.length - 1] : null;
}

export { tagError } from './types';

/**
 * Run `fn`, tagging anything it throws or rejects with `type` (see tagError).
 * Returns `fn`'s own value: while telemetry is off it is a plain call, and a
 * synchronous result is never wrapped in a promise.
 */
export function withErrorType<T>(type: ErrorType, fn: () => T): T {
  if (!local && !(exportWithoutLocal && (runtime || pending))) return fn();
  let result: T;
  try {
    result = fn();
  } catch (err) {
    throw tagError(err, type);
  }
  if (isPromiseLike(result)) {
    return Promise.resolve(result).catch((err: unknown) => {
      throw tagError(err, type);
    }) as T;
  }
  return result;
}

export const tel = {
  /** A root user-flow span. Thrown errors are recorded and rethrown unchanged. */
  flow<T>(name: SpanName, opts: FlowOptions, fn: (span: SpanHandle) => T, extras?: FlowExtras<T>): T {
    // The local wrapper runs inside the SDK span, so it sees the same body and result.
    const body = local ? local.wrap(name, opts, fn, extras) : fn;
    const rt = exportRuntime(SPANS[name].level, true);
    if (rt) return rt.flow(name, opts, trackFlow(name, body), extras);
    if (exportPending(SPANS[name].level, true)) return bufferedSpan(name, opts, trackFlow(name, body), extras);
    if (local) return trackFlow(name, body)(NOOP_SPAN);
    return fn(NOOP_SPAN);
  },

  /** A child span of the active flow. */
  step<T>(name: SpanName, fn: (span: SpanHandle) => T, opts: FlowOptions = {}): T {
    const body = local ? local.wrap(name, opts, fn) : fn;
    const rt = exportRuntime(SPANS[name].level, true);
    if (rt) return rt.step(name, body, opts);
    if (exportPending(SPANS[name].level, true)) return bufferedSpan(name, opts, body);
    return body(NOOP_SPAN);
  },

  count(name: MetricName, value = 1, attrs?: TelAttr[]): void {
    toLocal((l) => l.count(name, value, attrs));
    const target = exportRuntime(METRICS[name].level);
    if (target) target.count(name, value, attrs);
    else if (exportPending(METRICS[name].level)) buffer((rt) => rt.count(name, value, attrs));
  },

  event(name: EventName, attrs?: TelAttr[], opts?: EventOptions): void {
    toLocal((l) => l.event(name, attrs, opts));
    // Options only when given, so plain events keep their two-argument call shape.
    const emit = (rt: TelemetryRuntime): void => (opts ? rt.event(name, attrs, opts) : rt.event(name, attrs));
    const target = exportRuntime(EVENTS[name].level);
    if (target) emit(target);
    else if (exportPending(EVENTS[name].level)) buffer(emit);
  },

  exception(error: unknown, opts: ExceptionOptions): void {
    toLocal((l) => l.exception(error, opts));
    const exLevel = EVENTS['clubhouse.exception'].level;
    const target = exportRuntime(exLevel);
    if (target) target.exception(error, opts);
    else if (exportPending(exLevel)) buffer((rt) => rt.exception(error, opts));
  },
};

/**
 * Record a span measured elsewhere (a renderer) with explicit start and end
 * times. Buffered like any other call while the SDK chunk loads.
 */
export function replaySpan(span: ReplaySpan): void {
  toLocal((l) => l.replaySpan(span));
  const target = exportRuntime(SPANS[span.name].level, true);
  if (target) target.replaySpan(span);
  else if (exportPending(SPANS[span.name].level, true)) buffer((rt) => rt.replaySpan(span));
}

/** Record a root span and its children with explicit times (startup, shutdown). */
export function replaySpanTree(tree: ReplayTree): void {
  toLocal((l) => l.replayTree(tree));
  const target = exportRuntime(SPANS[tree.root.name].level, true);
  if (!target && !exportPending(SPANS[tree.root.name].level, true)) return;
  // Children above the local level are not produced, so not exported either.
  const sent: ReplayTree = { root: tree.root, children: tree.children.filter((c) => exported(SPANS[c.name].level, true)) };
  if (target) target.replayTree(sent);
  else buffer((rt) => rt.replayTree(sent));
}

/**
 * W3C `traceparent` for the active span, or undefined when telemetry is off
 * or nothing is recording. Only random ids and the sampled flag (spec §7).
 */
export function currentTraceparent(): string | undefined {
  return runtime?.traceparent?.();
}

/**
 * Run `fn` so the next root flow it starts continues a trace received from an
 * Annex peer. A no-op wrapper when telemetry is off or `traceparent` is
 * missing or malformed: this install's own settings decide (spec §7 rule 2).
 */
export function withRemoteParent<T>(traceparent: string | undefined, fn: () => T): T {
  if (!runtime?.withRemoteParent || typeof traceparent !== 'string') return fn();
  return runtime.withRemoteParent(traceparent, fn);
}

/**
 * The level producers record at: local recording's, or null while it is
 * off. Export never changes it (parity); each exporter only filters down.
 */
export function telemetryLevel(): TelemetryLevel | null {
  return local?.level ?? null;
}

/**
 * True while producers should run: exactly while local recording is on,
 * whatever the export state.
 */
export function isTelemetryActive(): boolean {
  return local !== null;
}

/** True while an exporter is running or starting. Not a producer gate. */
export function isExportActive(): boolean {
  return runtime !== null || pending !== null;
}

/** Test-only: exercise the other parity policy. */
export function _setExportWithoutLocalForTests(value: boolean): void {
  exportWithoutLocal = value;
}

/** The local sink must never break feature code or the export call after it. */
function toLocal(call: (sink: LocalTelemetrySink) => void): void {
  if (!local) return;
  try {
    call(local);
  } catch {
    // dropped: local recording is best effort
  }
}

// --- Runtime change notifications ------------------------------------------

type RuntimeListener = () => void;
const runtimeListeners = new Set<RuntimeListener>();

/**
 * Called whenever telemetry starts, stops or its startup is abandoned, so
 * renderers can be told to start or stop recording. Returns an unsubscribe.
 */
export function onRuntimeChange(listener: RuntimeListener): () => void {
  runtimeListeners.add(listener);
  return () => runtimeListeners.delete(listener);
}

function notifyRuntimeChange(): void {
  for (const l of runtimeListeners) {
    try {
      l();
    } catch {
      // A listener must never break telemetry start/stop.
    }
  }
}

// --- Lifecycle (used by bootstrap.ts and tests) ----------------------------

/** Start buffering calls while the SDK chunk loads. */
export function beginPending(): void {
  if (!runtime && !pending) pending = [];
}

/** Drop the startup buffer (telemetry failed to start or was disabled). */
export function abortPending(): void {
  pending = null;
  notifyRuntimeChange();
}

/** Install the runtime and replay anything buffered during startup. */
export function setRuntime(rt: TelemetryRuntime | null): void {
  runtime = rt;
  if (!rt) {
    pending = null;
    notifyRuntimeChange();
    return;
  }
  const queued = pending ?? [];
  pending = null;
  for (const item of queued) {
    try {
      item(rt);
    } catch {
      // Replay must never throw into startup code.
    }
  }
  notifyRuntimeChange();
}

export function getRuntime(): TelemetryRuntime | null {
  return runtime;
}

/** Install or remove the local recorder (local-control.ts). */
export function setLocalSink(sink: LocalTelemetrySink | null): void {
  if (sink === local) return;
  local = sink;
  notifyRuntimeChange();
}

export function getLocalSink(): LocalTelemetrySink | null {
  return local;
}

export function isPending(): boolean {
  return pending !== null;
}

/**
 * Flush queued telemetry before the process exits. Never throws and never
 * waits longer than `timeoutMs`. Call before every `app.exit()`: those paths
 * skip `before-quit` and the shutdown-guard cleanups.
 *
 * A no-op while the SDK chunk is still loading: anything buffered by then
 * (including `clubhouse.app.sessions`) is dropped if the app quits within
 * the first moments of startup. Accepted: waiting on the load would delay
 * an early quit for telemetry the user has not seen yet.
 */
export async function flushBeforeExit(timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS): Promise<void> {
  // Every caller of flushBeforeExit is an intentional exit (quit, restart,
  // update relaunch). Crash paths use forceFlushTelemetry instead, so these
  // listeners can mark the session as cleanly ended.
  for (const l of exitListeners) {
    try {
      l();
    } catch {
      // Never block an exit.
    }
  }
  await forceFlushTelemetry(timeoutMs);
}

/**
 * OS shutdown, restart or logoff (#2335): write the local recording
 * synchronously, then start an export flush the OS may not wait for. Doesn't
 * run the intentional-exit listeners; lifecycle records the exit kind itself.
 * Never throws.
 */
export function flushForOsSessionEnd(timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS): void {
  try {
    local?.flushSync?.();
  } catch {
    // Telemetry must never block or fail an exit.
  }
  try {
    runtime?.forceFlush(timeoutMs).catch(() => {});
  } catch {
    // As above.
  }
}

const exitListeners = new Set<() => void>();

/** Run synchronously at the start of every intentional exit. */
export function onIntentionalExit(listener: () => void): () => void {
  exitListeners.add(listener);
  return () => exitListeners.delete(listener);
}

/**
 * Flush without marking the session as cleanly ended. Used by crash
 * handlers. Never throws and never waits longer than `timeoutMs`.
 */
export async function forceFlushTelemetry(timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS): Promise<void> {
  const rt = runtime;
  const sink = local;
  if (!rt && !sink) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.all([rt?.forceFlush(timeoutMs), sink?.flush().catch(() => {})]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } catch {
    // Telemetry must never block or fail an exit.
  } finally {
    clearTimeout(timer);
  }
}
