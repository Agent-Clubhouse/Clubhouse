import { describe, it, expect } from 'vitest';
import { deriveGoobersPanelState } from './panelState';
import type { GoobersConnectionState } from '../../../../shared/goobers-types';
import type { Instance, Health, ReadState, ValidationWarning } from '../../../../shared/goobers-api-types';

function instanceWith(overrides: Partial<Instance> = {}): Instance {
  return {
    apiVersion: 'v1',
    schemaVersion: 'v1',
    name: 'goobers-local',
    environment: 'dev',
    instanceRoot: '/x',
    ready: true,
    status: 'ready',
    concurrency: { activeRuns: 0, maxConcurrentRuns: 3 },
    counts: { gaggles: 0, goobers: 0, workflows: 0, activeRuns: 0 },
    warnings: [],
    fleetEnrolled: false,
    ...overrides,
  };
}

function warnings(...codes: string[]): ValidationWarning[] {
  return codes.map((code) => ({ code, explanation: `${code} explanation` }));
}

function healthWith(readState?: Partial<ReadState>): Health {
  return {
    apiVersion: 'v1',
    schemaVersion: 'v1',
    ready: true,
    healthy: true,
    instance: { name: 'goobers-local', environment: 'dev' },
    freshness: {
      observedAt: new Date().toISOString(),
      definitionsLoadedAt: new Date().toISOString(),
      journalUpdatedAt: null,
      lastSchedulerTickAt: null,
      lastTickAgeMillis: 500,
    },
    ...(readState
      ? {
          readState: {
            epoch: 'e1',
            appliedSeq: 1,
            observedAt: new Date().toISOString(),
            lagSeconds: 0.4,
            pendingIntake: 0,
            oldestPendingSourceAge: 0,
            intakeWriteFailures: 0,
            minChangeSeq: 0,
            completeness: 'complete',
            degraded: [],
            ...readState,
          },
        }
      : {}),
  };
}

