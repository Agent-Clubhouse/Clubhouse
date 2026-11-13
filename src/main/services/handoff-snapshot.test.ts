import { execFile } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { EventEmitter } from 'events';
import { afterAll, afterEach, beforeEach as rawBeforeEach, describe, expect, it as rawIt, vi } from 'vitest';
import { canonicalHandoffManifest, HANDOFF_TRANSFER_DEFAULTS, type HandoffWorktreeManifest } from '../../shared/handoff-manifest';
import { prepareHandoffSnapshot, verifyHandoffSnapshot, type HandoffSnapshot, type PrepareHandoffSnapshot } from './handoff-snapshot';
import { CheckpointFixtureLifetime, ownCheckpointExecFile } from '../../../test/checkpoint-fixture-lifetime';
import { ownedRegistration, preservingFailure } from '../../../test/dispatcher-work-owner';

const lifetime = vi.hoisted(() => ({ current: undefined as CheckpointFixtureLifetime | undefined }));
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
const hash = (content: Uint8Array | string) => createHash('sha256').update(content).digest('hex');
const summary = (manifest: HandoffWorktreeManifest) => ({
  fileCount: manifest.files.length + manifest.deletions.length, totalBytes: manifest.total_bytes, sha256: manifest.manifest_sha256,
});
let root: string;
let repo: string;
let staging: string;

async function git(...args: string[]): Promise<void> {
  await exec('git', args, { cwd: repo });
}

async function file(name: string, value: string | Uint8Array): Promise<void> {
  await fs.promises.mkdir(path.dirname(path.join(repo, name)), { recursive: true });
  await fs.promises.writeFile(path.join(repo, name), value);
}

function options(overrides: Partial<PrepareHandoffSnapshot> = {}): PrepareHandoffSnapshot {
  return { worktreeRoot: repo, stagingRoot: staging, handoffId: randomUUID(), ...overrides };
}

function rehash(manifest: HandoffWorktreeManifest): HandoffWorktreeManifest {
  return { ...manifest, manifest_sha256: hash(canonicalHandoffManifest(manifest)) };
}

async function replacementFixture(): Promise<{ base: string; replacement: string }> {
  const base = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
  await file('tracked.txt', 'changed final bytes\n');
  await git('add', 'tracked.txt');
  await git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Replacement fixture');
  const replacement = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
  await git('update-ref', 'refs/heads/main', base);
  return { base, replacement };
}

async function executableTrackedBase(): Promise<void> {
  await git('update-index', '--chmod=+x', '--', 'tracked.txt');
  await git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Executable base');
  await git('config', 'core.filemode', 'false');
  await fs.promises.chmod(path.join(repo, 'tracked.txt'), 0o644);
  expect((await exec('git', ['ls-tree', 'HEAD', 'tracked.txt'], { cwd: repo })).stdout.startsWith('100755 ')).toBe(true);
  expect((await exec('git', ['ls-files', '--stage', '--', 'tracked.txt'], { cwd: repo })).stdout.startsWith('100755 ')).toBe(true);
  expect((await fs.promises.stat(path.join(repo, 'tracked.txt'))).mode & 0o100).toBe(0);
}

async function unsupportedTrackedBase(mode: string): Promise<void> {
  const oid = (await exec('git', ['rev-parse', mode === '120000' ? 'HEAD:tracked.txt' : 'HEAD'], { cwd: repo })).stdout.trim();
  await file('unsupported.txt', 'base\n');
  await git('update-index', '--add', '--cacheinfo', `${mode},${oid},unsupported.txt`);
  await git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Unsupported tracked fixture');
  await git('config', 'core.filemode', 'false');
  expect((await exec('git', ['ls-tree', 'HEAD', 'unsupported.txt'], { cwd: repo })).stdout.startsWith(`${mode} `)).toBe(true);
}

beforeEach(async () => {
  lifetime.current?.assertRetired();
  lifetime.current = new CheckpointFixtureLifetime();
  root = await fs.promises.realpath(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-snapshot-')));
  // Isolate supported fixtures with regular config files; Git for Windows rejects null devices.
  const config = path.join(root, 'empty-git-config');
  await fs.promises.writeFile(config, '');
  vi.stubEnv('GIT_CONFIG_GLOBAL', config);
  vi.stubEnv('GIT_CONFIG_SYSTEM', config);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '0');
  repo = path.join(root, 'repo');
  staging = path.join(root, 'staging');
  await fs.promises.mkdir(repo);
  await fs.promises.mkdir(staging);
});

async function initializeRepository(files: Record<string, string>, format?: 'sha256'): Promise<void> {
  await git('init', '-q', '-b', 'main', ...(format ? [`--object-format=${format}`] : []));
  await git('config', 'user.name', 'Fixture');
  await git('config', 'user.email', 'fixture@example.com');
  for (const [name, content] of Object.entries(files)) await file(name, content);
  await git('add', '.');
  await git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Fixture base');
}

const initializeStandardRepository = () => initializeRepository({
  '.gitignore': 'models/\nignored-unselected.txt\nnode_modules/\n', 'tracked.txt': 'base\n', 'deleted.txt': 'delete me\n',
});

afterEach(async () => {
  const capturedRoot = root;
  await owner().close(() => Promise.resolve(), () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(capturedRoot, { recursive: true, force: true });
  });
});
afterAll(() => { lifetime.current?.assertRetired(); });

