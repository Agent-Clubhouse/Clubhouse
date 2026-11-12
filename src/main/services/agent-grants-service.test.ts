import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableAgentConfig } from '../../shared/types';

const mocks = vi.hoisted(() => ({
  config: {} as Partial<DurableAgentConfig>,
  setOrchestrationPolicy: vi.fn(async (_p: string, _a: string, patch: Record<string, unknown>) => {
    mocks.config = { ...mocks.config, orchestration: { ...mocks.config.orchestration, ...patch } } as Partial<DurableAgentConfig>;
    return { ok: true, message: '' };
  }),
  changes: undefined as unknown,
  pending: false,
  invalidate: vi.fn(async (_id: string) => {}),
}));
vi.mock('./durable-grant-approvals', () => ({ invalidateCallApprovalsFor: mocks.invalidate }));
vi.mock('./agent-config', () => ({ getDurableConfig: vi.fn(async () => mocks.config) }));
vi.mock('./orchestration-policy', () => ({ setOrchestrationPolicy: mocks.setOrchestrationPolicy }));
vi.mock('./agent-grants-store', () => ({
  agentGrantChangePending: () => mocks.pending,
  withAgentGrantChange: <T,>(_id: string, change: () => Promise<T>) => change(),
  getAgentGrantChanges: () => mocks.changes,
  updateAgentGrantChanges: vi.fn(async (_id: string, fn: (c: unknown) => unknown) => { mocks.changes = fn(mocks.changes); }),
}));
const changes = vi.hoisted(() => [] as unknown[]);
vi.mock('./grant-telemetry', () => ({ recordGrantChange: (c: unknown) => { changes.push(c); } }));
vi.mock('./dispatcher/dispatcher-service', () => ({
  isDispatcherAgentId: () => false,
  resolveDispatcherIdentity: (projectPath: string, agentId: string) => ({ projectPath, agentId }),
}));

import { applyTemplateGrants, grantsFromFacts, readAgentGrants, resetAgentGrants, setAgentGrant } from './agent-grants-service';
import { updateAgentGrantChanges } from './agent-grants-store';
import { GRANT_OFF_PERSISTENCE_FAILED } from '../../shared/agent-grant-changes';
import { callerGrants, checkToolGrant, registerActionOwnerLookup } from './clubhouse-mcp/grant-check';
import { bindingManager } from './clubhouse-mcp/binding-manager';
import { setDispatcherIdLookup } from './clubhouse-mcp/dispatcher-gate';
import * as defaults from '../../shared/default-grants';

const row = (view: Awaited<ReturnType<typeof readAgentGrants>>, action: string, kind: string) =>
  view.rows.find((r) => r.action === action && r.target.kind === kind);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config = { id: 'o1', name: 'Orch', orchestration: { orchestrate: true, control: 'hands-off' } } as Partial<DurableAgentConfig>;
  mocks.changes = undefined;
  mocks.pending = false;
  mocks.invalidate.mockResolvedValue(undefined);
  registerActionOwnerLookup(null);
  bindingManager._resetForTesting();
});
afterEach(() => {
  vi.restoreAllMocks();
  bindingManager._resetForTesting();
  setDispatcherIdLookup(null);
});

