import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGrantChanges } from '../../../shared/agent-grant-changes';
import { DISPATCHER_FEDERATION_TOOLS } from '../../../shared/dispatcher-federation';

const h = vi.hoisted(() => ({ changes: undefined as AgentGrantChanges | undefined }));
vi.mock('./mcp-call-gate', async (original) => ({ ...await original<typeof import('./mcp-call-gate')>(), mcpCallAccess: () => 'open' }));
vi.mock('../agent-grants-store', () => ({ agentGrantChangePending: () => false, getAgentGrantChanges: () => h.changes }));
vi.mock('../connection-grants-store', () => ({ localConnectionWakeOn: () => true }));
vi.mock('./ask-first', () => ({
  askFirst: vi.fn(async () => ({ kind: 'asked', text: 'Needs you', created: true })),
}));
vi.mock('../annex-agent-calls', () => ({
  remoteMachineOf: (id: string) => id.includes('@') ? id.slice(id.indexOf('@') + 1) : null,
  forwardAgentCall: vi.fn(async () => ({ content: [{ type: 'text', text: 'generic sent' }] })),
}));

import {
  _resetForTesting, buildToolName, callTool, canCallWake, getConnectionToolCatalog, getScopedToolList,
  registerToolTemplate, runAgentToolForRemoteCaller, setDispatcherFederationSender, unregisterToolTemplate,
} from './tool-registry';
import { bindingManager } from './binding-manager';
import { callerConnectedToLocalDispatcher, checkToolGrant } from './grant-check';
import { setDispatcherIdLookup } from './dispatcher-gate';
import { askFirst } from './ask-first';
import { forwardAgentCall } from '../annex-agent-calls';
import {
  setDispatcherFederationControllerId, setDispatcherFederationPeers,
} from '../dispatcher/dispatcher-federation-presence';

const MACHINE = 'aa:'.repeat(15) + 'aa';
const TARGET = `remote-controller@${MACHINE}`;
const UNSAFE = ['read_output', 'wake_agent', 'clear_agent', 'compact_agent', 'update_settings', 'answer_permission', 'answer_question'];
const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'local handler' }] }));
const send = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'federation sent' }] }));
const announce = () => setDispatcherFederationPeers([{
  machineId: MACHINE, machineName: 'Laptop', name: 'Dispatch', address: TARGET, presence: 'online', link: 'active',
}]);
const binding = () => bindingManager.getBindingsForAgent('caller')[0];

beforeEach(() => {
  _resetForTesting();
  bindingManager._resetForTesting();
  setDispatcherIdLookup((id) => id === 'local-controller');
  setDispatcherFederationControllerId('caller');
  announce();
  h.changes = { changes: [{ action: 'agent.message', target: { kind: 'any' }, mode: 'allow' }] };
  bindingManager.bind('caller', { targetKind: 'agent', targetId: TARGET, label: 'Spoofed editable name' });
  bindingManager.setDisabledTools('caller', TARGET, [], ['wake_agent']);
  for (const suffix of [...DISPATCHER_FEDERATION_TOOLS, ...UNSAFE]) {
    registerToolTemplate('agent', suffix, { description: suffix, inputSchema: { type: 'object', properties: {} } }, handler,
      { grant: { actions: ['agent.message'], target: 'bound' } });
  }
  setDispatcherFederationSender(send);
});

