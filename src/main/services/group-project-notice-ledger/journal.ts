/** Main-only sequenced ledger storage. Not yet connected to notification dispatch. */
import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { applyNoticeDelta, noticeRecipientKey, validateNoticeState, type NoticeDelta, type NoticeRecipient, type SequencedNoticeState } from './state';

export const NOTICE_DELTA_BYTES = 64 * 1024;
export const NOTICE_SEGMENT_TARGET = 256 * 1024;
export const NOTICE_PAGE_BYTES = 512 * 1024;
const ZERO_HASH = '0'.repeat(64);
const hash = (body: Buffer | string) => createHash('sha256').update(body).digest('hex');
const isHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

export class NoticeLedgerStorageError extends Error {
  constructor(public readonly code: 'notice_ledger_corrupt' | 'notice_ledger_version' | 'notice_ledger_changed' | 'notice_ledger_unavailable', message: string) { super(message); }
}
interface Manifest {
  schemaVersion: 1;
  minWriterVersion: 1;
  recipientKey: string;
  checkpointRevision: number;
  checkpointDigest: string;
  checkpointRoot?: string;
  firstSegment: number;
  [extra: string]: unknown;
}
interface RecordEnvelope { schemaVersion: 1; minWriterVersion: 1; revision: number; previousDigest: string; delta: NoticeDelta }
type CheckpointPage = { kind: 'index'; children: string[] }
  | { kind: 'metadata'; value: Omit<SequencedNoticeState, 'terminal' | 'pending' | 'attempts'> }
  | { kind: 'terminal'; items: SequencedNoticeState['terminal'] }
  | { kind: 'pending'; items: SequencedNoticeState['pending'] }
  | { kind: 'attempts'; items: SequencedNoticeState['attempts'] };
export type NoticeJournalFailurePoint = 'beforeAppend' | 'afterAppendBeforeSync' | 'afterSync' | 'afterPages' | 'beforeManifest' | 'afterManifest';
export interface NoticeJournalOptions {
  /** Fixed main-owned location, never an IPC-supplied path. */
  directory: string;
  recipient: NoticeRecipient;
  /** Deterministic fault seam only; production callers omit this. */
  testFailure?: (point: NoticeJournalFailurePoint) => void | Promise<void>;
}

function decodeManifest(body: Buffer, recipientKey: string): Manifest {
  if (body.length > NOTICE_DELTA_BYTES) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Oversized notice manifest');
  const value: unknown = JSON.parse(body.toString('utf8'));
  if (!object(value)) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Invalid notice manifest');
  if (value.schemaVersion !== 1 || value.minWriterVersion !== 1) throw new NoticeLedgerStorageError('notice_ledger_version', 'Unsupported notice ledger writer version');
  if (value.recipientKey !== recipientKey || !integer(value.checkpointRevision) || !integer(value.firstSegment)
    || !isHash(value.checkpointDigest) || (value.checkpointRoot !== undefined && !isHash(value.checkpointRoot))) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Invalid notice manifest identity');
  if ((value.checkpointRevision === 0) !== (value.checkpointRoot === undefined) || value.checkpointRevision === 0 && value.checkpointDigest !== ZERO_HASH) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Invalid notice checkpoint anchor');
  return value as unknown as Manifest;
}
function decodeRecord(body: Buffer, revision: number, previousDigest: string): RecordEnvelope {
  const value: unknown = JSON.parse(body.toString('utf8'));
  if (!object(value)) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Invalid notice journal record');
  if (value.schemaVersion !== 1 || value.minWriterVersion !== 1) throw new NoticeLedgerStorageError('notice_ledger_version', 'Unsupported notice record writer version');
  if (value.revision !== revision || value.previousDigest !== previousDigest || !object(value.delta)) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Notice journal chain mismatch');
  return value as unknown as RecordEnvelope;
}
async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function missing(error: unknown): Promise<boolean> { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }

/**
 * Persistence foundation only: callers must still enforce main ownership, grants,
 * installation marker, generation adoption and runtime admission. No sends here.
 */
export class SequencedNoticeJournal {
  private manifest!: Manifest;
  private manifestHash = '';
  private state: SequencedNoticeState | undefined;
  private revision = 0;
  private digest = ZERO_HASH;
  private segment = 0;
  private segmentBytes = 0;
  private currentFileHash = hash(Buffer.alloc(0));
  private work: Promise<unknown> = Promise.resolve();
  private poisoned = false;
  private readonly directory: string;
  private readonly recipientKey: string;
  private readonly failure?: NoticeJournalOptions['testFailure'];

