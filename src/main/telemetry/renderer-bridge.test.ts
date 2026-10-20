import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => ({ on: new Map<string, (...a: unknown[]) => void>(), handle: new Map<string, (...a: unknown[]) => unknown>() }));

vi.mock('electron', () => ({
  ipcMain: {
    on: vi.fn((ch: string, fn: (...a: unknown[]) => void) => handlers.on.set(ch, fn)),
    handle: vi.fn((ch: string, fn: (...a: unknown[]) => unknown) => handlers.handle.set(ch, fn)),
  },
}));
const broadcast = vi.hoisted(() => vi.fn());
vi.mock('../util/ipc-broadcast', () => ({ broadcastToAllWindows: broadcast }));

import { IPC } from '../../shared/ipc-channels';
import { ATTR } from '../../shared/telemetry/attributes';
import { RENDERER_PROTOCOL_VERSION } from '../../shared/telemetry/renderer-protocol';
import { beginPending, setLocalSink, setRuntime } from './facade';
import type { LocalTelemetrySink } from './types';
import {
  _resetRendererBridgeForTests,
  dispatchRendererItems,
  getTelemetryState,
  onRendererReady,
} from './renderer-bridge';
import { registerTelemetryRendererHandlers } from '../ipc/telemetry-renderer-handlers';
import { ForwardedError, type TelemetryRuntime } from './types';

function fakeRuntime(): TelemetryRuntime {
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
  };
}

const MAIN_ID = 1;
const mainSender = { sender: { id: MAIN_ID } };
const popoutSender = { sender: { id: 7 } };

beforeEach(() => {
  handlers.on.clear();
  handlers.handle.clear();
  broadcast.mockClear();
  registerTelemetryRendererHandlers({ getMainWebContentsId: () => MAIN_ID, getConfiguredLevel: () => 'standard' });
});

function fakeLocalSink(): LocalTelemetrySink {
  return {
    level: 'standard',
    wrap: (_n, _o, fn) => fn,
    count: vi.fn(),
    event: vi.fn(),
    exception: vi.fn(),
    replaySpan: vi.fn(),
    replayTree: vi.fn(),
    activeTraceIds: () => undefined,
    flush: vi.fn(async () => {}),
  };
}

afterEach(() => {
  setLocalSink(null);
  setRuntime(null);
  _resetRendererBridgeForTests();
});

