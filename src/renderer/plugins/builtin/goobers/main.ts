import React, { useEffect, useState, useCallback, useMemo } from 'react';
import type { PluginContext, PluginAPI, PluginModule } from '../../../../shared/plugin-types';
import { useGoobersStore, initGoobersListener } from '../../../stores/goobersStore';
import { useGoobersSettingsStore } from '../../../stores/goobersSettingsStore';
import { deriveGoobersPanelState, type GoobersPanelState, type GoobersPanelStateKind } from './panelState';
import type { RunSummary } from '../../../../shared/goobers-api-types';
import type { GoobersSettings } from '../../../../shared/types';

// ── Activate / Deactivate ──────────────────────────────────────────────

let cleanupListener: (() => void) | null = null;
let refreshAction: (() => void) | null = null;
let startAction: (() => void) | null = null;
let stopAction: (() => void) | null = null;

export function activate(ctx: PluginContext, api: PluginAPI): void {
  cleanupListener = initGoobersListener();
  ctx.subscriptions.push(
    api.commands.register('goobers.open', () => { /* rail navigation handles opening */ }),
    api.commands.register('goobers.refresh', () => refreshAction?.()),
    api.commands.register('goobers.start', () => startAction?.()),
    api.commands.register('goobers.stop', () => stopAction?.()),
  );
}

export function deactivate(): void {
  cleanupListener?.();
  cleanupListener = null;
  refreshAction = null;
  startAction = null;
  stopAction = null;
}

// ── Helpers ────────────────────────────────────────────────────────────

function isRunList(v: unknown): v is { runs: RunSummary[]; nextCursor?: string } {
  return typeof v === 'object' && v !== null && Array.isArray((v as { runs?: unknown }).runs);
}

/** Truncate hostile content (workflow/gaggle names, issue titles, error text — all from user repos). */
export function truncate(value: string, max = 60): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

