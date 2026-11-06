/** Small in-memory xterm oracles; no node-pty, Electron, sockets or providers. */
import { afterEach, describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/headless';
import { PtyInputModeTracker } from '../../shared/pty-input-modes';
import { resyncOffset } from '../../shared/pty-snapshot';
import * as headless from './pty-headless-terminal';

const terminals: Terminal[] = [];
const on = '\x1b[?1h\x1b[?2004h';
const write = (terminal: Terminal, data: string) => new Promise<void>((resolve) => terminal.write(data, resolve));
function fresh() { const terminal = new Terminal({ cols: 40, rows: 5, scrollback: 100, allowProposedApi: true }); terminals.push(terminal); return terminal; }
function state(terminal: Terminal) {
  const buffer = terminal.buffer.active;
  return { screen: Array.from({ length: terminal.rows }, (_, i) => buffer.getLine(buffer.baseY + i)?.translateToString(true)),
    x: buffer.cursorX, y: buffer.cursorY, cursor: terminal.modes.applicationCursorKeysMode, paste: terminal.modes.bracketedPasteMode };
}
afterEach(() => { for (const terminal of terminals) terminal.dispose(); terminals.length = 0; headless.disposeAll(); });

describe('two-mode replay in memory', () => {
  it.each([
    ['enabled', on, 'visible'],
    ['retained disable', on, '\x1b[?2004lvisible'],
    ['retained RIS', on, '\x1bcvisible'],
    ['retained DECSTR', on, '\x1b[!pvisible'],
    ['combined C1', '\u009b?1;2004h', 'visible'],
    ['OSC text', '\x1b]0;[?1;2004h\x07', 'visible'],
    ['OSC terminates on ESC', '\x1b]0;title\x1b[?1;2004h', 'visible'],
    ['DCS text', '\x1bPq[?1;2004h\x1b\\', 'visible'],
    ['DCS terminates on ESC', '\x1bPqdata\x1b[?1;2004h', 'visible'],
  ] as const)('matches pinned xterm screen, cursor and modes for %s', async (_name, evicted, retained) => {
    const live = fresh(), replay = fresh(); const head = new PtyInputModeTracker();
    for (const char of evicted) { head.feed(char); await write(live, char); }
    await write(live, retained); await write(replay, head.replayPrefix() + retained);
    expect(state(replay)).toEqual(state(live));
  });

  it('completes a split mode in the discarded resync prefix before serializing through a mirror', async () => {
    const head = new PtyInputModeTracker(); head.feed('\x1b[?20');
    const raw = '04hdiscarded\n\x1b[H\x1b[2Jvisible'; const skip = resyncOffset(raw);
    expect(skip).toBe('04hdiscarded\n'.length);
    const corrected = head.replayPrefix(raw.slice(0, skip)) + raw.slice(skip);
    headless.ensure('mode', { cols: 40, rows: 5 }); headless.feedData('mode', corrected, 123);
    const snapshot = await headless.snapshot('mode'); expect(snapshot!.seq).toBe(123);
    const live = fresh(), replay = fresh();
    await write(live, '\x1b[?20' + raw); await write(replay, snapshot!.data);
    expect(state(replay)).toEqual(state(live)); expect(replay.modes.bracketedPasteMode).toBe(true);
  });

  it('keeps both modes with whole-line byte fitting and the standalone raw serializer', async () => {
    const head = new PtyInputModeTracker(); head.feed(on);
    const retained = Array.from({ length: 80 }, (_, i) => `line ${i}\r\n`).join('') + 'prompt> ';
    const corrected = head.replayPrefix() + retained;
    headless.ensure('mode', { cols: 40, rows: 5 }); headless.feedData('mode', corrected, 999);
    const full = await headless.snapshot('mode'); const budget = 200;
    expect(Buffer.byteLength(JSON.stringify(full!.data))).toBeGreaterThan(budget);
    const fitted = await headless.snapshot('mode', { maxEncodedBytes: budget });
    expect(fitted!.seq).toBe(full!.seq); expect(fitted!.scrollbackLines).toBeLessThan(80);
    expect(Buffer.byteLength(JSON.stringify(fitted!.data))).toBeLessThanOrEqual(budget);
    const raw = await headless.serializeRawWithin(corrected, { cols: 40, rows: 5, maxEncodedBytes: budget });
    expect(raw).not.toBeNull(); expect(Buffer.byteLength(JSON.stringify(raw!.data))).toBeLessThanOrEqual(budget);
    const reference = fresh(), limited = fresh(), rawReplay = fresh();
    await write(reference, full!.data); await write(limited, fitted!.data); await write(rawReplay, raw!.data);
    expect(state(limited)).toEqual(state(reference)); expect(state(rawReplay)).toEqual(state(reference));
    expect(state(limited)).toMatchObject({ cursor: true, paste: true });
  });
});

describe('two-mode replay known limitation', () => {
  it('characterizes UNRESOLVED evicted ESC[?20 plus retained 04htext when resyncOffset is zero', async () => {
    const evicted = '\x1b[?20', retained = '04htext'; const head = new PtyInputModeTracker(); head.feed(evicted);
    const skip = resyncOffset(retained); expect(skip).toBe(0);
    const live = fresh(), replay = fresh();
    await write(live, evicted + retained); await write(replay, head.replayPrefix(retained.slice(0, skip)) + retained.slice(skip));
    expect(live.modes.bracketedPasteMode).toBe(true); expect(replay.modes.bracketedPasteMode).toBe(false);
    expect(state(live).screen[0]).toBe('text'); expect(state(replay).screen[0]).toBe('04htext');
    // A correct scanner can consume the split stream, but this truncated raw
    // replay still lacks the introducer. This passing characterization is a
    // remaining defect, not evidence that #2743 is fully fixed.
    head.feed(retained); expect(head.modes.bracketedPaste).toBe(true);
  });
});
