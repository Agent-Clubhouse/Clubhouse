import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ClaudeCodeProvider } from './claude-code-provider';
let root: string;
const provider = new ClaudeCodeProvider();
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-inspection-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
it('reads the exact primary bytes and represents a missing file as empty', async () => {
  expect(await provider.inspectInstructions(root)).toBe('');
  await fs.writeFile(path.join(root, 'CLAUDE.md'), 'Keep @@AgentName\n');
  expect(await provider.inspectInstructions(root)).toBe('Keep @@AgentName\n');
});
it('refuses symlinks, directories and oversized files instead of treating them as empty', async () => {
  const file = path.join(root, 'CLAUDE.md');
  await fs.mkdir(file);
  await expect(provider.inspectInstructions(root)).rejects.toThrow('instructions_unreadable');
  await fs.rmdir(file);
  await fs.writeFile(path.join(root, 'other'), 'private fixture');
  // Windows file symlinks require an OS privilege that CI need not grant.
  if (process.platform !== 'win32') {
    await fs.symlink(path.join(root, 'other'), file);
    await expect(provider.inspectInstructions(root)).rejects.toThrow('instructions_unreadable');
    await fs.unlink(file);
  }
  await fs.writeFile(file, Buffer.alloc(2 * 1024 * 1024 + 1));
  await expect(provider.inspectInstructions(root)).rejects.toThrow('instructions_unreadable');
});
