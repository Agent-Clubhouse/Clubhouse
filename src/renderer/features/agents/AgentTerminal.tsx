import { useCallback, useEffect, useRef, useMemo, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useThemeStore } from '../../stores/themeStore';
import { getTheme } from '../../themes';
import { useClipboardSettingsStore } from '../../stores/clipboardSettingsStore';
import { useAgentStore } from '../../stores/agentStore';
import { useAnnexClientStore, satellitePtyDataBus } from '../../stores/annexClientStore';
import { isRemoteAgentId, parseNamespacedId } from '../../stores/remoteProjectStore';
import { attachClipboardHandlers, type ClipboardImageData } from '../terminal/clipboard';
import { useFileDrop } from '../terminal/useFileDrop';
import { useTerminalFit, isTerminalAtBottom, fitPreservingScroll } from '../terminal/useTerminalFit';
import { unseenPtySuffix, isAsciiBinary } from '../terminal/pty-stream';
import { ptyResize } from '../../services/project-proxy';
import { rendererLog } from '../../plugins/renderer-logger';
import { Spinner } from '../../components/Spinner';
import { DurablePermissionPrompt } from './DurablePermissionPrompt';

/** How long PTY output must be silent before we consider a resume "done". */
const RESUME_SETTLE_MS = 1500;

const SCROLL_LOG_NS = 'ui:terminal:scroll';

/**
 * Window event that requests the currently-focused AgentTerminal to re-focus
 * its xterm.  Dispatched by the `focus-active-terminal` keyboard shortcut —
 * the user's escape hatch for the "can scroll but can't type" wedge where
 * xterm's hidden helper textarea lost focus (see the blur watchdog below).
 */
export const FOCUS_ACTIVE_TERMINAL_EVENT = 'clubhouse:focus-active-terminal';

/**
 * Minimum previous viewport line required before a jump to line 0 is logged
 * as a suspicious snap-to-top.  Prevents noise when there is little content.
 */
const JUMP_MIN_LINES = 3;

/** Throttle interval (ms) for periodic scroll-state debug logging. */
const SCROLL_LOG_THROTTLE_MS = 2000;

interface Props {
  agentId: string;
  focused?: boolean;
  /** Zone theme ID — when set, terminal uses this theme's colors instead of global. */
  zoneThemeId?: string;
}

