import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { readOnlyRepositoryChanges, readOnlyRepositoryRoot } from './read-only-repository-changes';

let root: string;
function git(...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile('git', args, { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }, (error, out) => error ? reject(error) : resolve(out.trim())));
}
async function snapshot(folder: string, prefix = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
    const rel = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(result, await snapshot(path.join(folder, entry.name), rel + '/'));
    else result[rel] = entry.isSymbolicLink() ? `link:${await fs.readlink(path.join(folder, entry.name))}` : (await fs.readFile(path.join(folder, entry.name))).toString('base64');
  }
  return result;
}
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-passive-changes-')); await git('init', '-b', 'main'); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const tree = () => git('write-tree');
describe('passive repository comparison', () => {
  it('compares tracked, checkpoint-untracked and current-untracked files accurately without writing any worktree/index/object bytes', async () => {
    await fs.writeFile(path.join(root, 'tracked'), 'a\nb\nc\n');
    await fs.writeFile(path.join(root, 'checkpoint-untracked'), 'keep\n');
    await git('add', '.');
    const from = await tree();
    await git('rm', '--cached', 'checkpoint-untracked');
    await fs.writeFile(path.join(root, 'tracked'), 'a\nchanged\nc\n');
    await fs.writeFile(path.join(root, 'new-file'), 'new\n');
    const before = await snapshot(root);
    const comparison = { root, from, identity: 'selected-run' };
    const result = await readOnlyRepositoryChanges(comparison, { scope: 'session' });
    expect(result.files.map((f) => [f.path, f.status, f.additions, f.deletions, f.countsKnown])).toEqual([['new-file', 'added', 1, 0, true], ['tracked', 'modified', 1, 1, true]]);
    const patch = await readOnlyRepositoryChanges(comparison, { scope: 'session', fileKey: result.files[1].fileKey });
    expect(patch.patch).toMatchObject({ state: 'text' });
    expect(patch.patch?.text).toContain('-b\n+changed\n');
    expect(await snapshot(root)).toEqual(before);
    expect((await readOnlyRepositoryChanges({ ...comparison, identity: 'different-run' }, { scope: 'session', fileKey: result.files[1].fileKey })).patch?.state).toBe('stale');
  });
  it('compares immutable turn trees, pages file metadata and reports restricted/unsafe evidence distinctly', async () => {
    await fs.writeFile(path.join(root, 'delete-me'), 'before\n');
    await git('add', '.');
    const from = await tree();
    await fs.rm(path.join(root, 'delete-me'));
    for (let i = 0; i < 56; i++) await fs.writeFile(path.join(root, `file-${i.toString().padStart(2, '0')}`), 'new\n');
    await fs.writeFile(path.join(root, '.env'), 'TOKEN=PRIVATE_VALUE');
    await git('add', '.');
    const to = await tree();
    const before = await snapshot(root);
    const comparison = { root, from, to, identity: 'selected-run' };
    const result = await readOnlyRepositoryChanges(comparison, { scope: 'turn' });
    expect(result.files).toHaveLength(50);
    expect(result.totalFiles).toBe(57);
    expect(result.uncompared).toBe(1);
    expect(result.nextOffset).toBe(50);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_VALUE');
    const rest = await readOnlyRepositoryChanges(comparison, { scope: 'turn', offset: 50 });
    expect(rest.files).toHaveLength(7);
    expect(rest.nextOffset).toBeNull();
    expect(await snapshot(root)).toEqual(before);
    await fs.symlink('/private/no-reads', path.join(root, 'unsafe-link'));
    const live = await readOnlyRepositoryChanges({ root, from, identity: 'selected-run' }, { scope: 'branch', offset: 50 });
    expect(live.files.find((f) => f.path === 'unsafe-link')).toMatchObject({ evidence: 'unsafe', status: 'unknown', countsKnown: false });
  });
  it('distinguishes a nonrepository from a bad or unreadable immutable base', async () => {
    expect(await readOnlyRepositoryRoot(root)).toBe(await fs.realpath(root));
    await expect(readOnlyRepositoryChanges({ root, from: 'caller/ref', identity: 'selected-run' }, { scope: 'branch' })).rejects.toThrow();
    await expect(readOnlyRepositoryChanges({ root, from: 'a'.repeat(40), identity: 'selected-run' }, { scope: 'branch' })).rejects.toThrow();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-not-repo-'));
    try { expect(await readOnlyRepositoryRoot(outside)).toBeNull(); } finally { await fs.rm(outside, { recursive: true, force: true }); }
  });
  it('preserves executable-mode changes and honors the repository’s core.fileMode setting without updating it', async () => {
    await fs.writeFile(path.join(root, 'script'), 'echo ready\n', { mode: 0o644 });
    await git('add', '.');
    const from = await tree();
    await fs.chmod(path.join(root, 'script'), 0o755);
    const comparison = { root, from, identity: 'run' };
    const changed = await readOnlyRepositoryChanges(comparison, { scope: 'branch' });
    expect(changed.files).toHaveLength(1);
    expect(changed.files[0]).toMatchObject({ additions: 0, deletions: 0, status: 'modified', countsKnown: true });
    const patch = await readOnlyRepositoryChanges(comparison, { scope: 'branch', fileKey: changed.files[0].fileKey });
    expect(patch.patch?.text).toContain('old mode 100644\nnew mode 100755');
    await git('config', 'core.fileMode', 'false'); // fixture choice; display must honor it.
    const before = await snapshot(root);
    expect((await readOnlyRepositoryChanges(comparison, { scope: 'branch' })).files).toHaveLength(0);
    expect(await snapshot(root)).toEqual(before);
  });
  it('honors CRLF normalization while refusing to execute configured clean filters, and redacts complete secrets before cutting patch context', async () => {
    await git('config', 'core.autocrlf', 'input');
    await fs.writeFile(path.join(root, 'source'), 'first\nconst apiKey = "OLD_CREDENTIAL";\nlast\n');
    await git('add', '.');
    const from = await tree();
    await fs.writeFile(path.join(root, 'source'), 'first\r\nconst apiKey = "OLD_CREDENTIAL";\r\nlast\r\n');
    const comparison = { root, from, identity: 'run' };
    expect((await readOnlyRepositoryChanges(comparison, { scope: 'branch' })).files).toHaveLength(0);
    await fs.writeFile(path.join(root, 'source'), 'first\r\nconst apiKey = "NEW_CREDENTIAL";\r\nlast\r\n');
    const changed = await readOnlyRepositoryChanges(comparison, { scope: 'branch' });
    const patch = await readOnlyRepositoryChanges(comparison, { scope: 'branch', fileKey: changed.files[0].fileKey });
    expect(JSON.stringify(patch)).not.toMatch(/OLD_CREDENTIAL|NEW_CREDENTIAL/);
    expect(patch.patch?.state).toBe('unsafe');
    await fs.writeFile(path.join(root, '.gitattributes'), 'source filter=private\n');
    await git('config', 'filter.private.clean', 'exit 99'); // A passive read must not invoke this command.
    const filtered = await readOnlyRepositoryChanges(comparison, { scope: 'branch' });
    expect(filtered.files.find((f) => f.path === 'source')).toMatchObject({ evidence: 'filtered', countsKnown: false, status: 'unknown' });
  });
  it('never exposes a credential fragment when the changed hunk starts in the middle of a private key', async () => {
    const block = ['-----BEGIN RSA PRIVATE KEY-----', ...Array.from({ length: 24 }, (_, i) => `BODY_${i}_CREDENTIAL_FRAGMENT`), '-----END RSA PRIVATE KEY-----', 'ordinary before', ''].join('\n');
    await fs.writeFile(path.join(root, 'source.txt'), block);
    await git('add', '.');
    const from = await tree();
    await fs.writeFile(path.join(root, 'source.txt'), block.replace('BODY_12_CREDENTIAL_FRAGMENT', 'PRIVATE_CHANGED_CREDENTIAL_FRAGMENT').replace('ordinary before', 'ordinary after'));
    const comparison = { root, from, identity: 'run' };
    const result = await readOnlyRepositoryChanges(comparison, { scope: 'branch' });
    const patch = await readOnlyRepositoryChanges(comparison, { scope: 'branch', fileKey: result.files[0].fileKey });
    expect(patch.patch).toMatchObject({ state: 'text', redacted: true });
    expect(patch.patch?.text).toContain('ordinary after');
    expect(patch.patch?.text).not.toMatch(/BODY_|PRIVATE_CHANGED_CREDENTIAL_FRAGMENT/);
  });
  it('redacts quoted source credential keys with provider prefixes and numeric suffixes', async () => {
    await fs.writeFile(path.join(root, 'source.txt'), 'const awsSecretAccessKey2 = "OLD_PROVIDER_CREDENTIAL";\n');
    await git('add', '.');
    const from = await tree();
    await fs.writeFile(path.join(root, 'source.txt'), 'const awsSecretAccessKey2 = "NEW_PROVIDER_CREDENTIAL";\n');
    const comparison = { root, from, identity: 'run' };
    const result = await readOnlyRepositoryChanges(comparison, { scope: 'branch' });
    const patch = await readOnlyRepositoryChanges(comparison, { scope: 'branch', fileKey: result.files[0].fileKey });
    expect(patch.patch?.state).toBe('unsafe');
    expect(JSON.stringify(patch)).not.toMatch(/OLD_PROVIDER_CREDENTIAL|NEW_PROVIDER_CREDENTIAL/);
  });
  it('retains Git rename metadata for immutable saved-turn comparisons without snapshot writes', async () => {
    await fs.writeFile(path.join(root, 'old-name'), 'same content\n');
    await git('add', '.');
    const from = await tree();
    await fs.rename(path.join(root, 'old-name'), path.join(root, 'new-name'));
    await git('add', '-A');
    const to = await tree();
    const before = await snapshot(root);
    const comparison = { root, from, to, identity: 'run' };
    const result = await readOnlyRepositoryChanges(comparison, { scope: 'turn' });
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({ path: 'new-name', oldPath: 'old-name', status: 'renamed', additions: 0, deletions: 0 });
    const patch = await readOnlyRepositoryChanges(comparison, { scope: 'turn', fileKey: result.files[0].fileKey });
    expect(patch.patch?.text).toContain('rename from old-name\nrename to new-name');
    expect(await snapshot(root)).toEqual(before);
  });
});
