import { useState, useCallback } from 'react';

interface State<T> {
  loading: boolean;
  error: string | null;
  result: T | null;
}

interface Return<T> extends State<T> {
  run: (...args: Parameters<(...a: unknown[]) => Promise<T>>) => Promise<void>;
  reset: () => void;
}

export function useAsyncAction<T>(
  fn: (...args: unknown[]) => Promise<T>,
): Return<T> {
  const [state, setState] = useState<State<T>>({ loading: false, error: null, result: null });

  const run = useCallback(async (...args: unknown[]) => {
    setState({ loading: true, error: null, result: null });
    try {
      const result = await fn(...args);
      setState({ loading: false, error: null, result });
    } catch (err) {
      setState({ loading: false, error: err instanceof Error ? err.message : String(err), result: null });
    }
  }, [fn]);

  const reset = useCallback(() => setState({ loading: false, error: null, result: null }), []);

  return { ...state, run, reset };
}
