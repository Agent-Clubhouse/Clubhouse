import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getBranchChanges, getBranchFilePatch, resolveMergeBase } from './git-service';

let repo: string;
const temps: string[] = [];

function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}
function git(...args: string[]): string {
  return gitIn(repo, ...args);
}
function write(file: string, text: string | Buffer, dir = repo): void {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
}
function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(d);
  return d;
}
function configure(dir: string): void {
  gitIn(dir, 'config', 'core.autocrlf', 'false');
  gitIn(dir, 'config', 'user.email', 'dev@example.com');
  gitIn(dir, 'config', 'user.name', 'Dev');
}

beforeEach(() => {
  repo = tmp('git-branch-');
  git('init', '-q', '-b', 'main');
  configure(repo);
  write('src/app.ts', 'export const a = 1;\n');
  write('README.md', '# demo\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
});

afterEach(() => {
  for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A bare origin with this repo's main pushed, and a second clone that can move origin on. */
function withOrigin(defaultBranch = 'main'): { other: string } {
  const remote = tmp('git-origin-');
  gitIn(remote, 'init', '-q', '--bare', '-b', defaultBranch);
  git('remote', 'add', 'origin', remote);
  git('push', '-q', 'origin', `HEAD:${defaultBranch}`);
  git('fetch', '-q', 'origin');
  git('remote', 'set-head', 'origin', defaultBranch);
  const other = tmp('git-other-');
  execFileSync('git', ['clone', '-q', remote, other]);
  configure(other);
  return { other };
}

describe('git branch against main', { timeout: 30_000 }, () => {
  it('lists committed, uncommitted and untracked changes since the merge base, not main\'s later commits', async () => {
    git('checkout', '-q', '-b', 'agent/work');
    write('src/app.ts', 'export const a = 2;\nexport const b = 3;\n');
    git('commit', '-q', '-am', 'change app');
    // main moves on after the branch left it; that isn't the branch's change.
    git('checkout', '-q', 'main');
    write('README.md', '# demo\nmore\n');
    git('commit', '-q', '-am', 'main moves');
    git('checkout', '-q', 'agent/work');
    write('src/new.ts', 'one\ntwo\n');

    const changes = await getBranchChanges(repo);
    expect(changes).toMatchObject({ available: true, branch: 'agent/work', base: 'main' });
    expect(changes.files).toEqual([
      { path: 'src/app.ts', status: 'modified', additions: 2, deletions: 1, binary: false },
      { path: 'src/new.ts', status: 'added', additions: 2, deletions: 0, binary: false },
    ]);
  });

  it('measures against origin when the local main is behind it', async () => {
    const { other } = withOrigin();
    // origin/main moves on; the local main stays where it was.
    write('README.md', '# demo\nfrom origin\n', other);
    gitIn(other, 'commit', '-q', '-am', 'origin moves');
    gitIn(other, 'push', '-q', 'origin', 'main');
    git('fetch', '-q', 'origin');
    // The agent branches from the newer origin/main and adds one file.
    git('checkout', '-q', '-b', 'agent/work', 'origin/main');
    write('src/agent.ts', 'x\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'agent work');

    const base = await resolveMergeBase(repo);
    expect(base?.sha).toBe(git('rev-parse', 'origin/main'));
    const changes = await getBranchChanges(repo);
    // origin's README change is not the agent's work.
    expect(changes.files.map((f) => f.path)).toEqual(['src/agent.ts']);
  });

  it('follows origin/HEAD when the default branch isn\'t main', async () => {
    git('branch', '-m', 'main', 'trunk');
    withOrigin('trunk');
    git('checkout', '-q', '-b', 'agent/work');
    write('src/app.ts', 'export const a = 2;\n');
    const changes = await getBranchChanges(repo);
    expect(changes).toMatchObject({ base: 'trunk' });
    expect(changes.files.map((f) => f.path)).toEqual(['src/app.ts']);
  });

  it('shows a detached HEAD as its short sha', async () => {
    write('src/app.ts', 'export const a = 2;\n');
    git('commit', '-q', '-am', 'second');
    git('checkout', '-q', '--detach', 'HEAD');
    const changes = await getBranchChanges(repo);
    expect(changes.branch).toBe(git('rev-parse', '--short', 'HEAD'));
    expect(changes.branch).not.toBe('HEAD');
  });

  it('gives a patch for a changed file and the text of an untracked one', async () => {
    git('checkout', '-q', '-b', 'agent/work');
    write('src/app.ts', 'export const a = 2;\n');
    write('notes.md', 'hello\n');
    const patch = await getBranchFilePatch(repo, 'src/app.ts');
    expect(patch.patch).toContain('-export const a = 1;');
    expect(patch.patch).toContain('+export const a = 2;');
    expect(await getBranchFilePatch(repo, 'notes.md')).toEqual({ newText: 'hello\n' });
    await expect(getBranchFilePatch(repo, '../outside')).rejects.toThrow();
  });

  it('reports large and binary untracked files without reading them as text', async () => {
    write('big.log', Buffer.alloc(1024 * 1024 + 10, 0x61));
    write('img.bin', Buffer.from([1, 0, 2, 0]));
    expect(await getBranchFilePatch(repo, 'big.log')).toEqual({ tooLarge: true });
    expect(await getBranchFilePatch(repo, 'img.bin')).toEqual({ binary: true });
  });

  // Windows runners can't make symlinks without developer mode.
  (process.platform === 'win32' ? it.skip : it)('shows an untracked symlink as a link and never reads what it points at', async () => {
    const outside = tmp('git-outside-');
    write('secret.txt', 'do not read\n', outside);
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(repo, 'leak.txt'));
    const patch = await getBranchFilePatch(repo, 'leak.txt');
    expect(patch).toEqual({ link: path.join(outside, 'secret.txt') });
    expect(JSON.stringify(patch)).not.toContain('do not read');
  });

  it('rejects a base that looks like an option', async () => {
    await expect(resolveMergeBase(repo, '--output=/tmp/x')).rejects.toThrow('Invalid base');
    await expect(resolveMergeBase(repo, 'main:secret')).rejects.toThrow('Invalid base');
  });

  it('says when the folder is not a repository', async () => {
    expect(await getBranchChanges(tmp('not-git-'))).toMatchObject({ available: false, files: [] });
  });

  it('reports no base when there is no main or master', async () => {
    git('branch', '-m', 'main', 'trunk');
    expect(await getBranchChanges(repo)).toMatchObject({ available: true, noBase: true, files: [] });
  });

  it('shares one read between concurrent callers', async () => {
    const [a, b] = [getBranchChanges(repo), getBranchChanges(repo)];
    expect(a).toBe(b);
    await a;
  });
});
