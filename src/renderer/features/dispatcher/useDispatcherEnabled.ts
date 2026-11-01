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
 * `dispatcher:changed`, so it updates when the experimental flag, the app
 * setting or the agent's config changes.
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

/** True only while the experimental flag and the Dispatcher setting are both on. */
export function useDispatcherEnabled(): boolean {
  return useDispatcherState()?.enabled ?? false;
}

/**
 * True while the experimental flag is on, which shows Settings > Dispatcher.
 * Follows `dispatcher:changed`. If the read fails before any state arrives,
 * the flag is read from the experimental settings instead, so the page and
 * its error and Retry can still be reached (#2572).
 */
export function useDispatcherFlagOn(): boolean {
  const { state, error } = useDispatcherRead();
  const [fallback, setFallback] = useState(false);
  const failed = !state && !!error;
  useEffect(() => {
    if (!failed) return;
    let cancelled = false;
    window.clubhouse.app.getExperimentalSettings().then((s) => {
      if (!cancelled) setFallback(!!s.dispatcher);
    }).catch(() => {
      // telemetry-exempt: the item stays hidden, as it was.
    });
    return () => { cancelled = true; };
  }, [failed]);
  return state ? state.flagOn : failed && fallback;
}
