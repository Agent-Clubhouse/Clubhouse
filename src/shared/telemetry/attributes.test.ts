import { describe, expect, it } from 'vitest';
import {
  ATTR,
  allAttributeKeys,
  EVENTS,
  getAttributeSpec,
  isKnownEvent,
  isKnownMetric,
  isKnownSpan,
  levelAllows,
  METRICS,
  OTHER,
  SPANS,
  type TelAttr,
} from './attributes';

// One sample per registry entry. Adding an ATTR key without a sample here
// fails the "every key has a test" check below (spec §5.1 (a)).
const SAMPLES: Record<keyof typeof ATTR, { good: TelAttr; key: string }> = {
  outcome: { good: ATTR.outcome('ok'), key: 'clubhouse.outcome' },
  errorType: { good: ATTR.errorType('timeout'), key: 'error.type' },
  process: { good: ATTR.process('main'), key: 'clubhouse.process' },
  startupKind: { good: ATTR.startupKind('after_update'), key: 'clubhouse.startup.kind' },
  telemetrySignal: { good: ATTR.telemetrySignal('logs'), key: 'clubhouse.telemetry.signal' },
  httpClass: { good: ATTR.httpClass('5xx'), key: 'clubhouse.http.class' },
  telemetryDestination: { good: ATTR.telemetryDestination('otlp'), key: 'clubhouse.telemetry.destination' },
  agentKind: { good: ATTR.agentKind('durable'), key: 'clubhouse.agent.kind' },
  orchestrator: { good: ATTR.orchestrator('codex-cli'), key: 'clubhouse.orchestrator' },
  agentRuntime: { good: ATTR.agentRuntime('structured'), key: 'clubhouse.agent.runtime' },
  exitCode: { good: ATTR.exitCode(137), key: 'process.exit.code' },
  agentIdHash: { good: ATTR.agentIdHash('agent_123'), key: 'clubhouse.agent.id_hash' },
  sizeBucket: { good: ATTR.sizeBucket('<1MB'), key: 'clubhouse.size_bucket' },
  exceptionHandled: { good: ATTR.exceptionHandled(true), key: 'clubhouse.exception.handled' },
  exceptionOrigin: { good: ATTR.exceptionOrigin('renderer'), key: 'clubhouse.exception.origin' },
  updateFromVersion: { good: ATTR.updateFromVersion('0.42.0'), key: 'clubhouse.update.from_version' },
};

describe('telemetry attribute registry', () => {
  it('has a test sample for every registry key', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(Object.keys(ATTR).sort());
  });

  it.each(Object.entries(SAMPLES))('%s produces its declared key and a registered spec', (_name, sample) => {
    expect(sample.good.key).toBe(sample.key);
    const spec = getAttributeSpec(sample.key);
    expect(spec).toBeDefined();
    expect(spec?.kind).toBe(sample.good.kind);
  });

  it('normalizes enum values outside the set to "other"', () => {
    // Runtime values can escape the type system (e.g. from parsed data).
    const bogus = 'C:\\Users\\alice' as unknown as 'ok';
    expect(ATTR.outcome(bogus).value).toBe(OTHER);
    expect(ATTR.orchestrator('my-secret-cli' as 'other').value).toBe(OTHER);
  });

  it('truncates ints and coerces bools', () => {
    expect(ATTR.exitCode(1.9).value).toBe(1);
    expect(ATTR.exceptionHandled('yes' as unknown as boolean).value).toBe(false);
  });

  it('keeps hash attributes raw until the main-process facade hashes them', () => {
    expect(ATTR.agentIdHash('agent_1')).toEqual({ key: 'clubhouse.agent.id_hash', kind: 'hash', value: 'agent_1' });
  });

  it('snapshots the full key list so additions show up in review', () => {
    expect(allAttributeKeys()).toMatchInlineSnapshot(`
      [
        "clubhouse.agent.id_hash",
        "clubhouse.agent.kind",
        "clubhouse.agent.runtime",
        "clubhouse.exception.handled",
        "clubhouse.exception.origin",
        "clubhouse.http.class",
        "clubhouse.orchestrator",
        "clubhouse.outcome",
        "clubhouse.process",
        "clubhouse.size_bucket",
        "clubhouse.startup.kind",
        "clubhouse.telemetry.destination",
        "clubhouse.telemetry.signal",
        "clubhouse.update.from_version",
        "error.type",
        "process.exit.code",
      ]
    `);
  });

  it('declares only registry keys as metric dimensions, and never hashes', () => {
    for (const [name, def] of Object.entries(METRICS)) {
      expect(name.startsWith('clubhouse.')).toBe(true);
      for (const key of def.attributes) {
        const spec = getAttributeSpec(key);
        expect(spec, `${name} → ${key}`).toBeDefined();
        expect(spec?.kind).not.toBe('hash');
      }
    }
  });

  it('uses static clubhouse.* names for spans and events', () => {
    for (const name of [...Object.keys(SPANS), ...Object.keys(EVENTS)]) {
      expect(name).toMatch(/^clubhouse\.[a-z_]+(\.[a-z_]+)*$/);
    }
    expect(isKnownSpan('clubhouse.telemetry.test')).toBe(true);
    expect(isKnownMetric('clubhouse.app.sessions')).toBe(true);
    expect(isKnownEvent('clubhouse.telemetry.disabled')).toBe(true);
    expect(isKnownSpan('http.request')).toBe(false);
    expect(isKnownEvent('toString')).toBe(false);
  });

  it('orders levels errors < standard < detailed', () => {
    expect(levelAllows('errors', 'errors')).toBe(true);
    expect(levelAllows('errors', 'standard')).toBe(false);
    expect(levelAllows('standard', 'standard')).toBe(true);
    expect(levelAllows('standard', 'detailed')).toBe(false);
    expect(levelAllows('detailed', 'detailed')).toBe(true);
  });
});
