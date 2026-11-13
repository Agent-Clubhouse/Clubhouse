import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { createHash, randomUUID } from 'crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HANDOFF_TRANSFER_DEFAULTS, canonicalHandoffManifest } from '../../shared/handoff-manifest';
import { prepareHandoffSnapshot } from './handoff-snapshot';
import { prepareHandoffBundle } from './handoff-git-bundle';
import { receiveHandoffCommit } from './handoff-git-receive';
const exec = promisify(execFile);
let root: string; let sender: string; let receiver: string; let staging: string;
const url = 'https://example.invalid/team/project.git';
const git = (cwd: string, ...args: string[]) => exec('git', args, { cwd });
async function initialize(repo: string, message: string) {
  fs.mkdirSync(repo); await git(repo, 'init', '-b', 'main'); await git(repo, 'config', 'user.name', 'Fixture'); await git(repo, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(repo, 'public.txt'), message); await git(repo, 'add', '.'); await git(repo, '-c', `core.hooksPath=${path.join(root, 'no-hooks')}`, 'commit', '-qm', message);
  await git(repo, 'config', 'remote.origin.url', url);
}
beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-commit-'))); sender = path.join(root, 'sender'); receiver = path.join(root, 'receiver'); staging = path.join(root, 'stage'); fs.mkdirSync(staging);
  const config = path.join(root, 'empty-config'); fs.writeFileSync(config, ''); vi.stubEnv('GIT_CONFIG_GLOBAL', config); vi.stubEnv('GIT_CONFIG_SYSTEM', config); vi.stubEnv('GIT_CONFIG_NOSYSTEM', '0');
  await initialize(sender, 'Sender base'); await initialize(receiver, 'Receiver original');
  // An absent file remote fails locally and deterministically; no test reaches the internet.
  await git(receiver, 'config', `url.${pathToFileURL(path.join(root, 'absent.git')).href}.insteadOf`, url);
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });
async function prepared() {
  const handoffId = randomUUID(); const snapshot = await prepareHandoffSnapshot({ worktreeRoot: sender, stagingRoot: staging, handoffId });
  return { projectRoot: receiver, snapshot: await prepareHandoffBundle({ worktreeRoot: sender, snapshot, handoffId, bounds: HANDOFF_TRANSFER_DEFAULTS }), handoffId, bounds: HANDOFF_TRANSFER_DEFAULTS, authorize: async () => {} };
}
it('prefers a configured shared remote and arrives at the exact commit without changing the receiving worktree', async () => {
  const remote = path.join(root, 'remote.git'); await git(root, 'clone', '--bare', sender, remote);
  await git(receiver, 'config', '--unset-all', `url.${pathToFileURL(path.join(root, 'absent.git')).href}.insteadOf`);
  await git(receiver, 'config', `url.${pathToFileURL(remote).href}.insteadOf`, url);
  const options = await prepared(); const before = (await git(receiver, 'rev-parse', 'HEAD')).stdout.trim();
  expect(await receiveHandoffCommit(options)).toEqual({ commit: options.snapshot.manifest.repo.base, source: 'remote' });
  expect((await git(receiver, 'cat-file', '-t', options.snapshot.manifest.repo.base)).stdout.trim()).toBe('commit');
  expect((await git(receiver, 'rev-parse', 'HEAD')).stdout.trim()).toBe(before);
  expect(fs.readFileSync(path.join(receiver, 'public.txt'), 'utf8')).toBe('Receiver original');
}, 30_000);
it('falls back to an independently scanned bundle when the configured remote lacks the commit', async () => {
  const options = await prepared(); const before = (await git(receiver, 'rev-parse', 'HEAD')).stdout.trim();
  expect(await receiveHandoffCommit(options)).toEqual({ commit: options.snapshot.manifest.repo.base, source: 'bundle' });
  expect((await git(receiver, 'rev-parse', 'HEAD')).stdout.trim()).toBe(before);
  expect(fs.readdirSync(options.snapshot.root).some((name) => name.startsWith('quarantine-'))).toBe(false);
}, 30_000);
it('rejects hash-valid secret-bearing bundle history before importing it into the registered repository', async () => {
  const token = `ghp_${'a'.repeat(36)}`; fs.writeFileSync(path.join(sender, 'retired.txt'), token);
  await git(sender, 'add', '.'); await git(sender, '-c', `core.hooksPath=${path.join(root, 'no-hooks')}`, 'commit', '-qm', 'Malicious peer history');
  const handoffId = randomUUID(); const snapshot = await prepareHandoffSnapshot({ worktreeRoot: sender, stagingRoot: staging, handoffId });
  const bundle = path.join(snapshot.root, 'bundle.bin'); await git(sender, 'bundle', 'create', bundle, 'HEAD'); const bytes = fs.readFileSync(bundle);
  snapshot.manifest.bundle = { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; snapshot.manifest.total_bytes += bytes.length;
  snapshot.manifest.manifest_sha256 = createHash('sha256').update(canonicalHandoffManifest(snapshot.manifest)).digest('hex');
  await expect(receiveHandoffCommit({ projectRoot: receiver, snapshot, handoffId, bounds: HANDOFF_TRANSFER_DEFAULTS, authorize: async () => {} })).rejects.toMatchObject({ code: 'secret_blocked' });
  await expect(git(receiver, 'cat-file', '-e', `${snapshot.manifest.repo.base}^{commit}`)).rejects.toThrow();
  expect(fs.readFileSync(path.join(receiver, 'public.txt'), 'utf8')).toBe('Receiver original');
  expect(fs.readdirSync(snapshot.root).some((name) => name.startsWith('quarantine-'))).toBe(false);
}, 30_000);
it('refuses a different registered repository without creating any worktree or importing objects', async () => {
  const options = await prepared(); await git(receiver, 'config', 'remote.origin.url', 'https://example.invalid/team/other.git');
  await expect(receiveHandoffCommit(options)).rejects.toThrow('No matching registered project');
  await expect(git(receiver, 'cat-file', '-e', `${options.snapshot.manifest.repo.base}^{commit}`)).rejects.toThrow();
}, 30_000);
