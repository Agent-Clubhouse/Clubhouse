import { afterEach, describe, expect, it, vi } from 'vitest';
import { ATTR } from '../../shared/telemetry/attributes';
import {
  abortPending,
  beginPending,
  currentTraceIds,
  flushBeforeExit,
  isPending,
  PENDING_BUFFER_CAP,
  setRuntime,
  tel,
  withErrorType,
  setLocalSink,
} from './facade';
import { passThroughSink } from './__test-utils__/producing-runtime';
import { errorTypeOf, type TelemetryRuntime } from './types';

function fakeRuntime(overrides: Partial<TelemetryRuntime> = {}): TelemetryRuntime {
  return {
    level: 'standard',
    flow: vi.fn((_n, _o, fn) => fn({ set: () => {} })),
    step: vi.fn((_n, fn) => fn({ set: () => {} })),
    count: vi.fn(),
    event: vi.fn(),
    exception: vi.fn(),
    replaySpan: vi.fn(),
    preview: () => [],
    forceFlush: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    ...overrides,
  };
}

afterEach(() => {
  setRuntime(null);
  setLocalSink(null);
  abortPending();
});

describe('telemetry facade', () => {
  it('runs flows directly and drops calls while disabled', async () => {
    expect(tel.flow('clubhouse.telemetry.test', {}, (span) => {
      span.set(ATTR.outcome('ok'));
      return 42;
    })).toBe(42);
    await expect(tel.flow('clubhouse.telemetry.test', {}, async () => 'async')).resolves.toBe('async');
    tel.count('clubhouse.app.sessions');
    tel.event('clubhouse.telemetry.test');
    tel.exception(new Error('x'), { origin: 'main', handled: true });
    expect(isPending()).toBe(false);
  });

  it('rethrows from flows unchanged while disabled', () => {
    const err = new Error('boom');
    expect(() => tel.flow('clubhouse.telemetry.test', {}, () => {
      throw err;
    })).toThrow(err);
  });

  it('buffers calls during startup and replays them in order once the runtime is set', async () => {
    beginPending();
    // Export only receives what local recording produces (spec §6.12).
    setLocalSink(passThroughSink('detailed'));
    tel.count('clubhouse.app.sessions', 1, [ATTR.startupKind('cold')]);
    tel.flow('clubhouse.telemetry.test', { attrs: [ATTR.process('main')] }, (span) => span.set(ATTR.errorType('timeout')));
    tel.event('clubhouse.telemetry.test');
    await tel.flow('clubhouse.telemetry.test', {}, async () => 'x', { classify: () => ({ error: 'init_failed' }) });
    await Promise.resolve();

    const rt = fakeRuntime();
    setRuntime(rt);
    expect(isPending()).toBe(false);
    expect(rt.count).toHaveBeenCalledWith('clubhouse.app.sessions', 1, [ATTR.startupKind('cold')]);
    expect(rt.event).toHaveBeenCalledWith('clubhouse.telemetry.test', undefined);
    const replays = vi.mocked(rt.replaySpan).mock.calls.map(([s]) => s);
    expect(replays).toHaveLength(2);
    expect(replays[0]).toMatchObject({ outcome: 'ok', attrs: [ATTR.process('main'), ATTR.errorType('timeout')] });
    expect(replays[1]).toMatchObject({ outcome: 'error', errorType: 'init_failed' });
    expect(replays[0].endMs).toBeGreaterThanOrEqual(replays[0].startMs);

    // Live calls now go straight to the runtime.
    tel.count('clubhouse.app.sessions');
    expect(rt.count).toHaveBeenCalledTimes(2);
  });

  it('caps the startup buffer at 500 items', () => {
    beginPending();
    // Export only receives what local recording produces (spec §6.12).
    setLocalSink(passThroughSink('detailed'));
    for (let i = 0; i < PENDING_BUFFER_CAP + 50; i++) tel.count('clubhouse.app.sessions');
    const rt = fakeRuntime();
    setRuntime(rt);
    expect(rt.count).toHaveBeenCalledTimes(PENDING_BUFFER_CAP);
  });

  it('discards the buffer when startup is aborted', () => {
    beginPending();
    // Export only receives what local recording produces (spec §6.12).
    setLocalSink(passThroughSink('detailed'));
    tel.event('clubhouse.telemetry.test');
    abortPending();
    const rt = fakeRuntime();
    setRuntime(rt);
    expect(rt.event).not.toHaveBeenCalled();
  });

  it('records buffered exceptions from failing startup flows', async () => {
    beginPending();
    // Export only receives what local recording produces (spec §6.12).
    setLocalSink(passThroughSink('detailed'));
    const err = new Error('nope');
    await expect(tel.flow('clubhouse.telemetry.test', {}, async () => {
      throw err;
    })).rejects.toBe(err);
    const rt = fakeRuntime();
    setRuntime(rt);
    expect(rt.exception).toHaveBeenCalledWith(err, { origin: 'main', handled: false });
    expect(vi.mocked(rt.replaySpan).mock.calls[0][0]).toMatchObject({ outcome: 'error', errorType: 'unknown' });
  });

  it('withErrorType returns fn\'s own value, sync or async, and is a plain call while off', async () => {
    expect(withErrorType('cwd_invalid', () => 7)).toBe(7);
    const p = Promise.resolve(1);
    expect(withErrorType('cwd_invalid', () => p)).toBe(p);
    const err = new Error('x');
    expect(() => withErrorType('cwd_invalid', () => { throw err; })).toThrow(err);
    expect(errorTypeOf(err)).toBe('unknown');
    setLocalSink(passThroughSink());
    setRuntime(fakeRuntime());
    await expect(withErrorType('cwd_invalid', () => Promise.reject(err))).rejects.toBe(err);
    expect(errorTypeOf(err)).toBe('cwd_invalid');
    expect(withErrorType('cwd_invalid', () => 8)).toBe(8);
  });

  it('keeps the tagged error type on buffered startup flows', async () => {
    beginPending();
    // Export only receives what local recording produces (spec §6.12).
    setLocalSink(passThroughSink('detailed'));
    const err = new Error('nope');
    await expect(tel.flow('clubhouse.telemetry.test', {}, () => withErrorType('cwd_invalid', async () => {
      throw err;
    }))).rejects.toBe(err);
    const rt = fakeRuntime();
    setRuntime(rt);
    expect(vi.mocked(rt.replaySpan).mock.calls[0][0]).toMatchObject({ outcome: 'error', errorType: 'cwd_invalid' });
  });
});

