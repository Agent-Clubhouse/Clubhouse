import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HANDOFF_TRANSFER_DEFAULTS, summarizeHandoffManifest } from '../../shared/handoff-manifest';
import { prepareHandoffSnapshot, verifyHandoffSnapshot, openHandoffSnapshotArtifact } from './handoff-snapshot';
import { prepareHandoffBundle } from './handoff-git-bundle';
import { prepareHandoffTransfer } from './handoff-transfer-preparation';

const exec = promisify(execFile);
let root: string; let repo: string; let staging: string;
const git = (...args: string[]) => exec('git', args, { cwd: repo });
const commit = async (message = 'Fixture') => { await git('add', '-A'); await git('-c', `core.hooksPath=${path.join(root, 'no-hooks')}`, 'commit', '-qm', message); };
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-bundle-')); repo = path.join(root, 'repo'); staging = path.join(root, 'staging');
  const config = path.join(root, 'empty-git-config'); fs.writeFileSync(config, '');
  vi.stubEnv('GIT_CONFIG_GLOBAL', config); vi.stubEnv('GIT_CONFIG_SYSTEM', config); vi.stubEnv('GIT_CONFIG_NOSYSTEM', '0');
  fs.mkdirSync(repo); fs.mkdirSync(staging);
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(repo, 'file.txt'), 'committed bytes'); await commit();
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });
async function prepared() {
  const handoffId = randomUUID();
  const snapshot = await prepareHandoffSnapshot({ worktreeRoot: repo, stagingRoot: staging, handoffId });
  return { snapshot, handoffId, worktreeRoot: repo, bounds: HANDOFF_TRANSFER_DEFAULTS };
}
it('transports an exact commit and ancestry through a hash-bound bundle', async () => {
  fs.writeFileSync(path.join(repo, 'file.txt'), 'second committed bytes'); await commit('Second');
  const snapshot = await prepareHandoffBundle(await prepared());
  expect(snapshot.manifest.bundle!.size).toBeGreaterThan(0);
  expect(snapshot.manifest.files).toEqual([]);
  expect(await verifyHandoffSnapshot(snapshot.root, snapshot.manifest, summarizeHandoffManifest(snapshot.manifest))).toEqual(snapshot);
  const clone = path.join(root, 'receiver.git');
  await exec('git', ['clone', '--bare', path.join(snapshot.root, 'bundle.bin'), clone]);
  expect((await exec('git', ['rev-parse', 'HEAD'], { cwd: clone })).stdout.trim()).toBe(snapshot.manifest.repo.base);
  expect((await exec('git', ['show', 'HEAD:file.txt'], { cwd: clone })).stdout).toBe('second committed bytes');
  expect((await exec('git', ['rev-list', '--count', 'HEAD'], { cwd: clone })).stdout.trim()).toBe('2');
}, 30_000);
it.each(['content', 'historical-name', 'message'])('blocks %s history before creating any bundle bytes', async (cause) => {
  const token = `ghp_${'a'.repeat(36)}`;
  if (cause === 'content') { fs.writeFileSync(path.join(repo, 'retired.txt'), token); await commit(); fs.rmSync(path.join(repo, 'retired.txt')); await commit('Removed'); }
  if (cause === 'historical-name') { fs.writeFileSync(path.join(repo, '.env'), 'dummy fixture'); await commit(); await git('mv', '.env', 'public.txt'); await commit('Renamed'); }
  if (cause === 'message') { fs.writeFileSync(path.join(repo, 'file.txt'), 'changed'); await commit(token); }
  const options = await prepared();
  let failure: unknown;
  try { await prepareHandoffBundle(options); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ code: 'secret_blocked' }); expect(JSON.stringify(failure)).not.toContain(token);
  expect(fs.readdirSync(options.snapshot.root).sort()).toEqual(['files', 'manifest.json']);
}, 30_000);
it('enforces the artifact ceiling and removes temporary bundle bytes on failure', async () => {
  const options = await prepared();
  await expect(prepareHandoffBundle({ ...options, bounds: { totalBytes: 1024, perFileBytes: 32, maxFiles: 10 } })).rejects.toMatchObject({ code: 'bounds_exceeded' });
  expect(fs.readdirSync(options.snapshot.root).sort()).toEqual(['files', 'manifest.json']);
}, 30_000);
it('never replaces or follows a planted bundle destination', async () => {
  const options = await prepared(); const outside = path.join(root, 'outside.txt'); fs.writeFileSync(outside, 'keep');
  fs.symlinkSync(outside, path.join(options.snapshot.root, 'bundle.bin'));
  await expect(prepareHandoffBundle(options)).rejects.toThrow();
  expect(fs.readFileSync(outside, 'utf8')).toBe('keep');
}, 30_000);

