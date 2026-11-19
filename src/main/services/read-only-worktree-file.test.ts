import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { readOnlyWorktreeFile } from './read-only-worktree-file';
vi.mock('fs/promises', async (original) => {
  const actual = await original<typeof import('fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

let folder: string;
beforeEach(async () => { folder = await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-passive-file-')); });
afterEach(async () => { await fs.rm(folder, { recursive: true, force: true }); });
describe('selected worktree passive file evidence', () => {
  it('reads ordinary bounded files and distinguishes missing, links, directories and large files', async () => {
    await fs.mkdir(path.join(folder, 'sub'));
    await fs.writeFile(path.join(folder, 'sub', 'file'), 'visible');
    expect(await readOnlyWorktreeFile(folder, 'sub/file')).toEqual({ state: 'ok', bytes: Buffer.from('visible'), mode: '100644' });
    expect(await readOnlyWorktreeFile(folder, 'missing')).toEqual({ state: 'missing' });
    expect(await readOnlyWorktreeFile(folder, 'sub')).toEqual({ state: 'directory' });
    expect(await readOnlyWorktreeFile(folder, 'sub/file', 2)).toEqual({ state: 'too-large' });
    await fs.symlink(path.join(folder, 'sub'), path.join(folder, 'alias'));
    expect(await readOnlyWorktreeFile(folder, 'alias/file')).toEqual({ state: 'unsafe' });
    await fs.symlink(path.join(folder, 'sub', 'file'), path.join(folder, 'link'));
    expect(await readOnlyWorktreeFile(folder, 'link')).toEqual({ state: 'unsafe' });
    for (const p of ['../outside', '/outside', '.git/config', 'sub/../sub/file', 'sub\\file', 'sub\0file']) expect(await readOnlyWorktreeFile(folder, p)).toEqual({ state: 'unsafe' });
  });
  it('rejects a replaced ancestor before any opened descriptor bytes can escape', async () => {
    const root = path.join(folder, 'root');
    const outside = path.join(folder, 'outside');
    await fs.mkdir(path.join(root, 'sub'), { recursive: true });
    await fs.mkdir(outside);
    await fs.writeFile(path.join(root, 'sub', 'file'), 'ordinary');
    await fs.writeFile(path.join(outside, 'file'), 'PRIVATE_OUTSIDE_SECRET');
    const open = vi.mocked(fs.open).getMockImplementation()!;
    vi.mocked(fs.open).mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
      await fs.rename(path.join(root, 'sub'), path.join(root, 'original'));
      await fs.symlink(outside, path.join(root, 'sub'));
      return open(...args);
    });
    const result = await readOnlyWorktreeFile(root, 'sub/file');
    expect(result.state).not.toBe('ok');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_OUTSIDE_SECRET');
  });
  it('rejects a replaced ancestor even when its leaf is a hard link to the pinned inode', async () => {
    const root = path.join(folder, 'root'), outside = path.join(folder, 'outside');
    await fs.mkdir(path.join(root, 'sub'), { recursive: true });
    await fs.mkdir(outside);
    await fs.writeFile(path.join(root, 'sub', 'file'), 'ordinary');
    await fs.link(path.join(root, 'sub', 'file'), path.join(outside, 'file'));
    const open = vi.mocked(fs.open).getMockImplementation()!;
    vi.mocked(fs.open).mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
      await fs.rename(path.join(root, 'sub'), path.join(root, 'original'));
      await fs.symlink(outside, path.join(root, 'sub'));
      await fs.writeFile(path.join(outside, 'file'), 'PRIVATE_HARDLINK_SECRET');
      return open(...args);
    });
    const result = await readOnlyWorktreeFile(root, 'sub/file');
    expect(result.state).not.toBe('ok');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_HARDLINK_SECRET');
  });
});
