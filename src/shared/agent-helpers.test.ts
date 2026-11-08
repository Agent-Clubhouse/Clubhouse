import { describe, it, expect } from 'vitest';
import { isDisposedAgent, parentLinkError } from './agent-helpers';

describe('isDisposedAgent', () => {
  it('is true only when disposedAt is set', () => {
    expect(isDisposedAgent({ disposedAt: '2026-10-18T00:00:00.000Z' })).toBe(true);
    expect(isDisposedAgent({})).toBe(false);
    expect(isDisposedAgent(null)).toBe(false);
    expect(isDisposedAgent(undefined)).toBe(false);
  });
});

describe('parentLinkError', () => {
  const agents = [
    { id: 'a' },
    { id: 'b', parentAgentId: 'a' },
    { id: 'c', parentAgentId: 'b' },
    { id: 'd' },
  ];

  it('accepts a link to an unrelated or ancestor agent', () => {
    expect(parentLinkError(agents, 'd', 'c')).toBeNull();
    expect(parentLinkError(agents, 'c', 'a')).toBeNull();
  });

  it('rejects self-parenting', () => {
    expect(parentLinkError(agents, 'a', 'a')).toMatch(/own parent/);
  });

  it('rejects direct and transitive cycles', () => {
    expect(parentLinkError(agents, 'a', 'b')).toMatch(/cycle/);
    expect(parentLinkError(agents, 'a', 'c')).toMatch(/cycle/);
  });

  it('rejects unknown agents', () => {
    expect(parentLinkError(agents, 'a', 'zz')).toMatch(/Parent agent not found/);
    expect(parentLinkError(agents, 'zz', 'a')).toMatch(/^Agent not found/);
  });

  it('terminates on a cycle already present above the parent', () => {
    const looped = [{ id: 'x', parentAgentId: 'y' }, { id: 'y', parentAgentId: 'x' }, { id: 'n' }];
    expect(parentLinkError(looped, 'n', 'x')).toBeNull();
  });
});
