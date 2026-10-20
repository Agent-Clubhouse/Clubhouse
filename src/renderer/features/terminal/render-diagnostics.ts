/**
 * Content-free render diagnostics for one mounted xterm (`ui:terminal:render`).
 *
 * Records what is needed to explain a duplicated or re-drawn terminal after
 * the fact, without terminal content: how the buffer replay stitched to the
 * live stream (seq overlap, re-delivered chunks, gaps), size changes and who
 * sent them, the repaint the child emitted after a resize, alternate-screen
 * switches, synchronized-output frames and screen/scrollback clears.
 *
 * Lines are info level (anomalies warn) so the default logging settings keep
 * them, and each kind of line is rate-limited per terminal.
 */
import type { IDisposable, Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { rendererLog } from '../../plugins/renderer-logger';
import { createDiagRateLimiter } from '../../../shared/diag-rate-limiter';

export const RENDER_LOG_NS = 'ui:terminal:render';

/** Per terminal and line kind: at most 6 lines a minute. */
const LINES_PER_WINDOW = 6;
const LINE_WINDOW_MS = 60_000;

/** How long after a sent resize output counts as the child's repaint. */
export const POST_RESIZE_WINDOW_MS = 1000;

/** DEC private mode for synchronized output. */
const SYNC_OUTPUT_MODE = 2026;

export type LiveChunkKind = 'fresh' | 'covered' | 'overlap' | 'duplicate' | 'gap' | 'unsequenced';

/**
 * Classify a PTY chunk before seq trimming.
 *
 * `seq` is the output seq at the END of the chunk, so it spans
 * `[seq - length, seq)` (see `unseenPtySuffix`). `appliedSeq` is the highest
 * seq written to the terminal (snapshot included); `deliveredSeq` is the
 * highest seq of any chunk delivered before this one.
 *
 * - `covered`/`overlap`: wholly/partly inside what was already written. Normal
 *   right after a snapshot, since main merges broadcasts on a 16 ms timer.
 * - `duplicate`: a seq already delivered as a chunk, i.e. sent twice.
 * - `gap`: starts after the last written seq, so output is missing.
 *
 * `chars` is the overlapping length, or the missing length for `gap`.
 */
export function classifyChunk(
  length: number,
  seq: number | undefined,
  appliedSeq: number,
  deliveredSeq = -1,
): { kind: LiveChunkKind; chars: number } {
  if (seq === undefined) return { kind: 'unsequenced', chars: 0 };
  if (deliveredSeq >= 0 && seq <= deliveredSeq) return { kind: 'duplicate', chars: length };
  if (appliedSeq < 0) return { kind: 'fresh', chars: 0 };
  if (seq <= appliedSeq) return { kind: 'covered', chars: length };
  const start = seq - length;
  if (start < appliedSeq) return { kind: 'overlap', chars: appliedSeq - start };
  if (start > appliedSeq) return { kind: 'gap', chars: start - appliedSeq };
  return { kind: 'fresh', chars: 0 };
}

/** Terminals mounted per session id in this window (several views can show one agent). */
const mountedTerminals = new Map<string, number>();

let now: () => number = Date.now;
/** Shared across mounts so remounting a terminal doesn't reset its line budget. */
let limiter = createDiagRateLimiter(LINES_PER_WINDOW, LINE_WINDOW_MS, () => now());

/** Test seam: reset shared state and optionally inject a clock. */
export function _resetRenderDiagnosticsForTests(clock: () => number = Date.now): void {
  mountedTerminals.clear();
  now = clock;
  limiter = createDiagRateLimiter(LINES_PER_WINDOW, LINE_WINDOW_MS, () => now());
}

export function mountedTerminalCount(sessionId: string): number {
  return mountedTerminals.get(sessionId) ?? 0;
}

export interface TerminalRenderDiagnostics {
  /** Hook the terminal's parser and buffer events. Call once after `open()`. */
  attach(term: Terminal, fitAddon?: FitAddon): void;
  /** A buffer snapshot is about to be written. */
  beginReplay(source: 'local' | 'remote', snapshotLength: number, snapshotSeq?: number): void;
  /** The snapshot has been parsed: later parser events are live output, not history. */
  snapshotParsed(): void;
  /** A live chunk that queued during the snapshot fetch, checked against the snapshot. */
  replayChunk(length: number, seq: number | undefined, appliedSeq: number): void;
  /** The replay (snapshot and queued chunks) is done, or failed: logs the summary. */
  endReplay(failed?: boolean): void;
  /** A live chunk after the replay, before seq trimming. */
  liveChunk(length: number, seq: number | undefined, appliedSeq: number): void;
  /** The PTY exited: a respawn under the same id starts at a higher seq, so the next jump is expected. */
  ptyExited(): void;
  /** The terminal was fitted; `sent` when the size was also sent to the PTY. */
  resize(trigger: string, cols: number, rows: number, sent: boolean): void;
  dispose(): void;
}

interface Counters {
  chunks: number;
  covered: number;
  coveredChars: number;
  overlaps: number;
  overlapChars: number;
  duplicates: number;
  duplicateChars: number;
  gaps: number;
  gapChars: number;
  unsequenced: number;
}

function emptyCounters(): Counters {
  return { chunks: 0, covered: 0, coveredChars: 0, overlaps: 0, overlapChars: 0, duplicates: 0, duplicateChars: 0, gaps: 0, gapChars: 0, unsequenced: 0 };
}

function count(c: Counters, kind: LiveChunkKind, chars: number): void {
  c.chunks++;
  if (kind === 'covered') { c.covered++; c.coveredChars += chars; }
  else if (kind === 'overlap') { c.overlaps++; c.overlapChars += chars; }
  else if (kind === 'duplicate') { c.duplicates++; c.duplicateChars += chars; }
  else if (kind === 'gap') { c.gaps++; c.gapChars += chars; }
  else if (kind === 'unsequenced') c.unsequenced++;
}

interface PostResize {
  cols: number;
  rows: number;
  chars: number;
  chunks: number;
  clearScreens: number;
  clearScrollbacks: number;
  syncFrames: number;
  timer: ReturnType<typeof setTimeout>;
}

export function createTerminalRenderDiagnostics(opts: {
  sessionId: string;
  surface: 'agent' | 'shell';
  remote: boolean;
}): TerminalRenderDiagnostics {
  const { sessionId, surface, remote } = opts;
  const mountedAt = now();
  const platform = window.clubhouse?.platform;
  mountedTerminals.set(sessionId, mountedTerminalCount(sessionId) + 1);

  let term: Terminal | null = null;
  const disposables: IDisposable[] = [];
  let dprCleanup: (() => void) | null = null;

  const live = emptyCounters();
  let replay: (Counters & { source: 'local' | 'remote'; snapshotLength: number; snapshotSeq?: number; startedAt: number }) | null = null;
  /** True from beginReplay until the snapshot is parsed: parser events then belong to history. */
  let replaying = false;
  const replayParsed = { altScreenToggles: 0, clearScreens: 0, clearScrollbacks: 0, syncFrames: 0 };
  const totals = { altScreenToggles: 0, clearScreens: 0, clearScrollbacks: 0, syncFrames: 0, resizesSent: 0 };

  let lastCols = -1;
  let lastRows = -1;
  let unchangedFits = 0;
  let postResize: PostResize | null = null;
  let disposed = false;
  /** Highest seq of any chunk delivered so far (queued or live). */
  let deliveredSeq = -1;
  /** Set on PTY exit: the respawned session's first chunk jumps ahead in seq. */
  let expectSeqJump = false;
  let respawnJumps = 0;

  const classify = (length: number, seq: number | undefined, appliedSeq: number) => {
    const result = classifyChunk(length, seq, appliedSeq, deliveredSeq);
    if (seq !== undefined) {
      if (seq > deliveredSeq) deliveredSeq = seq;
      if (expectSeqJump) {
        expectSeqJump = false;
        if (result.kind === 'gap') {
          respawnJumps++;
          return { kind: 'fresh' as const, chars: 0 };
        }
      }
    }
    return result;
  };

  const emit = (kind: string, level: 'info' | 'warn', msg: string, meta: Record<string, unknown>) => {
    const suppressed = limiter.take(`${sessionId}:${surface}:${kind}`);
    if (suppressed === null) return;
    rendererLog(RENDER_LOG_NS, level, msg, {
      meta: { sessionId, surface, remote, ...meta, ...(suppressed > 0 && { suppressed }) },
    });
  };

  const size = () => (term ? { cols: term.cols, rows: term.rows } : {});

  const flushPostResize = () => {
    const p = postResize;
    if (!p) return;
    clearTimeout(p.timer);
    postResize = null;
    if (p.chunks === 0) return;
    emit('post-resize', 'info', 'Post-resize repaint', {
      cols: p.cols, rows: p.rows, chars: p.chars, chunks: p.chunks,
      clearScreens: p.clearScreens, clearScrollbacks: p.clearScrollbacks, syncFrames: p.syncFrames,
      windowMs: POST_RESIZE_WINDOW_MS,
    });
  };

  const onPrivateMode = (params: (number | number[])[], set: boolean): boolean => {
    for (const p of params) {
      const mode = Array.isArray(p) ? p[0] : p;
      if (mode === SYNC_OUTPUT_MODE && set) {
        if (replaying) replayParsed.syncFrames++;
        else {
          totals.syncFrames++;
          if (postResize) postResize.syncFrames++;
        }
      }
    }
    return false; // let xterm handle the sequence
  };

  const onEraseInDisplay = (params: (number | number[])[]): boolean => {
    const mode = Array.isArray(params[0]) ? params[0][0] : params[0];
    if (mode === 2 || mode === 3) {
      const key = mode === 2 ? 'clearScreens' : 'clearScrollbacks';
      if (replaying) replayParsed[key]++;
      else {
        totals[key]++;
        if (postResize) postResize[key]++;
      }
    }
    return false;
  };

  const watchDpr = (fitAddon?: FitAddon) => {
    if (typeof window.matchMedia !== 'function') return;
    const dpr = window.devicePixelRatio;
    const mql = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const onChange = () => {
      const proposed = fitAddon?.proposeDimensions?.();
      emit('dpr', 'info', 'Device pixel ratio changed', {
        from: dpr, to: window.devicePixelRatio, ...size(),
        proposedCols: proposed?.cols, proposedRows: proposed?.rows,
      });
      dprCleanup?.();
      watchDpr(fitAddon);
    };
    mql.addEventListener?.('change', onChange);
    dprCleanup = () => mql.removeEventListener?.('change', onChange);
  };

  return {
    attach(t, fitAddon) {
      term = t;
      const parser = t.parser;
      if (parser?.registerCsiHandler) {
        disposables.push(
          parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => onPrivateMode(params as (number | number[])[], true)),
          parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => onPrivateMode(params as (number | number[])[], false)),
          parser.registerCsiHandler({ final: 'J' }, (params) => onEraseInDisplay(params as (number | number[])[])),
        );
      }
      const bufferChange = t.buffer?.onBufferChange?.((buf) => {
        if (replaying) {
          replayParsed.altScreenToggles++;
          return;
        }
        totals.altScreenToggles++;
        emit('alt-screen', 'info', buf.type === 'alternate' ? 'Alternate screen entered' : 'Alternate screen exited', {
          ...size(), syncFrames: totals.syncFrames,
        });
      });
      if (bufferChange) disposables.push(bufferChange);
      watchDpr(fitAddon);
    },

    beginReplay(source, snapshotLength, snapshotSeq) {
      if (disposed) return;
      replaying = snapshotLength > 0;
      replay = { ...emptyCounters(), source, snapshotLength, snapshotSeq, startedAt: now() };
    },

    snapshotParsed() {
      replaying = false;
    },

    replayChunk(length, seq, appliedSeq) {
      if (!replay) return;
      const { kind, chars } = classify(length, seq, appliedSeq);
      count(replay, kind, chars);
    },

    endReplay(failed = false) {
      replaying = false;
      const r = replay;
      replay = null;
      if (!r || disposed) return;
      // Unsequenced remote chunks (older satellites) are written after a
      // snapshot that may already contain them, so they are a duplicate risk.
      const anomaly = r.duplicates > 0 || r.gaps > 0 || (r.source === 'remote' && r.unsequenced > 0);
      emit('replay', anomaly || failed ? 'warn' : 'info', failed ? 'Terminal buffer replay failed' : 'Terminal buffer replay', {
        source: r.source, snapshotLength: r.snapshotLength, snapshotSeq: r.snapshotSeq,
        pendingChunks: r.chunks, covered: r.covered, coveredChars: r.coveredChars, overlaps: r.overlaps, overlapChars: r.overlapChars,
        duplicates: r.duplicates, duplicateChars: r.duplicateChars, gaps: r.gaps, gapChars: r.gapChars,
        unsequenced: r.unsequenced,
        historyAltScreenToggles: replayParsed.altScreenToggles,
        historyClearScreens: replayParsed.clearScreens,
        historyClearScrollbacks: replayParsed.clearScrollbacks,
        historySyncFrames: replayParsed.syncFrames,
        altScreen: term?.buffer?.active?.type === 'alternate',
        durationMs: now() - r.startedAt,
        instances: mountedTerminalCount(sessionId),
        platform,
        ...size(),
      });
    },

    liveChunk(length, seq, appliedSeq) {
      if (disposed) return;
      const { kind, chars } = classify(length, seq, appliedSeq);
      count(live, kind, chars);
      if (postResize) {
        postResize.chunks++;
        postResize.chars += length;
      }
      if (kind === 'duplicate' || kind === 'gap') {
        emit(kind, 'warn', kind === 'duplicate' ? 'PTY chunk delivered twice' : 'PTY output gap', {
          length, seq, appliedSeq, chars,
        });
      }
    },

    ptyExited() {
      expectSeqJump = true;
    },

    resize(trigger, cols, rows, sent) {
      if (disposed) return;
      if (sent) {
        totals.resizesSent++;
        // Every send opens a window, even one this terminal thinks is
        // unchanged: another view of the same PTY may have changed its size.
        flushPostResize();
        postResize = {
          cols, rows, chars: 0, chunks: 0, clearScreens: 0, clearScrollbacks: 0, syncFrames: 0,
          timer: setTimeout(flushPostResize, POST_RESIZE_WINDOW_MS),
        };
      }
      if (cols === lastCols && rows === lastRows) {
        unchangedFits++;
        return;
      }
      const meta = {
        trigger, cols, rows, prevCols: lastCols, prevRows: lastRows, sent,
        unchangedFits, instances: mountedTerminalCount(sessionId),
        dpr: window.devicePixelRatio, platform,
      };
      lastCols = cols;
      lastRows = rows;
      unchangedFits = 0;
      emit('resize', 'info', 'Terminal resize', meta);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      flushPostResize();
      for (const d of disposables) d.dispose();
      dprCleanup?.();
      const remaining = mountedTerminalCount(sessionId) - 1;
      if (remaining > 0) mountedTerminals.set(sessionId, remaining);
      else mountedTerminals.delete(sessionId);
      emit('unmount', live.duplicates > 0 || live.gaps > 0 ? 'warn' : 'info', 'Terminal render summary', {
        lifetimeMs: now() - mountedAt,
        liveChunks: live.chunks, covered: live.covered, overlaps: live.overlaps, overlapChars: live.overlapChars,
        duplicates: live.duplicates, duplicateChars: live.duplicateChars,
        gaps: live.gaps, gapChars: live.gapChars, unsequenced: live.unsequenced, respawnJumps,
        ...totals,
        instancesLeft: remaining,
      });
      term = null;
    },
  };
}
