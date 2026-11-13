import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ dir: '', repo: '', receipt: vi.fn() }));
vi.mock('electron', () => ({ app: { getPath: () => state.dir } }));
vi.mock('./project-store', () => ({ peekProjects: async () => [{ id: 'sender', path: state.repo }, { id: 'receiver', path: state.repo }] }));
vi.mock('./actions', () => ({ actionsReady: () => true, recordExternalRun: state.receipt }));
vi.mock('../telemetry/persist', () => ({ persist: { recovery: vi.fn(), timed: (_area: string, work: () => Promise<void>) => work() } }));
import { HandoffSecretPolicy, setHandoffSecretSettings, _resetHandoffSecretSettingsForTesting } from './handoff-secret-settings';
import { withSettingsSurface } from './settings-audit';
import { checkHandoffSnapshot, prepareHandoffSnapshot, verifyHandoffSnapshot } from './handoff-snapshot';
const exec = promisify(execFile);
const token = `ghp_${'a'.repeat(36)}`;
const set = (project: string, names: string[]) => withSettingsSurface('ui', undefined, () => setHandoffSecretSettings(project, names));
let staging: string;
beforeEach(async () => {
  state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-security-')); state.repo = path.join(state.dir, 'repo'); staging = path.join(state.dir, 'stage');
  // Runner-wide filters (including Git LFS) intentionally make a repository unsupported.
  // Use regular files here because Git for Windows does not accept null devices.
  const config = path.join(state.dir, 'empty-git-config');
  fs.writeFileSync(config, '');
  vi.stubEnv('GIT_CONFIG_GLOBAL', config);
  vi.stubEnv('GIT_CONFIG_SYSTEM', config);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '0');
  fs.mkdirSync(state.repo); fs.mkdirSync(staging); _resetHandoffSecretSettingsForTesting(); state.receipt.mockReset().mockResolvedValue(undefined);
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Test'], ['config', 'user.email', 'test@example.invalid'], ['-c', `core.hooksPath=${path.join(state.dir, 'no-hooks')}`, 'commit', '--allow-empty', '-qm', 'Base']]) await exec('git', args, { cwd: state.repo });
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(state.dir, { recursive: true, force: true }); });
const options = () => ({ worktreeRoot: state.repo, stagingRoot: staging, handoffId: randomUUID() });
const summary = (manifest: Awaited<ReturnType<typeof prepareHandoffSnapshot>>['manifest']) => ({ fileCount: manifest.files.length + manifest.deletions.length, totalBytes: manifest.total_bytes, sha256: manifest.manifest_sha256 });
it('blocks before creating staging or sending bytes; reports only safe path, rule and line', async () => {
  fs.writeFileSync(path.join(state.repo, 'fixture.txt'), `safe\n${token}\n`);
  const preview = await checkHandoffSnapshot({ worktreeRoot: state.repo });
  expect(preview.ready).toBe(false); expect(preview.findings).toEqual([expect.objectContaining({ path: 'fixture.txt', line: 2 })]);
  expect(JSON.stringify(preview)).not.toContain(token);
  for (const finding of preview.findings) expect(Object.keys(finding).sort()).toEqual(['line', 'path', 'rule']);
  await expect(prepareHandoffSnapshot(options())).rejects.toMatchObject({ code: 'secret_blocked' }); expect(fs.readdirSync(staging)).toEqual([]);
});
it('runs receiver rules independently of sender exceptions, including a valid forged manifest', async () => {
  fs.writeFileSync(path.join(state.repo, 'fixture.txt'), token); await set('sender', ['fixture.txt']);
  const prepared = await prepareHandoffSnapshot({ ...options(), secretPolicy: await HandoffSecretPolicy.forProject('sender') });
  await expect(verifyHandoffSnapshot(prepared.root, prepared.manifest, summary(prepared.manifest))).rejects.toMatchObject({ code: 'secret_blocked' });
  await expect(verifyHandoffSnapshot(prepared.root, { ...prepared.manifest, notSecretPaths: ['fixture.txt'] }, summary(prepared.manifest))).rejects.toThrow();
  await expect(verifyHandoffSnapshot(prepared.root, prepared.manifest, summary(prepared.manifest), undefined, { policy: await HandoffSecretPolicy.forProject('receiver'), handoffId: randomUUID() })).rejects.toMatchObject({ code: 'secret_blocked' });
  await set('receiver', ['fixture.txt']);
  await expect(verifyHandoffSnapshot(prepared.root, prepared.manifest, summary(prepared.manifest), undefined, { policy: await HandoffSecretPolicy.forProject('receiver'), handoffId: randomUUID() })).resolves.toMatchObject({ manifest: prepared.manifest });
  expect(state.receipt.mock.calls.filter(([run]) => run.reason.startsWith('Handoff used'))).toHaveLength(2);
  expect(JSON.stringify(state.receipt.mock.calls)).not.toContain(token);
});
it('does not trust plain object policies from either boundary', async () => {
  const forged = { scan: () => [], assertCurrent: () => {}, usedPaths: () => [] } as unknown as HandoffSecretPolicy;
  fs.writeFileSync(path.join(state.repo, 'safe.txt'), 'safe');
  await expect(prepareHandoffSnapshot({ ...options(), secretPolicy: forged })).rejects.toMatchObject({ code: 'secret_blocked' });
  expect(fs.readdirSync(staging)).toEqual([]);
  const prepared = await prepareHandoffSnapshot(options());
  await expect(verifyHandoffSnapshot(prepared.root, prepared.manifest, summary(prepared.manifest), undefined, { policy: forged, handoffId: randomUUID() })).rejects.toMatchObject({ code: 'secret_blocked' });
});
it('cleans staged copies when an exception is revoked while its audit commits', async () => {
  fs.writeFileSync(path.join(state.repo, 'fixture.txt'), token); await set('sender', ['fixture.txt']);
  state.receipt.mockImplementationOnce(async () => { await set('sender', []); });
  await expect(prepareHandoffSnapshot({ ...options(), secretPolicy: await HandoffSecretPolicy.forProject('sender') })).rejects.toThrow();
  expect(fs.readdirSync(staging)).toEqual([]);
});
