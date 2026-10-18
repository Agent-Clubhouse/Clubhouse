import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpBindingEntry } from '../../../stores/mcpBindingStore';
import { bindWireDefinition } from './wire-binding';

const calls: string[] = [];
beforeEach(() => {
  calls.length = 0;
  window.clubhouse.mcpBinding = {
    ...window.clubhouse.mcpBinding,
    bind: vi.fn(async (agentId: string, target: { targetId: string }) => { calls.push(`bind ${agentId}->${target.targetId}`); }),
    setInstructions: vi.fn(async (_a: string, _t: string, i: Record<string, string>) => { calls.push(`instructions ${JSON.stringify(i)}`); }),
    setDisabledTools: vi.fn(async (_a: string, _t: string, d: string[]) => { calls.push(`disabled ${d.join(',')}`); }),
  } as typeof window.clubhouse.mcpBinding;
});

const def: McpBindingEntry = { agentId: 'a1', targetId: 'a2', targetKind: 'agent', label: 'Reviewer' };

describe('bindWireDefinition', () => {
  it('binds, then applies the wire\'s instructions and disabled tools', async () => {
    await bindWireDefinition({ ...def, instructions: { '*': 'Be brief' }, disabledTools: ['broadcast'] });
    expect(calls).toEqual(['bind a1->a2', 'instructions {"*":"Be brief"}', 'disabled broadcast']);
  });

  it('only binds when the wire carries no instructions or disabled tools', async () => {
    await bindWireDefinition({ ...def, instructions: {}, disabledTools: [] });
    expect(calls).toEqual(['bind a1->a2']);
  });

  it('applies nothing when bind fails', async () => {
    vi.mocked(window.clubhouse.mcpBinding.bind).mockRejectedValueOnce(new Error('MCP disabled'));
    await expect(bindWireDefinition({ ...def, disabledTools: ['broadcast'] })).rejects.toThrow('MCP disabled');
    expect(window.clubhouse.mcpBinding.setDisabledTools).not.toHaveBeenCalled();
  });
});
