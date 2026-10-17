import { afterEach, describe, expect, it } from 'vitest';
import { ExportResultCode } from '@opentelemetry/core';
import { InMemorySpanExporter, type ReadableSpan, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import { InMemoryLogRecordExporter } from '@opentelemetry/sdk-logs';
import { AggregationTemporality, InMemoryMetricExporter } from '@opentelemetry/sdk-metrics';
import { ATTR, type TelemetryLevel } from '../../shared/telemetry/attributes';
import type { TelemetryFilterPreset } from '../../shared/telemetry/settings-types';
import { compileFilter, recordingLevel, USER_ACTIVITY } from './filters';
import { startSdk } from './sdk';
import { createScrubber } from './scrubber';
import type { SdkDestination } from './destinations/types';
import type { TelemetryRuntime } from './types';

const salt = Buffer.alloc(32, 9);

interface Sink {
  spans: InMemorySpanExporter;
  logs: InMemoryLogRecordExporter;
  metrics: InMemoryMetricExporter;
}

function sink(temporality = AggregationTemporality.CUMULATIVE): Sink {
  return { spans: new InMemorySpanExporter(), logs: new InMemoryLogRecordExporter(), metrics: new InMemoryMetricExporter(temporality) };
}

function dest(id: string, kind: string, s: Sink, level: TelemetryLevel, preset: TelemetryFilterPreset = 'all', extra: Partial<SdkDestination> = {}): SdkDestination {
  return { id, kind, filter: { level, preset }, exporters: { spanExporter: s.spans, logExporter: s.logs, metricExporter: s.metrics }, ...extra };
}

let rt: TelemetryRuntime | null = null;
afterEach(async () => {
  await rt?.shutdown(1000);
  rt = null;
});

function start(destinations: SdkDestination[]): TelemetryRuntime {
  rt = startSdk({
    level: recordingLevel(destinations.map((d) => d.filter.level)),
    sampleRate: 1,
    resourceAttributes: { 'service.name': 'clubhouse', 'service.version': '9.9.9', 'enduser.pseudo.id': 'install-1' },
    destinations,
    hashSalt: salt,
    scrub: createScrubber({ homeDir: '/home/test' }),
    metricExportIntervalMs: 60_000,
    batchDelayMs: 60_000,
  });
  return rt;
}

const spanNames = (s: Sink) => s.spans.getFinishedSpans().map((x) => x.name).sort();
const eventNames = (s: Sink) => s.logs.getFinishedLogRecords().map((x) => x.eventName).sort();
const metricNames = (s: Sink) => [
  ...new Set(s.metrics.getMetrics().flatMap((rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics.map((m) => m.descriptor.name)))),
].sort();

describe('multi-destination fan-out', () => {
  it('sends a span to the destination whose filter takes it and not to the other', async () => {
    const a = sink();
    const b = sink();
    const r = start([dest('azure', 'azure', a, 'standard'), dest('otlp', 'otlp', b, 'standard', 'user_activity')]);
    r.flow('clubhouse.git.commit', {}, () => undefined);
    r.flow('clubhouse.agent.spawn', {}, () => undefined);
    await r.forceFlush(1000);
    expect(spanNames(a)).toEqual(['clubhouse.agent.spawn', 'clubhouse.git.commit']);
    expect(spanNames(b)).toEqual(['clubhouse.agent.spawn']);
  });

  it('keeps Detailed spans from a user-activity destination even at Detailed, and records at the most verbose level', async () => {
    const a = sink();
    const b = sink();
    const r = start([dest('azure', 'azure', a, 'detailed'), dest('otlp', 'otlp', b, 'detailed', 'user_activity')]);
    expect(r.level).toBe('detailed');
    r.flow('clubhouse.ipc.invoke', { attrs: [ATTR.ipcChannel('project:list')] }, () => undefined);
    r.flow('clubhouse.agent.tool_call', {}, () => undefined);
    await r.forceFlush(1000);
    expect(spanNames(a)).toEqual(['clubhouse.agent.tool_call', 'clubhouse.ipc.invoke']);
    expect(spanNames(b)).toEqual([]);
  });

  it('applies each destination its own level: an Errors destination only gets failing traces', async () => {
    const a = sink();
    const b = sink();
    const r = start([dest('azure', 'azure', a, 'standard'), dest('otlp', 'otlp', b, 'errors')]);
    r.flow('clubhouse.agent.spawn', {}, () => undefined);
    r.flow('clubhouse.agent.create', {}, () => undefined, { classify: () => ({ error: 'write_failed' }) });
    r.event('clubhouse.ui.feature_used');
    r.event('clubhouse.app.unclean_exit');
    await r.forceFlush(1000);
    expect(spanNames(a)).toEqual(['clubhouse.agent.create', 'clubhouse.agent.spawn']);
    expect(spanNames(b)).toEqual(['clubhouse.agent.create']);
    expect(eventNames(a)).toEqual(['clubhouse.app.unclean_exit', 'clubhouse.ui.feature_used']);
    expect(eventNames(b)).toEqual(['clubhouse.app.unclean_exit']);
  });

  it('routes the test event only to the destination it names', async () => {
    const a = sink();
    const b = sink();
    const r = start([dest('azure', 'azure', a, 'standard'), dest('otlp', 'otlp', b, 'standard')]);
    const attrs = [ATTR.telemetryDestination('otlp')];
    r.flow('clubhouse.telemetry.test', { attrs }, () => undefined);
    r.event('clubhouse.telemetry.test', attrs);
    await r.forceFlush(1000);
    expect(spanNames(a)).toEqual([]);
    expect(eventNames(a)).toEqual([]);
    expect(spanNames(b)).toEqual(['clubhouse.telemetry.test']);
    expect(eventNames(b)).toEqual(['clubhouse.telemetry.test']);
    expect(r.recentExports(0).map((x) => x.destination).every((d) => d === 'otlp')).toBe(true);
  });

  it('gives each destination its own metric reader: its temporality and its metric filter', async () => {
    const a = sink(AggregationTemporality.CUMULATIVE);
    const b = sink(AggregationTemporality.DELTA);
    const r = start([dest('azure', 'azure', a, 'standard'), dest('otlp', 'otlp', b, 'standard', 'user_activity')]);
    r.count('clubhouse.app.sessions', 1, [ATTR.startupKind('cold')]);
    r.count('clubhouse.agent.runs', 1);
    await r.forceFlush(1000);
    expect(metricNames(a)).toEqual(expect.arrayContaining(['clubhouse.agent.runs', 'clubhouse.app.sessions']));
    expect(metricNames(b)).toEqual(['clubhouse.app.sessions']);
    const temporality = (s: Sink) => s.metrics.getMetrics()[0].scopeMetrics[0].metrics[0].aggregationTemporality;
    expect(temporality(a)).toBe(AggregationTemporality.CUMULATIVE);
    expect(temporality(b)).toBe(AggregationTemporality.DELTA);
  });

  it('copies chosen resource attributes onto one destination only, without changing what others see', async () => {
    const a = sink();
    const b = sink();
    const r = start([dest('azure', 'azure', a, 'standard'), dest('otlp', 'otlp', b, 'standard', 'all', { copyResourceAttributes: ['service.version'] })]);
    r.flow('clubhouse.agent.spawn', {}, () => undefined);
    r.event('clubhouse.ui.feature_used');
    await r.forceFlush(1000);
    expect(b.spans.getFinishedSpans()[0].attributes['service.version']).toBe('9.9.9');
    expect(b.logs.getFinishedLogRecords()[0].attributes['service.version']).toBe('9.9.9');
    expect(a.spans.getFinishedSpans()[0].attributes['service.version']).toBeUndefined();
    expect(a.logs.getFinishedLogRecords()[0].attributes['service.version']).toBeUndefined();
  });

  it('tracks health per destination: one failing does not stop or taint the other', async () => {
    const good = sink();
    const failing: SpanExporter = {
      export: (_spans: ReadableSpan[], cb) => cb({ code: ExportResultCode.FAILED, error: Object.assign(new Error('nope'), { code: 503 }) }),
      shutdown: async () => {},
    };
    const bad = sink();
    const r = start([
      dest('azure', 'azure', good, 'standard'),
      { ...dest('otlp', 'otlp', bad, 'standard'), exporters: { spanExporter: failing, logExporter: bad.logs, metricExporter: bad.metrics } },
    ]);
    r.flow('clubhouse.agent.spawn', {}, () => undefined);
    await r.forceFlush(1000);
    const health = r.destinationHealth();
    expect(health.azure.lastSuccessAt).toBeGreaterThan(0);
    expect(health.azure.lastFailure).toBeUndefined();
    expect(health.otlp.lastFailure).toMatchObject({ ok: false, destination: 'otlp', httpStatus: 503 });
    expect(spanNames(good)).toEqual(['clubhouse.agent.spawn']);
  });
});

describe('filters', () => {
  it('user activity keeps errors, crashes, feature use and the agent and chat lifecycle', () => {
    const f = compileFilter({ level: 'standard', preset: 'user_activity' }, 'otlp');
    for (const name of USER_ACTIVITY.spans) expect(f.span({ name, attributes: {} })).toBe(true);
    expect(f.span({ name: 'clubhouse.git.commit', attributes: {} })).toBe(false);
    expect(f.span({ name: 'clubhouse.git.commit', attributes: {}, isError: true })).toBe(true);
    expect(f.log({ name: 'clubhouse.exception', attributes: {} })).toBe(true);
    expect(f.log({ name: 'clubhouse.app.unclean_exit', attributes: {} })).toBe(true);
    expect(f.log({ name: 'clubhouse.ui.feature_used', attributes: {} })).toBe(true);
    expect(f.log({ name: 'clubhouse.goobers.liveness', attributes: {} })).toBe(false);
    expect(f.metric('clubhouse.app.sessions')).toBe(true);
    expect(f.metric('clubhouse.agent.runs')).toBe(false);
  });

  it('records at the most verbose enabled level', () => {
    expect(recordingLevel(['errors', 'standard'])).toBe('standard');
    expect(recordingLevel(['errors', 'detailed'])).toBe('detailed');
    expect(recordingLevel(['errors'])).toBe('errors');
  });
});