describe('restrictive Off when approval storage fails', () => {
  const app = { action: 'settings.app.write' as const, target: { kind: 'app' as const } };
  beforeEach(() => { mocks.changes = { changes: [{ ...app, mode: 'ask' }] }; });

  it('saves Off despite receipt-only failure and returns explicit partial status with actual fresh-matcher refusal', async () => {
    mocks.invalidate.mockRejectedValueOnce(new Error('receipt disk failed'));
    const actual = await setAgentGrant('/p', 'o1', { ...app, mode: 'off' });
    expect(actual.partialFailure).toMatchObject({ code: 'approval_revocation_failed', effectiveOff: true });
    expect(actual.partialFailure?.message).toContain('Permission is Off');
    expect(mocks.changes).toBeUndefined();
  });

  it('does not claim Off when a wider ANY Ask still matches the app target', async () => {
    mocks.changes = { changes: [{ ...app, mode: 'ask' }, { action: app.action, target: { kind: 'any' }, mode: 'ask' }] };
    mocks.invalidate.mockRejectedValueOnce(new Error('receipt disk failed'));
    const actual = await setAgentGrant('/p', 'o1', { ...app, mode: 'off' });
    expect(actual.partialFailure?.effectiveOff).toBe(false);
    expect(actual.partialFailure?.message).not.toContain('Permission is Off');
    expect(actual.partialFailure?.message).toContain('other matching permissions');
  });

  it('reads current caller facts again instead of returning the configuration from before revocation', async () => {
    mocks.invalidate.mockImplementationOnce(async () => {
      mocks.config = { ...mocks.config, orchestration: { orchestrate: false } };
      throw new Error('receipt disk failed');
    });
    const actual = await setAgentGrant('/p', 'o1', { ...app, mode: 'off' });
    expect(actual.orchestrates).toBe(false);
    expect(actual.partialFailure?.effectiveOff).toBe(true);
  });

  it.each(['ask', 'allow'] as const)('does not widen to %s until old receipts are durably revoked', async (mode) => {
    mocks.invalidate.mockRejectedValueOnce(new Error('receipt disk failed'));
    await expect(setAgentGrant('/p', 'o1', { ...app, mode })).rejects.toThrow('receipt disk failed');
    expect(updateAgentGrantChanges).not.toHaveBeenCalled();
  });

  it('blocks reset and mixed template changes rather than sneaking an Allow through the Off exception', async () => {
    mocks.invalidate.mockRejectedValueOnce(new Error('receipt disk failed'));
    await expect(resetAgentGrants('/p', 'o1')).rejects.toThrow('receipt disk failed');
    mocks.invalidate.mockRejectedValueOnce(new Error('receipt disk failed'));
    await expect(applyTemplateGrants('o1', [{ ...app, mode: 'off' }, { action: 'library.write', target: { kind: 'any' }, mode: 'allow' }])).rejects.toThrow('receipt disk failed');
    expect(updateAgentGrantChanges).not.toHaveBeenCalled();
  });

  it('aggregates both failures without claiming Off or changing the old saved policy', async () => {
    mocks.invalidate.mockRejectedValueOnce(new Error('receipt disk failed'));
    vi.mocked(updateAgentGrantChanges).mockRejectedValueOnce(new Error('policy disk failed'));
    const saving = setAgentGrant('/p', 'o1', { ...app, mode: 'off' });
    await expect(saving).rejects.toMatchObject({ message: GRANT_OFF_PERSISTENCE_FAILED, errors: expect.arrayContaining([expect.any(Error), expect.any(Error)]) });
    expect(mocks.changes).toEqual({ changes: [{ ...app, mode: 'ask' }] });
  });

  it('does not claim an OWN Action is Off while its real registered target still allows through SELF', async () => {
    const action = { action: 'action.run' as const, target: { kind: 'action' as const, id: 'owned-action' } };
    registerActionOwnerLookup((args) => args.id === action.target.id ? { actionId: action.target.id, ownerAgentId: 'o1' } : undefined);
    mocks.changes = { changes: [{ ...action, mode: 'ask' }] };
    const check = () => checkToolGrant('o1', { actions: ['action.run'], target: 'action_arg' }, { id: action.target.id });
    expect(check()).toEqual({ ok: true });
    mocks.invalidate.mockRejectedValueOnce(new Error('receipt disk failed'));
    const actual = await setAgentGrant('/p', 'o1', { ...action, mode: 'off' });
    expect(check()).toEqual({ ok: true });
    expect(actual.partialFailure?.effectiveOff).toBe(false);
    expect(actual.partialFailure?.message).not.toContain('Permission is Off');
  });

  it.each(['ask', 'off'] as const)('checks both Action ownership contexts when SELF is %s', async (mode) => {
    const action = { action: 'action.run' as const, target: { kind: 'action' as const, id: 'owned-action' } };
    registerActionOwnerLookup((args) => args.id === action.target.id ? { actionId: action.target.id, ownerAgentId: 'o1' } : undefined);
    mocks.changes = { changes: [{ ...action, mode: 'ask' }, { action: action.action, target: { kind: 'self' }, mode }] };
    const check = () => checkToolGrant('o1', { actions: ['action.run'], target: 'action_arg' }, { id: action.target.id });
    expect(check()).toMatchObject({ ok: false, reason: 'ask_first' });
    mocks.invalidate.mockRejectedValueOnce(new Error('receipt disk failed'));
    const actual = await setAgentGrant('/p', 'o1', { ...action, mode: 'off' });
    expect(check()).toMatchObject({ ok: false, reason: mode === 'ask' ? 'ask_first' : 'no_grant' });
    expect(actual.partialFailure?.effectiveOff).toBe(mode === 'off');
  });
});

