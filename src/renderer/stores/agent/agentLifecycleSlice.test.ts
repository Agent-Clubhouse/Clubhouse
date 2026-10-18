import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createLifecycleSlice } from './agentLifecycleSlice';
import type { AgentState } from './types';
import { buildProjectTree } from '../../chrome/sidebar/treeModel';

// Minimal state that the lifecycle slice needs
function createMinimalState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    agents: {},
    agentActivity: {},
    agentSpawnedAt: {},
    agentTerminalAt: {},
    agentDetailedStatus: {},
    agentLaunchFailure: {},
    activeAgentId: null,
    agentSettingsOpenFor: null,
    deleteDialogAgent: null,
    configChangesDialogAgent: null,
    configChangesProjectPath: null,
    sessionNamePromptFor: null,
    projectActiveAgent: {},
    cancelledAgentIds: {},
    resumingAgents: {},
    agentIcons: {},
    pendingRecovery: null,
    ...overrides,
  } as AgentState;
}

function createTestStore(initial: Partial<AgentState> = {}) {
  let state = createMinimalState(initial);

  const set = (updater: Partial<AgentState> | ((s: AgentState) => Partial<AgentState> | AgentState)) => {
    if (typeof updater === 'function') {
      const result = updater(state);
      state = { ...state, ...result };
    } else {
      state = { ...state, ...updater };
    }
  };
  const get = () => state;

  const slice = createLifecycleSlice(set as any, get as any);
  return { state: get, set, slice };
}

const PROJECT_ID = 'proj-1';
const PROJECT_PATH = '/test/project';

describe('agentLifecycleSlice – spawnQuickAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as any).clubhouse.agent.getSummaryInstruction = vi.fn().mockResolvedValue('');
    (window as any).clubhouse.agent.spawnAgent = vi.fn().mockResolvedValue(undefined);
    (window as any).clubhouse.agent.getDurableConfig = vi.fn().mockResolvedValue(null);
    (window as any).clubhouse.agent.killAgent = vi.fn().mockResolvedValue(undefined);
  });

  it('transitions through spawning → running on happy path (TC-CRIT-01)', async () => {
    const { state, slice } = createTestStore();
    const states: string[] = [];

    // Intercept spawnAgent to capture intermediate state
    (window as any).clubhouse.agent.spawnAgent = vi.fn().mockImplementation(async () => {
      states.push(Object.values(state().agents)[0]?.status ?? 'none');
    });

    await slice.spawnQuickAgent(PROJECT_ID, PROJECT_PATH, 'test mission');

    const agentId = state().activeAgentId!;
    expect(agentId).toBeTruthy();
    // During spawn, status should have been 'spawning'
    expect(states[0]).toBe('spawning');
    // After successful spawn, status should be 'running'
    expect(state().agents[agentId]?.status).toBe('running');
  });

  it('sets status to spawning before IPC call', async () => {
    const { state, slice } = createTestStore();
    let statusDuringSpawn: string | undefined;

    (window as any).clubhouse.agent.spawnAgent = vi.fn().mockImplementation(async () => {
      const agents = Object.values(state().agents);
      statusDuringSpawn = agents[0]?.status;
    });

    await slice.spawnQuickAgent(PROJECT_ID, PROJECT_PATH, 'mission');

    expect(statusDuringSpawn).toBe('spawning');
  });

  it('transitions to error state on spawn failure (TC-CRIT-01)', async () => {
    const { state, slice } = createTestStore();

    (window as any).clubhouse.agent.spawnAgent = vi.fn().mockRejectedValue(new Error('spawn failed'));

    await expect(slice.spawnQuickAgent(PROJECT_ID, PROJECT_PATH, 'mission')).rejects.toThrow('spawn failed');

    const agentId = state().activeAgentId!;
    expect(state().agents[agentId]?.status).toBe('error');
    expect((state().agents[agentId] as any).errorMessage).toBe('spawn failed');
  });

  it('does not enter running state if spawn fails', async () => {
    const { state, slice } = createTestStore();

    (window as any).clubhouse.agent.spawnAgent = vi.fn().mockRejectedValue(new Error('fail'));

    try {
      await slice.spawnQuickAgent(PROJECT_ID, PROJECT_PATH, 'mission');
    } catch {
      // expected
    }

    const agentId = state().activeAgentId!;
    expect(state().agents[agentId]?.status).not.toBe('running');
  });

  it('stores agentId and sets activeAgentId', async () => {
    const { state, slice } = createTestStore();

    const agentId = await slice.spawnQuickAgent(PROJECT_ID, PROJECT_PATH, 'my mission');

    expect(agentId).toBeTruthy();
    expect(state().activeAgentId).toBe(agentId);
    expect(state().agents[agentId]).toBeTruthy();
  });

  describe('run cwd and base sha (#2033)', () => {
    const PARENT = { id: 'dur-1', projectId: PROJECT_ID, name: 'Parent', kind: 'durable', status: 'running', color: 'blue', worktreePath: '/test/project/.wt/parent' } as any;

    beforeEach(() => {
      (window as any).clubhouse.git.headSha = vi.fn().mockResolvedValue('abc1234def');
    });

    it('records the project root as runCwd and captures the base sha', async () => {
      const { state, slice } = createTestStore();
      const agentId = await slice.spawnQuickAgent(PROJECT_ID, PROJECT_PATH, 'm');

      expect(window.clubhouse.git.headSha).toHaveBeenCalledWith(PROJECT_PATH);
      expect(state().agents[agentId].runCwd).toBe(PROJECT_PATH);
      await vi.waitFor(() => expect(state().agents[agentId].runBaseSha).toBe('abc1234def'));
    });

    it("uses the parent's worktree as cwd", async () => {
      const { state, slice } = createTestStore({ agents: { 'dur-1': PARENT } });
      const agentId = await slice.spawnQuickAgent(PROJECT_ID, PROJECT_PATH, 'm', undefined, 'dur-1');

      expect(state().agents[agentId].runCwd).toBe(PARENT.worktreePath);
      expect(window.clubhouse.agent.spawnAgent).toHaveBeenCalledWith(expect.objectContaining({ cwd: PARENT.worktreePath }));
    });

    it('prefers cwdOverride over the parent worktree', async () => {
      const { state, slice } = createTestStore({ agents: { 'dur-1': PARENT } });
      const agentId = await slice.spawnQuickAgent(PROJECT_ID, PROJECT_PATH, 'm', undefined, 'dur-1', undefined, undefined, undefined, '/retry/here');

      expect(state().agents[agentId].runCwd).toBe('/retry/here');
      expect(window.clubhouse.git.headSha).toHaveBeenCalledWith('/retry/here');
      expect(window.clubhouse.agent.spawnAgent).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/retry/here' }));
    });

    it('still spawns when the base sha lookup fails or returns null', async () => {
      (window as any).clubhouse.git.headSha = vi.fn().mockRejectedValue(new Error('not a repo'));
      const { state, slice } = createTestStore();
      const agentId = await slice.spawnQuickAgent(PROJECT_ID, PROJECT_PATH, 'm');
      expect(state().agents[agentId].status).toBe('running');
      expect(state().agents[agentId].runBaseSha).toBeUndefined();

      (window as any).clubhouse.git.headSha = vi.fn().mockResolvedValue(null);
      const second = await slice.spawnQuickAgent(PROJECT_ID, PROJECT_PATH, 'm');
      await Promise.resolve();
      expect(state().agents[second].runBaseSha).toBeUndefined();
    });
  });
});

