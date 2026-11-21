import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { NoticeFramedJournal, type NoticePhysicalFailurePoint } from './framed-journal';
import { sparseRootCodec, noticeHeaderDigest, type NoticeRootInput, type NoticeRootRecord, type NoticeRootState } from './root-codec';
import { noticeRecipientKey } from './state';

const recipient = { groupId: 'synthetic-group', host: null, agentId: 'synthetic-agent', generation: 'synthetic-generation' };
const installationId = '11111111-2222-3333-4444-555555555555';
type Store = NoticeFramedJournal<NoticeRootState, NoticeRootInput, NoticeRootRecord>;
const stores: Store[] = []; const homes: string[] = [];
async function home() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'q5-root-codec-')); homes.push(dir); return dir; }
async function open(directory: string, options: { testFailure?: (point: NoticePhysicalFailurePoint) => void | Promise<void>; published?: (state: NoticeRootState, record: NoticeRootRecord) => void } = {}) {
  const store = await NoticeFramedJournal.open({ directory, recipientKey: noticeRecipientKey(recipient), installationId,
    codec: sparseRootCodec(directory, recipient), ...options });
  stores.push(store); return store;
}
async function initialize(store: Store) {
  await store.append({ expectedHeaderDigest: null, delta: { kind: 'initialize', recipient, baseline: 0 } });
}
function scan(store: Store, seq: number): NoticeRootInput {
  return { expectedHeaderDigest: noticeHeaderDigest(store.current!.header), delta: { kind: 'scan', through: seq, eligible: [{ seq, postId: `synthetic-${seq}` }] } };
}
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  await Promise.all(homes.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('private root codec development', () => {
  it('commits roots and checkpoint/reopens complete sparse state without a send or automatic recovery', async () => {
    const directory = await home(); let store = await open(directory); await initialize(store);
    await store.append(scan(store, 1));
    await store.append({ expectedHeaderDigest: noticeHeaderDigest(store.current!.header), delta: {
      kind: 'intent', attemptId: 'synthetic-attempt', posts: [{ seq: 1, postId: 'synthetic-1' }], startedAt: 1, handoffProcess: 'synthetic-process-data-not-a-receipt',
    } });
    const before = structuredClone(store.current!.header); const revision = store.committedRevision;
    await store.checkpoint(); await store.close(); store = await open(directory);
    expect(store.committedRevision).toBe(revision); expect(store.current!.header).toEqual(before);
    expect((await store.current!.prepared!.listActive({ limit: 50 })).attemptIds).toEqual(['synthetic-attempt']);
    // File open is not ledger-owner recovery/admission; no handoff API exists here.
    expect(store.current!.prepared).toBeDefined();
  });

  it('serializes candidate expectations so a stale second root cannot overwrite the first', async () => {
    const store = await open(await home()); await initialize(store);
    const first = scan(store, 1); const stale = scan(store, 2); const revision = store.committedRevision;
    const outcomes = await Promise.allSettled([store.append(first), store.append(stale)]);
    expect(outcomes.map((o) => o.status)).toEqual(['fulfilled', 'rejected']);
    expect(store.committedRevision).toBe(revision + 1); expect(store.current!.header.scannedThrough).toBe(1);
    expect(store.healthy).toBe(true);
    await store.append(scan(store, 2)); expect(store.current!.header.scannedThrough).toBe(2);
  });

  it('refuses a duplicate process owner and releases a closed owner for explicit reopen', async () => {
    const directory = await home(); const store = await open(directory); await initialize(store);
    await expect(open(path.join(directory, '.'))).rejects.toMatchObject({ code: 'notice_ledger_open' });
    await store.close(); const replacement = await open(directory);
    expect(replacement.current!.header.baselineThrough).toBe(0);
    await expect(store.append(scan(replacement, 1))).rejects.toMatchObject({ code: 'notice_ledger_unavailable' });
  });

  it('holds all candidate state/publication until final append bookkeeping finishes', async () => {
    const directory = await home(); let enabled = false;
    let arrived!: () => void; let release!: () => void;
    const held = new Promise<void>((r) => { arrived = r; }); const released = new Promise<void>((r) => { release = r; });
    const published = vi.fn();
    const store = await open(directory, { published, testFailure: async (point) => {
      if (enabled && point === 'beforeFinalBookkeeping') { arrived(); await released; }
    } });
    await initialize(store); const header = structuredClone(store.current!.header); const revision = store.committedRevision; const digest = store.committedDigest;
    enabled = true; const pending = store.append(scan(store, 1));
    try {
      await held; expect(store.current!.header).toEqual(header); expect(store.committedRevision).toBe(revision);
      expect(store.committedDigest).toBe(digest); expect(published).toHaveBeenCalledTimes(1);
    } finally { release(); }
    await pending; expect(store.current!.header.scannedThrough).toBe(1); expect(published).toHaveBeenCalledTimes(2);
    // Capability-zero requires the later shared receipt-owner consumer tests.
  });

  it('releases no-effect validation while ambiguous after-sync failure poisons and reopens committed bytes', async () => {
    const directory = await home(); let enabled = false;
    let store = await open(directory, { testFailure: (point) => { if (enabled && point === 'afterSync') throw new Error('synthetic-ambiguous-sync'); } });
    await initialize(store); const revision = store.committedRevision;
    await expect(store.append({ expectedHeaderDigest: noticeHeaderDigest(store.current!.header), delta: { kind: 'scan', through: -1, eligible: [] } })).rejects.toThrow('sequence');
    expect(store.healthy).toBe(true); expect(store.committedRevision).toBe(revision);
    enabled = true; await expect(store.append(scan(store, 1))).rejects.toThrow('synthetic-ambiguous-sync');
    expect(store.healthy).toBe(false); expect(store.current!.header.scannedThrough).toBe(0);
    await store.close(); store = await open(directory); expect(store.current!.header.scannedThrough).toBe(1);
  });

  it('refuses installation/full-owner mismatch and missing committed pages without rebuilding them', async () => {
    const directory = await home(); const store = await open(directory); await initialize(store); await store.append(scan(store, 1));
    const root = store.current!.header.roots.pending!; await store.close();
    const manifestPath = path.join(directory, 'manifest.json'); const before = await fs.readFile(manifestPath);
    await expect(NoticeFramedJournal.open({ directory, recipientKey: noticeRecipientKey(recipient), installationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', codec: sparseRootCodec(directory, recipient) })).rejects.toThrow('installation');
    await expect(NoticeFramedJournal.open({ directory, recipientKey: noticeRecipientKey(recipient), installationId, codec: sparseRootCodec(directory, { ...recipient, generation: 'wrong-generation' }) })).rejects.toThrow('recipient');
    expect(await fs.readFile(manifestPath)).toEqual(before);
    const location = path.join(directory, 'index', root.digest.slice(0, 2), `${root.digest}.json`);
    await fs.unlink(location); await expect(open(directory)).rejects.toThrow();
    await expect(fs.lstat(location)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
