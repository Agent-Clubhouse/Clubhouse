import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ directory: undefined as string | undefined }));
const opaque = '4dbf22e8-9889-4e65-84c3-dc04e71017bd';
vi.mock('crypto', () => ({ randomUUID: () => '4dbf22e8-9889-4e65-84c3-dc04e71017bd' }));
vi.mock('fs/promises', async (original) => {
  const actual = await original<typeof import('fs/promises')>();
  return { ...actual, mkdtemp: (prefix: string) => state.directory ? Promise.resolve(state.directory) : actual.mkdtemp(prefix) };
});
import { createMessageFile, removeMessageFile } from './message-file';
let root: string | undefined;
afterEach(async () => { state.directory = undefined; if (root) await fs.rm(root, { recursive: true, force: true }); });
it('creates an isolated directory and opaque exclusive private file, then cleans up both', async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'message-file-security-'));
  const file = await createMessageFile('private bytes', root);
  expect(path.dirname(path.dirname(file))).toBe(root);
  expect(path.basename(path.dirname(file))).toMatch(/^clubhouse-a2a-/);
  expect(path.basename(file)).toBe(`${opaque}.md`);
  expect(await fs.readFile(file, 'utf8')).toBe('private bytes');
  if (process.platform !== 'win32') expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  await removeMessageFile(file);
  await expect(fs.stat(path.dirname(file))).rejects.toMatchObject({ code: 'ENOENT' });
});
it.each(['file', 'symlink'] as const)('refuses to overwrite a pre-existing %s even if one appears before exclusive creation', async (kind) => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'message-file-race-'));
  const directory = path.join(root, 'isolated'); await fs.mkdir(directory, { mode: 0o700 });
  const target = path.join(directory, `${opaque}.md`);
  const victim = path.join(root, 'victim.md'); await fs.writeFile(victim, 'keep these bytes');
  if (kind === 'symlink') await fs.symlink(victim, target);
  else await fs.writeFile(target, 'existing message');
  state.directory = directory;
  await expect(createMessageFile('overwrite attempt', root)).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await fs.readFile(victim, 'utf8')).toBe('keep these bytes');
  expect(await fs.readFile(target, 'utf8')).toBe(kind === 'symlink' ? 'keep these bytes' : 'existing message');
});
