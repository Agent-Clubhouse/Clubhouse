import { useCallback, useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useThemeStore } from '../../stores/themeStore';
import { useClipboardSettingsStore } from '../../stores/clipboardSettingsStore';
import { useAgentStore } from '../../stores/agentStore';
import { attachClipboardHandlers } from '../terminal/clipboard';

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
  const clipboardCompat = useClipboardSettingsStore((s) => s.clipboardCompat);
  const loadClipboard = useClipboardSettingsStore((s) => s.loadSettings);

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
        window.clubhouse.pty.resize(agentId, terminalRef.current.cols, terminalRef.current.rows);
      }
    });
  }, [agentId, clearResuming]);

  useEffect(() => { loadClipboard(); }, [loadClipboard]);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      theme: terminalColors,
      fontFamily: '"SF Mono", "Cascadia Code", "Fira Code", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.3,
      cursorBlink: true,
      cursorStyle: 'bar',
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    // Initial fit, replay buffered output, and focus
    requestAnimationFrame(() => {
      fitAddon.fit();
      window.clubhouse.pty.resize(agentId, term.cols, term.rows);
      term.focus();
      // Replay buffered output so switching agents restores the terminal
      window.clubhouse.pty.getBuffer(agentId).then((buf: string) => {
        if (terminalRef.current !== term) return;
        if (buf) term.write(buf);
        bufferReplayed = true;
      });
    });

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    // Forward user input to PTY
    const inputDisposable = term.onData((data) => {
      window.clubhouse.pty.write(agentId, data);
    });

    // Gate live PTY data until after the buffer snapshot has been replayed.
    // Without this, the same output can be written twice: once from the
    // real-time broadcast and again when getBuffer() resolves, causing
    // duplicate lines (e.g. the exec command appearing multiple times).
    let bufferReplayed = false;

    // Receive PTY output
    const removeDataListener = window.clubhouse.pty.onData(
      (id: string, data: string) => {
        if (id === agentId && bufferReplayed) {
          term.write(data);
        }
      }
    );

    // Reset terminal state when the PTY process exits.
    // CLI tools (e.g. Copilot CLI) can leave the terminal in alternate screen
    // buffer mode or with a hidden cursor if they crash or exit uncleanly.
    const removeExitListener = window.clubhouse.pty.onExit(
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

    // Resize observer
    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        if (fitAddonRef.current) {
          fitAddonRef.current.fit();
          if (terminalRef.current) {
            window.clubhouse.pty.resize(
              agentId,
              terminalRef.current.cols,
              terminalRef.current.rows
            );
          }
        }
      });
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      inputDisposable.dispose();
      removeDataListener();
      removeExitListener();
      resizeObserver.disconnect();
      term.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [agentId]);

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
    const cleanup = attachClipboardHandlers(
      terminalRef.current,
      containerRef.current,
      (data) => window.clubhouse.pty.write(agentId, data)
    );
    return cleanup;
  }, [clipboardCompat, agentId]);

  // Live-update theme on existing terminal instances
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = terminalColors;
    }
  }, [terminalColors]);

  useEffect(() => {
    if (focused && terminalRef.current) {
      terminalRef.current.focus();
    }
  }, [focused]);

  const handleMouseDown = useCallback(() => {
    terminalRef.current?.focus();
  }, []);

  return (
    <div className="relative w-full h-full">
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
    </div>
  );
}
