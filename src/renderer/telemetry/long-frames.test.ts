import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ATTR } from '../../shared/telemetry/attributes';
import { _resetRendererTelemetryForTests, _setStateForTests, initRendererTelemetry, flushTelemetry } from './facade';
import { MAX_DURATION_SAMPLES, _resetLongFramesForTests, flushLongFrames, isAggregatingLongFrames, recordLongFrame, setTelemetryView, startLongFrameCollection } from './long-frames';

const emit = vi.fn();

beforeEach(() => {
  emit.mockClear();
  initRendererTelemetry({ emit, rendererReady: vi.fn(), getState: async () => ({ enabled: true, level: 'standard' }), onStateChanged: () => () => {} });
  _setStateForTests({ enabled: true, level: 'standard' });
});

afterEach(() => {
  _resetLongFramesForTests();
  _resetRendererTelemetryForTests();
});

describe('long frames', () => {
  it('aggregates per view and samples durations', () => {
    setTelemetryView('terminal');
    for (let i = 0; i < MAX_DURATION_SAMPLES + 5; i++) recordLongFrame(80);
    recordLongFrame(120, 'canvas');
    flushLongFrames();
    flushTelemetry();
    const items = emit.mock.calls.flatMap((c) => c[0].items);
    const counts = items.filter((i: { name: string }) => i.name === 'clubhouse.renderer.long_frames');
    expect(counts).toEqual([
      { t: 'count', name: 'clubhouse.renderer.long_frames', value: MAX_DURATION_SAMPLES + 5, attrs: [ATTR.view('terminal')] },
      { t: 'count', name: 'clubhouse.renderer.long_frames', value: 1, attrs: [ATTR.view('canvas')] },
    ]);
    const durations = items.filter((i: { name: string }) => i.name === 'clubhouse.renderer.long_frame.duration');
    expect(durations).toHaveLength(MAX_DURATION_SAMPLES + 1);
    expect(durations[0].value).toBeCloseTo(0.08);
  });

  it('runs the per-minute aggregate only while telemetry is on', () => {
    _setStateForTests({ enabled: false, level: null });
    startLongFrameCollection();
    expect(isAggregatingLongFrames()).toBe(false);
    _setStateForTests({ enabled: true, level: 'standard' });
    expect(isAggregatingLongFrames()).toBe(true);
    _setStateForTests({ enabled: false, level: null });
    expect(isAggregatingLongFrames()).toBe(false);
  });

  it('records nothing while telemetry is off', () => {
    _setStateForTests({ enabled: false, level: null });
    recordLongFrame(200);
    flushLongFrames();
    flushTelemetry();
    expect(emit).not.toHaveBeenCalled();
  });
});
