import { describe, it, expect, vi } from 'vitest';
import { validateBuiltinPlugin } from '../builtin-plugin-testing';
import { manifest } from './manifest';
import * as reviewModule from './main';
import { createMockContext, createMockAPI } from '../../testing';
import type { AgentInfo, PluginAgentDetailedStatus } from '../../../../shared/plugin-types';

function makeAgent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: 'agent-1',
    name: 'alpha',
    kind: 'durable',
    status: 'running',
    color: '#ff0000',
    projectId: 'proj-1',
    ...overrides,
  };
}

describe('review main', () => {
  it('passes validateBuiltinPlugin', () => {
    const result = validateBuiltinPlugin({ manifest, module: reviewModule });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('activate registers review-prev and review-next commands', () => {
    const ctx = createMockContext({ pluginId: 'review', scope: 'dual' });
    const registerFn = vi.fn(() => ({ dispose: () => {} }));
    const api = createMockAPI({
      commands: {
        register: registerFn,
        execute: async () => {},
        registerWithHotkey: () => ({ dispose: () => {} }),
        getBinding: () => null,
        clearBinding: () => {},
      },
    });

    reviewModule.activate(ctx, api);

    expect(registerFn).toHaveBeenCalledWith('review-prev', expect.any(Function));
    expect(registerFn).toHaveBeenCalledWith('review-next', expect.any(Function));
  });

  it('activate pushes disposables to ctx.subscriptions', () => {
    const ctx = createMockContext({ pluginId: 'review', scope: 'dual' });
    const api = createMockAPI();

    reviewModule.activate(ctx, api);

    expect(ctx.subscriptions).toHaveLength(2);
    expect(typeof ctx.subscriptions[0].dispose).toBe('function');
    expect(typeof ctx.subscriptions[1].dispose).toBe('function');
  });

  it('deactivate does not throw', () => {
    expect(() => reviewModule.deactivate()).not.toThrow();
  });

  it('exports MainPanel component', () => {
    expect(reviewModule.MainPanel).toBeDefined();
    expect(typeof reviewModule.MainPanel).toBe('function');
  });
});

describe('filterAgents', () => {
  const running = makeAgent({ id: 'a1', status: 'running' });
  const sleeping = makeAgent({ id: 'a2', status: 'sleeping' });
  const creating = makeAgent({ id: 'a3', status: 'creating' });
  const errored = makeAgent({ id: 'a4', status: 'error' });

  it('returns all agents when includeSleeping is true', () => {
    const result = reviewModule.filterAgents([running, sleeping, creating, errored], true);
    expect(result).toHaveLength(4);
  });

  it('excludes sleeping agents when includeSleeping is false', () => {
    const result = reviewModule.filterAgents([running, sleeping, creating, errored], false);
    expect(result).toHaveLength(3);
    expect(result.find((a) => a.id === 'a2')).toBeUndefined();
  });

  it('returns empty array when all agents are sleeping and includeSleeping is false', () => {
    const result = reviewModule.filterAgents([sleeping], false);
    expect(result).toHaveLength(0);
  });

  it('returns empty array for empty input', () => {
    const result = reviewModule.filterAgents([], true);
    expect(result).toHaveLength(0);
  });
});

describe('filterNeedsAttention', () => {
  const running = makeAgent({ id: 'a1', status: 'running' });
  const errored = makeAgent({ id: 'a2', status: 'error' });
  const needsPerm = makeAgent({ id: 'a3', status: 'running' });
  const toolErr = makeAgent({ id: 'a4', status: 'running' });
  const idle = makeAgent({ id: 'a5', status: 'running' });

  function makeStatuses(entries: [string, PluginAgentDetailedStatus | null][]): Map<string, PluginAgentDetailedStatus | null> {
    return new Map(entries);
  }

  it('filters to only error/needs_permission/tool_error agents', () => {
    const statuses = makeStatuses([
      ['a1', { state: 'working', message: '' }],
      ['a2', null],
      ['a3', { state: 'needs_permission', message: 'Needs permission' }],
      ['a4', { state: 'tool_error', message: 'Tool error' }],
      ['a5', { state: 'idle', message: '' }],
    ]);
    const result = reviewModule.filterNeedsAttention(
      [running, errored, needsPerm, toolErr, idle],
      statuses,
    );
    expect(result).toHaveLength(3);
    expect(result.map((a) => a.id)).toEqual(['a2', 'a3', 'a4']);
  });

  it('includes agents with status "error" even without detailed status', () => {
    const statuses = makeStatuses([
      ['a2', null],
    ]);
    const result = reviewModule.filterNeedsAttention([errored], statuses);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a2');
  });

  it('returns empty array for empty input', () => {
    const result = reviewModule.filterNeedsAttention([], new Map());
    expect(result).toHaveLength(0);
  });

  it('excludes agents that are working or idle', () => {
    const statuses = makeStatuses([
      ['a1', { state: 'working', message: '' }],
      ['a5', { state: 'idle', message: '' }],
    ]);
    const result = reviewModule.filterNeedsAttention([running, idle], statuses);
    expect(result).toHaveLength(0);
  });
});

describe('filterRemoteAgents', () => {
  const local1 = makeAgent({ id: 'agent-1', name: 'local-alpha' });
  const local2 = makeAgent({ id: 'agent-2', name: 'local-beta' });
  const remote1 = makeAgent({ id: 'remote||sat1||r-agent-1', name: 'remote-alpha' });
  const remote2 = makeAgent({ id: 'remote||sat2||r-agent-2', name: 'remote-beta' });

  it('returns all agents when includeRemote is true', () => {
    const result = reviewModule.filterRemoteAgents([local1, remote1, local2, remote2], true);
    expect(result).toHaveLength(4);
  });

  it('excludes remote agents when includeRemote is false', () => {
    const result = reviewModule.filterRemoteAgents([local1, remote1, local2, remote2], false);
    expect(result).toHaveLength(2);
    expect(result.map((a) => a.id)).toEqual(['agent-1', 'agent-2']);
  });

  it('returns empty array when all agents are remote and includeRemote is false', () => {
    const result = reviewModule.filterRemoteAgents([remote1, remote2], false);
    expect(result).toHaveLength(0);
  });

  it('returns all local agents when there are no remote agents', () => {
    const result = reviewModule.filterRemoteAgents([local1, local2], false);
    expect(result).toHaveLength(2);
  });

  it('returns empty array for empty input', () => {
    const result = reviewModule.filterRemoteAgents([], false);
    expect(result).toHaveLength(0);
  });
});

describe('resolveIndex', () => {
  it('wraps forward at the end', () => {
    expect(reviewModule.resolveIndex(4, 5, 1)).toBe(0);
  });

  it('wraps backward at the start', () => {
    expect(reviewModule.resolveIndex(0, 5, -1)).toBe(4);
  });

  it('advances forward normally', () => {
    expect(reviewModule.resolveIndex(2, 5, 1)).toBe(3);
  });

  it('goes backward normally', () => {
    expect(reviewModule.resolveIndex(2, 5, -1)).toBe(1);
  });

  it('returns 0 for empty list', () => {
    expect(reviewModule.resolveIndex(0, 0, 1)).toBe(0);
    expect(reviewModule.resolveIndex(0, 0, -1)).toBe(0);
  });

  it('stays at 0 for single-element list', () => {
    expect(reviewModule.resolveIndex(0, 1, 1)).toBe(0);
    expect(reviewModule.resolveIndex(0, 1, -1)).toBe(0);
  });
});
