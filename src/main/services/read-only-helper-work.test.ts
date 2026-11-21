import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import nodeFs from 'fs';
import { syncBuiltinESMExports } from 'module';
import type { AgentConfigTarget } from './agent-config-reader';
import { HELPER_TRANSFORM_UNAVAILABLE, readOnlyHelperWork } from './read-only-helper-work';
import * as repository from './read-only-repository-changes';
const m = vi.hoisted(() => ({ base: '', target: vi.fn() }));
vi.mock('./base-dir', () => ({ getBaseDirPath: () => m.base }));
vi.mock('./agent-config-reader', () => ({ resolveAgentConfigTarget: m.target }));
let root: string, project: string, parent: AgentConfigTarget, entry: Parameters<typeof readOnlyHelperWork>[1], inventory: string;
function git(...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile('git', args, { cwd: project, env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, 'empty-gitconfig'), GIT_CONFIG_NOSYSTEM: '1' } }, (error, out) => error ? reject(error) : resolve(out.trim())));
}
async function snapshot(folder: string, prefix = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const item of await fs.readdir(folder, { withFileTypes: true })) {
    const relative = prefix + item.name;
    if (item.isDirectory()) Object.assign(result, await snapshot(path.join(folder, item.name), relative + '/'));
    else result[relative] = item.isSymbolicLink() ? `link:${await fs.readlink(path.join(folder, item.name))}` : (await fs.readFile(path.join(folder, item.name))).toString('base64');
  }
  return result;
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-passive-helper-'));
  m.base = path.join(root, 'profile'); project = path.join(root, 'project');
  await fs.mkdir(m.base); await fs.mkdir(path.join(project, '.clubhouse'), { recursive: true });
  // An empty file, not os.devNull: Git for Windows cannot open \\.\nul as a config file.
  await fs.writeFile(path.join(root, 'empty-gitconfig'), '');
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@invalid');
  await fs.writeFile(path.join(project, '.git', 'info', 'exclude'), '.clubhouse/\n');
  await fs.writeFile(path.join(project, 'ordinary'), 'one\n'); await git('add', '.'); await git('commit', '-m', 'base'); await git('switch', '-c', 'helper');
  const p = { id: 'p1', path: project, name: 'Project' };
  parent = { project: p, agent: { id: 'parent', name: 'Selected', color: 'blue', createdAt: '2026-11-19' } };
  entry = { projectPath: project, config: { id: 'helper', name: 'Helper', parentAgentId: 'parent', branch: 'helper', worktreePath: project, color: 'blue', createdAt: '2026-11-19' } };
  inventory = path.join(project, '.clubhouse', 'agents.json');
  await fs.writeFile(inventory, JSON.stringify([parent.agent, entry.config]));
  await fs.writeFile(path.join(m.base, 'projects.json'), JSON.stringify({ version: 1, projects: [p] }));
  m.target.mockImplementation(async () => ({ project: p, agent: JSON.parse(await fs.readFile(inventory, 'utf8')).find((a: { id: string }) => a.id === 'helper') }));
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
describe('passive direct helper work', () => {
  it('matches clean/dirty/unpushed counts without writing repository/index/config/object bytes', async () => {
    const cleanBefore = await snapshot(root);
    expect(await readOnlyHelperWork(parent, entry, () => true)).toMatchObject({ dirty: 0, unpushed: 0 });
    expect(await snapshot(root)).toEqual(cleanBefore);
    await fs.writeFile(path.join(project, 'ordinary'), 'two\n'); await git('add', '.'); await git('commit', '-m', 'helper work');
    await fs.writeFile(path.join(project, 'untracked'), 'PRIVATE_CONTENT_NOT_SERIALIZED');
    const before = await snapshot(root);
    const result = await readOnlyHelperWork(parent, entry, () => true);
    expect(result).toEqual({ dirty: 1, unpushed: 1, unmerged: null });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_CONTENT');
    expect(await snapshot(root)).toEqual(before);
    expect(m.target).toHaveBeenCalledWith('helper', undefined, { strict: true });
  });
  it('shares the local classification of generated bridge configuration and real user changes', async () => {
    await fs.writeFile(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { clubhouse: { command: 'node', args: ['/app/clubhouse-mcp-bridge.js'] } } }));
    expect(await readOnlyHelperWork(parent, entry, () => true)).toMatchObject({ dirty: 0 });
    await fs.writeFile(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { user: { command: 'PRIVATE_COMMAND', env: { PRIVATE: 'VALUE' } } } }));
    expect(await readOnlyHelperWork(parent, entry, () => true)).toMatchObject({ dirty: 1 });
  });
  it('retains staged user MCP work when the worktree was restored to HEAD, without changing either side', async () => {
    const file = path.join(project, '.mcp.json');
    const beforeText = JSON.stringify({ mcpServers: { user: { command: 'before' } } });
    await fs.writeFile(file, beforeText); await git('add', '.mcp.json'); await git('commit', '-m', 'user MCP base');
    await fs.writeFile(file, JSON.stringify({ mcpServers: { user: { command: 'staged-user-change' } } }));
    await git('add', '.mcp.json'); await fs.writeFile(file, beforeText);
    const before = await snapshot(root);
    expect(await readOnlyHelperWork(parent, entry, () => true)).toMatchObject({ dirty: 1 });
    expect(await snapshot(root)).toEqual(before);
  });
  it.runIf(process.platform !== 'win32').each([false, true])('retains config mode-only work (staged=%s) without changing index or worktree', async (staged) => {
    const file = path.join(project, '.mcp.json');
    await fs.writeFile(file, JSON.stringify({ mcpServers: { clubhouse: { command: 'node', args: ['/app/clubhouse-mcp-bridge.js'] } } }), { mode: 0o644 });
    await git('config', 'core.fileMode', 'true'); await git('add', '.mcp.json'); await git('commit', '-m', 'generated MCP base');
    await fs.chmod(file, 0o755); if (staged) await git('add', '.mcp.json');
    const before = await snapshot(root);
    expect(await readOnlyHelperWork(parent, entry, () => true)).toMatchObject({ dirty: 1 });
    expect(await snapshot(root)).toEqual(before);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o755);
  });
  it('still excludes a staged generated-only MCP addition after classifying all stored sides', async () => {
    await fs.writeFile(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { clubhouse: { command: 'node', args: ['/app/clubhouse-mcp-bridge.js'] } } }));
    await git('add', '.mcp.json');
    const before = await snapshot(root);
    expect(await readOnlyHelperWork(parent, entry, () => true)).toMatchObject({ dirty: 0 });
    expect(await snapshot(root)).toEqual(before);
  });
  it('reports unknown when a remote has not been fetched; never contacts it', async () => {
    await git('remote', 'add', 'origin', 'https://not-contacted.invalid/repository');
    const before = await snapshot(root);
    expect(await readOnlyHelperWork(parent, entry, () => true)).toHaveProperty('error');
    expect(await snapshot(root)).toEqual(before);
  });
  it.each(['clean', 'process'])('does not execute a configured %s filter or change disk bytes for dirty counts', async (kind) => {
    await fs.writeFile(path.join(project, 'filtered.data'), 'before\n');
    await fs.writeFile(path.join(project, '.gitattributes'), '*.data filter=passivecanary\n');
    await git('add', '.'); await git('commit', '-m', 'filtered fixture');
    const marker = path.join(project, '.git', 'filter-ran');
    const program = path.join(project, '.git', 'filter-canary.cjs');
    await fs.writeFile(program, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected filter execution'); ${kind === 'process' ? 'process.exit(1);' : 'process.stdin.pipe(process.stdout);'}`);
    const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
    await git('config', `filter.passivecanary.${kind}`, `${quote(process.execPath)} ${quote(program)}`);
    // Same length forces status to hash rather than conclude dirty from size alone.
    await fs.writeFile(path.join(project, 'filtered.data'), 'AFTER!\n');
    await fs.utimes(path.join(project, 'filtered.data'), new Date(0), new Date(0));
    const before = await snapshot(root);
    const result = await readOnlyHelperWork(parent, entry, () => true);
    expect.soft(result).toHaveProperty('error', HELPER_TRANSFORM_UNAVAILABLE);
    expect.soft(await fs.access(marker).then(() => true, () => false)).toBe(false);
    expect.soft(await snapshot(root)).toEqual(before);
  });
  it.each(['clean', 'process'])('cannot run a %s filter introduced after attributes were read', async (kind) => {
    await fs.writeFile(path.join(project, 'filtered.data'), 'before\n');
    await fs.writeFile(path.join(project, '.gitattributes'), '');
    await git('add', '.'); await git('commit', '-m', 'late filter fixture');
    const marker = path.join(project, '.git', 'late-filter-ran');
    const program = path.join(project, '.git', 'late-filter.cjs');
    await fs.writeFile(program, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected filter execution'); ${kind === 'process' ? 'process.exit(1);' : 'process.stdin.pipe(process.stdout);'}`);
    await fs.writeFile(path.join(project, 'filtered.data'), 'AFTER!\n');
    await fs.utimes(path.join(project, 'filtered.data'), new Date(0), new Date(0));
    const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
    const actual = repository.readOnlyGit;
    let fixtureAfter: Record<string, string> | undefined;
    vi.spyOn(repository, 'readOnlyGit').mockImplementation(async (...args) => {
      const bytes = await actual(...args);
      if (args[1][0] === 'check-attr') {
        await git('config', `filter.late.${kind}`, `${quote(process.execPath)} ${quote(program)}`);
        await fs.writeFile(path.join(project, '.gitattributes'), '*.data filter=late\n');
        fixtureAfter = await snapshot(root);
      }
      return bytes;
    });
    await readOnlyHelperWork(parent, entry, () => true);
    expect(fixtureAfter).toBeDefined();
    expect.soft(await fs.access(marker).then(() => true, () => false)).toBe(false);
    expect.soft(await snapshot(root)).toEqual(fixtureAfter);
  });
  it('counts staged work even when the worktree matches HEAD and preserves staged rename grouping', async () => {
    await fs.writeFile(path.join(project, 'ordinary'), 'two\n'); await git('add', 'ordinary');
    await fs.writeFile(path.join(project, 'ordinary'), 'one\n');
    expect(await readOnlyHelperWork(parent, entry, () => true)).toMatchObject({ dirty: 1 });
    await git('restore', '--staged', 'ordinary');
    await git('mv', 'ordinary', 'renamed');
    expect(await readOnlyHelperWork(parent, entry, () => true)).toMatchObject({ dirty: 1 });
  });
  it('compares CRLF content using the host’s normalization without executing filters', async () => {
    await git('config', 'core.autocrlf', 'true');
    await fs.writeFile(path.join(project, 'ordinary'), 'one\r\n');
    expect(await readOnlyHelperWork(parent, entry, () => true)).toMatchObject({ dirty: 0 });
  });
  it('admits a root whose JS and native realpaths differ in form, and still refuses a different native root', async () => {
    // Windows 8.3 names (RUNNER~1) are expanded by the native realpath but not by the JS walk. Model the same folder
    // reported in two forms: the JS realpath adds a trailing separator; the native realpath is untouched.
    await fs.writeFile(path.join(project, 'ordinary'), 'two\n');
    const js = nodeFs.realpathSync, native = nodeFs.realpathSync.native;
    const variant = Object.assign((p: nodeFs.PathLike, options?: never) => { const real = js(p, options) as string; return real.startsWith(project) ? real + path.sep : real; }, { native });
    vi.spyOn(nodeFs, 'realpathSync').mockImplementation(variant as never); syncBuiltinESMExports();
    try {
      expect(await readOnlyHelperWork(parent, entry, () => true)).toEqual({ dirty: 1, unpushed: 0, unmerged: null });
      // A native root that is actually different is still refused at the final fence.
      const other = await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-other-root-'));
      Object.assign(nodeFs.realpathSync, { native: (p: nodeFs.PathLike, options?: never) => String(p) === project ? other : native(p, options) }); syncBuiltinESMExports();
      expect(await readOnlyHelperWork(parent, entry, () => true)).toMatchObject({ dirty: 0, unpushed: 0, unmerged: null, error: expect.any(String) });
      await fs.rm(other, { recursive: true, force: true });
    } finally { vi.mocked(nodeFs.realpathSync).mockRestore(); syncBuiltinESMExports(); }
  });

  it('refuses an unrelated helper before Git or file-content reads', async () => {
    entry.config.parentAgentId = 'other';
    await fs.writeFile(inventory, JSON.stringify([parent.agent, entry.config]));
    const spy = vi.spyOn(repository, 'readOnlyGit');
    expect(await readOnlyHelperWork(parent, entry, () => true)).toHaveProperty('error');
    expect(spy).not.toHaveBeenCalled();
  });
  it('withholds work after the actual helper inventory is released during an actual Git await', async () => {
    const actual = repository.readOnlyGit;
    vi.spyOn(repository, 'readOnlyGit').mockImplementation(async (...args) => {
      const bytes = await actual(...args);
      if (args[1][0] === 'ls-files') await fs.writeFile(inventory, JSON.stringify([parent.agent, { ...entry.config, parentAgentId: undefined }]));
      return bytes;
    });
    expect(await readOnlyHelperWork(parent, entry, () => true)).toHaveProperty('error');
  });
  it('withholds evidence when authority is revoked during an actual Git await', async () => {
    let allowed = true;
    const actual = repository.readOnlyGit;
    vi.spyOn(repository, 'readOnlyGit').mockImplementation(async (...args) => { const bytes = await actual(...args); allowed = false; return bytes; });
    expect(await readOnlyHelperWork(parent, entry, () => allowed)).toHaveProperty('error');
  });
});
