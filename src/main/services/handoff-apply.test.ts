import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { createHash, randomUUID } from 'crypto';
import { afterAll, afterEach, beforeEach as rawBeforeEach, expect, it as rawIt, vi } from 'vitest';
import { CheckpointFixtureLifetime } from '../../../test/checkpoint-fixture-lifetime';
import { ownedRegistration } from '../../../test/dispatcher-work-owner';
import { HANDOFF_TRANSFER_DEFAULTS, canonicalHandoffManifest } from '../../shared/handoff-manifest';
import { prepareHandoffTransfer } from './handoff-transfer-preparation';
import { receiveHandoffCommit } from './handoff-git-receive';
import { applyHandoffSnapshot, handoffApplyPaths, recoverPendingHandoffApply } from './handoff-apply';
const lifetime = vi.hoisted(() => ({ current: undefined as CheckpointFixtureLifetime | undefined, directory: '' }));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const { ownCheckpointExecFile } = await import('../../../test/checkpoint-fixture-lifetime');
  return { ...actual, execFile: ownCheckpointExecFile(actual.execFile, () => lifetime.current) };
});
function owner(): CheckpointFixtureLifetime {
  if (!lifetime.current) throw new Error('Handoff fixture is missing');
  return lifetime.current;
}
const it = ownedRegistration(rawIt, 1, (promise) => { owner().observeRaw(promise); });
const beforeEach = ownedRegistration(rawBeforeEach, 0, (promise) => { owner().observeRaw(promise); });
const exec = promisify(execFile);
let root: string; let sender: string; let receiver: string; let staging: string;
const git = (cwd: string, ...args: string[]) => exec('git', args, { cwd });
const commit = async (cwd: string, title: string) => { await git(cwd, 'add', '-A'); await git(cwd, '-c', `core.hooksPath=${path.join(root, 'no-hooks')}`, 'commit', '-qm', title); };
async function initialize(repo: string, title: string) {
  fs.mkdirSync(repo); await git(repo, 'init', '-b', 'main'); await git(repo, 'config', 'user.name', 'Fixture'); await git(repo, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(repo, 'public.txt'), title); fs.writeFileSync(path.join(repo, 'removed.txt'), 'remove on receiver'); fs.writeFileSync(path.join(repo, '.gitignore'), 'fixtures/\n.clubhouse/\n'); await commit(repo, title);
  await git(repo, 'config', 'remote.origin.url', 'https://example.invalid/project.git');
}
beforeEach(async () => {
  lifetime.current?.assertRetired(); lifetime.current = new CheckpointFixtureLifetime();
  lifetime.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-apply-'));
  // Async realpath expands Windows DOS 8.3 aliases just as the production roots do.
  root = await fs.promises.realpath(lifetime.directory); sender = path.join(root, 'sender'); receiver = path.join(root, 'receiver'); staging = path.join(root, 'stage'); fs.mkdirSync(staging);
  const config = path.join(root, 'empty-config'); fs.writeFileSync(config, ''); vi.stubEnv('GIT_CONFIG_GLOBAL', config); vi.stubEnv('GIT_CONFIG_SYSTEM', config); vi.stubEnv('GIT_CONFIG_NOSYSTEM', '0');
  await initialize(sender, 'Sender base'); await initialize(receiver, 'Receiver original');
  await git(receiver, 'config', `url.${pathToFileURL(path.join(root, 'absent.git')).href}.insteadOf`, 'https://example.invalid/project.git');
});
afterEach(async () => {
  await owner().close(() => Promise.resolve(), () => {
    vi.unstubAllEnvs(); fs.rmSync(lifetime.directory, { recursive: true, force: true });
  });
});
afterAll(() => { lifetime.current?.assertRetired(); });
async function prepare(mode: 'branch' | 'worktree' = 'worktree') {
  const id = randomUUID(); const bounds = HANDOFF_TRANSFER_DEFAULTS;
  const snapshot = await prepareHandoffTransfer({ worktreeRoot: sender, stagingRoot: staging, handoffId: id, bounds, mode, include: { ignored: ['fixtures/*.bin'] } });
  await receiveHandoffCommit({ projectRoot: receiver, snapshot, bounds, handoffId: id, authorize: async () => {} });
  return { id, projectId: 'registered', projectRoot: receiver, snapshot, bounds, authorize: async () => {}, checkpoint: vi.fn(async () => {}) };
}
it('leaves dirty receiving work intact and publishes byte-exact changes on a fresh uncommitted branch', async () => {
  fs.writeFileSync(path.join(sender, 'public.txt'), 'final tracked bytes'); fs.rmSync(path.join(sender, 'removed.txt')); fs.writeFileSync(path.join(sender, 'new.txt'), 'untracked');
  fs.mkdirSync(path.join(sender, 'fixtures')); const large = Buffer.alloc(600 * 1024, 17); fs.writeFileSync(path.join(sender, 'fixtures', 'selected.bin'), large); fs.writeFileSync(path.join(sender, 'fixtures', 'unselected.dat'), 'excluded');
  fs.writeFileSync(path.join(receiver, 'public.txt'), 'person dirty work');
  const options = await prepare(); const oldHead = (await git(receiver, 'rev-parse', 'HEAD')).stdout.trim();
  const result = await applyHandoffSnapshot(options);
  expect(options.checkpoint).toHaveBeenCalledWith({ projectId: 'registered', worktree: result.worktree, branch: result.branch, stagingId: options.id });
  expect(fs.readFileSync(path.join(receiver, 'public.txt'), 'utf8')).toBe('person dirty work'); expect((await git(receiver, 'rev-parse', 'HEAD')).stdout.trim()).toBe(oldHead);
  expect(fs.readFileSync(path.join(result.worktree, 'public.txt'), 'utf8')).toBe('final tracked bytes'); expect(fs.existsSync(path.join(result.worktree, 'removed.txt'))).toBe(false);
  expect(fs.readFileSync(path.join(result.worktree, 'new.txt'), 'utf8')).toBe('untracked'); expect(fs.readFileSync(path.join(result.worktree, 'fixtures', 'selected.bin'))).toEqual(large);
  expect(fs.existsSync(path.join(result.worktree, 'fixtures', 'unselected.dat'))).toBe(false); expect((await git(result.worktree, 'rev-parse', 'HEAD')).stdout.trim()).toBe(options.snapshot.manifest.repo.base);
  expect((await git(result.worktree, 'status', '--porcelain')).stdout).toContain(' M public.txt'); expect(fs.existsSync(handoffApplyPaths(receiver, options.id).pending)).toBe(false);
}, 60_000);
it('applies branch mode at the exact commit without creating a commit of its own', async () => {
  const options = await prepare('branch'); const result = await applyHandoffSnapshot(options);
  expect((await git(result.worktree, 'rev-parse', 'HEAD')).stdout.trim()).toBe(options.snapshot.manifest.repo.base); expect((await git(result.worktree, 'status', '--porcelain')).stdout).toBe('');
}, 60_000);
it('rejects a combined base/overlay link escape before allocating a worktree', async () => {
  fs.mkdirSync(path.join(sender, 'dir')); fs.mkdirSync(path.join(sender, 'outside')); fs.writeFileSync(path.join(sender, 'outside', 'keep.txt'), 'inside');
  // Create the base link with a regular index payload; no platform symlink privilege is required.
  fs.writeFileSync(path.join(root, 'link-payload'), '../outside'); const oid = (await git(sender, 'hash-object', '-w', path.join(root, 'link-payload'))).stdout.trim();
  await git(sender, 'update-index', '--add', '--cacheinfo', `120000,${oid},dir/portal`); await git(sender, '-c', `core.hooksPath=${path.join(root, 'no-hooks')}`, 'commit', '-qm', 'Internal base link');
  await git(sender, 'config', 'core.symlinks', 'false'); fs.writeFileSync(path.join(sender, 'dir', 'portal'), '../outside');
  const options = await prepare(); const payload = 'dir/portal/../..'; fs.writeFileSync(path.join(options.snapshot.root, 'files', 'bridge'), payload);
  options.snapshot.manifest.files.push({ path: 'bridge', mode: '120000', size: Buffer.byteLength(payload), sha256: createHash('sha256').update(payload).digest('hex') }); options.snapshot.manifest.total_bytes += Buffer.byteLength(payload);
  options.snapshot.manifest.manifest_sha256 = createHash('sha256').update(canonicalHandoffManifest(options.snapshot.manifest)).digest('hex');
  await expect(applyHandoffSnapshot(options)).rejects.toMatchObject({ code: 'unsafe_entry' }); expect(options.checkpoint).not.toHaveBeenCalled();
  expect(fs.existsSync(handoffApplyPaths(receiver, options.id).worktree)).toBe(false);
}, 60_000);
it('cleans its own fresh worktree after authorization is revoked during copying', async () => {
  const options = await prepare(); const paths = handoffApplyPaths(receiver, options.id);
  options.authorize = async () => { if (fs.existsSync(path.join(paths.pending, 'public.txt'))) throw new Error('revoked'); };
  await expect(applyHandoffSnapshot(options)).rejects.toThrow();
  expect(fs.existsSync(paths.pending)).toBe(false); expect(fs.existsSync(paths.worktree)).toBe(false);
  await expect(git(receiver, 'show-ref', '--verify', `refs/heads/${paths.branch}`)).rejects.toThrow();
  expect(fs.readFileSync(path.join(receiver, 'public.txt'), 'utf8')).toBe('Receiver original');
}, 60_000);

