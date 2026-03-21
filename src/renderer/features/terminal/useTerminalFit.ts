import { useEffect, type RefObject } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';

/** Delay (ms) after wake-from-sleep before re-fitting the terminal.
 *  Gives the browser layout engine time to recalculate dimensions and
 *  font metrics — particularly important for canvas views where CSS
 *  transforms affect rendered element sizes. */
const WAKE_SETTLE_MS = 150;

/**
 * Save the terminal viewport's scroll position so it can be restored
 * after a `fit()` call that may trigger a buffer reflow.
 *
 * xterm.js reflows the buffer when the column count changes during
 * `terminal.resize()`.  This can shift the viewport — particularly
 * when there is significant scrollback — causing the user's view to
 * jump to the top.  We record the viewport state before `fit()` and
 * restore it immediately after.
 */
function saveViewportScroll(container: HTMLElement): { scrollTop: number; atBottom: boolean } | null {
  const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
  if (!viewport) return null;
  const atBottom = viewport.scrollTop >= viewport.scrollHeight - viewport.clientHeight - 5;
  return { scrollTop: viewport.scrollTop, atBottom };
}

function restoreViewportScroll(container: HTMLElement, saved: { scrollTop: number; atBottom: boolean } | null): void {
  if (!saved) return;
  const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
  if (!viewport) return;
  if (saved.atBottom) {
    // User was at the bottom — make sure we stay there after reflow
    viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight;
  } else {
    // User was scrolled up — restore the previous position
    viewport.scrollTop = saved.scrollTop;
  }
}

/**
 * Manages terminal fit/resize with focus-awareness for multi-window correctness.
 *
 * Triggers a fit + resize on:
 * - Container size changes (ResizeObserver) — guarded by window focus so
 *   background windows don't override the active window's PTY dimensions
 * - Page becoming visible (covers wake-from-sleep, virtual desktop switch)
 * - Window gaining focus (active window re-asserts its terminal size)
 * - Terminal becoming the focused pane (`focused` prop)
 */
export function useTerminalFit(
  sessionId: string,
  terminalRef: RefObject<Terminal | null>,
  fitAddonRef: RefObject<FitAddon | null>,
  containerRef: RefObject<HTMLDivElement | null>,
  focused?: boolean,
  onResize?: (sessionId: string, cols: number, rows: number) => void,
): void {
  // Reactive resize: ResizeObserver + visibility + window focus
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    /**
     * Fit the terminal to its container and optionally resize the PTY.
     * When `sendResize` is false the xterm canvas is re-laid-out (fixing
     * visual wrapping) but the IPC resize is skipped so a background
     * window doesn't clobber the active window's PTY dimensions.
     *
     * Skips entirely when the container has zero dimensions — this guards
     * against measuring stale layout after wake-from-sleep or when the
     * container is hidden (e.g. behind a zoom overlay).
     */
    const doResize = onResize ?? window.clubhouse.pty.resize;

    const fitAndResize = (sendResize: boolean) => {
      requestAnimationFrame(() => {
        if (!fitAddonRef.current || !terminalRef.current) return;
        const el = containerRef.current;
        if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
        const saved = saveViewportScroll(el);
        fitAddonRef.current.fit();
        restoreViewportScroll(el, saved);
        if (sendResize) {
          doResize(
            sessionId,
            terminalRef.current.cols,
            terminalRef.current.rows,
          );
        }
      });
    };

    // Container size changes: only resize PTY if this window is focused
    const resizeObserver = new ResizeObserver(() => {
      fitAndResize(document.hasFocus());
    });
    resizeObserver.observe(container);

    // Wake from sleep / tab restore: delay the re-fit so the browser
    // layout engine can stabilise dimensions and font metrics first.
    let wakeTimer: ReturnType<typeof setTimeout> | null = null;
    const onVisibility = () => {
      if (!document.hidden) {
        wakeTimer = setTimeout(() => fitAndResize(true), WAKE_SETTLE_MS);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    // Window regains focus: ensure PTY matches this window's terminal size
    const onWindowFocus = () => fitAndResize(true);
    window.addEventListener('focus', onWindowFocus);

    return () => {
      resizeObserver.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onWindowFocus);
      if (wakeTimer) clearTimeout(wakeTimer);
    };
  }, [sessionId, onResize]);

  // Pane-level focus: re-fit, resize PTY, and focus the xterm instance.
  // This fires when the user clicks a hub pane or switches to the agents tab,
  // ensuring the PTY dimensions snap to the now-active terminal's container.
  useEffect(() => {
    if (!focused) return;
    if (terminalRef.current) terminalRef.current.focus();
    const doResize = onResize ?? window.clubhouse.pty.resize;
    requestAnimationFrame(() => {
      if (fitAddonRef.current && terminalRef.current) {
        const el = containerRef.current;
        if (el) {
          const saved = saveViewportScroll(el);
          fitAddonRef.current.fit();
          restoreViewportScroll(el, saved);
        } else {
          fitAddonRef.current.fit();
        }
        doResize(
          sessionId,
          terminalRef.current.cols,
          terminalRef.current.rows,
        );
      }
    });
  }, [focused, sessionId, onResize]);
}
