import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-media-retention-'));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('electron', () => ({ app: { getPath: () => path.join(tmpRoot, 'userData') } }));

import { pruneChatMedia, removeAgentChatMedia } from './chat-media-retention';
import { readMedia, storeMedia } from './chat-media';
import { agentMediaDir } from './chat-transcript';

const NOW = 1_800_000_000_000;
const MIN = 60_000;

function hash(n: number): string {
  return n.toString(16).padStart(64, '0');
}

/** A media file of `size` bytes last used `ageMin` minutes before NOW. */
function media(agent: string, n: number, size: number, ageMin: number): string {
  const dir = agentMediaDir(agent);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${hash(n)}.png`);
  fs.writeFileSync(file, Buffer.alloc(size, 1));
  const t = new Date(NOW - ageMin * MIN);
  fs.utimesSync(file, t, t);
  return file;
}

function png(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 3, 8, 6, 0, 0, 0]);
}

beforeEach(() => {
  fs.rmSync(path.join(tmpRoot, 'userData'), { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('pruneChatMedia', () => {
  it('does nothing under the cap', async () => {
    const a = media('a', 1, 100, 500);
    const result = await pruneChatMedia({ capBytes: 1000, targetBytes: 500, now: NOW });
    expect(result).toEqual({ scannedBytes: 100, removedFiles: 0, removedBytes: 0 });
    expect(fs.existsSync(a)).toBe(true);
  });

  it('removes the least recently used media across agents until under the target', async () => {
    const oldest = media('a', 1, 400, 300);
    const older = media('b', 2, 400, 200);
    const recent = media('a', 3, 400, 100);
    const result = await pruneChatMedia({ capBytes: 1000, targetBytes: 500, now: NOW });
    expect(result).toMatchObject({ scannedBytes: 1200, removedFiles: 2, removedBytes: 800 });
    expect(fs.existsSync(oldest)).toBe(false);
    expect(fs.existsSync(older)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
  });

  it('keeps media used in the last few minutes even over the cap', async () => {
    const old = media('a', 1, 600, 300);
    const fresh = media('a', 2, 600, 1);
    await pruneChatMedia({ capBytes: 1000, targetBytes: 100, minAgeMs: 10 * MIN, now: NOW });
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('leaves other files alone, and removes stale temporary files', async () => {
    media('a', 1, 10, 300);
    const dir = agentMediaDir('a');
    const other = path.join(dir, 'notes.txt');
    fs.writeFileSync(other, 'x'.repeat(5000));
    const staleTemp = path.join(dir, `${hash(9)}.png.1234.tmp`);
    const liveTemp = path.join(dir, `${hash(8)}.png.5678.tmp`);
    fs.writeFileSync(staleTemp, 'x');
    fs.writeFileSync(liveTemp, 'x');
    const old = new Date(NOW - 120 * MIN);
    fs.utimesSync(staleTemp, old, old);
    const now = new Date(NOW);
    fs.utimesSync(liveTemp, now, now);
    const result = await pruneChatMedia({ capBytes: 1000, now: NOW });
    expect(result.scannedBytes).toBe(10);
    expect(fs.existsSync(other)).toBe(true);
    expect(fs.existsSync(staleTemp)).toBe(false);
    expect(fs.existsSync(liveTemp)).toBe(true);
  });

  it('handles no chat folder at all', async () => {
    expect(await pruneChatMedia({ now: NOW })).toEqual({ scannedBytes: 0, removedFiles: 0, removedBytes: 0 });
  });
});

describe('use marks media as recent', () => {
  it('storing the same image again and reading it both refresh its time', async () => {
    fs.mkdirSync(path.dirname(agentMediaDir('a')), { recursive: true });
    const stored = await storeMedia('a', png());
    const file = path.join(agentMediaDir('a'), stored!.mediaRef!);
    const old = new Date(Date.now() - 300 * MIN);
    fs.utimesSync(file, old, old);
    await storeMedia('a', png());
    await vi.waitFor(() => expect(fs.statSync(file).mtimeMs).toBeGreaterThan(old.getTime() + MIN));
    fs.utimesSync(file, old, old);
    await readMedia('a', stored!.mediaRef!);
    await vi.waitFor(() => expect(fs.statSync(file).mtimeMs).toBeGreaterThan(old.getTime() + MIN));
  });
});

describe('removeAgentChatMedia', () => {
  it('removes only that agent\'s media folder', async () => {
    const a = media('a', 1, 10, 0);
    const b = media('b', 2, 10, 0);
    const transcript = path.join(path.dirname(agentMediaDir('a')), 'session.jsonl');
    fs.writeFileSync(transcript, '{}\n');
    await removeAgentChatMedia('a');
    expect(fs.existsSync(a)).toBe(false);
    expect(fs.existsSync(agentMediaDir('a'))).toBe(false);
    expect(fs.existsSync(transcript)).toBe(true);
    expect(fs.existsSync(b)).toBe(true);
  });

  it('is fine when there is nothing to remove', async () => {
    await expect(removeAgentChatMedia('missing')).resolves.toBeUndefined();
  });
});
