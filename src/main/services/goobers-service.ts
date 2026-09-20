/**
 * Goobers instance service — main-process connection + daemon control
 * (Phase 1 / M3, filling in the M1 skeleton's stubs).
 *
 * Idle-until-subscribed (spec §7.7): because experimental flags never reach
 * main, this service must not assume the plugin gates it. It does zero I/O —
 * no validation, no watcher, no poll — until `subscribe()` is called for the
 * first time. `subscribe()`/`release()` are reference-counted: popouts and
 * the main window can each subscribe independently.
 *
 * MVP (§12) uses 5s polling against 4 endpoints, not SSE — SSE lands in
 * Phase 2. Liveness detection (§7.4), defensive address parsing (§4.3), and
 * daemon start/stop (§7.5) live in sibling modules (`goobers-liveness.ts`,
 * `goobers-address.ts`, `goobers-daemon.ts`) that this service orchestrates.
 */
import * as fs from 'fs';
import * as path from 'path';
import { watch, type FSWatcher } from 'fs';
import { app, BrowserWindow } from 'electron';
import { GOOBERS_SETTINGS } from '../../shared/settings-definitions';
import { createManagedSettings, ManagedSettings } from './managed-settings';
import { getShellEnvironment } from '../util/shell';
import { probeLiveness } from './goobers-liveness';
import { parseAddressString } from './goobers-address';
import { readInstanceIdentitySummary } from './goobers-instance-identity';
import { startDaemon, stopDaemon, isLifecycleBusy, type StartResult, type StopResult } from './goobers-daemon';
import { httpGetJson, parseJsonBody, destroyAllRequests } from './goobers-http';
import { startEventStream, type EventStreamHandle, type StreamTerminalReason } from './goobers-event-stream';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import { IPC } from '../../shared/ipc-channels';
import { API_VERSION, type RunList, type TelemetryErrorsPage, type WorkItemPage, type EventList, type ModelInvalidation } from '../../shared/goobers-api-types';
import type { GoobersSettings } from '../../shared/types';
import type { GoobersConnectionState, GoobersDaemonStatus, RunListQuery } from '../../shared/goobers-types';

const RUNS_FETCH_TIMEOUT_MS = 10_000;

function buildRunListQueryString(query: RunListQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export interface GoobersErrorEnvelope {
  error: { code: string; message: string };
}

export interface RootValidationResult {
  ok: boolean;
  instanceId?: string;
  error?: { code: string; message: string };
}

const POLL_INTERVAL_MS = 5_000;
/**
 * Poll interval once the SSE invalidation feed is confirmed live (M26).
 * Deliberately not "stop polling" — SSE is a push signal *in addition to*
 * the poll, not a replacement for it (see `goobers-event-stream.ts`'s file
 * comment on why). Matches the stream's own liveness-watchdog deadline: if
 * the watchdog somehow fails to fire promptly, the panel still self-heals
 * within this same bound rather than sitting on an arbitrarily longer one.
 */
const SSE_WIDENED_POLL_INTERVAL_MS = 30_000;

/**
 * Coalescing window for SSE-triggered instance refreshes (M29). The daemon's
 * feed only ever carries `models: ['instance', ...]` in the opening
 * `snapshot` event — every steady-state `invalidate` is `['run','workflow']`
 * (see #1881) — but a run transition changes `instance.concurrency`/`counts`
 * by definition, so any invalidation is treated as instance-affecting rather
 * than trusting a tag the feed never repeats. Debounced so a burst of run
 * invalidations (several transitions within the same tick) triggers one
 * `refreshConnectionOnce()`, not one per event.
 */
const INSTANCE_REFRESH_DEBOUNCE_MS = 2_000;

const IDLE_DAEMON_STATUS: GoobersDaemonStatus = {
  state: 'unknown',
  address: null,
  pid: null,
  version: null,
  startedAt: null,
  lastTickAgeMillis: null,
  draining: false,
};

function makeIdleState(): GoobersConnectionState {
  return {
    configured: false,
    instanceRoot: null,
    rootIdentity: null,
    daemon: { ...IDLE_DAEMON_STATUS },
    connection: 'idle',
    stream: 'unavailable',
    instance: null,
    health: null,
    apiCompatible: true,
    lastError: null,
    lastUpdatedAt: new Date().toISOString(),
  };
}

function isAnyWindowVisible(): boolean {
  return BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isVisible() && !w.isMinimized());
}

/**
 * Validate a candidate instance root with **no network** (spec §4.2 steps 1-3).
 *
 * `.instance-id` (leading dot) is the durable root identity. `instance-id`
 * (no dot) is a *different* file — the runtime engine ID, mode 0600 — and
 * legitimately holds a different value. Conflating them is a bug (§4.2).
 */
export async function validateInstanceRoot(root: string): Promise<RootValidationResult> {
  const yamlPath = path.join(root, 'instance.yaml');
  const missingInstanceYamlMessage = `No 'instance.yaml' found in ${root} — not a Goobers instance root`;
  try {
    const stat = await fs.promises.stat(yamlPath);
    if (!stat.isFile()) {
      return { ok: false, error: { code: 'not-a-goobers-instance-root', message: missingInstanceYamlMessage } };
    }
  } catch {
    return { ok: false, error: { code: 'not-a-goobers-instance-root', message: missingInstanceYamlMessage } };
  }

  const decommissionedPath = path.join(root, '.instance-decommissioned');
  try {
    await fs.promises.stat(decommissionedPath);
    return { ok: false, error: { code: 'decommissioned-root', message: 'this is a decommissioned Goobers instance root' } };
  } catch {
    // Absent is the expected/healthy case — fall through.
  }

  // Intentionally `.instance-id`, never the sibling `instance-id` (no dot).
  const instanceIdPath = path.join(root, '.instance-id');
  try {
    const raw = await fs.promises.readFile(instanceIdPath, 'utf-8');
    const instanceId = raw.trim();
    if (!/^[0-9a-f]{32}$/.test(instanceId)) {
      return { ok: false, error: { code: 'invalid-instance-id', message: '.instance-id is not 32 lowercase hex characters' } };
    }
    return { ok: true, instanceId };
  } catch {
    return { ok: false, error: { code: 'instance-id-unreadable', message: 'could not read .instance-id' } };
  }
}

