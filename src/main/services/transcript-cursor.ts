import * as fsPromises from 'fs/promises';

/**
 * Cursor reads over a JSONL transcript (#2019 run monitor). The cursor is a
 * byte offset into the file. Each read starts there, returns only complete
 * lines, and hands back the offset after the last one it consumed, so:
 * - a partial trailing line (still being written) is left for the next read;
 * - a malformed line is skipped and counted, never re-read or lost;
 * - a read costs one page of the file, not the whole file.
 */

export interface TranscriptChunk {
  events: unknown[];
  /** Byte offset to pass to the next read. */
  cursor: number;
  /** Lines in this chunk that weren't valid JSON. */
  skipped: number;
  /** More complete lines may follow right away (the page or event limit was hit). */
  more: boolean;
  /** The file was shorter than the cursor (rewritten): this chunk starts again from 0. */
  reset: boolean;
}

export interface ChunkOptions {
  maxBytes?: number;
  maxEvents?: number;
}

const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_MAX_EVENTS = 200;
/** A single line longer than this is skipped rather than buffered whole. */
const MAX_LINE_BYTES = 64 * 1024 * 1024;

/** Split complete lines out of `buf`. Returns how many bytes were consumed. */
export function parseCompleteLines(buf: Buffer, maxEvents: number): { events: unknown[]; consumed: number; skipped: number; full: boolean } {
  const events: unknown[] = [];
  let skipped = 0;
  let pos = 0;
  while (events.length < maxEvents) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) break;
    const line = buf.toString('utf8', pos, nl);
    pos = nl + 1;
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // telemetry-exempt: a malformed transcript line is counted in `skipped`, not an error
      skipped++;
    }
  }
  return { events, consumed: pos, skipped, full: events.length >= maxEvents };
}

export async function readTranscriptChunk(filePath: string, cursor: number, opts: ChunkOptions = {}): Promise<TranscriptChunk | null> {
  const maxEvents = opts.maxEvents ?? DEFAULT_MAX_EVENTS;
  let fh: fsPromises.FileHandle;
  try {
    fh = await fsPromises.open(filePath, 'r');
  } catch {
    // telemetry-exempt: no transcript yet; the caller polls again
    return null;
  }
  try {
    const { size } = await fh.stat();
    let reset = false;
    let start = cursor;
    if (start > size) {
      start = 0;
      reset = true;
    }
    let maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    for (;;) {
      const len = Math.min(maxBytes, size - start);
      if (len <= 0) return { events: [], cursor: start, skipped: 0, more: false, reset };
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, start);
      const view = bytesRead < len ? buf.subarray(0, bytesRead) : buf;
      const parsed = parseCompleteLines(view, maxEvents);
      const pageFull = bytesRead === maxBytes && start + bytesRead < size;
      if (parsed.consumed === 0 && pageFull) {
        // One line longer than the page: widen the read, or skip it if absurdly long
        if (maxBytes < MAX_LINE_BYTES) {
          maxBytes = Math.min(MAX_LINE_BYTES, maxBytes * 4);
          continue;
        }
        const nl = await findNewline(fh, start + bytesRead, size);
        if (nl < 0) return { events: [], cursor: start, skipped: 0, more: false, reset };
        return { events: [], cursor: nl + 1, skipped: 1, more: true, reset };
      }
      return {
        events: parsed.events,
        cursor: start + parsed.consumed,
        skipped: parsed.skipped,
        more: parsed.full || (pageFull && parsed.consumed > 0),
        reset,
      };
    }
  } finally {
    await fh.close();
  }
}

async function findNewline(fh: fsPromises.FileHandle, from: number, size: number): Promise<number> {
  const buf = Buffer.alloc(64 * 1024);
  for (let at = from; at < size; at += buf.length) {
    const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - at), at);
    const i = buf.subarray(0, bytesRead).indexOf(0x0a);
    if (i >= 0) return at + i;
  }
  return -1;
}
