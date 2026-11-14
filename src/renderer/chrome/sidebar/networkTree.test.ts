import { describe, expect, it, beforeEach } from 'vitest';
import { buildNetworkProjects, groupPairs, mergeLinks, pairKey, pruneLinks, splitLinks } from './networkTree';
import { useNetworkSidebarStore, _resetNetworkSidebarForTesting } from './networkSidebarStore';

const p = (id: string) => ({ id, name: id, path: `/${id}` });
const local = [p('a'), p('b')];
const remote = { s1: [p('r||s1||a'), p('r||s1||c')], s2: [p('r||s2||d')] };
const machineOf = (id: string) => (id.startsWith('r||') ? id.split('||')[1] : null);
const build = (over: Partial<Parameters<typeof buildNetworkProjects>[0]> = {}) =>
  buildNetworkProjects({ local, remote, machineOrder: ['s1', 's2'], links: [], show: 'all', machineOf, ...over });

describe('the sidebar across machines (#3065)', () => {
  it('lists this machine\'s projects first, then each machine\'s in the given machine order', () => {
    expect(build().projects.map((x) => x.id)).toEqual(['a', 'b', 'r||s1||a', 'r||s1||c', 'r||s2||d']);
    expect(build({ machineOrder: ['s2', 's1'] }).projects.map((x) => x.id)).toEqual(['a', 'b', 'r||s2||d', 'r||s1||a', 'r||s1||c']);
  });

  it('shows linked projects as one group under this machine\'s, wherever the others are', () => {
    const out = build({ links: [['r||s1||a', 'a']] });
    expect(out.projects.map((x) => x.id)).toEqual(['a', 'b', 'r||s1||c', 'r||s2||d']);
    expect(out.members.a).toEqual(['a', 'r||s1||a']);
    // Two other machines' projects: under the first in the list.
    const remoteOnly = build({ links: [['r||s2||d', 'r||s1||c']] });
    expect(remoteOnly.members['r||s1||c']).toEqual(['r||s1||c', 'r||s2||d']);
  });

  it('narrows to one machine with Show, splitting a group to that machine\'s part', () => {
    expect(build({ show: 'local' }).projects.map((x) => x.id)).toEqual(['a', 'b']);
    expect(build({ show: 's1' }).projects.map((x) => x.id)).toEqual(['r||s1||a', 'r||s1||c']);
    const linked = build({ show: 's1', links: [['a', 'r||s1||a']] });
    expect(linked.members['r||s1||a']).toEqual(['r||s1||a']);
    // A machine with nothing to show, or gone: an empty list, not an error.
    expect(build({ show: 'gone' }).projects).toEqual([]);
  });

  it('merges groups, splits them, and drops projects that are gone', () => {
    let links = mergeLinks([], 'a', 'r||s1||a');
    links = mergeLinks(links, 'r||s2||d', 'a');
    expect(links.map((g) => [...g].sort())).toEqual([['a', 'r||s1||a', 'r||s2||d']]);
    expect(splitLinks(links, 'r||s2||d')).toEqual([]);
    expect(pruneLinks([['a', 'gone'], ['b', 'c', 'gone']], (id) => id !== 'gone')).toEqual([['b', 'c']]);
    expect(groupPairs(['x', 'y', 'z'])).toEqual([pairKey('x', 'y'), pairKey('x', 'z'), pairKey('y', 'z')]);
    expect(pairKey('b', 'a')).toBe(pairKey('a', 'b'));
  });
});

describe('what the sidebar across machines remembers', () => {
  beforeEach(() => _resetNetworkSidebarForTesting());

  it('keeps Show local and preserves legacy links and Keep separate values', () => {
    const legacy = { links: [['old', 'copy']], keptSeparate: ['old\ncopy'] };
    localStorage.setItem('clubhouse.networkSidebar', JSON.stringify(legacy));
    const s = useNetworkSidebarStore.getState();
    s.setShow('s1');
    s.link('a', 'r||s1||a');
    s.keepSeparate('b', 'r||s1||c');
    const saved = JSON.parse(localStorage.getItem('clubhouse.networkSidebar')!);
    expect(saved).toEqual({ show: 's1', ...legacy });
  });

  it('a split remembers its pairs as kept separate, and linking them again forgets that', () => {
    const s = useNetworkSidebarStore.getState();
    s.link('a', 'r||s1||a');
    s.split('a');
    expect(useNetworkSidebarStore.getState().links).toEqual([]);
    expect(useNetworkSidebarStore.getState().keptSeparate).toEqual([pairKey('a', 'r||s1||a')]);
    s.link('r||s1||a', 'a');
    expect(useNetworkSidebarStore.getState().keptSeparate).toEqual([]);
  });

  it('prunes projects that are gone, keeping the rest', () => {
    const s = useNetworkSidebarStore.getState();
    s.link('a', 'r||s1||a');
    s.link('b', 'r||s2||d');
    s.prune((id) => !id.startsWith('r||s1||'));
    expect(useNetworkSidebarStore.getState().links).toEqual([['b', 'r||s2||d']]);
  });
});
