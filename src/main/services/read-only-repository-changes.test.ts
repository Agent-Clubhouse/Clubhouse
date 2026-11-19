import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { readOnlyGit, readOnlyRepositoryChanges, readOnlyRepositoryRoot } from './read-only-repository-changes';

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
afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });
const tree = () => git('write-tree');
describe('passive repository comparison', () => {
  it.each([0, 1, 2, 3, 4, 5])('isolates selected repository reads from inherited Git directory/worktree/index/object/config overrides, variant %s', async (variant) => {
    await fs.writeFile(path.join(root, 'selected'), 'SELECTED\n');
    await git('add', '.');
    const from = await tree();
    await git('config', 'core.fileMode', 'false');
    const other = path.join(root, 'other');
    await fs.mkdir(other);
    const otherGit = (...args: string[]) => new Promise<string>((resolve, reject) => execFile('git', args, { cwd: other }, (error, out) => error ? reject(error) : resolve(out.trim())));
    await otherGit('init', '-b', 'main');
    await fs.writeFile(path.join(other, 'UNRELATED'), 'PRIVATE_OTHER_REPOSITORY');
    await otherGit('add', '.');
    await fs.writeFile(path.join(root, 'selected'), 'SELECTED_CHANGED\n');
    const vars = [
      { GIT_DIR: path.join(other, '.git'), GIT_WORK_TREE: other },
      { GIT_WORK_TREE: other }, { GIT_INDEX_FILE: path.join(other, '.git', 'index') },
      { GIT_COMMON_DIR: path.join(other, '.git') }, { GIT_OBJECT_DIRECTORY: path.join(other, '.git', 'objects') },
      { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fileMode', GIT_CONFIG_VALUE_0: 'true' },
    ][variant];
    for (const [key, value] of Object.entries(vars)) vi.stubEnv(key, value!);
    expect(await readOnlyRepositoryRoot(root)).toBe(await fs.realpath(root));
    expect((await readOnlyGit(root, ['ls-files', '--cached'])).toString().trim()).toBe('selected');
    expect((await readOnlyGit(root, ['config', '--bool', 'core.fileMode'])).toString().trim()).toBe('false');
    const result = await readOnlyRepositoryChanges({ root, from, identity: 'run' }, { scope: 'branch' });
    expect(result.files.find((f) => f.path === 'selected')).toMatchObject({ additions: 1, deletions: 1 });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_OTHER_REPOSITORY');
    vi.unstubAllEnvs();
  });
  it('does not lazy-fetch missing promisor objects or execute a remote/auth helper or write repository bytes', async () => {
    await fs.writeFile(path.join(root, 'selected'), 'promised content\n');
    await git('add', '.');
    await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid', 'commit', '-m', 'fixture');
    const from = await git('rev-parse', 'HEAD');
    const object = await git('rev-parse', 'HEAD:selected');
    const marker = path.join(root, '.git', 'lazy-helper-ran');
    const helper = path.join(root, '.git', 'passive-canary.cjs');
    await fs.writeFile(helper, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected helper'); process.exit(1);`);
    const extArg = (value: string) => value.replace(/%/g, '%%').replace(/ /g, '% ');
    await git('config', 'remote.origin.url', `ext::${extArg(process.execPath)} ${extArg(helper)}`);
    await git('config', 'protocol.ext.allow', 'always');
    await git('config', 'remote.origin.promisor', 'true');
    await git('config', 'remote.origin.partialclonefilter', 'blob:none');
    await git('config', 'extensions.partialClone', 'origin');
    await fs.rm(path.join(root, '.git', 'objects', object.slice(0, 2), object.slice(2)));
    const before = await snapshot(root);
    await expect(readOnlyGit(root, ['cat-file', '-p', object])).rejects.toThrow();
    await expect(readOnlyRepositoryChanges({ root, from, identity: 'run' }, { scope: 'branch' })).rejects.toThrow();
    await expect(fs.access(marker)).rejects.toThrow();
    expect(await snapshot(root)).toEqual(before);
  });
  it.each(['"', "'", '`'])('redacts complete escaped %s credentials before generic substitutions, including unchanged hunk context', async (quote) => {
    const before = `const apiKey = ${quote}PREFIX\\${quote} CREDENTIAL_TAIL\\\nCONTINUED_CREDENTIAL${quote};\nconst ordinary = 1;\n`;
    await fs.writeFile(path.join(root, 'source.txt'), before);
    await git('add', '.');
    const from = await tree();
    await fs.writeFile(path.join(root, 'source.txt'), before.replace('ordinary = 1', 'ordinary = 2'));
    const comparison = { root, from, identity: 'run' };
    const result = await readOnlyRepositoryChanges(comparison, { scope: 'branch' });
    const patch = await readOnlyRepositoryChanges(comparison, { scope: 'branch', fileKey: result.files[0].fileKey });
    expect(patch.patch?.text).toContain('ordinary = 2');
    expect(patch.patch?.text).not.toMatch(/CREDENTIAL_TAIL|CONTINUED_CREDENTIAL/);
  });
  it.each([
    'const credentials = ["PRIVATE_ARRAY_VALUE"];',
    '{"ordinary": 1, "credentials": ["PRIVATE_LATER_FIELD"]}',
    'const apiKey: string = "PRIVATE_TYPED_VALUE";',
    'const apiKey = Buffer.from("PRIVATE_FACTORY_VALUE");',
    'const apiKey = "PRIVATE_PREFIX" + "PRIVATE_TAIL";',
    'const apiKey = `PRIVATE_TEMPLATE${other}`;',
    'const apiKey = "PRIVATE_UNFINISHED',
  ])('withholds ambiguous credential initializer text while preserving file change metadata: %s', async (secret) => {
    await fs.writeFile(path.join(root, 'source.txt'), secret + '\nconst ordinary = 1;\n');
    await git('add', '.');
    const from = await tree();
    await fs.writeFile(path.join(root, 'source.txt'), secret + '\nconst ordinary = 2;\n');
    const comparison = { root, from, identity: 'run' };
    const result = await readOnlyRepositoryChanges(comparison, { scope: 'branch' });
    expect(result.files[0]).toMatchObject({ status: 'modified', countsKnown: true });
    const patch = await readOnlyRepositoryChanges(comparison, { scope: 'branch', fileKey: result.files[0].fileKey });
    expect(patch.patch).toMatchObject({ state: 'unsafe', redacted: true });
    expect(JSON.stringify(patch)).not.toContain('PRIVATE_');
  });
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
