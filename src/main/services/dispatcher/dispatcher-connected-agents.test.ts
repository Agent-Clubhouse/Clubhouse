import { describe, expect, it, vi } from 'vitest';

vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../base-dir', () => ({ getBaseDirPath: () => '/base' }));
vi.mock('../project-store', () => ({ list: vi.fn(async () => []) }));
vi.mock('../agent-config', () => ({ listDurable: vi.fn(async () => []) }));
vi.mock('../orchestration-policy', () => ({ resolveOrchestrationPolicies: vi.fn(async () => new Map()) }));

import { listConnectableAgents } from './dispatcher-connected-agents';
import type { DurableAgentConfig, Project } from '../../../shared/types';
import type { ResolvedOrchestrationPolicy } from '../../../shared/orchestration-policy';

const project = (id: string, name: string, extra: Partial<Project> = {}): Project => ({ id, name, path: `/p/${id}`, ...extra });
const agent = (id: string, name: string, extra: Partial<DurableAgentConfig> = {}): DurableAgentConfig =>
  ({ id, name, color: 'indigo', createdAt: 'now', ...extra }) as DurableAgentConfig;
const policy = (connectToDispatcher: boolean) => ({ connectToDispatcher }) as ResolvedOrchestrationPolicy;

describe('Connected agents (#3046)', () => {
  it('lists every project\'s agents with their resolved switch, sorted, without helpers, disposed agents or the Dispatcher\'s folder', async () => {
    const agents: Record<string, DurableAgentConfig[]> = {
      '/p/web': [agent('w2', 'webapp-lead', { emoji: '🛒' }), agent('w1', 'api-lead'), agent('h1', 'helper', { parentAgentId: 'w1' }), agent('d1', 'gone', { disposedAt: 'x' } as Partial<DurableAgentConfig>)],
      '/p/apps': [agent('a1', 'release-lead')],
      '/base/dispatcher': [agent('coordinator', 'Dispatcher')],
    };
    const policies = vi.fn(async (_path: string, list: DurableAgentConfig[]) => new Map(list.map((a) => [a.id, policy(a.id !== 'w1')])));
    const rows = await listConnectableAgents({
      listProjects: async () => [project('web', 'web', { displayName: 'Webapp' }), project('apps', 'apps'), { id: 'd', name: 'dispatcher', path: '/base/dispatcher' }],
      listAgents: async (p) => agents[p] ?? [],
      policies,
      purposeOf: async (id) => (id === 'w2' ? 'Checkout and payments' : undefined),
    });

    expect(rows.map((r) => [r.projectName, r.name, r.connected, r.purpose])).toEqual([
      ['apps', 'release-lead', true, undefined],
      ['Webapp', 'api-lead', false, undefined],
      ['Webapp', 'webapp-lead', true, 'Checkout and payments'],
    ]);
    expect(rows[2]).toMatchObject({ projectId: 'web', projectPath: '/p/web', agentId: 'w2', emoji: '🛒' });
    // Policies are resolved for the listed agents only.
    expect(policies.mock.calls.map(([, list]) => list.map((a) => a.id))).toEqual([['w2', 'w1'], ['a1']]);
  });

  it('leaves out a project that can\'t be read, and a description that can\'t be', async () => {
    const rows = await listConnectableAgents({
      listProjects: async () => [project('bad', 'bad'), project('ok', 'ok')],
      listAgents: async (p) => { if (p === '/p/bad') throw new Error('unreadable'); return [agent('o1', 'lead')]; },
      policies: async (_p, list) => new Map(list.map((a) => [a.id, policy(true)])),
      purposeOf: async () => { throw new Error('no cards'); },
    });
    expect(rows.map((r) => r.agentId)).toEqual(['o1']);
    expect(rows[0].purpose).toBeUndefined();
  });

  it('asks for no description of an agent that isn\'t connected', async () => {
    const purposeOf = vi.fn(async () => 'x');
    await listConnectableAgents({
      listProjects: async () => [project('ok', 'ok')],
      listAgents: async () => [agent('o1', 'lead')],
      policies: async () => new Map([['o1', policy(false)]]),
      purposeOf,
    });
    expect(purposeOf).not.toHaveBeenCalled();
  });
});
