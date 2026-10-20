import { describe, expect, it } from 'vitest';
import { isMediaRef, mediaDimensions, sniffMediaType } from './media';

const bytes = (...parts: Array<number[] | string>) => new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)));

/** A PNG header with an IHDR chunk for `w`×`h`. */
function pngHeader(w: number, h: number): Uint8Array {
  const be = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  return bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [0, 0, 0, 13], 'IHDR', be(w), be(h), [8, 6, 0, 0, 0]);
}

describe('sniffMediaType', () => {
  it('knows the raster types by their magic bytes', () => {
    expect(sniffMediaType(pngHeader(1, 1))).toBe('image/png');
    expect(sniffMediaType(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffMediaType(bytes('GIF89a', [1, 0, 1, 0]))).toBe('image/gif');
    expect(sniffMediaType(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 '))).toBe('image/webp');
  });

  it('knows SVG with or without a prologue, and nothing that only mentions svg', () => {
    expect(sniffMediaType(bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('image/svg+xml');
    expect(sniffMediaType(new TextEncoder().encode('\uFEFF<?xml version="1.0"?>\n<!-- made by hand -->\n<!DOCTYPE svg PUBLIC "x">\n<svg>'))).toBe('image/svg+xml');
    expect(sniffMediaType(bytes('<html><body><svg></svg></body></html>'))).toBeUndefined();
    expect(sniffMediaType(bytes('hello <svg>'))).toBeUndefined();
    expect(sniffMediaType(bytes('<svg', [0], '>'))).toBeUndefined();
  });

  it('scans comment-heavy input in linear time (no regex backtracking)', () => {
    const start = Date.now();
    expect(sniffMediaType(new TextEncoder().encode('<!---->'.repeat(146)))).toBeUndefined();
    expect(sniffMediaType(new TextEncoder().encode(`${'<!-- x -->'.repeat(100)}<svg>`))).toBe('image/svg+xml');
    expect(sniffMediaType(new TextEncoder().encode('<!-- never closed <svg>'))).toBeUndefined();
    expect(Date.now() - start).toBeLessThan(100);
  });

  it('ignores declared types: text is not an image', () => {
    expect(sniffMediaType(bytes('not an image'))).toBeUndefined();
    expect(sniffMediaType(new Uint8Array())).toBeUndefined();
  });
});

describe('mediaDimensions', () => {
  it('reads PNG, GIF, WebP and JPEG headers', () => {
    expect(mediaDimensions(pngHeader(640, 480), 'image/png')).toEqual({ width: 640, height: 480 });
    expect(mediaDimensions(bytes('GIF89a', [0x20, 0x01, 0x10, 0x00]), 'image/gif')).toEqual({ width: 288, height: 16 });
    // VP8X: 24-bit (width-1) and (height-1) at 24 and 27.
    const vp8x = bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8X', [10, 0, 0, 0, 0, 0, 0, 0], [99, 0, 0], [49, 0, 0]);
    expect(mediaDimensions(vp8x, 'image/webp')).toEqual({ width: 100, height: 50 });
    // SOI, an APP0 segment, then SOF0 with height 300 and width 400.
    const jpeg = bytes([0xff, 0xd8], [0xff, 0xe0, 0, 4, 0, 0], [0xff, 0xc0, 0, 11, 8, 0x01, 0x2c, 0x01, 0x90, 3]);
    expect(mediaDimensions(jpeg, 'image/jpeg')).toEqual({ width: 400, height: 300 });
  });

  it('says nothing for SVG or a truncated header', () => {
    expect(mediaDimensions(bytes('<svg>'), 'image/svg+xml')).toBeUndefined();
    expect(mediaDimensions(pngHeader(1, 1).subarray(0, 20), 'image/png')).toBeUndefined();
  });
});

describe('isMediaRef', () => {
  it('takes only a sha256 name with a known extension', () => {
    expect(isMediaRef(`${'a'.repeat(64)}.png`)).toBe(true);
    expect(isMediaRef(`${'a'.repeat(64)}.svg`)).toBe(true);
    expect(isMediaRef(`../${'a'.repeat(64)}.png`)).toBe(false);
    expect(isMediaRef(`${'a'.repeat(64)}.html`)).toBe(false);
    expect(isMediaRef(`${'A'.repeat(64)}.png`)).toBe(false);
    expect(isMediaRef(42)).toBe(false);
  });
});
