import { useCallback, useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useThemeStore } from '../../stores/themeStore';
import { useClipboardSettingsStore } from '../../stores/clipboardSettingsStore';
import { attachClipboardHandlers } from './clipboard';

interface Props {
  sessionId: string;
  focused?: boolean;
}

export function ShellTerminal({ sessionId, focused }: Props) {
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

    requestAnimationFrame(() => {
      fitAddon.fit();
      window.clubhouse.pty.resize(sessionId, term.cols, term.rows);
      term.focus();
      window.clubhouse.pty.getBuffer(sessionId).then((buf: string) => {
        if (buf && terminalRef.current === term) {
          term.write(buf);
        }
      });
    });

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    const inputDisposable = term.onData((data) => {
      window.clubhouse.pty.write(sessionId, data);
    });

    const removeDataListener = window.clubhouse.pty.onData(
      (id: string, data: string) => {
        if (id === sessionId) {
          term.write(data);
        }
      }
    );

    // Reset terminal state when the PTY process exits.
    const removeExitListener = window.clubhouse.pty.onExit(
      (id: string, _exitCode: number) => {
        if (id === sessionId && terminalRef.current) {
          terminalRef.current.write(
            '\x1b[?1049l' + // exit alternate screen buffer
            '\x1b[?25h' +   // show cursor
            '\x1b[0m'       // reset text attributes
          );
        }
      }
    );

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        if (fitAddonRef.current) {
          fitAddonRef.current.fit();
          if (terminalRef.current) {
            window.clubhouse.pty.resize(
              sessionId,
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
  }, [sessionId]);

  // Attach clipboard handlers only when clipboard compatibility is enabled
  useEffect(() => {
    if (!clipboardCompat || !terminalRef.current || !containerRef.current) return;
    const cleanup = attachClipboardHandlers(
      terminalRef.current,
      containerRef.current,
      (data) => window.clubhouse.pty.write(sessionId, data)
    );
    return cleanup;
  }, [clipboardCompat, sessionId]);

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
    <div
      ref={containerRef}
      data-testid="shell-terminal"
      className="w-full h-full overflow-hidden"
      style={{ padding: '8px' }}
      onMouseDown={handleMouseDown}
    />
  );
}
