import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getGithubRepo } from './git-service';

const temps: string[] = [];

function repoWith(remotes: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-repo-'));
  temps.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  for (const [name, url] of Object.entries(remotes)) execFileSync('git', ['remote', 'add', name, url], { cwd: dir });
  return dir;
}

afterEach(() => {
  for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('getGithubRepo (#2351)', () => {
  it('reads owner/repo from an ssh or https origin', async () => {
    expect(await getGithubRepo(repoWith({ origin: 'git@github.com:Agent-Clubhouse/Clubhouse.git' }))).toBe('Agent-Clubhouse/Clubhouse');
    expect(await getGithubRepo(repoWith({ origin: 'https://github.com/o/r' }))).toBe('o/r');
  });

  it('prefers origin, else takes the only remote', async () => {
    expect(await getGithubRepo(repoWith({ fork: 'git@github.com:me/r.git', origin: 'git@github.com:o/r.git' }))).toBe('o/r');
    expect(await getGithubRepo(repoWith({ upstream: 'git@github.com:o/r.git' }))).toBe('o/r');
  });

  it('is null without a github.com remote', async () => {
    expect(await getGithubRepo(repoWith({}))).toBeNull();
    expect(await getGithubRepo(repoWith({ origin: 'git@gitlab.com:o/r.git' }))).toBeNull();
    expect(await getGithubRepo(repoWith({ origin: 'https://github.example.com/o/r.git' }))).toBeNull();
  });

  it('is null outside a repo', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-norepo-'));
    temps.push(dir);
    expect(await getGithubRepo(dir)).toBeNull();
  });
});
