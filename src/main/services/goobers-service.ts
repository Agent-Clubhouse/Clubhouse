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
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import { IPC } from '../../shared/ipc-channels';
import { API_VERSION, type RunList } from '../../shared/goobers-api-types';
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
  private addressWatcher: FSWatcher | null = null;
  private focusListenerRegistered = false;
  private teardownRegistered = false;
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
    this.subscriberCount += 1;
    if (!this.activated && this.isSupportedPlatform) {
      this.activated = true;
      void this.activate();
    } else if (this.activated && this.subscriberCount === 1) {
      // Resumed from zero subscribers (panel reopened) — refetch immediately
      // rather than waiting out a tick (§7.7).
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
    destroyAllRequests();
  }

  private canPollNow(): boolean {
    return this.subscriberCount > 0 && isAnyWindowVisible();
  }

  private resumeIfNeeded(): void {
    if (!this.activated || !this.lastKnownSettings?.autoConnect) return;
    if (!this.canPollNow()) return;
    if (this.pollTimer) return; // already polling

    if (this.state.daemon.state === 'running') {
      const settings = this.lastKnownSettings;
      void this.refreshConnectionOnce(settings).then(() => this.startPolling(settings));
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
    }, POLL_INTERVAL_MS);
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
      return;
    }
    if (this.state.daemon.state !== 'running') {
      // Daemon disappeared between ticks — stop polling, resume watching
      // for the address file to reappear.
      this.stopPolling();
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

  private async onAddressFileChanged(): Promise<void> {
    if (!this.lastKnownSettings) return;
    const settings = this.lastKnownSettings;
    await this.refreshConnectionOnce(settings);
    if (this.state.daemon.state === 'running') {
      this.closeAddressWatcher();
      this.startPolling(settings);
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
        connection: 'error',
        stream: 'unavailable',
        daemon: snapshot.daemon,
        lastError: snapshot.error,
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
      lastUpdatedAt: now,
    };
  }

  /** Spec §7.1 startup sequence, run whenever the configured root/binary are
   *  valid and `autoConnect` is true. */
  private async establishConnection(
    settings: GoobersSettings,
    fallbackError: { code: string; message: string } | null,
  ): Promise<void> {
    this.stopPolling();
    this.closeAddressWatcher();

    if (!settings.autoConnect) {
      this.state = { ...this.state, connection: 'idle', stream: 'unavailable', lastError: fallbackError ?? this.state.lastError };
      return;
    }

    await this.refreshConnectionOnce(settings, fallbackError);

    if (this.state.daemon.state === 'running') {
      this.startPolling(settings);
    } else {
      this.watchAddressFile(settings.instanceRoot);
    }
  }

  private async reconcile(settings: GoobersSettings): Promise<void> {
    this.reconcileCount += 1;
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
      this.state = {
        ...makeIdleState(),
        configured: true,
        instanceRoot: settings.instanceRoot,
        connection: 'error',
        lastError: rootResult.error ?? { code: 'invalid-root', message: 'invalid Goobers instance root' },
      };
      return;
    }

    // Optional, defensive (§9.2) — config/manifest.yaml isn't in §14.2's file
    // list, so this is display-only and never blocks validation on failure.
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
    this.subscribe();
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
  async daemonStart(): Promise<{ ok: boolean; error?: string; holderKind?: 'daemon' | 'manual' }> {
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
      if (this.state.daemon.state === 'running') this.startPolling(settings);
      broadcastToAllWindows(IPC.GOOBERS.STATE_CHANGED, this.state);
      return { ok: true, holderKind: result.holderKind };
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
      this.state = { ...this.state, lastError: { code: 'daemon-stop-failed', message: result.error ?? 'failed to stop the daemon' } };
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