describe('local secret-safe handoff snapshots', () => {
  beforeEach(initializeStandardRepository);
  it.each(['loose', 'packed'])('refuses %s replacement refs without binding their tree to the original base', async (storage) => {
    const { base, replacement } = await replacementFixture();
    await git('replace', base, replacement);
    if (storage === 'packed') {
      await git('pack-refs', '--all');
      expect((await fs.promises.readFile(path.join(repo, '.git/packed-refs'), 'utf8'))).toContain(`refs/replace/${base}`);
      expect(fs.existsSync(path.join(repo, '.git/refs/replace', base))).toBe(false);
    }
    expect((await exec('git', ['--no-replace-objects', 'show', `${base}:tracked.txt`], { cwd: repo })).stdout).toBe('base\n');
    expect((await exec('git', ['show', `${base}:tracked.txt`], { cwd: repo })).stdout).toBe('changed final bytes\n');
    const index = await fs.promises.readFile(path.join(repo, '.git/index'));
    await expect(prepareHandoffSnapshot(options())).rejects.toMatchObject({ code: 'unsupported_repository', cleanupFailed: false });
    expect(await fs.promises.readFile(path.join(repo, '.git/index'))).toEqual(index);
    expect(await fs.promises.readdir(staging)).toEqual([]);
    expect(await fs.promises.readFile(path.join(repo, 'tracked.txt'), 'utf8')).toBe('changed final bytes\n');
  });

  it('refuses replacement refs appearing after preflight instead of changing the advertised base interpretation', async () => {
    const { base, replacement } = await replacementFixture();
    const lstat = fs.promises.lstat;
    let installed = false;
    vi.spyOn(fs.promises, 'lstat').mockImplementation(async (...args) => {
      const stat = await lstat(...args);
      if (args[0] === path.join(repo, 'tracked.txt') && !installed) {
        installed = true;
        await git('replace', base, replacement);
      }
      return stat;
    });
    await expect(prepareHandoffSnapshot(options())).rejects.toMatchObject({ code: 'unsupported_repository', cleanupFailed: false });
    expect(installed).toBe(true);
    expect(await fs.promises.readdir(staging)).toEqual([]);
  });

  it.each(['info/grafts', 'objects/info/alternates'])('refuses repository indirection in %s without rewriting it', async (relative) => {
    const { base, replacement } = await replacementFixture();
    const control = path.join(repo, '.git', relative);
    const alternateObjects = path.join(root, 'alternate-objects');
    await fs.promises.mkdir(alternateObjects);
    const content = relative === 'info/grafts' ? `${base} ${replacement}\n` : `${alternateObjects}\n`;
    await fs.promises.mkdir(path.dirname(control), { recursive: true });
    await fs.promises.writeFile(control, content);
    await expect(prepareHandoffSnapshot(options())).rejects.toMatchObject({ code: 'unsupported_repository' });
    expect(await fs.promises.readFile(control, 'utf8')).toBe(content);
    expect(await fs.promises.readdir(staging)).toEqual([]);
  });

  it('does not inherit a custom replacement namespace as authority over the approved base', async () => {
    const { base, replacement } = await replacementFixture();
    vi.stubEnv('GIT_REPLACE_REF_BASE', 'refs/handoff-test-replacements/');
    await git('replace', base, replacement);
    const refs = await exec('git', ['for-each-ref', '--format=%(refname):%(objectname)', 'refs/'], { cwd: repo });
    expect(refs.stdout.split(/\r?\n/)).toContain(`refs/handoff-test-replacements/${base}:${replacement}`);
    expect((await exec('git', ['show', `${base}:tracked.txt`], { cwd: repo })).stdout).toBe('changed final bytes\n');
    const snapshot = await prepareHandoffSnapshot(options());
    expect(snapshot.manifest.repo.base).toBe(base);
    expect(snapshot.manifest.files.map((entry) => entry.path)).toEqual(['tracked.txt']);
    expect(await fs.promises.readFile(path.join(snapshot.root, 'files/tracked.txt'), 'utf8')).toBe('changed final bytes\n');
  });

  it('ignores inherited repository and worktree overrides rather than advertising a foreign base', async () => {
    const { base, replacement } = await replacementFixture();
    const foreign = path.join(root, 'foreign-repo');
    await git('-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-q', '-b', 'foreign-fixture', foreign, replacement);
    const foreignGit = (await exec('git', ['rev-parse', '--absolute-git-dir'], { cwd: foreign })).stdout.trim();
    vi.stubEnv('GIT_DIR', foreignGit);
    vi.stubEnv('GIT_WORK_TREE', repo);
    expect((await exec('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim()).toBe(replacement);
    const snapshot = await prepareHandoffSnapshot(options());
    expect(snapshot.manifest.repo.base).toBe(base);
    expect(snapshot.manifest.files.map((entry) => entry.path)).toEqual(['tracked.txt']);
  });

  it('retains ordinary linked-worktree support while checking shared Git metadata', async () => {
    const linked = path.join(root, 'linked-worktree');
    await git('-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-q', '-b', 'handoff-fixture', linked);
    repo = linked;
    await file('tracked.txt', 'same\n');
    const snapshot = await prepareHandoffSnapshot(options());
    expect(snapshot.manifest.repo.branch).toBe('handoff-fixture');
    expect(snapshot.manifest.files.map((entry) => entry.path)).toEqual(['tracked.txt']);
    expect(await fs.promises.readFile(path.join(snapshot.root, 'files/tracked.txt'), 'utf8')).toBe('same\n');
  });

  it('still rejects a branch-base change during raw comparison', async () => {
    const { replacement } = await replacementFixture();
    const lstat = fs.promises.lstat;
    let moved = false;
    vi.spyOn(fs.promises, 'lstat').mockImplementation(async (...args) => {
      const stat = await lstat(...args);
      if (args[0] === path.join(repo, 'tracked.txt') && !moved) {
        moved = true;
        await git('update-ref', 'refs/heads/main', replacement);
      }
      return stat;
    });
    await expect(prepareHandoffSnapshot(options())).rejects.toMatchObject({ code: 'source_changed', cleanupFailed: false });
    expect(moved).toBe(true);
    expect(await fs.promises.readdir(staging)).toEqual([]);
  });

  it.each(['replacement', 'HEAD', 'graft', 'alternate'])('rechecks %s changes at the final manifest-publication boundary', async (change) => {
    const { base, replacement } = await replacementFixture();
    const open = fs.promises.open;
    let changed = false;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]).startsWith(staging) && path.basename(String(args[0])) === 'manifest.json') {
        changed = true;
        if (change === 'replacement') await git('replace', base, replacement);
        else if (change === 'HEAD') await git('update-ref', 'refs/heads/main', replacement);
        else {
          const alternate = path.join(root, 'late-alternate-objects');
          await fs.promises.mkdir(alternate);
          const relative = change === 'graft' ? 'info/grafts' : 'objects/info/alternates';
          await fs.promises.mkdir(path.dirname(path.join(repo, '.git', relative)), { recursive: true });
          await fs.promises.writeFile(path.join(repo, '.git', relative), change === 'graft' ? `${base} ${replacement}\n` : `${alternate}\n`);
        }
      }
      return handle;
    });
    await expect(prepareHandoffSnapshot(options())).rejects.toMatchObject({
      code: change === 'HEAD' ? 'source_changed' : 'unsupported_repository', cleanupFailed: false,
    });
    expect(changed).toBe(true);
    expect(await fs.promises.readdir(staging)).toEqual([]);
  });

  it.each(['private', 'common'])('rejects a changed %s Git directory identity even when base/branch/remote remain the same', async (changedDirectory) => {
    const linked = path.join(root, 'linked-worktree');
    await git('-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-q', '-b', 'handoff-fixture', linked);
    repo = linked;
    const privateDir = (await exec('git', ['rev-parse', '--absolute-git-dir'], { cwd: repo })).stdout.trim();
    const commonDir = path.resolve(repo, (await exec('git', ['rev-parse', '--git-common-dir'], { cwd: repo })).stdout.trim());
    const copied = path.join(root, 'copied-git-directory');
    await fs.promises.cp(changedDirectory === 'private' ? privateDir : commonDir, copied, { recursive: true });
    if (changedDirectory === 'private') await fs.promises.writeFile(path.join(copied, 'commondir'), `${commonDir}\n`);
    await file('tracked.txt', 'same\n');
    const lstat = fs.promises.lstat;
    let changed = false;
    vi.spyOn(fs.promises, 'lstat').mockImplementation(async (...args) => {
      const stat = await lstat(...args);
      if (args[0] === path.join(repo, 'tracked.txt') && !changed) {
        changed = true;
        if (changedDirectory === 'private') await fs.promises.writeFile(path.join(repo, '.git'), `gitdir: ${copied}\n`);
        else await fs.promises.writeFile(path.join(privateDir, 'commondir'), `${copied}\n`);
      }
      return stat;
    });
    await expect(prepareHandoffSnapshot(options())).rejects.toMatchObject({ code: 'source_changed', cleanupFailed: false });
    expect(changed).toBe(true);
    expect(await fs.promises.readdir(staging)).toEqual([]);
  });

  it('pins the environment source once without losing global configuration filter checks', async () => {
    const global = path.join(root, 'initial-global-config');
    const other = path.join(root, 'other-global-config');
    await git('config', '--file', global, 'remote.origin.url', 'https://example.com/initial.git');
    await git('config', '--file', other, 'remote.origin.url', 'https://example.com/other.git');
    vi.stubEnv('GIT_CONFIG_GLOBAL', global);
    await file('tracked.txt', 'same\n');
    const lstat = fs.promises.lstat;
    let changed = false;
    vi.spyOn(fs.promises, 'lstat').mockImplementation(async (...args) => {
      const stat = await lstat(...args);
      if (args[0] === path.join(repo, 'tracked.txt') && !changed) {
        changed = true;
        vi.stubEnv('GIT_CONFIG_GLOBAL', other);
      }
      return stat;
    });
    const snapshot = await prepareHandoffSnapshot(options());
    expect(changed).toBe(true);
    expect(snapshot.manifest.repo.remote).toBe('https://example.com/initial.git');
    expect(snapshot.manifest.files.map((entry) => entry.path)).toEqual(['tracked.txt']);
  });

  it('refuses configured filters before Git diff can execute their clean command', async () => {
    await file('.gitattributes', 'tracked.txt filter=qa\n');
    await git('config', 'filter.qa.clean', 'node -e "require(\'fs\').writeFileSync(\'filter-marker\',\'ran\');process.stdin.pipe(process.stdout)"');
    await file('tracked.txt', 'edited\n');
    const outcome: unknown = await prepareHandoffSnapshot(options()).catch((error: unknown) => error);
    expect(fs.existsSync(path.join(repo, 'filter-marker'))).toBe(false);
    expect(outcome).toMatchObject({ code: 'unsupported_repository' });
    expect(await fs.promises.readdir(staging)).toEqual([]);
  });

  it.each(['--skip-worktree', '--assume-unchanged'])('does not silently omit edited tracked files with %s', async (flag) => {
    await git('update-index', flag, '--', 'tracked.txt');
    await file('tracked.txt', 'edited but hidden from ordinary diff\n');
    await expect(prepareHandoffSnapshot(options())).rejects.toMatchObject({ code: 'unsupported_repository' });
    expect(await fs.promises.readdir(staging)).toEqual([]);
    expect(await fs.promises.readFile(path.join(repo, 'tracked.txt'), 'utf8')).toBe('edited but hidden from ordinary diff\n');
  });

  it('refuses global filters without running them or modifying the person-owned configuration', async () => {
    const config = path.join(root, 'global-config');
    const command = 'node -e "require(\'fs\').writeFileSync(\'filter-marker\',\'ran\');process.stdin.pipe(process.stdout)"';
    await git('config', '--file', config, 'filter.qa.clean', command);
    const original = await fs.promises.readFile(config);
    vi.stubEnv('GIT_CONFIG_GLOBAL', config);
    await file('.gitattributes', 'tracked.txt filter=qa\n');
    await file('tracked.txt', 'edited\n');
    await expect(prepareHandoffSnapshot(options())).rejects.toMatchObject({ code: 'unsupported_repository' });
    expect(fs.existsSync(path.join(repo, 'filter-marker'))).toBe(false);
    expect(await fs.promises.readFile(config)).toEqual(original);
  });

  it.each([
    ['global', 'GIT_CONFIG_GLOBAL'],
    ['system', 'GIT_CONFIG_SYSTEM'],
  ] as const)('refuses %s filter definitions even when no selected file uses the driver', async (scope, variable) => {
    const config = path.join(root, `${scope}-config`);
    await git('config', '--file', config, 'filter.qa.process', 'handoff-fixture-must-not-execute');
    const original = await fs.promises.readFile(config);
    vi.stubEnv(variable, config);
    const observed = await exec('git', ['config', '--show-scope', '--name-only', '--get-regexp', '^filter\\.qa\\.process$'], { cwd: repo });
    expect(observed.stdout.trim()).toBe(`${scope}\tfilter.qa.process`);
    await expect(prepareHandoffSnapshot(options())).rejects.toMatchObject({ code: 'unsupported_repository', cleanupFailed: false });
    expect(await fs.promises.readdir(staging)).toEqual([]);
    expect(await fs.promises.readFile(config)).toEqual(original);
  });

  it('never executes a filter installed after the initial repository preflight', async () => {
    await file('.gitattributes', 'tracked.txt filter=qa\n');
    await file('tracked.txt', 'same\n');
    const lstat = fs.promises.lstat;
    let installed = false;
    vi.spyOn(fs.promises, 'lstat').mockImplementation(async (...args) => {
      const stat = await lstat(...args);
      if (args[0] === path.join(repo, 'tracked.txt') && !installed) {
        installed = true;
        await git('config', 'filter.qa.clean', 'node -e "require(\'fs\').writeFileSync(\'filter-marker\',\'ran\');process.stdin.pipe(process.stdout)"');
      }
      return stat;
    });
    await expect(prepareHandoffSnapshot(options())).rejects.toMatchObject({ code: 'unsupported_repository' });
    expect(installed).toBe(true);
    expect(fs.existsSync(path.join(repo, 'filter-marker'))).toBe(false);
    expect(await fs.promises.readdir(staging)).toEqual([]);
  });

  it('compares raw tracked bytes rather than invoking filters or applying line-ending normalization', async () => {
    await file('.gitattributes', 'tracked.txt text eol=lf\n');
    await file('tracked.txt', 'base\r\n');
    const snapshot = await prepareHandoffSnapshot(options());
    expect(snapshot.manifest.files.map((entry) => entry.path)).toEqual(['.gitattributes', 'tracked.txt']);
    expect(await fs.promises.readFile(path.join(snapshot.root, 'files/tracked.txt'), 'utf8')).toBe('base\r\n');
  });

  it('preserves final tracked bytes, untracked and selected >512KiB ignored files, deletions and executable mode', async () => {
    await file('tracked.txt', 'staged\n');
    await git('add', 'tracked.txt');
    await file('tracked.txt', 'final unstaged\n');
    await fs.promises.rm(path.join(repo, 'deleted.txt'));
    await file('new.txt', 'new executable\n');
    await git('add', '--', 'new.txt');
    await git('update-index', '--chmod=+x', '--', 'new.txt');
    await git('config', 'core.filemode', 'false');
    await fs.promises.chmod(path.join(repo, 'new.txt'), 0o644);
    expect((await exec('git', ['ls-files', '--stage', '--', 'new.txt'], { cwd: repo })).stdout.startsWith('100755 ')).toBe(true);
    expect((await fs.promises.stat(path.join(repo, 'new.txt'))).mode & 0o100).toBe(0);
    await file('untracked.txt', 'untracked\n');
    const large = Buffer.alloc(600 * 1024, 17);
    await file('models/selected.bin', large);
    await file('models/unselected.dat', 'not selected\n');
    await file('ignored-unselected.txt', 'not selected\n');
    await file('node_modules/example/index.js', 'not selected\n');
    const snapshot = await prepareHandoffSnapshot(options({ include: { ignored: ['models/*.bin'] } }));
    expect(snapshot.manifest.files.map((entry) => entry.path)).toEqual(['models/selected.bin', 'new.txt', 'tracked.txt', 'untracked.txt']);
    expect(snapshot.manifest.deletions).toEqual(['deleted.txt']);
    expect(snapshot.manifest.files.find((entry) => entry.path === 'new.txt')?.mode).toBe('100755');
    expect(snapshot.manifest.files.find((entry) => entry.path === 'untracked.txt')?.mode).toBe('100644');
    expect(snapshot.manifest.files.find((entry) => entry.path === 'models/selected.bin')?.sha256).toBe(hash(large));
    expect(await fs.promises.readFile(path.join(snapshot.root, 'files/tracked.txt'), 'utf8')).toBe('final unstaged\n');
    expect(await fs.promises.readFile(path.join(snapshot.root, 'files/untracked.txt'), 'utf8')).toBe('untracked\n');
    const selectedBytes = await fs.promises.readFile(path.join(snapshot.root, 'files/models/selected.bin'));
    expect(selectedBytes.byteLength).toBe(large.byteLength);
    expect(selectedBytes.equals(large)).toBe(true);
    expect(await verifyHandoffSnapshot(snapshot.root, snapshot.manifest, summary(snapshot.manifest))).toEqual(snapshot);
    if (process.platform !== 'win32') {
      expect((await fs.promises.stat(snapshot.root)).mode & 0o777).toBe(0o700);
      expect((await fs.promises.stat(path.join(snapshot.root, 'files/tracked.txt'))).mode & 0o777).toBe(0o600);
    }
    await file('tracked.txt', 'sender changed after snapshot\n');
    expect(await fs.promises.readFile(path.join(snapshot.root, 'files/tracked.txt'), 'utf8')).toBe('final unstaged\n');
    expect(await verifyHandoffSnapshot(snapshot.root, snapshot.manifest, summary(snapshot.manifest))).toEqual(snapshot);
  });

  it.each(['edited', 'unchanged'] as const)('preserves canonical tracked Git mode with core.filemode=false (%s bytes)', async (bytes) => {
    await executableTrackedBase();
    if (bytes === 'edited') await file('tracked.txt', 'edited tracked bytes\n');
    const snapshot = await prepareHandoffSnapshot(options());
    if (bytes === 'edited') {
      expect(snapshot.manifest.files).toMatchObject([{ path: 'tracked.txt', mode: '100755' }]);
      expect(await fs.promises.readFile(path.join(snapshot.root, 'files/tracked.txt'), 'utf8')).toBe('edited tracked bytes\n');
    } else {
      expect(snapshot.manifest.files).toEqual([]);
      expect(snapshot.manifest.total_bytes).toBe(0);
    }
  });

  it('includes an index-only executable-mode change when Git ignores physical mode bits', async () => {
    await git('config', 'core.filemode', 'false');
    await git('update-index', '--chmod=+x', '--', 'tracked.txt');
    expect((await fs.promises.stat(path.join(repo, 'tracked.txt'))).mode & 0o100).toBe(0);
    const snapshot = await prepareHandoffSnapshot(options());
    expect(snapshot.manifest.files).toMatchObject([{ path: 'tracked.txt', mode: '100755' }]);
    expect(await fs.promises.readFile(path.join(snapshot.root, 'files/tracked.txt'), 'utf8')).toBe('base\n');
  });

  it('falls back to the canonical HEAD mode for a tracked path missing from the index', async () => {
    await executableTrackedBase();
    await git('rm', '--cached', '--', 'tracked.txt');
    await file('tracked.txt', 'edited after index removal\n');
    const snapshot = await prepareHandoffSnapshot(options({ include: { untracked: false } }));
    expect(snapshot.manifest.files).toMatchObject([{ path: 'tracked.txt', mode: '100755' }]);
    expect(await fs.promises.readFile(path.join(snapshot.root, 'files/tracked.txt'), 'utf8')).toBe('edited after index removal\n');
  });

  it('retains the HEAD mode for an index-removed path selected only as untracked', async () => {
    await executableTrackedBase();
    await git('rm', '--cached', '--', 'tracked.txt');
    await file('tracked.txt', 'selected as untracked\n');
    const snapshot = await prepareHandoffSnapshot(options({ include: { tracked_changes: false } }));
    expect(snapshot.manifest.files).toMatchObject([{ path: 'tracked.txt', mode: '100755' }]);
    expect(await fs.promises.readFile(path.join(snapshot.root, 'files/tracked.txt'), 'utf8')).toBe('selected as untracked\n');
  });

  it.each(['120000', '160000'])('retains excluded tracked kind %s compatibility while capturing an ordinary file', async (mode) => {
    await unsupportedTrackedBase(mode);
    await file('ordinary.txt', 'ordinary selected bytes\n');
    const snapshot = await prepareHandoffSnapshot(options({ exclude: ['unsupported.txt'] }));
    expect(snapshot.manifest.files.map((entry) => entry.path)).toEqual(['ordinary.txt']);
    expect(await fs.promises.readFile(path.join(snapshot.root, 'files/ordinary.txt'), 'utf8')).toBe('ordinary selected bytes\n');
    expect(await fs.promises.readFile(path.join(repo, 'unsupported.txt'), 'utf8')).toBe('base\n');
  });

  it.each(['120000', '160000'])('retains untracked-only compatibility with unselected HEAD kind %s', async (mode) => {
    await unsupportedTrackedBase(mode);
    await git('rm', '--cached', '--', 'unsupported.txt');
    await fs.promises.rm(path.join(repo, 'unsupported.txt'));
    expect((await exec('git', ['ls-files', '--stage', '--', 'unsupported.txt'], { cwd: repo })).stdout).toBe('');
    await file('ordinary.txt', 'ordinary untracked bytes\n');
    const snapshot = await prepareHandoffSnapshot(options({ include: { tracked_changes: false } }));
    expect(snapshot.manifest.files.map((entry) => entry.path)).toEqual(['ordinary.txt']);
    expect(snapshot.manifest.deletions).toEqual([]);
    expect(await fs.promises.readFile(path.join(snapshot.root, 'files/ordinary.txt'), 'utf8')).toBe('ordinary untracked bytes\n');
  });

  it.each(['120000', '160000'])('still refuses unsupported HEAD kind %s when its index-removed path is selected as untracked', async (mode) => {
    await unsupportedTrackedBase(mode);
    await git('rm', '--cached', '--', 'unsupported.txt');
    await expect(prepareHandoffSnapshot(options({ include: { tracked_changes: false } }))).rejects.toMatchObject({ code: 'unsupported_repository' });
    expect(await fs.promises.readdir(staging)).toEqual([]);
    expect(await fs.promises.readFile(path.join(repo, 'unsupported.txt'), 'utf8')).toBe('base\n');
  });

  it('uses physical modes when Git trusts them and leaves raw untracked modes unchanged', async () => {
    await executableTrackedBase();
    await git('config', 'core.filemode', 'true');
    await file('untracked.txt', 'raw untracked bytes\n');
    const snapshot = await prepareHandoffSnapshot(options());
    expect(snapshot.manifest.files).toMatchObject([
      { path: 'tracked.txt', mode: '100644' }, { path: 'untracked.txt', mode: '100644' },
    ]);
  });

  it('uses the documented true default only when core.filemode is absent', async () => {
    await git('config', '--unset', 'core.filemode');
    await git('update-index', '--chmod=+x', '--', 'tracked.txt');
    await expect(exec('git', ['config', '--get', 'core.filemode'], { cwd: repo })).rejects.toMatchObject({ code: 1 });
    expect((await prepareHandoffSnapshot(options())).manifest.files).toEqual([]);
  });

  it('refuses invalid core.filemode instead of guessing a mode policy', async () => {
    await git('config', 'core.filemode', 'not-a-boolean');
    await expect(prepareHandoffSnapshot(options())).rejects.toMatchObject({ code: 'git_failed' });
    expect(await fs.promises.readdir(staging)).toEqual([]);
  });

  it.each(['120000', '160000'])('refuses unsupported index mode %s even when the working path is a regular file', async (mode) => {
    const oid = (await exec('git', ['rev-parse', mode === '120000' ? 'HEAD:tracked.txt' : 'HEAD'], { cwd: repo })).stdout.trim();
    await file('indexed.txt', 'regular working file\n');
    await git('update-index', '--add', '--cacheinfo', `${mode},${oid},indexed.txt`);
    await expect(prepareHandoffSnapshot(options())).rejects.toMatchObject({ code: 'unsupported_repository' });
    expect(await fs.promises.readdir(staging)).toEqual([]);
  });

  it.each([
    ['index mode', 'manifest sync'], ['core.filemode', 'manifest sync'],
    ['index mode', 'final repository validation'], ['core.filemode', 'final repository validation'],
  ] as const)('rejects %s mutation during real %s without changing source bytes', async (authority, boundary) => {
    await executableTrackedBase();
    await file('tracked.txt', 'edited tracked bytes\n');
    const before = await fs.promises.stat(path.join(repo, 'tracked.txt'), { bigint: true });
    await fs.promises.mkdir(path.join(staging, 'existing-data'));
    await fs.promises.writeFile(path.join(staging, 'existing-data/keep.txt'), 'keep');
    const request = options();
    const open = fs.promises.open;
    const lstat = fs.promises.lstat;
    let synced = false;
    let mutated = false;
    const mutate = async () => {
      if (authority === 'index mode') await git('update-index', '--chmod=-x', '--', 'tracked.txt');
      else await git('config', 'core.filemode', 'true');
      mutated = true;
    };
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === path.join(staging, request.handoffId, 'manifest.json')) {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, 'sync').mockImplementation(async () => {
          await sync();
          synced = true;
          if (boundary === 'manifest sync') await mutate();
        });
      }
      return handle;
    });
    vi.spyOn(fs.promises, 'lstat').mockImplementation(async (...args) => {
      const stat = await lstat(...args);
      if (boundary === 'final repository validation' && synced && !mutated && args[0] === path.join(repo, '.git')) await mutate();
      return stat;
    });
    await expect(prepareHandoffSnapshot(request)).rejects.toMatchObject({ code: 'source_changed', cleanupFailed: false });
    expect(synced).toBe(true);
    expect(mutated).toBe(true);
    expect(await fs.promises.readdir(staging)).toEqual(['existing-data']);
    expect(await fs.promises.readFile(path.join(staging, 'existing-data/keep.txt'), 'utf8')).toBe('keep');
    expect(await fs.promises.readFile(path.join(repo, 'tracked.txt'), 'utf8')).toBe('edited tracked bytes\n');
    expect(await fs.promises.stat(path.join(repo, 'tracked.txt'), { bigint: true })).toMatchObject({
      dev: before.dev, ino: before.ino, mode: before.mode, size: before.size, mtimeNs: before.mtimeNs, ctimeNs: before.ctimeNs,
    });
  });

  it.each([
    ['.env', 'EXAMPLE=synthetic-password'],
    ['config.txt', `TOKEN=ghp_${'a'.repeat(36)}`],
    ['private.key', 'example'],
    ['.npmrc', '//registry.example/:_authToken=synthetic-password'],
  ])('blocks %s before allocating any packed content, without leaking content', async (name, value) => {
    await file('a-safe-file.txt', 'safe');
    await file(name, value);
    const result = await prepareHandoffSnapshot(options()).catch((error: unknown) => error);
    expect(result).toMatchObject({ code: 'secret_blocked', cleanupFailed: false });
    expect(JSON.stringify(result)).not.toContain(value);
    expect(await fs.promises.readdir(staging)).toEqual([]);
    expect(await fs.promises.readFile(path.join(repo, name), 'utf8')).toBe(value);
  });

  it('checks known secrets in ignored paths and Git remote metadata before packing', async () => {
    const token = `ghp_${'a'.repeat(36)}`;
    await file('models/selected.bin', token);
    await expect(prepareHandoffSnapshot(options({ include: { ignored: ['models/**'] } }))).rejects.toMatchObject({ code: 'secret_blocked' });
    await fs.promises.rm(path.join(repo, 'models/selected.bin'));
    await git('config', 'remote.origin.url', `ssh://${token}@example.com/project.git`);
    await expect(prepareHandoffSnapshot(options())).rejects.toMatchObject({ code: 'secret_blocked' });
    expect(await fs.promises.readdir(staging)).toEqual([]);
  });

  it.each([false, true])('rejects selected symlinks, inside or outside the worktree (outside=%s)', async (outside) => {
    const target = outside ? path.join(root, 'outside.txt') : path.join(repo, 'tracked.txt');
    if (outside) await fs.promises.writeFile(target, 'outside');
    await fs.promises.symlink(target, path.join(repo, 'link.txt'));
    await expect(prepareHandoffSnapshot(options())).rejects.toMatchObject({ code: 'unsafe_entry' });
    expect(await fs.promises.readdir(staging)).toEqual([]);
    expect(await fs.promises.readFile(target, 'utf8')).toBe(outside ? 'outside' : 'base\n');
  });

  it.each([
    ['per-file', { totalBytes: 11, perFileBytes: 9, maxFiles: 10 }],
    ['total', { totalBytes: 10, perFileBytes: 10, maxFiles: 10 }],
    ['count', { totalBytes: 20, perFileBytes: 10, maxFiles: 1 }],
  ] as const)('enforces the %s ceiling before allocating staging', async (_name, bounds) => {
    await file('new.txt', '1234567890');
    await file('second.txt', 'a');
    await fs.promises.writeFile(path.join(staging, 'keep.txt'), 'keep');
    const mkdir = vi.spyOn(fs.promises, 'mkdir');
    await expect(prepareHandoffSnapshot(options({ bounds }))).rejects.toMatchObject({ code: 'bounds_exceeded', cleanupFailed: false });
    expect(mkdir).not.toHaveBeenCalled();
    expect(await fs.promises.readdir(staging)).toEqual(['keep.txt']);
    expect(await fs.promises.readFile(path.join(staging, 'keep.txt'), 'utf8')).toBe('keep');
    expect(await fs.promises.readFile(path.join(repo, 'new.txt'), 'utf8')).toBe('1234567890');
    expect(await fs.promises.readFile(path.join(repo, 'second.txt'), 'utf8')).toBe('a');
    expect(await fs.promises.readFile(path.join(repo, 'tracked.txt'), 'utf8')).toBe('base\n');
  });

  it('accepts exact total, per-file and count bounds with eleven selected bytes', async () => {
    await file('new.txt', '1234567890');
    await file('second.txt', 'a');
    await fs.promises.writeFile(path.join(staging, 'keep.txt'), 'keep');
    const snapshot = await prepareHandoffSnapshot(options({ bounds: { totalBytes: 11, perFileBytes: 10, maxFiles: 2 } }));
    expect(snapshot.manifest.total_bytes).toBe(11);
    expect(snapshot.manifest.files.map(({ path, size }) => ({ path, size }))).toEqual([
      { path: 'new.txt', size: 10 }, { path: 'second.txt', size: 1 },
    ]);
    expect((await fs.promises.readdir(staging)).sort()).toEqual([path.basename(snapshot.root), 'keep.txt'].sort());
    expect(await fs.promises.readFile(path.join(staging, 'keep.txt'), 'utf8')).toBe('keep');
    expect(await fs.promises.readFile(path.join(repo, 'new.txt'), 'utf8')).toBe('1234567890');
    expect(await fs.promises.readFile(path.join(repo, 'second.txt'), 'utf8')).toBe('a');
    expect(await fs.promises.readFile(path.join(repo, 'tracked.txt'), 'utf8')).toBe('base\n');
  });

  it.each(['below total', 'exact total', 'below per-file', 'raised bounds'] as const)('enforces exact comparison read budgets independently of output bounds (%s; scaled fault injection)', async (scenario) => {
    const sizes = await Promise.all(['.gitignore', 'deleted.txt', 'tracked.txt'].map(async (name) =>
      (await fs.promises.stat(path.join(repo, name))).size));
    const total = sizes.reduce((sum, size) => sum + size, 0);
    const largest = Math.max(...sizes);
    const original = { totalBytes: HANDOFF_TRANSFER_DEFAULTS.totalBytes, perFileBytes: HANDOFF_TRANSFER_DEFAULTS.perFileBytes };
    const bounds = { totalBytes: 1, perFileBytes: 1, maxFiles: 1 };
    const protectedDirectory = path.join(staging, 'existing-data');
    await fs.promises.mkdir(protectedDirectory);
    await fs.promises.writeFile(path.join(protectedDirectory, 'keep.txt'), 'keep');
    try {
      Object.defineProperties(HANDOFF_TRANSFER_DEFAULTS, {
        totalBytes: { value: scenario === 'below total' || scenario === 'raised bounds' ? total - 1 : total },
        perFileBytes: { value: scenario === 'below per-file' || scenario === 'raised bounds' ? largest - 1 : largest },
      });
      if (scenario === 'below total' || scenario === 'below per-file') {
        await expect(prepareHandoffSnapshot(options({ bounds }))).rejects.toMatchObject({ code: 'unsupported_repository' });
        expect(await fs.promises.readdir(staging)).toEqual(['existing-data']);
      } else {
        const selectedBounds = scenario === 'raised bounds' ? { totalBytes: total + 1, perFileBytes: largest + 1, maxFiles: 1 } : bounds;
        const prepared = await prepareHandoffSnapshot(options({ bounds: selectedBounds }));
        expect(prepared.manifest.files).toEqual([]);
        expect(prepared.manifest.total_bytes).toBe(0);
        expect((await fs.promises.readdir(staging)).sort()).toEqual([path.basename(prepared.root), 'existing-data'].sort());
      }
      expect(await fs.promises.readFile(path.join(protectedDirectory, 'keep.txt'), 'utf8')).toBe('keep');
    } finally {
      Object.defineProperties(HANDOFF_TRANSFER_DEFAULTS, {
        totalBytes: { value: original.totalBytes }, perFileBytes: { value: original.perFileBytes },
      });
    }
  });

  it('detects mutation between scan and copy and cleans only its owned staging folder', async () => {
    await file('new.txt', 'safe original');
    const open = fs.promises.open;
    let sourceOpens = 0;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      if (args[0] === path.join(repo, 'new.txt') && ++sourceOpens === 2) await file('new.txt', `ghp_${'a'.repeat(36)}`);
      return open(...args);
    });
    await expect(prepareHandoffSnapshot(options())).rejects.toMatchObject({ code: 'source_changed' });
    expect(await fs.promises.readdir(staging)).toEqual([]);
    expect(await fs.promises.readFile(path.join(repo, 'tracked.txt'), 'utf8')).toBe('base\n');
    expect(await fs.promises.readFile(path.join(repo, 'new.txt'), 'utf8')).toBe(`ghp_${'a'.repeat(36)}`);
  });

  it('reports partial-copy failure and cleanup failure explicitly without deleting pre-existing staging', async () => {
    await file('a.txt', 'safe a');
    await file('b.txt', 'safe b');
    const protectedDirectory = path.join(staging, 'existing-data');
    await fs.promises.mkdir(protectedDirectory);
    await fs.promises.writeFile(path.join(protectedDirectory, 'keep.txt'), 'keep');
    const open = fs.promises.open;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      if (String(args[0]).startsWith(staging) && String(args[0]).endsWith(`${path.sep}b.txt`)) throw new Error('Injected write failure with no secret values.');
      return open(...args);
    });
    await expect(prepareHandoffSnapshot(options())).rejects.toMatchObject({ code: 'filesystem_failed', cleanupFailed: false });
    expect(await fs.promises.readdir(staging)).toEqual(['existing-data']);
    vi.spyOn(fs.promises, 'rm').mockRejectedValueOnce(new Error('Injected cleanup failure.'));
    await expect(prepareHandoffSnapshot(options())).rejects.toMatchObject({ code: 'filesystem_failed', cleanupFailed: true });
    expect(await fs.promises.readFile(path.join(protectedDirectory, 'keep.txt'), 'utf8')).toBe('keep');
    expect(await fs.promises.readFile(path.join(repo, 'a.txt'), 'utf8')).toBe('safe a');
  });

  it('refuses reused or invalid staging ids and staging inside the source worktree', async () => {
    const id = randomUUID();
    await fs.promises.mkdir(path.join(staging, id));
    await fs.promises.writeFile(path.join(staging, id, 'keep.txt'), 'keep');
    await expect(prepareHandoffSnapshot(options({ handoffId: id }))).rejects.toMatchObject({ code: 'filesystem_failed' });
    expect(await fs.promises.readFile(path.join(staging, id, 'keep.txt'), 'utf8')).toBe('keep');
    await expect(prepareHandoffSnapshot(options({ handoffId: '../outside' }))).rejects.toMatchObject({ code: 'invalid_staging' });
    await fs.promises.mkdir(path.join(repo, 'staging'));
    await expect(prepareHandoffSnapshot(options({ stagingRoot: path.join(repo, 'staging') }))).rejects.toMatchObject({ code: 'invalid_staging' });
  });
});

