import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalHandoffManifest, HANDOFF_TRANSFER_DEFAULTS, summarizeHandoffManifest, type HandoffWorktreeManifest } from '../../shared/handoff-manifest';
import type { Handoff } from '../../shared/handoffs';
import { HANDOFF_CHUNK_BYTES } from '../../shared/handoff-transfer';
import { HandoffTransferSource } from './handoff-transfer-source';
import { receiveHandoffSnapshot, HandoffTransferInterrupted, type ReceiveHandoffSnapshotOptions } from './handoff-transfer-receiver';
let root: string; let incoming: string; let outgoing: string;
const machine = Array(16).fill('ab').join(':'); const peer = Array(16).fill('cd').join(':');
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
// Each chunk crosses real file descriptors and fsync boundaries on both endpoints.
describe('real-I/O handoff transport', { timeout: 30_000 }, () => {
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-receive-')));
  incoming = path.join(root, 'incoming'); outgoing = path.join(root, 'outgoing');
  fs.mkdirSync(incoming); fs.mkdirSync(outgoing); fs.mkdirSync(path.join(outgoing, 'files'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
function fixture(bytes = Buffer.alloc(600 * 1024, 17)) {
  const id = randomUUID(); const name = 'fixtures/selected.bin';
  const manifest: HandoffWorktreeManifest = { v: 1, repo: { branch: 'main', base: 'a'.repeat(40), remote: null }, include: { tracked_changes: true, untracked: true, ignored: ['fixtures/*.bin'] }, exclude: ['**/node_modules/**'],
    files: [{ path: name, size: bytes.length, mode: '100644', sha256: hash(bytes) }], deletions: [], total_bytes: bytes.length, manifest_sha256: 'b'.repeat(64) };
  manifest.manifest_sha256 = hash(canonicalHandoffManifest(manifest));
  fs.mkdirSync(path.join(outgoing, 'files', 'fixtures')); fs.writeFileSync(path.join(outgoing, 'files', name), bytes);
  const target = { machine: peer, agentId: 'receiver' };
  const record: Handoff = { schemaVersion: 1, id, createdAt: Date.now(), updatedAt: Date.now(), version: 2, state: 'accepted', history: [], from: { machine, agentId: 'sender' }, to: target, acceptance: { by: target, target },
    task: { title: 'Continue', brief: 'Work' }, mode: 'worktree', manifest: summarizeHandoffManifest(manifest) };
  const sender = new HandoffTransferSource({ machine, record: () => record, authorize: async () => {}, prepared: async () => ({ snapshot: { root: outgoing, manifest }, source: { bounds: HANDOFF_TRANSFER_DEFAULTS } }) });
  const options: ReceiveHandoffSnapshotOptions = { id, stagingRoot: incoming, expected: record.manifest!, bounds: HANDOFF_TRANSFER_DEFAULTS, authorize: async () => {}, request: (request) => sender.receive(peer, request) };
  return { bytes, name, id, manifest, record, sender, options };
}
it('copies selected ignored bytes over 512 KiB through the source boundary and verifies every hash', async () => {
  const f = fixture(); const progress = vi.fn(async () => {}); f.options.progress = progress;
  const received = await receiveHandoffSnapshot(f.options);
  expect(received.manifest).toEqual(f.manifest);
  expect(fs.readFileSync(path.join(received.root, 'files', f.name))).toEqual(f.bytes);
  expect(progress).toHaveBeenLastCalledWith(f.bytes.length, f.bytes.length); await f.sender.close();
});
it('resumes at its fsynced file offset after both transport endpoints restart', async () => {
  const f = fixture(); const transport = f.options.request; let chunks = 0;
  f.options.request = async (request) => { if (request.op === 'read' && ++chunks === 2) throw new Error('disconnected'); return transport(request); };
  await expect(receiveHandoffSnapshot(f.options)).rejects.toBeInstanceOf(HandoffTransferInterrupted);
  expect(fs.statSync(path.join(incoming, f.id, 'files', f.name)).size).toBe(HANDOFF_CHUNK_BYTES); await f.sender.close();
  const restarted = new HandoffTransferSource({ machine, record: () => f.record, authorize: async () => {}, prepared: async () => ({ snapshot: { root: outgoing, manifest: f.manifest }, source: { bounds: HANDOFF_TRANSFER_DEFAULTS } }) });
  const offsets: number[] = [];
  f.options.request = async (request) => { if (request.op === 'read') offsets.push(request.offset); return restarted.receive(peer, request); };
  const result = await receiveHandoffSnapshot(f.options);
  expect(offsets[0]).toBe(HANDOFF_CHUNK_BYTES); expect(fs.readFileSync(path.join(result.root, 'files', f.name))).toEqual(f.bytes); await restarted.close();
});
it('rejects a corrupt chunk and removes the entire receiving allocation', async () => {
  const f = fixture(Buffer.from('plain work')); const transport = f.options.request;
  f.options.request = async (request) => { const reply = await transport(request); return request.op === 'read' ? { ...reply as object, data: Buffer.from('corruption').toString('base64') } : reply; };
  await expect(receiveHandoffSnapshot(f.options)).rejects.toMatchObject({ code: 'hash_mismatch' });
  expect(fs.readdirSync(incoming)).toEqual([]); await f.sender.close();
});
it('rejects receiver-side secrets in otherwise hash-valid bytes before returning anything to apply', async () => {
  const f = fixture(Buffer.from(`ghp_${'a'.repeat(36)}`));
  // Deliberately bypass sender checks to model a malicious peer with a valid manifest.
  f.options.request = async (request) => request.op === 'manifest' ? { manifest: f.manifest } : {
    offset: request.offset, totalBytes: f.bytes.length, data: f.bytes.subarray(request.offset).toString('base64'), sha256: hash(f.bytes.subarray(request.offset)), eof: true,
  };
  await expect(receiveHandoffSnapshot(f.options)).rejects.toMatchObject({ code: 'secret_blocked' });
  expect(fs.readdirSync(incoming)).toEqual([]); await f.sender.close();
});
it('sends zero file content when the sender scan blocks a forged prepared snapshot', async () => {
  const f = fixture(Buffer.from(`ghp_${'a'.repeat(36)}`)); const transport = f.options.request; let reads = 0;
  f.options.request = async (request) => { if (request.op === 'read') reads++; return transport(request); };
  await expect(receiveHandoffSnapshot(f.options)).rejects.toBeInstanceOf(HandoffTransferInterrupted);
  expect(reads).toBe(0); expect(fs.readdirSync(incoming)).toEqual([]); await f.sender.close();
});
it('refuses a planted receiving parent link without modifying its outside target', async () => {
  const f = fixture(Buffer.from('plain work')); const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
  fs.mkdirSync(path.join(incoming, f.id)); fs.mkdirSync(path.join(incoming, f.id, 'files'));
  fs.symlinkSync(outside, path.join(incoming, f.id, 'files', 'fixtures'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(receiveHandoffSnapshot(f.options)).rejects.toMatchObject({ code: 'unsafe_entry' });
  expect(fs.readdirSync(outside)).toEqual([]); await f.sender.close();
});

});
