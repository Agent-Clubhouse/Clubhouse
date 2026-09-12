import { useCallback, useEffect, useRef } from 'react';
import type { Viewport } from './canvas-types';

type ViewportUpdate = Viewport | ((current: Viewport) => Viewport);

function scheduleFrame(callback: FrameRequestCallback): number {
  return typeof globalThis.requestAnimationFrame === 'function'
    ? globalThis.requestAnimationFrame(callback)
    : setTimeout(callback, 16) as unknown as number;
}

function cancelFrame(id: number): void {
  if (typeof globalThis.cancelAnimationFrame === 'function') {
    globalThis.cancelAnimationFrame(id);
  } else {
    clearTimeout(id);
  }
}

export function useBatchedViewportChange(
  onViewportChange: (viewport: Viewport) => void,
  viewport: Viewport,
) {
  const pendingRef = useRef<Viewport | null>(null);
  const committedRef = useRef(viewport);
  const rafIdRef = useRef<number | null>(null);

  useEffect(() => {
    committedRef.current = viewport;
  }, [viewport]);

  const flush = useCallback(() => {
    const next = pendingRef.current;
    pendingRef.current = null;
    rafIdRef.current = null;
    if (next) {
      committedRef.current = next;
      onViewportChange(next);
    }
  }, [onViewportChange]);

  const schedule = useCallback((update: ViewportUpdate) => {
    const current = pendingRef.current ?? committedRef.current;
    pendingRef.current = typeof update === 'function' ? update(current) : update;
    if (rafIdRef.current !== null) return;

    rafIdRef.current = scheduleFrame(flush);
  }, [flush]);

  const flushNow = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelFrame(rafIdRef.current);
      rafIdRef.current = null;
    }

    const next = pendingRef.current;
    pendingRef.current = null;
    if (next) {
      committedRef.current = next;
      onViewportChange(next);
    }
  }, [onViewportChange]);

  useEffect(() => () => {
    if (rafIdRef.current !== null) cancelFrame(rafIdRef.current);
    rafIdRef.current = null;
    pendingRef.current = null;
  }, []);

  return {
    scheduleViewportChange: schedule,
    flushViewportChange: flushNow,
  };
}
