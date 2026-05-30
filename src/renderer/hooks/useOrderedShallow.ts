import { useMemo, useRef } from 'react';

function shallowOrderAware<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    a === null ||
    b === null
  ) {
    return false;
  }
  const keysA = Object.keys(a as object);
  const keysB = Object.keys(b as object);
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i++) {
    const key = keysA[i];
    if (key !== keysB[i]) return false;
    if (!Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
  }
  return true;
}

/**
 * Like zustand's `useShallow`, but treats reordered objects as different.
 *
 * Use this for state where insertion order is part of the value (e.g. an
 * agents map whose key order drives the visible list order). `useShallow`
 * returns the previous reference when keys and values match — which means
 * reorderings are silently dropped and the consumer never re-renders.
 */
export function useOrderedShallow<S, U>(selector: (state: S) => U): (state: S) => U {
  const prev = useRef<U | undefined>(undefined);
  return useMemo(
    () => (state: S) => {
      const next = selector(state);
      if (prev.current !== undefined && shallowOrderAware(prev.current, next)) {
        return prev.current;
      }
      prev.current = next;
      return next;
    },
    [],
  );
}
