import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { NoticeJournalOwner, type NoticeJournalOptions, type NoticeOwnerDelta } from './journal';
import { NoticeFramedJournal } from './framed-journal';
import { sparseRootCodec, noticeHeaderDigest } from './root-codec';
import { PreparedNoticeState } from './sparse-state';
import { noticeRecipientKey } from './state';

const recipient = { groupId: 'synthetic-group', host: null, agentId: 'synthetic-agent', generation: 'synthetic-generation' };
const installationId = '11111111-2222-3333-4444-555555555555';
type Owner = Awaited<ReturnType<typeof NoticeJournalOwner.openLegacy>> | Awaited<ReturnType<typeof NoticeJournalOwner.openSparse>>;
const owners: Owner[] = []; const homes: string[] = [];
async function home() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'q5-owner-')); homes.push(dir); return dir; }
async function open(profile: 'legacy' | 'sparse', directory: string, extra: Pick<NoticeJournalOptions, 'testFailure'> = {}) {
  const options = { directory, recipient, installationId, ...extra };
  const owner = profile === 'legacy' ? await NoticeJournalOwner.openLegacy(options) : await NoticeJournalOwner.openSparse(options);
  owners.push(owner); return owner;
}
async function initialized(profile: 'legacy' | 'sparse', extra: Pick<NoticeJournalOptions, 'testFailure'> = {}) {
  const directory = await home(); const owner = await open(profile, directory, extra);
  await owner.append({ kind: 'initialize', recipient, baseline: 0 }); return { directory, owner };
}
async function intent(owner: Owner, seq: number) {
  await owner.append({ kind: 'scan', through: seq, eligible: [{ seq, postId: `synthetic-${seq}` }] });
  await owner.append({ kind: 'intent', attemptId: `attempt-${seq}`, posts: [{ seq, postId: `synthetic-${seq}` }], startedAt: 1 });
  return owner.captureLiveHandoff(`attempt-${seq}`);
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const owner of owners.splice(0)) await owner.close();
  await Promise.all(homes.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe.each(['legacy', 'sparse'] as const)('shared journal ownership: %s', (profile) => {
  it('keeps entered coverage uncertain after released handles, while later useful work continues', async () => {
    const { directory, owner } = await initialized(profile);
    const handle = await intent(owner, 1); const sibling = await owner.captureLiveHandoff('attempt-1');
    expect(owner.tryMarkHandoffEntered(handle)).toBe('entered');
    expect(owner.tryMarkHandoffEntered(sibling)).toBe('journal_owned');
    const revision = owner.committedRevision;
    expect(owner.claimLoss(sibling, 'unknown')).toEqual({ kind: 'journal_owned' });
    expect(owner.committedRevision).toBe(revision);
    owner.releaseLiveHandoff(handle);
    await owner.append({ kind: 'settle', attemptId: 'attempt-1', outcome: 'unsubmitted' });
    expect(owner.retention.activeAnchors).toBe(0); expect(owner.admitting).toBe(true);
    await expect(owner.captureLiveHandoff('attempt-1')).rejects.toThrow('No exact');
    const later = await intent(owner, 2); expect(owner.tryMarkHandoffEntered(later)).toBe('entered');
    // Synthetic main-sink receipt capability, not a live provider ACK mapper.
    await owner.acknowledgeLiveHandoff(later); expect(owner.snapshot()!.acceptedCount).toBe(1);
    await owner.close(); const reopened = await open(profile, directory);
    expect(reopened.snapshot()!.acceptedCount).toBe(1);
    await expect(reopened.captureLiveHandoff('attempt-1')).rejects.toThrow('No exact');
  });

  it('reports actual unsubmitted for persisted intent with no runtime hook/entry', async () => {
    const { owner } = await initialized(profile); const handle = await intent(owner, 1);
    const revision = owner.committedRevision; // Intent already durable before a createHandoff refusal.
    const claim = owner.claimLoss(handle, 'unsubmitted'); expect(claim.kind).toBe('claimed');
    expect(owner.tryMarkHandoffEntered(handle)).toBe('journal_owned');
    if (claim.kind !== 'claimed') throw new Error('Expected exact loss producer');
    expect(await claim.committed).toEqual({ committedOutcome: 'unsubmitted' });
    expect(owner.committedRevision).toBe(revision + 1); expect(owner.retention).toEqual({ activeAnchors: 0, pendingClaims: 0 });
    expect(owner.tryMarkHandoffEntered(handle)).toBe('journal_owned');
  });

  it('registers ACK synchronously before loss and preserves unrelated entered attempts', async () => {
    let hold = false; let arrived!: () => void; let release!: () => void;
    const held = new Promise<void>((r) => { arrived = r; }); const released = new Promise<void>((r) => { release = r; });
    const { owner } = await initialized(profile, { testFailure: async (point) => { if (hold && point === 'beforeAppend') { arrived(); await released; } } });
    const first = await intent(owner, 1); const second = await intent(owner, 2);
    expect(owner.tryMarkHandoffEntered(first)).toBe('entered');
    hold = true; const revision = owner.committedRevision; const ack = owner.acknowledgeLiveHandoff(first);
    expect(owner.claimLoss(first, 'unknown')).toEqual({ kind: 'journal_owned' });
    try { await held; expect(owner.tryMarkHandoffEntered(second)).toBe('entered'); }
    finally { hold = false; release(); }
    await ack; expect(owner.committedRevision).toBe(revision + 1); expect(owner.snapshot()!.acceptedCount).toBe(1);
    const loss = owner.claimLoss(second, 'unsubmitted');
    if (loss.kind !== 'claimed') throw new Error('Expected second loss producer');
    expect(await loss.committed).toEqual({ committedOutcome: 'uncertain' });
  });

  it('serializes loss first and genuine historical ACK second without a fictional loss disposition', async () => {
    const { owner } = await initialized(profile); const handle = await intent(owner, 1);
    expect(owner.tryMarkHandoffEntered(handle)).toBe('entered'); const revision = owner.committedRevision;
    const loss = owner.claimLoss(handle, 'unsubmitted'); const ack = owner.acknowledgeLiveHandoff(handle);
    expect(owner.claimLoss(handle, 'unknown')).toEqual({ kind: 'journal_owned' });
    if (loss.kind !== 'claimed') throw new Error('Expected first loss producer');
    expect(await loss.committed).toEqual({ committedOutcome: 'uncertain' }); await ack;
    expect(owner.committedRevision).toBe(revision + 2);
    expect(owner.snapshot()).toMatchObject({ acceptedCount: 1, lateAcknowledgementCount: 1 });
    expect(owner.retention).toEqual({ activeAnchors: 0, pendingClaims: 0 });
  });

  it('releases no-effect validation but never revives blocked candidate handles', async () => {
    const { owner } = await initialized(profile); const handle = await intent(owner, 1);
    const invalid = owner.append({ kind: 'settle', attemptId: 'attempt-1', outcome: 'invalid' } as unknown as NoticeOwnerDelta);
    expect(owner.tryMarkHandoffEntered(handle)).toBe('journal_owned');
    await expect(invalid).rejects.toThrow('settlement');
    expect(owner.healthy).toBe(true); expect(owner.retention.pendingClaims).toBe(0);
    expect(owner.tryMarkHandoffEntered(handle)).toBe('journal_owned');
    expect(owner.claimLoss(handle, 'unknown')).toEqual({ kind: 'journal_owned' });
    const later = await intent(owner, 2); expect(owner.tryMarkHandoffEntered(later)).toBe('entered');
  });

  it('keeps ambiguous failed ownership until close and reopens persisted uncertainty without minting ACK', async () => {
    let enabled = false;
    const { owner, directory } = await initialized(profile, { testFailure: (point) => { if (enabled && point === 'afterSync') throw new Error('synthetic-owner-sync-unknown'); } });
    const handle = await intent(owner, 1); expect(owner.tryMarkHandoffEntered(handle)).toBe('entered'); enabled = true;
    const loss = owner.claimLoss(handle, 'unknown'); if (loss.kind !== 'claimed') throw new Error('Expected owned loss');
    await expect(loss.committed).rejects.toThrow('synthetic-owner-sync-unknown');
    expect(owner.healthy).toBe(false); expect(owner.retention.pendingClaims).toBe(1);
    expect(owner.tryMarkHandoffEntered(handle)).toBe('journal_owned');
    await owner.close(); expect(owner.retention).toEqual({ activeAnchors: 0, pendingClaims: 0 });
    const reopened = await open(profile, directory); expect(reopened.admitting).toBe(true);
    await expect(reopened.captureLiveHandoff('attempt-1')).rejects.toThrow('No exact');
    await expect(reopened.acknowledgeLiveHandoff(handle)).rejects.toThrow('historical');
  });

  it('releases strong anchors on retire while keeping exact historical receipt isolated', async () => {
    const { owner } = await initialized(profile); const handle = await intent(owner, 1);
    expect(owner.tryMarkHandoffEntered(handle)).toBe('entered'); await owner.retire();
    expect(owner.admitting).toBe(false); expect(owner.retention.activeAnchors).toBe(0);
    expect(owner.tryMarkHandoffEntered(handle)).toBe('journal_owned');
    await owner.acknowledgeLiveHandoff(handle); expect(owner.snapshot()!.acceptedCount).toBe(1);
    expect(owner.retention.pendingClaims).toBe(0);
  });
});

async function priorActive(directory: string, count: number) {
  const store = await NoticeFramedJournal.open({ directory, recipientKey: noticeRecipientKey(recipient), installationId, codec: sparseRootCodec(directory, recipient) });
  try {
    await store.append({ expectedHeaderDigest: null, delta: { kind: 'initialize', recipient, baseline: 0 } });
    for (let seq = 1; seq <= count; seq++) {
      await store.append({ expectedHeaderDigest: noticeHeaderDigest(store.current!.header), delta: { kind: 'scan', through: seq, eligible: [{ seq, postId: `synthetic-${seq}` }] } });
      await store.append({ expectedHeaderDigest: noticeHeaderDigest(store.current!.header), delta: { kind: 'intent', attemptId: `attempt-${seq}`, posts: [{ seq, postId: `synthetic-${seq}` }], startedAt: 1, handoffProcess: 'synthetic-prior-process-not-live-proof' } });
    }
    return store.committedRevision;
  } finally { await store.close(); }
}
describe('root owner complete recovery', () => {
  it('walks51 active attempts as two committed batches, preserves holes and later useful work', async () => {
    const directory = await home(); const before = await priorActive(directory, 51);
    const owner = await open('sparse', directory);
    expect(owner.committedRevision).toBe(before + 2); expect(owner.admitting).toBe(true);
    const state = owner.snapshot()!; if (!('roots' in state)) throw new Error('Expected sparse profile');
    expect(state.roots.active).toBeUndefined(); expect(state.roots.attempts?.count).toBe(51);
    expect(owner.retention.activeAnchors).toBe(0);
    await expect(owner.captureLiveHandoff('attempt-1')).rejects.toThrow('No exact');
    const handle = await intent(owner, 52); expect(owner.tryMarkHandoffEntered(handle)).toBe('entered');
    await owner.acknowledgeLiveHandoff(handle); expect(owner.snapshot()!.acceptedCount).toBe(1);
  }, 60000);

  it('typed-refuses a forced no-progress recovery instead of spinning or admitting a send', async () => {
    const directory = await home(); await priorActive(directory, 1);
    const original = PreparedNoticeState.prototype.prepare; let calls = 0;
    const spy = vi.spyOn(PreparedNoticeState.prototype, 'prepare').mockImplementation(async function (input) {
      if (input.kind === 'recover') {
        calls++; if (calls > 2) throw new Error('bounded no-progress simulation did not stop');
        return this;
      }
      return original.call(this, input);
    });
    await expect(open('sparse', directory)).rejects.toMatchObject({ code: 'notice_ledger_reconciliation' });
    expect(calls).toBe(1); spy.mockRestore();
    const recovered = await open('sparse', directory); expect(recovered.admitting).toBe(true);
    await expect(recovered.captureLiveHandoff('attempt-1')).rejects.toThrow('No exact');
  });
});
