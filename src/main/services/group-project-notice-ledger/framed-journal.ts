/** Private file-set owner. No app caller, receipt, runtime, catalog or send API. */
import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { constants } from 'fs';
import { NoticeDirectoryFlusher } from './durability';
import { NoticeLedgerValidationError } from './validation';
export { NoticeLedgerValidationError } from './validation';

export const NOTICE_DELTA_BYTES = 64 * 1024;
export const NOTICE_SEGMENT_TARGET = 256 * 1024;
export const NOTICE_PAGE_BYTES = 512 * 1024;
const ZERO_HASH = '0'.repeat(64);
const hash = (body: Buffer | string) => createHash('sha256').update(body).digest('hex');
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const isHash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
class NoticePhysicalFileAbsent extends Error { readonly code = 'ENOENT'; }

export type NoticeStorageCode = 'notice_ledger_corrupt' | 'notice_ledger_version' | 'notice_ledger_changed'
  | 'notice_ledger_unavailable' | 'notice_ledger_open' | 'notice_ledger_conflict' | 'notice_ledger_reconciliation';
export class NoticeLedgerStorageError extends Error {
  constructor(public readonly code: NoticeStorageCode, message: string) { super(message); }
}
interface Manifest {
  schemaVersion: 1;
  minWriterVersion: number;
  recipientKey: string;
  checkpointRevision: number;
  checkpointDigest: string;
  checkpointRoot?: string;
  firstSegment: number;
  profile?: string;
  installationId?: string;
  [extra: string]: unknown;
}
interface RecordEnvelope<R> { schemaVersion: 1; minWriterVersion: number; revision: number; previousDigest: string; delta: R }
export type NoticePhysicalFailurePoint = 'beforeAppend' | 'afterAppendBeforeSync' | 'afterSync'
  | 'beforeFinalBookkeeping' | 'afterFinalBookkeeping' | 'afterPages' | 'beforeManifest' | 'afterManifest';
export interface NoticePhysicalPages {
  put(value: unknown): Promise<string>;
  read(root: string): Promise<unknown>;
  /** Flat legacy checkpoint namespace only, after a committed manifest switch. */
  retireLegacyPages(retained: ReadonlySet<string>): Promise<void>;
}
/** Closed main-owned implementations only; never caller/IPC/user configuration. */
export interface NoticePhysicalCodec<S, D, R> {
  readonly minWriterVersion: 1 | 2;
  /** Undefined preserves the exact legacy envelope and manifest field set. */
  readonly profile?: 'sequenced-sparse-v1';
  prepare(current: S | undefined, input: D): Promise<{ state: S; record: R } | undefined>;
  replay(current: S | undefined, record: unknown): Promise<S>;
  validate(state: S): void;
  checkpoint(state: S, pages: NoticePhysicalPages): Promise<string>;
  restore(root: string, pages: NoticePhysicalPages): Promise<S>;
  /** New root profile verifies the final committed tree once before open returns. */
  finalizeOpen?(state: S): Promise<S>;
  /** Synchronous root/epoch capability recheck immediately before physical append. */
  assertPrepared?(state: S, record: R): void;
  /** Legacy codec may collect only its own page namespace, after manifest commit. */
  collect?(root: string, pages: NoticePhysicalPages): Promise<void>;
}
export interface NoticePhysicalExpectation {
  revision: number;
  digest: string;
}
export interface NoticePhysicalOptions<S, D, R> {
  directory: string;
  recipientKey: string;
  /** Required for the explicit root profile; legacy fields remain untouched. */
  installationId?: string;
  codec: NoticePhysicalCodec<S, D, R>;
  testFailure?: (point: NoticePhysicalFailurePoint) => void | Promise<void>;
  /** Internal synchronous anchor update only; no UI/driver callback or await. */
  published?: (state: S, record: R) => void;
}

// Keyed by real directory after mkdir: aliases cannot open a second owner here.
// This is a process-local guard, not a multiprocess lock or filesystem CAS.
const opening = new Set<string>();

