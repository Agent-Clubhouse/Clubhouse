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
import { resolveLivenessAddress } from './goobers-address';
import { httpGetJson, parseJsonBody } from './goobers-http';
import type { Health, Instance } from '../../shared/goobers-api-types';
import type { GoobersDaemonStatus, GoobersRecoveryStatus } from '../../shared/goobers-types';

const READYZ_TIMEOUT_MS = 2000;

/**
 * `/readyz`'s body — not vendored (goobers-api-types.ts is a portal-sourced
 * copy and this shape isn't part of that vendoring); only the subset M20
 * actually reads.
 */
interface ReadyzBody {
  checks?: Record<string, boolean>;
  startup?: { phase: string; since: string };
}

/**
 * A `startup.since` older than this while `/api/v1/instance` is still 503
 * `recovering` is treated as stalled, not merely slow (M20 requirement 4).
 * Chosen heuristic, not a spec value — the one observed live recovery ran
 * ~2 minutes; this gives ample room before escalating to a genuine error.
 */
const RECOVERY_STALL_MS = 10 * 60 * 1000;

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

/**
 * M22 — the daemon's `instanceRoot` field in `/api/v1/instance` is a raw argv
 * echo (verified live: `goobers up .` reports `"."`; `goobers up /abs/path`
 * reports that exact string, not even symlink-resolved) and was never a
 * valid identity signal, relative or absolute. `.instance-id` is the durable
 * identity (§4.2) and `goobers-service.ts`'s `validateInstanceRoot` already
 * reads and trusts it locally, with no network involved — this mirrors that
 * exact read (same regex, same "intentionally dotted, never the sibling
 * undotted `instance-id`" rule) rather than threading its result in from the
 * service layer, so `probeLiveness` stays self-contained given only `root`,
 * matching every other per-tick read in this function (e.g. `up.lock` above).
 */
async function readLocalInstanceId(root: string): Promise<string | null> {
  try {
    const raw = await fs.promises.readFile(path.join(root, '.instance-id'), 'utf-8');
    const id = raw.trim();
    return /^[0-9a-f]{32}$/.test(id) ? id : null;
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
  /** Set only when `error.code === 'recovering'` (M20). */
  recovery?: GoobersRecoveryStatus | null;
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

  // §8.4 (M20) — captured only for the 503/recovering branch below; a
  // successful identity check never needs it.
  const readyzBody = parseJsonBody<ReadyzBody>(readyRes.body);

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

  if (instanceRes.status === 401) {
    // §2.3/§10.1 — no auth by default, but a user-configured `api.auth` gets
    // 401s. /readyz already confirmed something is up and ready at this
    // address (§14.1 — /readyz is outside the auth pipeline), so this is a
    // running daemon we simply can't read from, not "not running". We do
    // not source or send a bearer token this phase — just surface it.
    const upLock = await readUpLockMetadata(root);
    return {
      daemon: idleDaemon('running', { address: addressDisplay, pid: upLock.pid, version: upLock.version, startedAt: upLock.startedAt }),
      instance: null,
      health: null,
      degraded: false,
      error: { code: 'auth-required', message: 'GET /api/v1/instance returned 401 — a credential is required and is not sourced or sent this phase (§10.1)' },
    };
  }

  if (instanceRes.status === 503) {
    // M20 — /readyz already confirmed the daemon is alive and gave us a
    // structured startup breakdown; a 503 whose body matches the known
    // "recovering" shape is that same alive daemon, not a failure. Anything
    // else (wrong error.code, or no corroborating /readyz startup info)
    // falls through to the generic 503-is-unexpected branch below —
    // requirement 4: a 503 that isn't recognizably "recovering" stays an error.
    const body = parseJsonBody<{ error?: { code?: string; message?: string } }>(instanceRes.body);
    if (body?.error?.code === 'recovering' && readyzBody?.startup) {
      const { phase, since } = readyzBody.startup;
      const sinceMs = Date.parse(since);
      const stalled = Number.isFinite(sinceMs) && Date.now() - sinceMs > RECOVERY_STALL_MS;
      if (!stalled) {
        return {
          daemon: idleDaemon('starting', { address: addressDisplay }),
          instance: null,
          health: null,
          degraded: false,
          recovery: { phase, since, checks: readyzBody.checks ?? {} },
          error: { code: 'recovering', message: body.error.message ?? 'daemon is completing crash recovery' },
        };
      }
      return {
        daemon: idleDaemon('unknown', { address: addressDisplay }),
        instance: null,
        health: null,
        degraded: false,
        error: {
          code: 'recovery-stalled',
          message: `daemon has been in startup phase "${phase}" for over ${Math.round(RECOVERY_STALL_MS / 60_000)} minutes without becoming ready`,
        },
      };
    }
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

  const localInstanceId = await readLocalInstanceId(root);
  const reportedInstanceId = instance.rootIdentity?.id;

  if (!localInstanceId || !reportedInstanceId) {
    // Distinct from a genuine mismatch (§9.1) — we simply can't confirm
    // identity either way. Never treated as a pass: still refuses to render
    // `instance`/`health`, same as a real mismatch, just with an honest
    // message instead of the false "another process is listening" claim
    // this used to assert unconditionally (M22's secondary defect).
    return {
      daemon: idleDaemon('unknown', { address: addressDisplay }),
      instance: null,
      health: null,
      degraded: false,
      error: {
        code: 'identity-unverifiable',
        message: !localInstanceId
          ? `could not read a valid .instance-id from ${root} to confirm this is the configured instance`
          : `the daemon at ${addressDisplay} did not report a rootIdentity.id to confirm against — cannot verify this is the configured instance`,
      },
    };
  }

  if (localInstanceId !== reportedInstanceId) {
    return {
      daemon: idleDaemon('unknown', { address: addressDisplay }),
      instance: null,
      health: null,
      degraded: false,
      error: {
        code: 'identity-mismatch',
        message: `another instance is listening on ${addressDisplay} — its identity ("${reportedInstanceId}") does not match the configured root's ("${localInstanceId}")`,
      },
    };
  }

  // Identity confirmed — fetch health for freshness, and up.lock for display metadata only.
  const upLock = await readUpLockMetadata(root);
  let health: Health | null = null;
  try {
    const healthRes = await httpGetJson(address.host, address.port, '/api/v1/health', READYZ_TIMEOUT_MS);
    if (healthRes.status === 200) {
      health = parseJsonBody<Health>(healthRes.body);
    } else if (healthRes.status === 401) {
      // Same reasoning as the /api/v1/instance 401 above — identity was
      // already confirmed via a 200 there, so we keep `instance` but not
      // `health`, and never retry this in a loop (§8.4/§10.1).
      return {
        daemon: { state: 'running', address: addressDisplay, pid: upLock.pid, version: upLock.version, startedAt: upLock.startedAt, lastTickAgeMillis: null, draining: false },
        instance,
        health: null,
        degraded: false,
        error: { code: 'auth-required', message: 'GET /api/v1/health returned 401 — a credential is required and is not sourced or sent this phase (§10.1)' },
      };
    }
  } catch {
    // Health is best-effort here; identity is already confirmed and the
    // daemon is running. A failed health fetch does not demote us to
    // not-running — it just leaves freshness unknown this tick.
  }

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
