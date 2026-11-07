import { describe, expect, it } from 'vitest';
import { PtyInputModeTracker } from './pty-input-modes';

const on = '\x1b[?1h\x1b[?2004h';
const both = { applicationCursor: true, bracketedPaste: true };
const neither = { applicationCursor: false, bracketedPaste: false };

describe('PTY input mode scanner', () => {
  it.each([
    ['combined enable', '\x1b[?1;2004h', both],
    ['ordered disable', on + '\x1b[?2004;1l', neither],
    ['RIS', on + '\x1bc', neither],
    ['DECSTR', on + '\x1b[!p', neither],
    ['C1 CSI', '\u009b?1;2004h', both],
    ['CAN cancellation', '\x1b[?1;2004\x18h', neither],
    ['SUB cancellation', '\x1b[?1;2004\x1ah', neither],
    ['C0 inside CSI', '\x1b[?1;20\n04h', both],
    ['subparameters', '\x1b[?1:9;2004:3h', both],
    ['invalid private prefix', '\x1b[??1;2004h', neither],
  ] as const)('matches full input at every split for %s', (_name, stream, expected) => {
    for (let cut = 0; cut <= stream.length; cut++) {
      const state = new PtyInputModeTracker(); state.feed(stream.slice(0, cut)); state.feed(stream.slice(cut));
      expect(state.modes).toEqual(expected);
    }
  });

  it.each([
    ['OSC BEL', '\x1b]0;[?1;2004h\x07', neither],
    ['DCS ST', '\x1bPq[?1;2004h\x1b\\', neither],
    ['APC ST', '\x1b_[?1;2004h\x1b\\', neither],
    ['C1 OSC/ST', '\u009d0;[?1;2004h\u009c', neither],
    ['OSC ESC starts actual CSI', '\x1b]0;title\x1b[?1;2004h', both],
    ['DCS ESC starts actual CSI', '\x1bPqpayload\x1b[?1;2004h', both],
    ['C1 CSI leaves OSC', '\u009d0;title\u009b?1;2004h', both],
  ] as const)('distinguishes string text from real commands: %s', (_name, stream, expected) => {
    const state = new PtyInputModeTracker();
    for (const char of stream) state.feed(char);
    expect(state.modes).toEqual(expected);
  });

  it('uses a copy for skipped-prefix completion and keeps the stored incomplete checkpoint intact', () => {
    const head = new PtyInputModeTracker(); head.feed('\x1b[?20');
    expect(head.replayPrefix('04hdiscarded\n')).toBe('\x1b[?2004h');
    expect(head.modes).toEqual(neither);
    head.feed('04l'); expect(head.modes).toEqual(neither);
    head.feed(on); expect(head.replayPrefix()).toBe(on);
    expect(head.replayPrefix('\x1b[!p')).toBe(''); expect(head.modes).toEqual(both);
  });

  it('bounds scanner storage and follows xterm numeric saturation and its 32-primary-parameter limit', () => {
    const head = new PtyInputModeTracker(); head.feed('\x1b[?' + '9'.repeat(20_000));
    // A state-size guard against retaining raw pending escape strings; this
    // is not a measurement of heap usage or a terminal-emulation claim.
    expect(JSON.stringify(head).length).toBeLessThan(512);
    head.feed(';2004h'); expect(head.modes).toEqual({ ...neither, bracketedPaste: true });
    const overflow = new PtyInputModeTracker(); overflow.feed('\x1b[?' + '9;'.repeat(32) + '2004h');
    expect(overflow.modes).toEqual(neither);
    const last = new PtyInputModeTracker(); last.feed('\x1b[?' + '9;'.repeat(31) + '2004h');
    expect(last.modes).toEqual({ ...neither, bracketedPaste: true });
    head.feed('\x1b]0;' + 'x'.repeat(20_000)); expect(JSON.stringify(head).length).toBeLessThan(512);
  });
});
