import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  read: vi.fn(async () => ({ targets: [{ model: 'model', source: 'agent' }] })),
  list: vi.fn(async () => ({ sections: [{ section: 'agent', keys: ['agent.cli.model'] }] })),
}));
vi.mock('./agent-config-reader', () => ({ resolveAgentConfigTarget: async () => ({ agent: { id: 'target', token: 'NEVER-SPREAD' }, project: { path: '/host/project' } }) }));
vi.mock('./settings-read-service', () => ({
  readSettings: h.read, listSettings: h.list, SettingsReadError: class extends Error {},
}));
import { readRemoteSettings } from './remote-settings-reader';

beforeEach(() => vi.clearAllMocks());
describe('read-only remote settings scope (#3656)', () => {
  it('uses the existing settings reader as the selected agent, with no expanded scope or config spreading', async () => {
    const result = await readRemoteSettings('target', 'read_settings', { select: ['agent.cli.model'], detail: true });
    expect(h.read).toHaveBeenCalledWith({ scope: 'own', agentId: 'target', projectPath: '/host/project' }, {
      select: ['agent.cli.model'], detail: true, limit: undefined, cursor: undefined,
    });
    expect(JSON.stringify(result)).not.toContain('NEVER-SPREAD');
    await readRemoteSettings('target', 'list_settings', {});
    expect(h.list).toHaveBeenCalledWith({ scope: 'own', agentId: 'target', projectPath: '/host/project' });
  });

  it.each([{ agentIds: ['other'] }, { project: '/other' }, { allAgents: true }, { allProjects: true }, { value: 'write' }, { select: [1] }, { detail: 'yes' }])('refuses scope expansion, invalid reads or write arguments: %j', async (args) => {
    await expect(readRemoteSettings('target', 'read_settings', { select: ['agent.cli.model'], ...args })).rejects.toThrow();
    expect(h.read).not.toHaveBeenCalled();
  });
});
