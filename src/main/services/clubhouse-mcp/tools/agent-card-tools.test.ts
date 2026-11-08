import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../mcp-call-gate', async (original) => ({ ...await original<typeof import('../mcp-call-gate')>(), mcpCallAccess: () => 'open' }));
vi.mock('../../log-service', () => ({ appLog: vi.fn() }));

const { wired, saveOwnCard } = vi.hoisted(() => ({
  wired: new Set<string>(),
  saveOwnCard: vi.fn(),
}));
vi.mock('../../dispatcher/dispatcher-agent-cards-watch', () => ({
  isWiredToDispatcher: (agentId: string) => wired.has(agentId),
  getAgentCards: () => ({ saveOwnCard }),
}));

import { callTool, getScopedToolList, invalidateToolListCache, listToolGrants, _resetForTesting } from '../tool-registry';
import { _resetDispatcherGateForTesting, setDispatcherAgent } from '../dispatcher-gate';
import { MAX_CARD_FIELD } from '../../dispatcher/dispatcher-agent-cards';
import { registerAgentCardTools } from './agent-card-tools';

// Real wires change the binding version, which refreshes cached tool lists; these fake ones don't.
function wire(agentId: string): void {
  wired.add(agentId);
  invalidateToolListCache();
}

const names = (agentId: string) => getScopedToolList(agentId).map((t) => t.name);

beforeEach(() => {
  vi.clearAllMocks();
  wired.clear();
  _resetForTesting();
  _resetDispatcherGateForTesting();
  registerAgentCardTools();
  saveOwnCard.mockResolvedValue({ ok: true, card: {}, page: 'agents/lead-webapp.md' });
});

describe('update_my_card', () => {
  it('is offered only to agents wired to the Dispatcher, and never to the Dispatcher', async () => {
    expect(names('durable_lead')).not.toContain('update_my_card');
    wire('durable_lead');
    expect(names('durable_lead')).toContain('update_my_card');

    wire('durable_dispatcher');
    setDispatcherAgent('durable_dispatcher', true);
    expect(names('durable_dispatcher')).not.toContain('update_my_card');

    const refused = await callTool('durable_other', 'update_my_card', { purpose: 'x' });
    expect(refused.isError).toBe(true);
    expect(saveOwnCard).not.toHaveBeenCalled();
  });

  it('has no way to name another agent, and writes the caller\'s own card', async () => {
    const tool = getScopedToolList('durable_lead').find((t) => t.name === 'update_my_card');
    expect(tool).toBeUndefined();
    wire('durable_lead');
    const schema = getScopedToolList('durable_lead').find((t) => t.name === 'update_my_card')!.inputSchema as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties).sort()).toEqual(['contact_when', 'owns', 'purpose']);

    const result = await callTool('durable_lead', 'update_my_card', { purpose: ' Leads the web app. ', owns: 'web/', agent: 'durable_qa' });
    expect(result.isError).toBeFalsy();
    expect(saveOwnCard).toHaveBeenCalledWith('durable_lead', { purpose: 'Leads the web app.', owns: 'web/' });
  });

  it('declares agent.display on itself', () => {
    const grant = listToolGrants().find((t) => t.name === 'update_my_card')!.grant;
    expect(grant).toEqual({ actions: ['agent.display'], target: 'self' });
  });

  it('refuses an empty or oversized card before saving', async () => {
    wired.add('durable_lead');
    expect((await callTool('durable_lead', 'update_my_card', {})).isError).toBe(true);
    expect((await callTool('durable_lead', 'update_my_card', { owns: 'x'.repeat(MAX_CARD_FIELD + 1) })).isError).toBe(true);
    expect(saveOwnCard).not.toHaveBeenCalled();
  });

  it('passes on the refusal for an agent that isn\'t connected any more', async () => {
    wired.add('durable_lead');
    saveOwnCard.mockResolvedValue({ ok: false, error: 'not connected' });
    const result = await callTool('durable_lead', 'update_my_card', { purpose: 'x' });
    expect(result).toEqual({ content: [{ type: 'text', text: 'not connected' }], isError: true });
  });
});
