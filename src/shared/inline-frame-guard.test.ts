import { describe, it, expect } from 'vitest';
import { Terminal } from '@xterm/headless';
import { InlineFrameGuard } from './inline-frame-guard';
import { writePtySnapshot, type PtyBufferSnapshot } from './pty-snapshot';

const ROWS = 8;

function screen(term: Terminal): string[] {
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

const count = (lines: string[], marker: string) => lines.filter((l) => l.includes(marker)).length;

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

/** A terminal that narrows the way Clubhouse does: guard erase, then resize. */
async function resize(term: Terminal, guard: InlineFrameGuard | null, cols: number): Promise<void> {
  const erase = guard?.eraseBeforeNarrow(cols);
  if (erase) await write(term, erase);
  term.resize(cols, ROWS);
}

/** Copilot CLI-shaped: inline, whole-frame redraw with one cursor-up, caret parked in the input box. */
class CopilotTui {
  private prevRows = 0;
  private caretUp = 0;
  constructor(private width: number, private sync = false) {}
  frame(n: number): string {
    const lines = [
      `COPILOT frame ${n}`.padEnd(this.width, ' '),
      `reply ${n} `.padEnd(this.width, '~'),
      `+${'-'.repeat(this.width - 2)}+`,
      `| > input${' '.repeat(this.width - 10)}|`,
      `+${'-'.repeat(this.width - 2)}+`,
      'shift+tab mode'.padEnd(this.width, ' '),
    ];
    let out = '';
    // Back to the frame's last row from the parked caret, then to its top.
    if (this.caretUp) out += `\x1b[${this.caretUp}B`;
    if (this.prevRows > 0) out += `\r\x1b[${this.prevRows - 1}A`;
    out += lines.map((line) => `\x1b[2K${line}`).join('\r\n');
    // Park the caret inside the input box, as an interactive prompt does.
    this.caretUp = 2;
    out += `\x1b[${this.caretUp}A\x1b[10G`;
    this.prevRows = lines.length;
    return this.sync ? `\x1b[?2026h${out}\x1b[?2026l` : out;
  }
  setWidth(width: number): void { this.width = width; }
}

/** Ink-shaped (Claude Code): erase with repeated "erase line, cursor up". */
class InkTui {
  private prevRows = 0;
  constructor(private width: number) {}
  frame(n: number): string {
    const lines = [`INK frame ${n} `.padEnd(this.width, '='), `> prompt ${n}`.padEnd(this.width, '.')];
    let out = '';
    for (let i = 0; i < this.prevRows; i++) out += '\x1b[2K' + (i < this.prevRows - 1 ? '\x1b[1A' : '');
    if (this.prevRows) out += '\x1b[G';
    out += lines.join('\r\n');
    this.prevRows = lines.length;
    return out;
  }
  setWidth(width: number): void { this.width = width; }
}

async function history(term: Terminal, lines: number): Promise<void> {
  let out = '';
  for (let i = 0; i < lines; i++) out += `history line ${i} `.padEnd(70, '.') + '\r\n';
  await write(term, out);
}

describe('InlineFrameGuard', () => {
  it.each([false, true])('leaves no stale Copilot frame after narrowing (sync output: %s)', async (sync) => {
    for (const guarded of [false, true]) {
      const term = new Terminal({ cols: 80, rows: ROWS, scrollback: 100, allowProposedApi: true });
      const guard = guarded ? new InlineFrameGuard(term) : null;
      const tui = new CopilotTui(80, sync);
      await history(term, 3);
      await write(term, tui.frame(1) + tui.frame(2));
      await resize(term, guard, 40);
      tui.setWidth(40);
      await write(term, tui.frame(3));
      const copies = count(screen(term), 'COPILOT');
      // Unguarded is the bug: the reflowed old frame stays above the redraw.
      expect(copies).toBe(guarded ? 1 : 2);
      if (guarded) {
        // History above the frame is kept (and reflowed), not erased.
        expect(count(screen(term), 'history line')).toBe(3);
      }
    }
  });

  it('leaves no stale Ink frame after narrowing', async () => {
    const term = new Terminal({ cols: 80, rows: ROWS, scrollback: 100, allowProposedApi: true });
    const guard = new InlineFrameGuard(term);
    const tui = new InkTui(80);
    await write(term, tui.frame(1) + tui.frame(2));
    await resize(term, guard, 40);
    tui.setWidth(40);
    await write(term, tui.frame(3));
    expect(count(screen(term), 'INK frame')).toBe(1);
  });

  it('does nothing when widening', async () => {
    const term = new Terminal({ cols: 40, rows: ROWS, allowProposedApi: true });
    const guard = new InlineFrameGuard(term);
    await write(term, new CopilotTui(40).frame(1));
    expect(guard.eraseBeforeNarrow(80)).toBeNull();
  });

  it('does nothing for a plain shell', async () => {
    const term = new Terminal({ cols: 80, rows: ROWS, scrollback: 100, allowProposedApi: true });
    const guard = new InlineFrameGuard(term);
    await history(term, 20);
    await write(term, 'user@host:~$ ');
    expect(guard.eraseBeforeNarrow(40)).toBeNull();
  });

  it('does nothing on the alt screen (Codex, vim)', async () => {
    const term = new Terminal({ cols: 80, rows: ROWS, allowProposedApi: true });
    const guard = new InlineFrameGuard(term);
    await write(term, '\x1b[?1049h\x1b[H\x1b[2Jtop\x1b[5;1Hbody\x1b[2Aup');
    expect(guard.eraseBeforeNarrow(40)).toBeNull();
  });

  it('stops erasing once output has moved on from the last redraw', async () => {
    const term = new Terminal({ cols: 80, rows: ROWS, scrollback: 100, allowProposedApi: true });
    const guard = new InlineFrameGuard(term);
    await write(term, new CopilotTui(80).frame(1) + new CopilotTui(80).frame(1));
    // The TUI exits and a shell prints a page of output.
    await write(term, '\x1b[3B\r\n');
    await history(term, 12);
    expect(guard.eraseBeforeNarrow(40)).toBeNull();
  });

  it('makes replay match the guarded live terminal', async () => {
    // Live: Copilot at 80, guarded narrowing to 40, redraw.
    const tui = new CopilotTui(80);
    const live = new Terminal({ cols: 80, rows: ROWS, scrollback: 100, allowProposedApi: true });
    const liveGuard = new InlineFrameGuard(live);
    const wide = tui.frame(1) + tui.frame(2);
    await write(live, wide);
    await resize(live, liveGuard, 40);
    tui.setWidth(40);
    const narrow = tui.frame(3);
    await write(live, narrow);

    const snapshot: PtyBufferSnapshot = {
      data: wide + narrow,
      seq: wide.length + narrow.length,
      sizes: [{ offset: 0, cols: 80, rows: ROWS }, { offset: wide.length, cols: 40, rows: ROWS }],
    };
    const replayed = new Terminal({ cols: 100, rows: ROWS, scrollback: 100, allowProposedApi: true });
    const replayGuard = new InlineFrameGuard(replayed);
    await writePtySnapshot(replayed, snapshot, { beforeResize: (cols) => replayGuard.eraseBeforeNarrow(cols) });
    expect(screen(replayed)).toEqual(screen(live));
    expect(count(screen(replayed), 'COPILOT')).toBe(1);
  });
});
