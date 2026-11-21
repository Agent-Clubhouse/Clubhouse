import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { NoticePageIndex, type NoticeJson, type NoticePageRoot } from './pages';
import { PreparedNoticeReader, noticeSequenceKey, type PreparedNoticeRoots } from './sparse-reader';
import { PreparedNoticeState, type SparseNoticeDelta } from './sparse-state';
import { applyNoticeDelta, noticeCoverageDigest, type NoticeDelta, type SequencedNoticeState } from './state';

const homes: string[] = [];
async function home() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'q5-root-state-')); homes.push(dir); return dir; }
afterEach(async () => { await Promise.all(homes.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });
const recipient = { groupId: 'synthetic-group', host: null, agentId: 'synthetic-agent', generation: 'member-generation' };
const post = (seq: number) => ({ seq, postId: `post-${String(seq).padStart(6, '0')}` });
const scan = (seq: number): SparseNoticeDelta => ({ kind: 'scan', through: seq, eligible: [post(seq)] });
const intent = (seq: number): SparseNoticeDelta => ({ kind: 'intent', attemptId: `attempt-${seq}`, posts: [post(seq)], handoffProcess: 'process-one', startedAt: 1 });
const ack = (seq: number): SparseNoticeDelta => ({ kind: 'settle', attemptId: `attempt-${seq}`, outcome: 'accepted', acknowledgement: { kind: 'same-process-exact-handoff', handoffProcess: 'process-one', coverageDigest: noticeCoverageDigest([post(seq)]) } });
const initial = () => applyNoticeDelta(undefined, { kind: 'initialize', recipient, baseline: 0 });
async function all(index: NoticePageIndex, root: NoticePageRoot | undefined) {
  const values: { key: string; value: NoticeJson }[] = [];
  let after: string | undefined;
  do {
    const page = await index.list(root, { after, limit: 50 }); values.push(...page.entries); after = page.nextAfter;
  } while (after);
  return values;
}
/** Bounded test oracle only; never used by the production root transitions. */
async function assertOracle(index: NoticePageIndex, state: PreparedNoticeState, model: SequencedNoticeState) {
  const h = state.preparedHeader;
  await PreparedNoticeReader.openPrepared(index, h);
  const { roots: _roots, profile, ...metadata } = h;
  const { terminal: _terminal, pending: _pending, attempts: _attempts, ...expected } = model;
  expect(profile).toBe('sequenced-sparse-v1');
  expect({ ...metadata, minWriterVersion: 1 }).toEqual(expected);
  expect((await all(index, h.roots.terminal)).map((v) => v.value)).toEqual(model.terminal);
  expect((await all(index, h.roots.pending)).map((v) => v.value)).toEqual([...model.pending].sort((a, b) => a.seq - b.seq));
  expect((await all(index, h.roots.attempts)).map((v) => v.value)).toEqual([...model.attempts].sort((a, b) => a.attemptId < b.attemptId ? -1 : a.attemptId > b.attemptId ? 1 : 0));
}
async function seed(index: NoticePageIndex, model: SequencedNoticeState) {
  const build = async (entries: { key: string; value: unknown }[]) => index.build(entries.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0) as { key: string; value: NoticeJson }[]);
  const roots: PreparedNoticeRoots['roots'] = {
    terminal: await build(model.terminal.map((r) => ({ key: noticeSequenceKey(r[0]), value: r }))),
    pending: await build(model.pending.map((p) => ({ key: noticeSequenceKey(p.seq), value: p }))),
    ready: await build(model.pending.filter((p) => p.attemptId === undefined).map((p) => ({ key: noticeSequenceKey(p.seq), value: p.postId }))),
    attempts: await build(model.attempts.map((a) => ({ key: a.attemptId, value: a }))),
    active: await build(model.attempts.filter((a) => a.status !== 'uncertain').map((a) => ({ key: a.attemptId, value: true }))),
    postIds: await build(model.pending.map((p) => ({ key: p.postId, value: p.seq }))),
  };
  const { terminal: _terminal, pending: _pending, attempts: _attempts, ...metadata } = model;
  return PreparedNoticeState.openPrepared(index, { ...metadata, minWriterVersion: 2, profile: 'sequenced-sparse-v1', roots });
}

