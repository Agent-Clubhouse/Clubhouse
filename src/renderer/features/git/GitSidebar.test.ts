import { describe, it, expect } from 'vitest';
import type { Agent } from '../../../shared/types';
import { getDurableWorktreeAgents, colorHexMap } from './git-sidebar-utils';

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'a1',
    projectId: 'proj_1',
    name: 'alpha-agent',
    kind: 'durable',
    status: 'sleeping',
    color: 'indigo',
    localOnly: false,
    worktreePath: '/repo/.clubhouse/agents/alpha-agent',
    ...overrides,
  };
}

describe('getDurableWorktreeAgents', () => {
  it('returns durable agents with worktreePath for the given project', () => {
    const agents: Record<string, Agent> = {
      a1: makeAgent({ id: 'a1', name: 'bravo', worktreePath: '/wt/bravo' }),
      a2: makeAgent({ id: 'a2', name: 'alpha', worktreePath: '/wt/alpha' }),
    };
    const result = getDurableWorktreeAgents(agents, 'proj_1');
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('alpha');
    expect(result[1].name).toBe('bravo');
  });

  it('excludes quick agents', () => {
    const agents: Record<string, Agent> = {
      a1: makeAgent({ id: 'a1', kind: 'quick', worktreePath: '/wt/a1' }),
      a2: makeAgent({ id: 'a2', kind: 'durable', worktreePath: '/wt/a2' }),
    };
    const result = getDurableWorktreeAgents(agents, 'proj_1');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a2');
  });

  it('excludes agents without worktreePath', () => {
    const agents: Record<string, Agent> = {
      a1: makeAgent({ id: 'a1', worktreePath: undefined }),
      a2: makeAgent({ id: 'a2', worktreePath: '/wt/a2' }),
    };
    const result = getDurableWorktreeAgents(agents, 'proj_1');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a2');
  });

  it('excludes agents from a different project', () => {
    const agents: Record<string, Agent> = {
      a1: makeAgent({ id: 'a1', projectId: 'proj_1' }),
      a2: makeAgent({ id: 'a2', projectId: 'proj_other' }),
    };
    const result = getDurableWorktreeAgents(agents, 'proj_1');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a1');
  });

  it('returns empty array when no agents match', () => {
    const agents: Record<string, Agent> = {
      a1: makeAgent({ id: 'a1', kind: 'quick' }),
    };
    expect(getDurableWorktreeAgents(agents, 'proj_1')).toEqual([]);
  });

  it('returns empty array for undefined projectId', () => {
    const agents: Record<string, Agent> = {
      a1: makeAgent({ id: 'a1' }),
    };
    expect(getDurableWorktreeAgents(agents, undefined)).toEqual([]);
  });

  it('sorts alphabetically by name', () => {
    const agents: Record<string, Agent> = {
      a1: makeAgent({ id: 'a1', name: 'zulu' }),
      a2: makeAgent({ id: 'a2', name: 'alpha' }),
      a3: makeAgent({ id: 'a3', name: 'mike' }),
    };
    const result = getDurableWorktreeAgents(agents, 'proj_1');
    expect(result.map((a) => a.name)).toEqual(['alpha', 'mike', 'zulu']);
  });
});

describe('colorHexMap', () => {
  it('maps known color IDs to hex values', () => {
    expect(colorHexMap['indigo']).toBe('#6366f1');
    expect(colorHexMap['emerald']).toBe('#10b981');
    expect(colorHexMap['rose']).toBe('#f43f5e');
  });

  it('returns undefined for unknown color IDs', () => {
    expect(colorHexMap['nonexistent']).toBeUndefined();
  });
});
