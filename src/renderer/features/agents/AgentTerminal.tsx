import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

interface Props {
  agentId: string;
  focused?: boolean;
}

const CATPPUCCIN_THEME = {
  background: '#1e1e2e',
  foreground: '#cdd6f4',
  cursor: '#f5e0dc',
  cursorAccent: '#1e1e2e',
  selectionBackground: '#585b7066',
  selectionForeground: '#cdd6f4',
  black: '#45475a',
  red: '#f38ba8',
  green: '#a6e3a1',
  yellow: '#f9e2af',
  blue: '#89b4fa',
  magenta: '#f5c2e7',
  cyan: '#94e2d5',
  white: '#bac2de',
  brightBlack: '#585b70',
  brightRed: '#f38ba8',
  brightGreen: '#a6e3a1',
  brightYellow: '#f9e2af',
  brightBlue: '#89b4fa',
  brightMagenta: '#f5c2e7',
  brightCyan: '#94e2d5',
  brightWhite: '#a6adc8',
};

export function AgentTerminal({ agentId, focused }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      theme: CATPPUCCIN_THEME,
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
      resizeObserver.disconnect();
      term.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [agentId]);

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
