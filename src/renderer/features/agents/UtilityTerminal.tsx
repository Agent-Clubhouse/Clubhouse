import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useThemeStore } from '../../stores/themeStore';

interface Props {
  agentId: string;
  worktreePath: string;
}

export function UtilityTerminal({ agentId, worktreePath }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalColors = useThemeStore((s) => s.theme.terminal);

  const ptyId = `utility_${agentId}`;

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
      window.clubhouse.pty.resize(ptyId, term.cols, term.rows);
    });

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    // Kill any leftover PTY from a previous mount, then spawn fresh
    window.clubhouse.pty.kill(ptyId).catch(() => {}).then(() => {
      window.clubhouse.pty.spawnShell(ptyId, worktreePath);
    });

    const inputDisposable = term.onData((data) => {
      window.clubhouse.pty.write(ptyId, data);
    });

    const removeDataListener = window.clubhouse.pty.onData(
      (id: string, data: string) => {
        if (id === ptyId) {
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
              ptyId,
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
      window.clubhouse.pty.kill(ptyId);
    };
  }, [ptyId, worktreePath]);

  // Live-update theme on existing terminal instances
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = terminalColors;
    }
  }, [terminalColors]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full overflow-hidden"
      style={{ padding: '8px' }}
    />
  );
}
