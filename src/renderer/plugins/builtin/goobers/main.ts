import React, { useEffect, useState, useCallback, useMemo } from 'react';
import type { PluginContext, PluginAPI, PluginModule } from '../../../../shared/plugin-types';
import { useGoobersStore, initGoobersListener } from '../../../stores/goobersStore';
import { useGoobersSettingsStore } from '../../../stores/goobersSettingsStore';
import {
  deriveGoobersPanelState,
  type GoobersPanelState,
  type GoobersPanelStateKind,
  type GoobersFreshness,
  type GoobersConfigWarnings,
} from './panelState';
import type { RunSummary, Instance, Health, InstanceStatus, UpdateModel } from '../../../../shared/goobers-api-types';
import type { GoobersSettings } from '../../../../shared/types';
import { GOOBERS_POLL_FALLBACK_INTERVAL_MS } from '../../../../shared/goobers-types';

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

function isDataInvalidatedPayload(v: unknown): v is { models: UpdateModel[] } {
  return typeof v === 'object' && v !== null && Array.isArray((v as { models?: unknown }).models);
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

/**
 * Transcribed from goobers cmd/goobers/dashboard.go:130-146 (own literals,
 * no dependency on the goobers repo). The daemon's phase vocabulary grows
 * without telling us, so an unmapped phase must still render sanely — see
 * `describeStartupPhase`'s fallback.
 */
const GOOBERS_STARTUP_PHASE_DESCRIPTIONS: Record<string, string> = {
  'api-bind': 'Opening the local API so startup progress can be observed.',
  'worktree-reap-crash-orphan': 'Recovering worktrees left by an interrupted run before scheduling resumes.',
  'telemetry-retention-prune': 'Pruning expired telemetry according to the instance retention policy.',
  'orphan-run-prune': 'Cleaning incomplete run directories left by an interrupted startup.',
  'webhook-listener-start': 'Starting the configured webhook listener.',
  'waiting-for-daemon-api': 'Waiting for the daemon API to begin listening.',
};

const UNKNOWN_STARTUP_PHASE_DESCRIPTION = 'Goobers is completing a required startup operation.';

export function describeStartupPhase(phase: string): string {
  return GOOBERS_STARTUP_PHASE_DESCRIPTIONS[phase] ?? UNKNOWN_STARTUP_PHASE_DESCRIPTION;
}

export function deslugPhase(phase: string): string {
  return phase.replace(/-/g, ' ');
}

export function formatElapsedSince(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'unknown';
  return formatDurationMillis(Math.max(0, Date.now() - then));
}

export function formatBytes(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${gib.toFixed(1)}GB`;
  const mib = bytes / 1024 ** 2;
  return `${mib.toFixed(0)}MB`;
}

/** M24: the daemon's own summary judgement — degraded/starting still needs the same idle framing. */
export function describeIdleStatus(status: InstanceStatus | undefined): string {
  switch (status) {
    // Config lint, not a fault — see §8.4. The warning count is rendered
    // separately in the header; this line is only about there being no runs.
    case 'degraded': return 'Daemon running — nothing active';
    case 'starting': return 'Daemon starting — nothing active yet';
    case 'ready':
    default: return 'Daemon running — nothing active';
  }
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
  recovering: { label: 'Recovering', color: 'text-ctp-yellow', icon: '◐' },
  'start-failed': { label: 'Start failed', color: 'text-ctp-red', icon: '⚠' },
  'start-unknown': { label: 'Starting (slow)', color: 'text-ctp-yellow', icon: '◐' },
  stopping: { label: 'Stopping', color: 'text-ctp-yellow', icon: '◐' },
  'stop-failed': { label: 'Stop failed', color: 'text-ctp-red', icon: '⚠' },
  'port-mismatch': { label: 'Instance mismatch', color: 'text-ctp-red', icon: '⚠' },
  'incompatible-api': { label: 'Incompatible', color: 'text-ctp-red', icon: '⚠' },
  'stream-reconnecting': { label: 'Reconnecting', color: 'text-ctp-yellow', icon: '◐' },
  'polling-fallback': { label: 'Polling', color: 'text-ctp-yellow', icon: '◐' },
  'no-read-model': { label: 'Degraded', color: 'text-ctp-yellow', icon: '⚠' },
  'scheduler-stalled': { label: 'Scheduler stalled', color: 'text-ctp-yellow', icon: '⚠' },
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

// ── Start outcome unknown (§7.5) ────────────────────────────────────────

/**
 * The 60s start wait elapsed but the child never exited — it is running, we
 * just haven't confirmed readiness yet. Deliberately has NO retry/Start
 * button: pressing Start again here would hit lock contention against the
 * app's own daemon (M17). The poll loop (goobers-service.ts) keeps observing
 * in the background and this screen clears on its own once the daemon
 * reports ready — no user action required.
 */
function StartUnknownScreen({ stderr, logPathHint }: { stderr?: string; logPathHint?: string }) {
  return React.createElement('div', {
    className: 'flex flex-col items-center justify-center h-full w-full gap-2 text-center px-6',
    'data-testid': 'goobers-state-start-unknown',
  },
    React.createElement('div', { className: 'text-ctp-text text-sm font-medium' }, 'Daemon started but hasn\'t become ready yet'),
    React.createElement('div', { className: 'text-ctp-subtext0 text-xs max-w-sm' },
      'This can take a while on a large instance. Still watching — this will update on its own once it\'s ready.'),
    logPathHint ? React.createElement('div', {
      className: 'text-ctp-subtext0 text-xs max-w-md truncate',
      title: logPathHint,
    }, `Log: ${logPathHint}`) : null,
    stderr ? React.createElement('div', {
      className: 'text-ctp-subtext0 text-xs max-w-md truncate',
      title: stderr,
    }, truncate(stderr, 200)) : null,
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

/**
 * M30 (#1882) — `run.durationMillis` is the run's TOTAL elapsed time, not
 * time-in-current-step; rendering it next to `currentStage` unlabeled read
 * as "this run is Ns old", which is misleading for a run that's been going
 * for a while but just entered a new stage. Prefer the matching
 * `activeStages[]` entry's own `startedAt` when one exists (that's the
 * in-step clock); fall back to total run duration, explicitly labeled, when
 * it doesn't (e.g. no `activeStages` on this wire version).
 */
function currentStepElapsedLabel(run: RunSummary): string {
  const activeStage = run.activeStages?.find((s) => s.name === run.currentStage);
  return activeStage
    ? `${formatElapsedSince(activeStage.startedAt)} in step`
    : `${formatDurationMillis(run.durationMillis)} total`;
}

function RunRow({ run }: { run: RunSummary }) {
  const op = run.operator;
  return React.createElement('div', {
    className: 'flex flex-col gap-0.5 px-3 py-2 border-b border-ctp-overlay0/30',
    'data-testid': 'goobers-run-row',
  },
    React.createElement('div', { className: 'flex items-center justify-between gap-2 text-xs' },
      React.createElement('span', { className: 'font-medium text-ctp-text truncate', title: run.workflow }, truncate(run.workflow, 40)),
      React.createElement('span', { className: 'text-ctp-subtext0 shrink-0' }, `gaggle: ${truncate(run.gaggle, 24)}`),
    ),
    React.createElement('div', { className: 'flex items-center gap-2 text-[11px] text-ctp-subtext0' },
      run.currentStage ? React.createElement('span', null, `step: ${truncate(run.currentStage, 30)}`) : null,
      op?.issue ? React.createElement('span', null, `#${op.issue.number}`) : null,
      op?.pullRequest ? React.createElement('span', null, 'has PR') : null,
      React.createElement('span', null, currentStepElapsedLabel(run)),
      op?.heartbeatAgeMillis != null ? React.createElement('span', null, `heartbeat ${formatAgeMillis(op.heartbeatAgeMillis)} ago`) : null,
      run.stale ? React.createElement('span', { className: 'text-ctp-red' }, 'no heartbeat') : null,
      React.createElement('span', { className: 'shrink-0', title: run.id, 'data-testid': 'goobers-run-id' }, `run ${run.id.slice(0, 8)}`),
    ),
    op ? React.createElement(BlockersAndLimitations, { blockers: op.potentialBlockers, limitations: op.diagnosticsLimitations }) : null,
  );
}