it('derives fresh trusted connection facts in every reader, ignores injected facts and preserves choices and pending denial', async () => {
  const observed = vi.spyOn(defaults, 'defaultGrants');
  const facts = { dispatcher: false, helper: false, orchestrates: false, crossProject: false, connectedToDispatcher: true };
  mocks.changes = { changes: [{ action: 'settings.app.write', target: { kind: 'app' }, mode: 'ask' }] };
  setDispatcherIdLookup((id) => id === 'controller');
  const readers = [() => grantsFromFacts('o1', facts), () => callerGrants('o1'), () => readAgentGrants('/p', 'o1')];
  for (const connected of [false, true, false]) {
    facts.connectedToDispatcher = !connected;
    Object.assign(mocks.config, { connectedToDispatcher: !connected });
    if (connected) bindingManager.bind('o1', { targetKind: 'agent', targetId: 'controller', label: 'Not authority' });
    else bindingManager.unbind('o1', 'controller');
    for (const read of readers) {
      observed.mockClear();
      await read();
      expect(observed).toHaveBeenLastCalledWith(expect.objectContaining({ connectedToDispatcher: connected }));
    }
    expect(grantsFromFacts('o1', facts)).toContainEqual(expect.objectContaining({ action: 'settings.app.write', mode: 'ask' }));
    expect(grantsFromFacts('o1', facts)).toContainEqual(expect.objectContaining({ action: 'connection.manage', target: { kind: 'self' }, mode: 'ask' }));
  }
  mocks.pending = true;
  observed.mockClear();
  expect(grantsFromFacts('o1', facts)).toEqual([]);
  expect(callerGrants('o1')).toEqual([]);
  expect(observed).not.toHaveBeenCalled();
});

