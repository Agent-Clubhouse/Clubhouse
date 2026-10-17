import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAgentStore } from '../../stores/agentStore';
import { wakeDurableAgent } from './wake-durable-agent';

const spawnDurableAgent = vi.fn();

describe('wakeDurableAgent', () => {
  beforeEach(() => {
    spawnDurableAgent.mockReset().mockResolvedValue(undefined);
    useAgentStore.setState({ spawnDurableAgent });
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
