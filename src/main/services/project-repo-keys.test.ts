import { beforeEach, describe, expect, it } from 'vitest';
import { cachedRepoKeys, repoKeysFor, _resetRepoKeysForTesting } from './project-repo-keys';

describe('project git remotes as keys (#3066)', () => {
  let calls: string[] = [];
  let peak = 0;
  let live = 0;
  const urls: Record<string, string | null> = { '/a': 'https://me:token@github.com/Org/App.git', '/b': null };
  beforeEach(() => {
    calls = [];
    peak = 0;
    live = 0;
    _resetRepoKeysForTesting(async (cwd) => {
      calls.push(cwd);
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      return urls[cwd] ?? null;
    });
  });

  it('gives keys, never URLs, for the projects with a remote, and reads each folder once a minute', async () => {
    const projects = [{ id: 'a', path: '/a' }, { id: 'b', path: '/b' }];
    expect(await repoKeysFor(projects, 1000)).toEqual({ a: 'github.com/org/app' });
    await repoKeysFor(projects, 30_000);
    expect(calls).toEqual(['/a', '/b']);
    await repoKeysFor(projects, 70_000);
    expect(calls).toHaveLength(4);
  });

  it('a snapshot never waits: it takes what is known and reads the rest for next time', async () => {
    const projects = [{ id: 'a', path: '/a' }];
    expect(cachedRepoKeys(projects, 1000)).toEqual({});
    await new Promise((r) => setTimeout(r, 20));
    expect(cachedRepoKeys(projects, 2000)).toEqual({ a: 'github.com/org/app' });
    expect(calls).toEqual(['/a']);
  });

  it('reads a few folders at a time', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, path: `/p${i}` }));
    await repoKeysFor(many, 1000);
    expect(calls).toHaveLength(12);
    expect(peak).toBeLessThanOrEqual(4);
  });
});
