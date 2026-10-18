import { useCallback, useLayoutEffect, useRef } from 'react';

/** How long a move may take to come back from the store (it waits for an IPC write). */
const REFOCUS_WINDOW_MS = 2_000;

/**
 * Keep keyboard focus on a row that Alt+Up / Alt+Down moved. React reorders
 * keyed rows by moving DOM nodes, and Chromium blurs a focused node it moves,
 * so focus would drop to the body and the next Alt+Down would do nothing.
 * `arm(el)` before the move; after each render, if focus fell to the body
 * within the window, it goes back to `el`.
 */
export function useRefocusAfterMove(): (el: HTMLElement) => void {
  const armed = useRef<{ el: HTMLElement; until: number } | null>(null);
  useLayoutEffect(() => {
    const a = armed.current;
    if (!a) return;
    if (Date.now() > a.until || !a.el.isConnected) { armed.current = null; return; }
    const active = document.activeElement;
    if (active === null || active === document.body) {
      a.el.focus();
      armed.current = null;
    }
  });
  return useCallback((el: HTMLElement) => { armed.current = { el, until: Date.now() + REFOCUS_WINDOW_MS }; }, []);
}
