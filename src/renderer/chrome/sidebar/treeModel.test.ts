import { describe, it, expect } from 'vitest';
import type { Agent, AgentDetailedStatus } from '../../../shared/types';
import { agentDot, groupProjectAgents, moveProject, orderProjects, projectRollup, selectNeedsAttention } from './treeModel';

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
