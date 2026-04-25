import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createLifecycleSlice } from './agentLifecycleSlice';
import type { AgentState, AgentLifecycleSlice } from './types';

// Minimal state that the lifecycle slice needs
function createMinimalState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    agents: {},
    agentActivity: {},
    agentSpawnedAt: {},
    agentTerminalAt: {},
    agentDetailedStatus: {},
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
    const statusHistory: string[] = [];

    (window as any).clubhouse.agent.spawnAgent = vi.fn().mockRejectedValue(new Error('fail'));

    // Patch set to track transitions
    const origSpawnAgent = (window as any).clubhouse.agent.spawnAgent;
    (window as any).clubhouse.agent.spawnAgent = vi.fn().mockImplementation(async () => {
      throw new Error('fail');
    });

    try {
      await slice.spawnQuickAgent(PROJECT_ID, PROJECT_PATH, 'mission');
    } catch {
      // expected
    }

    const agentId = state().activeAgentId!;
    expect(state().agents[agentId]?.status).not.toBe('running');
    (window as any).clubhouse.agent.spawnAgent = origSpawnAgent;
  });

  it('stores agentId and sets activeAgentId', async () => {
    const { state, slice } = createTestStore();

    const agentId = await slice.spawnQuickAgent(PROJECT_ID, PROJECT_PATH, 'my mission');

    expect(agentId).toBeTruthy();
    expect(state().activeAgentId).toBe(agentId);
    expect(state().agents[agentId]).toBeTruthy();
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
