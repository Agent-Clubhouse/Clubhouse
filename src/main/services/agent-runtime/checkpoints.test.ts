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
  MAX_UNTRACKED_BYTES,
  pruneCheckpoints,
  readSkipped,
  repoRoot,
  revertChanges,
} from './checkpoints';

const posixOnly = process.platform === 'win32' ? it.skip : it;

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
  // Windows runners default to core.autocrlf=true; these tests compare exact bytes.
  git('config', 'core.autocrlf', 'false');
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

    const forced = await revertChanges(repo, start, end, { force: true });
    expect(forced.reverted).toContain('src/app.ts');
    expect(read('src/app.ts')).toBe('export const a = 1;\n');
  });

  it('backs up the tree first, so a forced revert can be undone', async () => {
    const start = await createCheckpoint(repo, checkpointRef('a', 's', 't', 'start'), 'start');
    write('src/app.ts', 'agent edit\n');
    const end = await createCheckpoint(repo, checkpointRef('a', 's', 't', 'end'), 'end');
    write('src/app.ts', 'user edit afterwards\n');
    const backupRefs = { before: checkpointRef('a', 's', 't', 'pre-revert'), after: checkpointRef('a', 's', 't', 'post-revert') };

    const forced = await revertChanges(repo, start, end, { force: true, backupRefs });
    expect(read('src/app.ts')).toBe('export const a = 1;\n');
    expect(git('rev-parse', backupRefs.before)).toBe(forced.before);
    expect(git('show', `${backupRefs.before}:src/app.ts`)).toBe('user edit afterwards');

    const undo = await revertChanges(repo, git('rev-parse', backupRefs.before), git('rev-parse', backupRefs.after));
    expect(undo.reverted).toEqual(['src/app.ts']);
    expect(read('src/app.ts')).toBe('user edit afterwards\n');
  });

  it('keeps the first backup across consecutive reverts, so one undo covers both', async () => {
    const start = await createCheckpoint(repo, checkpointRef('a', 's', 't', 'start'), 'start');
    write('src/app.ts', 'agent edit\n');
    write('README.md', '# agent\n');
    const end = await createCheckpoint(repo, checkpointRef('a', 's', 't', 'end'), 'end');
    write('src/app.ts', 'user edit\n');
    const backupRefs = { before: checkpointRef('a', 's', 't', 'pre-revert'), after: checkpointRef('a', 's', 't', 'post-revert') };

    const first = await revertChanges(repo, start, end, { backupRefs });
    expect(first.reverted).toEqual(['README.md']);
    await revertChanges(repo, start, end, { force: true, backupRefs });
    expect(git('rev-parse', backupRefs.before)).toBe(first.before);

    await revertChanges(repo, git('rev-parse', backupRefs.before), git('rev-parse', backupRefs.after));
    expect(read('README.md')).toBe('# agent\n');
    expect(read('src/app.ts')).toBe('user edit\n');
  });

  posixOnly('replaces a symlink instead of writing through it, and undo puts the link back', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'do not touch\n');
      const start = await createCheckpoint(repo, checkpointRef('a', 's', 't', 'start'), 'start');
      write('src/app.ts', 'agent edit\n');
      const end = await createCheckpoint(repo, checkpointRef('a', 's', 't', 'end'), 'end');
      fs.rmSync(path.join(repo, 'src/app.ts'));
      fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(repo, 'src/app.ts'));

      expect((await revertChanges(repo, start, end)).conflicts).toEqual(['src/app.ts']);
      const backupRefs = { before: checkpointRef('a', 's', 't', 'pre-revert'), after: checkpointRef('a', 's', 't', 'post-revert') };
      await revertChanges(repo, start, end, { force: true, backupRefs });
      expect(fs.lstatSync(path.join(repo, 'src/app.ts')).isSymbolicLink()).toBe(false);
      expect(read('src/app.ts')).toBe('export const a = 1;\n');
      expect(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf-8')).toBe('do not touch\n');

      await revertChanges(repo, git('rev-parse', backupRefs.before), git('rev-parse', backupRefs.after));
      expect(fs.readlinkSync(path.join(repo, 'src/app.ts'))).toBe(path.join(outside, 'secret.txt'));
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  posixOnly('never deletes through a directory that became a symlink', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
    try {
      const start = await createCheckpoint(repo, checkpointRef('a', 's', 't', 'start'), 'start');
      write('gen/out.txt', 'agent output\n');
      const end = await createCheckpoint(repo, checkpointRef('a', 's', 't', 'end'), 'end');
      fs.rmSync(path.join(repo, 'gen'), { recursive: true });
      fs.writeFileSync(path.join(outside, 'out.txt'), 'outside\n');
      fs.symlinkSync(outside, path.join(repo, 'gen'));

      const result = await revertChanges(repo, start, end, { force: true });
      expect(result.skipped).toEqual(['gen/out.txt']);
      expect(fs.readFileSync(path.join(outside, 'out.txt'), 'utf-8')).toBe('outside\n');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  posixOnly('restores the executable bit', async () => {
    fs.writeFileSync(path.join(repo, 'run.sh'), '#!/bin/sh\necho hi\n');
    fs.chmodSync(path.join(repo, 'run.sh'), 0o755);
    git('add', 'run.sh');
    git('commit', '-q', '-m', 'script');
    const start = await createCheckpoint(repo, checkpointRef('a', 's', 't', 'start'), 'start');
    fs.writeFileSync(path.join(repo, 'run.sh'), '#!/bin/sh\necho bye\n');
    fs.chmodSync(path.join(repo, 'run.sh'), 0o644);
    const end = await createCheckpoint(repo, checkpointRef('a', 's', 't', 'end'), 'end');

    await revertChanges(repo, start, end);
    expect(read('run.sh')).toBe('#!/bin/sh\necho hi\n');
    expect(fs.statSync(path.join(repo, 'run.sh')).mode & 0o111).not.toBe(0);
  });

  posixOnly('runs checkout filters (LFS-style smudge) when restoring', async () => {
    // Stored lowercase, checked out uppercase: writing the raw blob would give lowercase.
    git('config', 'filter.shout.clean', 'tr A-Z a-z');
    git('config', 'filter.shout.smudge', 'tr a-z A-Z');
    write('.gitattributes', '*.dat filter=shout\n');
    write('data.dat', 'HELLO\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'filtered');
    const start = await createCheckpoint(repo, checkpointRef('a', 's', 't', 'start'), 'start');
    expect(git('cat-file', '-p', `${start}:data.dat`)).toBe('hello');
    write('data.dat', 'WORLD\n');
    const end = await createCheckpoint(repo, checkpointRef('a', 's', 't', 'end'), 'end');

    expect((await revertChanges(repo, start, end)).reverted).toEqual(['data.dat']);
    expect(read('data.dat')).toBe('HELLO\n');
  });

  it('restores binary files byte for byte', async () => {
    const bytes = Buffer.from([0, 255, 1, 254, 0, 13, 10, 0x80, 0xc3]);
    fs.writeFileSync(path.join(repo, 'blob.bin'), bytes);
    const start = await createCheckpoint(repo, checkpointRef('a', 's', 't', 'start'), 'start');
    fs.writeFileSync(path.join(repo, 'blob.bin'), Buffer.from([1, 2, 3]));
    const end = await createCheckpoint(repo, checkpointRef('a', 's', 't', 'end'), 'end');
    const files = await diffFiles(repo, start, end);
    expect(files).toEqual([expect.objectContaining({ path: 'blob.bin', binary: true })]);

    await revertChanges(repo, start, end);
    expect(fs.readFileSync(path.join(repo, 'blob.bin')).equals(bytes)).toBe(true);
  });

  it('swaps a file back for the directory the agent replaced it with', async () => {
    const start = await createCheckpoint(repo, checkpointRef('a', 's', 't', 'start'), 'start');
    fs.rmSync(path.join(repo, 'README.md'));
    write('README.md/index.md', 'now a folder\n');
    const end = await createCheckpoint(repo, checkpointRef('a', 's', 't', 'end'), 'end');

    const result = await revertChanges(repo, start, end);
    expect(result.reverted.sort()).toEqual(['README.md', 'README.md/index.md']);
    expect(read('README.md')).toBe('# demo\n');
  });

  it('leaves out large untracked files, notes them, and never reverts them', async () => {
    const big = Buffer.alloc(MAX_UNTRACKED_BYTES + 1, 7);
    const start = await createCheckpoint(repo, checkpointRef('a', 's', 't', 'start'), 'start');
    fs.writeFileSync(path.join(repo, 'big.bin'), big);
    write('small.txt', 'small\n');
    const end = await createCheckpoint(repo, checkpointRef('a', 's', 't', 'end'), 'end');

    expect(git('ls-tree', '-r', '--name-only', end).split('\n')).not.toContain('big.bin');
    expect(await readSkipped(repo, end)).toEqual({ large: ['big.bin'], repos: [] });
    const result = await revertChanges(repo, start, end);
    expect(result.reverted).toEqual(['small.txt']);
    expect(fs.existsSync(path.join(repo, 'big.bin'))).toBe(true);
  });

  it('skips a file the backup cannot hold even when forced', async () => {
    const start = await createCheckpoint(repo, checkpointRef('a', 's', 't', 'start'), 'start');
    write('scratch.txt', 'agent\n');
    const end = await createCheckpoint(repo, checkpointRef('a', 's', 't', 'end'), 'end');
    // The user replaces it with something too big to back up.
    fs.writeFileSync(path.join(repo, 'scratch.txt'), Buffer.alloc(MAX_UNTRACKED_BYTES + 1, 1));

    const result = await revertChanges(repo, start, end, { force: true });
    expect(result.skipped).toEqual(['scratch.txt']);
    expect(fs.statSync(path.join(repo, 'scratch.txt')).size).toBe(MAX_UNTRACKED_BYTES + 1);
  });

  it('uses paths relative to the repository root from a subdirectory', async () => {
    const sub = path.join(repo, 'src');
    // Windows: git reports C:/Users/runneradmin/..., tmpdir may be C:\\Users\\RUNNER~1\\...
    expect(fs.realpathSync.native((await repoRoot(sub)) as string)).toBe(fs.realpathSync.native(repo));
  });

  it('seeds the snapshot from the user\'s index without changing it', async () => {
    write('staged.txt', 'staged\n');
    git('add', 'staged.txt');
    const index = fs.readFileSync(path.join(repo, '.git', 'index'));
    const commit = await createCheckpoint(repo, checkpointRef('a', 's', 't', 'start'), 'start');
    expect(git('ls-tree', '-r', '--name-only', commit).split('\n')).toContain('staged.txt');
    expect(fs.readFileSync(path.join(repo, '.git', 'index')).equals(index)).toBe(true);
  });

  it('sees a same-size edit made in the same second as the user\'s last index write', async () => {
    write('src/app.ts', 'export const a = 7;\n');
    git('add', 'src/app.ts');
    write('src/app.ts', 'export const a = 8;\n');
    const commit = await createCheckpoint(repo, checkpointRef('a', 's', 't', 'start'), 'start');
    expect(git('show', `${commit}:src/app.ts`)).toBe('export const a = 8;');
  });

  it('leaves out a nested repository with no commits instead of failing the checkpoint', async () => {
    fs.mkdirSync(path.join(repo, 'scratch'));
    execFileSync('git', ['init', '-q'], { cwd: path.join(repo, 'scratch') });
    write('scratch/a.txt', 'inside\n');
    write('notes.txt', 'outside\n');
    const commit = await createCheckpoint(repo, checkpointRef('a', 's', 't', 'start'), 'start');
    const files = git('ls-tree', '-r', '--name-only', commit).split('\n');
    expect(files).toContain('notes.txt');
    expect(files.some((f) => f.startsWith('scratch'))).toBe(false);
    expect(await readSkipped(repo, commit)).toEqual({ large: [], repos: ['scratch'] });
  });

  it('restores line endings the way checkout would (LF stored, autocrlf=true gives CRLF)', async () => {
    git('config', 'core.autocrlf', 'true');
    const start = await createCheckpoint(repo, checkpointRef('a', 's', 't', 'start'), 'start');
    write('src/app.ts', 'agent edit\n');
    const end = await createCheckpoint(repo, checkpointRef('a', 's', 't', 'end'), 'end');
    await revertChanges(repo, start, end);
    expect(read('src/app.ts')).toBe('export const a = 1;\r\n');
  });

  it('pins plain diff output whatever the user\'s diff config says', async () => {
    git('config', 'color.diff', 'always');
    git('config', 'diff.noprefix', 'true');
    const start = await createCheckpoint(repo, checkpointRef('a', 's', 't', 'start'), 'start');
    write('src/app.ts', 'export const a = 5;\n');
    const end = await createCheckpoint(repo, checkpointRef('a', 's', 't', 'end'), 'end');
    const patch = await diffPatch(repo, start, end, 'src/app.ts');
    expect(patch).toContain('--- a/src/app.ts');
    expect(patch).not.toContain('\u001b[');
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