describe('currentTraceIds', () => {
  it('never throws, since appLog calls it on every line', () => {
    expect(currentTraceIds()).toBeUndefined();
    setRuntime(fakeRuntime());
    expect(currentTraceIds()).toBeUndefined();
    setRuntime(fakeRuntime({ activeTraceIds: () => { throw new Error('broken context'); } }));
    expect(currentTraceIds()).toBeUndefined();
    setRuntime(fakeRuntime({ activeTraceIds: () => ({ traceId: 't', spanId: 's' }) }));
    expect(currentTraceIds()).toEqual({ traceId: 't', spanId: 's' });
  });
});

describe('flushBeforeExit', () => {
  it('is a no-op while disabled', async () => {
    await expect(flushBeforeExit(10)).resolves.toBeUndefined();
  });

  it('flushes the runtime with the given timeout', async () => {
    const rt = fakeRuntime();
    setRuntime(rt);
    await flushBeforeExit(1234);
    expect(rt.forceFlush).toHaveBeenCalledWith(1234);
  });

  it('never waits past its timeout or throws', async () => {
    setRuntime(fakeRuntime({ forceFlush: () => new Promise(() => {}) }));
    const t0 = Date.now();
    await flushBeforeExit(30);
    expect(Date.now() - t0).toBeLessThan(1000);

    setRuntime(fakeRuntime({ forceFlush: async () => { throw new Error('down'); } }));
    await expect(flushBeforeExit(30)).resolves.toBeUndefined();
  });
});
