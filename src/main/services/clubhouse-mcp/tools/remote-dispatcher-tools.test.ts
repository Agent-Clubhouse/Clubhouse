import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ dir: '', machine: Array(16).fill('ab').join(':'), current: true, effectiveExtra: false, forward: vi.fn() }));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => fixture.dir }, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../../agent-registry', () => ({ agentRegistry: { get: () => ({ projectPath: fixture.dir }) } }));
vi.mock('../../agent-config', () => ({ getDurableConfig: async () => ({ id: 'sender', name: 'Project agent' }) }));
vi.mock('../../dispatcher/dispatcher-service', () => ({ isDispatcherAgentId: () => false }));
vi.mock('../../agent-grants-service', () => ({ effectiveAgentGrants: async (project: string, id: string) => {
  const { callerGrants } = await import('../grant-check'); return [...callerGrants(id), ...(fixture.effectiveExtra ? [{ action: 'agent.read', target: { kind: 'self' }, mode: 'allow' }] : [])];
} }));
vi.mock('../../dispatcher-presence', () => ({ getDispatcherPresence: () => ({ remotes: [{ machineId: fixture.machine, machineName: 'Laptop', address: `remote-controller@${fixture.machine}`, label: 'Dispatcher on Laptop', state: 'offline', dispatcherName: 'Dispatcher', link: { state: 'paused' } }] }) }));
vi.mock('../../dispatcher-federation', () => ({ remoteFederationController: () => ({ agentId: 'remote-controller', enabled: true }) }));
vi.mock('../../annex-agent-calls', () => ({
  captureControllerPublication: () => ({ epoch: { sender: 'a', receiver: 'b' }, current: () => fixture.current }),
  forwardPreparedAgentCall: fixture.forward, remoteMachineOf: () => undefined,
}));
vi.mock('../../../util/ipc-broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
import { _resetForTesting, callTool, registerGlobalTool } from '../tool-registry';
import { setHandoffGrantTargetResolver } from '../arg-targets';
import { setMcpCaller } from '../mcp-call-gate';
import { registerRemoteDispatcherTools } from './remote-dispatcher-tools';
import { updateAgentGrantChanges, getAgentGrantRevision } from '../../agent-grants-store';
import { _resetGrantRequestsForTesting, listGrantRequests, takeGrantRequest } from '../../grant-requests';
fixture.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-dispatcher-sender-'));
beforeEach(async () => {
  _resetForTesting(); _resetGrantRequestsForTesting(); vi.clearAllMocks(); fixture.current = true; fixture.effectiveExtra = false;
  setMcpCaller('sender', fixture.dir, {}); registerRemoteDispatcherTools();
  setHandoffGrantTargetResolver(async () => ({ kind: 'agent', remoteDispatcher: true, agentId: `dispatcher@${fixture.machine}` }));
  await updateAgentGrantChanges('sender', () => undefined);
  fixture.forward.mockResolvedValue({ content: [{ type: 'text', text: 'Queued durably for Laptop' }] });
});
afterAll(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));
const args = { machine: 'Laptop', message: 'News', task_id: 'origin-task' };
describe('authorized agent to remote Dispatcher (#3348)', () => {
  it('refuses without a grant, and only the exact person-approved Ask call reaches transport', async () => {
    expect(await callTool('sender', 'message_remote_dispatcher', args)).toMatchObject({ isError: true });
    expect(fixture.forward).not.toHaveBeenCalled();
    await updateAgentGrantChanges('sender', () => ({ changes: [{ action: 'agent.message', target: { kind: 'remote_dispatcher' }, mode: 'ask' }] }));
    expect(await callTool('sender', 'message_remote_dispatcher', args)).toMatchObject({ isError: true });
    const request = listGrantRequests()[0];
    expect(request).toMatchObject({ agentId: 'sender', toolName: 'message_remote_dispatcher', where: "another machine's Dispatcher" });
    expect(fixture.forward).not.toHaveBeenCalled();
    takeGrantRequest(request.requestId, true);
    expect(await callTool('sender', 'message_remote_dispatcher', args)).toEqual({ content: [{ type: 'text', text: 'Queued durably for Laptop' }] });
    expect(fixture.forward).toHaveBeenCalledWith('sender', `remote-controller@${fixture.machine}`, 'Dispatcher on Laptop', 'send_message', { message: 'News', task_id: 'origin-task' }, expect.any(Number), undefined, undefined, expect.objectContaining({ authorization: { policyHash: expect.any(String) } }));
    expect(await callTool('sender', 'message_remote_dispatcher', { ...args, message: 'Different' })).toMatchObject({ isError: true });
    expect(fixture.forward).toHaveBeenCalledTimes(1);
  });
  it('sends file contents with allowlisted arguments, and invalidates admission after revoke then reset', async () => {
    // Saved config defaults can precede runtime bindings at startup. Explicit Allow still works.
    fixture.effectiveExtra = true;
    await updateAgentGrantChanges('sender', () => ({ changes: [{ action: 'agent.message', target: { kind: 'remote_dispatcher' }, mode: 'allow' }] }));
    expect(await callTool('sender', 'send_file_to_remote_dispatcher', { machine: 'Laptop', content: 'File data', filename: 'plan.md', news: { spoof: true } })).toEqual({ content: [{ type: 'text', text: 'Queued durably for Laptop' }] });
    expect(fixture.forward).toHaveBeenCalledTimes(1);
    expect(fixture.forward.mock.calls[0][4]).toEqual({ content: 'File data', filename: 'plan.md' });
    const admission = fixture.forward.mock.calls[0][8]; expect(admission.current()).toBe(true);
    const revision = getAgentGrantRevision('sender');
    await updateAgentGrantChanges('sender', () => undefined);
    expect(getAgentGrantRevision('sender')).not.toBe(revision); expect(admission.current()).toBe(false);
    await updateAgentGrantChanges('sender', () => ({ changes: [{ action: 'agent.message', target: { kind: 'remote_dispatcher' }, mode: 'allow' }] }));
    expect(admission.current()).toBe(false);
  });
  it('delegates a Handoff through callTool, preserving its inner Ask approval and agreement identity', async () => {
    const offer = vi.fn(async () => ({ content: [{ type: 'text' as const, text: '{"id":"agreement","state":"offered"}' }] }));
    registerGlobalTool('offer_handoff', { description: 'Agreement fixture', inputSchema: { type: 'object' } }, offer, { grant: { actions: ['handoff.offer'], target: 'handoff_peer' } });
    await updateAgentGrantChanges('sender', () => ({ changes: [{ action: 'handoff.offer', target: { kind: 'remote_dispatcher' }, mode: 'ask' }] }));
    const handoff = { machine: 'Laptop', task: 'Continue', brief: 'Remaining work', mode: 'branch' };
    expect(await callTool('sender', 'offer_handoff_to_remote_dispatcher', handoff)).toMatchObject({ isError: true });
    expect(offer).not.toHaveBeenCalled();
    const request = listGrantRequests()[0]; expect(request.toolName).toBe('offer_handoff'); takeGrantRequest(request.requestId, true);
    expect(await callTool('sender', 'offer_handoff_to_remote_dispatcher', handoff)).toMatchObject({ content: [{ text: expect.stringContaining('agreement') }] });
    expect(offer).toHaveBeenCalledWith('sender', { to: `machine:${fixture.machine}`, task: 'Continue', brief: 'Remaining work', mode: 'branch' });
    expect(fixture.forward).not.toHaveBeenCalled();
  });
});
