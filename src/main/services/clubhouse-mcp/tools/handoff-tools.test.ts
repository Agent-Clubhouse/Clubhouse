import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpToolHandler } from '../types';
const state = vi.hoisted(() => ({
  handlers: new Map<string, McpToolHandler>(), options: new Map<string, unknown>(),
  offer: vi.fn(), respond: vi.fn(), get: vi.fn(), list: vi.fn(), cancel: vi.fn(), prepare: vi.fn(),
  target: { agentId: 'receiver', machine: Array(16).fill('ab').join(':') } as { agentId: string; machine: string },
}));
vi.mock('../tool-registry', () => ({ registerGlobalTool: (name: string, _definition: unknown, handler: McpToolHandler, options: unknown) => { state.handlers.set(name, handler); state.options.set(name, options); } }));
vi.mock('../arg-targets', () => ({ setHandoffGrantTargetResolver: vi.fn() }));
vi.mock('../ask-first', () => ({ describeCallsForAsk: vi.fn() }));
vi.mock('../handoff-permissions', () => ({
  HANDOFF_OFFER_GRANT: { actions: ['handoff.offer'], target: 'handoff_peer' }, HANDOFF_ACCEPT_GRANT: { actions: ['handoff.accept'], target: 'handoff_peer' },
  withHandoffAgreementCall: (_call: unknown, work: () => unknown) => work(),
}));
vi.mock('../../handoff-host', () => ({
  resolveHandoffTarget: async () => state.target, localHandoffAgent: (agentId: string) => ({ agentId, machine: Array(16).fill('ab').join(':') }), handoffSenderName: async () => 'Caller name',
  prepareNewHandoffHelper: (...args: unknown[]) => state.prepare(...args),
  handoffHost: () => ({ coordinator: { offer: state.offer, respond: state.respond, cancel: state.cancel, service: { get: state.get, list: state.list } }, commands: { list: () => [] } }),
}));
import { registerHandoffTools } from './handoff-tools';
const id = '17551191-93a4-4c8b-82d2-22629701d891';
const call = (name: string, args: Record<string, unknown>) => state.handlers.get(name)!('caller', args);
beforeEach(() => {
  vi.clearAllMocks();
  state.target = { agentId: 'receiver', machine: Array(16).fill('ab').join(':') };
  state.offer.mockResolvedValue({ id, state: 'offered' });
  state.respond.mockResolvedValue({ id, state: 'accepted' });
  state.get.mockReturnValue({ id, state: 'offered' });
  state.list.mockReturnValue([]);
  state.cancel.mockResolvedValue({ id, state: 'cancelled' });
  registerHandoffTools();
});

describe('global handoff tools', () => {
  it('declares agreement grants separately from orchestration and reserves queries for the caller', () => {
    expect(state.handlers.size).toBe(5);
    expect(state.options.get('offer_handoff')).toEqual({ group: 'handoffs', grant: { actions: ['handoff.offer'], target: 'handoff_peer' } });
    expect(state.options.get('respond_to_handoff')).toEqual({ group: 'handoffs', grant: { actions: ['handoff.accept'], target: 'handoff_peer' } });
    for (const name of ['get_handoff', 'list_handoffs', 'cancel_handoff']) expect(state.options.get(name)).toEqual({ group: 'handoffs', grant: { actions: ['agent.read'], target: 'self' } });
  });

  it('offers normalized task metadata with the host-resolved sender and receiver identities', async () => {
    expect((await call('offer_handoff', { to: 'Receiver', task: 'Task', brief: 'Remaining work', mode: 'worktree' })).isError).not.toBe(true);
    expect(state.offer).toHaveBeenCalledWith({ to: state.target, senderName: 'Caller name', task: { title: 'Task', brief: 'Remaining work' }, mode: 'worktree' }, { agentId: 'caller', machine: state.target.machine });
  });

  it.each([
    ['offer_handoff', { to: 'Receiver', task: 'Task', brief: 'Work', mode: 'patch' }],
    ['respond_to_handoff', { id, accept: false, target_agent: 'new_helper' }],
    ['respond_to_handoff', { id, accept: true, target_project: 'ambiguous' }],
    ['get_handoff', { id, machine: 'other' }], ['list_handoffs', { direction: 'all' }], ['cancel_handoff', { id, reason: '' }],
  ])('refuses malformed %s input before changing an agreement', async (name, args) => {
    expect((await call(name as string, args as Record<string, unknown>)).isError).toBe(true);
    expect(state.offer).not.toHaveBeenCalled(); expect(state.respond).not.toHaveBeenCalled(); expect(state.cancel).not.toHaveBeenCalled();
  });

  it('does not accept while a fresh helper still needs creation approval', async () => {
    const pending = { content: [{ type: 'text' as const, text: JSON.stringify({ state: 'needs_approval' }) }] };
    state.prepare.mockResolvedValue(pending);
    expect(await call('respond_to_handoff', { id, accept: true, target_agent: 'new_helper' })).toEqual(pending);
    expect(state.respond).not.toHaveBeenCalled();
    state.prepare.mockResolvedValue(state.target);
    expect((await call('respond_to_handoff', { id, accept: true, target_agent: 'new_helper' })).isError).not.toBe(true);
    expect(state.respond).toHaveBeenCalledWith(id, { agentId: 'caller', machine: state.target.machine }, true, state.target, undefined);
  });

  it('forbids redirecting acceptance to another machine and keeps query/cancel actor local', async () => {
    state.target = { ...state.target, machine: Array(16).fill('cd').join(':') };
    expect((await call('respond_to_handoff', { id, accept: true, target_agent: 'remote' })).isError).toBe(true);
    expect(state.respond).not.toHaveBeenCalled();
    await call('get_handoff', { id }); await call('list_handoffs', { direction: 'received', state: 'offered' }); await call('cancel_handoff', { id, reason: 'Reassigned' });
    const actor = { agentId: 'caller', machine: Array(16).fill('ab').join(':') };
    expect(state.get).toHaveBeenCalledWith(id, actor); expect(state.list).toHaveBeenCalledWith(actor, 'received', 'offered'); expect(state.cancel).toHaveBeenCalledWith(id, actor, 'Reassigned');
  });

  it('does not reflect private peer or storage diagnostics in any tool failure', async () => {
    const privateError = new Error('private-peer/private-path ghp_' + 'a'.repeat(36));
    state.offer.mockRejectedValue(privateError); state.respond.mockRejectedValue(privateError); state.get.mockImplementation(() => { throw privateError; }); state.list.mockImplementation(() => { throw privateError; }); state.cancel.mockRejectedValue(privateError);
    for (const [name, args] of [['offer_handoff', { to: 'receiver', task: 'Task', brief: 'Work', mode: 'branch' }], ['respond_to_handoff', { id, accept: true }], ['get_handoff', { id }], ['list_handoffs', {}], ['cancel_handoff', { id }]] as const) {
      const result = await call(name, args);
      expect(result.isError).toBe(true); expect(JSON.stringify(result)).not.toContain('private-'); expect(JSON.stringify(result)).not.toContain('ghp_');
    }
  });
});