describe('prepared root transitions, no journal/activation/receipt authority', () => {
  it('matches the independent full-array reducer through uncertainty, later acceptance, exclusion and genuine late ACK', async () => {
    const index = await NoticePageIndex.open(await home());
    let state = PreparedNoticeState.initialize(index, recipient, 0); let model = initial();
    const deltas: SparseNoticeDelta[] = [scan(1), intent(1), { kind: 'settle', attemptId: 'attempt-1', outcome: 'uncertain' },
      scan(3), intent(3), { kind: 'queued', attemptId: 'attempt-3', messageId: 'runtime-item' }, ack(3),
      scan(2), scan(4), intent(4), { kind: 'settle', attemptId: 'attempt-4', outcome: 'unsubmitted' }, intent(4), ack(4), ack(1), ack(1),
      { kind: 'queued', attemptId: 'attempt-1', messageId: 'late-result' }];
    for (const delta of deltas) {
      const prior = state; const before = prior.preparedHeader;
      state = await state.prepare(delta); model = applyNoticeDelta(model, delta as NoticeDelta);
      expect(prior.preparedHeader).toEqual(before); await assertOracle(index, state, model);
    }
    expect(state.preparedHeader.lateAcknowledgementCount).toBe(1);
    expect(await (await PreparedNoticeReader.openPrepared(index, state.preparedHeader)).legacyFloor()).toBe(4);
  });

  it('keeps >256 old uncertainty rows accessible while incrementally accepting later work and merging a million-position span', async () => {
    const directory = await home(); const index = await NoticePageIndex.open(directory); let model = initial();
    for (let n = 1; n <= 257; n++) for (const d of [scan(n), intent(n), { kind: 'settle', attemptId: `attempt-${n}`, outcome: 'uncertain' }] as NoticeDelta[]) model = applyNoticeDelta(model, d);
    let state = await seed(index, model); const old = state.preparedHeader;
    for (const delta of [scan(1_000_001), intent(1_000_001), ack(1_000_001)]) { state = await state.prepare(delta); model = applyNoticeDelta(model, delta as NoticeDelta); }
    expect(state.preparedHeader.roots.terminal?.count).toBe(1);
    expect(state.preparedHeader.roots.pending?.count).toBe(257);
    expect(state.preparedHeader.roots.attempts?.count).toBe(257);
    expect((await state.listReady({ limit: 50 })).posts).toEqual([]);
    await index.flush(); const cold = await NoticePageIndex.open(directory); const reopened = await PreparedNoticeState.openPrepared(cold, state.preparedHeader);
    await assertOracle(cold, reopened, model);
    const reader = await PreparedNoticeReader.openPrepared(cold, reopened.preparedHeader);
    expect((await reader.attempt('attempt-1'))?.status).toBe('uncertain'); expect(await reader.legacyFloor()).toBe(0);
    expect((await PreparedNoticeReader.openPrepared(cold, old)).preparedHeader.scannedThrough).toBe(257);
    expect(cold.cacheStats.leafPages).toBeLessThanOrEqual(4); expect(cold.cacheStats.indexPages).toBeLessThanOrEqual(16);
    expect(cold.cacheStats.peakLeafEntries).toBeLessThanOrEqual(256);
    expect((await fs.readdir(directory)).includes('manifest.json')).toBe(false);
  }, 60000);

  it('recovers only explicitly selected at-most50 active attempts per transition; recovered attempts never gain ACK or retry authority', async () => {
    const index = await NoticePageIndex.open(await home()); let model = initial();
    for (let n = 1; n <= 51; n++) for (const d of [scan(n), intent(n), { kind: 'queued', attemptId: `attempt-${n}` }] as NoticeDelta[]) model = applyNoticeDelta(model, d);
    let state = await seed(index, model);
    const first = await state.listActive({ limit: 50 }); expect(first.attemptIds).toHaveLength(50);
    state = await state.prepare({ kind: 'recover', attemptIds: first.attemptIds });
    expect(state.preparedHeader.roots.active?.count).toBe(1);
    await expect(state.prepare({ kind: 'recover', attemptIds: model.attempts.map((a) => a.attemptId) })).rejects.toThrow('batch');
    const remaining = await state.listActive({ limit: 50 }); state = await state.prepare({ kind: 'recover', attemptIds: remaining.attemptIds });
    model = applyNoticeDelta(model, { kind: 'recover' }); await assertOracle(index, state, model);
    expect(await state.prepare({ kind: 'recover', attemptIds: first.attemptIds })).toBe(state);
    await expect(state.prepare(ack(1))).rejects.toThrow('Recovered');
    await expect(state.prepare({ kind: 'settle', attemptId: 'attempt-1', outcome: 'unsubmitted' })).rejects.toThrow('Uncertainty');
    await expect(state.prepare({ ...intent(1), attemptId: 'blind-retry' })).rejects.toThrow('not ready');
    state = await state.prepare(scan(52)); expect((await state.listReady({ limit: 50 })).posts).toEqual([post(52)]);
  }, 30000);

  it('owns input before an await and failed preparation cannot alter old roots or confer committed authority', async () => {
    const directory = await home(); let fail = false;
    const index = await NoticePageIndex.open(directory, { testFailure: (point) => { if (fail && point === 'beforePageWrite') throw new Error('synthetic-write-failure'); } });
    const initial = PreparedNoticeState.initialize(index, recipient, 0);
    const input = { kind: 'scan' as const, through: 1, eligible: [post(1)] };
    const pending = initial.prepare(input); input.through = 999; input.eligible[0].postId = 'mutated-after-call';
    const state = await pending; expect((await state.listReady({ limit: 50 })).posts).toEqual([post(1)]);
    const snapshot = state.preparedHeader; state.preparedHeader.recipient.agentId = 'mutated-copy'; fail = true;
    await expect(state.prepare(scan(2))).rejects.toThrow('synthetic-write-failure'); expect(state.preparedHeader).toEqual(snapshot);
    fail = false; const good = await state.prepare(scan(3));
    await PreparedNoticeState.openPrepared(index, good.preparedHeader);
    expect(state.preparedHeader).toEqual(snapshot); expect(initial.preparedHeader.roots).toEqual({});
    expect((await fs.readdir(directory)).some((n) => /manifest|journal/.test(n))).toBe(false);
  });

  it('admits cap50 equality, rejects truncated scan frontier/conflicting identities and preserves scan-time exclusions', async () => {
    const index = await NoticePageIndex.open(await home()); const state = PreparedNoticeState.initialize(index, recipient, 0);
    const eligible = Array.from({ length: 50 }, (_, n) => post(n + 1));
    await expect(state.prepare({ kind: 'scan', through: 100, eligible })).rejects.toThrow('Capped');
    const full = await state.prepare({ kind: 'scan', through: 50, eligible }); expect((await full.listReady({ limit: 50 })).posts).toEqual(eligible);
    await expect(full.prepare({ kind: 'scan', through: 51, eligible: [{ seq: 1, postId: 'wrong' }] })).rejects.toThrow('identity');
    await expect(full.prepare({ kind: 'scan', through: 51, eligible: [{ seq: 51, postId: post(1).postId }] })).rejects.toThrow('identity');
    const excluded = await full.prepare({ kind: 'scan', through: 100, eligible: [] });
    expect(await excluded.prepare(scan(75))).toBe(excluded);
    expect(excluded.preparedHeader.excludedSequenceCount).toBe(50);
    await expect(full.listReady({ limit: 51 })).rejects.toThrow('limit');
  });

  it('matches multiple bounded scan/intent/settlement combinations and coalesces terminal neighbours without skipping holes', async () => {
    const index = await NoticePageIndex.open(await home()); let state = PreparedNoticeState.initialize(index, recipient, 0); let model = initial();
    for (let n = 1; n <= 24; n++) {
      const seq = n * 3;
      const outcome = n % 4 === 0 ? 'unsubmitted' : n % 3 === 0 ? 'uncertain' : 'accepted';
      for (const delta of [scan(seq), intent(seq), outcome === 'accepted' ? ack(seq) : { kind: 'settle', attemptId: `attempt-${seq}`, outcome }] as SparseNoticeDelta[]) {
        state = await state.prepare(delta); model = applyNoticeDelta(model, delta as NoticeDelta);
      }
      if (n % 6 === 0) await assertOracle(index, state, model);
    }
    await assertOracle(index, state, model);
  }, 30000);

  it('keeps sequence/counters exact near MAX_SAFE_INTEGER without unsafe add-then-subtract intermediates', async () => {
    const index = await NoticePageIndex.open(await home()); const max = Number.MAX_SAFE_INTEGER;
    let state = PreparedNoticeState.initialize(index, recipient, 0); let model = initial();
    for (const d of [{ kind: 'scan', through: max - 3, eligible: [] }, scan(max - 1), intent(max - 1), ack(max - 1), { kind: 'scan', through: max, eligible: [] }] as SparseNoticeDelta[]) {
      state = await state.prepare(d); model = applyNoticeDelta(model, d as NoticeDelta);
    }
    await assertOracle(index, state, model); expect(state.preparedHeader.acceptedCount).toBe(1); expect(state.preparedHeader.excludedSequenceCount).toBe(max - 1);
  });

  it('refuses unknown structural fields at header/recipient/transition boundaries without stripping or publishing them', async () => {
    const index = await NoticePageIndex.open(await home()); const state = PreparedNoticeState.initialize(index, recipient, 0); const header = state.preparedHeader;
    await expect(PreparedNoticeState.openPrepared(index, { ...header, future: true })).rejects.toThrow('header');
    await expect(PreparedNoticeState.openPrepared(index, { ...header, recipient: { ...recipient, future: true } })).rejects.toThrow('header');
    await expect(state.prepare({ ...scan(1), future: true } as SparseNoticeDelta)).rejects.toThrow('fields');
    await expect(state.prepare({ ...scan(1), future: undefined } as SparseNoticeDelta)).rejects.toThrow('fields');
    await expect(state.prepare({ kind: 'scan', through: 1, eligible: [{ ...post(1), body: 'must-not-be-stored' }] } as SparseNoticeDelta)).rejects.toThrow('fields');
    expect(state.preparedHeader).toEqual(header);
  });
});