describe('local secret-safe handoff snapshots', () => {
  beforeEach(() => initializeRepository({ 'tracked.txt': 'base\n', 'unchanged.txt': 'unchanged\n' }, 'sha256'));

  it('detects same-size raw tracked edits in a SHA-256-object-format repository', async () => {
    await file('tracked.txt', 'same\n');
    const snapshot = await prepareHandoffSnapshot(options());
    expect(snapshot.manifest.repo.base).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.manifest.files.map((entry) => entry.path)).toEqual(['tracked.txt']);
    expect(await fs.promises.readFile(path.join(snapshot.root, 'files/tracked.txt'), 'utf8')).toBe('same\n');
    expect(await verifyHandoffSnapshot(snapshot.root, snapshot.manifest, summary(snapshot.manifest))).toEqual(snapshot);
  });
});

describe('handoff Git process ownership', () => {
  it('retains a fake native custom-promisify child after promise settlement until its actual close', async () => {
    const child = new EventEmitter();
    let resolve!: (output: { stdout: string; stderr: string }) => void;
    const result = Object.assign(new Promise<{ stdout: string; stderr: string }>((complete) => { resolve = complete; }), { child });
    const delegate = () => { throw new Error('The native custom implementation must be retained'); };
    const custom = vi.fn((): Promise<unknown> & { child: EventEmitter } => result);
    Object.defineProperty(delegate, promisify.custom, { value: custom });
    const wrapped = ownCheckpointExecFile(delegate, owner);
    const rejectedChild = new EventEmitter();
    const failure = new Error('Original native rejection');
    let reject: (error: unknown) => void = () => {};
    let rejected: Promise<unknown> | undefined;
    await preservingFailure(async () => {
      expect(promisify(wrapped)()).toBe(result);
      expect(result.child).toBe(child);
      expect(custom).toHaveBeenCalledOnce();
      child.emit('exit');
      resolve({ stdout: 'raw bytes', stderr: '' });
      expect(await result).toEqual({ stdout: 'raw bytes', stderr: '' });
      expect(owner().evidence().teardown).toMatchObject({ callbackPending: 0, closePending: 1, childPending: 1 });
      expect(() => owner().mutateEpoch(() => { throw new Error('must not retire'); })).toThrow('accounting is incomplete');
      child.emit('close');
      await owner().settleEpoch(() => Promise.resolve());
      expect(owner().evidence().teardown.childPending).toBe(0);
      const rejection = Object.assign(new Promise<unknown>((_resolve, fail) => { reject = fail; }), { child: rejectedChild });
      custom.mockReturnValueOnce(rejection);
      rejected = promisify(wrapped)();
      expect(rejected).toBe(rejection);
      expect(rejection.child).toBe(rejectedChild);
      rejectedChild.emit('close');
      expect(owner().evidence().teardown).toMatchObject({ callbackPending: 1, closePending: 0, childPending: 1 });
      reject(failure);
      await expect(rejected).rejects.toBe(failure);
      await owner().settleEpoch(() => Promise.resolve());
      expect(owner().evidence().teardown.childPending).toBe(0);
    }, async () => {
      resolve({ stdout: 'raw bytes', stderr: '' });
      child.emit('close');
      await result;
      reject(failure);
      rejectedChild.emit('close');
      await rejected?.then(() => {}, () => {});
    });
  });
});

