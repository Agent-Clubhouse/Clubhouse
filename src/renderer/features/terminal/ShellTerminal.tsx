import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useThemeStore } from '../../stores/themeStore';

interface Props {
  sessionId: string;
  focused?: boolean;
}

export function ShellTerminal({ sessionId, focused }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalColors = useThemeStore((s) => s.theme.terminal);

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
      resizeObserver.disconnect();
      term.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [sessionId]);

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
