import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/clubhouse-test' },
  BrowserWindow: { getAllWindows: () => [] },
}));

const system = vi.hoisted(() => ({
  isAgentRunning: vi.fn(),
  isAgentStopping: vi.fn(),
  waitForAgentStopped: vi.fn(),
  killAgent: vi.fn(),
  spawnAgent: vi.fn(),
}));
vi.mock('../../agent-system', () => system);

const mocks = vi.hoisted(() => ({
  registryGet: vi.fn(),
  getAgentRuntime: vi.fn(),
  deliverNow: vi.fn(),
  listHelpersEverywhere: vi.fn(),
  listDurable: vi.fn(),
  listProjects: vi.fn(),
  broadcast: vi.fn(),
  getBindingsForAgent: vi.fn(),
}));
vi.mock('../../agent-registry', () => ({ agentRegistry: { get: mocks.registryGet } }));
vi.mock('../../agent-runtime', () => ({ getAgentRuntime: mocks.getAgentRuntime }));
vi.mock('../../agent-runtime/checkpoint-tracker', () => ({
  BUSY_STATES: new Set(['starting', 'running', 'waiting_permission', 'waiting_input']),
}));
vi.mock('./helper-delivery', () => ({ deliverNow: mocks.deliverNow }));
vi.mock('../../helper-index', () => ({ listHelpersEverywhere: mocks.listHelpersEverywhere }));
vi.mock('../../agent-config', () => ({ listDurable: mocks.listDurable }));
vi.mock('../../project-store', () => ({ list: mocks.listProjects }));
vi.mock('../../../util/ipc-broadcast', () => ({ broadcastToAllWindows: mocks.broadcast }));
vi.mock('../binding-manager', () => ({ bindingManager: { getBindingsForAgent: mocks.getBindingsForAgent } }));
vi.mock('../../log-service', () => ({ appLog: vi.fn() }));

import { sleepAgent, wakeWiredAgent } from './agent-lifecycle';

const request = { callerId: 'dispatcher', targetId: 'target', targetName: 'boss' };

