import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getBranchChanges, getBranchFilePatch, getBranchLog, resolveBaseBranch } from './git-branch';

let repo: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
}
function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), text);
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'git-branch-'));
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.email', 'dev@example.com');
  git('config', 'user.name', 'Dev');
  write('src/app.ts', 'export const a = 1;\n');
  write('README.md', '# demo\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('git branch against main', { timeout: 30_000 }, () => {
  it('finds main as the base', async () => {
    expect(await resolveBaseBranch(repo)).toEqual({ ref: 'main', name: 'main' });
  });

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
    expect(changes).toMatchObject({ available: true, branch: 'agent/work', base: 'main', ahead: 1, uncommitted: 1 });
    expect(changes.files).toEqual([
      { path: 'src/app.ts', status: 'modified', additions: 2, deletions: 1, binary: false },
      { path: 'src/new.ts', status: 'added', additions: 2, deletions: 0, binary: false },
    ]);
  });

  it('gives a patch for a changed file and the text of an untracked one', async () => {
    git('checkout', '-q', '-b', 'agent/work');
    write('src/app.ts', 'export const a = 2;\n');
    write('notes.md', 'hello\n');
    const patch = await getBranchFilePatch(repo, 'src/app.ts');
    expect(patch.patch).toContain('-export const a = 1;');
    expect(patch.patch).toContain('+export const a = 2;');
    expect(await getBranchFilePatch(repo, 'notes.md')).toEqual({ newText: 'hello\n' });
    await expect(getBranchFilePatch(repo, '../outside')).rejects.toThrow('Invalid file path');
  });

  it('logs only the branch\'s own commits', async () => {
    git('checkout', '-q', '-b', 'agent/work');
    write('src/app.ts', 'export const a = 2;\n');
    git('commit', '-q', '-am', 'branch commit');
    const log = await getBranchLog(repo);
    expect(log.map((e) => e.subject)).toEqual(['branch commit']);
  });

  it('says when the folder is not a repository', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'not-git-'));
    try {
      expect(await getBranchChanges(plain)).toMatchObject({ available: false, files: [] });
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  it('reports no base when there is no main or master', async () => {
    git('branch', '-m', 'main', 'trunk');
    expect(await getBranchChanges(repo)).toMatchObject({ available: true, noBase: true, files: [] });
  });
});
