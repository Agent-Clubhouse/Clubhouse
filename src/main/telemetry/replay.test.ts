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
    const result = convertRecordLines([session(), span, event, exception, counter(T0, 2), gauge, histogram(T0), diag, ...bookkeeping, '{"torn'], { resource: () => resource, temporality: 'delta', scrub });
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
    const [{ metrics }] = convertRecordLines(lines, { resource: () => resource, temporality: 'cumulative', scrub }).metrics.scopeMetrics;
    const [sessions, writes] = metrics;
    expect(sessions.aggregationTemporality).toBe(AggregationTemporality.CUMULATIVE);
    expect(sessions.dataPoints.map((p) => p.value)).toEqual([2, 5]);
    expect(sessions.dataPoints[1].startTime).toEqual(sessions.dataPoints[0].startTime);
    expect(writes.dataPoints.map((p) => (p.value as { count: number }).count)).toEqual([2, 4]);
  });

  it('converts a v3 run on the documented assumption, and skips a run recorded some other way', () => {
    const v3 = session({ v: 3, scope: undefined, temporality: undefined });
    expect(convertRecordLines([v3, counter(T0, 1), event], { resource: () => resource, temporality: 'delta', scrub })).toMatchObject({ skipped: 0, logs: [expect.anything()] });
    // A run with no session line (a later chunk read on its own) is a v3-or-later run: the same assumption.
    expect(convertRecordLines([counter(T0, 1)], { resource: () => resource, temporality: 'delta', scrub }).skipped).toBe(0);
    const other = convertRecordLines([session({ v: 5, temporality: 'cumulative' }), counter(T0, 1), event], { resource: () => resource, temporality: 'delta', scrub });
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
      const result = convertRecordLines(lines, { resource: () => resource, temporality: 'delta', scrub });
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

  it('replays a change-only gauge as exactly its recorded points: no filled-in minutes, and the heartbeat kept (#3125)', async () => {
    const files = new Map<string, string>();
    let t = T0;
    const rec = createLocalRecorder({
      dir: '/logs', fileBase: 'gauges', level: 'standard', hashSalt: Buffer.alloc(32, 4), scrub, now: () => t,
      session: { appVersion: '1.0.0', platform: 'darwin', arch: 'arm64', uiChrome: 'v2' }, flushIntervalMs: 60_000,
      appendFile: async (file, data) => { files.set(file, (files.get(file) ?? '') + data); }, mkdir: async () => {},
    });
    // Twenty minutes of a value that changes once: lines at minutes 1, 5 and the heartbeat at 20.
    for (let m = 1; m <= 20; m++) {
      rec.count('clubhouse.projects.count', m >= 5 ? 6 : 5);
      t = T0 + m * 60_000;
      await rec.flush();
    }
    await rec.stop();
    const lines = [...files.values()].join('').split('\n').filter(Boolean);
    const recorded = lines.map((l) => JSON.parse(l)).filter((r) => r.t === 'metric');
    expect(recorded.map((r) => [(r.startMs + r.durationMs - T0) / 60_000, r.value])).toEqual([[1, 5], [5, 6], [20, 6]]);
    for (const temporality of ['delta', 'cumulative'] as const) {
      const [{ metrics }] = convertRecordLines(lines, { resource: () => resource, temporality, scrub }).metrics.scopeMetrics;
      expect(metrics).toHaveLength(1);
      expect(metrics[0].dataPointType).toBe(DataPointType.GAUGE);
      // One point per line, each at the window it was measured in; the repeated heartbeat value is not merged away.
      expect(metrics[0].dataPoints.map((p) => [(p.endTime[0] * 1000 + p.endTime[1] / 1e6 - T0) / 60_000, p.value])).toEqual([[1, 5], [5, 6], [20, 6]]);
    }
  });
});

