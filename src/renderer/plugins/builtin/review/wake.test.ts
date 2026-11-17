import { beforeEach, expect, it, vi } from 'vitest';
import { useAgentStore } from '../../../stores/agentStore';
import { useProjectStore } from '../../../stores/projectStore';
import { wakeAgent } from './wake';

const spawn = vi.fn();
beforeEach(() => {
  useAgentStore.setState({ agents: { a1: { id: 'a1', name: 'agent', kind: 'durable', projectId: 'p1' } }, spawnDurableAgent: spawn } as never);
  useProjectStore.setState({ projects: [{ id: 'p1', path: '/proj' }] } as never);
});
it('refuses Review wake before an ordinary list could recover a corrupt primary (#3686)', async () => {
  window.clubhouse.agent.listDurable = vi.fn().mockResolvedValue([{ id: 'a1', access: 'full_access' }]);
  window.clubhouse.agent.getDurableConfig = vi.fn().mockRejectedValue(new Error('Cannot verify the saved execution policy'));
  await expect(wakeAgent('a1', { resume: true })).rejects.toThrow('Cannot verify');
  expect(window.clubhouse.agent.getDurableConfig).toHaveBeenCalledWith('/proj', 'a1', true);
  expect(window.clubhouse.agent.listDurable).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
});
it('preserves an explicit restricted policy and resume target on a valid Review wake (#3686)', async () => {
  const config = { id: 'a1', sandbox: 'read-only', lastSessionId: 's1' };
  window.clubhouse.agent.getDurableConfig = vi.fn().mockResolvedValue(config);
  await wakeAgent('a1', { resume: true, prompt: 'task' });
  expect(spawn).toHaveBeenCalledWith('p1', '/proj', config, true, 'task');
});
