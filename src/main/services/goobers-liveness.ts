/**
 * Daemon liveness detection (spec §7.4) — the 5-step sequence.
 *
 * Deliberately dependency-free (no `flock`): the address file's presence,
 * a `/readyz` probe, and an identity check on `/api/v1/instance` together
 * defeat the same hazards a non-blocking exclusive flock on `up.lock` would.
 * `up.lock`'s `pid` is NEVER used for liveness (§2.2) — only its
 * version/startedAt/livenessTimeoutMillis, and only as display metadata.
 */
import * as fs from 'fs';
import * as path from 'path';
import { realpath } from 'fs/promises';
import { resolveLivenessAddress } from './goobers-address';
import { httpGetJson, parseJsonBody } from './goobers-http';
import type { Health, Instance } from '../../shared/goobers-api-types';
import type { GoobersDaemonStatus } from '../../shared/goobers-types';

const READYZ_TIMEOUT_MS = 2000;

interface UpLockMetadata {
  pid: number | null;
  version: string | null;
  startedAt: string | null;
  livenessTimeoutMillis: number;
}

const DEFAULT_LIVENESS_TIMEOUT_MILLIS = 120_000;

async function readUpLockMetadata(root: string): Promise<UpLockMetadata> {
  try {
    const raw = await fs.promises.readFile(path.join(root, 'scheduler', 'up.lock'), 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      pid: typeof parsed.pid === 'number' ? parsed.pid : null,
      version: typeof parsed.version === 'string' ? parsed.version : null,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : null,
      livenessTimeoutMillis: typeof parsed.livenessTimeoutMillis === 'number' ? parsed.livenessTimeoutMillis : DEFAULT_LIVENESS_TIMEOUT_MILLIS,
    };
  } catch {
    return { pid: null, version: null, startedAt: null, livenessTimeoutMillis: DEFAULT_LIVENESS_TIMEOUT_MILLIS };
  }
}

async function realpathSafe(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}

export interface LivenessSnapshot {
  daemon: GoobersDaemonStatus;
  instance: Instance | null;
  health: Health | null;
  /** true when the daemon is running but its scheduler tick has gone stale
   *  beyond livenessTimeoutMillis — caller maps this to connection:'degraded'. */
  degraded: boolean;
  error?: { code: string; message: string };
}

function idleDaemon(state: GoobersDaemonStatus['state'], meta?: Partial<GoobersDaemonStatus>): GoobersDaemonStatus {
  return {
    state,
    address: null,
    pid: null,
    version: null,
    startedAt: null,
    lastTickAgeMillis: null,
    draining: false,
    ...meta,
  };
}

/**
 * Run the full §7.4 sequence for `root`. Never throws — every failure mode
 * is represented in the returned snapshot's `daemon.state`/`error`.
 */
export async function probeLiveness(root: string): Promise<LivenessSnapshot> {
  const resolved = await resolveLivenessAddress(root);

  if (resolved.status === 'absent') {
    return { daemon: idleDaemon('not-running'), instance: null, health: null, degraded: false };
  }
  if (resolved.status === 'pending') {
    // Present but still empty/partial after retries — a real race, not a
    // failure. Report the same as "not yet observed" rather than flapping
    // to an error state.
    return { daemon: idleDaemon('unknown'), instance: null, health: null, degraded: false };
  }
  if (resolved.status === 'non-loopback') {
    return {
      daemon: idleDaemon('unknown'),
      instance: null,
      health: null,
      degraded: false,
      error: { code: 'non-loopback-address', message: `scheduler/api.address resolved to a non-loopback host (${resolved.host}); refusing to connect` },
    };
  }

  const { address } = resolved;
  const addressDisplay = `${address.host}:${address.port}`;

  let readyRes;
  try {
    readyRes = await httpGetJson(address.host, address.port, '/readyz', READYZ_TIMEOUT_MS);
  } catch {
    // ECONNREFUSED (or any connect failure) against an address the file
    // claims is live ⇒ stale address file ⇒ not running.
    return { daemon: idleDaemon('not-running'), instance: null, health: null, degraded: false };
  }

  if (readyRes.status === 503) {
    return { daemon: idleDaemon('starting', { address: addressDisplay }), instance: null, health: null, degraded: false };
  }
  if (readyRes.status !== 200) {
    return {
      daemon: idleDaemon('unknown', { address: addressDisplay }),
      instance: null,
      health: null,
      degraded: false,
      error: { code: 'unexpected-readyz-status', message: `unexpected /readyz status ${readyRes.status}` },
    };
  }

  // Identity confirmation (§7.4 step 3 / §9.1 correctness gate).
  let instanceRes;
  try {
    instanceRes = await httpGetJson(address.host, address.port, '/api/v1/instance', READYZ_TIMEOUT_MS);
  } catch (err) {
    return {
      daemon: idleDaemon('unknown', { address: addressDisplay }),
      instance: null,
      health: null,
      degraded: false,
      error: { code: 'identity-check-failed', message: err instanceof Error ? err.message : String(err) },
    };
  }

  const instance = instanceRes.status === 200 ? parseJsonBody<Instance>(instanceRes.body) : null;
  if (!instance) {
    return {
      daemon: idleDaemon('unknown', { address: addressDisplay }),
      instance: null,
      health: null,
      degraded: false,
      error: { code: 'identity-check-failed', message: `unexpected /api/v1/instance response (status ${instanceRes.status})` },
    };
  }

  const [realConfiguredRoot, realReportedRoot] = await Promise.all([realpathSafe(root), realpathSafe(instance.instanceRoot)]);
  if (!realConfiguredRoot || !realReportedRoot || realConfiguredRoot !== realReportedRoot) {
    return {
      daemon: idleDaemon('unknown', { address: addressDisplay }),
      instance: null,
      health: null,
      degraded: false,
      error: {
        code: 'identity-mismatch',
        message: `another process is listening on ${addressDisplay} — its instanceRoot ("${instance.instanceRoot}") does not match the configured root`,
      },
    };
  }

  // Identity confirmed — fetch health for freshness, and up.lock for display metadata only.
  let health: Health | null = null;
  try {
    const healthRes = await httpGetJson(address.host, address.port, '/api/v1/health', READYZ_TIMEOUT_MS);
    if (healthRes.status === 200) health = parseJsonBody<Health>(healthRes.body);
  } catch {
    // Health is best-effort here; identity is already confirmed and the
    // daemon is running. A failed health fetch does not demote us to
    // not-running — it just leaves freshness unknown this tick.
  }

  const upLock = await readUpLockMetadata(root);
  const lastTickAgeMillis = health?.freshness?.lastTickAgeMillis ?? null;
  const degraded = lastTickAgeMillis != null && lastTickAgeMillis > upLock.livenessTimeoutMillis;

  return {
    daemon: {
      state: 'running',
      address: addressDisplay,
      pid: upLock.pid, // display only — never used above to decide liveness
      version: upLock.version,
      startedAt: upLock.startedAt,
      lastTickAgeMillis,
      draining: false,
    },
    instance,
    health,
    degraded,
  };
}
