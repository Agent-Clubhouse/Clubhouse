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
vi.mock('../agent-system', () => ({
  isAgentRunning: (id: string) => state.running.has(id),
  killAgent,
  spawnAgent,
}));

import { restartManagedAgent } from './index';

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
