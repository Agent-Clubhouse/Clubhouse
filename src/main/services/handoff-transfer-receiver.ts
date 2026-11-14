import * as fs from 'fs';
import type { FileHandle } from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import { canonicalHandoffManifest, parseHandoffManifest, summarizeHandoffManifest, validateHandoffBounds, type HandoffTransferBounds } from '../../shared/handoff-manifest';
import type { HandoffManifestSummary } from '../../shared/handoffs';
import { HANDOFF_CHUNK_BYTES, parseHandoffTransferRequest, type HandoffTransferRequest } from '../../shared/handoff-transfer';
import { scanHandoffSecrets } from '../../shared/handoff-secrets';
import type { HandoffSecretPolicy } from './handoff-secret-settings';
import { HandoffSnapshotError, verifyHandoffSnapshot } from './handoff-snapshot';

export class HandoffTransferInterrupted extends Error {
  constructor() { super('Handoff transfer interrupted; retained bytes can resume.'); }
}
/** Transport distinguishes a permanent peer refusal from a disconnected socket. */
export class HandoffTransferRefused extends Error {
  constructor() { super('Handoff transfer refused.'); }
}
const object = (raw: unknown): raw is Record<string, unknown> => !!raw && typeof raw === 'object' && !Array.isArray(raw);
const identity = (stat: fs.BigIntStats) => [stat.dev, stat.ino, stat.mode].join(':');

