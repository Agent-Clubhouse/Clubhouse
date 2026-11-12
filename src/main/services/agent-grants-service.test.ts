import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableAgentConfig } from '../../shared/types';
import { evaluateGrant } from '../../shared/agent-grants';

const mocks = vi.hoisted(() => ({
  config: {} as Partial<DurableAgentConfig>,
  setOrchestrationPolicy: vi.fn(async (_p: string, _a: string, patch: Record<string, unknown>) => {
    mocks.config = { ...mocks.config, orchestration: { ...mocks.config.orchestration, ...patch } } as Partial<DurableAgentConfig>;
    return { ok: true, message: '' };
  }),
  changes: undefined as unknown,
}));
vi.mock('./agent-config', () => ({ getDurableConfig: vi.fn(async () => mocks.config) }));
vi.mock('./orchestration-policy', () => ({ setOrchestrationPolicy: mocks.setOrchestrationPolicy }));
vi.mock('./agent-grants-store', () => ({
  getAgentGrantChanges: () => mocks.changes,
  updateAgentGrantChanges: vi.fn(async (_id: string, fn: (c: unknown) => unknown) => { mocks.changes = fn(mocks.changes); }),
}));
const changes = vi.hoisted(() => [] as unknown[]);
vi.mock('./grant-telemetry', () => ({ recordGrantChange: (c: unknown) => { changes.push(c); } }));
vi.mock('./dispatcher/dispatcher-service', () => ({
  isDispatcherAgentId: () => false,
  resolveDispatcherIdentity: (projectPath: string, agentId: string) => ({ projectPath, agentId }),
}));

import { effectiveAgentGrants, grantsFromFacts, readAgentGrants, setAgentGrant } from './agent-grants-service';
import { bindingManager } from './clubhouse-mcp/binding-manager';
import { setDispatcherIdLookup } from './clubhouse-mcp/dispatcher-gate';

const row = (view: Awaited<ReturnType<typeof readAgentGrants>>, action: string, kind: string) =>
  view.rows.find((r) => r.action === action && r.target.kind === kind);

beforeEach(() => {
  vi.clearAllMocks();
  bindingManager._resetForTesting();
  setDispatcherIdLookup((id) => id === 'real-controller');
  mocks.config = { id: 'o1', name: 'Orch', orchestration: { orchestrate: true, control: 'hands-off' } } as Partial<DurableAgentConfig>;
  mocks.changes = undefined;
});
afterEach(() => setDispatcherIdLookup(null));

describe('trusted remote sender defaults', () => {
  const facts = { dispatcher: false, helper: false, orchestrates: false, crossProject: false };
  const remoteDecision = (grants: ReturnType<typeof grantsFromFacts>, action: 'agent.read' | 'agent.message') => evaluateGrant({
    caller: { kind: 'agent', agentId: 'o1' }, action,
    target: { kind: 'agent', isDispatcher: true, isRemoteDispatcher: true },
  }, grants).outcome;

  it('uses the same live trusted connection in settings, effective grants and cached Actions facts', async () => {
    bindingManager.bind('o1', { targetId: 'real-controller', targetKind: 'agent', label: 'An ordinary label' });
    const view = await readAgentGrants('/p', 'o1');
    expect(row(view, 'agent.read', 'remote_dispatcher')).toMatchObject({ mode: 'allow', source: 'structural' });
    expect(row(view, 'agent.message', 'remote_dispatcher')).toMatchObject({ mode: 'ask', source: 'structural' });
    const effective = await effectiveAgentGrants('/p', 'o1');
    expect(remoteDecision(effective, 'agent.read')).toBe('allow');
    expect(remoteDecision(effective, 'agent.message')).toBe('ask');
    expect(remoteDecision(grantsFromFacts('o1', facts), 'agent.message')).toBe('ask');
    bindingManager.unbind('o1', 'real-controller');
    expect(row(await readAgentGrants('/p', 'o1'), 'agent.read', 'remote_dispatcher')?.mode).toBe('off');
    expect(remoteDecision(grantsFromFacts('o1', facts), 'agent.message')).toBe('refuse');
  });

  it('does not trust an injected connection fact in cached caller facts or durable config', async () => {
    Object.assign(mocks.config, { connectedToDispatcher: true });
    bindingManager.bind('o1', { targetId: 'ordinary', targetKind: 'agent', label: 'Dispatcher' });
    const view = await readAgentGrants('/p', 'o1');
    expect(row(view, 'agent.read', 'remote_dispatcher')?.mode).toBe('off');
    expect(row(view, 'agent.message', 'remote_dispatcher')?.mode).toBe('off');
    const grants = grantsFromFacts('o1', { ...facts, connectedToDispatcher: true });
    expect(remoteDecision(grants, 'agent.read')).toBe('refuse');
    expect(remoteDecision(grants, 'agent.message')).toBe('refuse');
  });

  it('keeps saved remote Off and Allow choices over the trusted connection defaults', async () => {
    bindingManager.bind('o1', { targetId: 'real-controller', targetKind: 'agent', label: 'Controller' });
    mocks.changes = { changes: [
      { action: 'agent.read', target: { kind: 'remote_dispatcher' }, mode: 'off', by: 'user' },
      { action: 'agent.message', target: { kind: 'remote_dispatcher' }, mode: 'allow', by: 'user' },
    ] };
    const view = await readAgentGrants('/p', 'o1');
    expect(row(view, 'agent.read', 'remote_dispatcher')).toMatchObject({ mode: 'off', source: 'user' });
    expect(row(view, 'agent.message', 'remote_dispatcher')).toMatchObject({ mode: 'allow', source: 'user' });
    expect(remoteDecision(await effectiveAgentGrants('/p', 'o1'), 'agent.read')).toBe('refuse');
    expect(remoteDecision(grantsFromFacts('o1', facts), 'agent.message')).toBe('allow');
  });
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