describe('trusted federation caps are independent of saved switches and grants', () => {
  it('lists only fixed-safe tools and retains disallowed catalog entries as unavailable', () => {
    expect(getScopedToolList('caller').map((tool) => tool.name.split('__').at(-1)).sort()).toEqual([...DISPATCHER_FEDERATION_TOOLS].sort());
    const catalog = getConnectionToolCatalog('caller', TARGET, 'agent');
    expect(catalog.tools.filter((tool) => tool.available).map((tool) => tool.suffix).sort()).toEqual([...DISPATCHER_FEDERATION_TOOLS].sort());
    expect(catalog.tools.filter((tool) => !tool.available).map((tool) => tool.suffix).sort()).toEqual([...UNSAFE].sort());
    expect(canCallWake('caller', TARGET)).toBe(false);
  });

  it.each(UNSAFE)('refuses %s by name before any local or generic remote handler', async (suffix) => {
    expect(await callTool('caller', buildToolName(binding(), suffix), {})).toMatchObject({ isError: true });
    expect(handler).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(forwardAgentCall).not.toHaveBeenCalled();
  });

  it('uses the dedicated sender and fails closed if it has not been installed', async () => {
    const name = buildToolName(binding(), 'send_message');
    await callTool('caller', name, {});
    expect(send).toHaveBeenCalledWith({ callerId: 'caller', targetId: TARGET, tool: 'send_message', args: {} });
    expect(forwardAgentCall).not.toHaveBeenCalled();
    setDispatcherFederationSender(undefined);
    expect(await callTool('caller', name, {})).toMatchObject({ isError: true });
    expect(forwardAgentCall).not.toHaveBeenCalled();
  });

  it('invalidates an already-cached ordinary target list as authenticated controller identity arrives', () => {
    setDispatcherFederationPeers([]);
    expect(getScopedToolList('caller').some((tool) => tool.name.endsWith('__read_output'))).toBe(true);
    announce();
    expect(getScopedToolList('caller').some((tool) => tool.name.endsWith('__read_output'))).toBe(false);
  });

  it('resolves remote grants from presence, never editable labels or local connected grants', () => {
    h.changes = undefined;
    const grant = { actions: ['agent.message'] as const, target: 'bound' as const };
    expect(checkToolGrant('caller', grant, {}, { binding: binding() })).toMatchObject({ ok: false, reason: 'no_grant' });
    h.changes = { changes: [{ action: 'agent.message', target: { kind: 'remote_dispatcher' }, mode: 'ask' }] };
    expect(checkToolGrant('caller', grant, {}, { binding: binding() })).toMatchObject({
      ok: false, reason: 'ask_first', asks: [{ action: 'agent.message', where: 'Dispatch on Laptop' }],
    });
    const local = { ...binding(), targetId: 'local-peer', targetName: 'Dispatch on Laptop' };
    expect(checkToolGrant('caller', grant, {}, { binding: local }).ok).toBe(true);
  });

  it('derives own-Dispatcher connection only from exact local controller identity, not remote links or labels', () => {
    expect(callerConnectedToLocalDispatcher('caller')).toBe(false);
    bindingManager.bind('caller', { targetKind: 'agent', targetId: 'impostor', label: 'Dispatcher' });
    expect(callerConnectedToLocalDispatcher('caller')).toBe(false);
    bindingManager.bind('caller', { targetKind: 'agent', targetId: 'local-controller', label: 'Any edited name' });
    expect(callerConnectedToLocalDispatcher('caller')).toBe(true);
  });

  it('keeps a controller-only template unavailable for ordinary local targets and the generic incoming runner', async () => {
    unregisterToolTemplate('agent', 'hand_off_request');
    registerToolTemplate('agent', 'hand_off_request', { description: 'handoff', inputSchema: { type: 'object', properties: {} } }, handler,
      { grant: { actions: ['agent.message'], target: 'bound' }, targetScope: 'remote_dispatcher' });
    bindingManager.bind('caller', { targetKind: 'agent', targetId: 'local-peer', label: 'Dispatch on Laptop' });
    const local = bindingManager.getBindingsForAgent('caller').find((entry) => entry.targetId === 'local-peer');
    if (!local) throw new Error('Expected local test binding');
    expect(getConnectionToolCatalog('caller', 'local-peer', 'agent').tools.find((tool) => tool.suffix === 'hand_off_request')?.available).toBe(false);
    expect(await callTool('caller', buildToolName(local, 'hand_off_request'), {})).toMatchObject({ isError: true });
    expect(await runAgentToolForRemoteCaller('hand_off_request', 'local-peer', `remote@${MACHINE}`, {})).toMatchObject({ isError: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it('keeps durable Ask-first disabled without consuming or inventing a click, regardless of arguments', async () => {
    h.changes = { changes: [{ action: 'agent.message', target: { kind: 'remote_dispatcher' }, mode: 'ask' }] };
    const name = buildToolName(binding(), 'send_message');
    expect(await callTool('caller', name, { grantApproved: true })).toMatchObject({ isError: true });
    expect(send).not.toHaveBeenCalled();
    expect(askFirst).not.toHaveBeenCalled();
  });
});
