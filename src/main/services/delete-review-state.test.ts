import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { DurableAgentConfig, WorktreeStatus } from '../../shared/types';
import { deleteReviewFingerprint } from './delete-review-state';

let dir: string;
let config: DurableAgentConfig;
const work: WorktreeStatus = { isValid: true, branch: 'main', uncommittedFiles: [], unpushedCommits: [], hasRemote: false };
const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'delete-review-'));
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  await fs.writeFile(path.join(dir, 'file'), 'original');
  git('add', '.'); git('commit', '-m', 'initial');
  config = { id: 'one', name: 'One', createdAt: 'original', color: 'blue', branch: 'main', worktreePath: dir };
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

it('detects new work and further edits to an already dirty file without storing contents', async () => {
  const clean = await deleteReviewFingerprint(config, work);
  await fs.writeFile(path.join(dir, 'file'), 'first');
  const first = await deleteReviewFingerprint(config, work);
  await fs.writeFile(path.join(dir, 'file'), 'second');
  const second = await deleteReviewFingerprint(config, work);
  expect(first).not.toBe(clean); expect(second).not.toBe(first);
  expect(second).toMatch(/^[a-f0-9]{64}$/);
});

it('detects further untracked edits in folders and filenames with spaces', async () => {
  await fs.mkdir(path.join(dir, 'new folder'));
  const file = path.join(dir, 'new folder', 'new file');
  await fs.writeFile(file, 'first');
  const first = await deleteReviewFingerprint(config, work);
  await fs.writeFile(file, 'second');
  expect(await deleteReviewFingerprint(config, work)).not.toBe(first);
});

it('detects index changes while working file contents stay unchanged', async () => {
  await fs.writeFile(path.join(dir, 'file'), 'staged one'); git('add', 'file');
  await fs.writeFile(path.join(dir, 'file'), 'working contents');
  const first = await deleteReviewFingerprint(config, work);
  await fs.writeFile(path.join(dir, 'file'), 'staged two'); git('add', 'file');
  await fs.writeFile(path.join(dir, 'file'), 'working contents');
  expect(await deleteReviewFingerprint(config, work)).not.toBe(first);
});

it('detects new commits, renames and symbolic links', async () => {
  const original = await deleteReviewFingerprint(config, work);
  git('commit', '--allow-empty', '-m', 'next');
  const next = await deleteReviewFingerprint(config, work);
  expect(next).not.toBe(original);
  git('mv', 'file', 'renamed');
  expect(await deleteReviewFingerprint(config, work)).not.toBe(next);
  await fs.symlink('renamed', path.join(dir, 'link'));
  const linked = await deleteReviewFingerprint(config, work);
  await fs.unlink(path.join(dir, 'link')); await fs.symlink('other', path.join(dir, 'link'));
  expect(await deleteReviewFingerprint(config, work)).not.toBe(linked);
});

it.each(['--skip-worktree', '--assume-unchanged'])('pins %s flags and later file edits hidden from Git status', async (flag) => {
  const original = await deleteReviewFingerprint(config, work);
  git('update-index', flag, 'file');
  const flagged = await deleteReviewFingerprint(config, work);
  expect(flagged).not.toBe(original);
  await fs.writeFile(path.join(dir, 'file'), 'hidden edit');
  expect(git('status', '--porcelain')).toBe('');
  const edited = await deleteReviewFingerprint(config, work);
  expect(edited).not.toBe(flagged);
  await fs.writeFile(path.join(dir, 'file'), 'another hidden edit');
  expect(await deleteReviewFingerprint(config, work)).not.toBe(edited);
});

it('does not claim to inventory ignored files', async () => {
  await fs.writeFile(path.join(dir, '.gitignore'), 'ignored/\n');
  git('add', '.gitignore'); git('commit', '-m', 'ignore generated folder');
  const original = await deleteReviewFingerprint(config, work);
  await fs.mkdir(path.join(dir, 'ignored'));
  await fs.writeFile(path.join(dir, 'ignored', 'draft'), 'not inventoried');
  expect(await deleteReviewFingerprint(config, work)).toBe(original);
});
