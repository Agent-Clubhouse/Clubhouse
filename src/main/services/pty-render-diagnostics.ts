/**
 * Content-free PTY render diagnostics for the local log (`core:pty:render`).
 *
 * Records what is needed to explain a duplicated or re-drawn terminal after
 * the fact: the platform and pty backend, every size change the PTY actually
 * received, the buffer snapshots served for replay, and output bursts. Never
 * terminal content, only lengths, counts and sizes.
 *
 * Lines are info level so the default logging settings keep them, and each
 * kind of line is rate-limited per session.
 */
import { appLog } from './log-service';
import { detectWindowsPty } from '../util/windows-pty';
import { createDiagRateLimiter } from '../../shared/diag-rate-limiter';

export const PTY_RENDER_LOG_NS = 'core:pty:render';

/** Output above either threshold within one second is logged as a burst. */
const BURST_WINDOW_MS = 1000;
const BURST_CHARS = 256 * 1024;
const BURST_CHUNKS = 400;

/** Per session and line kind: at most 6 lines a minute. */
const LINES_PER_WINDOW = 6;
const LINE_WINDOW_MS = 60_000;

interface SessionDiag {
  cols: number;
  rows: number;
  /** resize() calls since the last logged one that did not change the size. */
  unchangedResizes: number;
  burstStart: number;
  burstChars: number;
  burstChunks: number;
  burstLogged: boolean;
}

const sessions = new Map<string, SessionDiag>();
let limiter = createDiagRateLimiter(LINES_PER_WINDOW, LINE_WINDOW_MS);
let now: () => number = Date.now;

/** Platform and pty backend: `unix` off Windows, else what node-pty picks (conpty/winpty). */
function platformMeta(): Record<string, unknown> {
  const win = detectWindowsPty();
  return { platform: process.platform, backend: win?.backend ?? 'unix', ...(win && { windowsBuild: win.buildNumber }) };
}

function emit(id: string, kind: string, level: 'info' | 'warn', msg: string, meta: Record<string, unknown>): void {
  const suppressed = limiter.take(`${id}:${kind}`);
  if (suppressed === null) return;
  appLog(PTY_RENDER_LOG_NS, level, msg, {
    meta: { sessionId: id, ...meta, ...(suppressed > 0 && { suppressed }) },
  });
}

/** A PTY was spawned at `cols`×`rows`. */
export function recordSpawn(id: string, kind: 'agent' | 'shell', cols: number, rows: number): void {
  sessions.set(id, {
    cols, rows, unchangedResizes: 0,
    burstStart: now(), burstChars: 0, burstChunks: 0, burstLogged: false,
  });
  emit(id, 'spawn', 'info', 'PTY session started', { kind, cols, rows, ...platformMeta() });
}

/**
 * The PTY received a resize. Only size changes are logged (they make the
 * child reflow and, under ConPTY, re-emit the screen); repeats of the current
 * size are counted into the next logged line.
 */
export function recordResize(id: string, cols: number, rows: number): void {
  const s = sessions.get(id);
  if (!s) return;
  if (s.cols === cols && s.rows === rows) {
    s.unchangedResizes++;
    return;
  }
  const meta = {
    cols, rows, prevCols: s.cols, prevRows: s.rows,
    unchangedResizes: s.unchangedResizes,
    ...platformMeta(),
  };
  s.cols = cols;
  s.rows = rows;
  s.unchangedResizes = 0;
  emit(id, 'resize', 'info', 'PTY resize', meta);
}

/** Output arrived from the PTY: logs once per one-second window over the burst thresholds. */
export function recordOutput(id: string, length: number): void {
  const s = sessions.get(id);
  if (!s) return;
  const t = now();
  if (t - s.burstStart >= BURST_WINDOW_MS) {
    s.burstStart = t;
    s.burstChars = 0;
    s.burstChunks = 0;
    s.burstLogged = false;
  }
  s.burstChars += length;
  s.burstChunks++;
  if (!s.burstLogged && (s.burstChars >= BURST_CHARS || s.burstChunks >= BURST_CHUNKS)) {
    s.burstLogged = true;
    emit(id, 'burst', 'info', 'PTY output burst', {
      chars: s.burstChars, chunks: s.burstChunks, windowMs: BURST_WINDOW_MS,
      cols: s.cols, rows: s.rows,
    });
  }
}

/**
 * A buffer snapshot was served for replay. `evictedChars` > 0 means the
 * oldest output was dropped at the buffer cap, so the replay starts mid-stream.
 * `sizeSegments` is how many recorded PTY sizes the replay resizes through.
 */
export function recordSnapshot(id: string, length: number, seq: number, evictedChars: number, sizeSegments: number): void {
  const s = sessions.get(id);
  if (!s) return;
  emit(id, 'snapshot', 'info', 'PTY buffer snapshot served', {
    length, seq, evictedChars, sizeSegments, cols: s.cols, rows: s.rows,
  });
}

export function forget(id: string): void {
  sessions.delete(id);
  limiter.forget(`${id}:`);
}

/** Test seam: reset state and optionally inject a clock. */
export function _resetForTests(clock: () => number = Date.now): void {
  sessions.clear();
  now = clock;
  limiter = createDiagRateLimiter(LINES_PER_WINDOW, LINE_WINDOW_MS, clock);
}
