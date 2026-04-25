import { useEffect, useMemo, useRef } from 'react';
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
  const hasGradientBg = useThemeStore((s) => s.experimentalGradients && !!s.theme.gradients?.background);
  const effectiveTerminalColors = useMemo(
    () => hasGradientBg ? { ...terminalColors, background: 'transparent' } : terminalColors,
    [terminalColors, hasGradientBg],
  );
  const experimentalMonoFont = useThemeStore(
    (s) => s.experimentalGradients ? (s.theme.fonts?.mono ?? s.theme.fontOverride) : undefined,
  );

  const ptyId = `utility_${agentId}`;

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      theme: effectiveTerminalColors,
      fontFamily: '"SF Mono", "Cascadia Code", "Fira Code", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.3,
      cursorBlink: true,
      cursorStyle: 'bar',
      allowProposedApi: true,
      allowTransparency: true,
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

    // Batch PTY data writes using rAF to avoid line-wrap glitches during
    // rapid output.  Matches the batching strategy in ShellTerminal.
    let batchedData = '';
    let flushScheduled = false;
    let flushId = 0;

    const removeDataListener = window.clubhouse.pty.onData(
      (id: string, data: string) => {
        if (id === ptyId) {
          batchedData += data;
          if (!flushScheduled) {
            flushScheduled = true;
            flushId = requestAnimationFrame(() => {
              const batch = batchedData;
              batchedData = '';
              flushScheduled = false;
              term.write(batch);
            });
          }
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
      if (flushScheduled) cancelAnimationFrame(flushId);
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
      terminalRef.current.options.theme = effectiveTerminalColors;
    }
  }, [effectiveTerminalColors]);

  useEffect(() => {
    if (!terminalRef.current || !experimentalMonoFont) return;
    terminalRef.current.options.fontFamily = experimentalMonoFont;
  }, [experimentalMonoFont]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full overflow-hidden"
      style={{ padding: '8px' }}
    />
  );
}
