import { beforeEach, describe, expect, it } from 'vitest';
import { _resetAgentDisplayStateForTesting, agentDisplayState, noteAgentAwake, noteAgentStarting, noteAgentWakeFailed } from './agent-display-state';
beforeEach(_resetAgentDisplayStateForTesting);
describe('host lifecycle display evidence', () => {
  it('preserves real starting and failure observations without claiming a stopped process is running', () => {
    const agent = { id: 'a1' };
    expect(agentDisplayState(agent, false).status).toBe('sleeping');
    noteAgentStarting('a1');
    expect(agentDisplayState(agent, false).status).toBe('waking');
    noteAgentWakeFailed('a1', new Error('CLI missing; password=private-value'));
    expect(agentDisplayState(agent, false).status).toBe('error');
    expect(agentDisplayState(agent, false).error).not.toContain('private-value');
    noteAgentStarting('a1'); noteAgentAwake('a1');
    expect(agentDisplayState(agent, true)).toMatchObject({ status: 'running', spawnedAt: expect.any(Number) });
    expect(agentDisplayState(agent, false).status).toBe('sleeping');
    expect(agentDisplayState({ id: 'other' }, false).status).toBe('sleeping');
  });
});
