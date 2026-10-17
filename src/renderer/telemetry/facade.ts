/**
 * Renderer telemetry facade (spec §6.2). Same call shape as the main-process
 * `tel`, but there is no SDK here: items are batched and sent to main over
 * `telemetry:emit`, where they are re-validated and exported.
 *
 * While telemetry is off (the default), every call is one boolean check and
 * flows run `fn` directly. Main tells us the state at startup and whenever it
 * changes.
 */
import {
  EVENTS,
  METRICS,
  SPANS,
  levelAllows,
  type EventName,
  type MetricName,
  type Outcome,
  type SpanName,
  type TelAttr,
} from '../../shared/telemetry/attributes';
import {
  DISABLED_STATE,
  MAX_RENDERER_STACK_CHARS,
  RENDERER_PROTOCOL_VERSION,
  parseTelemetryState,
  type ErrorTypeValue,
  type RendererItem,
  type TelemetryState,
} from '../../shared/telemetry/renderer-protocol';

export const FLUSH_INTERVAL_MS = 2000;
export const FLUSH_AT_ITEMS = 50;
/** Hard cap on queued items between flushes; extra items are dropped. */
export const MAX_QUEUED_ITEMS = 500;

export interface SpanHandle {
  set(...attrs: TelAttr[]): void;
}

export interface FlowOptions {
  attrs?: TelAttr[];
  /** Marks the flow `cancelled` if it aborts before `fn` settles. */
  signal?: AbortSignal;
}

export type Classification = 'ok' | { error: ErrorTypeValue } | { outcome: Exclude<Outcome, 'error'> };

export interface FlowExtras<T> {
  classify?: (result: Awaited<T>) => Classification;
}

export interface ExceptionOptions {
  origin?: 'renderer' | 'plugin';
  handled: boolean;
  attrs?: TelAttr[];
}

interface Bridge {
  emit(batch: { v: typeof RENDERER_PROTOCOL_VERSION; items: RendererItem[] }): void;
  getState(): Promise<unknown>;
  onStateChanged(cb: (state: unknown) => void): () => void;
  rendererReady(): void;
}

const NOOP_SPAN: SpanHandle = { set: () => {} };

let state: TelemetryState = DISABLED_STATE;
let bridge: Bridge | null = null;
let queue: RendererItem[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let unsubscribe: (() => void) | null = null;
let readySent = false;

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return !!value && typeof (value as { then?: unknown }).then === 'function';
}

function enqueue(item: RendererItem): void {
  if (!state.enabled || !bridge) return;
  if (queue.length >= MAX_QUEUED_ITEMS) return;
  queue.push(item);
  if (queue.length >= FLUSH_AT_ITEMS) flushTelemetry();
  else if (!timer) timer = setTimeout(flushTelemetry, FLUSH_INTERVAL_MS);
}

/** Send everything queued now. Safe to call at any time. */
export function flushTelemetry(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!bridge || queue.length === 0) return;
  const items = queue;
  queue = [];
  try {
    bridge.emit({ v: RENDERER_PROTOCOL_VERSION, items });
  } catch {
    // Telemetry must never throw into app code.
  }
}

function setState(next: TelemetryState): void {
  state = next;
  if (!state.enabled) {
    queue = [];
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }
}

/**
 * Keep only the `at ...` frame lines. V8 puts `Type: message` on the first
 * line(s) of `error.stack`, and the message must never leave the renderer.
 * Main sanitizes the frames again before export.
 */
export function stackFramesOnly(stack: string | undefined): string | undefined {
  if (!stack) return undefined;
  const frames = stack.split(/\r?\n/).filter((line) => /^\s*at\s/.test(line));
  if (frames.length === 0) return undefined;
  return frames.join('\n').slice(0, MAX_RENDERER_STACK_CHARS);
}

function errorTypeOf(error: unknown): string {
  if (error instanceof Error) return error.constructor?.name || error.name || 'Error';
  return typeof error === 'object' && error !== null ? 'Object' : typeof error;
}

function spanAllowed(name: SpanName): boolean {
  if (!state.enabled || !state.level) return false;
  // At Errors level main keeps only failing flows, so they must still be recorded.
  const effective = state.level === 'errors' ? 'standard' : state.level;
  return levelAllows(effective, SPANS[name].level);
}

