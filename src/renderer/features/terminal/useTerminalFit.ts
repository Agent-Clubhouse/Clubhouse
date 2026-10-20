import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { claimSizeOwner, isSizeOwner, registerSizeOwner } from './pty-size-owner';
import { resizeTerminal } from './inline-frame';
import { onDevicePixelRatioChange } from './dpr-watch';

/** Delay (ms) after wake-from-sleep before re-fitting the terminal.
 *  Gives the browser layout engine time to recalculate dimensions and
 *  font metrics — particularly important for canvas views where CSS
 *  transforms affect rendered element sizes. */
const WAKE_SETTLE_MS = 150;

/** Trailing debounce (ms) for PTY resizes from container size changes, so a
 *  drag or layout animation sends one size instead of one per frame. */
export const RESIZE_DEBOUNCE_MS = 80;

/**
 * Whether the terminal viewport is showing the newest output.
 *
 * xterm 6 scrolls virtually (custom scrollbar) — `.xterm-viewport` scrollTop
 * stays 0 — so scroll state must be read from the buffer via the public API.
 */
export function isTerminalAtBottom(term: Terminal): boolean {
  const buf = term.buffer.active;
  return buf.viewportY >= buf.baseY;
}

/**
 * Run `fit()` while keeping a bottom-pinned viewport pinned.
 *
 * xterm.js reflows the buffer when the column count changes during
 * `terminal.resize()` and adjusts the viewport line itself, but a reflow can
 * leave a viewport that was following live output short of the new bottom.
 * Record whether we were at the bottom before `fit()` and re-pin after.
 */
export function fitPreservingScroll(term: Terminal, fitAddon: FitAddon): void {
  const wasAtBottom = isTerminalAtBottom(term);
  fitAddon.fit();
  if (wasAtBottom && !isTerminalAtBottom(term)) term.scrollToBottom();
}

/**
 * Whether a terminal container can be measured.  A `display: none` container
 * leaves xterm at its default 80x24 and a zero-size one fits to 2x1; neither
 * is a size the PTY should ever be given (#2323).
 */
export function hasMeasurableSize(el: HTMLElement | null): el is HTMLElement {
  return !!el && el.clientWidth > 0 && el.clientHeight > 0;
}

export interface PtySize {
  cols: number;
  rows: number;
}

export interface TerminalFitOptions {
  /**
   * While `readyRef.current` is false (the mount is still replaying the
   * buffer snapshot at its recorded sizes) every trigger is skipped; the
   * mount calls `refit` once the replay is written.
   */
  readyRef?: RefObject<boolean>;
  /**
   * The PTY size this terminal's written output was produced at, when known.
   * A terminal that doesn't drive the PTY size adopts it instead of fitting
   * its container, so live output lines up (#2322).
   */
  ptySizeRef?: RefObject<PtySize | null>;
}

export interface TerminalFitControls {
  /** Fit and, if this terminal owns the PTY size and its window has focus, send it now. */
  refit: (trigger: string) => void;
  /** After the PTY size changed: adopt it (owner included, #2359). */
  syncToPty: () => void;
}

/** Resize `term` to the known PTY size.  False when no size is known. */
function followPtySize(term: Terminal, size: PtySize | null | undefined): boolean {
  if (!size) return false;
  resizeTerminal(term, size.cols, size.rows);
  return true;
}

/**
 * Manages terminal fit/resize with focus-awareness for multi-window and
 * multi-view correctness.
 *
 * Only the session's size owner in this window (see pty-size-owner) sends PTY
 * resizes, and only while its window has focus.  Other terminals of the same
 * session follow the PTY size (`ptySizeRef`) instead, or just fit when it is
 * unknown.  Triggers:
 * - Container size changes (ResizeObserver), with the PTY resize debounced
 * - Page becoming visible (covers wake-from-sleep, virtual desktop switch)
 * - Window gaining focus (active window re-asserts its terminal size)
 * - Terminal becoming the focused pane (`focused` prop), or taking DOM focus;
 *   both claim ownership
 * - The previous owner unmounting
 * - Device pixel ratio changes (monitor move, display scaling, zoom), which
 *   change the cell size without resizing the container (#2326)
 *
 * Hidden and zero-size containers are never measured (#2323).
 */
