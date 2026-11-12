import { execFile } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalHandoffManifest, HANDOFF_TRANSFER_DEFAULTS, type HandoffWorktreeManifest } from '../../shared/handoff-manifest';
import { prepareHandoffSnapshot, verifyHandoffSnapshot, type HandoffSnapshot, type PrepareHandoffSnapshot } from './handoff-snapshot';

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

beforeEach(async () => {
  // Model supported repositories without ambient runner filters; production still refuses them.
  vi.stubEnv('GIT_CONFIG_GLOBAL', os.devNull);
  vi.stubEnv('GIT_CONFIG_SYSTEM', os.devNull);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '0');
  root = await fs.promises.realpath(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-snapshot-')));
  repo = path.join(root, 'repo');
  staging = path.join(root, 'staging');
  await fs.promises.mkdir(repo);
  await fs.promises.mkdir(staging);
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.name', 'Fixture');
  await git('config', 'user.email', 'fixture@example.com');
  await file('.gitignore', 'models/\nignored-unselected.txt\nnode_modules/\n');
  await file('tracked.txt', 'base\n');
  await file('deleted.txt', 'delete me\n');
  await git('add', '.');
  await git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Fixture base');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('local secret-safe handoff snapshots', () => {
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
    vi.stubEnv('GIT_REPLACE_REF_BASE', 'refs/handoff-test-replacements');
    await git('replace', base, replacement);
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

  it('detects same-size raw tracked edits in a SHA-256-object-format repository', async () => {
    repo = path.join(root, 'sha256-repo');
    await fs.promises.mkdir(repo);
    await git('init', '-q', '-b', 'main', '--object-format=sha256');
    await git('config', 'user.name', 'Fixture');
    await git('config', 'user.email', 'fixture@example.com');
    await file('tracked.txt', 'base\n');
    await file('unchanged.txt', 'unchanged\n');
    await git('add', '.');
    await git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'SHA256 fixture');
    await file('tracked.txt', 'same\n');
    const snapshot = await prepareHandoffSnapshot(options());
    expect(snapshot.manifest.repo.base).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.manifest.files.map((entry) => entry.path)).toEqual(['tracked.txt']);
    expect(await fs.promises.readFile(path.join(snapshot.root, 'files/tracked.txt'), 'utf8')).toBe('same\n');
    expect(await verifyHandoffSnapshot(snapshot.root, snapshot.manifest, summary(snapshot.manifest))).toEqual(snapshot);
  });

  it('preserves final tracked bytes, untracked and selected >512KiB ignored files, deletions and executable mode', async () => {
    await file('tracked.txt', 'staged\n');
    await git('add', 'tracked.txt');
    await file('tracked.txt', 'final unstaged\n');
    await fs.promises.rm(path.join(repo, 'deleted.txt'));
    await file('new.txt', 'untracked\n');
    await fs.promises.chmod(path.join(repo, 'new.txt'), 0o755);
    const large = Buffer.alloc(600 * 1024, 17);
    await file('models/selected.bin', large);
    await file('models/unselected.dat', 'not selected\n');
    await file('ignored-unselected.txt', 'not selected\n');
    await file('node_modules/example/index.js', 'not selected\n');
    const snapshot = await prepareHandoffSnapshot(options({ include: { ignored: ['models/*.bin'] } }));
    expect(snapshot.manifest.files.map((entry) => entry.path)).toEqual(['models/selected.bin', 'new.txt', 'tracked.txt']);
    expect(snapshot.manifest.deletions).toEqual(['deleted.txt']);
    expect(snapshot.manifest.files.find((entry) => entry.path === 'new.txt')?.mode).toBe('100755');
    expect(snapshot.manifest.files.find((entry) => entry.path === 'models/selected.bin')?.sha256).toBe(hash(large));
    expect(await fs.promises.readFile(path.join(snapshot.root, 'files/tracked.txt'), 'utf8')).toBe('final unstaged\n');
    expect(await fs.promises.readFile(path.join(snapshot.root, 'files/models/selected.bin'))).toEqual(large);
    expect(await verifyHandoffSnapshot(snapshot.root, snapshot.manifest, summary(snapshot.manifest))).toEqual(snapshot);
    if (process.platform !== 'win32') {
      expect((await fs.promises.stat(snapshot.root)).mode & 0o777).toBe(0o700);
      expect((await fs.promises.stat(path.join(snapshot.root, 'files/tracked.txt'))).mode & 0o777).toBe(0o600);
    }
    await file('tracked.txt', 'sender changed after snapshot\n');
    expect(await fs.promises.readFile(path.join(snapshot.root, 'files/tracked.txt'), 'utf8')).toBe('final unstaged\n');
    expect(await verifyHandoffSnapshot(snapshot.root, snapshot.manifest, summary(snapshot.manifest))).toEqual(snapshot);
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

  it('enforces total, per-file and count ceilings before allocating staging', async () => {
    await file('new.txt', '1234567890');
    await file('second.txt', 'a');
    for (const bounds of [
      { totalBytes: 11, perFileBytes: 9, maxFiles: 10 },
      { totalBytes: 10, perFileBytes: 10, maxFiles: 10 },
      { totalBytes: 20, perFileBytes: 10, maxFiles: 1 },
    ]) await expect(prepareHandoffSnapshot(options({ bounds }))).rejects.toMatchObject({ code: 'bounds_exceeded' });
    expect(await fs.promises.readdir(staging)).toEqual([]);
    expect((await prepareHandoffSnapshot(options({ bounds: { totalBytes: 11, perFileBytes: 10, maxFiles: 2 } }))).manifest.total_bytes).toBe(11);
  });

  it('enforces exact comparison read budgets independently of tighter output bounds (scaled budget fault injection)', async () => {
    const sizes = await Promise.all(['.gitignore', 'deleted.txt', 'tracked.txt'].map(async (name) =>
      (await fs.promises.stat(path.join(repo, name))).size));
    const total = sizes.reduce((sum, size) => sum + size, 0);
    const largest = Math.max(...sizes);
    const original = { totalBytes: HANDOFF_TRANSFER_DEFAULTS.totalBytes, perFileBytes: HANDOFF_TRANSFER_DEFAULTS.perFileBytes };
    const bounds = { totalBytes: 1, perFileBytes: 1, maxFiles: 1 };
    try {
      Object.defineProperties(HANDOFF_TRANSFER_DEFAULTS, { totalBytes: { value: total - 1 }, perFileBytes: { value: largest } });
      await expect(prepareHandoffSnapshot(options({ bounds }))).rejects.toMatchObject({ code: 'unsupported_repository' });
      expect(await fs.promises.readdir(staging)).toEqual([]);
      Object.defineProperty(HANDOFF_TRANSFER_DEFAULTS, 'totalBytes', { value: total });
      const exact = await prepareHandoffSnapshot(options({ bounds }));
      expect(exact.manifest.files).toEqual([]);
      expect(exact.manifest.total_bytes).toBe(0);
      Object.defineProperty(HANDOFF_TRANSFER_DEFAULTS, 'perFileBytes', { value: largest - 1 });
      await expect(prepareHandoffSnapshot(options({ bounds }))).rejects.toMatchObject({ code: 'unsupported_repository' });
      expect(await fs.promises.readdir(staging)).toEqual([path.basename(exact.root)]);
      const raised = await prepareHandoffSnapshot(options({ bounds: { totalBytes: total + 1, perFileBytes: largest + 1, maxFiles: 1 } }));
      expect(raised.manifest.files).toEqual([]);
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

describe('receiver byte and hash verification', () => {
  let snapshot: HandoffSnapshot;
  beforeEach(async () => {
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

  it.each(['open', 'read'] as const)('rejects a parent swap after %s, closes the descriptor and never accepts matching outside bytes', async (boundary) => {
    const files = path.join(snapshot.root, 'files');
    const outside = path.join(root, 'outside-files');
    await fs.promises.cp(files, outside, { recursive: true });
    const open = fs.promises.open;
    let swapped = false;
    const swap = async () => {
      if (swapped) return;
      swapped = true;
      await fs.promises.rename(files, path.join(root, 'retained-files'));
      await fs.promises.symlink(outside, files, 'junction');
    };
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
          if (boundary === 'read') await swap();
          return result;
        });

        vi.spyOn(handle, 'close').mockImplementation(async () => { closes(); return close(); });
        if (boundary === 'open') await swap();
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

  it('pins nested ancestors through the post-read lookup, even when the moved leaf retains the same inode', async () => {
    await file('a/b/nested.txt', 'nested bytes');
    snapshot = await prepareHandoffSnapshot(options());
    const parent = path.join(snapshot.root, 'files/a/b');
    const nested = path.join(parent, 'nested.txt');
    const outside = path.join(root, 'outside-nested');
    const open = fs.promises.open;
    const lstat = fs.promises.lstat;
    let readFinished = false;
    let swapped = false;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === nested) {
        const read = handle.read.bind(handle);
        vi.spyOn(handle, 'read').mockImplementation(async (...args) => {
          const result = await read(...args);
          readFinished = true;
          return result;
        });
      }
      return handle;
    });
    vi.spyOn(fs.promises, 'lstat').mockImplementation(async (...args) => {
      const stat = await lstat(...args);
      if (args[0] === parent && readFinished && !swapped) {
        swapped = true;
        await fs.promises.rename(parent, outside);
        await fs.promises.symlink(outside, parent, 'junction');
      }
      return stat;
    });
    await expect(verifyHandoffSnapshot(snapshot.root, snapshot.manifest, summary(snapshot.manifest))).rejects.toMatchObject({ code: 'source_changed' });
    expect(swapped).toBe(true);
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
