import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
vi.mock('fs/promises', async (original) => {
  const actual = await original<typeof import('fs/promises')>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});
import { readExtractionDocument } from './persona-extraction-sources';
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'persona-read-')); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
it('distinguishes an initially absent source from a present empty file', async () => {
  expect(await readExtractionDocument(root, 'CLAUDE.md')).toBeNull();
  await fs.writeFile(path.join(root, 'CLAUDE.md'), '');
  expect(await readExtractionDocument(root, 'CLAUDE.md')).toBe('');
});
it('refuses a source deleted after inspection rather than silently omitting its instructions', async () => {
  const file = path.join(root, 'CLAUDE.md');
  await fs.writeFile(file, 'CUSTOM_MARKER');
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  let removed = false;
  vi.mocked(fs.lstat).mockImplementationOnce(async (...args) => {
    const stat = await actual.lstat(...args);
    await actual.unlink(file); removed = true;
    return stat;
  });
  await expect(readExtractionDocument(root, 'CLAUDE.md')).rejects.toThrow('Cannot extract CLAUDE.md');
  expect(removed).toBe(true);
});
