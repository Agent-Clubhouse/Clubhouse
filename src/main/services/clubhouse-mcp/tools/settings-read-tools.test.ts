import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listSettings: vi.fn(async () => ({ sections: [] as unknown[] })),
  readSettings: vi.fn(async () => ({ targets: [] as unknown[], total: 0 })),
  dispatcherOn: true,
  fixedList: false,
}));

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

import { agentRegistry } from '../../agent-registry';
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
    expect(JSON.stringify(getScopedToolList('a1')).length).toBeLessThan(1200);
  });

  it('asks as the agent, in its own scope', async () => {
    await callTool('a1', 'list_settings', {});
    expect(mocks.listSettings).toHaveBeenCalledWith({ scope: 'own', agentId: 'a1', projectPath: '/one' });
    await callTool('a1', 'read_settings', { select: ['agent.idle'], agent_ids: ['a2'], project: 'p', limit: 5, cursor: '5', detail: true });
    expect(mocks.readSettings).toHaveBeenCalledWith({ scope: 'own', agentId: 'a1', projectPath: '/one' }, {
      select: ['agent.idle'], agentIds: ['a2'], project: 'p', allAgents: undefined, allProjects: undefined, limit: 5, cursor: '5', detail: true,
    });
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

  it('turns a refusal into a tool error with its message, and a result into compact JSON', async () => {
    mocks.readSettings.mockRejectedValueOnce(new SettingsReadError('out_of_scope', 'You can read only your own settings.'));
    const refused = await callTool('a1', 'read_settings', { select: ['agent.idle'] });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toBe('You can read only your own settings.');
    const ok = await callTool('a1', 'read_settings', { select: ['agent.idle'] });
    expect(text(ok)).toBe('{"targets":[],"total":0}');
  });
});
