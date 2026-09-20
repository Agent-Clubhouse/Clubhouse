import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MainPanel, describeStartupPhase, deslugPhase, formatElapsedSince, formatBytes, describeIdleStatus } from './main';
import { createMockAPI } from '../../testing';
import { useGoobersStore } from '../../../stores/goobersStore';
import { useGoobersSettingsStore } from '../../../stores/goobersSettingsStore';
import { GOOBERS_POLL_FALLBACK_INTERVAL_MS, type GoobersConnectionState } from '../../../../shared/goobers-types';
import type { RunSummary } from '../../../../shared/goobers-api-types';

function baseConnState(overrides: Partial<GoobersConnectionState> = {}): GoobersConnectionState {
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

function setConnState(state: GoobersConnectionState) {
  useGoobersStore.setState({
    state,
    loaded: true,
    loadError: null,
    loadState: vi.fn(async () => {}),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
  });
}

function setGoobersSettings(overrides: Partial<{ manageDaemon: boolean; binaryPath: string; instanceRoot: string; autoConnect: boolean }> = {}) {
  useGoobersSettingsStore.setState({
    instanceRoot: '/Users/cazzone/Repos/goobers-instance',
    binaryPath: 'goobers',
    autoConnect: true,
    manageDaemon: false,
    loaded: true,
    loadSettings: vi.fn(async () => {}),
    saveSettings: vi.fn(async () => {}),
    ...overrides,
  });
}

function makeRun(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    id: 'run-1',
    workflow: 'clubhouse-implementation',
    workflowVersion: 1,
    gaggle: 'clubhouse',
    trigger: { kind: 'schedule' },
    phase: 'running',
    terminal: false,
    currentStage: 'implement',
    startedAt: new Date().toISOString(),
    durationMillis: 120_000,
    lastActivityAt: new Date().toISOString(),
    stale: false,
    repassCount: 0,
    retryCount: 0,
    noWork: false,
    operator: {
      liveness: 'no-heartbeat',
      trajectory: 'implementing',
      claim: { leaseStatus: 'held', providerMarker: 'x' },
      potentialBlockers: [],
      diagnosticsLimitations: [],
    },
    ...overrides,
  };
}

function mockWindowClubhouse(overrides: { listRuns?: unknown; pickDirectory?: unknown; onDataInvalidated?: unknown } = {}) {
  const w = globalThis.window as unknown as { clubhouse?: Record<string, unknown> };
  w.clubhouse = {
    ...w.clubhouse,
    goobers: {
      listRuns: overrides.listRuns ?? vi.fn(async () => ({ runs: [], nextCursor: undefined })),
      daemonStart: vi.fn(async () => ({ ok: true })),
      daemonStop: vi.fn(async () => ({ ok: true })),
      onDataInvalidated: overrides.onDataInvalidated ?? vi.fn(() => vi.fn()),
    },
    project: {
      pickDirectory: overrides.pickDirectory ?? vi.fn(async () => null),
    },
  };
}

