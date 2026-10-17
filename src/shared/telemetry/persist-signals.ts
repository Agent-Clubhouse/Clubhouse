/**
 * Persistence-integrity signals (spec §12 H1), shared by main and renderer.
 * Each side passes its own `tel`; this module never imports a facade, so the
 * settings store can use it without an import cycle.
 */
import { ATTR, type EventName, type MetricName, type TelAttr } from './attributes';

export type PersistStore = Parameters<typeof ATTR.persistStore>[0];
export type PersistAction = Parameters<typeof ATTR.persistAction>[0];
export type PersistGuardReason = Parameters<typeof ATTR.persistGuardReason>[0];

export interface PersistTel {
  count(name: MetricName, value?: number, attrs?: TelAttr[]): void;
  event(name: EventName, attrs?: TelAttr[]): void;
}

export function createPersistSignals(tel: PersistTel) {
  const guardSeen = new Set<string>();
  return {
    write(store: PersistStore, startMs: number, ok: boolean): void {
      try {
        tel.count('clubhouse.persist.writes', 1, [ATTR.persistStore(store), ATTR.persistResult(ok ? 'ok' : 'failed')]);
        tel.count('clubhouse.persist.write.duration', (Date.now() - startMs) / 1000, [ATTR.persistStore(store)]);
      } catch {
        // telemetry-exempt: telemetry must never break a write path
      }
    },

    /** Time `fn` as one write; rethrows its error unchanged. */
    async timed<T>(store: PersistStore, fn: () => Promise<T>): Promise<T> {
      const startMs = Date.now();
      try {
        const result = await fn();
        this.write(store, startMs, true);
        return result;
      } catch (err) {
        this.write(store, startMs, false);
        throw err;
      }
    },

    recovery(store: PersistStore, action: PersistAction): void {
      try {
        tel.event('clubhouse.persist.recovery', [ATTR.persistStore(store), ATTR.persistAction(action)]);
      } catch {
        // telemetry-exempt: telemetry must never break a recovery path
      }
    },

    /** Counted every time; the event goes out once per store and reason per session. */
    guardBlocked(store: PersistStore, reason: PersistGuardReason): void {
      try {
        const attrs = [ATTR.persistStore(store), ATTR.persistGuardReason(reason)];
        tel.count('clubhouse.persist.guard_blocks', 1, attrs);
        const key = `${store}:${reason}`;
        if (!guardSeen.has(key)) {
          guardSeen.add(key);
          tel.event('clubhouse.persist.guard_blocked', attrs);
        }
      } catch {
        // telemetry-exempt: telemetry must never break a save path
      }
    },

    barrierWait(store: PersistStore, waitedMs: number): void {
      try {
        tel.count('clubhouse.persist.flush_barrier.wait', waitedMs / 1000, [ATTR.persistStore(store)]);
      } catch {
        // telemetry-exempt: telemetry must never break a flush
      }
    },
  };
}

export type PersistSignals = ReturnType<typeof createPersistSignals>;
