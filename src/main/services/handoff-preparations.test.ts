import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ dir: '', repo: '', project: 'registered' }));
vi.mock('electron', () => ({ app: { getPath: () => state.dir } }));
vi.mock('./handoff-preflight-host', () => ({ callerHandoffSource: async () => ({ project: { id: state.project, path: state.repo }, worktreeRoot: state.repo, bounds: { totalBytes: 1024 ** 3, perFileBytes: 256 * 1024 ** 2, maxFiles: 10000 } }) }));
import { parseHandoff, transitionHandoff, type HandoffManifestSummary } from '../../shared/handoffs';
import { prepareCallerHandoff, ensurePreparedHandoff, bindPreparedHandoff, settleHandoffPreparationBinding, preparedSourceForRecord, pruneHandoffPreparations, _resetHandoffPreparationsForTesting } from './handoff-preparations';
const exec = promisify(execFile);
const from = { machine: Array(16).fill('ab').join(':'), agentId: 'owner' };
const to = { machine: Array(16).fill('cd').join(':'), agentId: 'receiver' };
function agreement(manifest: HandoffManifestSummary) {
  const at = Date.now();
  return parseHandoff({ schemaVersion: 1, id: randomUUID(), createdAt: at, updatedAt: at, version: 1, from, to, task: { title: 'Task', brief: 'Continue' }, mode: 'worktree', manifest,
    state: 'offered', history: [{ state: 'offered', operationId: randomUUID(), at, by: { kind: 'agent', address: from } }] });
}
beforeEach(async () => {
  state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-preparations-')); state.repo = path.join(state.dir, 'repo'); state.project = 'registered'; fs.mkdirSync(state.repo); _resetHandoffPreparationsForTesting();
  const config = path.join(state.dir, 'empty-git-config'); fs.writeFileSync(config, '');
  vi.stubEnv('GIT_CONFIG_GLOBAL', config); vi.stubEnv('GIT_CONFIG_SYSTEM', config); vi.stubEnv('GIT_CONFIG_NOSYSTEM', '0');
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'test@example.invalid'], ['-c', `core.hooksPath=${path.join(state.dir, 'no-hooks')}`, 'commit', '--allow-empty', '-qm', 'Base']]) await exec('git', args, { cwd: state.repo });
  fs.writeFileSync(path.join(state.repo, 'work.txt'), 'handoff bytes');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(state.dir, { recursive: true, force: true }); });
it('binds only an owned preparation, survives restart and refuses another agreement or project', async () => {
  const preview = await prepareCallerHandoff('owner', 'worktree');
  expect(preview.ready).toBe(true); expect(preview.manifest.files).toMatchObject([{ path: 'work.txt' }]);
  expect(await ensurePreparedHandoff('owner', 'worktree', { sha256: preview.summary.sha256, totalBytes: preview.summary.totalBytes, fileCount: preview.summary.fileCount })).toEqual(preview.summary);
  await expect(ensurePreparedHandoff('other', 'worktree', preview.summary)).rejects.toThrow('Prepare');
  const record = agreement(preview.summary); await bindPreparedHandoff(record); settleHandoffPreparationBinding(record.id); _resetHandoffPreparationsForTesting();
  expect((await preparedSourceForRecord(record)).snapshot.manifest).toEqual(preview.manifest);
  await expect(preparedSourceForRecord({ ...record, id: randomUUID() })).rejects.toThrow('unavailable');
  state.project = 'different'; await expect(preparedSourceForRecord(record)).rejects.toThrow('unavailable');
}, 30_000);
it('prunes declined/cancelled source staging immediately and leaves other preparations intact', async () => {
  const preview = await prepareCallerHandoff('owner', 'worktree'); const record = agreement(preview.summary); await bindPreparedHandoff(record); settleHandoffPreparationBinding(record.id);
  const original = await preparedSourceForRecord(record);
  const other = await prepareCallerHandoff('other', 'worktree');
  const terminal = transitionHandoff(record, { state: 'cancelled', operationId: randomUUID(), at: Date.now(), by: { kind: 'agent', address: from } }, record.version);
  await pruneHandoffPreparations([terminal]); expect(fs.existsSync(original.snapshot.root)).toBe(false);
  expect(await ensurePreparedHandoff('other', 'worktree', other.summary)).toEqual(other.summary);
}, 30_000);
it('retains an in-flight binding before visibility, then expires the orphan after a restart', async () => {
  const preview = await prepareCallerHandoff('owner', 'worktree'); const record = agreement(preview.summary); await bindPreparedHandoff(record);
  const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 16 * 60_000);
  await pruneHandoffPreparations([]); expect((await preparedSourceForRecord(record)).snapshot.manifest).toEqual(preview.manifest);
  _resetHandoffPreparationsForTesting(); await pruneHandoffPreparations([]);
  await expect(preparedSourceForRecord(record)).rejects.toThrow('unavailable');
}, 30_000);
it('does not publish or retain file bytes after a failed catalog save', async () => {
  const rename = fs.promises.rename;
  vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
    if (String(to).endsWith('handoff-preparations.json')) throw new Error('disk failed');
    return rename(from, to);
  });
  await expect(prepareCallerHandoff('owner', 'worktree')).rejects.toThrow();
  expect(fs.readdirSync(path.join(state.dir, 'handoff-data', 'prepared'))).toEqual([]);
}, 30_000);