it('refuses dirty branch mode before staging and suggests worktree behavior through its typed code', async () => {
  fs.writeFileSync(path.join(repo, 'file.txt'), 'dirty');
  await expect(prepareHandoffTransfer({ worktreeRoot: repo, stagingRoot: staging, handoffId: randomUUID(), mode: 'branch' })).rejects.toMatchObject({ code: 'uncommitted_branch' });
  expect(fs.readdirSync(staging)).toEqual([]);
  const snapshot = await prepareHandoffTransfer({ worktreeRoot: repo, stagingRoot: staging, handoffId: randomUUID(), mode: 'worktree' });
  expect(snapshot.manifest.files).toMatchObject([{ path: 'file.txt', size: 5 }]);
  expect(await verifyHandoffSnapshot(snapshot.root, snapshot.manifest, summarizeHandoffManifest(snapshot.manifest))).toEqual(snapshot);
}, 30_000);
it('prepares clean branch mode at its exact commit without copying ignored cache files', async () => {
  fs.writeFileSync(path.join(repo, '.gitignore'), 'cache/\n'); await commit('Ignore cache');
  fs.mkdirSync(path.join(repo, 'cache')); fs.writeFileSync(path.join(repo, 'cache', 'ignored.txt'), 'ignored');
  const snapshot = await prepareHandoffTransfer({ worktreeRoot: repo, stagingRoot: staging, handoffId: randomUUID(), mode: 'branch' });
  expect(snapshot.manifest.files).toEqual([]); expect(snapshot.manifest.bundle).toBeDefined();
  expect(snapshot.manifest.repo.base).toBe((await git('rev-parse', 'HEAD')).stdout.trim());
}, 30_000);

it('blocks credential values embedded in a current file name without returning that value', async () => {
  const token = `ghp_${'a'.repeat(36)}`;
  fs.writeFileSync(path.join(repo, `${token}.txt`), 'safe file bytes');
  let failure: unknown;
  try { await prepareHandoffTransfer({ worktreeRoot: repo, stagingRoot: staging, handoffId: randomUUID(), mode: 'worktree' }); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ code: 'secret_blocked' }); expect(JSON.stringify(failure)).not.toContain(token);
  expect(fs.readdirSync(staging)).toEqual([]);
}, 30_000);

it('allows historical package configuration without authentication', async () => {
  fs.writeFileSync(path.join(repo, '.npmrc'), 'registry=https://registry.npmjs.org/\nsave-exact=true\n'); await commit('Registry settings');
  const snapshot = await prepareHandoffBundle(await prepared());
  expect(snapshot.manifest.bundle).toBeDefined();
}, 30_000);

it('reads a large prepared file by resumable offset, refusing mutation and revocation before returning another chunk', async () => {
  const bytes = Buffer.alloc(768 * 1024, 42); fs.writeFileSync(path.join(repo, 'large.bin'), bytes);
  const options = await prepared(); let allowed = true;
  const artifact = await openHandoffSnapshotArtifact({ snapshot: options.snapshot, file: 0, handoffId: options.handoffId,
    authorize: async () => { if (!allowed) throw new Error('revoked'); } });
  try {
    expect(await artifact.read(0)).toEqual(bytes.subarray(0, 256 * 1024));
    expect(await artifact.read(300 * 1024, 128 * 1024)).toEqual(bytes.subarray(300 * 1024, 428 * 1024));
    allowed = false; await expect(artifact.read(256 * 1024)).rejects.toThrow(); allowed = true;
    fs.writeFileSync(path.join(options.snapshot.root, 'files', 'large.bin'), Buffer.alloc(bytes.length, 43));
    await expect(artifact.read(256 * 1024)).rejects.toMatchObject({ code: 'source_changed' });
  } finally { await artifact.close(); }
}, 30_000);
it('refuses a replacement source path and forged offsets without following the replacement', async () => {
  fs.writeFileSync(path.join(repo, 'changed.txt'), 'original'); const options = await prepared();
  const artifact = await openHandoffSnapshotArtifact({ snapshot: options.snapshot, file: 0, handoffId: options.handoffId, authorize: async () => {} });
  try {
    await expect(artifact.read(-1)).rejects.toMatchObject({ code: 'unsafe_entry' });
    await expect(artifact.read(0, 256 * 1024 + 1)).rejects.toMatchObject({ code: 'unsafe_entry' });
    const staged = path.join(options.snapshot.root, 'files', 'changed.txt'); fs.rmSync(staged); fs.symlinkSync(path.join(repo, 'file.txt'), staged);
    await expect(artifact.read(0)).rejects.toMatchObject({ code: 'source_changed' });
  } finally { await artifact.close(); }
}, 30_000);

it('keeps a relative dangling link inside the worktree but refuses an existing outside ancestor', async () => {
  fs.symlinkSync('missing.txt', path.join(repo, 'link.txt'));
  const safe = await prepared(); expect(safe.snapshot.manifest.files).toMatchObject([{ path: 'link.txt', mode: '120000' }]);
  fs.rmSync(path.join(repo, 'link.txt')); fs.mkdirSync(path.join(root, 'outside'));
  fs.symlinkSync('../outside', path.join(repo, 'outside-link'));
  fs.symlinkSync('outside-link/../missing', path.join(repo, 'link.txt'));
  await expect(prepareHandoffSnapshot({ worktreeRoot: repo, stagingRoot: staging, handoffId: randomUUID(), exclude: ['outside-link'] })).rejects.toMatchObject({ code: 'unsafe_entry' });
}, 30_000);
