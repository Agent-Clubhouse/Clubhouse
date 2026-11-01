import { useEffect, useState } from 'react';
import type { DispatcherState } from '../../../shared/dispatcher-types';

/**
 * The Dispatcher's state from main (#2533), or null until the first read
 * lands. Follows `dispatcher:changed`, so it updates when the experimental
 * flag, the app setting or the agent's config changes.
 */
export function useDispatcherState(): DispatcherState | null {
  const [state, setState] = useState<DispatcherState | null>(null);

  useEffect(() => {
    let cancelled = false;
    let changed = false;
    const unsubscribe = window.clubhouse.dispatcher.onChanged((next) => {
      changed = true;
      setState(next);
    });
    window.clubhouse.dispatcher.get().then((next) => {
      // A broadcast that lands before the read is newer, so keep it.
      if (!cancelled && !changed) setState(next);
    }).catch(() => { /* stays null, which reads as off */ });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return state;
}

/** True only while the experimental flag and the Dispatcher setting are both on. */
export function useDispatcherEnabled(): boolean {
  return useDispatcherState()?.enabled ?? false;
}