function baseState(overrides: Partial<GoobersConnectionState> = {}): GoobersConnectionState {
  return {
    configured: true,
    instanceRoot: '/Users/cazzone/Repos/goobers-instance',
    rootIdentity: 'eaf74575d8de50fa5471027ba7fd15cb',
    daemon: {
      state: 'running',
      address: '127.0.0.1:8080',
      pid: 1234,
      version: 'portal-v0.1.0-21-ga1b2ae99',
      startedAt: new Date().toISOString(),
      lastTickAgeMillis: 500,
      draining: false,
    },
    connection: 'idle',
    stream: 'unavailable',
    instance: null,
    health: null,
    apiCompatible: true,
    lastError: null,
    lastUpdatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('deriveGoobersPanelState', () => {
  it('not-configured when instanceRoot is empty', () => {
    const state = baseState({ configured: false, instanceRoot: null });
    expect(deriveGoobersPanelState(state, false).kind).toBe('not-configured');
  });

  it('invalid-root on not-a-goobers-instance-root', () => {
    const state = baseState({ connection: 'error', lastError: { code: 'not-a-goobers-instance-root', message: 'not a Goobers instance root' } });
    expect(deriveGoobersPanelState(state, false).kind).toBe('invalid-root');
  });

  it('decommissioned-root on decommissioned-root code', () => {
    const state = baseState({ connection: 'error', lastError: { code: 'decommissioned-root', message: 'decommissioned' } });
    expect(deriveGoobersPanelState(state, false).kind).toBe('decommissioned-root');
  });

  it('binary-not-found on binary-not-found code', () => {
    const state = baseState({ lastError: { code: 'binary-not-found', message: 'not found' } });
    expect(deriveGoobersPanelState(state, true).kind).toBe('binary-not-found');
  });

  it('binary-not-found on binary-not-executable code', () => {
    const state = baseState({ lastError: { code: 'binary-not-executable', message: 'not executable' } });
    expect(deriveGoobersPanelState(state, true).kind).toBe('binary-not-found');
  });

  it('daemon-not-running when manageDaemon is true', () => {
    const state = baseState({ daemon: { ...baseState().daemon, state: 'not-running' } });
    expect(deriveGoobersPanelState(state, true).kind).toBe('daemon-not-running');
  });

  it('daemon-control-off when manageDaemon is false', () => {
    const state = baseState({ daemon: { ...baseState().daemon, state: 'not-running' } });
    expect(deriveGoobersPanelState(state, false).kind).toBe('daemon-control-off');
  });

  it('auth-required on auth-required code', () => {
    const state = baseState({ daemon: { ...baseState().daemon, state: 'running' }, lastError: { code: 'auth-required', message: 'auth' } });
    expect(deriveGoobersPanelState(state, true).kind).toBe('auth-required');
  });

  it('starting when daemon.state is starting', () => {
    const state = baseState({ daemon: { ...baseState().daemon, state: 'starting' } });
    expect(deriveGoobersPanelState(state, true).kind).toBe('starting');
  });

  it('recovering on recovering code, ahead of the plain starting branch, carrying the raw recovery breakdown (M20)', () => {
    const state = baseState({
      daemon: { ...baseState().daemon, state: 'starting' },
      lastError: { code: 'recovering', message: 'daemon is completing crash recovery' },
      recovery: { phase: 'worktree-reap-crash-orphan', since: '2026-09-16T22:58:49.213Z', checks: { apiListening: true, resumeComplete: false } },
    });
    const result = deriveGoobersPanelState(state, true);
    expect(result.kind).toBe('recovering');
    expect(result.error?.code).toBe('recovering');
    expect(result.raw.recovery?.phase).toBe('worktree-reap-crash-orphan');
  });

  it('recovery-stalled falls through to unknown-error, not recovering — requirement 4 (M20)', () => {
    const state = baseState({
      daemon: { ...baseState().daemon, state: 'unknown' },
      connection: 'error',
      lastError: { code: 'recovery-stalled', message: 'daemon has been in startup phase "x" for over 10 minutes without becoming ready' },
    });
    expect(deriveGoobersPanelState(state, true).kind).toBe('unknown-error');
  });

  it('start-failed on daemon-start-failed code', () => {
    const state = baseState({ daemon: { ...baseState().daemon, state: 'not-running' }, lastError: { code: 'daemon-start-failed', message: 'stderr...' } });
    expect(deriveGoobersPanelState(state, true).kind).toBe('start-failed');
  });

  it('start-unknown on daemon-start-unknown code (M17) — distinct from start-failed', () => {
    const state = baseState({
      connection: 'connecting',
      daemon: { ...baseState().daemon, state: 'unknown' },
      lastError: { code: 'daemon-start-unknown', message: 'daemon started but has not become ready after 60s', stderr: 'x', logPathHint: '/root/scheduler' },
    });
    const result = deriveGoobersPanelState(state, true);
    expect(result.kind).toBe('start-unknown');
    expect(result.kind).not.toBe('start-failed');
    expect(result.error?.stderr).toBe('x');
    expect(result.error?.logPathHint).toBe('/root/scheduler');
  });

  it('stopping when daemon.draining is true', () => {
    const state = baseState({ daemon: { ...baseState().daemon, state: 'stopping', draining: true } });
    expect(deriveGoobersPanelState(state, true).kind).toBe('stopping');
  });

  it('stop-failed on daemon-stop-failed code (M14)', () => {
    const state = baseState({ connection: 'error', lastError: { code: 'daemon-stop-failed', message: 'stderr...' } });
    expect(deriveGoobersPanelState(state, true).kind).toBe('stop-failed');
  });

  it('a successful drain (connection still connected, no error) is not mistaken for stop-failed', () => {
    const state = baseState({ connection: 'connected', daemon: { ...baseState().daemon, state: 'stopping', draining: true }, lastError: null });
    expect(deriveGoobersPanelState(state, true).kind).toBe('stopping');
  });

  it('port-mismatch when instance.rootIdentity.id differs from configured rootIdentity', () => {
    const state = baseState({
      connection: 'connected',
      daemon: { ...baseState().daemon, state: 'running' },
      instance: { apiVersion: 'v1', schemaVersion: 'v1', name: 'x', environment: 'dev', instanceRoot: '/x', ready: true, status: 'ready', concurrency: { activeRuns: 0, maxConcurrentRuns: 3 }, counts: { gaggles: 0, goobers: 0, workflows: 0, activeRuns: 0 }, warnings: [], fleetEnrolled: false, rootIdentity: { id: 'different-id' } },
    });
    expect(deriveGoobersPanelState(state, true).kind).toBe('port-mismatch');
  });

  it('port-mismatch on the identity-mismatch code goobers-liveness.ts actually emits', () => {
    const state = baseState({ connection: 'error', lastError: { code: 'identity-mismatch', message: 'mismatch' } });
    expect(deriveGoobersPanelState(state, true).kind).toBe('port-mismatch');
  });

  it('incompatible-api when apiCompatible is false and connected', () => {
    const state = baseState({ connection: 'connected', stream: 'live', apiCompatible: false });
    expect(deriveGoobersPanelState(state, true).kind).toBe('incompatible-api');
  });

  it('ready when connected, live stream, compatible', () => {
    const state = baseState({ connection: 'connected', stream: 'live', apiCompatible: true });
    expect(deriveGoobersPanelState(state, true).kind).toBe('ready');
  });

  it('scheduler-stalled when connection is degraded (scheduler not ticking)', () => {
    const state = baseState({ connection: 'degraded', stream: 'live' });
    expect(deriveGoobersPanelState(state, true).kind).toBe('scheduler-stalled');
  });

  // §8.4 — config lint is not a lifecycle state. This previously asserted
  // `kind: 'degraded'`, which is the defect #1883 reports: a permanent
  // property of most instances was driving an alarming state.
  it('stays ready when instance.status is degraded — config lint is not a state', () => {
    const state = baseState({
      connection: 'connected',
      stream: 'live',
      instance: instanceWith({ status: 'degraded' }),
    });
    expect(deriveGoobersPanelState(state, true).kind).toBe('ready');
  });

  it('stream-reconnecting when stream is reconnecting', () => {
    const state = baseState({ connection: 'connected', stream: 'reconnecting' });
    expect(deriveGoobersPanelState(state, true).kind).toBe('stream-reconnecting');
  });

  it('polling-fallback when stream is polling', () => {
    const state = baseState({ connection: 'connected', stream: 'polling' });
    expect(deriveGoobersPanelState(state, true).kind).toBe('polling-fallback');
  });

  it('no-read-model when stream is unavailable while connected', () => {
    const state = baseState({ connection: 'connected', stream: 'unavailable' });
    expect(deriveGoobersPanelState(state, true).kind).toBe('no-read-model');
  });

  it('connecting when connection is connecting', () => {
    const state = baseState({ connection: 'connecting' });
    expect(deriveGoobersPanelState(state, true).kind).toBe('connecting');
  });

  it('unknown-error on an unrecognized error code (must not crash)', () => {
    const state = baseState({ connection: 'error', lastError: { code: 'some-brand-new-m3-error', message: 'unexpected' } });
    const result = deriveGoobersPanelState(state, true);
    expect(result.kind).toBe('unknown-error');
    expect(result.error?.code).toBe('some-brand-new-m3-error');
  });

  it('falls back to connecting for an unrecognized connection value shape (defensive default)', () => {
    const state = baseState({ connection: 'idle', daemon: { ...baseState().daemon, state: 'unknown' } });
    const result = deriveGoobersPanelState(state, true);
    expect(result.kind).toBe('connecting');
  });
});

/**
 * #1883 — §8.4 previously OR-ed config lint, data freshness and scheduler
 * liveness into one "Ready, degraded" state with one blanket "marked stale"
 * treatment. These cover each signal alone, then all three together, which is
 * the case the OR collapsed.
 */
describe('§8.4 — the three signals are independent', () => {
  const ready = { connection: 'connected', stream: 'live', apiCompatible: true } as const;

  describe('config lint — informational, never a state and never a staleness claim', () => {
    it('reports the count without changing kind or freshness', () => {
      const state = baseState({
        ...ready,
        instance: instanceWith({ status: 'degraded', warnings: warnings('VER003', 'VER003', 'CFG001') }),
        health: healthWith({}),
      });
      const result = deriveGoobersPanelState(state, true);

      expect(result.kind).toBe('ready');
      expect(result.configWarnings.count).toBe(3);
      expect(result.configWarnings.label).toBe('3 config warnings');
      expect(result.freshness.kind).toBe('current');
      expect(result.freshness.alert).toBe(false);
    });

    it('names the codes with multiplicity so the header is self-diagnosing', () => {
      const state = baseState({
        ...ready,
        instance: instanceWith({ warnings: warnings('VER003', 'VER003', 'VER003', 'CFG001') }),
      });
      expect(deriveGoobersPanelState(state, true).configWarnings.detail).toBe('3x VER003, CFG001');
    });

    it('singularizes a single warning', () => {
      const state = baseState({ ...ready, instance: instanceWith({ warnings: warnings('VER003') }) });
      expect(deriveGoobersPanelState(state, true).configWarnings.label).toBe('1 config warning');
    });

    it('emits no label at all when there are none', () => {
      const state = baseState({ ...ready, instance: instanceWith() });
      const result = deriveGoobersPanelState(state, true);
      expect(result.configWarnings.count).toBe(0);
      expect(result.configWarnings.label).toBeNull();
    });
  });

  describe('data freshness — its own indicator, mirroring portal PortalShell', () => {
    it('is unknown and renders nothing when there is no read model', () => {
      const state = baseState({ ...ready, health: healthWith() });
      const result = deriveGoobersPanelState(state, true);
      expect(result.freshness.kind).toBe('unknown');
      expect(result.freshness.label).toBeNull();
      expect(result.freshness.alert).toBe(false);
    });

    it('is current when the daemon reports no degradation', () => {
      const state = baseState({ ...ready, health: healthWith({ degraded: [], lagSeconds: 0.4 }) });
      const result = deriveGoobersPanelState(state, true);
      expect(result.freshness.kind).toBe('current');
      expect(result.freshness.label).toBe('Data current');
    });

    it('does not invent lagging from a large lagSeconds the daemon has not flagged', () => {
      const state = baseState({ ...ready, health: healthWith({ degraded: [], lagSeconds: 1642.1 }) });
      expect(deriveGoobersPanelState(state, true).freshness.kind).toBe('current');
    });

    it.each(['projection_lag', 'sweep_stale', 'no_sweep_completed'])(
      'treats self-healing reason %s as lagging but NOT an alert',
      (reason) => {
        const state = baseState({ ...ready, health: healthWith({ degraded: [reason], lagSeconds: 90 }) });
        const result = deriveGoobersPanelState(state, true);
        expect(result.freshness.kind).toBe('lagging');
        expect(result.freshness.label).toBe('Data stale by 90.0s');
        expect(result.freshness.detail).toBe(reason);
        expect(result.freshness.alert).toBe(false);
      },
    );

    it.each(['project_failure', 'intake_write_failure'])(
      'alerts on non-self-healing reason %s',
      (reason) => {
        const state = baseState({ ...ready, health: healthWith({ degraded: [reason], lagSeconds: 5 }) });
        const result = deriveGoobersPanelState(state, true);
        expect(result.freshness.kind).toBe('lagging');
        expect(result.freshness.alert).toBe(true);
        expect(result.freshness.detail).toBe(reason);
      },
    );

    it('alerts on an unrecognized reason rather than assuming it is benign', () => {
      const state = baseState({ ...ready, health: healthWith({ degraded: ['some_future_reason'] }) });
      const result = deriveGoobersPanelState(state, true);
      expect(result.freshness.alert).toBe(true);
      expect(result.freshness.detail).toBe('some_future_reason');
    });

    it('reports partial completeness with the missing names', () => {
      const state = baseState({
        ...ready,
        health: healthWith({
          completeness: 'partial',
          missing: [{ name: 'projected-runs', reason: 'sweep pending', expectedBy: '2026-09-20T03:00:00Z' }],
        }),
      });
      const result = deriveGoobersPanelState(state, true);
      expect(result.freshness.kind).toBe('partial');
      expect(result.freshness.label).toBe('Partial — projected-runs');
    });
  });

  describe('scheduler liveness — distinct from both', () => {
    it('is its own kind, driven only by connection degraded', () => {
      const state = baseState({ connection: 'degraded', stream: 'live', instance: instanceWith() });
      expect(deriveGoobersPanelState(state, true).kind).toBe('scheduler-stalled');
    });

    it('does not claim data is stale — freshness stays independent', () => {
      const state = baseState({
        connection: 'degraded',
        stream: 'live',
        health: healthWith({ degraded: [], lagSeconds: 0.4 }),
      });
      const result = deriveGoobersPanelState(state, true);
      expect(result.kind).toBe('scheduler-stalled');
      expect(result.freshness.kind).toBe('current');
      expect(result.freshness.alert).toBe(false);
    });
  });

  describe('the combination the OR collapsed', () => {
    it('surfaces all three independently when all three are true at once', () => {
      const state = baseState({
        connection: 'degraded',
        stream: 'live',
        instance: instanceWith({ status: 'degraded', warnings: warnings('VER003', 'CFG001') }),
        health: healthWith({ degraded: ['project_failure'], lagSeconds: 120 }),
      });
      const result = deriveGoobersPanelState(state, true);

      expect(result.kind).toBe('scheduler-stalled');
      expect(result.configWarnings.count).toBe(2);
      expect(result.freshness.kind).toBe('lagging');
      expect(result.freshness.alert).toBe(true);
      expect(result.freshness.detail).toBe('project_failure');
    });

    /**
     * The exact scenario from #1883: healthy daemon, current data, 17 config
     * warnings. This rendered "⚠ Degraded — data below may be stale" and cost
     * the owner an evening hunting a fault that did not exist.
     */
    it('a healthy instance with 17 config warnings is ready with current data', () => {
      const state = baseState({
        ...ready,
        instance: instanceWith({
          status: 'degraded',
          warnings: warnings(...Array.from({ length: 13 }, () => 'VER003'), 'CFG001', 'CFG002', 'REF012', 'DVL001'),
        }),
        health: healthWith({ degraded: [], lagSeconds: 32.5, completeness: 'complete' }),
      });
      const result = deriveGoobersPanelState(state, true);

      expect(result.kind).toBe('ready');
      expect(result.freshness.kind).toBe('current');
      expect(result.freshness.alert).toBe(false);
      expect(result.configWarnings.count).toBe(17);
      expect(result.configWarnings.label).toBe('17 config warnings');
      expect(result.configWarnings.detail).toBe('13x VER003, CFG001, CFG002, REF012, DVL001');
    });
  });

  /**
   * Second defect, found while fixing the first: the config-lint branch
   * returned before the three `stream` checks, so on any instance carrying a
   * config warning — a permanent condition for most — a genuine stream outage
   * was invisible and rendered as the same generic "Degraded" pill.
   */
  describe('stream states stay reachable when config lint is non-empty', () => {
    it.each([
      ['reconnecting', 'stream-reconnecting'],
      ['polling', 'polling-fallback'],
      ['unavailable', 'no-read-model'],
    ] as const)('stream %s still derives %s', (stream, expected) => {
      const state = baseState({
        connection: 'connected',
        stream,
        apiCompatible: true,
        instance: instanceWith({ status: 'degraded', warnings: warnings('VER003') }),
      });
      expect(deriveGoobersPanelState(state, true).kind).toBe(expected);
    });
  });
});
