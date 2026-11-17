import { beforeEach, describe, expect, it, vi } from 'vitest';

// What the gate decides is covered in mcp-call-gate.test.ts and test/mcp-off.
vi.mock('../mcp-call-gate', async (original) => ({ ...await original<typeof import('../mcp-call-gate')>(), mcpCallAccess: () => 'open' }));

const mocks = vi.hoisted(() => ({
  listSettings: vi.fn(async () => ({ sections: [] as unknown[] })),
  readSettings: vi.fn(async () => ({ targets: [] as unknown[], total: 0 })),
  dispatcherOn: true,
  fixedList: false,
  forward: vi.fn(async () => ({ content: [{ type: 'text', text: 'remote settings' }] })),
}));

vi.mock('../../annex-agent-calls', async (original) => ({ ...await original<typeof import('../../annex-agent-calls')>(), forwardAgentCall: mocks.forward }));
vi.mock('../../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../../settings-read-service', () => {
  class SettingsReadError extends Error {
    constructor(readonly code: string, message: string) { super(message); }
  }
  return { SettingsReadError, listSettings: mocks.listSettings, readSettings: mocks.readSettings };
});
vi.mock('../dispatcher-gate', async (importOriginal) => ({
  ...await importOriginal<typeof import('../dispatcher-gate')>(),
  isDispatcherAgent: (id: string) => id === 'dispatcher' && mocks.dispatcherOn,
}));
vi.mock('../../../orchestrators', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../orchestrators')>(),
  getProvider: () => ({ getCapabilities: () => ({ ignoresToolListChanged: mocks.fixedList }) }),
}));

import { bindingManager } from '../binding-manager';
import { agentRegistry } from '../../agent-registry';
import * as grantStore from '../../agent-grants-store';
import { SettingsReadError } from '../../settings-read-service';
import { callTool, getScopedToolList, invalidateToolListCache, _resetForTesting } from '../tool-registry';
import { registerSettingsReadTools } from './settings-read-tools';

const text = (result: { content: Array<{ text?: string }> }) => result.content[0].text ?? '';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dispatcherOn = true;
  mocks.fixedList = false;
  for (const id of [...agentRegistry.getAllRegistrations().keys()]) agentRegistry.untrack(id);
  _resetForTesting();
  registerSettingsReadTools();
  bindingManager._resetForTesting();
  mocks.forward.mockResolvedValue({ content: [{ type: 'text', text: 'remote settings' }] });
  agentRegistry.register('a1', { projectPath: '/one', cwd: '/one/worktree', orchestrator: 'claude-code', runtime: 'chat' });
  agentRegistry.register('dispatcher', { projectPath: '/dispatcher', orchestrator: 'claude-code', runtime: 'chat' });
});

