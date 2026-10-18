import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Real git (#2226 review M1): deleteAgentBranch must never delete a branch
// someone has checked out, nor one that moved, nor one Clubhouse did not make.
vi.mock('./log-service', () => ({ appLog: vi.fn() }));

import { deleteAgentBranch } from './agent-config';

let repo: string;
const temps: string[] = [];

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
}
function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(d);
  return d;
}
function commit(message: string): void {
  fs.writeFileSync(path.join(repo, `${message}.txt`), message);
  git('add', '-A');
  git('commit', '-q', '-m', message);
}
function branchExists(branch: string): boolean {
  try {
    git('rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  repo = tmp('agent-branch-');
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.email', 'dev@example.com');
  git('config', 'user.name', 'Dev');
  commit('init');
});

afterEach(() => {
  for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const agentFor = (branch: string, sha: string) => ({
  id: 'durable_1_x', branch, branchOwned: true, branchStartSha: sha, worktreePath: path.join(repo, '.clubhouse', 'agents', 'helper'),
});

describe('deleteAgentBranch with real git (#2226)', () => {
  it('deletes an owned branch that has not moved and is not checked out', async () => {
    const sha = git('rev-parse', 'HEAD');
    git('branch', '--no-track', '--', 'helper/standby', sha);
    expect(await deleteAgentBranch(repo, agentFor('helper/standby', sha))).toBe(true);
    expect(branchExists('helper/standby')).toBe(false);
  });

  it('keeps an unmoved owned branch the user has checked out, leaving their HEAD intact', async () => {
    const sha = git('rev-parse', 'HEAD');
    git('branch', '--no-track', '--', 'helper/standby', sha);
    git('checkout', '-q', 'helper/standby');
    expect(await deleteAgentBranch(repo, agentFor('helper/standby', sha))).toBe(false);
    expect(branchExists('helper/standby')).toBe(true);
    expect(git('symbolic-ref', '--short', 'HEAD')).toBe('helper/standby');
    expect(git('rev-parse', 'HEAD')).toBe(sha);
  });

  it('keeps an owned branch checked out in another worktree', async () => {
    const sha = git('rev-parse', 'HEAD');
    git('branch', '--no-track', '--', 'helper/standby', sha);
    const wt = path.join(tmp('agent-wt-'), 'helper');
    git('worktree', 'add', '-q', '--', wt, 'helper/standby');
    expect(await deleteAgentBranch(repo, agentFor('helper/standby', sha))).toBe(false);
    expect(branchExists('helper/standby')).toBe(true);
  });

  it('keeps an owned branch that has moved since creation', async () => {
    const sha = git('rev-parse', 'HEAD');
    git('branch', '--no-track', '--', 'helper/standby', sha);
    git('checkout', '-q', 'helper/standby');
    commit('agent-work');
    git('checkout', '-q', 'main');
    expect(await deleteAgentBranch(repo, agentFor('helper/standby', sha))).toBe(false);
    expect(branchExists('helper/standby')).toBe(true);
  });

  it('keeps a pre-#2226 standby branch with unmerged work (branch -d refuses)', async () => {
    git('checkout', '-q', '-b', 'helper/standby');
    commit('legacy-work');
    git('checkout', '-q', 'main');
    const legacy = { id: 'durable_1_x', branch: 'helper/standby', worktreePath: path.join(repo, '.clubhouse', 'agents', 'helper') };
    expect(await deleteAgentBranch(repo, legacy)).toBe(false);
    expect(branchExists('helper/standby')).toBe(true);
  });
});
