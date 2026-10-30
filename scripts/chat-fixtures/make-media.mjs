#!/usr/bin/env node
// Writes the tiny media files chat E2E uses (test/chat-media/). Everything is
// generated here, so there is nothing to license: a gradient PNG, a two-page
// PDF, a sine-tone WAV, and (with --ffmpeg) a WebM from ffmpeg's own test
// sources. See test/chat-media/README.md.
//
//   node scripts/chat-fixtures/make-media.mjs [--out test/chat-media] [--ffmpeg /path/to/ffmpeg]
//
// PNG, PDF and WAV are byte-for-byte reproducible. The WebM depends on the
// ffmpeg build, so it is committed and only regenerated on purpose.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as zlib from 'node:zlib';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A width × height RGB gradient. */
export function makePng(width = 24, height = 16) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      row[1 + x * 3] = Math.round((x / (width - 1)) * 255);
      row[2 + x * 3] = Math.round((y / (height - 1)) * 255);
      row[3 + x * 3] = 160;
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A PDF with one line of text per page ("Page 1", "Page 2", …). */
export function makePdf(pages = 2) {
  const objects = [];
  const pageIds = Array.from({ length: pages }, (_, i) => 4 + i * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pageIds.forEach((id, i) => {
    const stream = `BT /F1 36 Tf 72 700 Td (Page ${i + 1}) Tj ET`;
    objects[id] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`;
    objects[id + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let out = '%PDF-1.4\n';
  const offsets = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** A mono 8-bit PCM sine tone. */
export function makeWav({ seconds = 0.5, rate = 8000, frequency = 440 } = {}) {
  const samples = Math.round(seconds * rate);
  const data = Buffer.alloc(samples);
  for (let i = 0; i < samples; i++) data[i] = 128 + Math.round(60 * Math.sin((2 * Math.PI * frequency * i) / rate));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate, 28); // byte rate
  header.writeUInt16LE(1, 32); // block align
  header.writeUInt16LE(8, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** One second of ffmpeg's test pattern and a tone, VP8 + Opus, metadata stripped. */
function makeWebm(ffmpeg, file) {
  execFileSync(ffmpeg, [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=10:duration=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-c:v', 'libvpx', '-b:v', '40k', '-c:a', 'libopus', '-b:a', '16k',
    '-map_metadata', '-1', '-fflags', '+bitexact', '-shortest',
    file,
  ], { stdio: 'inherit' });
}

function main() {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const out = path.resolve(opt('--out') ?? path.join(REPO_ROOT, 'test', 'chat-media'));
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'tiny.png'), makePng());
  fs.writeFileSync(path.join(out, 'two-pages.pdf'), makePdf(2));
  fs.writeFileSync(path.join(out, 'tone.wav'), makeWav());
  const ffmpeg = opt('--ffmpeg');
  if (ffmpeg) makeWebm(ffmpeg, path.join(out, 'clip.webm'));
  else console.log('clip.webm left as is (pass --ffmpeg to regenerate it)');
  for (const name of fs.readdirSync(out).sort()) console.log(`${name}\t${fs.statSync(path.join(out, name)).size} bytes`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
