import { beforeEach, describe, expect, it, vi } from 'vitest';

const urls = vi.hoisted(() => ({ map: {} as Record<string, string | null>, calls: 0 }));
vi.mock('./git-service', () => ({ getRemoteUrl: async (path: string) => { urls.calls++; return urls.map[path] ?? null; } }));

import { repoKeysFor, _clearRepoKeyCache } from './project-repo-keys';

describe('project git remotes as keys (#3066)', () => {
  beforeEach(() => { _clearRepoKeyCache(); urls.calls = 0; });

  it('gives keys, never URLs, for the projects with a remote, and reads each path once a minute', async () => {
    urls.map = { '/a': 'https://me:token@github.com/Org/App.git', '/b': null };
    const projects = [{ id: 'a', path: '/a' }, { id: 'b', path: '/b' }];
    expect(await repoKeysFor(projects, 1000)).toEqual({ a: 'github.com/org/app' });
    await repoKeysFor(projects, 30_000);
    expect(urls.calls).toBe(2);
    await repoKeysFor(projects, 70_000);
    expect(urls.calls).toBe(4);
  });
});
