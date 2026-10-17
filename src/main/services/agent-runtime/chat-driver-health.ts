/**
 * Per-driver health for automatic Chat → Terminal fallback
 * (docs/structured-chat-research.md §7.1).
 *
 * - Handshake probes are cached per driver and binary (re-probed when the
 *   binary changes on disk), so the zero-token handshake runs once per CLI
 *   install rather than on every wake.
 * - A driver whose handshake or session start fails repeatedly is paused for
 *   a while: agents skip it (to the next driver, or the terminal) instead of
 *   paying for another failing start each time. One success clears it; after
 *   the pause, the next attempt is let through.
 */

import * as fs from 'fs';
import { MINIMAL_CHAT_CAPABILITIES, type ChatDriver, type ChatDriverId, type ChatDriverProbe } from '../../../shared/chat';

/** Consecutive failures that pause a driver. */
export const DRIVER_FAILURE_THRESHOLD = 3;
/** How long a paused driver is skipped before it gets another try. */
export const DRIVER_PAUSE_MS = 30 * 60_000;

interface Health {
  consecutiveFailures: number;
  lastFailureAt: number;
  lastReason?: string;
}

const health = new Map<ChatDriverId, Health>();
const probes = new Map<string, { mtimeMs: number; probe: ChatDriverProbe }>();

export function recordDriverFailure(id: ChatDriverId, reason: string, now = Date.now()): void {
  const h = health.get(id) ?? { consecutiveFailures: 0, lastFailureAt: 0 };
  health.set(id, { consecutiveFailures: h.consecutiveFailures + 1, lastFailureAt: now, lastReason: reason });
}

export function recordDriverSuccess(id: ChatDriverId): void {
  health.delete(id);
}

/** The reason a driver is paused, or undefined when it may be tried. */
export function driverPausedReason(id: ChatDriverId, now = Date.now()): string | undefined {
  const h = health.get(id);
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

/**
 * The driver's handshake probe, cached while the binary is unchanged. Failed
 * probes are not cached and count as driver failures.
 */
export async function probeDriver(driver: ChatDriver, binaryPath: string, env?: Record<string, string>): Promise<ChatDriverProbe> {
  const key = `${driver.id}\0${binaryPath}`;
  const mtimeMs = binaryMtime(binaryPath);
  const cached = probes.get(key);
  if (cached && mtimeMs !== undefined && cached.mtimeMs === mtimeMs) return cached.probe;
  let probe: ChatDriverProbe;
  try {
    probe = await driver.probe(binaryPath, env);
  } catch (err) { // telemetry-exempt: a throwing probe is a failed handshake, recorded below and reported by chat-spawn
    probe = { handshakeOk: false, capabilities: MINIMAL_CHAT_CAPABILITIES, error: err instanceof Error ? err.message : String(err) };
  }
  if (probe.handshakeOk) {
    if (mtimeMs !== undefined) probes.set(key, { mtimeMs, probe });
  } else {
    probes.delete(key);
    recordDriverFailure(driver.id, `handshake failed: ${probe.error ?? 'unknown error'}`);
  }
  return probe;
}

/** For tests. */
export function clearDriverHealth(): void {
  health.clear();
  probes.clear();
}
