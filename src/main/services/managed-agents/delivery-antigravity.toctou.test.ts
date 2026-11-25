/**
 * A Codex start reads AGENTS.md (to keep text an Antigravity start left)
 * through a handle, and only if it is the file it checked (#3839 QA LOW):
 * a plain file opened without following links, a link's target by dev/ino.
 * A swap between the check and the read refuses.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ home: '', before: undefined as undefined | (() => void) }));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => h.home } }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
      const run = h.before;
      h.before = undefined;
      run?.();
      return actual.open(...args);
    }),
  };
});

import { _keepTextBesideAntigravityBlockForTesting as keepText } from './delivery';
import { ANTIGRAVITY_BLOCK_BEGIN, ANTIGRAVITY_BLOCK_END } from './antigravity-instructions';

describe('Codex reading an AGENTS.md an Antigravity start may have left', () => {
  let root: string;
  let worktree: string;
  const agentsMd = () => path.join(worktree, 'AGENTS.md');
  const withBlock = `# Mine\n${ANTIGRAVITY_BLOCK_BEGIN}\nmanaged\n${ANTIGRAVITY_BLOCK_END}\n`;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-codex-toctou-')));
    worktree = path.join(root, 'wt');
    h.home = path.join(root, 'home');
    fs.mkdirSync(worktree);
    fs.mkdirSync(h.home);
    h.before = undefined;
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reads the file it checked: one without markers is left to Codex', async () => {
    fs.writeFileSync(agentsMd(), '# Mine\n');
    await expect(keepText('a1', worktree)).resolves.toBeUndefined();
  });

  it('refuses when the file is replaced by another one between the check and the read', async () => {
    fs.writeFileSync(agentsMd(), withBlock);
    const other = path.join(worktree, 'other.md');
    fs.writeFileSync(other, withBlock);
    h.before = () => fs.renameSync(other, agentsMd());
    await expect(keepText('a1', worktree)).rejects.toMatchObject({ code: 'antigravity_instructions_unsafe' });
    expect(fs.readFileSync(agentsMd(), 'utf-8')).toBe(withBlock);
  });

  it.runIf(process.platform !== 'win32')('refuses when a plain file is replaced by a link between the check and the read', async () => {
    fs.writeFileSync(agentsMd(), withBlock);
    const target = path.join(root, 'outside.md');
    fs.writeFileSync(target, withBlock);
    h.before = () => { fs.unlinkSync(agentsMd()); fs.symlinkSync(target, agentsMd()); };
    await expect(keepText('a1', worktree)).rejects.toMatchObject({ code: 'antigravity_instructions_unsafe' });
    expect(fs.readFileSync(target, 'utf-8')).toBe(withBlock);
  });

  it.runIf(process.platform !== 'win32')('refuses when a link is repointed between the check and the read', async () => {
    const first = path.join(root, 'first.md');
    const second = path.join(root, 'second.md');
    fs.writeFileSync(first, '# First\n');
    fs.writeFileSync(second, withBlock);
    fs.symlinkSync(first, agentsMd());
    h.before = () => { fs.unlinkSync(agentsMd()); fs.symlinkSync(second, agentsMd()); };
    await expect(keepText('a1', worktree)).rejects.toMatchObject({ code: 'antigravity_instructions_unsafe' });
  });
});