function runSpan<T>(name: SpanName, opts: FlowOptions, fn: (s: SpanHandle) => T, extras?: FlowExtras<T>): T {
  if (!spanAllowed(name)) return fn(NOOP_SPAN);
  const startMs = Date.now();
  const attrs: TelAttr[] = [...(opts.attrs ?? [])];
  const handle: SpanHandle = { set: (...a) => attrs.push(...a) };
  const finish = (c: Classification): void => {
    const item: Extract<RendererItem, { t: 'span' }> = {
      t: 'span',
      name,
      startMs,
      endMs: Date.now(),
      attrs,
      outcome: 'ok',
    };
    if (opts.signal?.aborted) item.outcome = 'cancelled';
    else if (c !== 'ok') {
      if ('error' in c) {
        item.outcome = 'error';
        item.errorType = c.error;
      } else item.outcome = c.outcome;
    }
    enqueue(item);
  };
  const classify = (r: Awaited<T>): Classification => {
    try {
      return extras?.classify ? extras.classify(r) : 'ok';
    } catch {
      return 'ok';
    }
  };
  const onError = (err: unknown): void => {
    if (opts.signal?.aborted) {
      finish({ outcome: 'cancelled' });
      return;
    }
    tel.exception(err, { handled: false });
    finish({ error: 'unknown' });
  };
  let result: T;
  try {
    result = fn(handle);
  } catch (err) {
    onError(err);
    throw err;
  }
  if (isPromiseLike<Awaited<T>>(result)) {
    Promise.resolve(result).then((r) => finish(classify(r)), onError);
    return result;
  }
  finish(classify(result as Awaited<T>));
  return result;
}

export const tel = {
  /** A root user-flow span measured in this renderer. Errors are recorded and rethrown unchanged. */
  flow<T>(name: SpanName, opts: FlowOptions, fn: (span: SpanHandle) => T, extras?: FlowExtras<T>): T {
    return runSpan(name, opts, fn, extras);
  },

  /**
   * A sub-step span. In v1 renderer steps are exported as their own spans
   * (no parent link); cross-process trace context is a later addition.
   */
  step<T>(name: SpanName, fn: (span: SpanHandle) => T, opts: FlowOptions = {}): T {
    return runSpan(name, opts, fn);
  },

  count(name: MetricName, value = 1, attrs: TelAttr[] = []): void {
    if (!state.enabled || !state.level || !levelAllows(state.level, METRICS[name].level)) return;
    enqueue({ t: 'count', name, value, attrs });
  },

  event(name: EventName, attrs: TelAttr[] = []): void {
    if (!state.enabled || !state.level || !levelAllows(state.level, EVENTS[name].level)) return;
    enqueue({ t: 'event', name, attrs });
  },

  /** Report an error. Only its class name and stack leave the renderer; main sanitizes the stack. */
  exception(error: unknown, opts: ExceptionOptions): void {
    if (!state.enabled) return;
    const stack = error instanceof Error && typeof error.stack === 'string' ? stackFramesOnly(error.stack) : undefined;
    enqueue({
      t: 'exception',
      errorType: errorTypeOf(error),
      stack,
      origin: opts.origin ?? 'renderer',
      handled: opts.handled,
      attrs: opts.attrs ?? [],
    });
  },
};

/** True while main says telemetry is on. Lets callers skip expensive setup. */
export function isTelemetryEnabled(): boolean {
  return state.enabled;
}

/**
 * Connect to main. Call once at renderer startup. Does nothing when the
 * preload bridge is absent (tests, plugin sandboxes).
 */
export function initRendererTelemetry(source: Bridge | undefined = (globalThis as { clubhouse?: { telemetry?: Bridge } })
  .clubhouse?.telemetry): void {
  if (!source || bridge) return;
  bridge = source;
  try {
    unsubscribe = bridge.onStateChanged((s) => setState(parseTelemetryState(s)));
    bridge.getState().then((s) => setState(parseTelemetryState(s))).catch(() => {});
  } catch {
    // A broken bridge leaves telemetry off.
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', flushTelemetry);
  }
}

/** Tell main the app finished initializing. Main window only; sent once. */
export function markRendererReady(): void {
  if (readySent || !bridge) return;
  readySent = true;
  try {
    bridge.rendererReady();
  } catch {
    // Never break startup for telemetry.
  }
}

/** Test-only reset. */
export function _resetRendererTelemetryForTests(): void {
  if (timer) clearTimeout(timer);
  unsubscribe?.();
  state = DISABLED_STATE;
  bridge = null;
  queue = [];
  timer = null;
  unsubscribe = null;
  readySent = false;
}

/** Test-only: force a state without a bridge round trip. */
export function _setStateForTests(next: TelemetryState): void {
  setState(next);
}