  private constructor(options: NoticeJournalOptions) {
    this.directory = options.directory;
    this.recipientKey = noticeRecipientKey(options.recipient);
    this.failure = options.testFailure;
  }
  static async open(options: NoticeJournalOptions): Promise<SequencedNoticeJournal> {
    const journal = new SequencedNoticeJournal(options);
    await journal.load();
    if (journal.state?.attempts.some((a) => a.status !== 'uncertain')) await journal.append({ kind: 'recover' });
    return journal;
  }
  snapshot(): SequencedNoticeState | undefined {
    return this.state ? JSON.parse(JSON.stringify(this.state)) as SequencedNoticeState : undefined;
  }
  get committedRevision(): number { return this.revision; }
  get healthy(): boolean { return !this.poisoned; }
  private location(segment: number): string { return path.join(this.directory, `journal-${String(segment).padStart(10, '0')}.log`); }

  private async atomicManifest(manifest: Manifest): Promise<void> {
    const body = Buffer.from(JSON.stringify(manifest));
    if (body.length > NOTICE_DELTA_BYTES) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Oversized notice manifest');
    const temporary = path.join(this.directory, `manifest-${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
    await this.failure?.('beforeManifest');
    await fs.rename(temporary, path.join(this.directory, 'manifest.json'));
    await syncDirectory(this.directory);
    await this.failure?.('afterManifest');
    this.manifest = manifest; this.manifestHash = hash(body);
  }

  private async load(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    let manifestBody: Buffer;
    try { manifestBody = await fs.readFile(path.join(this.directory, 'manifest.json')); }
    catch (error) {
      if (!(await missing(error))) throw error; // telemetry-exempt: propagated to the owning delivery service
      const names = await fs.readdir(this.directory);
      if (names.length) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Notice manifest missing beside retained data');
      await this.atomicManifest({ schemaVersion: 1, minWriterVersion: 1, recipientKey: this.recipientKey,
        checkpointRevision: 0, checkpointDigest: ZERO_HASH, firstSegment: 0 });
      manifestBody = await fs.readFile(path.join(this.directory, 'manifest.json'));
    }
    this.manifest = decodeManifest(manifestBody, this.recipientKey);
    this.manifestHash = hash(manifestBody);
    this.revision = this.manifest.checkpointRevision; this.digest = this.manifest.checkpointDigest;
    if (this.manifest.checkpointRoot) {
      const pages = await this.readPages(this.manifest.checkpointRoot);
      const metadata = pages.filter((p) => p.kind === 'metadata');
      if (metadata.length !== 1 || metadata[0].kind !== 'metadata') throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Notice checkpoint metadata missing or repeated');
      const state = { ...metadata[0].value, terminal: [] as SequencedNoticeState['terminal'], pending: [] as SequencedNoticeState['pending'], attempts: [] as SequencedNoticeState['attempts'] };
      for (const page of pages) {
        if (page.kind === 'terminal') state.terminal.push(...page.items);
        else if (page.kind === 'pending') state.pending.push(...page.items);
        else if (page.kind === 'attempts') state.attempts.push(...page.items);
      }
      this.state = validateNoticeState(state);
      if (noticeRecipientKey(this.state.recipient) !== this.recipientKey) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Notice checkpoint recipient mismatch');
    }
    const segments = (await fs.readdir(this.directory)).filter((n) => /^journal-\d{10,}\.log$/.test(n))
      .map((name) => Number(name.slice(8, -4))).filter((n) => n >= this.manifest.firstSegment).sort((a, b) => a - b);
    let expected = this.manifest.firstSegment;
    for (let index = 0; index < segments.length; index++) {
      if (segments[index] !== expected++) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Notice journal segment missing');
      this.segment = segments[index];
      const body = await fs.readFile(this.location(this.segment));
      if (body.length > NOTICE_PAGE_BYTES) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Oversized notice segment');
      let offset = 0;
      while (offset < body.length) {
        const length = body.length - offset >= 4 ? body.readUInt32BE(offset) : undefined;
        if (length !== undefined && (length < 2 || length + 36 > NOTICE_DELTA_BYTES)) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Invalid notice frame length');
        if (length === undefined || body.length - offset < length + 36) {
          if (index !== segments.length - 1) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Non-tail notice record damage');
          await this.preserveAndTrimTail(body, offset);
          break;
        }
        const payload = body.subarray(offset + 4, offset + 4 + length);
        const checksum = body.subarray(offset + 4 + length, offset + 36 + length).toString('hex');
        if (checksum !== hash(payload)) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Notice record checksum mismatch');
        const record = decodeRecord(payload, this.revision + 1, this.digest);
        this.state = applyNoticeDelta(this.state, record.delta);
        if (noticeRecipientKey(this.state.recipient) !== this.recipientKey) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Notice record recipient mismatch');
        this.revision = record.revision; this.digest = checksum;
        offset += length + 36;
      }
      this.segmentBytes = offset;
    }
    if (!segments.length) this.segment = this.manifest.firstSegment;
    const current = await this.readCurrent();
    this.currentFileHash = hash(current);
  }
  private async preserveAndTrimTail(body: Buffer, offset: number): Promise<void> {
    const preserved = path.join(this.directory, `incomplete-tail-${randomUUID()}.bin`);
    const handle = await fs.open(preserved, 'wx', 0o600);
    try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
    await syncDirectory(this.directory);
    const journal = await fs.open(this.location(this.segment), 'r+');
    try { await journal.truncate(offset); await journal.sync(); } finally { await journal.close(); }
  }
  private async readCurrent(): Promise<Buffer> {
    try { return await fs.readFile(this.location(this.segment)); }
    catch (error) {
      if (await missing(error)) return Buffer.alloc(0); // telemetry-exempt: a new empty segment has no bytes yet
      throw error;
    }
  }
  private async unchanged(): Promise<void> {
    const manifest = await fs.readFile(path.join(this.directory, 'manifest.json'));
    const current = await this.readCurrent();
    if (hash(manifest) !== this.manifestHash || current.length !== this.segmentBytes || hash(current) !== this.currentFileHash) throw new NoticeLedgerStorageError('notice_ledger_changed', 'Notice storage changed outside its owner');
  }

  append(delta: NoticeDelta): Promise<SequencedNoticeState> {
    const next = this.work.catch(() => {}).then(async () => {
      if (this.poisoned) throw new NoticeLedgerStorageError('notice_ledger_unavailable', 'Notice storage needs reconciliation');
      const candidate = applyNoticeDelta(this.state, delta);
      if (candidate === this.state) return this.snapshot()!;
      if (noticeRecipientKey(candidate.recipient) !== this.recipientKey) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Notice recipient does not match storage');
      const envelope: RecordEnvelope = { schemaVersion: 1, minWriterVersion: 1, revision: this.revision + 1, previousDigest: this.digest, delta };
      const payload = Buffer.from(JSON.stringify(envelope));
      if (payload.length + 36 > NOTICE_DELTA_BYTES) throw new Error('Notice delta exceeds its byte bound');
      const frame = Buffer.alloc(payload.length + 36);
      frame.writeUInt32BE(payload.length, 0); payload.copy(frame, 4);
      const digest = hash(payload); Buffer.from(digest, 'hex').copy(frame, 4 + payload.length);
      try {
        await this.unchanged();
        if (this.segmentBytes >= NOTICE_SEGMENT_TARGET) {
          if (this.segment - this.manifest.firstSegment >= 3) await this.checkpointNow();
          else { this.segment++; this.segmentBytes = 0; this.currentFileHash = hash(Buffer.alloc(0)); }
        }
        await this.failure?.('beforeAppend');
        const handle = await fs.open(this.location(this.segment), 'a', 0o600);
        try {
          await handle.writeFile(frame);
          await this.failure?.('afterAppendBeforeSync');
          await handle.sync();
        } finally { await handle.close(); }
        await syncDirectory(this.directory);
        await this.failure?.('afterSync');
        this.revision = envelope.revision; this.digest = digest; this.state = candidate;
        this.segmentBytes += frame.length;
        this.currentFileHash = hash(await this.readCurrent());
      } catch (error) {
        this.poisoned = true;
        throw error; // telemetry-exempt: no cache publication after an ambiguous commit; owner reports storage failure
      }
      return this.snapshot()!;
    });
    this.work = next;
    return next;
  }

  private async putPage(page: CheckpointPage): Promise<string> {
    const body = Buffer.from(JSON.stringify(page));
    if (body.length > NOTICE_PAGE_BYTES) throw new Error('Notice checkpoint page exceeds its byte bound');
    const digest = hash(body);
    const destination = path.join(this.directory, `page-${digest}.json`);
    let prior: Buffer | undefined;
    try { prior = await fs.readFile(destination); }
    catch (error) { if (!(await missing(error))) throw error; } // telemetry-exempt: propagated, never silently repaired
    if (prior) {
      if (hash(prior) !== digest) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Existing notice page digest mismatch');
      return digest;
    }
    const temporary = path.join(this.directory, `page-${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, destination);
    return digest;
  }
  private async readPages(root: string, visiting = new Set<string>(), referenced?: Set<string>): Promise<CheckpointPage[]> {
    if (!isHash(root) || visiting.has(root)) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Invalid notice page reference');
    if (visiting.size > 32) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Notice page index is too deep');
    visiting.add(root);
    referenced?.add(root);
    const body = await fs.readFile(path.join(this.directory, `page-${root}.json`));
    if (body.length > NOTICE_PAGE_BYTES || hash(body) !== root) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Notice page checksum mismatch');
    const page: unknown = JSON.parse(body.toString('utf8'));
    if (!object(page)) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Invalid notice page');
    let records: CheckpointPage[];
    if (page.kind === 'metadata' && object(page.value)) records = [page as unknown as CheckpointPage];
    else if (['terminal', 'pending', 'attempts'].includes(page.kind as string) && Array.isArray(page.items)) records = [page as unknown as CheckpointPage];
    else if (page.kind === 'index' && Array.isArray(page.children) && page.children.length > 0 && page.children.every(isHash)) {
      records = [];
      for (const child of page.children) records.push(...await this.readPages(child, visiting, referenced));
    } else throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Unsupported notice checkpoint page');
    visiting.delete(root);
    return records;
  }

  /** Atomic checkpoint; old pages and logs are retired only after the new manifest commits. */
  checkpoint(): Promise<void> {
    const next = this.work.catch(() => {}).then(async () => {
      if (this.poisoned) throw new NoticeLedgerStorageError('notice_ledger_unavailable', 'Notice storage needs reconciliation');
      try { await this.unchanged(); await this.checkpointNow(); }
      catch (error) { this.poisoned = true; throw error; } // telemetry-exempt: owner must reconcile an ambiguous checkpoint
    });
    this.work = next; return next;
  }
  private async checkpointNow(): Promise<void> {
    if (!this.state) return;
    const { terminal, pending, attempts, ...metadata } = this.state;
    const children = [await this.putPage({ kind: 'metadata', value: metadata })];
    const appendPages = async (kind: 'terminal' | 'pending' | 'attempts', items: unknown[]) => {
      let batch: unknown[] = [];
      for (const item of items) {
        const candidate = [...batch, item];
        if (Buffer.byteLength(JSON.stringify({ kind, items: candidate })) > NOTICE_PAGE_BYTES || (kind === 'attempts' && candidate.length > 256)) {
          if (!batch.length) throw new Error('Notice checkpoint item exceeds its page bound');
          children.push(await this.putPage({ kind, items: batch } as CheckpointPage));
          batch = [item];
        } else batch = candidate;
      }
      if (batch.length) children.push(await this.putPage({ kind, items: batch } as CheckpointPage));
    };
    await appendPages('terminal', terminal); await appendPages('pending', pending); await appendPages('attempts', attempts);
    let level = children;
    while (level.length > 1000) {
      const parents: string[] = [];
      for (let offset = 0; offset < level.length; offset += 1000) parents.push(await this.putPage({ kind: 'index', children: level.slice(offset, offset + 1000) }));
      level = parents;
    }
    const root = await this.putPage({ kind: 'index', children: level });
    await syncDirectory(this.directory);
    await this.failure?.('afterPages');
    const firstSegment = this.segment + 1;
    await this.atomicManifest({ ...this.manifest, checkpointRevision: this.revision, checkpointDigest: this.digest, checkpointRoot: root, firstSegment });
    this.segment = firstSegment; this.segmentBytes = 0; this.currentFileHash = hash(Buffer.alloc(0));
    // Complete validated replacement is authoritative. GC failure does not undo its commit.
    const retained = new Set<string>();
    await this.readPages(root, new Set(), retained);
    for (const name of await fs.readdir(this.directory)) {
      if (/^journal-\d{10,}\.log$/.test(name) && Number(name.slice(8, -4)) < firstSegment
        || /^page-[a-f0-9]{64}\.json$/.test(name) && !retained.has(name.slice(5, -5))) {
        await fs.unlink(path.join(this.directory, name));
      }
    }
    await syncDirectory(this.directory);
  }
}
