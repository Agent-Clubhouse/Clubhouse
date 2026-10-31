import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Real git in a temp repository: the dispose checks rely on rev-list's
// --exclude/--branches semantics, which a fake git can't reproduce (#2224).

vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./agent-settings-service', () => ({
  applyAgentDefaults: vi.fn(async () => undefined),
  readProjectAgentDefaults: vi.fn(async () => ({})),
}));
vi.mock('./agent-system', () => ({ resolveOrchestrator: vi.fn() }));
vi.mock('./chat-idle-settings', () => ({ setAgentIdleSleep: vi.fn() }));

import {
  clearAgentConfigCache,
  flushAllAgentConfigs,
  getDisposeChecks,
  getWorktreeStatus,
  resolveHelpersForDelete,
} from './agent-config';
import { findGitCommonDir } from './git-service';
import type { DurableAgentConfig } from '../../shared/types';

let root: string;
let project: string;

function git(args: string[], cwd = project): string {
  return execFileSync('git', [
    '-c', 'user.name=Clubhouse Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false',
    ...args,
  ], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function worktree(name: string): string {
  return path.join(project, '.clubhouse', 'agents', name);
}

function addAgent(id: string, name: string, extra: Partial<DurableAgentConfig> = {}): DurableAgentConfig {
  git(['worktree', 'add', '-q', '-b', `${name}/standby`, worktree(name), 'main']);
  return {
    id, name, color: 'blue', createdAt: '2026-10-18T00:00:00.000Z',
    worktreePath: worktree(name), branch: `${name}/standby`, ...extra,
  };
}

function commit(cwd: string, file: string): void {
  fs.writeFileSync(path.join(cwd, file), `${file}\n`);
  git(['add', file], cwd);
  git(['commit', '-q', '-m', `add ${file}`], cwd);
}

function branchExists(name: string): boolean {
  try {
    git(['show-ref', '--verify', '--quiet', `refs/heads/${name}`]);
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  clearAgentConfigCache();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-helpers-'));
  project = path.join(root, 'project');
  fs.mkdirSync(project);
  git(['init', '-q']);
  git(['checkout', '-q', '-b', 'main']);
  commit(project, 'README.md');

  const agents = [
    addAgent('durable_1_orch', 'orch'),
    addAgent('durable_2_a', 'helper-a', { parentAgentId: 'durable_1_orch' }),
    addAgent('durable_3_b', 'helper-b', { parentAgentId: 'durable_1_orch' }),
  ];
  fs.writeFileSync(path.join(project, '.clubhouse', 'agents.json'), JSON.stringify(agents, null, 2));
});

afterEach(async () => {
  await flushAllAgentConfigs();
  clearAgentConfigCache();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('dispose checks against a real repository (no remote)', () => {
  it('does not count work kept only on a sibling helper being disposed as safe', async () => {
    // Helper A commits X; helper B's branch is fast-forwarded onto it.
    commit(worktree('helper-a'), 'x.txt');
    git(['merge', '-q', '--ff-only', 'helper-a/standby'], worktree('helper-b'));

    // On its own, A's commit survives on B's branch.
    expect((await getDisposeChecks(project, 'durable_2_a')).unpushed).toBe(0);

    // Disposed together, both branches go, so X is at risk in both.
    const result = await resolveHelpersForDelete(project, 'durable_1_orch', 'dispose');

    expect(result.ok).toBe(false);
    expect(result.blocked?.map((b) => [b.agentId, b.checks.unpushed])).toEqual([
      ['durable_2_a', 1],
      ['durable_3_b', 1],
    ]);
    expect(branchExists('helper-a/standby')).toBe(true);
    expect(branchExists('helper-b/standby')).toBe(true);
    expect(fs.existsSync(worktree('helper-a'))).toBe(true);
  });

  it('disposes helpers whose work is on a branch that stays', async () => {
    commit(worktree('helper-a'), 'x.txt');
    git(['merge', '-q', '--ff-only', 'helper-a/standby'], worktree('helper-b'));
    git(['merge', '-q', '--ff-only', 'helper-a/standby']);

    const result = await resolveHelpersForDelete(project, 'durable_1_orch', 'dispose');

    expect(result).toMatchObject({ ok: true, helperIds: ['durable_2_a', 'durable_3_b'] });
    expect(branchExists('helper-a/standby')).toBe(false);
    expect(branchExists('helper-b/standby')).toBe(false);
    expect(branchExists('orch/standby')).toBe(true);
    expect(fs.existsSync(worktree('helper-a'))).toBe(false);
    expect(fs.existsSync(worktree('helper-b'))).toBe(false);
  });

  it('blocks on uncommitted files', async () => {
    fs.writeFileSync(path.join(worktree('helper-b'), 'notes.txt'), 'draft\n');
    const result = await resolveHelpersForDelete(project, 'durable_1_orch', 'dispose');
    expect(result.blocked).toEqual([
      { agentId: 'durable_3_b', name: 'helper-b', checks: { dirty: 1, unpushed: 0, unmerged: 0 } },
    ]);
  });
});

describe('dispose checks and Clubhouse\'s own config', () => {
  const bridge = { mcpServers: { clubhouse: { command: 'node', args: ['/app/bridge/clubhouse-mcp-bridge.js'] } } };

  it('disposes a fresh helper whose only change is the .mcp.json Clubhouse wrote', async () => {
    fs.writeFileSync(path.join(worktree('helper-b'), '.mcp.json'), JSON.stringify(bridge, null, 2));
    expect(await getDisposeChecks(project, 'durable_3_b')).toEqual({ dirty: 0, unpushed: 0, unmerged: 0 });
  });

  it('still holds for a real edit, counting it alone', async () => {
    fs.writeFileSync(path.join(worktree('helper-b'), '.mcp.json'), JSON.stringify(bridge, null, 2));
    fs.writeFileSync(path.join(worktree('helper-b'), 'notes.txt'), 'draft\n');
    expect((await getDisposeChecks(project, 'durable_3_b')).dirty).toBe(1);
  });

  it('still holds when the user added a server to Clubhouse\'s .mcp.json', async () => {
    const edited = { mcpServers: { ...bridge.mcpServers, mine: { command: 'my-server' } } };
    fs.writeFileSync(path.join(worktree('helper-b'), '.mcp.json'), JSON.stringify(edited, null, 2));
    expect((await getDisposeChecks(project, 'durable_3_b')).dirty).toBe(1);
  });
});

describe('worktree status when git fails', () => {
  it('reports that it could not check, never a clean worktree', async () => {
    fs.writeFileSync(path.join(worktree('helper-b'), 'notes.txt'), 'draft\n');
    // Point the worktree at a git dir that isn't there, so git status fails.
    // Remove the .git file first: git marks it hidden on Windows, and
    // overwriting a hidden file there fails with EPERM.
    const gitFile = path.join(worktree('helper-b'), '.git');
    fs.rmSync(gitFile, { force: true });
    fs.writeFileSync(gitFile, `gitdir: ${path.join(root, 'missing')}\n`);
    const status = await getWorktreeStatus(project, 'durable_3_b');
    expect(status.checkError).toMatch(/couldn't read its uncommitted files/);
    expect(status.uncommittedFiles).toEqual([]);
    expect((await getDisposeChecks(project, 'durable_3_b')).error).toBeTruthy();
  });
});

describe('worktree status before delete (#2245)', () => {
  it('reports a clean worktree as clean', async () => {
    const status = await getWorktreeStatus(project, 'durable_3_b');
    expect(status).toEqual({ isValid: true, branch: 'helper-b/standby', uncommittedFiles: [], unpushedCommits: [], hasRemote: false });
  });

  it('lists uncommitted files and commits on no other branch', async () => {
    commit(worktree('helper-b'), 'x.txt');
    fs.writeFileSync(path.join(worktree('helper-b'), 'notes.txt'), 'draft\n');
    const status = await getWorktreeStatus(project, 'durable_3_b');
    expect(status.uncommittedFiles.map((f) => f.path)).toEqual(['notes.txt']);
    expect(status.unpushedCommits.map((c) => c.subject)).toEqual(['add x.txt']);
    expect(status.checkError).toBeUndefined();
  });

  it('checks the branch from the project when the worktree folder is missing', async () => {
    commit(worktree('helper-b'), 'x.txt');
    fs.rmSync(worktree('helper-b'), { recursive: true, force: true });
    const status = await getWorktreeStatus(project, 'durable_3_b');
    expect(status).toMatchObject({ isValid: true, worktreeMissing: true, uncommittedFiles: [] });
    expect(status.unpushedCommits.map((c) => c.subject)).toEqual(['add x.txt']);
    expect(status.checkError).toBeUndefined();
  });

  it('reports a missing folder whose branch is saved elsewhere as having nothing to lose', async () => {
    commit(worktree('helper-b'), 'x.txt');
    git(['merge', '-q', '--ff-only', 'helper-b/standby']);
    fs.rmSync(worktree('helper-b'), { recursive: true, force: true });
    const status = await getWorktreeStatus(project, 'durable_3_b');
    expect(status).toMatchObject({ isValid: true, worktreeMissing: true, unpushedCommits: [] });
  });
});

describe('findGitCommonDir (#2511)', () => {
  it('gives the project and each of its worktrees the same common dir', async () => {
    const common = await findGitCommonDir(project);
    expect(common).toBe(fs.realpathSync.native(path.join(project, '.git')));
    expect(await findGitCommonDir(worktree('helper-a'))).toBe(common);
    expect(await findGitCommonDir(path.join(project, '.clubhouse'))).toBe(common);
  });

  it('tells another repository apart, and gives null outside any repository', async () => {
    const otherRepo = path.join(root, 'other');
    fs.mkdirSync(otherRepo);
    git(['init', '-q'], otherRepo);
    expect(await findGitCommonDir(otherRepo)).toBe(fs.realpathSync.native(path.join(otherRepo, '.git')));
    expect(await findGitCommonDir(otherRepo)).not.toBe(await findGitCommonDir(project));

    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-not-a-repo-'));
    try {
      expect(await findGitCommonDir(plain)).toBeNull();
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});
