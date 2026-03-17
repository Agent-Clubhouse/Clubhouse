import { useEffect, type RefObject } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';

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
     */
    const fitAndResize = (sendResize: boolean) => {
      requestAnimationFrame(() => {
        if (!fitAddonRef.current || !terminalRef.current) return;
        fitAddonRef.current.fit();
        if (sendResize) {
          window.clubhouse.pty.resize(
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

    // Wake from sleep / tab restore: re-fit when page becomes visible
    const onVisibility = () => {
      if (!document.hidden) fitAndResize(true);
    };
    document.addEventListener('visibilitychange', onVisibility);

    // Window regains focus: ensure PTY matches this window's terminal size
    const onWindowFocus = () => fitAndResize(true);
    window.addEventListener('focus', onWindowFocus);

    return () => {
      resizeObserver.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onWindowFocus);
    };
  }, [sessionId]);

  // Pane-level focus: re-fit, resize PTY, and focus the xterm instance.
  // This fires when the user clicks a hub pane or switches to the agents tab,
  // ensuring the PTY dimensions snap to the now-active terminal's container.
  useEffect(() => {
    if (!focused) return;
    if (terminalRef.current) terminalRef.current.focus();
    requestAnimationFrame(() => {
      if (fitAddonRef.current && terminalRef.current) {
        fitAddonRef.current.fit();
        window.clubhouse.pty.resize(
          sessionId,
          terminalRef.current.cols,
          terminalRef.current.rows,
        );
      }
    });
  }, [focused, sessionId]);
}
