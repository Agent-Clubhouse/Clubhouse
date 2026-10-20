import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ATTR } from '../../shared/telemetry/attributes';
import { setProducingRuntime } from './__test-utils__/producing-runtime';
import {
  _resetGoobersTelemetryForTests,
  daemonFlow,
  goobersErrorCode,
  markFresh,
  recordLivenessChange,
  resetFreshness,
  recordPollDone,
} from './goobers-telemetry';
import type { Classification, TelemetryRuntime } from './types';

let rt: TelemetryRuntime;
let flows: Array<{ name: string; attrs: unknown[]; outcome?: Classification }>;
beforeEach(() => {
  flows = [];
  rt = {
    level: 'standard',
    count: vi.fn(),
    event: vi.fn(),
    replaySpan: vi.fn(),
    flow: (name: string, _o: unknown, fn: (s: { set: (...a: unknown[]) => void }) => Promise<unknown>, extras?: { classify?: (r: unknown) => Classification }) => {
      const f: { name: string; attrs: unknown[]; outcome?: Classification } = { name, attrs: [] };
      flows.push(f);
      return fn({ set: (...a) => f.attrs.push(...a) }).then((r) => { f.outcome = extras?.classify?.(r) ?? 'ok'; return r; });
    },
  } as unknown as TelemetryRuntime;
  setProducingRuntime(rt);
});
afterEach(() => {
  setProducingRuntime(null);
  _resetGoobersTelemetryForTests();
});

const view = (state: string, connection: string, code?: string) => ({ daemon: { state }, connection, lastError: code ? { code } : null });

describe('goobers telemetry', () => {
  it('keeps registered error codes and buckets everything else, never a message', () => {
    expect(goobersErrorCode('auth-required')).toBe('auth-required');
    expect(goobersErrorCode('daemon exited before becoming ready (see /Users/x/.goobers/logs)')).toBe('other');
    expect(goobersErrorCode(undefined)).toBe('none');
  });

  it('emits liveness only on transitions', () => {
    recordLivenessChange(view('running', 'connected'), view('running', 'connected'));
    recordLivenessChange(view('running', 'connected'), view('running', 'degraded', 'degraded'));
    expect(rt.event).toHaveBeenCalledTimes(1);
    expect(rt.event).toHaveBeenCalledWith('clubhouse.goobers.liveness', [
      ATTR.goobersDaemonState('running'), ATTR.goobersConnection('degraded'), ATTR.goobersError('degraded'),
    ]);
  });

  it('samples data age per model that has been fresh, at each poll', () => {
    markFresh(['instance', 'not-a-model'], 1000);
    markFresh(['run'], 4000);
    recordPollDone(9000, 10000);
    const ages = (rt.count as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === 'clubhouse.goobers.data.age');
    expect(ages).toEqual([
      ['clubhouse.goobers.data.age', 9, [ATTR.goobersModel('instance')]],
      ['clubhouse.goobers.data.age', 6, [ATTR.goobersModel('run')]],
    ]);
  });

  it('stops sampling data age once the instance root changes', () => {
    markFresh(['instance'], 1000);
    resetFreshness();
    recordPollDone(1500, 2000);
    expect((rt.count as ReturnType<typeof vi.fn>).mock.calls.some((c) => c[0] === 'clubhouse.goobers.data.age')).toBe(false);
  });

  it('classifies daemon start: free-text errors get the service code, a ready timeout is timeout', async () => {
    await daemonFlow('start', 'daemon-start-failed', async () => ({ ok: false, error: 'daemon exited before becoming ready' }));
    await daemonFlow('start', 'daemon-start-failed', async () => ({ ok: false, error: 'x', outcome: 'unknown' as const }));
    await daemonFlow('stop', 'daemon-stop-failed', async () => ({ ok: false, error: 'lifecycle-busy' }));
    expect(flows).toEqual([
      { name: 'clubhouse.goobers.daemon.start', attrs: [ATTR.goobersError('daemon-start-failed')], outcome: { error: 'goobers_daemon_failed' } },
      { name: 'clubhouse.goobers.daemon.start', attrs: [ATTR.goobersError('daemon-start-failed')], outcome: { outcome: 'timeout' } },
      { name: 'clubhouse.goobers.daemon.stop', attrs: [ATTR.goobersError('lifecycle-busy')], outcome: { error: 'goobers_daemon_failed' } },
    ]);
  });
});
