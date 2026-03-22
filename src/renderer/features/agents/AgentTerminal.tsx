import { useCallback, useEffect, useRef, useMemo, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useThemeStore } from '../../stores/themeStore';
import { useClipboardSettingsStore } from '../../stores/clipboardSettingsStore';
import { useAgentStore } from '../../stores/agentStore';
import { useAnnexClientStore, satellitePtyDataBus } from '../../stores/annexClientStore';
import { isRemoteAgentId, parseNamespacedId } from '../../stores/remoteProjectStore';
import { attachClipboardHandlers, type ClipboardImageData } from '../terminal/clipboard';
import { useFileDrop } from '../terminal/useFileDrop';
import { useTerminalFit } from '../terminal/useTerminalFit';
import { ptyResize } from '../../services/project-proxy';

/** How long PTY output must be silent before we consider a resume "done". */
const RESUME_SETTLE_MS = 1500;

interface Props {
  agentId: string;
  focused?: boolean;
}

export function AgentTerminal({ agentId, focused }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalColors = useThemeStore((s) => s.theme.terminal);
  const hasGradientBg = useThemeStore((s) => s.experimentalGradients && !!s.theme.gradients?.background);
  const effectiveTerminalColors = useMemo(
    () => hasGradientBg ? { ...terminalColors, background: 'transparent' } : terminalColors,
    [terminalColors, hasGradientBg],
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

  // Debounce timer that detects when PTY output settles after a resume replay
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasReceivedDataRef = useRef(false);

  const finishResume = useCallback(() => {
    clearResuming(agentId);
    // Re-fit the terminal to fix rendering glitches from the replay burst
    requestAnimationFrame(() => {
      if (fitAddonRef.current && terminalRef.current) {
        fitAddonRef.current.fit();
        ptyResize(agentId, terminalRef.current.cols, terminalRef.current.rows);
      }
    });
  }, [agentId, clearResuming]);

  useEffect(() => { loadClipboard(); }, [loadClipboard]);

  useEffect(() => {
    if (!containerRef.current) return;

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
    term.open(containerRef.current);

    // Initial fit, replay buffered output, and focus
    requestAnimationFrame(() => {
      fitAddon.fit();
      ptyResize(agentId, term.cols, term.rows);
      term.focus();

      if (!isRemote) {
        // Replay buffered output so switching agents restores the terminal
        window.clubhouse.pty.getBuffer(agentId).then((buf: string) => {
          if (terminalRef.current !== term) return;
          if (buf) term.write(buf);
          for (const data of pendingData) term.write(data);
          pendingData.length = 0;
          bufferReplayed = true;
        });
      } else if (remoteParts) {
        // Remote agents: fetch buffer from satellite via HTTPS REST
        requestPtyBufferRef.current(remoteParts.satelliteId, remoteParts.agentId).then((buf: string) => {
          if (terminalRef.current !== term) return;
          if (buf) term.write(buf);
          for (const data of pendingData) term.write(data);
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

    // Gate live PTY data until after the buffer snapshot has been replayed;
    // queue data arriving during fetch to avoid silent data loss.
    let bufferReplayed = false;
    const pendingData: string[] = [];

    let removeDataListener: () => void;
    let removeExitListener: () => void;

    if (!isRemote) {
      // Local PTY: receive from local pty manager
      removeDataListener = window.clubhouse.pty.onData(
        (id: string, data: string) => {
          if (id !== agentId) return;
          if (bufferReplayed) {
            term.write(data);
          } else {
            pendingData.push(data);
          }
        }
      );

      removeExitListener = window.clubhouse.pty.onExit(
        (id: string, _exitCode: number) => {
          if (id === agentId && terminalRef.current) {
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
            term.write(data);
          } else {
            pendingData.push(data);
          }
        }
      );
      removeExitListener = () => {}; // No local exit event for remote agents
    }

    return () => {
      inputDisposable.dispose();
      removeDataListener();
      removeExitListener();
      term.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [agentId, isRemote, remoteParts]);

  // Focus-aware resize: ResizeObserver, visibilitychange, window focus, pane focus
  // Pass ptyResize so remote agents route resize through the Annex client, not local IPC
  useTerminalFit(agentId, terminalRef, fitAddonRef, containerRef, focused, ptyResize);

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

  // Live-update theme on existing terminal instances
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = effectiveTerminalColors;
    }
  }, [effectiveTerminalColors]);

  useEffect(() => {
    if (!terminalRef.current || !experimentalMonoFont) return;
    terminalRef.current.options.fontFamily = experimentalMonoFont;
  }, [experimentalMonoFont]);

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
      />
      {resuming && (
        <div
          data-testid="resume-overlay"
          className="absolute inset-0 flex flex-col items-center justify-center bg-ctp-base/90 z-10"
        >
          <div className="w-6 h-6 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin mb-3" />
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
          className="absolute bottom-2 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg bg-ctp-surface0/90 text-ctp-subtext0 text-xs font-medium shadow-lg z-10 pointer-events-none"
        >
          {remoteBanner}
        </div>
      )}
    </div>
  );
}
