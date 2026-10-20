/**
 * Per-driver health for automatic Chat → Terminal fallback
 * (docs/structured-chat-research.md §7.1). Everything here lives for the
 * main process only and is keyed by driver + binary + profile env, so one
 * broken install or profile doesn't pause the driver for the others.
 *
 * - Handshake probes are cached per key (re-probed when the binary changes
 *   on disk: mtime, size or inode), so the zero-token handshake runs once per CLI install rather
 *   than on every wake. A probe that reports a missing login isn't cached
 *   or counted as a failure, so logging in takes effect on the next wake. Concurrent callers share one in-flight probe, so a
 *   burst of agents waking at launch costs one probe and, if it fails, one
 *   failure.
 * - Handshake and spawn-level failures pause a key after a few in a row:
 *   agents skip it (to the next driver, or the terminal) instead of paying
 *   for another failing start each time. One success clears it; after the
 *   pause, the next attempt is let through. Failures remember the binary's
 *   identity, so replacing it at the same path (a fixed install) drops the
 *   old failures and is tried right away, the same change that re-probes it.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import { MINIMAL_CHAT_CAPABILITIES, type ChatDriver, type ChatDriverProbe } from '../../../shared/chat';
import { appLog } from '../log-service';
import { ATTR } from '../../../shared/telemetry/attributes';

/** Consecutive failures that pause a driver key. */
export const DRIVER_FAILURE_THRESHOLD = 3;
/** How long a paused key is skipped before it gets another try. */
export const DRIVER_PAUSE_MS = 30 * 60_000;
/**
 * Outer bound on one probe, for every driver: concurrent callers share the
 * in-flight probe, so a probe that never settles would hold all of them and
 * keep the key from being probed again. Each driver's own handshake deadline
 * (e.g. the Claude SDK's SDK_INIT_TIMEOUT_MS, plus its close grace) should
 * fire before this; it is the backstop. A probe past it counts as a
 * failed handshake, and its late result is dropped.
 */
export const PROBE_DEADLINE_MS = 60_000;

interface Health {
  consecutiveFailures: number;
  lastFailureAt: number;
  lastReason?: string;
  /** Identity of the binary the failures were recorded against. */
  binaryIdentity?: string;
}

const health = new Map<string, Health>();
const probes = new Map<string, { identity: string; probe: ChatDriverProbe }>();
const inFlight = new Map<string, { identity: string | undefined; probe: Promise<ChatDriverProbe> }>();

/** Health and probe-cache key: driver, binary, the profile env it runs with and any command prefix it's launched through. */
export function driverHealthKey(driver: Pick<ChatDriver, 'id'>, binaryPath: string, env?: Record<string, string>, commandPrefix?: string): string {
  const envHash = env && Object.keys(env).length
    ? createHash('sha1').update(JSON.stringify(Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))).digest('hex').slice(0, 12)
    : '-';
  return `${driver.id}\0${binaryPath}\0${envHash}${commandPrefix ? `\0${commandPrefix}` : ''}`;
}

/**
 * Count a failure for the key. With the binary path, the failure is tied to
 * the binary's current identity, and failures of a different binary at that
 * path no longer count.
 */
export function recordDriverFailure(key: string, reason: string, now = Date.now(), binaryPath?: string): void {
  recordFailure(key, reason, now, binaryPath !== undefined ? binaryIdentity(binaryPath) : undefined);
}

function recordFailure(key: string, reason: string, now: number, identity: string | undefined): void {
  const prev = health.get(key);
  const h = prev && !identityChanged(prev.binaryIdentity, identity) ? prev : { consecutiveFailures: 0, lastFailureAt: 0 };
  health.set(key, { consecutiveFailures: h.consecutiveFailures + 1, lastFailureAt: now, lastReason: reason, binaryIdentity: identity ?? h.binaryIdentity });
}

export function recordDriverSuccess(key: string): void {
  health.delete(key);
}

/**
 * The reason a key is paused, or undefined when it may be tried. With the
 * binary path, a binary replaced since the failures clears them.
 */
export function driverPausedReason(key: string, now = Date.now(), binaryPath?: string): string | undefined {
  const h = health.get(key);
  if (!h) return undefined;
  if (binaryPath !== undefined && identityChanged(h.binaryIdentity, binaryIdentity(binaryPath))) {
    health.delete(key);
    return undefined;
  }
  if (h.consecutiveFailures < DRIVER_FAILURE_THRESHOLD) return undefined;
  if (now - h.lastFailureAt >= DRIVER_PAUSE_MS) return undefined;
  return h.lastReason ?? 'repeated failures';
}

