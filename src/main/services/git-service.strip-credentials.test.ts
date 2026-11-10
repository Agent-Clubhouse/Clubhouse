import { describe, it, expect } from 'vitest';
import { stripUrlCredentials } from './git-service';

describe('stripUrlCredentials (#3239)', () => {
  it.each([
    ['https://someone:secret-token@example.com/org/repo.git', 'https://example.com/org/repo.git'],
    ['https://ghp_abc123@github.com/org/repo.git', 'https://github.com/org/repo.git'],
    ['HTTP://user:pass@host:8080/repo', 'HTTP://host:8080/repo'],
    ['https://user:p@ss@host/repo.git', 'https://host/repo.git'],
    ['https://host/repo.git?private_token=secret#frag', 'https://host/repo.git'],
    ['https://host?access_token=secret', 'https://host'],
    ['git+https://user:secret@host/repo.git', 'git+https://host/repo.git'],
    ['ssh://git:secret@github.com/org/repo.git', 'ssh://git@github.com/org/repo.git'],
    ['ssh://git@github.com:22/org/repo.git', 'ssh://git@github.com:22/org/repo.git'],
    ['git+ssh://git:secret@host/repo.git', 'git+ssh://git@host/repo.git'],
    ['git://host/repo.git', 'git://host/repo.git'],
  ])('%s', (input, expected) => {
    expect(stripUrlCredentials(input)).toBe(expected);
  });

  it('keeps scp-style remotes and local paths as they are', () => {
    expect(stripUrlCredentials('git@github.com:org/repo.git')).toBe('git@github.com:org/repo.git');
    expect(stripUrlCredentials('../other-repo')).toBe('../other-repo');
  });
});
