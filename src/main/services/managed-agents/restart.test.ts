import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableAgentConfig } from '../../../shared/types';

const state = vi.hoisted(() => ({ agents: new Map<string, DurableAgentConfig>(), running: new Set<string>() }));
const spawnAgent = vi.hoisted(() => vi.fn(async () => undefined));
const killAgent = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/tmp' } }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../../util/ipc-broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../project-store', () => ({ peekProjects: async () => [] }));
vi.mock('../agent-config', () => ({
  getDurableConfig: async (_p: string, id: string) => state.agents.get(id) ?? null,
  peekDurableConfigs: async () => [...state.agents.values()],
  setManagedSetup: async () => undefined,
}));
const deliver = vi.hoisted(() => vi.fn(async (): Promise<unknown> => null));
vi.mock('./delivery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./delivery')>()),
  deliverManagedSetup: deliver,
}));
vi.mock('../git-exclude-manager', () => ({ addExclusions: vi.fn(async () => {}) }));
vi.mock('../agent-system', () => ({
  isAgentRunning: (id: string) => state.running.has(id),
  killAgent,
  spawnAgent,
}));

import { deliverForSpawn, restartManagedAgent, statusFor } from './index';
import type { OrchestratorProvider } from '../../orchestrators/types';

function add(id: string, managed: boolean): void {
  state.agents.set(id, {
    id, name: id, color: 'indigo', createdAt: '', worktreePath: `/w/${id}`,
    ...(managed && { managed: { version: 1, blocks: [], skills: [], mcps: [] } }),
  });
}

beforeEach(() => {
  state.agents.clear();
  state.running.clear();
  spawnAgent.mockClear();
  killAgent.mockClear();
});

describe('restartManagedAgent', () => {
  it('refuses an agent that isn\'t managed, even when it is running', async () => {
    add('plain', false);
    state.running.add('plain');
    await expect(restartManagedAgent('/p', 'plain')).rejects.toMatchObject({ code: 'not_managed' });
    expect(killAgent).not.toHaveBeenCalled();
  });

  it('never starts a sleeping agent', async () => {
    add('sleepy', true);
    await expect(restartManagedAgent('/p', 'sleepy')).rejects.toThrow(/isn't running/);
    expect(spawnAgent).not.toHaveBeenCalled();
  });

  it('stops and starts a running managed agent', async () => {
    add('worker', true);
    state.running.add('worker');
    await restartManagedAgent('/p', 'worker', { fresh: true });
    expect(killAgent).toHaveBeenCalledTimes(1);
    expect(spawnAgent).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'worker', resume: false }));
  });
});

describe('restart outcome (#2819)', () => {
  it('says when there was no conversation to resume', async () => {
    add('fresh-one', true);
    state.running.add('fresh-one');
    expect(await restartManagedAgent('/p', 'fresh-one')).toEqual({ resumed: false, noSession: true });
  });

  it('resumes when there is a session, and asking for fresh is not a surprise', async () => {
    add('resumer', true);
    state.agents.get('resumer')!.lastSessionId = 's1';
    state.running.add('resumer');
    expect(await restartManagedAgent('/p', 'resumer')).toEqual({ resumed: true });
    expect(await restartManagedAgent('/p', 'resumer', { fresh: true })).toEqual({ resumed: false });
  });
});

describe('delivery failure status (#2819)', () => {
  const provider = { id: 'claude-code', conventions: { configDir: '.claude', skillsDir: 'skills', mcpConfigFile: '.mcp.json', localSettingsFile: 'settings.local.json' } } as unknown as OrchestratorProvider;

  it('reports a failed delivery as waiting with the reason until a delivery succeeds', async () => {
    add('broken', true);
    state.running.add('broken');
    deliver.mockRejectedValueOnce(new Error('disk full'));
    await expect(deliverForSpawn('/p', state.agents.get('broken')!, provider)).rejects.toThrow('disk full');
    expect(await statusFor('/p', 'broken')).toMatchObject({
      waiting: true, deliveryFailed: 'disk full', changes: ["Setup couldn't be written: disk full"],
    });
    deliver.mockResolvedValueOnce(null);
    await deliverForSpawn('/p', state.agents.get('broken')!, provider);
    expect(await statusFor('/p', 'broken')).toMatchObject({ waiting: false });
    expect((await statusFor('/p', 'broken')).deliveryFailed).toBeUndefined();
  });
});