export interface BinaryResolution {
  resolved: string | null;
  error?: { code: string; message: string };
}

/** Error codes `resolveBinaryPath` can produce — used to tell a stale binary
 *  error apart from an unrelated one (e.g. an invalid root) when deciding
 *  whether to clear `lastError` after a re-resolution (see `onSettingsChanged`). */
const BINARY_ERROR_CODES = new Set(['binary-not-found', 'binary-not-executable']);

function isExecutableMode(mode: number): boolean {
  // Windows has no POSIX execute bit — fs.Stats.mode there is derived from
  // the read-only file attribute, never an execute concept, so `mode & 0o111`
  // is always 0 regardless of the file. Callers already gate on
  // `stat.isFile()` separately, so on win32 any regular file is
  // executable-enough here (mirrors how Node's own PATH-resolution tooling
  // treats it). This function is only reachable pre-activation via direct
  // calls to the exported `resolveBinaryPath`/`validateInstanceRoot` — the
  // win32 platform gate (§7.8) still governs whether the service itself
  // ever calls it.
  if (process.platform === 'win32') return true;

  // Any executable bit (owner/group/other) is good enough here — spawn()
  // will surface a real EACCES if this is wrong for the invoking user.
  return (mode & 0o111) !== 0;
}

/**
 * Resolve `binaryPath` per spec §4.1: absolute paths are stat'd directly;
 * bare names are resolved against the login-shell PATH (§2.7). Not-found is
 * a first-class result, never a thrown error.
 */
export async function resolveBinaryPath(binaryPath: string): Promise<BinaryResolution> {
  if (path.isAbsolute(binaryPath)) {
    try {
      const stat = await fs.promises.stat(binaryPath);
      if (!stat.isFile() || !isExecutableMode(stat.mode)) {
        return { resolved: null, error: { code: 'binary-not-executable', message: `${binaryPath} is not an executable file` } };
      }
      return { resolved: binaryPath };
    } catch {
      return { resolved: null, error: { code: 'binary-not-found', message: `${binaryPath} does not exist` } };
    }
  }

  const env = getShellEnvironment();
  const pathVar = env.PATH ?? '';
  const dirs = pathVar.split(path.delimiter).filter(Boolean);

  for (const dir of dirs) {
    const candidate = path.join(dir, binaryPath);
    try {
      const stat = await fs.promises.stat(candidate);
      if (stat.isFile() && isExecutableMode(stat.mode)) {
        return { resolved: candidate };
      }
    } catch {
      continue;
    }
  }

  return { resolved: null, error: { code: 'binary-not-found', message: `'${binaryPath}' was not found on PATH` } };
}

export class GoobersService {
  private subscriberCount = 0;
  private activated = false;
  private state: GoobersConnectionState = makeIdleState();
  private resolvedBinaryPath: string | null = null;
  private readonly settings: ManagedSettings<GoobersSettings>;
  private settingsRegistered = false;
  private lastKnownSettings: GoobersSettings | undefined;
  private reconcileCount = 0;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollIntervalMs = POLL_INTERVAL_MS;
  private addressWatcher: FSWatcher | null = null;
  private focusListenerRegistered = false;
  private teardownRegistered = false;
  private eventStreamHandle: EventStreamHandle | null = null;
  /** Set once the SSE stream hits a terminal condition (M26) — no further
   *  connection attempts for this handle's lifecycle. Cleared by
   *  `closeEventStream()`, called wherever the service already does a full
   *  poll/watcher reset (a fresh `establishConnection()` pass, or an
   *  instanceRoot change), giving each of those a fresh chance at SSE. */
  private eventStreamTerminal: StreamTerminalReason | null = null;
  /** M29 — debounce handle for `scheduleInstanceRefresh()`. Cleared by
   *  `closeEventStream()` so a pending refresh never fires after teardown,
   *  release, or a visibility-loss stop. */
  private instanceRefreshDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** True from a successful `daemon-stop` until liveness actually clears.
   *  `goobers down` exiting 0 does not mean stopped — the drain is
   *  unbounded, so we keep reporting `stopping`/`draining: true` even while
   *  the liveness probe still finds the API responding (§7.5). */
  private draining = false;

  /** Exposed for tests to prove `reconcile()` genuinely ran, rather than
   *  asserting only on `state`/call-count deltas that can be trivially true
   *  (e.g. unchanged at zero) whether or not activation ever happened. */
  get reconcileCountForTests(): number {
    return this.reconcileCount;
  }

  get isPollingForTests(): boolean {
    return this.pollTimer !== null;
  }

  get isWatchingAddressFileForTests(): boolean {
    return this.addressWatcher !== null;
  }

  get isEventStreamOpenForTests(): boolean {
    return this.eventStreamHandle !== null;
  }

  get eventStreamTerminalForTests(): StreamTerminalReason | null {
    return this.eventStreamTerminal;
  }

  get pollIntervalMsForTests(): number {
    return this.pollIntervalMs;
  }

  get isInstanceRefreshScheduledForTests(): boolean {
    return this.instanceRefreshDebounceTimer !== null;
  }

  constructor(settings?: ManagedSettings<GoobersSettings>) {
    this.settings = settings ?? createManagedSettings(GOOBERS_SETTINGS, {
      onSave: (next) => this.onSettingsChanged(next as GoobersSettings),
    });
  }

  /** `win32` is never activated (spec §7.8). Handlers must check this and
   *  return an `unsupported-platform` error envelope rather than throwing. */
  get isSupportedPlatform(): boolean {
    return process.platform !== 'win32';
  }

  /**
   * Register the settings IPC handlers. Called from `settings-handlers.ts`
   * at app startup — settings get/save must work even before the panel
   * ever subscribes (a future settings UI needs it immediately). Safe to
   * call multiple times: both this guard and `createManagedSettings`'s own
   * internal `registered` flag make the underlying `ipcMain.handle` and
   * `onSave` wiring happen exactly once no matter how many call sites hit
   * this (spec addendum — registerSettings() is called from both
   * `settings-handlers.ts` at startup and from `activate()` here).
   */
  registerSettings(): void {
    if (this.settingsRegistered) return;
    this.settingsRegistered = true;
    this.settings.register();
  }

