import { describe, it, expect } from 'vitest';
import { findLinkTokens, githubLabel, makeGithubRef, parseGithubUrl } from './link-tokens';

const spans = (text: string, opts?: Parameters<typeof findLinkTokens>[1]) =>
  findLinkTokens(text, opts).map((t) => ({ text: text.slice(t.start, t.end), type: t.type, ...(t.type === 'github' ? { repo: t.ref.repo, kind: t.ref.kind, id: t.ref.id } : {}) }));

describe('parseGithubUrl', () => {
  it('reads pull requests, issues and commits', () => {
    expect(parseGithubUrl('https://github.com/o/r/pull/12')).toMatchObject({ repo: 'o/r', kind: 'pull', id: '12', href: 'https://github.com/o/r/pull/12' });
    expect(parseGithubUrl('https://github.com/o/r/pull/12/files#diff-1')).toMatchObject({ kind: 'pull', id: '12' });
    expect(parseGithubUrl('https://github.com/o/r/issues/7?x=1')).toMatchObject({ kind: 'issue', id: '7' });
    expect(parseGithubUrl('https://github.com/o/r/commit/ABCDEF1234')).toMatchObject({ kind: 'commit', id: 'abcdef1234' });
  });

  it('ignores other pages, other hosts and odd URLs', () => {
    for (const url of [
      'https://github.com/o/r', 'https://github.com/o/r/tree/main', 'https://github.com/o/r/pull/abc', 'https://github.com/o/r/pull/0',
      'https://gitlab.com/o/r/pull/1', 'https://github.example.com/o/r/pull/1', 'https://evilgithub.com/o/r/pull/1',
      'https://user:pw@github.com/o/r/pull/1', 'https://github.com:8443/o/r/pull/1', 'javascript:alert(1)', 'not a url',
    ]) expect(parseGithubUrl(url)).toBeNull();
  });
});

describe('findLinkTokens', () => {
  it('finds http(s) URLs and trims sentence punctuation', () => {
    expect(spans('See https://example.com/a?b=1. Then (http://x.io/y).')).toEqual([
      { text: 'https://example.com/a?b=1', type: 'url' },
      { text: 'http://x.io/y', type: 'url' },
    ]);
    expect(spans('wiki https://en.wikipedia.org/wiki/Foo_(bar), ok')[0].text).toBe('https://en.wikipedia.org/wiki/Foo_(bar)');
  });

  it('only links http and https', () => {
    expect(spans('ftp://x.io file:///etc/passwd javascript:alert(1) mailto:a@b.c')).toEqual([]);
  });

  it('makes GitHub URLs references', () => {
    expect(spans('Opened https://github.com/o/r/pull/9!')).toEqual([{ text: 'https://github.com/o/r/pull/9', type: 'github', repo: 'o/r', kind: 'pull', id: '9' }]);
  });

  it('finds owner/repo#123 and, with a project repo, bare #123', () => {
    expect(spans('Fixed in o/r#12 and #34.', { shorthand: true, repo: 'me/proj' })).toEqual([
      { text: 'o/r#12', type: 'github', repo: 'o/r', kind: 'ref', id: '12' },
      { text: '#34', type: 'github', repo: 'me/proj', kind: 'ref', id: '34' },
    ]);
  });

  it('leaves bare #123 alone without a GitHub remote', () => {
    expect(spans('See #34', { shorthand: true, repo: null })).toEqual([]);
  });

  it('leaves shorthand alone unless asked (tool output)', () => {
    expect(spans('color: #333; o/r#1', { repo: 'me/proj' })).toEqual([]);
  });

  it('has no false positives inside paths and words', () => {
    const opts = { shorthand: true, repo: 'me/proj' };
    for (const text of [
      'src/renderer/a#12', './a/b#1', '~/a/b#1', '/abs/a/b#3', 'C:\\x\\a/b#1', 'file.ts#12', 'page#12', 'a/#12',
      '&#123;', '##12', '#12abc', '#12-x', 'issue#5', 'x/a/b#1', 'git@host:a/b#1', 'notes/#5',
    ]) expect(spans(text, opts)).toEqual([]);
  });

  it('keeps references separate from a URL they sit inside', () => {
    expect(spans('https://example.com/o/r#1 #2', { shorthand: true, repo: 'me/p' }).map((s) => s.text)).toEqual(['https://example.com/o/r#1', '#2']);
  });
});

describe('githubLabel', () => {
  it('drops the repo for the project\u2019s own references', () => {
    expect(githubLabel(makeGithubRef('O/R', 'pull', '5'), 'o/r')).toBe('#5');
    expect(githubLabel(makeGithubRef('o/r', 'pull', '5'), 'me/p')).toBe('o/r#5');
    expect(githubLabel(makeGithubRef('o/r', 'commit', 'abcdef123456'), 'o/r')).toBe('abcdef1');
    expect(githubLabel(makeGithubRef('o/r', 'commit', 'abcdef123456'), null)).toBe('o/r@abcdef1');
  });
});
