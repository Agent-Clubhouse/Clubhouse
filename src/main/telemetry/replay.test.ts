import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { AggregationTemporality, DataPointType } from '@opentelemetry/sdk-metrics';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { ATTR } from '../../shared/telemetry/attributes';
import { createLocalRecorder } from './local-recorder';
import { createScrubber } from './scrubber';
import { convertRecordLines } from './replay';

const scrub = createScrubber({ homeDir: '/Users/sam', username: 'sam', hostname: 'sams-laptop' });
const resource = resourceFromAttributes({ 'service.name': 'clubhouse' });
const DETAIL_CANARY = 'detail-canary-replay';
const RAW_ID = 'raw-agent-id-replay';
const DIAG_CANARY = 'DIAG-CANARY-REPLAY';
const T0 = Date.parse('2026-11-08T10:00:00.000Z');

const session = (extra: object = {}) => JSON.stringify({ t: 'session', v: 4, ts: '2026-11-08T10:00:00.000Z', appVersion: '1.0.0', platform: 'darwin', arch: 'arm64', uiChrome: 'v2', level: 'standard', scope: 'clubhouse', temporality: 'delta', ...extra });
const span = JSON.stringify({ t: 'span', ts: '2026-11-08T10:00:01.000Z', name: 'clubhouse.annex.rest', traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), parentSpanId: 'c'.repeat(16), startMs: T0, durationMs: 250, outcome: 'error', errorType: 'timeout', attrs: { 'clubhouse.audit.surface': 'ui', 'not.registered': 'x' } });
const event = JSON.stringify({ t: 'event', ts: '2026-11-08T10:00:02.000Z', name: 'clubhouse.audit.setting', severity: 'warn', traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), attrs: { 'clubhouse.audit.outcome': 'refused' }, detail: { key: DETAIL_CANARY } });
const exception = JSON.stringify({ t: 'exception', ts: '2026-11-08T10:00:03.000Z', type: 'TypeError', stack: 'TypeError\n    at f (/Users/sam/app.js:1:1)', attrs: { 'clubhouse.exception.origin': 'main', 'clubhouse.exception.handled': true } });
const counter = (startMs: number, sum: number) => JSON.stringify({ t: 'metric', ts: 'x', name: 'clubhouse.app.sessions', kind: 'counter', startMs, durationMs: 60_000, attrs: { 'clubhouse.startup.kind': 'cold' }, sum });
const gauge = JSON.stringify({ t: 'metric', ts: 'x', name: 'clubhouse.process.memory', kind: 'gauge', startMs: T0, durationMs: 60_000, attrs: {}, value: 512 });
const histogram = (startMs: number) => JSON.stringify({ t: 'metric', ts: 'x', name: 'clubhouse.persist.write.duration', kind: 'histogram', startMs, durationMs: 60_000, attrs: { 'clubhouse.persist.store': 'projects' }, count: 2, sum: 0.3, min: 0.1, max: 0.2 });
const diag = JSON.stringify({ t: 'diag', ts: '2026-11-08T10:00:04.000Z', ns: 'core:test', level: 'error', msg: `${DIAG_CANARY} failed` });
const bookkeeping = [JSON.stringify({ t: 'evicted', ts: 'x', files: 1, bytes: 1, maxBytes: 1 }), JSON.stringify({ t: 'dropped', ts: 'x', traces: 0, logs: 1, lines: 0, diag: 0 })];

/** Every string reachable from the result, functions called for span contexts, without the resource. */
function strings(value: unknown, seen = new Set<unknown>()): string[] {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object' || seen.has(value) || value === resource) return [];
  seen.add(value);
  return Object.values(value).flatMap((v) => strings(typeof v === 'function' ? (v as () => unknown)() : v, seen));
}

