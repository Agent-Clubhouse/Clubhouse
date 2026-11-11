import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableAgentConfig } from '../../../shared/types';
import type { ResolvedOrchestrationPolicy } from '../../../shared/orchestration-policy';

const state = vi.hoisted(() => ({
  base: '', project: '', agents: new Map<string, DurableAgentConfig>(),
  failPolicy: false, afterPolicy: undefined as (() => Promise<void>) | undefined,
}));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => state.base } }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../project-store', () => ({
  list: async () => [{ path: state.project, name: 'Project' }],
  peekProjects: async () => [{ path: state.project, name: 'Project' }],
}));
vi.mock('../dispatcher/dispatcher-settings', async (original) => ({
  ...await original<typeof import('../dispatcher/dispatcher-settings')>(), isDispatcherEnabled: () => true,
}));
vi.mock('../dispatcher/dispatcher-service', () => ({
  getDispatcherAgentId: () => 'dispatcher', isDispatcherEnabled: () => true,
  isDispatcherPath: () => false, dispatcherDisplayName: () => 'Dispatcher',
}));
vi.mock('../agent-config', () => ({
  listDurable: async () => [...state.agents.values()],
  getDurableConfig: async (_p: string, id: string) => state.agents.get(id) ?? null,
  deleteDurable: vi.fn(async (_p: string, id: string) => { state.agents.delete(id); }),
}));
vi.mock('../orchestration-policy', async () => {
  const { resolveOrchestrationPolicy } = await import('../../../shared/orchestration-policy');
  const policy = (a: DurableAgentConfig) => resolveOrchestrationPolicy(a.orchestration, { helper: !!a.parentAgentId });
  return {
    resolveOrchestrationPolicies: async (_p: string, agents: DurableAgentConfig[]) => new Map(agents.map((a) => [a.id, policy(a)])),
    getOrchestrationPolicy: async (_p: string, id: string) => {
      const a = state.agents.get(id);
      return a ? policy(a) : null;
    },
    setOrchestrationPolicy: vi.fn(async (_p: string, id: string, patch: { connectToDispatcher: boolean }, options?: {
      precondition?: (agent: DurableAgentConfig, policy: ResolvedOrchestrationPolicy) => void;
    }) => {
      const a = state.agents.get(id);
      if (!a) return { ok: false, message: 'Agent not found' };
      options?.precondition?.(a, policy(a));
      if (patch.connectToDispatcher && state.failPolicy) throw new Error('Policy write failed');
      a.orchestration = { ...a.orchestration, ...patch };
      if (patch.connectToDispatcher) await state.afterPolicy?.();
      return { ok: true, message: 'Saved', policy: policy(a) };
    }),
  };
});
vi.mock('../../telemetry/dispatcher-telemetry', () => ({
  recordDispatcherControl: vi.fn(() => true), auditString: (v: unknown) => String(v),
}));
vi.mock('./tools/helper-delivery', () => ({ deliverHelperUpdate: async () => 'delivered' }));

state.base = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-bootstrap-'));
state.project = path.join(state.base, 'project');

import { createDispatcherManagedAgent, _resetDispatcherBootstrapForTesting } from './dispatcher-bootstrap';
import { recordDispatcherControl } from '../../telemetry/dispatcher-telemetry';
import { bindingManager } from './binding-manager';
import { callTool, getScopedToolList, registerGlobalTool, registerToolTemplate, _resetForTesting } from './tool-registry';
import type { ToolGrantDeclaration } from './tool-grants';
import { setDispatcherAgent } from './dispatcher-gate';
import { setMcpCaller, _resetMcpCallGateForTesting } from './mcp-call-gate';
import { dispatcherWireBindingSource } from '../dispatcher-wire-source';
import {
  _resetPersistedBindingSourcesForTesting, markBindingRemovedByUser, rebuildPersistedBindings, registerPersistedBindingSource,
} from '../persisted-bindings';
import {
  addDispatcherConnections, dispatcherConnectionsPath, isTombstoned, recordUserRemoval, _resetDispatcherConnectionsForTesting,
} from '../dispatcher-connections';
import { agentRegistry } from '../agent-registry';
import { deleteDurable } from '../agent-config';
import { updateAgentGrantChanges } from '../agent-grants-store';
import { _resetGrantRequestsForTesting, listGrantRequests } from '../grant-requests';
import { answerGrantRequest } from '../grant-request-answers';
import { GRANT_REQUEST_TTL_MS } from '../../../shared/grant-requests';
import {
  getConnectionDirection, removeConnectionDirections, setConnectionTools, _setConnectionGrantsVersionForTesting,
} from '../connection-grants-store';

