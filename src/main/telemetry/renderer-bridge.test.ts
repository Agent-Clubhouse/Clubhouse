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
const logSettings = vi.hoisted(() => ({ getSettings: vi.fn() }));
vi.mock('../services/log-settings', () => logSettings);

import { IPC } from '../../shared/ipc-channels';
import { ATTR } from '../../shared/telemetry/attributes';
import { RENDERER_PROTOCOL_VERSION } from '../../shared/telemetry/renderer-protocol';
import { beginPending, setLocalSink, setRuntime } from './facade';
import type { LocalTelemetrySink } from './types';
import { _resetDiagForTests, addDiagTap, setDiagSink, type DiagRecord } from './diag';
import {
  _resetRendererBridgeForTests,
  DIAG_RATE_MAX,
  DIAG_RATE_WINDOW_MS,
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
  logSettings.getSettings.mockReturnValue({ enabled: true, namespaces: {}, retention: 'medium', minLogLevel: 'info' });
  _resetDiagForTests('/Users/sam-tester');
  registerTelemetryRendererHandlers({ getMainWebContentsId: () => MAIN_ID, getConfiguredLevel: () => 'standard' });
});

function fakeDiagSink() {
  const lines: DiagRecord[] = [];
  return { lines, writeDiag: vi.fn((r: DiagRecord) => void lines.push(r)), noteDiagDropped: vi.fn(), flush: vi.fn(async () => {}) };
}

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
  _resetDiagForTests();
  vi.useRealTimers();
});

describe('renderer diag items (#2299)', () => {
  const emit = (sender: { sender: { id: number } }, items: unknown[]) =>
    handlers.on.get(IPC.TELEMETRY.EMIT)!(sender, { v: RENDERER_PROTOCOL_VERSION, items });

  it('tells renderers to send diag while diag recording runs, with or without signals', () => {
    const sink = fakeDiagSink();
    setDiagSink(sink);
    expect(getTelemetryState()).toEqual({ enabled: false, level: null, diag: true });
    expect(broadcast).toHaveBeenLastCalledWith(IPC.TELEMETRY.STATE_CHANGED, { enabled: false, level: null, diag: true });
    setLocalSink(fakeLocalSink());
    expect(getTelemetryState()).toEqual({ enabled: true, level: 'standard', producers: true, diag: true });
    setDiagSink(null);
    expect(broadcast).toHaveBeenLastCalledWith(IPC.TELEMETRY.STATE_CHANGED, { enabled: true, level: 'standard', producers: true });
  });

  it('writes diag items, tagged and redacted, while signals are off; never to the facade', () => {
    const sink = fakeDiagSink();
    setDiagSink(sink);
    const rt = fakeRuntime();
    setRuntime(rt);
    emit(popoutSender, [
      { t: 'diag', ns: 'ui:nav', level: 'info', msg: 'opened /Users/sam-tester/repo', meta: { prompt: 'secret' } },
      { t: 'event', name: 'clubhouse.renderer.gone', attrs: [] },
      { t: 'diag', ns: 'ui:nav', level: 'debug', msg: 'below min level' },
    ]);
    expect(sink.lines).toEqual([{ ns: 'ui:nav', level: 'info', msg: 'opened <home>/repo', meta: { prompt: '<redacted: 6 chars>' }, window: 'popout' }]);
    expect(rt.event).not.toHaveBeenCalled();
  });

  it('dispatches signals and diag from one batch when both are on', () => {
    const sink = fakeDiagSink();
    const local = fakeLocalSink();
    setDiagSink(sink);
    setLocalSink(local);
    emit(mainSender, [{ t: 'event', name: 'clubhouse.renderer.gone', attrs: [] }, { t: 'diag', ns: 'ui:perf', level: 'warn', msg: 'slow' }]);
    expect(local.event).toHaveBeenCalledTimes(1);
    expect(sink.lines).toEqual([{ ns: 'ui:perf', level: 'warn', msg: 'slow', window: 'main' }]);
  });

  it('drops diag items while diag recording is off', () => {
    const local = fakeLocalSink();
    setLocalSink(local);
    const tap = vi.fn();
    addDiagTap(tap);
    emit(mainSender, [{ t: 'diag', ns: 'ui:perf', level: 'error', msg: 'x' }, { t: 'event', name: 'clubhouse.renderer.gone', attrs: [] }]);
    expect(tap).not.toHaveBeenCalled();
    expect(local.event).toHaveBeenCalledTimes(1);
  });

  it('redacts a renderer secret that straddles the message cap', () => {
    const sink = fakeDiagSink();
    setDiagSink(sink);
    emit(mainSender, [{ t: 'diag', ns: 'ui:x', level: 'error', msg: `${'a '.repeat(995)}sk-${'b'.repeat(30)}` }]);
    expect(sink.lines[0].msg).not.toContain('sk-');
    expect(sink.lines[0].msg).not.toContain('bbbb');
  });

  it('rate-limits diag items per window and counts the drops', () => {
    vi.useFakeTimers();
    const sink = fakeDiagSink();
    setDiagSink(sink);
    const items = (n: number) => Array.from({ length: n }, (_, i) => ({ t: 'diag', ns: 'ui:x', level: 'info', msg: `m${i}` }));
    for (let i = 0; i < Math.ceil(DIAG_RATE_MAX / 100) + 1; i++) emit(mainSender, items(100));
    expect(sink.lines).toHaveLength(DIAG_RATE_MAX);
    expect(sink.noteDiagDropped.mock.calls.reduce((n, [d]) => n + (d as number), 0)).toBe(100);
    // Another window has its own budget.
    emit(popoutSender, items(10));
    expect(sink.lines).toHaveLength(DIAG_RATE_MAX + 10);
    // The next rate window starts fresh.
    vi.advanceTimersByTime(DIAG_RATE_WINDOW_MS);
    emit(mainSender, items(10));
    expect(sink.lines).toHaveLength(DIAG_RATE_MAX + 20);
  });
});

