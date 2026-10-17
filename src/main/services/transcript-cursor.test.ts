import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseCompleteLines, readTranscriptChunk } from './transcript-cursor';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-cursor-'));
  file = path.join(dir, 't.jsonl');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const line = (o: unknown) => `${JSON.stringify(o)}\n`;

describe('parseCompleteLines', () => {
  it('stops before a partial trailing line', () => {
    const buf = Buffer.from(`${line({ a: 1 })}{"b":`);
    const r = parseCompleteLines(buf, 100);
    expect(r.events).toEqual([{ a: 1 }]);
    expect(r.consumed).toBe(line({ a: 1 }).length);
  });
});

describe('readTranscriptChunk', () => {
  it('returns null when there is no transcript yet', async () => {
    expect(await readTranscriptChunk(path.join(dir, 'missing.jsonl'), 0)).toBeNull();
  });

  it('skips and counts a malformed line without duplicating or losing neighbours', async () => {
    fs.writeFileSync(file, `${line({ n: 1 })}not json\n${line({ n: 2 })}`);
    const r = await readTranscriptChunk(file, 0);
    expect(r).toMatchObject({ events: [{ n: 1 }, { n: 2 }], skipped: 1, more: false, cursor: fs.statSync(file).size });
    // Nothing new: the next read returns nothing and keeps the cursor
    expect(await readTranscriptChunk(file, r!.cursor)).toMatchObject({ events: [], cursor: r!.cursor });
  });

  it('an all-malformed page advances past those lines and keeps the rest', async () => {
    fs.writeFileSync(file, `bad\nworse\n${line({ n: 3 })}`);
    const r = await readTranscriptChunk(file, 0);
    expect(r).toMatchObject({ events: [{ n: 3 }], skipped: 2 });
  });

  it('leaves a partial trailing line for the next read', async () => {
    fs.writeFileSync(file, `${line({ n: 1 })}{"n":`);
    const first = await readTranscriptChunk(file, 0);
    expect(first).toMatchObject({ events: [{ n: 1 }], cursor: line({ n: 1 }).length, more: false });
    fs.appendFileSync(file, '2}\n');
    const second = await readTranscriptChunk(file, first!.cursor);
    expect(second).toMatchObject({ events: [{ n: 2 }], skipped: 0 });
  });

  it('pages through a file across reads, each from its cursor', async () => {
    fs.writeFileSync(file, Array.from({ length: 25 }, (_, n) => line({ n })).join(''));
    const seen: number[] = [];
    let cursor = 0;
    for (let i = 0; i < 10; i++) {
      const r = await readTranscriptChunk(file, cursor, { maxEvents: 10 });
      seen.push(...r!.events.map((e) => (e as { n: number }).n));
      cursor = r!.cursor;
      if (!r!.more) break;
    }
    expect(seen).toEqual(Array.from({ length: 25 }, (_, n) => n));
  });

  it('pages by bytes too, without splitting a line', async () => {
    fs.writeFileSync(file, Array.from({ length: 50 }, (_, n) => line({ n, pad: 'x'.repeat(40) })).join(''));
    const seen: number[] = [];
    let cursor = 0;
    for (let i = 0; i < 200; i++) {
      const r = await readTranscriptChunk(file, cursor, { maxBytes: 256 });
      seen.push(...r!.events.map((e) => (e as { n: number }).n));
      cursor = r!.cursor;
      if (!r!.more) break;
    }
    expect(seen).toEqual(Array.from({ length: 50 }, (_, n) => n));
  });

  it('reads a line longer than the page', async () => {
    fs.writeFileSync(file, `${line({ big: 'y'.repeat(5000) })}${line({ n: 1 })}`);
    const r = await readTranscriptChunk(file, 0, { maxBytes: 100 });
    expect(r!.events).toHaveLength(2);
  });

  it('starts over when the file is shorter than the cursor', async () => {
    fs.writeFileSync(file, line({ n: 1 }));
    expect(await readTranscriptChunk(file, 9999)).toMatchObject({ events: [{ n: 1 }], reset: true });
  });
});
