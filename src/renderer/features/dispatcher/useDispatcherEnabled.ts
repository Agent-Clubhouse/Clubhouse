import { useCallback, useEffect, useState } from 'react';
import type { DispatcherState } from '../../../shared/dispatcher-types';
import { ipcErrorMessage } from '../../utils/ipc-error';

export interface DispatcherRead {
  /** Null until the first read or broadcast lands. */
  state: DispatcherState | null;
  /** Why the read failed, while no state has arrived since. */
  error: string | null;
  /** Read again after a failure. */
  retry: () => void;
}

/**
 * The Dispatcher's state from main (#2533), with the read's error. Follows
 * `dispatcher:changed`, so it updates when its switch, MCP at app level or the
 * agent's config changes.
 */
export function useDispatcherRead(): DispatcherRead {
  const [state, setState] = useState<DispatcherState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let changed = false;
    const unsubscribe = window.clubhouse.dispatcher.onChanged((next) => {
      changed = true;
      setState(next);
      setError(null);
    });
    window.clubhouse.dispatcher.get().then((next) => {
      // A broadcast that lands before the read is newer, so keep it.
      if (!cancelled && !changed) {
        setState(next);
        setError(null);
      }
    }).catch((err: unknown) => {
      // telemetry-exempt: shown by the page that reads it, with Retry.
      if (!cancelled && !changed) setError(ipcErrorMessage(err));
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, error, retry };
}

/** The Dispatcher's state from main, or null until the first read lands (or when it fails). */
export function useDispatcherState(): DispatcherState | null {
  return useDispatcherRead().state;
}

/** The "Connect to Dispatcher" row. It shows while the Dispatcher is on. */
export function useDispatcherConnection(): { show: boolean } {
  const state = useDispatcherState();
  return { show: !!state?.enabled };
}