it('removes only an unpublished checkpoint-owned worktree during crash recovery', async () => {
  const options = await prepare(); const paths = handoffApplyPaths(receiver, options.id); fs.mkdirSync(paths.parent, { recursive: true });
  await git(receiver, '-c', `core.hooksPath=${path.join(root, 'no-hooks')}`, 'worktree', 'add', '--no-checkout', '-b', paths.branch, '--', paths.pending, options.snapshot.manifest.repo.base);
  fs.writeFileSync(path.join(paths.pending, 'partial.txt'), 'partial apply');
  const checkpoint = { projectId: 'registered', stagingId: options.id, worktree: paths.worktree + path.sep, branch: paths.branch };
  // Equivalent native spelling is valid, but a different checkpoint must never remove it.
  await expect(recoverPendingHandoffApply(receiver, options.id, { ...checkpoint, worktree: paths.pending })).rejects.toMatchObject({ code: 'invalid_staging' });
  expect(fs.existsSync(paths.pending)).toBe(true);
  expect(await recoverPendingHandoffApply(receiver, options.id, checkpoint)).toBe('removed');
  expect(fs.existsSync(paths.pending)).toBe(false); await expect(git(receiver, 'show-ref', '--verify', `refs/heads/${paths.branch}`)).rejects.toThrow();
  expect(fs.readFileSync(path.join(receiver, 'public.txt'), 'utf8')).toBe('Receiver original');
}, 60_000);
it('preserves a fully published worktree when recovery cannot know whether its mission was delivered', async () => {
  const options = await prepare('branch'); const result = await applyHandoffSnapshot(options);
  expect(await recoverPendingHandoffApply(receiver, options.id, { projectId: 'registered', stagingId: options.id, worktree: result.worktree, branch: result.branch })).toBe('published');
  expect((await git(result.worktree, 'rev-parse', 'HEAD')).stdout.trim()).toBe(result.commit);
}, 60_000);