export function formatDurationMillis(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function formatAgeMillis(ms: number | undefined | null): string {
  if (ms == null) return 'unknown';
  return formatDurationMillis(ms);
}

const STATUS_PILL: Record<GoobersPanelStateKind, { label: string; color: string; icon: string }> = {
  'not-configured': { label: 'Not configured', color: 'text-ctp-subtext0', icon: '○' },
  'invalid-root': { label: 'Invalid root', color: 'text-ctp-red', icon: '⚠' },
  'decommissioned-root': { label: 'Decommissioned root', color: 'text-ctp-red', icon: '⚠' },
  'binary-not-found': { label: 'Binary not found', color: 'text-ctp-yellow', icon: '⚠' },
  'daemon-control-off': { label: 'Daemon not running', color: 'text-ctp-subtext0', icon: '○' },
  'auth-required': { label: 'Auth required', color: 'text-ctp-yellow', icon: '⚠' },
  'daemon-not-running': { label: 'Daemon not running', color: 'text-ctp-subtext0', icon: '○' },
  starting: { label: 'Starting', color: 'text-ctp-yellow', icon: '◐' },
  'start-failed': { label: 'Start failed', color: 'text-ctp-red', icon: '⚠' },
  stopping: { label: 'Stopping', color: 'text-ctp-yellow', icon: '◐' },
  'port-mismatch': { label: 'Instance mismatch', color: 'text-ctp-red', icon: '⚠' },
  'incompatible-api': { label: 'Incompatible', color: 'text-ctp-red', icon: '⚠' },
  'stream-reconnecting': { label: 'Reconnecting', color: 'text-ctp-yellow', icon: '◐' },
  'polling-fallback': { label: 'Polling', color: 'text-ctp-yellow', icon: '◐' },
  'no-read-model': { label: 'Degraded', color: 'text-ctp-yellow', icon: '⚠' },
  degraded: { label: 'Degraded', color: 'text-ctp-yellow', icon: '⚠' },
  ready: { label: 'Ready', color: 'text-ctp-green', icon: '●' },
  connecting: { label: 'Connecting', color: 'text-ctp-yellow', icon: '◐' },
  'unknown-error': { label: 'Error', color: 'text-ctp-red', icon: '⚠' },
};

function StatusPill({ kind }: { kind: GoobersPanelStateKind }) {
  const cfg = STATUS_PILL[kind] ?? { label: kind, color: 'text-ctp-subtext0', icon: '○' };
  return React.createElement('span', {
    className: `flex items-center gap-1 text-xs font-medium ${cfg.color}`,
    'data-testid': 'goobers-status-pill',
  },
    React.createElement('span', { 'aria-hidden': 'true' }, cfg.icon),
    React.createElement('span', null, cfg.label),
  );
}

function RetryButton({ onRetry }: { onRetry: () => void }) {
  return React.createElement('button', {
    onClick: onRetry,
    className: 'text-xs px-2 py-1 rounded border border-ctp-overlay0 text-ctp-text hover:bg-surface-1 cursor-pointer',
    'data-testid': 'goobers-retry',
  }, 'Try again');
}

function InlinePicker({ onPick }: { onPick: () => void }) {
  return React.createElement('button', {
    onClick: onPick,
    className: 'text-sm px-3 py-1.5 rounded bg-ctp-accent text-ctp-base hover:opacity-90 cursor-pointer',
    'data-testid': 'goobers-inline-picker',
  }, 'Choose instance root…');
}

// ── Not configured ─────────────────────────────────────────────────────

function NotConfiguredScreen({ onPick }: { onPick: () => void }) {
  return React.createElement('div', {
    className: 'flex flex-col items-center justify-center h-full w-full gap-3 text-center px-6',
    'data-testid': 'goobers-state-not-configured',
  },
    React.createElement('div', { className: 'text-ctp-text text-sm font-medium' }, 'Point Clubhouse at a Goobers instance'),
    React.createElement('div', { className: 'text-ctp-subtext0 text-xs max-w-sm' },
      'Goobers is a local daemon that schedules automated workflows against your repositories. Choose the directory that holds its instance.yaml to get started.'),
    React.createElement(InlinePicker, { onPick }),
  );
}

// ── Generic error screen ───────────────────────────────────────────────

function ErrorScreen({
  title, detail, onRetry, testId,
}: { title: string; detail?: string; onRetry: () => void; testId: string }) {
  return React.createElement('div', {
    className: 'flex flex-col items-center justify-center h-full w-full gap-2 text-center px-6',
    'data-testid': testId,
  },
    React.createElement('div', { className: 'text-ctp-red text-sm font-medium' }, title),
    detail ? React.createElement('div', {
      className: 'text-ctp-subtext0 text-xs max-w-md truncate',
      title: detail,
    }, truncate(detail, 200)) : null,
    React.createElement(RetryButton, { onRetry }),
  );
}

// ── Daemon not running / control off ───────────────────────────────────

function DaemonNotRunningScreen({
  manageDaemon, binaryPath, instanceName, instanceEnvironment, rootIdentity, onStart, onEnableControl, onRetry,
}: {
  manageDaemon: boolean;
  binaryPath: string;
  instanceName?: string | null;
  instanceEnvironment?: string | null;
  rootIdentity: string | null;
  onStart: () => void;
  onEnableControl: () => void;
  onRetry: () => void;
}) {
  // §8.4/§12 — "Instance identity + config summary from disk" for the
  // daemon-down screen. instanceName/instanceEnvironment come from the
  // optional config/manifest.yaml (§9.2 — absent is normal, never an error);
  // fall back to the root identity alone when they're unavailable.
  const identityLine = instanceName
    ? `${instanceName}${instanceEnvironment ? ` (${instanceEnvironment})` : ''}`
    : rootIdentity;
  return React.createElement('div', {
    className: 'flex flex-col items-center justify-center h-full w-full gap-3 text-center px-6',
    'data-testid': manageDaemon ? 'goobers-state-daemon-not-running' : 'goobers-state-daemon-control-off',
  },
    identityLine
      ? React.createElement('div', {
          className: 'text-ctp-subtext0 text-xs',
          'data-testid': 'goobers-daemon-not-running-identity',
        }, identityLine)
      : null,
    React.createElement('div', { className: 'text-ctp-text text-sm font-medium' }, 'Daemon is not running'),
    React.createElement('div', { className: 'text-ctp-subtext0 text-xs max-w-sm' },
      manageDaemon
        ? 'History is unavailable while the daemon is stopped.'
        : `Daemon control is off. Run this command yourself: ${binaryPath} up — or enable Clubhouse-managed control below.`),
    manageDaemon
      ? React.createElement('button', {
          onClick: onStart,
          className: 'text-sm px-3 py-1.5 rounded bg-ctp-accent text-ctp-base hover:opacity-90 cursor-pointer',
          'data-testid': 'goobers-start-daemon',
        }, 'Start daemon')
      : React.createElement('button', {
          onClick: onEnableControl,
          className: 'text-sm px-3 py-1.5 rounded border border-ctp-overlay0 text-ctp-text hover:bg-surface-1 cursor-pointer',
          'data-testid': 'goobers-enable-daemon-control',
        }, 'Enable daemon control from Clubhouse'),
    React.createElement(RetryButton, { onRetry }),
  );
}

// ── Active runs list ───────────────────────────────────────────────────

function BlockersAndLimitations({ blockers, limitations }: { blockers: string[]; limitations?: string[] }) {
  return React.createElement('div', { className: 'flex flex-col gap-1 mt-1' },
    blockers.length > 0
      ? React.createElement('div', { className: 'flex flex-wrap gap-1', 'data-testid': 'goobers-run-blockers' },
          blockers.map((b, i) => React.createElement('span', {
            key: i,
            className: 'text-[10px] px-1.5 py-0.5 rounded bg-ctp-yellow/15 text-ctp-yellow border border-ctp-yellow/30',
            title: b,
          }, `⚠ ${truncate(b, 40)}`)),
        )
      : null,
    limitations && limitations.length > 0
      ? React.createElement('div', {
          className: 'text-[10px] text-ctp-subtext0 italic',
          'data-testid': 'goobers-run-limitations',
          title: limitations.join('; '),
        }, `diagnostics incomplete: ${truncate(limitations.join('; '), 60)}`)
      : null,
  );
}

function RunRow({ run }: { run: RunSummary }) {
  const op = run.operator;
  return React.createElement('div', {
    className: 'flex flex-col gap-0.5 px-3 py-2 border-b border-ctp-overlay0/30',
    'data-testid': 'goobers-run-row',
  },
    React.createElement('div', { className: 'flex items-center justify-between gap-2 text-xs' },
      React.createElement('span', { className: 'font-medium text-ctp-text truncate', title: run.workflow }, truncate(run.workflow, 40)),
      React.createElement('span', { className: 'text-ctp-subtext0 shrink-0' }, truncate(run.gaggle, 24)),
    ),
    React.createElement('div', { className: 'flex items-center gap-2 text-[11px] text-ctp-subtext0' },
      run.currentStage ? React.createElement('span', null, truncate(run.currentStage, 30)) : null,
      op?.issue ? React.createElement('span', null, `#${op.issue.number}`) : null,
      op?.pullRequest ? React.createElement('span', null, 'has PR') : null,
      React.createElement('span', null, formatDurationMillis(run.durationMillis)),
      op?.heartbeatAgeMillis != null ? React.createElement('span', null, `heartbeat ${formatAgeMillis(op.heartbeatAgeMillis)} ago`) : null,
      run.stale ? React.createElement('span', { className: 'text-ctp-red' }, 'no heartbeat') : null,
    ),
    op ? React.createElement(BlockersAndLimitations, { blockers: op.potentialBlockers, limitations: op.diagnosticsLimitations }) : null,
  );
}

function ActiveRunsView({
  runs, hasMore, totalShown, activeRuns, maxConcurrentRuns,
}: {
  runs: RunSummary[];
  hasMore: boolean;
  totalShown: number;
  activeRuns: number;
  maxConcurrentRuns: number;
}) {
  return React.createElement('div', { className: 'flex flex-col h-full w-full', 'data-testid': 'goobers-active-runs' },
    React.createElement('div', { className: 'flex items-center justify-between px-3 py-1.5 text-[11px] text-ctp-subtext0 border-b border-ctp-overlay0/30' },
      React.createElement('span', null, `${activeRuns} / ${maxConcurrentRuns} slots`),
      hasMore ? React.createElement('span', null, `showing first ${totalShown} of many running`) : null,
    ),
    runs.length === 0
      ? React.createElement('div', { className: 'flex items-center justify-center flex-1 text-ctp-subtext0 text-xs', 'data-testid': 'goobers-runs-empty' },
          'Daemon running — nothing active')
      : React.createElement('div', { className: 'flex-1 overflow-y-auto' },
          runs.map((r) => React.createElement(RunRow, { key: r.id, run: r })),
        ),
  );
}

// ── Header ──────────────────────────────────────────────────────────────

function Header({
  kind, state, manageDaemon, onRefresh, onStart, onStop, onOpenSettings,
}: {
  kind: GoobersPanelStateKind;
  state: ReturnType<typeof useGoobersStore.getState>['state'];
  manageDaemon: boolean;
  onRefresh: () => void;
  onStart: () => void;
  onStop: () => void;
  onOpenSettings: () => void;
}) {
  const name = state?.instance?.name ?? state?.instanceRoot ?? 'Goobers';
  const env = state?.instance?.environment;
  const running = state?.daemon.state === 'running';
  const readState = state?.health?.readState;

  return React.createElement('div', {
    className: 'flex items-center justify-between px-3 py-2 border-b border-ctp-overlay0/30 shrink-0',
    'data-testid': 'goobers-header',
  },
    React.createElement('div', { className: 'flex items-center gap-2 min-w-0' },
      React.createElement('span', { className: 'text-sm font-medium text-ctp-text truncate', title: name }, truncate(name, 30)),
      env ? React.createElement('span', { className: 'text-[10px] px-1.5 py-0.5 rounded bg-surface-1 text-ctp-subtext0' }, env) : null,
      React.createElement(StatusPill, { kind }),
      readState ? React.createElement('span', {
        className: 'text-[10px] text-ctp-subtext0',
        'data-testid': 'goobers-freshness',
      }, `lag ${readState.lagSeconds.toFixed(1)}s${readState.completeness === 'partial' ? ' · partial' : ''}`) : null,
    ),
    React.createElement('div', { className: 'flex items-center gap-2 shrink-0' },
      manageDaemon
        ? (running
            ? React.createElement('button', {
                onClick: onStop,
                className: 'text-xs px-2 py-1 rounded border border-ctp-overlay0 text-ctp-text hover:bg-surface-1 cursor-pointer',
                'data-testid': 'goobers-stop-daemon',
              }, 'Stop daemon')
            : React.createElement('button', {
                onClick: onStart,
                className: 'text-xs px-2 py-1 rounded border border-ctp-overlay0 text-ctp-text hover:bg-surface-1 cursor-pointer',
                'data-testid': 'goobers-header-start-daemon',
              }, 'Start daemon'))
        : null,
      React.createElement('button', {
        onClick: onRefresh,
        className: 'text-xs px-2 py-1 rounded border border-ctp-overlay0 text-ctp-text hover:bg-surface-1 cursor-pointer',
        'data-testid': 'goobers-refresh',
      }, '[refresh]'),
      React.createElement('button', {
        onClick: onOpenSettings,
        'aria-label': 'Goobers settings',
        className: 'text-ctp-subtext0 hover:text-ctp-text cursor-pointer',
        'data-testid': 'goobers-settings-gear',
      }, '⚙'),
    ),
  );
}

// ── Main Panel ─────────────────────────────────────────────────────────

export function MainPanel({ api }: { api: PluginAPI }) {
  const storeState = useGoobersStore((s) => s.state);
  const loaded = useGoobersStore((s) => s.loaded);
  const loadState = useGoobersStore((s) => s.loadState);

  const manageDaemon = useGoobersSettingsStore((s) => s.manageDaemon);
  const binaryPath = useGoobersSettingsStore((s) => s.binaryPath);
  const settingsInstanceRoot = useGoobersSettingsStore((s) => s.instanceRoot);
  const settingsLoaded = useGoobersSettingsStore((s) => s.loaded);
  const saveGoobersSettings = useGoobersSettingsStore((s) => s.saveSettings);
  const loadGoobersSettings = useGoobersSettingsStore((s) => s.loadSettings);

  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [runsHasMore, setRunsHasMore] = useState(false);

  useEffect(() => {
    loadState();
    loadGoobersSettings();
  }, [loadState, loadGoobersSettings]);

  const panelState = useMemo(() => {
    if (!storeState) return null;
    const derived = deriveGoobersPanelState(storeState, manageDaemon);
    // M12: `goobers:get-state`'s first read always reflects the pre-
    // activation idle snapshot (configured: false) — subscribe() fires
    // reconcile() unawaited, so the synchronous getState() that follows it
    // can't see the result yet. The settings store loads the saved
    // instanceRoot over its own, unrelated IPC channel, so it isn't subject
    // to that race. Trust it over a same-tick "not configured" read rather
    // than falsely asserting the root was never saved; fall back to the
    // loading state until the STATE_CHANGED broadcast that follows
    // reconcile() replaces this with the true derived state.
    if (derived.kind === 'not-configured' && settingsLoaded && settingsInstanceRoot !== '') {
      return null;
    }
    return derived;
  }, [storeState, manageDaemon, settingsLoaded, settingsInstanceRoot]);

  const fetchRuns = useCallback(async () => {
    try {
      const result = await window.clubhouse.goobers.listRuns({
        phase: 'running',
        limit: 200,
        orderByActivity: true,
        showNoWork: false,
      });
      if (isRunList(result)) {
        setRuns(result.runs);
        setRunsHasMore(!!result.nextCursor);
      } else {
        // M3 not-implemented stub, or an unrecognized shape — degrade quietly (§9.2).
        setRuns([]);
        setRunsHasMore(false);
      }
    } catch {
      setRuns([]);
      setRunsHasMore(false);
    }
  }, []);

  const isDataView = panelState
    ? ['ready', 'degraded', 'stream-reconnecting', 'polling-fallback', 'no-read-model'].includes(panelState.kind)
    : false;

  useEffect(() => {
    if (isDataView) {
      fetchRuns();
    }
  }, [isDataView, fetchRuns]);

  const handleRefresh = useCallback(() => {
    loadState();
    if (isDataView) fetchRuns();
  }, [loadState, isDataView, fetchRuns]);

  const handleStart = useCallback(() => {
    window.clubhouse.goobers.daemonStart().then(() => loadState());
  }, [loadState]);

  const handleStop = useCallback(() => {
    window.clubhouse.goobers.daemonStop().then(() => loadState());
  }, [loadState]);

  const handleEnableDaemonControl = useCallback(() => {
    saveGoobersSettings({ manageDaemon: true } satisfies Partial<GoobersSettings>);
  }, [saveGoobersSettings]);

  const handlePickRoot = useCallback(async () => {
    const picked = await window.clubhouse.project.pickDirectory();
    if (picked) {
      saveGoobersSettings({ instanceRoot: picked } satisfies Partial<GoobersSettings>);
      loadState();
    }
  }, [saveGoobersSettings, loadState]);

  // Deep-linking into Settings → Goobers is wired by M2's GoobersSettingsView
  // registration (spec §14.3 lists MainContentView.tsx routing as M2 scope).
  // This gear is a visible affordance for that link point; api is accepted
  // so the wiring can be added here without touching MainContentView.tsx.
  const handleOpenSettings = useCallback(() => {
    void api;
  }, [api]);

  useEffect(() => {
    refreshAction = handleRefresh;
    startAction = handleStart;
    stopAction = handleStop;
    return () => {
      refreshAction = null;
      startAction = null;
      stopAction = null;
    };
  }, [handleRefresh, handleStart, handleStop]);

  if (!loaded || !panelState) {
    return React.createElement('div', {
      className: 'flex items-center justify-center h-full w-full text-ctp-subtext0 text-xs',
      'data-testid': 'goobers-state-connecting',
    }, 'Loading…');
  }

  const kind = panelState.kind;

  let body: React.ReactElement;
  switch (kind) {
    case 'not-configured':
      body = React.createElement(NotConfiguredScreen, { onPick: handlePickRoot });
      break;
    case 'invalid-root':
      body = React.createElement(ErrorScreen, {
        title: 'Not a Goobers instance root',
        detail: panelState.error?.message ?? 'instance.yaml was not found at this path',
        onRetry: handleRefresh,
        testId: 'goobers-state-invalid-root',
      });
      break;
    case 'decommissioned-root':
      body = React.createElement(ErrorScreen, {
        title: 'This is a historical (decommissioned) root',
        detail: panelState.error?.message,
        onRetry: handlePickRoot,
        testId: 'goobers-state-decommissioned-root',
      });
      break;
    case 'binary-not-found':
      body = React.createElement(ErrorScreen, {
        title: `Couldn't find the goobers binary`,
        detail: `Tried: ${binaryPath}. ${panelState.error?.message ?? ''}`,
        onRetry: handleRefresh,
        testId: 'goobers-state-binary-not-found',
      });
      break;
    case 'auth-required':
      body = React.createElement(ErrorScreen, {
        title: `This instance requires an API credential, which Clubhouse can't supply yet.`,
        onRetry: handleRefresh,
        testId: 'goobers-state-auth-required',
      });
      break;
    case 'daemon-not-running':
    case 'daemon-control-off':
      body = React.createElement(DaemonNotRunningScreen, {
        manageDaemon,
        binaryPath,
        instanceName: panelState.raw.instanceName,
        instanceEnvironment: panelState.raw.instanceEnvironment,
        rootIdentity: panelState.raw.rootIdentity,
        onStart: handleStart,
        onEnableControl: handleEnableDaemonControl,
        onRetry: handleRefresh,
      });
      break;
    case 'starting':
      body = React.createElement('div', {
        className: 'flex flex-col items-center justify-center h-full w-full gap-2 text-ctp-subtext0 text-xs',
        'data-testid': 'goobers-state-starting',
      }, React.createElement('span', null, 'Starting…'));
      break;
    case 'start-failed':
      body = React.createElement(ErrorScreen, {
        title: 'Failed to start the daemon',
        detail: panelState.error?.message ?? 'see the daemon log for details',
        onRetry: handleStart,
        testId: 'goobers-state-start-failed',
      });
      break;
    case 'stopping':
      body = React.createElement('div', {
        className: 'flex items-center justify-center h-full w-full text-ctp-subtext0 text-xs',
        'data-testid': 'goobers-state-stopping',
      }, 'Stopping — draining in-flight runs…');
      break;
    case 'port-mismatch':
      body = React.createElement(ErrorScreen, {
        title: 'This instance does not match the configured root',
        detail: 'Refusing to render another instance\'s data.',
        onRetry: handleRefresh,
        testId: 'goobers-state-port-mismatch',
      });
      break;
    case 'incompatible-api':
      body = React.createElement(ErrorScreen, {
        title: 'This Goobers instance uses an incompatible API version',
        detail: panelState.error?.message,
        onRetry: handleRefresh,
        testId: 'goobers-state-incompatible-api',
      });
      break;
    case 'unknown-error':
      body = React.createElement(ErrorScreen, {
        title: 'Something went wrong',
        detail: panelState.error?.message ?? panelState.error?.code,
        onRetry: handleRefresh,
        testId: 'goobers-state-unknown-error',
      });
      break;
    case 'connecting':
      body = React.createElement('div', {
        className: 'flex items-center justify-center h-full w-full text-ctp-subtext0 text-xs',
        'data-testid': 'goobers-state-connecting-active',
      }, 'Connecting…');
      break;
    case 'degraded':
    case 'stream-reconnecting':
    case 'polling-fallback':
    case 'no-read-model':
    case 'ready':
    default:
      body = React.createElement(React.Fragment, null,
        kind === 'degraded' ? React.createElement('div', {
          className: 'px-3 py-1 text-[11px] text-ctp-yellow bg-ctp-yellow/10 border-b border-ctp-yellow/20',
          'data-testid': 'goobers-degraded-banner',
        }, '⚠ Instance is degraded — data below may be stale') : null,
        kind === 'stream-reconnecting' ? React.createElement('div', {
          className: 'px-3 py-1 text-[11px] text-ctp-yellow',
          'data-testid': 'goobers-reconnecting-banner',
        }, 'Reconnecting…') : null,
        kind === 'polling-fallback' ? React.createElement('div', {
          className: 'px-3 py-1 text-[11px] text-ctp-yellow',
          'data-testid': 'goobers-polling-banner',
        }, 'Live updates unavailable — refreshing every 60s') : null,
        kind === 'no-read-model' ? React.createElement('div', {
          className: 'px-3 py-1 text-[11px] text-ctp-yellow',
          'data-testid': 'goobers-no-read-model-banner',
        }, 'Reduced fidelity — read model unavailable') : null,
        React.createElement(ActiveRunsView, {
          runs,
          hasMore: runsHasMore,
          totalShown: runs.length,
          activeRuns: storeState?.instance?.concurrency.activeRuns ?? 0,
          maxConcurrentRuns: storeState?.instance?.concurrency.maxConcurrentRuns ?? 0,
        }),
      );
      break;
  }

  return React.createElement('div', { className: 'flex flex-col h-full w-full' },
    React.createElement(Header, {
      kind, state: storeState, manageDaemon,
      onRefresh: handleRefresh, onStart: handleStart, onStop: handleStop, onOpenSettings: handleOpenSettings,
    }),
    React.createElement('div', { className: 'flex-1 min-h-0 overflow-hidden' }, body),
  );
}

// Compile-time type assertion
const _: PluginModule = { activate, deactivate, MainPanel };
void _;
export type { GoobersPanelState };
