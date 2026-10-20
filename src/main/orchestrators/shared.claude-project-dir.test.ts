/**
 * Claude Code names a project
 * directory under <CLAUDE_CONFIG_DIR>/projects by replacing every
 * non-alphanumeric character of the cwd with '-', e.g.
 *   /Users/me/repo/.clubhouse/agents/foo -> -Users-me-repo--clubhouse-agents-foo
 *   C:\Users\me\repo                     -> C--Users-me-repo
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import * as realFs from 'fs';
import * as os from 'os';

// Switchable path module: the native one by default, win32 for the simulated Windows case.
const h = vi.hoisted(() => ({ win: false, existing: new Set<string>() }));
vi.mock('path', async () => {
  const actual = await vi.importActual<typeof import('path')>('path');
  const pick = () => (h.win ? actual.win32 : actual) as unknown as Record<string, unknown>;
  const mod = new Proxy({} as Record<string, unknown>, { get: (_t, k: string) => pick()[k] });
  return { ...actual, default: mod, join: (...a: string[]) => (pick().join as (...x: string[]) => string)(...a), resolve: (...a: string[]) => (pick().resolve as (...x: string[]) => string)(...a) };
});
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, existsSync: (p: string) => h.existing.has(String(p)) || (!h.win && actual.existsSync(p)) };
});

import { resolveEncodedPathDir } from './shared';

/** Claude Code's own project-dir encoding (as observed in ~/.claude/projects). */
const claudeEncode = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

let realPath: typeof import('path');
beforeAll(async () => { realPath = await vi.importActual<typeof import('path')>('path'); });
afterEach(() => {
  h.win = false;
  h.existing.clear();
});

describe('resolveEncodedPathDir finds Claude Code project dirs', () => {
  it('finds the project dir for a Clubhouse worktree cwd (dot in .clubhouse)', () => {
    const tmp = realFs.mkdtempSync(realPath.join(os.tmpdir(), 'claude-project-dir-'));
    const base = realPath.join(tmp, 'projects');
    const cwd = realPath.join(realFs.realpathSync(tmp), 'repo', '.clubhouse', 'agents', 'foo');
    const claudeDir = realPath.join(base, claudeEncode(cwd));
    realFs.mkdirSync(claudeDir, { recursive: true });
    try {
      expect(resolveEncodedPathDir(base, cwd)).toBe(claudeDir);
    } finally {
      realFs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('finds the project dir for a Windows drive-letter cwd', () => {
    h.win = true;
    const base = 'C:\\Users\\me\\.claude\\projects';
    const cwd = 'C:\\Users\\me\\repo';
    const claudeDir = realPath.win32.join(base, claudeEncode(cwd)); // ...\projects\C--Users-me-repo
    h.existing.add(base);
    h.existing.add(claudeDir);
    expect(resolveEncodedPathDir(base, cwd)).toBe(claudeDir);
  });
});