describe('Goobers MainPanel', () => {
  const api = createMockAPI();

  beforeEach(() => {
    mockWindowClubhouse();
    setGoobersSettings();
  });

  it('shows a loading state before the store has loaded', () => {
    useGoobersStore.setState({ state: null, loaded: false, loadError: null, loadState: vi.fn(async () => {}), connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}) });
    render(<MainPanel api={api} />);
    expect(screen.getByTestId('goobers-state-connecting')).toBeInTheDocument();
  });

  it('renders not-configured with an inline picker when no root is saved', () => {
    setGoobersSettings({ instanceRoot: '' });
    setConnState(baseConnState({ configured: false, instanceRoot: null }));
    render(<MainPanel api={api} />);
    expect(screen.getByTestId('goobers-state-not-configured')).toBeInTheDocument();
    expect(screen.getByTestId('goobers-inline-picker')).toBeInTheDocument();
  });

  // M12: `goobers:get-state`'s first read is always the pre-activation idle
  // snapshot (configured: false), regardless of what's actually saved. The
  // settings store (loaded independently) says a root IS saved here — the
  // panel must show loading, never assert "not configured" against a root
  // it knows exists on disk.
  it('shows loading, not not-configured, when a root is saved but the connection snapshot has not caught up yet', () => {
    setGoobersSettings({ instanceRoot: '/Users/cazzone/Repos/goobers-instance' });
    setConnState(baseConnState({ configured: false, instanceRoot: null }));
    render(<MainPanel api={api} />);
    expect(screen.getByTestId('goobers-state-connecting')).toBeInTheDocument();
    expect(screen.queryByTestId('goobers-state-not-configured')).not.toBeInTheDocument();
  });

  it('renders invalid-root', () => {
    setConnState(baseConnState({ connection: 'error', lastError: { code: 'not-a-goobers-instance-root', message: 'not a Goobers instance root' } }));
    render(<MainPanel api={api} />);
    expect(screen.getByTestId('goobers-state-invalid-root')).toBeInTheDocument();
  });

  it('renders decommissioned-root', () => {
    setConnState(baseConnState({ connection: 'error', lastError: { code: 'decommissioned-root', message: 'decommissioned' } }));
    render(<MainPanel api={api} />);
    expect(screen.getByTestId('goobers-state-decommissioned-root')).toBeInTheDocument();
  });

  it('renders binary-not-found', () => {
    setConnState(baseConnState({ lastError: { code: 'binary-not-found', message: `'goobers' was not found on PATH` } }));
    render(<MainPanel api={api} />);
    expect(screen.getByTestId('goobers-state-binary-not-found')).toBeInTheDocument();
  });

  it('renders daemon-control-off with the inline enable affordance when manageDaemon is false', () => {
    setGoobersSettings({ manageDaemon: false });
    setConnState(baseConnState({ daemon: { ...baseConnState().daemon, state: 'not-running' } }));
    render(<MainPanel api={api} />);
    expect(screen.getByTestId('goobers-state-daemon-control-off')).toBeInTheDocument();
    expect(screen.getByTestId('goobers-enable-daemon-control')).toBeInTheDocument();
  });

  it('renders daemon-not-running with a Start button when manageDaemon is true', () => {
    setGoobersSettings({ manageDaemon: true });
    setConnState(baseConnState({ daemon: { ...baseConnState().daemon, state: 'not-running' } }));
    render(<MainPanel api={api} />);
    expect(screen.getByTestId('goobers-state-daemon-not-running')).toBeInTheDocument();
    expect(screen.getByTestId('goobers-start-daemon')).toBeInTheDocument();
  });

  it('shows instance name and environment on daemon-not-running when config/manifest.yaml was readable (§12)', () => {
    setGoobersSettings({ manageDaemon: true });
    setConnState(baseConnState({
      daemon: { ...baseConnState().daemon, state: 'not-running' },
      instanceName: 'goobers-local',
      instanceEnvironment: 'dev',
    }));
    render(<MainPanel api={api} />);
    expect(screen.getByTestId('goobers-daemon-not-running-identity')).toHaveTextContent('goobers-local (dev)');
  });

  it('falls back to the root identity on daemon-not-running when no manifest name is available', () => {
    setGoobersSettings({ manageDaemon: true });
    setConnState(baseConnState({
      daemon: { ...baseConnState().daemon, state: 'not-running' },
      instanceName: null,
      instanceEnvironment: null,
    }));
    render(<MainPanel api={api} />);
    expect(screen.getByTestId('goobers-daemon-not-running-identity')).toHaveTextContent('eaf74575d8de50fa5471027ba7fd15cb');
  });

  it('renders auth-required', () => {
    setGoobersSettings({ manageDaemon: true });
    setConnState(baseConnState({ daemon: { ...baseConnState().daemon, state: 'running' }, lastError: { code: 'auth-required', message: 'auth' } }));
    render(<MainPanel api={api} />);
    expect(screen.getByTestId('goobers-state-auth-required')).toBeInTheDocument();
  });

  it('renders starting', () => {
    setConnState(baseConnState({ daemon: { ...baseConnState().daemon, state: 'starting' } }));
    render(<MainPanel api={api} />);
    expect(screen.getByTestId('goobers-state-starting')).toBeInTheDocument();
  });

  it('renders recovering with the /readyz phase and checks breakdown, not the generic error screen (M20)', () => {
    setConnState(baseConnState({
      daemon: { ...baseConnState().daemon, state: 'starting' },
      lastError: { code: 'recovering', message: 'daemon is completing crash recovery' },
      recovery: {
        phase: 'worktree-reap-crash-orphan',
        since: '2026-09-16T22:58:49.213Z',
        checks: { apiListening: true, resumeComplete: false },
      },
    }));
    render(<MainPanel api={api} />);
    expect(screen.getByTestId('goobers-state-recovering')).toBeInTheDocument();
    expect(screen.queryByTestId('goobers-state-unknown-error')).not.toBeInTheDocument();
    expect(screen.getByText(/apiListening/)).toBeInTheDocument();
  });

  // M23: the panel used to hardcode "the daemon is alive and completing
  // crash recovery" — asserting a crash that never happened (an ordinary
  // startup routes through this same state). The copy must not claim a
  // crash, the phase must be de-slugged with a description, and `since`
  // must render as elapsed time, not a raw ISO timestamp.
  it('does not assert a crash, de-slugs the phase, describes it, and shows elapsed time not a raw ISO string (M23)', () => {
    setConnState(baseConnState({
      daemon: { ...baseConnState().daemon, state: 'starting' },
      lastError: { code: 'recovering', message: 'daemon is completing crash recovery' },
      recovery: {
        phase: 'worktree-reap-crash-orphan',
        since: '2026-09-16T22:58:49.213Z',
        checks: { apiListening: true, resumeComplete: false },
      },
    }));
    render(<MainPanel api={api} />);
    expect(screen.queryByText(/crash recovery/)).not.toBeInTheDocument();
    expect(screen.getByText('worktree reap crash orphan', { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/Recovering worktrees left by an interrupted run/)).toBeInTheDocument();
    expect(screen.queryByText(/2026-09-16T22:58:49.213Z/)).not.toBeInTheDocument();
    expect(screen.getByText(/elapsed/)).toBeInTheDocument();
  });

  it('renders an unmapped startup phase gracefully instead of a raw slug (M23)', () => {
    setConnState(baseConnState({
      daemon: { ...baseConnState().daemon, state: 'starting' },
      lastError: { code: 'recovering', message: 'daemon is completing crash recovery' },
      recovery: {
        phase: 'some-future-upstream-phase',
        since: '2026-09-16T22:58:49.213Z',
        checks: {},
      },
    }));
    render(<MainPanel api={api} />);
    expect(screen.getByTestId('goobers-state-recovering')).toBeInTheDocument();
    expect(screen.getByText('Goobers is completing a required startup operation.')).toBeInTheDocument();
    expect(screen.getByText('some future upstream phase', { exact: false })).toBeInTheDocument();
  });

  it('renders start-failed with the buffered error, never a bare message', () => {
    setConnState(baseConnState({ daemon: { ...baseConnState().daemon, state: 'not-running' }, lastError: { code: 'daemon-start-failed', message: 'stderr: exit 1' } }));
    render(<MainPanel api={api} />);
    expect(screen.getByTestId('goobers-state-start-failed')).toBeInTheDocument();
    expect(screen.getByText(/stderr: exit 1/)).toBeInTheDocument();
  });

  it('renders start-unknown with the buffered stderr and log path, and NO retry button (M17)', () => {
    setConnState(baseConnState({
      connection: 'connecting',
      daemon: { ...baseConnState().daemon, state: 'unknown' },
      lastError: {
        code: 'daemon-start-unknown',
        message: 'daemon started but has not become ready after 60s',
        stderr: 'still initializing…',
        logPathHint: '/Users/cazzone/Repos/goobers-instance/scheduler',
      },
    }));
    render(<MainPanel api={api} />);
    expect(screen.getByTestId('goobers-state-start-unknown')).toBeInTheDocument();
    expect(screen.getByText(/still initializing/)).toBeInTheDocument();
    expect(screen.getByText(/scheduler/)).toBeInTheDocument();
    // Retrying here would hit lock contention against the app's own live
    // daemon — this screen must never offer a Start/retry affordance.
    expect(screen.queryByTestId('goobers-retry')).not.toBeInTheDocument();
    expect(screen.queryByTestId('goobers-start-daemon')).not.toBeInTheDocument();
  });

  it('renders stopping while draining', () => {
    setConnState(baseConnState({ daemon: { ...baseConnState().daemon, state: 'stopping', draining: true } }));
    render(<MainPanel api={api} />);
    expect(screen.getByTestId('goobers-state-stopping')).toBeInTheDocument();
  });

  it('renders stop-failed with the buffered error and a retry (M14)', () => {
    setConnState(baseConnState({ connection: 'error', lastError: { code: 'daemon-stop-failed', message: 'stderr: permission denied' } }));
    render(<MainPanel api={api} />);
    expect(screen.getByTestId('goobers-state-stop-failed')).toBeInTheDocument();
    expect(screen.getByText(/stderr: permission denied/)).toBeInTheDocument();
  });

  it('renders port-mismatch and refuses to render another instance\'s data', () => {
    setConnState(baseConnState({ connection: 'error', lastError: { code: 'identity-mismatch', message: 'mismatch' } }));
    render(<MainPanel api={api} />);
    expect(screen.getByTestId('goobers-state-port-mismatch')).toBeInTheDocument();
    expect(screen.queryByTestId('goobers-active-runs')).not.toBeInTheDocument();
  });

  it('renders incompatible-api', () => {
    setConnState(baseConnState({ connection: 'connected', stream: 'live', apiCompatible: false }));
    render(<MainPanel api={api} />);
    expect(screen.getByTestId('goobers-state-incompatible-api')).toBeInTheDocument();
  });

  it('renders unknown-error for an unrecognized error code without crashing (§9.2)', () => {
    setConnState(baseConnState({ connection: 'error', lastError: { code: 'a-code-from-the-future', message: 'huh' } }));
    render(<MainPanel api={api} />);
    expect(screen.getByTestId('goobers-state-unknown-error')).toBeInTheDocument();
  });

  it('renders the active-runs view with a scheduler-stalled banner naming the tick age', async () => {
    setConnState(baseConnState({ connection: 'degraded', stream: 'live' }));
    render(<MainPanel api={api} />);
    // §8.4 required "banner naming the specific degradation"; the old copy
    // named none and claimed staleness the scheduler tick says nothing about.
    const banner = screen.getByTestId('goobers-scheduler-stalled-banner');
    expect(banner).toBeInTheDocument();
    expect(banner.textContent).toContain('Scheduler has not ticked');
    expect(banner.textContent).not.toContain('may be stale');
    await waitFor(() => expect(screen.getByTestId('goobers-active-runs')).toBeInTheDocument());
  });

  it('renders the stream-reconnecting banner', async () => {
    setConnState(baseConnState({ connection: 'connected', stream: 'reconnecting' }));
    render(<MainPanel api={api} />);
    expect(screen.getByTestId('goobers-reconnecting-banner')).toBeInTheDocument();
  });

  // M32 (#1888): this banner previously hardcoded a literal "60s" — 12x the
  // real POLL_INTERVAL_MS fallback cadence (5s). Assert against the actual
  // shared constant so the text can't silently drift from it again.
  it('renders the polling-fallback banner with the real fallback interval, not a hardcoded literal', async () => {
    setConnState(baseConnState({ connection: 'connected', stream: 'polling' }));
    render(<MainPanel api={api} />);
    const banner = screen.getByTestId('goobers-polling-banner');
    expect(banner).toBeInTheDocument();
    expect(banner.textContent).toBe(`Live updates unavailable — refreshing every ${GOOBERS_POLL_FALLBACK_INTERVAL_MS / 1000}s`);
  });

  it('renders the no-read-model banner', async () => {
    setConnState(baseConnState({ connection: 'connected', stream: 'unavailable' }));
    render(<MainPanel api={api} />);
    expect(screen.getByTestId('goobers-no-read-model-banner')).toBeInTheDocument();
  });

  describe('ready state and the active-run list', () => {
    function readyState(
      instanceOverrides: Partial<NonNullable<GoobersConnectionState['instance']>> = {},
      connStateOverrides: Partial<GoobersConnectionState> = {},
    ) {
      return baseConnState({
        connection: 'connected',
        stream: 'live',
        apiCompatible: true,
        instance: {
          apiVersion: 'v1', schemaVersion: 'v1', name: 'goobers-local', environment: 'dev',
          instanceRoot: '/Users/cazzone/Repos/goobers-instance', ready: true, status: 'ready',
          concurrency: { activeRuns: 0, maxConcurrentRuns: 3 },
          counts: { gaggles: 3, goobers: 1, workflows: 12, activeRuns: 0 },
          warnings: [], fleetEnrolled: false,
          ...instanceOverrides,
        },
        ...connStateOverrides,
      });
    }

    it('handles zero active runs as the normal resting state, not an error', async () => {
      setConnState(readyState());
      mockWindowClubhouse({ listRuns: vi.fn(async () => ({ runs: [] })) });
      render(<MainPanel api={api} />);
      await waitFor(() => expect(screen.getByTestId('goobers-runs-empty')).toBeInTheDocument());
      expect(screen.getByText('Daemon running — nothing active')).toBeInTheDocument();
    });

    // M33 (#1890): `overflow-y-auto` was already present on `goobers-runs-empty`
    // before this fix and did nothing — a flex item defaults to
    // `min-height: auto` and refuses to shrink below its content height, so
    // this box grew to fit every warning/footer row instead of overflowing,
    // and the ancestor's `overflow-hidden` clipped the excess. An assertion
    // that only checks for `overflow-y-auto` passes on that broken state
    // (the class was already there); this asserts the structural fix
    // instead — `min-h-0` present at every link the issue named — which is
    // absent on unmodified `2900a8f7` and would fail there.
    it('the idle detail scroll container can actually shrink (min-h-0 chain, not just overflow-y-auto)', async () => {
      setConnState(readyState({
        warnings: Array.from({ length: 17 }, (_, i) => ({ code: `VER00${i}`, explanation: `warning ${i}` })),
      }));
      mockWindowClubhouse({ listRuns: vi.fn(async () => ({ runs: [] })) });
      render(<MainPanel api={api} />);
      await waitFor(() => expect(screen.getByTestId('goobers-runs-empty')).toBeInTheDocument());

      const idleDetail = screen.getByTestId('goobers-runs-empty');
      expect(idleDetail.className).toContain('overflow-y-auto');
      expect(idleDetail.className).toContain('min-h-0');
      // justify-center splits overflow to both ends, making the leading
      // (top) overflow unreachable once content exceeds the box.
      expect(idleDetail.className).not.toContain('justify-center');

      const activeRunsRoot = screen.getByTestId('goobers-active-runs');
      expect(activeRunsRoot.className).toContain('min-h-0');
    });

    /**
     * #1883, rendered end to end. The owner's live instance: healthy daemon,
     * current data, 17 config warnings. The header must read
     * "Ready · Data current · 17 config warnings" with nothing alarming.
     */
    it('renders a healthy config-linted instance with no alarming banner (#1883)', async () => {
      setConnState(readyState(
        {
          status: 'degraded',
          warnings: [
            ...Array.from({ length: 13 }, () => ({ code: 'VER003', explanation: 'workflow has no schedule trigger' })),
            { code: 'CFG001', explanation: 'a' }, { code: 'CFG002', explanation: 'b' },
            { code: 'REF012', explanation: 'c' }, { code: 'DVL001', explanation: 'd' },
          ],
        },
        {
          health: {
            apiVersion: 'v1', schemaVersion: 'v1', ready: true, healthy: true,
            instance: { name: 'goobers-local', environment: 'dev' },
            freshness: {
              observedAt: new Date().toISOString(), definitionsLoadedAt: new Date().toISOString(),
              journalUpdatedAt: null, lastSchedulerTickAt: null, lastTickAgeMillis: 500,
            },
            readState: {
              epoch: 'e1', appliedSeq: 1, observedAt: new Date().toISOString(), lagSeconds: 32.5,
              pendingIntake: 0, oldestPendingSourceAge: 0, intakeWriteFailures: 0, minChangeSeq: 0,
              completeness: 'complete', degraded: [],
            },
          },
        },
      ));
      mockWindowClubhouse({ listRuns: vi.fn(async () => ({ runs: [] })) });
      render(<MainPanel api={api} />);
      await waitFor(() => expect(screen.getByTestId('goobers-runs-empty')).toBeInTheDocument());

      expect(screen.getByTestId('goobers-status-pill').textContent).toContain('Ready');
      expect(screen.getByTestId('goobers-freshness').textContent).toContain('Data current');
      expect(screen.getByTestId('goobers-config-warnings').textContent).toBe('17 config warnings');
      expect(screen.getByTestId('goobers-config-warnings')).toHaveAttribute(
        'title', '13x VER003, CFG001, CFG002, REF012, DVL001',
      );

      // The regression itself: nothing claims degradation or staleness.
      expect(screen.queryByTestId('goobers-scheduler-stalled-banner')).not.toBeInTheDocument();
      expect(screen.queryByTestId('goobers-freshness-banner')).not.toBeInTheDocument();
      expect(screen.queryByText(/may be stale/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Degraded/)).not.toBeInTheDocument();
    });

    it('omits the freshness element entirely when there is no read model', async () => {
      setConnState(readyState({}, { health: null }));
      mockWindowClubhouse({ listRuns: vi.fn(async () => ({ runs: [] })) });
      render(<MainPanel api={api} />);
      await waitFor(() => expect(screen.getByTestId('goobers-runs-empty')).toBeInTheDocument());
      // "Data current" here would be a claim nobody made.
      expect(screen.queryByTestId('goobers-freshness')).not.toBeInTheDocument();
    });

    it('shows an alert banner naming the reason for a non-self-healing degradation', async () => {
      setConnState(readyState({}, {
        health: {
          apiVersion: 'v1', schemaVersion: 'v1', ready: true, healthy: true,
          instance: { name: 'goobers-local', environment: 'dev' },
          freshness: {
            observedAt: new Date().toISOString(), definitionsLoadedAt: new Date().toISOString(),
            journalUpdatedAt: null, lastSchedulerTickAt: null, lastTickAgeMillis: 500,
          },
          readState: {
            epoch: 'e1', appliedSeq: 1, observedAt: new Date().toISOString(), lagSeconds: 120,
            pendingIntake: 0, oldestPendingSourceAge: 0, intakeWriteFailures: 3, minChangeSeq: 0,
            completeness: 'complete', degraded: ['intake_write_failure'],
          },
        },
      }));
      mockWindowClubhouse({ listRuns: vi.fn(async () => ({ runs: [] })) });
      render(<MainPanel api={api} />);
      await waitFor(() => expect(screen.getByTestId('goobers-runs-empty')).toBeInTheDocument());

      const banner = screen.getByTestId('goobers-freshness-banner');
      expect(banner.textContent).toContain('Data stale by 120.0s');
      expect(banner.textContent).toContain('intake_write_failure');
    });

    // M24: nothing beyond the base sentence renders when every optional
    // field (warnings, maintenance, storageHealth, counts, freshness/health)
    // is absent — a daemon that omits them must still get a clean panel.
    it('renders a clean idle panel with no warnings/maintenance/storage/freshness sections when every optional field is absent (M24)', async () => {
      setConnState(readyState({}, { health: null }));
      mockWindowClubhouse({ listRuns: vi.fn(async () => ({ runs: [] })) });
      render(<MainPanel api={api} />);
      await waitFor(() => expect(screen.getByTestId('goobers-runs-empty')).toBeInTheDocument());
      expect(screen.getByText('Daemon running — nothing active')).toBeInTheDocument();
      expect(screen.queryByTestId('goobers-instance-warnings')).not.toBeInTheDocument();
      expect(screen.queryByTestId('goobers-maintenance')).not.toBeInTheDocument();
      expect(screen.queryByTestId('goobers-storage-health')).not.toBeInTheDocument();
      expect(screen.queryByTestId('goobers-scheduler-freshness')).not.toBeInTheDocument();
      // counts IS present on the base fixture's instance, since it's non-optional on the wire.
      expect(screen.getByTestId('goobers-inventory-counts')).toBeInTheDocument();
    });

    /**
     * Reverses an M24 assertion on purpose (#1883). M24 wanted the idle screen
     * to answer "why is nothing running?", which was right — but it answered it
     * by calling the daemon "degraded" off `instance.status`, which only means
     * config lint. The answer is kept: the warnings list still renders directly
     * below this line. Only the false fault label is gone.
     */
    it('does not call a config-linted daemon "degraded" on the idle screen (#1883)', async () => {
      setConnState(readyState({ status: 'degraded' }));
      mockWindowClubhouse({ listRuns: vi.fn(async () => ({ runs: [] })) });
      render(<MainPanel api={api} />);
      await waitFor(() => expect(screen.getByTestId('goobers-runs-empty')).toBeInTheDocument());
      expect(screen.getByText('Daemon running — nothing active')).toBeInTheDocument();
      expect(screen.queryByText('Daemon degraded — nothing active')).not.toBeInTheDocument();
    });

    // M27: the daemon's CodedWarning serializes the text under `explanation`,
    // not `message` — a mock that fed `message` here pinned the wrong wire
    // contract and let `REF012: undefined` ship to the panel. Assert both
    // the real field renders and that no entry ever falls back to `undefined`.
    it('renders warnings[] with code and explanation, one per entry (M27)', async () => {
      setConnState(readyState({
        warnings: [
          { code: 'VER001', explanation: 'workflow version mismatch' },
          { code: 'MODEL002', explanation: 'model reference unresolved' },
        ],
      }));
      mockWindowClubhouse({ listRuns: vi.fn(async () => ({ runs: [] })) });
      render(<MainPanel api={api} />);
      await waitFor(() => expect(screen.getByTestId('goobers-instance-warnings')).toBeInTheDocument());
      expect(screen.getByText(/VER001: workflow version mismatch/)).toBeInTheDocument();
      expect(screen.getByText(/MODEL002: model reference unresolved/)).toBeInTheDocument();
      const warningsList = screen.getByTestId('goobers-instance-warnings');
      for (const item of warningsList.querySelectorAll('li')) {
        expect(item.textContent).not.toMatch(/undefined/);
      }
    });

    // M30 (#1879): three REF012 warnings with identical code+explanation were
    // rendering byte-identically on a live 17-warning instance — `scope` is
    // the only field that tells them apart, and it wasn't rendered at all.
    // Also covers the duplicate-React-key defect from the same line: keying
    // solely on `w.code` collides across these three siblings.
    it('renders scope so that warnings sharing a code are distinguishable, with unique React keys (M30 #1879)', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      setConnState(readyState({
        warnings: [
          { code: 'REF012', explanation: 'connectionRef does not select credentials at runtime', scope: 'gaggles/clubhouse/gaggle.yaml Gaggle/clubhouse' },
          { code: 'REF012', explanation: 'connectionRef does not select credentials at runtime', scope: 'gaggles/game-sim-gaggle/gaggle.yaml Gaggle/game-sim-gaggle' },
          { code: 'REF012', explanation: 'connectionRef does not select credentials at runtime', scope: 'gaggles/goobers-repo/gaggle.yaml Gaggle/goobers-repo' },
        ],
      }));
      mockWindowClubhouse({ listRuns: vi.fn(async () => ({ runs: [] })) });
      render(<MainPanel api={api} />);
      await waitFor(() => expect(screen.getByTestId('goobers-instance-warnings')).toBeInTheDocument());
      expect(screen.getByText(/Gaggle\/clubhouse/)).toBeInTheDocument();
      expect(screen.getByText(/Gaggle\/game-sim-gaggle/)).toBeInTheDocument();
      expect(screen.getByText(/Gaggle\/goobers-repo/)).toBeInTheDocument();
      const items = screen.getByTestId('goobers-instance-warnings').querySelectorAll('li');
      expect(items).toHaveLength(3);
      const rendered = Array.from(items).map((li) => li.textContent);
      expect(new Set(rendered).size).toBe(3);
      const keyWarnings = consoleError.mock.calls.filter((call) => String(call[0]).includes('unique "key" prop'));
      expect(keyWarnings).toHaveLength(0);
      consoleError.mockRestore();
    });

    it('renders maintenance with its current phase de-slugged and its error summary (M24)', async () => {
      setConnState(readyState({
        maintenance: {
          kind: 'retention-sweep',
          state: 'running',
          trigger: 'startup',
          currentPhase: 'projection-retention',
          candidates: 4,
          removed: 0,
          failures: 1,
          errorSummary: 'one candidate failed to remove',
        },
      }));
      mockWindowClubhouse({ listRuns: vi.fn(async () => ({ runs: [] })) });
      render(<MainPanel api={api} />);
      await waitFor(() => expect(screen.getByTestId('goobers-maintenance')).toBeInTheDocument());
      expect(screen.getByText(/retention-sweep — running/)).toBeInTheDocument();
      expect(screen.getByText(/projection retention/)).toBeInTheDocument();
      expect(screen.getByText('one candidate failed to remove')).toBeInTheDocument();
    });

    it('renders maintenance without currentPhase or errorSummary gracefully (M24)', async () => {
      setConnState(readyState({
        maintenance: {
          kind: 'retention-sweep', state: 'completed', trigger: 'startup',
          candidates: 0, removed: 0, failures: 0,
        },
      }));
      mockWindowClubhouse({ listRuns: vi.fn(async () => ({ runs: [] })) });
      render(<MainPanel api={api} />);
      await waitFor(() => expect(screen.getByTestId('goobers-maintenance')).toBeInTheDocument());
      expect(screen.getByText('Maintenance: retention-sweep — completed')).toBeInTheDocument();
    });

    // M24: verified live against a /tmp scratch daemon — storageHealth is a
    // real field our vendored Instance type didn't model until this mission.
    it('renders storageHealth, flagging any non-healthy tier — this is the actual answer to "why is nothing active" on the real instance (M24)', async () => {
      setConnState(readyState({
        storageHealth: {
          tier: 'admission-stopped',
          path: '.',
          freeBytes: 66_823_286_784,
          totalBytes: 494_384_795_648,
          warningFloorBytes: 137_438_953_472,
          warningFloorPercent: 10,
          criticalFloorBytes: 68_719_476_736,
          criticalFloorPercent: 5,
          measuredAt: '2026-09-18T01:31:29.560701-07:00',
        },
      }));
      mockWindowClubhouse({ listRuns: vi.fn(async () => ({ runs: [] })) });
      render(<MainPanel api={api} />);
      await waitFor(() => expect(screen.getByTestId('goobers-storage-health')).toBeInTheDocument());
      expect(screen.getByText(/admission stopped/)).toBeInTheDocument();
      expect(screen.getByText(/62\.2GB free of 460\.4GB/)).toBeInTheDocument();
      expect(screen.getByText(/critical floor 64\.0GB/)).toBeInTheDocument();
    });

    it('renders scheduler freshness as a relative age, not a raw timestamp (M24)', async () => {
      setConnState(readyState({}, {
        health: {
          apiVersion: 'v1', schemaVersion: 'v1', ready: true, healthy: true,
          instance: { name: 'goobers-local', environment: 'dev' },
          freshness: {
            observedAt: '2026-09-18T00:05:00.000Z',
            definitionsLoadedAt: '2026-09-18T00:00:00.000Z',
            journalUpdatedAt: '2026-09-18T00:00:00.000Z',
            lastSchedulerTickAt: '2026-09-18T00:00:00.000Z',
            lastTickAgeMillis: 300_000,
          },
        },
      }));
      mockWindowClubhouse({ listRuns: vi.fn(async () => ({ runs: [] })) });
      render(<MainPanel api={api} />);
      await waitFor(() => expect(screen.getByTestId('goobers-scheduler-freshness')).toBeInTheDocument());
      expect(screen.getByText('Scheduler tick 5m ago')).toBeInTheDocument();
      expect(screen.queryByText(/2026-09-18T00:00:00\.000Z/)).not.toBeInTheDocument();
    });

    it('renders inventory counts (gaggles/goobers/workflows) in the idle panel (M24)', async () => {
      setConnState(readyState({ counts: { gaggles: 3, goobers: 1, workflows: 12, activeRuns: 0 } }));
      mockWindowClubhouse({ listRuns: vi.fn(async () => ({ runs: [] })) });
      render(<MainPanel api={api} />);
      await waitFor(() => expect(screen.getByTestId('goobers-inventory-counts')).toBeInTheDocument());
      expect(screen.getByText('3 gaggles · 1 goober · 12 workflows')).toBeInTheDocument();
    });

    it('renders a single-count singular correctly (M24)', async () => {
      setConnState(readyState({ counts: { gaggles: 1, goobers: 1, workflows: 1, activeRuns: 0 } }));
      mockWindowClubhouse({ listRuns: vi.fn(async () => ({ runs: [] })) });
      render(<MainPanel api={api} />);
      await waitFor(() => expect(screen.getByTestId('goobers-inventory-counts')).toBeInTheDocument());
      expect(screen.getByText('1 gaggle · 1 goober · 1 workflow')).toBeInTheDocument();
    });

    it('renders a single active run with blockers and limitations rendered differently', async () => {
      setConnState(readyState({ concurrency: { activeRuns: 1, maxConcurrentRuns: 3 } }));
      const run = makeRun({
        operator: {
          liveness: 'no-heartbeat', trajectory: 'implementing',
          claim: { leaseStatus: 'held', providerMarker: 'x' },
          potentialBlockers: ['waiting on review'],
          diagnosticsLimitations: ['provider unreachable'],
        },
      });
      mockWindowClubhouse({ listRuns: vi.fn(async () => ({ runs: [run] })) });
      render(<MainPanel api={api} />);
      await waitFor(() => expect(screen.getAllByTestId('goobers-run-row')).toHaveLength(1));
      expect(screen.getByTestId('goobers-run-blockers')).toBeInTheDocument();
      expect(screen.getByTestId('goobers-run-limitations')).toBeInTheDocument();
      expect(screen.getByText(/waiting on review/)).toBeInTheDocument();
      expect(screen.getByText(/diagnostics incomplete/)).toBeInTheDocument();
    });

    // M30 (#1882): the row used to read as four unlabeled bare strings —
    // workflow, an unlabeled gaggle tag, an unlabeled "current stage" that
    // looked like a subtitle, and an ambiguous "1s" (total run duration,
    // easily misread as "this run just started"). Assert every field is
    // labeled, that the elapsed time is qualified, and that a run id is
    // present for CLI correlation.
    it('labels every active-run field — gaggle, step, elapsed time (qualified), and run id (M30 #1882)', async () => {
      setConnState(readyState({ concurrency: { activeRuns: 1, maxConcurrentRuns: 3 } }));
      const run = makeRun({
        id: '194450f95334b54ac833b95502ab3930',
        workflow: 'clubhouse-merge-review',
        gaggle: 'clubhouse',
        currentStage: 'reconcile-post-merge',
        durationMillis: 300_000,
        activeStages: [{ name: 'reconcile-post-merge', kind: 'stage', startedAt: new Date(Date.now() - 1_000).toISOString() }],
      });
      mockWindowClubhouse({ listRuns: vi.fn(async () => ({ runs: [run] })) });
      render(<MainPanel api={api} />);
      await waitFor(() => expect(screen.getAllByTestId('goobers-run-row')).toHaveLength(1));
      expect(screen.getByText('gaggle: clubhouse')).toBeInTheDocument();
      expect(screen.getByText('step: reconcile-post-merge')).toBeInTheDocument();
      // In-step elapsed (~1s, from activeStages[].startedAt), not the 5m total.
      expect(screen.getByText(/^\ds in step$/)).toBeInTheDocument();
      expect(screen.queryByText(/5m total/)).not.toBeInTheDocument();
      const runId = screen.getByTestId('goobers-run-id');
      expect(runId).toHaveTextContent('run 194450f9');
      expect(runId).toHaveAttribute('title', '194450f95334b54ac833b95502ab3930');
    });

    // No activeStages entry matches currentStage (older wire version, or the
    // stage just isn't tracked) — must fall back to total run duration and
    // say so explicitly, not silently reuse the in-step label.
    it('falls back to labeled total run duration when no activeStages entry matches the current stage (M30 #1882)', async () => {
      setConnState(readyState({ concurrency: { activeRuns: 1, maxConcurrentRuns: 3 } }));
      const run = makeRun({ currentStage: 'reconcile-post-merge', durationMillis: 300_000, activeStages: undefined });
      mockWindowClubhouse({ listRuns: vi.fn(async () => ({ runs: [run] })) });
      render(<MainPanel api={api} />);
      await waitFor(() => expect(screen.getAllByTestId('goobers-run-row')).toHaveLength(1));
      expect(screen.getByText('5m total')).toBeInTheDocument();
      expect(screen.queryByText(/in step/)).not.toBeInTheDocument();
    });

    it('scrolls and shows the truncation message with many runs above maxParallelRuns and tracks the live ratio', async () => {
      // maxParallelRuns well above the reference instance's 3, per §11's acceptance check.
      setConnState(readyState({ concurrency: { activeRuns: 12, maxConcurrentRuns: 50 } }));
      const runs = Array.from({ length: 12 }, (_, i) => makeRun({ id: `run-${i}`, workflow: `wf-${i}` }));
      mockWindowClubhouse({ listRuns: vi.fn(async () => ({ runs, nextCursor: 'more' })) });
      render(<MainPanel api={api} />);
      await waitFor(() => expect(screen.getAllByTestId('goobers-run-row')).toHaveLength(12));
      expect(screen.getByText('12 / 50 slots')).toBeInTheDocument();
      expect(screen.getByText(/showing first 12 of many running/)).toBeInTheDocument();
      const container = screen.getByTestId('goobers-active-runs').querySelector('.overflow-y-auto');
      expect(container).not.toBeNull();
      // M33 (#1890): the run list had the identical dead-scroll bug, not yet
      // visible only because this instance's concurrency caps runs at a low
      // number. `overflow-y-auto` alone was already present and inert; the
      // structural fix is `min-h-0` on both this container and the
      // ActiveRunsView root — absent on unmodified 2900a8f7.
      expect(container?.className).toContain('min-h-0');
      expect(screen.getByTestId('goobers-active-runs').className).toContain('min-h-0');
    });

    it('renders unknown RunEventType-adjacent fields gracefully — a run with no operator block does not crash', async () => {
      setConnState(readyState());
      const run = makeRun({ operator: undefined });
      mockWindowClubhouse({ listRuns: vi.fn(async () => ({ runs: [run] })) });
      render(<MainPanel api={api} />);
      await waitFor(() => expect(screen.getAllByTestId('goobers-run-row')).toHaveLength(1));
    });

    // M28: the panel's run list/slot count previously only ever updated on
    // mount or the manual [refresh] button, even though goobers-service.ts
    // has broadcast DATA_INVALIDATED with models:['run'] since M26. These
    // cover the consumer side: subscribe only in the data view, unsubscribe
    // on unmount (the panel mounts/unmounts on tab switches), and refetch
    // only when the invalidation actually names 'run'.
    it('unsubscribes from onDataInvalidated on unmount', async () => {
      setConnState(readyState());
      const unsubscribe = vi.fn();
      const onDataInvalidated = vi.fn(() => unsubscribe);
      mockWindowClubhouse({ listRuns: vi.fn(async () => ({ runs: [] })), onDataInvalidated });
      const { unmount } = render(<MainPanel api={api} />);
      await waitFor(() => expect(onDataInvalidated).toHaveBeenCalled());
      unmount();
      expect(unsubscribe).toHaveBeenCalled();
    });

    it('refetches runs when a DATA_INVALIDATED broadcast names the "run" model', async () => {
      setConnState(readyState());
      const listRuns = vi.fn(async () => ({ runs: [] }));
      let invalidate: ((payload: unknown) => void) | undefined;
      const onDataInvalidated = vi.fn((cb: (payload: unknown) => void) => { invalidate = cb; return vi.fn(); });
      mockWindowClubhouse({ listRuns, onDataInvalidated });
      render(<MainPanel api={api} />);
      await waitFor(() => expect(listRuns).toHaveBeenCalledTimes(1));
      invalidate?.({ models: ['run'] });
      await waitFor(() => expect(listRuns).toHaveBeenCalledTimes(2));
    });

    it('does not refetch runs when a DATA_INVALIDATED broadcast only names the "instance" model', async () => {
      setConnState(readyState());
      const listRuns = vi.fn(async () => ({ runs: [] }));
      let invalidate: ((payload: unknown) => void) | undefined;
      const onDataInvalidated = vi.fn((cb: (payload: unknown) => void) => { invalidate = cb; return vi.fn(); });
      mockWindowClubhouse({ listRuns, onDataInvalidated });
      render(<MainPanel api={api} />);
      await waitFor(() => expect(listRuns).toHaveBeenCalledTimes(1));
      invalidate?.({ models: ['instance'] });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(listRuns).toHaveBeenCalledTimes(1);
    });
  });

  it('the header refresh button force-refetches independent of any tick', async () => {
    const loadStateSpy = vi.fn(async () => {});
    useGoobersStore.setState({
      state: baseConnState({ connection: 'connected', stream: 'live' }),
      loaded: true, loadError: null,
      loadState: loadStateSpy, connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}),
    });
    mockWindowClubhouse();
    render(<MainPanel api={api} />);
    const btn = await screen.findByTestId('goobers-refresh');
    btn.click();
    expect(loadStateSpy).toHaveBeenCalled();
  });
});

