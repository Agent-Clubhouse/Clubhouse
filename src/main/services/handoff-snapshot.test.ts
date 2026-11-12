import { execFile } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalHandoffManifest, type HandoffWorktreeManifest } from '../../shared/handoff-manifest';
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

beforeEach(async () => {
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
  fs.rmSync(root, { recursive: true, force: true });
});

describe('local secret-safe handoff snapshots', () => {
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

  it('rejects a fully rehashed replacement manifest that differs from the agreed offer summary', async () => {
    const changed = 'new bytes';
    await fs.promises.writeFile(path.join(snapshot.root, 'files/new.txt'), changed);
    const replacement = rehash({
      ...snapshot.manifest, files: [{ ...snapshot.manifest.files[0], sha256: hash(changed) }],
    });
    await expect(verifyHandoffSnapshot(snapshot.root, replacement, summary(snapshot.manifest))).rejects.toMatchObject({ code: 'hash_mismatch' });
  });
});
