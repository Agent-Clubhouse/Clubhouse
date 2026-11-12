import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableAgentConfig, LiveAgentInfo } from '../../shared/types';

vi.mock('./agent-config', () => ({
  peekDurableConfigsChecked: vi.fn(),
  listDurable: vi.fn(),
  getDurableConfig: vi.fn(),
}));
vi.mock('./project-store', () => ({
  peekProjectsChecked: vi.fn(),
  list: vi.fn(),
  projectPathKey: (value: string) => path.resolve(value),
}));
vi.mock('./provider-quota', () => ({ cachedProviderCapacity: vi.fn() }));
vi.mock('./restart-session-service', () => ({ getLiveAgentActivity: vi.fn() }));

import { localHandoffCapacitySources } from './handoff-capacity-sources';
import { sampleHandoffCapacity } from './handoff-capacity';
import { peekDurableConfigsChecked, listDurable, getDurableConfig } from './agent-config';
import { peekProjectsChecked, list } from './project-store';
import { cachedProviderCapacity } from './provider-quota';
import { getLiveAgentActivity } from './restart-session-service';

const machine = Array(16).fill('aa').join(':');
const first = { id: 'p1', name: 'example-project', path: '/registered/one' };
const second = { id: 'p2', name: 'another-project', path: '/registered/two' };
const durable = (id: string): DurableAgentConfig => ({ id, name: id, color: 'indigo', createdAt: '2026-11-12T00:00:00Z' });
const live = (agentId: string, isWorking: boolean, projectPath = first.path): Omit<LiveAgentInfo, 'resumeStrategy'> => ({
  agentId, projectPath, orchestrator: 'copilot-cli', runtime: 'chat', isWorking, lastActivity: null,
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(peekProjectsChecked).mockResolvedValue({ projects: [first, second], readable: true });
  vi.mocked(peekDurableConfigsChecked).mockImplementation(async (project) => ({
    readable: true, agents: project === first.path ? [durable('active'), durable('idle'), durable('sleeping')] : [durable('another-sleeping')],
  }));
  vi.mocked(getLiveAgentActivity).mockReturnValue([
    live('active', true), live('idle', false), live('quick-idle', false), live('headless', true, second.path),
  ]);
  vi.mocked(cachedProviderCapacity).mockImplementation((provider) => provider === 'copilot-cli' ? 'limited' : 'unknown');
});

describe('read-only app capacity sources', () => {
  it('creates no identity, registry load or provider resolution and counts live, sleeping and idle durables separately', async () => {
    const sources = localHandoffCapacitySources(machine);
    expect(peekProjectsChecked).not.toHaveBeenCalled();
    expect(cachedProviderCapacity).not.toHaveBeenCalled();
    expect(await sources.agentCounts()).toEqual({ running: 4, sleeping: 2, idleDurable: 1 });
    expect(getLiveAgentActivity).toHaveBeenCalledWith({ includePendingWork: true });
    expect(await sources.projectVolumes()).toEqual([first.path, second.path]);
    expect(sources.providers()).toEqual({ 'claude-code': 'unknown', 'copilot-cli': 'limited', 'codex-cli': 'unknown' });
    expect(cachedProviderCapacity).toHaveBeenCalledTimes(3);
    expect(sources.acceptingHandoffs()).toBe(false);
    expect(listDurable).not.toHaveBeenCalled();
    expect(getDurableConfig).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it('deduplicates registered paths and does not mistake an idle quick session for an idle durable', async () => {
    vi.mocked(peekProjectsChecked).mockResolvedValue({ projects: [first, { ...first, id: 'duplicate' }], readable: true });
    vi.mocked(getLiveAgentActivity).mockReturnValue([live('quick-idle', false)]);
    const sources = localHandoffCapacitySources(machine);
    expect(await sources.agentCounts()).toEqual({ running: 1, sleeping: 3, idleDurable: 0 });
    expect(peekDurableConfigsChecked).toHaveBeenCalledTimes(1);
    expect(await sources.projectVolumes()).toEqual([first.path]);
  });

  it.each(['missing-project-registry', 'unreadable-durables', 'registry-exception', 'empty-projects'])('fails explicitly without raw diagnostics or healthy zeros for %s', async (failure) => {
    if (failure === 'missing-project-registry') vi.mocked(peekProjectsChecked).mockResolvedValue({ projects: [], readable: false });
    if (failure === 'unreadable-durables') vi.mocked(peekDurableConfigsChecked).mockResolvedValue({ agents: [], readable: false });
    if (failure === 'registry-exception') vi.mocked(peekDurableConfigsChecked).mockRejectedValue(new Error('private-path-and-token-must-not-escape'));
    if (failure === 'empty-projects') vi.mocked(peekProjectsChecked).mockResolvedValue({ projects: [], readable: true });
    await expect(localHandoffCapacitySources(machine).agentCounts()).rejects.toThrow('Capacity inventory is unavailable.');
  });

  it('passes only bands/counts to the sampler and keeps accepting policy explicit', async () => {
    const sources = localHandoffCapacitySources(machine, () => true);
    const result = await sampleHandoffCapacity({
      ...sources, now: () => 1000, cpuUsage: async () => 0.1, memory: () => ({ free: 8, total: 10 }),
      disk: async () => ({ available: 30 * 1024 ** 3, total: 100 * 1024 ** 3 }),
    });
    expect(result).toMatchObject({
      online: true, agents: { running: 4, sleeping: 2, idleDurable: 1 },
      load: 'low', disk: 'ample', accepting_handoffs: true,
    });
    expect(JSON.stringify(result)).not.toContain('/registered');
    expect(JSON.stringify(result)).not.toContain('example-project');
    expect(JSON.stringify(result)).not.toContain('quick-idle');
  });
});
