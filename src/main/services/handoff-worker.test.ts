import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { parseHandoff, transitionHandoff, type Handoff } from '../../shared/handoffs';
import { HANDOFF_TRANSFER_DEFAULTS, type HandoffWorktreeManifest } from '../../shared/handoff-manifest';
import { HandoffWorker, HandoffProjectUnavailable, type HandoffWorkerOptions } from './handoff-worker';
import { HandoffSnapshotError } from './handoff-snapshot';
import { HandoffTransferInterrupted } from './handoff-transfer-receiver';
let root: string;
const machine = Array(16).fill('ab').join(':'); const sender = { machine: Array(16).fill('cd').join(':'), agentId: 'sender' }; const target = { machine, agentId: 'receiver' };
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-worker-'))); });
afterEach(() => { vi.useRealTimers(); fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const at = Date.now(); const id = randomUUID();
  let record: Handoff = parseHandoff({ schemaVersion: 1, id, from: sender, to: target, task: { title: 'Continue', brief: 'Do the task' }, mode: 'worktree', manifest: { fileCount: 1, totalBytes: 3, sha256: 'b'.repeat(64) },
    state: 'offered', version: 1, createdAt: at, updatedAt: at, history: [{ state: 'offered', operationId: randomUUID(), at, by: { kind: 'agent', address: sender } }] });
  record = transitionHandoff(record, { state: 'accepted', target, operationId: randomUUID(), at, by: { kind: 'agent', address: target } }, record.version);
  const manifest: HandoffWorktreeManifest = { v: 1, repo: { remote: null, branch: 'main', base: 'a'.repeat(40) }, include: { tracked_changes: true, untracked: true, ignored: [] }, exclude: [],
    files: [{ path: 'work.txt', mode: '100644', size: 3, sha256: 'c'.repeat(64) }], deletions: [], total_bytes: 3, manifest_sha256: 'b'.repeat(64) };
  const order: string[] = [];
  const options: HandoffWorkerOptions = {
    machine, records: () => [record],
    advance: vi.fn(async (current, update) => { record = transitionHandoff(record, { ...update, operationId: randomUUID(), at: Math.max(at, Date.now()), by: { kind: 'machine', machine } }, current.version); order.push(record.state); return record; }),
    authorize: vi.fn(async () => {}), sync: vi.fn(async () => {}), resolve: vi.fn(async () => ({ projectId: 'registered', projectRoot: root, bounds: HANDOFF_TRANSFER_DEFAULTS })),
    stagingRoot: async () => root, request: vi.fn(async () => ({})),
    receive: vi.fn(async (input) => { await input.progress?.(3, 3); return { root: path.join(root, id), manifest }; }),
    acquire: vi.fn(async () => { order.push('scan-history'); return { commit: manifest.repo.base, source: 'bundle' }; }),
    apply: vi.fn(async (input) => { await input.checkpoint({ projectId: 'registered', worktree: path.join(root, 'fresh-worktree'), branch: 'handoff/test', stagingId: id }); order.push('move-complete-tree'); return { worktree: path.join(root, 'fresh-worktree'), branch: 'handoff/test', commit: manifest.repo.base }; }),
    wake: vi.fn(async (_record, _result, admission) => { expect(admission()).toBe(true); order.push('wake'); }),
  };
  const worker = new HandoffWorker(options);
  return { worker, options, id, manifest, order, current: () => record };
}
it('automatically transfers, independently verifies, stages, wakes and records the applied result', async () => {
  const f = fixture(); await f.worker.run(f.id);
  expect(f.current()).toMatchObject({ state: 'applied', result: { agent: target, branch: 'handoff/test', commit: f.manifest.repo.base } });
  expect(f.order).toEqual(['transferring', 'transferring', 'verifying', 'scan-history', 'applying', 'move-complete-tree', 'wake', 'applied']);
  expect(f.options.sync).toHaveBeenCalledWith(f.id); expect(f.options.wake).toHaveBeenCalledTimes(1);
});
it('does not apply or wake after a receiver-side hash or secret failure', async () => {
  const f = fixture(); vi.mocked(f.options.receive!).mockRejectedValue(new HandoffSnapshotError('secret_blocked', 'fixture.txt'));
  await f.worker.run(f.id);
  expect(f.current()).toMatchObject({ state: 'failed', failure: { step: 'verification', code: 'verification_failed' } });
  expect(f.options.apply).not.toHaveBeenCalled(); expect(f.options.wake).not.toHaveBeenCalled();
  expect(f.current().history.at(-1)?.reason).toContain('fixture.txt');
});
it('fails clearly when no registered project matches, without applying or waking', async () => {
  const f = fixture(); vi.mocked(f.options.resolve).mockRejectedValue(new HandoffProjectUnavailable()); await f.worker.run(f.id);
  expect(f.current()).toMatchObject({ state: 'failed', failure: { step: 'apply', code: 'apply_failed' } });
  expect(f.current().history.at(-1)?.reason).toContain('No matching registered project');
  expect(f.options.receive).not.toHaveBeenCalled(); expect(f.options.wake).not.toHaveBeenCalled();
});
it('retains interrupted receiving data and retries without requiring a new acceptance', async () => {
  const f = fixture(); const receive = f.options.receive!;
  // Canonical native paths can differ in spelling (including Windows drive case).
  f.options.stagingRoot = async () => root + path.sep;
  vi.mocked(receive).mockImplementationOnce(async () => { fs.mkdirSync(path.join(root, f.id)); fs.writeFileSync(path.join(root, f.id, 'partial'), 'saved'); throw new HandoffTransferInterrupted(); });
  await f.worker.run(f.id); expect(f.current().state).toBe('transferring'); expect(fs.existsSync(path.join(root, f.id, 'partial'))).toBe(true);
  await f.worker.run(f.id); expect(f.current().state).toBe('applied'); expect(fs.existsSync(path.join(root, f.id))).toBe(false);
  expect(f.options.wake).toHaveBeenCalledTimes(1);
});
it('expires a stuck resolver and prevents its late continuation from applying or waking', async () => {
  vi.useFakeTimers(); const f = fixture(); f.options.timeoutMs = 50;
  let release!: (value: Awaited<ReturnType<HandoffWorkerOptions['resolve']>>) => void;
  vi.mocked(f.options.resolve).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  const pending = f.worker.run(f.id); await vi.advanceTimersByTimeAsync(51); await pending;
  expect(f.current().state).toBe('failed');
  release({ projectId: 'registered', projectRoot: root, bounds: HANDOFF_TRANSFER_DEFAULTS }); await vi.advanceTimersByTimeAsync(0);
  expect(f.options.apply).not.toHaveBeenCalled(); expect(f.options.wake).not.toHaveBeenCalled();
});