  /**
   * Reference-counted activation gate (spec §7.7). The service performs zero
   * I/O until the first subscriber. Each popout and the main window call
   * this independently; the underlying work only happens once.
   */
  subscribe(): void {
    this.subscribeInternal(true);
  }

  /**
   * `attemptResume` is false only from `connect()`, which always follows
   * this immediately with its own authoritative `reconcile()` — letting
   * `resumeIfNeeded()` also fire there would race two `probeLiveness()`
   * calls against each other for no benefit.
   */
  private subscribeInternal(attemptResume: boolean): void {
    this.subscriberCount += 1;
    if (!this.activated && this.isSupportedPlatform) {
      this.activated = true;
      void this.activate();
    } else if (this.activated && attemptResume) {
      // M29: always attempt a resume, not just on the 0→1 edge. `release()`
      // is only ever called by tests — the renderer has no matching call for
      // `GET_STATE`'s `subscribe()` (every mount and every manual [refresh]
      // click calls it), so `subscriberCount` never returns to 0 in
      // production and the old `=== 1` guard fired exactly once, ever. After
      // that, the only way polling/SSE could resume once `canPollNow()` went
      // false (window minimized/hidden) was an Electron
      // `browser-window-focus` event, which isn't guaranteed on every
      // return-to-visible transition. `GET_STATE` is the one point we know a
      // window is actually asking for current data, so treat it as a resume
      // opportunity every time — `resumeIfNeeded()` is already a safe no-op
      // when nothing needs to happen (already polling, autoConnect off, or
      // still not pollable).
      this.resumeIfNeeded();
    }
  }

  /**
   * Releases one subscription. When the last subscriber releases, stop the
   * poll interval and close the `api.address` watcher (§7.7, §7.9) — a user
   * who never opts in should not have I/O running on their behalf.
   */
  release(): void {
    this.subscriberCount = Math.max(0, this.subscriberCount - 1);
    if (this.subscriberCount === 0) {
      this.stopPolling();
      this.closeAddressWatcher();
      this.closeEventStream();
    }
  }

  get subscriberCountForTests(): number {
    return this.subscriberCount;
  }

  /** Zero-I/O snapshot read — safe to call before or after activation. */
  getState(): GoobersConnectionState {
    return this.state;
  }

  private async activate(): Promise<void> {
    this.registerSettings();
    this.registerFocusListener();
    this.registerTeardown();
    this.lastKnownSettings = this.settings.getSettings();
    await this.reconcile(this.lastKnownSettings);
  }

  private registerFocusListener(): void {
    if (this.focusListenerRegistered) return;
    this.focusListenerRegistered = true;
    try {
      app.on('browser-window-focus', () => this.resumeIfNeeded());
    } catch {
      // app may not be available in a test harness that constructs the
      // service without a running Electron app — non-fatal, polling simply
      // won't auto-resume on focus in that environment.
    }
  }

  private registerTeardown(): void {
    if (this.teardownRegistered) return;
    this.teardownRegistered = true;
    try {
      app.on('before-quit', () => this.teardown());
    } catch {
      // See registerFocusListener — best-effort outside a real Electron app.
    }
  }

  /** Spec §7.9 — clear the poll interval, close the watcher, abort in-flight
   *  requests. Never touches the daemon, including one this app started and
   *  including one mid-drain (D12). */
  teardown(): void {
    this.stopPolling();
    this.closeAddressWatcher();
    this.closeEventStream();
    destroyAllRequests();
  }

  private canPollNow(): boolean {
    return this.subscriberCount > 0 && isAnyWindowVisible();
  }

  /**
   * Whether a daemon in this state should be tracked by polling rather than
   * the one-shot `api.address` watcher. `not-running` is the only state with
   * nothing alive to poll — every other state (`starting`, `unknown`,
   * `stopping`, `running`, and M20's `recovering`, which is `starting` with
   * `lastError.code === 'recovering'`) already has an address file on disk,
   * so a poll is meaningful and, per `afterPollTick`'s existing comment, the
   * file-watch event for that address file already fired once and will not
   * fire again. Keeping this the single source of truth for the decision
   * (used at initial connect, on focus/subscribe resume, and when the
   * watcher itself fires) closes the M21 race: a `fs.watch` armed after
   * `api.address` already exists never gets a second chance to notice it.
   */
  private shouldPoll(daemonState: GoobersDaemonStatus['state']): boolean {
    return daemonState !== 'not-running';
  }

  private resumeIfNeeded(): void {
    if (!this.activated || !this.lastKnownSettings?.autoConnect) return;
    if (!this.canPollNow()) return;
    if (this.pollTimer) return; // already polling

    if (this.shouldPoll(this.state.daemon.state)) {
      const settings = this.lastKnownSettings;
      void this.refreshConnectionOnce(settings).then(() => {
        // §8.4/§10.1 — don't resume into an immediate 401 loop.
        if (this.state.lastError?.code === 'auth-required') return;
        this.startPolling(settings);
      });
    } else if (!this.addressWatcher) {
      // Not currently watching (e.g. we were suspended entirely) — re-arm.
      this.watchAddressFile(this.lastKnownSettings.instanceRoot);
    }
  }

  private startPolling(settings: GoobersSettings): void {
    if (this.pollTimer) return;
    if (!this.canPollNow()) return;
    this.pollTimer = setInterval(() => {
      void this.refreshConnectionOnce(settings).then(() => this.afterPollTick(settings));
    }, this.pollIntervalMs);
  }

