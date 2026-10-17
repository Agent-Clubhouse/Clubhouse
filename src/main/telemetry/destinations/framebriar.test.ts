import { describe, expect, it, vi } from 'vitest';
import { AggregationTemporality, InstrumentType } from '@opentelemetry/sdk-metrics';
import { createFramebriarExporters, sessionResourceView, withSessionId } from './framebriar';
import { getAdapter, resolveEntry } from './registry';
import { setFramebriarTelemetrySource, type FramebriarTelemetryExport } from './framebriar-source';
import type { DestinationExporters } from './types';
import type { TelemetryDestinationEntry } from '../../../shared/telemetry/settings-types';

const FB: FramebriarTelemetryExport = {
  host: 'framebriar.example.net',
  options: vi.fn((signal) => ({ url: `https://framebriar.example.net/api/v1/otlp/v1/${signal}`, headers: async () => ({ authorization: 'Bearer token' }) })),
  sessionId: 's-123',
};

function recorder() {
  const seen: { spans: unknown[]; logs: unknown[]; metrics: unknown[] } = { spans: [], logs: [], metrics: [] };
  const exporters = {
    spanExporter: { export: (items: unknown[], cb: (r: unknown) => void) => { seen.spans.push(...items); cb({ code: 0 }); }, shutdown: async () => {}, forceFlush: async () => {} },
    logExporter: { export: (items: unknown[], cb: (r: unknown) => void) => { seen.logs.push(...items); cb({ code: 0 }); }, shutdown: async () => {}, forceFlush: async () => {} },
    metricExporter: {
      export: (rm: unknown, cb: (r: unknown) => void) => { seen.metrics.push(rm); cb({ code: 0 }); },
      shutdown: async () => {}, forceFlush: async () => {},
      selectAggregationTemporality: () => AggregationTemporality.DELTA,
    },
  } as unknown as DestinationExporters;
  return { seen, exporters };
}

describe('Framebriar session on the resource', () => {
  it('views the shared resource with session.id, once per resource, without editing it', () => {
    const view = sessionResourceView('s-1');
    const resource = { attributes: { 'service.name': 'clubhouse' } };
    const v1 = view(resource);
    expect(v1.attributes).toEqual({ 'service.name': 'clubhouse', 'session.id': 's-1' });
    expect(view(resource)).toBe(v1);
    expect(resource.attributes).toEqual({ 'service.name': 'clubhouse' });
  });

  it('stamps spans, logs and metrics for this destination only', () => {
    const { seen, exporters } = recorder();
    const wrapped = withSessionId(exporters, 's-9');
    const resource = { attributes: { 'service.version': '1.0.0' } };
    const span = { name: 'c.agent.spawn', attributes: { a: 1 }, resource };
    const log = { body: 'x', attributes: {}, resource };
    wrapped.spanExporter.export([span] as never, () => {});
    wrapped.logExporter.export([log] as never, () => {});
    wrapped.metricExporter.export({ resource, scopeMetrics: [] } as never, () => {});
    for (const item of [...seen.spans, ...seen.logs, ...seen.metrics] as Array<{ resource: { attributes: Record<string, unknown> } }>) {
      expect(item.resource.attributes).toEqual({ 'service.version': '1.0.0', 'session.id': 's-9' });
    }
    expect((seen.spans[0] as typeof span).name).toBe('c.agent.spawn');
    expect((seen.spans[0] as typeof span).attributes).toEqual({ a: 1 });
    // The shared items are untouched for other destinations.
    expect(span.resource.attributes).toEqual({ 'service.version': '1.0.0' });
    expect(wrapped.metricExporter.selectAggregationTemporality!(InstrumentType.COUNTER)).toBe(AggregationTemporality.DELTA);
  });

  it('builds OTLP exporters from Framebriar URLs with delta temporality', () => {
    const ex = createFramebriarExporters(FB, () => []);
    expect(FB.options).toHaveBeenCalledWith('traces');
    expect(FB.options).toHaveBeenCalledWith('metrics');
    expect(FB.options).toHaveBeenCalledWith('logs');
    expect(ex.metricExporter.selectAggregationTemporality!(InstrumentType.COUNTER)).toBe(AggregationTemporality.DELTA);
    expect(ex.metricExporter.selectAggregationTemporality!(InstrumentType.HISTOGRAM)).toBe(AggregationTemporality.DELTA);
  });
});

describe('Framebriar destination adapter', () => {
  const entry: TelemetryDestinationEntry = { id: 'framebriar', kind: 'framebriar', enabled: true, level: 'standard', preset: 'user_activity' };
  const settings = {} as never;

  it('is unconfigured until Feedback is connected', () => {
    setFramebriarTelemetrySource(null);
    expect(resolveEntry(entry, settings, {})).toMatchObject({ config: null, validation: { ok: false, reason: 'feedback_not_connected' } });
    setFramebriarTelemetrySource(() => null);
    expect(resolveEntry(entry, settings, {}).config).toBeNull();
  });

  it('names Framebriar\'s host for consent, and needs HTTPS', () => {
    setFramebriarTelemetrySource(() => FB);
    const { validation } = resolveEntry(entry, settings, {});
    expect(validation).toMatchObject({ ok: true, host: 'framebriar.example.net' });
    const plain = { ...FB, options: () => ({ url: 'http://framebriar.example.net/v1/otlp/v1/traces', headers: async () => ({}) }) };
    expect(getAdapter('framebriar').validate(plain)).toEqual({ ok: false, reason: 'https_required' });
    setFramebriarTelemetrySource(null);
  });

  it('copies install id, layout and channel onto events', () => {
    expect(getAdapter('framebriar').copyResourceAttributes).toEqual(['clubhouse.install.id', 'clubhouse.ui.chrome', 'clubhouse.channel']);
    expect(getAdapter('framebriar').label).toBe('Clubhouse developer (Framebriar)');
  });
});