describe('settings read tools', () => {
  it('lists both for any agent, whether or not its CLI keeps its first tool list', () => {
    for (const id of ['a1', 'dispatcher']) {
      expect(getScopedToolList(id).map((t) => t.name)).toEqual(['list_settings', 'read_settings']);
    }
    mocks.fixedList = true;
    invalidateToolListCache();
    expect(getScopedToolList('a1').map((t) => t.name)).toEqual(['list_settings', 'read_settings']);
  });

  it('stays small: every agent carries these definitions', () => {
    // The two tools now also carry explicit MCP effect hints.
    expect(JSON.stringify(getScopedToolList('a1')).length).toBeLessThan(1400);
  });

  it('asks as the agent, in its own scope', async () => {
    await callTool('a1', 'list_settings', {});
    expect(mocks.listSettings).toHaveBeenCalledWith({ scope: 'own', agentId: 'a1', projectPath: '/one' });
    await callTool('a1', 'read_settings', { select: ['agent.idle'], agent_ids: ['a1'], limit: 5, cursor: '5', detail: true });
    expect(mocks.readSettings).toHaveBeenCalledWith({ scope: 'own', agentId: 'a1', projectPath: '/one' }, {
      select: ['agent.idle'], agentIds: ['a1'], project: undefined, allAgents: undefined, allProjects: undefined, limit: 5, cursor: '5', detail: true,
    });
  });

  it('keeps no-argument local listing under its existing grant, while reads still honor agent.read Off', async () => {
    const grants = vi.spyOn(grantStore, 'getAgentGrantChanges').mockReturnValue({
      changes: [{ action: 'agent.read', target: { kind: 'self' }, mode: 'off' }],
    });
    try {
      expect((await callTool('a1', 'list_settings', {})).isError).toBeFalsy();
      expect(mocks.listSettings).toHaveBeenCalledTimes(1);
      expect((await callTool('a1', 'read_settings', { select: ['agent.cli.model'] })).isError).toBe(true);
      expect(mocks.readSettings).not.toHaveBeenCalled();
    } finally { grants.mockRestore(); }
  });

  it('accepts an explicit self listing and refuses an unsupported different local target', async () => {
    expect((await callTool('a1', 'list_settings', { agent: 'a1' })).isError).toBeFalsy();
    expect(mocks.listSettings).toHaveBeenCalledWith({ scope: 'own', agentId: 'a1', projectPath: '/one' });
    mocks.listSettings.mockClear();
    const refused = await callTool('dispatcher', 'list_settings', { agent: 'a1' });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('lists only your own key names');
    expect(mocks.listSettings).not.toHaveBeenCalled();
    expect(mocks.forward).not.toHaveBeenCalled();
  });

  it('asks with full scope for the running Dispatcher only', async () => {
    await callTool('dispatcher', 'read_settings', { select: ['app.system'], all_projects: true });
    expect(mocks.readSettings).toHaveBeenLastCalledWith({ scope: 'all', agentId: 'dispatcher' }, expect.objectContaining({ allProjects: true }));
    mocks.dispatcherOn = false;
    await callTool('dispatcher', 'read_settings', { select: ['app.defaults'] });
    expect(mocks.readSettings).toHaveBeenLastCalledWith({ scope: 'own', agentId: 'dispatcher', projectPath: '/dispatcher' }, expect.anything());
  });

  it('refuses an agent Clubhouse doesn\'t know, before the service', async () => {
    const result = await callTool('nobody', 'read_settings', { select: ['app.defaults'] });
    expect(result.isError).toBe(true);
    expect(mocks.readSettings).not.toHaveBeenCalled();
  });

  it('refuses arguments it doesn\'t know, and a select of the wrong shape', async () => {
    expect((await callTool('a1', 'read_settings', { select: ['agent.idle'], everything: true })).isError).toBe(true);
    expect((await callTool('a1', 'read_settings', {})).isError).toBe(true);
    expect((await callTool('a1', 'read_settings', { select: [1] })).isError).toBe(true);
    expect(mocks.readSettings).not.toHaveBeenCalled();
  });

  it('routes one qualified agent through the existing read transport and preserves host refusals (#3656)', async () => {
    const machine = Array(16).fill('ab').join(':');
    const target = `target@${machine}`;
    bindingManager.bind('a1', { targetId: target, targetKind: 'agent', label: 'Remote agent' });
    const args = { select: ['agent.cli.model'], agent_ids: [target], detail: true };
    expect(await callTool('a1', 'read_settings', args)).toEqual({ content: [{ type: 'text', text: 'remote settings' }] });
    expect(mocks.forward).toHaveBeenCalledWith('a1', target, 'That agent', 'read_settings', { select: ['agent.cli.model'], detail: true });
    await callTool('a1', 'list_settings', { agent: target });
    expect(mocks.forward).toHaveBeenLastCalledWith('a1', target, 'That agent', 'list_settings', {});
    mocks.forward.mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: 'Host refuses agent.read' }] } as never);
    expect((await callTool('a1', 'read_settings', args)).isError).toBe(true);
    expect(mocks.readSettings).not.toHaveBeenCalled();
  });

  it('refuses unconnected remote targets and rejects remote bulk/project/write arguments', async () => {
    const target = `target@${Array(16).fill('ab').join(':')}`;
    expect((await callTool('a1', 'read_settings', { select: ['agent.cli.model'], agent_ids: [target] })).isError).toBe(true);
    expect(mocks.forward).not.toHaveBeenCalled();
    bindingManager.bind('a1', { targetId: target, targetKind: 'agent', label: 'Remote' });
    for (const extra of [{ project: '/one' }, { all_agents: true }, { all_projects: true }, { value: 'write' }]) {
      expect((await callTool('a1', 'read_settings', { select: ['agent.cli.model'], agent_ids: [target], ...extra })).isError).toBe(true);
    }
    expect(mocks.forward).not.toHaveBeenCalled();
  });

  it('turns a refusal into a tool error with its message, and a result into compact JSON', async () => {
    mocks.readSettings.mockRejectedValueOnce(new SettingsReadError('out_of_scope', 'You can read only your own settings.'));
    const refused = await callTool('a1', 'read_settings', { select: ['agent.idle'] });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toBe('You can read only your own settings.');
    const ok = await callTool('a1', 'read_settings', { select: ['agent.idle'] });
    expect(text(ok)).toBe('{"targets":[],"total":0}');
  });
});