export function AgentTerminal({ agentId, focused, zoneThemeId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  // xterm mounts into this unpadded child of the padded container: FitAddon
  // measures the xterm element's parent, so mounting directly into the padded
  // container counted the padding as terminal space and clipped the last row.
  const xtermHostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const globalTerminalColors = useThemeStore((s) => s.theme.terminal);
  const hasGradientBg = useThemeStore((s) => s.experimentalGradients && !!s.theme.gradients?.background);
  const terminalColors = useMemo(() => {
    if (zoneThemeId) {
      const zoneTheme = getTheme(zoneThemeId);
      if (zoneTheme) return zoneTheme.terminal;
    }
    return globalTerminalColors;
  }, [zoneThemeId, globalTerminalColors]);
  const effectiveTerminalColors = useMemo(
    () => hasGradientBg && !zoneThemeId ? { ...terminalColors, background: 'transparent' } : terminalColors,
    [terminalColors, hasGradientBg, zoneThemeId],
  );
  const experimentalMonoFont = useThemeStore(
    (s) => s.experimentalGradients ? (s.theme.fonts?.mono ?? s.theme.fontOverride) : undefined,
  );
  const clipboardCompat = useClipboardSettingsStore((s) => s.clipboardCompat);
  const loadClipboard = useClipboardSettingsStore((s) => s.loadSettings);

  const isRemote = isRemoteAgentId(agentId);
  const remoteParts = useMemo(() => isRemote ? parseNamespacedId(agentId) : null, [agentId, isRemote]);
  const sendPtyInput = useAnnexClientStore((s) => s.sendPtyInput);
  const sendClipboardImage = useAnnexClientStore((s) => s.sendClipboardImage);
  const requestPtyBuffer = useAnnexClientStore((s) => s.requestPtyBuffer);

  // Refs for Zustand store methods — prevents terminal destruction/recreation
  // if the store ever returns a new function reference during state updates.
  const sendPtyInputRef = useRef(sendPtyInput);
  sendPtyInputRef.current = sendPtyInput;
  const requestPtyBufferRef = useRef(requestPtyBuffer);
  requestPtyBufferRef.current = requestPtyBuffer;

  const resuming = useAgentStore((s) => s.agents[agentId]?.resuming);
  const clearResuming = useAgentStore((s) => s.clearResuming);

  // Tracks the latest `focused` prop so long-lived effects (blur watchdog,
  // post-reflow refocus calls) can read it without re-running on every
  // focus-prop flip, which would otherwise tear down and rebuild the xterm
  // listeners and lose input mid-session.
  const focusedRef = useRef(!!focused);
  useEffect(() => { focusedRef.current = !!focused; }, [focused]);

  // Debounce timer that detects when PTY output settles after a resume replay
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasReceivedDataRef = useRef(false);

  const finishResume = useCallback(() => {
    clearResuming(agentId);
    // Re-fit the terminal to fix rendering glitches from the replay burst.
    // Preserve scroll position — fit() triggers an xterm buffer reflow that
    // can jump the viewport to the top.
    requestAnimationFrame(() => {
      if (fitAddonRef.current && terminalRef.current) {
        fitPreservingScroll(terminalRef.current, fitAddonRef.current, agentId);

        ptyResize(agentId, terminalRef.current.cols, terminalRef.current.rows);
        // fit() reflow can blur xterm's helper textarea; re-focus if this
        // pane is still focused so the user can type immediately after
        // the resume overlay dismisses.
        if (focusedRef.current) terminalRef.current.focus();
      }
    });
  }, [agentId, clearResuming]);

  useEffect(() => { loadClipboard(); }, [loadClipboard]);

  useEffect(() => {
    if (!containerRef.current || !xtermHostRef.current) return;

    const term = new Terminal({
      theme: effectiveTerminalColors,
      fontFamily: '"SF Mono", "Cascadia Code", "Fira Code", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.3,
      scrollback: 10_000,
      cursorBlink: true,
      cursorStyle: 'bar',
      allowProposedApi: true,
      allowTransparency: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(xtermHostRef.current);

    // Blur watchdog — the "can scroll but can't type" recovery path.
    //
    // xterm.js routes every keystroke through a hidden <textarea> element
    // (.xterm-helper-textarea).  That textarea must hold DOM focus for
    // typing to work.  Several things can blur it with no recovery:
    //   • theme / font option mutations (xterm re-renders internals)
    //   • fitAddon.fit() reflows
    //   • large buffer replays on re-attach
    //   • Copilot CLI / other Ink TUIs enable mouse-tracking CSI
    //     sequences that cause xterm to intercept mousedown as a mouse
    //     report, so clicking the terminal does NOT reliably refocus
    //     the helper textarea
    //
    // When the textarea blurs to nothing (relatedTarget === null) while
    // this pane is still the focused pane in the app and the window
    // still has OS focus, re-focus xterm on the next microtask so we
    // don't fight whatever triggered the blur.  Any legitimate focus
    // move (user tabs or clicks something else) has a non-null
    // relatedTarget and is left alone.
    const helperTextarea = containerRef.current.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');
    const onHelperBlur = (ev: FocusEvent) => {
      if (ev.relatedTarget) return;
      if (!focusedRef.current) return;
      if (!document.hasFocus()) return;
      queueMicrotask(() => {
        if (terminalRef.current === term && focusedRef.current && document.hasFocus()) {
          term.focus();
        }
      });
    };
    helperTextarea?.addEventListener('blur', onHelperBlur);

    // Initial fit, replay buffered output, and focus
    requestAnimationFrame(() => {
      fitAddon.fit();
      ptyResize(agentId, term.cols, term.rows);
      term.focus();

      rendererLog(SCROLL_LOG_NS, 'debug', 'Terminal initialized', {
        meta: { agentId, isRemote, cols: term.cols, rows: term.rows },
      });

      if (!isRemote) {
        // Replay buffered output so switching agents restores the terminal.
        // The snapshot reports the output seq it includes; live chunks queued
        // (or still in flight) for that range are trimmed so data that landed
        // in both the snapshot and the live stream is written only once.
        window.clubhouse.pty.getBufferSnapshot(agentId).then(({ data: buf, seq }) => {
          if (terminalRef.current !== term) return;
          if (buf) {
            rendererLog(SCROLL_LOG_NS, 'debug', 'Buffer replay (local)', {
              meta: { agentId, bufLen: buf.length, seq },
            });
            term.write(buf);
          }
          appliedSeq = seq;
          for (const chunk of pendingData) {
            const fresh = takeUnseen(chunk.data, chunk.seq);
            if (fresh) term.write(fresh);
          }
          pendingData.length = 0;
          bufferReplayed = true;
          // Large writes (buf can approach the 2MB MAX_BUFFER_SIZE cap in
          // pty-manager) can stall the renderer long enough that focus is
          // dropped before the user sees a ready terminal.  Re-focus if
          // this pane is still the focused one.
          if (focusedRef.current) term.focus();
        }).catch((err: unknown) => {
          rendererLog(SCROLL_LOG_NS, 'error', 'Buffer replay failed (local)', {
            meta: { agentId, error: err instanceof Error ? err.message : String(err) },
          });
          for (const chunk of pendingData) term.write(chunk.data);
          pendingData.length = 0;
          bufferReplayed = true;
        });
      } else if (remoteParts) {
        // Remote agents: fetch buffer from satellite via HTTPS REST
        requestPtyBufferRef.current(remoteParts.satelliteId, remoteParts.agentId).then((buf: string) => {
          if (terminalRef.current !== term) return;
          if (buf) {
            rendererLog(SCROLL_LOG_NS, 'debug', 'Buffer replay (remote/annex)', {
              meta: { agentId, satelliteId: remoteParts.satelliteId, bufLen: buf.length },
            });
            term.write(buf);
          }
          for (const chunk of pendingData) term.write(chunk.data);
          pendingData.length = 0;
          bufferReplayed = true;
          if (focusedRef.current) term.focus();
        }).catch((err: unknown) => {
          rendererLog(SCROLL_LOG_NS, 'error', 'Buffer replay failed (remote/annex)', {
            meta: { agentId, satelliteId: remoteParts.satelliteId, error: err instanceof Error ? err.message : String(err) },
          });
          for (const chunk of pendingData) term.write(chunk.data);
          pendingData.length = 0;
          bufferReplayed = true;
        });
      }
    });

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    // Forward user input to PTY (local or remote)
    const inputDisposable = term.onData((data) => {
      if (!isRemote) {
        window.clubhouse.pty.write(agentId, data);
      } else if (remoteParts) {
        sendPtyInputRef.current(remoteParts.satelliteId, remoteParts.agentId, data);
      }
    });

    // Legacy (X10/normal) mouse reports arrive via onBinary, not onData.  The
    // string is binary (one char per byte), so the local path sends it over a
    // byte-preserving channel.  The remote input channel is text (UTF-8), so
    // only reports that are pure ASCII can be forwarded without corruption.
    const binaryDisposable = term.onBinary((data) => {
      if (!isRemote) {
        window.clubhouse.pty.writeBinary(agentId, data);
      } else if (remoteParts && isAsciiBinary(data)) {
        sendPtyInputRef.current(remoteParts.satelliteId, remoteParts.agentId, data);
      }
    });

    // Gate live PTY data until after the buffer snapshot has been replayed;
    // queue data arriving during fetch to avoid silent data loss.
    let bufferReplayed = false;
    const pendingData: Array<{ data: string; seq?: number }> = [];
    // Highest output seq written to the terminal (local PTY only).  -1 until
    // the snapshot arrives, so a failed snapshot fetch drops nothing.
    let appliedSeq = -1;
    const takeUnseen = (data: string, seq: number | undefined): string => {
      const fresh = unseenPtySuffix(data, seq, appliedSeq);
      if (seq !== undefined && seq > appliedSeq) appliedSeq = seq;
      return fresh;
    };
    let dataWriteCount = 0;
    let lastDataLogTime = 0;

    /** Log scroll state around data writes at a throttled rate. */
    const logDataWrite = (source: 'local' | 'annex', dataLen: number) => {
      dataWriteCount++;
      const now = Date.now();
      if (now - lastDataLogTime < SCROLL_LOG_THROTTLE_MS) return;
      lastDataLogTime = now;

      const { viewportY, baseY } = term.buffer.active;
      rendererLog(SCROLL_LOG_NS, 'debug', `PTY data write (${source})`, {
        meta: {
          agentId,
          dataLen,
          writeCount: dataWriteCount,
          viewportY,
          baseY,
          scrollPct: baseY > 0 ? Math.round((viewportY / baseY) * 100) : 100,
          atBottom: viewportY >= baseY,
        },
      });
    };

    let removeDataListener: () => void;
    let removeExitListener: () => void;

    // Batch PTY data writes using rAF to avoid line-wrap glitches during
    // rapid streaming.  Matches the batching strategy in ShellTerminal.
    let batchedData = '';
    let flushScheduled = false;
    let flushId = 0;

    const flushBatch = () => {
      const batch = batchedData;
      batchedData = '';
      flushScheduled = false;
      term.write(batch);
    };

    const enqueueWrite = (source: 'local' | 'annex', data: string) => {
      logDataWrite(source, data.length);
      batchedData += data;
      if (!flushScheduled) {
        flushScheduled = true;
        flushId = requestAnimationFrame(flushBatch);
      }
    };

    if (!isRemote) {
      // Local PTY: receive from local pty manager
      removeDataListener = window.clubhouse.pty.onData(
        (id: string, data: string, seq?: number) => {
          if (id !== agentId) return;
          if (bufferReplayed) {
            // Chunks merged in main before the snapshot was taken can still
            // arrive after it — trim anything the snapshot already contained.
            const fresh = takeUnseen(data, seq);
            if (fresh) enqueueWrite('local', fresh);
          } else {
            pendingData.push({ data, seq });
          }
        }
      );

      removeExitListener = window.clubhouse.pty.onExit(
        (id: string, _exitCode: number) => {
          if (id === agentId && terminalRef.current) {
            rendererLog(SCROLL_LOG_NS, 'info', 'PTY exited, resetting terminal state', {
              meta: { agentId, isRemote: false },
            });
            terminalRef.current.write(
              '\x1b[?1049l' + // exit alternate screen buffer
              '\x1b[?25h' +   // show cursor
              '\x1b[0m'       // reset text attributes
            );
          }
        }
      );
    } else {
      // Remote PTY: receive from satellite via WS
      const satId = remoteParts?.satelliteId;
      const origAgentId = remoteParts?.agentId;
      removeDataListener = satellitePtyDataBus.on(
        (incomingSatId: string, incomingAgentId: string, data: string) => {
          if (incomingSatId !== satId || incomingAgentId !== origAgentId) return;
          if (bufferReplayed) {
            enqueueWrite('annex', data);
          } else {
            pendingData.push({ data });
          }
        }
      );
      removeExitListener = () => {}; // No local exit event for remote agents
    }

    return () => {
      if (flushScheduled) cancelAnimationFrame(flushId);
      inputDisposable.dispose();
      binaryDisposable.dispose();
      removeDataListener();
      removeExitListener();
      helperTextarea?.removeEventListener('blur', onHelperBlur);
      term.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [agentId, isRemote, remoteParts]);

  // Focus-aware resize: ResizeObserver, visibilitychange, window focus, pane focus
  // Pass ptyResize so remote agents route resize through the Annex client, not local IPC
  useTerminalFit(agentId, terminalRef, fitAddonRef, containerRef, focused, ptyResize);

  // ── Scroll-to-bottom tracking ───────────────────────────────────
  // xterm 6 scrolls virtually: `.xterm-viewport` never scrolls (scrollTop
  // stays 0), so scroll state is read from the buffer via the public API.
  // Tracks whether the user is scrolled up so we can show a "scroll to
  // bottom" button, and emits throttled scroll-state logs for diagnosing
  // snap-to-top reports.
  const [isScrolledUp, setIsScrolledUp] = useState(false);
  const lastKnownViewportYRef = useRef<number>(0);
  const lastScrollLogRef = useRef<number>(0);

  useEffect(() => {
    const term = terminalRef.current;
    if (!term) return;

    const logMeta = { agentId, isRemote };

    const onScroll = () => {
      const { viewportY, baseY } = term.buffer.active;
      const atBottom = isTerminalAtBottom(term);
      const lastKnown = lastKnownViewportYRef.current;
      const scrollPct = baseY > 0 ? Math.round((viewportY / baseY) * 100) : 100;

      const now = Date.now();
      if (now - lastScrollLogRef.current > SCROLL_LOG_THROTTLE_MS) {
        lastScrollLogRef.current = now;
        rendererLog(SCROLL_LOG_NS, 'debug', 'Scroll state', {
          meta: { ...logMeta, viewportY, baseY, scrollPct, atBottom, lastKnown },
        });
      }

      if (viewportY === 0 && lastKnown >= JUMP_MIN_LINES && baseY > 0) {
        rendererLog(SCROLL_LOG_NS, 'info', 'Viewport jumped to top', {
          meta: { ...logMeta, viewportY, baseY, lastKnown },
        });
      }

      lastKnownViewportYRef.current = viewportY;
      setIsScrolledUp(!atBottom);
    };

    const scrollDisposable = term.onScroll(onScroll);
    // Switching to/from the alternate screen changes baseY without a scroll.
    const bufferDisposable = term.buffer.onBufferChange(onScroll);
    return () => {
      scrollDisposable.dispose();
      bufferDisposable.dispose();
    };
  }, [agentId, isRemote]);

  const handleScrollToBottom = useCallback(() => {
    const term = terminalRef.current;
    if (!term) return;
    term.scrollToBottom();
    lastKnownViewportYRef.current = term.buffer.active.viewportY;
    setIsScrolledUp(false);
  }, []);

  // Resume settle detection: watch PTY data and clear resuming after silence
  useEffect(() => {
    if (!resuming) return;

    hasReceivedDataRef.current = false;

    const removeListener = window.clubhouse.pty.onData(
      (id: string, _data: string) => {
        if (id !== agentId) return;
        hasReceivedDataRef.current = true;

        // Reset the settle timer on each data chunk
        if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
        settleTimerRef.current = setTimeout(() => {
          finishResume();
        }, RESUME_SETTLE_MS);
      }
    );

    // Safety fallback: if no data arrives within 10s, clear the overlay anyway
    const fallbackTimer = setTimeout(() => {
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
      finishResume();
    }, 10_000);

    return () => {
      removeListener();
      clearTimeout(fallbackTimer);
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    };
  }, [resuming, agentId, finishResume]);

  // Attach clipboard handlers only when clipboard compatibility is enabled
  useEffect(() => {
    if (!clipboardCompat || !terminalRef.current || !containerRef.current) return;
    const writeData = (data: string) => {
      if (!isRemote) {
        window.clubhouse.pty.write(agentId, data);
      } else if (remoteParts) {
        sendPtyInputRef.current(remoteParts.satelliteId, remoteParts.agentId, data);
      }
    };
    const handleImagePaste = (isRemote && remoteParts)
      ? (image: ClipboardImageData) => {
          sendClipboardImage(remoteParts.satelliteId, remoteParts.agentId, image.base64, image.mimeType);
        }
      : undefined;
    const cleanup = attachClipboardHandlers(terminalRef.current, containerRef.current, writeData, handleImagePaste);
    return cleanup;
  }, [clipboardCompat, agentId, isRemote, remoteParts, sendClipboardImage]);

  // Live-update theme on existing terminal instances.  Mutating xterm
  // options re-renders internals and can drop focus from the helper
  // textarea; re-focus when this pane is the active one so typing
  // doesn't silently stop after a theme swap.
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = effectiveTerminalColors;
      if (focusedRef.current) terminalRef.current.focus();
    }
  }, [effectiveTerminalColors]);

  useEffect(() => {
    if (!terminalRef.current || !experimentalMonoFont) return;
    terminalRef.current.options.fontFamily = experimentalMonoFont;
    if (focusedRef.current) terminalRef.current.focus();
  }, [experimentalMonoFont]);

  // Keyboard shortcut escape hatch: when the user fires
  // `focus-active-terminal` (default Ctrl/Cmd+Shift+T), the dispatcher in
  // app-event-bridge.ts emits FOCUS_ACTIVE_TERMINAL_EVENT on window.  The
  // active (focused) AgentTerminal re-focuses its xterm.  Multiple
  // AgentTerminal instances mount at once (canvas cards, popouts); only the
  // one with `focused === true` should respond so we don't steal focus.
  useEffect(() => {
    if (!focused) return;
    const onFocusRequest = () => {
      terminalRef.current?.focus();
    };
    window.addEventListener(FOCUS_ACTIVE_TERMINAL_EVENT, onFocusRequest);
    return () => window.removeEventListener(FOCUS_ACTIVE_TERMINAL_EVENT, onFocusRequest);
  }, [focused]);

  const [remoteBanner, setRemoteBanner] = useState<string | null>(null);
  const bannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showRemoteBanner = useCallback((msg: string) => {
    setRemoteBanner(msg);
    if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
    bannerTimerRef.current = setTimeout(() => setRemoteBanner(null), 3000);
  }, []);

  const handleMouseDown = useCallback(() => {
    terminalRef.current?.focus();
  }, []);

  const { isDragOver, handleDragOver, handleDragLeave, handleDrop } = useFileDrop(
    useCallback((data: string) => {
      if (isRemote) {
        // Local file paths don't exist on the remote satellite
        showRemoteBanner('File drop is not supported on remote agents');
        return;
      }
      window.clubhouse.pty.write(agentId, data);
      terminalRef.current?.focus();
    }, [agentId, isRemote, showRemoteBanner])
  );

  return (
    <div
      className="relative w-full h-full"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div
        ref={containerRef}
        data-testid="agent-terminal"
        className="w-full h-full overflow-hidden"
        style={{ padding: '8px' }}
        onMouseDown={handleMouseDown}
      >
        <div ref={xtermHostRef} className="w-full h-full" />
      </div>
      {/* Approve/deny for hook-driven permission requests. Remote agents are
          owned by their satellite host, which runs its own queue. */}
      {!isRemote && <DurablePermissionPrompt agentId={agentId} />}
      {/* Scroll-to-bottom floating button */}
      {isScrolledUp && !resuming && (
        <button
          data-testid="scroll-to-bottom"
          onClick={handleScrollToBottom}
          className="absolute top-2 right-2 z-10 flex items-center gap-1 px-2 py-1 rounded-md
            bg-surface-0/90 hover:bg-surface-1 text-ctp-subtext0 hover:text-ctp-text
            text-xs font-medium shadow-lg backdrop-blur-sm transition-all duration-150
            border border-surface-1/50"
          title="Scroll to bottom"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
          Bottom
        </button>
      )}
      {resuming && (
        <div
          data-testid="resume-overlay"
          className="absolute inset-0 flex flex-col items-center justify-center bg-ctp-base/90 z-10"
        >
          <Spinner size="lg" className="mb-3" />
          <span className="text-sm text-ctp-subtext0">Resuming session...</span>
        </div>
      )}
      {isDragOver && (
        <div className="absolute inset-0 bg-black/40 flex items-center justify-center pointer-events-none z-10">
          <span className="text-white/90 text-sm font-medium">
            {isRemote ? 'File drop not supported on remote' : 'Drop to insert path'}
          </span>
        </div>
      )}
      {remoteBanner && (
        <div
          data-testid="remote-banner"
          className="absolute bottom-2 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg bg-surface-0/90 text-ctp-subtext0 text-xs font-medium shadow-lg z-10 pointer-events-none"
        >
          {remoteBanner}
        </div>
      )}
    </div>
  );
}
