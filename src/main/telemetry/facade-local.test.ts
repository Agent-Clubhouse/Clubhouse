/**
 * The facade with the local recorder installed (#2278): signals are recorded
 * with no SDK runtime, and an SDK runtime sees exactly what it saw before.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ATTR } from '../../shared/telemetry/attributes';
import {
  abortPending,
  currentTraceIds,
  forceFlushTelemetry,
  isTelemetryActive,
  onRuntimeChange,
  replaySpan,
  setLocalSink,
  setRuntime,
  tel,
  telemetryLevel,
  withErrorType,
} from './facade';
import { createLocalRecorder, type LocalRecorder } from './local-recorder';
import { createScrubber } from './scrubber';
import type { TelemetryRuntime } from './types';

function fakeRuntime(): TelemetryRuntime {
  return {
    level: 'detailed',
    flow: vi.fn((_n, _o, fn) => fn({ set: vi.fn() })),
    step: vi.fn((_n, fn) => fn({ set: vi.fn() })),
    count: vi.fn(),
    event: vi.fn(),
    exception: vi.fn(),
    activeTraceIds: vi.fn(() => undefined),
    replaySpan: vi.fn(),
    replayTree: vi.fn(),
    traceparent: vi.fn(),
    withRemoteParent: vi.fn((_t, fn) => fn()),
    preview: () => [],
    recentExports: () => [],
    destinationHealth: () => ({}),
    forceFlush: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
  };
}

let written = '';
let recorder: LocalRecorder | null = null;

function installRecorder(): LocalRecorder {
  recorder = createLocalRecorder({
    dir: '/logs',
    fileBase: 'run',
    level: 'standard',
    hashSalt: Buffer.alloc(32, 1),
    scrub: createScrubber({ homeDir: '/Users/sam-tester' }),
    session: { appVersion: '1.0.0', platform: 'linux', arch: 'x64' },
    flushIntervalMs: 60_000,
    appendFile: async (_f, data) => {
      written += data;
    },
    mkdir: async () => {},
  });
  setLocalSink(recorder);
  return recorder;
}

const records = () => written.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);

afterEach(async () => {
  setLocalSink(null);
  await recorder?.stop();
  recorder = null;
  written = '';
  setRuntime(null);
  abortPending();
});

/** One of each call, as feature code makes them. */
async function exercise(): Promise<unknown[]> {
  const out: unknown[] = [];
  out.push(tel.flow('clubhouse.agent.spawn', { attrs: [ATTR.orchestrator('codex-cli')] }, (span) => {
    span.set(ATTR.outcome('ok'));
    return tel.step('clubhouse.provider.resolve', () => 'resolved');
  }));
  out.push(await tel.flow('clubhouse.agent.run', {}, async () => 7, { classify: () => ({ error: 'timeout' }) }));
  try {
    tel.flow('clubhouse.agent.create', {}, () => {
      throw new Error('boom /Users/sam-tester/secret');
    });
  } catch (err) {
    out.push((err as Error).message);
  }
  tel.count('clubhouse.app.sessions', 1, [ATTR.startupKind('cold')]);
  tel.event('clubhouse.telemetry.test', [ATTR.orchestrator('claude-code')], { severity: 'error' });
  tel.exception(new TypeError('raw text'), { origin: 'main', handled: true });
  replaySpan({ name: 'clubhouse.agent.kill', startMs: 1, endMs: 5, attrs: [], outcome: 'ok' });
  return out;
}

