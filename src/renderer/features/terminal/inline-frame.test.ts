import { describe, it, expect } from 'vitest';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import type { Terminal } from '@xterm/xterm';
import { attachInlineFrameGuard, beginErase, detachInlineFrameGuard, endErase, resizeTerminal } from './inline-frame';

function lines(term: HeadlessTerminal): string[] {
  const buf = term.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < buf.length; i++) out.push(buf.getLine(i)?.translateToString(true) ?? '');
  return out;
}

const write = (term: HeadlessTerminal, data: string) => new Promise<void>((r) => term.write(data, r));

/** Two-row inline frame redrawn in place with one cursor-up. */
function frame(n: number, width: number, redraw: boolean): string {
  return (redraw ? '\r\x1b[1A' : '') + `\x1b[2KFRAME ${n} `.padEnd(width + 4, '=') + '\r\n' + `\x1b[2K> `.padEnd(width + 4, '.');
}

describe('inline-frame erase + resizeTerminal', () => {
  it.each([true, false])('narrows an inline frame without a stale copy (guard attached: %s)', async (guarded) => {
    const headless = new HeadlessTerminal({ cols: 80, rows: 6, scrollback: 50, allowProposedApi: true });
    const term = headless as unknown as Terminal;
    if (guarded) attachInlineFrameGuard(term);
    await write(headless, 'earlier output\r\n' + frame(1, 80, false) + frame(2, 80, true));

    // What AgentTerminal does on PTY.RESIZED once earlier output is parsed.
    const erase = beginErase(term, 40);
    expect(!!erase).toBe(guarded);
    if (erase) await write(headless, erase);
    endErase(term);
    resizeTerminal(term, 40, 6);
    await write(headless, frame(3, 40, true)); // the TUI's redraw after SIGWINCH

    expect(headless.cols).toBe(40);
    const copies = lines(headless).filter((l) => l.includes('FRAME')).length;
    expect(copies).toBe(guarded ? 1 : 2);
    expect(lines(headless).some((l) => l.includes('earlier output'))).toBe(true);
    detachInlineFrameGuard(term);
  });

  it('is a no-op at the current size', () => {
    const headless = new HeadlessTerminal({ cols: 80, rows: 6, allowProposedApi: true });
    resizeTerminal(headless as unknown as Terminal, 80, 6);
    expect([headless.cols, headless.rows]).toEqual([80, 6]);
  });

  it('does not count its own erase as a redraw', async () => {
    const headless = new HeadlessTerminal({ cols: 80, rows: 6, scrollback: 50, allowProposedApi: true });
    const term = headless as unknown as Terminal;
    attachInlineFrameGuard(term);
    await write(headless, frame(1, 80, false) + frame(2, 80, true));
    const erase = beginErase(term, 60)!;
    await write(headless, erase);
    endErase(term);
    resizeTerminal(term, 60, 6);
    await write(headless, frame(3, 60, true));
    // Still a stable one-row-above frame: the next narrowing erases it too.
    expect(beginErase(term, 40)).not.toBeNull();
    endErase(term);
    detachInlineFrameGuard(term);
  });

  it('ignores terminals without a parser API', () => {
    expect(attachInlineFrameGuard({} as Terminal)).toBeNull();
  });
});
