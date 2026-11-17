import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAgentStore } from '../../stores/agentStore';
import { wakeDurableAgent } from './wake-durable-agent';

const spawnDurableAgent = vi.fn();

describe('wakeDurableAgent', () => {
  beforeEach(() => {
    spawnDurableAgent.mockReset().mockResolvedValue(undefined);
    useAgentStore.setState({ spawnDurableAgent });
    window.clubhouse.agent.getDurableConfig = vi.fn(async (_path, id) => (await window.clubhouse.agent.listDurable('/fixture')).find((c: { id: string }) => c.id === id));
  });

  it('QA3686 renderer wake: refuses corrupt primary before ordinary list recovery', async () => {
    let recovered = false;
    const backup = { id: 'a1', name: 'old backup', access: 'full_access', orchestrator: 'codex-cli' };
    const strictRead = vi.fn(async (_path: string, _id: string, forLaunch?: boolean) => {
      if (forLaunch && !recovered) throw new Error('Cannot verify the saved execution policy: corrupt primary');
      return backup;
    });
    window.clubhouse.agent.getDurableConfig = strictRead as never;
    const ordinaryList = vi.fn(async () => { recovered = true; return [backup]; });
    window.clubhouse.agent.listDurable = ordinaryList as never;
    const result = await wakeDurableAgent('p1', '/proj', 'a1').then(() => 'LAUNCHED', (e) => String(e));
    console.log('QA3686 renderer wake receipt', JSON.stringify({ result, recovered, strictReads: strictRead.mock.calls, spawns: spawnDurableAgent.mock.calls.length }));
    expect(result).toContain('Cannot verify the saved execution policy');
    expect(ordinaryList).not.toHaveBeenCalled();
    expect(spawnDurableAgent).not.toHaveBeenCalled();
  });

  it('resumes by default when the agent has a last session', async () => {
    const config = { id: 'a1', name: 'agent', lastSessionId: 'sess-1' };
    window.clubhouse.agent.listDurable = vi.fn().mockResolvedValue([config]);
    await wakeDurableAgent('p1', '/proj', 'a1');
    expect(spawnDurableAgent).toHaveBeenCalledWith('p1', '/proj', config, true);
  });

  it('starts fresh when the agent has never had a session', async () => {
    const config = { id: 'a1', name: 'agent' };
    window.clubhouse.agent.listDurable = vi.fn().mockResolvedValue([config]);
    await wakeDurableAgent('p1', '/proj', 'a1');
    expect(spawnDurableAgent).toHaveBeenCalledWith('p1', '/proj', config, false);
  });

  it('starts fresh in new mode even with a last session', async () => {
    const config = { id: 'a1', name: 'agent', lastSessionId: 'sess-1' };
    window.clubhouse.agent.listDurable = vi.fn().mockResolvedValue([config]);
    await wakeDurableAgent('p1', '/proj', 'a1', 'new');
    expect(spawnDurableAgent).toHaveBeenCalledWith('p1', '/proj', config, false);
  });

  it('does nothing when the agent config is missing', async () => {
    window.clubhouse.agent.listDurable = vi.fn().mockResolvedValue([]);
    await wakeDurableAgent('p1', '/proj', 'a1');
    expect(spawnDurableAgent).not.toHaveBeenCalled();
  });
});
