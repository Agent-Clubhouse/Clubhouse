/**
 * The instrumentation API feature code calls (spec §6.5). Always loaded;
 * never imports OpenTelemetry.
 *
 * While telemetry is disabled every `tel.*` call is one property read and a
 * branch: flows run `fn` directly. While the SDK chunk is loading at startup,
 * calls are buffered (max 500) and replayed once the runtime is ready.
 */
import type { EventName, MetricName, SpanName, TelAttr } from '../../shared/telemetry/attributes';
import {
  NOOP_SPAN,
  type Classification,
  type ExceptionOptions,
  type FlowExtras,
  type FlowOptions,
  type ReplaySpan,
  type ReplayTree,
  type SpanHandle,
  type TelemetryRuntime,
  type EventOptions,
  type TraceIds,
} from './types';

export const PENDING_BUFFER_CAP = 500;
export const DEFAULT_FLUSH_TIMEOUT_MS = 3000;

type Pending = (rt: TelemetryRuntime) => void;

let runtime: TelemetryRuntime | null = null;
let pending: Pending[] | null = null;

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
    record({ error: 'unknown' });
    buffer((rt) => rt.exception(err, { origin: 'main', handled: false }));
    throw err;
  }
  if (isPromiseLike<Awaited<T>>(result)) {
    Promise.resolve(result).then(
      (r) => record(classify(r)),
      (err) => {
        record({ error: 'unknown' });
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

/** The active span's trace and span ids, when telemetry is running. */
export function currentTraceIds(): TraceIds | undefined {
  // Called from appLog on every line; a logger must never throw, and runtimes
  // built before activeTraceIds existed (test fakes) may not have it.
  try {
    return runtime?.activeTraceIds?.();
  } catch {
    return undefined;
  }
}

/** The most recently started root flow still running, if any. */
export function currentFlow(): SpanName | null {
  return activeFlows.length > 0 ? activeFlows[activeFlows.length - 1] : null;
}

export const tel = {
  /** A root user-flow span. Thrown errors are recorded and rethrown unchanged. */
  flow<T>(name: SpanName, opts: FlowOptions, fn: (span: SpanHandle) => T, extras?: FlowExtras<T>): T {
    if (runtime) return runtime.flow(name, opts, trackFlow(name, fn), extras);
    if (!pending) return fn(NOOP_SPAN);
    return bufferedSpan(name, opts, trackFlow(name, fn), extras);
  },

  /** A child span of the active flow. */
  step<T>(name: SpanName, fn: (span: SpanHandle) => T, opts: FlowOptions = {}): T {
    if (runtime) return runtime.step(name, fn, opts);
    if (!pending) return fn(NOOP_SPAN);
    return bufferedSpan(name, opts, fn);
  },

  count(name: MetricName, value = 1, attrs?: TelAttr[]): void {
    if (runtime) runtime.count(name, value, attrs);
    else if (pending) buffer((rt) => rt.count(name, value, attrs));
  },

  event(name: EventName, attrs?: TelAttr[], opts?: EventOptions): void {
    // Options only when given, so plain events keep their two-argument call shape.
    const emit = (rt: TelemetryRuntime): void => (opts ? rt.event(name, attrs, opts) : rt.event(name, attrs));
    if (runtime) emit(runtime);
    else if (pending) buffer(emit);
  },

  exception(error: unknown, opts: ExceptionOptions): void {
    if (runtime) runtime.exception(error, opts);
    else if (pending) buffer((rt) => rt.exception(error, opts));
  },
};

/**
 * Record a span measured elsewhere (a renderer) with explicit start and end
 * times. Buffered like any other call while the SDK chunk loads.
 */
export function replaySpan(span: ReplaySpan): void {
  if (runtime) runtime.replaySpan(span);
  else if (pending) buffer((rt) => rt.replaySpan(span));
}

/** Record a root span and its children with explicit times (startup, shutdown). */
export function replaySpanTree(tree: ReplayTree): void {
  if (runtime) runtime.replayTree(tree);
  else if (pending) buffer((rt) => rt.replayTree(tree));
}

/** True while telemetry is running or starting. */
export function isTelemetryActive(): boolean {
  return runtime !== null || pending !== null;
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
  if (!rt) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      rt.forceFlush(timeoutMs),
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
