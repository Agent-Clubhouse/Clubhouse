import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useProjectStore } from '../../stores/projectStore';
import { useThemeStore } from '../../stores/themeStore';

const PTY_ID = 'standalone-terminal';

export function StandaloneTerminal() {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const { projects, activeProjectId } = useProjectStore();
  const projectPath = projects.find((p) => p.id === activeProjectId)?.path;
  const terminalColors = useThemeStore((s) => s.theme.terminal);

  useEffect(() => {
    if (!containerRef.current || !projectPath) return;

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
      window.clubhouse.pty.resize(PTY_ID, term.cols, term.rows);
      term.focus();
    });

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    // Spawn the shell
    window.clubhouse.pty.spawnShell(PTY_ID, projectPath);

    // Forward user input to PTY
    const inputDisposable = term.onData((data) => {
      window.clubhouse.pty.write(PTY_ID, data);
    });

    // Receive PTY output
    const removeDataListener = window.clubhouse.pty.onData(
      (id: string, data: string) => {
        if (id === PTY_ID) {
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
              PTY_ID,
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
      window.clubhouse.pty.kill(PTY_ID);
    };
  }, [projectPath]);

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
      onClick={() => terminalRef.current?.focus()}
    />
  );
}
