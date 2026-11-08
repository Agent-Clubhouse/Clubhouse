import { describe, expect, it } from 'vitest';
import { normalizeGitRemote } from './git-remote';

describe('a git remote as a key (#3066)', () => {
  it('reads the same repository the same way, whatever the form', () => {
    for (const url of [
      'git@github.com:Agent-Clubhouse/Clubhouse.git',
      'https://github.com/agent-clubhouse/clubhouse',
      'https://user:secret-token@github.com/Agent-Clubhouse/Clubhouse.git/',
      'ssh://git@github.com:22/Agent-Clubhouse/Clubhouse.git',
    ]) expect(normalizeGitRemote(url), url).toBe('github.com/agent-clubhouse/clubhouse');
  });

  it('keeps no credentials', () => {
    expect(normalizeGitRemote('https://me:hunter2@example.com/team/app.git')).not.toContain('hunter2');
    expect(normalizeGitRemote('me:p@ss@example.com:team/app.git')).toBe('example.com/team/app');
  });

  it('has no key for what isn\'t a remote', () => {
    for (const url of ['', null, undefined, '/Users/me/src/app', 'file:///Users/me/src/app', 'C:\\src\\app', 'https://github.com/']) {
      expect(normalizeGitRemote(url as string), String(url)).toBeNull();
    }
  });
});
