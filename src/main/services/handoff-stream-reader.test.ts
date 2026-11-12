import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { FileHandle } from 'fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalHandoffManifest, type HandoffWorktreeManifest } from '../../shared/handoff-manifest';
import type { HandoffManifestSummary } from '../../shared/handoffs';
import { HANDOFF_STREAM_CHUNK_BYTES as CHUNK, readHandoffSnapshot, type HandoffReadFrame } from './handoff-stream-reader';

let root: string;
let data: Buffer;
let manifest: HandoffWorktreeManifest;
let expected: HandoffManifestSummary;
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const target = () => path.join(root, 'files/data.bin');

function fixture(bytes = Buffer.alloc(2 * CHUNK + 10, 'x')) {
  data = bytes;
  fs.mkdirSync(path.join(root, 'files'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target(), data);
  fs.writeFileSync(path.join(root, 'files/empty.txt'), '');
  manifest = {
    v: 1, repo: { remote: null, base: 'a'.repeat(40), branch: 'example' },
    include: { tracked_changes: true, untracked: true, ignored: [] }, exclude: [],
    files: [
      { path: 'data.bin', size: data.byteLength, sha256: sha(data), mode: '100644' },
      { path: 'empty.txt', size: 0, sha256: sha(''), mode: '100755' },
    ],
    deletions: ['removed.txt'], total_bytes: data.byteLength, manifest_sha256: '0'.repeat(64),
  };
  manifest.manifest_sha256 = sha(canonicalHandoffManifest(manifest));
  expected = { sha256: manifest.manifest_sha256, fileCount: 3, totalBytes: data.byteLength };
}

async function consume(reader: AsyncGenerator<HandoffReadFrame>, frames: HandoffReadFrame[] = []) {
  for await (const frame of reader) frames.push(frame);
  return frames;
}

const payload = (frames: HandoffReadFrame[]) => Buffer.concat(frames.filter((frame) => frame.kind === 'file').map((frame) => Buffer.from(frame.bytes)));
const reader = (authorize: () => Promise<boolean> = async () => true) => readHandoffSnapshot({ root, manifest, expected, authorize });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-reader-'));
  fixture();
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('verified snapshot chunk source', () => {
  it('emits bounded independent chunks with exact bytes, empty files, deletions and a final marker', async () => {
    fixture(Buffer.alloc(1024 * 1024 + CHUNK + 10, 'x'));
    const frames = await consume(reader());
    const chunks = frames.filter((frame) => frame.kind === 'file');
    expect(chunks.length).toBeGreaterThan(16);
    expect(chunks.every((frame) => frame.bytes.byteLength > 0 && frame.bytes.byteLength <= CHUNK)).toBe(true);
    expect(chunks.map((frame) => frame.offset)).toEqual(chunks.map((_frame, index) => index * CHUNK));
    expect(Buffer.from(payload(frames))).toEqual(data);
    expect(frames.filter((frame) => frame.kind === 'file-complete').map((frame) => frame.path)).toEqual(['data.bin', 'empty.txt']);
    expect(frames[0]).toMatchObject({ kind: 'manifest', manifest: { deletions: ['removed.txt'] } });
    expect(frames[frames.length - 1]).toEqual({ kind: 'complete' });
    expect(fs.readFileSync(target())).toEqual(data);
  });

  it('restarts from a validated chunk boundary and still verifies the entire source', async () => {
    const frames = await consume(readHandoffSnapshot({
      root, manifest, expected, authorize: async () => true, resume: [{ path: 'data.bin', offset: CHUNK }],
    }));
    const chunks = frames.filter((frame) => frame.kind === 'file');
    expect(chunks[0].offset).toBe(CHUNK);
    expect(Buffer.concat([data.subarray(0, CHUNK), Buffer.from(payload(frames))])).toEqual(data);
    fs.writeFileSync(target(), Buffer.alloc(data.byteLength, 'z'));
    const changed: HandoffReadFrame[] = [];
    await expect(consume(readHandoffSnapshot({
      root, manifest, expected, authorize: async () => true, resume: [{ path: 'data.bin', offset: data.byteLength }],
    }), changed)).rejects.toMatchObject({ code: 'hash_mismatch' });
    expect(changed).toEqual([]);
  });

  it.each([
    [{ path: '../outside', offset: 0 }],
    [{ path: 'data.bin', offset: 1 }],
    [{ path: 'data.bin', offset: -CHUNK }],
    [{ path: 'data.bin', offset: Number.NaN }],
    [{ path: 'data.bin', offset: 4 * CHUNK }],
    [{ path: 'data.bin', offset: 0 }, { path: 'data.bin', offset: CHUNK }],
    [{ path: 'data.bin', offset: 0, unexpected: true }],
  ])('refuses invalid resume state before emitting any frame: %j', async (...resume) => {
    const frames: HandoffReadFrame[] = [];
    const open = vi.spyOn(fs.promises, 'open');
    await expect(consume(readHandoffSnapshot({ root, manifest, expected, authorize: async () => true, resume }), frames))
      .rejects.toMatchObject({ code: 'bounds_exceeded' });
    expect(frames).toEqual([]);
    expect(open).not.toHaveBeenCalled();
  });

  it('refuses revoked or failed authorization before opening files without reflecting diagnostic values', async () => {
    const open = vi.spyOn(fs.promises, 'open');
    for (const authorize of [async () => false, async () => { throw new Error('private-path-and-token-must-not-escape'); }]) {
      const frames: HandoffReadFrame[] = [];
      await expect(consume(reader(authorize), frames)).rejects.toMatchObject({
        code: 'authorization_changed', message: 'Handoff snapshot failed: authorization_changed.',
      });
      expect(frames).toEqual([]);
    }
    expect(open).not.toHaveBeenCalled();
  });

  it('blocks an agreed secret-bearing snapshot and a substituted summary before the first frame', async () => {
    const secret = `ghp_${'a'.repeat(36)}`;
    fixture(Buffer.from(secret));
    const frames: HandoffReadFrame[] = [];
    await expect(consume(reader(), frames)).rejects.toMatchObject({ code: 'secret_blocked' });
    expect(frames).toEqual([]);
    fixture();
    expected = { ...expected, sha256: 'f'.repeat(64) };
    await expect(consume(reader(), frames)).rejects.toMatchObject({ code: 'hash_mismatch' });
    expect(frames).toEqual([]);
  });

  it('detects mutation after initial validation without transmitting the changed secret', async () => {
    const secret = `ghp_${'a'.repeat(36)}`;
    const stream = reader();
    expect((await stream.next()).value).toMatchObject({ kind: 'manifest' });
    const first = (await stream.next()).value;
    expect(first).toMatchObject({ kind: 'file', offset: 0 });
    const changed = Buffer.from(data);
    changed.write(secret, CHUNK + 20);
    fs.writeFileSync(target(), changed);
    await expect(stream.next()).rejects.toMatchObject({ code: 'hash_mismatch' });
    if (first?.kind !== 'file') throw new Error('Expected first payload chunk.');
    expect(Buffer.from(first.bytes)).toEqual(data.subarray(0, CHUNK));
    expect(Buffer.from(first.bytes).includes(secret)).toBe(false);
    expect(fs.readFileSync(target())).toEqual(changed);
  });

  it('does not trust a consumer-mutated manifest frame or reuse its yielded byte buffers', async () => {
    const stream = reader();
    const header = (await stream.next()).value;
    if (header?.kind !== 'manifest') throw new Error('Expected manifest.');
    header.manifest.files[0].sha256 = 'f'.repeat(64);
    const frames = await consume(stream);
    expect(Buffer.from(payload(frames))).toEqual(data);
    const chunks = frames.filter((frame) => frame.kind === 'file');
    expect(chunks[0].bytes).not.toBe(chunks[1].bytes);
  });

  it.each(['revoked', 'consumer-return'])('closes every descriptor after %s without modifying the snapshot', async (failure) => {
    const opened = new Set<FileHandle>();
    const open = fs.promises.open;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (file, flags, mode) => {
      const handle = await open(file, flags, mode);
      opened.add(handle);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, 'close').mockImplementation(async () => { await close(); opened.delete(handle); });
      return handle;
    });
    let allowed = true;
    const stream = reader(async () => allowed);
    await stream.next();
    await stream.next();
    expect(opened.size).toBe(1);
    if (failure === 'revoked') {
      allowed = false;
      await expect(stream.next()).rejects.toMatchObject({ code: 'authorization_changed' });
    } else await stream.return(undefined);
    expect(opened.size).toBe(0);
    expect(fs.readFileSync(target())).toEqual(data);
  });
});