describe('renderer bridge', () => {
  it('reports disabled until a runtime exists', () => {
    expect(getTelemetryState()).toEqual({ enabled: false, level: null });
    setRuntime(fakeRuntime());
    expect(getTelemetryState()).toEqual({ enabled: true, level: 'standard' });
  });

  it('tells renderers to record for local recording alone (#2278)', () => {
    setLocalSink(fakeLocalSink());
    expect(getTelemetryState()).toEqual({ enabled: true, level: 'standard' });
    expect(broadcast).toHaveBeenLastCalledWith(IPC.TELEMETRY.STATE_CHANGED, { enabled: true, level: 'standard' });
    // The SDK's more verbose level wins, so its export is unchanged.
    const rt = fakeRuntime();
    (rt as { level: string }).level = 'detailed';
    setRuntime(rt);
    expect(getTelemetryState()).toEqual({ enabled: true, level: 'detailed' });
    setRuntime(null);
    setLocalSink(null);
    expect(getTelemetryState()).toEqual({ enabled: false, level: null });
  });

  it('feeds renderer batches into the local recorder with no SDK runtime', () => {
    const sink = fakeLocalSink();
    setLocalSink(sink);
    handlers.on.get(IPC.TELEMETRY.EMIT)!(mainSender, {
      v: RENDERER_PROTOCOL_VERSION,
      items: [
        { t: 'event', name: 'clubhouse.renderer.gone', attrs: [] },
        { t: 'span', name: 'clubhouse.agent.spawn', startMs: 1, endMs: 3, attrs: [], outcome: 'ok' },
      ],
    });
    expect(sink.event).toHaveBeenCalledWith('clubhouse.renderer.gone', [ATTR.process('renderer'), ATTR.windowKind('main')], undefined);
    expect(sink.replaySpan).toHaveBeenCalledWith(expect.objectContaining({ name: 'clubhouse.agent.spawn', attrs: [ATTR.process('renderer'), ATTR.windowKind('main')] }));
  });

  it('reports the configured level while the SDK is still loading', () => {
    beginPending();
    expect(getTelemetryState()).toEqual({ enabled: true, level: 'standard' });
  });

  it('broadcasts the new state when telemetry starts or stops', () => {
    setRuntime(fakeRuntime());
    expect(broadcast).toHaveBeenLastCalledWith(IPC.TELEMETRY.STATE_CHANGED, { enabled: true, level: 'standard' });
    setRuntime(null);
    expect(broadcast).toHaveBeenLastCalledWith(IPC.TELEMETRY.STATE_CHANGED, { enabled: false, level: null });
  });

  it('ignores batches while telemetry is off', () => {
    const rt = fakeRuntime();
    handlers.on.get(IPC.TELEMETRY.EMIT)!(mainSender, { v: RENDERER_PROTOCOL_VERSION, items: [{ t: 'event', name: 'clubhouse.renderer.gone', attrs: [] }] });
    setRuntime(rt);
    expect(rt.event).not.toHaveBeenCalled();
  });

  it('tags items with the window kind main decides, not the renderer', () => {
    const rt = fakeRuntime();
    setRuntime(rt);
    handlers.on.get(IPC.TELEMETRY.EMIT)!(popoutSender, {
      v: RENDERER_PROTOCOL_VERSION,
      items: [{ t: 'event', name: 'clubhouse.renderer.gone', attrs: [ATTR.windowKind('main')] }],
    });
    const attrs = (rt.event as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(attrs).toContainEqual(ATTR.windowKind('popout'));
    expect(attrs).toContainEqual(ATTR.process('renderer'));
  });

  it('replays renderer spans with their own times', () => {
    const rt = fakeRuntime();
    setRuntime(rt);
    dispatchRendererItems([{ t: 'span', name: 'clubhouse.renderer.unresponsive', startMs: 10, endMs: 30, attrs: [], outcome: 'ok' }], 'main');
    expect(rt.replaySpan).toHaveBeenCalledWith(expect.objectContaining({ startMs: 10, endMs: 30, outcome: 'ok' }));
  });

  it('turns renderer exceptions into ForwardedErrors with no message', () => {
    const rt = fakeRuntime();
    setRuntime(rt);
    dispatchRendererItems([{ t: 'exception', errorType: 'TypeError', stack: 'TypeError\n at x', origin: 'plugin', handled: true, attrs: [ATTR.errorBoundary('plugin')] }], 'main');
    const [err, opts] = (rt.exception as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(err).toBeInstanceOf(ForwardedError);
    expect((err as ForwardedError).forwardedType).toBe('TypeError');
    expect((err as Error).message).toBe('');
    // The boundary from the renderer and the window kind main decides both reach the record.
    expect(opts).toEqual({
      origin: 'plugin',
      handled: true,
      attrs: [ATTR.errorBoundary('plugin'), ATTR.process('renderer'), ATTR.windowKind('main')],
    });
  });

  it('accepts renderer-ready once, and only from the main window', () => {
    const seen: number[] = [];
    onRendererReady((t) => seen.push(t));
    handlers.on.get(IPC.TELEMETRY.RENDERER_READY)!(popoutSender);
    expect(seen).toHaveLength(0);
    handlers.on.get(IPC.TELEMETRY.RENDERER_READY)!(mainSender);
    handlers.on.get(IPC.TELEMETRY.RENDERER_READY)!(mainSender);
    expect(seen).toHaveLength(1);
  });

  it('serves the state over invoke', () => {
    expect(handlers.handle.get(IPC.TELEMETRY.GET_STATE)!()).toEqual({ enabled: false, level: null });
  });
});
