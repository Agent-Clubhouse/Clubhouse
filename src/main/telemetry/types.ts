/**
 * Contract between the always-loaded facade and the lazily loaded SDK
 * runtime. No OpenTelemetry imports here: this file is part of the main
 * bundle and must not pull the SDK chunk in.
 */
import type {
  ERROR_TYPES,
  EventName,
  MetricName,
  Outcome,
  SpanName,
  TelAttr,
  TelemetryLevel,
} from '../../shared/telemetry/attributes';
import type { PreviewItem } from './preview-tee';

export type ErrorType = (typeof ERROR_TYPES)[number];

export interface SpanHandle {
  set(...attrs: TelAttr[]): void;
}

export interface FlowOptions {
  attrs?: TelAttr[];
  /** Marks the flow `cancelled` if it aborts before `fn` settles. */
  signal?: AbortSignal;
}

/** Return-value classification for flows that fail without throwing. */
export type Classification = 'ok' | { error: ErrorType } | { outcome: Exclude<Outcome, 'error'> };

export interface FlowExtras<T> {
  classify?: (result: Awaited<T>) => Classification;
}

/** Bridged appLog records keep their level (spec §6.6); events default to info. */
export type EventSeverity = 'info' | 'warn' | 'error' | 'fatal';

export interface EventOptions {
  severity?: EventSeverity;
}

export interface TraceIds {
  traceId: string;
  spanId: string;
}

export interface ExceptionOptions {
  origin: 'main' | 'renderer' | 'plugin';
  handled: boolean;
  /** Extra registry attributes, e.g. the window kind or error boundary. */
  attrs?: TelAttr[];
}

/** A span recorded before the SDK was ready, replayed with explicit times. */
export interface ReplaySpan {
  name: SpanName;
  startMs: number;
  endMs: number;
  attrs: TelAttr[];
  outcome: Outcome;
  errorType?: ErrorType;
}

/** One exporter result, kept briefly for the Settings test event. */
export interface ExportRecord {
  signal: 'traces' | 'metrics' | 'logs';
  /** The destination id the batch went to. */
  destination?: string;
  ok: boolean;
  /** Epoch ms when the result arrived. */
  at: number;
  httpStatus?: number;
  /** Error code (`ENOTFOUND`, `CERT_HAS_EXPIRED`, ...) or name. */
  errorCode?: string;
  errorMessage?: string;
}

export interface DestinationHealthRecord {
  lastSuccessAt?: number;
  lastFailureAt?: number;
  /** The most recent failed export among signals whose latest export failed. */
  lastFailure?: ExportRecord;
}

/** A root span and its direct children, all with explicit times (startup, shutdown). */
export interface ReplayTree {
  root: ReplaySpan;
  children: ReplaySpan[];
}

export interface TelemetryRuntime {
  readonly level: TelemetryLevel;
  flow<T>(name: SpanName, opts: FlowOptions, fn: (span: SpanHandle) => T, extras?: FlowExtras<T>): T;
  step<T>(name: SpanName, fn: (span: SpanHandle) => T, opts?: FlowOptions): T;
  count(name: MetricName, value: number, attrs?: TelAttr[]): void;
  event(name: EventName, attrs?: TelAttr[], opts?: EventOptions): void;
  exception(error: unknown, opts: ExceptionOptions): void;
  /** The active span's ids, for correlating local log lines with exported traces. */
  activeTraceIds(): TraceIds | undefined;
  replaySpan(span: ReplaySpan): void;
  replayTree(tree: ReplayTree): void;
  /** W3C `traceparent` of the active recording span, for Annex propagation (spec §7). */
  traceparent(): string | undefined;
  /**
   * Run `fn` so that the next root flow it starts continues the remote trace
   * in `traceparent` (once; later root flows start their own traces).
   */
  withRemoteParent<T>(traceparent: string, fn: () => T): T;
  preview(): PreviewItem[];
  /** Export results that arrived at or after `sinceMs`, oldest first. */
  recentExports(sinceMs: number): ExportRecord[];
  /** Per destination id: the latest success and failure this session. */
  destinationHealth(): Record<string, DestinationHealthRecord>;
  forceFlush(timeoutMs: number): Promise<void>;
  shutdown(timeoutMs: number): Promise<void>;
}

/**
 * The local recorder (local-recorder.ts) as the facade sees it. It runs next
 * to any SDK runtime and needs no OpenTelemetry.
 */
export interface LocalTelemetrySink {
  readonly level: TelemetryLevel;
  /** Wrap a span body so it is timed and recorded locally; the handle passed in still receives every attribute. */
  wrap<T>(name: SpanName, opts: FlowOptions, fn: (span: SpanHandle) => T, extras?: FlowExtras<T>): (span: SpanHandle) => T;
  count(name: MetricName, value: number, attrs?: TelAttr[]): void;
  event(name: EventName, attrs?: TelAttr[], opts?: EventOptions): void;
  exception(error: unknown, opts: ExceptionOptions): void;
  replaySpan(span: ReplaySpan): void;
  replayTree(tree: ReplayTree): void;
  activeTraceIds(): TraceIds | undefined;
  flush(): Promise<void>;
}

export const NOOP_SPAN: SpanHandle = { set: () => {} };

const ERROR_TYPE_TAG = Symbol.for('clubhouse.telemetry.error_type');

/**
 * Attach a registry error type to an error before it is thrown, so a flow
 * or step it escapes from records that type instead of `unknown`. The first
 * tag wins: an inner, more specific tag is never overwritten. Returns the
 * same error.
 */
export function tagError<E>(error: E, type: ErrorType): E {
  if (typeof error === 'object' && error !== null && !(ERROR_TYPE_TAG in error)) {
    try {
      Object.defineProperty(error, ERROR_TYPE_TAG, { value: type, enumerable: false });
    } catch {
      // Frozen objects stay untagged.
    }
  }
  return error;
}

/** The error type a thrown value was tagged with, or `unknown`. */
export function errorTypeOf(error: unknown): ErrorType {
  if (typeof error === 'object' && error !== null && ERROR_TYPE_TAG in error) {
    return (error as Record<symbol, ErrorType>)[ERROR_TYPE_TAG];
  }
  return 'unknown';
}

/**
 * An error reported from another process (a renderer or plugin). It carries
 * the original constructor name and raw stack; the message is never sent
 * across, so it is always empty here.
 */
export class ForwardedError extends Error {
  constructor(
    readonly forwardedType: string,
    stack: string | undefined,
  ) {
    super('');
    this.name = forwardedType;
    this.stack = stack;
  }
}

/** The exported `exception.type`: a constructor name, never the message. */
export function errorTypeName(error: unknown): string {
  if (error instanceof ForwardedError) {
    return /^[A-Za-z_$][\w$.]{0,63}$/.test(error.forwardedType) ? error.forwardedType : 'Error';
  }
  if (error instanceof Error) {
    const name = error.constructor?.name || error.name;
    return /^[A-Za-z_$][\w$.]{0,63}$/.test(name) ? name : 'Error';
  }
  return typeof error === 'object' && error !== null ? 'Object' : typeof error;
}
