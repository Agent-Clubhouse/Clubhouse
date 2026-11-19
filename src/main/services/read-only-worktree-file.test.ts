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
  it.each([false, true])('rejects a replaced ancestor before any opened descriptor bytes can escape, prefix=%s', async (prefix) => {
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
    const result = await readOnlyWorktreeFile(root, 'sub/file', 1024, { prefix });
    expect(result.state).not.toBe('ok');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_OUTSIDE_SECRET');
  });
  it('admits an explicitly requested bounded prefix without changing full-file comparison limits', async () => {
    const file = path.join(folder, 'large'); await fs.writeFile(file, 'visible-prefix-' + 'PRIVATE_NOTES'.repeat(10000));
    const before = await fs.stat(file); let bytes = 0;
    const open = vi.mocked(fs.open).getMockImplementation()!;
    vi.mocked(fs.open).mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args), read = handle.read.bind(handle);
      vi.spyOn(handle, 'read').mockImplementation(async (...args: Parameters<typeof read>) => { const result = await Reflect.apply(read, handle, args); bytes += result.bytesRead; return result; });
      return handle;
    });
    const prefix = await readOnlyWorktreeFile(folder, 'large', 14, { prefix: true });
    expect(prefix).toEqual({ state: 'ok', bytes: Buffer.from('visible-prefix'), mode: '100644', truncated: true });
    expect(bytes).toBeGreaterThan(0); expect(bytes).toBeLessThanOrEqual(15);
    expect(await readOnlyWorktreeFile(folder, 'large', 14)).toEqual({ state: 'too-large' });
    const after = await fs.stat(file); expect([after.ino, after.mtimeMs, after.size]).toEqual([before.ino, before.mtimeMs, before.size]);
    await fs.symlink(file, path.join(folder, 'linked')); expect(await readOnlyWorktreeFile(folder, 'linked', 14, { prefix: true })).toEqual({ state: 'unsafe' });
  });
  it.each([false, true])('rejects a replaced ancestor even when its leaf is a hard link to the pinned inode, prefix=%s', async (prefix) => {
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
    const result = await readOnlyWorktreeFile(root, 'sub/file', 1024, { prefix });
    expect(result.state).not.toBe('ok');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_HARDLINK_SECRET');
  });
});