describe('start and dispose rows follow the approval setting (#2970)', () => {
  it('shows the setting\'s modes', async () => {
    mocks.config = { ...mocks.config, orchestration: { orchestrate: true, control: 'ask-before-start' } };
    const view = await readAgentGrants('/p', 'o1');
    expect(row(view, 'agent.create', 'project')?.mode).toBe('ask');
    expect(row(view, 'agent.dispose', 'my_helpers')?.mode).toBe('allow');
  });

  it('Ask first on starting helpers changes the setting, not a saved permission', async () => {
    const view = await setAgentGrant('/p', 'o1', { action: 'agent.create', target: { kind: 'project', project: 'own' }, mode: 'ask' });
    expect(mocks.setOrchestrationPolicy).toHaveBeenCalledWith('/p', 'o1', { control: 'ask-before-start' });
    expect(mocks.changes).toBeUndefined();
    expect(row(view, 'agent.create', 'project')?.mode).toBe('ask');
  });

  it('Ask first on removing asks for everything; Allow on both goes back to hands-off', async () => {
    await setAgentGrant('/p', 'o1', { action: 'agent.dispose', target: { kind: 'my_helpers' }, mode: 'ask' });
    expect(mocks.config.orchestration?.control).toBe('ask-everything');
    await setAgentGrant('/p', 'o1', { action: 'agent.dispose', target: { kind: 'my_helpers' }, mode: 'allow' });
    expect(mocks.config.orchestration?.control).toBe('ask-before-start');
    await setAgentGrant('/p', 'o1', { action: 'agent.create', target: { kind: 'project', project: 'own' }, mode: 'allow' });
    expect(mocks.config.orchestration?.control).toBe('hands-off');
  });

  it('refuses Allow on starting while removing asks, which has no setting, rather than doing nothing', async () => {
    mocks.config = { ...mocks.config, orchestration: { orchestrate: true, control: 'ask-everything' } };
    await expect(setAgentGrant('/p', 'o1', { action: 'agent.create', target: { kind: 'project', project: 'own' }, mode: 'allow' })).rejects.toThrow(/Set Delete agents and remove helpers to Allow first/);
    expect(mocks.setOrchestrationPolicy).not.toHaveBeenCalled();
  });

  it('keeps the template\'s layer when a Helper control row changes (#2971)', async () => {
    mocks.changes = { changes: [], template: [{ action: 'agent.message', target: { kind: 'connected' }, mode: 'off' }] };
    await setAgentGrant('/p', 'o1', { action: 'agent.create', target: { kind: 'project', project: 'own' }, mode: 'ask' });
    expect(mocks.changes).toEqual({ changes: [], template: [{ action: 'agent.message', target: { kind: 'connected' }, mode: 'off' }] });
  });

  it('drops a change saved on the row before it followed the setting', async () => {
    mocks.changes = { changes: [
      { action: 'agent.dispose', target: { kind: 'my_helpers' }, mode: 'ask', by: 'user', at: 't' },
      { action: 'settings.app.write', target: { kind: 'app' }, mode: 'allow', by: 'user', at: 't' },
    ] };
    await setAgentGrant('/p', 'o1', { action: 'agent.dispose', target: { kind: 'my_helpers' }, mode: 'allow' });
    expect(mocks.changes).toEqual({ changes: [expect.objectContaining({ action: 'settings.app.write' })] });
  });

  it('starting helpers anywhere is the setting\'s row only with cross-project helpers on', async () => {
    await expect(setAgentGrant('/p', 'o1', { action: 'agent.create', target: { kind: 'project', project: 'any' }, mode: 'ask' })).resolves.toBeDefined();
    expect(mocks.setOrchestrationPolicy).not.toHaveBeenCalled();
  });

  it('Off is refused: turning off orchestration is how', async () => {
    await expect(setAgentGrant('/p', 'o1', { action: 'agent.create', target: { kind: 'project', project: 'own' }, mode: 'off' })).rejects.toThrow(/Let this agent orchestrate/);
    expect(mocks.setOrchestrationPolicy).not.toHaveBeenCalled();
  });

  it('records a change once, and not a save that changes nothing (#2973)', async () => {
    changes.length = 0;
    await setAgentGrant('/p', 'o1', { action: 'settings.app.write', target: { kind: 'app' }, mode: 'ask' });
    await setAgentGrant('/p', 'o1', { action: 'settings.app.write', target: { kind: 'app' }, mode: 'ask' });
    expect(changes).toEqual([expect.objectContaining({ agentId: 'o1', layer: 'own', mode: 'ask', action: 'settings.app.write' })]);
  });

  it('other rows save as before', async () => {
    await setAgentGrant('/p', 'o1', { action: 'settings.app.write', target: { kind: 'app' }, mode: 'ask' });
    expect(mocks.setOrchestrationPolicy).not.toHaveBeenCalled();
    expect(mocks.changes).toMatchObject({ changes: [{ action: 'settings.app.write', mode: 'ask', by: 'user' }] });
  });
});
