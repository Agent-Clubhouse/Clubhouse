import { describe, it, expect, vi } from 'vitest';

vi.mock('./git-service', () => ({ ghExec: vi.fn(async () => null) }));

import { createGithubRefService, parseRefResponse, REF_CACHE_TTL_MS, REF_FAILURE_TTL_MS, REF_MAX_IN_FLIGHT } from './github-ref-service';

function pr(over: Record<string, unknown> = {}) {
  return JSON.stringify({ data: { repository: { issueOrPullRequest: {
    __typename: 'PullRequest', title: 'Add tokens', state: 'OPEN', isDraft: false, updatedAt: '2026-10-18T10:00:00Z',
    author: { login: 'octo' }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] }, ...over,
  } } } });
}
function issue(state: string) {
  return JSON.stringify({ data: { repository: { issueOrPullRequest: { __typename: 'Issue', title: 'Bug', state, updatedAt: '2026-10-18T10:00:00Z', author: { login: 'octo' } } } } });
}

describe('parseRefResponse', () => {
  it('reads each pull request state', () => {
    expect(parseRefResponse(pr(), 'pull')).toMatchObject({ kind: 'pull', title: 'Add tokens', state: 'open', author: 'octo', checks: 'passing' });
    expect(parseRefResponse(pr({ isDraft: true }), 'pull')?.state).toBe('draft');
    expect(parseRefResponse(pr({ state: 'MERGED' }), 'pull')?.state).toBe('merged');
    expect(parseRefResponse(pr({ state: 'CLOSED' }), 'pull')?.state).toBe('closed');
  });

  it('reads issue states, and a #number that turns out to be either', () => {
    expect(parseRefResponse(issue('OPEN'), 'ref')).toMatchObject({ kind: 'issue', state: 'open', checks: undefined });
    expect(parseRefResponse(issue('CLOSED'), 'issue')?.state).toBe('closed');
    expect(parseRefResponse(pr(), 'ref')?.kind).toBe('pull');
  });

  it('maps the checks rollup', () => {
    const rollup = (state: string | null) => pr({ commits: { nodes: [{ commit: { statusCheckRollup: state ? { state } : null } }] } });
    expect(parseRefResponse(rollup('FAILURE'), 'pull')?.checks).toBe('failing');
    expect(parseRefResponse(rollup('ERROR'), 'pull')?.checks).toBe('failing');
    expect(parseRefResponse(rollup('PENDING'), 'pull')?.checks).toBe('pending');
    expect(parseRefResponse(rollup(null), 'pull')?.checks).toBeUndefined();
  });

  it('reads a commit', () => {
    const raw = JSON.stringify({ data: { repository: { object: { messageHeadline: 'Fix it', committedDate: '2026-10-18T10:00:00Z', author: { name: 'Dev', user: null }, statusCheckRollup: { state: 'SUCCESS' } } } } });
    expect(parseRefResponse(raw, 'commit')).toEqual({ kind: 'commit', title: 'Fix it', author: 'Dev', updatedAt: '2026-10-18T10:00:00Z', checks: 'passing' });
  });

  it('is null for missing, private or malformed answers', () => {
    expect(parseRefResponse('not json', 'pull')).toBeNull();
    expect(parseRefResponse(JSON.stringify({ data: { repository: null } }), 'pull')).toBeNull();
    expect(parseRefResponse(JSON.stringify({ data: { repository: { issueOrPullRequest: null } } }), 'ref')).toBeNull();
  });
});

describe('createGithubRefService', () => {
  it('asks gh for the reference with each value as its own argument', async () => {
    const run = vi.fn(async () => pr());
    const svc = createGithubRefService(run);
    expect(await svc.get('o/r', 'pull', '12')).toMatchObject({ ok: true, details: { title: 'Add tokens' } });
    const args = run.mock.calls[0][0] as string[];
    expect(args.slice(0, 4)).toEqual(['api', '--hostname', 'github.com', 'graphql']);
    expect(args).toContain('owner=o');
    expect(args).toContain('name=r');
    expect(args).toContain('number=12');
  });

  it('caches answers for the TTL and shares one lookup between concurrent callers', async () => {
    let t = 1000;
    let release!: (v: string) => void;
    const run = vi.fn(() => new Promise<string | null>((r) => { release = r; }));
    const svc = createGithubRefService(run, () => t);
    const a = svc.get('o/r', 'pull', '5');
    const b = svc.get('O/R', 'ref', '5');
    const c = svc.get('o/r', 'issue', '5');
    expect(run).toHaveBeenCalledTimes(1);
    release(pr());
    expect(await a).toEqual(await b);
    expect(await c).toEqual(await a);
    await svc.get('o/r', 'pull', '5');
    expect(run).toHaveBeenCalledTimes(1);
    t += REF_CACHE_TTL_MS;
    run.mockImplementation(async () => pr());
    await svc.get('o/r', 'pull', '5');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('degrades to unavailable when gh is missing, signed out or rate-limited, and retries after the failure TTL', async () => {
    let t = 0;
    const run = vi.fn(async (): Promise<string | null> => null);
    const svc = createGithubRefService(run, () => t);
    expect(await svc.get('o/r', 'pull', '1')).toEqual({ ok: false, reason: 'unavailable' });
    expect(await svc.get('o/r', 'pull', '1')).toEqual({ ok: false, reason: 'unavailable' });
    expect(run).toHaveBeenCalledTimes(1);
    t += REF_FAILURE_TTL_MS;
    await svc.get('o/r', 'pull', '1');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('is not_found when GitHub has no such reference', async () => {
    const svc = createGithubRefService(async () => JSON.stringify({ data: { repository: { issueOrPullRequest: null } } }));
    expect(await svc.get('o/r', 'ref', '999')).toEqual({ ok: false, reason: 'not_found' });
  });

  it('never runs gh for invalid input', async () => {
    const run = vi.fn(async () => pr());
    const svc = createGithubRefService(run);
    for (const [repo, kind, id] of [
      ['o', 'pull', '1'], ['o/r/x', 'pull', '1'], ['../r', 'pull', '1'], ['o/r', 'pull', '-1'], ['o/r', 'pull', '0'],
      ['o/r', 'pull', '1;rm'], ['o/r', 'commit', 'xyz'], ['o/r', 'commit', '@file'], ['o/r', 'bogus', '1'], ['-o/r', 'pull', 'abc'],
    ] as const) {
      expect(await svc.get(repo, kind as never, id)).toEqual({ ok: false, reason: 'not_found' });
    }
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses lookups past the concurrency cap without caching the refusal', async () => {
    const releases: Array<(v: string) => void> = [];
    const run = vi.fn(() => new Promise<string | null>((r) => { releases.push(r); }));
    const svc = createGithubRefService(run);
    const held = Array.from({ length: REF_MAX_IN_FLIGHT }, (_, i) => svc.get('o/r', 'pull', String(i + 1)));
    expect(await svc.get('o/r', 'pull', '99')).toEqual({ ok: false, reason: 'unavailable' });
    expect(run).toHaveBeenCalledTimes(REF_MAX_IN_FLIGHT);
    releases.forEach((r) => r(pr()));
    await Promise.all(held);
    run.mockImplementation(async () => pr());
    expect((await svc.get('o/r', 'pull', '99')).ok).toBe(true);
  });
});