export class NoticeFramedJournal<S, D, R> {
  private manifest!: Manifest;
  private manifestHash = '';
  private state: S | undefined;
  private revision = 0;
  private digest = ZERO_HASH;
  private segment = 0;
  private segmentBytes = 0;
  private currentFileHash = hash(Buffer.alloc(0));
  /** The sole serialized queue for this physical file set. */
  private work: Promise<unknown> = Promise.resolve();
  private poisoned = false;
  private closing = false;
  private readonly directoryFlusher = new NoticeDirectoryFlusher();
  private constructor(private readonly directory: string, private readonly options: NoticePhysicalOptions<S, D, R>) {}

  static async open<S, D, R>(options: NoticePhysicalOptions<S, D, R>): Promise<NoticeFramedJournal<S, D, R>> {
    if (!isHash(options.recipientKey)) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Invalid fixed notice recipient');
    if (options.codec.minWriterVersion === 2 && (options.codec.profile !== 'sequenced-sparse-v1'
      || typeof options.installationId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(options.installationId))) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Root journal requires a fixed installation/profile');
    await fs.mkdir(options.directory, { recursive: true, mode: 0o700 });
    const directory = await fs.realpath(options.directory);
    if (opening.has(directory)) throw new NoticeLedgerStorageError('notice_ledger_open', 'Notice file set already has a process owner');
    opening.add(directory);
    const journal = new NoticeFramedJournal(directory, options);
    try { await journal.load(); return journal; }
    catch (error) { opening.delete(directory); throw error; }
  }
  /** Internal codec/journal view, never exported to UI or a driver. */
  get current(): S | undefined { return this.state; }
  get committedRevision(): number { return this.revision; }
  get committedDigest(): string { return this.digest; }
  get healthy(): boolean { return !this.poisoned && !this.closing; }
  get directoryDurability() { return this.directoryFlusher.observation; }
  /** Typed reconciliation refusal is also an irreversible admission fence. */
  refuseReconciliation(message: string): never {
    this.poisoned = true;
    throw new NoticeLedgerStorageError('notice_ledger_reconciliation', message);
  }
  async close(): Promise<void> {
    if (this.closing) { await this.work.catch(() => {}); return; }
    this.closing = true;
    await this.work.catch(() => {});
    opening.delete(this.directory);
  }
  private location(segment: number): string { return path.join(this.directory, `journal-${String(segment).padStart(10, '0')}.log`); }
  private assertHealthy(): void {
    if (this.poisoned) throw new NoticeLedgerStorageError('notice_ledger_unavailable', 'Notice storage needs reconciliation');
  }
  private expectation(value: NoticePhysicalExpectation | undefined): void {
    if (value && (value.revision !== this.revision || value.digest !== this.digest)) throw new NoticeLedgerStorageError('notice_ledger_conflict', 'Notice committed expectation changed');
  }
  private decodeManifest(body: Buffer): Manifest {
    if (body.length > NOTICE_DELTA_BYTES) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Oversized notice manifest');
    const value: unknown = JSON.parse(body.toString('utf8'));
    if (!object(value)) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Invalid notice manifest');
    // Legacy optional extras remain opaque, including a field named profile.
    // Only the explicit new writer/profile is allowed to interpret that field.
    if (value.schemaVersion !== 1 || value.minWriterVersion !== this.options.codec.minWriterVersion
      || this.options.codec.profile !== undefined && value.profile !== this.options.codec.profile) throw new NoticeLedgerStorageError('notice_ledger_version', 'Unsupported notice ledger writer version/profile');
    if (this.options.codec.minWriterVersion === 2) {
      const keys = ['schemaVersion', 'minWriterVersion', 'recipientKey', 'checkpointRevision', 'checkpointDigest', 'firstSegment', 'profile', 'installationId'];
      if (value.checkpointRoot !== undefined) keys.push('checkpointRoot');
      if (value.installationId !== this.options.installationId || Object.keys(value).length !== keys.length || keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Invalid root manifest fields or installation');
    }
    if (value.recipientKey !== this.options.recipientKey || !integer(value.checkpointRevision) || !integer(value.firstSegment)
      || !isHash(value.checkpointDigest) || value.checkpointRoot !== undefined && !isHash(value.checkpointRoot)) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Invalid notice manifest identity');
    if ((value.checkpointRevision === 0) !== (value.checkpointRoot === undefined) || value.checkpointRevision === 0 && value.checkpointDigest !== ZERO_HASH) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Invalid notice checkpoint anchor');
    return value as unknown as Manifest;
  }
  private decodeRecord(body: Buffer): RecordEnvelope<unknown> {
    const value: unknown = JSON.parse(body.toString('utf8'));
    if (!object(value)) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Invalid notice journal record');
    if (value.schemaVersion !== 1 || value.minWriterVersion !== this.options.codec.minWriterVersion) throw new NoticeLedgerStorageError('notice_ledger_version', 'Unsupported notice record writer version');
    if (this.options.codec.minWriterVersion === 2 && (Object.keys(value).length !== 5 || !['schemaVersion', 'minWriterVersion', 'revision', 'previousDigest', 'delta'].every((key) => Object.prototype.hasOwnProperty.call(value, key)))) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Unsupported root record fields');
    if (value.revision !== this.revision + 1 || value.previousDigest !== this.digest || !object(value.delta)) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Notice journal chain mismatch');
    return value as unknown as RecordEnvelope<unknown>;
  }
  /** Cleanup is limited to this invocation's exact-created temporary identity. */
  private async replaceMetadata(destination: string, prefix: string, body: Buffer, beforeRename?: () => Promise<void>): Promise<void> {
    const temporary = path.join(this.directory, `${prefix}-${randomUUID()}.tmp`);
    let handle: fs.FileHandle | undefined;
    let identity: import('fs').BigIntStats | undefined;
    let failed = false; let original: unknown;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      identity = await handle.stat({ bigint: true });
      await handle.writeFile(body); await handle.sync(); await handle.close(); handle = undefined;
      await beforeRename?.();
      await fs.rename(temporary, destination);
    } catch (error) {
      // telemetry-exempt: propagated below after current-own-temp cleanup
      failed = true; original = error;
    }
    finally {
      try { await handle?.close(); }
      catch (error) {
        // telemetry-exempt: preserve original failure over secondary close error
        if (!failed) { failed = true; original = error; }
      }
      if (identity) {
        try {
          const current = await fs.lstat(temporary, { bigint: true });
          if (!current.isFile() || current.dev !== identity.dev || current.ino !== identity.ino) {
            if (!failed) { failed = true; original = new NoticeLedgerStorageError('notice_ledger_changed', 'Notice temporary identity changed'); }
          } else await fs.unlink(temporary);
        } catch (error) {
          // telemetry-exempt: absent means renamed; preserve first failure otherwise
          if (!missing(error) && !failed) { failed = true; original = error; }
        }
      }
    }
    if (failed) throw original;
  }
  private async atomicManifest(manifest: Manifest): Promise<void> {
    const body = Buffer.from(JSON.stringify(manifest));
    if (body.length > NOTICE_DELTA_BYTES) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Oversized notice manifest');
    await this.replaceMetadata(path.join(this.directory, 'manifest.json'), 'manifest', body, async () => { await this.options.testFailure?.('beforeManifest'); });
    await this.directoryFlusher.flush(this.directory);
    await this.options.testFailure?.('afterManifest');
    this.manifest = manifest; this.manifestHash = hash(body);
  }
  private async readBoundedFile(location: string, maximum: number, expectedHash?: string, sync = false): Promise<Buffer> {
    let initial: import('fs').Stats;
    try { initial = await fs.lstat(location); }
    catch (error) { if (missing(error)) throw new NoticePhysicalFileAbsent('Notice physical file missing at lookup'); throw error; } // telemetry-exempt: only initial absence can authorize creation
    if (!initial.isFile() || initial.size > maximum) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Invalid notice physical file type/size');
    const flags = (sync && process.platform === 'win32' ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0);
    const handle = await fs.open(location, flags);
    try {
      const same = (s: import('fs').Stats) => s.isFile() && s.dev === initial.dev && s.ino === initial.ino && s.size === initial.size && s.mtimeMs === initial.mtimeMs && s.ctimeMs === initial.ctimeMs;
      if (!same(await handle.stat())) throw new NoticeLedgerStorageError('notice_ledger_changed', 'Notice physical file changed while opening');
      const buffer = Buffer.alloc(maximum + 1); let used = 0;
      while (used < buffer.length) {
        const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used);
        used += bytesRead; if (!bytesRead) break;
      }
      if (used > maximum || used !== initial.size || !same(await handle.stat()) || !same(await fs.lstat(location))) throw new NoticeLedgerStorageError('notice_ledger_changed', 'Notice physical file changed while reading');
      const body = buffer.subarray(0, used);
      if (expectedHash && hash(body) !== expectedHash) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Notice page checksum mismatch');
      if (sync) {
        await handle.sync();
        if (!same(await handle.stat()) || !same(await fs.lstat(location))) throw new NoticeLedgerStorageError('notice_ledger_changed', 'Notice physical file changed while syncing');
      }
      return body;
    } finally { await handle.close(); }
  }
  private readonly pages: NoticePhysicalPages = {
    put: async (value) => {
      const body = Buffer.from(JSON.stringify(value));
      if (body.length > NOTICE_PAGE_BYTES) throw new Error('Notice checkpoint page exceeds its byte bound');
      const digest = hash(body); const destination = path.join(this.directory, `page-${digest}.json`);
      let prior: Buffer | undefined;
      try { prior = await this.readBoundedFile(destination, NOTICE_PAGE_BYTES, digest, true); }
      catch (error) { if (!(error instanceof NoticePhysicalFileAbsent)) throw error; } // telemetry-exempt: later IO/sync failure never authorizes replacement
      if (prior) {
        if (hash(prior) !== digest) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Existing notice page digest mismatch');
      } else await this.replaceMetadata(destination, 'page', body);
      return digest;
    },
    read: async (root) => {
      if (!isHash(root)) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Invalid notice page reference');
      const body = await this.readBoundedFile(path.join(this.directory, `page-${root}.json`), NOTICE_PAGE_BYTES, root);
      if (body.length > NOTICE_PAGE_BYTES || hash(body) !== root) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Notice page checksum mismatch');
      return JSON.parse(body.toString('utf8')) as unknown;
    },
    retireLegacyPages: async (retained) => {
      if (this.options.codec.minWriterVersion !== 1 || this.options.codec.profile !== undefined) throw new NoticeLedgerStorageError('notice_ledger_version', 'Legacy page collection cannot collect a root profile');
      for (const name of await fs.readdir(this.directory)) if (/^page-[a-f0-9]{64}\.json$/.test(name) && !retained.has(name.slice(5, -5))) await fs.unlink(path.join(this.directory, name));
    },
  };
  private async load(): Promise<void> {
    let body: Buffer;
    try { body = await this.readBoundedFile(path.join(this.directory, 'manifest.json'), NOTICE_DELTA_BYTES); }
    catch (error) {
      if (!(error instanceof NoticePhysicalFileAbsent)) throw error; // telemetry-exempt: propagated, never silently repaired
      if ((await fs.readdir(this.directory)).length) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Notice manifest missing beside retained data');
      await this.atomicManifest({ schemaVersion: 1, minWriterVersion: this.options.codec.minWriterVersion, recipientKey: this.options.recipientKey,
        checkpointRevision: 0, checkpointDigest: ZERO_HASH, firstSegment: 0, ...(this.options.codec.profile && { profile: this.options.codec.profile, installationId: this.options.installationId }) });
      body = await this.readBoundedFile(path.join(this.directory, 'manifest.json'), NOTICE_DELTA_BYTES);
    }
    this.manifest = this.decodeManifest(body); this.manifestHash = hash(body);
    this.revision = this.manifest.checkpointRevision; this.digest = this.manifest.checkpointDigest;
    if (this.manifest.checkpointRoot) {
      this.state = await this.options.codec.restore(this.manifest.checkpointRoot, this.pages);
      this.options.codec.validate(this.state);
    }
    const segments = (await fs.readdir(this.directory)).filter((n) => /^journal-\d{10,}\.log$/.test(n))
      .map((n) => Number(n.slice(8, -4))).filter((n) => n >= this.manifest.firstSegment).sort((a, b) => a - b);
    let expected = this.manifest.firstSegment;
    for (let index = 0; index < segments.length; index++) {
      if (segments[index] !== expected++) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Notice journal segment missing');
      this.segment = segments[index];
      const segment = await this.readBoundedFile(this.location(this.segment), NOTICE_PAGE_BYTES);
      if (segment.length > NOTICE_PAGE_BYTES) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Oversized notice segment');
      let offset = 0;
      while (offset < segment.length) {
        const length = segment.length - offset >= 4 ? segment.readUInt32BE(offset) : undefined;
        if (length !== undefined && (length < 2 || length + 36 > NOTICE_DELTA_BYTES)) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Invalid notice frame length');
        if (length === undefined || segment.length - offset < length + 36) {
          if (index !== segments.length - 1) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Non-tail notice record damage');
          await this.preserveAndTrimTail(segment, offset); break;
        }
        const payload = segment.subarray(offset + 4, offset + 4 + length);
        const checksum = segment.subarray(offset + 4 + length, offset + length + 36).toString('hex');
        if (checksum !== hash(payload)) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Notice record checksum mismatch');
        const record = this.decodeRecord(payload);
        this.state = await this.options.codec.replay(this.state, record.delta); this.options.codec.validate(this.state);
        this.revision = record.revision; this.digest = checksum; offset += length + 36;
      }
      this.segmentBytes = offset;
    }
    if (!segments.length) this.segment = this.manifest.firstSegment;
    this.currentFileHash = hash(await this.readCurrent());
    if (this.state && this.options.codec.finalizeOpen) {
      this.state = await this.options.codec.finalizeOpen(this.state);
      this.options.codec.validate(this.state);
    }
  }
  private async preserveAndTrimTail(body: Buffer, offset: number): Promise<void> {
    const location = path.join(this.directory, `incomplete-tail-${randomUUID()}.bin`);
    const preserved = await fs.open(location, 'wx', 0o600);
    try { await preserved.writeFile(body); await preserved.sync(); } finally { await preserved.close(); }
    await this.directoryFlusher.flush(this.directory);
    const journal = await fs.open(this.location(this.segment), 'r+');
    try { await journal.truncate(offset); await journal.sync(); } finally { await journal.close(); }
  }
  private async readCurrent(segment = this.segment, allowMissing = this.segmentBytes === 0 && segment === this.segment): Promise<Buffer> {
    try { return await this.readBoundedFile(this.location(segment), NOTICE_PAGE_BYTES); }
    catch (error) { if (allowMissing && error instanceof NoticePhysicalFileAbsent) return Buffer.alloc(0); throw error; } // telemetry-exempt: only a new empty segment is absent
  }
  private async unchanged(): Promise<void> {
    const manifest = await this.readBoundedFile(path.join(this.directory, 'manifest.json'), NOTICE_DELTA_BYTES); const current = await this.readCurrent();
    if (hash(manifest) !== this.manifestHash || current.length !== this.segmentBytes || hash(current) !== this.currentFileHash) throw new NoticeLedgerStorageError('notice_ledger_changed', 'Notice storage changed outside its owner');
  }
  /** Validation/preparation refusal has no journal effect and does not poison. */
  append(input: D, expected?: NoticePhysicalExpectation): Promise<S | undefined> {
    if (this.closing) return Promise.reject(new NoticeLedgerStorageError('notice_ledger_unavailable', 'Notice storage is closing'));
    const owned = structuredClone(input); const expectation = expected && { ...expected };
    const next = this.work.catch(() => {}).then(async () => {
      this.assertHealthy(); this.expectation(expectation);
      let prepared: { state: S; record: R } | undefined;
      try { prepared = await this.options.codec.prepare(this.state, owned); }
      catch (error) {
        if (!(error instanceof NoticeLedgerValidationError)) this.poisoned = true;
        throw error; // telemetry-exempt: only explicitly no-effect validation can release producer ownership
      }
      this.assertHealthy(); this.expectation(expectation);
      if (!prepared) return this.state;
      this.options.codec.validate(prepared.state);
      const envelope: RecordEnvelope<R> = { schemaVersion: 1, minWriterVersion: this.options.codec.minWriterVersion,
        revision: this.revision + 1, previousDigest: this.digest, delta: prepared.record };
      if (!integer(envelope.revision)) throw new NoticeLedgerValidationError('Notice revision overflow');
      const payload = Buffer.from(JSON.stringify(envelope));
      if (payload.length + 36 > NOTICE_DELTA_BYTES) throw new NoticeLedgerValidationError('Notice delta exceeds its byte bound');
      const digest = hash(payload); const frame = Buffer.alloc(payload.length + 36);
      frame.writeUInt32BE(payload.length, 0); payload.copy(frame, 4); Buffer.from(digest, 'hex').copy(frame, payload.length + 4);
      try {
        await this.unchanged();
        let targetSegment = this.segment; let targetBytes = this.segmentBytes; let priorHash = this.currentFileHash;
        if (this.segmentBytes >= NOTICE_SEGMENT_TARGET) {
          if (this.segment - this.manifest.firstSegment >= 3) {
            await this.checkpointNow();
            targetSegment = this.segment; targetBytes = this.segmentBytes; priorHash = this.currentFileHash;
          } else {
            targetSegment++; targetBytes = 0; priorHash = hash(Buffer.alloc(0));
          }
        }
        await this.options.testFailure?.('beforeAppend');
        this.options.codec.assertPrepared?.(prepared.state, prepared.record);
        const handle = await fs.open(this.location(targetSegment), 'a', 0o600);
        try { await handle.writeFile(frame); await this.options.testFailure?.('afterAppendBeforeSync'); await handle.sync(); }
        finally { await handle.close(); }
        await this.directoryFlusher.flush(this.directory); await this.options.testFailure?.('afterSync');
        await this.options.testFailure?.('beforeFinalBookkeeping');
        const current = await this.readCurrent(targetSegment, false);
        if (current.length !== targetBytes + frame.length || hash(current.subarray(0, targetBytes)) !== priorHash
          || !current.subarray(targetBytes).equals(frame)) throw new NoticeLedgerStorageError('notice_ledger_changed', 'Notice append bookkeeping changed');
        const fileHash = hash(current);
        await this.options.testFailure?.('afterFinalBookkeeping');
        // One non-yielding phase: metadata/state/hash and internal anchor invalidation.
        this.revision = envelope.revision; this.digest = digest; this.state = prepared.state;
        this.segment = targetSegment; this.segmentBytes = targetBytes + frame.length; this.currentFileHash = fileHash;
        this.options.published?.(prepared.state, prepared.record);
      } catch (error) { this.poisoned = true; throw error; } // telemetry-exempt: ambiguous physical IO requires owner reconciliation
      return this.state;
    });
    this.work = next; return next;
  }
  checkpoint(): Promise<void> {
    if (this.closing) return Promise.reject(new NoticeLedgerStorageError('notice_ledger_unavailable', 'Notice storage is closing'));
    const next = this.work.catch(() => {}).then(async () => {
      this.assertHealthy();
      try { await this.unchanged(); await this.checkpointNow(); }
      catch (error) { this.poisoned = true; throw error; } // telemetry-exempt: ambiguous checkpoint never resumes entry
    });
    this.work = next; return next;
  }
  private async checkpointNow(): Promise<void> {
    if (!this.state) return;
    const root = await this.options.codec.checkpoint(this.state, this.pages);
    await this.directoryFlusher.flush(this.directory); await this.options.testFailure?.('afterPages');
    const firstSegment = this.segment + 1;
    if (!integer(firstSegment)) throw new Error('Notice segment overflow');
    await this.atomicManifest({ ...this.manifest, checkpointRevision: this.revision, checkpointDigest: this.digest, checkpointRoot: root, firstSegment });
    this.segment = firstSegment; this.segmentBytes = 0; this.currentFileHash = hash(Buffer.alloc(0));
    await this.options.codec.collect?.(root, this.pages);
    for (const name of await fs.readdir(this.directory)) if (/^journal-\d{10,}\.log$/.test(name) && Number(name.slice(8, -4)) < firstSegment) await fs.unlink(path.join(this.directory, name));
    await this.directoryFlusher.flush(this.directory);
  }
}
