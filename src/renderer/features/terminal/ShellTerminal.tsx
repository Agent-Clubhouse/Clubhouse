import { useCallback, useEffect, useRef } from 'react';
import { useFileDrop } from './useFileDrop';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useThemeStore } from '../../stores/themeStore';
import { useClipboardSettingsStore } from '../../stores/clipboardSettingsStore';
import { attachClipboardHandlers } from './clipboard';
import { registerTerminalEditHandler, unregisterTerminalEditHandler } from './terminal-edit-handler';
import type { RegisteredTerminal } from './terminal-edit-handler';
import { useTerminalFit } from './useTerminalFit';

interface Props {
  sessionId: string;
  focused?: boolean;
}

export function ShellTerminal({ sessionId, focused }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalColors = useThemeStore((s) => s.theme.terminal);
  const experimentalMonoFont = useThemeStore(
    (s) => s.experimentalGradients ? (s.theme.fonts?.mono ?? s.theme.fontOverride) : undefined,
  );
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

    // Intercept Shift+Enter and Ctrl+Enter to insert a newline instead of
    // executing the command.  We write a literal newline (\n) to the PTY —
    // most shells (zsh, bash, fish) treat this as a line continuation when
    // the input is incomplete, and PSReadLine on Windows handles it natively.
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type === 'keydown' && ev.key === 'Enter' && (ev.shiftKey || ev.ctrlKey)) {
        window.clubhouse.pty.write(sessionId, '\n');
        return false; // prevent xterm from emitting \r
      }
      return true;
    });

    const inputDisposable = term.onData((data) => {
      window.clubhouse.pty.write(sessionId, data);
    });

    // Batch PTY data writes using rAF to avoid 100+ DOM renders/sec.
    // Data arriving between frames is concatenated and flushed once per paint.
    let pendingData = '';
    let flushScheduled = false;
    let flushId = 0;

    const removeDataListener = window.clubhouse.pty.onData(
      (id: string, data: string) => {
        if (id === sessionId) {
          pendingData += data;
          if (!flushScheduled) {
            flushScheduled = true;
            flushId = requestAnimationFrame(() => {
              const batch = pendingData;
              pendingData = '';
              flushScheduled = false;
              term.write(batch);
            });
          }
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

    return () => {
      if (flushId) cancelAnimationFrame(flushId);
      inputDisposable.dispose();
      removeDataListener();
      removeExitListener();
      term.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [sessionId]);

  // Focus-aware resize: ResizeObserver, visibilitychange, window focus, pane focus
  useTerminalFit(sessionId, terminalRef, fitAddonRef, containerRef, focused);

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

  // Register with the terminal edit-command handler so that Electron menu
  // shortcuts (Cmd+V, Cmd+C, Cmd+A) route to this terminal when focused.
  // This is needed because the Electron menu accelerator intercepts the
  // keyboard event before it reaches xterm.js.
  useEffect(() => {
    if (!terminalRef.current || !containerRef.current) return;
    const entry: RegisteredTerminal = {
      term: terminalRef.current,
      writeToPty: (data) => window.clubhouse.pty.write(sessionId, data),
      container: containerRef.current,
    };
    registerTerminalEditHandler(entry);
    return () => unregisterTerminalEditHandler(entry);
  }, [sessionId]);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = terminalColors;
    }
  }, [terminalColors]);

  useEffect(() => {
    if (!terminalRef.current || !experimentalMonoFont) return;
    terminalRef.current.options.fontFamily = experimentalMonoFont;
  }, [experimentalMonoFont]);

  const handleMouseDown = useCallback(() => {
    terminalRef.current?.focus();
  }, []);

  const { isDragOver, handleDragOver, handleDragLeave, handleDrop } = useFileDrop(
    useCallback((data: string) => {
      window.clubhouse.pty.write(sessionId, data);
      terminalRef.current?.focus();
    }, [sessionId])
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
        data-testid="shell-terminal"
        className="w-full h-full overflow-hidden"
        style={{ padding: '8px' }}
        onMouseDown={handleMouseDown}
      />
      {isDragOver && (
        <div className="absolute inset-0 bg-black/40 flex items-center justify-center pointer-events-none z-10">
          <span className="text-white/90 text-sm font-medium">Drop to insert path</span>
        </div>
      )}
    </div>
  );
}
