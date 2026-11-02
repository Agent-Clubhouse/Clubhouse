/**
 * The diag tier (#2299): gating by the logging settings, redaction, and the
 * local-only guarantee (no diag line ever reaches an exporter).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logSettings = vi.hoisted(() => ({
  getSettings: vi.fn(() => ({}) as Record<string, unknown>),
}));
vi.mock('../services/log-settings', () => logSettings);

import { ATTR } from '../../shared/telemetry/attributes';
import { _resetDiagForTests, addDiagTap, diag, getDiagNamespaces, isDiagActive, setDiagSink, type DiagRecord } from './diag';
import {
  _setExportWithoutLocalForTests,
  EXPORT_WITHOUT_LOCAL_RECORDING,
  forceFlushTelemetry,
  setLocalSink,
  setRuntime,
  tel,
} from './facade';
import { createLocalRecorder, type LocalRecorder } from './local-recorder';
import { createScrubber } from './scrubber';
import type { TelemetryRuntime } from './types';

const HOME = '/Users/sam-tester';
const settings = (over: Record<string, unknown> = {}) => ({ enabled: true, namespaces: {}, retention: 'medium', minLogLevel: 'info', ...over });

function memorySink() {
  const lines: DiagRecord[] = [];
  return { lines, writeDiag: (r: DiagRecord) => lines.push(r), noteDiagDropped: vi.fn(), flush: vi.fn(async () => {}) };
}

beforeEach(() => {
  _resetDiagForTests(HOME);
  logSettings.getSettings.mockReturnValue(settings());
});

afterEach(() => {
  _resetDiagForTests();
});

describe('diag gating', () => {
  it('writes nothing without a sink', () => {
    expect(isDiagActive()).toBe(false);
    expect(() => diag('core:pty', 'error', 'x')).not.toThrow();
  });

  it('follows enabled, then namespaces, then minLogLevel, like the legacy log', () => {
    const sink = memorySink();
    setDiagSink(sink);
    diag('core:pty', 'info', 'kept');
    diag('core:pty', 'debug', 'below min level');
    logSettings.getSettings.mockReturnValue(settings({ minLogLevel: 'debug' }));
    diag('core:pty', 'debug', 'debug now kept');
    logSettings.getSettings.mockReturnValue(settings({ namespaces: { 'core:pty': false, 'core:git': true } }));
    diag('core:pty', 'error', 'namespace off');
    diag('core:git', 'warn', 'namespace on');
    logSettings.getSettings.mockReturnValue(settings({ enabled: false }));
    diag('core:git', 'fatal', 'logging off');
    expect(sink.lines.map((l) => l.msg)).toEqual(['kept', 'debug now kept', 'namespace on']);
    expect(getDiagNamespaces()).toEqual(['core:git', 'core:pty']);
  });

  it('redacts msg and meta before the sink sees them', () => {
    const sink = memorySink();
    setDiagSink(sink);
    diag('core:agent', 'info', `Spawning in ${HOME}/repo`, { args: ['-p', 'secret mission'], cwd: `${HOME}/repo`, token: 'abc', exitCode: 1 });
    expect(sink.lines).toEqual([
      { ns: 'core:agent', level: 'info', msg: 'Spawning in <home>/repo', meta: { args: '<redacted: 2 items>', cwd: '<home>/repo', token: '<redacted>', exitCode: 1 } },
    ]);
  });

  it('never throws, whatever it is given', () => {
    const sink = memorySink();
    setDiagSink(sink);
    const hostile = { get boom() { throw new Error('no'); } };
    expect(() => diag('core:x', 'warn', 'm', hostile)).not.toThrow();
    expect(() => diag(42 as never, 'nope' as never, undefined as never)).not.toThrow();
    expect(sink.lines[1]).toMatchObject({ ns: 'unknown', level: 'info', msg: '' });
    setDiagSink({ ...sink, writeDiag: () => { throw new Error('disk'); } });
    expect(() => diag('core:x', 'error', 'm')).not.toThrow();
  });

  it('runs taps on every call, whatever the settings, with the redacted line, for the breadcrumb ring', () => {
    const msgs: string[] = [];
    const off = addDiagTap((e) => msgs.push(`${e.msg} ${JSON.stringify(e.meta)}`));
    logSettings.getSettings.mockReturnValue(settings({ enabled: false }));
    diag('core:x', 'debug', `in ${HOME}/repo`, { prompt: 'secret', token: 't' });
    off();
    expect(msgs).toEqual(['in <home>/repo {"prompt":"<redacted: 6 chars>","token":"<redacted>"}']);
  });

  it('runs taps in order, and a throwing tap breaks nothing', () => {
    const seen: string[] = [];
    const off = addDiagTap((e) => seen.push(`${e.ns}:${e.level}:${String(e.meta?.maxMs)}`));
    logSettings.getSettings.mockReturnValue(settings({ enabled: false }));
    diag('ui:perf', 'debug', 'slow', { kind: 'long_frame', maxMs: 900 });
    addDiagTap(() => {
      throw new Error('tap');
    });
    expect(() => diag('ui:perf', 'info', 'again')).not.toThrow();
    off();
    diag('ui:perf', 'info', 'after unsubscribe');
    expect(seen).toEqual(['ui:perf:debug:900', 'ui:perf:info:undefined']);
  });
});

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

describe('diag is local only', () => {
  let recorder: LocalRecorder | null = null;
  let written = '';

  function install(signals: boolean): LocalRecorder {
    written = '';
    recorder = createLocalRecorder({
      dir: '/logs',
      fileBase: 'run',
      level: 'detailed',
      signals,
      hashSalt: Buffer.alloc(32, 1),
      scrub: createScrubber({ homeDir: HOME }),
      session: { appVersion: '1.0.0', platform: 'linux', arch: 'x64' },
      flushIntervalMs: 60_000,
      appendFile: async (_f, data) => {
        written += data;
      },
      mkdir: async () => {},
    });
    if (signals) setLocalSink(recorder);
    setDiagSink(recorder);
    return recorder;
  }

  afterEach(async () => {
    setRuntime(null);
    setLocalSink(null);
    await recorder?.stop();
    recorder = null;
    _setExportWithoutLocalForTests(EXPORT_WITHOUT_LOCAL_RECORDING);
  });

  for (const policy of [false, true]) {
    for (const signals of [true, false]) {
      it(`sends the exporter nothing (EXPORT_WITHOUT_LOCAL_RECORDING=${policy}, signals ${signals ? 'on' : 'off'})`, async () => {
        _setExportWithoutLocalForTests(policy);
        const rt = fakeRuntime();
        setRuntime(rt);
        install(signals);
        logSettings.getSettings.mockReturnValue(settings({ minLogLevel: 'debug' }));
        for (const level of ['debug', 'info', 'warn', 'error', 'fatal'] as const) {
          diag('core:pty', level, `DIAG-CANARY ${level}`, { error: new Error('DIAG-CANARY'), lastOutput: 'DIAG-CANARY' });
        }
        // Inside an exported flow, too.
        tel.flow('clubhouse.agent.spawn', { attrs: [ATTR.orchestrator('claude-code')] }, () => diag('core:agent', 'error', 'DIAG-CANARY in flow'));
        await forceFlushTelemetry();

        // The canary reached the local file...
        expect(written.match(/DIAG-CANARY/g)?.length).toBeGreaterThanOrEqual(6);
        // ...and nothing the runtime was given mentions it.
        const calls = JSON.stringify(
          Object.entries(rt)
            .filter(([, v]) => vi.isMockFunction(v))
            .map(([k, v]) => [k, (v as ReturnType<typeof vi.fn>).mock.calls]),
          (_k, v: unknown) => (typeof v === 'function' ? '[fn]' : v instanceof Error ? v.message : v),
        );
        expect(calls).not.toContain('DIAG-CANARY');
        expect(rt.event).not.toHaveBeenCalled();
        expect(rt.exception).not.toHaveBeenCalled();
        expect(rt.count).not.toHaveBeenCalled();
      });
    }
  }

  it('carries the active local span ids, so a diag line sits inside its flow', async () => {
    const rec = install(true);
    tel.flow('clubhouse.agent.spawn', {}, () => diag('core:agent', 'warn', 'inside'));
    await rec.flush();
    const lines = written.trim().split('\n').map((l) => JSON.parse(l));
    const span = lines.find((l) => l.t === 'span');
    expect(lines.find((l) => l.t === 'diag')).toMatchObject({ ns: 'core:agent', level: 'warn', msg: 'inside', traceId: span.traceId, spanId: span.spanId });
  });
});

describe('addDiagTap filter', () => {
  it('calls a tap only for the lines it wants, and survives a filter that throws', () => {
    _resetDiagForTests('/Users/somebody');
    const seen: string[] = [];
    const off = addDiagTap((r) => seen.push(r.ns), (ns) => ns === 'core:annex');
    const offBroken = addDiagTap(() => seen.push('broken'), () => { throw new Error('bad filter'); });
    diag('core:annex', 'info', 'kept');
    diag('core:git', 'info', 'skipped');
    off();
    offBroken();
    expect(seen).toEqual(['core:annex']);
  });
});