/** Pins every app-owned staging parent. Leaf opens additionally reject links and hardlinks. */
class Staging {
  private readonly directories = new Map<string, string>();
  constructor(readonly root: string) {}
  async check(): Promise<void> {
    for (const [name, expected] of this.directories) {
      const stat = await fs.promises.lstat(name, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || identity(stat) !== expected) throw new HandoffSnapshotError('unsafe_entry');
    }
  }
  async directory(name: string, create: boolean): Promise<void> {
    await this.check();
    if (create) {
      try { await fs.promises.mkdir(name, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    const stat = await fs.promises.lstat(name, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || !path.isAbsolute(name) || path.relative(name, await fs.promises.realpath(name)) !== '') throw new HandoffSnapshotError('unsafe_entry');
    const pinned = this.directories.get(name);
    if (pinned && pinned !== identity(stat)) throw new HandoffSnapshotError('source_changed');
    this.directories.set(name, identity(stat)); await this.check();
  }
  async open(name: string): Promise<FileHandle> {
    let current = this.root;
    const parts = path.relative(this.root, name).split(path.sep);
    if (parts.some((part) => !part || part === '..') || path.isAbsolute(path.relative(this.root, name))) throw new HandoffSnapshotError('unsafe_entry');
    for (const part of parts.slice(0, -1)) { current = path.join(current, part); await this.directory(current, true); }
    await this.check();
    const handle = await fs.promises.open(name, fs.constants.O_RDWR | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0), 0o600);
    try {
      const stat = await handle.stat({ bigint: true }); const leaf = await fs.promises.lstat(name, { bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n || leaf.isSymbolicLink() || identity(leaf) !== identity(stat)) throw new HandoffSnapshotError('unsafe_entry');
      await this.check(); return handle;
    } catch (error) { await handle.close(); throw error; }
  }
  async remove(): Promise<void> { await this.check(); await fs.promises.rm(this.root, { recursive: true, force: true }); }
}

export interface ReceiveHandoffSnapshotOptions {
  id: string;
  /** Existing main-owned received-data parent, never a path supplied by a peer or agent. */
  stagingRoot: string;
  expected: HandoffManifestSummary;
  bounds: HandoffTransferBounds;
  secretPolicy?: HandoffSecretPolicy;
  authorize(): Promise<void>;
  request(request: HandoffTransferRequest): Promise<unknown>;
  progress?(bytesDone: number, totalBytes: number): Promise<void>;
}

/** File lengths are durable resume offsets. Every final byte is independently verified. */
export async function receiveHandoffSnapshot(options: ReceiveHandoffSnapshotOptions) {
  parseHandoffTransferRequest({ op: 'manifest', id: options.id });
  const bounds = validateHandoffBounds(options.bounds);
  const root = await fs.promises.realpath(options.stagingRoot);
  if ((await fs.promises.lstat(options.stagingRoot)).isSymbolicLink()) throw new HandoffSnapshotError('invalid_staging');
  const stage = new Staging(path.join(root, options.id));
  await stage.directory(root, false);
  const request = async (value: HandoffTransferRequest) => {
    await options.authorize();
    let reply: unknown;
    try { reply = await options.request(value); }
    catch (error) {
      if (error instanceof HandoffTransferRefused) throw error;
      throw new HandoffTransferInterrupted();
    }
    await options.authorize(); return reply;
  };
  let allocated = false;
  try {
    const reply = await request({ op: 'manifest', id: options.id });
    if (!object(reply) || Object.keys(reply).length !== 1 || !('manifest' in reply)) throw new HandoffSnapshotError('hash_mismatch');
    const manifest = parseHandoffManifest(reply.manifest, bounds);
    const expected = options.expected; const summary = summarizeHandoffManifest(manifest);
    if (summary.fileCount !== expected.fileCount || summary.totalBytes !== expected.totalBytes || summary.sha256 !== expected.sha256
      || createHash('sha256').update(canonicalHandoffManifest(manifest, bounds)).digest('hex') !== expected.sha256) throw new HandoffSnapshotError('hash_mismatch');
    // Reject unsafe metadata before allocating or asking the sender for file bytes.
    const metadata = [manifest.repo.remote ?? '', manifest.repo.branch, ...manifest.include.ignored, ...manifest.exclude, ...manifest.deletions, ...manifest.files.map((file) => file.path)];
    if (metadata.some((value) => scanHandoffSecrets('metadata/value.txt', Buffer.from(value)).length)) throw new HandoffSnapshotError('secret_blocked');
    await stage.directory(stage.root, true); allocated = true;
    await stage.directory(path.join(stage.root, 'files'), true);
    const output = await stage.open(path.join(stage.root, 'manifest.json'));
    try {
      const before = await output.stat();
      if (before.size > 2 * 1024 ** 2) throw new HandoffSnapshotError('bounds_exceeded');
      if (before.size) {
        const bytes = Buffer.alloc(before.size); let position = 0;
        while (position < bytes.length) { const { bytesRead } = await output.read(bytes, position, bytes.length - position, position); if (!bytesRead) throw new HandoffSnapshotError('source_changed'); position += bytesRead; }
        const old = parseHandoffManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), bounds);
        if (canonicalHandoffManifest(old, bounds) !== canonicalHandoffManifest(manifest, bounds) || old.manifest_sha256 !== expected.sha256) throw new HandoffSnapshotError('hash_mismatch');
      } else { await output.writeFile(JSON.stringify(manifest)); await output.sync(); }
    } finally { await output.close(); }
    const artifacts = [...(manifest.bundle ? [{ file: -1, name: 'bundle.bin', size: manifest.bundle.size }] : []),
      ...manifest.files.map((file, index) => ({ file: index, name: path.join('files', file.path), size: file.size }))];
    let done = 0;
    for (const artifact of artifacts) {
      await options.authorize();
      const name = path.join(stage.root, artifact.name); const handle = await stage.open(name);
      try {
        let offset = (await handle.stat()).size;
        if (offset > artifact.size) throw new HandoffSnapshotError('hash_mismatch');
        done += offset; await options.progress?.(done, manifest.total_bytes);
        while (offset < artifact.size) {
          const reply = await request({ op: 'read', id: options.id, file: artifact.file, offset });
          if (!object(reply) || Object.keys(reply).sort().join(',') !== 'data,eof,offset,sha256,totalBytes'
            || reply.offset !== offset || reply.totalBytes !== artifact.size || typeof reply.data !== 'string'
            || reply.data.length > Math.ceil(HANDOFF_CHUNK_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(reply.data)
            || typeof reply.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(reply.sha256)) throw new HandoffSnapshotError('hash_mismatch');
          const bytes = Buffer.from(reply.data, 'base64');
          if (!bytes.length || bytes.length > HANDOFF_CHUNK_BYTES || offset + bytes.length > artifact.size || bytes.toString('base64') !== reply.data
            || createHash('sha256').update(bytes).digest('hex') !== reply.sha256 || reply.eof !== (offset + bytes.length === artifact.size)) throw new HandoffSnapshotError('hash_mismatch');
          await stage.check();
          const leaf = await fs.promises.lstat(name, { bigint: true }); const pinned = await handle.stat({ bigint: true });
          if (identity(leaf) !== identity(pinned) || !pinned.isFile() || pinned.nlink !== 1n || pinned.size !== BigInt(offset)) throw new HandoffSnapshotError('source_changed');
          let position = 0;
          while (position < bytes.length) { const { bytesWritten } = await handle.write(bytes, position, bytes.length - position, offset + position); if (!bytesWritten) throw new HandoffSnapshotError('filesystem_failed'); position += bytesWritten; }
          await handle.sync(); offset += bytes.length; done += bytes.length;
          await stage.check(); await options.progress?.(done, manifest.total_bytes);
        }
      } finally { await handle.close(); }
    }
    await options.authorize(); await stage.check();
    const verified = await verifyHandoffSnapshot(stage.root, manifest, expected, bounds,
      options.secretPolicy ? { policy: options.secretPolicy, handoffId: options.id } : undefined);
    await options.authorize(); return verified;
  } catch (failure) {
    const error = failure instanceof HandoffSnapshotError || failure instanceof HandoffTransferInterrupted || failure instanceof HandoffTransferRefused ? failure : new HandoffSnapshotError('filesystem_failed');
    if (allocated && !(error instanceof HandoffTransferInterrupted)) {
      try { await stage.remove(); }
      catch { if (error instanceof HandoffSnapshotError) error.cleanupFailed = true; /* telemetry-exempt: failed cleanup cannot authorize an unsafe recursive removal */ }
    }
    throw error;
  }
}
