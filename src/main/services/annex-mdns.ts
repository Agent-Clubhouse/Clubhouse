/**
 * Bonjour (mDNS) instances that never throw (#1921).
 *
 * `bonjour-service` throws from its send callback unless it's given an error
 * callback, and its multicast socket emits `error` with no listener when it
 * can't bind. Either reached `uncaughtException` after a Wi-Fi change, sleep or
 * a VPN coming up (`send EADDRNOTAVAIL 224.0.0.251:5353`). Every Annex Bonjour
 * instance is made here, with both handled and logged at warn.
 */
import Bonjour from 'bonjour-service';
import type { EventEmitter } from 'events';
import { appLog } from './log-service';

export type MdnsRole = 'advertise' | 'discover';

export interface MdnsErrorInfo {
  /** The socket couldn't be bound, so this instance is dead and should be made again. */
  fatal: boolean;
  code: string;
}

/** How often the same error from the same role is logged. */
const LOG_EVERY_MS = 60_000;
const lastLogged = new Map<string, number>();

function codeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code ? code : 'unknown';
}

function logOnce(role: MdnsRole, err: unknown, fatal: boolean): void {
  const code = codeOf(err);
  const key = `${role}:${code}:${fatal}`;
  const now = Date.now();
  if ((lastLogged.get(key) ?? -Infinity) + LOG_EVERY_MS > now) return;
  lastLogged.set(key, now);
  appLog('core:annex', 'warn', fatal ? 'mDNS socket could not start' : 'mDNS send failed', {
    meta: { role, code, error: err instanceof Error ? err.message : String(err) },
  });
}

/**
 * A Bonjour instance whose socket errors are logged instead of thrown.
 * `onError` hears each one; a `fatal` one means the instance should be replaced.
 */
export function createBonjour(role: MdnsRole, onError?: (info: MdnsErrorInfo) => void): InstanceType<typeof Bonjour> {
  const report = (err: unknown, fatal: boolean): void => {
    logOnce(role, err, fatal);
    try { onError?.({ fatal, code: codeOf(err) }); } catch { /* telemetry-exempt: a failing handler must not throw out of a socket callback */ }
  };
  const bonjour = new Bonjour({}, (err: unknown) => report(err, false));
  // The multicast socket inside: `error` when it can't bind (with no listener, a throw),
  // `warning` for send and socket errors it recovers from.
  const mdns = (bonjour as unknown as { server?: { mdns?: EventEmitter } }).server?.mdns;
  mdns?.on('error', (err: unknown) => report(err, true));
  mdns?.on('warning', (err: unknown) => report(err, false));
  return bonjour;
}

/** Test helper: forget which errors were logged. */
export function resetMdnsLogForTests(): void {
  lastLogged.clear();
}
