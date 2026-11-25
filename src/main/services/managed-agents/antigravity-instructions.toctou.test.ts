/**
 * AGENTS.md is read through a handle opened without following links, and only
 * if it is the file lstat saw (#3792, QA LOW). A swap between the two refuses.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../log-service', () => ({ appLog: vi.fn() }));

const swap = vi.hoisted(() => ({ before: undefined as undefined | (() => void) }));
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
      const run = swap.before;
      swap.before = undefined;
      run?.();
      return actual.open(...args);
    }),
  };
});

import { planAntigravityInstructions } from './antigravity-instructions';

describe('reading AGENTS.md', () => {
  let dir: string;
  const agentsMd = () => path.join(dir, 'AGENTS.md');

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-toctou-')));
    swap.before = undefined;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads the file lstat saw', async () => {
    fs.writeFileSync(agentsMd(), '# Mine\n');
    await expect(planAntigravityInstructions(dir, 'Be brief.')).resolves.toBeTruthy();
  });

  it('refuses when the file is replaced by another one between lstat and open', async () => {
    fs.writeFileSync(agentsMd(), '# Mine\n');
    const other = path.join(dir, 'other.md');
    fs.writeFileSync(other, '# Someone else\n');
    swap.before = () => fs.renameSync(other, agentsMd());
    await expect(planAntigravityInstructions(dir, 'Be brief.')).rejects.toMatchObject({ code: 'antigravity_instructions_unsafe' });
    expect(fs.readFileSync(agentsMd(), 'utf-8')).toBe('# Someone else\n');
  });

  it.runIf(process.platform !== 'win32')('refuses when the file is replaced by a link between lstat and open', async () => {
    fs.writeFileSync(agentsMd(), '# Mine\n');
    const target = path.join(dir, 'outside.md');
    fs.writeFileSync(target, 'outside');
    swap.before = () => { fs.unlinkSync(agentsMd()); fs.symlinkSync(target, agentsMd()); };
    await expect(planAntigravityInstructions(dir, 'Be brief.')).rejects.toMatchObject({ code: 'antigravity_instructions_unsafe' });
    expect(fs.readFileSync(target, 'utf-8')).toBe('outside');
  });
});