describe('convertRecordLines: what each destination gets (#2920 review)', () => {
  const report = JSON.stringify({ t: 'event', ts: '2026-11-08T10:00:05.000Z', name: 'clubhouse.feedback.submitted', severity: 'info', attrs: { 'feedback.report.id': '11111111-2222-4333-8444-555555555555' } });

  it('leaves out attributes only the developer destination may get, unless it is the developer destination', () => {
    const other = convertRecordLines([session(), report], { resource: () => resource, temporality: 'delta', scrub });
    expect(other.logs[0].attributes).not.toHaveProperty('feedback.report.id');
    const dev = convertRecordLines([session(), report], { resource: () => resource, temporality: 'delta', scrub, framebriar: true });
    expect(dev.logs[0].attributes['feedback.report.id']).toBe('11111111-2222-4333-8444-555555555555');
  });

  it("copies the destination's item attributes onto spans and log records, never metrics", () => {
    const user = { 'enduser.pseudo.id': '99999999-8888-4777-8666-555555555555' };
    const result = convertRecordLines([session(), span, event, exception, counter(T0, 1)], { resource: () => resource, temporality: 'delta', scrub, itemAttributes: user });
    expect(result.spans[0].attributes).toMatchObject(user);
    for (const log of result.logs) expect(log.attributes).toMatchObject(user);
    expect(result.metrics.scopeMetrics[0].metrics[0].dataPoints[0].attributes).not.toHaveProperty('enduser.pseudo.id');
  });

  it("gives each run its own resource from its session line, and starts cumulative totals again at a new run", () => {
    const runs: unknown[] = [];
    const lines = [session({ appVersion: '1.0.0' }), counter(T0, 2), session({ appVersion: '1.1.0', serviceInstanceId: 'inst-2' }), counter(T0 + 120_000, 3), event];
    const result = convertRecordLines(lines, { resource: (run) => { runs.push(run); return resourceFromAttributes({ 'service.version': run?.appVersion ?? 'unknown' }); }, temporality: 'cumulative', scrub });
    expect(runs).toEqual([{ appVersion: '1.0.0', uiChrome: 'v2', serviceInstanceId: undefined }, { appVersion: '1.1.0', uiChrome: 'v2', serviceInstanceId: 'inst-2' }]);
    expect(result.logs[0].resource.attributes['service.version']).toBe('1.1.0');
    expect(result.metrics.scopeMetrics[0].metrics[0].dataPoints.map((p) => p.value)).toEqual([2, 3]);
  });

  it('marks a local parent as local, and only a root span under a traceparent as remote', () => {
    const child = JSON.stringify({ ...JSON.parse(span), name: 'clubhouse.app.startup.load_settings' });
    const [root, inner] = convertRecordLines([session(), span, child], { resource: () => resource, temporality: 'delta', scrub }).spans;
    expect(root.parentSpanContext?.isRemote).toBe(true);
    expect(inner.parentSpanContext?.isRemote).toBe(false);
  });

  it('skips metrics for a destination that gets none, and marks the overflow series', () => {
    expect(convertRecordLines([session(), counter(T0, 1)], { resource: () => resource, temporality: 'delta', scrub, metrics: false })).toMatchObject({ skipped: 1, metrics: { scopeMetrics: [] } });
    const overflow = JSON.stringify({ ...JSON.parse(counter(T0, 4)), attrs: {}, overflow: true });
    const [{ metrics }] = convertRecordLines([session(), overflow], { resource: () => resource, temporality: 'delta', scrub }).metrics.scopeMetrics;
    expect(metrics[0].dataPoints[0].attributes).toEqual({ 'otel.metric.overflow': true });
  });

  it("matches the live exception record, which has no custom event name", () => {
    const [ex] = convertRecordLines([session(), exception], { resource: () => resource, temporality: 'delta', scrub }).logs;
    expect(ex.attributes).not.toHaveProperty('microsoft.custom_event.name');
  });

  it('refuses names that are only inherited object keys, and format versions it does not know', () => {
    const forged = [
      JSON.stringify({ ...JSON.parse(span), name: 'constructor' }),
      JSON.stringify({ ...JSON.parse(event), name: 'toString', severity: 'constructor' }),
      JSON.stringify({ ...JSON.parse(counter(T0, 1)), name: '__proto__' }),
    ];
    expect(convertRecordLines([session(), ...forged], { resource: () => resource, temporality: 'delta', scrub })).toMatchObject({ skipped: 3, spans: [], logs: [] });
    // A known event with an inherited severity name falls back to info.
    const odd = JSON.stringify({ ...JSON.parse(event), severity: 'constructor' });
    expect(convertRecordLines([session(), odd], { resource: () => resource, temporality: 'delta', scrub }).logs[0].severityText).toBe('INFO');
    for (const v of [2, 5]) {
      expect(convertRecordLines([session({ v }), counter(T0, 1), event], { resource: () => resource, temporality: 'delta', scrub })).toMatchObject({ skipped: 2, logs: [] });
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
    const result = convertRecordLines([session(), span, event, exception, counter(T0, 2), gauge, histogram(T0), diag], { resource: () => resource, temporality: 'cumulative', scrub });

    const done = (exp: { export: (items: never, cb: (r: { code: number; error?: Error }) => void) => void }, items: unknown) =>
      new Promise<number>((resolve) => exp.export(items as never, (r) => resolve(r.code)));
    expect(await done(new OTLPTraceExporter({ url: `${base}/v1/traces` }), result.spans)).toBe(0);
    expect(await done(new OTLPLogExporter({ url: `${base}/v1/logs` }), result.logs)).toBe(0);
    expect(await done(new OTLPMetricExporter({ url: `${base}/v1/metrics` }), result.metrics)).toBe(0);

    expect(bodies.map((b) => b.url).sort()).toEqual(['/v1/logs', '/v1/metrics', '/v1/traces']);
    const json = (url: string) => JSON.parse(bodies.find((b) => b.url === url)!.body);
    const traces = json('/v1/traces');
    const otlpSpan = traces.resourceSpans[0].scopeSpans[0].spans[0];
    expect(traces.resourceSpans[0].scopeSpans[0].scope.name).toBe('clubhouse');
    expect(otlpSpan.name).toBe('clubhouse.annex.rest');
    expect(otlpSpan.status.code).toBe(2);
    const logs = json('/v1/logs').resourceLogs[0].scopeLogs[0].logRecords;
    expect(logs.map((l: { eventName?: string; body: { stringValue: string } }) => l.eventName ?? l.body.stringValue)).toEqual(['clubhouse.audit.setting', 'clubhouse.exception']);
    const sums = json('/v1/metrics').resourceMetrics[0].scopeMetrics[0].metrics.find((m: { name: string }) => m.name === 'clubhouse.app.sessions');
    expect(sums.sum.isMonotonic).toBe(true);
    expect(sums.sum.aggregationTemporality).toBe(2);
    const all = bodies.map((b) => b.body).join('\n');
    expect(all).toContain('clubhouse.annex.rest');
    expect(all).toContain('clubhouse.audit.setting');
    expect(all).toContain('clubhouse.persist.write.duration');
    expect(all).not.toContain(DETAIL_CANARY);
    expect(all).not.toContain(DIAG_CANARY);
  }, 30_000);
});
