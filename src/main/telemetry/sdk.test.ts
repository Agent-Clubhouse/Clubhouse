import { randomBytes } from 'crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemorySpanExporter, SamplingDecision } from '@opentelemetry/sdk-trace-base';
import { InMemoryLogRecordExporter } from '@opentelemetry/sdk-logs';
import { AggregationTemporality, InMemoryMetricExporter } from '@opentelemetry/sdk-metrics';
import { ROOT_CONTEXT, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { ATTR, type TelemetryLevel } from '../../shared/telemetry/attributes';
import { parseTraceparent, startSdk } from './sdk';
import { createScrubber } from './scrubber';
import { FlowSampler } from './sampler';
import { SessionCaps } from './caps';
import { PreviewTee } from './preview-tee';
import { hashId } from './ids';
import type { TelemetryRuntime } from './types';
import { ForwardedError, tagError } from './types';

const salt = Buffer.alloc(32, 7);

function setup(level: TelemetryLevel = 'standard', extra: Partial<Parameters<typeof startSdk>[0]> = {}) {
  const spans = new InMemorySpanExporter();
  const logs = new InMemoryLogRecordExporter();
  const metrics = new InMemoryMetricExporter(AggregationTemporality.DELTA);
  const rt = startSdk({
    level,
    sampleRate: 1,
    resourceAttributes: { 'service.name': 'clubhouse' },
    exporters: { spanExporter: spans, logExporter: logs, metricExporter: metrics },
    hashSalt: salt,
    scrub: createScrubber({ homeDir: '/home/test' }),
    metricExportIntervalMs: 60_000,
    batchDelayMs: 60_000,
    ...extra,
  });
  return { rt, spans, logs, metrics };
}

let active: TelemetryRuntime | null = null;
afterEach(async () => {
  await active?.shutdown(1000);
  active = null;
});

describe('startSdk', () => {
  it('exports a flow root as a SERVER span with outcome, and children as INTERNAL', async () => {
    const { rt, spans } = setup();
    active = rt;
    await rt.flow('clubhouse.telemetry.test', { attrs: [ATTR.process('main')] }, async () => {
      rt.step('clubhouse.telemetry.test', () => 1);
    });
    await new Promise((r) => setImmediate(r));
    await rt.forceFlush(1000);
    const finished = spans.getFinishedSpans();
    expect(finished).toHaveLength(2);
    const root = finished.find((s) => !s.parentSpanContext)!;
    const child = finished.find((s) => s.parentSpanContext)!;
    expect(root.kind).toBe(SpanKind.SERVER);
    expect(child.kind).toBe(SpanKind.INTERNAL);
    expect(child.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    expect(root.attributes).toMatchObject({ 'clubhouse.outcome': 'ok', 'clubhouse.process': 'main', 'microsoft.sample_rate': 100 });
  });

  it('records thrown errors sanitized, rethrows them unchanged, and marks the span ERROR', async () => {
    const { rt, spans, logs } = setup();
    active = rt;
    const boom = new TypeError('cannot read /home/test/secret.txt');
    expect(() => rt.flow('clubhouse.telemetry.test', {}, () => {
      throw boom;
    })).toThrow(boom);
    await rt.forceFlush(1000);
    const [span] = spans.getFinishedSpans();
    expect(span.status).toEqual({ code: SpanStatusCode.ERROR });
    expect(span.attributes['error.type']).toBe('unknown');
    const ev = span.events.find((e) => e.name === 'exception');
    expect(ev?.attributes?.['exception.type']).toBe('TypeError');
    const record = logs.getFinishedLogRecords().find((l) => l.eventName === 'clubhouse.exception');
    expect(record?.body).toBe('clubhouse.exception');
    expect(JSON.stringify(record?.attributes)).not.toContain('secret');
  });

  it('starts registered root spans in a new trace even inside an active flow', async () => {
    const { rt, spans } = setup();
    active = rt;
    let leaked: (() => void) | undefined;
    await rt.flow('clubhouse.agent.spawn', {}, async () => {
      await rt.step('clubhouse.pty.spawn', async () => {
        // A process callback registered here keeps this context after the flow ends.
        leaked = () => {
          rt.replaySpan({ name: 'clubhouse.agent.run', startMs: Date.now() - 10, endMs: Date.now(), attrs: [], outcome: 'ok' });
          rt.flow('clubhouse.group.shoulder_tap', {}, () => undefined);
        };
      });
    });
    leaked!();
    await rt.forceFlush(1000);
    const byName = new Map(spans.getFinishedSpans().map((sp) => [sp.name, sp]));
    expect(byName.get('clubhouse.pty.spawn')?.parentSpanContext?.spanId).toBe(byName.get('clubhouse.agent.spawn')?.spanContext().spanId);
    expect(byName.get('clubhouse.agent.run')?.parentSpanContext).toBeUndefined();
    expect(byName.get('clubhouse.group.shoulder_tap')?.parentSpanContext).toBeUndefined();
    expect(byName.get('clubhouse.agent.run')?.spanContext().traceId).not.toBe(byName.get('clubhouse.agent.spawn')?.spanContext().traceId);
  });

  it('continues a remote traceparent in the next root flow only, once', async () => {
    const { rt, spans } = setup();
    active = rt;
    const remote = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01';
    let inner: string | undefined;
    await rt.withRemoteParent(remote, async () => {
      await rt.flow('clubhouse.agent.spawn', {}, async () => {
        inner = rt.traceparent();
      });
      // A second root flow in the same (leaked) context starts its own trace.
      rt.flow('clubhouse.group.shoulder_tap', {}, () => undefined);
    });
    await rt.forceFlush(1000);
    const byName = new Map(spans.getFinishedSpans().map((sp) => [sp.name, sp]));
    const spawn = byName.get('clubhouse.agent.spawn')!;
    expect(spawn.spanContext().traceId).toBe('0123456789abcdef0123456789abcdef');
    expect(spawn.parentSpanContext?.spanId).toBe('0123456789abcdef');
    expect(inner).toBe(`00-${spawn.spanContext().traceId}-${spawn.spanContext().spanId}-01`);
    expect(byName.get('clubhouse.group.shoulder_tap')?.spanContext().traceId).not.toBe('0123456789abcdef0123456789abcdef');
    expect(rt.traceparent()).toBeUndefined();
  });

  it('applies its own sample rate to a sampled remote parent instead of always recording it', async () => {
    const { rt, spans } = setup('standard', { sampleRate: 1e-9 });
    active = rt;
    const remote = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01';
    await rt.withRemoteParent(remote, async () => {
      await rt.flow('clubhouse.agent.spawn', {}, async () => undefined);
    });
    await rt.forceFlush(1000);
    // Declined at this install's rate: continued unsampled, so nothing is recorded.
    expect(spans.getFinishedSpans()).toHaveLength(0);
  });

  it('ignores unsampled, malformed or all-zero traceparents', () => {
    expect(parseTraceparent('00-0123456789abcdef0123456789abcdef-0123456789abcdef-00')).toBeUndefined();
    expect(parseTraceparent('01-0123456789abcdef0123456789abcdef-0123456789abcdef-01')).toBeUndefined();
    expect(parseTraceparent('00-00000000000000000000000000000000-0123456789abcdef-01')).toBeUndefined();
    expect(parseTraceparent('00-0123456789ABCDEF0123456789abcdef-0123456789abcdef-01')).toBeUndefined();
    expect(parseTraceparent('garbage')).toBeUndefined();
    expect(parseTraceparent('00-0123456789abcdef0123456789abcdef-0123456789abcdef-03')).toMatchObject({ isRemote: true });
  });

  it('does not attach an exception to an ended span left in context', async () => {
    const { rt, spans, logs } = setup();
    active = rt;
    let leaked: (() => void) | undefined;
    await rt.flow('clubhouse.agent.spawn', {}, async () => {
      leaked = () => rt.exception(new Error('later'), { origin: 'main', handled: true });
    });
    leaked!();
    await rt.forceFlush(1000);
    const [spawn] = spans.getFinishedSpans();
    expect(spawn.events.filter((e) => e.name === 'exception')).toEqual([]);
    const record = logs.getFinishedLogRecords().find((l) => l.eventName === 'clubhouse.exception');
    expect(record).toBeDefined();
    expect(record?.spanContext?.traceId).not.toBe(spawn.spanContext().traceId);
  });

  it('records the error type a thrown error was tagged with, innermost tag first', async () => {
    const { rt, spans } = setup();
    active = rt;
    const err = tagError(tagError(new Error('x'), 'preflight_failed'), 'unknown');
    await expect(rt.flow('clubhouse.agent.spawn', {}, async () => {
      await rt.step('clubhouse.provider.check_availability', async () => { throw err; });
    })).rejects.toBe(err);
    await rt.forceFlush(1000);
    const types = spans.getFinishedSpans().map((s) => [s.name, s.attributes['error.type']]);
    expect(types).toEqual([
      ['clubhouse.provider.check_availability', 'preflight_failed'],
      ['clubhouse.agent.spawn', 'preflight_failed'],
    ]);
  });

  it('keeps forwarded renderer errors\' class name and extra attributes on the exception record', async () => {
    const { rt, logs } = setup();
    active = rt;
    rt.exception(new ForwardedError('RangeError', 'RangeError: secret\n    at render (renderer.js:10:5)'), {
      origin: 'renderer',
      handled: true,
      attrs: [ATTR.windowKind('popout'), ATTR.errorBoundary('app')],
    });
    await rt.forceFlush(1000);
    const record = logs.getFinishedLogRecords().find((l) => l.eventName === 'clubhouse.exception');
    expect(record?.attributes).toMatchObject({
      'exception.type': 'RangeError',
      'clubhouse.exception.origin': 'renderer',
      'clubhouse.window.kind': 'popout',
      'clubhouse.error.boundary': 'app',
    });
    expect(JSON.stringify(record?.attributes)).not.toContain('secret');
  });

  it('puts the install id on spans and log records but never on metrics', async () => {
    const installId = '0f1e2d3c-4b5a-4968-8776-655443322110';
    const { rt, spans, logs, metrics } = setup('standard', {
      resourceAttributes: { 'service.name': 'clubhouse', 'enduser.pseudo.id': installId },
    });
    active = rt;
    rt.flow('clubhouse.telemetry.test', {}, () => 1);
    rt.event('clubhouse.telemetry.test');
    rt.count('clubhouse.app.sessions', 1, [ATTR.startupKind('cold')]);
    await rt.forceFlush(1000);
    expect(spans.getFinishedSpans()[0].attributes['enduser.pseudo.id']).toBe(installId);
    expect(logs.getFinishedLogRecords()[0].attributes['enduser.pseudo.id']).toBe(installId);
    const points = metrics.getMetrics().flatMap((m) => m.scopeMetrics.flatMap((s) => s.metrics.flatMap((x) => x.dataPoints)));
    expect(points.length).toBeGreaterThan(0);
    for (const p of points) expect(p.attributes['enduser.pseudo.id']).toBeUndefined();
  });

  it('applies return-value classification and abort signals', async () => {
    const { rt, spans } = setup();
    active = rt;
    rt.flow('clubhouse.telemetry.test', {}, () => ({ ok: false }), { classify: () => ({ error: 'binary_not_found' }) });
    const ac = new AbortController();
    const p = rt.flow('clubhouse.telemetry.test', { signal: ac.signal }, () => new Promise((r) => setTimeout(r, 5)));
    ac.abort();
    await p;
    await rt.forceFlush(1000);
    const [failed, cancelled] = spans.getFinishedSpans();
    expect(failed.attributes).toMatchObject({ 'clubhouse.outcome': 'error', 'error.type': 'binary_not_found' });
    expect(cancelled.attributes['clubhouse.outcome']).toBe('cancelled');
    expect(cancelled.status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it('emits events as customEvents-routed log records with the name as body', async () => {
    const { rt, logs } = setup();
    active = rt;
    rt.event('clubhouse.telemetry.test', [ATTR.telemetryDestination('azure')]);
    await rt.forceFlush(1000);
    const [record] = logs.getFinishedLogRecords();
    expect(record.body).toBe('clubhouse.telemetry.test');
    expect(record.attributes).toEqual({
      'clubhouse.telemetry.destination': 'azure',
      'microsoft.custom_event.name': 'clubhouse.telemetry.test',
    });
  });

  it('hashes id attributes with the install salt', async () => {
    const { rt, spans } = setup();
    active = rt;
    rt.flow('clubhouse.telemetry.test', { attrs: [ATTR.agentIdHash('durable_123')] }, () => undefined);
    await rt.forceFlush(1000);
    expect(spans.getFinishedSpans()[0].attributes['clubhouse.agent.id_hash']).toBe(hashId(salt, 'durable_123'));
  });

  it('counts metrics with allowlisted dimensions only', async () => {
    const { rt, metrics } = setup();
    active = rt;
    rt.count('clubhouse.app.sessions', 1, [ATTR.startupKind('cold'), ATTR.process('main')]);
    await rt.forceFlush(1000);
    const all = metrics.getMetrics().flatMap((rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics));
    const sessions = all.find((m) => m.descriptor.name === 'clubhouse.app.sessions');
    expect(sessions?.dataPoints).toHaveLength(1);
    expect(sessions?.dataPoints[0].attributes).toEqual({ 'clubhouse.startup.kind': 'cold' });
    expect(sessions?.dataPoints[0].value).toBe(1);
  });

  it('fills the preview tee with what was exported', async () => {
    const { rt } = setup();
    active = rt;
    rt.event('clubhouse.telemetry.test');
    rt.flow('clubhouse.telemetry.test', {}, () => undefined);
    await rt.forceFlush(1000);
    const names = rt.preview().map((p) => `${p.signal}:${p.name}`);
    expect(names).toEqual(expect.arrayContaining(['logs:clubhouse.telemetry.test', 'traces:clubhouse.telemetry.test']));
  });

  it('at Errors level exports only traces that end in error', async () => {
    const { rt, spans } = setup('errors');
    active = rt;
    rt.flow('clubhouse.telemetry.test', {}, () => {
      rt.step('clubhouse.telemetry.test', () => undefined);
    });
    rt.flow('clubhouse.telemetry.test', {}, () => {
      rt.step('clubhouse.telemetry.test', () => undefined);
      return 'x';
    }, { classify: () => ({ error: 'timeout' }) });
    await rt.forceFlush(1000);
    const finished = spans.getFinishedSpans();
    expect(finished).toHaveLength(2);
    expect(new Set(finished.map((s) => s.spanContext().traceId)).size).toBe(1);
  });

  it('drops spans and logs past the per-session cap and counts them', async () => {
    const { rt, spans, logs, metrics } = setup('standard', { sessionCaps: { traces: 2, logs: 1 } });
    active = rt;
    for (let i = 0; i < 5; i++) rt.flow('clubhouse.telemetry.test', {}, () => undefined);
    for (let i = 0; i < 3; i++) rt.event('clubhouse.telemetry.test');
    await rt.forceFlush(1000);
    expect(spans.getFinishedSpans()).toHaveLength(2);
    expect(logs.getFinishedLogRecords()).toHaveLength(1);
    const dropped = metrics.getMetrics()
      .flatMap((rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics))
      .filter((m) => m.descriptor.name === 'clubhouse.telemetry.dropped')
      .flatMap((m) => m.dataPoints);
    const bySignal = Object.fromEntries(dropped.map((dp) => [dp.attributes['clubhouse.telemetry.signal'], dp.value]));
    expect(bySignal).toEqual({ traces: 3, logs: 2 });
  });

  it('replays buffered startup spans with their original timestamps', async () => {
    const { rt, spans } = setup();
    active = rt;
    rt.replaySpan({ name: 'clubhouse.telemetry.test', startMs: 1_000_000, endMs: 1_000_250, attrs: [], outcome: 'error', errorType: 'init_failed' });
    await rt.forceFlush(1000);
    const [s] = spans.getFinishedSpans();
    expect(s.startTime).toEqual([1000, 0]);
    expect(s.duration).toEqual([0, 250_000_000]);
    expect(s.attributes['error.type']).toBe('init_failed');
  });
});

describe('appLog bridge support', () => {
  it('keeps a bridged record\'s severity and exposes the active trace ids', async () => {
    const { rt, logs } = setup();
    active = rt;
    expect(rt.activeTraceIds()).toBeUndefined();
    let ids: ReturnType<typeof rt.activeTraceIds>;
    rt.flow('clubhouse.telemetry.test', {}, () => {
      ids = rt.activeTraceIds();
      rt.event('clubhouse.annex.heartbeat_timeout', [], { severity: 'warn' });
    });
    await rt.forceFlush(1000);
    expect(ids!.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(ids!.spanId).toMatch(/^[0-9a-f]{16}$/);
    const record = logs.getFinishedLogRecords().find((l) => l.eventName === 'clubhouse.annex.heartbeat_timeout')!;
    expect(record.severityText).toBe('WARN');
    expect(record.spanContext?.traceId).toBe(ids!.traceId);
  });
});

describe('FlowSampler', () => {
  it('stamps the sample rate as a percentage on sampled spans', () => {
    const sampler = new FlowSampler(0.25);
    let sampled = 0;
    for (let i = 0; i < 2000; i++) {
      const id = randomBytes(16).toString('hex');
      const r = sampler.shouldSample(ROOT_CONTEXT, id, 'clubhouse.telemetry.test', SpanKind.SERVER, {}, []);
      if (r.decision === SamplingDecision.RECORD_AND_SAMPLED) {
        sampled++;
        expect(r.attributes?.['microsoft.sample_rate']).toBe(25);
      }
    }
    expect(sampled).toBeGreaterThan(0);
    expect(sampled).toBeLessThan(2000);
  });

  it('samples everything at the default rate and rejects invalid rates', () => {
    for (const rate of [1, 0, -1, 7]) {
      const r = new FlowSampler(rate).shouldSample(ROOT_CONTEXT, 'f'.repeat(32), 'x', SpanKind.SERVER, {}, []);
      expect(r.decision).toBe(SamplingDecision.RECORD_AND_SAMPLED);
      expect(r.attributes?.['microsoft.sample_rate']).toBe(100);
    }
  });
});

describe('SessionCaps', () => {
  it('admits up to the limit per signal and reports drops', () => {
    const drops: string[] = [];
    const caps = new SessionCaps({ traces: 2, logs: 0 }, (s) => drops.push(s));
    expect([caps.tryAcquire('traces'), caps.tryAcquire('traces'), caps.tryAcquire('traces')]).toEqual([true, true, false]);
    expect(caps.tryAcquire('logs')).toBe(false);
    expect(caps.count('traces')).toBe(2);
    expect(caps.dropped('traces')).toBe(1);
    expect(drops).toEqual(['traces', 'logs']);
  });

  it('defaults to 50,000 spans and 10,000 log records', () => {
    const caps = new SessionCaps();
    for (let i = 0; i < 10_000; i++) caps.tryAcquire('logs');
    expect(caps.tryAcquire('logs')).toBe(false);
    for (let i = 0; i < 50_000; i++) caps.tryAcquire('traces');
    expect(caps.tryAcquire('traces')).toBe(false);
  });
});

describe('PreviewTee', () => {
  it('keeps the newest items, oldest first', () => {
    const tee = new PreviewTee(3);
    for (let i = 0; i < 5; i++) tee.push({ signal: 'logs', name: `e${i}`, time: i, attributes: {} });
    expect(tee.snapshot().map((i) => i.name)).toEqual(['e2', 'e3', 'e4']);
    tee.clear();
    expect(tee.snapshot()).toEqual([]);
  });
});
