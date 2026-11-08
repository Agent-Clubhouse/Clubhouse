import { describe, expect, it } from 'vitest';
import { linkSuggestions } from './projectLinks';
import { pairKey } from './networkTree';

const p = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, path: `/${id}`, ...extra });

describe('suggested links across machines (#3066)', () => {
  const local = [p('a'), p('b'), p('c')];
  const keys = { a: 'github.com/org/app', b: 'github.com/org/site' };
  const remote = [
    p('r1', { repoKey: 'github.com/org/app', satelliteName: 'Studio' }),
    p('r2', { repoKey: 'github.com/org/app', satelliteName: 'Laptop' }),
    p('r3', { repoKey: 'github.com/org/other' }),
    p('r4'),
  ];

  it('suggests each pair that shares a git remote, once per pair', () => {
    const out = linkSuggestions(local, keys, remote, [], []);
    expect(out.map((s) => [s.local.id, s.remote.id])).toEqual([['a', 'r1'], ['a', 'r2']]);
  });

  it('never suggests a pair again once linked or kept separate', () => {
    expect(linkSuggestions(local, keys, remote, [['a', 'r1']], []).map((s) => s.remote.id)).toEqual(['r2']);
    expect(linkSuggestions(local, keys, remote, [], [pairKey('r2', 'a')]).map((s) => s.remote.id)).toEqual(['r1']);
  });

  it('suggests nothing for a project with no remote, or a remote no other machine has', () => {
    expect(linkSuggestions([p('c')], keys, remote, [], [])).toEqual([]);
    expect(linkSuggestions([p('b')], keys, remote, [], [])).toEqual([]);
  });
});
