import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useFileDrop } from './useFileDrop';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { localWindowsPtyOptions } from './windows-pty';
import { useThemeStore } from '../../stores/themeStore';
import { useClipboardSettingsStore } from '../../stores/clipboardSettingsStore';
import { attachClipboardHandlers } from './clipboard';
import { useTerminalFit, hasMeasurableSize, type PtySize, type TerminalFitControls } from './useTerminalFit';
import { unseenPtySuffix, isAsciiBinary, writeAsync } from './pty-stream';
import { writePtySnapshot, type PtyBufferSnapshot } from '../../../shared/pty-snapshot';

/**
 * Abstraction over terminal I/O operations, allowing ShellTerminal to work
 * with both local PTY (window.clubhouse.pty) and remote Annex terminals.
 */
export interface TerminalIO {
  write(sessionId: string, data: string): void;
  /**
   * Write a binary string (one char per byte, from xterm `onBinary`) without
   * UTF-8 encoding it.  When absent, only pure-ASCII binary input is sent,
   * via `write`.
   */
  writeBinary?(sessionId: string, data: string): void;
  resize(sessionId: string, cols: number, rows: number): void;
  getBuffer(sessionId: string): Promise<string>;
  /**
   * Buffer plus the output seq it includes.  When provided, live `onData`
   * chunks carrying a seq are trimmed against it so output that landed in both
   * the snapshot and the live stream is written once.  When it also carries
   * `sizes`, each part is replayed at the PTY size it was written at.
   */
  getBufferSnapshot?(sessionId: string): Promise<PtyBufferSnapshot>;
  onData(callback: (id: string, data: string, seq?: number) => void): () => void;
  onExit(callback: (id: string, exitCode: number) => void): () => void;
  /** PTY size changes, sent after the output produced at the old size. */
  onResized?(callback: (id: string, cols: number, rows: number) => void): () => void;
}

interface ReplayState {
  replayed: boolean;
  /** Highest output seq written to the terminal; -1 before the snapshot. */
  appliedSeq: number;
  pending: Array<{ data: string; seq?: number }>;
  /** The snapshot has been received; resizes after this are newer than it. */
  snapshotApplied: boolean;
  resizedDuringReplay: PtySize | null;
}

interface Props {
  sessionId: string;
  focused?: boolean;
  io?: TerminalIO;
}

