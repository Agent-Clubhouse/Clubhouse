/**
 * Per-driver health for automatic Chat → Terminal fallback
 * (docs/structured-chat-research.md §7.1). Everything here lives for the
 * main process only and is keyed by driver + binary + profile env, so one
 * broken install or profile doesn't pause the driver for the others.
 *
 * - Handshake probes are cached per key (re-probed when the binary changes
 *   on disk), so the zero-token handshake runs once per CLI install rather
 *   than on every wake. A probe that reports a missing login isn't cached
 *   or counted as a failure, so logging in takes effect on the next wake. Concurrent callers share one in-flight probe, so a
 *   burst of agents waking at launch costs one probe and, if it fails, one
 *   failure.
 * - Handshake and spawn-level failures pause a key after a few in a row:
 *   agents skip it (to the next driver, or the terminal) instead of paying
 *   for another failing start each time. One success clears it; after the
 *   pause, the next attempt is let through.
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
}

const health = new Map<string, Health>();
const probes = new Map<string, { mtimeMs: number; probe: ChatDriverProbe }>();
const inFlight = new Map<string, Promise<ChatDriverProbe>>();

/** Health and probe-cache key: driver, binary, the profile env it runs with and any command prefix it's launched through. */
export function driverHealthKey(driver: Pick<ChatDriver, 'id'>, binaryPath: string, env?: Record<string, string>, commandPrefix?: string): string {
  const envHash = env && Object.keys(env).length
    ? createHash('sha1').update(JSON.stringify(Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))).digest('hex').slice(0, 12)
    : '-';
  return `${driver.id}\0${binaryPath}\0${envHash}${commandPrefix ? `\0${commandPrefix}` : ''}`;
}

export function recordDriverFailure(key: string, reason: string, now = Date.now()): void {
  const h = health.get(key) ?? { consecutiveFailures: 0, lastFailureAt: 0 };
  health.set(key, { consecutiveFailures: h.consecutiveFailures + 1, lastFailureAt: now, lastReason: reason });
}

export function recordDriverSuccess(key: string): void {
  health.delete(key);
}

/** The reason a key is paused, or undefined when it may be tried. */
export function driverPausedReason(key: string, now = Date.now()): string | undefined {
  const h = health.get(key);
  if (!h || h.consecutiveFailures < DRIVER_FAILURE_THRESHOLD) return undefined;
  if (now - h.lastFailureAt >= DRIVER_PAUSE_MS) return undefined;
  return h.lastReason ?? 'repeated failures';
}

function binaryMtime(binaryPath: string): number | undefined {
  try {
    return fs.statSync(binaryPath).mtimeMs;
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
  const mtimeMs = binaryMtime(binaryPath);
  const cached = probes.get(key);
  if (cached && mtimeMs !== undefined && cached.mtimeMs === mtimeMs) return Promise.resolve(cached.probe);
  const pending = inFlight.get(key);
  if (pending) return pending;

  const startedAt = Date.now();
  const probe = runProbe(driver, binaryPath, env, commandPrefix).then((result) => {
    inFlight.delete(key);
    if (result.handshakeOk && result.needsLogin) {
      // Healthy CLI, user not logged in: probe again next time rather than caching or pausing.
      probes.delete(key);
    } else if (result.handshakeOk) {
      if (mtimeMs !== undefined) probes.set(key, { mtimeMs, probe: result });
    } else {
      probes.delete(key);
      recordDriverFailure(key, `handshake failed: ${result.error ?? 'unknown error'}`);
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
  inFlight.set(key, probe);
  return probe;
}

/** For tests. */
export function clearDriverHealth(): void {
  health.clear();
  probes.clear();
  inFlight.clear();
}
