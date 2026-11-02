import { afterEach, describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/headless';
import * as headless from './pty-headless-terminal';

const MIB = 1024 * 1024;
const encoded = (data: string) => Buffer.byteLength(JSON.stringify(data));
const ID = 'budget';

/** Every cell its own truecolor, the most a line can cost. */
const colorful = (cols: number, tag: string) => Array.from({ length: cols - tag.length }, (_, c) => (
  `\x1b[38;2;${c % 256};${(c * 7) % 256};9m${String.fromCharCode(97 + (c % 26))}`
)).join('') + `\x1b[0m${tag}`;

async function fill(lines: number, line: (i: number) => string): Promise<void> {
  let data = '';
  for (let i = 0; i < lines; i++) data += `${line(i)}\r\n`;
  headless.feedData(ID, data, 1);
  await headless.snapshot(ID);
}

/** What a phone's terminal shows after writing this. */
async function replay(data: string, cols: number, rows: number) {
  const terminal = new Terminal({ cols, rows, scrollback: 10_000, allowProposedApi: true });
  await new Promise<void>((resolve) => terminal.write(data, resolve));
  const buffer = terminal.buffer.active;
  const screen = Array.from({ length: rows }, (_, i) => buffer.getLine(buffer.baseY + i)?.translateToString(true));
  const state = { screen, cursorX: buffer.cursorX, cursorY: buffer.cursorY, scrollback: buffer.baseY };
  terminal.dispose();
  return state;
}

describe('a terminal snapshot within a byte limit', () => {
  afterEach(() => headless.dispose(ID));

  it('leaves out old scrollback, and keeps the screen and cursor exactly', async () => {
    headless.reset(ID, { cols: 120, rows: 30 });
    await fill(11_000, (i) => colorful(120, `#${i}`));
    headless.feedData(ID, 'prompt> half typed', 2);

    const full = await headless.snapshot(ID);
    expect(encoded(full!.data)).toBeGreaterThan(16 * MIB);
    const limited = await headless.snapshot(ID, { maxEncodedBytes: 8 * MIB });

    expect(encoded(limited!.data)).toBeLessThanOrEqual(8 * MIB);
    expect(limited!.seq).toBe(full!.seq);
    expect(limited!.scrollbackLines).toBeGreaterThan(0);
    expect(limited!.scrollbackLines).toBeLessThan(10_000);

    const fromFull = await replay(full!.data, 120, 30);
    const fromLimited = await replay(limited!.data, 120, 30);
    expect(fromLimited.screen).toEqual(fromFull.screen);
    expect(fromLimited.cursorX).toBe(fromFull.cursorX);
    expect(fromLimited.cursorY).toBe(fromFull.cursorY);
    expect(fromLimited.scrollback).toBe(limited!.scrollbackLines);
    expect(fromLimited.screen.at(-1)).toContain('prompt> half typed');
  }, 120_000);

  it('keeps the most recent scrollback, whole lines and characters, with wide text', async () => {
    headless.reset(ID, { cols: 80, rows: 10 });
    await fill(3000, (i) => `${colorful(40, `#${i}#`)} 日本語🦊`);

    const limited = await headless.snapshot(ID, { maxEncodedBytes: 512 * 1024 });

    expect(encoded(limited!.data)).toBeLessThanOrEqual(512 * 1024);
    // No half a surrogate pair or half an escape sequence: it reads back with no replacement characters.
    expect(limited!.data).not.toContain('�');
    const shown = await replay(limited!.data, 80, 10);
    expect(shown.screen.join('\n')).toContain('#2999#');
    expect(shown.screen.join('\n')).not.toContain('�');
    expect(shown.scrollback).toBe(limited!.scrollbackLines);
  }, 120_000);

  it('gives the whole thing, with no note, when it fits', async () => {
    headless.reset(ID, { cols: 80, rows: 10 });
    await fill(100, (i) => `line ${i}`);
    const limited = await headless.snapshot(ID, { maxEncodedBytes: 8 * MIB });
    expect(limited!.scrollbackLines).toBeUndefined();
    expect(limited!.data).toBe((await headless.snapshot(ID))!.data);
  });

  it('comes down to the screen alone, and says so, even if that is still over', async () => {
    headless.reset(ID, { cols: 80, rows: 5 });
    await fill(2000, (i) => colorful(80, `#${i}`));
    const limited = await headless.snapshot(ID, { maxEncodedBytes: 2 * 1024 });
    expect(limited!.scrollbackLines).toBe(0);
    expect((await replay(limited!.data, 80, 5)).scrollback).toBe(0);
  }, 60_000);

  describe('raw output with no mirror', () => {
    it('replays it through a terminal and fits it, keeping the screen and cursor', async () => {
      const raw = `${Array.from({ length: 11_000 }, (_, i) => `${colorful(120, `#${i}`)}\r\n`).join('')}\x1b[?1hprompt> half typed`;
      headless.reset(ID, { cols: 120, rows: 30 });
      headless.feedData(ID, raw, 1);
      const live = await headless.snapshot(ID);

      const fitted = await headless.serializeRawWithin(raw, { cols: 120, rows: 30, maxEncodedBytes: 8 * MIB });

      expect(encoded(fitted!.data)).toBeLessThanOrEqual(8 * MIB);
      expect(fitted!.scrollbackLines).toBeGreaterThan(0);
      const fromLive = await replay(live!.data, 120, 30);
      const fromFitted = await replay(fitted!.data, 120, 30);
      expect(fromFitted.screen).toEqual(fromLive.screen);
      expect(fromFitted.cursorX).toBe(fromLive.cursorX);
      expect(fromFitted.cursorY).toBe(fromLive.cursorY);
      expect(fitted!.data).toContain('\x1b[?1h');
    }, 120_000);

    it('comes down to the screen alone, and is null when even that is over', async () => {
      const raw = Array.from({ length: 2000 }, (_, i) => `${colorful(80, `#${i}`)}\r\n`).join('');
      const screen = await headless.serializeRawWithin(raw, { cols: 80, rows: 5, maxEncodedBytes: 16 * 1024 });
      expect(encoded(screen!.data)).toBeLessThanOrEqual(16 * 1024);
      expect(await headless.serializeRawWithin(raw, { cols: 80, rows: 5, maxEncodedBytes: 1024 })).toBeNull();
    }, 60_000);
  });
});
