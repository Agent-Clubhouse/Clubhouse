import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  checkpointRef,
  createCheckpoint,
  diffFiles,
  diffPatch,
  isGitWorkTree,
  listCheckpointRefs,
  pruneCheckpoints,
  revertChanges,
} from './checkpoints';

let repo: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
}
function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), text);
}
function read(file: string): string | null {
  const p = path.join(repo, file);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null;
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-checkpoints-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'dev@example.com');
  git('config', 'user.name', 'Dev');
  write('src/app.ts', 'export const a = 1;\n');
  write('README.md', '# demo\n');
  write('.gitignore', 'node_modules/\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('git checkpoints', () => {
  it('detects git work trees', async () => {
    expect(await isGitWorkTree(repo)).toBe(true);
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'not-git-'));
    expect(await isGitWorkTree(plain)).toBe(false);
    fs.rmSync(plain, { recursive: true, force: true });
  });

  it('snapshots tracked and untracked files without touching HEAD, the index or the branch', async () => {
    write('src/app.ts', 'export const a = 2;\n');
    write('notes.txt', 'untracked\n');
    write('node_modules/dep.js', 'ignored\n');
    git('add', 'src/app.ts'); // something staged by the user
    const headBefore = git('rev-parse', 'HEAD');
    const indexBefore = git('diff', '--cached', '--name-only');

    const ref = checkpointRef('agent-1', 's1', 't1', 'start');
    const commit = await createCheckpoint(repo, ref, 'test');

    expect(git('rev-parse', 'HEAD')).toBe(headBefore);
    expect(git('diff', '--cached', '--name-only')).toBe(indexBefore);
    expect(git('rev-parse', ref)).toBe(commit);
    const files = git('ls-tree', '-r', '--name-only', commit).split('\n');
    expect(files).toEqual(expect.arrayContaining(['notes.txt', 'src/app.ts', 'README.md']));
    expect(files).not.toContain('node_modules/dep.js');
    expect(git('show', `${commit}:src/app.ts`)).toBe('export const a = 2;');
  });

  it('diffs a turn and reverts it', async () => {
    const start = await createCheckpoint(repo, checkpointRef('a', 's', 't', 'start'), 'start');
    write('src/app.ts', 'export const a = 3;\nexport const b = 4;\n');
    write('src/new.ts', 'new file\n');
    fs.rmSync(path.join(repo, 'README.md'));
    const end = await createCheckpoint(repo, checkpointRef('a', 's', 't', 'end'), 'end');

    const files = await diffFiles(repo, start, end);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(byPath['src/app.ts']).toMatchObject({ status: 'modified', additions: 2, deletions: 1 });
    expect(byPath['src/new.ts']).toMatchObject({ status: 'added', additions: 1 });
    expect(byPath['README.md']).toMatchObject({ status: 'deleted', deletions: 1 });
    expect(await diffPatch(repo, start, end, 'src/app.ts')).toContain('+export const b = 4;');

    const result = await revertChanges(repo, start, end);
    expect(result.conflicts).toEqual([]);
    expect(result.reverted.sort()).toEqual(['README.md', 'src/app.ts', 'src/new.ts']);
    expect(read('src/app.ts')).toBe('export const a = 1;\n');
    expect(read('src/new.ts')).toBeNull();
    expect(read('README.md')).toBe('# demo\n');
  });

  it('compares against the working tree while a turn is running', async () => {
    const start = await createCheckpoint(repo, checkpointRef('a', 's', 't', 'start'), 'start');
    write('src/app.ts', 'export const a = 9;\n');
    const files = await diffFiles(repo, start);
    expect(files.map((f) => f.path)).toEqual(['src/app.ts']);
  });

  it('refuses files edited after the turn unless forced', async () => {
    const start = await createCheckpoint(repo, checkpointRef('a', 's', 't', 'start'), 'start');
    write('src/app.ts', 'agent edit\n');
    write('README.md', '# agent\n');
    const end = await createCheckpoint(repo, checkpointRef('a', 's', 't', 'end'), 'end');
    write('src/app.ts', 'user edit afterwards\n');

    const result = await revertChanges(repo, start, end);
    expect(result.conflicts).toEqual(['src/app.ts']);
    expect(result.reverted).toEqual(['README.md']);
    expect(read('src/app.ts')).toBe('user edit afterwards\n');

    const forced = await revertChanges(repo, start, end, true);
    expect(forced.reverted).toContain('src/app.ts');
    expect(read('src/app.ts')).toBe('export const a = 1;\n');
  });

  it('lists and prunes an agent\'s checkpoints by turn', async () => {
    for (const t of ['t1', 't2', 't3']) {
      await createCheckpoint(repo, checkpointRef('agent-9', 's', t, 'start'), 'start');
      await createCheckpoint(repo, checkpointRef('agent-9', 's', t, 'end'), 'end');
    }
    await createCheckpoint(repo, checkpointRef('other', 's', 'x', 'start'), 'start');
    const refs = await listCheckpointRefs(repo, 'agent-9');
    expect(refs).toHaveLength(6);
    expect(refs[0]).toMatchObject({ sessionId: 's', phase: 'start' });

    expect(await pruneCheckpoints(repo, 'agent-9', 1)).toBe(4);
    expect(new Set((await listCheckpointRefs(repo, 'agent-9')).map((r) => r.turnId)).size).toBe(1);
    expect(await listCheckpointRefs(repo, 'other')).toHaveLength(1);
  });
});
