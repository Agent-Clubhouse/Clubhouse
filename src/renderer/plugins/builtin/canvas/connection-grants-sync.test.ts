import { describe, expect, it, vi } from 'vitest';
import { syncWireTools } from './connection-grants-sync';

const storeWith = (defs: Array<{ agentId: string; targetId: string; disabledTools?: string[] }>) => {
  const updateWireDefinition = vi.fn();
  return {
    updateWireDefinition,
    getState: () => ({ wireDefinitions: defs.map((d) => ({ ...d, targetKind: 'agent' as const, label: d.targetId })), updateWireDefinition }),
  };
};

describe('canvas copies follow the connection store (D129)', () => {
  it('updates a loaded canvas that has the wire, and only when its copy differs', () => {
    const a = storeWith([{ agentId: 'x', targetId: 'y', disabledTools: ['clear_agent'] }]);
    const b = storeWith([{ agentId: 'x', targetId: 'y', disabledTools: ['send_file'] }]);
    const c = storeWith([]);
    syncWireTools([a, b, c], 'x', 'y', ['clear_agent']);
    expect(a.updateWireDefinition).not.toHaveBeenCalled();
    expect(b.updateWireDefinition).toHaveBeenCalledWith('x', 'y', { disabledTools: ['clear_agent'] });
    expect(c.updateWireDefinition).not.toHaveBeenCalled();
  });
});
