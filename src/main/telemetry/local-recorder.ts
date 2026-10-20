/**
 * Local telemetry recording (spec §6.12): the same `tel.*` signals written
 * to `~/.clubhouse/logs/telemetry-<start>.jsonl`, with no exporter and no
 * network. Runs whether or not an export destination is on.
 *
 * Everything written goes through the export pipeline's protections: the
 * attribute registry and its formats (redaction.ts), hashed ids (ids.ts),
 * the scrubber, message-free exception types and sanitized stacks. Metrics
 * are aggregated per interval, never written per call.
 *
 * No OpenTelemetry imports: part of the main bundle.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { randomBytes } from 'crypto';
import * as fsp from 'fs/promises';
import * as path from 'path';
import {
  ATTR,
  EVENTS,
  METRICS,
  SDK_ATTRIBUTE_KEYS,
  SPANS,
  levelAllows,
  type EventName,
  type MetricName,
  type SpanName,
  type TelAttr,
  type TelemetryLevel,
} from '../../shared/telemetry/attributes';
import { DEFAULT_SESSION_CAPS, SessionCaps } from './caps';
import { hashId } from './ids';
import { sanitizeAttribute, type AttrValue } from './redaction';
import { sanitizeStack, type Scrubber } from './scrubber';
import {
  errorTypeName,
  errorTypeOf,
  type Classification,
  type EventOptions,
  type ExceptionOptions,
  type FlowExtras,
  type FlowOptions,
  type LocalTelemetrySink,
  type ReplaySpan,
  type ReplayTree,
  type SpanHandle,
  type TraceIds,
} from './types';

export const LOCAL_FORMAT_VERSION = 1;
export const LOCAL_FILE_PREFIX = 'telemetry-';
export const LOCAL_FLUSH_INTERVAL_MS = 2_000;
export const LOCAL_FLUSH_AT_LINES = 100;
export const LOCAL_METRIC_INTERVAL_MS = 60_000;
export const LOCAL_MAX_CHUNK_BYTES = 2 * 1024 * 1024;
/** Rolling budget for one run's files: past it, the oldest chunks are deleted (#2297). */
export const LOCAL_MAX_SESSION_BYTES = 10 * 1024 * 1024;
/** The §6.4 item caps apply per window, so a long run keeps recording its tail. */
export const LOCAL_CAPS_WINDOW_MS = 60 * 60 * 1000;
export const LOCAL_MAX_PENDING_LINES = 1_000;
/** Same per-instrument limit as the SDK's metric views. */
export const LOCAL_METRIC_CARDINALITY_LIMIT = 200;

export interface LocalRecorderOptions {
  dir: string;
  /** Run timestamp shared by this run's chunk files. */
  fileBase: string;
  level: TelemetryLevel;
  hashSalt: Buffer;
  scrub: Scrubber;
  session: { appVersion: string; platform: string; arch: string };
  now?: () => number;
  flushIntervalMs?: number;
  metricIntervalMs?: number;
  maxChunkBytes?: number;
  maxSessionBytes?: number;
  maxPendingLines?: number;
  sessionCaps?: { traces: number; logs: number };
  capsWindowMs?: number;
  /** Called after the recorder starts a new chunk (local-control runs retention then). */
  onRotate?: () => void;
  /** Overrides for tests. */
  appendFile?: (file: string, data: string) => Promise<void>;
  mkdir?: (dir: string) => Promise<void>;
  unlink?: (file: string) => Promise<void>;
}

export interface LocalRecorder extends LocalTelemetrySink {
  /** Write any aggregated metrics and a drop summary, flush, and stop the timer. */
  stop(): Promise<void>;
  /** This run's files still on disk, oldest first; the last is being written. */
  files(): string[];
}

type Attrs = Record<string, AttrValue>;

interface Series {
  attrs: Attrs;
  count: number;
  sum: number;
  min: number;
  max: number;
  last: number;
}

interface MetricWindow {
  series: Map<string, Series>;
  overflow?: Series;
}

const newTraceId = (): string => randomBytes(16).toString('hex');
const newSpanId = (): string => randomBytes(8).toString('hex');

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return !!value && typeof (value as { then?: unknown }).then === 'function';
}

