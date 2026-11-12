import { describe, expect, it, vi } from 'vitest';
import { importGitEnvironment, parseRemoteIdentity } from './git';
import { validateGithubUrl, validateImportBranch } from './types';

vi.mock('../log-service', () => ({ appLog: vi.fn() }));

const sha = 'a'.repeat(40);
const metadata = `ref: refs/heads/trunk\tHEAD\n${sha}\tHEAD\n${sha}\trefs/heads/trunk\n`;

describe('strict GitHub repository import input', () => {
  it.each(['https://github.com/owner/repo', 'https://github.com/owner/repo.git'])('canonicalizes only supported HTTPS identity %s', (url) => {
    expect(validateGithubUrl(url)).toBe('https://github.com/owner/repo.git');
  });

  it.each([
    'https://person:token@github.com/owner/repo', 'https://token@github.com/owner/repo',
    'https://github.com/owner/repo?token=secret', 'https://github.com/owner/repo#token',
    'https://github.com/owner/%2e%2e', 'https://github.com/owner/../repo', 'https://github.com/owner/repo%2fgit',
    'https://github.com\\@evil.test/owner/repo', 'https://github.com.evil.test/owner/repo',
    'https://github.com:443/owner/repo', 'http://github.com/owner/repo', 'ssh://git@github.com/owner/repo',
    'git@github.com:owner/repo.git', 'https://enterprise.test/owner/repo', 'file:///tmp/repo',
    'ext::sh -c command', '--upload-pack=command', ' https://github.com/owner/repo', 'https://github.com/owner/repo\n',
    'https://github.com/owner/-repo', 'https://github.com/owner/.', 'https://github.com/owner/..',
    'https://github.com/owner/repo/extra', 'https://github.com/owner/repo/',
  ])('refuses unsafe or unsupported URL without echoing its contents: %s', (url) => {
    expect(() => validateGithubUrl(url)).toThrow(/Use only/);
    try { validateGithubUrl(url); } catch (error) { expect(String(error)).not.toContain('secret'); }
  });

  it.each(['-b', '../main', 'heads//main', 'topic.lock', 'branch^{commit}', 'branch:target', 'branch\n', '.hidden', 'branch.', 'branch@{0}'])('refuses unsafe branch expression %s', (branch) => {
    expect(() => validateImportBranch(branch)).toThrow(/existing branch/);
  });
});

describe('actual advertised default branch and access metadata', () => {
  it('uses the advertised trunk and selected commit, never assumes main', () => {
    expect(parseRemoteIdentity('https://github.com/o/r.git', metadata)).toMatchObject({ branch: 'trunk', defaultBranch: 'trunk', commit: sha });
  });
  it('reports an empty repository explicitly', () => {
    expect(() => parseRemoteIdentity('https://github.com/o/r.git', '')).toThrow(/no downloadable branch/);
  });
  it('reports missing default metadata explicitly even with an explicit requested branch', () => {
    expect(() => parseRemoteIdentity('https://github.com/o/r.git', `${sha}\trefs/heads/trunk\n`, 'trunk')).toThrow(/default branch/);
  });
  it('rejects a missing requested branch', () => {
    expect(() => parseRemoteIdentity('https://github.com/o/r.git', metadata, 'release')).toThrow(/does not exist/);
  });
  it('rejects inconsistent HEAD metadata', () => {
    expect(() => parseRemoteIdentity('https://github.com/o/r.git', metadata.replace(`${sha}\tHEAD`, `${'b'.repeat(40)}\tHEAD`))).toThrow(/matching commit/);
  });
  it('strips inherited transport/config/trace/askpass injection while retaining normal environment', () => {
    const env = importGitEnvironment({
      HOME: '/home/user', PATH: '/bin', GIT_DIR: '/other/repo', GIT_WORK_TREE: '/other',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'filter.x.smudge', GIT_CONFIG_VALUE_0: 'command',
      GIT_TRACE: '/secret/log', GIT_SSL_NO_VERIFY: '1', GIT_EXEC_PATH: '/other/bin',
      GIT_ASKPASS: 'command', SSH_ASKPASS: 'command', NODE_OPTIONS: '--require=command', GH_DEBUG: 'api',
    }, '/owned/empty.config');
    expect(env).toMatchObject({
      HOME: '/home/user', PATH: '/bin', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GCM_INTERACTIVE: 'Never',
      GIT_CONFIG_GLOBAL: '/owned/empty.config', GIT_CONFIG_SYSTEM: '/owned/empty.config', GIT_ASKPASS: '',
    });
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_TRACE', 'GIT_SSL_NO_VERIFY', 'GIT_EXEC_PATH', 'SSH_ASKPASS', 'NODE_OPTIONS', 'GH_DEBUG']) expect(env[key]).toBeUndefined();
    expect(env.GIT_ASKPASS).not.toBe('command');
  });
});
