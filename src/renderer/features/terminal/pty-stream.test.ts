import { describe, it, expect } from 'vitest';
import { unseenPtySuffix, isAsciiBinary } from './pty-stream';

describe('unseenPtySuffix', () => {
  it('passes chunks without a seq through unchanged', () => {
    expect(unseenPtySuffix('abc', undefined, 100)).toBe('abc');
  });

  it('drops a chunk that ends at or before the applied seq', () => {
    expect(unseenPtySuffix('abc', 10, 10)).toBe('');
    expect(unseenPtySuffix('abc', 7, 10)).toBe('');
  });

  it('keeps a chunk that starts at or after the applied seq', () => {
    expect(unseenPtySuffix('abc', 13, 10)).toBe('abc');
    expect(unseenPtySuffix('abc', 20, 10)).toBe('abc');
  });

  it('trims the already-seen prefix of a chunk straddling the boundary', () => {
    // chunk spans [8, 13); seen up to 10 -> keep the last 3 chars
    expect(unseenPtySuffix('abcde', 13, 10)).toBe('cde');
  });

  it('keeps everything when nothing has been applied yet', () => {
    expect(unseenPtySuffix('abc', 3, -1)).toBe('abc');
  });
});

describe('isAsciiBinary', () => {
  it('accepts 7-bit binary strings', () => {
    expect(isAsciiBinary('\x1b[M !!')).toBe(true);
    expect(isAsciiBinary('')).toBe(true);
  });

  it('rejects strings containing bytes >= 0x80', () => {
    expect(isAsciiBinary('\x1b[M ' + String.fromCharCode(0xe8) + '!')).toBe(false);
  });
});
