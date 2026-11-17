/** Real services and filesystem, with call-through pauses inside their own awaits. */
import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { FileHandle } from 'fs/promises';
import { createHash, randomUUID } from 'crypto';
import { canonicalHandoffManifest, HANDOFF_TRANSFER_DEFAULTS, summarizeHandoffManifest, type HandoffWorktreeManifest } from '../../shared/handoff-manifest';
import type { Handoff } from '../../shared/handoffs';
import { HandoffTransferSource } from './handoff-transfer-source';
let root: string | undefined;
let source: HandoffTransferSource | undefined;
afterEach(async () => { vi.restoreAllMocks(); await source?.close(); source = undefined; if (root) fs.rmSync(root, { recursive: true, force: true }); root = undefined; });
it.each(['peer-revoked', 'cancelled', 'acceptance-removed', 'record-removed', 'agreement-changed', 'target-changed', 'grant-generation', 'policy-generation'] as const)('P6 real handoff descriptor stat await: %s prevents the next filesystem read and closes its descriptor', async (change) => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'binary-fence-')));
  fs.mkdirSync(path.join(root, 'files'));
  const bytes = Buffer.alloc(300000, 0x71);
  fs.writeFileSync(path.join(root, 'files', 'data.bin'), bytes);
  const hash = (body: Buffer | string) => createHash('sha256').update(body).digest('hex');
  const manifest: HandoffWorktreeManifest = { v: 1, repo: { branch: 'main', base: 'a'.repeat(40), remote: null }, include: { tracked_changes: true, untracked: true, ignored: [] }, exclude: [], files: [{ path: 'data.bin', size: bytes.length, mode: '100644', sha256: hash(bytes) }], deletions: [], total_bytes: bytes.length, manifest_sha256: '0'.repeat(64) };
  manifest.manifest_sha256 = hash(canonicalHandoffManifest(manifest));
  const machine = 'sender'; const peer = 'receiver'; const receiver = { machine: peer, agentId: 'a' };
  const record = { schemaVersion: 1, id: randomUUID(), from: { machine, agentId: 'a' }, to: receiver, mode: 'worktree', task: { title: 't', brief: 'b' }, manifest: summarizeHandoffManifest(manifest), state: 'accepted', acceptance: { by: receiver, target: receiver }, history: [], version: 2, createdAt: Date.now(), updatedAt: Date.now() } as Handoff;
  let current: Handoff | undefined = record;
  const handles: FileHandle[] = [];
  const open = fs.promises.open.bind(fs.promises);
  vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => { const handle = await open(...args); handles.push(handle); return handle; });
  let generation = 0;
  source = new HandoffTransferSource({ authority: () => { const captured = generation; return { check: () => { if (captured !== generation) throw new Error('policy changed'); }, dispose: () => {} }; }, machine, record: () => current, authorize: async () => {}, prepared: async () => ({ snapshot: { root: root!, manifest }, source: { bounds: HANDOFF_TRANSFER_DEFAULTS } }) });
  const request = { op: 'read', id: record.id, file: 0, offset: 0 };
  await source.receive(peer, request);
  const pinned = handles.at(-1)!;
  const stat = pinned.stat.bind(pinned);
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const ready = new Promise<void>((r) => { entered = r; });
  vi.spyOn(pinned, 'stat').mockImplementationOnce((async (...args: unknown[]) => {
    const result = await (stat as (...args: unknown[]) => Promise<unknown>)(...args);
    entered(); await gate; return result;
  }) as any);
  const read = vi.spyOn(pinned, 'read');
  const close = vi.spyOn(pinned, 'close');
  let allowed = true;
  const pending = source.receive(peer, request, () => { if (!allowed) throw new Error('authorization_revoked'); }).catch((e) => e);
  await ready;
  if (change === 'grant-generation' || change === 'policy-generation') generation++;
  else if (change === 'peer-revoked') allowed = false;
  else if (change === 'cancelled') record.state = 'cancelled';
  else if (change === 'acceptance-removed') delete record.acceptance;
  else if (change === 'record-removed') current = undefined;
  else if (change === 'agreement-changed') record.manifest = { ...record.manifest!, sha256: 'f'.repeat(64) };
  else if (change === 'target-changed') record.acceptance = { ...record.acceptance!, target: { machine: peer, agentId: 'replacement' } };
  release();
  expect((await pending) instanceof Error).toBe(true);
  expect(read).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
});

it.each(['cancelled', 'grant-generation'] as const)('P6 real handoff path stat await: %s prevents the verification open', async (change) => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'binary-fence-')));
  fs.mkdirSync(path.join(root, 'files'));
  const bytes = Buffer.alloc(300000, 0x71);
  fs.writeFileSync(path.join(root, 'files', 'data.bin'), bytes);
  const hash = (body: Buffer | string) => createHash('sha256').update(body).digest('hex');
  const manifest: HandoffWorktreeManifest = { v: 1, repo: { branch: 'main', base: 'a'.repeat(40), remote: null }, include: { tracked_changes: true, untracked: true, ignored: [] }, exclude: [], files: [{ path: 'data.bin', size: bytes.length, mode: '100644', sha256: hash(bytes) }], deletions: [], total_bytes: bytes.length, manifest_sha256: '0'.repeat(64) };
  manifest.manifest_sha256 = hash(canonicalHandoffManifest(manifest));
  const machine = 'sender'; const peer = 'receiver'; const receiver = { machine: peer, agentId: 'a' };
  const record = { schemaVersion: 1, id: randomUUID(), from: { machine, agentId: 'a' }, to: receiver, mode: 'worktree', task: { title: 't', brief: 'b' }, manifest: summarizeHandoffManifest(manifest), state: 'accepted', acceptance: { by: receiver, target: receiver }, history: [], version: 2, createdAt: Date.now(), updatedAt: Date.now() } as Handoff;
  let current: Handoff | undefined = record;
  let generation = 0;
  source = new HandoffTransferSource({ machine, record: () => current, authorize: async () => {},
    authority: () => { const captured = generation; return { check: () => { if (generation !== captured) throw new Error('grant changed'); }, dispose: () => {} }; },
    prepared: async () => ({ snapshot: { root: root!, manifest }, source: { bounds: HANDOFF_TRANSFER_DEFAULTS } }),
  });
  const lstat = fs.promises.lstat.bind(fs.promises);
  let count = 0; let release!: () => void; let enter!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const entered = new Promise<void>((r) => { enter = r; });
  vi.spyOn(fs.promises, 'lstat').mockImplementation((async (...args: unknown[]) => {
    const result = await (lstat as (...args: unknown[]) => Promise<unknown>)(...args);
    // sourceStat(file), then inspect's own sourceStat(file), immediately before open.
    if (args[0] === path.join(root!, 'files', 'data.bin') && ++count === 2) { enter(); await gate; }
    return result;
  }) as any);
  const open = vi.spyOn(fs.promises, 'open');
  const pending = source.receive(peer, { op: 'read', id: record.id, file: 0, offset: 0 }).catch((e) => e);
  await entered;
  if (change === 'cancelled') record.state = 'cancelled'; else generation++;
  release();
  expect((await pending) instanceof Error).toBe(true); expect(open).not.toHaveBeenCalled();
});