export function useTerminalFit(
  sessionId: string,
  terminalRef: RefObject<Terminal | null>,
  fitAddonRef: RefObject<FitAddon | null>,
  containerRef: RefObject<HTMLDivElement | null>,
  focused?: boolean,
  onResize?: (sessionId: string, cols: number, rows: number) => void,
  options: TerminalFitOptions = {},
): TerminalFitControls {
  const { readyRef, ptySizeRef } = options;
  const tokenRef = useRef<symbol | null>(null);
  if (!tokenRef.current) tokenRef.current = Symbol('terminal-size-owner');
  const fitRef = useRef<((sendResize: boolean, trigger: string, after?: () => void) => void) | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const token = tokenRef.current!;
    const doResize = onResize ?? window.clubhouse.pty.resize;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    /**
     * Fit the terminal to its container and, when `sendResize` is true and
     * this terminal owns the session's size, resize the PTY.  A terminal
     * that doesn't drive the size adopts the PTY's size when it is known.
     * `debounce` delays the PTY resize (not the fit) for continuous triggers.
     */
    const fitAndResize = (sendResize: boolean, trigger: string, after?: () => void, debounce = false) => {
      requestAnimationFrame(() => {
        const term = terminalRef.current;
        const fitAddon = fitAddonRef.current;
        if (!fitAddon || !term) return;
        if (readyRef && !readyRef.current) return;
        if (!hasMeasurableSize(containerRef.current)) return;
        const drive = sendResize && isSizeOwner(sessionId, token);
        // With a known PTY size the xterm only ever takes the PTY's size, on
        // PTY.RESIZED (syncToPty), so output is always parsed at the width it
        // was produced for; the owner just proposes its container's size.
        // Unknown PTY size (remote agents): fit right away, as before.
        const ptySize = ptySizeRef?.current;
        let proposed: PtySize | undefined;
        if (drive && ptySize) {
          const dims = fitAddon.proposeDimensions?.();
          if (dims && dims.cols > 0 && dims.rows > 0) proposed = { cols: dims.cols, rows: dims.rows };
        }
        if (proposed) {
          // Already the PTY's size: main would skip it, so adopt it here.
          if (proposed.cols === ptySize!.cols && proposed.rows === ptySize!.rows) followPtySize(term, ptySize);
        } else if (drive || !followPtySize(term, ptySize)) {
          fitPreservingScroll(term, fitAddon);
        }
        if (drive) {
          const size = proposed ?? { cols: term.cols, rows: term.rows };
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = null;
          if (debounce) {
            debounceTimer = setTimeout(() => {
              debounceTimer = null;
              if (terminalRef.current && isSizeOwner(sessionId, token) && document.hasFocus()) {
                doResize(sessionId, size.cols, size.rows);
              }
            }, RESIZE_DEBOUNCE_MS);
          } else {
            doResize(sessionId, size.cols, size.rows);
          }
        }
        after?.();
      });
    };
    fitRef.current = (sendResize, trigger, after) => fitAndResize(sendResize, trigger, after);

    const unregister = registerSizeOwner(sessionId, token, () => {
      fitAndResize(document.hasFocus(), 'owner-handoff');
    });

    // Container size changes: only resize PTY if this window is focused
    const resizeObserver = new ResizeObserver(() => {
      fitAndResize(document.hasFocus(), 'resize-observer', undefined, true);
    });
    resizeObserver.observe(container);

    // Wake from sleep / tab restore: delay the re-fit so the browser
    // layout engine can stabilise dimensions and font metrics first.
    let wakeTimer: ReturnType<typeof setTimeout> | null = null;
    const onVisibility = () => {
      if (!document.hidden) {
        // Several windows can become visible at once; only the focused one sends.
        wakeTimer = setTimeout(() => fitAndResize(document.hasFocus(), 'visibility-change'), WAKE_SETTLE_MS);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    // Window regains focus: ensure PTY matches this window's terminal size
    const onWindowFocus = () => fitAndResize(true, 'window-focus');
    window.addEventListener('focus', onWindowFocus);

    // Typing into (or clicking) this terminal makes it the size owner.  The
    // mount's own term.focus() doesn't count: it runs before the replay is
    // ready, and a newly mounted view must not take the size from another.
    const onFocusIn = () => {
      if (readyRef && !readyRef.current) return;
      if (isSizeOwner(sessionId, token)) return;
      claimSizeOwner(sessionId, token);
      fitAndResize(document.hasFocus(), 'focus-claim');
    };
    container.addEventListener('focusin', onFocusIn);

    // DPR change: xterm re-measures the cell size itself, but cols/rows only
    // change on fit().  Only the size owner in a focused window sends the PTY
    // resize; other views follow the PTY size.
    const removeDprListener = onDevicePixelRatioChange(() => {
      fitAndResize(document.hasFocus(), 'dpr-change');
    });

    return () => {
      removeDprListener();
      resizeObserver.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onWindowFocus);
      container.removeEventListener('focusin', onFocusIn);
      if (wakeTimer) clearTimeout(wakeTimer);
      if (debounceTimer) clearTimeout(debounceTimer);
      fitRef.current = null;
      unregister();
    };
  }, [sessionId, onResize]);

  // Pane-level focus: claim the size, re-fit, resize PTY, and focus the xterm
  // instance.  This fires when the user clicks a canvas card or switches to
  // the agents tab, so the PTY dimensions snap to the now-active terminal.
  useEffect(() => {
    if (!focused) return;
    claimSizeOwner(sessionId, tokenRef.current!);
    if (terminalRef.current) terminalRef.current.focus();
    // fit() reflow can blur xterm's helper textarea — refocus so the user can
    // type immediately after switching back to an actively streaming agent
    // (issue #1387).  A focused pane can still be hidden (behind the review
    // panel); the zero-size guard then skips the fit and the resize.
    fitRef.current?.(true, 'pane-focus', () => terminalRef.current?.focus());
  }, [focused, sessionId, onResize]);

  const refit = useCallback((trigger: string) => {
    // Like the ResizeObserver: a background window must not take the size.
    fitRef.current?.(document.hasFocus(), trigger);
  }, []);

  const syncToPty = useCallback(() => {
    const term = terminalRef.current;
    if (!term) return;
    followPtySize(term, ptySizeRef?.current);
  }, []);

  return { refit, syncToPty };
}
