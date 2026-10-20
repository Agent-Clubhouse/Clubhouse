/**
 * PTY buffer snapshots that remember the terminal size each part was drawn at.
 *
 * The PTY history is raw output, and inline TUIs (Claude Code, Codex, Copilot)
 * redraw with relative cursor moves ("cursor up N, erase line") whose N only
 * holds at the width the output was produced for.  Replaying that history into
 * a terminal of another size leaves earlier frames stacked above later ones
 * (#2321).  A snapshot therefore carries the PTY size in effect at each point
 * of its data, and the replay resizes the target terminal at those points so
 * every byte is interpreted at the size it was written for.
 */

/** The PTY size in effect from `offset` (UTF-16 index into the data) onward. */
export interface PtySnapshotSize {
  offset: number;
  cols: number;
  rows: number;
}

export interface PtyBufferSnapshot {
  data: string;
  /** Output seq at the end of `data`; live chunks with seq <= this are in it. */
  seq: number;
  /** Sizes in offset order.  Absent from transports that don't record them. */
  sizes?: PtySnapshotSize[];
}

/** The part of a terminal the replay drives (an xterm `Terminal` fits). */
export interface PtyReplayTarget {
  readonly cols: number;
  readonly rows: number;
  resize(cols: number, rows: number): void;
  write(data: string, callback?: () => void): void;
}

export interface PtySnapshotSegment {
  data: string;
  /** Size to apply before writing `data`; absent when unknown. */
  cols?: number;
  rows?: number;
}

/** Split a snapshot into runs of data that share one PTY size. */
export function snapshotSegments(snapshot: PtyBufferSnapshot): PtySnapshotSegment[] {
  const { data, sizes } = snapshot;
  if (!sizes || sizes.length === 0) return data ? [{ data }] : [];
  const segments: PtySnapshotSegment[] = [];
  const firstOffset = Math.min(Math.max(sizes[0]!.offset, 0), data.length);
  if (firstOffset > 0) segments.push({ data: data.slice(0, firstOffset) });
  for (let i = 0; i < sizes.length; i++) {
    const { cols, rows } = sizes[i]!;
    const start = Math.min(Math.max(sizes[i]!.offset, 0), data.length);
    const end = i + 1 < sizes.length ? Math.min(Math.max(sizes[i + 1]!.offset, start), data.length) : data.length;
    // A size with no data after it still matters when it is the last one:
    // it is the size live output will arrive at.
    if (end > start || i === sizes.length - 1) segments.push({ data: data.slice(start, end), cols, rows });
  }
  return segments;
}

/**
 * Write a snapshot into `target`, resizing it to the recorded PTY size before
 * each run of data.  Resolves once xterm has parsed everything, leaving the
 * target at the PTY's latest size so following live output lines up.
 */
export async function writePtySnapshot(target: PtyReplayTarget, snapshot: PtyBufferSnapshot): Promise<void> {
  for (const segment of snapshotSegments(snapshot)) {
    const { cols, rows } = segment;
    if (cols && rows && (cols !== target.cols || rows !== target.rows)) target.resize(cols, rows);
    if (segment.data) await new Promise<void>((resolve) => target.write(segment.data, resolve));
  }
}

// eslint-disable-next-line no-control-regex
const ALT_SCREEN_TOGGLE = /\x1b\[\?(?:1049|1047|47)([hl])/g;

/**
 * Alt-screen state after `data`, given the state before it.  Used to carry the
 * mode across history that has been evicted.
 */
export function altScreenAfter(data: string, before: boolean): boolean {
  let state = before;
  for (const match of data.matchAll(ALT_SCREEN_TOGGLE)) state = match[1] === 'h';
  return state;
}

/** How far into evicted-head data to look for a safe place to start. */
const RESYNC_SCAN_LIMIT = 4096;

/**
 * Offset of a safe replay start in history whose head was evicted.  Eviction
 * drops whole chunks, so the first kept byte can sit inside an escape
 * sequence; starting at the first ESC or line feed skips the fragment.
 */
export function resyncOffset(data: string): number {
  const limit = Math.min(data.length, RESYNC_SCAN_LIMIT);
  for (let i = 0; i < limit; i++) {
    const ch = data.charCodeAt(i);
    if (ch === 0x1b) return i;
    if (ch === 0x0a) return i + 1;
  }
  return 0;
}