describe('agentLifecycleSlice – spawnDurableAgent', () => {
  const DURABLE_CONFIG = {
    id: 'durable-1',
    name: 'Durable Agent',
    color: 'blue',
    model: 'claude-3',
    worktreePath: '/test/worktree',
    branch: 'main',
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    (window as any).clubhouse.agent.spawnAgent = vi.fn().mockResolvedValue(undefined);
    (window as any).clubhouse.agent.killAgent = vi.fn().mockResolvedValue(undefined);
  });

  it('transitions through spawning → running on happy path (TC-CRIT-01)', async () => {
    const { state, slice } = createTestStore();
    let statusDuringSpawn: string | undefined;

    (window as any).clubhouse.agent.spawnAgent = vi.fn().mockImplementation(async () => {
      statusDuringSpawn = state().agents['durable-1']?.status;
    });

    await slice.spawnDurableAgent(PROJECT_ID, PROJECT_PATH, DURABLE_CONFIG, false);

    expect(statusDuringSpawn).toBe('spawning');
    expect(state().agents['durable-1']?.status).toBe('running');
  });

  it('transitions to error on spawn failure (TC-CRIT-01)', async () => {
    const { state, slice } = createTestStore();

    (window as any).clubhouse.agent.spawnAgent = vi.fn().mockRejectedValue(new Error('durable spawn failed'));

    await expect(
      slice.spawnDurableAgent(PROJECT_ID, PROJECT_PATH, DURABLE_CONFIG, false),
    ).rejects.toThrow('durable spawn failed');

    expect(state().agents['durable-1']?.status).toBe('error');
    expect((state().agents['durable-1'] as any).errorMessage).toBe('durable spawn failed');
  });

  it('preserves the configured model on the store entry', async () => {
    // Regression: the spawned Agent object REPLACES the store entry, so dropping
    // `model` made Agent Settings and the list badge fall back to "Default" after
    // every wake, even though agents.json still had the right value.
    const { state, slice } = createTestStore();

    await slice.spawnDurableAgent(PROJECT_ID, PROJECT_PATH, DURABLE_CONFIG, false);

    expect(state().agents['durable-1']?.model).toBe('claude-3');
  });

  it('keeps a woken helper nested under its parent (#2231)', async () => {
    // The spawned Agent replaces the store entry, so the parent link must come along.
    const { state, slice } = createTestStore({
      agents: {
        lead: { id: 'lead', projectId: PROJECT_ID, name: 'lead', kind: 'durable', status: 'running', color: 'blue' },
        'durable-1': { id: 'durable-1', projectId: PROJECT_ID, name: 'Durable Agent', kind: 'durable', status: 'sleeping', color: 'blue', parentAgentId: 'lead' },
      } as any,
    });

    await slice.spawnDurableAgent(PROJECT_ID, PROJECT_PATH, { ...DURABLE_CONFIG, parentAgentId: 'lead' }, false);

    expect(state().agents['durable-1']).toMatchObject({ status: 'running', parentAgentId: 'lead' });
    const tree = buildProjectTree(Object.values(state().agents));
    expect(tree.awake.map((n) => [n.agent.id, n.children.map((c) => c.agent.id)])).toEqual([['lead', ['durable-1']]]);
  });

  it('passes the configured model to the spawn IPC', async () => {
    const { slice } = createTestStore();

    await slice.spawnDurableAgent(PROJECT_ID, PROJECT_PATH, DURABLE_CONFIG, false);

    expect((window as any).clubhouse.agent.spawnAgent).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-3' }),
    );
  });
});

