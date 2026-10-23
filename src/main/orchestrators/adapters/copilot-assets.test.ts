import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { CopilotAssetReader } from './copilot-assets';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-assets-'));
const stateDir = path.join(tmpRoot, 'session-state');
const SESSION = '4f2c9a1e-0000-4000-8000-000000002421';
const journal = path.join(stateDir, SESSION, 'events.jsonl');

function png(padding = 0): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 3, 8, 6, 0, 0, 0, ...new Array(padding).fill(7)]);
}
const idOf = (b: Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

/** Journal lines as Copilot CLI 1.0.103 writes them: the asset just before the tool's completion. */
function assetLines(bytes: Buffer, assetId = idOf(bytes)): string {
  const asset = {
    type: 'session.binary_asset',
    data: { assetId, type: 'image', mimeType: 'image/png', byteLength: bytes.length, data: bytes.toString('base64'), description: 'Image file at path /tmp/shot.png' },
    id: 'e6b9b3aa-36ec-4a81-902a-6e7ad9e78179', timestamp: '2026-10-22T00:00:00.000Z', parentId: null,
  };
  const complete = {
    type: 'tool.execution_complete',
    data: { toolCallId: 't1', success: true, result: { content: 'Viewed image file successfully.', binaryResultsForLlm: [{ type: 'image', assetId, mimeType: 'image/png', byteLength: bytes.length }] } },
    id: 'f0000000-0000-4000-8000-000000000001', timestamp: '2026-10-22T00:00:00.001Z', parentId: 'e6b9b3aa-36ec-4a81-902a-6e7ad9e78179',
  };
  return `${JSON.stringify(asset)}\n${JSON.stringify(complete)}\n`;
}

/** Ordinary journal lines, `bytes` long in all. */
function filler(bytes: number): string {
  const line = `${JSON.stringify({ type: 'assistant.message', data: { content: 'x'.repeat(1000) } })}\n`;
  return line.repeat(Math.ceil(bytes / line.length));
}

const reader = (opts: ConstructorParameters<typeof CopilotAssetReader>[1] = {}) => new CopilotAssetReader(stateDir, { retryDelaysMs: [], ...opts });

beforeEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(stateDir, SESSION), { recursive: true });
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('CopilotAssetReader', () => {
  it('reads an asset from the session journal and checks its hash', async () => {
    const bytes = png(64);
    fs.writeFileSync(journal, filler(10_000) + assetLines(bytes) + filler(10_000));
    const result = await reader().read(SESSION, idOf(bytes));
    expect(result.ok).toBe(true);
    expect(Buffer.from(result.bytes!)).toEqual(bytes);
  });

  it('refuses bytes that do not hash to the asset id', async () => {
    const claimed = idOf(png(1));
    fs.writeFileSync(journal, assetLines(png(2), claimed));
    expect(await reader().read(SESSION, claimed)).toEqual({ ok: false, reason: 'hash_mismatch' });
  });

  it('says not_found for an asset the journal lacks, and finds one appended later', async () => {
    const first = png(1);
    const later = png(2);
    fs.writeFileSync(journal, assetLines(first));
    const r = reader();
    expect((await r.read(SESSION, idOf(first))).ok).toBe(true);
    expect(await r.read(SESSION, idOf(later))).toEqual({ ok: false, reason: 'not_found' });
    fs.appendFileSync(journal, assetLines(later));
    expect((await r.read(SESSION, idOf(later))).ok).toBe(true);
  });

  it('waits briefly for an asset whose journal write lands after the tool result', async () => {
    const bytes = png(3);
    fs.writeFileSync(journal, filler(1000));
    const pending = reader({ retryDelaysMs: [20, 20] }).read(SESSION, idOf(bytes));
    setTimeout(() => fs.appendFileSync(journal, assetLines(bytes)), 5);
    expect((await pending).ok).toBe(true);
  });

  it('does not index a line still being written', async () => {
    const bytes = png(4);
    const lines = assetLines(bytes);
    fs.writeFileSync(journal, lines.slice(0, 40));
    const r = reader();
    expect(await r.read(SESSION, idOf(bytes))).toEqual({ ok: false, reason: 'not_found' });
    fs.appendFileSync(journal, lines.slice(40));
    expect((await r.read(SESSION, idOf(bytes))).ok).toBe(true);
  });

  it('starts over when the journal is replaced', async () => {
    const a = png(5);
    const b = png(6);
    fs.writeFileSync(journal, filler(50_000) + assetLines(a));
    const r = reader();
    expect((await r.read(SESSION, idOf(a))).ok).toBe(true);
    // Compaction writes a new, shorter file in place of the old one.
    const next = `${journal}.new`;
    fs.writeFileSync(next, assetLines(b));
    fs.renameSync(next, journal);
    expect((await r.read(SESSION, idOf(b))).ok).toBe(true);
  });

  it('finds a fresh asset at the end of a journal larger than the scan budget', async () => {
    const early = png(7);
    const bytes = png(8);
    // 96 MiB: more than one lookup may scan (64 MiB), so only the end is read.
    const fd = fs.openSync(journal, 'w');
    try {
      fs.writeSync(fd, assetLines(early));
      const block = Buffer.from(filler(8 * 1024 * 1024));
      for (let written = 0; written < 96 * 1024 * 1024; written += block.length) fs.writeSync(fd, block);
      fs.writeSync(fd, assetLines(bytes));
    } finally {
      fs.closeSync(fd);
    }
    const r = reader();
    const started = Date.now();
    const result = await r.read(SESSION, idOf(bytes));
    expect(result.ok).toBe(true);
    expect(Buffer.from(result.bytes!)).toEqual(bytes);
    // The budget bounds each lookup: an asset before the scanned tail isn't searched for.
    expect(await r.read(SESSION, idOf(early))).toEqual({ ok: false, reason: 'not_found' });
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);

  it('enforces a smaller scan budget too', async () => {
    const bytes = png(9);
    fs.writeFileSync(journal, assetLines(bytes) + filler(200_000));
    expect(await reader({ scanBudgetBytes: 100_000 }).read(SESSION, idOf(bytes))).toEqual({ ok: false, reason: 'not_found' });
    expect((await reader({ scanBudgetBytes: 1_000_000 }).read(SESSION, idOf(bytes))).ok).toBe(true);
  });

  it('finds an asset line that crosses a tail window boundary', async () => {
    const bytes = png(12);
    const [assetLine, rest] = assetLines(bytes).split(/(?<=\n)/);
    // The 4 MiB tail window starts 20 bytes before the asset line ends: the next window must finish it.
    const pad = `${JSON.stringify({ type: 'pad', d: '' })}`;
    const padLine = `${pad.slice(0, -2)}${'x'.repeat(4 * 1024 * 1024 - 20 - rest.length - pad.length - 1)}"}\n`;
    const prefix = filler(1024 * 1024);
    fs.writeFileSync(journal, prefix + assetLine + rest + padLine);
    const boundary = fs.statSync(journal).size - 4 * 1024 * 1024;
    expect(boundary).toBe(prefix.length + assetLine.length - 20);
    expect((await reader().read(SESSION, idOf(bytes))).ok).toBe(true);
  });

  it('stops waiting in a session where waiting never helps, and starts again after a find', async () => {
    fs.writeFileSync(journal, filler(1000));
    const r = reader({ retryDelaysMs: [60, 60] });
    const timed = async (id: string) => { const t = Date.now(); const res = await r.read(SESSION, id); return { res, ms: Date.now() - t }; };
    expect((await timed(idOf(png(20)))).ms).toBeGreaterThanOrEqual(100);
    expect((await timed(idOf(png(21)))).ms).toBeGreaterThanOrEqual(100);
    const third = await timed(idOf(png(22)));
    expect(third.res).toEqual({ ok: false, reason: 'not_found' });
    expect(third.ms).toBeLessThan(100);
    fs.appendFileSync(journal, assetLines(png(23)));
    expect((await r.read(SESSION, idOf(png(23)))).ok).toBe(true);
    expect((await timed(idOf(png(24)))).ms).toBeGreaterThanOrEqual(100);
  });

  it('indexes again when the journal is rewritten in place', async () => {
    const bytes = png(13);
    fs.writeFileSync(journal, assetLines(bytes));
    const r = reader();
    expect((await r.read(SESSION, idOf(bytes))).ok).toBe(true);
    // Same inode, longer content: the old offsets now point into other lines.
    fs.writeFileSync(journal, filler(5000) + assetLines(bytes));
    expect((await r.read(SESSION, idOf(bytes))).ok).toBe(true);
  });

  it('refuses session ids that are not a plain token, and asset ids that are not sha256', async () => {
    const bytes = png(10);
    fs.writeFileSync(journal, assetLines(bytes));
    for (const id of ['..', '../session-state', `${SESSION}/..`, '', null]) {
      expect(await reader().read(id, idOf(bytes))).toEqual({ ok: false, reason: 'no_session' });
    }
    expect(await reader().read(SESSION, '/etc/passwd')).toEqual({ ok: false, reason: 'bad_asset_id' });
    expect(await reader().read(SESSION, idOf(bytes).toUpperCase())).toEqual({ ok: false, reason: 'bad_asset_id' });
  });

  it('never uses a Windows device name as a session folder', async () => {
    for (const id of ['CON', 'nul', 'COM1', 'lpt9', 'AUX']) expect(await reader().read(id, idOf(png()))).toEqual({ ok: false, reason: 'no_session' });
  });

  it('says the journal is unreadable when the session has none', async () => {
    expect(await reader().read('no-such-session', idOf(png()))).toEqual({ ok: false, reason: 'journal_unreadable' });
  });

  it.skipIf(process.platform === 'win32')('refuses a session folder or journal that is a symlink out of the session-state folder', async () => {
    const outside = path.join(tmpRoot, 'outside');
    fs.rmSync(outside, { recursive: true, force: true });
    fs.mkdirSync(outside, { recursive: true });
    const bytes = png(11);
    fs.writeFileSync(path.join(outside, 'events.jsonl'), assetLines(bytes));

    fs.symlinkSync(outside, path.join(stateDir, 'linked'));
    expect(await reader().read('linked', idOf(bytes))).toEqual({ ok: false, reason: 'session_dir_rejected' });

    fs.symlinkSync(path.join(outside, 'events.jsonl'), journal);
    expect(await reader().read(SESSION, idOf(bytes))).toEqual({ ok: false, reason: 'session_dir_rejected' });
  });

  it.skipIf(process.platform === 'win32')('refuses a journal that is not a regular file', async () => {
    fs.mkdirSync(journal);
    expect(await reader().read(SESSION, idOf(png()))).toEqual({ ok: false, reason: 'session_dir_rejected' });
  });
});
