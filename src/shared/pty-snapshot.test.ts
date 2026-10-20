import { describe, it, expect } from 'vitest';
import { Terminal } from '@xterm/headless';
import {
  altScreenAfter,
  resyncOffset,
  snapshotSegments,
  writePtySnapshot,
  type PtyBufferSnapshot,
} from './pty-snapshot';

const ROWS = 6;

/** Every line of the active buffer (scrollback + viewport), right-trimmed. */
function screen(term: Terminal): string[] {
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

function count(lines: string[], marker: string): number {
  return lines.filter((line) => line.includes(marker)).length;
}

/**
 * An inline TUI in the style of Ink: each frame erases the previous frame's
 * line count with "erase line, cursor up" and redraws.  It lays out lines for
 * the width it was told, so a frame drawn at 80 columns has 80-column lines.
 */
class InlineTui {
  private prevLines = 0;
  constructor(private width: number, private sync = false) {}

  frame(n: number): string {
    const lines = [
      `STATUS frame ${n} `.padEnd(this.width, '='),
      `> prompt ${n}`.padEnd(this.width, '.'),
    ];
    let out = '';
    for (let i = 0; i < this.prevLines; i++) out += '\x1b[2K' + (i < this.prevLines - 1 ? '\x1b[1A' : '');
    if (this.prevLines > 0) out += '\x1b[G';
    out += lines.join('\r\n');
    this.prevLines = lines.length;
    return this.sync ? `\x1b[?2026h${out}\x1b[?2026l` : out;
  }

  /** What the child does on SIGWINCH: clear and redraw at the new width. */
  resize(width: number, n: number): string {
    this.width = width;
    this.prevLines = 0;
    return '\x1b[2J\x1b[H' + this.frame(n);
  }
}

/**
 * Feed a live terminal the way the PTY did (resizing at the recorded points)
 * and return it with the snapshot main would serve for the same history.
 */
async function record(parts: Array<{ data: string; cols: number }>): Promise<{ live: Terminal; snapshot: PtyBufferSnapshot }> {
  const live = new Terminal({ cols: parts[0]!.cols, rows: ROWS, allowProposedApi: true });
  const sizes: NonNullable<PtyBufferSnapshot['sizes']> = [];
  let data = '';
  for (const part of parts) {
    if (sizes.length === 0 || sizes[sizes.length - 1]!.cols !== part.cols) {
      live.resize(part.cols, ROWS);
      sizes.push({ offset: data.length, cols: part.cols, rows: ROWS });
    }
    await write(live, part.data);
    data += part.data;
  }
  return { live, snapshot: { data, seq: data.length, sizes } };
}

describe('writePtySnapshot', () => {
  it.each([
    ['plain inline frames', false],
    ['?2026 synchronized-output frames', true],
  ])('replays %s drawn at other widths without stacking them', async (_name, sync) => {
    // Drawn wide (a wide main view), then the PTY moved to a narrow canvas
    // card and the TUI redrew itself there.
    const tui = new InlineTui(80, sync);
    const { live, snapshot } = await record([
      { data: tui.frame(1) + tui.frame(2) + tui.frame(3), cols: 80 },
      { data: tui.resize(40, 4) + tui.frame(5), cols: 40 },
    ]);

    const replayed = new Terminal({ cols: 120, rows: ROWS, allowProposedApi: true });
    await writePtySnapshot(replayed, snapshot);
    expect(replayed.cols).toBe(40);
    expect(screen(replayed)).toEqual(screen(live));

    // The old behaviour: the raw history written at the final size, where the
    // 80-column frames wrap and their "erase N lines" no longer covers them.
    const naive = new Terminal({ cols: 40, rows: ROWS, allowProposedApi: true });
    await write(naive, snapshot.data);
    expect(count(screen(naive), 'STATUS')).toBeGreaterThan(count(screen(live), 'STATUS'));
  });

  it('replays an alt-screen session at its recorded sizes', async () => {
    const draw = (cols: number, n: number) =>
      `\x1b[H\x1b[2J\x1b[1;1H${'TOP'.padEnd(cols, '-')}\x1b[3;1Hframe ${n}\x1b[${ROWS};1H${'BOTTOM'.padEnd(cols, '-')}`;
    const { live, snapshot } = await record([
      { data: 'shell prompt$ app\r\n\x1b[?1049h' + draw(80, 1) + draw(80, 2), cols: 80 },
      { data: draw(40, 3), cols: 40 },
    ]);

    const replayed = new Terminal({ cols: 100, rows: ROWS, allowProposedApi: true });
    await writePtySnapshot(replayed, snapshot);
    expect(replayed.buffer.active.type).toBe('alternate');
    expect(screen(replayed)).toEqual(screen(live));
    // Leaving the app restores the normal screen exactly as it was.
    await write(live, '\x1b[?1049l');
    await write(replayed, '\x1b[?1049l');
    expect(screen(replayed)).toEqual(screen(live));
  });

  it('writes the data as-is when the snapshot has no sizes', async () => {
    const replayed = new Terminal({ cols: 50, rows: ROWS, allowProposedApi: true });
    await writePtySnapshot(replayed, { data: 'hello\r\nworld', seq: 11 });
    expect(replayed.cols).toBe(50);
    expect(screen(replayed)).toEqual(['hello', 'world']);
  });

  it('leaves the target at the latest size even with no data after it', async () => {
    const replayed = new Terminal({ cols: 50, rows: ROWS, allowProposedApi: true });
    await writePtySnapshot(replayed, {
      data: 'abc',
      seq: 3,
      sizes: [{ offset: 0, cols: 60, rows: 8 }, { offset: 3, cols: 70, rows: 9 }],
    });
    expect([replayed.cols, replayed.rows]).toEqual([70, 9]);
  });
});

/**
 * A Copilot CLI-shaped TUI: renders inline on the main screen (no alt
 * screen), redraws the whole frame each update by moving the cursor up over
 * the previous frame's rows and erasing each line, and on resize just redraws
 * the same way at the new width (no screen clear).  Frames taller than the
 * viewport push their top into scrollback.
 */
class CopilotTui {
  private prevRows = 0;
  constructor(private width: number, private sync: boolean) {}

  frame(n: number, bodyLines = 3): string {
    const lines = [`COPILOT frame ${n}`.padEnd(this.width, ' ').slice(0, this.width)];
    for (let i = 0; i < bodyLines; i++) lines.push(`body ${n}.${i} `.padEnd(this.width, '~'));
    lines.push('> '.padEnd(this.width, '_'));
    let out = '';
    if (this.prevRows > 0) out += `\r\x1b[${this.prevRows - 1}A`;
    out += lines.map((line) => `\x1b[2K${line}`).join('\r\n');
    this.prevRows = lines.length;
    return this.sync ? `\x1b[?2026h${out}\x1b[?2026l` : out;
  }

  resize(width: number): void {
    this.width = width;
  }
}

describe('Copilot-shaped inline redraws', () => {
  it.each([
    ['without sync output', false],
    ['with ?2026 sync output', true],
  ])('replays a widen resize %s like the live terminal, with one frame on screen', async (_name, sync) => {
    const tui = new CopilotTui(40, sync);
    const parts = [{ data: tui.frame(1) + tui.frame(2), cols: 40 }];
    tui.resize(80);
    parts.push({ data: tui.frame(3) + tui.frame(4), cols: 80 });
    const { live, snapshot } = await record(parts);

    const replayed = new Terminal({ cols: 60, rows: ROWS, allowProposedApi: true });
    await writePtySnapshot(replayed, snapshot);
    expect(screen(replayed)).toEqual(screen(live));
    expect(count(screen(replayed), 'COPILOT')).toBe(1);
  });

  it.each([
    ['without sync output', false],
    ['with ?2026 sync output', true],
  ])('replays a narrow resize %s exactly as the live terminal drew it', async (_name, sync) => {
    // Drawn in a wide view, then the PTY moved to a narrow one.  Remounting at
    // the narrow size used to replay the wide frames there, where each row
    // wraps in two and the "cursor up" redraws miss half of every frame.
    const tui = new CopilotTui(80, sync);
    const parts = [{ data: tui.frame(1) + tui.frame(2) + tui.frame(3), cols: 80 }];
    tui.resize(40);
    parts.push({ data: tui.frame(4) + tui.frame(5), cols: 40 });
    const { live, snapshot } = await record(parts);

    const replayed = new Terminal({ cols: 40, rows: ROWS, allowProposedApi: true });
    await writePtySnapshot(replayed, snapshot);
    expect(screen(replayed)).toEqual(screen(live));

    const naive = new Terminal({ cols: 40, rows: ROWS, allowProposedApi: true });
    await write(naive, snapshot.data);
    expect(count(screen(naive), 'COPILOT')).toBeGreaterThan(count(screen(live), 'COPILOT'));
  });

  it('documents the live artifact: an inline redraw after a narrowing reflow leaves stale rows', async () => {
    // Not a replay problem: xterm reflows the wide frame into more rows than
    // the TUI's "cursor up" covers, so even the live terminal keeps a stale
    // copy above the new frame.  Replay reproduces it faithfully; fewer PTY
    // resizes (#2322) mean fewer of these.
    const tui = new CopilotTui(80, false);
    const parts = [{ data: tui.frame(1), cols: 80 }];
    tui.resize(40);
    parts.push({ data: tui.frame(2), cols: 40 });
    const { live } = await record(parts);
    expect(count(screen(live), 'COPILOT')).toBe(2);
  });
});

describe('snapshotSegments', () => {
  it('splits data at each size offset', () => {
    expect(snapshotSegments({
      data: 'aaabbcccc',
      seq: 9,
      sizes: [{ offset: 0, cols: 10, rows: 5 }, { offset: 3, cols: 20, rows: 5 }, { offset: 5, cols: 30, rows: 6 }],
    })).toEqual([
      { data: 'aaa', cols: 10, rows: 5 },
      { data: 'bb', cols: 20, rows: 5 },
      { data: 'cccc', cols: 30, rows: 6 },
    ]);
  });

  it('keeps data before the first size unsized', () => {
    expect(snapshotSegments({ data: 'xxyy', seq: 4, sizes: [{ offset: 2, cols: 10, rows: 5 }] })).toEqual([
      { data: 'xx' },
      { data: 'yy', cols: 10, rows: 5 },
    ]);
  });

  it('returns nothing for an empty unsized snapshot', () => {
    expect(snapshotSegments({ data: '', seq: 0 })).toEqual([]);
  });
});

describe('altScreenAfter', () => {
  it('tracks the last alt-screen toggle in the data', () => {
    expect(altScreenAfter('a\x1b[?1049hb', false)).toBe(true);
    expect(altScreenAfter('a\x1b[?1049hb\x1b[?1049l', false)).toBe(false);
    expect(altScreenAfter('\x1b[?47h', false)).toBe(true);
    expect(altScreenAfter('plain text', true)).toBe(true);
  });
});

describe('resyncOffset', () => {
  it('skips a cut escape-sequence fragment to the next ESC', () => {
    expect(resyncOffset('5;10Hhello\x1b[2Kworld')).toBe(10);
  });

  it('starts after the first line feed when it comes first', () => {
    expect(resyncOffset('tail of a line\r\nnext\x1b[m')).toBe(16);
  });

  it('starts at the beginning when there is no boundary nearby', () => {
    expect(resyncOffset('x'.repeat(5000))).toBe(0);
  });
});
