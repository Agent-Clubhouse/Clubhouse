import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ATTR } from '../../shared/telemetry/attributes';
import {
  FLUSH_AT_ITEMS,
  FLUSH_INTERVAL_MS,
  MAX_QUEUED_ITEMS,
  _resetRendererTelemetryForTests,
  _setStateForTests,
  flushTelemetry,
  initRendererTelemetry,
  isTelemetryEnabled,
  markRendererReady,
  onTelemetryEnabledChange,
  tel,
} from './facade';

function fakeBridge() {
  let listener: ((s: unknown) => void) | null = null;
  return {
    emit: vi.fn(),
    rendererReady: vi.fn(),
    getState: vi.fn(async () => ({ enabled: false, level: null })),
    onStateChanged: vi.fn((cb: (s: unknown) => void) => {
      listener = cb;
      return () => {
        listener = null;
      };
    }),
    push: (s: unknown) => listener?.(s),
  };
}

let bridge: ReturnType<typeof fakeBridge>;

beforeEach(() => {
  vi.useFakeTimers();
  bridge = fakeBridge();
  initRendererTelemetry(bridge);
});

afterEach(() => {
  _resetRendererTelemetryForTests();
  vi.useRealTimers();
});

describe('renderer telemetry facade', () => {
  it('runs flows directly and sends nothing while disabled', () => {
    expect(tel.flow('clubhouse.renderer.unresponsive', {}, () => 42)).toBe(42);
    tel.count('clubhouse.renderer.long_frames', 1);
    tel.exception(new Error('x'), { handled: true });
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS * 2);
    flushTelemetry();
    expect(bridge.emit).not.toHaveBeenCalled();
  });

  it('keeps producers off while main forwards calls for an exporter alone (#2278 parity)', () => {
    const changes: boolean[] = [];
    onTelemetryEnabledChange((on) => changes.push(on));
    bridge.push({ enabled: true, level: 'standard', producers: false });
    expect(isTelemetryEnabled()).toBe(false);
    tel.event('clubhouse.renderer.gone');
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
    expect(bridge.emit).toHaveBeenCalledTimes(1);
    bridge.push({ enabled: true, level: 'standard', producers: true });
    expect(isTelemetryEnabled()).toBe(true);
    bridge.push({ enabled: false, level: null });
    expect(changes).toEqual([true, false]);
  });

  it('follows state changes pushed from main', () => {
    bridge.push({ enabled: true, level: 'standard' });
    tel.count('clubhouse.renderer.long_frames', 2, [ATTR.view('canvas')]);
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
    expect(bridge.emit).toHaveBeenCalledTimes(1);
    expect(bridge.emit.mock.calls[0][0]).toEqual({
      v: 1,
      items: [{ t: 'count', name: 'clubhouse.renderer.long_frames', value: 2, attrs: [ATTR.view('canvas')] }],
    });
  });

  it('flushes early at the batch size and caps the queue', () => {
    _setStateForTests({ enabled: true, level: 'standard' });
    for (let i = 0; i < FLUSH_AT_ITEMS; i++) tel.count('clubhouse.renderer.long_frames');
    expect(bridge.emit).toHaveBeenCalledTimes(1);
    bridge.emit.mockClear();
    // Simulate a stuck bridge: queue fills, extra items are dropped.
    const emit = bridge.emit;
    bridge.emit = vi.fn(() => {
      throw new Error('ipc down');
    });
    for (let i = 0; i < MAX_QUEUED_ITEMS + 100; i++) tel.event('clubhouse.renderer.gone');
    bridge.emit = emit;
    expect(() => flushTelemetry()).not.toThrow();
  });

  it('respects metric and span levels', () => {
    _setStateForTests({ enabled: true, level: 'errors' });
    tel.count('clubhouse.renderer.long_frames'); // standard-level metric
    tel.count('clubhouse.renderer.unresponsive_count'); // errors-level metric
    flushTelemetry();
    const items = bridge.emit.mock.calls[0][0].items;
    expect(items.map((i: { name: string }) => i.name)).toEqual(['clubhouse.renderer.unresponsive_count']);
  });

  it('records spans with outcome and rethrows errors unchanged', () => {
    _setStateForTests({ enabled: true, level: 'standard' });
    const boom = new TypeError('secret path /Users/x');
    expect(() => tel.flow('clubhouse.renderer.unresponsive', {}, () => {
      throw boom;
    })).toThrow(boom);
    flushTelemetry();
    const items = bridge.emit.mock.calls[0][0].items;
    expect(items[0]).toMatchObject({ t: 'exception', errorType: 'TypeError', handled: false });
    // The message line of error.stack never crosses IPC; only frames do.
    expect(JSON.stringify(items)).not.toContain('secret path');
    expect(items[0].stack).toMatch(/^\s*at /);
    expect(items[1]).toMatchObject({ t: 'span', outcome: 'error', errorType: 'unknown' });
  });

  it('classifies return values', async () => {
    _setStateForTests({ enabled: true, level: 'standard' });
    await tel.flow('clubhouse.renderer.unresponsive', {}, async () => false, {
      classify: (ok) => (ok ? 'ok' : { error: 'timeout' }),
    });
    flushTelemetry();
    expect(bridge.emit.mock.calls[0][0].items[0]).toMatchObject({ outcome: 'error', errorType: 'timeout' });
  });

  it('drops queued items when telemetry is turned off', () => {
    bridge.push({ enabled: true, level: 'standard' });
    tel.event('clubhouse.renderer.gone');
    bridge.push({ enabled: false, level: null });
    flushTelemetry();
    expect(bridge.emit).not.toHaveBeenCalled();
  });

  it('sends renderer-ready only once', () => {
    markRendererReady();
    markRendererReady();
    expect(bridge.rendererReady).toHaveBeenCalledTimes(1);
  });
});
