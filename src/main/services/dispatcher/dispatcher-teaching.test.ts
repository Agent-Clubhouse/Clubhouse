import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableAgentConfig } from '../../../shared/types';

/**
 * #3048: "What else can you do?" is answered from the Dispatcher's real
 * grants. These run the real grants service (defaults, saved changes and the
 * Dispatcher's facts) with only storage and the app around it faked, so a
 * grant changed the way the permissions page changes it changes the list.
 */

const mocks = vi.hoisted(() => ({
  changes: new Map<string, unknown>(),
  agents: new Map<string, Array<Partial<DurableAgentConfig>>>(),
  connected: new Set<string>(),
  running: new Set<string>(),
  cards: new Map<string, { state: 'ready' | 'asking' | 'none'; card: { purpose?: string } | null }>(),
  enabled: true,
  projects: [] as Array<{ path: string; name: string }>,
}));

vi.mock('../agent-config', () => ({
  getDurableConfig: vi.fn(async (_p: string, id: string) => ({ id, name: id })),
  listDurable: vi.fn(async (projectPath: string) => {
    if (projectPath === '/broken') throw new Error('unreadable');
    return mocks.agents.get(projectPath) ?? [];
  }),
}));
vi.mock('../orchestration-policy', () => ({
  setOrchestrationPolicy: vi.fn(async () => ({ ok: true, message: '' })),
  resolveOrchestrationPolicies: vi.fn(async (_p: string, agents: DurableAgentConfig[]) =>
    new Map(agents.map((a) => [a.id, { connectToDispatcher: mocks.connected.has(a.id), orchestrate: false }]))),
}));
vi.mock('../agent-grants-store', () => ({
  getAgentGrantChanges: (id: string) => mocks.changes.get(id),
  updateAgentGrantChanges: vi.fn(async (id: string, fn: (c: unknown) => unknown) => { mocks.changes.set(id, fn(mocks.changes.get(id))); }),
}));
vi.mock('../grant-telemetry', () => ({ recordGrantChange: () => {} }));
vi.mock('../grant-requests', () => ({ dropCallApprovalsFor: () => {} }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../project-store', () => ({ list: vi.fn(async () => mocks.projects) }));
vi.mock('../agent-system', () => ({ isAgentRunning: (id: string) => mocks.running.has(id) }));
vi.mock('./dispatcher-paths', () => ({ getDispatcherPath: () => '/home/.clubhouse/dispatcher' }));
vi.mock('./dispatcher-settings', () => ({ isDispatcherEnabled: () => mocks.enabled }));
vi.mock('./dispatcher-service', () => ({
  getDispatcherAgentId: () => 'disp',
  isDispatcherAgentId: (id: string) => id === 'disp',
  resolveDispatcherIdentity: (projectPath: string, agentId: string) => ({ projectPath, agentId }),
}));
vi.mock('./dispatcher-agent-cards-watch', () => ({
  getAgentCards: () => ({ view: async (id: string) => mocks.cards.get(id) ?? null }),
}));

import { setAgentGrant } from '../agent-grants-service';
import { readDispatcherAbilities, readTeachingAgents } from './dispatcher-teaching';
import { capabilitiesText, type CapabilityGroup } from '../../../shared/dispatcher-teaching';

const DISPATCHER = '/home/.clubhouse/dispatcher';

function line(groups: CapabilityGroup[], id: string, has: string): string | undefined {
  return groups.find((g) => g.id === id)?.lines.map((l) => l.text).find((t) => t.includes(has));
}

beforeEach(() => {
  mocks.changes.clear();
  mocks.agents.clear();
  mocks.connected.clear();
  mocks.running.clear();
  mocks.cards.clear();
  mocks.enabled = true;
  mocks.projects = [];
});

describe('readDispatcherAbilities follows the Dispatcher\'s live grants', () => {
  it('answers in the five groups from its defaults', async () => {
    const groups = await readDispatcherAbilities();
    expect(groups.map((g) => g.title)).toEqual([
      'Your agents', 'New agents and connections', 'Schedules and follow-ups', 'Projects and settings', 'Keeping track',
    ]);
    expect(line(groups, 'projects', 'Change app settings')).toBe('Change app settings, after asking you');
  });

  it('changes when a grant is changed on its permissions page', async () => {
    const before = await readDispatcherAbilities();
    expect(line(before, 'agents', 'wake')).toMatch(/wake/);

    await setAgentGrant(DISPATCHER, 'disp', { action: 'agent.wake', target: { kind: 'connected' }, mode: 'off' });
    await setAgentGrant(DISPATCHER, 'disp', { action: 'settings.app.write', target: { kind: 'app' }, mode: 'allow' });
    await setAgentGrant(DISPATCHER, 'disp', { action: 'agent.dispose', target: { kind: 'any' }, mode: 'ask' });

    const after = await readDispatcherAbilities();
    expect(capabilitiesText(after)).not.toBe(capabilitiesText(before));
    expect(after.flatMap((g) => g.lines).some((l) => l.actions.includes('agent.wake'))).toBe(false);
    expect(line(after, 'projects', 'Change app settings')).toBe('Change app settings');
    expect(line(after, 'agents', 'Remove')).toBe('Remove any agent, after asking you');
  });
});

describe('readTeachingAgents', () => {
  it('lists connected agents across projects with whether they run and what their card says', async () => {
    mocks.projects = [{ path: '/a', name: 'a' }, { path: '/broken', name: 'broken' }, { path: '/b', name: 'b' }];
    mocks.agents.set('/a', [{ id: 'lead', name: 'webapp-lead' }, { id: 'quiet', name: 'not-connected' }, { id: 'gone', name: 'gone', disposedAt: '2026-01-01' } as Partial<DurableAgentConfig>]);
    mocks.agents.set('/b', [{ id: 'rel', name: 'release-lead' }]);
    for (const id of ['lead', 'rel', 'gone']) mocks.connected.add(id);
    mocks.running.add('lead');
    mocks.cards.set('lead', { state: 'ready', card: { purpose: '  Owns checkout  ' } });
    mocks.cards.set('rel', { state: 'asking', card: { purpose: 'old' } });

    expect(await readTeachingAgents()).toEqual([
      { id: 'lead', name: 'webapp-lead', running: true, purpose: 'Owns checkout' },
      { id: 'rel', name: 'release-lead', running: false },
    ]);
  });

  it('lists none while the Dispatcher is off', async () => {
    mocks.enabled = false;
    mocks.projects = [{ path: '/a', name: 'a' }];
    mocks.agents.set('/a', [{ id: 'lead', name: 'webapp-lead' }]);
    mocks.connected.add('lead');
    expect(await readTeachingAgents()).toEqual([]);
  });
});
