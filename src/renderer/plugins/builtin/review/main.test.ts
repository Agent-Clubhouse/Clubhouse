import { describe, it, expect, vi } from 'vitest';
import { validateBuiltinPlugin } from '../builtin-plugin-testing';
import { manifest } from './manifest';
import * as reviewModule from './main';
import { createMockContext, createMockAPI } from '../../testing';
import type { AgentInfo } from '../../../../shared/plugin-types';

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
