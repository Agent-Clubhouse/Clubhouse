import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpToolHandler } from '../types';
const state = vi.hoisted(() => ({
  handlers: new Map<string, McpToolHandler>(), options: new Map<string, unknown>(),
  defaultTarget: vi.fn(), snapshot: vi.fn(), ensure: vi.fn(), check: vi.fn(), offer: vi.fn(), respond: vi.fn(), get: vi.fn(), list: vi.fn(), cancel: vi.fn(), prepare: vi.fn(),
  target: { agentId: 'receiver', machine: Array(16).fill('ab').join(':') } as { agentId: string; machine: string },
}));
vi.mock('../../handoff-preparations', () => ({ prepareCallerHandoff: (...args: unknown[]) => state.snapshot(...args), ensurePreparedHandoff: (...args: unknown[]) => state.ensure(...args) }));
vi.mock('../../handoff-preflight-host', () => ({ checkCallerHandoff: (...args: unknown[]) => state.check(...args) }));
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
  defaultHandoffReceivingAgent: (...args: unknown[]) => state.defaultTarget(...args),
  handoffHost: () => ({ coordinator: { offer: state.offer, respond: state.respond, cancel: state.cancel, service: { get: state.get, list: state.list } }, commands: { list: () => [] } }),
}));
import { registerHandoffTools } from './handoff-tools';
const id = '17551191-93a4-4c8b-82d2-22629701d891';
const call = (name: string, args: Record<string, unknown>) => state.handlers.get(name)!('caller', args);
beforeEach(() => {
  vi.clearAllMocks();
  state.target = { agentId: 'receiver', machine: Array(16).fill('ab').join(':') };
  state.ensure.mockResolvedValue({ fileCount: 1, totalBytes: 5, sha256: 'a'.repeat(64) });
  state.snapshot.mockResolvedValue({ ready: true }); state.defaultTarget.mockResolvedValue(undefined);
  state.offer.mockResolvedValue({ id, state: 'offered' });
  state.respond.mockResolvedValue({ id, state: 'accepted' });
  state.get.mockReturnValue({ id, state: 'offered' });
  state.list.mockReturnValue([]);
  state.cancel.mockResolvedValue({ id, state: 'cancelled' });
  registerHandoffTools();
});

describe('global handoff tools', () => {
  it('declares agreement grants separately from orchestration and reserves queries for the caller', () => {
    expect(state.handlers.size).toBe(7);
    expect(state.options.get('offer_handoff')).toEqual({ group: 'handoffs', grant: { actions: ['handoff.offer'], target: 'handoff_peer' } });
    expect(state.options.get('respond_to_handoff')).toEqual({ group: 'handoffs', grant: { actions: ['handoff.accept'], target: 'handoff_peer' } });
    for (const name of ['get_handoff', 'list_handoffs', 'cancel_handoff']) expect(state.options.get(name)).toEqual({ group: 'handoffs', grant: { actions: ['agent.read'], target: 'self' } });
  });

  it('offers normalized task metadata with the host-resolved sender and receiver identities', async () => {
    expect((await call('offer_handoff', { to: 'Receiver', task: 'Task', brief: 'Remaining work', mode: 'worktree' })).isError).not.toBe(true);
    expect(state.offer).toHaveBeenCalledWith({ to: state.target, senderName: 'Caller name', task: { title: 'Task', brief: 'Remaining work' }, mode: 'worktree', manifest: { fileCount: 1, totalBytes: 5, sha256: 'a'.repeat(64) } }, { agentId: 'caller', machine: state.target.machine });
  });

  it('reports automatic preparation ceilings and largest files before creating or posting an offer', async () => {
    const { HandoffSnapshotError } = await import('../../handoff-snapshot');
    const error = new HandoffSnapshotError('bounds_exceeded');
    error.boundsReport = { totalBytes: 900, fileCount: 1, largestFiles: [{ path: 'fixture.bin', size: 900 }], bounds: { totalBytes: 800, perFileBytes: 800, maxFiles: 10 } };
    state.ensure.mockRejectedValueOnce(error);
    const result = await call('offer_handoff', { to: 'Receiver', task: 'Task', brief: 'Work', mode: 'worktree' });
    expect(JSON.parse(result.content[0].text as string)).toMatchObject({ ready: false, reason: 'bounds_exceeded', ...error.boundsReport });
    expect(state.offer).not.toHaveBeenCalled();
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

  it("uses the Dispatcher matching-project selection before accepting without an explicit target", async () => {
    state.defaultTarget.mockResolvedValue(state.target);
    expect((await call('respond_to_handoff', { id, accept: true })).isError).not.toBe(true);
    expect(state.defaultTarget).toHaveBeenCalledWith('caller', id);
    expect(state.respond).toHaveBeenCalledWith(id, { agentId: 'caller', machine: state.target.machine }, true, state.target, undefined);
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


it('preflights only the authenticated caller and refuses path, policy and rule overrides', async () => {
  state.check.mockResolvedValue({ ready: false, findings: [{ path: 'fixture.txt', rule: 'github-token', line: 2 }] });
  const include = { tracked_changes: true, untracked: true, ignored: ['fixtures/example.txt'] };
  expect((await call('check_handoff', { include, exclude: ['build/**'] })).isError).not.toBe(true);
  expect(state.check).toHaveBeenCalledWith('caller', include, ['build/**']);
  state.check.mockClear();
  for (const args of [{ source: 'other' }, { project: 'other' }, { notSecretPaths: ['fixture.txt'] }, { secretPolicy: {} }, { include: { allow_secrets: true } }]) expect((await call('check_handoff', args)).isError).toBe(true);
  expect(state.check).not.toHaveBeenCalled();
});

it('prepares only the authenticated caller selection, returns frozen results, and rejects policy overrides', async () => {
  const include = { ignored: ['fixtures/**'] };
  expect((await call('prepare_handoff', { mode: 'worktree', include, exclude: ['build/**'] })).isError).not.toBe(true);
  expect(state.snapshot).toHaveBeenCalledWith('caller', 'worktree', { include, exclude: ['build/**'] });
  state.snapshot.mockClear();
  expect((await call('prepare_handoff', { mode: 'worktree', bounds: { totalBytes: 999999 } })).isError).toBe(true);
  expect(state.snapshot).not.toHaveBeenCalled();
});

it.each(['prepare_handoff', 'offer_handoff'])('returns actionable repository prerequisites from %s without an offer', async (name) => {
  const { HandoffSnapshotError } = await import('../../handoff-snapshot');
  for (const reason of ['not_a_repository', 'no_commits', 'invalid_repository'] as const) {
    const error = new HandoffSnapshotError(reason);
    if (name === 'prepare_handoff') state.snapshot.mockRejectedValueOnce(error);
    else state.ensure.mockRejectedValueOnce(error);
    const result = await call(name, name === 'prepare_handoff' ? { mode: 'worktree' } : { to: 'Receiver', task: 'Task', brief: 'Work', mode: 'worktree' });
    expect(JSON.parse(result.content[0].text as string)).toEqual({ ready: false, reason, findings: [], instruction: error.instruction });
    expect(state.offer).not.toHaveBeenCalled();
  }
});
