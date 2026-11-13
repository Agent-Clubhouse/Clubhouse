import { createHash, randomUUID } from 'crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { Handoff } from '../../shared/handoffs';
import { HANDOFF_TRANSFER_DEFAULTS, type HandoffWorktreeManifest } from '../../shared/handoff-manifest';
import { HANDOFF_CHUNK_BYTES } from '../../shared/handoff-transfer';
import { HandoffTransferSource, type HandoffTransferSourceOptions } from './handoff-transfer-source';
const machine = Array(16).fill('ab').join(':'); const peer = Array(16).fill('cd').join(':');
function fixture() {
  const bytes = Buffer.alloc(600 * 1024, 17);
  const manifest: HandoffWorktreeManifest = { v: 1, repo: { branch: 'main', base: 'a'.repeat(40), remote: null }, include: { tracked_changes: true, untracked: true, ignored: [] }, exclude: [],
    files: [{ path: 'large.bin', size: bytes.length, mode: '100644', sha256: createHash('sha256').update(bytes).digest('hex') }], deletions: [], total_bytes: bytes.length, manifest_sha256: 'b'.repeat(64) };
  const receiver = { machine: peer, agentId: 'receiver' };
  const record: Handoff = { schemaVersion: 1, id: randomUUID(), from: { machine, agentId: 'sender' }, to: receiver, mode: 'worktree', task: { title: 'Continue', brief: 'Do the work' },
    manifest: { fileCount: 1, totalBytes: bytes.length, sha256: manifest.manifest_sha256 }, state: 'accepted', acceptance: { by: receiver, target: receiver }, history: [], version: 2, createdAt: Date.now(), updatedAt: Date.now() };
  const prepared = { snapshot: { root: 'private-staging', manifest }, source: { bounds: HANDOFF_TRANSFER_DEFAULTS } };
  const descriptor = { size: bytes.length, read: vi.fn(async (offset: number, maximum: number) => bytes.subarray(offset, offset + maximum)), close: vi.fn(async () => {}) };
  const options: HandoffTransferSourceOptions = { machine, record: () => record, authorize: vi.fn(async () => {}), prepared: vi.fn(async () => prepared), verify: vi.fn(async () => prepared.snapshot), open: vi.fn(async () => descriptor), timeoutMs: 5_000 };
  const service = new HandoffTransferSource(options);
  return { service, options, descriptor, bytes, manifest, record, prepared };
}
afterEach(() => { vi.useRealTimers(); });
it('resumes an artifact larger than 512 KiB in independently hashed bounded chunks', async () => {
  const f = fixture(); const chunks: Buffer[] = [];
  expect(await f.service.receive(peer, { op: 'manifest', id: f.record.id })).toEqual({ manifest: f.manifest });
  for (let offset = 0; offset < f.bytes.length; offset += HANDOFF_CHUNK_BYTES) {
    const reply = await f.service.receive(peer, { op: 'read', id: f.record.id, file: 0, offset });
    if (!('data' in reply)) throw new Error('Missing chunk');
    const bytes = Buffer.from(reply.data, 'base64'); chunks.push(bytes);
    expect(bytes.length).toBeLessThanOrEqual(HANDOFF_CHUNK_BYTES); expect(reply.offset).toBe(offset);
    expect(reply.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(reply.eof).toBe(offset + bytes.length === f.bytes.length);
  }
  expect(Buffer.concat(chunks)).toEqual(f.bytes); expect(f.options.verify).toHaveBeenCalledTimes(1); expect(f.options.open).toHaveBeenCalledTimes(1);
  await f.service.close(); await Promise.resolve(); expect(f.descriptor.close).toHaveBeenCalled();
});
it('permits only the addressed machine and requires acceptance before exposing file content', async () => {
  const f = fixture();
  await expect(f.service.receive(machine, { op: 'manifest', id: f.record.id })).rejects.toThrow('unavailable');
  expect(f.options.prepared).not.toHaveBeenCalled();
  f.record.state = 'offered'; delete f.record.acceptance;
  await expect(f.service.receive(peer, { op: 'read', id: f.record.id, file: 0, offset: 0 })).rejects.toThrow('unavailable');
  expect(f.options.open).not.toHaveBeenCalled();
  expect(await f.service.receive(peer, { op: 'manifest', id: f.record.id })).toEqual({ manifest: f.manifest });
  await f.service.close();
});
it('rescans the complete source before exposing any artifact bytes', async () => {
  const f = fixture(); vi.mocked(f.options.verify!).mockRejectedValue(new Error('blocked'));
  await expect(f.service.receive(peer, { op: 'read', id: f.record.id, file: 0, offset: 0 })).rejects.toThrow('blocked');
  expect(f.options.open).not.toHaveBeenCalled(); expect(f.descriptor.read).not.toHaveBeenCalled();
});
it('rechecks authority after reading and emits no chunk if consent changed', async () => {
  const f = fixture();
  f.descriptor.read.mockImplementation(async () => { vi.mocked(f.options.authorize).mockRejectedValue(new Error('revoked')); return f.bytes.subarray(0, 1); });
  await expect(f.service.receive(peer, { op: 'read', id: f.record.id, file: 0, offset: 0 })).rejects.toThrow('revoked');
  await Promise.resolve(); expect(f.descriptor.close).toHaveBeenCalled();
});
it('expires a never-settling sampler without retaining or overwriting a fresh cache entry', async () => {
  vi.useFakeTimers(); const f = fixture(); f.options.timeoutMs = 50;
  vi.mocked(f.options.prepared).mockImplementationOnce(() => new Promise(() => {}));
  const pending = expect(f.service.receive(peer, { op: 'manifest', id: f.record.id })).rejects.toThrow('deadline');
  await vi.advanceTimersByTimeAsync(51); await pending;
  expect(await f.service.receive(peer, { op: 'manifest', id: f.record.id })).toEqual({ manifest: f.manifest });
  expect(f.options.prepared).toHaveBeenCalledTimes(2); await f.service.close();
});
it('closes a descriptor that opens after its deadline rather than caching it', async () => {
  vi.useFakeTimers(); const f = fixture(); f.options.timeoutMs = 50; let release!: (value: typeof f.descriptor) => void;
  vi.mocked(f.options.open!).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  const pending = expect(f.service.receive(peer, { op: 'read', id: f.record.id, file: 0, offset: 0 })).rejects.toThrow('deadline');
  await vi.advanceTimersByTimeAsync(51); await pending;
  release(f.descriptor); await vi.advanceTimersByTimeAsync(0);
  expect(f.descriptor.close).toHaveBeenCalledTimes(1); expect(f.descriptor.read).not.toHaveBeenCalled();
  expect(await f.service.receive(peer, { op: 'manifest', id: f.record.id })).toEqual({ manifest: f.manifest });
  expect(f.options.prepared).toHaveBeenCalledTimes(2); await f.service.close();
});
