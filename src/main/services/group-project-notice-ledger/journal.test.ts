import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { NOTICE_PAGE_BYTES, SequencedNoticeJournal, type NoticeJournalFailurePoint } from './journal';
import { noticeLegacyFloor, type NoticeDelta } from './state';

const recipient = { groupId: 'synthetic-group', host: null, agentId: 'synthetic-member', generation: 'generation-one' };
const homes: string[] = [];
async function home() { const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'q5-journal-')); homes.push(directory); return directory; }
async function open(directory: string) { return SequencedNoticeJournal.open({ directory, recipient }); }
async function initialized(directory: string) {
  const journal = await open(directory);
  await journal.append({ kind: 'initialize', recipient, baseline: 0 });
  return journal;
}
const post = (seq: number) => ({ seq, postId: `synthetic-post-${seq}` });
const intent = (seq: number): NoticeDelta => ({ kind: 'intent', attemptId: `attempt-${seq}`, posts: [post(seq)], startedAt: 1 });
async function acknowledge(journal: SequencedNoticeJournal, attemptId: string) {
  const handle = journal.captureLiveHandoff(attemptId);
  journal.markHandoffEntered(handle);
  return journal.acknowledgeLiveHandoff(handle);
}
afterEach(async () => { await Promise.all(homes.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });

describe('sequenced notice journal persistence', () => {
  it('retains uncertain A and accepted B across disk reopen, then admits C', async () => {
    const directory = await home();
    let journal = await initialized(directory);
    for (const seq of [1, 2]) {
      await journal.append({ kind: 'scan', through: seq, eligible: [post(seq)] });
      await journal.append(intent(seq));
      if (seq === 1) await journal.append({ kind: 'settle', attemptId: 'attempt-1', outcome: 'uncertain' });
      else await acknowledge(journal, `attempt-${seq}`);
    }
    const revision = journal.committedRevision;
    journal = await open(directory);
    expect(journal.committedRevision).toBe(revision);
    expect(journal.snapshot()?.attempts).toMatchObject([{ attemptId: 'attempt-1', status: 'uncertain' }]);
    expect(journal.snapshot()?.terminal).toEqual([[2, 2]]);
    expect(noticeLegacyFloor(journal.snapshot()!)).toBe(0);
    await journal.append({ kind: 'scan', through: 3, eligible: [post(3)] });
    await journal.append(intent(3));
    expect(journal.snapshot()?.attempts.map((a) => a.attemptId)).toEqual(['attempt-1', 'attempt-3']);
  });

  it('publishes no cache success after an ambiguously committed intent and recovers it uncertain', async () => {
    const directory = await home();
    let enabled = false;
    const journal = await SequencedNoticeJournal.open({ directory, recipient, testFailure: (point) => { if (enabled && point === 'afterSync') throw new Error('synthetic-after-sync'); } });
    await journal.append({ kind: 'initialize', recipient, baseline: 0 });
    await journal.append({ kind: 'scan', through: 1, eligible: [post(1)] });
    enabled = true;
    await expect(journal.append(intent(1))).rejects.toThrow('synthetic-after-sync');
    expect(journal.healthy).toBe(false);
    expect(journal.snapshot()?.attempts).toEqual([]);
    await expect(journal.append(intent(1))).rejects.toThrow('reconciliation');
    const restored = await open(directory);
    expect(restored.snapshot()?.attempts[0]).toMatchObject({ status: 'uncertain', reason: 'recovered' });
  });

  it('checkpoints terminal coverage above holes and verifies immutable page references', async () => {
    const directory = await home();
    let journal = await initialized(directory);
    await journal.append({ kind: 'scan', through: 1, eligible: [post(1)] });
    await journal.append(intent(1));
    await journal.append({ kind: 'settle', attemptId: 'attempt-1', outcome: 'uncertain' });
    await journal.append({ kind: 'scan', through: 1_000_001, eligible: [] });
    const expected = journal.snapshot();
    await journal.checkpoint();
    for (const name of await fs.readdir(directory)) if (name.startsWith('page-') && name.endsWith('.json')) expect((await fs.stat(path.join(directory, name))).size).toBeLessThanOrEqual(NOTICE_PAGE_BYTES);
    journal = await open(directory);
    expect(journal.snapshot()).toEqual(expected);
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
    const reference = path.join(directory, `page-${manifest.checkpointRoot}.json`);
    await fs.writeFile(reference, 'corrupted-page');
    await expect(open(directory)).rejects.toThrow('checksum');
    expect(await fs.readFile(reference, 'utf8')).toBe('corrupted-page');
  });

  it('refuses changed external storage and unknown writer versions without rewriting them', async () => {
    const directory = await home();
    const journal = await initialized(directory);
    const manifestPath = path.join(directory, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    const raw = JSON.stringify({ ...manifest, minWriterVersion: 2, futureField: true });
    await fs.writeFile(manifestPath, raw);
    await expect(journal.append({ kind: 'scan', through: 1, eligible: [] })).rejects.toThrow('outside its owner');
    await expect(open(directory)).rejects.toThrow('writer version');
    expect(await fs.readFile(manifestPath, 'utf8')).toBe(raw);
    await expect(SequencedNoticeJournal.open({ directory, recipient: { ...recipient, generation: 'other-generation' } })).rejects.toThrow();
  });

  it('preserves supported unknown optional manifest and checkpoint fields', async () => {
    const directory = await home();
    await initialized(directory);
    const manifestPath = path.join(directory, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, futureOptional: { retain: true } }));
    const journal = await open(directory);
    await journal.checkpoint();
    expect(JSON.parse(await fs.readFile(manifestPath, 'utf8')).futureOptional).toEqual({ retain: true });
    expect((await open(directory)).snapshot()?.baselineThrough).toBe(0);
  });

  it('does not mistake complete checksum damage for a recoverable partial tail', async () => {
    const directory = await home();
    await initialized(directory);
    const location = path.join(directory, 'journal-0000000000.log');
    const bytes = await fs.readFile(location); bytes[bytes.length - 1] ^= 1;
    await fs.writeFile(location, bytes);
    await expect(open(directory)).rejects.toThrow('checksum');
    expect(await fs.readFile(location)).toEqual(bytes);
    expect((await fs.readdir(directory)).filter((n) => n.startsWith('incomplete-tail'))).toEqual([]);
  });

  it('serializes callers and rejects conflicting sequence IDs before adding a record', async () => {
    const directory = await home();
    const journal = await initialized(directory);
    await Promise.all([journal.append({ kind: 'scan', through: 1, eligible: [post(1)] }), journal.append(intent(1))]);
    const revision = journal.committedRevision;
    await expect(journal.append({ kind: 'scan', through: 2, eligible: [{ seq: 1, postId: 'conflict' }] })).rejects.toThrow('identity');
    expect(journal.committedRevision).toBe(revision);
    expect(journal.healthy).toBe(true);
  });

  it('retains more than256 uncertain attempts in bounded pages while later work continues', async () => {
    const directory = await home();
    let journal = await initialized(directory);
    for (let seq = 1; seq <= 257; seq++) {
      await journal.append({ kind: 'scan', through: seq, eligible: [post(seq)] });
      await journal.append(intent(seq));
      await journal.append({ kind: 'settle', attemptId: `attempt-${seq}`, outcome: 'uncertain' });
    }
    await journal.checkpoint();
    let attemptPages = 0;
    for (const name of await fs.readdir(directory)) if (/^page-[a-f0-9]{64}\.json$/.test(name)) {
      const page = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'));
      if (page.kind === 'attempts') { attemptPages++; expect(page.items.length).toBeLessThanOrEqual(256); }
      expect((await fs.stat(path.join(directory, name))).size).toBeLessThanOrEqual(NOTICE_PAGE_BYTES);
    }
    expect(attemptPages).toBeGreaterThanOrEqual(2);
    journal = await open(directory);
    expect(journal.snapshot()?.attempts[0]).toMatchObject({ attemptId: 'attempt-1', status: 'uncertain' });
    await journal.append({ kind: 'scan', through: 258, eligible: [post(258)] });
    await journal.append(intent(258));
    await acknowledge(journal, 'attempt-258');
    journal = await open(directory);
    expect(journal.snapshot()?.attempts).toHaveLength(257);
    expect(journal.snapshot()?.terminal).toEqual([[258, 258]]);
  }, 30000);

  it('rolls bounded segments through atomic compact checkpoints instead of stopping on later traffic', async () => {
    const directory = await home();
    let journal = await initialized(directory);
    for (let burst = 0; burst < 40; burst++) {
      const posts = Array.from({ length: 50 }, (_, index) => ({ seq: burst * 50 + index + 1, postId: `${String(burst * 50 + index + 1).padStart(10, '0')}-${'x'.repeat(230)}` }));
      await journal.append({ kind: 'scan', through: posts[49].seq, eligible: posts });
      await journal.append({ kind: 'intent', attemptId: `burst-${burst}`, posts, startedAt: 1 });
      await acknowledge(journal, `burst-${burst}`);
    }
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
    expect(manifest.checkpointRevision).toBeGreaterThan(0);
    const segments = (await fs.readdir(directory)).filter((n) => /^journal-\d+\.log$/.test(n));
    expect(segments.length).toBeLessThanOrEqual(4);
    for (const name of segments) expect((await fs.stat(path.join(directory, name))).size).toBeLessThanOrEqual(NOTICE_PAGE_BYTES);
    expect(journal.retainedEntryCount).toBe(0);
    journal = await open(directory);
    expect(journal.snapshot()?.terminal).toEqual([[1, 2000]]);
    expect(journal.snapshot()?.acceptedCount).toBe(2000);
    expect(journal.snapshot()?.attempts).toEqual([]);
    expect(journal.retainedEntryCount).toBe(0);
  }, 30000);

  it('requires entered same-process capability for a late ACK; reopen cannot mint one for recovered uncertainty', async () => {
    const directory = await home();
    const journal = await initialized(directory);
    await journal.append({ kind: 'scan', through: 1, eligible: [post(1)] });
    await journal.append(intent(1));
    const handle = journal.captureLiveHandoff('attempt-1');
    await expect(journal.acknowledgeLiveHandoff(handle)).rejects.toThrow('entered');
    journal.markHandoffEntered(handle);
    expect(() => journal.markHandoffEntered(handle)).toThrow('no longer current');
    await journal.append({ kind: 'settle', attemptId: 'attempt-1', outcome: 'uncertain' });
    await expect(journal.append({ kind: 'settle', attemptId: 'attempt-1', outcome: 'accepted' })).rejects.toThrow('capability');
    await journal.acknowledgeLiveHandoff(handle);
    await journal.acknowledgeLiveHandoff(handle);
    expect(journal.snapshot()?.lateAcknowledgementCount).toBe(1);
    expect(journal.snapshot()?.acceptedCount).toBe(1);
    expect(journal.retainedEntryCount).toBe(0);

    await journal.append({ kind: 'scan', through: 2, eligible: [post(2)] });
    await journal.append(intent(2));
    const oldHandle = journal.captureLiveHandoff('attempt-2');
    journal.markHandoffEntered(oldHandle);
    const recovered = await open(directory);
    expect(recovered.snapshot()?.attempts[0]).toMatchObject({ attemptId: 'attempt-2', reason: 'recovered' });
    expect(() => recovered.captureLiveHandoff('attempt-2')).toThrow('No exact');
    await expect(recovered.acknowledgeLiveHandoff(oldHandle)).rejects.toThrow('live entered');
    await expect(recovered.append({ kind: 'settle', attemptId: 'attempt-2', outcome: 'accepted' })).rejects.toThrow('capability');
    expect(recovered.snapshot()?.attempts[0].status).toBe('uncertain');
  });

  it('refuses zero-filled final extension without trimming a possibly committed frame', async () => {
    const directory = await home();
    const journal = await initialized(directory);
    await journal.append({ kind: 'scan', through: 1, eligible: [post(1)] });
    await journal.append(intent(1));
    const location = path.join(directory, 'journal-0000000000.log');
    await fs.appendFile(location, Buffer.alloc(64));
    const bytes = await fs.readFile(location);
    await expect(open(directory)).rejects.toThrow('frame length');
    expect(await fs.readFile(location)).toEqual(bytes);
    expect((await fs.readdir(directory)).some((n) => n.startsWith('incomplete-tail'))).toBe(false);
  });

  it('never releases entered coverage through unsubmitted, even after its handle is released', async () => {
    const directory = await home();
    const journal = await initialized(directory);
    await journal.append({ kind: 'scan', through: 1, eligible: [post(1)] });
    await journal.append(intent(1));
    const handle = journal.captureLiveHandoff('attempt-1');
    journal.markHandoffEntered(handle);
    journal.releaseLiveHandoff(handle);
    expect(journal.retainedEntryCount).toBe(1);
    await journal.append({ kind: 'settle', attemptId: 'attempt-1', outcome: 'unsubmitted' });
    expect(journal.snapshot()?.pending[0].attemptId).toBe('attempt-1');
    expect(journal.snapshot()?.attempts[0]).toMatchObject({ status: 'uncertain', reason: 'handoff_unknown' });
    await expect(journal.append({ ...intent(1), attemptId: 'duplicate-risk' })).rejects.toThrow('not ready');
    const restored = await open(directory);
    expect(restored.snapshot()?.pending[0].attemptId).toBe('attempt-1');
    await restored.append({ kind: 'scan', through: 2, eligible: [post(2)] });
    await restored.append(intent(2));
    expect(restored.snapshot()?.attempts.map((a) => a.attemptId)).toEqual(['attempt-1', 'attempt-2']);
  });

  it('entry arbitration: two handles cannot enter the same attempt twice', async () => {
    const journal = await initialized(await home());
    await journal.append({ kind: 'scan', through: 1, eligible: [post(1)] });
    await journal.append(intent(1));
    const first = journal.captureLiveHandoff('attempt-1');
    const second = journal.captureLiveHandoff('attempt-1');
    journal.markHandoffEntered(first);
    expect(() => journal.markHandoffEntered(second)).toThrow();
  });

  it('entry arbitration: a pending unsubmitted commit cannot both admit entry and release coverage', async () => {
    const directory = await home();
    let blocking = false;
    let arrived!: () => void; let release!: () => void;
    const waiting = new Promise<void>((resolve) => { arrived = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const journal = await SequencedNoticeJournal.open({ directory, recipient, testFailure: async (point) => {
      if (blocking && point === 'beforeAppend') { arrived(); await blocked; }
    } });
    await journal.append({ kind: 'initialize', recipient, baseline: 0 });
    await journal.append({ kind: 'scan', through: 1, eligible: [post(1)] });
    await journal.append(intent(1));
    const handle = journal.captureLiveHandoff('attempt-1');
    blocking = true;
    const transition = journal.append({ kind: 'settle', attemptId: 'attempt-1', outcome: 'unsubmitted' });
    await waiting;
    let enteredDuringTransition = false;
    try { journal.markHandoffEntered(handle); enteredDuringTransition = true; }
    catch { /* telemetry-exempt: this modeled entry refusal is the control being measured */ }
    finally { release(); await transition; }
    const readyAfterTransition = journal.snapshot()?.pending[0].attemptId === undefined;
    expect({ enteredDuringTransition, readyAfterTransition }).not.toEqual({ enteredDuringTransition: true, readyAfterTransition: true });
  });

  it.each(['uncertain', 'recover'] as const)('entry arbitration: %s holds entry synchronously before queued IO', async (kind) => {
    const journal = await initialized(await home());
    await journal.append({ kind: 'scan', through: 2, eligible: [post(1), post(2)] });
    await journal.append(intent(1));
    await journal.append(intent(2));
    const first = journal.captureLiveHandoff('attempt-1');
    const other = journal.captureLiveHandoff('attempt-2');
    const transition = journal.append(kind === 'recover' ? { kind: 'recover' }
      : { kind: 'settle', attemptId: 'attempt-1', outcome: 'uncertain' });
    expect(() => journal.captureLiveHandoff('attempt-1')).toThrow('No exact');
    expect(() => journal.markHandoffEntered(first)).toThrow('no longer current');
    if (kind === 'recover') expect(() => journal.markHandoffEntered(other)).toThrow('no longer current');
    else journal.markHandoffEntered(other);
    await transition;
    expect(() => journal.markHandoffEntered(first)).toThrow('no longer current');
    if (kind === 'uncertain') {
      await journal.acknowledgeLiveHandoff(other);
      expect(journal.snapshot()?.terminal).toEqual([[2, 2]]);
    }
  });

  it('entry arbitration: pending uncertainty preserves a genuine already-entered ACK', async () => {
    const directory = await home();
    const journal = await initialized(directory);
    await journal.append({ kind: 'scan', through: 1, eligible: [post(1)] });
    await journal.append(intent(1));
    const handle = journal.captureLiveHandoff('attempt-1');
    journal.markHandoffEntered(handle);
    expect(() => journal.captureLiveHandoff('attempt-1')).toThrow('No exact');
    const unknown = journal.append({ kind: 'settle', attemptId: 'attempt-1', outcome: 'uncertain' });
    const acknowledgement = journal.acknowledgeLiveHandoff(handle);
    await Promise.all([unknown, acknowledgement]);
    expect(journal.snapshot()).toMatchObject({ acceptedCount: 1, lateAcknowledgementCount: 1, attempts: [] });
    expect((await open(directory)).snapshot()?.terminal).toEqual([[1, 1]]);
  });

  it('kills the in-memory mutant that removes the journal entered-attempt guard', async () => {
    const baseline = await home();
    const control = await promisify(execFile)(process.execPath, ['test/research/q5-entered-mutation.cjs', baseline, 'guarded'], { cwd: process.cwd() });
    console.info('Q5 guarded mutation control', JSON.stringify({ code: 0, stdout: control.stdout, stderr: control.stderr }));
    const mutant = await home();
    const result = await promisify(execFile)(process.execPath, ['test/research/q5-entered-mutation.cjs', mutant, 'remove-entered-guard'], { cwd: process.cwd() }).then(
      (value) => ({ code: 0, stdout: value.stdout, stderr: value.stderr }),
      (error: Error & { code: number; stdout: string; stderr: string }) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
    );
    console.info('Q5 removed-guard mutation result', JSON.stringify(result));
    expect(result).toMatchObject({ code: 2, stdout: expect.stringContaining('SAFETY ASSERTION FAILED: entered coverage became ready') });
  }, 15000);

  it.each(['beforeAppend', 'afterAppendBeforeSync', 'afterSync', 'partial-tail', 'afterPages', 'afterManifest'] as Array<NoticeJournalFailurePoint | 'partial-tail'>)('recovers an actual synthetic child-process exit at %s', async (point) => {
    const directory = await home();
    await expect(promisify(execFile)(process.execPath, ['test/research/q5-journal-process.cjs', directory, point], { cwd: process.cwd() })).rejects.toMatchObject({ code: 77 });
    const restored = await open(directory);
    const expectedAttempt = !['beforeAppend', 'partial-tail'].includes(point);
    expect(restored.snapshot()?.attempts).toHaveLength(expectedAttempt ? 1 : 0);
    expect(restored.snapshot()?.pending[0]).toMatchObject({ seq: 1, postId: 'synthetic-post-1' });
    if (expectedAttempt) expect(restored.snapshot()?.attempts[0].status).toBe('uncertain');
    if (point === 'partial-tail') expect((await fs.readdir(directory)).some((n) => n.startsWith('incomplete-tail'))).toBe(true);
  }, 15000);
});