function parsed(result: { content: Array<{ text?: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text!);
}

describe('agent-lifecycle', () => {
  /** Whether the target has a live session. */
  let running: boolean;

  beforeEach(() => {
    vi.clearAllMocks();
    running = true;
    system.isAgentRunning.mockImplementation((id: string) => id === 'target' && running);
    system.isAgentStopping.mockReturnValue(false);
    system.waitForAgentStopped.mockImplementation(async () => { running = false; return true; });
    system.killAgent.mockImplementation(async () => { running = false; });
    system.spawnAgent.mockImplementation(async () => { running = true; });
    mocks.registryGet.mockImplementation((id: string) =>
      id === 'target' && running ? { projectPath: '/proj', orchestrator: 'claude-code', runtime: 'chat' } : undefined);
    mocks.getAgentRuntime.mockReturnValue({ kind: 'chat', getState: () => 'idle' });
    mocks.deliverNow.mockResolvedValue('delivered');
    mocks.listHelpersEverywhere.mockResolvedValue([]);
    mocks.listProjects.mockResolvedValue([{ path: '/proj' }]);
    mocks.listDurable.mockResolvedValue([{
      id: 'target', name: 'boss', model: 'opus', orchestrator: 'claude-code', worktreePath: '/proj/wt', freeAgentMode: false,
    }]);
    mocks.getBindingsForAgent.mockReturnValue([{ agentName: 'Dispatcher', targetId: 'target' }]);
  });

  describe('sleepAgent', () => {
    it('reports already_sleeping and stops nothing', async () => {
      running = false;
      const result = await sleepAgent({ ...request, force: false });
      expect(parsed(result).status).toBe('already_sleeping');
      expect(result.isError).toBeFalsy();
      expect(system.killAgent).not.toHaveBeenCalled();
    });

    it('stops an idle chat agent, waits for exit and records the caller', async () => {
      const result = await sleepAgent({ ...request, force: false });
      expect(parsed(result)).toEqual({ agentId: 'target', agentName: 'boss', status: 'sleeping' });
      expect(system.killAgent).toHaveBeenCalledWith('target', '/proj', 'claude-code', 'agent_tool', { by: 'Dispatcher', waitForExit: true });
      expect(mocks.broadcast).toHaveBeenCalledWith('agent:agent-sleeping', 'target');
    });

    it.each(['starting', 'running', 'waiting_permission', 'waiting_input'])('refuses a chat agent in %s without force', async (state) => {
      mocks.getAgentRuntime.mockReturnValue({ kind: 'chat', getState: () => state });
      const result = await sleepAgent({ ...request, force: false });
      expect(result.isError).toBe(true);
      expect(parsed(result)).toMatchObject({ status: 'refused', reason: 'mid_turn', state });
      expect(system.killAgent).not.toHaveBeenCalled();
      expect(mocks.broadcast).not.toHaveBeenCalled();
    });

    it('stops a chat agent mid-turn with force', async () => {
      mocks.getAgentRuntime.mockReturnValue({ kind: 'chat', getState: () => 'running' });
      const result = await sleepAgent({ ...request, force: true });
      expect(parsed(result).status).toBe('sleeping');
      expect(system.killAgent).toHaveBeenCalledTimes(1);
    });

    it('refuses a terminal agent without force and says its turn state is unknown', async () => {
      mocks.getAgentRuntime.mockReturnValue({ kind: 'pty' });
      const result = await sleepAgent({ ...request, force: false });
      expect(result.isError).toBe(true);
      expect(parsed(result)).toMatchObject({ status: 'refused', reason: 'turn_state_unknown' });
      expect(parsed(result).note).toContain('turn state is unknown');
      expect(system.killAgent).not.toHaveBeenCalled();
    });

    it('refuses an agent with no runtime (headless) without force', async () => {
      mocks.getAgentRuntime.mockReturnValue(undefined);
      expect(parsed(await sleepAgent({ ...request, force: false })).reason).toBe('turn_state_unknown');
    });

    it('stops a terminal agent with force', async () => {
      mocks.getAgentRuntime.mockReturnValue({ kind: 'pty' });
      expect(parsed(await sleepAgent({ ...request, force: true })).status).toBe('sleeping');
    });

    it('waits on a sleep already under way, without force and without a second kill', async () => {
      mocks.getAgentRuntime.mockReturnValue({ kind: 'pty' });
      system.isAgentStopping.mockReturnValue(true);
      const result = await sleepAgent({ ...request, force: false });
      expect(parsed(result).status).toBe('sleeping');
      expect(system.waitForAgentStopped).toHaveBeenCalledWith('target');
      expect(system.killAgent).not.toHaveBeenCalled();
    });

    it('reports stopping when the agent has not exited', async () => {
      system.killAgent.mockResolvedValue(undefined);
      const result = await sleepAgent({ ...request, force: false });
      expect(parsed(result).status).toBe('stopping');
      expect(mocks.broadcast).not.toHaveBeenCalled();
    });

    it('lists running helpers without waiting on them, and leaves out sleeping ones', async () => {
      system.isAgentRunning.mockImplementation((id: string) => id === 'helper-1' || (id === 'target' && running));
      mocks.listHelpersEverywhere.mockResolvedValue([
        { projectPath: '/proj', config: { id: 'helper-1', name: 'awake' } },
        { projectPath: '/proj', config: { id: 'helper-2', name: 'asleep' } },
      ]);
      const result = await sleepAgent({ ...request, force: false });
      expect(parsed(result).status).toBe('sleeping');
      expect(parsed(result).runningHelpers).toEqual([{ id: 'helper-1', name: 'awake' }]);
      expect(system.killAgent).toHaveBeenCalledTimes(1);
    });

    it('lists running helpers on a refusal too', async () => {
      system.isAgentRunning.mockImplementation((id: string) => id === 'helper-1' || (id === 'target' && running));
      mocks.getAgentRuntime.mockReturnValue({ kind: 'pty' });
      mocks.listHelpersEverywhere.mockResolvedValue([{ projectPath: '/proj', config: { id: 'helper-1', name: 'awake' } }]);
      expect(parsed(await sleepAgent({ ...request, force: false })).runningHelpers).toEqual([{ id: 'helper-1', name: 'awake' }]);
    });

    it('still sleeps the agent when its helpers can not be listed', async () => {
      mocks.listHelpersEverywhere.mockRejectedValue(new Error('unreadable'));
      const result = await sleepAgent({ ...request, force: false });
      expect(parsed(result).status).toBe('sleeping');
      expect(parsed(result).runningHelpers).toBeUndefined();
    });

    it('errors when the project path can not be found', async () => {
      mocks.registryGet.mockReturnValue(undefined);
      mocks.listDurable.mockResolvedValue([]);
      const result = await sleepAgent({ ...request, force: false });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('project path');
    });
  });

  describe('wakeWiredAgent', () => {
    beforeEach(() => { running = false; });

    it('starts a sleeping agent with its own saved access and no permission mode', async () => {
      const result = await wakeWiredAgent({ ...request, mission: '[FROM:Dispatcher] go' });
      expect(parsed(result)).toEqual({ agentId: 'target', agentName: 'boss', status: 'running', resumed: false, messageDelivered: true });
      expect(mocks.broadcast).toHaveBeenCalledWith('agent:agent-waking', 'target');
      const params = system.spawnAgent.mock.calls[0][0];
      expect(params).toMatchObject({
        agentId: 'target', projectPath: '/proj', cwd: '/proj/wt', kind: 'durable', model: 'opus',
        mission: '[FROM:Dispatcher] go', orchestrator: 'claude-code', freeAgentMode: false, resume: false,
      });
      // spawnAgent resolves it from the target's project, whatever the caller runs at.
      expect(params).not.toHaveProperty('permissionMode');
    });

    it('keeps free agent mode only when the target has it saved', async () => {
      mocks.listDurable.mockResolvedValue([{ id: 'target', name: 'boss', freeAgentMode: true }]);
      await wakeWiredAgent(request);
      expect(system.spawnAgent.mock.calls[0][0].freeAgentMode).toBe(true);
    });

    it('resumes the last session when there is one', async () => {
      mocks.listDurable.mockResolvedValue([{ id: 'target', name: 'boss', lastSessionId: 'sess-1' }]);
      const result = await wakeWiredAgent(request);
      expect(parsed(result).resumed).toBe(true);
      expect(parsed(result).messageDelivered).toBeUndefined();
      expect(system.spawnAgent.mock.calls[0][0]).toMatchObject({ resume: true, sessionId: 'sess-1' });
    });

    it('is idempotent for a running agent', async () => {
      running = true;
      const result = await wakeWiredAgent(request);
      expect(parsed(result)).toEqual({ agentId: 'target', agentName: 'boss', status: 'already_running' });
      expect(system.spawnAgent).not.toHaveBeenCalled();
      expect(mocks.deliverNow).not.toHaveBeenCalled();
    });

    it('delivers a message to an agent that is already running', async () => {
      running = true;
      const missionRouted = [{ sender: { agentId: 'caller', name: 'Dispatcher' }, text: 'go' }];
      const result = await wakeWiredAgent({ ...request, mission: 'go', missionRouted });
      expect(parsed(result)).toMatchObject({ status: 'already_running', messageDelivered: true });
      expect(mocks.deliverNow).toHaveBeenCalledWith('target', 'go', missionRouted);
    });

    it('waits for a stopping agent, then wakes it, reading the session its exit saved', async () => {
      running = true;
      system.isAgentStopping.mockImplementation(() => running);
      system.waitForAgentStopped.mockImplementation(async () => {
        running = false;
        mocks.listDurable.mockResolvedValue([{ id: 'target', name: 'boss', lastSessionId: 'saved-on-exit' }]);
        return true;
      });
      const result = await wakeWiredAgent({ ...request, mission: 'go' });
      expect(parsed(result)).toMatchObject({ status: 'running', resumed: true, messageDelivered: true });
      expect(system.spawnAgent.mock.calls[0][0]).toMatchObject({ mission: 'go', sessionId: 'saved-on-exit' });
    });

    it('reports stopping, with nothing sent, when the agent does not exit in time', async () => {
      running = true;
      system.isAgentStopping.mockReturnValue(true);
      system.waitForAgentStopped.mockResolvedValue(false);
      const result = await wakeWiredAgent({ ...request, mission: 'go' });
      expect(parsed(result)).toMatchObject({ status: 'stopping', messageDelivered: false });
      expect(system.spawnAgent).not.toHaveBeenCalled();
    });

    it('reports stopping when a sleep starts as the message is delivered', async () => {
      running = true;
      mocks.deliverNow.mockResolvedValue('stopping');
      expect(parsed(await wakeWiredAgent({ ...request, mission: 'go' }))).toMatchObject({ status: 'stopping', messageDelivered: false });
    });

    it('reports starting for an agent that is registered but not live yet', async () => {
      mocks.registryGet.mockReturnValue({ projectPath: '/proj', runtime: 'chat' });
      const result = await wakeWiredAgent({ ...request, mission: 'go' });
      expect(parsed(result)).toMatchObject({ status: 'starting', messageDelivered: false });
      expect(system.spawnAgent).not.toHaveBeenCalled();
    });

    it('spawns once for two parallel wakes', async () => {
      const [first, second] = await Promise.all([wakeWiredAgent(request), wakeWiredAgent(request)]);
      expect(system.spawnAgent).toHaveBeenCalledTimes(1);
      expect(parsed(first).status).toBe('running');
      expect(parsed(second).status).toBe('starting');
    });

    it('errors when the agent has no durable config', async () => {
      mocks.listDurable.mockResolvedValue([]);
      const result = await wakeWiredAgent(request);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('durable config');
      expect(mocks.broadcast).not.toHaveBeenCalled();
    });

    it('broadcasts the failure and releases the claim when the spawn fails', async () => {
      system.spawnAgent.mockRejectedValueOnce(new Error('no cli'));
      const result = await wakeWiredAgent(request);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('no cli');
      expect(mocks.broadcast).toHaveBeenCalledWith('agent:agent-wake-failed', 'target', 'no cli');
      expect(parsed(await wakeWiredAgent(request)).status).toBe('running');
    });
  });
});
