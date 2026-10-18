import { describe, expect, it } from 'vitest';
import { resolveBuildSha } from './build-sha';

describe('resolveBuildSha', () => {
  it('prefers CLUBHOUSE_BUILD_SHA, then the checkout HEAD, then GITHUB_SHA', () => {
    expect(resolveBuildSha({ CLUBHOUSE_BUILD_SHA: 'abc1234', GITHUB_SHA: 'def5678' }, () => '9999999')).toBe('abc1234');
    expect(resolveBuildSha({ GITHUB_SHA: 'def5678' }, () => '71b4bc9d\n')).toBe('71b4bc9d');
    expect(resolveBuildSha({ GITHUB_SHA: 'def5678' }, () => { throw new Error('not a git repo'); })).toBe('def5678');
  });

  it('is null outside git with no environment hint, and never throws', () => {
    expect(resolveBuildSha({}, () => { throw new Error('not a git repo'); })).toBeNull();
    expect(resolveBuildSha({}, () => '')).toBeNull();
  });
});
