import { describe, it, expect } from 'vitest';

// Extract stripAnsi for testing — replicate the function since it's not exported
function stripAnsi(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[\?]?[0-9;]*[a-zA-Z~]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[^[\]]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\r/g, '')
    .replace(/^quote> /gm, '');
}

describe('stripAnsi', () => {
  it('strips basic CSI color codes', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
  });

  it('strips bracketed paste mode sequences', () => {
    expect(stripAnsi('\x1b[?2004h')).toBe('');
    expect(stripAnsi('\x1b[?2004l')).toBe('');
    expect(stripAnsi('hello\x1b[?2004hworld')).toBe('helloworld');
  });

  it('strips cursor movement sequences', () => {
    expect(stripAnsi('\x1b[2Jhello')).toBe('hello');
    expect(stripAnsi('\x1b[1;1Hhello')).toBe('hello');
  });

  it('strips OSC sequences', () => {
    expect(stripAnsi('\x1b]0;title\x07text')).toBe('text');
  });

  it('strips carriage returns', () => {
    expect(stripAnsi('line1\rline2')).toBe('line1line2');
  });

  it('strips quote> prompt artifacts', () => {
    expect(stripAnsi('quote> hello')).toBe('hello');
    expect(stripAnsi('line1\nquote> line2')).toBe('line1\nline2');
  });

  it('handles real-world PTY output', () => {
    const raw = '\x1b[?2004h\x1b[?2004l\x1b[?2004hlist_agents\x1b[?2004l';
    const cleaned = stripAnsi(raw);
    expect(cleaned).toBe('list_agents');
    expect(cleaned).not.toContain('[?');
  });

  it('preserves plain text', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
    expect(stripAnsi('line1\nline2')).toBe('line1\nline2');
  });

  it('handles mixed escape types', () => {
    const raw = '\x1b[?2004h\x1b[32mgreen text\x1b[0m\x1b[?2004l\r\nquote> more';
    const cleaned = stripAnsi(raw);
    expect(cleaned).toBe('green text\nmore');
  });
});