describe('facade with local recording and telemetry off', () => {
  it('writes scrubbed flows, steps, events, exceptions and metric totals', async () => {
    installRecorder();
    expect(isTelemetryActive()).toBe(true);
    expect(telemetryLevel()).toBe('standard');
    const out = await exercise();
    expect(out).toEqual(['resolved', 7, 'boom /Users/sam-tester/secret']);
    await forceFlushTelemetry();
    const r = records();
    const spans = r.filter((x) => x.t === 'span');
    const spawn = spans.find((s) => s.name === 'clubhouse.agent.spawn')!;
    expect(spawn).toMatchObject({ outcome: 'ok', attrs: { 'clubhouse.orchestrator': 'codex-cli', 'clubhouse.outcome': 'ok' } });
    expect(typeof spawn.durationMs).toBe('number');
    expect(spans.find((s) => s.name === 'clubhouse.provider.resolve')).toMatchObject({ parentSpanId: spawn.spanId, traceId: spawn.traceId });
    expect(spans.find((s) => s.name === 'clubhouse.agent.run')).toMatchObject({ outcome: 'error', errorType: 'timeout' });
    expect(spans.find((s) => s.name === 'clubhouse.agent.create')).toMatchObject({ outcome: 'error', errorType: 'unknown' });
    expect(spans.find((s) => s.name === 'clubhouse.agent.kill')).toMatchObject({ durationMs: 4 });
    expect(r.filter((x) => x.t === 'exception').map((x) => x.type)).toEqual(['Error', 'TypeError']);
    expect(r.find((x) => x.t === 'event')).toMatchObject({ name: 'clubhouse.telemetry.test', severity: 'error' });
    expect(r.find((x) => x.t === 'metric')).toMatchObject({ name: 'clubhouse.app.sessions', sum: 1 });
    expect(written).not.toContain('boom');
    expect(written).not.toContain('raw text');
    expect(written).not.toContain('sam-tester');
  });

  it('gives appLog lines the local trace ids inside a flow', () => {
    installRecorder();
    let ids: unknown;
    tel.flow('clubhouse.agent.spawn', {}, () => {
      ids = currentTraceIds();
    });
    expect(ids).toMatchObject({ traceId: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(currentTraceIds()).toBeUndefined();
  });

  it('tags error types for classification', () => {
    installRecorder();
    let caught: unknown;
    try {
      tel.flow('clubhouse.agent.spawn', {}, () => withErrorType('spawn_failed', () => {
        throw new Error('x');
      }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
  });

  it('records the tagged error type on the local span', async () => {
    installRecorder();
    expect(() => tel.flow('clubhouse.agent.spawn', {}, () => withErrorType('spawn_failed', () => {
      throw new Error('x');
    }))).toThrow('x');
    await forceFlushTelemetry();
    expect(records().find((r) => r.t === 'span')).toMatchObject({ outcome: 'error', errorType: 'spawn_failed' });
  });

  it('notifies runtime listeners when recording starts and stops', () => {
    const listener = vi.fn();
    const off = onRuntimeChange(listener);
    installRecorder();
    setLocalSink(null);
    off();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(isTelemetryActive()).toBe(false);
  });

  it('keeps the disabled path a plain call with no recorder', async () => {
    expect(isTelemetryActive()).toBe(false);
    const fn = vi.fn(() => 1);
    expect(tel.flow('clubhouse.agent.spawn', {}, fn)).toBe(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(withErrorType('timeout', () => 2)).toBe(2);
    await forceFlushTelemetry();
    expect(written).toBe('');
  });
});

describe('facade export path with local recording on', () => {
  it('still reaches the SDK runtime when the local sink throws', () => {
    const boom = () => {
      throw new Error('sink failure');
    };
    setLocalSink({
      level: 'standard',
      wrap: (_n, _o, fn) => fn,
      count: boom,
      event: boom,
      exception: boom,
      replaySpan: boom,
      replayTree: boom,
      activeTraceIds: () => undefined,
      flush: async () => {},
    });
    const rt = fakeRuntime();
    setRuntime(rt);
    tel.count('clubhouse.app.sessions', 1);
    tel.event('clubhouse.telemetry.test');
    tel.exception(new Error('e'), { origin: 'main', handled: true });
    replaySpan({ name: 'clubhouse.agent.kill', startMs: 1, endMs: 2, attrs: [], outcome: 'ok' });
    expect(rt.count).toHaveBeenCalledTimes(1);
    expect(rt.event).toHaveBeenCalledTimes(1);
    expect(rt.exception).toHaveBeenCalledTimes(1);
    expect(rt.replaySpan).toHaveBeenCalledTimes(1);
  });

  /** The calls a runtime receives, minus the wrapped callbacks. */
  function callsOf(rt: TelemetryRuntime) {
    const m = (f: unknown) => (f as ReturnType<typeof vi.fn>).mock.calls;
    return {
      flow: m(rt.flow).map(([n, o, , e]) => [n, o, e]),
      step: m(rt.step).map(([n, , o]) => [n, o]),
      count: m(rt.count),
      event: m(rt.event),
      exception: m(rt.exception).map(([e, o]) => [(e as Error).message, o]),
      replaySpan: m(rt.replaySpan),
    };
  }

  it('sends the SDK runtime the same calls and results as without it', async () => {
    const without = fakeRuntime();
    setRuntime(without);
    const outWithout = await exercise();
    setRuntime(null);

    installRecorder();
    const withLocal = fakeRuntime();
    setRuntime(withLocal);
    const outWith = await exercise();

    expect(outWith).toEqual(outWithout);
    // Serialized: each run passes its own classify closure.
    expect(JSON.stringify(callsOf(withLocal))).toBe(JSON.stringify(callsOf(without)));
    expect((withLocal.flow as ReturnType<typeof vi.fn>).mock.calls[1][3].classify).toBeTypeOf('function');
    // The SDK's span handle still receives attributes set inside the flow.
    const handleSet = vi.fn();
    (withLocal.flow as ReturnType<typeof vi.fn>).mockImplementationOnce((_n, _o, fn) => fn({ set: handleSet }));
    tel.flow('clubhouse.agent.spawn', {}, (span) => span.set(ATTR.outcome('ok')));
    expect(handleSet).toHaveBeenCalledWith(ATTR.outcome('ok'));
    // Producers run at local recording's level, not the exporter's (parity).
    expect(telemetryLevel()).toBe('standard');
    await forceFlushTelemetry();
    expect(withLocal.forceFlush).toHaveBeenCalled();
    expect(records().some((r) => r.t === 'span')).toBe(true);
  });
});