export function ShellTerminal({ sessionId, focused, io }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  // xterm mounts into this unpadded child of the padded container: FitAddon
  // measures the xterm element's parent, so mounting directly into the padded
  // container counted the padding as terminal space and clipped the last row.
  const xtermHostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  // Use a ref for the IO layer so that changes to `io` don't trigger a full
  // terminal destruction/recreation cycle.  The terminal instance is expensive
  // to rebuild — it replays the entire buffer, resets scroll position, and
  // causes a visible flash.  All IO call-sites read through the ref instead.
  const ptyRef = useRef<TerminalIO>(io ?? window.clubhouse.pty);
  ptyRef.current = io ?? window.clubhouse.pty;

  // Snapshot/live stitching shared by the creation and IO effects: live data
  // is queued until the buffer snapshot has been written, then trimmed
  // against the snapshot's seq.
  const replayRef = useRef<ReplayState>({ replayed: false, appliedSeq: -1, pending: [], snapshotApplied: false, resizedDuringReplay: null });
  // Mirrors `replayRef.current.replayed` for useTerminalFit, which must not
  // fit or resize while the snapshot is still being written.
  const readyRef = useRef(false);
  // PTY size the written output was produced at; followed when this view
  // doesn't own the session's size (#2322).
  const ptySizeRef = useRef<PtySize | null>(null);
  const fitControlsRef = useRef<TerminalFitControls | null>(null);

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

  useEffect(() => { loadClipboard(); }, [loadClipboard]);

  // ── Terminal creation — only depends on sessionId ────────────────
  useEffect(() => {
    if (!containerRef.current || !xtermHostRef.current) return;

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
    term.open(xtermHostRef.current);

    const replay: ReplayState = { replayed: false, appliedSeq: -1, pending: [], snapshotApplied: false, resizedDuringReplay: null };
    replayRef.current = replay;
    readyRef.current = false;
    ptySizeRef.current = null;
    // Write queued live data (parsed before any resize, since it was produced
    // at the PTY's current size), then fit and size the PTY.  Fitting after
    // the replay keeps the shell's repaint for the new size on top of the
    // restored screen (#2321).
    const flushPending = async () => {
      while (replay.pending.length > 0) {
        let batch = '';
        for (const chunk of replay.pending.splice(0)) {
          batch += unseenPtySuffix(chunk.data, chunk.seq, replay.appliedSeq);
          if (chunk.seq !== undefined && chunk.seq > replay.appliedSeq) replay.appliedSeq = chunk.seq;
        }
        if (batch) await writeAsync(term, batch).catch((): void => undefined); // telemetry-exempt: xterm drops writes past its buffer cap; the replay must still finish
      }
      if (terminalRef.current !== term) return;
      if (replay.resizedDuringReplay) ptySizeRef.current = replay.resizedDuringReplay;
      replay.replayed = true;
      readyRef.current = true;
      // The size owner fits and sizes the PTY; other views follow it.  Hidden
      // or zero-size containers are skipped (they fit to 80x24 or 2x1,
      // #2323); the ResizeObserver sizes the PTY once they are laid out.
      fitControlsRef.current?.refit('mount');
    };

    requestAnimationFrame(() => {
      term.focus();
      const pty = ptyRef.current;
      const snapshot: Promise<PtyBufferSnapshot> = pty.getBufferSnapshot
        ? pty.getBufferSnapshot(sessionId)
        : pty.getBuffer(sessionId).then((data) => ({ data, seq: -1 }));
      snapshot.then(async (snap) => {
        if (terminalRef.current !== term) return;
        // Resizes from here on happened after main built the snapshot.
        replay.snapshotApplied = true;
        // Unsized history (older or remote IO): write at this pane's size.
        if (!snap.sizes?.length && hasMeasurableSize(containerRef.current)) fitAddon.fit();
        await writePtySnapshot(term, snap);
        if (terminalRef.current !== term) return;
        replay.appliedSeq = snap.seq;
        const last = snap.sizes?.[snap.sizes.length - 1];
        if (last) ptySizeRef.current = { cols: last.cols, rows: last.rows };
        await flushPending();
      }).catch(() => {
        if (terminalRef.current !== term) return;
        void flushPending();
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
        ptyRef.current.write(sessionId, '\n');
        return false; // prevent xterm from emitting \r
      }
      return true;
    });

    const inputDisposable = term.onData((data) => {
      ptyRef.current.write(sessionId, data);
    });

    // Legacy (X10/normal) mouse reports arrive via onBinary as a binary
    // string; send them byte-for-byte rather than UTF-8 encoded.
    const binaryDisposable = term.onBinary((data) => {
      const pty = ptyRef.current;
      if (pty.writeBinary) {
        pty.writeBinary(sessionId, data);
      } else if (isAsciiBinary(data)) {
        pty.write(sessionId, data);
      }
    });

    return () => {
      inputDisposable.dispose();
      binaryDisposable.dispose();
      term.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [sessionId]);

  // ── IO event listeners — re-registered when io changes ───────────
  // Separated from terminal creation so that an IO change (e.g. satellite
  // reconnect) only re-subscribes listeners without destroying the terminal.
  useEffect(() => {
    const term = terminalRef.current;
    if (!term) return;

    // Only a local PTY can be ConPTY. A remote (canvas satellite) PTY's
    // platform is unknown, so it gets no hint (#2320). Set here rather than at
    // creation because `io` can change while the terminal stays mounted.
    const windowsPty = io ? {} : (localWindowsPtyOptions().windowsPty ?? {});
    if (windowsPty.backend !== term.options.windowsPty?.backend) term.options.windowsPty = windowsPty;

    const pty = ptyRef.current;

    // Batch PTY data writes using rAF to avoid 100+ DOM renders/sec.
    // Data arriving between frames is concatenated and flushed once per paint.
    let pendingData = '';
    let flushScheduled = false;
    let flushId = 0;
    const flushBatch = () => {
      const batch = pendingData;
      pendingData = '';
      flushScheduled = false;
      term.write(batch);
    };

    const removeDataListener = pty.onData(
      (id: string, incoming: string, seq?: number) => {
        if (id === sessionId) {
          const replay = replayRef.current;
          if (!replay.replayed) {
            replay.pending.push({ data: incoming, seq });
            return;
          }
          const data = unseenPtySuffix(incoming, seq, replay.appliedSeq);
          if (seq !== undefined && seq > replay.appliedSeq) replay.appliedSeq = seq;
          if (!data) return;
          pendingData += data;
          if (!flushScheduled) {
            flushScheduled = true;
            flushId = requestAnimationFrame(flushBatch);
          }
        }
      }
    );

    // The PTY was resized: write what is batched (produced at the old size),
    // then adopt the new size unless this view drives it.
    const removeResizedListener = pty.onResized?.((id: string, cols: number, rows: number) => {
      if (id !== sessionId) return;
      const replay = replayRef.current;
      if (!replay.replayed) {
        if (replay.snapshotApplied) replay.resizedDuringReplay = { cols, rows };
        return;
      }
      ptySizeRef.current = { cols, rows };
      if (flushScheduled) {
        cancelAnimationFrame(flushId);
        flushBatch();
      }
      term.write('', () => {
        if (terminalRef.current === term) fitControlsRef.current?.syncToPty();
      });
    }) ?? (() => {});

    // Reset terminal state when the PTY process exits.
    const removeExitListener = pty.onExit(
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
      removeDataListener();
      removeExitListener();
      removeResizedListener();
    };
  }, [sessionId, io]);

  // Focus-aware resize: ResizeObserver, visibilitychange, window focus, pane focus
  const resizeCallback = useCallback(
    (sid: string, cols: number, rows: number) => ptyRef.current.resize(sid, cols, rows),
    [],
  );
  fitControlsRef.current = useTerminalFit(
    sessionId, terminalRef, fitAddonRef, containerRef, focused, resizeCallback, { readyRef, ptySizeRef },
  );

  // Attach clipboard handlers only when clipboard compatibility is enabled
  useEffect(() => {
    if (!clipboardCompat || !terminalRef.current || !containerRef.current) return;
    const cleanup = attachClipboardHandlers(
      terminalRef.current,
      containerRef.current,
      (data) => ptyRef.current.write(sessionId, data)
    );
    return cleanup;
  }, [clipboardCompat, sessionId]);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = effectiveTerminalColors;
    }
  }, [effectiveTerminalColors]);

  useEffect(() => {
    if (!terminalRef.current || !experimentalMonoFont) return;
    terminalRef.current.options.fontFamily = experimentalMonoFont;
  }, [experimentalMonoFont]);

  const handleMouseDown = useCallback(() => {
    terminalRef.current?.focus();
  }, []);

  const { isDragOver, handleDragOver, handleDragLeave, handleDrop } = useFileDrop(
    useCallback((data: string) => {
      ptyRef.current.write(sessionId, data);
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
      >
        <div ref={xtermHostRef} className="w-full h-full" />
      </div>
      {isDragOver && (
        <div className="absolute inset-0 bg-black/40 flex items-center justify-center pointer-events-none z-10">
          <span className="text-white/90 text-sm font-medium">Drop to insert path</span>
        </div>
      )}
    </div>
  );
}
