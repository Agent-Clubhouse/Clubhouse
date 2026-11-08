import { describe, expect, it, vi } from 'vitest';

vi.mock('./agent-config', () => ({ listDurable: vi.fn(async () => []), onAgentConfigChanged: vi.fn(() => () => undefined) }));
vi.mock('./agent-registry', () => ({ getAgentCwd: vi.fn(() => undefined) }));
vi.mock('./agent-runtime/chat-event-bus', () => ({ onChatEvent: vi.fn(() => () => undefined) }));
vi.mock('./project-store', () => ({ list: vi.fn(async () => []), onProjectsChanged: vi.fn(() => () => undefined) }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));

import {
  MANY_BRANCHES, coalesceRemoteUpdates, diffSnapshots, parseHead, parsePackedRefs, type RepoSnapshot, type WorktreeState,
} from './git-watcher';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

function snap(refs: Record<string, string>, worktrees: Record<string, [string | null, string | null]>): RepoSnapshot {
  const wts = new Map<string, WorktreeState>();
  for (const [k, [branch, lastBranch]] of Object.entries(worktrees)) wts.set(k, { branch, lastBranch });
  return { refs: new Map(Object.entries(refs)), worktrees: wts };
}

describe('parsePackedRefs', () => {
  it('keeps branch and remote-tracking refs and skips the header, peeled lines and tags', () => {
    const text = [
      '# pack-refs with: peeled fully-peeled sorted ',
      `${A} refs/heads/main`,
      `${B} refs/remotes/origin/main`,
      `${C} refs/tags/v1`,
      `^${A}`,
      '',
    ].join('\r\n');
    expect([...parsePackedRefs(text)]).toEqual([['refs/heads/main', A], ['refs/remotes/origin/main', B]]);
  });
});

describe('parseHead', () => {
  it('returns the branch, or null when detached', () => {
    expect(parseHead('ref: refs/heads/feature/x\n')).toBe('feature/x');
    expect(parseHead(`${A}\n`)).toBeNull();
    expect(parseHead('ref: refs/remotes/origin/main\n')).toBeNull();
  });

  it('never reports reftable\'s placeholder branch', () => {
    expect(parseHead('ref: refs/heads/.invalid\n')).toBeNull();
  });
});

describe('coalesceRemoteUpdates', () => {
  const many = (remote: string, n: number) => Array.from({ length: n }, (_, i) => ({ remote, branch: `b${i}` }));

  it('reports each branch up to the cap', () => {
    expect(coalesceRemoteUpdates(many('origin', 3), new Set(), 3)).toEqual(many('origin', 3));
  });

  it('past the cap, reports the remote once plus its checked-out branches, per remote', () => {
    const changes = [...many('origin', 2000), ...many('up', 2)];
    expect(coalesceRemoteUpdates(changes, new Set(['b7', 'nope']), 20)).toEqual([
      { remote: 'origin', branch: 'b7' },
      { remote: 'origin', branch: MANY_BRANCHES },
      { remote: 'up', branch: 'b0' },
      { remote: 'up', branch: 'b1' },
    ]);
  });
});

describe('diffSnapshots', () => {
  it('reports a commit only for the worktree whose branch moved', () => {
    const prev = snap({ 'refs/heads/main': A, 'refs/heads/agent': A }, { root: ['main', 'main'], wt: ['agent', 'agent'] });
    const next = snap({ 'refs/heads/main': A, 'refs/heads/agent': B }, { root: ['main', 'main'], wt: ['agent', 'agent'] });
    expect(diffSnapshots(prev, next)).toEqual([{ type: 'commit', worktree: 'wt', branch: 'agent' }]);
  });

  it('reports a switch, not a commit, when HEAD moved to another branch', () => {
    const prev = snap({ 'refs/heads/main': A }, { root: ['main', 'main'] });
    const next = snap({ 'refs/heads/main': A, 'refs/heads/new': B }, { root: ['new', 'new'] });
    expect(diffSnapshots(prev, next)).toEqual([{ type: 'branch_switched', worktree: 'root', branch: 'new', previousBranch: 'main' }]);
  });

  it('waits out a detached HEAD, then reports a commit when it returns to the same branch', () => {
    const start = snap({ 'refs/heads/main': A }, { root: ['main', 'main'] });
    const detached = snap({ 'refs/heads/main': A }, { root: [null, 'main'] });
    const done = snap({ 'refs/heads/main': C }, { root: ['main', 'main'] });
    expect(diffSnapshots(start, detached)).toEqual([]);
    expect(diffSnapshots(detached, done)).toEqual([{ type: 'commit', worktree: 'root', branch: 'main' }]);
  });

  it('reports the first commit on an unborn branch', () => {
    const prev = snap({}, { root: ['main', 'main'] });
    const next = snap({ 'refs/heads/main': A }, { root: ['main', 'main'] });
    expect(diffSnapshots(prev, next)).toEqual([{ type: 'commit', worktree: 'root', branch: 'main' }]);
  });

  it('treats a worktree new to the snapshot as a baseline', () => {
    const prev = snap({ 'refs/heads/main': A }, {});
    const next = snap({ 'refs/heads/main': B }, { root: ['main', 'main'] });
    expect(diffSnapshots(prev, next)).toEqual([]);
  });

  it('reports remote-tracking refs that are new or moved, by remote and branch, and skips HEAD and deletions', () => {
    const prev = snap({ 'refs/remotes/origin/main': A, 'refs/remotes/origin/gone': A }, {});
    const next = snap({
      'refs/remotes/origin/main': B,
      'refs/remotes/origin/feature/x': A,
      'refs/remotes/origin/HEAD': A,
      'refs/remotes/up/main': A,
    }, {});
    expect(diffSnapshots(prev, next)).toEqual([
      { type: 'remote_updated', remote: 'origin', branch: 'main' },
      { type: 'remote_updated', remote: 'origin', branch: 'feature/x' },
      { type: 'remote_updated', remote: 'up', branch: 'main' },
    ]);
  });

  it('reports nothing when nothing changed', () => {
    const s = snap({ 'refs/heads/main': A, 'refs/remotes/origin/main': A }, { root: ['main', 'main'] });
    expect(diffSnapshots(s, s)).toEqual([]);
  });
});
