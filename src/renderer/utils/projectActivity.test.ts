import { describe, it, expect } from 'vitest';
import type { Agent, AgentDetailedStatus, AgentStatus, AgentKind } from '../../shared/types';
import {
  arrangeProjects,
  describeProjectActivity,
  isProjectRailMode,
  summarizeProjectActivity,
} from './projectActivity';

function agent(id: string, projectId: string, status: AgentStatus, kind: AgentKind = 'durable'): Agent {
  return { id, projectId, name: id, kind, status, color: 'emerald' };
}

function detail(state: AgentDetailedStatus['state']): AgentDetailedStatus {
  return { state, message: '', timestamp: 0 };
}

function agentMap(...agents: Agent[]): Record<string, Agent> {
  return Object.fromEntries(agents.map((a) => [a.id, a]));
}

describe('summarizeProjectActivity', () => {
  it('counts only running agents, across every agent kind', () => {
    const summaries = summarizeProjectActivity(agentMap(
      agent('a', 'p1', 'running', 'durable'),
      agent('b', 'p1', 'running', 'quick'),
      agent('c', 'p1', 'running', 'companion'),
      agent('d', 'p2', 'sleeping'),
      agent('e', 'p2', 'error'),
      agent('f', 'p3', 'creating'),
      agent('g', 'p3', 'spawning'),
      agent('h', 'p3', 'waking'),
    ), {});
    expect([...summaries.keys()]).toEqual(['p1']);
    expect(summaries.get('p1')).toMatchObject({ running: 3, level: 'running' });
  });

  it('treats a running agent with no detailed status as running, not idle-inactive', () => {
    const summaries = summarizeProjectActivity(agentMap(agent('a', 'p1', 'running')), {});
    expect(summaries.get('p1')?.level).toBe('running');
  });

  it('ranks needs_permission over working over running', () => {
    const agents = agentMap(
      agent('a', 'p1', 'running'), agent('b', 'p1', 'running'),
      agent('c', 'p2', 'running'), agent('d', 'p2', 'running'),
      agent('e', 'p3', 'running'),
    );
    const detailed = {
      a: detail('working'), b: detail('needs_permission'),
      c: detail('working'), d: detail('idle'),
      e: detail('idle'),
    };
    const summaries = summarizeProjectActivity(agents, detailed);
    expect(summaries.get('p1')).toMatchObject({ level: 'needs_permission', working: 1, needsPermission: 1 });
    expect(summaries.get('p2')).toMatchObject({ level: 'working', working: 1 });
    expect(summaries.get('p3')?.level).toBe('running');
  });

  it('ignores detailed status of agents that are not running', () => {
    const summaries = summarizeProjectActivity(
      agentMap(agent('a', 'p1', 'sleeping')),
      { a: detail('needs_permission') },
    );
    expect(summaries.size).toBe(0);
  });

  it('keeps a running agent with a tool error active and counts the error', () => {
    const summaries = summarizeProjectActivity(agentMap(agent('a', 'p1', 'running')), { a: detail('tool_error') });
    expect(summaries.get('p1')).toMatchObject({ level: 'running', toolError: 1 });
  });

  it('keys remote agents by their namespaced project id', () => {
    const nsProject = 'remote||sat-1||p1';
    const summaries = summarizeProjectActivity(
      agentMap(agent('remote||sat-1||a', nsProject, 'running'), agent('a', 'p1', 'sleeping')),
      {},
    );
    expect([...summaries.keys()]).toEqual([nsProject]);
  });
});

describe('describeProjectActivity', () => {
  it('describes inactive and active projects', () => {
    expect(describeProjectActivity(undefined)).toBe('No running agents');
    expect(describeProjectActivity({ level: 'running', running: 1, working: 0, needsPermission: 0, toolError: 0 }))
      .toBe('1 running agent');
    expect(describeProjectActivity({ level: 'needs_permission', running: 3, working: 1, needsPermission: 1, toolError: 2 }))
      .toBe('3 running agents; 1 working; 1 needs permission; 2 tool errors');
  });
});

describe('arrangeProjects', () => {
  const projects = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const active = new Set(['c', 'a']);

  it('all: keeps manual order', () => {
    expect(arrangeProjects(projects, active, 'all', null).map((p) => p.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('active-first: stable partition preserving manual order within groups', () => {
    expect(arrangeProjects(projects, active, 'active-first', null).map((p) => p.id)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('active-only: active projects in manual order', () => {
    expect(arrangeProjects(projects, active, 'active-only', null).map((p) => p.id)).toEqual(['a', 'c']);
  });

  it('active-only: retains the selected project even when inactive', () => {
    expect(arrangeProjects(projects, active, 'active-only', 'd').map((p) => p.id)).toEqual(['a', 'c', 'd']);
  });

  it('never mutates the input order', () => {
    const input = [...projects];
    arrangeProjects(input, active, 'active-first', null);
    expect(input).toEqual(projects);
  });
});

describe('isProjectRailMode', () => {
  it('accepts the three modes and rejects anything else', () => {
    expect(isProjectRailMode('all')).toBe(true);
    expect(isProjectRailMode('active-first')).toBe(true);
    expect(isProjectRailMode('active-only')).toBe(true);
    expect(isProjectRailMode('running')).toBe(false);
    expect(isProjectRailMode(undefined)).toBe(false);
  });
});
