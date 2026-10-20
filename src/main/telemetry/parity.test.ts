/**
 * Signal parity (spec §6.12, maintainer decision on #2289): local recording
 * is the only gate on what is produced. Export on or off starts or stops no
 * producer and changes no producer level; with local logging off, nothing runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getAppMetrics = vi.hoisted(() => vi.fn(() => [] as unknown[]));
vi.mock('electron', () => ({ app: { getAppMetrics }, powerMonitor: { on: vi.fn() } }));
const broadcast = vi.hoisted(() => vi.fn());
vi.mock('../util/ipc-broadcast', () => ({ broadcastToAllWindows: broadcast }));

import {
  _setExportWithoutLocalForTests,
  EXPORT_WITHOUT_LOCAL_RECORDING,
  isTelemetryActive,
  replaySpan,
  setLocalSink,
  setRuntime,
  tel,
  telemetryLevel,
} from './facade';
import { passThroughSink } from './__test-utils__/producing-runtime';
import { _resetHealthForTests, installHealthTelemetry } from './health';
import { _resetRendererBridgeForTests, getTelemetryState, initRendererBridge } from './renderer-bridge';
import { _resetWorkspaceTelemetryForTests, installWorkspaceTelemetry } from './workspace-gauges';
import type { TelemetryRuntime } from './types';

function fakeRuntime(level: TelemetryRuntime['level'] = 'detailed'): TelemetryRuntime {
  return {
    level,
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

const projectCount = vi.fn(async () => 3);
const MINUTE = 60_000;

/** Every observable producer decision at this moment. */
function producerSnapshot() {
  return {
    active: isTelemetryActive(),
    level: telemetryLevel(),
    renderer: { producers: getTelemetryState().producers ?? false, level: getTelemetryState().level },
  };
}

/** Samples taken by the periodic producers over `minutes`. */
async function samplesOver(minutes: number): Promise<{ health: number; workspace: number }> {
  const h0 = getAppMetrics.mock.calls.length;
  const w0 = projectCount.mock.calls.length;
  await vi.advanceTimersByTimeAsync(minutes * MINUTE);
  return { health: getAppMetrics.mock.calls.length - h0, workspace: projectCount.mock.calls.length - w0 };
}

beforeEach(() => {
  vi.useFakeTimers();
  getAppMetrics.mockClear();
  projectCount.mockClear();
  initRendererBridge({ getMainWebContentsId: () => 1, getConfiguredLevel: () => 'detailed' });
  installHealthTelemetry();
  installWorkspaceTelemetry({ projectCount, activeWatchCount: () => 0 });
});

afterEach(() => {
  setRuntime(null);
  setLocalSink(null);
  _setExportWithoutLocalForTests(EXPORT_WITHOUT_LOCAL_RECORDING);
  _resetHealthForTests();
  _resetWorkspaceTelemetryForTests();
  _resetRendererBridgeForTests();
  vi.useRealTimers();
});

describe('signal parity with local recording on', () => {
  it('runs the same producers at the same level with export off, on, and off again', async () => {
    setLocalSink(passThroughSink('standard'));
    const off = { snapshot: producerSnapshot(), samples: await samplesOver(3) };

    setRuntime(fakeRuntime('detailed'));
    const on = { snapshot: producerSnapshot(), samples: await samplesOver(3) };

    setRuntime(null);
    const offAgain = { snapshot: producerSnapshot(), samples: await samplesOver(3) };

    expect(off.snapshot).toEqual({ active: true, level: 'standard', renderer: { producers: true, level: 'standard' } });
    expect(on).toEqual(off);
    expect(offAgain).toEqual(off);
    // Both periodic producers really ran: one sample a minute each.
    expect(off.samples).toEqual({ health: 3, workspace: 3 });
  });

  it('sends a running exporter every signal it records locally', () => {
    const sink = passThroughSink('standard');
    const counted = vi.spyOn(sink, 'count');
    setLocalSink(sink);
    const rt = fakeRuntime();
    setRuntime(rt);
    // The workspace gauge samples once as recording starts; count from here.
    counted.mockClear();
    tel.count('clubhouse.app.sessions', 1);
    tel.event('clubhouse.telemetry.test');
    replaySpan({ name: 'clubhouse.agent.kill', startMs: 1, endMs: 2, attrs: [], outcome: 'ok' });
    expect(tel.flow('clubhouse.agent.spawn', {}, () => 5)).toBe(5);
    expect(counted).toHaveBeenCalledTimes(1);
    expect(rt.count).toHaveBeenCalledTimes(1);
    expect(rt.event).toHaveBeenCalledTimes(1);
    expect(rt.replaySpan).toHaveBeenCalledTimes(1);
    expect(rt.flow).toHaveBeenCalledTimes(1);
  });
});

describe('with local logging (or telemetry recording) off', () => {
  it('runs no producer, with export off or on', async () => {
    const none = { active: false, level: null, renderer: { producers: false, level: null } };
    expect(producerSnapshot()).toEqual(none);
    expect(await samplesOver(3)).toEqual({ health: 0, workspace: 0 });

    setRuntime(fakeRuntime('detailed'));
    expect(producerSnapshot()).toMatchObject({ active: false, level: null, renderer: { producers: false } });
    expect(await samplesOver(3)).toEqual({ health: 0, workspace: 0 });
  });

  it(`policy EXPORT_WITHOUT_LOCAL_RECORDING=true: feature calls still reach a running exporter`, () => {
    _setExportWithoutLocalForTests(true);
    const rt = fakeRuntime('standard');
    setRuntime(rt);
    tel.event('clubhouse.telemetry.test');
    tel.flow('clubhouse.agent.spawn', {}, () => 1);
    expect(rt.event).toHaveBeenCalledTimes(1);
    expect(rt.flow).toHaveBeenCalledTimes(1);
    expect(getTelemetryState()).toEqual({ enabled: true, level: 'standard', producers: false });
  });

  it(`policy EXPORT_WITHOUT_LOCAL_RECORDING=false: nothing is produced, so nothing is exported`, () => {
    _setExportWithoutLocalForTests(false);
    const rt = fakeRuntime('standard');
    setRuntime(rt);
    tel.count('clubhouse.app.sessions', 1);
    tel.event('clubhouse.telemetry.test');
    tel.exception(new Error('x'), { origin: 'main', handled: true });
    replaySpan({ name: 'clubhouse.agent.kill', startMs: 1, endMs: 2, attrs: [], outcome: 'ok' });
    expect(tel.flow('clubhouse.agent.spawn', {}, () => 1)).toBe(1);
    expect(tel.step('clubhouse.provider.resolve', () => 2)).toBe(2);
    for (const fn of [rt.count, rt.event, rt.exception, rt.replaySpan, rt.flow, rt.step]) expect(fn).not.toHaveBeenCalled();
    expect(getTelemetryState()).toEqual({ enabled: false, level: null });
  });
});
