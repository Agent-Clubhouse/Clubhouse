import { describe, it, expect } from 'vitest';
import type { Agent, AgentDetailedStatus } from '../../../shared/types';
import { agentDot, buildProjectTree, descendants, filterTree, groupProjectAgents, helperRollup, siblingGroups, moveProject, moveWithinGroup, orderProjects, sortByRecent, holdOrder, projectRollup, selectNeedsAttention, selectRemoteNeedsAttention, mergeNeedsAttention } from './treeModel';

const agent = (id: string, over: Partial<Agent> = {}): Agent => ({
  id, projectId: 'p1', name: id, kind: 'durable', status: 'running', color: 'blue', ...over,
} as Agent);
const detail = (state: AgentDetailedStatus['state'], message = '', timestamp = 0): AgentDetailedStatus => ({ state, message, timestamp });

describe('agentDot', () => {
  it('ranks error and permission prompts above everything else', () => {
    expect(agentDot(agent('a', { status: 'error' }), detail('working'))).toBe('error');
    expect(agentDot(agent('a'), detail('tool_error'))).toBe('error');
    expect(agentDot(agent('a'), detail('needs_permission'))).toBe('needs');
  });

  it('reports sleeping, starting, working and idle', () => {
    expect(agentDot(agent('a', { status: 'sleeping' }), undefined)).toBe('sleeping');
    expect(agentDot(agent('a', { status: 'waking' }), undefined)).toBe('starting');
    expect(agentDot(agent('a'), detail('working'))).toBe('working');
    expect(agentDot(agent('a'), detail('idle'))).toBe('idle');
    expect(agentDot(agent('a'), undefined)).toBe('idle');
  });
});

describe('selectNeedsAttention', () => {
  it('lists permission prompts, tool errors and errored agents in the given projects, oldest first', () => {
    const agents = {
      a: agent('a'),
      b: agent('b'),
      c: agent('c', { status: 'error', errorMessage: 'crashed' }),
      d: agent('d', { projectId: 'other' }),
      e: agent('e'),
    };
    const detailed = {
      a: detail('needs_permission', 'Wants to run: npm test', 20),
      b: detail('tool_error', 'Bash failed', 10),
      d: detail('needs_permission', 'ignored', 5),
      e: detail('working', '', 1),
    };
    const items = selectNeedsAttention(agents, detailed, new Set(['p1']));
    expect(items.map((i) => [i.agent.id, i.reason, i.message])).toEqual([
      ['c', 'error', 'crashed'],
      ['b', 'tool_error', 'Bash failed'],
      ['a', 'permission', 'Wants to run: npm test'],
    ]);
  });

  it('lists helpers an orchestrator asked to dispose, unless already listed or gone (#2229)', () => {
    const agents = { h: agent('h'), p: agent('p'), x: agent('x', { projectId: 'other' }) };
    const requests = {
      h: { message: 'Orch asked to dispose this helper. 1 uncommitted file.', at: 30 },
      p: { message: 'ignored: a permission prompt comes first', at: 1 },
      x: { message: 'ignored: other project', at: 2 },
      gone: { message: 'ignored: no such agent', at: 3 },
    };
    const items = selectNeedsAttention(agents, { p: detail('needs_permission', 'Wants to run: ls', 5) }, new Set(['p1']), requests);
    expect(items.map((i) => [i.agent.id, i.reason, i.message, i.at])).toEqual([
      ['p', 'permission', 'Wants to run: ls', 5],
      ['h', 'dispose_request', 'Orch asked to dispose this helper. 1 uncommitted file.', 30],
    ]);
  });
});

describe('orderProjects', () => {
  it('puts pinned projects first and keeps saved order inside each group', () => {
    const projects = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
    const { pinned, rest } = orderProjects(projects, ['c', 'a']);
    expect(pinned.map((p) => p.id)).toEqual(['a', 'c']);
    expect(rest.map((p) => p.id)).toEqual(['b', 'd']);
  });
});

