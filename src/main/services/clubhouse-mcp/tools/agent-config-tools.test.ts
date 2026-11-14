import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../mcp-call-gate', async (original) => ({ ...await original<typeof import('../mcp-call-gate')>(), mcpCallAccess: () => 'open' }));
vi.mock('../../project-store', () => ({ peekProjects: async () => [{ id: 'p', name: 'Project', path: '/project' }] }));
vi.mock('../../agent-config', () => ({ peekDurableConfigs: async () => [{ id: 'target', name: 'Target' }] }));
const mocks = vi.hoisted(() => ({ read: vi.fn(async () => ({ instructions: { text: 'Rules' } })), forward: vi.fn(async () => ({ content: [] })) }));
vi.mock('../../agent-config-reader', async (original) => ({ ...await original<typeof import('../../agent-config-reader')>(), readResolvedAgentConfig: mocks.read }));
vi.mock('../../annex-agent-calls', () => ({ remoteMachineOf: (id: string) => id.includes('@') ? 'peer' : null, forwardAgentCall: mocks.forward }));
import { registerAgentConfigTools } from './agent-config-tools';
import { callTool, getScopedToolList, _resetForTesting } from '../tool-registry';
import { bindingManager } from '../binding-manager';
import { setDispatcherAgent, _resetDispatcherGateForTesting } from '../dispatcher-gate';
const grants = vi.hoisted(() => ({ off: false }));
vi.mock('../../agent-grants-store', () => ({ getAgentGrantChanges: () => grants.off ? { changes: [{ action: 'agent.read', target: { kind: 'connected' }, mode: 'off' }] } : undefined, getAgentGrantRevision: () => 'test' }));

beforeEach(() => {
  vi.clearAllMocks(); _resetForTesting(); _resetDispatcherGateForTesting(); grants.off = false; bindingManager._resetForTesting(); registerAgentConfigTools();
});
const wire = () => bindingManager.bind('caller', { label: 'Target', targetId: 'target', targetKind: 'agent', targetName: 'Target', agentName: 'Caller', projectName: 'Project' });
describe('read_agent_config grants and routing', () => {
  it('is available to an ordinary agent and reads a connected target', async () => {
    wire();
    expect(getScopedToolList('caller').map((t) => t.name)).toContain('read_agent_config');
    expect((await callTool('caller', 'read_agent_config', { agent: 'target' })).isError).toBeFalsy();
    expect(mocks.read).toHaveBeenCalledWith({ agent: { id: 'target', name: 'Target' }, project: { id: 'p', name: 'Project', path: '/project' } });
  });
  it('refuses without agent.read, including a saved Off on a connection', async () => {
    expect((await callTool('caller', 'read_agent_config', { agent: 'target' })).isError).toBe(true);
    wire();
    grants.off = true;
    expect((await callTool('caller', 'read_agent_config', { agent: 'target' })).isError).toBe(true);
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it('withholds content when the connection is unbound during the read', async () => {
    wire();
    mocks.read.mockImplementationOnce(async () => {
      bindingManager.unbind('caller', 'target');
      return { instructions: { text: 'Rules' } };
    });
    const result = await callTool('caller', 'read_agent_config', { agent: 'target' });
    expect(mocks.read).toHaveBeenCalledOnce();
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('Rules');
  });
  it('refuses an unknown project for a real unconnected id without reading content', async () => {
    expect((await callTool('caller', 'read_agent_config', { agent: 'target', project: 'does-not-exist' })).isError).toBe(true);
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it('cannot bypass saved Off by pairing a connected id with an unknown project', async () => {
    wire(); grants.off = true;
    expect((await callTool('caller', 'read_agent_config', { agent: 'target', project: 'does-not-exist' })).isError).toBe(true);
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it('rejects a remote project argument before it can bypass the sender grant and forward', async () => {
    bindingManager.bind('caller', { label: 'Remote', targetId: 'target@peer', targetKind: 'agent' });
    grants.off = true;
    expect((await callTool('caller', 'read_agent_config', { agent: 'target@peer', project: 'does-not-exist' })).isError).toBe(true);
    expect(mocks.forward).not.toHaveBeenCalled();
  });
  it('lets the Dispatcher read unconnected targets and forwards remote reads', async () => {
    setDispatcherAgent('dispatcher', true);
    expect((await callTool('dispatcher', 'read_agent_config', { agent: 'target' })).isError).toBeFalsy();
    await callTool('dispatcher', 'read_agent_config', { agent: 'target@peer' });
    expect(mocks.forward).toHaveBeenCalledWith('dispatcher', 'target@peer', 'That agent', 'read_agent_config', {});
  });
});
