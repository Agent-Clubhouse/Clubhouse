import { afterEach, describe, expect, it } from 'vitest';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { InMemoryLogRecordExporter } from '@opentelemetry/sdk-logs';
import { AggregationTemporality, InMemoryMetricExporter } from '@opentelemetry/sdk-metrics';
import type { TelemetryLevel } from '../../shared/telemetry/attributes';
import { recordingLevel } from './filters';
import { startSdk } from './sdk';
import { createScrubber } from './scrubber';
import type { SdkDestination } from './destinations/types';
import type { TelemetryRuntime } from './types';

interface Sink { spans: InMemorySpanExporter; logs: InMemoryLogRecordExporter; metrics: InMemoryMetricExporter }
const sink = (): Sink => ({ spans: new InMemorySpanExporter(), logs: new InMemoryLogRecordExporter(), metrics: new InMemoryMetricExporter(AggregationTemporality.DELTA) });
const dest = (id: string, kind: string, s: Sink, level: TelemetryLevel): SdkDestination =>
  ({ id, kind, filter: { level, preset: 'all' }, exporters: { spanExporter: s.spans, logExporter: s.logs, metricExporter: s.metrics } });

let rt: TelemetryRuntime | null = null;
afterEach(async () => { await rt?.shutdown(1000); rt = null; });

function start(destinations: SdkDestination[]): TelemetryRuntime {
  rt = startSdk({
    level: recordingLevel(destinations.map((d) => d.filter.level)),
    sampleRate: 1,
    resourceAttributes: { 'service.name': 'clubhouse', 'service.version': '9.9.9', 'enduser.pseudo.id': 'install-1' },
    destinations,
    hashSalt: Buffer.alloc(32, 9),
    scrub: createScrubber({ homeDir: '/home/test' }),
    metricExportIntervalMs: 60_000,
    batchDelayMs: 60_000,
  });
  return rt;
}

const T0 = Date.parse('2026-11-01T10:00:00.000Z');
const session = JSON.stringify({ t: 'session', v: 4, ts: '2026-11-01T10:00:00.000Z', appVersion: '1.2.0', platform: 'darwin', arch: 'arm64', uiChrome: 'v2', level: 'standard', scope: 'clubhouse', temporality: 'delta' });
const spanLine = (trace: string, id: string, name: string, outcome: string, parent?: string) => JSON.stringify({
  t: 'span', ts: 'x', name, traceId: trace.repeat(32), spanId: id.repeat(16), ...(parent && { parentSpanId: parent.repeat(16) }),
  startMs: T0, durationMs: 100, outcome, ...(outcome === 'error' && { errorType: 'timeout' }), attrs: {},
});
const lines = [
  session,
  // A failing trace: an error root and its OK child.
  spanLine('a', '1', 'clubhouse.annex.rest', 'error'),
  spanLine('a', '2', 'clubhouse.app.startup.load_settings', 'ok', '1'),
  // A trace that went fine.
  spanLine('b', '3', 'clubhouse.annex.rest', 'ok'),
  JSON.stringify({ t: 'event', ts: '2026-11-01T10:00:01.000Z', name: 'clubhouse.feedback.submitted', severity: 'info', attrs: { 'feedback.report.id': '11111111-2222-4333-8444-555555555555' } }),
  JSON.stringify({ t: 'metric', ts: 'x', name: 'clubhouse.app.sessions', kind: 'counter', startMs: T0, durationMs: 60_000, attrs: { 'clubhouse.startup.kind': 'cold' }, sum: 1 }),
  JSON.stringify({ t: 'diag', ts: 'x', ns: 'core:test', level: 'error', msg: 'local only' }),
];

describe('runtime replay to one destination (#2920 backfill)', () => {
  it('sends only to the named destination, through its stamp, with the run resource and install id, and no developer-only attribute', async () => {
    const otlp = sink();
    const other = sink();
    const r = start([dest('otlp', 'otlp', otlp, 'standard'), dest('azure', 'azure', other, 'standard')]);
    const report = await r.replay!('otlp', lines);
    expect(report).toMatchObject({ ok: true, spans: 3, logs: 1, metricPoints: 1, skipped: 1 });
    expect(other.spans.getFinishedSpans()).toHaveLength(0);
    expect(other.logs.getFinishedLogRecords()).toHaveLength(0);
    const [log] = otlp.logs.getFinishedLogRecords();
    expect(log.attributes).toMatchObject({ 'clubhouse.telemetry.level': 'standard', 'enduser.pseudo.id': 'install-1' });
    expect(log.attributes).not.toHaveProperty('feedback.report.id');
    expect(log.resource.attributes['service.version']).toBe('1.2.0');
    expect(otlp.spans.getFinishedSpans().every((s) => s.attributes['clubhouse.telemetry.level'] === 'standard')).toBe(true);
    expect(otlp.metrics.getMetrics()).toHaveLength(1);
  });

  it("applies the destination's level: at Errors, only failing traces (children included) and no Standard events", async () => {
    const errorsOnly = sink();
    const r = start([dest('otlp', 'otlp', errorsOnly, 'errors')]);
    const report = await r.replay!('otlp', lines);
    expect(report.ok).toBe(true);
    expect(errorsOnly.spans.getFinishedSpans().map((s) => s.spanContext().spanId).sort()).toEqual(['1'.repeat(16), '2'.repeat(16)]);
    expect(errorsOnly.logs.getFinishedLogRecords()).toHaveLength(0);
    expect(report.filtered).toBe(2);
  });

  it('sends Azure no metrics, since it would stamp them with the export time', async () => {
    const azure = sink();
    const r = start([dest('azure', 'azure', azure, 'standard')]);
    const report = await r.replay!('azure', lines);
    expect(report).toMatchObject({ ok: true, metricPoints: 0 });
    expect(azure.metrics.getMetrics()).toHaveLength(0);
    expect(azure.spans.getFinishedSpans()).toHaveLength(3);
  });

  it('stops when cancelled, and refuses a destination that is not running', async () => {
    const s = sink();
    const r = start([dest('otlp', 'otlp', s, 'standard')]);
    const abort = new AbortController();
    abort.abort();
    expect(await r.replay!('otlp', lines, { signal: abort.signal })).toMatchObject({ ok: false, reason: 'cancelled', spans: 0 });
    expect(s.spans.getFinishedSpans()).toHaveLength(0);
    expect(await r.replay!('nowhere', lines)).toMatchObject({ ok: false, reason: 'not_enabled' });
  });

  it('caps what one call sends', async () => {
    const s = sink();
    const r = start([dest('otlp', 'otlp', s, 'standard')]);
    const report = await r.replay!('otlp', lines, { maxSpans: 1 });
    expect(report.spans).toBe(1);
    expect(report.filtered).toBe(2);
  });
});