/**
 * M24: the panel fetched `instance.warnings[]`, `.status`, `.maintenance`,
 * `.counts`, `.storageHealth`, and `health.freshness` every poll cycle and
 * discarded all of it behind a flat "nothing active" — the owner's actual
 * question ("what is my daemon doing, and why is it doing nothing?") went
 * unanswered. Each field below is independently optional; a daemon that
 * omits one must still render the others cleanly.
 */
function DaemonIdleDetail({ instance, health }: { instance: Instance | null; health: Health | null }) {
  const warnings = instance?.warnings ?? [];
  const maintenance = instance?.maintenance;
  const storageHealth = instance?.storageHealth;
  const counts = instance?.counts;
  const freshness = health?.freshness;

  return React.createElement('div', {
    // M33 (#1890): `overflow-y-auto` was inert without `min-h-0` — a flex
    // item defaults to `min-height: auto` and refuses to shrink below its
    // content height, so this box grew to fit every warning/footer row
    // instead of overflowing. `justify-center` is dropped too: centering a
    // scroll container splits overflow to both ends and makes the leading
    // (top) overflow unreachable once content exceeds the box — that would
    // have traded a lost bottom for a lost top. The "nothing active"
    // headline no longer gets vertical centering as a result; that's
    // accepted per the mission brief (a design call, not this fix's job).
    className: 'flex flex-col items-center flex-1 min-h-0 gap-1.5 text-ctp-subtext0 text-xs text-center px-6 overflow-y-auto',
    'data-testid': 'goobers-runs-empty',
  },
    React.createElement('span', null, describeIdleStatus(instance?.status)),
    warnings.length > 0 && React.createElement('ul', {
      className: 'list-none space-y-1',
      'data-testid': 'goobers-instance-warnings',
    }, warnings.map((w, i) => React.createElement('li', {
      key: `${w.code}:${w.scope ?? ''}:${i}`,
      className: 'flex flex-col items-center',
    },
      React.createElement('span', { className: w.severity === 'error' ? 'text-ctp-red' : 'text-ctp-yellow' }, `${w.code}: ${w.explanation}`),
      w.scope && React.createElement('span', {
        className: 'text-[10px] text-ctp-overlay0 font-mono truncate max-w-full',
        title: w.scope,
      }, truncate(w.scope, 70)),
    ))),
    storageHealth && React.createElement('span', {
      className: storageHealth.tier === 'healthy' ? 'text-ctp-overlay0' : 'text-ctp-red',
      'data-testid': 'goobers-storage-health',
    }, `Storage ${deslugPhase(storageHealth.tier)}: ${formatBytes(storageHealth.freeBytes)} free of ${formatBytes(storageHealth.totalBytes)} (critical floor ${formatBytes(storageHealth.criticalFloorBytes)})`),
    maintenance && React.createElement('div', {
      className: 'flex flex-col items-center gap-0.5 text-ctp-overlay0',
      'data-testid': 'goobers-maintenance',
    },
      React.createElement('span', null,
        `Maintenance: ${maintenance.kind} — ${maintenance.state}${maintenance.currentPhase ? ` (${deslugPhase(maintenance.currentPhase)})` : ''}`),
      maintenance.errorSummary ? React.createElement('span', { className: 'text-ctp-red' }, maintenance.errorSummary) : null,
    ),
    freshness && React.createElement('span', { 'data-testid': 'goobers-scheduler-freshness' },
      `Scheduler tick ${formatAgeMillis(freshness.lastTickAgeMillis)} ago`),
    counts && React.createElement('span', { 'data-testid': 'goobers-inventory-counts' },
      `${counts.gaggles} gaggle${counts.gaggles === 1 ? '' : 's'} · ${counts.goobers} goober${counts.goobers === 1 ? '' : 's'} · ${counts.workflows} workflow${counts.workflows === 1 ? '' : 's'}`),
  );
}

