import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MainPanel, describeStartupPhase, deslugPhase, formatElapsedSince } from './main';
import { createMockAPI } from '../../testing';
import { useGoobersStore } from '../../../stores/goobersStore';
import { useGoobersSettingsStore } from '../../../stores/goobersSettingsStore';
import type { GoobersConnectionState } from '../../../../shared/goobers-types';
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

function mockWindowClubhouse(overrides: { listRuns?: unknown; pickDirectory?: unknown } = {}) {
  const w = globalThis.window as unknown as { clubhouse?: Record<string, unknown> };
  w.clubhouse = {
    ...w.clubhouse,
    goobers: {
      listRuns: overrides.listRuns ?? vi.fn(async () => ({ runs: [], nextCursor: undefined })),
      daemonStart: vi.fn(async () => ({ ok: true })),
      daemonStop: vi.fn(async () => ({ ok: true })),
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

  it('renders the active-runs view with a degraded banner when degraded', async () => {
    setConnState(baseConnState({ connection: 'degraded', stream: 'live' }));
    render(<MainPanel api={api} />);
    expect(screen.getByTestId('goobers-degraded-banner')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('goobers-active-runs')).toBeInTheDocument());
  });

  it('renders the stream-reconnecting banner', async () => {
    setConnState(baseConnState({ connection: 'connected', stream: 'reconnecting' }));
    render(<MainPanel api={api} />);
    expect(screen.getByTestId('goobers-reconnecting-banner')).toBeInTheDocument();
  });

  it('renders the polling-fallback banner', async () => {
    setConnState(baseConnState({ connection: 'connected', stream: 'polling' }));
    render(<MainPanel api={api} />);
    expect(screen.getByTestId('goobers-polling-banner')).toBeInTheDocument();
  });

  it('renders the no-read-model banner', async () => {
    setConnState(baseConnState({ connection: 'connected', stream: 'unavailable' }));
    render(<MainPanel api={api} />);
    expect(screen.getByTestId('goobers-no-read-model-banner')).toBeInTheDocument();
  });

  describe('ready state and the active-run list', () => {
    function readyState(instanceOverrides: Partial<NonNullable<GoobersConnectionState['instance']>> = {}) {
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
      });
    }

    it('handles zero active runs as the normal resting state, not an error', async () => {
      setConnState(readyState());
      mockWindowClubhouse({ listRuns: vi.fn(async () => ({ runs: [] })) });
      render(<MainPanel api={api} />);
      await waitFor(() => expect(screen.getByTestId('goobers-runs-empty')).toBeInTheDocument());
      expect(screen.getByText('Daemon running — nothing active')).toBeInTheDocument();
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
    });

    it('renders unknown RunEventType-adjacent fields gracefully — a run with no operator block does not crash', async () => {
      setConnState(readyState());
      const run = makeRun({ operator: undefined });
      mockWindowClubhouse({ listRuns: vi.fn(async () => ({ runs: [run] })) });
      render(<MainPanel api={api} />);
      await waitFor(() => expect(screen.getAllByTestId('goobers-run-row')).toHaveLength(1));
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
});