export function createLocalRecorder(opts: LocalRecorderOptions): LocalRecorder {
  const now = opts.now ?? Date.now;
  const level = opts.level;
  // Same rule as the SDK: Errors level still records flows, so failures have a duration.
  const spanLevel: TelemetryLevel = level === 'errors' ? 'standard' : level;
  const maxChunkBytes = opts.maxChunkBytes ?? LOCAL_MAX_CHUNK_BYTES;
  const maxSessionBytes = opts.maxSessionBytes ?? LOCAL_MAX_SESSION_BYTES;
  const maxPending = opts.maxPendingLines ?? LOCAL_MAX_PENDING_LINES;
  const metricInterval = opts.metricIntervalMs ?? LOCAL_METRIC_INTERVAL_MS;
  const appendFile = opts.appendFile ?? ((file: string, data: string) => fsp.appendFile(file, data, 'utf-8'));
  const mkdir = opts.mkdir ?? (async (dir: string) => {
    await fsp.mkdir(dir, { recursive: true });
  });
  const unlink = opts.unlink ?? ((file: string) => fsp.unlink(file));

  const als = new AsyncLocalStorage<TraceIds>();
  let caps = new SessionCaps(opts.sessionCaps ?? DEFAULT_SESSION_CAPS);
  const capsWindow = opts.capsWindowMs ?? LOCAL_CAPS_WINDOW_MS;

  let pending: string[] = [];
  let droppedLines = 0;
  let chunk = 0;
  let chunkBytes = 0;
  let stopped = false;
  let dirReady: Promise<void> | null = null;
  let chain: Promise<void> = Promise.resolve();
  let flushQueued = false;
  /** This run's chunks on disk, oldest first, with the bytes written to each. */
  const runFiles: Array<{ file: string; bytes: number }> = [];
  const runBytes = (): number => runFiles.reduce((sum, f) => sum + f.bytes, 0);
  const reportedDrops = { traces: 0, logs: 0, lines: 0 };

  let windowStart = now();
  let capsWindowStart = windowStart;
  let metrics = new Map<MetricName, MetricWindow>();

  const fileFor = (n: number): string =>
    path.join(opts.dir, n === 0 ? `${LOCAL_FILE_PREFIX}${opts.fileBase}.jsonl` : `${LOCAL_FILE_PREFIX}${opts.fileBase}.${n}.jsonl`);

  /**
   * Queue one line. `force` (metric aggregates and drop summaries) skips the
   * pending limit: they are already bounded, and a full window must not be
   * cut short.
   */
  function push(record: Record<string, unknown>, force = false): void {
    if (stopped) return;
    if (!force && pending.length >= maxPending) {
      droppedLines++;
      return;
    }
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      droppedLines++;
      return;
    }
    pending.push(line);
    if (pending.length >= LOCAL_FLUSH_AT_LINES && !flushQueued) void flushLines();
  }

  /** Append to the current chunk and track its size. */
  async function append(data: string, bytes: number): Promise<boolean> {
    const file = fileFor(chunk);
    try {
      await appendFile(file, data);
    } catch {
      return false;
    }
    const last = runFiles[runFiles.length - 1];
    if (last?.file === file) last.bytes += bytes;
    else runFiles.push({ file, bytes });
    chunkBytes += bytes;
    return true;
  }

  async function writeOut(): Promise<void> {
    flushQueued = false;
    if (pending.length === 0) return;
    const lines = pending;
    pending = [];
    if (!dirReady) dirReady = mkdir(opts.dir);
    try {
      await dirReady;
    } catch {
      dirReady = null;
      droppedLines += lines.length;
      return;
    }
    // Lines are grouped per chunk so a chunk only passes its limit when a
    // single line is larger than it.
    let batch: string[] = [];
    let batchBytes = 0;
    const writeBatch = async (): Promise<void> => {
      if (batch.length === 0) return;
      const data = batch.join('\n') + '\n';
      const n = batch.length;
      const bytes = batchBytes;
      batch = [];
      batchBytes = 0;
      if (!(await append(data, bytes))) droppedLines += n;
    };
    let rotated = false;
    for (let i = 0; i < lines.length; i++) {
      const bytes = Buffer.byteLength(lines[i], 'utf-8') + 1;
      if (chunkBytes + batchBytes > 0 && chunkBytes + batchBytes + bytes > maxChunkBytes) {
        await writeBatch();
        chunk++;
        chunkBytes = 0;
        rotated = true;
      }
      batch.push(lines[i]);
      batchBytes += bytes;
    }
    await writeBatch();
    await evictOverBudget();
    if (rotated) {
      try {
        opts.onRotate?.();
      } catch {
        // Retention is best effort.
      }
    }
  }

  /**
   * Rolling eviction (#2297): past the run budget, delete this run's oldest
   * chunks so recording keeps going and the newest data (where a hang or
   * failure is) is kept. The chunk being written is never removed. An
   * `evicted` line in the current chunk reports what went.
   */
  async function evictOverBudget(): Promise<void> {
    let files = 0;
    let bytes = 0;
    while (runFiles.length > 1 && runBytes() > maxSessionBytes) {
      const oldest = runFiles[0];
      try {
        await unlink(oldest.file);
      } catch {
        // Already gone (retention, the user) or locked: stop tracking it either way.
      }
      runFiles.shift();
      files++;
      bytes += oldest.bytes;
    }
    if (files === 0) return;
    const line = JSON.stringify({ t: 'evicted', ts: iso(now()), files, bytes, maxBytes: maxSessionBytes }) + '\n';
    await append(line, Buffer.byteLength(line, 'utf-8'));
  }

  function flushLines(): Promise<void> {
    flushQueued = true;
    chain = chain.then(writeOut, writeOut);
    return chain;
  }

  // --- Attributes ---

  function attrsOf(attrs: readonly TelAttr[] | undefined, allow?: readonly string[]): Attrs {
    const out: Attrs = {};
    if (!attrs) return out;
    for (const a of attrs) {
      if (allow && !allow.includes(a.key)) continue;
      try {
        const raw = a.kind === 'hash' ? hashId(opts.hashSalt, String(a.value)) : a.value;
        const clean = sanitizeAttribute(a.key, raw, opts.scrub);
        if (clean !== undefined) out[a.key] = clean;
      } catch {
        // An attribute that can't be validated is dropped, never written raw.
      }
    }
    return out;
  }

  /** ISO time; a value outside the Date range (a bad renderer time) falls back to now. */
  const iso = (ms: number): string => {
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? new Date(now()).toISOString() : d.toISOString();
  };

  // --- Spans ---

  function writeSpan(
    name: SpanName,
    ids: TraceIds,
    parentSpanId: string | undefined,
    startMs: number,
    endMs: number,
    attrs: readonly TelAttr[],
    outcome: ReplaySpan['outcome'],
    errorType: ReplaySpan['errorType'],
  ): void {
    if (!caps.tryAcquire('traces')) return;
    const record: Record<string, unknown> = {
      t: 'span',
      ts: iso(endMs),
      name,
      traceId: ids.traceId,
      spanId: ids.spanId,
    };
    if (parentSpanId) record.parentSpanId = parentSpanId;
    record.startMs = startMs;
    record.durationMs = Math.max(0, endMs - startMs);
    // Through the registry like the SDK's outcome and error.type attributes.
    const clean = attrsOf([ATTR.outcome(outcome), ...(errorType ? [ATTR.errorType(errorType)] : [])]);
    record.outcome = clean[ATTR.outcome('ok').key] ?? 'other';
    if (errorType) record.errorType = clean[ATTR.errorType('unknown').key] ?? 'other';
    record.attrs = attrsOf(attrs);
    push(record);
  }

  /** Ids for a new span: a registered root starts its own trace, anything else joins the active one. */
  function idsFor(name: SpanName, parent: TraceIds | undefined): { ids: TraceIds; parentSpanId?: string } {
    if (SPANS[name].root || !parent) return { ids: { traceId: newTraceId(), spanId: newSpanId() } };
    return { ids: { traceId: parent.traceId, spanId: newSpanId() }, parentSpanId: parent.spanId };
  }

  function outcomeOf(c: Classification): Pick<ReplaySpan, 'outcome' | 'errorType'> {
    if (c === 'ok') return { outcome: 'ok' };
    if ('error' in c) return { outcome: 'error', errorType: c.error };
    return { outcome: c.outcome };
  }

  function wrap<T>(name: SpanName, flowOpts: FlowOptions, fn: (s: SpanHandle) => T, extras?: FlowExtras<T>): (s: SpanHandle) => T {
    return (outer) => {
      if (stopped || !levelAllows(spanLevel, SPANS[name].level)) return fn(outer);
      const { ids, parentSpanId } = idsFor(name, als.getStore());
      const startMs = now();
      const attrs: TelAttr[] = [...(flowOpts.attrs ?? [])];
      const handle: SpanHandle = {
        set: (...a) => {
          outer.set(...a);
          attrs.push(...a);
        },
      };
      const end = (c: Classification): void => {
        try {
          const { outcome, errorType } = flowOpts.signal?.aborted ? { outcome: 'cancelled' as const, errorType: undefined } : outcomeOf(c);
          writeSpan(name, ids, parentSpanId, startMs, now(), attrs, outcome, errorType);
        } catch {
          // Recording must never change what the flow returns or throws.
        }
      };
      const classify = (r: Awaited<T>): Classification => {
        try {
          return extras?.classify ? extras.classify(r) : 'ok';
        } catch {
          return 'ok';
        }
      };
      const onError = (err: unknown): void => {
        try {
          if (!flowOpts.signal?.aborted) writeException(err, { origin: 'main', handled: false }, ids);
        } catch {
          // A hostile error object must not replace the caller's error.
        }
        end({ error: errorTypeOf(err) });
      };
      return als.run(ids, () => {
        let result: T;
        try {
          result = fn(handle);
        } catch (err) {
          onError(err);
          throw err;
        }
        if (isPromiseLike<Awaited<T>>(result)) {
          Promise.resolve(result).then((r) => end(classify(r)), onError);
          return result;
        }
        end(classify(result as Awaited<T>));
        return result;
      });
    };
  }

  function replaySpan(s: ReplaySpan, parent?: TraceIds): TraceIds | undefined {
    if (stopped || !levelAllows(spanLevel, SPANS[s.name].level)) return undefined;
    const { ids, parentSpanId } = parent
      ? { ids: { traceId: parent.traceId, spanId: newSpanId() }, parentSpanId: parent.spanId }
      : idsFor(s.name, als.getStore());
    writeSpan(s.name, ids, parentSpanId, s.startMs, s.endMs, s.attrs, s.outcome, s.errorType);
    return ids;
  }

  // --- Events and exceptions ---

  function withTrace(record: Record<string, unknown>, ids: TraceIds | undefined): Record<string, unknown> {
    if (ids) {
      record.traceId = ids.traceId;
      record.spanId = ids.spanId;
    }
    return record;
  }

  function writeException(error: unknown, exOpts: ExceptionOptions, ids: TraceIds | undefined): void {
    if (!levelAllows(level, EVENTS['clubhouse.exception'].level) || !caps.tryAcquire('logs')) return;
    const type = errorTypeName(error);
    const stack = sanitizeAttribute(
      SDK_ATTRIBUTE_KEYS.exceptionStacktrace,
      sanitizeStack(error instanceof Error ? error.stack : undefined, opts.scrub) ?? `at ${type}`,
      opts.scrub,
    );
    push(withTrace({
      t: 'exception',
      ts: iso(now()),
      // Validated the same way as the exported exception.type: a bare identifier.
      type: sanitizeAttribute(SDK_ATTRIBUTE_KEYS.exceptionType, type, opts.scrub) ?? 'Error',
      stack,
      attrs: attrsOf([ATTR.exceptionOrigin(exOpts.origin), ATTR.exceptionHandled(exOpts.handled), ...(exOpts.attrs ?? [])]),
    }, ids));
  }

  // --- Metrics ---

  function recordMetric(name: MetricName, value: number, attrs: readonly TelAttr[] | undefined): void {
    const def = METRICS[name];
    if (!levelAllows(level, def.level) || typeof value !== 'number' || !Number.isFinite(value)) return;
    const clean = attrsOf(attrs, def.attributes);
    const key = JSON.stringify(Object.keys(clean).sort().map((k) => [k, clean[k]]));
    let win = metrics.get(name);
    if (!win) {
      win = { series: new Map() };
      metrics.set(name, win);
    }
    let s = win.series.get(key);
    if (!s) {
      if (win.series.size >= LOCAL_METRIC_CARDINALITY_LIMIT) {
        s = win.overflow ??= { attrs: {}, count: 0, sum: 0, min: value, max: value, last: value };
      } else {
        s = { attrs: clean, count: 0, sum: 0, min: value, max: value, last: value };
        win.series.set(key, s);
      }
    }
    s.count++;
    s.sum += value;
    if (value < s.min) s.min = value;
    if (value > s.max) s.max = value;
    s.last = value;
  }

  function writeMetrics(): void {
    const endMs = now();
    const startMs = windowStart;
    const windows = metrics;
    metrics = new Map();
    windowStart = endMs;
    for (const [name, win] of windows) {
      const def = METRICS[name];
      const all = win.overflow ? [...win.series.values(), win.overflow] : [...win.series.values()];
      for (const s of all) {
        const record: Record<string, unknown> = {
          t: 'metric',
          ts: iso(endMs),
          name,
          kind: def.kind,
          startMs,
          durationMs: endMs - startMs,
          attrs: s.attrs,
        };
        if (def.unit) record.unit = def.unit;
        if (s === win.overflow) record.overflow = true;
        if (def.kind === 'counter') record.sum = s.sum;
        else if (def.kind === 'gauge') record.value = s.last;
        else Object.assign(record, { count: s.count, sum: s.sum, min: s.min, max: s.max });
        push(record, true);
      }
    }
  }

  // --- Lifecycle ---

  /** A `dropped` line with what was dropped since the last one, if anything. */
  function writeDrops(): void {
    const total = { traces: caps.dropped('traces'), logs: caps.dropped('logs'), lines: droppedLines };
    const delta = {
      traces: total.traces - reportedDrops.traces,
      logs: total.logs - reportedDrops.logs,
      lines: total.lines - reportedDrops.lines,
    };
    if (!delta.traces && !delta.logs && !delta.lines) return;
    Object.assign(reportedDrops, total);
    push({ t: 'dropped', ts: iso(now()), ...delta }, true);
  }

  /** Start a new item-cap window, after reporting what the last one dropped. */
  function rollCaps(): void {
    writeDrops();
    caps = new SessionCaps(opts.sessionCaps ?? DEFAULT_SESSION_CAPS);
    reportedDrops.traces = 0;
    reportedDrops.logs = 0;
    capsWindowStart = now();
  }

  push({
    t: 'session',
    v: LOCAL_FORMAT_VERSION,
    ts: iso(windowStart),
    appVersion: opts.session.appVersion,
    platform: opts.session.platform,
    arch: opts.session.arch,
    level,
  });

  const timer = setInterval(() => {
    try {
      if (now() - windowStart >= metricInterval) writeMetrics();
      if (now() - capsWindowStart >= capsWindow) rollCaps();
      void flushLines();
    } catch {
      // The timer must never throw.
    }
  }, opts.flushIntervalMs ?? LOCAL_FLUSH_INTERVAL_MS);
  timer.unref?.();

  return {
    level,
    wrap,

    count(name, value, attrs) {
      if (stopped) return;
      try {
        recordMetric(name, value, attrs);
      } catch {
        // Best effort, like every recorder entry point.
      }
    },

    event(name: EventName, attrs?: TelAttr[], evOpts?: EventOptions) {
      if (stopped || !levelAllows(level, EVENTS[name].level) || !caps.tryAcquire('logs')) return;
      push(withTrace({
        t: 'event',
        ts: iso(now()),
        name,
        severity: evOpts?.severity ?? 'info',
        attrs: attrsOf(attrs),
      }, als.getStore()));
    },

    exception(error, exOpts) {
      if (!stopped) writeException(error, exOpts, als.getStore());
    },

    replaySpan(s) {
      replaySpan(s);
    },

    replayTree({ root, children }: ReplayTree) {
      const rootIds = replaySpan(root);
      if (!rootIds) return;
      for (const c of children) replaySpan(c, rootIds);
    },

    activeTraceIds() {
      return als.getStore();
    },

    async flush() {
      // A final flush writes this window's aggregates and drops too, so an exit loses none.
      if (!stopped) {
        try {
          writeMetrics();
          writeDrops();
        } catch {
          // Flush what is queued either way.
        }
      }
      await flushLines();
    },

    async stop() {
      if (stopped) return;
      try {
        writeMetrics();
        writeDrops();
      } catch {
        // Stop either way.
      }
      stopped = true;
      clearInterval(timer);
      await flushLines();
    },

    files: () => runFiles.map((f) => f.file),
  };
}
