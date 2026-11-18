import { beforeEach, describe, expect, it, vi } from 'vitest';
const fx = vi.hoisted(() => ({ describe: vi.fn(), bindings: vi.fn(() => []), alive: new Set<string>(), state: new Map<string, string>() }));
vi.mock('./group-project-roster', () => ({ groupProjectRoster: { describe: fx.describe } }));
vi.mock('./pty-manager', () => ({ isRunning: (id: string) => fx.alive.has(id) }));
vi.mock('./agent-registry', () => ({ agentRegistry: { get: () => undefined } }));
vi.mock('./agent-runtime', () => ({ getAgentRuntime: (id: string) => fx.state.has(id) ? { kind: 'chat', getState: () => fx.state.get(id) } : undefined }));
vi.mock('./annex-settings', () => ({ getSettings: () => ({ alias: 'Mac mini' }) }));
vi.mock('./clubhouse-mcp/binding-manager', () => ({ bindingManager: { getAllBindings: fx.bindings } }));
vi.mock('./group-project-roles', () => ({ listGroupProjectRoles: () => [] }));
vi.mock('./group-project-host', () => ({ groupProjectHost: {
  get: async () => ({}), addressOf: (_gp: unknown, address: string) => address,
  inboxFor: async (_id: string, _name: string, address: string) => address.startsWith('second') ? 'inbox-twin-abcdef' : 'inbox-twin',
} }));
import { groupProjectMentionMembers, groupProjectToolMembers } from './group-project-tool-members';
const row = (agentId: string, machine: string, extra = {}) => ({ agentId, key: `${agentId}@${machine}`, machine, label: 'Twin', machineLabel: machine === 'one' ? 'Mac mini' : 'Laptop', thisComputer: machine === 'one', ...extra });
beforeEach(() => { fx.alive.clear(); fx.state.clear(); fx.describe.mockReset(); });
describe('tool member identities', () => {
  it('lists exact inbox suffixes, distinct addresses and computers, with local and observed remote states', async () => {
    fx.alive.add('first'); fx.state.set('first', 'running');
    fx.describe.mockResolvedValue({ status: 'available', members: [row('first', 'one', { lead: 'allow' }), row('second', 'two', { status: 'asleep', lastSeen: '2026-11-18T00:00:00Z', admin: 'ask' })] });
    const members = await groupProjectToolMembers('gp');
    expect(members).toEqual([
      { name: 'Twin', address: 'first@one', computer: 'Mac mini', inbox: 'inbox-twin', status: 'busy', lastSeen: expect.any(String), roles: ['lead'] },
      { name: 'Twin', address: 'second@two', computer: 'Laptop', inbox: 'inbox-twin-abcdef', status: 'asleep', lastSeen: '2026-11-18T00:00:00Z', roles: ['admin'] },
    ]);
    expect(await groupProjectMentionMembers('gp')).toEqual(members.map(({ name, address, computer }) => ({ name, address, computer })));
  });
  it('reports awake, asleep and unknown honestly, and uses the host inbox when supplied', async () => {
    fx.alive.add('first');
    fx.describe.mockResolvedValue({ status: 'available', members: [row('first', 'one'), row('third', 'one'), row('old', 'two', { inbox: 'inbox-renamed-123456' })] });
    expect((await groupProjectToolMembers('gp')).map(({ status }) => status)).toEqual(['awake', 'asleep', 'unknown']);
    expect((await groupProjectToolMembers('gp'))[2]).toMatchObject({ inbox: 'inbox-renamed-123456' });
    expect((await groupProjectToolMembers('gp'))[2]).not.toHaveProperty('lastSeen');
  });
});