const grants: ToolGrantDeclaration[] = [
  { actions: ['agent.create'], target: 'all_projects' },
  { actions: ['connection.bootstrap'], target: 'created_by_me', ifTrue: ['connectToDispatcher'] },
];
const args = { project: 'Project', name: 'Owner', connectToDispatcher: true };
const create = vi.fn(async (): Promise<DurableAgentConfig> => {
  const agent: DurableAgentConfig = {
    id: 'new-agent', name: 'Owner', color: 'indigo', createdAt: new Date().toISOString(),
    worktreePath: path.join(state.base, 'owner'), orchestration: { connectToDispatcher: false },
  };
  state.agents.set(agent.id, agent);
  return agent;
});
const call = async (input: Record<string, unknown> = args) => {
  const result = await callTool('dispatcher', 'create_managed_agent', input);
  return { ...result, value: result.content[0].text.startsWith('{') ? JSON.parse(result.content[0].text) : null };
};
const allow = () => updateAgentGrantChanges('dispatcher', () => ({
  changes: [{ action: 'connection.bootstrap', target: { kind: 'created_by_me' }, mode: 'allow' }],
}));

beforeEach(async () => {
  state.agents.clear();
  state.failPolicy = false;
  state.afterPolicy = undefined;
  create.mockClear();
  vi.mocked(deleteDurable).mockClear();
  _resetDispatcherBootstrapForTesting();
  _resetGrantRequestsForTesting();
  _resetForTesting();
  _resetMcpCallGateForTesting();
  _resetPersistedBindingSourcesForTesting();
  _resetDispatcherConnectionsForTesting();
  fs.rmSync(dispatcherConnectionsPath(), { force: true });
  bindingManager._resetForTesting();
  await _setConnectionGrantsVersionForTesting(1);
  await removeConnectionDirections('dispatcher');
  await updateAgentGrantChanges('dispatcher', () => undefined);
  setDispatcherAgent('dispatcher', true);
  setMcpCaller('dispatcher', state.project, {});
  agentRegistry.register('dispatcher', { projectPath: state.project, orchestrator: 'claude-code', runtime: 'pty' });
  registerPersistedBindingSource(dispatcherWireBindingSource);
  bindingManager.setConnectionToolsSource(
    (from, to) => getConnectionDirection({ agentId: from }, { agentId: to })?.disabledTools,
    (from, to, _kind, legacy, options) => {
      const saved = getConnectionDirection({ agentId: from }, { agentId: to });
      bindingManager.setDisabledTools(from, to, saved?.disabledTools ?? legacy, saved?.enabledTools ?? options.enabledTools);
    },
  );
  registerGlobalTool('create_managed_agent', {
    description: 'Create and connect', inputSchema: { type: 'object', properties: { connectToDispatcher: { type: 'boolean' } } },
  }, (id, input) => createDispatcherManagedAgent(id, input, { path: state.project, name: 'Project' }, grants, create),
  { group: 'dispatcher', grant: grants.map((g) => ({ ...g, askHandledByTool: true })) });
  registerToolTemplate('agent', 'wake_agent', { description: 'Wake', inputSchema: { type: 'object' } },
    async () => ({ content: [{ type: 'text', text: 'Awake' }] }), { grant: { actions: ['agent.wake'], target: 'bound' } });
  vi.mocked(recordDispatcherControl).mockClear();
});
afterEach(() => {
  _resetGrantRequestsForTesting();
  agentRegistry.untrack('dispatcher');
});
afterAll(() => fs.rmSync(state.base, { recursive: true, force: true }));

