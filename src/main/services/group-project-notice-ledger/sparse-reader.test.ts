import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { NoticePageIndex, type NoticeJson } from './pages';
import { noticeCoverageDigest } from './state';
import { noticeSequenceKey, PreparedNoticeReader, type PreparedNoticeRoots } from './sparse-reader';

const homes: string[] = [];
async function home() { const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'q5-sparse-reader-')); homes.push(directory); return directory; }
afterEach(async () => { await Promise.all(homes.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });
const recipient = { groupId: 'synthetic-group', host: null, agentId: 'synthetic-member', generation: 'generation-one' };
const postId = (n: number) => `post-${String(n).padStart(6, '0')}`;
const attemptId = (n: number) => `attempt-${String(n).padStart(6, '0')}`;
const post = (n: number) => ({ seq: n * 2 + 1, postId: postId(n) });
function attempt(n: number, count: number) {
  const posts = [post(n)];
  return { attemptId: attemptId(n), coverageDigest: noticeCoverageDigest(posts), posts, startedAt: 1,
    status: n === count - 2 ? 'queued' : 'uncertain', handoffProcess: 'synthetic-process',
    ...(n === count - 2 ? { messageId: 'synthetic-queued-message' } : { reason: 'handoff_unknown' }) };
}
async function fixture(directory: string, count = 3) {
  const index = await NoticePageIndex.open(directory);
  const build = async (size: number, row: (n: number) => { key: string; value: NoticeJson }) => {
    function* entries() { for (let n = 0; n < size; n++) yield row(n); }
    return index.build(entries());
  };
  const roots: PreparedNoticeRoots['roots'] = {
    terminal: await build(count, (n) => ({ key: noticeSequenceKey(n * 2 + 2), value: [n * 2 + 2, n * 2 + 2] })),
    pending: await build(count, (n) => ({ key: noticeSequenceKey(post(n).seq), value: { ...post(n), ...(n === count - 1 ? {} : { attemptId: attemptId(n) }) } })),
    ready: await index.set(undefined, noticeSequenceKey(post(count - 1).seq), postId(count - 1)),
    attempts: await build(count - 1, (n) => ({ key: attemptId(n), value: attempt(n, count) })),
    active: await index.set(undefined, attemptId(count - 2), true),
    postIds: await build(count, (n) => ({ key: postId(n), value: post(n).seq })),
  };
  await index.flush();
  const header: PreparedNoticeRoots = { schemaVersion: 1, minWriterVersion: 2, profile: 'sequenced-sparse-v1', recipient,
    baselineThrough: 0, scannedThrough: count * 2, acceptedCount: count, excludedSequenceCount: 0, lateAcknowledgementCount: 0, roots };
  return { index, header };
}

describe('prepared sparse notice reader, no activation authority', () => {
  it('cold-verifies >256 uncertainty rows and pages later ready/active work without an all-record snapshot', async () => {
    const directory = await home();
    const { header } = await fixture(directory, 513);
    const cold = await NoticePageIndex.open(directory);
    const reader = await PreparedNoticeReader.openPrepared(cold, header);
    expect(cold.cacheStats.peakLeafEntries).toBeLessThanOrEqual(256);
    expect(cold.cacheStats.leafPages).toBeLessThanOrEqual(4);
    expect(cold.cacheStats.indexPages).toBeLessThanOrEqual(16);
    expect(Buffer.byteLength(JSON.stringify(reader.preparedHeader))).toBeLessThan(4096);
    expect(await reader.legacyFloor()).toBe(0);
    expect((await reader.attempt(attemptId(0)))?.status).toBe('uncertain');
    expect((await reader.listReady({ limit: 50 })).posts).toEqual([post(512)]);
    expect((await reader.listAttempts({ limit: 50, activeOnly: true })).attempts.map((a) => a.attemptId)).toEqual([attemptId(511)]);
    let count = 0; let after: string | undefined;
    do {
      const page = await reader.listAttempts({ limit: 50, after });
      expect(page.attempts.length).toBeLessThanOrEqual(50);
      for (const value of page.attempts) expect(value.attemptId).toBe(attemptId(count++));
      after = page.nextAfter;
    } while (after);
    expect(count).toBe(512);
    expect(cold.cacheStats.peakLeafEntries).toBeLessThanOrEqual(256);
    expect((await fs.readdir(directory)).includes('manifest.json')).toBe(false);
  }, 30000);

  it('copies header and returned rows, supports empty baseline and truthful contiguous floor', async () => {
    const { index, header } = await fixture(await home());
    const reader = await PreparedNoticeReader.openPrepared(index, header);
    header.scannedThrough = 999;
    reader.preparedHeader.recipient.generation = 'mutated';
    const row = (await reader.attempt(attemptId(0)))!; row.posts[0].postId = 'mutated';
    expect((await reader.attempt(attemptId(0)))?.posts[0].postId).toBe(postId(0));
    expect(reader.preparedHeader.scannedThrough).toBe(6);
    const empty = { ...reader.preparedHeader, baselineThrough: 7, scannedThrough: 7, acceptedCount: 0, roots: {} };
    expect(await (await PreparedNoticeReader.openPrepared(index, empty)).legacyFloor()).toBe(7);
    const terminal = await index.set(undefined, noticeSequenceKey(8), [8, 1000000000000]);
    const excluded = { ...empty, scannedThrough: 1000000000000, excludedSequenceCount: 1000000000000 - 7, roots: { terminal } };
    expect(await (await PreparedNoticeReader.openPrepared(index, excluded)).legacyFloor()).toBe(1000000000000);
  });

  it.each(['ready-missing', 'ready-owned', 'post-id-missing', 'post-id-orphan', 'attempt-missing', 'attempt-extra-post', 'active-missing', 'active-uncertain'])(
    'refuses cross-index damage: %s', async (kind) => {
      const { index, header } = await fixture(await home());
      const r = header.roots;
      if (kind === 'ready-missing') r.ready = undefined;
      if (kind === 'ready-owned') r.ready = await index.set(r.ready, noticeSequenceKey(1), postId(0));
      if (kind === 'post-id-missing') r.postIds = await index.delete(r.postIds, postId(0));
      if (kind === 'post-id-orphan') r.postIds = await index.set(r.postIds, 'orphan', 1);
      if (kind === 'attempt-missing') r.attempts = await index.delete(r.attempts, attemptId(0));
      if (kind === 'attempt-extra-post') {
        const posts = [post(0), post(2)];
        r.attempts = await index.set(r.attempts, attemptId(0), { ...attempt(0, 3), posts, coverageDigest: noticeCoverageDigest(posts) });
      }
      if (kind === 'active-missing') r.active = undefined;
      if (kind === 'active-uncertain') r.active = await index.set(r.active, attemptId(0), true);
      await expect(PreparedNoticeReader.openPrepared(index, header)).rejects.toThrow();
    });

  it.each(['gap', 'overlap', 'adjacent-terminal', 'counter', 'terminal-key', 'noncanonical-seq'])(
    'refuses incomplete/noncanonical coverage: %s', async (kind) => {
      const { index, header } = await fixture(await home());
      if (kind === 'gap') header.roots.terminal = await index.delete(header.roots.terminal, noticeSequenceKey(2));
      if (kind === 'overlap') header.roots.terminal = await index.set(header.roots.terminal, noticeSequenceKey(2), [2, 3]);
      if (kind === 'adjacent-terminal') {
        header.roots = { terminal: await index.build([{ key: noticeSequenceKey(1), value: [1, 1] }, { key: noticeSequenceKey(2), value: [2, 2] }]) };
        header.scannedThrough = 2; header.acceptedCount = 2;
      }
      if (kind === 'counter') header.acceptedCount++;
      if (kind === 'terminal-key') header.roots.terminal = await index.set(header.roots.terminal, noticeSequenceKey(2), [1, 2]);
      if (kind === 'noncanonical-seq') header.roots.pending = await index.set(header.roots.pending, '01', post(0));
      await expect(PreparedNoticeReader.openPrepared(index, header)).rejects.toThrow();
    });

  it('refuses future/ambiguous schema, malformed rows, missing pages and invalid read limits', async () => {
    const directory = await home(); const { index, header } = await fixture(directory);
    await expect(PreparedNoticeReader.openPrepared(index, { ...header, minWriterVersion: 3 })).rejects.toThrow('header');
    await expect(PreparedNoticeReader.openPrepared(index, { ...header, roots: { ...header.roots, unknown: header.roots.ready } })).rejects.toThrow('roots');
    const reader = await PreparedNoticeReader.openPrepared(index, header);
    await expect(reader.listReady({ limit: 51 })).rejects.toThrow('limit');
    await expect(reader.listAttempts({ limit: 0 })).rejects.toThrow('limit');
    const bad = await index.set(header.roots.attempts, attemptId(0), { ...attempt(0, 3), reason: 'made-up' });
    await expect(PreparedNoticeReader.openPrepared(index, { ...header, roots: { ...header.roots, attempts: bad } })).rejects.toThrow('reason');
    const root = header.roots.pending!;
    await fs.unlink(path.join(directory, root.digest.slice(0, 2), `${root.digest}.json`));
    index.clearCache();
    await expect(PreparedNoticeReader.openPrepared(index, header)).rejects.toThrow();
  });
});