describe('moveProject', () => {
  it('moves the dragged project before the target', () => {
    expect(moveProject(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual(['a', 'd', 'b', 'c']);
    expect(moveProject(['a', 'b', 'c', 'd'], 'a', 'c')).toEqual(['b', 'a', 'c', 'd']);
  });

  it('returns null when nothing changes or an id is unknown', () => {
    expect(moveProject(['a', 'b'], 'a', 'a')).toBeNull();
    expect(moveProject(['a', 'b'], 'a', 'b')).toBeNull();
    expect(moveProject(['a', 'b'], 'x', 'b')).toBeNull();
  });
});

describe('groupProjectAgents and projectRollup', () => {
  it('splits durable, sleeping and quick agents and ignores companions', () => {
    const groups = groupProjectAgents([
      agent('d1'),
      agent('d2', { status: 'sleeping' }),
      agent('q1', { kind: 'quick' }),
      agent('c1', { kind: 'companion' }),
    ]);
    expect(groups.durable.map((a) => a.id)).toEqual(['d1']);
    expect(groups.sleeping.map((a) => a.id)).toEqual(['d2']);
    expect(groups.quick.map((a) => a.id)).toEqual(['q1']);
  });

  it('counts working agents and agents waiting on the user', () => {
    const agents = [agent('a'), agent('b'), agent('c'), agent('d', { status: 'sleeping' })];
    expect(projectRollup(agents, { a: detail('working'), b: detail('needs_permission'), c: detail('idle') })).toEqual({ working: 1, waiting: 1 });
  });
});

describe('selectRemoteNeedsAttention', () => {
  const remoteAgent = (id: string, projectId: string) => ({ id, projectId, name: id, kind: 'durable', status: 'running', color: 'blue' }) as Agent;
  const agents = {
    'r||s1||a': remoteAgent('r||s1||a', 'r||s1||p'),
    'r||s2||b': remoteAgent('r||s2||b', 'r||s2||p'),
  };
  const detailed = {
    'r||s1||a': { state: 'needs_permission', message: 'Wants to push', timestamp: 5 },
    'r||s2||b': { state: 'needs_permission', message: 'Wants to run', timestamp: 3 },
  } as Record<string, AgentDetailedStatus>;
  const projects = { s1: [{ id: 'r||s1||p' }], s2: [{ id: 'r||s2||p' }] };

  it('tags items with their host and skips satellites that are not connected', () => {
    const items = selectRemoteNeedsAttention(
      [{ id: 's1', alias: 'Studio', state: 'connected' }, { id: 's2', alias: 'Attic', state: 'disconnected' }],
      projects, agents, detailed,
    );
    expect(items.map((i) => [i.agent.id, i.hostId, i.hostLabel])).toEqual([['r||s1||a', 's1', 'Studio']]);
  });

  it('merges hosts into one queue, oldest first', () => {
    const remote = selectRemoteNeedsAttention(
      [{ id: 's1', alias: 'Studio', state: 'connected' }, { id: 's2', alias: 'Attic', state: 'connected' }],
      projects, agents, detailed,
    );
    const local = [{ agent: remoteAgent('l', 'p1'), reason: 'error' as const, message: 'x', at: 4 }];
    expect(mergeNeedsAttention(local, remote).map((i) => i.agent.id)).toEqual(['r||s2||b', 'l', 'r||s1||a']);
  });
});

describe('filterTree', () => {
  const ag = (id: string, projectId: string, over: Partial<Agent> = {}) =>
    ({ id, projectId, name: id, kind: 'durable', status: 'running', ...over }) as Agent;
  const projects = [{ id: 'p1', name: 'Clubhouse' }, { id: 'p2', name: 'Goobers', displayName: 'Goob' }];
  const byProject = {
    p1: [ag('sleepy-ant', 'p1', { status: 'sleeping' }), ag('brave-ant', 'p1'), ag('quick-ant', 'p1', { kind: 'quick' })],
    p2: [ag('bold-falcon', 'p2')],
  };

  it('is empty for a blank query', () => {
    expect(filterTree('  ', projects, byProject)).toEqual({ groups: [], count: 0 });
  });

  it('keeps matching agents in tree order, sleeping ones last, case-insensitive', () => {
    const { groups, count } = filterTree('ANT', projects, byProject);
    expect(groups).toHaveLength(1);
    expect(groups[0].agents.map((a) => a.name)).toEqual(['brave-ant', 'quick-ant', 'sleepy-ant']);
    expect(count).toBe(3);
  });

  it('matches a project by its shown name, with no agents', () => {
    const { groups, count } = filterTree('goob', projects, byProject);
    expect(groups.map((g) => [g.project.id, g.nameMatch, g.agents.length])).toEqual([['p2', true, 0]]);
    expect(count).toBe(1);
  });
});

describe('moveWithinGroup (#2115)', () => {
  const order = ['a1', 's1', 'a2', 's2', 'a3'];
  const awake = ['a1', 'a2', 'a3'];

  it('moving down lands after the target, so the end of the group is reachable', () => {
    expect(moveWithinGroup(order, awake, 'a1', 'a3')).toEqual(['a2', 's1', 'a3', 's2', 'a1']);
  });

  it('moving up lands before the target', () => {
    expect(moveWithinGroup(order, awake, 'a3', 'a1')).toEqual(['a3', 's1', 'a1', 's2', 'a2']);
  });

  it('keeps agents outside the group at their places', () => {
    const next = moveWithinGroup(order, awake, 'a2', 'a1')!;
    expect(next[1]).toBe('s1');
    expect(next[3]).toBe('s2');
  });

  it('refuses a move that would lose a group member missing from the order', () => {
    expect(moveWithinGroup(['a1', 'a3'], awake, 'a1', 'a3')).toBeNull();
  });

  it('returns null for a no-op or an agent outside the group', () => {
    expect(moveWithinGroup(order, awake, 'a1', 'a1')).toBeNull();
    expect(moveWithinGroup(order, awake, 's1', 'a1')).toBeNull();
    expect(moveWithinGroup(order, awake, 'a1', 's1')).toBeNull();
  });
});

describe('sortByRecent and holdOrder (#2116)', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];

  it('puts the most recent first, items with no activity last, ties in manual order', () => {
    expect(sortByRecent(items, { a: 1, b: 3, c: 3 }).map((i) => i.id)).toEqual(['b', 'c', 'a', 'd']);
    expect(sortByRecent(items, {}).map((i) => i.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('holds a previous order and appends new items in their own order', () => {
    expect(holdOrder(items, ['c', 'a']).map((i) => i.id)).toEqual(['c', 'a', 'b', 'd']);
    expect(holdOrder(items.slice(1), ['a', 'd', 'b']).map((i) => i.id)).toEqual(['d', 'b', 'c']);
  });
});

describe('buildProjectTree (#2231)', () => {
  const ids = (nodes: { agent: { id: string }; children: unknown[] }[]): unknown =>
    nodes.map((n) => (n.children.length ? { [n.agent.id]: ids(n.children as never) } : n.agent.id));

  it('nests helpers under their parent at any depth, keeping sibling order', () => {
    const tree = buildProjectTree([
      agent('lead'), agent('h1', { parentAgentId: 'lead' }), agent('other'),
      agent('h2', { parentAgentId: 'lead' }), agent('h2a', { parentAgentId: 'h2' }),
      agent('q', { kind: 'quick', parentAgentId: 'lead' }),
    ]);
    expect(ids(tree.awake)).toEqual([{ lead: ['h1', { h2: ['h2a'] }] }, 'other']);
    // Quick agents keep their own place and never nest.
    expect(tree.quick.map((a) => a.id)).toEqual(['q']);
  });

  it('shows a helper whose parent is missing, or whose links loop, at the top level', () => {
    const tree = buildProjectTree([
      agent('orphan', { parentAgentId: 'gone' }),
      agent('x', { parentAgentId: 'y' }), agent('y', { parentAgentId: 'x' }),
      agent('z', { parentAgentId: 'x' }),
      agent('self', { parentAgentId: 'self' }),
    ]);
    // x and y loop, so both show at the top; z still nests under x.
    expect(ids(tree.awake)).toEqual(['orphan', { x: ['z'] }, 'y', 'self']);
  });

  it('keeps a sleeping helper under its parent, and folds a parent only when its whole subtree sleeps', () => {
    const tree = buildProjectTree([
      agent('lead', { status: 'sleeping' }), agent('h1', { parentAgentId: 'lead' }),
      agent('nap', { status: 'sleeping' }), agent('nap-h', { status: 'sleeping', parentAgentId: 'nap' }),
      agent('awake'), agent('awake-h', { status: 'sleeping', parentAgentId: 'awake' }),
    ]);
    expect(ids(tree.awake)).toEqual([{ lead: ['h1'] }, { awake: ['awake-h'] }]);
    expect(ids(tree.sleeping)).toEqual([{ nap: ['nap-h'] }]);
  });

  it('reorders within the awake roots, the sleeping roots, or one parent\'s helpers', () => {
    const tree = buildProjectTree([
      agent('a'), agent('a1', { parentAgentId: 'a' }), agent('a2', { parentAgentId: 'a' }),
      agent('b'), agent('s', { status: 'sleeping' }),
    ]);
    expect(siblingGroups(tree)).toEqual([['a', 'b'], ['a1', 'a2'], ['s']]);
    expect(descendants(tree.awake[0]).map((a) => a.id)).toEqual(['a1', 'a2']);
  });
});

describe('helperRollup (#2231)', () => {
  it('counts every helper below, and those that need you or are working', () => {
    const tree = buildProjectTree([
      agent('lead'), agent('h1', { parentAgentId: 'lead' }), agent('h2', { parentAgentId: 'lead' }),
      agent('h2a', { parentAgentId: 'h2' }), agent('h3', { parentAgentId: 'lead', status: 'error' }),
    ]);
    const detailed = { h1: detail('working'), h2a: detail('needs_permission'), lead: detail('needs_permission') };
    expect(helperRollup(tree.awake[0], detailed)).toEqual({ count: 4, needs: 2, working: 1 });
  });
});