describe('convertRecordLines (#2920)', () => {
  it('builds spans, log records and metrics from a v4 run, and never puts out diag lines, detail or unknown attributes', () => {
    const result = convertRecordLines([session(), span, event, exception, counter(T0, 2), gauge, histogram(T0), diag, ...bookkeeping, '{"torn'], { resource, temporality: 'delta', scrub });
    expect(result.skipped).toBe(4);

    expect(result.spans).toHaveLength(1);
    const [s] = result.spans;
    expect(s.name).toBe('clubhouse.annex.rest');
    expect(s.spanContext().traceId).toBe('a'.repeat(32));
    expect(s.parentSpanContext?.spanId).toBe('c'.repeat(16));
    expect(s.attributes).toEqual({ 'clubhouse.audit.surface': 'ui', 'clubhouse.outcome': 'error', 'error.type': 'timeout' });
    expect(s.status.code).toBe(2);
    expect(s.instrumentationScope.name).toBe('clubhouse');
    expect(s.resource).toBe(resource);

    expect(result.logs.map((l) => l.eventName)).toEqual(['clubhouse.audit.setting', 'clubhouse.exception']);
    const [ev, ex] = result.logs;
    expect(ev.attributes).toEqual({ 'clubhouse.audit.outcome': 'refused', 'microsoft.custom_event.name': 'clubhouse.audit.setting' });
    expect(ev.severityText).toBe('WARN');
    expect(ev.spanContext?.spanId).toBe('b'.repeat(16));
    expect(ex.attributes['exception.type']).toBe('TypeError');
    expect(ex.attributes['exception.message']).toBe('TypeError');
    expect(String(ex.attributes['exception.stacktrace'])).not.toContain('/Users/sam');

    const [{ metrics }] = result.metrics.scopeMetrics;
    expect(metrics.map((m) => [m.descriptor.name, m.dataPointType, m.aggregationTemporality])).toEqual([
      ['clubhouse.app.sessions', DataPointType.SUM, AggregationTemporality.DELTA],
      ['clubhouse.process.memory', DataPointType.GAUGE, AggregationTemporality.DELTA],
      ['clubhouse.persist.write.duration', DataPointType.HISTOGRAM, AggregationTemporality.DELTA],
    ]);
    expect(metrics[2].dataPoints[0].value).toEqual({ count: 2, sum: 0.3, min: 0.1, max: 0.2, buckets: { boundaries: [], counts: [2] } });

    const all = strings(result).join('\n');
    expect(all).not.toContain(DETAIL_CANARY);
    expect(all).not.toContain(DIAG_CANARY);
    expect(all).not.toContain('not.registered');
  });

  it('turns per-window counters and histograms into running totals for a cumulative destination', () => {
    const lines = [session(), counter(T0, 2), counter(T0 + 60_000, 3), histogram(T0), histogram(T0 + 60_000)];
    const [{ metrics }] = convertRecordLines(lines, { resource, temporality: 'cumulative', scrub }).metrics.scopeMetrics;
    const [sessions, writes] = metrics;
    expect(sessions.aggregationTemporality).toBe(AggregationTemporality.CUMULATIVE);
    expect(sessions.dataPoints.map((p) => p.value)).toEqual([2, 5]);
    expect(sessions.dataPoints[1].startTime).toEqual(sessions.dataPoints[0].startTime);
    expect(writes.dataPoints.map((p) => (p.value as { count: number }).count)).toEqual([2, 4]);
  });

  it('converts a v3 run on the documented assumption, and skips a run recorded some other way', () => {
    const v3 = session({ v: 3, scope: undefined, temporality: undefined });
    expect(convertRecordLines([v3, counter(T0, 1), event], { resource, temporality: 'delta', scrub })).toMatchObject({ skipped: 0, logs: [expect.anything()] });
    // A run with no session line (a later chunk read on its own) is a v3-or-later run: the same assumption.
    expect(convertRecordLines([counter(T0, 1)], { resource, temporality: 'delta', scrub }).skipped).toBe(0);
    const other = convertRecordLines([session({ v: 5, temporality: 'cumulative' }), counter(T0, 1), event], { resource, temporality: 'delta', scrub });
    expect(other).toMatchObject({ skipped: 2, spans: [], logs: [] });
    expect(other.metrics.scopeMetrics).toEqual([]);
  });

  it('keeps detail and raw ids out, end to end from a real recorder', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-'));
    try {
      const rec = createLocalRecorder({
        dir, fileBase: '2026-11-08T10-00-00.000', level: 'standard', hashSalt: Buffer.alloc(32, 4), scrub,
        session: { appVersion: '1.0.0', platform: 'darwin', arch: 'arm64', uiChrome: 'v2' }, flushIntervalMs: 60_000,
      });
      rec.event('clubhouse.audit.dispatcher_control', [ATTR.auditTool('connect_orchestrators'), ATTR.auditOutcome('ok'), ATTR.auditActorIdHash(RAW_ID)], {
        detail: { tool: 'connect_orchestrators', code: DETAIL_CANARY }, detailIds: { targets: [RAW_ID] },
      });
      rec.writeDiag({ ns: 'core:test', level: 'error', msg: DIAG_CANARY });
      await rec.stop();
      const lines = fs.readdirSync(dir).flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf-8').split('\n').filter(Boolean));
      // The file holds the detail and the diag line (local only), and the id only hashed.
      const file = lines.join('\n');
      expect(file).toContain(DETAIL_CANARY);
      expect(file).toContain(DIAG_CANARY);
      expect(file).not.toContain(RAW_ID);
      const result = convertRecordLines(lines, { resource, temporality: 'delta', scrub });
      expect(result.logs.map((l) => l.eventName)).toEqual(['clubhouse.audit.dispatcher_control']);
      const all = strings(result).join('\n');
      expect(all).not.toContain(DETAIL_CANARY);
      expect(all).not.toContain(RAW_ID);
      expect(all).not.toContain(DIAG_CANARY);
      expect(result.logs[0].attributes['clubhouse.audit.actor.id_hash']).toMatch(/^[0-9a-f]{16}$/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('replay through the real OTLP exporters (#2920)', () => {
  let server: http.Server | undefined;
  afterEach(() => new Promise<void>((resolve) => { if (server) server.close(() => resolve()); else resolve(); }));

  it('the converted data is accepted as OTLP JSON, with no detail or diag text in it', async () => {
    const bodies: Array<{ url: string; body: string }> = [];
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { bodies.push({ url: req.url ?? '', body }); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    const base = `http://127.0.0.1:${port}`;
    const result = convertRecordLines([session(), span, event, exception, counter(T0, 2), gauge, histogram(T0), diag], { resource, temporality: 'cumulative', scrub });

    const done = (exp: { export: (items: never, cb: (r: { code: number; error?: Error }) => void) => void }, items: unknown) =>
      new Promise<number>((resolve) => exp.export(items as never, (r) => resolve(r.code)));
    expect(await done(new OTLPTraceExporter({ url: `${base}/v1/traces` }), result.spans)).toBe(0);
    expect(await done(new OTLPLogExporter({ url: `${base}/v1/logs` }), result.logs)).toBe(0);
    expect(await done(new OTLPMetricExporter({ url: `${base}/v1/metrics` }), result.metrics)).toBe(0);

    expect(bodies.map((b) => b.url).sort()).toEqual(['/v1/logs', '/v1/metrics', '/v1/traces']);
    const all = bodies.map((b) => b.body).join('\n');
    expect(all).toContain('clubhouse.annex.rest');
    expect(all).toContain('clubhouse.audit.setting');
    expect(all).toContain('clubhouse.persist.write.duration');
    expect(all).not.toContain(DETAIL_CANARY);
    expect(all).not.toContain(DIAG_CANARY);
  }, 30_000);
});
