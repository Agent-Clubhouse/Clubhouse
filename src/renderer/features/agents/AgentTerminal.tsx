import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useThemeStore } from '../../stores/themeStore';
import { useClipboardSettingsStore } from '../../stores/clipboardSettingsStore';
import { attachClipboardHandlers } from '../terminal/clipboard';

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
        if (buf && terminalRef.current === term) {
          term.write(buf);
        }
      });
    });

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    // Forward user input to PTY
    const inputDisposable = term.onData((data) => {
      window.clubhouse.pty.write(agentId, data);
    });

    // Receive PTY output
    const removeDataListener = window.clubhouse.pty.onData(
      (id: string, data: string) => {
        if (id === agentId) {
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

  return (
    <div
      ref={containerRef}
      className="w-full h-full overflow-hidden"
      style={{ padding: '8px' }}
    />
  );
}
