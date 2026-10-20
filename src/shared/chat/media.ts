/**
 * Rich chat content (experimental `richChatContent` flag): images agents
 * return, stored by main under the agent's media folder and read back by
 * reference. Pure helpers shared by main and tests: type sniffing, header
 * dimensions and media refs.
 */

/** The experimental flag's id in experimental settings. */
export const RICH_CHAT_CONTENT_FLAG = 'richChatContent';

/** Image types chat shows inline. SVG only ever renders through `<img>`. */
export const CHAT_MEDIA_TYPES: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

/** Larger images aren't stored or shown. */
export const CHAT_MEDIA_MAX_BYTES = 20 * 1024 * 1024;

/** More pixels than this (width × height from the header) aren't stored or shown. */
export const CHAT_MEDIA_MAX_PIXELS = 64 * 1024 * 1024;

const MEDIA_REF_RE = /^[0-9a-f]{64}\.(png|jpg|gif|webp|svg)$/;

export function isMediaRef(value: unknown): value is string {
  return typeof value === 'string' && MEDIA_REF_RE.test(value);
}

function ascii(b: Uint8Array, start: number, end: number): string {
  let s = '';
  for (let i = start; i < Math.min(end, b.length); i++) s += String.fromCharCode(b[i]);
  return s;
}

/**
 * True when `text` starts (after a BOM, whitespace, an XML declaration,
 * comments and a doctype) with an `<svg` root element. A linear scan: no
 * regex backtracking on untrusted bytes.
 */
function startsWithSvg(text: string): boolean {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const skipSpace = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  const skipPast = (end: string): boolean => {
    const at = text.indexOf(end, i);
    if (at < 0) return false;
    i = at + end.length;
    return true;
  };
  for (;;) {
    skipSpace();
    const rest = text.slice(i, i + 9).toLowerCase();
    if (rest.startsWith('<?xml')) { if (!skipPast('?>')) return false; continue; }
    if (rest.startsWith('<!--')) { if (!skipPast('-->')) return false; continue; }
    if (rest.startsWith('<!doctype')) { if (!skipPast('>')) return false; continue; }
    return rest.startsWith('<svg') && (i + 4 === text.length || /[\s>/]/.test(text[i + 4]));
  }
}

/** Image type from the bytes themselves (never the name or a declared type), or undefined. */
export function sniffMediaType(b: Uint8Array): string | undefined {
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 4) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) return 'image/gif';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'image/webp';
  // SVG is text: look at the start only, and refuse anything with NUL bytes there.
  const head = b.subarray(0, 1024);
  if (head.includes(0)) return undefined;
  if (startsWithSvg(new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(head))) return 'image/svg+xml';
  return undefined;
}

function u16be(b: Uint8Array, i: number): number { return (b[i] << 8) | b[i + 1]; }
function u16le(b: Uint8Array, i: number): number { return b[i] | (b[i + 1] << 8); }
function u24le(b: Uint8Array, i: number): number { return b[i] | (b[i + 1] << 8) | (b[i + 2] << 16); }
function u32be(b: Uint8Array, i: number): number { return ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]); }

/**
 * Pixel size from the image header, without decoding it, so the transcript
 * can reserve the thumbnail's space. Undefined when the header doesn't say
 * (SVG, a truncated file).
 */
export function mediaDimensions(b: Uint8Array, mimeType: string): { width: number; height: number } | undefined {
  let size: { width: number; height: number } | undefined;
  if (mimeType === 'image/png' && b.length >= 24 && ascii(b, 12, 16) === 'IHDR') {
    size = { width: u32be(b, 16), height: u32be(b, 20) };
  } else if (mimeType === 'image/gif' && b.length >= 10) {
    size = { width: u16le(b, 6), height: u16le(b, 8) };
  } else if (mimeType === 'image/webp' && b.length >= 30) {
    const chunk = ascii(b, 12, 16);
    if (chunk === 'VP8X') size = { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
    else if (chunk === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) size = { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
    else if (chunk === 'VP8L' && b[20] === 0x2f) {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      size = { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  } else if (mimeType === 'image/jpeg') {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      // Start-of-frame markers (not DHT C4, JPG C8 or DAC CC) carry the size.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        size = { width: u16be(b, i + 7), height: u16be(b, i + 5) };
        break;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) { i += marker === 0xff ? 1 : 2; continue; }
      i += 2 + u16be(b, i + 2);
    }
  }
  return size && size.width > 0 && size.height > 0 ? size : undefined;
}
