import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { readOnlyGit, readOnlyRepositoryChanges, readOnlyRepositoryRoot } from './read-only-repository-changes';
import * as worktreeFiles from './read-only-worktree-file';

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
  it.each((['branch', 'session', 'turn'] as const).flatMap((scope) => [false, true].map((empty) => ({ scope, empty }))))('pairs a unique identical live $scope move with endpoint-bound metadata, empty=$empty', async ({ scope, empty }) => {
    await fs.writeFile(path.join(root, 'old-name'), empty ? '' : 'same content\n');
    await git('add', '.');
    const from = await tree();
    await fs.rename(path.join(root, 'old-name'), path.join(root, 'new-name'));
    const before = await snapshot(root);
    const comparison = { root, from, identity: 'selected-run' };
    const result = await readOnlyRepositoryChanges(comparison, { scope });
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({ path: 'new-name', oldPath: 'old-name', status: 'renamed', additions: 0, deletions: 0, countsKnown: true });
    expect(result.diffstat).toEqual({ additions: 0, deletions: 0, knownFiles: 1 });
    const patch = await readOnlyRepositoryChanges(comparison, { scope, fileKey: result.files[0].fileKey });
    expect(patch.patch).toEqual({ fileKey: result.files[0].fileKey, state: 'text', text: 'rename from old-name\nrename to new-name\n' });
    expect(await snapshot(root)).toEqual(before);
  });
  it.each(['duplicate source', 'duplicate destination', 'edited destination', 'unknown addition', 'private path'] as const)('does not guess a live move with %s', async (condition) => {
    await fs.writeFile(path.join(root, 'old-name'), 'same content\n');
    if (condition === 'duplicate source') await fs.writeFile(path.join(root, 'copy'), 'same content\n');
    await git('add', '.');
    const from = await tree();
    await fs.rename(path.join(root, 'old-name'), path.join(root, 'new-name'));
    if (condition === 'duplicate destination') await fs.writeFile(path.join(root, 'second-new'), 'same content\n');
    if (condition === 'edited destination') await fs.writeFile(path.join(root, 'new-name'), 'different content\n');
    if (condition === 'unknown addition') await fs.symlink('/no-target-reads', path.join(root, 'link'));
    if (condition === 'private path') await fs.writeFile(path.join(root, '.env'), 'WITHHELD_METADATA');
    const before = await snapshot(root);
    const result = await readOnlyRepositoryChanges({ root, from, identity: 'selected-run' }, { scope: 'branch' });
    expect(result.files.some((f) => f.status === 'renamed' || f.oldPath)).toBe(false);
    expect(result.files.find((f) => f.path === 'new-name')?.status).toBe('added');
    expect(result.files.find((f) => f.path === 'old-name')?.status).toBe('deleted');
    expect(JSON.stringify(result)).not.toContain('WITHHELD_METADATA');
    if (condition === 'unknown addition') expect(result.files.find((f) => f.path === 'link')).toMatchObject({ evidence: 'unsafe', countsKnown: false });
    expect(await snapshot(root)).toEqual(before);
  });
  it.each(['source reappeared', 'destination changed source', 'destination edited', 'destination removed', 'source filtered', ...(process.platform === 'win32' ? [] : ['mode changed' as const])] as const)('refuses an opened exact-rename witness when %s', async (condition) => {
    await fs.writeFile(path.join(root, 'old-name'), 'same content\n');
    await fs.writeFile(path.join(root, 'different-source'), 'other content\n');
    await git('add', '.');
    const from = await tree();
    await fs.rename(path.join(root, 'old-name'), path.join(root, 'new-name'));
    const comparison = { root, from, identity: 'selected-run' };
    const result = await readOnlyRepositoryChanges(comparison, { scope: 'branch' });
    const fileKey = result.files.find((f) => f.path === 'new-name')!.fileKey;
    if (condition === 'source reappeared') await fs.writeFile(path.join(root, 'old-name'), 'same content\n');
    if (condition === 'destination changed source') {
      await fs.rm(path.join(root, 'different-source'));
      await fs.writeFile(path.join(root, 'new-name'), 'other content\n');
    }
    if (condition === 'destination edited') await fs.writeFile(path.join(root, 'new-name'), 'edited content\n');
    if (condition === 'destination removed') await fs.rm(path.join(root, 'new-name'));
    if (condition === 'source filtered') await fs.writeFile(path.join(root, '.gitattributes'), 'old-name filter=private\n');
    if (condition === 'mode changed') await fs.chmod(path.join(root, 'new-name'), 0o755);
    const patch = await readOnlyRepositoryChanges(comparison, { scope: 'branch', fileKey });
    expect(patch.patch).toEqual({ fileKey, state: condition === 'source filtered' ? 'filtered' : 'stale' });
  });
  it.each(['source', 'destination'] as const)('rechecks both endpoints, refuses a changed %s and honors revocation during revalidation', async (endpoint) => {
    await fs.writeFile(path.join(root, 'old-name'), 'same content\n');
    await git('add', '.');
    const from = await tree();
    await fs.rename(path.join(root, 'old-name'), path.join(root, 'new-name'));
    const comparison = { root, from, identity: 'selected-run' };
    const read = worktreeFiles.readOnlyWorktreeFile;
    const spy = vi.spyOn(worktreeFiles, 'readOnlyWorktreeFile').mockImplementation(async (...args) => {
      if (endpoint === 'destination' && args[1] === 'new-name' && spy.mock.calls.filter((call) => call[1] === 'new-name').length === 2) await fs.writeFile(path.join(root, 'new-name'), 'changed destination\n');
      const result = await read(...args);
      if (endpoint === 'source' && args[1] === 'new-name' && spy.mock.calls.filter((call) => call[1] === 'new-name').length === 2) await fs.writeFile(path.join(root, 'old-name'), 'recreated\n');
      return result;
    });
    const list = await readOnlyRepositoryChanges(comparison, { scope: 'branch' });
    expect(list.files.some((f) => f.status === 'renamed')).toBe(false);
    expect(spy.mock.calls.filter((call) => call[1] === 'old-name' && call[2] === 0)).toHaveLength(endpoint === 'source' ? 2 : 1);
    await fs.rm(path.join(root, 'old-name'), { force: true });
    await fs.writeFile(path.join(root, 'new-name'), 'same content\n');
    let allowed = true;
    spy.mockImplementation(async (...args) => {
      const result = await read(...args);
      if (args[1] === 'old-name' && args[2] === 0) allowed = false;
      return result;
    });
    await expect(readOnlyRepositoryChanges(comparison, { scope: 'branch' }, () => allowed)).rejects.toThrow('read_revoked');
  });
  it('preserves ambiguous empty-file presence changes as known zero-line additions/deletions', async () => {
    await fs.writeFile(path.join(root, 'old-name'), '');
    await fs.writeFile(path.join(root, 'copy'), '');
    await git('add', '.');
    const from = await tree();
    await fs.rename(path.join(root, 'old-name'), path.join(root, 'new-name'));
    const result = await readOnlyRepositoryChanges({ root, from, identity: 'selected-run' }, { scope: 'branch' });
    expect(result.files.map((file) => [file.path, file.status, file.countsKnown])).toEqual([['new-name', 'added', true], ['old-name', 'deleted', true]]);
    expect(result.diffstat).toEqual({ additions: 0, deletions: 0, knownFiles: 2 });
  });
  it('pages the paired representation and derives its diffstat from represented changes', async () => {
    await fs.writeFile(path.join(root, 'old-name'), 'same content\n');
    await git('add', '.');
    const from = await tree();
    await fs.rename(path.join(root, 'old-name'), path.join(root, 'new-name'));
    for (let i = 0; i < 50; i++) await fs.writeFile(path.join(root, `extra-${i}`), `extra content ${i}\n`);
    const comparison = { root, from, identity: 'selected-run' };
    const first = await readOnlyRepositoryChanges(comparison, { scope: 'branch' });
    const last = await readOnlyRepositoryChanges(comparison, { scope: 'branch', offset: 50 });
    expect(first).toMatchObject({ totalFiles: 51, nextOffset: 50, diffstat: { additions: 50, deletions: 0, knownFiles: 51 } });
    expect(last).toMatchObject({ totalFiles: 51, nextOffset: null, diffstat: first.diffstat });
    expect([...first.files, ...last.files].filter((f) => f.status === 'renamed')).toHaveLength(1);
  });
  it('bounds endpoint rechecks and keeps unpaired line counts honest', async () => {
    for (let i = 0; i < 33; i++) await fs.writeFile(path.join(root, `old-${i}`), `unique ${i}\n`);
    await git('add', '.');
    const from = await tree();
    for (let i = 0; i < 33; i++) await fs.rename(path.join(root, `old-${i}`), path.join(root, `new-${i}`));
    const result = await readOnlyRepositoryChanges({ root, from, identity: 'selected-run' }, { scope: 'branch' });
    expect(result.files.filter((f) => f.status === 'renamed')).toHaveLength(32);
    expect(result.files.filter((f) => f.status === 'added')).toHaveLength(1);
    expect(result.files.filter((f) => f.status === 'deleted')).toHaveLength(1);
    expect(result.diffstat).toEqual({ additions: 1, deletions: 1, knownFiles: 34 });
  });
  it('keeps a configured-filter move unpaired without running a filter', async () => {
    await fs.writeFile(path.join(root, 'old-name'), 'same content\n');
    await fs.writeFile(path.join(root, '.gitattributes'), 'new-name filter=private\n');
    await git('add', '.');
    const from = await tree();
    await fs.rename(path.join(root, 'old-name'), path.join(root, 'new-name'));
    const result = await readOnlyRepositoryChanges({ root, from, identity: 'selected-run' }, { scope: 'branch' });
    expect(result.files.some((f) => f.status === 'renamed')).toBe(false);
    expect(result.files.find((f) => f.path === 'new-name')).toMatchObject({ evidence: 'filtered', countsKnown: false });
  });
  it('redacts and sanitizes exact-rename metadata using display labels, never raw endpoint names', async () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const old = `old-${token}`, next = process.platform === 'win32' ? 'new-name' : 'new\nname';
    const label = process.platform === 'win32' ? 'new-name' : 'new name';
    await fs.writeFile(path.join(root, old), 'same content\n');
    await git('add', '.');
    const from = await tree();
    await fs.rename(path.join(root, old), path.join(root, next));
    const comparison = { root, from, identity: 'selected-run' };
    const result = await readOnlyRepositoryChanges(comparison, { scope: 'branch' });
    expect(result.files[0]).toMatchObject({ path: label, status: 'renamed' });
    const patch = await readOnlyRepositoryChanges(comparison, { scope: 'branch', fileKey: result.files[0].fileKey });
    expect(patch.patch?.text).toContain(`rename to ${label}\n`);
    expect(JSON.stringify({ result, patch })).not.toContain(token);
  });
  it.each([false, true])('keeps changed link-own destinations refused with unknown counts, saved=%s', async (saved) => {
    const file = path.join(root, 'link');
    await fs.symlink('UNSHARED_LINK_DESTINATION', file);
    await git('add', '.');
    const from = await tree();
    await fs.unlink(file);
    await fs.symlink('CHANGED_UNSHARED_DESTINATION', file);
    let to: string | undefined;
    if (saved) { await git('add', '.'); to = await tree(); }
    const comparison = { root, from, to, identity: 'selected-run' };
    const result = await readOnlyRepositoryChanges(comparison, { scope: saved ? 'turn' : 'branch' });
    expect(result.files[0]).toMatchObject({ path: 'link', evidence: 'unsafe', countsKnown: false });
    expect(result.diffstat).toEqual({ additions: 0, deletions: 0, knownFiles: 0 });
    const patch = await readOnlyRepositoryChanges(comparison, { scope: saved ? 'turn' : 'branch', fileKey: result.files[0].fileKey });
    expect(patch.patch?.state).toBe('unsafe');
    expect(JSON.stringify({ result, patch })).not.toMatch(/UNSHARED_LINK_DESTINATION|CHANGED_UNSHARED_DESTINATION/);
  });
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
    'const apiKey = ("PRIVATE_PAREN_VALUE");',
    'const apiKey = "PREFIX" /* comment */ + "PRIVATE_COMMENT_TAIL";',
    'const apiKey = "PREFIX" // comment\n + "PRIVATE_LINE_COMMENT_TAIL";',
    'const apiKey = condition ? "PRIVATE_TRUE_VALUE" : "PRIVATE_FALSE_VALUE";',
    'const apiKey = storedValue || "PRIVATE_FALLBACK_VALUE";',
    'const apiKey = "PREFIX" /* comment */ .concat("PRIVATE_METHOD_TAIL");',
    'apiKey += "PRIVATE_APPEND_VALUE";',
    'apiKey ??= ("PRIVATE_ASSIGN_VALUE");',
    'config["apiKey"] = "PRIVATE_INDEXED_VALUE";',
    'os.environ["API_KEY"] = "PRIVATE_ENV_VALUE";',
    'config["api key"] = "PRIVATE_SPACED_KEY_VALUE";',
    'credentials = "PUBLIC_USER", "PRIVATE_TUPLE_VALUE"',
    'credentials = "PUBLIC_USER", "PRIVATE_TUPLE_VALUE";',
    'apiKey *= "PRIVATE_MULTIPLY_VALUE";',
    'apiKey /= "PRIVATE_DIVIDE_VALUE";',
    'apiKey <<= "PRIVATE_SHIFT_VALUE";',
    'config.apiKey ||= "PRIVATE_MEMBER_VALUE";',
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
  it.each([
    String.raw`{"api\u004bey": "PRIVATE_JSON_VALUE"}`,
    String.raw`config["api\x4bey"] = "PRIVATE_HEX_VALUE";`,
    String.raw`config["api\u{4b}ey"] = "PRIVATE_CODEPOINT_VALUE";`,
    String.raw`config["api\U0000004bey"] = "PRIVATE_LONG_UNICODE_VALUE"`,
    String.raw`config["api\N{LATIN CAPITAL LETTER K}ey"] = "PRIVATE_NAMED_VALUE"`,
    String.raw`config["\141piKey"] = "PRIVATE_OCTAL_VALUE";`,
    String.raw`const api\u004bey = "PRIVATE_IDENTIFIER_VALUE";`,
    String.raw`config["\u0061\u0070\u0069\u004b\u0065\u0079"] = "PRIVATE_FULLY_ENCODED_VALUE";`,
    'const api\\\nKey = "PRIVATE_CONTINUED_IDENTIFIER_VALUE";',
  ])('withholds unclassified escaped key or identifier syntax: %s', async (secret) => {
    await fs.writeFile(path.join(root, 'source.txt'), secret + '\nconst ordinary = 1;\n');
    await git('add', '.');
    const from = await tree();
    await fs.writeFile(path.join(root, 'source.txt'), secret + '\nconst ordinary = 2;\n');
    const comparison = { root, from, identity: 'run' };
    const result = await readOnlyRepositoryChanges(comparison, { scope: 'branch' });
    expect(result.files[0]).toMatchObject({ status: 'modified', countsKnown: true });
    const patch = await readOnlyRepositoryChanges(comparison, { scope: 'branch', fileKey: result.files[0].fileKey });
    expect.soft(JSON.stringify(patch)).not.toContain('PRIVATE_');
    expect.soft(patch.patch).toMatchObject({ state: 'unsafe', redacted: true });
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
    expect(result.diffstat).toEqual({ additions: 56, deletions: 1, knownFiles: 57 });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_VALUE');
    const rest = await readOnlyRepositoryChanges(comparison, { scope: 'turn', offset: 50 });
    expect(rest.files).toHaveLength(7);
    expect(rest.nextOffset).toBeNull();
    expect(rest.diffstat).toEqual(result.diffstat);
    expect(await snapshot(root)).toEqual(before);
    await fs.symlink('/private/no-reads', path.join(root, 'unsafe-link'));
    const live = await readOnlyRepositoryChanges({ root, from, identity: 'selected-run' }, { scope: 'branch', offset: 50 });
    expect(live.files.find((f) => f.path === 'unsafe-link')).toMatchObject({ evidence: 'unsafe', status: 'unknown', countsKnown: false });
    expect(live.diffstat).toEqual({ additions: 56, deletions: 1, knownFiles: 57 });
    expect(live.totalFiles).toBe(58);
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
  it('retains saved-turn edited-rename counts and text instead of applying the exact-live rule', async () => {
    const original = Array.from({ length: 20 }, (_, i) => `line ${i}\n`).join('');
    await fs.writeFile(path.join(root, 'old-name'), original);
    await git('add', '.');
    const from = await tree();
    await fs.rename(path.join(root, 'old-name'), path.join(root, 'new-name'));
    await fs.writeFile(path.join(root, 'new-name'), original.replace('line 10\n', 'edited line\n'));
    await git('add', '-A');
    const to = await tree();
    const comparison = { root, from, to, identity: 'selected-run' };
    const result = await readOnlyRepositoryChanges(comparison, { scope: 'turn' });
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({ status: 'renamed', oldPath: 'old-name', countsKnown: true, additions: 1, deletions: 1 });
    expect(result.diffstat).toEqual({ additions: 1, deletions: 1, knownFiles: 1 });
    const patch = await readOnlyRepositoryChanges(comparison, { scope: 'turn', fileKey: result.files[0].fileKey });
    expect(patch.patch?.text).toContain('rename from old-name\nrename to new-name\n');
    expect(patch.patch?.text).toContain('+edited line\n');
  });
});
