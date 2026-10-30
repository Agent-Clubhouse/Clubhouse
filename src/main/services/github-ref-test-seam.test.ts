import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app } from 'electron';
import { createGithubRefService } from './github-ref-service';
import {
  GITHUB_REFS_ENV, GITHUB_REFS_REQUESTS_FILE, GITHUB_REFS_STUBS_FILE, stubKeyOf, testGithubRefRunner,
} from './github-ref-test-seam';

const PR = { data: { repository: { issueOrPullRequest: {
  __typename: 'PullRequest', title: 'Add tokens', state: 'MERGED', isDraft: false, updatedAt: '2026-10-18T10:00:00Z', author: { login: 'octo' },
} } } };

describe('github-ref test seam (CLUBHOUSE_TEST_GITHUB_REFS)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gh-refs-seam-'));
  });
  afterEach(async () => {
    delete process.env[GITHUB_REFS_ENV];
    (app as { isPackaged: boolean }).isPackaged = false;
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  const requests = async () => (await fs.promises.readFile(path.join(dir, GITHUB_REFS_REQUESTS_FILE), 'utf8'))
    .split('\n').filter(Boolean).map((l) => JSON.parse(l) as { ref: string; args: string[] });

  it('is off when the variable is unset', () => {
    expect(testGithubRefRunner()).toBeUndefined();
  });

  it('is ignored in packaged builds', () => {
    process.env[GITHUB_REFS_ENV] = dir;
    (app as { isPackaged: boolean }).isPackaged = true;
    expect(testGithubRefRunner()).toBeUndefined();
  });

  it('keys numbers and commits the way the service asks for them', () => {
    expect(stubKeyOf(['api', 'graphql', '-f', 'query=q', '-f', 'owner=Acme', '-f', 'name=Widgets', '-F', 'number=34'])).toBe('acme/widgets#34');
    expect(stubKeyOf(['api', 'graphql', '-f', 'query=q', '-f', 'owner=acme', '-f', 'name=widgets', '-f', 'expr=ABC1234'])).toBe('acme/widgets@abc1234');
  });

  it('answers the service from refs.json and records each lookup', async () => {
    process.env[GITHUB_REFS_ENV] = dir;
    await fs.promises.writeFile(path.join(dir, GITHUB_REFS_STUBS_FILE), JSON.stringify({ 'acme/widgets#34': PR }));
    const service = createGithubRefService(testGithubRefRunner());

    expect(await service.get('Acme/widgets', 'pull', '34')).toEqual({
      ok: true, details: { kind: 'pull', title: 'Add tokens', state: 'merged', author: 'octo', updatedAt: '2026-10-18T10:00:00Z', checks: undefined },
    });
    // A reference with no stub fails as a signed-out gh would.
    expect(await service.get('acme/widgets', 'ref', '99')).toEqual({ ok: false, reason: 'unavailable' });
    // The service's cache answers a repeat without a lookup.
    await service.get('acme/widgets', 'pull', '34');

    const logged = await requests();
    expect(logged.map((r) => r.ref)).toEqual(['acme/widgets#34', 'acme/widgets#99']);
    expect(logged[0].args).toEqual(expect.arrayContaining(['--hostname', 'github.com', '-F', 'number=34']));
  });

  it('fails every lookup when there is no stubs file', async () => {
    process.env[GITHUB_REFS_ENV] = dir;
    const run = testGithubRefRunner()!;
    expect(await run(['api', 'graphql', '-f', 'owner=a', '-f', 'name=b', '-F', 'number=1'])).toBeNull();
    expect((await requests()).map((r) => r.ref)).toEqual(['a/b#1']);
  });
});
