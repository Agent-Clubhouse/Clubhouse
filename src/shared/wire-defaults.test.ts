import { describe, expect, it } from 'vitest';
import { newWireDisabledTools } from './wire-defaults';

describe('what a new wire starts with (#2969)', () => {
  it('a new agent pair starts with clear and compact off', () => {
    expect(newWireDisabledTools([], 'a', 'b', 'agent')).toEqual(['clear_agent', 'compact_agent']);
  });

  it('a pair that already has a binding keeps its own list (a helper or Dispatcher wire, a wire drawn again)', () => {
    expect(newWireDisabledTools([{ agentId: 'a', targetId: 'b' }], 'a', 'b', 'agent')).toBeUndefined();
    // The other direction is still new.
    expect(newWireDisabledTools([{ agentId: 'a', targetId: 'b' }], 'b', 'a', 'agent')).toEqual(['clear_agent', 'compact_agent']);
  });

  it('other targets get nothing', () => {
    expect(newWireDisabledTools([], 'a', 'w1', 'browser')).toBeUndefined();
    expect(newWireDisabledTools([], 'a', 'gp', 'group-project')).toBeUndefined();
  });
});
