import { createHash } from 'crypto';
import type { Handoff, HandoffManifestSummary } from '../../shared/handoffs';
import type { HandoffTransferBounds, HandoffWorktreeManifest } from '../../shared/handoff-manifest';
import { HANDOFF_CHUNK_BYTES, HANDOFF_TRANSFER_TIMEOUT_MS, parseHandoffTransferRequest } from '../../shared/handoff-transfer';
import type { HandoffSecretPolicy } from './handoff-secret-settings';
import { openHandoffSnapshotArtifact, verifyHandoffSnapshot, type HandoffSnapshot } from './handoff-snapshot';

type Artifact = Awaited<ReturnType<typeof openHandoffSnapshotArtifact>>;
interface Prepared { snapshot: HandoffSnapshot; source: { bounds: HandoffTransferBounds; secretPolicy?: HandoffSecretPolicy } }
interface Entry {
  active: boolean; used: number; source: Promise<Prepared>;
  file?: number; artifact?: Promise<Artifact>; opened?: Artifact; closing?: Promise<void>;
}
export interface HandoffTransferSourceOptions {
  machine: string;
  record(id: string): Handoff | undefined;
  authorize(record: Handoff, peer: string): Promise<void>;
  prepared(record: Handoff): Promise<Prepared>;
  timeoutMs?: number;
  /** Injected descriptor/verification boundaries support deterministic, model-free tests. */
  open?: typeof openHandoffSnapshotArtifact;
  verify?: typeof verifyHandoffSnapshot;
}
export type HandoffTransferReply = { manifest: HandoffWorktreeManifest } | {
  offset: number; totalBytes: number; data: string; sha256: string; eof: boolean;
};

/** Serves only frozen, agreement-bound artifacts. No peer-supplied filesystem paths. */
export class HandoffTransferSource {
  private readonly entries = new Map<string, Entry>();
  private readonly requests = new Map<string, number>();
  constructor(private readonly options: HandoffTransferSourceOptions) {}

  private async authorized(id: string, peer: string, content: boolean): Promise<Handoff> {
    const record = this.options.record(id);
    if (!record || record.id !== id || record.from.machine !== this.options.machine || record.to.machine !== peer || !record.manifest
      || !['offered', 'accepted', 'transferring'].includes(record.state)
      || content && (!record.acceptance || !['accepted', 'transferring'].includes(record.state))) throw new Error('Handoff transfer unavailable.');
    await this.options.authorize(record, peer);
    return record;
  }

  private invalidate(id: string, entry: Entry): Promise<void> {
    entry.active = false;
    if (this.entries.get(id) === entry) this.entries.delete(id);
    const opened = entry.opened; entry.opened = undefined;
    if (opened) entry.closing = opened.close().catch(() => { /* telemetry-exempt: expired descriptors are never reused */ });
    return entry.closing ?? Promise.resolve();
  }

  private entry(id: string, record: Handoff): Entry {
    const now = Date.now();
    for (const [key, item] of this.entries) if (now - item.used > 5 * 60_000) void this.invalidate(key, item);
    let entry = this.entries.get(id);
    if (!entry) {
      if (this.entries.size >= 8) throw new Error('Handoff transfer busy.');
      const current: Entry = { active: true, used: now, source: Promise.resolve(undefined as never) };
      current.source = (async () => {
        const prepared = await this.options.prepared(record);
        const policy = prepared.source.secretPolicy;
        await (this.options.verify ?? verifyHandoffSnapshot)(prepared.snapshot.root, prepared.snapshot.manifest,
          record.manifest as HandoffManifestSummary, prepared.source.bounds,
          policy ? { policy, handoffId: id, side: 'sender' } : undefined);
        if (!current.active) throw new Error('Handoff transfer expired.');
        return prepared;
      })();
      // A late failure after a request deadline must not become an unhandled rejection.
      void current.source.catch(() => {}); // telemetry-exempt: the caller receives a bounded refusal
      this.entries.set(id, current); entry = current;
    }
    entry.used = now;
    return entry;
  }

  async receive(peer: string, raw: unknown): Promise<HandoffTransferReply> {
    const request = parseHandoffTransferRequest(raw);
    if ((this.requests.get(peer) ?? 0) >= 2 || [...this.requests.values()].reduce((a, b) => a + b, 0) >= 8) throw new Error('Handoff transfer busy.');
    this.requests.set(peer, (this.requests.get(peer) ?? 0) + 1);
    let expired = false; let entry: Entry | undefined;
    const assertCurrent = async () => {
      if (expired || entry && !entry.active) throw new Error('Handoff transfer expired.');
      await this.authorized(request.id, peer, request.op === 'read');
      if (expired || entry && !entry.active) throw new Error('Handoff transfer expired.');
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        if (entry) void this.invalidate(request.id, entry);
        reject(new Error('Handoff transfer deadline exceeded.'));
      }, this.options.timeoutMs ?? HANDOFF_TRANSFER_TIMEOUT_MS);
    });
    try {
      const work = (async (): Promise<HandoffTransferReply> => {
        const record = await this.authorized(request.id, peer, request.op === 'read');
        if (expired) throw new Error('Handoff transfer expired.');
        entry = this.entry(request.id, record);
        const prepared = await entry.source;
        await assertCurrent();
        if (request.op === 'manifest') return { manifest: prepared.snapshot.manifest };
        if (entry.file !== request.file) {
          const previous = entry.artifact;
          entry.file = request.file;
          const captured = entry;
          entry.artifact = (async () => {
            await previous?.then((artifact) => artifact.close());
            captured.opened = undefined;
            const artifact = await (this.options.open ?? openHandoffSnapshotArtifact)({
              snapshot: prepared.snapshot, file: request.file, bounds: prepared.source.bounds,
              policy: prepared.source.secretPolicy, handoffId: request.id,
              authorize: async () => {
                if (!captured.active) throw new Error('Handoff transfer expired.');
                await this.authorized(request.id, peer, true);
              },
            });
            if (!captured.active) { await artifact.close(); throw new Error('Handoff transfer expired.'); }
            captured.opened = artifact; return artifact;
          })();
        }
        const artifact = await entry.artifact!;
        const bytes = await artifact.read(request.offset, HANDOFF_CHUNK_BYTES);
        await assertCurrent();
        return { offset: request.offset, totalBytes: artifact.size, data: bytes.toString('base64'),
          sha256: createHash('sha256').update(bytes).digest('hex'), eof: request.offset + bytes.length === artifact.size };
      })();
      return await Promise.race([work, deadline]);
    } catch (error) {
      if (entry) await this.invalidate(request.id, entry);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      const count = (this.requests.get(peer) ?? 1) - 1;
      if (count) this.requests.set(peer, count); else this.requests.delete(peer);
    }
  }

  async close(id?: string): Promise<void> {
    await Promise.all([...this.entries].filter(([key]) => id === undefined || key === id).map(([key, entry]) => this.invalidate(key, entry)));
  }
}