function ActiveRunsView({
  runs, hasMore, totalShown, instance, health,
}: {
  runs: RunSummary[];
  hasMore: boolean;
  totalShown: number;
  instance: Instance | null;
  health: Health | null;
}) {
  const activeRuns = instance?.concurrency.activeRuns ?? 0;
  const maxConcurrentRuns = instance?.concurrency.maxConcurrentRuns ?? 0;
  return React.createElement('div', { className: 'flex flex-col h-full w-full min-h-0', 'data-testid': 'goobers-active-runs' },
    React.createElement('div', { className: 'flex items-center justify-between px-3 py-1.5 text-[11px] text-ctp-subtext0 border-b border-ctp-overlay0/30' },
      React.createElement('span', null, `${activeRuns} / ${maxConcurrentRuns} slots`),
      hasMore ? React.createElement('span', null, `showing first ${totalShown} of many running`) : null,
    ),
    runs.length === 0
      ? React.createElement(DaemonIdleDetail, { instance, health })
      : React.createElement('div', { className: 'flex-1 min-h-0 overflow-y-auto' },
          runs.map((r) => React.createElement(RunRow, { key: r.id, run: r })),
        ),
  );
}

// ── Header ──────────────────────────────────────────────────────────────

function Header({
  kind, state, manageDaemon, freshness, configWarnings, onRefresh, onStart, onStop, onOpenSettings,
}: {
  kind: GoobersPanelStateKind;
  state: ReturnType<typeof useGoobersStore.getState>['state'];
  manageDaemon: boolean;
  freshness: GoobersFreshness;
  configWarnings: GoobersConfigWarnings;
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
      // §8.4 — freshness is its own indicator, never folded into the pill.
      // 'unknown' renders nothing: claiming "current" with no read model
      // would be a claim nobody made.
      freshness.label ? React.createElement('span', {
        className: `text-[10px] ${freshness.alert ? 'text-ctp-red' : 'text-ctp-subtext0'}`,
        'data-testid': 'goobers-freshness',
        'data-freshness': freshness.kind,
        title: freshness.detail ?? undefined,
      },
        freshness.alert ? '⚠ ' : '',
        freshness.label,
      ) : null,
      readState ? React.createElement('span', {
        className: 'text-[10px] text-ctp-subtext0',
        'data-testid': 'goobers-lag',
      }, `lag ${readState.lagSeconds.toFixed(1)}s`) : null,
      // §8.4 — config lint is informational. Never an alert, never a staleness
      // claim. Not a link: the warnings[] list only renders in the empty state,
      // so in MVP there is often nothing on screen to link to. The tooltip
      // carries the codes instead.
      configWarnings.label ? React.createElement('span', {
        className: 'text-[10px] text-ctp-subtext0',
        'data-testid': 'goobers-config-warnings',
        title: configWarnings.detail ?? undefined,
      }, configWarnings.label) : null,
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
    ? ['ready', 'scheduler-stalled', 'stream-reconnecting', 'polling-fallback', 'no-read-model'].includes(panelState.kind)
    : false;

  useEffect(() => {
    if (isDataView) {
      fetchRuns();
    }
  }, [isDataView, fetchRuns]);

  useEffect(() => {
    if (!isDataView) return;
    return window.clubhouse.goobers.onDataInvalidated((payload) => {
      if (isDataInvalidatedPayload(payload) && payload.models.includes('run')) {
        fetchRuns();
      }
    });
  }, [isDataView, fetchRuns]);

  const handleRefresh = useCallback(() => {
    loadState();
    if (isDataView) fetchRuns();
  }, [loadState, isDataView, fetchRuns]);

  const handleStart = useCallback(() => {
    window.clubhouse.goobers.daemonStart().then(() => loadState());
  }, [loadState]);

  const handleStop = useCallback(() => {
    window.clubhouse.goobers.daemonStop().then((raw) => {
      // The service already broadcasts state (including a stop-failed
      // connection:'error' snapshot) before this promise resolves, so
      // loadState() picks up the real outcome either way — but the result
      // itself must not be silently discarded here, since that was half of
      // what let a stop failure go unsurfaced (goobers-service.ts's
      // daemonStop() fix is the other half). The preload types this as
      // `Promise<unknown>`, matching every other goobers IPC call.
      const result = raw as { ok?: boolean; error?: string } | undefined;
      if (result && result.ok === false) {
        console.error('[goobers] daemonStop failed:', result.error);
      }
      loadState();
    });
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
    case 'recovering': {
      const recovery = panelState.raw.recovery;
      const checkEntries = recovery ? Object.entries(recovery.checks) : [];
      body = React.createElement('div', {
        className: 'flex flex-col items-center justify-center h-full w-full gap-2 text-ctp-subtext0 text-xs px-6',
        'data-testid': 'goobers-state-recovering',
      },
        React.createElement('span', null, 'Goobers is starting — completing required startup work before it accepts requests.'),
        recovery && React.createElement('span', { className: 'text-ctp-overlay0' }, describeStartupPhase(recovery.phase)),
        recovery && React.createElement('span', { className: 'text-ctp-overlay0' },
          `${deslugPhase(recovery.phase)} (${formatElapsedSince(recovery.since)} elapsed)`),
        checkEntries.length > 0 && React.createElement('ul', { className: 'text-ctp-overlay0 list-none space-y-0.5' },
          checkEntries.map(([name, done]) => React.createElement('li', { key: name }, `${done ? '✓' : '…'} ${name}`)),
        ),
      );
      break;
    }
    case 'start-failed':
      body = React.createElement(ErrorScreen, {
        title: 'Failed to start the daemon',
        detail: panelState.error?.message ?? 'see the daemon log for details',
        onRetry: handleStart,
        testId: 'goobers-state-start-failed',
      });
      break;
    case 'start-unknown':
      body = React.createElement(StartUnknownScreen, {
        stderr: panelState.error?.stderr,
        logPathHint: panelState.error?.logPathHint,
      });
      break;
    case 'stopping':
      body = React.createElement('div', {
        className: 'flex items-center justify-center h-full w-full text-ctp-subtext0 text-xs',
        'data-testid': 'goobers-state-stopping',
      }, 'Stopping — draining in-flight runs…');
      break;
    case 'stop-failed':
      body = React.createElement(ErrorScreen, {
        title: 'Failed to stop the daemon',
        detail: panelState.error?.message ?? 'see the daemon log for details',
        onRetry: handleStop,
        testId: 'goobers-state-stop-failed',
      });
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
    case 'scheduler-stalled':
    case 'stream-reconnecting':
    case 'polling-fallback':
    case 'no-read-model':
    case 'ready':
    default:
      body = React.createElement(React.Fragment, null,
        // §8.4 required "banner naming the specific degradation" and the old
        // blanket copy named none. Scheduler liveness only — it says nothing
        // about whether already-projected data is stale, so it no longer
        // claims that.
        kind === 'scheduler-stalled' ? React.createElement('div', {
          className: 'px-3 py-1 text-[11px] text-ctp-yellow bg-ctp-yellow/10 border-b border-ctp-yellow/20',
          'data-testid': 'goobers-scheduler-stalled-banner',
        }, `⚠ Scheduler has not ticked in ${formatAgeMillis(storeState?.daemon.lastTickAgeMillis ?? null)} — new runs may not be starting`) : null,
        // Data trust is independent of every kind above, so this banner is
        // driven by the freshness descriptor rather than by `kind`.
        panelState.freshness.alert ? React.createElement('div', {
          className: 'px-3 py-1 text-[11px] text-ctp-red bg-ctp-red/10 border-b border-ctp-red/20',
          'data-testid': 'goobers-freshness-banner',
        }, `⚠ ${panelState.freshness.label}${panelState.freshness.detail ? ` — ${panelState.freshness.detail}` : ''}`) : null,
        kind === 'stream-reconnecting' ? React.createElement('div', {
          className: 'px-3 py-1 text-[11px] text-ctp-yellow',
          'data-testid': 'goobers-reconnecting-banner',
        }, 'Reconnecting…') : null,
        kind === 'polling-fallback' ? React.createElement('div', {
          className: 'px-3 py-1 text-[11px] text-ctp-yellow',
          'data-testid': 'goobers-polling-banner',
        }, `Live updates unavailable — refreshing every ${GOOBERS_POLL_FALLBACK_INTERVAL_MS / 1000}s`) : null,
        kind === 'no-read-model' ? React.createElement('div', {
          className: 'px-3 py-1 text-[11px] text-ctp-yellow',
          'data-testid': 'goobers-no-read-model-banner',
        }, 'Reduced fidelity — read model unavailable') : null,
        React.createElement(ActiveRunsView, {
          runs,
          hasMore: runsHasMore,
          totalShown: runs.length,
          instance: storeState?.instance ?? null,
          health: storeState?.health ?? null,
        }),
      );
      break;
  }

  return React.createElement('div', { className: 'flex flex-col h-full w-full' },
    React.createElement(Header, {
      kind, state: storeState, manageDaemon,
      freshness: panelState.freshness, configWarnings: panelState.configWarnings,
      onRefresh: handleRefresh, onStart: handleStart, onStop: handleStop, onOpenSettings: handleOpenSettings,
    }),
    React.createElement('div', { className: 'flex-1 min-h-0 overflow-hidden' }, body),
  );
}

// Compile-time type assertion
const _: PluginModule = { activate, deactivate, MainPanel };
void _;
export type { GoobersPanelState };
