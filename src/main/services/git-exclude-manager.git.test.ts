/** The exclude block against real git: what it writes must actually ignore the files. */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { replaceExclusions } from './git-exclude-manager';

function ignored(cwd: string, rel: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', '--', rel], { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('git-exclude-manager with git', () => {
  it('writes patterns git matches, and drops old trailing-tag lines it never matched', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'exclude-git-'));
    execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
    fs.writeFileSync(path.join(repo, '.git', 'info', 'exclude'), '.mcp.json # clubhouse-managed-claude-code\n');
    expect(ignored(repo, '.mcp.json')).toBe(false);
    await replaceExclusions(repo, 'clubhouse-managed-claude-code', ['.mcp.json', '/.claude/skills/build/']);
    expect(ignored(repo, '.mcp.json')).toBe(true);
    expect(ignored(repo, '.claude/skills/build/SKILL.md')).toBe(true);
    expect(ignored(repo, '.claude/skills/mine/SKILL.md')).toBe(false);
    expect(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf-8')).not.toContain(' # ');
  });
});
