import { createHash, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { HandoffTransferBounds, HandoffWorktreeManifest } from '../../shared/handoff-manifest';
import type { HandoffManifestSummary } from '../../shared/handoffs';
import {
  HandoffSnapshotError, inspectHandoffSource, stampHandoffSource, statHandoffSource, verifyHandoffManifest, verifyHandoffSnapshot,
} from './handoff-snapshot';

export const HANDOFF_STREAM_CHUNK_BYTES = 64 * 1024;

/** Internal source frames, not agent-call envelopes; a 2 MiB manifest needs dedicated bounded transport framing. */
export type HandoffReadFrame =
  | { kind: 'manifest'; manifest: HandoffWorktreeManifest }
  | { kind: 'file'; path: string; offset: number; bytes: Uint8Array }
  | { kind: 'file-complete'; path: string }
  | { kind: 'complete' };

export interface ReadHandoffSnapshot {
  root: string;
  manifest: unknown;
  expected: HandoffManifestSummary;
  /** Current two-sided grant/connection/accepting policy; never wire-provided authority. */
  authorize(): Promise<boolean>;
  bounds?: HandoffTransferBounds;
  resume?: ReadonlyArray<{ path: string; offset: number }>;
}

async function authorized(options: ReadHandoffSnapshot): Promise<void> {
  try {
    if (await options.authorize() === true) return;
  } catch {
    // telemetry-exempt: authorization diagnostics may contain private transport data
  }
  throw new HandoffSnapshotError('authorization_changed');
}

/**
 * Unregistered, backpressured source only, not a transfer receipt or apply.
 * A private hash index binds every emitted chunk to a fully scanned, manifest-hash-verified read.
 */
export async function* readHandoffSnapshot(options: ReadHandoffSnapshot): AsyncGenerator<HandoffReadFrame> {
  try {
    await authorized(options);
    const manifest = verifyHandoffManifest(options.manifest, options.expected, options.bounds);
    const files = new Map(manifest.files.map((file) => [file.path, file]));
    const resume = new Map<string, number>();
    if (options.resume !== undefined && (!Array.isArray(options.resume) || options.resume.length > manifest.files.length)) {
      throw new HandoffSnapshotError('bounds_exceeded');
    }
    for (const entry of options.resume ?? []) {
      const file = files.get(entry?.path);
      if (!file || Object.keys(entry).some((key) => key !== 'path' && key !== 'offset')
        || resume.has(entry.path) || !Number.isSafeInteger(entry.offset) || entry.offset < 0 || entry.offset > file.size
        || entry.offset !== file.size && entry.offset % HANDOFF_STREAM_CHUNK_BYTES !== 0) throw new HandoffSnapshotError('bounds_exceeded');
      resume.set(entry.path, entry.offset);
    }
    const snapshot = await verifyHandoffSnapshot(options.root, manifest, options.expected, options.bounds);
    await authorized(options);
    yield { kind: 'manifest', manifest: structuredClone(snapshot.manifest) };
    const root = path.join(snapshot.root, 'files');
    for (const file of snapshot.manifest.files) {
      await authorized(options);
      const stat = await statHandoffSource(root, file.path);
      if (!stat || stat.size !== BigInt(file.size)) throw new HandoffSnapshotError('source_changed', file.path);
      const hashes = Buffer.alloc(Math.ceil(file.size / HANDOFF_STREAM_CHUNK_BYTES) * 32);
      let part = createHash('sha256');
      let used = 0;
      let index = 0;
      const actual = await inspectHandoffSource(root, { path: file.path, stat }, async (chunk) => {
        await authorized(options);
        for (let offset = 0; offset < chunk.byteLength;) {
          const length = Math.min(HANDOFF_STREAM_CHUNK_BYTES - used, chunk.byteLength - offset);
          part.update(chunk.subarray(offset, offset + length));
          offset += length;
          used += length;
          if (used === HANDOFF_STREAM_CHUNK_BYTES) {
            part.digest().copy(hashes, index++ * 32);
            part = createHash('sha256');
            used = 0;
          }
        }
      });
      if (used) part.digest().copy(hashes, index++ * 32);
      if (index * 32 !== hashes.byteLength || !timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(file.sha256, 'hex'))) {
        throw new HandoffSnapshotError('hash_mismatch', file.path);
      }
      await authorized(options);
      const handle = await fs.promises.open(path.join(root, file.path), fs.constants.O_RDONLY
        | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
      try {
        const current = await statHandoffSource(root, file.path);
        if (!current || stampHandoffSource(current) !== stampHandoffSource(stat)
          || stampHandoffSource(await handle.stat({ bigint: true })) !== stampHandoffSource(stat)) {
          throw new HandoffSnapshotError('source_changed', file.path);
        }
        for (let position = resume.get(file.path) ?? 0; position < file.size;) {
          await authorized(options);
          const bytes = Buffer.alloc(Math.min(HANDOFF_STREAM_CHUNK_BYTES, file.size - position));
          let read = 0;
          while (read < bytes.byteLength) {
            const result = await handle.read(bytes, read, bytes.byteLength - read, position + read);
            if (!result.bytesRead) throw new HandoffSnapshotError('source_changed', file.path);
            read += result.bytesRead;
          }
          const expected = hashes.subarray(position / HANDOFF_STREAM_CHUNK_BYTES * 32, position / HANDOFF_STREAM_CHUNK_BYTES * 32 + 32);
          if (!timingSafeEqual(createHash('sha256').update(bytes).digest(), expected)) throw new HandoffSnapshotError('hash_mismatch', file.path);
          await authorized(options);
          yield { kind: 'file', path: file.path, offset: position, bytes };
          position += bytes.byteLength;
        }
        const after = await statHandoffSource(root, file.path);
        if (!after || stampHandoffSource(after) !== stampHandoffSource(stat)
          || stampHandoffSource(await handle.stat({ bigint: true })) !== stampHandoffSource(stat)) {
          throw new HandoffSnapshotError('source_changed', file.path);
        }
      } finally {
        await handle.close();
      }
      await authorized(options);
      yield { kind: 'file-complete', path: file.path };
    }
    await authorized(options);
    yield { kind: 'complete' };
  } catch (error) {
    if (error instanceof HandoffSnapshotError) throw error;
    throw new HandoffSnapshotError('filesystem_failed');
  }
}