// M23: unit coverage for the startup-phase copy helpers, independent of
// rendering, so the unknown-phase fallback and elapsed-time boundaries are
// each exercised directly rather than only incidentally through one fixture.
describe('startup phase copy helpers', () => {
  describe('describeStartupPhase', () => {
    it('describes a known upstream phase', () => {
      expect(describeStartupPhase('worktree-reap-crash-orphan')).toBe(
        'Recovering worktrees left by an interrupted run before scheduling resumes.',
      );
    });

    it('falls back to a generic description for an unmapped phase', () => {
      expect(describeStartupPhase('some-brand-new-phase')).toBe(
        'Goobers is completing a required startup operation.',
      );
    });

    it('falls back for an empty phase string', () => {
      expect(describeStartupPhase('')).toBe('Goobers is completing a required startup operation.');
    });
  });

  describe('deslugPhase', () => {
    it('replaces every hyphen with a space', () => {
      expect(deslugPhase('worktree-reap-crash-orphan')).toBe('worktree reap crash orphan');
    });

    it('leaves a phase with no hyphens unchanged', () => {
      expect(deslugPhase('starting')).toBe('starting');
    });
  });

  describe('formatElapsedSince', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-17T00:00:00.000Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('formats a moment just now as 0s', () => {
      expect(formatElapsedSince('2026-09-17T00:00:00.000Z')).toBe('0s');
    });

    it('formats a few seconds ago in seconds', () => {
      expect(formatElapsedSince('2026-09-16T23:59:45.000Z')).toBe('15s');
    });

    it('parses a Go-shaped microsecond timestamp with a UTC offset instead of returning "unknown"', () => {
      // 2026-09-16T16:58:00-07:00 is 2026-09-16T23:58:00Z, ~2 minutes before
      // the fake system time set above.
      expect(formatElapsedSince('2026-09-16T16:58:00.194644-07:00')).toBe('1m');
    });

    it('formats minutes elapsed', () => {
      expect(formatElapsedSince('2026-09-16T23:55:00.000Z')).toBe('5m');
    });

    it('formats hours elapsed', () => {
      expect(formatElapsedSince('2026-09-16T21:30:00.000Z')).toBe('2h 30m');
    });

    it('never goes negative for a since timestamp in the future (clock skew)', () => {
      expect(formatElapsedSince('2026-09-17T00:05:00.000Z')).toBe('0s');
    });

    it('returns "unknown" for an unparseable since string', () => {
      expect(formatElapsedSince('not-a-date')).toBe('unknown');
    });
  });

  describe('formatBytes', () => {
    it('formats gigabyte-scale values with one decimal', () => {
      expect(formatBytes(66_823_286_784)).toBe('62.2GB');
    });

    it('formats sub-gigabyte values in whole megabytes', () => {
      expect(formatBytes(5 * 1024 * 1024)).toBe('5MB');
    });

    it('formats exactly zero bytes', () => {
      expect(formatBytes(0)).toBe('0MB');
    });
  });

  describe('describeIdleStatus', () => {
    it('does not report a fault for a config-linted instance (#1883)', () => {
      expect(describeIdleStatus('degraded')).toBe('Daemon running — nothing active');
    });

    it('describes a starting instance', () => {
      expect(describeIdleStatus('starting')).toBe('Daemon starting — nothing active yet');
    });

    it('describes a ready instance', () => {
      expect(describeIdleStatus('ready')).toBe('Daemon running — nothing active');
    });

    it('falls back to the running framing for an undefined status', () => {
      expect(describeIdleStatus(undefined)).toBe('Daemon running — nothing active');
    });
  });
});