  /**
   * Widen/narrow the active poll cadence (M26) — `setInterval`'s period is
   * fixed once created, so changing it means recreating the timer. A no-op
   * if the interval isn't actually changing or nothing is currently
   * polling (the new value still takes effect the next time polling starts).
   */
  private setPollInterval(ms: number, settings: GoobersSettings): void {
    if (this.pollIntervalMs === ms) return;
    this.pollIntervalMs = ms;
    if (!this.pollTimer) return;
    this.stopPolling();
    this.startPolling(settings);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private afterPollTick(settings: GoobersSettings): void {
    if (!this.canPollNow()) {
      this.stopPolling();
      this.closeEventStream();
      return;
    }
    if (this.state.lastError?.code === 'auth-required') {
      // §8.4/§10.1 — a 401 showed up mid-poll (e.g. auth got enabled on the
      // daemon between ticks). Stop retrying in a loop and hold; broadcast
      // once so the renderer switches to the auth-required screen. SSE would
      // fail the identical way (M26) — stop it too rather than let it spin.
      this.stopPolling();
      this.closeEventStream();
      broadcastToAllWindows(IPC.GOOBERS.STATE_CHANGED, this.state);
      return;
    }
    if (this.state.daemon.state === 'not-running') {
      // Daemon disappeared between ticks (address file genuinely gone) —
      // stop polling, resume watching for the address file to reappear.
      // Deliberately narrower than "!== 'running'": 'starting'/'unknown'
      // are still-alive transitional states (§7.5 — includes the M17
      // post-timeout case) where the address file already exists and won't
      // fire the fs.watch callback again, so falling back to file-watching
      // here would silently stop observation. Only a true absence should
      // hand off to the watcher.
      this.stopPolling();
      this.closeEventStream(); // M26 — nothing to stream from once not-running
      this.watchAddressFile(settings.instanceRoot);
    }
    broadcastToAllWindows(IPC.GOOBERS.STATE_CHANGED, this.state);
    broadcastToAllWindows(IPC.GOOBERS.DATA_INVALIDATED, { models: ['instance', 'run'] });
  }

  private watchAddressFile(root: string): void {
    if (this.addressWatcher) return;
    if (!this.canPollNow()) return; // §7.7 — no watcher for an unsubscribed/hidden panel
    // `scheduler/` is created by `goobers` as part of instance state and is
    // expected to already exist on any initialized root (it holds up.lock,
    // events.jsonl, etc. even while the daemon is down) — fs.watch requires
    // the directory to exist. If it's genuinely absent (never-initialized
    // root), we fall back to polling on the next subscribe/focus resume
    // rather than watching, since there is nothing to attach a watcher to.
    const schedulerDir = path.join(root, 'scheduler');
    try {
      const watcher = watch(schedulerDir, (_eventType, filename) => {
        if (String(filename) !== 'api.address') return;
        void this.onAddressFileChanged();
      });
      watcher.on('error', () => {
        // e.g. the scheduler dir doesn't exist yet — nothing to watch until
        // the daemon (or its first start) creates it.
      });
      this.addressWatcher = watcher;
    } catch {
      // Same as above — the directory may not exist yet.
    }
  }

  private closeAddressWatcher(): void {
    if (this.addressWatcher) {
      this.addressWatcher.close();
      this.addressWatcher = null;
    }
  }

  /** Closes the SSE handle if one is open and clears the terminal flag, so
   *  whoever calls this (always alongside a full `stopPolling()` +
   *  `closeAddressWatcher()` reset) gets a fresh chance at SSE on the next
   *  successful connection. */
  private closeEventStream(): void {
    this.eventStreamHandle?.close();
    this.eventStreamHandle = null;
    this.eventStreamTerminal = null;
    if (this.instanceRefreshDebounceTimer) {
      clearTimeout(this.instanceRefreshDebounceTimer);
      this.instanceRefreshDebounceTimer = null;
    }
  }

  /**
   * Debounced instance refresh (M29), fired from `onInvalidation` for every
   * invalidation regardless of `models` — see `INSTANCE_REFRESH_DEBOUNCE_MS`.
   * Re-checks `canPollNow()` when the timer actually fires, not just when it
   * was scheduled, so a visibility/subscriber change during the debounce
   * window is still respected (§7.7/§7.9 — no I/O for an unsubscribed or
   * hidden panel).
   */
  private scheduleInstanceRefresh(settings: GoobersSettings): void {
    if (this.instanceRefreshDebounceTimer) return; // already scheduled
    this.instanceRefreshDebounceTimer = setTimeout(() => {
      this.instanceRefreshDebounceTimer = null;
      if (!this.canPollNow()) return;
      void this.refreshConnectionOnce(settings);
    }, INSTANCE_REFRESH_DEBOUNCE_MS);
  }

  /**
   * Starts the SSE invalidation feed (M26) once the daemon is confirmed
   * `running` — never earlier. `RouteEvents` is not `RecoverySafe`
   * (`apicontract/contract.go:483`), so attempting it against a still-
   * recovering daemon is a guaranteed wasted round-trip; M21 already has us
   * polling correctly through `starting`/`unknown`/`recovering`, so there is
   * nothing to gain by racing the daemon's own readiness.
   *
   * Idempotent — safe to call on every successful poll tick, which is
   * exactly how it's invoked (from `refreshConnectionOnce`'s running-success
   * branch): does nothing if a stream is already open or this connection
   * lifecycle already hit a terminal condition.
   */
  private maybeStartEventStream(settings: GoobersSettings): void {
    if (!this.isSupportedPlatform) return;
    if (this.eventStreamHandle) return;
    if (this.eventStreamTerminal) return;
    if (!this.canPollNow()) return;
    if (this.state.daemon.state !== 'running' || !this.state.daemon.address) return;
    const address = parseAddressString(this.state.daemon.address);
    if (!address) return;

    this.eventStreamHandle = startEventStream(address.host, address.port, {
      onConnected: () => {
        this.setPollInterval(SSE_WIDENED_POLL_INTERVAL_MS, settings);
      },
      onInvalidation: (invalidation: ModelInvalidation) => {
        // M29 (#1881): the daemon's feed only ever carries 'instance' in the
        // opening snapshot event — every steady-state invalidate is
        // ['run','workflow'], so `models.includes('instance')` was dead here
        // after connect. A run transition changes
        // instance.concurrency/counts by definition, so treat every
        // invalidation as instance-affecting rather than trusting a model
        // tag the feed never repeats.
        this.scheduleInstanceRefresh(settings);
        broadcastToAllWindows(IPC.GOOBERS.DATA_INVALIDATED, {
          models: invalidation.models,
          runIds: invalidation.runIds,
        });
      },
      onRefetchRequired: () => {
        // 409 epoch_changed/feed_truncated/stale_cursor — the server's own
        // instruction is "refetch current read endpoints." We don't know
        // exactly what changed, so refetch broadly rather than guess.
        void this.refreshConnectionOnce(settings);
        broadcastToAllWindows(IPC.GOOBERS.DATA_INVALIDATED, { models: ['instance', 'run'] });
      },
      onDisconnected: () => {
        this.setPollInterval(POLL_INTERVAL_MS, settings);
      },
      onTerminal: (reason) => {
        this.eventStreamTerminal = reason;
        this.eventStreamHandle = null;
        this.setPollInterval(POLL_INTERVAL_MS, settings);
      },
    });
  }

  private async onAddressFileChanged(): Promise<void> {
    if (!this.lastKnownSettings) return;
    const settings = this.lastKnownSettings;
    await this.refreshConnectionOnce(settings);
    if (this.shouldPoll(this.state.daemon.state)) {
      // The address file exists now — no need to keep watching for it —
      // regardless of whether we can actually poll it (§8.4/§10.1: a 401
      // still means "running", just not readable). This also covers the
      // M21 case where the very first probe after the file appears lands on
      // `starting`/`unknown` rather than `running` — that event already
      // fired and won't fire again, so the watcher must hand off to polling
      // now rather than wait for a change that isn't coming.
      this.closeAddressWatcher();
      if (this.state.lastError?.code !== 'auth-required') {
        this.startPolling(settings);
      }
    }
    broadcastToAllWindows(IPC.GOOBERS.STATE_CHANGED, this.state);
  }

  /**
   * Run the liveness probe once and fold the result into `state`. `fallbackError`
   * is shown only when the probe itself found nothing wrong but some other
   * concern (e.g. an unresolved binaryPath) still applies — an unresolvable
   * binaryPath must never block monitoring of an already-running daemon (§4.1).
   */
  private async refreshConnectionOnce(
    settings: GoobersSettings,
    fallbackError: { code: string; message: string } | null = null,
  ): Promise<void> {
    if (!settings.instanceRoot) return;
    const snapshot = await probeLiveness(settings.instanceRoot);
    const now = new Date().toISOString();

    if (this.draining) {
      if (snapshot.daemon.state === 'running') {
        // Still up — the drain is unbounded, keep showing it as such.
        this.state = {
          ...this.state,
          connection: 'connected',
          stream: 'polling',
          daemon: { ...snapshot.daemon, state: 'stopping', draining: true },
          lastError: null,
          recovery: null,
          lastUpdatedAt: now,
        };
        return;
      }
      // Liveness genuinely cleared — the drain finished.
      this.draining = false;
    }

    if (snapshot.error) {
      this.state = {
        ...this.state,
        // M20 — 'recovering' self-heals via the normal poll loop, exactly
        // like the M17 daemon-start-unknown case; unlike auth-required it
        // must never be treated as a terminal hold (see afterPollTick).
        connection: 'error',
        stream: 'unavailable',
        daemon: snapshot.daemon,
        lastError: snapshot.error,
        recovery: snapshot.recovery ?? null,
        lastUpdatedAt: now,
      };
      return;
    }

    if (snapshot.daemon.state !== 'running') {
      this.state = {
        ...this.state,
        connection: 'idle',
        stream: 'unavailable',
        daemon: snapshot.daemon,
        instance: null,
        health: null,
        lastError: fallbackError,
        recovery: null,
        lastUpdatedAt: now,
      };
      return;
    }

    const apiCompatible = snapshot.health ? snapshot.health.apiVersion === API_VERSION : this.state.apiCompatible;

    this.state = {
      ...this.state,
      connection: snapshot.degraded ? 'degraded' : 'connected',
      stream: 'polling',
      daemon: snapshot.daemon,
      instance: snapshot.instance,
      health: snapshot.health,
      apiCompatible,
      lastError: snapshot.degraded ? { code: 'degraded', message: 'scheduler not ticking' } : fallbackError,
      recovery: null,
      lastUpdatedAt: now,
    };
    this.maybeStartEventStream(settings);
  }

  /** Spec §7.1 startup sequence, run whenever the configured root/binary are
   *  valid and `autoConnect` is true. */
  private async establishConnection(
    settings: GoobersSettings,
    fallbackError: { code: string; message: string } | null,
  ): Promise<void> {
    this.stopPolling();
    this.closeAddressWatcher();
    this.closeEventStream();

    if (!settings.autoConnect) {
      this.state = { ...this.state, connection: 'idle', stream: 'unavailable', lastError: fallbackError ?? this.state.lastError };
      return;
    }

    await this.refreshConnectionOnce(settings, fallbackError);

    if (this.state.lastError?.code === 'auth-required') {
      // §8.4/§10.1 — do not retry a 401 in a loop; a credential is not
      // something we can acquire this phase. Hold here: no poll, no
      // watcher. Daemon control is untouched by this (it's a CLI spawn,
      // not an authenticated API call) and stays available.
      return;
    }

    if (this.shouldPoll(this.state.daemon.state)) {
      this.startPolling(settings);
    } else {
      this.watchAddressFile(settings.instanceRoot);
    }
  }

  /**
   * Every exit path below mutates `this.state`. `getState()` is a
   * fire-and-forget-triggered snapshot (`goobers:get-state` calls
   * `subscribe()` then immediately reads `this.state` synchronously, before
   * this async method has a chance to settle it), so the very first read a
   * renderer gets is always the pre-reconcile idle default. The try/finally
   * broadcast here is what corrects that — without it, nothing ever tells a
   * subscribed renderer that reconciliation finished (M12: the panel showed
   * "Not configured" indefinitely on first open despite a valid saved root,
   * because none of these branches broadcast on their own).
   */
  private async reconcile(settings: GoobersSettings): Promise<void> {
    this.reconcileCount += 1;
    try {
      if (!this.isSupportedPlatform) {
        this.state = {
          ...makeIdleState(),
          lastError: { code: 'unsupported-platform', message: 'Goobers is not supported on this platform' },
          connection: 'error',
        };
        return;
      }

      if (!settings.instanceRoot) {
        this.stopPolling();
        this.closeAddressWatcher();
        this.closeEventStream();
        this.state = { ...makeIdleState(), configured: false };
        this.resolvedBinaryPath = null;
        return;
      }

      const [rootResult, binaryResult] = await Promise.all([
        validateInstanceRoot(settings.instanceRoot),
        resolveBinaryPath(settings.binaryPath),
      ]);

      this.resolvedBinaryPath = binaryResult.resolved;

      if (!rootResult.ok) {
        this.stopPolling();
        this.closeAddressWatcher();
        this.closeEventStream();
        this.state = {
          ...makeIdleState(),
          configured: true,
          instanceRoot: settings.instanceRoot,
          connection: 'error',
          lastError: rootResult.error ?? { code: 'invalid-root', message: 'invalid Goobers instance root' },
        };
        return;
      }

      // Optional, defensive (§9.2) — config/manifest.yaml isn't in §14.2's
      // file list, so this is display-only and never blocks validation on
      // failure.
      const identitySummary = await readInstanceIdentitySummary(settings.instanceRoot);

      this.state = {
        ...makeIdleState(),
        configured: true,
        instanceRoot: settings.instanceRoot,
        rootIdentity: rootResult.instanceId ?? null,
        instanceName: identitySummary?.name ?? null,
        instanceEnvironment: identitySummary?.environment ?? null,
        connection: 'idle',
        daemon: { ...IDLE_DAEMON_STATUS, state: 'unknown' },
        lastError: binaryResult.error ?? null,
      };

      await this.establishConnection(settings, binaryResult.error ?? null);
    } finally {
      broadcastToAllWindows(IPC.GOOBERS.STATE_CHANGED, this.state);
    }
  }

  /**
   * Settings-change reaction table (spec §4.1 "Settings changes at runtime").
   */
  private onSettingsChanged(next: GoobersSettings): void {
    const prev = this.lastKnownSettings;
    this.lastKnownSettings = next;

    if (!this.activated) return; // Still idle — nothing subscribed yet.

    if (!prev || next.instanceRoot !== prev.instanceRoot) {
      // Disconnect and drop every cached Instance/Health/run-implied field
      // before re-validating — never show the previous root's data under
      // the new root's identity (§9.1).
      this.stopPolling();
      this.closeAddressWatcher();
      this.closeEventStream();
      this.draining = false;
      this.state = { ...makeIdleState(), configured: !!next.instanceRoot };
      this.resolvedBinaryPath = null;
      void this.reconcile(next);
      return;
    }

    if (next.binaryPath !== prev.binaryPath) {
      void resolveBinaryPath(next.binaryPath).then((result) => {
        this.resolvedBinaryPath = result.resolved;
        // An unrelated error (e.g. an invalid root) is more fundamental than
        // binaryPath and must survive regardless of the new resolution result
        // — this branch only runs when instanceRoot is unchanged (see the
        // early return above), so a root error can still be current and a
        // binaryPath edit must not paper over or replace it. Otherwise the
        // fresh resolution result is authoritative: null on success (never
        // leave a stale binary-not-found/not-executable error behind), or
        // the new binary error on failure.
        const currentIsUnrelatedError = !!this.state.lastError && !BINARY_ERROR_CODES.has(this.state.lastError.code);
        const lastError = currentIsUnrelatedError ? this.state.lastError : (result.error ?? null);
        this.state = { ...this.state, lastError };
        broadcastToAllWindows(IPC.GOOBERS.STATE_CHANGED, this.state);
      });
    }

    if (next.autoConnect !== prev.autoConnect) {
      if (next.autoConnect) {
        void this.reconcile(next);
      } else {
        this.stopPolling();
        this.closeAddressWatcher();
        this.closeEventStream();
        this.state = { ...this.state, connection: 'idle', stream: 'unavailable' };
      }
    }

    // manageDaemon only gates the renderer's Start/Stop affordance and the
    // daemon-start/daemon-stop IPC handlers below — a drain already in
    // progress keeps being tracked in main regardless (§4.1): we did not
    // stop observing reality just because the button went away.
  }

  /** `runId`/`gaggle`/`workflow`/`stage`-scoped history reads are Phase 2
   *  (§12). This returns the not-implemented envelope until then. */
  notImplemented(): GoobersErrorEnvelope {
    return { error: { code: 'not-implemented', message: 'not implemented until Phase 2' } };
  }

  unsupportedPlatform(): GoobersErrorEnvelope {
    return { error: { code: 'unsupported-platform', message: 'Goobers is not supported on this platform' } };
  }

  /** Idempotent — spec §6.1. Ensures activation and re-runs the full §7.1
   *  connection sequence against the currently configured root. */
  async connect(): Promise<GoobersConnectionState | GoobersErrorEnvelope> {
    if (!this.isSupportedPlatform) return this.unsupportedPlatform();
    this.subscribeInternal(false); // reconcile() below is the authoritative refresh
    this.lastKnownSettings = this.settings.getSettings();
    await this.reconcile(this.lastKnownSettings);
    return this.state;
  }

  /** Spec §7.9 — closes the poll loop/watcher and clears in-flight requests.
   *  Never touches the daemon itself (D12). */
  disconnect(): void | GoobersErrorEnvelope {
    if (!this.isSupportedPlatform) return this.unsupportedPlatform();
    this.stopPolling();
    this.closeAddressWatcher();
    this.closeEventStream();
    destroyAllRequests();
    this.state = { ...this.state, connection: 'idle', stream: 'unavailable' };
  }

  getBinaryPathForTests(): string | null {
    return this.resolvedBinaryPath;
  }

  /**
   * `goobers:list-runs` (§6.1/§8.7) — passthrough to `GET /api/v1/runs`
   * against the currently connected daemon. No caching layer (§7.3/§7.6
   * only caches Instance/Health) — the active-runs view wants a live read
   * on every invoke, and the 5s poll tick separately drives its
   * `data-invalidated` broadcast so the renderer knows when to re-call this.
   */
  async listRuns(query: RunListQuery = {}): Promise<RunList | GoobersErrorEnvelope> {
    if (!this.isSupportedPlatform) return this.unsupportedPlatform();
    if (this.state.daemon.state !== 'running' || !this.state.daemon.address) {
      return { error: { code: 'daemon-not-running', message: 'Goobers daemon is not running' } };
    }
    const parsed = parseAddressString(this.state.daemon.address);
    if (!parsed) {
      return { error: { code: 'invalid-address', message: 'could not parse the daemon address' } };
    }

    try {
      const res = await httpGetJson(parsed.host, parsed.port, `/api/v1/runs${buildRunListQueryString(query)}`, RUNS_FETCH_TIMEOUT_MS);
      if (res.status !== 200) {
        return { error: { code: 'runs-fetch-failed', message: `GET /api/v1/runs returned ${res.status}` } };
      }
      const body = parseJsonBody<RunList>(res.body);
      if (!body) {
        return { error: { code: 'runs-fetch-failed', message: 'GET /api/v1/runs returned an unparseable body' } };
      }
      return body;
    } catch (err) {
      return { error: { code: 'runs-fetch-failed', message: err instanceof Error ? err.message : String(err) } };
    }
  }

  /** Shared preflight for the read-only passthroughs below — same
   *  daemon-running/address-parse checks `listRuns` inlines, factored out
   *  since M25 adds three more call sites for it. */
  private resolveRunningDaemonAddress(): { host: string; port: number } | GoobersErrorEnvelope {
    if (this.state.daemon.state !== 'running' || !this.state.daemon.address) {
      return { error: { code: 'daemon-not-running', message: 'Goobers daemon is not running' } };
    }
    const parsed = parseAddressString(this.state.daemon.address);
    if (!parsed) {
      return { error: { code: 'invalid-address', message: 'could not parse the daemon address' } };
    }
    return parsed;
  }

  /**
   * `goobers:telemetry-errors` (M25) — passthrough to
   * `GET /api/v1/telemetry/errors`. No query params yet (the upstream
   * `TelemetryErrorsOptions` filters are not wired up here — nothing in the
   * panel needs them until M26's UI); add them when a consumer does.
   */
  async telemetryErrors(): Promise<TelemetryErrorsPage | GoobersErrorEnvelope> {
    if (!this.isSupportedPlatform) return this.unsupportedPlatform();
    const address = this.resolveRunningDaemonAddress();
    if ('error' in address) return address;

    try {
      const res = await httpGetJson(address.host, address.port, '/api/v1/telemetry/errors', RUNS_FETCH_TIMEOUT_MS);
      if (res.status !== 200) {
        return { error: { code: 'telemetry-errors-fetch-failed', message: `GET /api/v1/telemetry/errors returned ${res.status}` } };
      }
      const body = parseJsonBody<TelemetryErrorsPage>(res.body);
      if (!body) {
        return { error: { code: 'telemetry-errors-fetch-failed', message: 'GET /api/v1/telemetry/errors returned an unparseable body' } };
      }
      return body;
    } catch (err) {
      return { error: { code: 'telemetry-errors-fetch-failed', message: err instanceof Error ? err.message : String(err) } };
    }
  }

  /**
   * `goobers:work-items` (M25) — passthrough to `GET /api/v1/work-items`.
   * No query params yet, same reasoning as `telemetryErrors()`.
   */
  async workItems(): Promise<WorkItemPage | GoobersErrorEnvelope> {
    if (!this.isSupportedPlatform) return this.unsupportedPlatform();
    const address = this.resolveRunningDaemonAddress();
    if ('error' in address) return address;

    try {
      const res = await httpGetJson(address.host, address.port, '/api/v1/work-items', RUNS_FETCH_TIMEOUT_MS);
      if (res.status !== 200) {
        return { error: { code: 'work-items-fetch-failed', message: `GET /api/v1/work-items returned ${res.status}` } };
      }
      const body = parseJsonBody<WorkItemPage>(res.body);
      if (!body) {
        return { error: { code: 'work-items-fetch-failed', message: 'GET /api/v1/work-items returned an unparseable body' } };
      }
      return body;
    } catch (err) {
      return { error: { code: 'work-items-fetch-failed', message: err instanceof Error ? err.message : String(err) } };
    }
  }

  /**
   * `goobers:get-run-events` (M25) — passthrough to
   * `GET /api/v1/runs/{run}/events`. `cursor`/`limit` are accepted by the
   * existing IPC signature but deliberately not forwarded: the daemon's own
   * handler (`internal/httpapi/router.go`, `RouteRunEvents`) calls
   * `reader.RunEvents(ctx, run)` with no pagination params at all — the
   * upstream client (`portal/src/api/types.ts`'s `listRunEvents`) doesn't
   * pass them either. Our IPC surface is ahead of what the daemon supports
   * here; flagged in the PR rather than silently dropped.
   */
  async getRunEvents(runId: string): Promise<EventList | GoobersErrorEnvelope> {
    if (!this.isSupportedPlatform) return this.unsupportedPlatform();
    const address = this.resolveRunningDaemonAddress();
    if ('error' in address) return address;

    try {
      const res = await httpGetJson(address.host, address.port, `/api/v1/runs/${encodeURIComponent(runId)}/events`, RUNS_FETCH_TIMEOUT_MS);
      if (res.status !== 200) {
        return { error: { code: 'run-events-fetch-failed', message: `GET /api/v1/runs/${runId}/events returned ${res.status}` } };
      }
      const body = parseJsonBody<EventList>(res.body);
      if (!body) {
        return { error: { code: 'run-events-fetch-failed', message: 'GET /api/v1/runs/{run}/events returned an unparseable body' } };
      }
      return body;
    } catch (err) {
      return { error: { code: 'run-events-fetch-failed', message: err instanceof Error ? err.message : String(err) } };
    }
  }

  /**
   * `goobers:daemon-status` — a fresh liveness probe against the currently
   * configured root (§7.4), independent of the poll cadence.
   */
  async daemonStatus(): Promise<GoobersDaemonStatus | GoobersErrorEnvelope> {
    if (!this.isSupportedPlatform) return this.unsupportedPlatform();
    const settings = this.lastKnownSettings ?? this.settings.getSettings();
    if (!settings.instanceRoot) return { ...IDLE_DAEMON_STATUS };
    const snapshot = await probeLiveness(settings.instanceRoot);
    return snapshot.daemon;
  }

  /**
   * `goobers:daemon-start` (§7.5). Gated on `manageDaemon`; requires a
   * resolved `binaryPath`. Reentrancy/lock-contention handling lives in
   * `goobers-daemon.ts`; this just wires the service's known root/binary
   * and folds the observed result back into `state`.
   */
  async daemonStart(): Promise<{ ok: boolean; error?: string; holderKind?: 'daemon' | 'manual'; outcome?: 'unknown' }> {
    if (!this.isSupportedPlatform) return { ok: false, error: 'unsupported-platform' };
    if (isLifecycleBusy()) return { ok: false, error: 'lifecycle-busy' };

    const settings = this.lastKnownSettings ?? this.settings.getSettings();
    if (!settings.manageDaemon) return { ok: false, error: 'daemon-control-disabled' };
    if (!settings.instanceRoot) return { ok: false, error: 'not-configured' };
    if (!this.resolvedBinaryPath) return { ok: false, error: 'binary-not-found' };

    this.draining = false;
    this.state = { ...this.state, daemon: { ...this.state.daemon, state: 'starting' }, connection: 'connecting' };
    broadcastToAllWindows(IPC.GOOBERS.STATE_CHANGED, this.state);

    const result: StartResult = await startDaemon(settings.instanceRoot, this.resolvedBinaryPath);

    if (result.ok) {
      await this.refreshConnectionOnce(settings);
      // §8.4/§10.1 — do not start the poll into an immediate 401 loop.
      if (this.state.daemon.state === 'running' && this.state.lastError?.code !== 'auth-required') {
        this.startPolling(settings);
      }
      broadcastToAllWindows(IPC.GOOBERS.STATE_CHANGED, this.state);
      return { ok: true, holderKind: result.holderKind };
    }

    if (result.outcome === 'unknown') {
      // §7.5 — the child never exited, so this is NOT a start failure: it is
      // "started, not confirmed ready yet". Never surface daemon-start-failed
      // here (that reads as "press Start again", which is wrong against a
      // live daemon — lock contention). Keep polling so the panel
      // self-corrects to running the moment api.address/readyz/identity all
      // confirm, with no [refresh] from the user (M11-class seam: a poll
      // that never runs again is what leaves lastError stuck forever).
      this.state = {
        ...this.state,
        connection: 'connecting',
        daemon: { ...this.state.daemon, state: 'unknown' },
        lastError: {
          code: 'daemon-start-unknown',
          message: result.error ?? 'daemon started but has not become ready',
          stderr: result.stderr,
          logPathHint: result.logPathHint,
        },
      };
      broadcastToAllWindows(IPC.GOOBERS.STATE_CHANGED, this.state);
      if (!this.pollTimer) this.startPolling(settings);
      return { ok: false, error: result.error, outcome: 'unknown' };
    }

    this.state = {
      ...this.state,
      connection: 'error',
      daemon: { ...this.state.daemon, state: 'unknown' },
      lastError: { code: 'daemon-start-failed', message: result.error ?? 'failed to start the daemon' },
    };
    broadcastToAllWindows(IPC.GOOBERS.STATE_CHANGED, this.state);
    return { ok: false, error: result.error };
  }

  /**
   * `goobers:daemon-stop` (§7.5). Exit 0 from `goobers down` does not mean
   * stopped — enters `stopping`/`draining: true` and keeps polling liveness
   * (reusing the normal poll loop) until the API actually stops responding.
   */
  async daemonStop(): Promise<{ ok: boolean; error?: string; alreadyStopped?: boolean }> {
    if (!this.isSupportedPlatform) return { ok: false, error: 'unsupported-platform' };
    if (isLifecycleBusy()) return { ok: false, error: 'lifecycle-busy' };

    const settings = this.lastKnownSettings ?? this.settings.getSettings();
    if (!settings.manageDaemon) return { ok: false, error: 'daemon-control-disabled' };
    if (!settings.instanceRoot) return { ok: false, error: 'not-configured' };
    if (!this.resolvedBinaryPath) return { ok: false, error: 'binary-not-found' };

    const result: StopResult = await stopDaemon(settings.instanceRoot, this.resolvedBinaryPath);

    if (result.alreadyStopped) {
      await this.refreshConnectionOnce(settings);
      broadcastToAllWindows(IPC.GOOBERS.STATE_CHANGED, this.state);
      return { ok: true, alreadyStopped: true };
    }

    if (!result.ok) {
      // Mirror daemonStart()'s failure path (:752-759) — a genuine stop
      // failure must enter connection:'error' too, not just set lastError,
      // or panelState.ts's unknown-error fallback (gated on connection
      // being 'error') never fires and the failure is silently discarded.
      this.state = {
        ...this.state,
        connection: 'error',
        lastError: { code: 'daemon-stop-failed', message: result.error ?? 'failed to stop the daemon' },
      };
      broadcastToAllWindows(IPC.GOOBERS.STATE_CHANGED, this.state);
      return { ok: false, error: result.error };
    }

    // Stop-request accepted — the drain is unbounded. Keep tracking reality
    // via the normal poll loop until liveness actually clears (§7.5); a
    // `manageDaemon` toggle to false later must not stop this tracking.
    this.draining = true;
    this.state = {
      ...this.state,
      connection: 'connected',
      daemon: { ...this.state.daemon, state: 'stopping', draining: true },
    };
    broadcastToAllWindows(IPC.GOOBERS.STATE_CHANGED, this.state);
    if (!this.pollTimer) this.startPolling(settings);
    return { ok: true };
  }
}

export const goobersService = new GoobersService();
