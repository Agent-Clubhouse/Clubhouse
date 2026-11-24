import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClaudeCodeProvider } from './claude-code-provider';

describe('BaseProvider.replaceInstructionsIfUnchanged', () => {
  let dir: string;
  let file: string;
  const provider = new ClaudeCodeProvider();
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replace-instructions-'));
    file = path.join(dir, 'CLAUDE.md');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('replaces a plain file that still holds the text that was read, leaving no temp file', async () => {
    fs.writeFileSync(file, 'old\n');
    expect(await provider.replaceInstructionsIfUnchanged(dir, 'old\n', 'new\n')).toBe(true);
    expect(fs.readFileSync(file, 'utf-8')).toBe('new\n');
    expect(fs.readdirSync(dir)).toEqual(['CLAUDE.md']);
  });

  it('keeps the file\'s permissions', async () => {
    if (process.platform === 'win32') return;
    fs.writeFileSync(file, 'old\n');
    fs.chmodSync(file, 0o640);
    await provider.replaceInstructionsIfUnchanged(dir, 'old\n', 'new\n');
    expect(fs.statSync(file).mode & 0o777).toBe(0o640);
  });

  it('writes nothing when the file was edited since the read', async () => {
    fs.writeFileSync(file, 'old\nan edit made after the read\n');
    expect(await provider.replaceInstructionsIfUnchanged(dir, 'old\n', 'new\n')).toBe(false);
    expect(fs.readFileSync(file, 'utf-8')).toBe('old\nan edit made after the read\n');
    expect(fs.readdirSync(dir)).toEqual(['CLAUDE.md']);
  });

  it('refuses a symlink and leaves its target alone', async () => {
    if (process.platform === 'win32') return;
    const target = path.join(dir, 'elsewhere.md');
    fs.writeFileSync(target, 'old\n');
    fs.symlinkSync(target, file);
    expect(await provider.replaceInstructionsIfUnchanged(dir, 'old\n', 'new\n')).toBe(false);
    expect(fs.readFileSync(target, 'utf-8')).toBe('old\n');
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
  });

  it('does not create a file that is not there', async () => {
    await expect(provider.replaceInstructionsIfUnchanged(dir, 'old\n', 'new\n')).rejects.toThrow();
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