describe('renderer bridge', () => {
  it('stays disabled for an exporter alone: export only sends what local recording produces', () => {
    expect(getTelemetryState()).toEqual({ enabled: false, level: null });
    setRuntime(fakeRuntime());
    expect(getTelemetryState()).toEqual({ enabled: false, level: null });
  });

  it('tells renderers to record for local recording alone (#2278)', () => {
    setLocalSink(fakeLocalSink());
    const local = { enabled: true, level: 'standard', producers: true };
    expect(getTelemetryState()).toEqual(local);
    expect(broadcast).toHaveBeenLastCalledWith(IPC.TELEMETRY.STATE_CHANGED, local);
    // Parity: an exporter, even at Detailed, doesn't change what renderers produce.
    const rt = fakeRuntime();
    (rt as { level: string }).level = 'detailed';
    setRuntime(rt);
    expect(getTelemetryState()).toEqual(local);
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

  it('stays disabled while the SDK loads with local recording off', () => {
    beginPending();
    expect(getTelemetryState()).toEqual({ enabled: false, level: null });
  });

  it('broadcasts the new state when local recording starts or stops', () => {
    setLocalSink(fakeLocalSink());
    expect(broadcast).toHaveBeenLastCalledWith(IPC.TELEMETRY.STATE_CHANGED, { enabled: true, level: 'standard', producers: true });
    setLocalSink(null);
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
    setLocalSink(fakeLocalSink());
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
    setLocalSink(fakeLocalSink());
    setRuntime(rt);
    dispatchRendererItems([{ t: 'span', name: 'clubhouse.renderer.unresponsive', startMs: 10, endMs: 30, attrs: [], outcome: 'ok' }], 'main');
    expect(rt.replaySpan).toHaveBeenCalledWith(expect.objectContaining({ startMs: 10, endMs: 30, outcome: 'ok' }));
  });

  it('turns renderer exceptions into ForwardedErrors with no message', () => {
    const rt = fakeRuntime();
    setLocalSink(fakeLocalSink());
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