/**
 * A binary that can't be stat'ed now counts as unchanged; one that couldn't
 * be when the failures were recorded and can be now has changed.
 */
function identityChanged(recorded: string | undefined, current: string | undefined): boolean {
  return current !== undefined && recorded !== current;
}

/** What changes when the binary is replaced: mtime, size and inode. */
function binaryIdentity(binaryPath: string): string | undefined {
  try {
    const st = fs.statSync(binaryPath);
    return `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch { // telemetry-exempt: an unstat-able binary just isn't cached; the probe reports the real failure
    return undefined;
  }
}

async function runProbe(driver: ChatDriver, binaryPath: string, env: Record<string, string> | undefined, commandPrefix: string | undefined): Promise<ChatDriverProbe> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ChatDriverProbe>((resolve) => {
    timer = setTimeout(() => resolve({
      handshakeOk: false, capabilities: MINIMAL_CHAT_CAPABILITIES,
      error: `probe did not finish within ${PROBE_DEADLINE_MS}ms`, errorCode: 'rpc_timeout',
    }), PROBE_DEADLINE_MS);
  });
  try {
    // Launched the way start() will be, through the profile's command prefix.
    return await Promise.race([driver.probe(binaryPath, env, commandPrefix ? { commandPrefix } : undefined), deadline]);
  } catch (err) { // telemetry-exempt: a throwing probe is a failed handshake, recorded by the caller and reported by chat-spawn
    return { handshakeOk: false, capabilities: MINIMAL_CHAT_CAPABILITIES, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The driver's handshake probe, cached while the binary is unchanged.
 * Concurrent calls for one key share a probe; a failed probe is not cached
 * and counts one failure for the key. A probe past PROBE_DEADLINE_MS fails
 * for every caller sharing it and leaves nothing in flight or cached.
 */
export function probeDriver(driver: ChatDriver, binaryPath: string, env?: Record<string, string>, commandPrefix?: string): Promise<ChatDriverProbe> {
  const key = driverHealthKey(driver, binaryPath, env, commandPrefix);
  const identity = binaryIdentity(binaryPath);
  const cached = probes.get(key);
  if (cached && identity !== undefined && cached.identity === identity) return Promise.resolve(cached.probe);
  // A probe of the binary this one replaced isn't shared.
  const pending = inFlight.get(key);
  if (pending && !identityChanged(pending.identity, identity)) return pending.probe;

  const startedAt = Date.now();
  const probe = runProbe(driver, binaryPath, env, commandPrefix).then((result) => {
    // Superseded by a probe of a replacement binary: stale, so neither cached nor counted.
    if (inFlight.get(key)?.probe !== probe) return result;
    inFlight.delete(key);
    if (result.handshakeOk && result.needsLogin) {
      // Healthy CLI, user not logged in: probe again next time rather than caching or pausing.
      probes.delete(key);
    } else if (result.handshakeOk) {
      // A version lookup that failed may pass next time; don't pin "unknown".
      if (identity !== undefined && !result.versionTransient) probes.set(key, { identity, probe: result });
      else probes.delete(key);
    } else {
      probes.delete(key);
      recordFailure(key, `handshake failed: ${result.error ?? 'unknown error'}`, Date.now(), identity);
      // One record per actual probe (concurrent callers share it). Raw errors
      // and binary paths stay local; never log/export the environment or key.
      appLog('core:chat', 'warn', 'Chat handshake probe failed', {
        meta: {
          driver: driver.id, provider: driver.provider, binary: binaryPath,
          elapsedMs: Date.now() - startedAt,
          error: result.error, errorCode: result.errorCode ?? 'unknown',
        },
        telemetry: {
          event: 'clubhouse.chat.probe_failed',
          attrs: [ATTR.chatDriver(driver.id), ATTR.errorType(result.errorCode ?? 'unknown')],
        },
      });
    }
    return result;
  });
  inFlight.set(key, { identity, probe });
  return probe;
}

/** For tests. */
export function clearDriverHealth(): void {
  health.clear();
  probes.clear();
  inFlight.clear();
}
