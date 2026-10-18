import { describe, it, expect } from 'vitest';
import { stripTerminalEscapes, terminalTailSummary } from './terminal-text';

describe('stripTerminalEscapes', () => {
  it('removes colors and private-mode CSI sequences (#2088)', () => {
    expect(stripTerminalEscapes('\x1b[1;31merror\x1b[0m \x1b[?25h\x1b[?2026l\x1b[?2026h\x1b[?25h')).toBe('error ');
  });

  it('removes OSC titles and hyperlinks, BEL or ST terminated', () => {
    expect(stripTerminalEscapes('\x1b]0;codex\x07a \x1b]8;;https://x.y\x1b\\link\x1b]8;;\x1b\\')).toBe('a link');
  });

  it('removes cursor movement, charset and keypad escapes', () => {
    expect(stripTerminalEscapes('\x1b[2K\x1b[1G\x1b(Bdone\x1b=\x1b>\x1b[3;12H!')).toBe('done!');
  });

  it('removes DCS strings and bare control characters, keeping tabs and newlines', () => {
    expect(stripTerminalEscapes('\x1bP1$r0m\x1b\\a\tb\x07\x08\nc')).toBe('a\tb\nc');
  });

  it('turns carriage returns into line breaks', () => {
    expect(stripTerminalEscapes('one\r\ntwo\rthree')).toBe('one\ntwo\nthree');
  });

  it('drops a sequence cut in half at the start of a slice', () => {
    expect(stripTerminalEscapes('0m\x1b[?25h tail')).toBe(' tail');
    expect(stripTerminalEscapes('[?2026l\x1b[0mrest')).toBe('rest');
    expect(stripTerminalEscapes('0m\x1b]0;codex\x07Error')).toBe('Error');
  });

  it('does not mistake ordinary leading text for a cut sequence', () => {
    expect(stripTerminalEscapes('3d printing')).toBe('3d printing');
    expect(stripTerminalEscapes('2fa\x1b[0m ok')).toBe('2fa ok');
  });

  it('leaves ordinary text alone', () => {
    const text = 'No conversation found with session ID: 1e339cf2 [see docs] 2fa ok';
    expect(stripTerminalEscapes(text)).toBe(text);
  });
});

describe('terminalTailSummary', () => {
  it('joins the last non-empty plain lines', () => {
    const raw = 'banner\r\n\x1b[2Kline a\r\n\r\n\x1b[31mline b\x1b[0m\r\n   \r\n\x1b[?25hline c\x1b[?2026l\r\n';
    expect(terminalTailSummary(raw)).toBe('line a | line b | line c');
  });

  it('returns an empty string when only escape codes were printed', () => {
    expect(terminalTailSummary('\x1b[0m\x1b[?25h\x1b[?2026l\x1b[?2026h\x1b[?25h')).toBe('');
  });

  it('caps the length', () => {
    expect(terminalTailSummary('x'.repeat(500), 3, 200)).toHaveLength(200);
  });
});
