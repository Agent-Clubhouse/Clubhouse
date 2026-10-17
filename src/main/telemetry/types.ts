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

export interface ExceptionOptions {
  origin: 'main' | 'renderer' | 'plugin';
  handled: boolean;
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

export interface TelemetryRuntime {
  readonly level: TelemetryLevel;
  flow<T>(name: SpanName, opts: FlowOptions, fn: (span: SpanHandle) => T, extras?: FlowExtras<T>): T;
  step<T>(name: SpanName, fn: (span: SpanHandle) => T, opts?: FlowOptions): T;
  count(name: MetricName, value: number, attrs?: TelAttr[]): void;
  event(name: EventName, attrs?: TelAttr[]): void;
  exception(error: unknown, opts: ExceptionOptions): void;
  replaySpan(span: ReplaySpan): void;
  preview(): PreviewItem[];
  forceFlush(timeoutMs: number): Promise<void>;
  shutdown(timeoutMs: number): Promise<void>;
}

export const NOOP_SPAN: SpanHandle = { set: () => {} };

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
