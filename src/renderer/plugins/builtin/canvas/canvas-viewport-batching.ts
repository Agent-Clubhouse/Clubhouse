import { useCallback, useRef } from 'react';
import type { Viewport } from './canvas-types';

export function useBatchedViewportChange(onViewportChange: (viewport: Viewport) => void) {
  const pendingRef = useRef<Viewport | null>(null);
  const rafIdRef = useRef<number | null>(null);

  const flush = useCallback(() => {
    const next = pendingRef.current;
    pendingRef.current = null;
    rafIdRef.current = null;
    if (next) {
      onViewportChange(next);
    }
  }, [onViewportChange]);

  const schedule = useCallback((viewport: Viewport) => {
    pendingRef.current = viewport;
    if (rafIdRef.current !== null) return;

    const scheduleFrame = typeof globalThis.requestAnimationFrame === 'function'
      ? globalThis.requestAnimationFrame.bind(globalThis)
      : (cb: FrameRequestCallback) => setTimeout(cb, 16) as unknown as number;

    rafIdRef.current = scheduleFrame(flush);
  }, [flush]);

  const flushNow = useCallback(() => {
    const cancelFrame = typeof globalThis.cancelAnimationFrame === 'function'
      ? globalThis.cancelAnimationFrame.bind(globalThis)
      : (id: number) => clearTimeout(id);

    if (rafIdRef.current !== null) {
      cancelFrame(rafIdRef.current);
      rafIdRef.current = null;
    }

    const next = pendingRef.current;
    pendingRef.current = null;
    if (next) {
      onViewportChange(next);
    }
  }, [onViewportChange]);

  return {
    scheduleViewportChange: schedule,
    flushViewportChange: flushNow,
  };
}
