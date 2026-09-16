/**
 * Goobers instance service — main-process contract + skeleton (Phase 1 / M1).
 *
 * Scope of this stream: the state machine's *shape*, root validation, and
 * binaryPath resolution — all zero-network. Connect/daemon/SSE internals are
 * documented stubs for M3 (spec §7.1, §7.2, §7.4, §7.5).
 *
 * Idle-until-subscribed (spec §7.7): because experimental flags never reach
 * main, this service must not assume the plugin gates it. It does zero I/O —
 * no validation, no watcher, no poll — until `subscribe()` is called for the
 * first time. `subscribe()`/`release()` are reference-counted: popouts and
 * the main window can each subscribe independently.
 */
import * as fs from 'fs';
import * as path from 'path';
import { GOOBERS_SETTINGS } from '../../shared/settings-definitions';
import { createManagedSettings, ManagedSettings } from './managed-settings';
import { getShellEnvironment } from '../util/shell';
import type { GoobersSettings } from '../../shared/types';
import type { GoobersConnectionState, GoobersDaemonStatus } from '../../shared/goobers-types';

export interface GoobersErrorEnvelope {
  error: { code: string; message: string };
}

export interface RootValidationResult {
  ok: boolean;
  instanceId?: string;
  error?: { code: string; message: string };
}

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

/**
 * Validate a candidate instance root with **no network** (spec §4.2 steps 1-3).
 *
 * `.instance-id` (leading dot) is the durable root identity. `instance-id`
 * (no dot) is a *different* file — the runtime engine ID, mode 0600 — and
 * legitimately holds a different value. Conflating them is a bug (§4.2).
 */
export async function validateInstanceRoot(root: string): Promise<RootValidationResult> {
  const yamlPath = path.join(root, 'instance.yaml');
  try {
    const stat = await fs.promises.stat(yamlPath);
    if (!stat.isFile()) {
      return { ok: false, error: { code: 'not-a-goobers-instance-root', message: 'not a Goobers instance root' } };
    }
  } catch {
    return { ok: false, error: { code: 'not-a-goobers-instance-root', message: 'not a Goobers instance root' } };
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
   * call multiple times.
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
    }
  }

  /**
   * Releases one subscription. When the last subscriber releases, M3 will
   * stop the poll interval and close the `api.address` watcher (§7.7, §7.9).
   * M1 has neither yet, so this only tracks the count.
   */
  release(): void {
    this.subscriberCount = Math.max(0, this.subscriberCount - 1);
    // M3: stop poll interval / close api.address watcher when subscriberCount reaches 0.
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
    this.lastKnownSettings = this.settings.getSettings();
    await this.reconcile(this.lastKnownSettings);
  }

  private async reconcile(settings: GoobersSettings): Promise<void> {
    if (!this.isSupportedPlatform) {
      this.state = {
        ...makeIdleState(),
        lastError: { code: 'unsupported-platform', message: 'Goobers is not supported on this platform' },
        connection: 'error',
      };
      return;
    }

    if (!settings.instanceRoot) {
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
      this.state = {
        ...makeIdleState(),
        configured: true,
        instanceRoot: settings.instanceRoot,
        connection: 'error',
        lastError: rootResult.error ?? { code: 'invalid-root', message: 'invalid Goobers instance root' },
      };
      return;
    }

    this.state = {
      ...makeIdleState(),
      configured: true,
      instanceRoot: settings.instanceRoot,
      rootIdentity: rootResult.instanceId ?? null,
      connection: 'idle',
      daemon: { ...IDLE_DAEMON_STATUS, state: 'unknown' },
      lastError: binaryResult.error ?? null,
    };

    // M3: probe daemon liveness (§7.4), open SSE stream if autoConnect and
    // running (§7.1), watch <root>/scheduler/api.address if not running.
  }

  /**
   * Settings-change reaction table (spec §4.1 "Settings changes at runtime").
   * Only the network-free transitions are implemented here; connect/poll
   * transitions land with M3.
   */
  private onSettingsChanged(next: GoobersSettings): void {
    const prev = this.lastKnownSettings;
    this.lastKnownSettings = next;

    if (!this.activated) return; // Still idle — nothing subscribed yet.

    if (!prev || next.instanceRoot !== prev.instanceRoot) {
      // Never show the previous root's data under the new root's identity.
      void this.reconcile(next);
      return;
    }

    if (next.binaryPath !== prev.binaryPath) {
      void resolveBinaryPath(next.binaryPath).then((result) => {
        this.resolvedBinaryPath = result.resolved;
        this.state = { ...this.state, lastError: result.error ?? null };
      });
    }

    // M3: autoConnect true/false toggles the startup sequence / poll+watcher
    // suspend. manageDaemon toggles only affect the UI's Start/Stop buttons —
    // a drain already in progress keeps being tracked regardless (§4.1).
  }

  /** `runId`/`gaggle`/`workflow`/`stage`-scoped reads are network calls owned
   *  by M3. This returns the not-implemented envelope until then. */
  notImplemented(): GoobersErrorEnvelope {
    return { error: { code: 'not-implemented', message: 'not implemented until M3' } };
  }

  unsupportedPlatform(): GoobersErrorEnvelope {
    return { error: { code: 'unsupported-platform', message: 'Goobers is not supported on this platform' } };
  }

  /** Idempotent — spec §6.1. M1 stub: ensures activation and re-validates
   *  the configured root; the real daemon/SSE connect lands with M3. */
  async connect(): Promise<GoobersConnectionState | GoobersErrorEnvelope> {
    if (!this.isSupportedPlatform) return this.unsupportedPlatform();
    this.subscribe();
    this.lastKnownSettings = this.settings.getSettings();
    await this.reconcile(this.lastKnownSettings);
    return this.state;
  }

  /** M1 stub — M3 closes the SSE stream and clears in-flight requests
   *  (§7.9). Never touches the daemon itself (D12). */
  disconnect(): void | GoobersErrorEnvelope {
    if (!this.isSupportedPlatform) return this.unsupportedPlatform();
    this.state = { ...this.state, connection: 'idle', stream: 'unavailable' };
  }

  getBinaryPathForTests(): string | null {
    return this.resolvedBinaryPath;
  }
}

export const goobersService = new GoobersService();
