import { describe, it, expect, beforeEach } from 'vitest';
import { AgentOutputParser } from './output-parser';

describe('AgentOutputParser', () => {
  let parser: AgentOutputParser;

  beforeEach(() => {
    parser = new AgentOutputParser();
  });

  it('strips ANSI escape codes', () => {
    const segments = parser.feed('\x1b[32mHello world\x1b[0m\n');
    expect(segments.some((s) => s.text.includes('Hello world'))).toBe(true);
    expect(segments.every((s) => !s.text.includes('\x1b'))).toBe(true);
  });

  it('classifies plain text as response', () => {
    const segments = parser.feed('I found the bug in auth.ts.\n');
    expect(segments[0].kind).toBe('response');
  });

  it('buffers incomplete lines', () => {
    const s1 = parser.feed('Hello ');
    expect(s1.length).toBe(0);
    const s2 = parser.feed('world\n');
    expect(s2.length).toBeGreaterThan(0);
  });

  it('classifies error lines', () => {
    const segments = parser.feed('Error: something went wrong\n');
    expect(segments[0].kind).toBe('error');
  });

  it('classifies tool summary lines', () => {
    const segments = parser.feed('Reading file src/main.ts\n');
    expect(segments[0].kind).toBe('tool_summary');
  });

  it('flushes remaining buffer', () => {
    parser.feed('partial text');
    const segments = parser.flush();
    expect(segments.length).toBe(1);
    expect(segments[0].text).toBe('partial text');
  });

  it('flush returns empty when buffer is empty', () => {
    expect(parser.flush()).toEqual([]);
  });

  it('handles multiple lines in one feed', () => {
    const segments = parser.feed('Line one\nLine two\nLine three\n');
    expect(segments.length).toBe(3);
  });

  it('skips empty lines', () => {
    const segments = parser.feed('Hello\n\n\nWorld\n');
    expect(segments.length).toBe(2);
  });
});