describe('Dispatcher create-and-connect bootstrap (#3281)', () => {
  it('creates only after approval, connects with narrow switches, and exposes wake', async () => {
    const waiting = await call();
    expect(waiting.value.status).toBe('needs_approval');
    expect(create).not.toHaveBeenCalled();
    const request = listGrantRequests('dispatcher')[0];
    expect(request.actions).toEqual(['connection.bootstrap']);
    expect(JSON.parse(request.argumentsText!).project).toBe(state.project);
    await answerGrantRequest(request.requestId, true);
    const result = await call();
    expect(result.isError).toBeFalsy();
    expect(result.value).toMatchObject({ id: 'new-agent', connectedToDispatcher: true, receipt: { outcome: 'connected', agentId: 'new-agent' } });
    for (const [from, to] of [['dispatcher', 'new-agent'], ['new-agent', 'dispatcher']]) {
      expect(getConnectionDirection({ agentId: from }, { agentId: to })).toMatchObject({
        disabledTools: ['clear_agent', 'compact_agent'], enabledTools: ['wake_agent'], setBy: 'dispatcher',
      });
    }
    const wake = getScopedToolList('dispatcher').find((tool) => tool.name.endsWith('_wake_agent'))!;
    expect((await callTool('dispatcher', wake.name, {})).content[0].text).toBe('Awake');
    expect(recordDispatcherControl).toHaveBeenCalledWith(expect.objectContaining({ targets: ['new-agent'], outcome: 'ok' }));
  });

  it('an allowed retry and simultaneous calls return one receipt and create one agent', async () => {
    await allow();
    const [first, second] = await Promise.all([call(), call()]);
    expect(first.value.receipt).toEqual(second.value.receipt);
    expect((await call()).value.receipt).toEqual(first.value.receipt);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('combines creation and bootstrap Ask first into one exact-call approval', async () => {
    await updateAgentGrantChanges('dispatcher', () => ({
      changes: [{ action: 'agent.create', target: { kind: 'project', project: 'any' }, mode: 'ask' }],
    }));
    await call();
    const request = listGrantRequests('dispatcher')[0];
    expect(request.actions).toEqual(['agent.create', 'connection.bootstrap']);
    await answerGrantRequest(request.requestId, true);
    expect((await call()).value.connectedToDispatcher).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    expect(listGrantRequests('dispatcher')).toHaveLength(0);
  });

  it('decline and expiry never create or connect, and approval covers only the exact arguments', async () => {
    await call();
    await answerGrantRequest(listGrantRequests('dispatcher')[0].requestId, false);
    expect(create).not.toHaveBeenCalled();
    expect(recordDispatcherControl).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'refused', code: 'bootstrap_declined' }));
    await call();
    await answerGrantRequest(listGrantRequests('dispatcher')[0].requestId, true);
    expect((await call({ ...args, name: 'Other' })).value.status).toBe('needs_approval');
    expect(create).not.toHaveBeenCalled();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + GRANT_REQUEST_TTL_MS + 1);
    expect((await call()).value.status).toBe('needs_approval');
    expect(create).not.toHaveBeenCalled();
  });

  it('Off is refused, while false or omitted needs no bootstrap grant', async () => {
    await updateAgentGrantChanges('dispatcher', () => ({ changes: [{ action: 'connection.bootstrap', target: { kind: 'created_by_me' }, mode: 'off' }] }));
    const refused = await call();
    expect(refused.isError).toBe(true);
    expect(refused.value.receipt.outcome).toBe('refused');
    expect(create).not.toHaveBeenCalled();
    expect(recordDispatcherControl).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'refused', code: 'no_grant' }));
    const result = await call({ ...args, connectToDispatcher: false });
    expect(result.value).toMatchObject({ connectedToDispatcher: false, nextStep: expect.stringContaining('enable Connect to Dispatcher') });
    expect(bindingManager.getAllBindings()).toHaveLength(0);
    expect((await call({ project: 'Project', name: 'Owner' })).value.connectedToDispatcher).toBe(false);
  });

  it('a failed creation cannot leave a connection or a success receipt', async () => {
    await allow();
    create.mockRejectedValueOnce(new Error('Setup failed'));
    const result = await call();
    expect(result.isError).toBe(true);
    expect(result.value).toMatchObject({ connectedToDispatcher: false, error: 'Setup failed', receipt: { outcome: 'failed' } });
    expect(getConnectionDirection({ agentId: 'dispatcher' }, { agentId: 'new-agent' })).toBeUndefined();
    expect(bindingManager.getAllBindings()).toHaveLength(0);
  });

  it.each<Partial<DurableAgentConfig>>([
    { id: 'dispatcher' }, { id: 'helper', parentAgentId: 'parent' }, { id: 'disposed', disposedAt: '2026-01-01' },
  ])('refuses an invalid created target without touching it: $id', async (invalid) => {
    await allow();
    create.mockResolvedValueOnce({ id: 'invalid', name: 'Invalid', color: 'indigo', createdAt: '', ...invalid });
    const result = await call();
    expect(result.isError).toBe(true);
    expect(result.value.receipt.outcome).toBe('refused');
    expect(bindingManager.getAllBindings()).toHaveLength(0);
    expect(deleteDurable).not.toHaveBeenCalled();
  });

  it('keeps user-owned switches and reports the controls actually saved', async () => {
    await allow();
    await setConnectionTools({ agentId: 'dispatcher' }, { agentId: 'new-agent' }, ['send_message', 'clear_agent', 'compact_agent'], []);
    const before = getConnectionDirection({ agentId: 'dispatcher' }, { agentId: 'new-agent' });
    const result = await call();
    expect(result.isError).toBeFalsy();
    expect(getConnectionDirection({ agentId: 'dispatcher' }, { agentId: 'new-agent' })).toEqual(before);
    expect(result.value.receipt.directions[0].tools.disabled).toContain('wake_agent');
    expect(result.value.receipt.directions[0].tools.disabled).toContain('send_message');
  });

  it('a user-removed successful connection is never restored on retry or rebuild', async () => {
    await allow();
    const first = await call();
    state.agents.get('new-agent')!.orchestration = { connectToDispatcher: false };
    await rebuildPersistedBindings();
    const again = await call();
    expect(again.isError).toBe(true);
    expect(again.value.receipt.id).toBe(first.value.receipt.id);
    expect(again.value.connectedToDispatcher).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
    expect(bindingManager.getAllBindings()).toHaveLength(0);
  });

  it('rolls back a policy-write failure without dropping user-owned switches', async () => {
    await allow();
    state.failPolicy = true;
    await setConnectionTools({ agentId: 'new-agent' }, { agentId: 'dispatcher' }, ['send_file'], []);
    const owned = getConnectionDirection({ agentId: 'new-agent' }, { agentId: 'dispatcher' });
    const result = await call();
    expect(result.value.error).toContain('Policy write failed');
    expect(result.isError).toBe(true);
    expect(state.agents.has('new-agent')).toBe(false);
    expect(getConnectionDirection({ agentId: 'dispatcher' }, { agentId: 'new-agent' })).toBeUndefined();
    expect(getConnectionDirection({ agentId: 'new-agent' }, { agentId: 'dispatcher' })).toEqual(owned);
    expect(bindingManager.getAllBindings()).toHaveLength(0);
    expect(recordDispatcherControl).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error' }));
  });

  it('rollback keeps a user edit that lands after bootstrap saved its default switches', async () => {
    await allow();
    state.afterPolicy = async () => {
      await setConnectionTools({ agentId: 'dispatcher' }, { agentId: 'new-agent' }, ['send_message'], []);
      throw new Error('Failure after the user edit');
    };
    const result = await call();
    expect(result.isError).toBe(true);
    expect(getConnectionDirection({ agentId: 'dispatcher' }, { agentId: 'new-agent' })).toMatchObject({ disabledTools: ['send_message'] });
    expect(getConnectionDirection({ agentId: 'new-agent' }, { agentId: 'dispatcher' })).toBeUndefined();
    expect(state.agents.has('new-agent')).toBe(false);
  });

  it('fails closed if the connection store cannot be written', async () => {
    await allow();
    await _setConnectionGrantsVersionForTesting(2);
    expect((await call()).isError).toBe(true);
    expect(state.agents.has('new-agent')).toBe(false);
    expect(bindingManager.getAllBindings()).toHaveLength(0);
  });

  it('rolls back if the user removes a pair mid-call, retaining the tombstone', async () => {
    await allow();
    state.afterPolicy = async () => {
      markBindingRemovedByUser('dispatcher', 'new-agent');
      await addDispatcherConnections([{
        agentId: 'dispatcher', targetId: 'new-agent', agentProjectPath: state.base, targetProjectPath: state.project,
        createdAt: new Date().toISOString(), createdBy: 'dispatcher',
      }]);
      await recordUserRemoval({ agentId: 'dispatcher', targetId: 'new-agent' });
    };
    const result = await call();
    expect(result.isError).toBe(true);
    expect(result.value.error).toContain('user removed');
    expect(state.agents.has('new-agent')).toBe(false);
    expect(bindingManager.getAllBindings()).toHaveLength(0);
    expect(await isTombstoned({ agentId: 'dispatcher', targetId: 'new-agent' })).toBe(true);
  });
});