describe('receiver byte and hash verification', () => {
  let snapshot: HandoffSnapshot;
  beforeEach(async () => {
    await initializeStandardRepository();
    await file('new.txt', 'safe file');
    snapshot = await prepareHandoffSnapshot(options());
  });

  it('rejects tampered bytes, sizes and manifest digests before any apply exists', async () => {
    await fs.promises.writeFile(path.join(snapshot.root, 'files/new.txt'), 'evil file');
    await expect(verifyHandoffSnapshot(snapshot.root, snapshot.manifest, summary(snapshot.manifest))).rejects.toMatchObject({ code: 'hash_mismatch' });
    await fs.promises.writeFile(path.join(snapshot.root, 'files/new.txt'), 'different length');
    await expect(verifyHandoffSnapshot(snapshot.root, snapshot.manifest, summary(snapshot.manifest))).rejects.toMatchObject({ code: 'hash_mismatch' });
    await expect(verifyHandoffSnapshot(snapshot.root, { ...snapshot.manifest, manifest_sha256: '0'.repeat(64) }, summary(snapshot.manifest))).rejects.toMatchObject({ code: 'hash_mismatch' });
    expect(await fs.promises.readFile(path.join(repo, 'tracked.txt'), 'utf8')).toBe('base\n');
  });

  it('blocks forged but correctly hashed secret content on the receiver', async () => {
    const content = `ghp_${'a'.repeat(36)}`;
    await fs.promises.writeFile(path.join(snapshot.root, 'files/new.txt'), content);
    const forged = rehash({
      ...snapshot.manifest, total_bytes: content.length,
      files: [{ ...snapshot.manifest.files[0], size: content.length, sha256: hash(content) }],
    });
    await expect(verifyHandoffSnapshot(snapshot.root, forged, summary(forged))).rejects.toMatchObject({
      code: 'secret_blocked', findings: [{ path: 'new.txt', rule: 'content.github_token', line: 1 }],
    });
  });

  it('refuses replaced symlink components even when the outside bytes match', async () => {
    await fs.promises.rename(path.join(snapshot.root, 'files'), path.join(root, 'outside-files'));
    await fs.promises.symlink(path.join(root, 'outside-files'), path.join(snapshot.root, 'files'));
    await expect(verifyHandoffSnapshot(snapshot.root, snapshot.manifest, summary(snapshot.manifest))).rejects.toMatchObject({ code: 'unsafe_entry' });
    expect(await fs.promises.readFile(path.join(root, 'outside-files/new.txt'), 'utf8')).toBe('safe file');
  });

  it('rejects a matching-byte parent symlink swapped after its lstat', async () => {
    const files = path.join(snapshot.root, 'files');
    const outside = path.join(root, 'outside-files');
    await fs.promises.cp(files, outside, { recursive: true });
    const lstat = fs.promises.lstat;
    let swapped = false;
    vi.spyOn(fs.promises, 'lstat').mockImplementation(async (...args) => {
      const stat = await lstat(...args);
      if (args[0] === files && !swapped) {
        swapped = true;
        await fs.promises.rename(files, path.join(root, 'retained-files'));
        await fs.promises.symlink(outside, files, 'junction');
      }
      return stat;
    });
    await expect(verifyHandoffSnapshot(snapshot.root, snapshot.manifest, summary(snapshot.manifest))).rejects.toMatchObject({ code: 'source_changed' });
    expect(swapped).toBe(true);
    expect(await fs.promises.readFile(path.join(outside, 'new.txt'), 'utf8')).toBe('safe file');
  });

  it.each(['open', 'read'] as const)('rejects an observed parent identity replacement after %s despite matching file bytes, and closes the descriptor', async (boundary) => {
    const files = path.join(snapshot.root, 'files');
    const outside = path.join(root, 'outside-files');
    await fs.promises.cp(files, outside, { recursive: true });
    const open = fs.promises.open;
    const lstat = fs.promises.lstat;
    const original = await lstat(files, { bigint: true });
    const replacement = await lstat(outside, { bigint: true });
    expect([replacement.ino, replacement.ctimeNs]).not.toEqual([original.ino, original.ctimeNs]);
    let swapped = false;
    vi.spyOn(fs.promises, 'lstat').mockImplementation(async (...args) =>
      swapped && args[0] === files ? replacement : lstat(...args));
    const reads = vi.fn();
    const closes = vi.fn();
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === path.join(files, 'new.txt')) {
        const read = handle.read.bind(handle);
        const close = handle.close.bind(handle);
        vi.spyOn(handle, 'read').mockImplementation(async (...args) => {
          reads();
          const result = await read(...args);
          if (boundary === 'read') swapped = true;
          return result;
        });

        vi.spyOn(handle, 'close').mockImplementation(async () => { closes(); return close(); });
        if (boundary === 'open') swapped = true;
      }
      return handle;
    });
    await expect(verifyHandoffSnapshot(snapshot.root, snapshot.manifest, summary(snapshot.manifest))).rejects.toMatchObject({ code: 'source_changed' });
    expect(swapped).toBe(true);
    if (boundary === 'open') expect(reads).not.toHaveBeenCalled();
    else expect(reads).toHaveBeenCalledOnce();
    expect(closes).toHaveBeenCalledOnce();
    expect(await fs.promises.readFile(path.join(outside, 'new.txt'), 'utf8')).toBe('safe file');
  });

  it('pins nested ancestors through the post-read lookup despite a matching leaf inode (identity fault injection)', async () => {
    await file('a/b/nested.txt', 'nested bytes');
    snapshot = await prepareHandoffSnapshot(options());
    const parent = path.join(snapshot.root, 'files/a/b');
    const nested = path.join(parent, 'nested.txt');
    const outside = path.join(root, 'outside-nested');
    await fs.promises.cp(parent, outside, { recursive: true });
    const open = fs.promises.open;
    const lstat = fs.promises.lstat;
    const original = await lstat(parent, { bigint: true });
    const replacement = await lstat(outside, { bigint: true });
    const leaf = await lstat(nested, { bigint: true });
    expect([replacement.ino, replacement.ctimeNs]).not.toEqual([original.ino, original.ctimeNs]);
    let readFinished = false;
    let swapped = false;
    let postReadLeafLookups = 0;
    const reads = vi.fn();
    const stats = vi.fn();
    const closes = vi.fn();
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === nested) {
        const read = handle.read.bind(handle);
        const stat = handle.stat.bind(handle);
        const close = handle.close.bind(handle);
        vi.spyOn(handle, 'read').mockImplementation(async (...args) => {
          reads();
          const result = await read(...args);
          readFinished = true;
          return result;
        });
        vi.spyOn(handle, 'stat').mockImplementation(async (...args) => { stats(); return stat(...args); });
        vi.spyOn(handle, 'close').mockImplementation(async () => { closes(); return close(); });
      }
      return handle;
    });
    vi.spyOn(fs.promises, 'lstat').mockImplementation(async (...args) => {
      const stat = await lstat(...args);
      if (args[0] === parent) {
        if (swapped) return replacement;
        // Keep the first lookup stale, as a directory replacement after lstat would.
        if (readFinished) swapped = true;
      } else if (args[0] === nested && readFinished) {
        postReadLeafLookups++;
        expect(stat).toMatchObject({ dev: leaf.dev, ino: leaf.ino, mode: leaf.mode, size: leaf.size, mtimeNs: leaf.mtimeNs, ctimeNs: leaf.ctimeNs });
      }
      return stat;
    });
    await expect(verifyHandoffSnapshot(snapshot.root, snapshot.manifest, summary(snapshot.manifest))).rejects.toMatchObject({ code: 'source_changed' });
    expect(swapped).toBe(true);
    expect(postReadLeafLookups).toBe(1);
    expect(reads).toHaveBeenCalledOnce();
    expect(stats).toHaveBeenCalledOnce();
    expect(closes).toHaveBeenCalledOnce();
    expect(await fs.promises.readFile(path.join(outside, 'nested.txt'), 'utf8')).toBe('nested bytes');
  });

  it('rejects a fully rehashed replacement manifest that differs from the agreed offer summary', async () => {
    const changed = 'new bytes';
    await fs.promises.writeFile(path.join(snapshot.root, 'files/new.txt'), changed);
    const replacement = rehash({
      ...snapshot.manifest, files: [{ ...snapshot.manifest.files[0], sha256: hash(changed) }],
    });
    await expect(verifyHandoffSnapshot(snapshot.root, replacement, summary(snapshot.manifest))).rejects.toMatchObject({ code: 'hash_mismatch' });
  });
});
