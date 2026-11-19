import { beforeEach, describe, expect, it } from 'vitest';
import { cachedRepoKeys, repoKeysFor, _resetRepoKeysForTesting } from './project-repo-keys';

describe('project git remotes as keys (#3066)', () => {
  let calls: string[] = [];
  let peak = 0;
  let live = 0;
  const urls: Record<string, string | null> = { '/a': 'https://me:token@github.com/Org/App.git', '/b': null, '/c': 'git@github.com:org/other.git' };
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

  it('notifies once for a changed batch and reuses in-flight reads', async () => {
    const changed = vi.fn();
    const projects = [{ id: 'a', path: '/a' }, { id: 'same-folder', path: '/a' }, { id: 'b', path: '/b' }, { id: 'c', path: '/c' }];
    expect(cachedRepoKeys(projects, 1000, changed)).toEqual({});
    expect(cachedRepoKeys(projects, 1000)).toEqual({});
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(calls).toEqual(['/a', '/b', '/c']);
    expect(cachedRepoKeys(projects, 2000, changed)).toEqual({
      a: 'github.com/org/app',
      'same-folder': 'github.com/org/app',
      c: 'github.com/org/other',
    });
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('does not request another snapshot for unchanged keys, including folders without a remote', async () => {
    const changed = vi.fn();
    const projects = [{ id: 'a', path: '/a' }, { id: 'b', path: '/b' }];
    await repoKeysFor(projects, 1000);
    cachedRepoKeys(projects, 70_000, changed);
    await repoKeysFor(projects, 70_000);
    await Promise.resolve();
    expect(calls).toHaveLength(4);
    expect(changed).not.toHaveBeenCalled();
  });

  it('notifies when a remote changes or is removed, but not when its normalized key stays the same', async () => {
    const projects = [{ id: 'a', path: '/a' }];
    const changed = vi.fn();
    const reader = vi.fn().mockResolvedValue('git@github.com:org/app');
    _resetRepoKeysForTesting(reader);
    await repoKeysFor(projects, 1000);
    reader.mockResolvedValue('https://github.com/Org/App.git');
    cachedRepoKeys(projects, 70_000, changed);
    await repoKeysFor(projects, 70_000);
    await Promise.resolve();
    expect(changed).not.toHaveBeenCalled();
    reader.mockResolvedValue('https://github.com/org/other.git');
    cachedRepoKeys(projects, 140_000, changed);
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    reader.mockResolvedValue(null);
    cachedRepoKeys(projects, 210_000, changed);
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
    expect(cachedRepoKeys(projects, 211_000)).toEqual({});
  });
});