describe('agentLifecycleSlice – killAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as any).clubhouse.agent.killAgent = vi.fn().mockResolvedValue(undefined);
  });

  it('marks a running quick agent as sleeping after kill', async () => {
    const { state, slice } = createTestStore({
      agents: {
        'qa-1': { id: 'qa-1', projectId: PROJECT_ID, name: 'Quick', kind: 'quick', status: 'running', color: 'gray' } as any,
      },
    });

    await slice.killAgent('qa-1', PROJECT_PATH);

    expect(state().agents['qa-1']?.status).toBe('sleeping');
  });

  it('adds quick agent to cancelledAgentIds on kill', async () => {
    const { state, slice } = createTestStore({
      agents: {
        'qa-2': { id: 'qa-2', projectId: PROJECT_ID, name: 'Quick', kind: 'quick', status: 'running', color: 'gray' } as any,
      },
    });

    await slice.killAgent('qa-2', PROJECT_PATH);

    expect(state().cancelledAgentIds['qa-2']).toBe(true);
  });

  it('is a no-op for non-existent agent', async () => {
    const { slice } = createTestStore();
    // Should not throw
    await slice.killAgent('ghost-agent', PROJECT_PATH);
  });

  it('forwards waitForExit to the main process', async () => {
    const { slice } = createTestStore({
      agents: {
        'da-1': { id: 'da-1', projectId: PROJECT_ID, name: 'Durable', kind: 'durable', status: 'running', color: 'gray' } as any,
      },
    });

    await slice.killAgent('da-1', PROJECT_PATH, { waitForExit: true });

    expect((window as any).clubhouse.agent.killAgent).toHaveBeenCalledWith('da-1', PROJECT_PATH, true);
  });
});

describe('agentLifecycleSlice – state transition guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as any).clubhouse.agent.spawnAgent = vi.fn().mockResolvedValue(undefined);
    (window as any).clubhouse.agent.getSummaryInstruction = vi.fn().mockResolvedValue('');
    (window as any).clubhouse.agent.getDurableConfig = vi.fn().mockResolvedValue(null);
  });

  it('does not transition removed agent to running after successful spawn', async () => {
    const { state, set, slice } = createTestStore();

    (window as any).clubhouse.agent.spawnAgent = vi.fn().mockImplementation(async () => {
      // Simulate agent being removed while IPC was in flight
      const agentId = Object.keys(state().agents)[0];
      if (agentId) {
        const { [agentId]: _, ...rest } = state().agents;
        set({ agents: rest });
      }
    });

    const agentId = await slice.spawnQuickAgent(PROJECT_ID, PROJECT_PATH, 'mission');

    // Agent was removed — no state update should have resurrected it
    expect(state().agents[agentId]).toBeUndefined();
  });
});
