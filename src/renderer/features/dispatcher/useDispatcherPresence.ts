import { useEffect, useState } from 'react';
import type { DispatcherPresenceSnapshot } from '../../../shared/dispatcher-presence';

/**
 * The Dispatchers on this person's other computers (#3349), read-only.
 * Follows `dispatcher:presence-changed`; null until the first read lands.
 */
export function useDispatcherPresence(): DispatcherPresenceSnapshot | null {
  const [snapshot, setSnapshot] = useState<DispatcherPresenceSnapshot | null>(null);
  useEffect(() => {
    let cancelled = false;
    let changed = false;
    const unsubscribe = window.clubhouse.dispatcher.onPresenceChanged((next) => {
      changed = true;
      setSnapshot(next);
    });
    window.clubhouse.dispatcher.getPresence().then((next) => {
      // A broadcast that lands before the read is newer, so keep it.
      if (!cancelled && !changed) setSnapshot(next);
    }).catch(() => {
      // telemetry-exempt: presence is informational; the section shows nothing until a broadcast arrives.
      if (!cancelled && !changed) setSnapshot({ remotes: [] });
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  return snapshot;
}
